'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = require('../src/cli.cjs');
const eos = require('../src/eos.cjs');
const m = require('../src/manifest.cjs');
const { tmpDir, captureOutput, seedUserFiles, snapshot, ARTIFACTS } = require('./helpers.cjs');

const BIN = path.join(__dirname, '..', 'bin', 'gsd-rovo.cjs');
const ctx = () => eos.initialize();
const install = (root, opts = {}) => cli.cmdInstall({ root, ctx: ctx(), artifacts: ARTIFACTS, out: captureOutput(), ...opts });
const runBin = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

function writeManifestRaw(root, body) {
  fs.writeFileSync(path.join(root, m.MANIFEST_NAME), JSON.stringify({ version: 1, gsdCoreVersion: '1.15.0', ...body }));
}

// ── argument handling ───────────────────────────────────────────────────────

test('parseArgs', () => {
  assert.deepEqual(cli.parseArgs(['install', '--root', '/x', '--force']), {
    command: 'install', root: '/x', force: true, help: false, errors: [],
  });
  assert.equal(cli.parseArgs(['install', '--root=/y']).root, '/y');
  assert.equal(cli.parseArgs(['--help']).help, true);
  const cases = {
    'install --bogus': ['unknown option --bogus'],
    'install -r /x': ['unknown option -r', 'unexpected argument /x'],
    'install --root': ['--root needs a value'],
    'install --root --force': ['--root needs a value'],
    'install --root=': ['--root needs a value'],
    'install extra': ['unexpected argument extra'],
  };
  for (const [argv, errors] of Object.entries(cases)) assert.deepEqual(cli.parseArgs(argv.split(' ')).errors, errors, argv);
  assert.equal(cli.parseArgs(['install', '--root', '--force']).force, true);
});

test('resolveRoot defaults to ~/.rovo and expands ~', () => {
  assert.equal(cli.resolveRoot(null, '/home/u'), '/home/u/.rovo');
  assert.equal(cli.resolveRoot('~/alt', '/home/u'), '/home/u/alt');
  assert.equal(cli.resolveRoot('~', '/home/u'), '/home/u');
  assert.equal(cli.resolveRoot('/abs/dir', '/home/u'), '/abs/dir');
});

test('main refuses / and the home directory as root', async () => {
  for (const root of ['/', '/home/u', '~']) {
    await assert.rejects(cli.main(['install', '--root', root], { out: captureOutput(), home: '/home/u' }), /refusing to use/);
    await assert.rejects(cli.main(['uninstall', '--root', root], { out: captureOutput(), home: '/home/u' }), /refusing to use/);
  }
});

test('main installs into <home>/.rovo by default', async (t) => {
  const home = tmpDir(t);
  assert.equal(await cli.main(['install'], { out: captureOutput(), home }), 0);
  assert.ok(fs.existsSync(path.join(home, '.rovo', m.MANIFEST_NAME)));
});

test('main prints argument errors before usage and exits 2', async () => {
  for (const argv of [['--bogus'], ['install', '--help', '--bogus']]) {
    const out = captureOutput();
    assert.equal(await cli.main(argv, { out }), 2);
    assert.match(out.lines[0], /^FAIL unknown option --bogus/);
    assert.ok(out.has(/Usage:/));
  }
});

// ── install ─────────────────────────────────────────────────────────────────

test('install writes artifacts, keeps user files and records only the dirs it created', (t) => {
  const root = tmpDir(t);
  const userFiles = seedUserFiles(root);
  assert.equal(install(root), 0);

  for (const a of ARTIFACTS) assert.equal(fs.readFileSync(path.join(root, a.relativePath), 'utf8'), a.content);
  for (const [rel, content] of Object.entries(userFiles)) assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), content);

  const got = m.readManifest(root);
  assert.equal(got.gsdCoreVersion, ctx().coreVersion);
  assert.deepEqual(got.files.map((f) => f.path), ['skills/gsd-help/SKILL.md', 'subagents/gsd-planner.md']);
  assert.deepEqual(got.dirs, ['skills', 'skills/gsd-help'], 'subagents/ existed before install');
});

test('re-install is idempotent', (t) => {
  const root = tmpDir(t);
  install(root);
  const before = snapshot(root);
  const out = captureOutput();
  assert.equal(install(root, { out }), 0);
  assert.deepEqual(snapshot(root), before);
  assert.match(out.lines.at(-1), /0 files written, 2 unchanged, 0 removed/);
});

