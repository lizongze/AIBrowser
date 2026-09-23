'use strict';
// pvs 命令实现。纯 Node（不依赖 electron 运行时），通过 socket/HTTP 驱动控制入口。
const path = require('node:path');
const fs = require('node:fs');
const { parseArgs, HELP } = require('./args');
const { send, ensureTarget, resolveTarget, stopTarget, electronBinary } = require('./client');
const { readState, pidAlive, socketPath, runtimeDir } = require('../control/state');
const { normalizePath } = require('../file-service');
const { writeStdout, writeStderr } = require('../safe-io');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

// 管道被下游提前关闭（例如 | head）时不要让 CLI 崩掉
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
  });
}

function out(text) {
  try {
    writeStdout(text);
  } catch {
    /* 下游已关闭 */
  }
}

function errOut(text) {
  try {
    writeStderr(text);
  } catch {
    /* 下游已关闭 */
  }
}

function jsonOut(value) {
  out(JSON.stringify(value));
}

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function shortTime(ts) {
  const date = new Date(ts);
  return date.toTimeString().slice(0, 8);
}

function looksLikeUrl(value) {
  return /^(https?|file|data|about):/i.test(String(value || '')) || /^[a-z0-9.-]+\.[a-z]{2,}(\/|:|$)/i.test(String(value || ''));
}

/**
 * 解析打开目标：URL 或路径（路径会补全为绝对路径）。
 */
function resolveTargetArg(raw, { cwd = process.cwd() } = {}) {
  const value = String(raw || '').trim();
  if (!value) return { kind: 'none' };
  if (looksLikeUrl(value) && !fs.existsSync(path.resolve(cwd, value))) return { kind: 'url', url: value };
  let abs = path.resolve(cwd, normalizePath(value));
  if (!fs.existsSync(abs)) {
    // 尝试在项目根目录下补全
    const state = readState();
    const roots = state?.roots || [];
    for (const root of roots) {
      const candidate = path.join(root, value);
      if (fs.existsSync(candidate)) {
        abs = candidate;
        break;
      }
    }
  }
  return { kind: 'path', file: abs, exists: fs.existsSync(abs) };
}

function targetOptions(flags) {
  const mode = flags.gui ? 'gui' : flags.daemon || flags['force-daemon'] ? 'daemon' : flags.headless ? 'daemon' : 'auto';
  return {
    mode,
    noSpawn: Boolean(flags['no-spawn']),
    port: flags.port ? Number(flags.port) : undefined,
    quiet: Boolean(flags.json) || Boolean(flags.quiet),
    // 浏览器身份：默认伪装成同版本 Chrome；--native-ua 保留 Electron 原始身份（排查用）
    identity: flags['native-ua'] || flags.identity === 'native' ? 'native' : flags.identity ? 'chrome' : undefined,
  };
}

function errorMessage(err) {
  const hints = [];
  if (err.code === 'ENOUNREACHABLE' || err.code === 'ENOENT') hints.push('提示：可先运行 `pvs serve` 常驻一个无头预览服务。');
  if (err.code === 'NOSESSION') hints.push('提示：先 `pvs open <file|url>` 建立会话。');
  if (err.code === 'ENOTALLOWED') hints.push('提示：用 `pvs open --root <目录>` 授权该目录。');
  return hints.length ? `${err.message}\n${hints.join('\n')}` : err.message;
}

// ---------- 命令实现 ----------

async function commandOpen(args, flags) {
  const raw = args[0];
  if (!raw) throw Object.assign(new Error('用法：pvs open <file|url|target>'), { code: 'EUSAGE' });
  const { state, spawned } = await ensureTarget(targetOptions(flags));
  // 原样透传：类型判断与路径补全都在服务端做（manager.openSmart），
  // 这里任何「补全或猜测」都会把 URL 拼成本地路径、或把 Windows 路径拼坏。
  const target = String(raw);
  const result = await send('open', {
    target,
    force: flags.mode === 'code' ? 'code' : undefined,
    root: flags.root ? path.resolve(String(flags.root)) : undefined,
    fresh: Boolean(flags.fresh) && !flags.keep,
  }, { state, timeoutMs: 30000 });
  if (flags.json) {
    jsonOut({ ok: true, spawned, ...result });
  } else {
    out(`已打开 [${result.sessionId}] ${result.kind === 'code' ? '代码' : '网页'} · ${result.title || ''}`);
    out(`  ${result.url || result.file}`);
    if (spawned) out('  （已自动启动后台预览服务）');
  }
  return EXIT_OK;
}

