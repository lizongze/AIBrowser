'use strict';
// CLI 客户端：连接已运行的控制入口；不存在时按需拉起（无头守护 / GUI 面板）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { readState, probe, pidAlive, runtimeDir, statePath, env } = require('../control/state');
const { writeStderr } = require('../safe-io');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 打开子进程的日志文件（超过 2MB 先清空），并让应用自己往里写（AIBROWSER_LOG_FILE） */
function setupChildLog(name) {
  try {
    const dir = runtimeDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.log`);
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) fs.writeFileSync(file, '');
    } catch {
      /* 文件不存在就新建 */
    }
    return { path: file };
  } catch {
    return { path: null };
  }
}

function projectRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * 找「本平台能用的 Electron 可执行文件」。三种场景：
 *   1) 打包后的应用里：直接用应用自己的可执行文件（bin/pvs 的 shim 会设 AIBROWSER_PACKAGED=1）；
 *   2) Windows 原生 + 共享 node_modules：devDependency 里装的可能是 Linux 版，
 *      所以优先看 node_modules.win*（run-native.cmd 用的就是它们）；
 *   3) 普通 WSL / Linux：node_modules/electron/dist/electron。
 * 注意：require('electron') 返回的路径在跨平台共享 node_modules 时经常是「另一平台」的，
 * 所以这里要按文件是否存在来挑，而不是无条件相信它。
 */
function electronBinary() {
  if (process.env.AIBROWSER_PACKAGED === '1') return process.execPath;
  const root = projectRoot();
  const candidates = [];
  if (process.platform === 'win32') {
    for (const dir of ['node_modules.win2', 'node_modules.win3', 'node_modules.win', 'node_modules']) {
      candidates.push(path.join(root, dir, 'node_modules', 'electron', 'dist', 'electron.exe'));
    }
  } else {
    try {
      const fromPackage = require('electron');
      if (typeof fromPackage === 'string') candidates.push(fromPackage);
    } catch {
      /* 打包版或依赖缺失 */
    }
    candidates.push(path.join(root, 'node_modules', 'electron', 'dist', 'electron'));
  }
  const found = candidates.find((file) => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  });
  if (found) return found;
  try {
    const fromPackage = require('electron');
    if (typeof fromPackage === 'string') return fromPackage;
  } catch {
    /* 忽略 */
  }
  return process.execPath; // 最后兜底：跑自己（打包版行为）
}

const ELECTRON_BIN = electronBinary();

function requestOverSocket(socketPath, action, params, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!socketPath || !fs.existsSync(socketPath)) {
      reject(Object.assign(new Error('控制通道不存在'), { code: 'ENOENT' }));
      return;
    }
    const socket = net.connect(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, Object.assign(new Error(`控制请求超时（${timeoutMs}ms）：${action}`), { code: 'ETIMEDOUT' })), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: '1', action, params })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      let message;
      try {
        message = JSON.parse(buffer.slice(0, idx));
      } catch (err) {
        finish(reject, new Error(`控制通道返回了非法 JSON: ${err.message}`));
        return;
      }
      if (message.ok) finish(resolve, message.result);
      else finish(reject, Object.assign(new Error(message.error || '控制请求失败'), { code: message.code }));
    });
    socket.on('error', (err) => finish(reject, err));
    socket.on('close', () => finish(reject, Object.assign(new Error('控制通道被关闭'), { code: 'ECLOSED' })));
  });
}

async function requestOverHttp(port, action, params, { token, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pvs-token': token || '' },
      body: JSON.stringify(params || {}),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { code: payload.code });
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

async function send(action, params, { state, timeoutMs } = {}) {
  const target = state;
  const errors = [];
  if (target?.socket) {
    try {
      return await requestOverSocket(target.socket, action, params, { timeoutMs });
    } catch (err) {
      errors.push(`socket: ${err.message}`);
    }
  }
  if (target?.port) {
    try {
      return await requestOverHttp(target.port, action, params, { token: target.token, timeoutMs });
    } catch (err) {
      errors.push(`http: ${err.message}`);
    }
  }
  throw Object.assign(new Error(`无法与控制入口通信（${errors.join('; ') || '没有可用入口'}）`), { code: 'EUNREACHABLE' });
}

/** 找一个可用的控制入口：state.json 探活 → 若进程已死则清理 */
async function resolveTarget({ prefer = 'auto' } = {}) {
  const state = readState();
  if (!state) return { ok: false, reason: 'no-state' };
  if (!pidAlive(state.pid)) return { ok: false, reason: 'dead', state };
  if (prefer === 'daemon' && state.mode !== 'daemon') return { ok: false, reason: 'mode-mismatch', state };
  if (prefer === 'gui' && state.mode !== 'gui') return { ok: false, reason: 'mode-mismatch', state };
  const alive = await probe(state, { timeoutMs: 800 });
  if (alive.ok) return { ok: true, state };
  // 管道不通不代表服务不在：上个实例的命名管道还占着、或平台对管道路径判断不一致时，
  // 用 HTTP /health 再确认一次。少了这一步，调用方会去拉第二个实例，两个实例抢同一个管道。
  if (state.port) {
    const http = await requestOverHttp(state.port, 'health', {}, { token: state.token, timeoutMs: 900 }).catch(() => null);
    if (http) return { ok: true, state, via: 'http' };
  }
  return { ok: false, reason: alive.reason, state };
}

/** 轮询等待控制入口就绪（用于「服务正在被别处拉起」的场合） */
async function waitForTarget({ prefer = 'auto', timeoutMs = 20000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await resolveTarget({ prefer });
    if (found.ok) return { ok: true, state: found.state, via: found.via };
    if (Date.now() >= deadline) return { ok: false, reason: found.reason || 'timeout' };
    await sleep(intervalMs);
  }
}

/**
 * 服务的启动参数：`--serve --gui|--headless --json`。
 * `--serve` 只是把「这是常驻服务」写清楚（应用本身按 --gui/--headless 决定形态）。
 */
function serviceArgs({ gui = false, port, extra = [] } = {}) {
  // 打包版：可执行文件自带应用，不需要再传应用目录
  const appArg = process.env.AIBROWSER_PACKAGED === '1' ? [] : [projectRoot()];
  return [
    ...appArg,
    '--serve',
    gui ? '--gui' : '--headless',
    '--json',
    ...(port ? [`--port=${port}`] : []),
    ...extra,
  ];
}

/**
 * 拉起常驻服务进程。
 *
 * Windows 上用 PowerShell 的 `Start-Process`（ShellExecuteEx 路径）：这是实测在 agent 的
 * 「无控制台 + 捕获输出的 PowerShell」里唯一稳的起法 —— 直接 spawn 应用时，调用方的 shell
 * 会一直盯着这条进程链，命令看起来就像卡住了。
 * 其他平台直接 spawn + detached 就够。
 *
 * 无论哪种方式，都不继承调用方的 stdout/stderr（否则长活进程握着管道，调用方读不到 EOF），
 * 日志由应用自己写 AIBROWSER_LOG_FILE。
 */
function launchService({ gui = false, port, identity, logName = gui ? 'gui' : 'daemon', extra = [] } = {}) {
  const args = serviceArgs({ gui, port, extra });
  const childEnv = { ...process.env };
  // 打包版 CLI 自己是以「Node 模式」跑的（shim 设了 ELECTRON_RUN_AS_NODE=1），
  // 子进程要当真正的应用启动：必须把这个变量摘掉，否则子进程会以 Node 模式执行应用目录。
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (identity) childEnv.AIBROWSER_IDENTITY = identity;
  if (!gui) childEnv.AIBROWSER_HEADLESS = '1';
  const logFile = setupChildLog(logName);
  if (logFile.path) childEnv.AIBROWSER_LOG_FILE = logFile.path;
  // 告诉子进程「你是被拉起来的常驻服务」：它会在启动最早期释放继承来的句柄
  childEnv.AIBROWSER_DETACHED = '1';

  const child = process.platform === 'win32'
    ? spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath '${ELECTRON_BIN.replace(/'/g, "''")}' `
      + `-ArgumentList ${args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(', ')} `
      + '-WindowStyle Hidden',
    ], { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv })
    : spawn(ELECTRON_BIN, args, { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv });
  child.unref();
  return { child, args, logFile };
}

