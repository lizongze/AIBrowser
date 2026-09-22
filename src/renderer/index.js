// AIBrowser 渲染层：面板 UI（文件树 / 标签 / CodeMirror / 控制台 / 原生视图联动）
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { syntaxHighlighting, defaultHighlightStyle, StreamLanguage, LanguageSupport, indentUnit } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

const $ = (id) => document.getElementById(id);
const el = {
  body: document.body,
  rootChip: $('root-chip'),
  rootLabel: $('root-label'),
  statusText: $('status-text'),
  statusDot: $('status-dot'),
  btnOpenFolder: $('btn-open-folder'),
  btnSidebar: $('btn-sidebar'),
  sidebar: $('sidebar'),
  btnHotReload: $('btn-hot-reload'),
  btnConsole: $('btn-console'),
  btnFullscreen: $('btn-fullscreen'),
  btnTheme: $('btn-theme'),
  sideTabs: $('side-tabs'),
  treeFilter: $('tree-filter'),
  btnRefreshTree: $('btn-refresh-tree'),
  sideFiles: $('side-files'),
  sideSessions: $('side-sessions'),
  sideFoot: $('side-foot'),
  tree: $('tree'),
  sessList: $('sess-list'),
  divider: $('divider'),
  tabs: $('tabs'),
  navBack: $('nav-back'),
  navForward: $('nav-forward'),
  navReload: $('nav-reload'),
  address: $('address'),
  btnGo: $('btn-go'),
  webSlot: $('web-slot'),
  webEmpty: $('web-empty'),
  codeName: $('code-name'),
  codeLang: $('code-lang'),
  codeSave: $('code-save'),
  editorHost: $('editor'),
  consoleTabs: $('console-tabs'),
  consoleList: $('console-list'),
  networkList: $('network-list'),
  netToggle: $('net-toggle'),
  consoleClear: $('console-clear'),
  evalInput: $('eval-input'),
  drawer: $('drawer'),
  drawerList: $('drawer-list'),
  drawerClear: $('drawer-clear'),
  drawerClose: $('drawer-close'),
  toast: $('toast'),
};

const state = {
  runtime: null,
  roots: [],
  entries: [], // 当前根目录条目
  treeCache: new Map(),
  expanded: new Set(),
  sessions: [],
  activeId: null,
  drafts: [], // 新建但还没绑定文件的空标签：{ id, active }
  draftSeq: 0,
  activeFile: null,
  codeSessions: new Map(), // sessionId -> { file, text, language, dirty, line }
  editors: new Map(), // file -> EditorView
  view: 'web',
  sidebar: false, // 默认隐藏左侧文件树，专注预览内容
  contentOnly: true, // 全屏预览：隐藏标题栏与工具栏，只留标签条（默认开启）
  uiScale: 1, // 面板界面缩放（Ctrl+滚轮 / Ctrl+Shift+= / Ctrl+0）
  hotReload: false, // 热重载默认关闭，按需开启
  consoleTab: 'console',
  consoleFilterSession: null,
  networkEnabled: false,
  logs: [],
  netLogs: [],
  theme: 'light', // 默认白天模式
  zoom: 1,
};

// ---------------------------------------------------------------- 工具