async function commandCode(args, flags) {
  const raw = args[0];
  if (!raw) throw Object.assign(new Error('用法：pvs code <file>'), { code: 'EUSAGE' });
  const { state, spawned } = await ensureTarget(targetOptions(flags));
  const result = await send('open', {
    target: String(raw),
    force: 'code',
    root: flags.root ? path.resolve(String(flags.root)) : undefined,
    fresh: Boolean(flags.fresh) && !flags.keep,
  }, { state });
  if (flags.json) jsonOut({ ok: true, spawned, ...result });
  else out(`代码会话 [${result.sessionId}] ${result.file} (${result.language || result.kind})`);
  return EXIT_OK;
}

async function commandList(_args, flags) {
  const { state } = await ensureTarget(targetOptions(flags));
  const result = await send('list', {}, { state });
  if (flags.json) {
    jsonOut({ ok: true, ...result });
    return EXIT_OK;
  }
  if (!result.sessions.length) out('（没有会话）');
  for (const session of result.sessions) {
    const mark = session.focused ? '▶' : ' ';
    out(`${mark} [${session.sessionId}] ${session.kind === 'code' ? 'code' : 'web '} ${session.title || ''}`);
    out(`      ${session.url || session.file || ''}${session.loading ? '  (加载中)' : ''}`);
  }
  if (result.roots?.length) {
    out('');
    out('项目目录：');
    for (const root of result.roots) out(`  [${root.id}] ${root.dir}`);
  }
  return EXIT_OK;
}

async function commandShot(args, flags) {
  const { state } = await ensureTarget(targetOptions(flags));
  const sessionId = args[0] || flags.session;
  const params = {
    sessionId,
    format: flags.format === 'jpeg' ? 'jpeg' : 'png',
    quality: flags.quality ? Number(flags.quality) : undefined,
    fullPage: Boolean(flags['full-page']),
    selector: flags.selector,
  };
  if (flags.out) params.out = path.resolve(String(flags.out));
  else if (!flags.base64) params.out = path.resolve(`pvs-${sessionId || 'focused'}-${Date.now()}.${params.format === 'jpeg' ? 'jpg' : 'png'}`);

  const result = await send('screenshot', params, { state, timeoutMs: 60000 });
  if (flags.json) {
    jsonOut({ ok: true, sessionId: result.sessionId, filePath: result.filePath, width: result.width, height: result.height, bytes: result.bytes, format: result.format, source: result.source });
    return EXIT_OK;
  }
  const fromPanel = result.source === 'panel';
  const label = fromPanel ? '面板截图（含标签条）'
    : result.source === 'code-page' ? '代码页渲染（无面板，只有文件内容）' : '渲染截图';
  out(`截图完成 · ${result.width}×${result.height} · ${humanSize(result.bytes)} · ${label}`);
  if (result.filePath) out(`  已保存：${result.filePath}`);
  // 无头服务没有面板窗口，代码会话只能截 pvs://code/ 代码页，容易被误认为「没截到面板」
  if (!fromPanel && result.source === 'code-page') {
    out('  提示：当前是纯无头服务（没有面板窗口）。想要带标签条的整块面板截图，先开 GUI：');
    out('        node bin/pvs.js serve --gui    （或 npm run gui，然后在同一个服务里截图）');
  }
  if (flags.base64 && result.dataBase64) out(result.dataBase64);
  return EXIT_OK;
}

async function commandTree(args, flags) {
  const { state } = await ensureTarget(targetOptions(flags));
  const result = await send('tree', {
    dir: args[0] || flags.dir,
    includeIgnored: Boolean(flags.all),
  }, { state });
  if (flags.json) jsonOut({ ok: true, ...result });
  else {
    for (const entry of result.entries) out(`${entry.dir ? '▸' : '·'} ${entry.name}${entry.dir ? '/' : ''}`);
  }
  return EXIT_OK;
}

