'use strict';
// PreviewSession：一个网页预览会话。
// host 有两种形态：
//   'window'  → 无头模式，独立的隐藏 BrowserWindow（可 pop-out 显示）
//   'view'    → GUI 模式，WebContentsView 由主进程嵌入面板
const path = require('node:path');
const fssync = require('node:fs');
const fs = require('node:fs/promises');
const { BrowserWindow, WebContentsView } = require('electron');
const { PREVIEW_PARTITION } = require('./preview-protocol');
const { detectLanguage } = require('./language');

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 840;
const MAX_CONSOLE_ENTRIES = 2000;
const MAX_NETWORK_ENTRIES = 1000;

function cleanUrl(value) {
  const text = String(value || '').trim().replace(/^["']|["']$/g, '');
  if (!text) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) || /^data:/.test(text) || /^about:/.test(text)) return text;
  if (/^localhost(:\d+)?(\/|$)/i.test(text) || /^\d+\.\d+\.\d+\.\d+(:\d+)?(\/|$)/.test(text)) return `http://${text}`;
  return null;
}

function isLocalTarget(text) {
  if (!text) return false;
  if (cleanUrl(text)) return false;
  return true;
}

let sessionSeq = 0;

class PreviewSession {
  /**
   * @param {object} ctx
   * @param {import('./file-service').FileService} ctx.files
   * @param {(file:string)=>string} ctx.urlForFile  本地文件 → pvs:// URL
   * @param {()=>void} ctx.onChange
   * @param {()=>void} ctx.onConsole
   * @param {()=>void} ctx.onNetwork
   * @param {()=>void} ctx.onFocusRequest
   */
  constructor(ctx) {
    this.ctx = ctx;
    sessionSeq += 1;
    this.id = `s${sessionSeq}`;
    this.kind = 'web';
    this.file = null;
    this.rootId = null;
    this.title = '新建预览';
    this.url = 'about:blank';
    this.focused = false;
    this.loading = false;
    this.consoleEntries = [];
    this.networkEntries = [];
    this.networkEnabled = false;
    this.consoleOpen = false;
    this.zoomFactor = 1;
    this.host = ctx.host || 'window'; // 'window' | 'view'
    this.createdAt = Date.now();
    this.lastError = null;
    this._watchers = new Map();
    this._pollTimer = null;
    this._poller = null;
    this._extraWatch = new Set();
    this._watchStamps = new Map();
    this._pendingEval = null;
    this._sentRequestIds = new Map();
    this._attachCallbacks = [];
    this.webContents = null;
    this.window = null;
    this.view = null;
    // 宿主（真实 Chromium 页面）按需创建：代码会话没有页面，也不需要窗口
  }

  /** 是否已具备真实 Chromium 页面 */
  get hasHost() {
    return Boolean(this.webContents && !this.webContents.isDestroyed());
  }

  /** 惰性创建宿主：网页会话第一次加载时才建窗口/视图 */
  ensureHost() {
    if (this.webContents && !this.webContents.isDestroyed()) return this;
    this.createHost();
    return this;
  }

  // ---------- host 创建与消息接线 ----------

  createHost() {
    const webPreferences = {
      partition: PREVIEW_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    };

    if (this.host === 'view') {
      this.view = new WebContentsView({ webPreferences });
      this.view.setBackgroundColor('#ffffff');
      if (typeof this.view.setVisible === 'function') this.view.setVisible(false);
      this.window = null;
      this.webContents = this.view.webContents;
    } else if (this.host === 'offscreen') {
      // 无头模式：离屏渲染 + 隐藏窗口。窗口始终 show:false 且不进任务栏，
      // 因此在 WSLg / 桌面环境下都不会闪现；截图取 paint 事件的位图。
      this.window = new BrowserWindow({
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        show: false,
        skipTaskbar: true,
        focusable: false,
        title: 'AIBrowser',
        backgroundColor: '#ffffff',
        webPreferences: { ...webPreferences, offscreen: true },
      });
      this.view = null;
      this.webContents = this.window.webContents;
      this._offscreenFrame = null;
      this.webContents.setFrameRate(20);
      this.webContents.on('paint', (_event, _dirty, image) => {
        this._offscreenFrame = image;
      });
    } else {
      this.window = new BrowserWindow({
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        show: false,
        skipTaskbar: true,
        title: 'AIBrowser',
        backgroundColor: '#ffffff',
        webPreferences,
      });
      this.view = null;
      this.webContents = this.window.webContents;
    }

    this.wireWebContents();
    this.ctx.captureSession?.(this);
    return this;
  }

