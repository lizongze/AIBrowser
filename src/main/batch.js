'use strict';
// 批量任务：给一份文件/URL 清单，串行打开并逐项截图，产出结果清单。
// 设计说明见 docs/BATCH.md。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizePath } = require('./file-service');

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_TIMEOUT = 20000;


/** 调整会话视口以影响截图尺寸；返回原尺寸以便恢复 */
function applyViewport(session, viewport, { resize = false } = {}) {
  try {
    const target = { ...DEFAULT_VIEWPORT, ...(viewport || {}) };
    if (session.host === 'view') {
      // 面板里的会话尺寸由窗口决定，无法逐个改；记录一下供报告使用
      return null;
    }
    if (!session.window || session.window.isDestroyed()) return null;
    const [w, h] = session.window.getContentSize();
    if (!resize && w === target.width && h === target.height) return [w, h];
    session.window.setContentSize(target.width, target.height);
    return [w, h];
  } catch {
    return null;
  }
}

/** 恢复视口尺寸 */
function restoreViewport(session, saved) {
  if (!saved) return;
  try {
    if (session.window && !session.window.isDestroyed()) session.window.setContentSize(saved[0], saved[1]);
  } catch {
    /* ignore */
  }
}

/** 把 URL/路径转成安全的文件名片段 */
function safeName(input) {
  let text = String(input || '').trim();
  try {
    if (/^https?:\/\//i.test(text)) {
      const u = new URL(text);
      text = `${u.hostname}${u.pathname}`;
    }
  } catch {
    /* 保持原样 */
  }
  text = text
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^file:\/\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^0-9a-zA-Z\u4e00-\u9fa5._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
  if (!text) text = 'item';
  return text.length > 60 ? text.slice(0, 60) : text;
}

/** 展开 --dir 目录里的文件 */
function collectFromDir(dir, ext) {
  const wantExt = ext ? new Set(String(ext).split(',').map((e) => e.replace(/^\./, '').toLowerCase())) : null;
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!wantExt || wantExt.has(path.extname(entry.name).replace(/^\./, '').toLowerCase())) out.push(full);
    }
  };
  walk(path.resolve(dir));
  out.sort();
  return out;
}

/** 从文件读取清单：.json 支持字符串数组或对象数组；其它格式按「每行一个」解析 */
function collectFromFile(file) {
  const abs = path.resolve(file);
  const raw = fs.readFileSync(abs, 'utf8');
  if (/\.json$/i.test(abs)) {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error(`清单文件应为数组：${abs}`);
    return data;
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      // 支持 "url,name" 或 "url<TAB>name"
      const m = line.match(/^(.+?)[,\t]([^,\t]+)$/);
      if (m && /^https?:\/\//i.test(m[1].trim())) return { url: m[1].trim(), name: m[2].trim() };
      return line;
    });
}

