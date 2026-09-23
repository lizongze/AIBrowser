// AIBrowser — 把「skill + 自带应用」打成一个自包含目录
//
// 目标：别人只拿 skill 就能用 —— 不需要 clone 项目、不需要 npm install、不需要 node，
// skill 里自带一份 release 应用（按平台放），脚本自动找到它。
//
// 用法：
//   node scripts/pack-skill.mjs --platforms linux              # 只带 linux-x64
//   node scripts/pack-skill.mjs --platforms linux,win32,darwin  # 三平台都带（体积大）
//   node scripts/pack-skill.mjs --platforms linux --tar        # 额外产出可分发的 tar.gz
//   node scripts/pack-skill.mjs --platforms linux --from-cache # 直接用 release/ 里已有的 zip
//
// 产物：
//   dist-skill/aibrowser/               自包含 skill（拷进 ~/.agents/skills/ 即可用）
//   dist-skill/aibrowser-skill-<版本>-<平台>.tar.gz   （--tar 时）
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const skillSource = path.join(root, 'skills', 'aibrowser');
const outRoot = path.join(root, 'dist-skill');
const { version: appVersion, devDependencies = {} } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = String(devDependencies.electron || '').replace(/^[^\d]*/, '');

function parseArgs(argv) {
  const out = { platforms: ['linux'], arch: process.arch === 'arm64' ? 'arm64' : 'x64', tar: true, fromCache: false, unpacked: false, outDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--platforms') out.platforms = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--arch') out.arch = String(argv[++i] || 'x64');
    else if (argv[i] === '--no-tar') out.tar = false;
    else if (argv[i] === '--unpacked') out.unpacked = true;
    else if (argv[i] === '--out-dir') out.outDir = String(argv[++i] || '');
    else if (argv[i] === '--from-cache') out.fromCache = true;
  }
  out.platforms = [...new Set(out.platforms.map((p) => (p === 'windows' ? 'win32' : p === 'mac' || p === 'macos' ? 'darwin' : p)))];
  return out;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function dirSize(dir) {
  let total = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  walk(dir);
  return total;
}

/** 递归删除：先把目录权限放开（macOS 的 .app 里有 drw-r--r-- 这种目录），符号链接不 chmod */
function forceRemove(target) {
  const fix = (current) => {
    try {
      fs.chmodSync(current, 0o755);
    } catch {
      /* 忽略 */
    }
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) fix(full);
      else {
        try {
          fs.chmodSync(full, 0o644);
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  try {
    if (fs.existsSync(target)) fix(target);
  } catch {
    /* 忽略 */
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return true;
    } catch {
      try {
        execFileSync('sleep', ['1']);
      } catch {
        /* 忽略 */
      }
    }
  }
  return !fs.existsSync(target);
}

/** release/AIBrowser-<版本>-<平台>-<架构>.zip 必须已存在（先跑 npm run package） */
function ensureReleaseZip(platform, arch, fromCache) {
  const zip = path.join(root, 'release', `AIBrowser-${appVersion}-${platform}-${arch}.zip`);
  if (fs.existsSync(zip)) return zip;
  if (fromCache) return null;
  process.stdout.write(`[skill] 缺少 ${path.basename(zip)}，先打包 ${platform}-${arch} …\n`);
  try {
    execFileSync(process.execPath, [path.join(scriptDir, 'package.mjs'), '--targets', platform, '--arch', arch], { cwd: root, stdio: 'inherit' });
  } catch {
    return null;
  }
  return fs.existsSync(zip) ? zip : null;
}

/** 把 zip 解到目标目录（用 python3 的 zipfile：unzip 在一些环境里不可用） */
function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const script = [
    'import sys, zipfile, os, stat',
    'zip_path, dest = sys.argv[1], sys.argv[2]',
    'with zipfile.ZipFile(zip_path) as z:',
    '    z.extractall(dest)',
    '    for info in z.infolist():',
    '        mode = info.external_attr >> 16',
    '        if mode and stat.S_ISREG(mode):',
    '            target = os.path.join(dest, info.filename)',
    '            try: os.chmod(target, 0o755 if mode & stat.S_IXUSR else 0o644)',
    '            except OSError: pass',
  ].join('\n');
  execFileSync('python3', ['-c', script, zip, dest], { stdio: 'inherit' });
}