async function commandPackages(_args, flags) {
  const { projectRoot } = require('./client');
  const { readManifest, normalizeManifest, pickArtifacts, summarize } = require('../release-manifest');
  const read = readManifest(projectRoot());
  const file = read.file;
  const manifest = normalizeManifest(read.manifest, read.source);
  if (!manifest) {
    const hint = process.env.AIBROWSER_PACKAGED === '1'
      ? '这是打包版运行：没有 release/ 清单。要列出各平台产物，请在项目里跑 npm run package -- --targets all，或用带 bundle 的 skill（清单在 bundle/manifest.json）'
      : `还没有打包产物（缺 ${file}）。先运行：npm run package -- --targets all`;
    if (flags.json) jsonOut({ ok: false, error: hint });
    else errOut(hint);
    return EXIT_FAIL;
  }
  const target = flags.target || flags.platform || null;
  const arch = flags.arch || null;
  const wanted = pickArtifacts(manifest, { platform: target, arch });
  if (flags.json) {
    jsonOut({
      ok: wanted.length > 0,
      version: manifest.version,
      electron: manifest.electron,
      generatedAt: manifest.generatedAt,
      manifest: file,
      artifacts: wanted.map(summarize),
      picked: summarize(wanted[0]) || null,
    });
    return wanted.length ? EXIT_OK : EXIT_FAIL;
  }
  out(`AIBrowser ${manifest.version} · Electron ${manifest.electron} · 清单生成于 ${manifest.generatedAt}`
    + (manifest.source === 'bundle' ? '（来源：skill 自带 bundle）' : ''));
  if (!wanted.length) {
    const available = (manifest.artifacts || []).map((a) => `${a.platform}-${a.arch}${a.ok ? '' : '(失败)'}`).join(', ') || '（无）';
    errOut(`清单里没有匹配的产物（${[target, arch].filter(Boolean).join('-') || '任意平台'}）；已有：${available}`);
    errOut(`重新打包：npm run package -- --targets ${target || 'all'}`);
    return EXIT_FAIL;
  }
  out('');
  for (const a of wanted) {
    if (a.bundled) {
      out(`${a.platform}-${a.arch}  skill 自带（${Math.round((a.archiveBytes || 0) / 1024 / 1024)}MB）  ${a.archive}`);
    } else {
      out(`${a.platform}-${a.arch}  ${Math.round(a.archiveBytes / 1024 / 1024)}MB  ${a.archive}`);
    }
    out(`  可执行文件（解压后）：${a.executableRel}`);
    out(`  命令行入口：${path.basename(a.cli || '')}（用同一份应用，无需 node/npm）`);
    out(`  sha256：${String(a.sha256).slice(0, 16)}…   ${a.note || ''}`);
  }
  out('');
  out('解压后直接跑：AIBrowser（GUI）或 ./pvs serve（无头服务）。');
  return EXIT_OK;
}

async function commandDebugWatch(_args, flags) {
  const { state } = await ensureTarget(targetOptions(flags));
  const result = await send('debugWatch', { sessionId: flags.session }, { state });
  if (flags.json) {
    jsonOut({ ok: true, ...result });
    return EXIT_OK;
  }
  out(`热重载：${result.enabled ? `开 · 每 ${result.intervalMs}ms 轮询` : '关'}`);
  out(`  入口：${result.entry || '（无）'}`);
  out(`  关注 ${result.files.length} 个文件（页面引用 ${result.pageAssets} 个 · 显式注册 ${result.extraFiles} 个）：`);
  for (const file of result.files) out(`    ${file}`);
  out(`  类型覆盖：${result.extensions}`);
  return EXIT_OK;
}

async function commandContent(args, flags) {
  const { state } = await ensureTarget(targetOptions(flags));
  const result = await send('content', {
    sessionId: args[0] || flags.session,
    selector: flags.selector,
    format: flags.html ? 'html' : 'text',
    maxLength: flags.timeout ? Number(flags.timeout) : undefined,
  }, { state });
  if (flags.json) jsonOut({ ok: true, ...result });
  else out(result.text);
  return EXIT_OK;
}