/**
 * 清掉「状态文件还在、但服务已经不可达」的残留。
 * Windows 上命名管道被上个实例占着时，新实例会直接起不来 —— 手工配方里的
 * `pvs stop` + 等 2 秒就是为了这个。这里做进源码，调用方不用再记这一步。
 */
async function clearStaleRuntime({ sleepMs = 0 } = {}) {
  const state = readState();
  if (!state) return { cleared: false, reason: 'no-state' };
  const found = await resolveTarget({});
  if (found.ok) return { cleared: false, reason: 'running' };
  let killed = false;
  if (pidAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM');
      killed = true;
    } catch {
      /* 已经不在了 */
    }
  }
  try {
    fs.rmSync(statePath(), { force: true });
  } catch {
    /* 忽略 */
  }
  if (sleepMs) await sleep(sleepMs);
  return { cleared: true, killed, pid: state.pid };
}

/**
 * 「还在启动」的时间窗。
 *
 * 正常的启动窗口可能很长：从 skill 包里第一次启动时，Windows 要解包/扫描几百 MB 的 app.asar，
 * 十几秒不奇怪。所以 status 会把这段窗口内的「进程活着但通道没应答」报成 starting；
 * **超过这个窗口就是 stuck**（卡死/弹了模态框），必须给出可执行的下一步，而不是让调用方
 * 无限等下去 —— 「一直等」和「一直重启」都是调用方被坑的方式。
 */
