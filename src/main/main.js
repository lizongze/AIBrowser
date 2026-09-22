'use strict';
// Electron 主入口：统一处理「GUI 面板」与「无头服务」两种模式。
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen } = require('electron');
const { detectScaleFactor, wslgRecommendedScale } = require('./display-scale');
const config = require('./config');

// ---- WSL / 容器兼容：必须在 app ready 之前 ----
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// 高分辨率屏上的「发虚」多半不是渲染问题，而是渲染缩放太小（DPR=1）。
// 允许用 --scale-factor 抬高整体渲染缩放，文字会更大更实。
const explicitScale = (() => {
  const idx = process.argv.findIndex((arg) => arg === '--scale-factor');
  if (idx !== -1 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  const inline = process.argv.find((arg) => arg.startsWith('--scale-factor='));
  if (inline) return Number(inline.split('=')[1]);
  if (process.env.AIBROWSER_SCALE) return Number(process.env.AIBROWSER_SCALE);
  return null;
})();
const scaleInfo = detectScaleFactor(explicitScale);
// --win：明确告知「在 Windows 原生运行」。
// 原生下 Electron 会自己读系统缩放（如 150%），再叠加 force-device-scale-factor 会放大成 2.25 倍。
// 注意：这里必须直接看原始 argv —— 命令行解析（flags）发生在这段代码之后，用 flags 会踩 TDZ。
const rawArgv = process.argv.slice(1);
const nativeWindows = rawArgv.includes('--win')
  || (process.platform === 'win32' && !process.env.WSL_DISTRO_NAME);
const wslgScale = (scaleInfo.scale || nativeWindows) ? null : wslgRecommendedScale();
if (scaleInfo.scale) {
  // 显式指定（--scale-factor / AIBROWSER_SCALE）永远优先
  app.commandLine.appendSwitch('force-device-scale-factor', String(scaleInfo.scale));
  process.stderr.write(`[aibrowser] 渲染缩放 ${scaleInfo.scale}x（来源：${scaleInfo.source}${scaleInfo.detail ? ' · ' + scaleInfo.detail : ''}）\n`);
} else if (wslgScale) {
  // WSLg 把 devicePixelRatio 报成 2.25（实测），远大于 Windows 桌面的实际缩放，
  // 于是面板文字显得又小又虚。这里默认纠正到 1.25x（可用 --scale-factor 覆盖，
  // 或设 AIBROWSER_WSLG_SCALE=0 关掉）。
  app.commandLine.appendSwitch('force-device-scale-factor', String(wslgScale));
  process.stderr.write(`[aibrowser] 渲染缩放 ${wslgScale}x（WSLg 默认纠正，--scale-factor 可覆盖）\n`);
} else {
  process.stderr.write(
    `[aibrowser] 渲染缩放：系统默认${scaleInfo.detail ? `（探测参考 ${scaleInfo.detail}）` : ''}`
    + '；觉得字小可用 --scale-factor 1.25/1.5\n',
  );
}
// ---- 字体渲染质量 ----
// 实测：默认情况下本机 92% 的文字边缘像素带彩色（R/G/B 通道差均值 41），
// 这是 LCD 亚像素抗锯齿（ClearType 风格）造成的彩边，看起来就是重影、发虚。
// Chrome 浏览器默认用灰度抗锯齿，这里对齐它的行为。
app.commandLine.appendSwitch('disable-lcd-text');
// 让 Chromium 自己决定字形微调，避免系统 hinting 把笔画改得发灰
if (!app.commandLine.hasSwitch('font-render-hinting')) {
  app.commandLine.appendSwitch('font-render-hinting', 'medium');
}
if (!app.commandLine.hasSwitch('no-sandbox')) app.commandLine.appendSwitch('no-sandbox');
if (!app.commandLine.hasSwitch('disable-gpu')) app.commandLine.appendSwitch('disable-gpu');
if (!app.commandLine.hasSwitch('disable-dev-shm-usage')) app.commandLine.appendSwitch('disable-dev-shm-usage');

const { FileService } = require('./file-service');
const { PreviewManager } = require('./preview-manager');
const { ControlServer } = require('./control/server');
const { registerScheme, registerHandler } = require('./preview-protocol');
const { parseArgs, stripElectronArgv } = require('./cli/args');
const { runSmokeTest } = require('./smoke');

registerScheme();

const cli = parseArgs(stripElectronArgv(process.argv));
const flags = cli.flags;
const isHeadless = Boolean(flags.headless) || process.env.AIBROWSER_HEADLESS === '1';
const smokeTest = Boolean(flags['smoke-test']);

const files = new FileService();
const state = {
  window: null,
  rendererReady: false,
  manager: null,
  server: null,
  mode: isHeadless ? 'daemon' : 'gui',
  quitting: false,
  ready: false,
};

function broadcast(channel, payload) {
  const win = state.window;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('pvs:event', { channel, payload });
  } catch {
    /* ignore */
  }
}

