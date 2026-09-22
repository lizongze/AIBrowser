'use strict';
const fs = require('node:fs');
const path = require('node:path');
// 主进程的日志出口：**尽力而为地写，写不出去也不能弄崩面板**。
//
// 背景（真实故障）：面板常由「别的进程」拉起来——agent 的 shell、npm start、
// cmd / PowerShell 包装脚本。那些父进程随时会退出，stdout/stderr 的管道随之断开。
// 此后任意一次 stderr 写入都会拿到 EPIPE（broken pipe），Electron 把它当未捕获异常，
// 于是每次开面板前都弹一串：
//   A JavaScript error occurred in the main process
//   Uncaught Exception: Error: EPIPE: broken pipe, write
// 可面板本身明明是好的——日志写不出去只是噪音，不该拦在门口。
// 这里统一吞掉「对端已经不在」这一类错误；其它错误照旧抛出，免得把真正的 bug 一起藏起来。
//
// 两个层面都要挡：
//   1) 异步：Node 的流错误是 emit('error')，没有监听就是 uncaughtException → 挂一个监听；
//   2) 同步：管道已销毁时 write() 会直接 throw（ERR_STREAM_DESTROYED）→ 包一层 try/catch。

/** 这些错误码都表示「对端已经不在了」，不是程序逻辑错误 */
const STREAM_GONE = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_IPC_CHANNEL_CLOSED',
]);

const GUARDED = Symbol.for('aibrowser.streamGuarded');

/** 判断是否是「管道/IPC 通道没了」这类可忽略错误 */
function isStreamGone(err) {
  return Boolean(err && STREAM_GONE.has(err.code));
}

/**
 * 给流挂上 error 监听（幂等）。
 * 只吞「对端没了」，其它错误重新抛出，保持原来的可见性。
 */
function guardStream(stream) {
  if (!stream || stream[GUARDED] || typeof stream.on !== 'function') return stream;
  Object.defineProperty(stream, GUARDED, { value: true, configurable: true });
  stream.on('error', (err) => {
    if (!isStreamGone(err)) throw err;
  });
  return stream;
}

/** 往流里写一行；管道断了就返回 false，不抛 */
function write(stream, text) {
  if (!stream) return false;
  guardStream(stream);
  // 已经断掉/已结束的流直接跳过：继续写只会再触发一次异步 'error'
  if (stream.destroyed || stream.writableEnded || stream.writable === false) return false;
  try {
    const line = String(text);
    stream.write(line.endsWith('\n') ? line : `${line}\n`);
    return true;
  } catch (err) {
    if (isStreamGone(err)) return false;
    throw err;
  }
}

/** 写 stderr（面板/守护进程的日志通道） */
const writeStderr = (text) => write(process.stderr, text);

/** 写 stdout */
const writeStdout = (text) => write(process.stdout, text);

// 引入即生效：任何第三方库直接写 process.stderr 也不会再炸出弹窗
guardStream(process.stdout);
guardStream(process.stderr);

/**
 * 崩溃兜底：Electron 对主进程的 uncaughtException 默认行为是弹一个模态对话框
 * （「A JavaScript error occurred in the main process」）。面板常常是别的进程拉起来的，
 * 管道一断就是 EPIPE —— 那种「错误」既不是 bug 也不该拦在门口，所以这里：
 *   1) 属于「对端没了」的 → 直接丢掉；
 *   2) 其它 → 记到 <runtimeDir>/aibrowser-crash.log，默认也不弹窗（AIBROWSER_CRASH_DIALOG=1 可恢复弹窗）。
 * 记录文件比弹窗有用：agent 可以读它，人也不会被卡住。
 */
function crashLogPath() {
  try {
    // 延迟 require：safe-io 要能在极早期（app ready 之前）加载
    const { runtimeDir } = require('./control/state');
    const dir = runtimeDir();
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'aibrowser-crash.log');
  } catch {
    return null;
  }
}

/** 把一条异常写进 crash log（最多保留最近 200KB） */
function recordCrash(kind, err) {
  const text = `[${new Date().toISOString()}] ${kind}: ${err && err.stack ? err.stack : err}\n`;
  const file = crashLogPath();
  if (!file) return null;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 200 * 1024) fs.writeFileSync(file, '');
    fs.appendFileSync(file, text);
  } catch {
    /* 记不下来就算了，不能因为日志再炸一次 */
  }
  return file;
}

/** uncaughtException / unhandledRejection 的统一处理（导出便于自检） */
function handleCrash(kind, reason) {
  if (isStreamGone(reason)) return { ignored: true, reason: 'stream-gone' };
  const file = recordCrash(kind, reason);
  return { ignored: false, file };
}

/** 装上崩溃兜底（幂等）。返回是否本次真的装了 */
function installCrashGuard({ dialog = process.env.AIBROWSER_CRASH_DIALOG === '1' } = {}) {
  if (process[INSTALLED]) return false;
  Object.defineProperty(process, INSTALLED, { value: true, configurable: true });
  const onError = (err) => {
    const { ignored, file } = handleCrash('uncaughtException', err);
    if (ignored) return;
    writeStderr(`[aibrowser] 主进程异常：${err && err.message ? err.message : err}（已记入 ${file || 'crash log'}）`);
    if (!dialog) return;
    try {
      require('electron').dialog.showErrorBox('AIBrowser 主进程异常', String((err && err.stack) || err));
    } catch {
      /* 没有 electron（比如 CLI 里）就只留日志 */
    }
  };
  const onRejection = (reason) => {
    const { ignored, file } = handleCrash('unhandledRejection', reason);
    if (ignored) return;
    writeStderr(`[aibrowser] 未处理的 Promise 拒绝：${reason && reason.message ? reason.message : reason}（已记入 ${file || 'crash log'}）`);
  };
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onRejection);
  return true;
}

const INSTALLED = Symbol.for('aibrowser.crashGuard');

module.exports = {
  isStreamGone,
  guardStream,
  write,
  writeStderr,
  writeStdout,
  crashLogPath,
  recordCrash,
  handleCrash,
  installCrashGuard,
};