function toast(message, kind = 'info', timeout = 2600) {
  el.toast.textContent = message;
  el.toast.className = `toast show ${kind}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.toast.className = 'toast';
  }, timeout);
}

function setStatus(text, kind = 'ok') {
  el.statusText.textContent = text;
  el.statusDot.className = `dot ${kind}`;
}

function basename(p) {
  if (!p) return '';
  return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
}

function dirname(p) {
  if (!p) return '';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  parts.pop();
  return parts.join('/') || '/';
}

function shortPath(p, max = 42) {
  const text = String(p || '');
  if (text.length <= max) return text;
  return `…${text.slice(-max + 1)}`;
}

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

function formatTime(ts) {
  return new Date(ts).toTimeString().slice(0, 8);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function looksLikeUrl(value) {
  return /^(https?|file|data|about):/i.test(String(value || '')) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/|$)/i.test(String(value || ''));
}

// ---------------------------------------------------------------- 语言加载

const LANGUAGE_CACHE = new Map();

// 语言包通过「顶层静态 import」引入：渲染层被打包成 IIFE（单文件、无 chunk），
// 这种格式下动态 import() 会返回永不 settle 的 Promise，编辑器就会一直没有内容。
// 静态导入换来启动时一次性加载，代价是包体积变大，但对桌面应用完全可接受。
const LANG_LOADERS = {
  html: async () => (await import('@codemirror/lang-html')).html({ autoCloseTags: true, matchClosingTags: true }),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: false }),
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
};

/** StreamLanguage 包装的 legacy 模式（无 Lang 包的语言） */
function stream(define) {
  return async () => {
    const { StreamLanguage } = await import('@codemirror/language');
    return new LanguageSupport(StreamLanguage.define(define));
  };
}

async function loadLanguage(id) {
  if (LANGUAGE_CACHE.has(id)) return LANGUAGE_CACHE.get(id);
  const promise = (async () => {
    try {
      const direct = LANG_LOADERS[id];
      if (direct) return await direct();
      switch (id) {
        case 'shell': {
          const { shell } = await import('@codemirror/legacy-modes/mode/shell');
          return await stream(shell)();
        }
        case 'powershell': {
          const { powerShell } = await import('@codemirror/legacy-modes/mode/powershell');
          return await stream(powerShell)();
        }
        case 'ruby': {
          const { ruby } = await import('@codemirror/legacy-modes/mode/ruby');
          return await stream(ruby)();
        }
        case 'lua': {
          const { lua } = await import('@codemirror/legacy-modes/mode/lua');
          return await stream(lua)();
        }
        case 'perl': {
          const { perl } = await import('@codemirror/legacy-modes/mode/perl');
          return await stream(perl)();
        }
        case 'r': {
          const { r } = await import('@codemirror/legacy-modes/mode/r');
          return await stream(r)();
        }
        case 'dockerfile': {
          const { dockerFile } = await import('@codemirror/legacy-modes/mode/dockerfile');
          return await stream(dockerFile)();
        }
        case 'diff': {
          const { diff } = await import('@codemirror/legacy-modes/mode/diff');
          return await stream(diff)();
        }
        case 'toml': {
          const { toml } = await import('@codemirror/legacy-modes/mode/toml');
          return await stream(toml)();
        }
        case 'ini': {
          const { properties } = await import('@codemirror/legacy-modes/mode/properties');
          return await stream(properties)();
        }
        case 'nginx': {
          const { nginx } = await import('@codemirror/legacy-modes/mode/nginx');
          return await stream(nginx)();
        }
        case 'csharp': {
          const { csharp } = await import('@codemirror/legacy-modes/mode/clike');
          return await stream(csharp)();
        }
        case 'kotlin': {
          const { kotlin } = await import('@codemirror/legacy-modes/mode/clike');
          return await stream(kotlin)();
        }
        case 'swift': {
          const { swift } = await import('@codemirror/legacy-modes/mode/swift');
          return await stream(swift)();
        }
        case 'scala': {
          const { scala } = await import('@codemirror/legacy-modes/mode/clike');
          return await stream(scala)();
        }
        case 'dart': {
          const { dart } = await import('@codemirror/legacy-modes/mode/clike');
          return await stream(dart)();
        }
        case 'proto': {
          const { protobuf } = await import('@codemirror/legacy-modes/mode/protobuf');
          return await stream(protobuf)();
        }
        case 'cmake': {
          const { cmake } = await import('@codemirror/legacy-modes/mode/cmake');
          return await stream(cmake)();
        }
        case 'haskell': {
          const { haskell } = await import('@codemirror/legacy-modes/mode/haskell');
          return await stream(haskell)();
        }
        case 'graphql': {
          // legacy-modes 未提供 graphql 模式，用 sparql 做近似高亮（不额外引依赖）
          const { sparql } = await import('@codemirror/legacy-modes/mode/sparql');
          return await stream(sparql)();
        }
        default:
          return null;
      }
    } catch (err) {
      trace(`语言包加载失败 ${id}：${err && err.message ? err.message : String(err)}`);
      return null;
    }
  })();
  LANGUAGE_CACHE.set(id, promise);
  return promise;
}

// ---------------------------------------------------------------- 代码预览

// 白天模式的代码高亮：CodeMirror 默认高亮 + 面向浅色背景的字色/选中色
const lightTheme = [
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  EditorView.theme({
    '&': { color: 'var(--text)' },
    '.cm-content': { caretColor: 'var(--accent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--sel)' },
    '.cm-activeLine': { backgroundColor: 'rgba(76,141,255,0.07)' },
    '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
  }),
];

const cm = {
  language: new Compartment(),
  readOnly: new Compartment(),
  wrap: new Compartment(),
  theme: new Compartment(),
};

// 文档变更监听：始终把编辑写入「当前激活的代码会话」，保存时用得到
const changeTracker = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  const session = state.codeSessions.get(state.activeCodeSessionId);
  if (!session) return;
  session.text = update.state.doc.toString();
  session.dirty = true;
  el.codeSave.hidden = false;
  setStatus(`${basename(session.file)} 已修改（Ctrl+S 保存）`, 'warn');
});

function baseExtensions() {
  return [
    basicSetup,
    changeTracker,
    highlightActiveLine(),
    highlightActiveLineGutter(),
    drawSelection(),
    highlightSelectionMatches(),
    indentUnit.of('  '),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.theme({
      '&': { height: '100%', fontSize: 'var(--editor-font-size, 13px)', backgroundColor: 'transparent' },
      '.cm-scroller': {
        fontFamily: 'var(--mono)',
        fontSize: 'inherit',
        lineHeight: '1.7',
        letterSpacing: '0.1px',
        // Cascadia Code 的编程连字（=> != >= :: 等），代码可读性更好
        fontVariantLigatures: 'contextual',
        fontFeatureSettings: '"calt" 1, "liga" 1',
      },
      '.cm-gutters': { backgroundColor: 'var(--bg)', borderRight: '1px solid var(--border)', color: 'var(--faint)' },
      '.cm-activeLine': { backgroundColor: 'rgba(76,141,255,0.06)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(76,141,255,0.08)' },
      '&.cm-focused': { outline: 'none' },
      '.cm-panels': { backgroundColor: 'var(--elev)', color: 'var(--text)' },
      '.cm-searchMatch': { backgroundColor: 'rgba(210,153,34,0.3)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(210,153,34,0.55)' },
      '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--sel) !important' },
    }),
    cm.language.of([]),
    cm.readOnly.of(EditorState.readOnly.of(false)),
    cm.wrap.of(EditorView.lineWrapping),
    cm.theme.of(lightTheme),
  ];
}

function ensureEditor() {
  if (state.editorView) return state.editorView;
  state.editorView = new EditorView({
    state: EditorState.create({ doc: '', extensions: baseExtensions() }),
    parent: el.editorHost,
  });
  return state.editorView;
}

async function renderCode(session) {
  const view = ensureEditor();
  state.activeCodeSessionId = session.sessionId;
  const meta = state.codeSessions.get(session.sessionId) || {};
  const file = meta.file || session.file;
  // 用「编辑器里当前真正装载的内容」判断，而不是靠外部标记，避免竞态导致跳过装载
  const loadedDoc = state.loadedDoc || {};
  const needLoad = loadedDoc.sessionId !== session.sessionId
    || loadedDoc.file !== file
    || view.state.doc.length === 0;

  if (needLoad) {
    state.activeFile = file;
    el.codeName.textContent = basename(file);
    let payload;
    try {
      payload = await Promise.race([
        window.api.files.read(file),
        new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 5000)),
      ]);
      if (payload && payload.__timeout) throw new Error('读取超时（5s）：主进程 IPC 未返回');
    } catch (err) {
      toast(`读取失败：${err.message}`, 'error');
      setStatus(`读取失败：${err.message}`, 'error');
      return;
    }
    const language = await loadLanguage(payload.language);
    const text = payload.binary ? `（二进制文件，${humanSize(payload.size)}，无法以文本预览）` : payload.text;
    el.codeLang.textContent = payload.languageLabel || payload.language || 'plain';
    el.codeSave.hidden = true;
    try {
      // 注意：cm.language 这个 Compartment 在 extensions 里只能出现一次（重复会抛
      // "Duplicate use of compartment in extensions"），语言内容必须用 reconfigure 注入。
      view.setState(EditorState.create({ doc: text, extensions: baseExtensions() }));
      view.dispatch({ effects: cm.language.reconfigure(language ? [language] : []) });
    } catch (err) {
      toast(`渲染失败：${err.message}`, 'error');
      setStatus(`渲染失败：${err.message}`, 'error');
      return;
    }
    state.codeSessions.set(session.sessionId, {
      ...meta,
      file,
      language: payload.language,
      text: payload.text,
      size: payload.size,
      truncated: payload.truncated,
      dirty: false,
    });
    if (payload.truncated) toast('文件较大，已截断显示', 'warn', 3000);
    state.loadedDoc = { sessionId: session.sessionId, file, chars: payload.text.length };
  }

  // 关键：编辑器创建时容器可能还是 display:none（高度 0），CodeMirror 只会渲染 0 行。
  // 这里循环「等一帧 → 请求测量」，最多 5 轮，确保内容一定被画出来。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await nextFrame();
    view.requestMeasure();
    const renderedNow = document.querySelectorAll('.cm-line').length;
    const heightNow = view.viewport ? view.viewport.height : 0;
    if (renderedNow > 0 && heightNow > 0) break;
  }

  const line = Number(session.line || meta.line || 0);
  if (line > 0) {
    try {
      const lineInfo = view.state.doc.line(Math.min(line, view.state.doc.lines));
      view.dispatch({ selection: { anchor: lineInfo.from }, scrollIntoView: true });
    } catch {
      /* ignore */
    }
  }
  el.codeSave.hidden = !state.codeSessions.get(session.sessionId)?.dirty;
  const paintedLines = document.querySelectorAll('.cm-line').length;
  setStatus(
    `${basename(file)} · ${state.codeSessions.get(session.sessionId)?.language || 'text'}`
    + ` · ${view.state.doc.length} 字符 · 已渲染 ${paintedLines} 行`,
    paintedLines > 0 ? 'ok' : 'warn',
  );
}

/** 主题切换：同时切换界面配色与代码高亮（浅色用 CodeMirror 默认高亮，深色用 One Dark） */
function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.body.dataset.theme = state.theme;
  el.btnTheme.title = state.theme === 'dark' ? '切换为白天模式' : '切换为夜间模式';
  if (state.editorView) {
    state.editorView.dispatch({
      effects: cm.theme.reconfigure(state.theme === 'dark' ? oneDark : lightTheme),
    });
  }
  window.api.ui.setTheme(state.theme).catch(() => {});
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function trace(message) {
  state.execTrace = state.execTrace || [];
  state.execTrace.push(`${new Date().toTimeString().slice(0, 8)}.${String(Date.now() % 1000).padStart(3, '0')} ${message}`);
  if (state.execTrace.length > 60) state.execTrace.shift();
}

async function saveActiveCode() {
  const session = state.codeSessions.get(state.activeCodeSessionId);
  if (!session) return;
  try {
    await window.api.files.write(session.file, session.text);
    session.dirty = false;
    el.codeSave.hidden = true;
    setStatus(`已保存 ${basename(session.file)}`, 'ok');
    toast(`已保存 ${basename(session.file)}`, 'ok');
  } catch (err) {
    toast(`保存失败：${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------- 标签 / 视图

function sessionById(id) {
  return state.sessions.find((s) => s.sessionId === id) || null;
}

function renderTabs() {
  el.tabs.innerHTML = '';
  const addTabButton = () => {
    const button = document.createElement('button');
    button.className = 'icon-btn tab-add';
    button.id = 'btn-new-tab';
    button.title = '新建标签 (Ctrl+T)';
    button.textContent = '＋';
    button.addEventListener('click', newTab);
    el.tabs.appendChild(button);
    return button;
  };
  for (const session of state.sessions) {
    const tab = document.createElement('div');
    const kind = session.kind === 'code' ? 'code' : 'web';
    tab.className = `tab ${kind}${session.sessionId === state.activeId ? ' active' : ''}`;
    tab.title = session.file || session.url || '';
    tab.innerHTML = `<span class="tab-icon">${kind === 'code' ? '{}' : '◧'}</span>
      <span class="tab-title">${escapeHtml(basename(session.file) || session.title || session.url || session.sessionId)}</span>
      <span class="tab-close" title="关闭">✕</span>`;
    tab.addEventListener('click', (event) => {
      if (event.target.classList.contains('tab-close')) {
        event.stopPropagation();
        closeSession(session.sessionId);
        return;
      }
      activateSession(session.sessionId);
    });
    el.tabs.appendChild(tab);
  }
  if (!state.sessions.length && !state.drafts.length) {
    const empty = document.createElement('div');
    empty.className = 'tab';
    empty.style.opacity = '.5';
    empty.innerHTML = '<span class="tab-title">没有打开的标签</span>';
    el.tabs.appendChild(empty);
  }
  // 空标签（可以开多个）：点了「＋」但还没选文件/输入 URL，统一排在所有会话标签之后
  for (const draft of state.drafts) {
    const draftTab = document.createElement('div');
    draftTab.className = `tab draft${draft === state.activeDraft ? ' active' : ''}`;
    draftTab.title = '新标签页：在地址栏输入 URL 或文件路径';
    draftTab.innerHTML = '<span class="tab-icon">⊕</span><span class="tab-title">新标签页</span><span class="tab-close" title="关闭">✕</span>';
    draftTab.addEventListener('click', (event) => {
      if (event.target.classList.contains('tab-close')) {
        event.stopPropagation();
        closeDraftTab(draft);
        return;
      }
      activateDraft(draft);
    });
    el.tabs.appendChild(draftTab);
  }
  addTabButton(); // 草稿标签与「＋」都排在所有会话标签之后
}

/**
 * 新建一个空标签。可以连续点多次，每个空标签都是一个独立的待打开目标。
 * 输入 URL / 文件路径（或点文件树选择文件）后，当前空标签就会变成真实的预览会话。
 */
function newTab() {
  state.draftSeq += 1;
  const draft = { id: `d${state.draftSeq}` };
  state.drafts.push(draft);
  activateDraft(draft);
  return draft;
}

/** 聚焦某个空标签 */
function activateDraft(draft) {
  state.activeDraft = draft;
  state.activeId = null;
  state.activeFile = null;
  state.activeCodeSessionId = null;
  setView('web');
  renderTabs();
  renderSessionList();
  el.address.value = '';
  el.address.focus();
  state.lastLayout = null;
  syncNativeView();
  setStatus('新标签页：输入 URL 或文件路径，回车打开', 'ok');
}

/** 关闭一个空标签（不传则关闭当前聚焦的那个） */
function closeDraftTab(draft = state.activeDraft) {
  const index = state.drafts.indexOf(draft);
  if (index === -1) return;
  state.drafts.splice(index, 1);
  if (state.activeDraft === draft) {
    state.activeDraft = state.drafts[index] || state.drafts[index - 1] || null;
  }
  if (state.activeDraft) {
    activateDraft(state.activeDraft);
    return;
  }
  renderTabs();
  const next = state.sessions[state.sessions.length - 1];
  if (next) activateSession(next.sessionId);
  else {
    state.activeId = null;
    syncNativeView();
  }
}

function renderSessionList() {
  el.sessList.innerHTML = '';
  for (const session of state.sessions) {
    const row = document.createElement('div');
    row.className = `sess${session.sessionId === state.activeId ? ' active' : ''}`;
    row.innerHTML = `<span class="sess-icon">${session.kind === 'code' ? '{}' : '◧'}</span>
      <span class="sess-title">${escapeHtml(basename(session.file) || session.title || session.url || session.sessionId)}</span>
      <span class="sess-kind">${session.kind === 'code' ? 'code' : 'web'}</span>`;
    row.title = session.file || session.url || '';
    row.addEventListener('click', () => activateSession(session.sessionId));
    el.sessList.appendChild(row);
  }
  if (!state.sessions.length) {
    el.sessList.innerHTML = '<div class="node" style="opacity:.55;padding:10px">暂无会话</div>';
  }
  el.sideFoot.textContent = `${state.sessions.length} 个会话 · ${state.roots.length} 个根目录`;
}

function setView(view) {
  const previous = state.view;
  if (view !== 'console') state.lastNonConsoleView = view;
  state.view = view;
  el.body.dataset.view = view;
  // 调试追踪：记录每次视图切换的来源（面板自检会读取）
  state.viewTrace = state.viewTrace || [];
  if (previous !== view || state.viewTrace.length === 0) {
    const stack = (new Error().stack || '').split('\n').slice(2, 5).map((line) => line.trim().replace(/^at\s+/, ''));
    const active = state.sessions.find((s) => s.sessionId === state.activeId);
    state.viewTrace.push(
      `${new Date().toTimeString().slice(0, 8)}.${String(Date.now() % 1000).padStart(3, '0')} `
      + `${previous}→${view} activeId=${state.activeId}(${active ? active.kind : 'nil'}) | ${stack.join(' ← ')}`,
    );
    if (state.viewTrace.length > 40) state.viewTrace.shift();
  }
  if (view === 'console') refreshConsole();
  syncNativeView();
  state.sendTrace = state.sendTrace || [];
  state.sendTrace.push(`${Date.now() % 100000} send ${view} activeId=${state.activeId}`);
  if (state.sendTrace.length > 40) state.sendTrace.shift();
  window.api.ui.setView(view, state.activeId).catch(() => {});
}

/**
 * 把原生 Chromium 视图在面板里的位置同步给主进程。
 * 两点防抖动：
 *   1) 渲染层去重 —— 槽位与「当前该显示的会话」都没变就什么都不发；
 *   2) 防重入 —— 主进程摘挂原生视图会触发 ResizeObserver 回调，回调里再发一次就会互相激发。
 */
function syncNativeView() {
  // 合并同一帧内的多次请求；槽位与会话都没变时 syncNativeViewNow 内部也不会真的发请求
  if (state.nativeViewScheduled) return;
  state.nativeViewScheduled = true;
  requestAnimationFrame(() => {
    state.nativeViewScheduled = false;
    syncNativeViewNow();
  });
}

function syncNativeViewNow() {
  if (state.syncingNativeView) return;
  state.syncingNativeView = true;
  try {
    const session = sessionById(state.activeId);
    const rect = el.webSlot.getBoundingClientRect();
    const box = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const showNative = state.view === 'web' && session && session.kind !== 'code';
    const wanted = showNative ? session.sessionId : null;
    const previous = state.lastLayout || {};
    const same = previous.sessionId === wanted
      && previous.left === box.left && previous.top === box.top
      && previous.width === box.width && previous.height === box.height;
    if (!same) {
      state.layoutSendCount = (state.layoutSendCount || 0) + 1;
      state.lastLayout = { sessionId: wanted, ...box };
      window.api.ui.layout({
        viewLeft: box.left,
        viewTop: box.top,
        viewWidth: box.width,
        viewHeight: box.height,
        bodyWidth: el.body.clientWidth,
        bodyHeight: el.body.clientHeight,
      }).catch(() => {});
      window.api.ui.activeView(wanted).catch(() => {});
    }
    el.webEmpty.hidden = Boolean(showNative);
  } finally {
    state.syncingNativeView = false;
  }
}

async function activateSession(id, { force = false } = {}) {
  const session = sessionById(id);
  if (!session) return;
  // 面板还在启动（文件树/会话列表尚未就绪）时先跳过，boot 结束会补一次激活，
  // 否则启动瞬间进来的 open 请求会被静默丢弃。
  if (!state.booted) return;
  const isCode = session.kind === 'code';
  // 代码会话自动切到代码面板；网页会话在「控制台」之外切回网页面板
  const targetView = isCode ? 'code' : state.view === 'code' ? 'web' : state.view;
  // 幂等守卫：同一会话、同一视图、且代码文件已经装载完毕时才跳过重复渲染。
  // 只比 sessionId 不行 —— 装载是异步的，中途重复触发会把渲染吃掉，编辑器就一直空着。
  const fileLoaded = !isCode || state.activeCodeSessionId === id;
  // 注意：幂等守卫里不能忽略「还有聚焦中的空标签」这一情况 ——
  // 否则在新标签页里打开目标时，会话被激活但空标签没被消耗，界面上就多出一个标签页。
  if (!force && !state.activeDraft && state.activeId === id && state.view === targetView && fileLoaded) {
    return;
  }
  state.activeId = id;
  // 打开真实会话后，聚焦中的空标签让位（其它空标签保留）
  if (state.activeDraft) {
    state.drafts = state.drafts.filter((item) => item !== state.activeDraft);
    state.activeDraft = null;
  }
  el.address.value = session.file || session.url || '';
  setOpenMode(isCode ? 'code' : 'web');
  window.api.sessions.focus(id).catch(() => {});
  setView(targetView);
  renderTabs();
  renderSessionList();
  if (isCode) {
    await renderCode(session);
  } else {
    state.activeFile = null;
    state.activeCodeSessionId = null;
  }
}

async function closeSession(id) {
  await window.api.sessions.close(id).catch(() => {});
  await refreshSessions();
  if (state.activeId === id) {
    const next = state.sessions[state.sessions.length - 1];
    if (next) await activateSession(next.sessionId);
    else {
      state.activeId = null;
      syncNativeView();
    }
  }
}

async function refreshSessions() {
  const result = await window.api.sessions.list();
  state.sessions = result.sessions || [];
  state.roots = result.roots || [];
  // 只有在「当前激活会话不存在了」或「还没有激活会话」时才重新挑选：
  // 绝不能无条件跟主进程的 focused 走，否则刚打开的新会话会被刷新覆盖回旧会话。
  if (state.activeId && !sessionById(state.activeId)) state.activeId = null;
  // 空标签（草稿）期间不要自动跳回旧会话，否则刚点「＋」建好的标签会被顶掉
  if (!state.activeId && !state.activeDraft && state.sessions.length) {
    state.activeId = (state.sessions.find((s) => s.focused) || state.sessions[0]).sessionId;
  }
  renderTabs();
  renderSessionList();
  renderRoots();
  syncNativeView();
}

// ---------------------------------------------------------------- 文件树

function renderRoots() {
  const root = state.roots[state.roots.length - 1];
  el.rootLabel.textContent = root ? basename(root.dir) || root.dir : '未打开文件夹';
  el.rootChip.title = root ? root.dir : '点击选择项目目录';
}

async function loadTree(dir) {
  const result = await window.api.files.tree(dir);
  state.treeCache.set(dir, result.entries || []);
  return result.entries || [];
}

async function renderTree() {
  const root = state.roots[state.roots.length - 1];
  el.tree.innerHTML = '';
  if (!root) {
    el.tree.innerHTML = '<div class="node" style="opacity:.6;padding:10px;white-space:pre-line">尚未打开项目目录\n点击左上角目录名或 📂 选择</div>';
    return;
  }
  const filter = el.treeFilter.value.trim().toLowerCase();
  if (!state.treeCache.has(root.dir)) await loadTree(root.dir);
  const rows = await buildTree(root.dir, 0, filter);
  for (const row of rows) el.tree.appendChild(row);
}

async function buildTree(dir, depth, filter) {
  const entries = state.treeCache.get(dir) || (await loadTree(dir));
  const rows = [];
  for (const entry of entries) {
    if (filter && !entry.name.toLowerCase().includes(filter)) {
      if (!entry.dir) continue;
    }
    const row = document.createElement('div');
    row.className = 'node';
    const isOpen = state.expanded.has(entry.path) || Boolean(filter);
    const isActive = state.activeFile === entry.path;
    row.classList.toggle('dir', entry.dir);
    row.classList.toggle('file', !entry.dir);
    row.classList.toggle('active', isActive);
    row.style.paddingLeft = `${6 + depth * 12}px`;
    const icon = entry.dir ? (isOpen ? '▾' : '▸') : entry.isPreview ? '◆' : '·';
    row.innerHTML = `<span class="node-icon">${icon}</span><span class="node-name">${escapeHtml(entry.name)}</span>
      ${entry.dir ? '' : `<span class="node-meta">${humanSize(entry.size)}</span>`}`;
    row.title = entry.path;
    row.addEventListener('click', () => onTreeClick(entry));
    rows.push(row);
    if (entry.dir && isOpen) {
      const children = await buildTree(entry.path, depth + 1, filter);
      rows.push(...children);
    }
  }
  return rows;
}

async function onTreeClick(entry) {
  if (entry.dir) {
    if (state.expanded.has(entry.path)) state.expanded.delete(entry.path);
    else state.expanded.add(entry.path);
    await renderTree();
    return;
  }
  // 注意：这里不要提前写 state.activeFile —— 那是「编辑器当前装载的文件」的标记，
  // 提前改掉会让 renderCode 误判为已装载，从而跳过读取，编辑器就一直是空的。
  await renderTree();
  // 由文件类型决定预览方式：HTML/SVG 走网页，其余走代码
  await openTarget(entry.path, entry.isPreview ? 'web' : 'code');
}

/** 打开方式：网页 / 代码。仍保留状态是为了「新标签页默认方式」与状态栏提示 */
function setOpenMode(mode) {
  state.openMode = mode === 'code' ? 'code' : 'web';
}

// ---------------------------------------------------------------- 打开目标

async function openTarget(value, mode) {
  const text = String(value || '').trim();
  if (!text) return;
  setStatus(`打开中 ${shortPath(text, 30)}…`, 'busy');
  try {
    // 本地存在的路径优先（避免 README.md / package.json 被当成域名）
    const localStat = looksLikeUrl(text) ? await window.api.files.stat(text).catch(() => null) : null;
    const treatAsPath = !looksLikeUrl(text) || (localStat && localStat.exists);
    if (!treatAsPath) {
      const result = await window.api.sessions.open({ url: text });
      await refreshSessions();
      await activateSession(result.sessionId);
      setView('web');
      setStatus(`已打开 ${shortPath(text, 40)}`, 'ok');
      return;
    }
    const stat = await window.api.files.stat(text);
    if (!stat.exists) {
      toast(`路径不存在：${text}`, 'error');
      setStatus('路径不存在', 'error');
      return;
    }
    if (mode === 'code' || (!stat.dir && state.openMode === 'code' && isExplicitMode())) {
      const result = await window.api.sessions.openCode({ file: text });
      await refreshSessions();
      await activateSession(result.sessionId);
      setView('code');
      setStatus(`代码预览 ${basename(text)}`, 'ok');
      return;
    }
    const result = await window.api.sessions.open({ file: text });
    await refreshSessions();
    await activateSession(result.sessionId);
    setView('web');
    setStatus(`网页预览 ${basename(text)}`, 'ok');
  } catch (err) {
    toast(`打开失败：${err.message}`, 'error');
    setStatus('打开失败', 'error');
  }
}

function isExplicitMode() {
  return true;
}

// ---------------------------------------------------------------- 控制台 / 网络

function pushLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 800) state.logs.splice(0, state.logs.length - 800);
  appendLogRow(el.consoleList, entry);
  appendLogRow(el.drawerList, entry);
}