  wireWebContents() {
    const wc = this.webContents;

    wc.setWindowOpenHandler(({ url }) => {
      // 预览里的 target=_blank：同进程内新开会话，避免弹出无地址栏窗口
      if (/^https?:|^pvs:/.test(url)) {
        setImmediate(() => this.ctx.onPopup?.(this, url));
        return { action: 'deny' };
      }
      return { action: 'deny' };
    });

    wc.on('did-start-loading', () => {
      this.loading = true;
      this.emitChange();
    });

    wc.on('did-stop-loading', () => {
      this.loading = false;
      this.emitChange();
    });

    wc.on('did-finish-load', () => {
      this.lastError = null;
      this.loading = false;
      this.syncMeta();
      this.emitChange();
    });

    wc.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3 /* ERR_ABORTED */) return;
      this.lastError = { code, description, url: validatedURL };
      this.pushConsole({
        level: 'error',
        text: `加载失败：${description} (${code}) ${validatedURL || ''}`,
        ts: Date.now(),
      });
      this.emitChange();
    });

    wc.on('page-title-updated', (_e, title) => {
      this.title = title || this.title;
      this.emitChange();
    });

    wc.on('did-navigate', (_e, url) => {
      this.url = url;
      this.syncMeta();
      this.emitChange();
    });

    wc.on('did-navigate-in-page', (_e, url) => {
      this.url = url;
      this.emitChange();
    });

    wc.on('console-message', (...args) => {
      // Electron 新旧签名兼容：老版本 (event, level, message, line, sourceId)
      let level = 'log';
      let message = '';
      if (args.length && typeof args[1] === 'object' && args[1] && 'message' in args[1]) {
        const details = args[1];
        level = typeof details.level === 'number' ? ['debug', 'info', 'warn', 'error'][details.level] || 'log' : details.level || 'log';
        message = details.message;
      } else {
        const rawLevel = args[1];
        level = typeof rawLevel === 'number' ? ['debug', 'info', 'warn', 'error'][rawLevel] || 'log' : String(rawLevel || 'log');
        message = args[2];
      }
      this.pushConsole({ level, text: String(message ?? ''), ts: Date.now() });
    });

    wc.on('render-process-gone', (_e, details) => {
      this.pushConsole({ level: 'error', text: `渲染进程退出：${details.reason}`, ts: Date.now() });
      this.emitChange();
    });

    this.networkListener = (event, details) => {
      if (!this.networkEnabled) return;
      const isMainFrame = details.webContentsId === wc.id || true;
      if (!isMainFrame) return;
      this.networkEntries.push({
        method: details.method,
        url: details.url,
        status: details.statusCode,
        resourceType: details.resourceType,
        ok: !details.error && details.statusCode >= 200 && details.statusCode < 400,
        ts: Date.now(),
        durationMs: undefined,
      });
      if (this.networkEntries.length > MAX_NETWORK_ENTRIES) this.networkEntries.splice(0, this.networkEntries.length - MAX_NETWORK_ENTRIES);
      this.ctx.onNetwork?.(this);
    };

    wc.on('did-start-navigation', (_e, url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      this._navStart = { url, at: Date.now() };
    });
    wc.on('did-frame-finish-load', () => {
      if (this._navStart && this.networkEnabled) {
        const durationMs = Date.now() - this._navStart.at;
        this.networkEntries.push({
          method: 'GET',
          url: this._navStart.url,
          status: this.lastError ? 0 : 200,
          resourceType: 'document',
          ok: !this.lastError,
          ts: Date.now(),
          durationMs,
        });
        this._navStart = null;
        this.ctx.onNetwork?.(this);
      }
    });
  }

  /** 由主进程 control server 转交：注入脚本上报的事件 */
  handleAgentEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind === 'console') {
      this.pushConsole({ level: payload.level || 'log', text: String(payload.text ?? ''), ts: Date.now(), url: payload.url });
    } else if (payload.kind === 'network') {
      if (!this.networkEnabled) return;
      this.networkEntries.push({
        method: payload.method || 'GET',
        url: payload.url || '',
        status: payload.status ?? 0,
        resourceType: payload.resourceType || 'fetch',
        ok: Boolean(payload.ok),
        ts: Date.now(),
        durationMs: payload.durationMs,
        error: payload.error,
      });
      if (this.networkEntries.length > MAX_NETWORK_ENTRIES) this.networkEntries.splice(0, this.networkEntries.length - MAX_NETWORK_ENTRIES);
      this.ctx.onNetwork?.(this);
    }
  }

  pushConsole(entry) {
    const normalized = {
      level: entry.level || 'log',
      text: String(entry.text ?? ''),
      ts: entry.ts || Date.now(),
      url: entry.url,
    };
    this.consoleEntries.push(normalized);
    if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
      this.consoleEntries.splice(0, this.consoleEntries.length - MAX_CONSOLE_ENTRIES);
    }
    this.ctx.onConsole?.(this, normalized);
  }

  // ---------- 导航 ----------

  /**
   * @param {{file?:string, url?:string, rootId?:string}} target
   */
  async load(target) {
    const { file, url } = target;
    this.ensureHost();
    if (url) {
      const normalized = cleanUrl(url) || url;
      this.file = null;
      this.rootId = null;
      await this.webContents.loadURL(normalized);
      this.startPolling();
      this.url = this.webContents.getURL() || normalized;
      this.title = this.webContents.getTitle() || normalized;
      this.emitChange();
      return this;
    }
    if (!file) throw new Error('需要 file 或 url 参数');
    const abs = path.resolve(file);
    if (!fssync.existsSync(abs)) throw new Error(`文件不存在：${abs}`);
    const stat = await fs.stat(abs);
    const target_file = stat.isDirectory() ? path.join(abs, 'index.html') : abs;
    if (!fssync.existsSync(target_file)) throw new Error(`目录下没有 index.html：${abs}`);
    const registered = this.ctx.urlForFile(target_file);
    if (!registered) throw new Error(`文件不在已授权目录内：${target_file}`);
    this.file = path.resolve(target_file);
    this.rootId = registered.rootId;
    this.title = path.basename(this.file);
    await this.webContents.loadURL(`${registered.url}?__pvsSession=${encodeURIComponent(this.id)}`);
    this.url = this.webContents.getURL();
    this.watchProjectDir(path.dirname(this.file));
    this.pollFiles(); // 建立 mtime 基线，避免首次轮询误判
    this.startPolling();
    this.emitChange();
    return this;
  }

  /**
   * 热重载：轮询被关注文件的 mtime。
   * 之所以不用 fs.watch —— 在 WSL 的 /mnt/* 挂载（9p）上 inotify 事件经常丢失，
   * 而轮询在同一份代码里跨平台都可靠，代价只是 600ms 一次 stat。
   */
  startPolling() {
    if (this._poller) return; // 面板会话与无头会话都需要热重载，不按宿主区分
    this._poller = setInterval(() => {
      try {
        this.pollFiles();
      } catch {
        /* 轮询异常不能影响主进程 */
      }
    }, 600);
    if (typeof this._poller.unref === 'function') this._poller.unref();
  }

  pollFiles() {
    const targets = new Set();
    if (this.file) targets.add(this.file);
    for (const file of this._extraWatch) targets.add(file);
    for (const file of targets) {
      let stamp = null;
      try {
        const info = fssync.statSync(file);
        stamp = `${info.mtimeMs}:${info.size}`;
      } catch {
        stamp = 'missing';
      }
      const previous = this._watchStamps.get(file);
      if (previous === undefined) {
        this._watchStamps.set(file, stamp);
        continue;
      }
      if (previous !== stamp) {
        this._watchStamps.set(file, stamp);
        this.scheduleReload(`文件变化：${path.basename(file)}`);
        break;
      }
    }
  }

  /** 关注某个文件（页面引用的 CSS/JS 等） */
  watchFile(file) {
    if (file) this._extraWatch.add(file);
  }

  /** 关注整个项目目录里的常见静态资源（HTML/CSS/JS/SVG），供预览站点时自动刷新 */
  watchProjectDir(dir) {
    if (!dir) return;
    let entries = [];
    try {
      entries = fssync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(html?|xhtml|svg|css|m?js|cjs|json|txt|md)$/i.test(entry.name)) continue;
      this.watchFile(path.join(dir, entry.name));
    }
  }

  scheduleReload(reason) {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.pushConsole({ level: 'info', text: `热重载：${reason}`, ts: Date.now() });
      try {
        // 注意：Electron 里 reload / reloadIgnoringCache 返回 void，
        // 直接 .catch() 会在定时器回调里抛 TypeError 并让主进程崩溃。
        const result = this.webContents.reloadIgnoringCache();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (err) {
        this.pushConsole({ level: 'error', text: `热重载失败：${err.message}`, ts: Date.now() });
      }
    }, 120);
  }

  async reload(hard = false) {
    this.requireHost();
    const pending = hard ? this.webContents.reloadIgnoringCache() : this.webContents.reload();
    if (pending && typeof pending.then === 'function') await pending;
    this.emitChange();
    return this;
  }

  async goBack() {
    this.requireHost();
    const history = this.webContents.navigationHistory;
    if (history && history.canGoBack()) {
      history.goBack();
      return true;
    }
    return false;
  }

  async goForward() {
    this.requireHost();
    const history = this.webContents.navigationHistory;
    if (history && history.canGoForward()) {
      history.goForward();
      return true;
    }
    return false;
  }

  // ---------- 能力 ----------

  /** 截图取帧：离屏会话用 paint 事件的位图；面板/窗口会话用 capturePage */
  async grabFrame(rect) {
    if (this.host !== 'offscreen') return this.webContents.capturePage(rect);

    // 离屏渲染：优先用 paint 事件产出的帧。
    // 部分环境（例如无 GPU 的 WSL）不会自动产出帧，此时主动 invalidate 触发一次重绘。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (let i = 0; i < 30; i += 1) {
        if (this._offscreenFrame && !this._offscreenFrame.isEmpty()) return this._offscreenFrame;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      try {
        this.webContents.invalidate();
      } catch {
        /* ignore */
      }
    }
    // 最后的兜底：窗口本就不可见（show:false + skipTaskbar），capturePage 不会打扰用户
    const image = await this.webContents.capturePage(rect);
    if (image && !image.isEmpty()) return image;
    throw new Error('离屏渲染没有产出画面（页面可能仍在加载，或该环境不支持离屏渲染）');
  }

  async screenshot({ format = 'png', quality, fullPage = false, selector } = {}) {
    await this.ensureLoaded();
    this.requireHost();
    if (selector) {
      const rect = await this.runInPage(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      })()`, { timeoutMs: 8000 });
      if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error(`选择器未匹配到可见元素：${selector}`);
      const image = await this.grabFrame(rect);
      return this.imageResult(image, format, quality);
    }
    if (fullPage) {
      const metrics = await this.runInPage(`(() => {
        const d = document.documentElement;
        return { width: Math.max(d.scrollWidth, window.innerWidth), height: Math.max(d.scrollHeight, window.innerHeight) };
      })()`, { timeoutMs: 8000 });
      const [origW, origH] = this.sizeOf();
      const targetW = Math.min(Math.max(metrics.width, 320), 4000);
      const targetH = Math.min(Math.max(metrics.height, 240), 20000);
      this.resize(targetW, targetH);
      // 等一帧新尺寸的画面（离屏需要更久一点）
      await new Promise((resolve) => setTimeout(resolve, this.host === 'offscreen' ? 500 : 260));
      const image = await this.grabFrame();
      this.resize(origW, origH);
      return this.imageResult(image, format, quality);
    }
    const image = await this.grabFrame();
    return this.imageResult(image, format, quality);
  }

  imageResult(image, format, quality) {
    const size = image.getSize();
    const data = format === 'jpeg' ? image.toJPEG(quality ?? 85) : image.toPNG();
    return {
      sessionId: this.id,
      format: format === 'jpeg' ? 'jpeg' : 'png',
      width: size.width,
      height: size.height,
      bytes: data.length,
      dataBase64: data.toString('base64'),
      buffer: data,
      image, // 保留 nativeImage，便于程序化校验像素
    };
  }

  sizeOf() {
    if (this.view) {
      const bounds = this.view.getBounds();
      return [bounds.width || DEFAULT_WIDTH, bounds.height || DEFAULT_HEIGHT];
    }
    const [w, h] = this.window.getContentSize();
    return [w || DEFAULT_WIDTH, h || DEFAULT_HEIGHT];
  }

  resize(width, height) {
    if (this.view) {
      const b = this.view.getBounds();
      this.view.setBounds({ x: b.x, y: b.y, width, height });
    } else if (this.window) {
      this.window.setContentSize(width, height);
    }
  }

  /** 需要真实页面能力的入口：没有宿主时给出明确错误（而不是静默卡住） */
  requireHost() {
    if (!this.webContents || this.webContents.isDestroyed()) {
      const err = new Error(this.kind === 'code'
        ? '这是代码预览会话，没有网页图层；请先 open 一个网页（HTML 或 URL）'
        : '预览页面尚未加载或已关闭');
      err.code = 'NOSESSION';
      throw err;
    }
    return this.webContents;
  }

  async ensureLoaded() {
    if (this.pendingLoad) await this.pendingLoad.catch(() => {});
    return this;
  }

  async getContent({ selector, format = 'text', maxLength = 200000 } = {}) {
    await this.ensureLoaded();
    this.requireHost();
    const expr = selector
      ? (format === 'html'
        ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : null; })()`
        : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.innerText : null; })()`)
      : (format === 'html' ? 'document.documentElement.outerHTML' : 'document.body ? document.body.innerText : ""');
    const raw = await this.runInPage(expr, { timeoutMs: 15000 });
    const text = raw === null || raw === undefined ? '' : String(raw);
    const truncated = text.length > maxLength;
    return {
      sessionId: this.id,
      title: this.title,
      url: this.webContents.getURL(),
      text: truncated ? text.slice(0, maxLength) : text,
      length: text.length,
      truncated,
    };
  }

  /**
   * 带超时地执行页面脚本：渲染进程被同步长任务卡住时，不能让控制请求无限挂起。
   * 超时后会尝试重新加载页面，保证后续调用还能用。
   */
  async runInPage(code, { timeoutMs = 15000, userGesture = true } = {}) {
    const wc = this.webContents;
    if (!wc || wc.isDestroyed()) {
      const err = new Error(this.kind === 'code'
        ? '这是代码预览会话，没有网页图层；请先 open 一个网页（HTML 或 URL）'
        : '预览页面尚未加载或已关闭');
      err.code = 'NOSESSION';
      throw err;
    }
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`页面执行超时（${timeoutMs}ms）：页面可能被同步脚本阻塞`);
        err.code = 'ETIMEOUT';
        reject(err);
        wc.reload().catch(() => {});
      }, timeoutMs);
    });
    try {
      return await Promise.race([wc.executeJavaScript(code, userGesture), timeout]);
    } catch (err) {
      if (err && err.code === 'ETIMEOUT') throw err;
      // Electron 在脚本抛错时只给一句笼统信息，这里补上上下文便于诊断
      const wrapped = new Error(`页面执行失败：${err?.message || err}`);
      wrapped.code = 'EPAGE';
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 执行 JS：先按「表达式」求值，语法不成立时按「语句块」执行。
   * 结果在页面内序列化成 JSON 字符串回传：即使表达式返回 undefined / DOM 节点 /
   * 循环引用，或语句块里 throw，都不会让 executeJavaScript 以「Script failed to execute」失败。
   */
  async evaluate(expression, { timeoutMs = 15000 } = {}) {
    await this.ensureLoaded();
    const raw = JSON.stringify(String(expression ?? ''));
    const script = `(() => {
      const serialize = (v) => {
        try {
          if (v === undefined) return { type: 'undefined', text: 'undefined' };
          if (v === null) return { type: 'null', text: 'null' };
          const t = typeof v;
          if (t === 'string') return { type: t, text: v };
          if (t === 'number' || t === 'boolean' || t === 'bigint') return { type: t, text: String(v) };
          if (t === 'function') return { type: t, text: String(v).slice(0, 4000) };
          if (t === 'symbol') return { type: t, text: v.toString() };
          if (v instanceof Error) return { type: 'error', text: v.stack || (v.name + ': ' + v.message) };
          if (v && v.nodeType === 1) {
            return { type: 'element', text: '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + '> ' + String(v.outerHTML || '').slice(0, 2000) };
          }
          const seen = new WeakSet();
          const text = JSON.stringify(v, (key, value) => {
            if (typeof value === 'object' && value !== null) {
              if (seen.has(value)) return '[circular]';
              seen.add(value);
            }
            return value;
          }, 2);
          return { type: 'object', text: text === undefined ? String(v) : text };
        } catch (e) {
          return { type: 'unknown', text: String(v) };
        }
      };
      const source = ${raw};
      try {
        let value;
        try {
          // eslint-disable-next-line no-new-func
          value = (0, eval)('(' + source + '\\n)');
        } catch (e) {
          if (e instanceof SyntaxError) {
            // eslint-disable-next-line no-new-func
            value = (0, eval)(source);
          } else {
            throw e;
          }
        }
        return JSON.stringify(serialize(value));
      } catch (err) {
        return JSON.stringify({ type: 'error', text: (err && err.stack) || String(err), threw: true });
      }
    })()`;
    const text = await this.runInPage(script, { timeoutMs });
    let parsed;
    try {
      parsed = JSON.parse(typeof text === 'string' ? text : JSON.stringify(text));
    } catch {
      parsed = { type: 'unknown', text: String(text) };
    }
    let value = String(parsed?.text ?? '');
    if (value.length > 200000) value = `${value.slice(0, 200000)}\n… (已截断)`;
    return { sessionId: this.id, value, type: parsed?.type || 'unknown', threw: Boolean(parsed?.threw) };
  }

  async evalInPage(expression) {
    return this.runInPage(String(expression), { timeoutMs: 15000 });
  }

  console({ clear = false, since } = {}) {
    const entries = since ? this.consoleEntries.filter((e) => e.ts > since) : this.consoleEntries.slice();
    if (clear) this.consoleEntries = [];
    return { sessionId: this.id, entries };
  }

  network({ enabled, clear = false } = {}) {
    if (this.hasHost && typeof enabled === 'boolean') {
      const changed = this.networkEnabled !== enabled;
      this.networkEnabled = enabled;
      if (enabled && changed) {
        try {
          this.webContents.debugger.attach('1.3');
        } catch {
          /* 已附加 */
        }
        try {
          this.webContents.debugger.sendCommand('Network.enable');
          this.webContents.debugger.on('message', this._onDebuggerMessage || (this._onDebuggerMessage = (_e, method, params) => {
            if (!this.networkEnabled) return;
            if (method === 'Network.responseReceived') {
              this.networkEntries.push({
                method: params.response?.requestHeaders ? 'GET' : 'GET',
                url: params.response?.url || '',
                status: params.response?.status ?? 0,
                resourceType: params.type || 'Other',
                ok: (params.response?.status ?? 0) >= 200 && (params.response?.status ?? 0) < 400,
                ts: Date.now(),
                durationMs: undefined,
              });
              if (this.networkEntries.length > MAX_NETWORK_ENTRIES) {
                this.networkEntries.splice(0, this.networkEntries.length - MAX_NETWORK_ENTRIES);
              }
              this.ctx.onNetwork?.(this);
            }
          }));
        } catch {
          /* CDP 不可用时依赖注入脚本上报 fetch */
        }
      }
      if (!enabled && this.webContents.debugger.isAttached()) {
        try {
          this.webContents.debugger.detach();
        } catch {
          /* ignore */
        }
      }
      this.emitChange();
    }
    const entries = this.networkEntries.slice();
    if (clear) this.networkEntries = [];
    return { sessionId: this.id, enabled: this.networkEnabled, entries };
  }

  setZoom(factor) {
    this.requireHost();
    const clamped = Math.min(Math.max(Number(factor) || 1, 0.25), 5);
    this.zoomFactor = clamped;
    this.webContents.setZoomFactor(clamped);
    this.emitChange();
    return { sessionId: this.id, factor: clamped };
  }

  syncMeta() {
    try {
      const wc = this.webContents;
      if (!wc.isDestroyed()) {
        if (!this.file) {
          this.url = wc.getURL() || this.url;
          const title = wc.getTitle();
          if (title) this.title = title;
        }
      }
    } catch {
      /* ignore */
    }
  }

  info() {
    let canGoBack = false;
    let canGoForward = false;
    const wc = this.hasHost ? this.webContents : null;
    try {
      const history = wc ? wc.navigationHistory : null;
      canGoBack = Boolean(history?.canGoBack());
      canGoForward = Boolean(history?.canGoForward());
    } catch {
      /* ignore */
    }
    return {
      sessionId: this.id,
      kind: this.kind,
      title: this.title,
      url: this.file ? this.url : (wc ? wc.getURL() : this.url) || this.url,
      file: this.file,
      language: this.file ? detectLanguage(this.file).id : null,
      languageLabel: this.file ? detectLanguage(this.file).label : null,
      line: this.line ?? null,
      column: this.column ?? null,
      focused: this.focused,
      loading: this.loading,
      hasPage: this.hasHost,
      canGoBack,
      canGoForward,
      lastError: this.lastError,
      zoom: this.zoomFactor,
      host: this.host,
    };
  }

  emitChange() {
    this.ctx.onChange?.(this);
  }

  destroy() {
    for (const watcher of this._watchers.values()) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
    }
    this._watchers.clear();
    if (this._poller) clearInterval(this._poller);
    this._poller = null;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    try {
      if (this.webContents && !this.webContents.isDestroyed()) {
        if (this.webContents.debugger.isAttached()) this.webContents.debugger.detach();
        this.webContents.close();
      }
    } catch {
      /* ignore */
    }
    try {
      if (this.window && !this.window.isDestroyed()) this.window.destroy();
    } catch {
      /* ignore */
    }
    this.view = null;
    this.window = null;
  }
}

module.exports = { PreviewSession, cleanUrl, isLocalTarget };
