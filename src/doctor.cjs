'use strict';

const fs = require('node:fs');
const path = require('node:path');

const eos = require('./eos.cjs');
const manifest = require('./manifest.cjs');

function findOnPath(name, env = process.env, platform = process.platform) {
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not in this directory
      }
    }
  }
  return null;
}

function cmdDoctor({ root, out, initialize = eos.initialize, findRovo = () => findOnPath('rovo') }) {
  let ctx;
  try {
    ctx = initialize();
  } catch (err) {
    out.fail(`gsd-core handshake failed: ${err.message}`);
    return 1;
  }
  out.info(`gsd-core ${ctx.coreVersion} at ${ctx.coreRoot}`);
  out.info(`handshake: protocol v${ctx.negotiation.protocolVersion}, profile ${ctx.profile}`);
  for (const w of ctx.negotiation.warnings) {
    if (!/undocumented/.test(w)) out.warn(`negotiation: ${w}`);
  }
  for (const [point, p] of Object.entries(ctx.negotiation.points)) {
    if (p.effectiveLevel !== 'full') out.warn(`interface point ${point}: ${p.effectiveLevel} (${p.fallback})`);
  }

  const rovo = findRovo();
  if (rovo) out.info(`rovo found: ${rovo}`);
  else out.warn('rovo not found on PATH; Rovo CLI is needed to use GSD');

  let current;
  try {
    current = manifest.readManifest(root);
  } catch (err) {
    out.fail(err.message);
    return 1;
  }
  if (!current) {
    out.fail(`not installed in ${root} (no ${manifest.MANIFEST_NAME})`);
    return 1;
  }
  if (current.gsdCoreVersion !== ctx.coreVersion) {
    out.warn(`installed from gsd-core ${current.gsdCoreVersion}, current is ${ctx.coreVersion}: run install again`);
  }

  let failures = 0;
  let changed = 0;
  for (const f of current.files) {
    let abs;
    try {
      abs = manifest.resolveInRoot(root, f.path);
    } catch (err) {
      failures++;
      out.fail(err.message);
      continue;
    }
    const onDisk = manifest.hashFile(abs);
    if (onDisk === null) {
      failures++;
      out.fail(`missing: ${f.path}`);
    } else if (onDisk !== f.sha256) {
      changed++;
      out.warn(`changed after install: ${f.path}`);
    }
  }
  out.info(`${current.files.length} tracked files: ${failures} problems, ${changed} changed`);

  if (failures > 0) {
    out.fail('unhealthy: run install again');
    return 1;
  }
  out.info('healthy');
  return 0;
}

module.exports = Object.freeze({ findOnPath, cmdDoctor });