function appendLogRow(container, entry) {
  const row = document.createElement('div');
  row.className = `log ${entry.level === 'warning' ? 'warn' : entry.level}`;
  row.innerHTML = `<span class="log-ts">${formatTime(entry.ts)}</span><span class="log-text">${escapeHtml(entry.text)}</span>`;
  const stick = container.scrollTop + container.clientHeight >= container.scrollHeight - 30;
  container.appendChild(row);
  while (container.childElementCount > 600) container.removeChild(container.firstChild);
  if (stick) container.scrollTop = container.scrollHeight;
}

function appendNetRow(entry) {
  const row = document.createElement('div');
  row.className = `net${entry.ok ? '' : ' err'}`;
  row.innerHTML = `<span class="net-method">${escapeHtml(entry.method || 'GET')}</span>
    <span class="net-status">${entry.status || 0}</span>
    <span class="net-url" title="${escapeHtml(entry.url)}">${escapeHtml(entry.url)}</span>
    <span class="net-time">${entry.durationMs ? `${entry.durationMs}ms` : ''}</span>`;
  const stick = el.networkList.scrollTop + el.networkList.clientHeight >= el.networkList.scrollHeight - 30;
  el.networkList.appendChild(row);
  while (el.networkList.childElementCount > 500) el.networkList.removeChild(el.networkList.firstChild);
  if (stick) el.networkList.scrollTop = el.networkList.scrollHeight;
}