function createManager() {
  state.manager = new PreviewManager({
    files,
    endpoint: () => (state.server ? state.server.endpoint() : 'http://127.0.0.1:0'),
    token: () => (state.server ? state.server.token : ''),
    reloadEnabled: () => true,
    broadcast,
  });
  return state.manager;
}

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1440, Math.max(1024, Math.round(screenWidth * 0.8))),
    height: Math.min(920, Math.max(640, Math.round(screenHeight * 0.8))),
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#ffffff', // 默认白天模式
    title: 'AIBrowser',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  state.window = win;
  state.manager.setGuiWindow(win);

  const distIndex = path.join(__dirname, '..', '..', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <body style="background:#0d1117;color:#c9d1d9;font:14px ui-monospace,monospace;padding:40px">
      <h2 style="color:#f85149">渲染层未构建</h2>
      <p>请先执行：<code style="background:#161b22;padding:2px 6px;border-radius:4px">npm run build</code></p>
      <p style="color:#8b949e">然后重新启动 AIBrowser。</p></body>`));
    return win;
  }
  // 恢复上次的界面缩放
  const savedScale = config.read().uiScale;
  if (savedScale && Math.abs(savedScale - 1) > 0.001) {
    win.webContents.once('did-finish-load', () => {
      try {
        win.webContents.setZoomFactor(savedScale);
      } catch {
        /* ignore */
      }
    });
  }
  win.loadFile(distIndex);

  win.once('ready-to-show', () => {
    // 默认最大化全屏铺满可用区域（面板类工具的常态用法）；--no-maximize 可保持窗口大小
    if (!flags['no-maximize']) win.maximize();
    process.stderr.write(`[aibrowser] 窗口内容尺寸 ${win.getContentSize().join('×')} · 渲染缩放 ${scaleInfo.scale || '系统默认'}
`);
    win.show();
    state.ready = true;
  });

  win.webContents.on('did-finish-load', () => {
    state.rendererReady = false;
  });

  win.on('closed', () => {
    state.window = null;
    state.manager.clearView();
  });

  win.on('resize', () => {
    if (state.manager) broadcast('ui:relayout', {});
  });

  return win;
}

// ---------- IPC（GUI 渲染进程 ↔ 主进程） ----------

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(`pvs:${channel}`, async (_event, payload) => fn(payload || {}));
  const manager = () => state.manager;

  handle('ui:ready', async () => {
    process.stderr.write('[aibrowser] 渲染层就绪，补发排队请求 ' + state.pendingRequests.length + ' 条\n');
    // 面板就绪：处理此前排队的控制请求
    state.rendererReady = true;
    const pending = state.pendingRequests.splice(0, state.pendingRequests.length);
    for (const entry of pending) {
      broadcast('ui:open', entry);
    }
    return { ready: true, pending: pending.length };
  });

  handle('runtime', () => ({
    mode: state.mode,
    version: require('../../package.json').version,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    port: state.server?.port ?? null,
    socket: state.server?.state?.socket ?? null,
    token: state.server?.token ?? null,
    runtimeDir: state.server?.state?.runtimeDir ?? null,
    cwd: process.cwd(),
  }));

  // 文件
  handle('files:roots', () => ({ roots: files.listRoots() }));
  handle('files:openFolder', async (payload) => {
    const win = state.window;
    const result = await dialog.showOpenDialog(win, {
      title: '选择项目目录',
      defaultPath: payload.defaultPath || process.cwd(),
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const added = files.addRoot(result.filePaths[0]);
    broadcast('roots:updated', { roots: files.listRoots() });
    broadcast('files:changed', { root: added.root });
    return added;
  });
  handle('files:setRoot', (payload) => {
    if (!payload.dir) throw new Error('缺少 dir');
    const added = files.addRoot(payload.dir);
    broadcast('roots:updated', { roots: files.listRoots() });
    return added;
  });
  handle('files:tree', async (payload) => {
    const dir = payload.dir || files.listRoots()[0]?.dir;
    if (!dir) return { dir: null, entries: [] };
    return { dir, entries: await files.tree(dir) };
  });
  handle('files:read', (payload) => files.read(payload.path));
  handle('files:write', async (payload) => {
    const written = await files.write(payload.path, payload.text);
    broadcast('files:changed', { root: path.dirname(written.path) });
    return written;
  });
  handle('files:stat', (payload) => files.stat(payload.path));

  // 会话
  handle('sessions:open', async (payload) => {
    const session = await manager().open({ file: payload.file, url: payload.url, focus: payload.focus !== false });
    return { sessionId: session.id, url: session.info().url, title: session.title, kind: session.kind };
  });
  handle('sessions:openCode', async (payload) => {
    const session = await manager().openCode({ file: payload.file, line: payload.line, column: payload.column });
    return { sessionId: session.id, language: session.language, languageLabel: session.languageLabel, file: session.file };
  });
  handle('sessions:list', () => ({ sessions: manager().list(), roots: files.listRoots() }));
  handle('sessions:close', (payload) => ({ closed: manager().close(payload.sessionId) }));
  handle('sessions:focus', (payload) => {
    const session = manager().setFocus(payload.sessionId);
    return { sessionId: session?.id ?? null, kind: session?.kind ?? null };
  });
  handle('sessions:reload', async (payload) => {
    const session = manager().resolve(payload.sessionId);
    if (session.kind === 'code') return { sessionId: session.id, code: true };
    await session.reload(Boolean(payload.hard));
    return { sessionId: session.id, url: session.info().url };
  });
  handle('sessions:navigate', async (payload) => {
    const session = manager().resolve(payload.sessionId, { requireWeb: true });
    if (payload.url || payload.file) await session.load({ url: payload.url, file: payload.file });
    return { sessionId: session.id, url: session.info().url };
  });
  handle('sessions:back', async (payload) => ({ moved: await manager().resolve(payload.sessionId).goBack() }));
  handle('sessions:forward', async (payload) => ({ moved: await manager().resolve(payload.sessionId).goForward() }));
  handle('sessions:zoom', (payload) => manager().resolve(payload.sessionId).setZoom(payload.factor));
  handle('sessions:screenshot', async (payload) => {
    const session = manager().resolve(payload.sessionId, { requireWeb: true });
    const shot = await session.screenshot({ format: payload.format || 'png', fullPage: Boolean(payload.fullPage) });
    const out = path.join(app.getPath('temp'), `pvs-gui-${session.id}-${Date.now()}.${shot.format}`);
    await fs.promises.writeFile(out, shot.buffer);
    return { sessionId: shot.sessionId, filePath: out, width: shot.width, height: shot.height, bytes: shot.bytes, format: shot.format, dataBase64: shot.dataBase64 };
  });
  handle('sessions:console', (payload) => manager().resolve(payload.sessionId).console({ clear: Boolean(payload.clear) }));
  handle('sessions:network', (payload) => manager().resolve(payload.sessionId, { requireWeb: true }).network({ enabled: payload.enabled, clear: Boolean(payload.clear) }));
  handle('sessions:eval', async (payload) => {
    const session = manager().resolve(payload.sessionId);
    const result = await session.evaluate(payload.expression);
    return { value: result.value, type: result.type };
  });

  // UI
  // 界面缩放：Ctrl+滚轮 / 菜单 / Ctrl+0 重置。webContents 自带 zoom 因子，
  // 与页面预览的缩放（session.setZoom）互不影响。
  // 热重载开关（标题栏 ⟳ 按钮 / 菜单）
  handle('ui:hotReload', (payload) => {
    const enabled = typeof payload.enabled === 'boolean'
      ? payload.enabled
      : !state.manager.hotReload;
    state.manager.setHotReload(enabled);
    config.write({ hotReload: enabled });
    process.stderr.write(`[aibrowser] 热重载 ${enabled ? '已开启（轮询本地文件变化）' : '已关闭'}\n`);
    return { enabled };
  });

  handle('ui:zoom', (payload) => {
    const win = state.window;
    if (!win || win.isDestroyed()) return { factor: 1 };
    const current = win.webContents.getZoomFactor();
    const next = typeof payload.factor === 'number'
      ? Math.min(Math.max(payload.factor, 0.6), 3)
      : Math.min(Math.max(current + (payload.delta || 0), 0.6), 3);
    win.webContents.setZoomFactor(next);
    const saved = config.write({ uiScale: next });
    process.stderr.write(`[aibrowser] 界面缩放 ${Math.round(next * 100)}%\n`);
    return { factor: next, saved: saved.uiScale };
  });

  handle('ui:contentOnly', (payload) => {
    const enabled = payload.enabled !== false;
    config.write({ contentOnly: enabled });
    return { enabled };
  });

  handle('ui:sidebar', (payload) => {
    const visible = payload.visible !== false;
    config.write({ sidebar: visible });
    broadcast('ui:sidebar', { visible });
    return { visible };
  });

  handle('ui:layout', (payload) => {
    if (state.manager) {
      state.manager.updateViewBounds({
        x: Number(payload.viewLeft) || 0,
        y: Number(payload.viewTop) || 0,
        width: Number(payload.viewWidth) || 0,
        height: Number(payload.viewHeight) || 0,
      });
    }
    return { ok: true };
  });
  handle('ui:activeView', (payload) => {
    if (state.manager) state.manager.setActiveView(payload.sessionId || null);
    return { ok: true };
  });
  handle('ui:openExternal', async (payload) => {
    if (!payload.url) throw new Error('缺少 url');
    await shell.openExternal(String(payload.url));
    return { ok: true };
  });
  handle('ui:setView', (payload) => {
    const view = payload.view;
    broadcast('ui:view', { view, sessionId: payload.sessionId });
    return { view };
  });
  handle('ui:setTheme', (payload) => {
    const win = state.window;
    const theme = payload.theme === 'light' ? 'light' : 'dark';
    if (win && !win.isDestroyed()) win.setBackgroundColor(theme === 'light' ? '#ffffff' : '#0d1117');
    return { theme };
  });
  handle('ui:info', () => ({
    zoomFactor: state.window && !state.window.isDestroyed() ? state.window.webContents.getZoomFactor() : 1,
    hotReload: state.manager ? state.manager.hotReload : false,
    contentOnly: config.read().contentOnly !== false,
    sidebar: config.read().sidebar === true,
    shortcut: {
      openFolder: 'Ctrl/Cmd+O',
      reload: 'Ctrl/Cmd+R',
      hardReload: 'Ctrl/Cmd+Shift+R',
      console: 'Ctrl/Cmd+J',
      find: 'Ctrl/Cmd+F',
      devtools: 'Ctrl/Cmd+Alt+I',
    },
  }));
}

// ---------- 菜单（面板式工具的快捷键） ----------

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开文件夹…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            broadcast('ui:command', { command: 'open-folder' });
          },
        },
        { label: '新建预览标签', accelerator: 'CmdOrCtrl+T', click: () => broadcast('ui:command', { command: 'new-tab' }) },
        { type: 'separator' },
        { label: '关闭标签', accelerator: 'CmdOrCtrl+W', click: () => broadcast('ui:command', { command: 'close-tab' }) },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '显示/隐藏文件树', accelerator: 'CmdOrCtrl+B', click: () => broadcast('ui:command', { command: 'toggle-sidebar' }) },
        { type: 'separator' },
        { label: '控制台', accelerator: 'CmdOrCtrl+J', click: () => broadcast('ui:command', { command: 'toggle-console' }) },
        { label: '热重载（文件变化自动刷新）', accelerator: 'CmdOrCtrl+Shift+H', click: () => broadcast('ui:command', { command: 'toggle-hot-reload' }) },
        { label: '全屏预览（只留标签页）', accelerator: 'CmdOrCtrl+Shift+M', click: () => broadcast('ui:command', { command: 'toggle-content-only' }) },
        { type: 'separator' },
        { label: '界面放大', accelerator: 'CmdOrCtrl+Shift+Plus', click: () => broadcast('ui:command', { command: 'ui-zoom-in' }) },
        { label: '界面缩小', accelerator: 'CmdOrCtrl+Shift+-', click: () => broadcast('ui:command', { command: 'ui-zoom-out' }) },
        { label: '界面缩放重置', accelerator: 'CmdOrCtrl+Shift+0', click: () => broadcast('ui:command', { command: 'ui-zoom-reset' }) },
        { type: 'separator' },
        { label: '刷新预览', accelerator: 'CmdOrCtrl+R', click: () => broadcast('ui:command', { command: 'reload' }) },
        { label: '强制刷新', accelerator: 'CmdOrCtrl+Shift+R', click: () => broadcast('ui:command', { command: 'hard-reload' }) },
        { type: 'separator' },
        { label: '缩放 +', accelerator: 'CmdOrCtrl+Plus', click: () => broadcast('ui:command', { command: 'zoom-in' }) },
        { label: '缩放 -', accelerator: 'CmdOrCtrl+-', click: () => broadcast('ui:command', { command: 'zoom-out' }) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => broadcast('ui:command', { command: 'zoom-reset' }) },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具（面板）' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '文档 / 快捷键', click: () => shell.openPath(path.join(__dirname, '..', '..', 'README.md')) },
        { label: '控制通道信息', click: () => broadcast('ui:command', { command: 'show-control-info' }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 启动 ----------

async function bootstrap() {
  const initialRoot = flags.root ? path.resolve(String(flags.root)) : null;
  if (initialRoot && fs.existsSync(initialRoot)) files.addRoot(initialRoot);
  if (!files.listRoots().length && flags.cwd !== false) {
    // 默认把「当前工作目录」作为根目录，方便直接浏览
    const cwd = process.env.AIBROWSER_CWD || process.cwd();
    if (fs.existsSync(cwd)) files.addRoot(cwd);
  }

  createManager();
  // 无头模式使用离屏渲染：窗口隐藏且不进任务栏，桌面上不会闪现
  if (isHeadless) state.manager.setHost('offscreen');

  // 全屏预览与文件树：命令行参数优先于持久化配置（默认：全屏开、文件树关）
  {
    const cfg = config.read();
    const fullscreen = flags['no-fullscreen'] === true ? false
      : flags.fullscreen === true ? true
        : cfg.contentOnly !== false;
    const showSidebar = flags['show-sidebar'] === true ? true
      : flags['hide-sidebar'] === true ? false
        : cfg.sidebar === true;
    config.write({ contentOnly: fullscreen, sidebar: showSidebar });
  }

  // 热重载：命令行 --hot-reload / --no-hot-reload 优先，否则用持久化配置（默认关闭）
  const configHotReload = flags['hot-reload'] === true ? true
    : flags['no-hot-reload'] === false ? false
      : flags['no-hot-reload'] === true ? false
        : config.read().hotReload === true;
  state.manager.setHotReload(configHotReload);
  config.write({ hotReload: configHotReload });

  state.pendingRequests = [];
  state.server = new ControlServer({
    manager: state.manager,
    files,
    mode: state.mode,
    broadcast: (channel, payload) => {
      // 面板还没就绪时，把「打开会话」类事件排队，就绪后补发，避免界面漏渲染
      if (channel === 'ui:open' && !state.rendererReady && state.window && !state.window.isDestroyed()) {
        state.pendingRequests.push(payload);
        process.stderr.write('[aibrowser] ui:open 排队（面板未就绪）\n');
        return;
      }
      broadcast(channel, payload);
    },
    requestShutdown: () => gracefulQuit(),
  });
  await state.server.start({ port: flags.port ? Number(flags.port) : undefined });

  registerHandler({
    files,
    endpoint: () => state.server.endpoint(),
    token: () => state.server.token,
    reloadEnabled: () => true,
  });

  if (!isHeadless) {
    registerIpc();
    buildMenu();
    createWindow();
  }

  // 守护进程把连接信息打到 stderr，便于脚本读取
  process.stderr.write(`[aibrowser] ${state.mode} · pid ${process.pid} · http://127.0.0.1:${state.server.port} · socket ${state.server.state.socket}\n`);

  if (smokeTest) {
    const code = await runSmokeTest({ manager: state.manager, files, server: state.server, app });
    app.exit(code);
    return;
  }

  // CLI 直接带目标启动：pvs open … 的等价形式（electron . file.html / --url）
  const targets = cli._.filter((arg) => !arg.startsWith('-'));
  const urlFlag = flags.url;
  if (urlFlag) {
    await state.manager.open({ url: String(urlFlag), focus: true }).catch((err) => {
      process.stderr.write(`[aibrowser] 打开 URL 失败：${err.message}\n`);
    });
  }
  for (const target of targets) {
    const abs = path.resolve(String(target));
    if (!fs.existsSync(abs)) continue;
    try {
      if (flags.mode === 'code') await state.manager.openCode({ file: abs });
      else await state.manager.openPath(abs);
    } catch (err) {
      process.stderr.write(`[aibrowser] 打开 ${abs} 失败：${err.message}\n`);
    }
  }
}

