'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const doctor = require('./doctor.cjs');
const eos = require('./eos.cjs');
const manifest = require('./manifest.cjs');
const projection = require('./projection.cjs');

const USAGE = `gsd-rovo - GSD integration for Atlassian Rovo CLI.

Usage:
  gsd-rovo install [--root <dir>] [--force]
  gsd-rovo uninstall [--root <dir>] [--force]
  gsd-rovo descriptor
  gsd-rovo doctor [--root <dir>]

Options:
  --root <dir>   Rovo CLI config dir (default: ~/.rovo).
  --force        install: overwrite files that were changed or not installed by gsd-rovo.
                 uninstall: also remove tracked files that were changed after install.
  -h, --help     Show this help.`;

function createOutput(stdout = process.stdout, stderr = process.stderr) {
  return {
    info: (msg) => stdout.write(`ok    ${msg}\n`),
    warn: (msg) => stderr.write(`warn  ${msg}\n`),
    fail: (msg) => stderr.write(`FAIL  ${msg}\n`),
    raw: (msg) => stdout.write(msg),
  };
}

function parseArgs(argv) {
  const args = { command: null, root: null, force: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        args.errors.push('--root needs a value');
      } else {
        args.root = value;
        i++;
      }
    } else if (a.startsWith('--root=')) {
      args.root = a.slice('--root='.length) || null;
      if (!args.root) args.errors.push('--root needs a value');
    } else if (a === '--force') {
      args.force = true;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a.startsWith('-')) {
      args.errors.push(`unknown option ${a}`);
    } else if (args.command === null) {
      args.command = a;
    } else {
      args.errors.push(`unexpected argument ${a}`);
    }
  }
  return args;
}

function resolveRoot(rootFlag, home = os.homedir()) {
  if (!rootFlag) return path.join(home, '.rovo');
  return path.resolve(rootFlag.replace(/^~(?=$|\/)/, home));
}