async function refreshConsole() {
  const sessionId = state.activeId;
  if (!sessionId) return;
  try {
    const logs = await window.api.sessions.console({ sessionId });
    el.consoleList.innerHTML = '';
    state.logs = logs.entries || [];
    for (const entry of state.logs) appendLogRow(el.consoleList, entry);
    if (state.networkEnabled) {
      const net = await window.api.sessions.network({ sessionId });
      el.networkList.innerHTML = '';
      state.netLogs = net.entries || [];
      for (const entry of state.netLogs) appendNetRow(entry);
    }
  } catch {
    /* 无会话时忽略 */
  }
}

// ---------------------------------------------------------------- 事件接线

function setConsoleTab(tab) {
  state.consoleTab = tab;
  for (const button of el.consoleTabs.querySelectorAll('.side-tab')) {
    button.classList.toggle('active', button.dataset.ctab === tab);
  }
  el.consoleList.hidden = tab !== 'console';
  el.networkList.hidden = tab !== 'network';
}

function setSideTab(tab) {
  for (const button of el.sideTabs.querySelectorAll('.side-tab')) {
    button.classList.toggle('active', button.dataset.side === tab);
  }
  el.sideFiles.hidden = tab !== 'files';
  el.sideSessions.hidden = tab !== 'sessions';
}