test('install refuses an unmanaged file, even with identical content, and writes nothing', (t) => {
  for (const content of ['user content', ARTIFACTS[0].content]) {
    const root = tmpDir(t);
    m.atomicWrite(path.join(root, ARTIFACTS[0].relativePath), content);
    const before = snapshot(root);
    const out = captureOutput();
    assert.equal(install(root, { out }), 1);
    assert.deepEqual(snapshot(root), before);
    assert.ok(out.has(/FAIL skills\/gsd-help\/SKILL.md: exists and is not managed by gsd-rovo/));
    assert.ok(out.has(/Nothing was written/));
  }
});

test('install --force takes over an unmanaged file', (t) => {
  const root = tmpDir(t);
  m.atomicWrite(path.join(root, ARTIFACTS[0].relativePath), 'user content');
  const out = captureOutput();
  assert.equal(install(root, { force: true, out }), 0);
  assert.ok(out.has(/warn overwriting \(--force\): skills\/gsd-help\/SKILL.md/));
  assert.equal(fs.readFileSync(path.join(root, ARTIFACTS[0].relativePath), 'utf8'), ARTIFACTS[0].content);
  assert.ok(m.readManifest(root).files.some((f) => f.path === ARTIFACTS[0].relativePath));
});

test('install refuses a user-changed managed file; --force overwrites it', (t) => {
  const root = tmpDir(t);
  install(root);
  fs.writeFileSync(path.join(root, ARTIFACTS[1].relativePath), 'edited');
  const next = [{ ...ARTIFACTS[0], content: 'v2 help\n' }, { ...ARTIFACTS[1], content: 'v2\n' }];

  const before = snapshot(root);
  const out = captureOutput();
  assert.equal(install(root, { artifacts: next, out }), 1);
  assert.deepEqual(snapshot(root), before, 'nothing may change, including the unconflicted file and the manifest');
  assert.ok(out.has(/FAIL subagents\/gsd-planner.md: changed since last install/));

  assert.equal(install(root, { artifacts: next, force: true }), 0);
  assert.equal(fs.readFileSync(path.join(root, ARTIFACTS[1].relativePath), 'utf8'), 'v2\n');
  assert.equal(fs.readFileSync(path.join(root, ARTIFACTS[0].relativePath), 'utf8'), 'v2 help\n');
});

test('install updates unchanged managed files and restores deleted ones without --force', (t) => {
  const root = tmpDir(t);
  install(root);
  fs.rmSync(path.join(root, ARTIFACTS[0].relativePath));
  const next = [ARTIFACTS[0], { ...ARTIFACTS[1], content: 'v2\n' }];
  assert.equal(install(root, { artifacts: next }), 0);
  assert.equal(fs.readFileSync(path.join(root, ARTIFACTS[0].relativePath), 'utf8'), ARTIFACTS[0].content);
  assert.equal(fs.readFileSync(path.join(root, ARTIFACTS[1].relativePath), 'utf8'), 'v2\n');
});

test('install removes files no longer shipped and prunes the dirs it created', (t) => {
  const root = tmpDir(t);
  install(root);
  assert.equal(install(root, { artifacts: [ARTIFACTS[1]] }), 0);
  assert.ok(!fs.existsSync(path.join(root, 'skills')));
  const got = m.readManifest(root);
  assert.deepEqual(got.files.map((f) => f.path), ['subagents/gsd-planner.md']);
  assert.deepEqual(got.dirs, ['subagents']);
});

test('install refuses to drop a changed file that is no longer shipped; --force deletes it', (t) => {
  const root = tmpDir(t);
  install(root);
  const dropped = path.join(root, ARTIFACTS[0].relativePath);
  fs.writeFileSync(dropped, 'edited');
  const before = snapshot(root);

  const out = captureOutput();
  assert.equal(install(root, { artifacts: [ARTIFACTS[1]], out }), 1);
  assert.deepEqual(snapshot(root), before);
  assert.ok(out.has(/FAIL skills\/gsd-help\/SKILL.md: no longer shipped, but changed since last install/));

  const forced = captureOutput();
  assert.equal(install(root, { artifacts: [ARTIFACTS[1]], force: true, out: forced }), 0);
  assert.ok(!fs.existsSync(dropped));
  assert.ok(forced.has(/warn overwriting \(--force\): skills\/gsd-help\/SKILL.md/));
});

