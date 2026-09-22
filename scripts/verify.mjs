#!/usr/bin/env node
// 端到端验收：启动 GUI → 打开代码/网页/控制台 → 校验渲染结果 → 关闭。
// 用法：node scripts/verify.mjs   （需要先 npm run build）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 运行时目录：与 src/main/control/state.js 的规则保持一致（Windows 上没有 XDG_RUNTIME_DIR）
const runtimeDir = process.env.AIBROWSER_RUNTIME || process.env.PREVIEW_STUDIO_RUNTIME
  ? path.resolve(process.env.AIBROWSER_RUNTIME || process.env.PREVIEW_STUDIO_RUNTIME)
  : process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, 'aibrowser')
    : path.join(os.homedir(), '.aibrowser');
const statePath = path.join(runtimeDir, 'state.json');

const results = [];
const check = (ok, label, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

async function api(action, params = {}) {
  const state = readState();
  if (!state) throw new Error('控制入口未就绪');
  const response = await fetch(`http://127.0.0.1:${state.port}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pvs-token': state.token },
    body: JSON.stringify(params),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error);
  // 自动化连续操作比人手快得多，会给界面叠加一串瞬态（表现为连续闪烁）。
  // 每个动作后留一点时间让界面收敛，也让验收结果稳定。
  await sleep(120);
  return payload.result;
}

async function waitReady(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = readState();
    if (state?.mode === 'gui') {
      try {
        const response = await fetch(`http://127.0.0.1:${state.port}/health`);
        if (response.ok) return state;
      } catch { /* 还没起来 */ }
    }
    await sleep(300);
  }
  throw new Error('GUI 启动超时');
}

/** 轮询等待条件成立（界面是异步的，固定 sleep 容易抖动） */
async function waitFor(check, { timeoutMs = 8000, intervalMs = 300, label = '条件' } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await check();
    if (last && last.ok) return last;
    await sleep(intervalMs);
  }
  return last || { ok: false, detail: `${label} 超时` };
}

