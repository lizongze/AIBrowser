'use strict';
// PreviewManager：会话表 + GUI 面板里的原生视图寄宿。
const path = require('node:path');
const fs = require('node:fs');
const { PreviewSession, cleanUrl, isLocalTarget } = require('./preview-session');
const { detectLanguage, isWebPreviewable } = require('./language');

class PreviewManager {
  /**
   * @param {object} deps
   * @param {import('./file-service').FileService} deps.files
   * @param {()=>string} deps.endpoint
   * @param {()=>string} deps.token
   * @param {()=>boolean} deps.reloadEnabled
   * @param {(channel:string, payload:any)=>void} deps.broadcast
   */
  constructor(deps) {
    this.deps = deps;
    this.files = deps.files;
    this.sessions = new Map();
    this.order = [];
    this.focusedId = null;
    /** @type {import('electron').BaseWindow|null} */
    this.guiWindow = null;
    this.host = 'window';
    /** @type {{x:number,y:number,width:number,height:number}|null} */
    this.viewBounds = null;
    this.activeViewId = null;
  }

  setGuiWindow(win) {
    this.guiWindow = win;
    this.host = 'view';
  }

  setHost(host) {
    this.host = host;
  }

  create(overrides = {}) {
    const session = new PreviewSession({
      files: this.files,
      host: this.host,
      urlForFile: (file) => this.urlForFile(file),
      onPopup: (owner, url) => this.open({ url, focus: true }),
      onConsole: (s, entry) => this.deps.broadcast('console:entry', { sessionId: s.id, entry }),
      onNetwork: (s) => this.deps.broadcast('sessions:updated', { sessions: this.list() }),
      onChange: () => this.deps.broadcast('sessions:updated', { sessions: this.list() }),
      captureSession: () => {},
      ...overrides,
    });
    this.sessions.set(session.id, session);
    this.order.push(session.id);
    return session;
  }

  get(id) {
    if (!id) return this.focused();
    return this.sessions.get(id) || null;
  }

  focused() {
    if (this.focusedId && this.sessions.has(this.focusedId)) return this.sessions.get(this.focusedId);
    const first = this.order.map((id) => this.sessions.get(id)).filter(Boolean)[0] || null;
    return first;
  }

  /** 解析会话：显式 id 优先，其次 focused；带空值错误信息 */
  resolve(sessionId, { requireWeb = false } = {}) {
    const session = this.get(sessionId);
    if (!session) {
      const err = new Error('当前没有可用的预览会话，请先 open 一个文件或 URL');
      err.code = 'NOSESSION';
      throw err;
    }
    return session;
  }

  setFocus(id) {
    if (!this.sessions.has(id)) return null;
    this.focusedId = id;
    for (const session of this.sessions.values()) session.focused = session.id === id;
    this.deps.broadcast('sessions:updated', { sessions: this.list() });
    return this.sessions.get(id);
  }

  list() {
    return this.order.map((id) => this.sessions.get(id)).filter(Boolean).map((s) => this.info(s));
  }

  info(session) {
    const info = session.info();
    return { ...info, kind: session.kind === 'code' ? 'code' : 'web' };
  }

  urlForFile(file) {
    const root = this.files.rootContaining(file);
    let rootId = root?.id;
    if (!rootId) {
      const added = this.files.addRootFor(file, true);
      rootId = added.id;
      this.deps.broadcast('roots:updated', { roots: this.files.listRoots() });
    }
    const url = this.files.urlFor(rootId, path.resolve(file));
    return url ? { url, rootId } : null;
  }

  /** 打开网页预览（本地文件或 URL） */
  async open({ file, url, root, focus = true, sessionId = null } = {}) {
    if (root) this.files.addRoot(root);
    let target = null;
    if (file) {
      const abs = path.resolve(file);
      if (!this.files.rootContaining(abs)) {
        const isFile = !fs.existsSync(abs) || fs.statSync(abs).isFile();
        this.files.addRootFor(abs, isFile);
        this.deps.broadcast('roots:updated', { roots: this.files.listRoots() });
      }
      target = { file: abs };
    } else if (url) {
      target = { url: cleanUrl(url) || url };
    } else {
      throw new Error('open 需要 file 或 url 参数');
    }

    const existing = sessionId ? this.sessions.get(sessionId) : null;
    const session = existing || this.create();
    if (existing) this.setFocus(existing.id);
    await session.load(target);
    if (session.file) session.watchProjectDir(path.dirname(session.file));
    if (focus) this.setFocus(session.id);
    this.deps.broadcast('sessions:updated', { sessions: this.list() });
    this.deps.broadcast('ui:open', { sessionId: session.id, view: 'web' });
    return session;
  }