test('install carries hook entries from the previous manifest forward', (t) => {
  const root = tmpDir(t);
  install(root);
  const raw = JSON.parse(fs.readFileSync(path.join(root, m.MANIFEST_NAME), 'utf8'));
  raw.hooks = [{ event: 'on_tool_start', command: 'x' }];
  fs.writeFileSync(path.join(root, m.MANIFEST_NAME), JSON.stringify(raw));
  install(root);
  assert.deepEqual(m.readManifest(root).hooks, [{ event: 'on_tool_start', command: 'x' }]);
});

test('install records ownership before writing, so a failed install can be re-run', (t) => {
  const root = tmpDir(t);
  const subagents = path.join(root, 'subagents');
  fs.mkdirSync(subagents);
  fs.chmodSync(subagents, 0o500);
  try {
    assert.throws(() => install(root), /EACCES/);
  } finally {
    fs.chmodSync(subagents, 0o755);
  }
  assert.ok(fs.existsSync(path.join(root, ARTIFACTS[0].relativePath)), 'first write happened');
  assert.ok(m.readManifest(root).files.some((f) => f.path === ARTIFACTS[0].relativePath));

  assert.equal(install(root), 0, 'no --force needed after the failure');
  assert.deepEqual(m.readManifest(root).files.map((f) => f.path), ARTIFACTS.map((a) => a.relativePath));
});