async function commandEval(args, flags) {
  const expression = args.join(' ') || (flags.input ? fs.readFileSync(String(flags.input), 'utf8') : '');
  if (!expression) throw Object.assign(new Error('用法：pvs eval "<js>"'), { code: 'EUSAGE' });
  const { state } = await ensureTarget(targetOptions(flags));
  const result = await send('eval', { expression, sessionId: args.session || flags.session }, { state, timeoutMs: 60000 });
  if (flags.json) jsonOut({ ok: true, ...result });
  else out(result.value);
  return EXIT_OK;
}

async function commandConsole(args, flags) {
  const { state } = await ensureTarget(targetOptions(flags));
  const result = await send('console', { sessionId: args[0] || flags.session, clear: Boolean(flags.clear) }, { state });
  if (flags.json) {
    jsonOut({ ok: true, ...result });
    return EXIT_OK;
  }
  if (!result.entries.length) out('（控制台无输出）');
  for (const entry of result.entries) {
    out(`${shortTime(entry.ts)} ${entry.level.padEnd(5)} ${entry.text}`);
  }
  return EXIT_OK;
}

async function commandNetwork(args, flags) {
  const { state } = await ensureTarget(targetOptions(flags));
  const enabled = flags.on ? true : flags.off ? false : undefined;
  const result = await send('network', { sessionId: args[0] || flags.session, enabled, clear: Boolean(flags.clear) }, { state });
  if (flags.json) {
    jsonOut({ ok: true, ...result });
    return EXIT_OK;
  }
  out(`网络记录：${result.enabled ? '开' : '关'} · ${result.entries.length} 条`);
  for (const entry of result.entries.slice(-40)) {
    out(`${String(entry.status || 0).padStart(3)} ${entry.method.padEnd(6)} ${entry.url}${entry.durationMs ? `  ${entry.durationMs}ms` : ''}`);
  }
  return EXIT_OK;
}

async function commandReload(args, flags) {
  const { state } = await ensureTarget(targetOptions(flags));
  const result = await send('reload', { sessionId: args[0] || flags.session, hard: Boolean(flags.hard) }, { state });
  if (flags.json) jsonOut({ ok: true, ...result });
  else out(`已重新加载 [${result.sessionId}] ${result.url}`);
  return EXIT_OK;
}

async function commandClose(args, flags) {
  const { state } = await ensureTarget(targetOptions(flags));
  const result = await send('close', { sessionId: args[0] || flags.session, all: Boolean(flags.all) }, { state });
  if (flags.json) jsonOut({ ok: true, ...result });
  else out(result.all ? '已关闭所有会话' : result.closed ? '会话已关闭' : '没有匹配的会话');
  return EXIT_OK;
}

async function commandStatus(_args, flags) {
  const state = readState();
  const alive = state ? await resolveTarget({ prefer: 'auto' }) : { ok: false };
  const payload = {
    ok: Boolean(alive.ok),
    running: Boolean(alive.ok),
    pid: state?.pid ?? null,
    pidAlive: state ? pidAlive(state.pid) : false,
    port: state?.port ?? null,
    socket: socketPath(),
    runtimeDir: runtimeDir(),
    token: state?.token ?? null,
    mode: state?.mode ?? null,
    version: state?.version ?? null,
    startedAt: state?.startedAt ?? null,
    // 对外自报的浏览器身份：必须问「运行中的那个实例」——CLI 自己跑在普通 Node 里，
    // process.versions.chrome 不存在，本地算出来的版本号会是兜底值，容易看岔。
    identity: null,
    endpoint: state?.port ? `http://127.0.0.1:${state.port}` : null,
    sessions: null,
  };
  if (alive.ok) {
    try {
      const list = await send('list', {}, { state });
      payload.sessions = list.sessions.length;
      payload.roots = list.roots;
    } catch {
      /* ignore */
    }
    try {
      const pong = await send('ping', {}, { state });
      payload.identity = pong.identity || null;
    } catch {
      /* 老实例可能还没有这个字段 */
    }
  }
  if (flags.json) {
    jsonOut(payload);
    return alive.ok ? EXIT_OK : EXIT_FAIL;
  }
  out(alive.ok ? `运行中 · ${payload.mode === 'gui' ? '面板窗口' : '无头服务'} · pid ${payload.pid}` : '未运行');
  if (alive.ok && payload.identity) out(`  浏览器身份：${payload.identity.summary || payload.identity.mode}`);
  out(`  控制端口：${payload.port ?? '-'}`);
  out(`  socket  ：${payload.socket}`);
  out(`  令牌    ：${payload.token ?? '-'}`);
  if (payload.sessions !== null) out(`  会话数  ：${payload.sessions}`);
  if (payload.roots?.length) for (const root of payload.roots) out(`  根目录  ：[${root.id}] ${root.dir}`);
  return alive.ok ? EXIT_OK : EXIT_FAIL;
}

