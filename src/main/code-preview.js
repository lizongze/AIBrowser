'use strict';
// 把代码文件渲染成一张**可截图的网页**。
// 背景：代码会话本身没有网页图层（只有编辑器的 DOM），所以无头模式下截不到图。
// 这里用 highlight.js 在服务端生成高亮后的 HTML，通过 pvs://code/<路径> 交给 Chromium 渲染，
// 于是代码预览也能截图，且 GUI 与无头两种模式行为一致。
const fs = require('node:fs');
const path = require('node:path');
const hljs = require('highlight.js');
const { detectLanguage } = require('./language');

/**
 * 内联 highlight.js 官方主题（亮色 github / 暗色 github-dark）。
 * 只输出 hljs-* 类名而不给样式，代码就是一片无色的黑字 —— 这是之前截图的真实问题。
 */
const HLJS_CSS = (() => {
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(require.resolve('highlight.js/package.json'), '..', 'styles', name), 'utf8');
    } catch {
      return '';
    }
  };
  return { light: read('github.css'), dark: read('github-dark.css') };
})();

const MAX_BYTES = 2 * 1024 * 1024; // 超过这个大小不渲染（避免卡死）
const CACHE_LIMIT = 24;

/** 我们识别出的语言 id → highlight.js 的语言名（没有对应实现时退回自动识别） */
const HLJS_ALIAS = {
  javascript: 'javascript',
  typescript: 'typescript',
  json: 'json',
  css: 'css',
  html: 'xml',
  xml: 'xml',
  markdown: 'markdown',
  python: 'python',
  rust: 'rust',
  go: 'go',
  java: 'java',
  kotlin: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  php: 'php',
  ruby: 'ruby',
  shell: 'bash',
  powershell: 'powershell',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  dockerfile: 'dockerfile',
  diff: 'diff',
  lua: 'lua',
  perl: 'perl',
  r: 'r',
  scala: 'scala',
  dart: 'dart',
  elixir: 'elixir',
  haskell: 'haskell',
  clojure: 'clojure',
  proto: 'protobuf',
  graphql: 'graphql',
  nginx: 'nginx',
  makefile: 'makefile',
  cmake: 'cmake',
};

const cache = new Map(); // filePath -> { mtimeMs, size, html }

/** 顶部信息条右侧的文字：语言 · 行数 · 大小 */
function metaOf(value) {
  const parts = [value.languageLabel || value.language];
  if (value.lines) parts.push(`${value.lines} 行`);
  if (value.bytes) parts.push(`${Math.max(1, Math.round(value.bytes / 1024))} KB`);
  return parts.join(' · ');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * 生成代码预览页的 HTML。
 * @param {object} opts
 * @param {string} opts.file 绝对路径
 * @param {string} [opts.title] 顶部显示的标题（默认文件名）
 * @param {string} [opts.theme] light|dark
 * @param {boolean} [opts.wrap] 长行是否折行（默认 true）
 * @param {number} [opts.maxBytes]
 * @returns {{ html: string, language: string, languageLabel: string, lines: number, bytes: number, binary: boolean, truncated: boolean }}
 */
function renderCodePage({ file, title, theme = 'light', wrap = true, maxBytes = MAX_BYTES } = {}) {
  const abs = path.resolve(file);
  const stat = fs.statSync(abs);
  const key = abs;
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { ...cached.value, html: decorate(cached.value.html, { title: title || path.basename(abs), theme, wrap, meta: metaOf(cached.value) }) };
  }

  const buffer = fs.readFileSync(abs);
  const binary = buffer.includes(0);
  const truncated = buffer.length > maxBytes;
  const text = binary ? '' : buffer.subarray(0, maxBytes).toString('utf8');
  const lang = detectLanguage(abs);
  const lines = text ? text.split('\n').length : 0;

  let body;
  if (binary) {
    body = `<div class="empty">二进制文件（${stat.size} 字节），无法以文本方式预览</div>`;
  } else {
    const hljsName = HLJS_ALIAS[lang.id];
    let highlighted;
    try {
      highlighted = hljsName && hljs.getLanguage(hljsName)
        ? hljs.highlight(text, { language: hljsName, ignoreIllegals: true }).value
        : hljs.highlightAuto(text, hljsName ? [hljsName] : undefined).value;
    } catch {
      highlighted = escapeHtml(text);
    }
    body = `<pre><code class="hljs">${highlighted}</code></pre>`;
    if (truncated) body += `<div class="note">文件较大，仅渲染前 ${Math.round(maxBytes / 1024 / 1024 * 10) / 10}MB</div>`;
  }

  const value = {
    html: body,
    language: lang.id,
    languageLabel: lang.label,
    lines,
    bytes: stat.size,
    binary,
    truncated,
  };
  cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);

  return { ...value, html: decorate(body, { title: title || path.basename(abs), theme, wrap, meta: metaOf(value) }) };
}

/** 包一层完整的 HTML 文档（含样式与顶部信息条） */
function decorate(body, { title, theme, wrap, meta }) {
  const dark = theme === 'dark';
  const bg = dark ? '#0d1117' : '#ffffff';
  const fg = dark ? '#e6edf3' : '#14181d';
  const metaColor = dark ? '#8b949e' : '#6e7781';
  const border = dark ? '#232a34' : '#e2e6eb';
  const codeBg = dark ? '#0d1117' : '#ffffff';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title || 'code')}</title>
<style>
  /* highlight.js 主题（内联，保证离线可用） */
${HLJS_CSS[dark ? 'dark' : 'light']}
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: ${bg}; color: ${fg};
    font: 12.5px/1.7 ui-monospace, "Cascadia Code", "SFMono-Regular", Menlo, Consolas, monospace;
    -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision;
  }
  header {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 14px; border-bottom: 1px solid ${border};
    background: ${dark ? '#151a21' : '#f9fafb'}; color: ${metaColor};
    font: 500 12px/1.4 system-ui, "Microsoft YaHei UI", sans-serif;
    position: sticky; top: 0;
  }
  header .name { color: ${fg}; font-weight: 600; }
  header .spacer { flex: 1 }
  pre { margin: 0; padding: 14px 16px; background: ${codeBg}; overflow: visible; }
  pre code { white-space: ${wrap ? 'pre-wrap' : 'pre'}; word-break: ${wrap ? 'break-word' : 'normal'}; }
  .empty, .note { padding: 16px; color: ${metaColor}; }
  .note { border-top: 1px dashed ${border}; font-size: 11.5px; }
</style></head>
<body>
<header>
  <span class="name">${escapeHtml(title || '')}</span>
  <span class="spacer"></span>
  <span>${escapeHtml(meta || '')}</span>
</header>
${body}
</body></html>`;
}

module.exports = { renderCodePage, HLJS_ALIAS, MAX_BYTES };
