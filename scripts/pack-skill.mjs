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

const KNOWN_PLATFORMS = new Set(['linux', 'win32', 'darwin', 'windows', 'win', 'mac', 'macos', 'osx', 'all']);

function normalizePlatformName(value) {
  const raw = String(value).trim().toLowerCase();
  if (raw === 'windows' || raw === 'win') return 'win32';
  if (raw === 'mac' || raw === 'macos' || raw === 'osx') return 'darwin';
  return raw;
}

/**
 * 解析参数：多个值**用逗号分隔**（`--platforms linux,win32`、`--arch x64,arm64`）。
 * 认不出来的参数会明确警告（空格分隔会被当成无关参数，以前是静默丢掉）。
 */
function parseArgs(argv) {
  const out = { platforms: [], arch: [], tar: true, fromCache: false, unpacked: false, outDir: null, reuse: false, combined: false, unknown: [] };
  const split = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--platforms') out.platforms.push(...split(argv[++i]));
    else if (token === '--arch') out.arch.push(...split(argv[++i]));
    else if (token === '--no-tar') out.tar = false;
    else if (token === '--unpacked') out.unpacked = true;
    else if (token === '--out-dir') out.outDir = String(argv[++i] || '');
    else if (token === '--reuse') out.reuse = true;
    else if (token === '--combined') out.combined = true;
    else if (token === '--from-cache') out.fromCache = true;
    else out.unknown.push(token);
  }
  if (!out.platforms.length) out.platforms = [process.platform];
  if (out.platforms.some((p) => String(p).toLowerCase() === 'all')) out.platforms = ['linux', 'win32', 'darwin'];
  out.platforms = [...new Set(out.platforms.map(normalizePlatformName))];
  out.archList = out.arch.length ? [...new Set(out.arch)] : [process.arch === 'arm64' ? 'arm64' : 'x64'];
  delete out.arch;
  return out;
}

/** 递归硬链接（同一文件系统内瞬间完成）：per-platform 打包时用来复用共享的应用目录 */
async function hardLinkTree(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) await fsp.symlink(await fsp.readlink(from), to);
    else if (entry.isDirectory()) await hardLinkTree(from, to);
    else await fsp.link(from, to);
  }
}

/** 某个平台单独一份的 skill 目录（skeleton 复制 + 该平台 bundle 硬链接） */
async function buildPerPlatformDir(buildRoot, key, info, sharedSkillDir) {
  const pkgRoot = path.join(buildRoot, `pkg-${key}`);
  forceRemove(pkgRoot);
  const dest = path.join(pkgRoot, 'aibrowser');
  // 骨架（文档/脚本/参考）：复制
  for (const name of await fsp.readdir(sharedSkillDir)) {
    if (name === 'bundle') continue;
    await fsp.cp(path.join(sharedSkillDir, name), path.join(dest, name), { recursive: true, verbatimSymlinks: true });
  }
  // 自带应用：硬链接（同一分区，秒级）
  await hardLinkTree(path.join(sharedSkillDir, 'bundle', key), path.join(dest, 'bundle', key));
  // 该包自己的清单（只列本平台）
  const single = {
    name: 'aibrowser-skill',
    productName: 'AIBrowser',
    version: info.version,
    electron: info.electron,
    generatedAt: new Date().toISOString(),
    platforms: { [key]: info },
  };
  await fsp.writeFile(path.join(dest, 'bundle', 'manifest.json'), `${JSON.stringify(single, null, 2)}\n`, 'utf8');
  // BUNDLE.md 只写本平台
  const bundleMdPath = path.join(dest, 'BUNDLE.md');
  let bundleMd = '';
  try {
    bundleMd = await fsp.readFile(bundleMdPath, 'utf8');
  } catch {
    bundleMd = '# 这份 skill 自带 AIBrowser 应用\n';
  }
  const head = bundleMd.split('\n').slice(0, 3).join('\n');
  await fsp.writeFile(bundleMdPath, `${head}\n\n自带平台：${key}\n${bundleMd.split('\n').slice(3).join('\n')}`, 'utf8');
  return { pkgRoot, appDir: dest };
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

/**
 * 登记一个已存在的产物（--reuse）：不重新打包，只算 sha256/大小，用于刷新索引。
 */
async function recordExisting(archivePath, platform, arch) {
  // 包里到底带了哪些平台，直接问压缩包本身（权威），别再依赖临时的组装目录
  let bundlePlatforms = null;
  try {
    const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    bundlePlatforms = [...new Set(listing
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^aibrowser\/bundle\/[^/]+\/[^/]+$/.test(line) || /^aibrowser\/bundle\/[^/]+\/$/.test(line))
      .map((line) => line.split('/')[2]))].filter(Boolean);
  } catch {
    bundlePlatforms = null;
  }
  return {
    platform,
    arch,
    ok: true,
    reused: true,
    archive: archivePath,
    archiveBytes: fs.statSync(archivePath).size,
    sha256: sha256(archivePath),
    builtAt: new Date(fs.statSync(archivePath).mtimeMs).toISOString(),
    version: appVersion,
    electron: electronVersion,
    bundlePlatforms,
  };
}

