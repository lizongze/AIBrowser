'use strict';
// 控制服务：把「open/eval/screenshot/console」等动作暴露给 CLI 与 AI。
//   - Unix socket：NDJSON（{id, action, params} → {id, ok, result|error}）
//   - HTTP：POST /<action>、GET /health、GET /sessions、GET /screenshot（直接返回图片字节）
//   - WebSocket：/__pvs/ws  —— 预览页面回传热重载信号；页面事件走 POST /__pvs/event
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { bindSocket, runtimeDir, socketPath, writeState, env } = require('./state');
const { activateSession, capturePanelShot, panelWindow } = require('../panel-shot');

const VERSION = require('../../../package.json').version;
const MAX_BODY = 8 * 1024 * 1024;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 极简 WebSocket 文本帧编码（服务端→客户端，不掩码） */
function encodeFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 客户端帧解码（处理掩码与分片长度；返回 messages 与剩余 buffer） */
function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  let rest = buffer;
  for (;;) {
    if (rest.length - offset < 2) break;
    const first = rest[offset];
    const opcode = first & 0x0f;
    const masked = (rest[offset + 1] & 0x80) === 0x80;
    let length = rest[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (rest.length < cursor + 2) break;
      length = rest.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (rest.length < cursor + 8) break;
      length = Number(rest.readBigUInt64BE(cursor));
      cursor += 8;
    }
    let maskKey = null;
    if (masked) {
      if (rest.length < cursor + 4) break;
      maskKey = rest.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (rest.length < cursor + length) break;
    const payload = Buffer.from(rest.subarray(cursor, cursor + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    }
    offset = cursor + length;
    if (opcode === 0x8) {
      messages.push({ op: 'close' });
    } else if (opcode === 0x1) {
      messages.push({ op: 'text', text: payload.toString('utf8') });
    } else if (opcode === 0x9) {
      messages.push({ op: 'ping' });
    }
  }
  return { messages, rest: rest.subarray(offset) };
}

class ControlServer {
  /**
   * @param {object} deps
   * @param {import('../preview-manager').PreviewManager} deps.manager
   * @param {import('../file-service').FileService} deps.files
   * @param {()=>void} deps.broadcast      GUI 渲染进程事件广播
   * @param {()=>void} deps.requestShutdown
   * @param {'gui'|'daemon'} deps.mode
   */
  constructor(deps) {
    this.manager = deps.manager;
    this.files = deps.files;
    this.broadcast = deps.broadcast || (() => {});
    this.requestShutdown = deps.requestShutdown || (() => {});
    this.mode = deps.mode;
    this.token = env('TOKEN') || crypto.randomBytes(16).toString('hex');
    this.port = null;
    this.server = null;
    this.socketServer = null;
    this.socketBound = false;
    this.wsClients = new Map(); // sessionId -> Set<socket>
  }

  endpoint() {
    return `http://127.0.0.1:${this.port}`;
  }

  reloadEnabled() {
    return true;
  }

  async start({ port } = {}) {
    const desired = Number(port || env('PORT') || 0);
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(desired, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;

    const bound = await bindSocket((message) => this.dispatch(message.action, message.params || {}), { reclaim: true, adopt: true });
    this.socketServer = bound.server;
    this.socketBound = bound.bound;
    this.socketNote = bound.error
      ? `socket 绑定失败：${bound.error.message}`
      : bound.reason === 'occupied'
        ? 'socket 被其他实例占用，本次仅提供 HTTP 控制入口'
        : null;

    fs.mkdirSync(runtimeDir(), { recursive: true });
    this.state = {
      pid: process.pid,
      port: this.port,
      socket: socketPath(),
      token: this.token,
      mode: this.mode,
      version: VERSION,
      startedAt: Date.now(),
      endpoint: this.endpoint(),
      runtimeDir: runtimeDir(),
      socketBound: this.socketBound,
      note: this.socketNote || undefined,
    };
    writeState(this.state);
    return this.state;
  }

  async stop() {
    for (const set of this.wsClients.values()) {
      for (const socket of set) {
        try {
          socket.end(encodeFrame(JSON.stringify({ kind: 'bye' })));
        } catch {
          /* ignore */
        }
      }
    }
    this.wsClients.clear();
    if (this.socketServer) {
      await new Promise((resolve) => this.socketServer.close(() => resolve()));
      this.socketServer = null;
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
  }

  // ---------- HTTP ----------

  async handleHttp(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port || 0}`);
    const route = url.pathname.replace(/^\/+/, '') || 'health';

    // 预览页面回传事件：靠 token 鉴权，不需要额外 header。
    // 预览页面的 origin 是 pvs://<rootId>，属于跨源，必须放行 CORS 与预检。
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
    };
    if (route === '__pvs/event' && req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (route === '__pvs/event' && req.method === 'POST') {
      if (!safeEqual(url.searchParams.get('token'), this.token)) {
        res.writeHead(403, cors).end('forbidden');
        return;
      }
      let body = '';
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const session = this.manager.sessions.get(payload.sessionId) || this.manager.sessions.get(url.searchParams.get('session'));
          if (session) session.handleAgentEvent(payload);
        } catch {
          /* 忽略坏包 */
        }
        res.writeHead(204, cors).end();
      });
      return;
    }

    const json = (status, obj) => {
      const text = JSON.stringify(obj);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };

    if (route === 'health') {
      json(200, {
        ok: true,
        pid: process.pid,
        mode: this.mode,
        version: VERSION,
        chrome: process.versions.chrome,
        platform: process.platform,
        uptimeMs: Math.round(process.uptime() * 1000),
        sessions: this.manager.sessions.size,
      });
      return;
    }

    const token = req.headers['x-pvs-token'] || url.searchParams.get('token');
    if (!safeEqual(token, this.token)) {
      json(401, { ok: false, error: 'unauthorized：缺少或错误的 X-PVS-Token' });
      return;
    }

    let params = {};
    if (req.method === 'GET') {
      params = Object.fromEntries(url.searchParams.entries());
    } else {
      const body = await new Promise((resolve, reject) => {
        let data = '';
        let size = 0;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            reject(new Error('body too large'));
            req.destroy();
            return;
          }
          data += chunk;
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      if (body) {
        try {
          params = JSON.parse(body);
        } catch (err) {
          json(400, { ok: false, error: `bad json body: ${err.message}` });
          return;
        }
      }
      // 兼容 content-type: text/plain 的裸 JS（eval 常用）
      if (typeof params === 'object' && params && params.__raw) params = { expression: params.__raw };
    }

    try {
      if (route === 'screenshot' && req.method === 'GET' && (params.format === 'png' || params.format === 'jpeg' || !params.format)) {
        const result = await this.dispatch('screenshot', { ...params, raw: true });
        res.writeHead(200, { 'content-type': `image/${result.format === 'jpeg' ? 'jpeg' : 'png'}`, 'content-length': result.bytes });
        res.end(result.buffer);
        return;
      }
      const result = await this.dispatch(route, params);
      // 去掉二进制字段，保持 JSON 可序列化
      const clean = result && typeof result === 'object'
        ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'buffer'))
        : result;
      json(200, { ok: true, result: clean });
    } catch (err) {
      json(err.code === 'ENOTALLOWED' ? 403 : 400, { ok: false, error: err.message || String(err), code: err.code });
    }
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port || 0}`);
    if (url.pathname !== '/__pvs/ws' || !safeEqual(url.searchParams.get('token'), this.token)) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const sessionId = url.searchParams.get('session') || '';
    const set = this.wsClients.get(sessionId) || new Set();
    set.add(socket);
    this.wsClients.set(sessionId, set);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const message of messages) {
        if (message.op === 'close') socket.end();
        if (message.op === 'ping') socket.write(Buffer.from([0x8a, 0x00]));
      }
    });
    const drop = () => {
      const current = this.wsClients.get(sessionId);
      if (current) {
        current.delete(socket);
        if (!current.size) this.wsClients.delete(sessionId);
      }
    };
    socket.on('error', drop);
    socket.on('close', drop);
  }

  /** 通知页面热重载 */
  notifyReload(sessionId) {
    const set = this.wsClients.get(sessionId);
    if (!set) return 0;
    const frame = encodeFrame(JSON.stringify({ kind: 'reload', ts: Date.now() }));
    let count = 0;
    for (const socket of set) {
      try {
        socket.write(frame);
        count += 1;
      } catch {
        /* ignore */
      }
    }
    return count;
  }

  // ---------- 动作分发 ----------

  async dispatch(action, params = {}) {
    const manager = this.manager;
    switch (action) {
      case 'ping':
        return { pong: true, pid: process.pid, mode: this.mode, version: VERSION, chrome: process.versions.chrome, port: this.port };

      case 'open': {
        // fresh：先关掉所有旧会话，只留这一次打开的面板（AI 一条命令一个面板，不堆标签）
        if (params.fresh) manager.closeAll();
        // target 是统一入口：调用方不必区分文件还是 URL；file/url 仍兼容
        if (params.target !== undefined && params.file === undefined && params.url === undefined) {
          const { kind, session } = await manager.openSmart({
            target: params.target,
            force: params.force === 'code' ? 'code' : params.force === 'web' ? 'web' : undefined,
            root: params.root,
            focus: params.focus !== false,
          });
          return {
            sessionId: session.id,
            kind,
            url: session.info().url,
            title: session.title,
            file: session.file,
            language: session.language || null,
            target: params.target,
          };
        }
        const session = await manager.open({
          file: params.file,
          url: params.url,
          root: params.root,
          focus: params.focus !== false,
          sessionId: params.sessionId || null,
        });
        return { sessionId: session.id, kind: session.kind, url: session.info().url, title: session.title, file: session.file };
      }

      case 'openCode': {
        if (params.fresh) manager.closeAll();
        const session = await manager.openCode({
          file: params.file,
          root: params.root,
          line: params.line,
          column: params.column,
          focus: params.focus !== false,
        });
        return { sessionId: session.id, kind: 'code', file: session.file, language: session.language };
      }

      case 'openPath': {
        if (params.fresh) manager.closeAll();
        const { kind, session } = await manager.openPath(params.path || params.file, { force: params.force, root: params.root });
        return { sessionId: session.id, kind, file: session.file, url: session.info().url, title: session.title };
      }

      case 'list':
        return { sessions: manager.list(), roots: this.files.listRoots() };

      case 'reload': {
        const session = await manager.reload(params.sessionId, Boolean(params.hard));
        return { sessionId: session.id, url: session.info().url };
      }

      case 'close':
        if (params.all) {
          manager.closeAll();
          return { closed: true, all: true };
        }
        return { closed: manager.close(params.sessionId) };

      case 'focus': {
        const session = manager.setFocus(params.sessionId);
        if (!session) throw new Error(`会话不存在：${params.sessionId}`);
        this.broadcast('ui:focus', { sessionId: session.id, view: session.kind === 'code' ? 'code' : 'web' });
        return { sessionId: session.id, kind: session.kind };
      }

      case 'zoom': {
        const session = manager.resolve(params.sessionId);
        if (typeof params.factor === 'number') return session.setZoom(params.factor);
        return { sessionId: session.id, factor: session.zoomFactor };
      }

      case 'screenshot': {
        const session = manager.resolve(params.sessionId);
        // 代码会话在 GUI 下优先「截面板」：包含标签条与行号栏，和用户看到的画面一致；
        // 无头模式没有面板，则退回 screenshot() 内部的代码页渲染。
        // 注意：面板模式下代码页面的原生视图是隐藏的（面板用 CodeMirror 显示），隐藏视图不产生帧。
        if (session.kind === 'code' && session.file && panelWindow(manager)) {
          const activated = await activateSession({ manager, session });
          const shot = await capturePanelShot({ manager, session, format: params.format, quality: params.quality });
          if (shot) {
            const result = {
              sessionId: session.id,
              format: shot.format,
              width: shot.width,
              height: shot.height,
              bytes: shot.bytes,
              dataBase64: shot.buffer.toString('base64'),
              buffer: shot.buffer,
              source: 'panel',
              activated,
            };
            if (params.out !== undefined && params.out !== null) {
              const out = params.out ? path.resolve(String(params.out)) : path.join(os.tmpdir(), `pvs-panel-${session.id}-${Date.now()}.png`);
              await fsp.mkdir(path.dirname(out), { recursive: true });
              await fsp.writeFile(out, shot.buffer);
              result.filePath = out;
            }
            return result;
          }
        }
        const urlBefore = session.url;
        const shot = await session.screenshot({
          format: params.format || 'png',
          quality: params.quality,
          fullPage: Boolean(params.fullPage ?? params.full_page),
          selector: params.selector,
        });
        // 代码会话回退到代码页截图后，恢复到原本的会话标识，界面不应显示成 pvs://code/
        if (session.kind === 'code' && urlBefore) session.url = urlBefore;
        const result = {
          sessionId: shot.sessionId,
          format: shot.format,
          width: shot.width,
          height: shot.height,
          bytes: shot.bytes,
          // 这里没有面板可截：代码会话是 pvs://code/ 代码页渲染，网页会话是离屏/原生视图
          source: session.kind === 'code' ? 'code-page' : 'render',
        };
        if (params.raw) return { ...result, buffer: shot.buffer };
        if (params.out !== undefined || params.out === null) {
          const out = params.out ? path.resolve(String(params.out)) : path.join(os.tmpdir(), `pvs-${session.id}-${Date.now()}.${shot.format}`);
          await fsp.mkdir(path.dirname(out), { recursive: true });
          await fsp.writeFile(out, shot.buffer);
          result.filePath = out;
        }
        if (params.data !== false) result.dataBase64 = shot.dataBase64;
        result.buffer = shot.buffer;
        return result;
      }

      case 'content': {
        const session = manager.resolve(params.sessionId, { requireWeb: true });
        if (session.kind === 'code') throw Object.assign(new Error('代码会话没有网页图层；请改用网页会话'), { code: 'NOSESSION' });
        const content = await session.getContent({
          selector: params.selector,
          format: params.format === 'html' ? 'html' : 'text',
          maxLength: Number(params.maxLength) || 200000,
        });
        return content;
      }

      case 'eval': {
        const session = manager.resolve(params.sessionId);
        if (session.kind === 'code') {
          const err = new Error('代码会话没有网页图层，无法执行 JS；请改用网页会话（open 一个 HTML 或 URL）');
          err.code = 'NOSESSION';
          throw err;
        }
        if (!params.expression) throw new Error('eval 需要 expression 参数');
        const result = await session.evaluate(params.expression);
        return { sessionId: session.id, value: result.value, type: result.type };
      }

      case 'console': {
        const session = manager.resolve(params.sessionId);
        return session.console({ clear: Boolean(params.clear), since: params.since ? Number(params.since) : undefined });
      }

      case 'network': {
        const session = manager.resolve(params.sessionId, { requireWeb: true });
        const enabled = typeof params.enabled === 'boolean' ? params.enabled : (params.on ? true : params.off ? false : undefined);
        return session.network({ enabled, clear: Boolean(params.clear) });
      }

      case 'navigate': {
        const session = manager.resolve(params.sessionId, { requireWeb: true });
        if (params.url) await session.load({ url: params.url });
        else if (params.file) await session.load({ file: params.file });
        else if (params.back) await session.goBack();
        else if (params.forward) await session.goForward();
        return { sessionId: session.id, url: session.info().url };
      }

      case 'save': {
        if (!params.file) throw new Error('save 需要 file 参数');
        const written = await this.files.write(params.file, params.content);
        this.broadcast('files:changed', { root: path.dirname(written.path) });
        return written;
      }

      case 'roots': {
        if (params.root) {
          const added = this.files.addRoot(params.root);
          this.broadcast('roots:updated', { roots: this.files.listRoots() });
          return { roots: this.files.listRoots(), added };
        }
        return { roots: this.files.listRoots() };
      }

      case 'read': {
        if (!params.file) throw new Error('read 需要 file 参数');
        const file = await this.files.read(params.file);
        return { ...file, text: params.full ? file.text : file.text.slice(0, Number(params.maxLength) || 60000) };
      }

      case 'tree': {
        const dir = params.dir || this.files.listRoots()[0]?.dir;
        if (!dir) throw new Error('没有已打开的项目目录');
        return { dir, entries: await this.files.tree(dir, { includeIgnored: Boolean(params.includeIgnored) }) };
      }

      case 'ui': {
        const view = params.view === 'code' ? 'code' : params.view === 'console' ? 'console' : 'web';
        this.broadcast('ui:view', { view, sessionId: params.sessionId });
        return { view, sessionId: params.sessionId || manager.focused()?.id || null };
      }

      case 'logs':
        return { mode: this.mode, pid: process.pid, port: this.port, socket: socketPath(), token: this.token, runtimeDir: runtimeDir() };

      // 热重载覆盖情况：面板里当前盯着哪些文件、类型覆盖多少（验收与自查用）
      case 'debugWatch': {
        const session = manager.resolve(params.sessionId);
        return { mode: this.mode, ...session.watchInfo() };
      }

      case 'panelRead': {
        const win = this.manager.guiWindow;
        if (!win || win.isDestroyed()) throw new Error('当前不是 GUI 模式');
        const target = JSON.stringify(String(params.path || ''));
        const raw = await Promise.race([
          win.webContents.executeJavaScript('(async () => JSON.stringify(await window.__PVS_READ__(' + target + ')))()', true),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('panelRead 超时')), 10000)),
        ]);
        return { result: raw ? JSON.parse(raw) : null };
      }

      case 'panelEditor': {
        const win = this.manager.guiWindow;
        if (!win || win.isDestroyed()) throw new Error('当前不是 GUI 模式');
        const raw = await Promise.race([
          win.webContents.executeJavaScript('JSON.stringify(window.__PVS_EDITOR__ ? window.__PVS_EDITOR__() : { missing: true })', true),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('panelEditor 超时')), 8000)),
        ]);
        return { editor: raw ? JSON.parse(raw) : null };
      }

      // 批量：串行打开清单里的每项并截图（设计见 docs/BATCH.md）
      case 'batch': {
        const { runBatch } = require('../batch');
        const items = Array.isArray(params.items) ? params.items : [];
        if (!items.length) throw new Error('batch 需要 items 数组');
        const outDir = params.outDir || 'aibrowser-shots';
        const report = await runBatch({
          items,
          outDir,
          fullPage: params.fullPage !== false,
          format: params.format === 'jpeg' ? 'jpeg' : 'png',
          timeout: Number(params.timeout) || undefined,
          manager: this.manager,
        });
        // 结果清单落盘，便于 AI 后续读取或续跑
        try {
          const fsp = require('node:fs/promises');
          const path = require('node:path');
          await fsp.writeFile(path.join(report.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
          await fsp.writeFile(
            path.join(report.outDir, 'report.jsonl'),
            `${report.items.map((i) => JSON.stringify(i)).join('\n')}\n`,
            'utf8',
          );
          report.reportPath = path.join(report.outDir, 'report.json');
        } catch (err) {
          this.manager.deps.broadcast('log', { level: 'warn', text: `写报告失败：${err.message}` });
        }
        return report;
      }

      // 面板交互动作：等价于「点按钮」（新建标签、切视图、开关侧栏……），供验收与 AI 驱动
      case 'panelAction': {
        const win = this.manager.guiWindow;
        if (!win || win.isDestroyed()) throw new Error('当前不是 GUI 模式');
        if (!params.action) throw new Error('panelAction 需要 action 参数');
        const source = JSON.stringify(String(params.action));
        const payload = JSON.stringify(params.payload || {});
        // 动作可能返回 Promise（例如读取剪贴板），这里统一 await 后再序列化
        const code = '(async () => {'
          + ' try { const r = await window.__PVS_ACTION__(' + source + ', ' + payload + ');'
          + ' return JSON.stringify(r === undefined ? {} : r); }'
          + ' catch (e) { return JSON.stringify({ error: String(e && e.message ? e.message : e) }); }'
          + ' })()';
        const raw = await Promise.race([
          win.webContents.executeJavaScript(code, true),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('panelAction 超时')), 10000)),
        ]);
        return { result: raw ? JSON.parse(raw) : null };
      }

      // 面板状态快照：调用渲染层导出的 window.__PVS_PANEL__（GUI 模式）
      case 'panelState': {
        const win = this.manager.guiWindow;
        if (!win || win.isDestroyed()) throw new Error('当前不是 GUI 模式，没有面板渲染进程');
        const raw = await Promise.race([
          win.webContents.executeJavaScript('window.__PVS_PANEL__ ? JSON.stringify(window.__PVS_PANEL__()) : JSON.stringify({ __missing: true })', true),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('panelState 超时')), 8000)),
        ]);
        const state = raw ? JSON.parse(raw) : null;
        if (state) state.statusText = await win.webContents.executeJavaScript('document.getElementById("status-text").textContent', true).catch(() => null);
        return { state };
      }

      // 面板级自检：直接在 GUI 渲染进程里执行 JS（与预览页面无关，仅 GUI 模式可用）
      case 'panelEval': {
        const win = this.manager.guiWindow;
        if (!win || win.isDestroyed()) throw new Error('当前不是 GUI 模式，没有面板渲染进程');
        if (!params.expression) throw new Error('panelEval 需要 expression 参数');
        const source = JSON.stringify(String(params.expression));
        const code = '(() => { try { return JSON.stringify(eval(' + source + ')); } '
          + 'catch (e) { return JSON.stringify({ __error: String(e) }); } })()';
        const value = await Promise.race([
          win.webContents.executeJavaScript(code, true),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('panelEval 超时：面板渲染进程无响应')), 10000)),
        ]);
        return { value };
      }

      // 调试自检：确认「渲染层报告的槽位」与「原生视图实际位置」一致
      case 'debugLayout': {
        const manager = this.manager;
        const win = manager.guiWindow;
        const bounds = manager.viewBounds;
        let slot = null;
        let windowSize = null;
        if (win && !win.isDestroyed()) {
          const size = win.getContentSize();
          windowSize = { width: size[0], height: size[1] };
          try {
            slot = await win.webContents.executeJavaScript(
              '(() => { const r = document.getElementById("web-slot").getBoundingClientRect();'
              + ' return { left: r.left, top: r.top, width: r.width, height: r.height,'
              + ' view: document.body.dataset.view,'
              + ' activeTab: (document.querySelector("#tabs .tab.active .tab-title") || {}).textContent || null,'
              + ' codeLang: (document.getElementById("code-lang") || {}).textContent || null,'
              + ' codeChars: (document.querySelector(".cm-content") || {}).textContent ? document.querySelector(".cm-content").textContent.length : 0,'
              + ' tabs: document.querySelectorAll("#tabs .tab").length,'
              + ' treeNodes: document.querySelectorAll("#tree .node").length }; })()',
              true,
            );
          } catch (err) {
            slot = { error: err.message };
          }
        }
        const active = manager.focused();
        let viewBounds = null;
        if (active && active.view) {
          try {
            viewBounds = active.view.getBounds();
          } catch {
            viewBounds = null;
          }
        }
        let panelShot = null;
        if (win && !win.isDestroyed() && params.screenshot) {
          try {
            const image = await win.webContents.capturePage();
            const data = image.toPNG();
            const out = params.out ? path.resolve(String(params.out)) : path.join(os.tmpdir(), `pvs-panel-${Date.now()}.png`);
            await fsp.writeFile(out, data);
            const size = image.getSize();
            panelShot = { filePath: out, width: size.width, height: size.height, bytes: data.length, dataBase64: data.toString('base64') };
          } catch (err) {
            panelShot = { error: err.message };
          }
        }
        let windowState = null;
        if (win && !win.isDestroyed()) {
          try {
            windowState = {
              visible: win.isVisible(),
              minimized: win.isMinimized(),
              focused: win.isFocused(),
              bounds: win.getBounds(),
              contentSize: win.getContentSize(),
            };
          } catch (err) {
            windowState = { error: err.message };
          }
        }
        return {
          mode: this.mode,
          windowState,
          windowSize,
          slot,
          reportedBounds: bounds,
          activeSessionId: active?.id ?? null,
          activeViewBounds: viewBounds,
          panelShot,
        };
      }

      case 'shutdown': {
        setTimeout(() => this.requestShutdown(), 60);
        return { shutdown: true, pid: process.pid };
      }

      default: {
        const err = new Error(`未知动作：${action}`);
        err.code = 'EUNKNOWN';
        throw err;
      }
    }
  }
}

module.exports = { ControlServer, encodeFrame, decodeFrames };