const START_WINDOW_MS = 45000;

/**
 * 「进程还在、但控制通道还没就绪」。
 *
 * 调用方看到 running:false 会本能地再 `serve` 一次 —— 那是把问题放大的关键，
 * 所以这里给「该等」和「该清掉重来」一个明确判据：进程活着且还在启动窗口内 → 等；否则 → 清。
 * 窗口与 status 的 starting 用同一个常量，保证「status 说 stuck 了，serve 就会真的清掉重来」。
 */
function startingState({ recentMs = START_WINDOW_MS } = {}) {
  const state = readState();
  if (!state || !pidAlive(state.pid)) return null;
  if (Date.now() - Number(state.startedAt || 0) > recentMs) return null;
  return state;
}

/** 等应用自己写出 state.json —— 拉起器（PowerShell / spawn）的 pid 不是应用的 pid */
async function waitForAppState({ timeoutMs = 2000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = readState();
    if (state && pidAlive(state.pid)) return state;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

function waitForReady({ timeoutMs = 20000, startedAt = Date.now() } = {}) {
  return new Promise((resolve) => {
    const tick = async () => {
      if (Date.now() - startedAt > timeoutMs) {
        resolve({ ok: false, reason: 'timeout' });
        return;
      }
      const state = readState();
      if (process.env.AIBROWSER_DEBUG_WAIT === '1') {
        const why = !state ? 'no-state'
          : state.startedAt < startedAt - 250 ? `stale-startedAt(${state.startedAt}<${startedAt})`
            : !pidAlive(state.pid) ? `pid-dead(${state.pid})` : 'probe';
        const detail = why === 'probe' ? (await probe(state, { timeoutMs: 800 })) : null;
        writeStderr(`[pvs] wait 第 ${Math.round((Date.now() - startedAt) / 1000)}s: ${why}${detail ? ` → ${detail.ok ? 'ok' : detail.reason}` : ''}`);
      }
      if (state && state.startedAt >= startedAt - 250 && pidAlive(state.pid)) {
        let alive = await probe(state, { timeoutMs: 800 });
        // 兜底：管道不可用（例如上一个实例的命名管道还占着、或平台对管道路径判断不一致）时，
        // 用 HTTP /health 再确认一次 —— 否则 serve 会一直等到超时，调用方看着就是「命令卡住」。
        if (!alive.ok && state.port) {
          const http = await requestOverHttp(state.port, 'health', {}, { token: state.token, timeoutMs: 900 }).catch(() => null);
          if (http && http.ok !== false) alive = { ok: true, state, via: 'http' };
        }
        if (alive.ok) {
          resolve({ ok: true, state });
          return;
        }
      }
      setTimeout(tick, 220);
    };
    tick();
  });
}

/**
 * 确保有可用的控制入口，必要时拉起进程。
 * @param {{mode:'auto'|'daemon'|'gui', noSpawn?:boolean, port?:number, quiet?:boolean, identity?:string}} options
 */
async function ensureTarget({ mode = 'auto', noSpawn = false, port, quiet = false, identity } = {}) {
  const prefer = mode === 'daemon' ? 'daemon' : mode === 'gui' ? 'gui' : 'auto';
  const found = await resolveTarget({ prefer });
  if (found.ok) return { state: found.state, spawned: false };

  if (noSpawn) {
    throw Object.assign(new Error(`没有可用的控制入口（原因：${found.reason || 'unknown'}），且已设置 --no-spawn`), { code: 'ENOENT' });
  }

  const headless = mode !== 'gui';
  // 先给一条「卡住怎么办」的提示：某些 agent 的 shell 包装器（无控制台 + 捕获输出的 PowerShell）
  // 会一直等这条进程链，命令看起来就像卡住了。提示要早打印，harness 超时时也能看到。
  writeStderr('[pvs] 正在后台拉起服务；若本命令长时间不返回，可改用 skill 的启动脚本：'
    + ' bash <skill>/scripts/ensure-service.sh（Windows: powershell -File <skill>\\scripts\\serve.ps1）');

  // 有实例在跑、但模式不对（想面板却在跑无头，或反过来）：应用是单实例，硬拉只会白等，
  // 所以先按调用方的要求停掉它，再起一个对的模式。
  if (found.reason === 'mode-mismatch') {
    if (!quiet) writeStderr('[pvs] 运行中的服务模式不同，先停掉再按本次要求启动…');
    await stopTarget();
    await sleep(800);
  }

  // 「进程还在、通道还没就绪」= 正常的启动窗口（首次解包 + 杀软扫描可能要十几秒）或卡死的实例。
  // 先等，不要另拉一个：应用是单实例 + 控制通道是每用户独一份的名字，重复拉起只会互相顶掉。
  const starting = startingState();
  if (process.env.AIBROWSER_LAZY_STARTED === '1' || starting) {
    const grace = await waitForTarget({ prefer, timeoutMs: 30000, intervalMs: 300 });
    if (grace.ok) return { state: grace.state, spawned: false, waited: true };
    if (!quiet) writeStderr(`[pvs] 已有进程（pid ${starting?.pid ?? '?'}）30s 仍未就绪，按卡死处理：清掉重来`);
  }

  // 服务不可达但状态文件还在：可能是残留（上一个实例的命名管道还占着）。
  // 清掉再起，否则新实例会 bind EADDRINUSE 直接失败。
  const stale = await clearStaleRuntime({ sleepMs: process.platform === 'win32' ? 1500 : 0 });
  if (stale.cleared && !quiet) {
    writeStderr(`[pvs] 清掉残留状态（pid ${stale.pid}${stale.killed ? ' 已结束' : ''}）后重新拉起服务`);
  }

  const { child, logFile } = launchService({ gui: !headless, port, identity, logName: headless ? 'daemon' : 'gui' });
  if (!quiet) writeStderr(`[pvs] 启动${headless ? '无头预览服务' : '预览面板'}（pid ${child.pid}）…`);

  const startedAt = Date.now();
  const ready = await waitForReady({ timeoutMs: mode === 'gui' ? 30000 : 25000, startedAt });
  if (!ready.ok) {
    throw Object.assign(new Error('启动预览服务超时，请检查 Electron 是否可用（可先运行 npm run build）'), { code: 'ESTART' });
  }
  return { state: ready.state, spawned: true, pid: child.pid };
}

async function stopTarget() {
  const state = readState();
  if (!state) return { stopped: false, reason: 'no-state' };
  if (!pidAlive(state.pid)) return { stopped: false, reason: 'dead', pid: state.pid };
  try {
    await send('shutdown', {}, { state, timeoutMs: 4000 });
  } catch {
    /* 直接补刀 */
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!pidAlive(state.pid)) return { stopped: true, pid: state.pid };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  try {
    process.kill(state.pid, 'SIGTERM');
    return { stopped: true, pid: state.pid, forced: true };
  } catch {
    return { stopped: false, pid: state.pid, reason: 'kill-failed' };
  }
}

module.exports = {
  electronBinary,
  send,
  ensureTarget,
  resolveTarget,
  stopTarget,
  requestOverSocket,
  requestOverHttp,
  waitForReady,
  waitForTarget,
  waitForAppState,
  startingState,
  START_WINDOW_MS,
  serviceArgs,
  launchService,
  clearStaleRuntime,
  runtimeDir,
  projectRoot,
};