/** 复制 skill 自身的内容（脚本、文档、参考） */
async function copySkillSkeleton(skillDir) {
  await fsp.cp(skillSource, skillDir, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}bundle`), // 旧的 bundle 不复制
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // 在系统临时目录（Linux 原生盘）里组装：repo 在 /mnt/d（drvfs）上，几千个小文件（含 15MB 的 app.asar）
  // 刚写出来就可能被 Windows 侧（索引/杀软）占用，覆盖/删除直接 EACCES。
  // 最终只往 repo 里放一个 tar.gz（单文件，不会被锁），需要解包目录时用 --unpacked。
  const buildRoot = args.outDir ? path.resolve(args.outDir) : path.join(os.tmpdir(), 'aibrowser-skill-build');
  const skillDir = path.join(buildRoot, 'aibrowser');
  process.stdout.write(`[skill] 组装自包含 skill：${args.platforms.join(' / ')} · ${args.arch}\n`);
  forceRemove(skillDir);
  await copySkillSkeleton(skillDir);

  const bundleRoot = path.join(skillDir, 'bundle');
  await fsp.mkdir(bundleRoot, { recursive: true });
  const platforms = {};

  for (const platform of args.platforms) {
    const zip = ensureReleaseZip(platform, args.arch, args.fromCache);
    if (!zip) {
      process.stdout.write(`[skill]   ✗ ${platform}-${args.arch}：没有 release 包，跳过\n`);
      continue;
    }
    const key = `${platform}-${args.arch}`;
    const dest = path.join(bundleRoot, key);
    process.stdout.write(`[skill]   解包 ${path.basename(zip)} → bundle/${key}\n`);
    extractZip(zip, dest);
    // zip 里带一层 AIBrowser-<平台>-<架构>/，把它拍平成 bundle/<平台>-<架构>/ 直接放应用。
    // 用「复制 + 删除」而不是 rename：/mnt/d（drvfs）上跨层 rename 会失败。
    const entries = fs.readdirSync(dest);
    const inner = entries.find((name) => name.startsWith('AIBrowser-') && fs.statSync(path.join(dest, name)).isDirectory());
    if (inner) {
      const innerPath = path.join(dest, inner);
      const staging = `${dest}-staging`;
      forceRemove(staging);
      await fsp.mkdir(staging, { recursive: true });
      await fsp.cp(innerPath, staging, { recursive: true, verbatimSymlinks: true });
      forceRemove(dest);
      await fsp.mkdir(dest, { recursive: true });
      for (const name of fs.readdirSync(staging)) {
        await fsp.cp(path.join(staging, name), path.join(dest, name), { recursive: true, verbatimSymlinks: true });
      }
      forceRemove(staging);
    }
    const exe = platform === 'win32' ? 'AIBrowser.exe' : platform === 'darwin' ? path.join('AIBrowser.app', 'Contents', 'MacOS', 'AIBrowser') : 'AIBrowser';
    const cli = platform === 'win32' ? 'pvs.cmd' : 'pvs';
    if (!fs.existsSync(path.join(dest, exe))) {
      process.stdout.write(`[skill]   ✗ ${key}：解包后找不到 ${exe}\n`);
      continue;
    }
    if (platform !== 'win32') {
      try {
        fs.chmodSync(path.join(dest, cli), 0o755);
        fs.chmodSync(path.join(dest, exe), 0o755);
      } catch {
        /* 忽略 */
      }
    }
    platforms[key] = {
      platform,
      arch: args.arch,
      dir: `bundle/${key}`,
      executable: path.join(`bundle/${key}`, exe),
      cli: path.join(`bundle/${key}`, cli),
      sha256: sha256(zip),
      bytes: dirSize(dest),
      electron: electronVersion,
      version: appVersion,
    };
    process.stdout.write(`[skill]   ✓ ${key}（${Math.round(dirSize(dest) / 1024 / 1024)}MB）\n`);
  }

  const manifest = {
    name: 'aibrowser-skill',
    productName: 'AIBrowser',
    version: appVersion,
    electron: electronVersion,
    generatedAt: new Date().toISOString(),
    host: `${process.platform}-${process.arch}`,
    platforms,
  };
  await fsp.writeFile(path.join(bundleRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // 说明文件：告诉使用者这份 skill 自带应用，怎么装、怎么用
  await fsp.writeFile(path.join(skillDir, 'BUNDLE.md'), [
    '# 这份 skill 自带 AIBrowser 应用',
    '',
    `版本 ${appVersion} · Electron ${electronVersion} · 自带平台：${Object.keys(platforms).join('、') || '（无）'}`,
    '',
    '不需要 clone 项目、不需要 npm install、也不需要装 node —— 直接把这个目录放到 skill 位置即可：',
    '',
    '```bash',
    '# 全局（所有项目的 agent 都能用）',
    'cp -r aibrowser ~/.agents/skills/',
    '# 或者只给当前项目',
    'cp -r aibrowser <项目>/.agents/skills/',
    '',
    'bash ~/.agents/skills/aibrowser/scripts/ensure-service.sh   # 首次：拉起服务',
    'bash ~/.agents/skills/aibrowser/scripts/pvs.sh status       # 之后直接用',
    '```',
    '',
    '脚本会优先使用本目录 `bundle/<平台>-<架构>/` 里的应用；只有在找不到时才回退到',
    '`$PVS_HOME`（开发用）或 `PATH` 里的 `pvs`。',
    '',
    'macOS 产物未签名：首次打开需右键「打开」，或 `xattr -dr com.apple.quarantine <app>`。',
    '',
    `清单（各平台可执行文件与 sha256）：\`bundle/manifest.json\``,
    '',
  ].join('\n'), 'utf8');

  const sizeMb = Math.round(dirSize(skillDir) / 1024 / 1024);
  process.stdout.write(`[skill] 完成：${path.relative(root, skillDir)}（${sizeMb}MB，${Object.keys(platforms).length} 个平台）\n`);

  fs.mkdirSync(outRoot, { recursive: true });
  if (args.tar) {
    for (const [key, info] of Object.entries(platforms)) {
      const tarPath = path.join(outRoot, `aibrowser-skill-${appVersion}-${key}.tar.gz`);
      forceRemove(tarPath);
      execFileSync('tar', ['-czf', tarPath, '-C', buildRoot, 'aibrowser'], { stdio: 'inherit' });
      process.stdout.write(`[skill] 分发包：${path.relative(root, tarPath)}（${Math.round(fs.statSync(tarPath).size / 1024 / 1024)}MB）\n`);
      process.stdout.write('         别人拿到后：tar -xzf <包> && cp -r aibrowser ~/.agents/skills/\n');
      info.archive = tarPath;
    }
  }
  if (args.unpacked) {
    const unpacked = path.join(outRoot, 'aibrowser');
    if (forceRemove(unpacked) || !fs.existsSync(unpacked)) {
      try {
        await fsp.cp(skillDir, unpacked, { recursive: true, verbatimSymlinks: true });
        process.stdout.write(`[skill] 解包目录：${path.relative(root, unpacked)}\n`);
      } catch (err) {
        process.stdout.write(`[skill] 解包目录复制失败（/mnt/d 上易被占用）：${err.message}\n`);
      }
    } else {
      process.stdout.write('[skill] 旧解包目录删不掉（Windows 侧占用），跳过 --unpacked\n');
    }
  }
}

await main();
