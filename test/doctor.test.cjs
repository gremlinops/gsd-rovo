'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = require('../src/cli.cjs');
const doctor = require('../src/doctor.cjs');
const eos = require('../src/eos.cjs');
const m = require('../src/manifest.cjs');
const { tmpDir, captureOutput, seedUserFiles, ARTIFACTS } = require('./helpers.cjs');

const BIN = path.join(__dirname, '..', 'bin', 'gsd-rovo.cjs');
const findRovo = () => '/usr/local/bin/rovo';
const install = (root) => cli.cmdInstall({ root, ctx: eos.initialize(), artifacts: ARTIFACTS, out: captureOutput() });
const run = (root, opts = {}) => {
  const out = captureOutput();
  return { code: doctor.cmdDoctor({ root, out, findRovo, ...opts }), out };
};

test('findOnPath finds executable files only', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'rovo'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'notexec'), 'x', { mode: 0o644 });
  fs.mkdirSync(path.join(dir, 'adir'));
  const env = { PATH: ['', '/nonexistent', dir].join(path.delimiter) };
  assert.equal(doctor.findOnPath('rovo', env, 'darwin'), path.join(dir, 'rovo'));
  assert.equal(doctor.findOnPath('notexec', env, 'darwin'), null);
  assert.equal(doctor.findOnPath('adir', env, 'darwin'), null);
  assert.equal(doctor.findOnPath('rovo', { PATH: '' }, 'darwin'), null);
  assert.equal(doctor.findOnPath('rovo', {}, 'darwin'), null);
});

test('doctor fails when not installed', (t) => {
  const { code, out } = run(tmpDir(t));
  assert.equal(code, 1);
  assert.ok(out.has(/FAIL not installed/));
});

test('doctor is healthy after install and reports degraded interface points', (t) => {
  const root = tmpDir(t);
  seedUserFiles(root);
  install(root);
  const { code, out } = run(root);
  assert.equal(code, 0);
  assert.equal(out.lines.at(-1), 'ok healthy');
  assert.ok(out.has(/warn interface point command: absent/));
  assert.ok(out.has(/warn interface point dispatch: degraded \(flat dispatch/));
  assert.ok(!out.has(/negotiation:/), 'no unexpected negotiation warnings');
});

test('doctor warns on changed files and fails on missing ones', (t) => {
  const root = tmpDir(t);
  install(root);
  fs.writeFileSync(path.join(root, ARTIFACTS[0].relativePath), 'edited');
  let r = run(root);
  assert.equal(r.code, 0);
  assert.ok(r.out.has(/warn changed after install: skills\/gsd-help\/SKILL.md/));

  fs.rmSync(path.join(root, ARTIFACTS[1].relativePath));
  r = run(root);
  assert.equal(r.code, 1);
  assert.ok(r.out.has(/FAIL missing: subagents\/gsd-planner.md/));
  assert.ok(r.out.has(/2 tracked files: 1 problems, 1 changed/));
});

test('doctor fails on a corrupt manifest or a manifest path outside owned dirs', (t) => {
  const root = tmpDir(t);
  install(root);
  const file = path.join(root, m.MANIFEST_NAME);
  const good = fs.readFileSync(file, 'utf8');

  fs.writeFileSync(file, '{not json');
  let r = run(root);
  assert.equal(r.code, 1);
  assert.ok(r.out.has(/FAIL corrupt \.gsd-rovo-manifest\.json/));

  const mf = JSON.parse(good);
  mf.files.push({ path: '../outside', sha256: 'x' });
  fs.writeFileSync(file, JSON.stringify(mf));
  r = run(root);
  assert.equal(r.code, 1);
  assert.ok(r.out.has(/FAIL path escapes install root: \.\.\/outside/));
});

test('doctor warns when rovo is absent and when gsd-core version drifted', (t) => {
  const root = tmpDir(t);
  install(root);
  const file = path.join(root, m.MANIFEST_NAME);
  const mf = JSON.parse(fs.readFileSync(file, 'utf8'));
  mf.gsdCoreVersion = '0.0.1';
  fs.writeFileSync(file, JSON.stringify(mf));
  const { code, out } = run(root, { findRovo: () => null });
  assert.equal(code, 0);
  assert.ok(out.has(/warn rovo not found/));
  assert.ok(out.has(/warn installed from gsd-core 0\.0\.1/));
});

test('doctor fails when the handshake fails', (t) => {
  const { code, out } = run(tmpDir(t), { initialize: () => { throw new Error('boom'); } });
  assert.equal(code, 1);
  assert.ok(out.has(/FAIL gsd-core handshake failed: boom/));
});

test('doctor shows unexpected negotiation warnings', (t) => {
  const root = tmpDir(t);
  install(root);
  const real = eos.initialize();
  const initialize = () => ({ ...real, negotiation: { ...real.negotiation, warnings: ['dispatch.maxConcurrency is not a number — treating as 1', 'x is undocumented'] } });
  const { out } = run(root, { initialize });
  assert.ok(out.has(/warn negotiation: dispatch.maxConcurrency is not a number/));
  assert.ok(!out.has(/negotiation: x is undocumented/));
});

test('bin: install then doctor exits 0', (t) => {
  const root = tmpDir(t);
  const runBin = (...args) => spawnSync(process.execPath, [BIN, ...args, '--root', root], { encoding: 'utf8' });
  assert.equal(runBin('install').status, 0);
  const res = runBin('doctor');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /ok {4}healthy/);
});