/** 汇总该项的等待就绪逻辑 */
async function waitReady(session, item, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // 1) 等页面加载完成（有上限）
  await session.ensureLoaded(Math.min(15000, timeoutMs));
  // 2) 等指定选择器出现
  if (item.waitFor) {
    for (;;) {
      const found = await session.evalInPage(
        `Boolean(document.querySelector(${JSON.stringify(item.waitFor)}))`,
      ).catch(() => false);
      if (found) break;
      if (Date.now() > deadline) throw new Error(`等待选择器超时：${item.waitFor}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  // 3) 固定额外等待
  if (item.waitMs) await new Promise((r) => setTimeout(r, Number(item.waitMs)));
}

/**
 * 执行批量任务。
 * @param {object} opts
 * @param {Array<string|object>} opts.items 目标清单
 * @param {string} opts.outDir 截图输出目录
 * @param {boolean} [opts.fullPage] 默认是否整页截图
 * @param {string} [opts.format] png|jpeg
 * @param {number} [opts.timeout] 单项超时（毫秒）
 * @param {(event:object)=>void} [opts.onEvent] 逐项回调（用于流式输出）
 * @param {import('../../src/main/preview-manager').PreviewManager} opts.manager
 */
async function runBatch(opts) {
  const {
    items,
    outDir,
    fullPage = true,
    format = 'png',
    timeout = DEFAULT_TIMEOUT,
    onEvent,
    manager,
  } = opts;

  const outAbsolute = path.resolve(outDir);
  await fsp.mkdir(outAbsolute, { recursive: true });

  const startedAt = Date.now();
  const results = [];
  const used = new Map();
  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (let i = 0; i < items.length; i += 1) {
    const index = i + 1;
    const raw = items[i];
    // 字符串项不预判类型：统一交给 openSmart 判断（避免把域名当成路径）
    const item = typeof raw === 'string' ? { target: raw } : { ...raw };
    const target = item.url || item.file || String(raw);

    if (item.skip) {
      skipCount += 1;
      const entry = { index, target, name: item.name || safeName(target), ok: null, skipped: true };
      results.push(entry);
      onEvent?.({ kind: 'skip', ...entry });
      continue;
    }

    const baseName = item.name ? safeName(item.name) : safeName(target);
    const seen = used.get(baseName) || 0;
    used.set(baseName, seen + 1);
    const name = seen === 0 ? baseName : `${baseName}-${seen + 1}`;

    const itemStarted = Date.now();
    let session = null;
    let consoleBefore = 0;
    try {
      // 本地文件：缺省用其父目录作为授权根目录
      if (item.file && !item.root) {
        const absFile = path.resolve(item.file);
        if (!fs.existsSync(absFile)) throw new Error(`路径不存在：${item.file}`);
        item.root = fs.statSync(absFile).isDirectory() ? absFile : path.dirname(absFile);
      }
      if (item.root) manager.files.addRoot(item.root);

      session = item.sessionId ? manager.get(item.sessionId) : null;
      if (!session) {
        // 统一入口：字符串/ url / file 都在这里判断，不再由调用方区分
        const target = item.target !== undefined ? item.target : (item.url || item.file);
        const opened = await manager.openSmart({
          target,
          force: item.force,
          root: item.root,
        });
        // 代码会话也能截图：screenshot() 内部会先把代码渲染成 pvs://code/ 页面
        session = opened.session;
      } else {
        await session.load(item.target ? { url: item.target } : item.url ? { url: item.url } : { file: item.file });
      }

      // 视口：仅对「非整页」截图的宽度有意义；整页截图会自动扩展到全页高度
      const viewport = { ...DEFAULT_VIEWPORT, ...(item.viewport || {}) };
      const savedSize = applyViewport(session, viewport);

      consoleBefore = session.consoleEntries.length;

      const started = { kind: 'open', index, target, name, url: session.url };
      onEvent?.(started);

      await waitReady(session, item, timeout);

      // 默认**只出一张整页图**；只有显式给 item.viewports（数组）时才多尺寸
      const wantFullPage = item.fullPage !== undefined ? Boolean(item.fullPage) : fullPage;
      const viewports = Array.isArray(item.viewports) && item.viewports.length
        ? item.viewports
        : [item.viewport || null];
      const ext = (item.format || format) === 'jpeg' ? 'jpg' : 'png';
      const images = [];
      for (let v = 0; v < viewports.length; v += 1) {
        if (viewports[v]) applyViewport(session, viewports[v], { resize: true });
        const shot = await session.screenshot({
          format: item.format || format,
          fullPage: wantFullPage,
        });
        const suffix = viewports.length > 1 ? `-${(viewports[v] && viewports[v].width) || 'auto'}` : '';
        const imagePath = path.join(outAbsolute, `${String(index).padStart(3, '0')}-${name}${suffix}.${ext}`);
        await fsp.writeFile(imagePath, shot.buffer);
        images.push({
          path: imagePath,
          width: shot.width,
          height: shot.height,
          bytes: shot.bytes,
          fullPage: wantFullPage,
        });
      }
      restoreViewport(session, savedSize);

      let content = null;
      if (item.content) {
        try {
          const got = await session.getContent({ selector: item.content, maxLength: 4000 });
          content = got.text;
        } catch (err) {
          content = `提取失败：${err.message}`;
        }
      }

      const consoleErrors = session.consoleEntries
        .slice(consoleBefore)
        .filter((e) => e.level === 'error')
        .map((e) => e.text.slice(0, 300));

      const entry = {
        index,
        target,
        name,
        ok: true,
        title: session.title,
        url: session.info().url,
        image: images[0].path,
        images,
        width: images[0].width,
        height: images[0].height,
        bytes: images[0].bytes,
        fullPage: wantFullPage,
        elapsedMs: Date.now() - itemStarted,
        consoleErrors,
        ...(content === null ? {} : { content }),
      };
      results.push(entry);
      okCount += 1;
      onEvent?.({ kind: 'done', ...entry });
    } catch (err) {
      const entry = {
        index,
        target,
        name,
        ok: false,
        error: err && err.message ? err.message : String(err),
        elapsedMs: Date.now() - itemStarted,
      };
      results.push(entry);
      failCount += 1;
      onEvent?.({ kind: 'error', ...entry });
    }
  }

  const report = {
    ok: failCount === 0,
    startedAt,
    finishedAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    outDir: outAbsolute,
    total: items.length,
    succeeded: okCount,
    failed: failCount,
    skipped: skipCount,
    items: results,
    errors: results.filter((r) => r.ok === false).map((r) => ({ index: r.index, error: r.error })),
  };
  return report;
}

module.exports = { runBatch, safeName, collectFromFile, collectFromDir, DEFAULT_VIEWPORT, DEFAULT_TIMEOUT };