function wireEvents() {
  // 侧栏
  el.sideTabs.addEventListener('click', (event) => {
    const button = event.target.closest('.side-tab');
    if (button) setSideTab(button.dataset.side);
  });
  el.treeFilter.addEventListener('input', () => renderTree().catch(() => {}));
  el.btnRefreshTree.addEventListener('click', async () => {
    state.treeCache.clear();
    await renderTree();
    toast('文件树已刷新', 'info', 1200);
  });
  el.rootChip.addEventListener('click', pickFolder);
  el.btnOpenFolder.addEventListener('click', pickFolder);

  // 地址栏：回车直接打开（当前是网页会话且已在浏览时，等价于导航；否则按类型新开/切换）
  el.address.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const session = sessionById(state.activeId);
    const value = el.address.value.trim();
    if (!value) return;
    // 先看是不是本地已存在的路径：README.md、package.json 这类含点号的相对路径
    // 会被 URL 正则误判成域名，必须优先按路径处理。
    openTarget(value, /\.(html?|xhtml|svg)$/i.test(value) ? 'web' : 'code');
  });
  el.navBack.addEventListener('click', () => state.activeId && window.api.sessions.back(state.activeId).then(() => refreshSessions()));
  el.navForward.addEventListener('click', () => state.activeId && window.api.sessions.forward(state.activeId).then(() => refreshSessions()));
  el.navReload.addEventListener('click', async () => {
    const session = sessionById(state.activeId);
    if (!session) return;
    if (session.kind === 'code') {
      state.activeFile = null;
      await renderCode(session);
      toast('已重新读取文件', 'info', 1200);
      return;
    }
    await window.api.sessions.reload(session.sessionId, false);
    toast('已刷新预览', 'info', 1200);
  });

  // 代码视图：只读/换行两个开关已去掉 —— 默认即可编辑（Ctrl+S 保存）、自动换行，
  // 少两个按钮，界面更干净。
  el.codeSave.addEventListener('click', saveActiveCode);

  // 控制台
  el.consoleTabs.addEventListener('click', (event) => {
    const button = event.target.closest('.side-tab');
    if (button) setConsoleTab(button.dataset.ctab);
  });
  el.consoleClear.addEventListener('click', () => {
    state.logs = [];
    el.consoleList.innerHTML = '';
    el.drawerList.innerHTML = '';
    window.api.sessions.console({ sessionId: state.activeId, clear: true }).catch(() => {});
  });
  el.netToggle.addEventListener('click', async () => {
    state.networkEnabled = !state.networkEnabled;
    el.netToggle.textContent = `网络记录：${state.networkEnabled ? '开' : '关'}`;
    el.netToggle.classList.toggle('on', state.networkEnabled);
    if (state.networkEnabled) setConsoleTab('network');
    try {
      await window.api.sessions.network({ sessionId: state.activeId, enabled: state.networkEnabled });
      await refreshConsole();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  el.evalInput.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    const expression = el.evalInput.value.trim();
    if (!expression) return;
    el.evalInput.value = '';
    appendLogRow(el.consoleList, { level: 'debug', ts: Date.now(), text: `› ${expression}` });
    try {
      const result = await window.api.sessions.eval({ sessionId: state.activeId, expression });
      appendLogRow(el.consoleList, { level: 'info', ts: Date.now(), text: `← ${result.value}` });
    } catch (err) {
      appendLogRow(el.consoleList, { level: 'error', ts: Date.now(), text: `← ${err.message}` });
    }
  });

  // 抽屉
  el.btnSidebar.addEventListener('click', () => setSidebar(!state.sidebar));
  // 控制台图标：在「控制台面板」与「原来的预览视图」之间来回切
  el.btnHotReload.addEventListener('click', () => setHotReload(!state.hotReload, { notify: true }));
  el.btnConsole.addEventListener('click', () => toggleConsole());
  el.btnFullscreen.addEventListener('click', () => toggleContentOnly());
  el.drawerClose.addEventListener('click', () => {
    el.drawer.hidden = true;
    syncNativeView();
  });
  el.drawerClear.addEventListener('click', () => {
    el.drawerList.innerHTML = '';
  });

  // 主题
  el.btnTheme.addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    toast(`已切换到${state.theme === 'dark' ? '深色' : '浅色'}主题`, 'info', 1400);
  });

  // Ctrl + 滚轮：缩放界面（面板整体）
  window.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    // deltaY 在不同设备上量级差别很大，按符号逐步缩放更稳妥
    stepUiScale(event.deltaY < 0 ? 0.1 : -0.1);
  }, { passive: false });

  // 侧栏宽度拖拽
  let dragging = false;
  el.divider.addEventListener('mousedown', () => {
    dragging = true;
    el.body.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const width = Math.min(Math.max(event.clientX, 200), 520);
    document.getElementById('sidebar').style.width = `${width}px`;
    syncNativeView();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    el.body.classList.remove('resizing');
    document.body.style.cursor = '';
    syncNativeView();
  });

  // Esc：优先关闭浮层，其次退出全屏预览
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const searchOpen = Boolean(document.querySelector('.cm-panels .cm-search'));
    if (!el.drawer.hidden) {
      el.drawer.hidden = true;
      syncNativeView();
      event.preventDefault();
      return;
    }
    if (searchOpen) return; // 搜索框自己会处理 Esc
    if (state.contentOnly) {
      toggleContentOnly(false);
      event.preventDefault();
    }
  }, true); // 捕获阶段：编辑器吃掉按键前先处理

  // 快捷键
  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    if (event.key === 'o') {
      event.preventDefault();
      pickFolder();
    } else if (event.key === 's') {
      event.preventDefault();
      saveActiveCode();
    } else if (event.key === 'm' && event.shiftKey) {
      event.preventDefault();
      toggleContentOnly();
    } else if (event.key === 't') {
      event.preventDefault();
      newTab();
    } else if (event.key === 'b') {
      event.preventDefault();
      setSidebar(!state.sidebar);
    } else if (event.key === 'j') {
      event.preventDefault();
      toggleConsole();
    }
  });

  // 原生视图位置只在这些时刻需要重算：
  //   窗口尺寸变化、视图切换、会话切换、侧栏开关/拖拽、底部抽屉展开收起。
  // 这里刻意不用 ResizeObserver 观察内容区 —— 主进程 setBounds 会改变合成布局，
  // 观察者回调里再上报一次就会形成「重排 → 观察者 → 重排」的自激循环，界面表现为不停闪烁。
  window.addEventListener('resize', () => syncNativeView());
  document.addEventListener('visibilitychange', () => syncNativeView());
}

