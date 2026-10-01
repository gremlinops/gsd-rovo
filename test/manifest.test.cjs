'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const m = require('../src/manifest.cjs');

function tmpDir(t, prefix = 'gsd-rovo-manifest-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('sha256 hashes bytes; hashFile matches and returns null when missing', (t) => {
  const root = tmpDir(t);
  assert.equal(m.sha256('é'), m.sha256(Buffer.from('é', 'utf8')));
  fs.writeFileSync(path.join(root, 'x'), Buffer.from([0xff, 0xfe]));
  assert.equal(m.hashFile(path.join(root, 'x')), m.sha256(Buffer.from([0xff, 0xfe])));
  assert.notEqual(m.hashFile(path.join(root, 'x')), m.sha256(Buffer.from([0xff, 0xfd])));
  assert.equal(m.hashFile(path.join(root, 'nope')), null);
});

test('atomicWrite creates parent dirs and leaves no temp file', (t) => {
  const root = tmpDir(t);
  const file = path.join(root, 'a', 'b', 'c.md');
  m.atomicWrite(file, 'hello');
  m.atomicWrite(file, 'again');
  assert.equal(fs.readFileSync(file, 'utf8'), 'again');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['c.md']);
});

test('atomicWrite removes its temp file when the rename fails', (t) => {
  const root = tmpDir(t);
  const target = path.join(root, 'dir-in-the-way');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'x');
  assert.throws(() => m.atomicWrite(target, 'content'));
  assert.deepEqual(fs.readdirSync(root), ['dir-in-the-way']);
  assert.deepEqual(fs.readdirSync(target), ['keep']);
});

test('resolveInRoot accepts files inside owned dirs, also for an unnormalized root', (t) => {
  const root = tmpDir(t);
  const want = path.join(root, 'skills', 'gsd-a', 'SKILL.md');
  assert.equal(m.resolveInRoot(root, 'skills/gsd-a/SKILL.md'), want);
  assert.equal(m.resolveInRoot(root + path.sep, 'skills/./gsd-a/SKILL.md'), want);
  assert.equal(m.resolveInRoot(root, 'subagents/gsd-planner.md'), path.join(root, 'subagents', 'gsd-planner.md'));
  const rel = path.relative(process.cwd(), root);
  assert.equal(m.resolveInRoot(rel, 'skills/x/SKILL.md'), path.join(root, 'skills', 'x', 'SKILL.md'));
});

test('resolveInRoot refuses escapes, the root, non-owned paths and bad input', (t) => {
  const root = tmpDir(t);
  const refused = {
    '../outside': /escapes install root/,
    [`../${path.basename(root)}-evil/skills/x`]: /escapes install root/,
    '/etc/passwd': /escapes install root/,
    '.': /escapes install root/,
    'skills/../../x': /escapes install root/,
    'config.yml': /not inside skills\/ or subagents\//,
    [m.MANIFEST_NAME]: /not inside/,
    'hooks/aloc-managed/post_to_aloc.sh': /not inside/,
    'skills': /not inside/,
    '': /invalid path/,
  };
  for (const [p, re] of Object.entries(refused)) assert.throws(() => m.resolveInRoot(root, p), re, p);
  assert.throws(() => m.resolveInRoot(root, null), /invalid path/);
  assert.throws(() => m.resolveInRoot(root, 42), /invalid path/);
  assert.equal(m.resolveInRoot(root, 'skills', 'dir'), path.join(root, 'skills'));
});

test('resolveInRoot refuses symlinked directories and symlinked targets', (t) => {
  const root = tmpDir(t);
  const outside = tmpDir(t, 'gsd-rovo-outside-');
  fs.symlinkSync(outside, path.join(root, 'skills'));
  assert.throws(() => m.resolveInRoot(root, 'skills/gsd-a/SKILL.md'), /refusing to follow symlink: skills/);

  fs.mkdirSync(path.join(root, 'subagents'));
  fs.writeFileSync(path.join(outside, 'real.md'), 'x');
  fs.symlinkSync(path.join(outside, 'real.md'), path.join(root, 'subagents', 'gsd-a.md'));
  assert.throws(() => m.resolveInRoot(root, 'subagents/gsd-a.md'), /refusing to follow symlink: subagents\/gsd-a.md/);
});

test('missingDirs lists only the ancestors that do not exist yet', (t) => {
  const root = tmpDir(t);
  fs.mkdirSync(path.join(root, 'skills'));
  const file = path.join(root, 'skills', 'gsd-a', 'deep', 'SKILL.md');
  assert.deepEqual(m.missingDirs(root, file), [path.join('skills', 'gsd-a', 'deep'), path.join('skills', 'gsd-a')]);
  assert.deepEqual(m.missingDirs(root, path.join(root, 'skills', 'x.md')), []);
});

test('manifest round-trips with sorted files and dirs', (t) => {
  const root = tmpDir(t);
  assert.equal(m.readManifest(root), null);
  m.writeManifest(root, {
    gsdCoreVersion: '1.15.0',
    files: [{ path: 'skills/b/SKILL.md', sha256: '2' }, { path: 'skills/a/SKILL.md', sha256: '1' }],
    dirs: ['skills/b', 'skills', 'skills/b'],
  });
  const got = m.readManifest(root);
  assert.equal(got.version, m.MANIFEST_VERSION);
  assert.equal(got.gsdCoreVersion, '1.15.0');
  assert.deepEqual(got.files.map((f) => f.path), ['skills/a/SKILL.md', 'skills/b/SKILL.md']);
  assert.deepEqual(got.dirs, ['skills', 'skills/b']);
  assert.deepEqual(got.hooks, []);
});

test('readManifest names the file for corrupt content and rejects unknown versions', (t) => {
  const root = tmpDir(t);
  const file = path.join(root, m.MANIFEST_NAME);
  const cases = {
    '{not json': /corrupt \.gsd-rovo-manifest\.json: .*JSON/,
    'null': /not a JSON object/,
    '[]': /not a JSON object/,
    '{"version":1,"files":[{"path":1}]}': /"files" must be/,
    '{"version":1,"files":{}}': /"files" must be/,
    '{"version":1,"dirs":[1]}': /"dirs" must be/,
    '{"version":1,"hooks":{}}': /"hooks" must be/,
    '{"version":99}': /unsupported \.gsd-rovo-manifest\.json version 99/,
  };
  for (const [content, re] of Object.entries(cases)) {
    fs.writeFileSync(file, content);
    assert.throws(() => m.readManifest(root), re, content);
  }
});

test('pruneDirs removes listed empty dirs deepest first and keeps everything else', (t) => {
  const root = tmpDir(t);
  fs.mkdirSync(path.join(root, 'skills', 'gsd-a', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'user-skill'));
  fs.writeFileSync(path.join(root, 'skills', 'user-skill', 'SKILL.md'), 'x');
  fs.mkdirSync(path.join(root, 'subagents'));

  const removed = m.pruneDirs(root, ['skills', 'skills/gsd-a', 'skills/gsd-a/deep', 'skills/gone']);
  assert.deepEqual(removed, ['skills/gsd-a/deep', 'skills/gsd-a']);
  assert.ok(fs.existsSync(path.join(root, 'skills', 'user-skill', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, 'subagents')), 'unlisted empty dir was removed');
});
