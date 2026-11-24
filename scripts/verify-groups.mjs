#!/usr/bin/env node
// 回归测试：多组并行 + 组内串行截图（真实跑批形态），中途经历一次「面板忙住 / 控制通道暂时连不上」。
//
// 场景（与研发云截图 skill 的跑法一致）：
//   1. 起前台面板（GUI）
//   2. close --all 关闭所有标签
//   3. 6 组并行；每组内部串行处理 3 个模块：pvs open → pvs shot → pvs close
//   4. 跑到一半，把 state.json 的 port/socket 改成连不上、startedAt 改老（模拟面板正忙，
//      且已超过 CLI 的 45s 启动宽限窗）——这是唯一能触发「把活着的面板当残留进程杀掉」的条件
//   5. 几秒后恢复，各组的重试应当成功
//
// 断言：
//   - 18 张截图全部成功
//   - 面板 pid 全程不变（没有被杀、没有自动重启）
//   - 任何一条 pvs 输出里都不出现「清掉残留状态」
//
// 修复前（HEAD）跑这个脚本会失败：注入之后某条命令把面板 TerminateProcess 掉，随后又拉起新实例，
// 于是 pid 变了、标签全丢、后面的截图全失败 —— 用户看到的就是「闪退，然后自己重启」。
//
// 用法：node scripts/verify-groups.mjs [--groups 6] [--modules 3] [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = process.env.AIBROWSER_RUNTIME || process.env.PREVIEW_STUDIO_RUNTIME
  ? path.resolve(process.env.AIBROWSER_RUNTIME || process.env.PREVIEW_STUDIO_RUNTIME)
  : process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, 'aibrowser')
    : path.join(os.homedir(), '.aibrowser');
const statePath = path.join(runtimeDir, 'state.json');
const pvsJs = path.join(root, 'bin', 'pvs.js');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const groups = arg('groups', 6);
const modules = arg('modules', 3);
const keep = argv.includes('--keep');
const allowEnsure = argv.includes('--ensure');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 面板进程退出监听的共享状态：一旦 pid 没了，所有 pvs 子进程立刻收手、组循环不再重试
let panelCrashed = false;
let panelCrashedAt = null;
let panelRestartPid = null;
const results = [];
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
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
async function api(action, params = {}, timeoutMs = 30000) {
  const state = readState();
  if (!state) throw new Error('控制入口未就绪');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pvs-token': state.token },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    const payload = await res.json();
    if (!payload.ok) throw new Error(payload.error || 'unknown');
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}
/** 跑一条真实 pvs 命令（只有 CLI 才带「探活 → 判残留 → 清理」这套逻辑） */
function runPvs(args, timeoutMs = 90000) {
  // 面板已经退出：不要再起任何命令（它们只会去拉起新实例、白等 20~30s）
  if (panelCrashed) return Promise.resolve({ code: -1, out: '', err: 'panel-exited', ms: 0 });
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [pvsJs, ...args], { cwd: root, env: process.env, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, timeoutMs);
    // 面板已经没了：不要继续等一条注定超时的命令（它会去拉起新实例，白等 20~30s）
    const watch = setInterval(() => { if (panelCrashed) { try { p.kill(); } catch { /* ignore */ } } }, 200);
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', (e) => {
      clearTimeout(timer);
      clearInterval(watch);
      resolve({ code: -1, out, err: String(e.message), ms: Date.now() - started });
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      resolve({ code, out, err, ms: Date.now() - started });
    });
  });
}
function lastJson(out) {
  const lines = String(out).trim().split('\n').filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* 继续往前找 */ }
  }
  return null;
}
async function startGui() {
  const electron = (() => {
    if (process.platform !== 'win32') return path.join(root, 'node_modules', '.bin', 'electron');
    const candidates = ['node_modules.win', 'node_modules.win2', 'node_modules.win3', 'node_modules']
      .flatMap((dir) => [
        path.join(root, dir, 'node_modules', 'electron', 'dist', 'electron.exe'),
        path.join(root, dir, 'electron', 'dist', 'electron.exe'),
      ]);
    const found = candidates.find((file) => fs.existsSync(file));
    if (!found) throw new Error('找不到 Windows 版 Electron');
    return found;
  })();
  try { fs.rmSync(statePath, { force: true }); } catch { /* ignore */ }
  const launchArgs = process.platform === 'win32'
    ? [root, '--no-maximize']
    : [root, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
  // 注意：agent 的运行环境里可能带着 ELECTRON_RUN_AS_NODE=1（那是给 CLI 用的），
  // 传给应用会变成「以 Node 模式跑应用目录」—— 应用直接不启动。这里必须摘掉。
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ASAR;
  childEnv.AIBROWSER_LOG_FILE = path.join(os.tmpdir(), 'pvs-verify-groups.log');
  const child = spawn(electron, launchArgs, {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: childEnv,
  });
  child.unref();
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const state = readState();
    if (state && state.pid === child.pid) {
      try {
        const res = await fetch(`http://127.0.0.1:${state.port}/health`);
        if (res.ok) return state;
      } catch { /* 还没就绪 */ }
    }
    await sleep(300);
  }
  throw new Error('GUI 启动超时');
}