/**
 * 全屏预览：隐藏标题栏与工具栏（保留标签条），把竖直空间全部让给预览内容。
 * 再点一次图标或按 Ctrl+Shift+M 还原。
 */
function toggleContentOnly(force, { persist = true } = {}) {
  const next = typeof force === 'boolean' ? force : !state.contentOnly;
  state.contentOnly = next;
  el.body.classList.toggle('content-only', next);
  el.btnFullscreen.classList.toggle('on', next);
  el.btnFullscreen.title = next ? '退出全屏预览（Esc）' : '全屏预览：只留标签页 (Ctrl+Shift+M，Esc 退出)';
  // 全屏时把视图切回当前会话该有的样子，避免停在控制台面板
  const session = sessionById(state.activeId);
  if (next) setView(session && session.kind === 'code' ? 'code' : 'web');
  state.lastLayout = null; // 标题栏/工具栏消失会改变槽位，强制重算
  requestAnimationFrame(() => syncNativeView());
  if (persist) window.api.ui.setContentOnly(next).catch(() => {});
  setStatus(next ? '全屏预览：按 Esc 或 Ctrl+Shift+M 还原' : '已退出全屏预览', 'ok');
}

/**
 * 界面缩放（面板整体，不是页面内容）：
 *   Ctrl + 滚轮  —— 直接调
 *   Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+0 —— 菜单与快捷键
 * 缩放由 Chromium 的 zoomFactor 承担，槽位坐标随之变化，因此需要重新同步原生视图位置。
 */
function applyUiScale(next, { persist = true } = {}) {
  const clamped = Math.min(Math.max(Number(next) || 1, 0.6), 3);
  state.uiScale = clamped;
  state.lastLayout = null; // 缩放会改变槽位，强制重算
  // persist 只影响「是否写入配置文件」，缩放本身始终应用
  window.api.ui.zoom(clamped).catch(() => {});
  syncNativeView();
  return clamped;
}

function stepUiScale(delta) {
  const next = Math.round((state.uiScale + delta) * 100) / 100;
  applyUiScale(next);
  setStatus(`界面缩放 ${Math.round(state.uiScale * 100)}%`, 'ok');
  toast(`界面缩放 ${Math.round(state.uiScale * 100)}%`, 'info', 1200);
}

/**
 * 热重载开关：默认关闭。开启后每 0.6s 轮询被预览文件所在目录，变化即自动刷新页面。
 * notify=false 用于「跟随主进程状态」的场景，避免来回回声。
 */
function setHotReload(enabled, { notify = false } = {}) {
  state.hotReload = Boolean(enabled);
  el.btnHotReload.classList.toggle('on', state.hotReload);
  el.btnHotReload.title = state.hotReload
    ? '热重载：开（文件变化自动刷新，点击关闭）'
    : '热重载：关（点击开启）';
  if (notify) {
    window.api.ui.hotReload(state.hotReload).catch(() => {});
    toast(state.hotReload ? '热重载已开启' : '热重载已关闭', 'info', 1600);
    setStatus(state.hotReload ? '热重载：开' : '热重载：关', 'ok');
  }
}

/** 控制台开关：打开控制台面板 / 回到原来的预览视图 */
function toggleConsole() {
  const open = state.view === 'console';
  el.btnConsole.classList.toggle('on', !open);
  el.btnConsole.title = open ? '控制台 (Ctrl+J)' : '关闭控制台 (Ctrl+J)';
  if (open) {
    const session = sessionById(state.activeId);
    const back = state.lastNonConsoleView || (session && session.kind === 'code' ? 'code' : 'web');
    setView(back === 'console' ? 'web' : back);
  } else {
    state.lastNonConsoleView = state.view;
    setView('console');
  }
}

/** 左侧栏显示/隐藏：隐藏时把空间全部让给预览内容，并同步原生视图位置 */
function setSidebar(visible, { notify = true } = {}) {
  const next = Boolean(visible);
  const unchanged = state.sidebar === next
    && el.body.classList.contains('sidebar-hidden') === !next;
  state.sidebar = next;
  // 状态没变直接返回：否则会与主进程的 ui:sidebar 广播形成每帧回环（实测每秒 60 次）
  if (unchanged) return;
  el.body.classList.toggle('sidebar-hidden', !state.sidebar);
  el.sidebar.style.display = state.sidebar ? '' : 'none';
  el.divider.style.display = state.sidebar ? '' : 'none';
  el.btnSidebar.classList.toggle('on', state.sidebar);
  el.btnSidebar.title = state.sidebar ? '隐藏文件树 (Ctrl+B)' : '显示文件树 (Ctrl+B)';
  state.lastLayout = null; // 侧栏开关会改变槽位，强制重算
  requestAnimationFrame(() => syncNativeView());
  if (notify) window.api.ui.toggleSidebar(state.sidebar).catch(() => {}); // 主进程会持久化
}

