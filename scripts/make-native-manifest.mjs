#!/usr/bin/env node
// 生成 Windows 原生依赖目录的 package.json（只含依赖声明与构建脚本）。
// 由 start-windows.cmd 调用：node scripts/make-native-manifest.mjs node_modules.win
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(root, process.argv[2] || 'node_modules.win');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const manifest = {
  name: 'aibrowser-native',
  private: true,
  version: pkg.version,
  description: 'AIBrowser 的 Windows 原生运行依赖（由 start-windows.cmd 自动生成）',
  scripts: { build: 'node ../scripts/build.mjs' },
  dependencies: pkg.dependencies || {},
  devDependencies: pkg.devDependencies || {},
};

fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`已生成 ${path.relative(root, path.join(target, 'package.json'))}`);