/** 打开子进程的日志文件（超过 2MB 先清空，避免无限增长） */
function setupChildLog(name) {
  try {
    const dir = runtimeDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.log`);
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) fs.writeFileSync(file, '');
    } catch {
      /* 文件不存在就由 openSync 新建 */
    }
    return { path: file, fd: fs.openSync(file, 'a') };
  } catch {
    return { path: null, fd: 'ignore' };
  }
}

async function commandServe(_args, flags) {
  const wantGui = Boolean(flags.gui);
  const existing = await resolveTarget({ prefer: wantGui ? 'gui' : 'daemon' });
  if (existing.ok) {
    const info = {
      ok: true,
      alreadyRunning: true,
      pid: existing.state.pid,
      port: existing.state.port,
      mode: existing.state.mode,
      socket: existing.state.socket,
      token: existing.state.token,
    };
    if (flags.json) jsonOut(info);
    else out(`已有${existing.state.mode === 'gui' ? '面板' : '无头服务'}在运行 · pid ${existing.state.pid} · 端口 ${existing.state.port}`);
    return EXIT_OK;
  }
  const { spawn } = require('node:child_process');
  const { projectRoot, waitForReady } = require('./client');
  // 可执行文件按平台挑（共享 node_modules 里可能装的是另一平台的 Electron）；
  // 打包版则用应用自己的可执行文件。详见 client.electronBinary()。
  const ELECTRON_BIN = electronBinary();
  const startedAt = Date.now();
  // 子进程的 stdout/stderr 落盘到 <runtimeDir>/<mode>.log，而不是继承父进程的管道：
  // 拉起面板的 agent shell / cmd 随时会退出，继承的管道一断，子进程每次写日志都会拿到
  // EPIPE（Windows 上就是「A JavaScript error occurred in the main process」弹窗）。
  // 落盘既避免这个问题，也留下可查的启动日志。
  const logFile = setupChildLog(wantGui ? 'gui' : 'daemon');
  // 打包版的 pvs 是「Node 模式」跑起来的（ELECTRON_RUN_AS_NODE=1），子进程要当真正的应用启动，
  // 必须把这个变量摘掉：留着的话子进程会以 Node 模式执行应用目录，起不来（表现为「启动超时」）。
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // 让应用自己把日志写进这个文件（下面 stdio 用 ignore，子进程拿不到我们的标准输出）
  if (logFile.path) childEnv.AIBROWSER_LOG_FILE = logFile.path;
  // 告诉子进程「你是被拉起来的常驻服务」：它会在启动最早期释放继承来的 stdin/stdout/stderr，
  // 否则长活进程会一直握着调用方的管道，调用方永远等不到 EOF（表现为命令 pending）。
  childEnv.AIBROWSER_DETACHED = '1';
  const guiFlags = [];
  if (flags.fullscreen) guiFlags.push('--fullscreen');
  if (flags['no-fullscreen']) guiFlags.push('--no-fullscreen');
  if (flags['show-sidebar']) guiFlags.push('--show-sidebar');
  // 打包版：可执行文件自带应用，不需要再传应用目录
  const appArg = process.env.AIBROWSER_PACKAGED === '1' ? [] : [projectRoot()];
  // stdio 三个都用 ignore：libuv 只有在「没有任何 stdio 需要继承」时才不传 bInheritHandles，
  // 否则长活的 GUI 子进程会继承调用方（agent 的 shell）的 stdout/stderr 管道并一直握着，
  // 调用方永远等不到 EOF → 表现就是「命令一直 pending、拿不到回传」。日志改由应用自己写文件。
  const childArgs = [...appArg, ...(wantGui ? [] : ['--headless']), ...guiFlags, ...(flags.port ? [`--port=${flags.port}`] : [])];
  // 拉起方式：Windows 用 PowerShell 的 Start-Process（ShellExecuteEx 路径），其他平台直接 spawn。
  // 两者都 detached + stdio:'ignore'：子进程拿 NUL 作标准流、不继承调用方的 stdout/stderr 管道
  // （继承的话长活的 GUI 进程会一直握着管道，调用方读不到 EOF —— 表现就是命令 pending）。
  // 日志由应用自己写 AIBROWSER_LOG_FILE。
  const child = (process.platform === 'win32'
    ? spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath '${ELECTRON_BIN.replace(/'/g, "''")}' `
      + `-ArgumentList @(${childArgs.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(', ')}) `
      + '-WindowStyle Hidden',
    ], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...childEnv } })
    : spawn(ELECTRON_BIN, childArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...childEnv,
      ...(wantGui ? {} : { AIBROWSER_HEADLESS: '1' }),
      ...(flags['native-ua'] || flags.identity === 'native' ? { AIBROWSER_IDENTITY: 'native' } : {}),
      },
    }));
  child.unref();
  // 等待策略：**默认拉起即返回**（不等就绪）。
  // 为什么默认不等：拉起服务的调用方常常是 agent 的 shell 包装器（无控制台 + 管道的 PowerShell），
  // 它们会在我们等待期间把整条命令挂住、最后超时 kill —— 看起来像启动失败，其实服务已经起来了。
  // 需要「就绪后再继续」的脚本自己加 --wait（旧行为，上限 30s）或 --wait-ms <毫秒>。
  const quickWaitMs = flags.wait || flags.block
    ? (wantGui ? 30000 : 25000)
    : (flags['wait-ms'] !== undefined ? Math.max(0, Number(flags['wait-ms']) || 0) : 0);
  const ready = quickWaitMs > 0
    ? await waitForReady({ timeoutMs: quickWaitMs, startedAt })
    : { ok: false };
  if (!ready.ok) {
    const info = {
      ok: true,
      spawning: true,
      ready: false,
      pid: child.pid || null,
      mode: wantGui ? 'gui' : 'daemon',
      note: '服务已在后台启动；用 pvs status --json 看 "running":true',
    };
    if (flags.json) jsonOut(info);
    else out(`已在后台启动${wantGui ? '预览面板' : '无头预览服务'} · pid ${info.pid || '?'}（用 pvs status 确认就绪）`);
    child.unref();
    process.exit(EXIT_OK);
  }
  if (!ready.ok) {
    errOut('启动超时');
    return EXIT_FAIL;
  }
  const info = {
    ok: true,
    spawned: true,
    pid: ready.state.pid,
    port: ready.state.port,
    mode: ready.state.mode,
    socket: ready.state.socket,
    token: ready.state.token,
    endpoint: `http://127.0.0.1:${ready.state.port}`,
  };
  if (flags.json) jsonOut(info);
  else {
    out(`已启动${wantGui ? '预览面板' : '无头预览服务'} · pid ${info.pid} · 端口 ${info.port}`);
    out(`  控制通道：${info.socket}`);
    out(`  HTTP    ：${info.endpoint}（Header: X-PVS-Token: ${info.token}）`);
    if (logFile.path) out(`  启动日志：${logFile.path}`);
  }
  return EXIT_OK;
}

