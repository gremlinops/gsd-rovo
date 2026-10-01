'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const m = require('../src/manifest.cjs');

function tmpDir(t, prefix = 'gsd-rovo-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function captureOutput() {
  const lines = [];
  return {
    lines,
    info: (msg) => lines.push(`ok ${msg}`),
    warn: (msg) => lines.push(`warn ${msg}`),
    fail: (msg) => lines.push(`FAIL ${msg}`),
    raw: (msg) => lines.push(msg),
    has: (re) => lines.some((l) => re.test(l)),
  };
}

/** A Rovo root with the user's own config, another tool's hook and a user subagent. */
function seedUserFiles(root) {
  const files = {
    'config.yml': 'version: 1\neventHooks:\n  events: []\n',
    'hooks/aloc-managed/post_to_aloc.sh': '#!/bin/sh\n',
    'subagents/test-agent.md': '---\nname: test-agent\n---\n',
  };
  for (const [rel, content] of Object.entries(files)) m.atomicWrite(path.join(root, rel), content);
  return files;
}

/** Every file and directory under root, with file contents. */
function snapshot(root) {
  const out = {};
  for (const rel of fs.readdirSync(root, { recursive: true }).sort()) {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    out[rel] = st.isFile() ? fs.readFileSync(abs, 'utf8') : st.isDirectory() ? '<dir>' : '<other>';
  }
  return out;
}

const ARTIFACTS = Object.freeze([
  Object.freeze({ relativePath: 'skills/gsd-help/SKILL.md', content: '---\nname: gsd-help\n---\nhelp\n' }),
  Object.freeze({ relativePath: 'subagents/gsd-planner.md', content: '---\nname: gsd-planner\n---\nplan\n' }),
]);

module.exports = { tmpDir, captureOutput, seedUserFiles, snapshot, ARTIFACTS };
