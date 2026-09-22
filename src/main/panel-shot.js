'use strict';
/**
 * 面板截图：把「当前活动标签」那一屏整块截下来（含标签条、行号栏）。
 *
 * 为什么代码会话必须走这里：GUI 面板里代码是用 CodeMirror 渲染的，会话内部那个承载
 * pvs://code/ 页面的原生 WebContentsView 是**隐藏**的；隐藏视图不产生帧，
 * `capturePage()` 只会一直拿到空帧 —— 表现就是「当前环境取不到渲染帧（host=view …）」超时。
 * 网页会话走的是另一条路径（可见的原生视图 / 离屏渲染），不受影响。
 *
 * 面板模式下的关键是**让目标会话成为活动标签**：非活动标签同样不产生帧。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 面板窗口可用吗 */
function panelWindow(manager) {
  const win = manager && manager.guiWindow;
  if (!win || win.isDestroyed()) return null;
  return win;
}

/**
 * 把这个会话切成当前活动标签：先通知主进程侧聚焦，再让渲染进程切过去，
 * 然后等渲染进程回报「活动会话就是它」，最后留一点时间给合成器刷新。
 */
async function activateSession({ manager, session, timeoutMs = 3000, settleMs = 350 }) {
  const win = panelWindow(manager);
  manager.setFocus(session.id);
  if (!win) return false;
  try {
    manager.deps.broadcast('ui:focus', { sessionId: session.id, view: session.kind === 'code' ? 'code' : 'web' });
  } catch {
    /* 广播失败也要继续等 */
  }
  const deadline = Date.now() + timeoutMs;
  let active = false;
  while (Date.now() < deadline) {
    try {
      const raw = await win.webContents.executeJavaScript(
        "window.__PVS_PANEL__ ? JSON.stringify({ activeId: window.__PVS_PANEL__().activeId, activeCode: window.__PVS_PANEL__().activeCodeSessionId }) : ''",
        true,
      );
      const state = raw ? JSON.parse(raw) : null;
      if (state && (state.activeId === session.id || state.activeCode === session.id)) {
        active = true;
        break;
      }
    } catch {
      /* 渲染进程还没就绪，继续等 */
    }
    await sleep(100);
  }
  // 切换标签会改合成布局，等一帧再截，否则可能截到上一屏
  await sleep(settleMs);
  return active;
}

/**
 * 截面板。成功返回 {format,width,height,bytes,buffer,source:'panel'}，不可用时返回 null。
 * @param {object} opts
 * @param {object} opts.manager PreviewManager
 * @param {object} opts.session 目标会话（调用方保证它已是活动标签）
 * @param {'png'|'jpeg'} [opts.format]
 * @param {number} [opts.quality] jpeg 质量
 */
async function capturePanelShot({ manager, session, format = 'png', quality = 85 }) {
  const win = panelWindow(manager);
  if (!win) return null;
  // Windows 上隐藏/最小化的窗口 capturePage 返回空帧；先确保窗口可见
  try {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.showInactive();
  } catch {
    /* ignore */
  }
  // 面板里原生视图此时是隐藏的（代码视图用 CodeMirror），收起它避免合成层被裁切
  const bounds = session.view && typeof session.view.getBounds === 'function' ? session.view.getBounds() : null;
  if (bounds && session.view && typeof session.view.setVisible === 'function') session.view.setVisible(false);
  try {
    let image = await win.webContents.capturePage();
    if (!image || image.isEmpty() || image.getSize().width === 0) {
      await sleep(350);
      image = await win.webContents.capturePage();
    }
    if (!image || image.isEmpty() || image.getSize().width === 0) return null;
    const buffer = format === 'jpeg' ? image.toJPEG(quality) : image.toPNG();
    const size = image.getSize();
    return {
      format: format === 'jpeg' ? 'jpeg' : 'png',
      width: size.width,
      height: size.height,
      bytes: buffer.length,
      buffer,
      source: 'panel',
    };
  } catch {
    return null;
  } finally {
    if (bounds && session.view && typeof session.view.setVisible === 'function') session.view.setVisible(true);
  }
}

module.exports = { activateSession, capturePanelShot, panelWindow };
