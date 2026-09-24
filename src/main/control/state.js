'use strict';
// 控制入口的状态文件与 socket 绑定：
//   state.json  { pid, port, socket, token, mode, startedAt } —— CLI / AI 通过它发现控制入口
//   control.sock —— NDJSON 控制通道
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

/**
 * 读取环境变量，同时兼容旧前缀。
 * 改名（Preview Studio → AIBrowser）不应破坏已有脚本，因此 AIBROWSER_* 优先，
 * 回退到 PREVIEW_STUDIO_*（旧名），最后才是默认值。
 */
function env(name, fallback) {
  const next = process.env[`AIBROWSER_${name}`];
  if (next !== undefined) return next;
  const legacy = process.env[`PREVIEW_STUDIO_${name}`];
  if (legacy !== undefined) return legacy;
  return fallback;
}

function runtimeDir() {
  const configured = env('RUNTIME');
  if (configured) return configured;
  if (process.platform === 'linux' && process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'aibrowser');
  }
  return path.join(os.homedir(), '.aibrowser');
}

function statePath() {
  return path.join(runtimeDir(), 'state.json');
}

function socketPath() {
  // Windows 不支持「文件路径形式的」Unix socket：必须用命名管道。
  // 之前直接拼 control.sock 会导致 listen EACCES，CLI 在 Windows 上完全不可用。
  if (process.platform === 'win32') {
    const user = (process.env.USERNAME || process.env.USER || 'default').replace(/[^\w.-]/g, '');
    return `\\\\.\\pipe\\aibrowser-control-${user}`;
  }
  return path.join(runtimeDir(), 'control.sock');
}

function readState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(runtimeDir(), { recursive: true });
  const tmp = `${statePath()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, statePath());
}

function clearState(expectedPid) {
  try {
    const current = readState();
    if (current && expectedPid && current.pid !== expectedPid) return;
    fs.unlinkSync(statePath());
  } catch {
    /* ignore */
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 探测控制入口是否活着：能连上 socket 且 ping 有响应 */
function probe(state, { timeoutMs = 700 } = {}) {
  return new Promise((resolve) => {
    const info = state || readState();
    if (!info || !info.socket) {
      resolve({ ok: false, reason: 'no-state' });
      return;
    }
    if (!fs.existsSync(info.socket)) {
      resolve({ ok: false, reason: 'no-socket', state: info });
      return;
    }
    const socket = net.connect(info.socket);
    let buffer = '';
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, reason: 'timeout', state: info }), timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'ping', action: 'ping', params: {} })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      clearTimeout(timer);
      try {
        const msg = JSON.parse(buffer.slice(0, idx));
        done(msg && msg.ok ? { ok: true, state: info, result: msg.result } : { ok: false, reason: 'bad-response', state: info });
      } catch {
        done({ ok: false, reason: 'bad-json', state: info });
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, reason: err.code || 'error', state: info });
    });
  });
}

/**
 * 绑定控制 socket。
 * 若已被占用：
 *   - adopt=false（默认）且占用者可用 → 返回 { bound:false, existing:true }，本进程不再占用它。
 *     为什么默认不接管：控制通道是「每用户一个固定名字」，接管意味着请旧实例退出 —— 和调用方的
 *     重试（agent 看到没起来就又 serve 一次）叠加起来就成了多实例互相顶掉，谁都起不来。
 *   - adopt=true（只有显式 --takeover 才传）→ 先请求对方 shutdown，等它退出后重新绑定
 *   - 占用者无响应 → 删除残留文件后重试绑定（这种情况是残留，不是别人的活服务）
 */
async function bindSocket(onRequest, { reclaim = true, adopt = false } = {}) {
  fs.mkdirSync(runtimeDir(), { recursive: true });
  const target = socketPath();

  const requestShutdown = async () => {
    try {
      const result = await new Promise((resolve) => {
        const socket = net.connect(target);
        const timer = setTimeout(() => {
          socket.destroy();
          resolve(null);
        }, 900);
        socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'adopt', action: 'shutdown', params: {} })}\n`));
        socket.on('data', (chunk) => {
          if (String(chunk).includes('"ok":true')) {
            clearTimeout(timer);
            socket.destroy();
            resolve(true);
          }
        });
        socket.on('error', () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
      return result;
    } catch {
      return null;
    }
  };

  try {
    if (fs.existsSync(target)) {
      const alive = await probe({ socket: target }, { timeoutMs: 500 });
      if (alive.ok && !reclaim) {
        return { bound: false, existing: true, server: null, path: target };
      }
      if (alive.ok && !adopt) {
        return { bound: false, existing: true, server: null, path: target, reason: 'adopt-disabled' };
      }
      if (alive.ok && adopt) {
        // 接管：请旧实例退出，等它真正断开后再绑定
        await requestShutdown();
        for (let i = 0; i < 12; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          const still = await probe({ socket: target }, { timeoutMs: 250 });
          if (!still.ok) break;
        }
      }
      const leftover = await probe({ socket: target }, { timeoutMs: 250 });
      if (!leftover.ok) {
        try {
          fs.unlinkSync(target);
        } catch {
          /* ignore */
        }
      } else {
        return { bound: false, existing: true, server: null, path: target, reason: 'occupied' };
      }
    }
    const attempt = () =>
      new Promise((resolve, reject) => {
        const server = net.createServer((socket) => {
          socket.setEncoding('utf8');
          let buffer = '';
          socket.on('data', (chunk) => {
            buffer += chunk;
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (!line) continue;
              let message;
              try {
                message = JSON.parse(line);
              } catch (err) {
                socket.write(`${JSON.stringify({ id: null, ok: false, error: `bad json: ${err.message}` })}\n`);
                continue;
              }
              Promise.resolve()
                .then(() => onRequest(message))
                .then((result) => socket.write(`${JSON.stringify({ id: message.id ?? null, ok: true, result })}\n`))
                .catch((err) => socket.write(`${JSON.stringify({ id: message.id ?? null, ok: false, error: err.message || String(err), code: err.code })}\n`));
            }
          });
          socket.on('error', () => {});
        });
        server.on('error', reject);
        server.listen(target, () => resolve(server));
      });

    const server = await attempt();
    return { bound: true, existing: false, server, path: target };
  } catch (err) {
    return { bound: false, existing: false, server: null, path: target, error: err };
  }
}

module.exports = {
  env,
  runtimeDir,
  statePath,
  socketPath,
  readState,
  writeState,
  clearState,
  pidAlive,
  probe,
  bindSocket,
};
