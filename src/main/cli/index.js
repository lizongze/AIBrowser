'use strict';
// pvs 命令实现。纯 Node（不依赖 electron 运行时），通过 socket/HTTP 驱动控制入口。
const path = require('node:path');
const fs = require('node:fs');
const { parseArgs, HELP } = require('./args');
const { send, ensureTarget, resolveTarget, stopTarget } = require('./client');
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
  // 「进程活着但控制通道还没应答」= 正在启动（首次解包/杀软扫描会慢），不是「没在跑」。
  // 这个区分很重要：否则调用方看到 running:false 就会再 serve 一次，把启动过程搅乱。
  const starting = !alive.ok && state && pidAlive(state.pid);
  const payload = {
    ok: Boolean(alive.ok),
    running: Boolean(alive.ok),
    starting: Boolean(starting),
    // 已经启动多久了：调用方据此判断「再等一会」还是「真的卡住了」（首次解包 10-20s 很正常）
    startingMs: starting ? Date.now() - Number(state.startedAt || Date.now()) : null,
    pid: state?.pid ?? null,
    pidAlive: state ? pidAlive(state.pid) : false,
    port: state?.port ?? null,
    socket: socketPath(),
    runtimeDir: runtimeDir(),
    token: state?.token ?? null,
    mode: state?.mode ?? null,
    version: state?.version ?? null,
    startedAt: state?.startedAt ?? null,
    socketBound: state?.socketBound ?? null,
    note: state?.note ?? null,
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
  } else {
    // 没起来的时候，最有用的是「为什么」：把应用自己写的日志尾巴带上，调用方不用猜、也不用翻文件。
    payload.logTail = readLogTail(state);
    payload.logFile = logFileFor(state);
  }
  if (flags.json) {
    jsonOut(payload);
    return alive.ok ? EXIT_OK : EXIT_FAIL;
  }
  out(alive.ok
    ? `运行中 · ${payload.mode === 'gui' ? '面板窗口' : '无头服务'} · pid ${payload.pid}`
    : starting ? `启动中 · pid ${payload.pid}（进程已在运行，等它就绪即可）` : '未运行');
  if (alive.ok && payload.identity) out(`  浏览器身份：${payload.identity.summary || payload.identity.mode}`);
  out(`  控制端口：${payload.port ?? '-'}`);
  out(`  socket  ：${payload.socket}`);
  out(`  令牌    ：${payload.token ?? '-'}`);
  if (payload.sessions !== null) out(`  会话数  ：${payload.sessions}`);
  if (payload.roots?.length) for (const root of payload.roots) out(`  根目录  ：[${root.id}] ${root.dir}`);
  if (!alive.ok && payload.logTail?.length) {
    out(`  最近日志（${payload.logFile}）：`);
    for (const line of payload.logTail) out(`    ${line}`);
  }
  return alive.ok ? EXIT_OK : EXIT_FAIL;
}

/** 服务日志文件：应用自己写的那份（gui.log / daemon.log） */
function logFileFor(state) {
  const name = state?.mode === 'daemon' ? 'daemon.log' : 'gui.log';
  return path.join(runtimeDir(), name);
}

/** 读日志尾巴：status 里带上「为什么没起来」，比让调用方去翻文件有用得多 */
function readLogTail(state, { lines = 12 } = {}) {
  const files = [logFileFor(state), path.join(runtimeDir(), 'aibrowser-crash.log')];
  const tail = [];
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, 'utf8').trimEnd();
      if (!text) continue;
      const suffix = file.endsWith('crash.log') ? '[crash] ' : '';
      tail.push(...text.split('\n').slice(-lines).map((line) => suffix + line));
    } catch {
      /* 文件不存在就算了 */
    }
  }
  return tail.slice(-lines);
}

