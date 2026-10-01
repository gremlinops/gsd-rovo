'use strict';

/**
 * Install manifest: the record of every file, directory and hook entry gsd-rovo owns
 * under the Rovo config root. Paths are stored relative to the root.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST_NAME = '.gsd-rovo-manifest.json';
const MANIFEST_VERSION = 1;
// Top-level directories gsd-rovo may write into. Anything else (config.yml, hooks of
// other tools) is never written or deleted, whatever the manifest says.
const OWNED_DIRS = Object.freeze(['skills', 'subagents']);

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashFile(filePath) {
  try {
    return sha256(fs.readFileSync(filePath));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Resolve a manifest-relative path to an absolute one. Throws unless the path is inside an
 * owned directory and no existing component below the root is a symlink.
 * kind 'file' needs at least one level below the owned dir; kind 'dir' may be the owned dir.
 */
function resolveInRoot(root, relativePath, kind = 'file') {
  if (typeof relativePath !== 'string' || relativePath === '') {
    throw new Error(`invalid path in manifest: ${JSON.stringify(relativePath)}`);
  }
  const base = path.resolve(root);
  const abs = path.resolve(base, relativePath);
  if (!abs.startsWith(base + path.sep)) {
    throw new Error(`path escapes install root: ${relativePath}`);
  }
  const parts = path.relative(base, abs).split(path.sep);
  if (!OWNED_DIRS.includes(parts[0]) || (kind === 'file' && parts.length < 2)) {
    throw new Error(`path is not inside ${OWNED_DIRS.map((d) => `${d}/`).join(' or ')}: ${relativePath}`);
  }
  let cur = base;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      if (err.code === 'ENOENT') break;
      throw err;
    }
    if (st.isSymbolicLink()) throw new Error(`refusing to follow symlink: ${path.relative(base, cur)}`);
  }
  return abs;
}

/** Relative paths of the ancestor directories of absFile (below root) that do not exist yet. */
function missingDirs(root, absFile) {
  const base = path.resolve(root);
  const missing = [];
  for (let dir = path.dirname(absFile); dir.startsWith(base + path.sep); dir = path.dirname(dir)) {
    if (fs.existsSync(dir)) break;
    missing.push(path.relative(base, dir));
  }
  return missing;
}

function corrupt(detail, cause) {
  return new Error(`corrupt ${MANIFEST_NAME}: ${detail}`, cause ? { cause } : undefined);
}

/** Returns the manifest, or null when absent. Throws on a corrupt or unknown-version manifest. */
function readManifest(root) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, MANIFEST_NAME), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw corrupt(err.message, err);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw corrupt('not a JSON object');
  if (parsed.version !== MANIFEST_VERSION) {
    throw new Error(`unsupported ${MANIFEST_NAME} version ${JSON.stringify(parsed.version)}`);
  }
  const files = parsed.files ?? [];
  const dirs = parsed.dirs ?? [];
  const hooks = parsed.hooks ?? [];
  if (!Array.isArray(files) || !files.every((f) => f && typeof f.path === 'string' && typeof f.sha256 === 'string')) {
    throw corrupt('"files" must be a list of { path, sha256 }');
  }
  if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === 'string')) throw corrupt('"dirs" must be a list of strings');
  if (!Array.isArray(hooks)) throw corrupt('"hooks" must be a list');
  return { version: parsed.version, gsdCoreVersion: parsed.gsdCoreVersion ?? null, files, dirs, hooks };
}

function writeManifest(root, { gsdCoreVersion, files, dirs = [], hooks = [] }) {
  const body = {
    version: MANIFEST_VERSION,
    tool: 'gsd-rovo',
    gsdCoreVersion,
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    dirs: [...new Set(dirs)].sort(),
    hooks,
  };
  atomicWrite(path.join(root, MANIFEST_NAME), JSON.stringify(body, null, 2) + '\n');
}

function removeManifest(root) {
  fs.rmSync(path.join(root, MANIFEST_NAME), { force: true });
}

/** rmdir each listed directory that is now empty, deepest first. Returns the ones removed. */
function pruneDirs(root, relDirs) {
  const removed = [];
  for (const rel of [...new Set(relDirs)].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(resolveInRoot(root, rel, 'dir'));
      removed.push(rel);
    } catch (err) {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR'].includes(err.code)) throw err;
    }
  }
  return removed;
}

module.exports = Object.freeze({
  MANIFEST_NAME,
  MANIFEST_VERSION,
  OWNED_DIRS,
  sha256,
  hashFile,
  atomicWrite,
  resolveInRoot,
  missingDirs,
  readManifest,
  writeManifest,
  removeManifest,
  pruneDirs,
});
