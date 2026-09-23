// AIBrowser — 打包脚本
// 目标：为每个平台产出一个「拿起来就能跑」的应用目录 + zip，并写一份清单（release/manifest.json），
// 让 AI 直接按平台选文件，不需要装 node / npm / 依赖。
//
// 用法：
//   node scripts/package.mjs                        # 当前平台
//   node scripts/package.mjs --targets linux,win32   # 指定目标
//   node scripts/package.mjs --targets all           # linux + win32 + darwin（能下到 Electron 就行）
//   node scripts/package.mjs --arch arm64            # 换架构（darwin 常用）
//
// Electron 二进制来源（按顺序尝试，都不需要手工准备）：
//   1) 本机缓存 ~/.cache/aibrowser-electron/*.zip（本脚本自己下的）
//   2) 已有的 node_modules / node_modules.win* 里的 dist/（离线也能打 Windows 包）
//   3) 从镜像 / GitHub 下载 electron-v<版本>-<平台>-<架构>.zip
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const releaseDir = path.join(root, 'release');
const cacheDir = path.join(os.homedir(), '.cache', 'aibrowser-electron');
const { version: appVersion, devDependencies = {}, name: packageName } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = String(devDependencies.electron || '').replace(/^[^\d]*/, '') || '38.0.0';

// 打包时不需要进包的东西：源码仓库的元数据、开发脚本、各平台的依赖目录、验收产物
const IGNORE = [
  /^\/release($|\/)/,
  /^\/dist-skill($|\/)/,     // skill 自包含打包的中间产物（含整份应用！漏了会让 asar 翻倍）
  /^\/skills\/aibrowser\/bundle($|\/)/,
  /^\/aibrowser-shots($|\/)/,
  /^\/[^/]+\.tar\.gz$/,
  /^\/gen($|\/)/,
  /^\/screenshots($|\/)/,
  /^\/\.temp($|\/)/,
  /^\/\.git($|\/)/,
  /^\/node_modules\.win/,
  /^\/scripts($|\/)/,
  /^\/skills($|\/)/,
  /^\/docs($|\/)/,
  /^\/images($|\/)/,
  /^\/\.agents($|\/)/,
  /^\/\.aibrowser($|\/)/,
  /^\/aibrowser-shots($|\/)/,
  /^\/start-windows\.cmd$/,
  /^\/run-native\.cmd$/,
];

const KNOWN_PLATFORMS = new Set(['linux', 'win32', 'darwin', 'windows', 'win', 'mac', 'macos', 'osx', 'all']);

function normalizePlatformName(value) {
  const raw = String(value).trim().toLowerCase();
  if (raw === 'windows' || raw === 'win') return 'win32';
  if (raw === 'mac' || raw === 'macos' || raw === 'osx') return 'darwin';
  return raw;
}

/**
 * 解析参数：多个值**用逗号分隔**（`--targets linux,win32`、`--arch x64,arm64`）。
 * 认不出来的参数会明确警告（踩过坑：写成空格分隔时后一个平台被静默丢掉，只打出一个平台，
 * 人会以为脚本坏了 —— 现在至少会说出来）。
 */
function parseArgs(argv) {
  const out = { targets: [], arch: [], keepDir: false, skipExisting: false, unknown: [] };
  const split = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--targets') out.targets.push(...split(argv[++i]));
    else if (token === '--arch') out.arch.push(...split(argv[++i]));
    else if (token === '--keep-dir') out.keepDir = true;
    else if (token === '--skip-existing') out.skipExisting = true;
    else out.unknown.push(token);
  }
  if (!out.targets.length) out.targets = [process.platform];
  if (out.targets.some((t) => String(t).toLowerCase() === 'all')) out.targets = ['linux', 'win32', 'darwin'];
  out.targets = [...new Set(out.targets.map(normalizePlatformName))];
  out.archList = out.arch.length ? [...new Set(out.arch)] : [process.arch === 'arm64' ? 'arm64' : 'x64'];
  return out;
}

/** 目标平台 → 产物里的可执行文件名 */
function executableName(platform) {
  if (platform === 'win32') return 'AIBrowser.exe';
  if (platform === 'darwin') return path.join('AIBrowser.app', 'Contents', 'MacOS', 'AIBrowser');
  return 'AIBrowser';
}

