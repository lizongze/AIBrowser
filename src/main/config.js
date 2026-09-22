'use strict';
// 用户偏好（界面缩放等）持久化到运行时目录，重启后保持。
const fs = require('node:fs');
const path = require('node:path');
const { runtimeDir } = require('./control/state');

const FILE = 'config.json';
const DEFAULTS = {
  uiScale: 1, // 面板界面缩放（1 = 100%）
  theme: 'light',
  sidebar: false,
};

function configPath() {
  return path.join(runtimeDir(), FILE);
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(patch) {
  const next = { ...read(), ...patch };
  try {
    fs.mkdirSync(runtimeDir(), { recursive: true });
    const target = configPath();
    fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(`${target}.tmp`, target);
  } catch {
    /* 配置写不进去不影响使用 */
  }
  return next;
}

module.exports = { read, write, configPath, DEFAULTS };
