'use strict';

// Syntax-checks every .cjs file under bin/, scripts/, src/ and test/.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
let count = 0;
for (const dir of ['bin', 'scripts', 'src', 'test']) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const rel of fs.readdirSync(abs, { recursive: true })) {
    if (!rel.endsWith('.cjs')) continue;
    execFileSync(process.execPath, ['--check', path.join(abs, rel)], { stdio: 'inherit' });
    count++;
  }
}
process.stdout.write(`checked ${count} files\n`);
