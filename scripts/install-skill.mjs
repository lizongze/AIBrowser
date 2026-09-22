#!/usr/bin/env node
// 把 skills/aibrowser 安装到 DSH 的 skill 目录（符号链接），使新会话能直接发现。
// 由 package.json 的 postinstall 调用；也可手动 `node scripts/install-skill.mjs`。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillDir = path.join(root, 'skills', 'aibrowser');

if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
  console.log('[aibrowser] 未找到 skills/aibrowser/SKILL.md，跳过 skill 安装');
  process.exit(0);
}

const targets = [
  path.join(root, '.agents', 'skills'),
  path.join(os.homedir(), '.agents', 'skills'),
];

let installed = 0;
for (const dir of targets) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const link = path.join(dir, 'aibrowser');
    if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) {
      const stat = fs.lstatSync(link);
      if (stat.isSymbolicLink()) {
        const current = fs.readlinkSync(link);
        if (path.resolve(current) === skillDir) continue; // 已正确链接
        fs.unlinkSync(link);
      } else {
        continue; // 真实目录，不覆盖
      }
    }
    fs.symlinkSync(skillDir, link, 'dir');
    console.log(`[aibrowser] skill 已安装: ${link} -> ${skillDir}`);
    installed += 1;
  } catch (err) {
    console.log(`[aibrowser] 安装 skill 到 ${dir} 失败（可忽略）：${err.message}`);
  }
}

if (installed === 0) console.log('[aibrowser] skill 已是最新（无需改动）');
