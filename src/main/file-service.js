'use strict';
// 文件系统服务：根目录授权、目录树、读写文件。
// 所有对外暴露的路径都必须是某个已授权根目录下的文件（防越权读取）。
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { detectLanguage, isWebPreviewable } = require('./language');

const MAX_READ_BYTES = 4 * 1024 * 1024; // 代码预览上限
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.cache', 'dist', '.next', '__pycache__', '.venv', 'venv', '.idea']);

class FileService {
  constructor() {
    /** @type {Map<string, {id:string, dir:string, addedAt:number}>} */
    this.roots = new Map();
    this.counter = 0;
  }

  addRoot(dir) {
    const resolved = path.resolve(dir);
    for (const root of this.roots.values()) {
      if (root.dir === resolved) return { root: root.dir, id: root.id };
    }
    this.counter += 1;
    const id = `r${this.counter}`;
    this.roots.set(id, { id, dir: resolved, addedAt: Date.now() });
    return { root: resolved, id };
  }

  /** 以某个文件所在目录建立临时根目录（用于无根目录时直接预览文件） */
  addRootFor(dirOrFile, isFile = false) {
    const dir = isFile ? path.dirname(dirOrFile) : dirOrFile;
    return this.addRoot(dir);
  }

  listRoots() {
    return [...this.roots.values()].map(({ id, dir }) => ({ id, dir }));
  }

  rootFor(id) {
    return this.roots.get(id);
  }

  /** 找到包含该路径的根目录（最长的那个） */
  rootContaining(target) {
    const resolved = path.resolve(target);
    let best = null;
    for (const root of this.roots.values()) {
      const rel = path.relative(root.dir, resolved);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        if (!best || root.dir.length > best.dir.length) best = root;
      }
    }
    return best;
  }

  /** 校验路径：必须在某个根目录内，否则抛错 */
  assertAllowed(target) {
    const resolved = path.resolve(target);
    const root = this.rootContaining(resolved);
    if (!root) {
      const err = new Error(`路径不在任何已打开的项目目录内：${resolved}`);
      err.code = 'ENOTALLOWED';
      throw err;
    }
    return { resolved, root };
  }

  async stat(target) {
    try {
      const info = await fs.stat(target);
      return { path: path.resolve(target), exists: true, dir: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return { path: path.resolve(target), exists: false, dir: false, size: 0 };
    }
  }

  /** 列目录（供文件树），目录在前、按名称排序，跳过重目录 */
  async tree(dir, { includeIgnored = false } = {}) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const hidden = entry.name.startsWith('.');
      if (entry.isDirectory() && !includeIgnored && IGNORED_DIRS.has(entry.name)) continue;
      let size = 0;
      if (entry.isFile()) {
        try {
          size = (await fs.stat(full)).size;
        } catch {
          size = 0;
        }
      }
      out.push({
        name: entry.name,
        path: full,
        dir: entry.isDirectory(),
        size,
        hidden,
        isPreview: entry.isFile() && isWebPreviewable(full),
      });
    }
    out.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
    });
    return out;
  }

  async read(target, { maxBytes = MAX_READ_BYTES } = {}) {
    const { resolved } = this.assertAllowed(target);
    const info = await fs.stat(resolved);
    if (info.isDirectory()) throw new Error(`是目录，不是文件：${resolved}`);
    const buf = await fs.readFile(resolved);
    let text = '';
    let binary = false;
    let truncated = false;
    if (buf.includes(0)) {
      binary = true;
    } else {
      truncated = buf.length > maxBytes;
      text = buf.subarray(0, maxBytes).toString('utf8');
      // 替换非法控制字符，避免编辑器渲染异常
      text = text.replace(/\u0000/g, '');
    }
    const lang = detectLanguage(resolved);
    return {
      path: resolved,
      name: path.basename(resolved),
      size: info.size,
      binary,
      text,
      language: lang.id,
      languageLabel: lang.label,
      truncated,
    };
  }

  async write(target, text) {
    const { resolved } = this.assertAllowed(target);
    await fs.writeFile(resolved, String(text ?? ''), 'utf8');
    const info = await fs.stat(resolved);
    return { path: resolved, bytes: info.size };
  }

  /** 供预览协议使用：把根目录 + 相对路径解析为绝对路径（含目录 index.html 回退） */
  async resolveInRoot(rootId, urlPath) {
    const root = this.roots.get(rootId);
    if (!root) return null;
    const clean = decodeURIComponent(String(urlPath || '/').split('?')[0].split('#')[0]);
    const rel = clean.replace(/^\/+/, '');
    const abs = path.resolve(root.dir, rel);
    const relCheck = path.relative(root.dir, abs);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null; // 目录穿越
    if (!fssync.existsSync(abs)) return null;
    let file = abs;
    let stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      const index = path.join(abs, 'index.html');
      if (!fssync.existsSync(index)) return null;
      file = index;
      stat = await fs.stat(index);
    }
    return { file, size: stat.size, root: root.dir, mime: mimeFor(file) };
  }

  /** 生成 pvs:// URL */
  urlFor(rootId, file) {
    const root = this.roots.get(rootId);
    if (!root) return null;
    const rel = path.relative(root.dir, file).split(path.sep).map(encodeURIComponent).join('/');
    return `pvs://${rootId}/${rel}`;
  }
}

const MIME = {
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml', svg: 'image/svg+xml',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  json: 'application/json', map: 'application/json', txt: 'text/plain', md: 'text/markdown',
  xml: 'application/xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  pdf: 'application/pdf', wasm: 'application/wasm', csv: 'text/csv', webmanifest: 'application/manifest+json',
};

function mimeFor(file) {
  const ext = String(file).split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function defaultRoot() {
  return process.env.PREVIEW_STUDIO_ROOT || process.cwd() || os.homedir();
}

module.exports = { FileService, mimeFor, MAX_READ_BYTES, defaultRoot, IGNORED_DIRS };