// 说明：抛起服务子进程的那套（日志文件 / 参数 / Windows 的 Start-Process）现在统一在
// client.launchService 里，serve 与「自动拉起」走同一条路，避免两处行为不一致。

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
  const { waitForReady, launchService, clearStaleRuntime, startingState, waitForAppState } = require('./client');
  // 已有实例在跑、只是模式不同（想面板却在跑无头，或反过来）：应用是单实例，硬拉只会白等到超时。
  // 先按调用方的要求停掉它，再起一个对的模式 —— 这样 `serve --gui` / `serve` 都一定「说到做到」。
  if (existing.reason === 'mode-mismatch') {
    writeStderr(`[pvs] 运行中的是${existing.state?.mode === 'gui' ? '面板' : '无头'}服务，本次要求`
      + `${wantGui ? '面板' : '无头'}：先停掉再启动…`);
    await stopTarget();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  // 进程还在、只是还没就绪（首次解包 + 杀软扫描可能要十几秒）：这就是「正在启动」，直接如实上报，
  // 不要再拉一个 —— 多实例抢同一个命名管道/状态文件正是「怎么都起不来」的根源。
  const starting = startingState();
  if (starting) {
    const info = {
      ok: true,
      starting: true,
      ready: false,
      pid: starting.pid,
      port: starting.port,
      mode: starting.mode,
      socket: starting.socket,
      note: '服务正在启动（进程已在运行），继续轮询 pvs status --json，不要重复启动',
    };
    if (flags.json) jsonOut(info);
    else out(`服务正在启动（pid ${starting.pid}，${starting.mode === 'gui' ? '面板' : '无头'}），用 pvs status 确认就绪`);
    return EXIT_OK;
  }
  // 拉起方式统一走 client.launchService：Windows 用 PowerShell 的 Start-Process
  // （实测在 agent 的 shell 里唯一稳的起法），其他平台直接 detached spawn；
  // 两者都不继承调用方的 stdout/stderr，日志由应用自己写 AIBROWSER_LOG_FILE。
  const startedAt = Date.now();
  // 残留状态（上一个实例的命名管道还占着）会让新实例 bind 失败：先清掉再起，
  // 也就是手工配方里 `pvs stop` + 等 2 秒那一步。
  const stale = await clearStaleRuntime({ sleepMs: process.platform === 'win32' ? 1500 : 0 });
  if (stale.cleared) {
    writeStderr(`[pvs] 清掉残留状态（pid ${stale.pid}${stale.killed ? ' 已结束' : ''}）后重新拉起服务`);
  }
  const guiFlags = [];
  if (flags.fullscreen) guiFlags.push('--fullscreen');
  if (flags['no-fullscreen']) guiFlags.push('--no-fullscreen');
  if (flags['show-sidebar']) guiFlags.push('--show-sidebar');
  const { child, logFile } = launchService({
    gui: wantGui,
    port: flags.port,
    identity: flags['native-ua'] || flags.identity === 'native' ? 'native' : undefined,
    logName: wantGui ? 'gui' : 'daemon',
    extra: guiFlags,
  });
  // 拉起用的是 PowerShell / spawn，拿到的 pid 是**拉起器**的 pid（Windows 上尤其容易看岔：
  // serve 说 pid 7256，status 却是 24328）。这里等一下应用自己写的 state.json，尽量报真实 pid。
  const appState = await waitForAppState({ timeoutMs: 1500 });
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
  if (quickWaitMs > 0 && !ready.ok) {
    errOut('启动超时');
    return EXIT_FAIL;
  }
  if (!ready.ok) {
    const info = {
      ok: true,
      spawning: true,
      ready: false,
      pid: appState?.pid ?? null,
      // 应用还没写 state.json 时，pid 只能是「拉起器」的（Windows 上是 powershell）——标清楚，
      // 免得调用方拿它去 kill / 对不上号
      launcherPid: appState ? undefined : (child.pid || null),
      mode: wantGui ? 'gui' : 'daemon',
      note: appState
        ? '服务已在后台启动；用 pvs status --json 看 "running":true'
        : '正在启动（首次运行/解包会慢一点）；用 pvs status --json 轮询，不要重复 serve',
    };
    if (flags.json) jsonOut(info);
    else {
      out(`已在后台启动${wantGui ? '预览面板' : '无头预览服务'} · pid ${info.pid ?? info.launcherPid ?? '?'}`
        + '（用 pvs status 确认就绪；首次启动可能要十几秒）');
    }
    child.unref();
    process.exit(EXIT_OK);
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
