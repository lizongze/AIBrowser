'use strict';
// CLI 客户端：连接已运行的控制入口；不存在时按需拉起（无头守护 / GUI 面板）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { readState, probe, pidAlive, runtimeDir, env } = require('../control/state');
const { writeStderr } = require('../safe-io');

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
  return { ok: false, reason: alive.reason, state };
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
  // 打包版：可执行文件自带应用，不需要再传应用目录
  const appArg = process.env.AIBROWSER_PACKAGED === '1' ? [] : [projectRoot()];
  const args = [...appArg, '--headless', ...(port ? ['--port', String(port)] : [])];
  // 打包版 CLI 自己是以「Node 模式」跑的，子进程要当真正的应用启动：必须摘掉这个变量
  const childEnv = { ...process.env, AIBROWSER_HEADLESS: '1' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (identity) childEnv.AIBROWSER_IDENTITY = identity;
  // 同上：自动拉起服务时也不继承调用方的管道（否则调用方可能等不到 EOF）
  const logFile = setupChildLog('daemon');
  if (logFile.path) childEnv.AIBROWSER_LOG_FILE = logFile.path;
  childEnv.AIBROWSER_DETACHED = '1'; // 子进程启动时释放继承句柄（见 safe-io.releaseInheritedStdio）
  const child = spawn(ELECTRON_BIN, args, {
    detached: true,
    stdio: 'ignore', // 三个都 ignore：不让子进程继承调用方的 stdout/stderr 管道
    env: childEnv,
  });
  child.unref();
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
  runtimeDir,
  projectRoot,
};
