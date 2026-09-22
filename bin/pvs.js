#!/usr/bin/env node
'use strict';
// AIBrowser CLI 入口：pvs <command> [args]
const { main } = require('../src/main/cli/index.js');
// 下游（agent 的 shell / 管道）先退出时 stderr 已断，报错本身也不能再抛出去
const { writeStderr } = require('../src/main/safe-io.js');

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    writeStderr(`pvs 内部错误：${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  },
);