/**
 * 压缩目录成 zip。
 * 不依赖系统 `zip` 命令（WSL 里常见没装）：优先用 python3 的 zipfile（项目里已经在用 python3），
 * 再退回 `zip`。`contents` 为 true 时把 rootDir 的内容放在 zip 根（Electron 预编译包的约定），
 * 否则把 baseDir 这一层也带进去（应用产物的习惯）。
 */
function makeZip(rootDir, zipPath, { contents = false, baseDir = null } = {}) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  forceRemove(zipPath);
  const script = contents
    ? 'import shutil,sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])'
    : 'import shutil,sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2], sys.argv[3])';
  const args = contents ? [zipPath, rootDir] : [zipPath, rootDir, baseDir];
  try {
    execFileSync('python3', ['-c', script, ...args], { stdio: 'inherit' });
    return zipPath;
  } catch {
    /* 没有 python3 就退回 zip 命令 */
  }
  const zipArgs = contents ? ['-q', '-r', '-X', zipPath, '.'] : ['-q', '-r', '-y', zipPath, baseDir];
  execFileSync('zip', zipArgs, { cwd: rootDir, stdio: 'inherit' });
  return zipPath;
}

/** 从已安装的 electron 包里拿一份本平台 dist，压成 packager 需要的 zip（离线兜底） */
function zipFromInstalledDist(platform, arch, zipPath) {
  // Windows 侧的依赖目录（node_modules.win*）里本来就有一份 Windows dist，
  // 在 Linux 上交叉打 Windows 包时直接用它，省一次 100MB 下载（离线也能打）。
  // 只认「平台对得上」的那份 dist：装在本机的 dist 是 host 平台的，
  // node_modules.win* 里的是 Windows 的。darwin 一律走下载（否则会拿 Linux 文件拼出假 .app，
  // packager 随后报找不到 Electron.app/Contents/Info.plist）。
  const candidates = [];
  if (platform === process.platform) candidates.push(path.join(root, 'node_modules', 'electron', 'dist'));
  if (platform === 'win32') {
    candidates.push(...['node_modules.win2', 'node_modules.win3', 'node_modules.win']
      .map((dir) => path.join(root, dir, 'node_modules', 'electron', 'dist')));
  }
  // 再把期望的目录结构核对一遍，避免「文件名碰巧一样」
  const dist = candidates.find((dir) => {
    if (platform === 'darwin') return fs.existsSync(path.join(dir, 'Electron.app', 'Contents', 'Info.plist'));
    if (platform === 'win32') return fs.existsSync(path.join(dir, 'electron.exe')) && fs.existsSync(path.join(dir, 'resources', 'default_app.asar'));
    return fs.existsSync(path.join(dir, 'electron')) && fs.existsSync(path.join(dir, 'resources', 'default_app.asar'));
  });
  if (!dist) return null;
  // zip 内部必须是 dist 的内容（不带顶层目录），packager 按这个约定解压
  makeZip(dist, zipPath, { contents: true });
  return zipPath;
}

/** 下载 electron 预编译包（先镜像后官方） */
async function downloadElectronZip(platform, arch, zipPath) {
  const file = `electron-v${electronVersion}-${platform}-${arch}.zip`;
  const urls = [
    `https://registry.npmmirror.com/-/binary/electron/${electronVersion}/${file}`,
    `https://github.com/electron/electron/releases/download/v${electronVersion}/${file}`,
  ];
  for (const url of urls) {
    try {
      process.stdout.write(`[package] 下载 ${url}\n`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024 * 1024) throw new Error(`文件过小（${buf.length}B）`);
      fs.mkdirSync(path.dirname(zipPath), { recursive: true });
      await fsp.writeFile(zipPath, buf);
      return zipPath;
    } catch (err) {
      process.stdout.write(`[package]   失败：${err.message}\n`);
    }
  }
  return null;
}

/**
 * 检查一份 Electron zip 是不是「这个平台」的。
 * 缓存里可能留着之前用错平台拼出来的包（例如把 Linux dist 命名成 darwin 的），
 * 只看文件名会一直踩坑，所以按包内标志性文件判断。
 */
