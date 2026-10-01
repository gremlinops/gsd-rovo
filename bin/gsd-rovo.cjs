#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli.cjs');

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    const detail = process.env.GSD_ROVO_DEBUG ? (err && err.stack) || err : (err && err.message) || err;
    process.stderr.write(`FAIL  ${detail}\n`);
    process.exitCode = 1;
  },
);
