#!/usr/bin/env node
'use strict';
// Preview Studio CLI 入口：pvs <command> [args]
const { main } = require('../src/main/cli/index.js');

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`pvs 内部错误：${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  },
);