function zipLooksValid(platform, zipPath) {
  const markers = platform === 'darwin'
    ? ['Electron.app/Contents/Info.plist']
    : platform === 'win32'
      ? ['electron.exe']
      : ['electron'];
  try {
    // 注意用 chr(10) 而不是 "\n"：那段 Python 代码是 JS 字符串字面量，写 \n 会被真正换行破坏
    const listing = execFileSync('python3', ['-c', 'import sys,zipfile;print(chr(10).join(zipfile.ZipFile(sys.argv[1]).namelist()))', zipPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return markers.every((marker) => listing.split('\n').some((line) => line === marker || line.startsWith(`${marker}/`)));
  } catch {
    return true; // 判断不了就不拦（比如没装 python3）
  }
}

/** 确保某个平台/架构的 Electron zip 就绪 */
async function ensureElectronZip(platform, arch) {
  const file = `electron-v${electronVersion}-${platform}-${arch}.zip`;
  const local = path.join(cacheDir, file);
  if (fs.existsSync(local)) {
    if (zipLooksValid(platform, local)) return local;
    process.stdout.write(`[package] 缓存里的 ${file} 不是 ${platform} 的包，重新获取\n`);
    forceRemove(local);
  }
  // 系统里已有的 electron 缓存目录（electron 安装器下载的）
  const cached = (() => {
    const base = path.join(os.homedir(), '.cache', 'electron');
    try {
      for (const dir of fs.readdirSync(base)) {
        const candidate = path.join(base, dir, file);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      /* 没有缓存目录 */
    }
    return null;
  })();
  if (cached && zipLooksValid(platform, cached)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.copyFileSync(cached, local);
    return local;
  }
  {
    // 本平台，或 Windows 目标（node_modules.win* 里有现成 dist）都可以省掉下载
    const zipped = zipFromInstalledDist(platform, arch, local);
    if (zipped && zipLooksValid(platform, zipped)) {
      process.stdout.write(`[package] 用已装的 Electron dist 生成 ${file}\n`);
      return zipped;
    }
    if (zipped) forceRemove(local);
  }
  return downloadElectronZip(platform, arch, local);
}

/**
 * 删目录/文件前先把权限放开。
 * /mnt/d（drvfs）会把「只读文件」映射成 Windows 只读属性，asar 打包出来的 app.asar 就是 0444，
 * 直接 rm 会 EACCES；先 chmod 再删就没事。
 */
function forceRemove(target) {
  const fix = (current) => {
    // 必须先把自己放开：macOS 的 .app 里有 `drw-r--r--` 这种「没有 x 位」的目录，
    // 缺 x 位时连 readdir 都进不去（EACCES），后序 chmod 就永远轮不到它的子项。
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
      // 符号链接绝对不能 chmod：chmod 会顺着链接改到**目标**上，而 macOS 的 .app 里
      // Frameworks 全是链接（Versions/Current、Resources…），一改就会把目标目录的 x 位抹掉，
      // 之后连删都删不动（EACCES）。
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
      // drvfs 上偶尔会被 Windows 侧短暂占用，等一下再试
      try {
        execFileSync('sleep', ['1']);
      } catch {
        /* 忽略 */
      }
    }
  }
  return !fs.existsSync(target);
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function dirSize(dir) {
  let total = 0;
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
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

/** 在打包结果里放一份 pvs 命令行入口：用同一份 Electron 以 Node 模式跑 bin/pvs.js */
async function writeCliShim(appDir, platform) {
  const shimName = platform === 'win32' ? 'pvs.cmd' : 'pvs';
  // 应用代码默认打进 resources/app.asar（asar 打包时），用 app.asar 路径；
  // 若将来改成 asar:false，这里也能用 app/ 找到（shim 里做了回退判断）。
  // .cmd 必须是**纯 ASCII + CRLF**：cmd.exe 按控制台代码页（中文 Windows 是 GBK）解析批处理，
  // 里面有 UTF-8 中文注释时会把注释行当成命令执行（踩过一次：双击一闪而逝 / 报「不是内部或外部命令」）。
  const lines = platform === 'win32'
    ? [
      '@echo off',
      'REM AIBrowser CLI shim (packaged): run bin/pvs.js with the bundled Electron in node mode',
      'setlocal',
      'set "HERE=%~dp0"',
      'set "APP=%HERE%resources\\app.asar"',
      'if not exist "%HERE%resources\\app.asar" set "APP=%HERE%resources\\app"',
      'set ELECTRON_RUN_AS_NODE=1',
      'set AIBROWSER_PACKAGED=1',
      '"%HERE%AIBrowser.exe" "%APP%\\bin\\pvs.js" %*',
      'endlocal',
      '',
    ]
    : [
      '#!/bin/sh',
      '# AIBrowser 命令行入口（打包版）：用自带的 Electron 以 Node 模式执行 bin/pvs.js',
      'HERE=$(cd "$(dirname "$0")" && pwd)',
      'APP="$HERE/resources/app.asar"',
      '[ -f "$HERE/resources/app.asar" ] || APP="$HERE/resources/app"',
      'ELECTRON_RUN_AS_NODE=1 AIBROWSER_PACKAGED=1 "$HERE/AIBrowser" "$APP/bin/pvs.js" "$@"',
      '',
    ];
  const target = path.join(appDir, shimName);
  // Windows 用 CRLF + ASCII；POSIX 用 LF
  await fsp.writeFile(target, lines.join(platform === 'win32' ? '\r\n' : '\n'), 'utf8');
  if (platform !== 'win32') await fsp.chmod(target, 0o755);
  return shimName;
}

async function packageOne(platform, arch, options) {
  const archivePath = path.join(releaseDir, `AIBrowser-${appVersion}-${platform}-${arch}.zip`);
  // 复用已有产物：清单要能一次列全，但没必要把每个平台都重新打一遍
  if (options.skipExisting && fs.existsSync(archivePath)) {
    const executable = executableName(platform);
    return {
      platform,
      arch,
      ok: true,
      reused: true,
      executable: path.join(releaseDir, `${platform}-${arch}`, 'AIBrowser', executable),
      executableRel: executable,
      cli: path.join(releaseDir, `${platform}-${arch}`, 'AIBrowser', platform === 'win32' ? 'pvs.cmd' : 'pvs'),
      archive: archivePath,
      archiveBytes: fs.statSync(archivePath).size,
      elapsedMs: 0,
      reused: true,
      sha256: sha256(archivePath),
      electron: electronVersion,
      version: appVersion,
      note: platform === 'darwin'
        ? 'macOS 产物未签名：首次打开需右键「打开」或 xattr -dr com.apple.quarantine'
        : (platform !== process.platform ? '交叉打包产物：本机无法直接运行，请在目标平台验证' : '可直接运行'),
    };
  }
  const zipPath = await ensureElectronZip(platform, arch);
  if (!zipPath) {
    return { platform, arch, ok: false, error: `拿不到 Electron ${electronVersion} 的 ${platform}-${arch} 包（检查网络或手动放进 ${cacheDir}）` };
  }
  // 在系统临时目录（Linux 原生盘）里组装：repo 在 /mnt/d（drvfs）上，
  // 那里刚生成的 app.asar 会被 Windows 侧（索引/杀软）短暂占用，连删都删不掉。
  let outRoot = path.join(os.tmpdir(), 'aibrowser-package', `${platform}-${arch}`);
  // 删不掉旧目录（被占用/权限古怪）就换一个名字，别让打包因为清理失败而失败
  if (!forceRemove(outRoot) && fs.existsSync(outRoot)) outRoot = `${outRoot}-${Date.now()}`;
  fs.mkdirSync(outRoot, { recursive: true });
  const started = Date.now();
  const [appDir] = await packager({
    dir: root,
    // Windows 可执行文件的属性页信息（打包器要求 package.json 有 author，这里再补公司/产品名）
    win32metadata: platform === 'win32'
      ? { CompanyName: 'AIBrowser', FileDescription: 'AIBrowser — Chromium 网页/代码预览', ProductName: 'AIBrowser', InternalName: 'AIBrowser', OriginalFilename: 'AIBrowser.exe' }
      : undefined,
    out: outRoot,
    name: 'AIBrowser',
    platform,
    arch,
    electronVersion,
    electronZipDir: path.dirname(zipPath),
    asar: true,
    prune: true,
    overwrite: true,
    appVersion,
    appCopyright: `AIBrowser ${appVersion}`,
    ignore: IGNORE,
    quiet: true,
  });
  // packager 会把 zip 也拷进 out，清理掉免得重复占空间
  for (const name of await fsp.readdir(outRoot)) {
    if (name.endsWith('.zip')) forceRemove(path.join(outRoot, name));
  }
  const shim = await writeCliShim(appDir, platform);
  const archive = path.join(releaseDir, `AIBrowser-${appVersion}-${platform}-${arch}.zip`);
  makeZip(outRoot, archive, { baseDir: path.basename(appDir) });
  const executable = executableName(platform);
  // zip 往返可能丢执行位（不同 unzip 实现不同），解包后补一下，省得用户遇到「权限不够」
  if (platform !== 'win32') {
    try {
      fs.chmodSync(path.join(appDir, executable), 0o755);
    } catch {
      /* 忽略 */
    }
  }
  const dirBytes = dirSize(appDir);
  // 需要「解包即可跑」的目录时再拷回 release/（可选，drvfs 上比较慢）
  let unpacked = null;
  if (options.keepDir) {
    unpacked = path.join(releaseDir, `${platform}-${arch}`);
    forceRemove(unpacked);
    await fsp.cp(appDir, path.join(unpacked, path.basename(appDir)), { recursive: true });
  }
  forceRemove(outRoot);
  return {
    platform,
    arch,
    ok: true,
    appDir,
    executable: path.join(appDir, executable),
    executableRel: executable,
    cli: path.join(appDir, shim),
    archive,
    archiveBytes: fs.statSync(archive).size,
    dirBytes,
    unpacked,
    sha256: sha256(archive),
    elapsedMs: Date.now() - started,
    electron: electronVersion,
    version: appVersion,
    note: platform === 'darwin'
      ? 'macOS 产物未签名：首次打开需右键「打开」或 xattr -dr com.apple.quarantine；要分发请自行签名/公证'
      : (platform !== process.platform ? '交叉打包产物：本机无法直接运行，请在目标平台验证' : '可直接运行'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(`[package] AIBrowser ${appVersion} · Electron ${electronVersion}\n`);
  if (args.unknown.length) {
    process.stdout.write(`[package] 忽略了不认识的参数：${args.unknown.join(' ')}`
      + '（多个平台用逗号分隔：--targets linux,win32）\n');
  }
  process.stdout.write(`[package] 目标：${args.targets.flatMap((p) => args.archList.map((a) => `${p}-${a}`)).join(' ')}`
    + `${args.skipExisting ? '  （已存在的产物直接复用）' : ''}\n`);
  try {
    execFileSync(process.execPath, [path.join(scriptDir, 'build.mjs')], { cwd: root, stdio: 'inherit' });
  } catch {
    process.stdout.write('[package] 渲染层构建失败，终止\n');
    process.exit(1);
  }
  await fsp.mkdir(releaseDir, { recursive: true });
  const results = [];
  for (const platform of args.targets) {
    for (const arch of args.archList) {
      process.stdout.write(`[package] 打包 ${platform}-${arch} …\n`);
      try {
        const result = await packageOne(platform, arch, args);
        results.push(result);
        process.stdout.write(result.ok
          ? `[package]   ✓ ${path.relative(root, result.archive)}（${Math.round(result.archiveBytes / 1024 / 1024)}MB，${result.elapsedMs}ms）\n`
          : `[package]   ✗ ${result.error}\n`);
      } catch (err) {
        results.push({ platform, arch, ok: false, error: err.message });
        process.stdout.write(`[package]   ✗ ${err.message}\n`);
        if (process.env.AIBROWSER_PACKAGE_DEBUG) process.stdout.write(`${err.stack}\n`);
      }
    }
  }

  const manifestPath = path.join(releaseDir, 'manifest.json');
  // 与已有清单合并：一次只打一个平台时，不要把别的平台记录抹掉
  const previous = (() => {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return { artifacts: [] };
    }
  })();
  const merged = new Map();
  for (const item of previous.artifacts || []) {
    if (item && item.ok && item.archive && fs.existsSync(item.archive)) merged.set(`${item.platform}-${item.arch}`, item);
  }
  for (const item of results) {
    if (item.ok) merged.set(`${item.platform}-${item.arch}`, item);
    else if (!merged.has(`${item.platform}-${item.arch}`)) merged.set(`${item.platform}-${item.arch}`, item);
  }
  const allArtifacts = [...merged.values()];
  const manifest = {
    name: packageName,
    productName: 'AIBrowser',
    version: appVersion,
    electron: electronVersion,
    generatedAt: new Date().toISOString(),
    host: `${process.platform}-${process.arch}`,
    // 给 AI/脚本用：按平台取「该跑哪个文件」
    pick: Object.fromEntries(allArtifacts.filter((r) => r.ok).map((r) => [`${r.platform}-${r.arch}`, {
      executable: r.executable,
      cli: r.cli,
      archive: r.archive,
      sha256: r.sha256,
      note: r.note,
    }])),
    artifacts: allArtifacts,
  };
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`[package] 清单：${path.relative(root, manifestPath)}\n`);
  const okCount = results.filter((r) => r.ok).length;
  process.stdout.write(`[package] 完成 ${okCount}/${results.length} 个目标\n`);
  if (!okCount) process.exitCode = 1;
}

await main();