async function commandStop(_args, flags) {
  const result = await stopTarget();
  if (flags.json) jsonOut({ ok: result.stopped, ...result });
  else out(result.stopped ? `已停止 · pid ${result.pid}` : `未在运行${result.reason ? `（${result.reason}）` : ''}`);
  return result.stopped ? EXIT_OK : EXIT_FAIL;
}

/**
 * 批量：给一份文件/URL 清单，串行打开并逐项截图（设计见 docs/BATCH.md）。
 * 输出：stderr 打进度；stdout 逐项 JSONL；结束时写 report.json / report.jsonl。
 */
async function commandBatch(args, flags) {
  const { runBatch, collectFromFile, collectFromDir } = require('../batch');
  const items = [];
  for (const arg of args) items.push(arg);
  if (flags.from) items.push(...collectFromFile(String(flags.from)));
  if (flags.dir) items.push(...collectFromDir(String(flags.dir), flags.ext));
  if (!items.length) {
    throw Object.assign(new Error('用法：pvs batch <url|file>… | --from list.txt|list.json | --dir <目录> [--ext html]'), { code: 'EUSAGE' });
  }

  const { state } = await ensureTarget(targetOptions(flags));
  const outDir = path.resolve(String(flags.out || 'aibrowser-shots'));
  const only = flags.json; // --json 时不打进度
  const report = await send('batch', {
    items,
    outDir,
    fullPage: flags['full-page'] !== false,
    format: flags.format === 'jpeg' ? 'jpeg' : 'png',
    timeout: flags.timeout ? Number(flags.timeout) : undefined,
    stream: Boolean(!only),
  }, { state, timeoutMs: 1000 * 60 * 30 });

  if (only) {
    jsonOut({ ok: report.failed === 0, ...report });
  } else {
    for (const item of report.items) {
      out(`${item.ok ? '✓' : item.ok === null ? '–' : '✗'} ${String(item.index).padStart(3, '0')} `
        + `${(item.name || '').padEnd(28)} ${item.ok ? `${item.width}×${item.height} ${humanSize(item.bytes)}` : item.error}`);
    }
    out('');
    out(`共 ${report.total} 项 · 成功 ${report.succeeded} · 失败 ${report.failed} · 跳过 ${report.skipped} · 用时 ${(report.elapsedMs / 1000).toFixed(1)}s`);
    out(`截图目录：${report.outDir}`);
    if (report.reportPath) out(`结果清单：${report.reportPath}`);
  }
  return report.failed === 0 ? EXIT_OK : EXIT_FAIL;
}