async function pickFolder() {
  try {
    const result = await window.api.files.openFolder({ defaultPath: state.roots[state.roots.length - 1]?.dir });
    if (!result) return;
    state.treeCache.clear();
    state.expanded.clear();
    state.roots = (await window.api.files.roots()).roots;
    renderRoots();
    await renderTree();
    setStatus(`已打开目录 ${basename(result.root)}`, 'ok');
  } catch (err) {
    toast(`打开目录失败：${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------- 主进程事件

function wireEventsFromMain() {
  window.api.on('sessions:updated', (payload) => {
    // 防抖：一次 open 会带来多条会话更新，集中处理避免视图来回抖动
    clearTimeout(state.sessionsTimer);
    state.sessionsTimer = setTimeout(() => {
      state.sessions = payload.sessions || [];
      renderTabs();
      renderSessionList();
      const active = state.activeDraft ? null : sessionById(state.activeId);
      if (active) {
        el.address.value = active.file || active.url || '';
        if (active.kind === 'code' && state.view === 'code' && state.activeCodeSessionId !== active.sessionId) {
          renderCode(active).catch(() => {});
        }
      }
      renderTabs();
      syncNativeView();
    }, 30);
  });
  window.api.on('roots:updated', (payload) => {
    state.roots = payload.roots || [];
    renderRoots();
    state.treeCache.clear();
    renderTree().catch(() => {});
  });
  window.api.on('files:changed', () => renderTree().catch(() => {}));
  window.api.on('console:entry', (payload) => {
    if (payload.sessionId === state.activeId || !state.activeId) pushLog(payload.entry);
  });
  window.api.on('ui:view', (payload) => {
    // 防回声：这些事件常由渲染层自己发出（渲染层 → 主进程 → 广播回渲染层）。
    // 已经处于目标视图就什么都不做，否则会与本地逻辑互相切换，界面会疯狂闪烁。
    if (!payload.view || payload.view === state.view) return;
    setView(payload.view);
  });
  window.api.on('ui:focus', (payload) => {
    activateSession(payload.sessionId).catch(() => {});
  });
  window.api.on('ui:open', (payload) => {
    refreshSessions().then(() => activateSession(payload.sessionId)).catch(() => {});
  });
  window.api.on('ui:sidebar', (payload) => {
    setSidebar(payload.visible !== false, { notify: false });
  });
  window.api.on('ui:command', (payload) => {
    const command = payload.command;
    if (command === 'toggle-sidebar') setSidebar(!state.sidebar);
    if (command === 'toggle-console') toggleConsole();
    if (command === 'toggle-hot-reload') setHotReload(!state.hotReload, { notify: true });
    if (command === 'toggle-content-only') toggleContentOnly();
    if (command === 'ui-zoom-in') stepUiScale(0.1);
    if (command === 'ui-zoom-out') stepUiScale(-0.1);
    if (command === 'ui-zoom-reset') { applyUiScale(1); setStatus('界面缩放 100%', 'ok'); }
    if (command === 'open-folder') pickFolder();
    if (command === 'reload') el.navReload.click();
    if (command === 'hard-reload' && state.activeId) window.api.sessions.reload(state.activeId, true);
    if (command === 'close-tab' && state.activeId) closeSession(state.activeId);
    if (command === 'new-tab') newTab();
    if (command === 'zoom-in' || command === 'zoom-out' || command === 'zoom-reset') {
      const delta = command === 'zoom-in' ? 0.1 : command === 'zoom-out' ? -0.1 : 0;
      state.zoom = command === 'zoom-reset' ? 1 : Math.min(Math.max(state.zoom + delta, 0.3), 3);
      const session = sessionById(state.activeId);
      if (session && session.kind !== 'code' && state.runtime?.port) {
        window.api.sessions.zoom(session.sessionId, state.zoom).catch(() => {});
      } else if (state.editorView) {
        // 缩放代码预览：作用于编辑器宿主字号，CodeMirror 内部文字随之缩放
        el.editorHost.style.setProperty('--editor-font-size', `${13 * state.zoom}px`);
      }
      setStatus(`缩放 ${Math.round(state.zoom * 100)}%`, 'ok');
    }
    if (command === 'show-control-info') {
      const info = state.runtime || {};
      toast(`控制通道 ${info.socket || '-'} · 端口 ${info.port || '-'} · 令牌 ${String(info.token || '').slice(0, 8)}…`, 'info', 6000);
    }
  });
}

// ---------------------------------------------------------------- 调试快照
// 面板自检用：把 GUI 内部状态导出成 JSON（main 进程的 panelState 动作会调用它）
window.__PVS_READ__ = async (path) => {
  try {
    const result = await Promise.race([
      window.api.files.read(path),
      new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 4000)),
    ]);
    if (result && result.__timeout) return { timeout: true };
    return { chars: result.text ? result.text.length : -1, language: result.language, binary: result.binary };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
};

// 界面动作入口：把「点按钮」这类交互暴露出来，便于自动化验收与 AI 驱动
window.__PVS_ACTION__ = (action, payload = {}) => {
  switch (action) {
    case 'new-tab': newTab(); return { drafts: state.drafts.map((d) => d.id), activeDraft: state.activeDraft?.id ?? null };
    case 'close-draft': closeDraftTab(); return { drafts: state.drafts.map((d) => d.id) };
    case 'toggle-sidebar': setSidebar(!state.sidebar); return { sidebar: state.sidebar };
    case 'set-sidebar': setSidebar(payload.visible !== false); return { sidebar: state.sidebar };
    case 'set-view': setView(payload.view); return { view: state.view };
    case 'open-target': openTarget(payload.value, payload.mode); return { queued: true };
    case 'activate': activateSession(payload.sessionId); return { activeId: state.activeId };
    case 'close-tab': closeSession(payload.sessionId || state.activeId); return { closing: true };
    case 'sidebar-tab': setSideTab(payload.tab); return { side: payload.tab };
    case 'open-tree': {
      // 等价于「鼠标点文件树里的某个文件」，用于还原用户手工操作路径
      const nodes = [...document.querySelectorAll('#tree .node')];
      const target = payload.name
        ? nodes.find((node) => node.textContent.includes(payload.name))
        : nodes.find((node) => node.classList.contains('file'));
      if (!target) return { error: 'not found', available: nodes.map((n) => n.textContent.trim()).slice(0, 20) };
      target.click();
      return { clicked: target.textContent.trim() };
    }
    case 'edit-doc': {
      // 模拟用户键入：把内容替换成 payload.text（用于验证可编辑与保存链路）
      const view = state.editorView;
      if (!view) return { error: '没有编辑器' };
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: payload.text ?? '' } });
      return { dirty: Boolean(state.codeSessions.get(state.activeCodeSessionId)?.dirty), saveVisible: !document.getElementById('code-save').hidden };
    }
    case 'save': saveActiveCode(); return { saving: true };
    case 'toggle-console': toggleConsole(); return { view: state.view };
    case 'type-address': {
      // 还原用户操作：在地址栏填入内容并回车
      el.address.value = String(payload.value || '');
      el.address.focus();
      el.address.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return { value: el.address.value };
    }
    case 'hot-reload': setHotReload(payload.enabled, { notify: payload.notify !== false }); return { hotReload: state.hotReload };
    case 'content-only': toggleContentOnly(payload.visible); return { contentOnly: state.contentOnly };
    case 'ui-zoom': applyUiScale(payload.factor, { persist: false }); return { uiScale: state.uiScale };
    case 'font-report': {
      // 报告各区域实际使用的字体与字号（便于确认字体栈是否命中）
      const pick = (sel) => {
        const node = document.querySelector(sel);
        if (!node) return null;
        const cs = getComputedStyle(node);
        return { family: cs.fontFamily.split(',')[0].replace(/["']/g, ''), size: cs.fontSize, ligatures: cs.fontVariantLigatures };
      };
      return {
        editor: pick('.cm-scroller'),
        editorContent: pick('.cm-content'),
        codeHead: pick('#code-name'),
        address: pick('#address'),
        console: pick('#console-list'),
        tree: pick('#tree'),
        title: pick('.app-name'),
        hint: pick('.empty-sub'),
      };
    }
    case 'idle-stats': return {
      // 布局上报累计次数：静置时应停止增长（持续增长说明存在重排循环）
      layoutSends: state.layoutSendCount || 0,
      view: state.view,
      activeId: state.activeId,
      drafts: state.drafts.length,
      contentOnly: state.contentOnly,
      sidebar: state.sidebar,
    };
    case 'wheel-zoom': {
      // 派发真实 Ctrl+滚轮事件，验证用户操作链路
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: payload.deltaY || -100, ctrlKey: true, bubbles: true, cancelable: true }));
      return { uiScale: state.uiScale };
    }
    case 'press-escape': {
      // 派发真实键盘事件，确保验证的是用户按 Esc 的完整链路
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return { contentOnly: state.contentOnly, target: target.id || target.tagName };
    }
    case 'toggle-drawer': el.drawer.hidden = !el.drawer.hidden; syncNativeView(); return { drawer: !el.drawer.hidden };
    default: return { error: 'unknown action: ' + action };
  }
};

window.__PVS_EDITOR__ = () => {
  const view = state.editorView;
  if (!view) return { missing: true };
  const vp = view.viewport || {};
  return {
    docLines: view.state.doc.lines,
    docChars: view.state.doc.length,
    docFirstLine: view.state.doc.line(1).text.slice(0, 50),
    viewport: { from: vp.from, to: vp.to, height: vp.height },
    renderedLines: document.querySelectorAll('.cm-line').length,
    contentRect: (() => { const r = document.querySelector('.cm-content')?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null; })(),
    scrollerRect: (() => { const r = document.querySelector('.cm-scroller')?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null; })(),
    editorClass: document.querySelector('.cm-editor')?.className || null,
    display: getComputedStyle(document.querySelector('.cm-editor') || document.body).display,
    visibility: getComputedStyle(document.querySelector('.cm-editor') || document.body).visibility,
  };
};

window.__PVS_PANEL__ = () => {
  const rect = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { w: Math.round(r.width), h: Math.round(r.height), display: style.display, visibility: style.visibility };
  };
  const cmContent = document.querySelector('.cm-content');
  return {
    view: state.view,
    theme: state.theme,
    themeAttr: document.body.dataset.theme,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    openMode: state.openMode || 'web',
    uiScale: state.uiScale,
    hotReload: state.hotReload,
    contentOnly: state.contentOnly,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    dataView: document.body.dataset.view,
    activeId: state.activeId,
    activeFile: state.activeFile,
    activeCodeSession: state.activeCodeSessionId,
    root: state.roots[state.roots.length - 1]?.dir || null,
    codePane: rect(document.getElementById('code-pane')),
    editorHost: rect(document.getElementById('editor')),
    cmEditor: Boolean(document.querySelector('.cm-editor')),
    cmChars: cmContent ? cmContent.textContent.length : 0,
    cmFirstLine: (document.querySelector('.cm-line') || { textContent: '' }).textContent.slice(0, 60),
    codeName: document.getElementById('code-name').textContent,
    codeLang: document.getElementById('code-lang').textContent,
    tabs: [...document.querySelectorAll('#tabs .tab')].map((tab) => tab.textContent.trim()),
    sessions: state.sessions.map((session) => ({ id: session.sessionId, kind: session.kind, file: session.file, title: session.title })),
    roots: state.roots,
    codeSessions: [...state.codeSessions.entries()].map(([id, meta]) => ({ id, file: meta.file, chars: meta.text ? meta.text.length : 0 })),
    logs: state.logs.slice(-8).map((entry) => `${entry.level}: ${entry.text.slice(0, 120)}`),
    viewTrace: (state.viewTrace || []).slice(-12),
    execTrace: (state.execTrace || []).slice(-25),
    sendTrace: (state.sendTrace || []).slice(-12),
    recvTrace: (state.recvTrace || []).slice(-12),
  };
};

// 渲染层异常也回传主进程，便于排查（面板里不会有开发者工具翻日志的负担）
window.addEventListener('error', (event) => {
  setStatus(`渲染层错误：${event.message}`, 'error');
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
  setStatus(`渲染层异步错误：${reason}`, 'error');
});

// ---------------------------------------------------------------- 启动

async function boot() {
  try {
    state.runtime = await window.api.runtime();
  // 主进程可能已经恢复了上次的界面缩放，这里读回来保持一致
  try {
    const zoom = await window.api.ui.info();
    if (zoom && typeof zoom.zoomFactor === 'number') state.uiScale = zoom.zoomFactor;
    if (zoom && typeof zoom.hotReload === 'boolean') setHotReload(zoom.hotReload);
    if (zoom && typeof zoom.contentOnly === 'boolean') state.contentOnly = zoom.contentOnly;
    if (zoom && typeof zoom.sidebar === 'boolean') state.sidebar = zoom.sidebar;
  } catch {
    /* ignore */
  }
  } catch {
    state.runtime = {};
  }
  setStatus(`Chromium ${state.runtime.chrome || '?'} · 无头守护 ${state.runtime.mode === 'daemon' ? '开' : '关'}`, 'ok');
  applyTheme(state.theme); // 默认白天模式，同时把代码高亮同步成浅色
  ensureEditor();
  wireEvents();
  wireEventsFromMain();
  setSideTab('files');
  setConsoleTab('console');
  setOpenMode('web');
  // 默认全屏 + 隐藏文件树（可在 config.json 或运行时切换）
  toggleContentOnly(state.contentOnly, { persist: false });
  setSidebar(state.sidebar, { notify: false });
  await refreshSessions();
  renderRoots();
  await renderTree();
  setView(state.sessions.some((s) => s.kind === 'code') ? 'code' : 'web');
  syncNativeView();
  state.booted = true;
  // 补激活：启动过程中建立的会话（例如 CLI 在面板刚起来时 open 的文件）统一在这里渲染
  const toActivate = state.sessions.find((s) => s.sessionId === state.activeId) || state.sessions.find((s) => s.focused) || state.sessions[0];
  if (toActivate) await activateSession(toActivate.sessionId, { force: true });
  else setOpenMode('web');
  // 告诉主进程「面板已就绪」：此前主进程需要排队处理 open 请求
  window.api.ui.ready().catch(() => {});
  // 与主进程对齐一次布局（等首帧渲染完）
  requestAnimationFrame(() => syncNativeView());
  setTimeout(() => syncNativeView(), 300);
}

boot().catch((err) => {
  setStatus(`初始化失败：${err.message}`, 'error');
});