/**
 * 索引文件：dist-skill/manifest.json 列出每个平台包的位置、sha256、大小、时间，
 * 再配一份 README.txt 说明「只有 .tar.gz 是产物」——免得目录里出现个解包目录让人以为是产物。
 */
async function writeIndex(results, args) {
  const manifestFile = path.join(outRoot, 'manifest.json');
  const previous = (() => {
    try {
      return JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    } catch {
      return { packages: [] };
    }
  })();
  const merged = new Map();
  for (const item of previous.packages || []) {
    if (item && item.archive && fs.existsSync(item.archive)) merged.set(`${item.platform}-${item.arch}`, item);
  }
  for (const item of results) {
    if (item.ok) merged.set(`${item.platform}-${item.arch}`, item);
  }
  const packages = [...merged.values()].sort((a, b) => String(a.platform).localeCompare(String(b.platform)));
  const index = {
    name: 'aibrowser-skill',
    version: appVersion,
    electron: electronVersion,
    generatedAt: new Date().toISOString(),
    host: `${process.platform}-${process.arch}`,
    packages,
    // 给 AI/脚本用：平台 → 该发给对方哪个文件
    pick: Object.fromEntries(packages.map((item) => [`${item.platform}-${item.arch}`, {
      archive: item.archive,
      sha256: item.sha256,
      bytes: item.archiveBytes,
      bundlePlatforms: item.bundlePlatforms || null,
    }])),
  };
  await fsp.writeFile(manifestFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  await fsp.writeFile(path.join(outRoot, 'README.txt'), [
    'AIBrowser —— 自带应用的 skill 分发包',
    '',
    '目录里只有这些是「产物」：',
    '  aibrowser-skill-<版本>-<平台>-<架构>.tar.gz   发给别人的 skill 包（自带该平台的 AIBrowser）',
    '  manifest.json                                 上面这些包的索引（sha256 / 大小 / 打包时间）',
    '',
    '用法（对方机器上）：',
    '  tar -xzf aibrowser-skill-<...>.tar.gz',
    '  cp -r aibrowser ~/.agents/skills/',
    '  bash ~/.agents/skills/aibrowser/scripts/ensure-service.sh',
    '',
    '注意：本目录里若出现 `aibrowser/` 解包目录，那是中间产物（正常不会生成，除非用了 --unpacked）。',
    '      可以放心删除；若删不掉（Windows 侧占用 app.asar），重启后再删或从资源管理器删。',
    '',
  ].join('\n'), 'utf8');
  return manifestFile;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // 在系统临时目录（Linux 原生盘）里组装：repo 在 /mnt/d（drvfs）上，几千个小文件（含 15MB 的 app.asar）
  // 刚写出来就可能被 Windows 侧（索引/杀软）占用，覆盖/删除直接 EACCES。
  // 最终只往 repo 里放一个 tar.gz（单文件，不会被锁），需要解包目录时用 --unpacked。
  const buildRoot = args.outDir ? path.resolve(args.outDir) : path.join(os.tmpdir(), 'aibrowser-skill-build');
  const skillDir = path.join(buildRoot, 'aibrowser');
  if (args.unknown.length) {
    process.stdout.write(`[skill] 忽略了不认识的参数：${args.unknown.join(' ')}`
      + '（多个平台用逗号分隔：--platforms linux,win32）\n');
  }
  process.stdout.write(`[skill] 组装自包含 skill：${args.platforms.join(' / ')} · ${args.archList.join(',')}\n`);
  forceRemove(skillDir);
  await copySkillSkeleton(skillDir);

  const staleUnpacked = path.join(outRoot, 'aibrowser');
  if (fs.existsSync(staleUnpacked)) {
    const removed = forceRemove(staleUnpacked);
    process.stdout.write(removed
      ? '[skill] 清掉上次遗留的解包目录 dist-skill/aibrowser\n'
      : '[skill] 提示：dist-skill/aibrowser 是遗留的中间产物（删不掉：Windows 侧可能还占着 app.asar），\n'
        + '        它不是产物，可稍后手动删除；这次只更新 tar.gz 与 manifest.json\n');
  }

  const bundleRoot = path.join(skillDir, 'bundle');
  await fsp.mkdir(bundleRoot, { recursive: true });
  const platforms = {};
  const results = [];

  for (const platform of args.platforms) {
    for (const arch of args.archList) {
    const existingTar = path.join(outRoot, `aibrowser-skill-${appVersion}-${platform}-${arch}.tar.gz`);
    if (args.reuse && fs.existsSync(existingTar)) {
      process.stdout.write(`[skill] 复用已存在的 ${path.basename(existingTar)}\n`);
      const entry = await recordExisting(existingTar, platform, arch);
      results.push(entry);
      continue;
    }
    const zip = ensureReleaseZip(platform, arch, args.fromCache);
    if (!zip) {
      process.stdout.write(`[skill]   ✗ ${platform}-${arch}：没有 release 包，跳过\n`);
      continue;
    }
    const key = `${platform}-${arch}`;
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
      arch,
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
    '命令行入口（自带应用，不需要 node/npm）：',
    '',
    '| 环境 | 调用方式 |',
    '| --- | --- |',
    '| Git Bash / WSL | `bash scripts/pvs.sh status`（推荐，脚本会自动选平台） |',
    '| cmd.exe | `bundle\\win32-x64\\pvs.cmd status` |',
    '| PowerShell | `& .\\bundle\\win32-x64\\pvs.ps1 status` 或 `& .\\bundle\\win32-x64\\pvs.cmd status` |',
    '',
    '> **别随手加 `&`**，它在不同 shell 里意思不同，只有 PowerShell 该用它：',
    '> 前缀写法 `& "path" args` 在 bash/sh（语法错误）和 cmd.exe（此时不应有 &）里都什么都不执行、拿不到回传；',
    '> 后缀写法 `path args &` 在 bash 里是后台执行（命令会跑，但这一行收不到 stdout 与退出码）；',
    '> 只有 PowerShell 里 `&` 才是调用运算符（以带引号路径开头时必需，输出正常）。',
    '> 最省事：把 `bundle\\win32-x64` 加进 PATH，之后直接写 `pvs status`（无路径、无引号，任何 shell 都不会改写它）。',
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
    const keys = Object.keys(platforms);
    if (args.combined && keys.length) {
      const tarPath = path.join(outRoot, `aibrowser-skill-${appVersion}-all.tar.gz`);
      forceRemove(tarPath);
      execFileSync('tar', ['-czf', tarPath, '-C', buildRoot, 'aibrowser'], { stdio: 'inherit' });
      process.stdout.write(`[skill] 合并分发包（${keys.join(' + ')}）：${path.relative(root, tarPath)}`
        + `（${Math.round(fs.statSync(tarPath).size / 1024 / 1024)}MB）\n`);
      results.push({
        platform: 'all',
        arch: 'any',
        ok: true,
        archive: tarPath,
        archiveBytes: fs.statSync(tarPath).size,
        sha256: sha256(tarPath),
        builtAt: new Date().toISOString(),
        version: appVersion,
        electron: electronVersion,
        bundlePlatforms: keys,
        note: '合并包：一份 skill 里带多个平台',
      });
    }
    for (const [key, info] of keys.length && !args.combined ? Object.entries(platforms) : []) {
      // 每个平台单独一份：只装它自己的 bundle，避免「打某个平台却带着所有平台」的体积翻倍
      const { pkgRoot } = await buildPerPlatformDir(buildRoot, key, info, skillDir);
      const tarPath = path.join(outRoot, `aibrowser-skill-${appVersion}-${key}.tar.gz`);
      forceRemove(tarPath);
      execFileSync('tar', ['-czf', tarPath, '-C', pkgRoot, 'aibrowser'], { stdio: 'inherit' });
      forceRemove(pkgRoot);
      process.stdout.write(`[skill] 分发包：${path.relative(root, tarPath)}（${Math.round(fs.statSync(tarPath).size / 1024 / 1024)}MB）\n`);
      process.stdout.write('         别人拿到后：tar -xzf <包> && cp -r aibrowser ~/.agents/skills/\n');
      info.archive = tarPath;
      results.push({
        platform: key.split('-')[0],
        arch: key.split('-')[1],
        ok: true,
        archive: tarPath,
        archiveBytes: fs.statSync(tarPath).size,
        sha256: sha256(tarPath),
        builtAt: new Date().toISOString(),
        version: appVersion,
        electron: electronVersion,
        bundlePlatforms: [key], // 这一份包里只有这个平台（--combined 时才是全部）
        note: 'skill 包：自带应用，对方无需 node/npm',
      });
    }
  }
  const indexFile = await writeIndex(results, args);
  process.stdout.write(`[skill] 索引：${path.relative(root, indexFile)}\n`);

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