async function gracefulQuit() {
  if (state.quitting) return;
  state.quitting = true;
  try {
    // 顺序很重要：先摘掉原生视图、销毁会话，再停服务，最后退出。
    // 反过来（视图还在场景里就退出）会让 Electron 在 teardown 阶段段错误。
    state.manager?.clearView();
    state.manager?.closeAll();
    await state.server?.stop();
  } catch {
    /* 尽力而为 */
  }
  try {
    const { clearState } = require('./control/state');
    clearState(process.pid);
  } catch {
    /* ignore */
  }
  if (state.window && !state.window.isDestroyed()) {
    try {
      state.window.destroy();
    } catch {
      /* ignore */
    }
  }
  app.exit(0);
}

app.on('before-quit', () => {
  if (!state.quitting) {
    state.quitting = true;
    try {
      state.server?.stop();
      require('./control/state').clearState(process.pid);
    } catch {
      /* ignore */
    }
  }
});

app.on('window-all-closed', () => {
  if (isHeadless) return;
  gracefulQuit();
});

app.on('activate', () => {
  if (!state.window && !isHeadless) createWindow();
});

process.on('SIGTERM', () => gracefulQuit());
process.on('SIGINT', () => gracefulQuit());

app.whenReady().then(bootstrap).catch((err) => {
  process.stderr.write(`[aibrowser] 启动失败：${err && err.stack ? err.stack : err}\n`);
  app.exit(1);
});