  /** 打开代码预览（GUI 里由渲染进程用 CodeMirror 显示；无头下只登记会话信息） */
  async openCode({ file, root, line = null, column = null, focus = true } = {}) {
    if (!file) throw new Error('openCode 需要 file 参数');
    const abs = path.resolve(file);
    if (!this.files.rootContaining(abs)) {
      this.files.addRootFor(abs, true);
      this.deps.broadcast('roots:updated', { roots: this.files.listRoots() });
    }
    const existing = this.order
      .map((id) => this.sessions.get(id))
      .find((s) => s && s.kind === 'code' && s.file === abs);
    const lang = detectLanguage(abs);
    const session = existing || this.create();
    session.kind = 'code';
    session.file = abs;
    session.title = path.basename(abs);
    session.language = lang.id;
    session.languageLabel = lang.label;
    session.line = line;
    session.column = column;
    session.url = `code://${abs}`;
    if (focus) this.setFocus(session.id);
    this.deps.broadcast('sessions:updated', { sessions: this.list() });
    this.deps.broadcast('ui:open', { sessionId: session.id, view: 'code', file: abs, line, column });
    return session;
  }

  async reload(sessionId, hard = false) {
    const session = this.resolve(sessionId, { requireWeb: true });
    await session.reload(hard);
    return session;
  }

  close(sessionId) {
    const id = sessionId || this.focusedId;
    const session = this.sessions.get(id);
    if (!session) return false;
    if (this.activeViewId === id) this.clearView();
    session.destroy();
    this.sessions.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.focusedId === id) this.focusedId = this.order[this.order.length - 1] || null;
    this.setFocus(this.focusedId);
    this.deps.broadcast('sessions:updated', { sessions: this.list() });
    return true;
  }

  closeAll() {
    for (const id of [...this.order]) this.close(id);
  }

  // ---------- GUI 原生视图寄宿 ----------

  updateViewBounds(bounds) {
    const next = {
      x: Math.round(Number(bounds.x) || 0),
      y: Math.round(Number(bounds.y) || 0),
      width: Math.round(Number(bounds.width) || 0),
      height: Math.round(Number(bounds.height) || 0),
    };
    const previous = this.viewBounds;
    if (previous
      && previous.x === next.x && previous.y === next.y
      && previous.width === next.width && previous.height === next.height) {
      return; // 尺寸没变就不要重排，否则会和渲染层的 ResizeObserver 形成循环
    }
    this.viewBounds = next;
    this.applyView();
  }

  setActiveView(sessionId) {
    if (this.activeViewId === sessionId) return; // 幂等：重复设置不触发重排
    this.activeViewId = sessionId;
    this.applyView();
  }

  /**
   * 把 active 会话的 WebContentsView 铺到面板内容区；其余全部摘掉。
   * 必须幂等：摘挂原生子视图会改变窗口合成布局，进而触发渲染层的 ResizeObserver；
   * 如果这里每次调用都摘了再挂，就会变成「点击/渲染 → 重排 → 上报布局 → 再重排」的抖动循环。
   */
  applyView() {
    if (!this.guiWindow || this.guiWindow.isDestroyed()) return;
    const contentView = this.guiWindow.contentView;
    const wanted = this.activeViewId ? this.sessions.get(this.activeViewId) : null;
    const shouldShow = Boolean(wanted && wanted.view && this.viewBounds && this.viewBounds.width > 4 && this.viewBounds.height > 4);

    const target = shouldShow ? wanted.view : null;
    const attached = target !== null && contentView.children.includes(target);

    // 1) 摘掉所有不该在场景里的子视图（带上限，避免异常状态下反复进出）
    for (const child of contentView.children.slice()) {
      if (child === target) continue;
      try {
        contentView.removeChildView(child);
      } catch {
        /* ignore */
      }
    }
    if (wanted?.view && typeof wanted.view.setVisible === 'function') wanted.view.setVisible(Boolean(shouldShow));

    if (!shouldShow || !target) return;

    // 2) 位置没变且已挂载 → 什么都不做（这是防抖动的关键）
    const { x, y, width, height } = this.viewBounds;
    const next = { x, y, width: Math.max(1, width), height: Math.max(1, height) };
    let current = null;
    try {
      current = target.getBounds();
    } catch {
      current = null;
    }
    const sameBounds = current
      && current.x === next.x && current.y === next.y
      && current.width === next.width && current.height === next.height;
    if (!attached) {
      try {
        contentView.addChildView(target);
      } catch {
        /* 已添加 */
      }
    }
    if (!sameBounds) {
      try {
        target.setBounds(next);
      } catch {
        /* ignore */
      }
    }
  }

  clearView() {
    this.activeViewId = null;
    this.applyView();
  }

  // ---------- 便捷入口 ----------

  /** 智能打开：目录→index.html；.html→网页预览；其它→代码预览 */
  async openPath(targetPath, opts = {}) {
    const abs = path.resolve(targetPath);
    if (!fs.existsSync(abs)) throw new Error(`路径不存在：${abs}`);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const index = path.join(abs, 'index.html');
      if (!fs.existsSync(index)) throw new Error(`目录下没有 index.html：${abs}`);
      return { kind: 'web', session: await this.open({ file: index, root: opts.root, ...opts }) };
    }
    if (opts.force === 'code' || !isWebPreviewable(abs)) {
      return { kind: 'code', session: await this.openCode({ file: abs, ...opts }) };
    }
    return { kind: 'web', session: await this.open({ file: abs, ...opts }) };
  }
}

module.exports = { PreviewManager };