test('install rejects duplicate, escaping and non-owned artifact paths', (t) => {
  const root = tmpDir(t);
  const dup = [ARTIFACTS[0], { ...ARTIFACTS[0], relativePath: 'skills/./gsd-help/SKILL.md' }];
  assert.throws(() => install(root, { artifacts: dup }), /duplicate artifact path/);
  assert.throws(() => install(root, { artifacts: [{ relativePath: '../x', content: '' }] }), /escapes install root/);
  assert.throws(() => install(root, { artifacts: [{ relativePath: 'config.yml', content: '' }] }), /not inside/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('install throws before writing when the manifest is corrupt or lists a bad path', (t) => {
  for (const bad of ['{not json', { files: [{ path: '../outside', sha256: 'x' }] }, { dirs: ['/etc'] }]) {
    const root = tmpDir(t);
    if (typeof bad === 'string') fs.writeFileSync(path.join(root, m.MANIFEST_NAME), bad);
    else writeManifestRaw(root, bad);
    const before = snapshot(root);
    assert.throws(() => install(root));
    assert.deepEqual(snapshot(root), before);
  }
});

// ── uninstall ───────────────────────────────────────────────────────────────

test('uninstall restores the root to its pre-install state', (t) => {
  const root = tmpDir(t);
  seedUserFiles(root);
  fs.mkdirSync(path.join(root, 'skills'));
  const before = snapshot(root);
  install(root);
  assert.equal(cli.cmdUninstall({ root, out: captureOutput() }), 0);
  assert.deepEqual(snapshot(root), before, 'pre-existing empty skills/ must survive; created dirs must go');
});

test('uninstall keeps user-changed files and a manifest for them, unless --force', (t) => {
  const root = tmpDir(t);
  install(root);
  const target = path.join(root, ARTIFACTS[0].relativePath);
  fs.writeFileSync(target, 'edited');

  const out = captureOutput();
  assert.equal(cli.cmdUninstall({ root, out }), 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'edited');
  assert.ok(!fs.existsSync(path.join(root, ARTIFACTS[1].relativePath)));
  assert.ok(out.has(/warn kept \(changed after install\): skills\/gsd-help\/SKILL.md/));
  const left = m.readManifest(root);
  assert.deepEqual(left.files.map((f) => f.path), [ARTIFACTS[0].relativePath]);
  assert.deepEqual(left.dirs, ['skills', 'skills/gsd-help']);

  const again = captureOutput();
  assert.equal(install(root, { out: again }), 1);
  assert.ok(again.has(/changed since last install/), 'kept file is still known, not "unmanaged"');

  assert.equal(cli.cmdUninstall({ root, force: true, out: captureOutput() }), 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('uninstall skips tracked files that are already gone', (t) => {
  const root = tmpDir(t);
  install(root);
  fs.rmSync(path.join(root, ARTIFACTS[1].relativePath));
  const out = captureOutput();
  assert.equal(cli.cmdUninstall({ root, out }), 0);
  assert.match(out.lines.at(-1), /1 file removed, 0 kept/);
  assert.equal(m.readManifest(root), null);
});

test('uninstall deletes nothing when any manifest path is bad, even with --force', (t) => {
  for (const badPath of ['../sentinel', 'config.yml', 'zzz/../../sentinel']) {
    const parent = tmpDir(t);
    const root = path.join(parent, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(parent, 'sentinel'), 'outside');
    fs.writeFileSync(path.join(root, 'config.yml'), 'user config');
    install(root);
    const mf = JSON.parse(fs.readFileSync(path.join(root, m.MANIFEST_NAME), 'utf8'));
    mf.files.push({ path: badPath, sha256: m.sha256('user config') });
    fs.writeFileSync(path.join(root, m.MANIFEST_NAME), JSON.stringify(mf));
    const before = snapshot(parent);

    assert.throws(() => cli.cmdUninstall({ root, force: true, out: captureOutput() }), /escapes install root|not inside/, badPath);
    assert.deepEqual(snapshot(parent), before, badPath);
  }
});

test('uninstall refuses to delete through a symlinked owned dir', (t) => {
  const root = tmpDir(t);
  const outside = tmpDir(t, 'gsd-rovo-outside-');
  install(root);
  fs.cpSync(path.join(root, 'skills'), outside, { recursive: true });
  fs.rmSync(path.join(root, 'skills'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'skills'));

  assert.throws(() => cli.cmdUninstall({ root, out: captureOutput() }), /refusing to follow symlink: skills/);
  assert.ok(fs.existsSync(path.join(outside, 'gsd-help', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, ARTIFACTS[1].relativePath)), 'nothing deleted before the throw');
});

test('uninstall throws on a corrupt manifest and changes nothing', (t) => {
  const root = tmpDir(t);
  install(root);
  fs.writeFileSync(path.join(root, m.MANIFEST_NAME), '{not json');
  const before = snapshot(root);
  assert.throws(() => cli.cmdUninstall({ root, out: captureOutput() }), /corrupt/);
  assert.deepEqual(snapshot(root), before);
});

test('uninstall without a manifest is a no-op', (t) => {
  const root = tmpDir(t);
  seedUserFiles(root);
  const before = snapshot(root);
  assert.equal(cli.cmdUninstall({ root, out: captureOutput() }), 0);
  assert.deepEqual(snapshot(root), before);
});

// ── bin ─────────────────────────────────────────────────────────────────────

test('bin: descriptor prints JSON that the SDK handshake accepts', () => {
  const res = runBin(['descriptor']);
  assert.equal(res.status, 0, res.stderr);
  const desc = JSON.parse(res.stdout);
  const SDK = eos.loadSdk();
  const result = SDK.handleHandshakeRequest(SDK.buildHandshakeRequest({ protocolVersion: desc.protocolVersion, axes: desc.axes }));
  assert.equal(SDK.profileOf(result.effective), 'declarative-cli');
});

test('bin: install/uninstall round trip leaves user files as they were', (t) => {
  const root = tmpDir(t);
  seedUserFiles(root);
  const before = snapshot(root);
  assert.equal(runBin(['install', '--root', root]).status, 0);
  assert.ok(fs.existsSync(path.join(root, m.MANIFEST_NAME)));
  assert.equal(runBin(['uninstall', '--root', root]).status, 0);
  assert.deepEqual(snapshot(root), before);
});

test('bin: usage, argument errors and unknown commands', () => {
  const help = runBin([]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const bad = runBin(['install', '--nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option --nope/);
  const unknown = runBin(['frobnicate']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command frobnicate/);
});

test('bin: errors print one line, with the stack only under GSD_ROVO_DEBUG', (t) => {
  const root = tmpDir(t);
  fs.writeFileSync(path.join(root, m.MANIFEST_NAME), '{not json');
  const plain = runBin(['uninstall', '--root', root]);
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /^FAIL {2}corrupt \.gsd-rovo-manifest\.json/);
  assert.doesNotMatch(plain.stderr, /\n\s+at /);
  const debug = runBin(['uninstall', '--root', root], { GSD_ROVO_DEBUG: '1' });
  assert.match(debug.stderr, /\n\s+at /);
});