const COMMANDS = {
  open: commandOpen,
  code: commandCode,
  list: commandList,
  ls: commandList,
  sessions: commandList,
  shot: commandShot,
  batch: commandBatch,
  screenshot: commandShot,
  content: commandContent,
  text: commandContent,
  eval: commandEval,
  console: commandConsole,
  tree: commandTree,
  packages: commandPackages,
  release: commandPackages,
  debugWatch: commandDebugWatch,
  watch: commandDebugWatch,
  logs: commandConsole,
  network: commandNetwork,
  net: commandNetwork,
  reload: commandReload,
  close: commandClose,
  status: commandStatus,
  serve: commandServe,
  stop: commandStop,
};

/**
 * 输出格式：AI 优先。
 *   --json / -j            → JSON
 *   --text / --human       → 人读
 *   AIBROWSER_FORMAT=json|text → 同上
 *   都没给：stdout 是终端（人）就用文本，被管道/重定向捕获（AI、脚本）就用 JSON。
 * 这样 agent 直接 `pvs serve --gui` 也能拿到可解析的单行 JSON，不会因为「输出看不懂」而卡住。
 */
function resolveJsonMode(flags) {
  if (flags.json === true) return true;
  if (flags.text || flags.human || flags['no-json']) return false;
  const env = String(process.env.AIBROWSER_FORMAT || '').trim().toLowerCase();
  if (env === 'json') return true;
  if (env === 'text' || env === 'human') return false;
  return !process.stdout.isTTY;
}

async function main(argv) {
  const { _: positional, flags } = parseArgs(argv);
  flags.json = resolveJsonMode(flags);
  if (flags.version) {
    out(require('../../../package.json').version);
    return EXIT_OK;
  }
  const command = positional[0];
  if (!command || flags.help) {
    out(HELP);
    return command ? EXIT_OK : EXIT_USAGE;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    // 未知命令也要按「AI 优先」的格式回：JSON 模式给可解析的结构，别把 HELP 混进 stdout
    if (flags.json) jsonOut({ ok: false, error: `未知命令：${command}`, code: 'EUSAGE', commands: Object.keys(COMMANDS) });
    else {
      errOut(`未知命令：${command}\n`);
      errOut(HELP);
    }
    return EXIT_USAGE;
  }
  try {
    return await handler(positional.slice(1), flags);
  } catch (err) {
    if (flags.json) jsonOut({ ok: false, error: err.message || String(err), code: err.code });
    else errOut(`错误：${errorMessage(err)}`);
    return err.code === 'EUSAGE' ? EXIT_USAGE : EXIT_FAIL;
  }
}

module.exports = { main, resolveTargetArg, COMMANDS, EXIT_OK, EXIT_FAIL, EXIT_USAGE };