async function main() {
  console.log('AIBrowser 端到端验收\n');
  try { fs.writeFileSync(path.join(os.tmpdir(), 'pvs-verify-gui.log'), ''); } catch { /* ignore */ }
  spawnSync(process.execPath, [path.join(root, 'bin', 'pvs.js'), 'stop'], { stdio: 'ignore' });
  await sleep(1200);

  // Windows 上可执行文件是 electron.cmd，且 WSLg/容器的开关不需要
  // Windows 上不用 .cmd 包装（Node 24 直接 spawn .cmd 会 EINVAL），指向真实 exe。
  // 依赖可能在 node_modules（WSL 装的 Linux 版）或 node_modules.win*（Windows 原生版），
  // 按平台与存在性挑选。
  const electron = (() => {
    if (process.platform !== 'win32') return path.join(root, 'node_modules', '.bin', 'electron');
    const candidates = ['node_modules.win', 'node_modules.win2', 'node_modules.win3', 'node_modules']
      .flatMap((dir) => [
        path.join(root, dir, 'node_modules', 'electron', 'dist', 'electron.exe'),
        path.join(root, dir, 'electron', 'dist', 'electron.exe'),
      ]);
    const found = candidates.find((file) => fs.existsSync(file));
    if (!found) throw new Error('找不到 Windows 版 Electron：请先运行 start-windows.cmd 安装依赖');
    return found;
  })();
  const launchArgs = process.platform === 'win32'
    ? [root]
    : [root, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
  const child = spawn(electron, launchArgs,
    { cwd: root, detached: true, stdio: ['ignore', 'ignore', fs.openSync(path.join(os.tmpdir(), 'pvs-verify-gui.log'), 'w')] });
  child.unref();

  const state = await waitReady();
  check(true, 'GUI 面板启动', `pid ${state.pid} · 端口 ${state.port}`);
  check(state.socketBound === true, '控制通道 socket 已绑定', state.socket);

  const themeState = await api('panelState');
  check(themeState.state.themeAttr === 'light', '默认白天模式', `body[data-theme=${themeState.state.themeAttr}] · bg ${themeState.state.bodyBg}`);

  const codeFile = path.join(root, 'src', 'main', 'language.js');
  const htmlFile = path.join(root, 'examples', 'demo.html');

  // 代码预览
  await api('openCode', { file: codeFile });
  await sleep(1500);
  const panel = await api('panelState');
  const editor = await api('panelEditor');
  check(panel.state.view === 'code', '打开代码文件后切到代码视图', panel.state.view);
  check(editor.editor.docChars > 1000, '代码内容装载进编辑器', `${editor.editor.docChars} 字符 / ${editor.editor.docLines} 行`);
  check(editor.editor.renderedLines > 5, '编辑器实际渲染出可见行', `${editor.editor.renderedLines} 行`);
  check(String(editor.editor.docFirstLine).includes('use strict'), '首行内容正确', JSON.stringify(editor.editor.docFirstLine));
  if (editor.editor.docChars === 0) {
    console.log('    ↳ 失败现场 execTrace：');
    for (const line of panel.state.execTrace || []) console.log('       ' + line);
    console.log('    ↳ 会话：' + JSON.stringify(panel.state.sessions));
  }

  // 网页预览
  await api('open', { file: htmlFile });
  await sleep(1800);
  const webPanel = await api('panelState');
  check(webPanel.state.view === 'web', '打开 HTML 后切回网页视图', webPanel.state.view);
  const evaluated = await api('eval', { expression: '({ cards: document.querySelectorAll(".card").length, title: document.title })' });
  const value = JSON.parse(evaluated.value);
  check(value.cards === 3, 'Chromium 渲染出页面结构', `${value.cards} 张卡片`);
  check(value.title.includes('AIBrowser'), '页面标题正确', value.title);

  const shot = await api('screenshot', { format: 'png', out: path.join(root, '.aibrowser', 'verify-shot.png') });
  check(shot.bytes > 2000, '无头截图可用', `${shot.width}×${shot.height} · ${Math.round(shot.bytes / 1024)}KB`);

  const logs = await api('console');
  check(logs.entries.some((entry) => entry.text.includes('demo 页面已就绪')), '控制台日志采集', `${logs.entries.length} 条`);

  // 从文件树点击打开（用户最常用的路径）：必须真的把文件读进编辑器并渲染
  await api('panelAction', { action: 'toggle-sidebar' });
  await sleep(400);
  await api('panelAction', { action: 'sidebar-tab', payload: { tab: 'files' } });
  await sleep(600);
  const treeClick = await api('panelAction', { action: 'open-tree', payload: { name: 'README.md' } });
  check(!treeClick.result?.error, '文件树里能点到文件', (treeClick.result?.clicked || '').replace(/\s+/g, ' '));
  const treeEditor = await waitFor(async () => {
    const editor = await api('panelEditor');
    return editor.editor.docChars > 100 && editor.editor.renderedLines > 5
      ? { ok: true, value: editor }
      : { ok: false, value: editor };
  }, { label: '文件树装载' }).then((r) => r.value);
  await sleep(200);
  check(treeEditor.editor.docChars > 100, '点击文件树后编辑器装载了内容', `${treeEditor.editor.docChars} 字符 / ${treeEditor.editor.docLines} 行`);
  check(treeEditor.editor.renderedLines > 5, '点击文件树后内容真的渲染出来', `${treeEditor.editor.renderedLines} 行`);

  // 同一个文件树里切换到另一个文件，内容要跟着换
  await api('panelAction', { action: 'open-tree', payload: { name: 'package.json' } });
  await sleep(2000);
  const switched = await api('panelEditor');
  check(switched.editor.docFirstLine.trim().startsWith('{'), '切换文件后编辑器内容随之更新', JSON.stringify(switched.editor.docFirstLine.slice(0, 24)));

  // 编辑 + 保存链路：只对临时文件操作，避免破坏项目文件（踩过一次坑）
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvs-edit-'));
  const sandboxFile = path.join(sandboxDir, 'scratch.md');
  fs.writeFileSync(sandboxFile, '# scratch\norigin\n');
  await api('openCode', { file: sandboxFile });
  await waitFor(async () => {
    const editor = await api('panelEditor');
    return editor.editor.docChars > 0 ? { ok: true } : { ok: false };
  }, { label: '临时文件装载' });
  const edited = await api('panelAction', { action: 'edit-doc', payload: { text: '# 自动化验收临时内容\n第二行\n' } });
  check(edited.result?.dirty === true && edited.result?.saveVisible === true, '去掉按钮后仍可编辑（Ctrl+S 保存入口出现）', JSON.stringify(edited.result));
  await api('panelAction', { action: 'save' });
  const saved = await waitFor(async () => {
    const text = fs.readFileSync(sandboxFile, 'utf8');
    return text.startsWith('# 自动化验收临时内容') ? { ok: true } : { ok: false };
  }, { label: '落盘', timeoutMs: 5000 });
  check(saved.ok, 'Ctrl+S 保存确实写入磁盘');
  fs.rmSync(sandboxDir, { recursive: true, force: true });

  // 热重载：默认关闭，开启后文件变化会自动刷新
  const hotDefault = await api('panelState');
  check(hotDefault.state.hotReload === false, '热重载默认关闭', String(hotDefault.state.hotReload));
  const hotOn = await api('panelAction', { action: 'hot-reload', payload: { enabled: true } });
  check(hotOn.result.hotReload === true, '可开启热重载', JSON.stringify(hotOn.result));
  // 打开示例页并改文件，验证真的会刷新
  await api('openPath', { path: htmlFile });
  await waitFor(async () => {
    const s = await api('panelState');
    return s.state.view === 'web' ? { ok: true } : { ok: false };
  }, { label: '切到网页会话' });
  const originalHtml = fs.readFileSync(htmlFile, 'utf8');
  fs.writeFileSync(htmlFile, originalHtml.replace('<h1>', '<h1 data-hot="1">热重载 '));
  const reloaded = await waitFor(async () => {
    const r = await api('eval', { expression: 'document.querySelector("h1").hasAttribute("data-hot")' });
    return r.value === 'true' ? { ok: true } : { ok: false };
  }, { label: '热重载生效', timeoutMs: 8000 });
  fs.writeFileSync(htmlFile, originalHtml);
  check(reloaded.ok, '开启后改文件会自动刷新页面');
  const hotOff = await api('panelAction', { action: 'hot-reload', payload: { enabled: false } });
  check(hotOff.result.hotReload === false, '可关闭热重载', JSON.stringify(hotOff.result));
  fs.writeFileSync(htmlFile, originalHtml.replace('<h1>', '<h1 data-off="1">不应刷新 '));
  await sleep(2500);
  const stillOld = await api('eval', { expression: 'document.querySelector("h1").hasAttribute("data-off")' });
  fs.writeFileSync(htmlFile, originalHtml);
  check(stillOld.value === 'false', '关闭后改文件不再刷新');

  // 新标签页里回车打开目标：必须消耗空标签，不能多出一个
  await api('panelAction', { action: 'new-tab' });
  await sleep(400);
  const beforeEnter = await api('panelState');
  const beforeCount = beforeEnter.state.tabs.length;
  await api('panelAction', { action: 'type-address', payload: { value: 'README.md' } });
  await waitFor(async () => {
    const state = await api('panelState');
    return state.state.tabs.some((tab) => tab.includes('README.md')) ? { ok: true } : { ok: false };
  }, { label: '回车打开 README' });
  const afterEnter = await api('panelState');
  // 要求：不残留「刚建的那个空标签」，也不因回车多出额外标签
  const draftsBefore = beforeEnter.state.tabs.filter((t) => t.includes('新标签页')).length;
  const draftsAfter = afterEnter.state.tabs.filter((t) => t.includes('新标签页')).length;
  check(draftsAfter <= draftsBefore && afterEnter.state.tabs.some((t) => t.includes('README.md')),
    '在新标签页回车后不会残留空标签',
    `空标签 ${draftsBefore} → ${draftsAfter}，标签数 ${beforeCount} → ${afterEnter.state.tabs.length}`);

  // 相对路径（含点号）不应被误判成域名
  check(afterEnter.state.tabs.some((tab) => tab.includes('README.md')), '相对路径按本地文件打开而非域名');

  // 全屏预览：默认就是开启的（隐藏标题栏与工具栏，只留标签条）
  await api('openPath', { path: htmlFile });
  await waitFor(async () => {
    const state = await api('panelState');
    return state.state.view === 'web' ? { ok: true } : { ok: false };
  }, { label: '切到网页会话' });
  const fullscreenDefault = await api('debugLayout');
  const panelDefault = await api('panelState');
  check(panelDefault.state.contentOnly === true, '默认处于全屏预览（无标题栏/工具栏）', `contentOnly=${panelDefault.state.contentOnly}`);
  check(fullscreenDefault.slot.top <= 40, '默认全屏：内容从顶部开始', `top=${fullscreenDefault.slot.top}`);

  // 退出全屏 → 标题栏与工具栏回来，内容下移
  await api('panelAction', { action: 'content-only', payload: { visible: false } });
  const normal = await waitFor(async () => {
    const layout = await api('debugLayout');
    return layout.slot.top > fullscreenDefault.slot.top ? { ok: true, value: layout } : { ok: false, value: layout };
  }, { label: '退出全屏' }).then((r) => r.value);
  check(normal.slot.top > fullscreenDefault.slot.top, '退出全屏后标题栏与工具栏恢复、内容下移',
    `top ${fullscreenDefault.slot.top} → ${normal.slot.top}（+${normal.slot.top - fullscreenDefault.slot.top}px）`);
  const normalAligned = await waitFor(async () => {
    const layout = await api('debugLayout');
    const v = layout.activeViewBounds;
    return v && Math.abs(v.y - layout.slot.top) <= 2 && Math.abs(v.width - layout.slot.width) <= 2
      ? { ok: true, detail: `view ${v.width}×${v.height} · slot ${Math.round(layout.slot.width)}×${Math.round(layout.slot.height)}` }
      : { ok: false, detail: `view=${JSON.stringify(v)} slot top=${layout.slot.top}` };
  }, { label: '普通模式对齐' });
  check(normalAligned.ok, '普通模式下原生视图仍与槽位对齐', normalAligned.detail);

  // 用真实 Esc 回到全屏（Esc 的语义是「退出全屏」，这里先确认它在普通模式下无副作用）
  await api('panelAction', { action: 'press-escape' });
  const afterEsc = await api('debugLayout');
  check(afterEsc.slot.top === normal.slot.top, '普通模式下按 Esc 不改变布局', `top=${afterEsc.slot.top}`);

  // 重新回到全屏并确认还原
  await api('panelAction', { action: 'content-only', payload: { visible: true } });
  const backToFull = await waitFor(async () => {
    const layout = await api('debugLayout');
    return layout.slot.top <= 40 ? { ok: true, value: layout } : { ok: false, value: layout };
  }, { label: '回到全屏' }).then((r) => r.value);
  check(backToFull.slot.top === fullscreenDefault.slot.top, '可再次进入全屏并还原布局', `top=${backToFull.slot.top}`);


  // Ctrl+滚轮缩放界面：视口 CSS 宽度应随缩放变小、内容变大
  // 先显式回到 100%，避免上一次运行留下的持久化缩放影响断言
  await api('panelAction', { action: 'ui-zoom', payload: { factor: 1 } });
  await sleep(600);
  const beforeZoom = await api('panelState');
  const zoomed = await api('panelAction', { action: 'wheel-zoom', payload: { deltaY: -120 } });
  check(zoomed.result.uiScale > beforeZoom.state.uiScale, 'Ctrl+滚轮放大界面缩放值',
    `${beforeZoom.state.uiScale} → ${zoomed.result.uiScale}`);
  const shrunk = await waitFor(async () => {
    const state = await api('panelState');
    return state.state.viewportWidth < beforeZoom.state.viewportWidth - 5
      ? { ok: true, detail: `${beforeZoom.state.viewportWidth} → ${state.state.viewportWidth}px` }
      : { ok: false, detail: `仍为 ${state.state.viewportWidth}px` };
  }, { label: '视口缩小' });
  check(shrunk.ok, '缩放后视口 CSS 宽度变小（内容变大）', shrunk.detail);
  const layoutAfterZoom = await waitFor(async () => {
    const layout = await api('debugLayout');
    const aligned = layout.activeViewBounds
      && Math.abs(layout.activeViewBounds.width - layout.slot.width) <= 2
      && Math.abs(layout.activeViewBounds.y - layout.slot.top) <= 2;
    return aligned
      ? { ok: true, detail: `view ${layout.activeViewBounds.width}×${layout.activeViewBounds.height} · slot ${Math.round(layout.slot.width)}×${Math.round(layout.slot.height)}` }
      : { ok: false, detail: `view=${JSON.stringify(layout.activeViewBounds)} slot w=${Math.round(layout.slot.width)}` };
  }, { label: '缩放后对齐' });
  check(layoutAfterZoom.ok, '缩放后原生视图仍与槽位对齐', layoutAfterZoom.detail);
  await api('panelAction', { action: 'ui-zoom', payload: { factor: 1 } });
  const resetZoom = await waitFor(async () => {
    const state = await api('panelState');
    return Math.abs(state.state.viewportWidth - beforeZoom.state.viewportWidth) <= 3
      ? { ok: true, detail: `${state.state.viewportWidth}px` }
      : { ok: false, detail: `${state.state.viewportWidth}px` };
  }, { label: '缩放重置' });
  check(resetZoom.ok, '重置界面缩放回到 100%', resetZoom.detail);

  // 空标签：可以连续新建多个，并且排在所有会话标签之后
  await api('panelAction', { action: 'new-tab' });
  await sleep(300);
  await api('panelAction', { action: 'new-tab' });
  await sleep(500);
  const draft = await api('panelState');
  const draftTabs = draft.state.tabs.filter((tab) => tab.includes('新标签页'));
  check(draftTabs.length === 2, '可连续新建多个空标签', `${draftTabs.length} 个空标签`);
  const lastTwo = draft.state.tabs.slice(-2);
  check(lastTwo.every((tab) => tab.includes('新标签页')), '空标签排在所有会话标签之后', JSON.stringify(draft.state.tabs.map((t) => t.replace(/\s+/g, ''))));

  await api('panelAction', { action: 'open-target', payload: { value: htmlFile, mode: 'web' } });
  const draftResult = await waitFor(async () => {
    const state = await api('panelState');
    const leftOver = state.state.tabs.filter((tab) => tab.includes('新标签页'));
    return leftOver.length === 1
      ? { ok: true, detail: `剩 1 个空标签 / 共 ${state.state.tabs.length} 个标签` }
      : { ok: false, detail: `剩 ${leftOver.length} 个空标签` };
  }, { label: '空标签转换' });
  check(draftResult.ok, '空标签打开文件后转为正式标签，其余空标签保留', draftResult.detail);

  await api('ui', { view: 'console' });
  const consoleView = await waitFor(async () => {
    const state = await api('panelState');
    return state.state.view === 'console' ? { ok: true } : { ok: false };
  }, { label: '控制台视图' });
  const consolePanel = await api('panelState');
  check(consoleView.ok, '可切到控制台视图', consolePanel.state.view);

  // 静置后布局不该继续变化：确认没有重排循环（之前踩过每帧重排导致闪烁的坑）
  const idleA = await api('panelAction', { action: 'idle-stats' });
  await sleep(1500);
  const idleB = await api('panelAction', { action: 'idle-stats' });
  check(idleB.result.layoutSends - idleA.result.layoutSends <= 2, '静置时布局上报不再增长（无重排循环）',
    `1.5s 内 +${idleB.result.layoutSends - idleA.result.layoutSends} 次`);

  await api('shutdown');
  await sleep(1500);

  console.log('\n--- GUI 启动日志 ---');
  try {
    for (const line of fs.readFileSync(path.join(os.tmpdir(), 'pvs-verify-gui.log'), 'utf8').trim().split('\n').slice(-10)) console.log('   ' + line);
  } catch { /* ignore */ }

  const passed = results.filter(Boolean).length;
  console.log(`\n结果：${passed}/${results.length} 项通过\n`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((err) => {
  console.error(`\n验收异常：${err.message}\n`);
  process.exitCode = 1;
});