function assertSafeRoot(root, home = os.homedir()) {
  if (root === path.parse(root).root || root === path.resolve(home)) {
    throw new Error(`refusing to use ${root} as the Rovo CLI config dir`);
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function relTo(root, abs) {
  return path.relative(path.resolve(root), abs);
}

function cmdInstall({ root, force = false, ctx, artifacts, out }) {
  const prev = manifest.readManifest(root);
  const recorded = new Map();
  for (const f of prev?.files ?? []) recorded.set(manifest.resolveInRoot(root, f.path), f.sha256);
  const prevDirs = (prev?.dirs ?? []).map((d) => relTo(root, manifest.resolveInRoot(root, d, 'dir')));

  const seen = new Set();
  const writes = [];
  const unchanged = [];
  const conflicts = [];
  for (const art of artifacts) {
    const abs = manifest.resolveInRoot(root, art.relativePath);
    if (seen.has(abs)) throw new Error(`duplicate artifact path: ${art.relativePath}`);
    seen.add(abs);
    const entry = { path: relTo(root, abs), sha256: manifest.sha256(art.content) };
    const onDisk = manifest.hashFile(abs);
    const owned = recorded.get(abs);
    if (onDisk !== null && owned === undefined) {
      conflicts.push({ path: entry.path, reason: 'exists and is not managed by gsd-rovo' });
    } else if (onDisk === entry.sha256) {
      unchanged.push(entry);
      continue;
    } else if (onDisk !== null && onDisk !== owned) {
      conflicts.push({ path: entry.path, reason: 'changed since last install' });
    }
    writes.push({ abs, content: art.content, entry });
  }

  const deletes = [];
  for (const [abs, owned] of recorded) {
    if (seen.has(abs)) continue;
    const onDisk = manifest.hashFile(abs);
    if (onDisk === null) continue;
    if (onDisk !== owned) conflicts.push({ path: relTo(root, abs), reason: 'no longer shipped, but changed since last install' });
    deletes.push(abs);
  }

  if (conflicts.length > 0 && !force) {
    for (const c of conflicts) out.fail(`${c.path}: ${c.reason}`);
    out.fail(`refusing to install: ${plural(conflicts.length, 'conflict')}. Nothing was written. Re-run with --force to overwrite.`);
    return 1;
  }
  for (const c of conflicts) out.warn(`overwriting (--force): ${c.path}`);

  const dirs = new Set(prevDirs);
  for (const w of writes) for (const d of manifest.missingDirs(root, w.abs)) dirs.add(d);
  const hooks = prev?.hooks ?? [];

  // Record ownership of everything about to be written first, so a crash part-way
  // leaves files that the next install recognises instead of calling them unmanaged.
  const pending = [...recorded].map(([abs, sha256]) => ({ path: relTo(root, abs), sha256 }));
  for (const w of writes) if (!recorded.has(w.abs)) pending.push(w.entry);
  manifest.writeManifest(root, { gsdCoreVersion: ctx.coreVersion, files: pending, dirs: [...dirs], hooks });

  for (const w of writes) manifest.atomicWrite(w.abs, w.content);
  for (const abs of deletes) fs.rmSync(abs, { force: true });
  for (const d of manifest.pruneDirs(root, [...dirs])) dirs.delete(d);

  manifest.writeManifest(root, {
    gsdCoreVersion: ctx.coreVersion,
    files: [...writes.map((w) => w.entry), ...unchanged],
    dirs: [...dirs],
    hooks,
  });

  out.info(`installed into ${root}: ${plural(writes.length, 'file')} written, ${unchanged.length} unchanged, ${deletes.length} removed`);
  return 0;
}

function cmdUninstall({ root, force = false, out }) {
  const current = manifest.readManifest(root);
  if (!current) {
    out.warn(`no ${manifest.MANIFEST_NAME} in ${root}: nothing to uninstall`);
    return 0;
  }
  const files = current.files.map((f) => ({ ...f, abs: manifest.resolveInRoot(root, f.path) }));
  for (const d of current.dirs) manifest.resolveInRoot(root, d, 'dir');

  let removed = 0;
  const kept = [];
  for (const f of files) {
    const onDisk = manifest.hashFile(f.abs);
    if (onDisk === null) continue;
    if (onDisk !== f.sha256 && !force) {
      kept.push({ path: f.path, sha256: f.sha256 });
      continue;
    }
    fs.rmSync(f.abs, { force: true });
    removed++;
  }
  const prunedDirs = new Set(manifest.pruneDirs(root, current.dirs));

  if (kept.length > 0) {
    manifest.writeManifest(root, {
      gsdCoreVersion: current.gsdCoreVersion,
      files: kept,
      dirs: current.dirs.filter((d) => !prunedDirs.has(d)),
      hooks: current.hooks,
    });
    for (const f of kept) out.warn(`kept (changed after install): ${f.path}`);
  } else {
    manifest.removeManifest(root);
  }
  out.info(`uninstalled from ${root}: ${plural(removed, 'file')} removed, ${kept.length} kept`);
  return 0;
}

function cmdDescriptor({ ctx, out }) {
  out.raw(JSON.stringify(eos.descriptorOf(ctx), null, 2) + '\n');
  return 0;
}

async function main(argv, { out = createOutput(), home = os.homedir() } = {}) {
  const args = parseArgs(argv);
  if (args.errors.length > 0) {
    for (const e of args.errors) out.fail(e);
    out.raw(USAGE + '\n');
    return 2;
  }
  if (args.help || args.command === null) {
    out.raw(USAGE + '\n');
    return 0;
  }
  const root = resolveRoot(args.root, home);
  switch (args.command) {
    case 'install': {
      assertSafeRoot(root, home);
      const ctx = eos.initialize();
      return cmdInstall({ root, force: args.force, ctx, artifacts: projection.buildArtifacts(ctx), out });
    }
    case 'uninstall':
      assertSafeRoot(root, home);
      return cmdUninstall({ root, force: args.force, out });
    case 'descriptor':
      return cmdDescriptor({ ctx: eos.initialize(), out });
    case 'doctor':
      return doctor.cmdDoctor({ root, out });
    default:
      out.fail(`unknown command ${args.command}`);
      out.raw(USAGE + '\n');
      return 2;
  }
}

module.exports = Object.freeze({
  USAGE,
  createOutput,
  parseArgs,
  resolveRoot,
  assertSafeRoot,
  cmdInstall,
  cmdUninstall,
  cmdDescriptor,
  main,
});