/**
 * 先确认「前台服务是否正常运行」——这是这个回归测试的前置条件。
 * 默认**不**自己拉起、也不停别人的服务：只在已经有一个健康的 GUI 面板时跑；
 * 没在跑就直接失败并给出启动命令（加 --ensure 才由脚本自己拉起）。
 */
async function ensureService({ allowStart = false } = {}) {
  const state = readState();
  if (state && pidAlive(state.pid) && state.mode === 'gui') {
    try {
      const res = await fetch(`http://127.0.0.1:${state.port}/health`);
      if (res.ok) {
        const info = await res.json().catch(() => ({}));
        return { state, started: false, health: info };
      }
    } catch { /* 端口不通，继续判断 */ }
  }
  if (!allowStart) {
    throw new Error(
      '前台服务没有正常运行：先启动面板再跑这个回归，例如\n'
      + '    node bin/pvs.js serve --gui --json\n'
      + '  （或加 --ensure 让本脚本自己拉起一个）',
    );
  }
  return { state: await startGui(), started: true, health: null };
}

async function main() {
  console.log(`多组并行 / 组内串行截图回归（${groups} 组 × ${modules} 个模块）\n`);
  console.log('① 前置检查：前台服务是否在正常运行');
  const service = await ensureService({ allowStart: allowEnsure });
  const state = service.state;
  const appPid = state.pid;
  const original = { ...state };
  const t0 = Date.now();
  const step = (msg) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s] ${msg}`);
  const sessionsNow = await api('list').then((r) => (r.sessions || []).length).catch(() => null);
  check(true, '前台服务正在运行（GUI 面板 + /health 正常）',
    `pid=${appPid} · port=${state.port} · 标签=${sessionsNow ?? '?'}${service.started ? ' · 本次由脚本拉起' : ''}`);
  console.log('');

  // 监听面板进程退出：pid 一没就**立刻判定失败并结束**（不再重试、不再等命令超时）
  const watcher = setInterval(() => {
    if (panelCrashed) return;
    if (pidAlive(appPid)) return;
    panelCrashed = true;
    panelCrashedAt = Date.now();
    const s = readState();
    if (s && s.pid && s.pid !== appPid && pidAlive(s.pid)) panelRestartPid = s.pid;
    const detail = `pid=${appPid} 在 ${((panelCrashedAt - t0) / 1000).toFixed(2)}s 退出`
      + (panelRestartPid ? ` · 已被自动重启为 pid=${panelRestartPid}（标签全丢）` : ' · 没有新实例');
    results.push({ ok: false, label: '面板进程全程存活（没有被杀掉 / 没有闪退）', detail });
    console.log(`  ✗ 面板进程全程存活（没有被杀掉 / 没有闪退） — ${detail}`);
    console.log('\n✗ 面板已经退出（闪退）→ 直接结束，不再重试');
    // 给还在跑的 pvs 子进程一点时间被 runPvs 里的监听杀掉，然后立刻退出
    setTimeout(() => process.exit(1), 300);
  }, 150);

  // ① close --all：从「没有任何标签」开始
  await api('close', { all: true }).catch(() => null);
  await sleep(400);
  const listed = await api('list').catch(() => ({ sessions: [] }));
  check((listed.sessions || []).length === 0, 'close --all 后没有残留标签', `sessions=${(listed.sessions || []).length}`);

  // ② 6 组并行，组内串行：open → shot → close
  // 每个「组-模块」用**各自独立**的文件：代码会话在应用侧会按文件去重（openCode 复用同一个
  // session），多个组共用一个文件时，先关掉的那个会把别人的会话带走 —— 那是测试自身的问题，
  // 不是要被验证的 bug。真实跑批里每个模块也都是不同文件。
  const fixtureDir = path.join(runtimeDir, 'verify-groups-fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const targets = Array.from({ length: groups * modules }, (_v, i) => {
    const g = Math.floor(i / modules) + 1;
    const m = (i % modules) + 1;
    const isCode = m === modules; // 每组的最后一个模块用代码文件（走面板截图路径）
    const file = path.join(fixtureDir, `g${g}-m${m}.${isCode ? 'js' : 'html'}`);
    fs.writeFileSync(file, isCode
      ? `// fixture g${g}-m${m}\nconst value = ${g * 10 + m};\nconsole.log(value);\n`
      : `<!doctype html><html><body style="margin:0;background:hsl(${(i * 47) % 360} 60% 55%);color:#fff;font:700 48px system-ui">`
        + `<div style="padding:40px">GROUP ${g} · MODULE ${m}</div></body></html>`);
    return file;
  });

  let corrupted = false;
  const injectAt = 6000;
  const healAt = 10000;
  const injectTimer = setTimeout(() => {
    const s = readState();
    if (!s) return;
    corrupted = true;
    fs.writeFileSync(statePath, JSON.stringify({
      ...s,
      port: 1,
      socket: `\\\\.\\pipe\\aibrowser-control-verify-${Date.now()}`,
      startedAt: Date.now() - 10 * 60 * 1000, // 已过 45s 启动宽限窗：真实跑批就是这种状态
    }, null, 2));
    step('💉 注入：state.json 的 port/socket 改成连不上 + startedAt 改老（面板本身健康）');
  }, injectAt);
  const healTimer = setTimeout(() => {
    if (pidAlive(appPid)) {
      fs.writeFileSync(statePath, JSON.stringify(original, null, 2));
      step('💊 恢复：state.json 改回真实 port/socket（模拟面板忙完）');
    }
  }, healAt);

  const killEvents = [];
  const groupResults = await Promise.all(Array.from({ length: groups }, async (_v, g) => {
    const out = [];
    for (let m = 0; m < modules; m += 1) {
      if (panelCrashed) { out.push('panel-exited'); return out; }
      const tag = `G${g + 1}-M${m + 1}`;
      const target = targets[g * modules + m];
      let sessionId = null;
      for (let attempt = 1; attempt <= 3 && !sessionId; attempt += 1) {
        const open = await runPvs(['open', target, '--root', root, '--json']);
        if (/清掉残留状态/.test(open.out + open.err)) killEvents.push(`open ${tag}`);
        const parsed = lastJson(open.out);
        if (parsed && parsed.ok) {
          sessionId = parsed.sessionId;
          step(`${tag} open  ✓ ${path.basename(target)} → ${sessionId}（${open.ms}ms）`);
        } else {
          if (panelCrashed) break;
          const why = /ESTUCK|还活着/.test(open.out + open.err)
            ? '被拒绝：服务还活着但暂时没应答'
            : ((open.err || open.out).trim().split('\n')[0] || '未知错误');
          step(`${tag} open  第 ${attempt} 次失败：${why} · 800ms 后重试`);
          await sleep(800);
        }
      }
      if (!sessionId) { out.push('open-failed'); step(`${tag} open  最终失败`); continue; }
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        const shot = await runPvs(['shot', sessionId, '--out', path.join(runtimeDir, `verify-groups-${g}-${m}.png`), '--json']);
        if (/清掉残留状态/.test(shot.out + shot.err)) killEvents.push(`shot ${tag}`);
        ok = /"ok":true/.test(shot.out);
        if (ok) step(`${tag} shot  ✓（${shot.ms}ms）`);
        else {
          if (panelCrashed) break;
          const why = /ESTUCK|还活着/.test(shot.out + shot.err)
            ? '被拒绝：服务还活着但暂时没应答'
            : ((shot.err || shot.out).trim().split('\n')[0] || '未知错误');
          step(`${tag} shot  第 ${attempt} 次失败：${why} · 800ms 后重试`);
          await sleep(800);
        }
      }
      out.push(ok ? 'ok' : 'shot-failed');
      const closed = await runPvs(['close', sessionId, '--json']);
      step(`${tag} close（${closed.ms}ms）`);
    }
    return out;
  }));
  clearTimeout(injectTimer);
  clearTimeout(healTimer);
  clearInterval(watcher);
  if (pidAlive(appPid)) fs.writeFileSync(statePath, JSON.stringify(original, null, 2));

  const flat = groupResults.flat();
  const okShots = flat.filter((x) => x === 'ok').length;
  const total = groups * modules;
  const alive = pidAlive(appPid);
  const afterState = readState();
  const crashedDetail = panelCrashed
    ? `面板在 ${((panelCrashedAt - t0) / 1000).toFixed(2)}s 退出${panelRestartPid ? ` · 已被自动重启为 pid=${panelRestartPid}` : ' · 没有新实例'}`
    : `pid=${appPid} 全程存活`;

  check(okShots === total, '多组并行 + 组内串行截图全部成功',
    `${okShots}/${total}${panelCrashed ? `（面板退出后剩余 ${total - okShots} 个模块未完成）` : ''}`);
  check(!panelCrashed && alive, '面板进程全程存活（没有被杀掉 / 没有闪退）', crashedDetail);
  check(!panelCrashed && Boolean(afterState) && afterState.pid === appPid, '没有自动重启（state.json 仍是同一个 pid）',
    `state.pid=${afterState?.pid ?? '-'}`);
  check(killEvents.length === 0, '任何一条 pvs 都没有判定「清掉残留状态」', killEvents.slice(0, 3).join(', ') || '无');
  check(corrupted, '「探活失败」注入确实生效过', `corrupted=${corrupted}`);

  if (service.started && !keep) {
    // 面板是脚本自己拉起的：用完关掉，避免留一个窗口
    await api('shutdown', {}, 5000).catch(() => null);
    await sleep(1200);
    if (pidAlive(appPid)) { try { process.kill(appPid, 'SIGTERM'); } catch { /* ignore */ } }
    try { fs.rmSync(statePath, { force: true }); } catch { /* ignore */ }
  } else if (!keep) {
    // 面板是你自己起的：不关它，只把 state.json 恢复成好的、并清干净标签
    if (pidAlive(appPid)) fs.writeFileSync(statePath, JSON.stringify(original, null, 2));
    await api('close', { all: true }).catch(() => null);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? '✗' : '✓'} ${results.length - failed.length}/${results.length} 通过${keep ? '（面板保留）' : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`✗ 回归失败：${err && err.message ? err.message : err}`);
  process.exit(1);
});
