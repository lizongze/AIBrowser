'use strict';
// pvs:// 协议：把已授权根目录下的本地文件交给 Chromium 渲染，
// 并为 HTML 注入「控制台采集 + 网络上报 + 热重载 + 元素拾取」脚本。
const fs = require('node:fs/promises');
const path = require('node:path');
const { protocol, net } = require('electron');
const { mimeFor } = require('./file-service');

const SCHEME = 'pvs';
const PREVIEW_PARTITION = 'persist:pvs';

/** 必须在 app ready 之前调用 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * 生成注入脚本。参数经 JSON 序列化后内联，注意转义 `</script>`。
 * @param {{sessionId:string, endpoint:string, token:string, reload:number}} ctx
 */
function injectionScript({ sessionId, endpoint, token, reload }) {
  const cfg = JSON.stringify({ sessionId, endpoint, token, reload });
  return `<script data-pvs-injected="1">(function(){
var CFG = ${cfg};
if (window.__PVS__) return;
var MAX = 400;
function safe(v, depth){
  try {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'object') {
      depth = depth || 0;
      if (depth > 2) return '[Object]';
      if (v.nodeType === 1) return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + '>';
      var out = Array.isArray(v) ? [] : {};
      var keys = Object.keys(v).slice(0, 20);
      for (var i = 0; i < keys.length; i++) {
        try { out[keys[i]] = safe(v[keys[i]], depth + 1); } catch (e) { out[keys[i]] = '[circular]'; }
      }
      return out;
    }
    return String(v);
  } catch (e) { return '[unserializable]'; }
}
function send(payload){
  try {
    var body = JSON.stringify(payload);
    // 注意：不用 navigator.sendBeacon —— 它固定以 credentials:'include' 发送，
    // 会被 CORS 的 wildcard allow-origin 拒绝。fetch + keepalive 语义相同且无凭证。
    fetch(CFG.endpoint + '/__pvs/event?token=' + encodeURIComponent(CFG.token), {
      method: 'POST',
      body: body,
      keepalive: true,
      headers: { 'content-type': 'text/plain;charset=UTF-8' }
    }).catch(function(){});
  } catch (e) {}
}
var api = {
  sessionId: CFG.sessionId,
  push: function(level, args){
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var t = safe(args[i]);
      parts.push(typeof t === 'string' ? t : JSON.stringify(t));
    }
    send({ kind:'console', level: level, text: parts.join(' '), url: location.href });
  },
  reload: function(){ location.reload(); }
};
window.__PVS__ = api;
['log','info','warn','error','debug'].forEach(function(level){
  var orig = console[level] ? console[level].bind(console) : function(){};
  console[level] = function(){
    api.push(level, arguments);
    try { orig.apply(null, arguments); } catch (e) {}
  };
});
window.addEventListener('error', function(e){
  api.push('error', [ (e.message || 'Error') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0) ]);
}, true);
window.addEventListener('unhandledrejection', function(e){
  api.push('error', ['Unhandled promise rejection: ' + safe(e.reason)]);
});
var origFetch = window.fetch;
if (origFetch) {
  window.fetch = function(input, init){
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var method = (init && init.method) || (input && input.method) || 'GET';
    var started = performance.now();
    return origFetch.apply(this, arguments).then(function(res){
      send({ kind:'network', method: method.toUpperCase(), url: url, status: res.status, resourceType:'fetch', ok: res.ok, durationMs: Math.round(performance.now() - started) });
      return res;
    }, function(err){
      send({ kind:'network', method: method.toUpperCase(), url: url, status: 0, resourceType:'fetch', ok: false, error: String(err), durationMs: Math.round(performance.now() - started) });
      throw err;
    });
  };
}
// 热重载：优先 WebSocket（控制服务提供），失败则退化为轮询 reload 计数
if (CFG.reload) {
  var connect = function(){
    var proto = CFG.endpoint.indexOf('https:') === 0 ? 'wss:' : 'ws:';
    var ws;
    try { ws = new WebSocket(CFG.endpoint.replace(/^https?:/, proto) + '/__pvs/ws?token=' + encodeURIComponent(CFG.token) + '&session=' + encodeURIComponent(CFG.sessionId)); } catch (e) { return; }
    ws.onmessage = function(ev){
      try {
        var msg = JSON.parse(ev.data);
        if (msg.kind === 'reload') api.reload();
      } catch (e) {}
    };
    ws.onclose = function(){ setTimeout(connect, 1500); };
  };
  connect();
}
})();</script>`;
}

function injectIntoHtml(html, ctx, baseHref) {
  const base = baseHref ? `<base href="${escapeAttr(baseHref)}">` : '';
  const head = `${base}${injectionScript(ctx)}`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, (m) => `${m}${head}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, (m) => `${m}<head>${head}</head>`);
  return head + html;
}

function errorPage(status, message, detail) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview Studio · ${status}</title>
<style>
 body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#c9d1d9;
      font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
 .box{max-width:560px;padding:24px 28px;border:1px solid #30363d;border-radius:8px;background:#161b22}
 h1{margin:0 0 8px;font-size:14px;color:#f85149;letter-spacing:.04em}
 pre{margin:12px 0 0;padding:10px;background:#0d1117;border:1px solid #21262d;border-radius:6px;white-space:pre-wrap;color:#8b949e}
</style></head><body><div class="box"><h1>${status} · ${message}</h1>
<div>若要从预览访问该文件，请先把它所在的目录作为项目根目录打开（pvs open --root &lt;dir&gt;）。</div>
${detail ? `<pre>${String(detail).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</pre>` : ''}</div></body></html>`;
}

/**
 * 注册 pvs:// 处理器。
 * @param {{files: import('./file-service').FileService, manager: {get:(id:string)=>any, endpoint:()=>string, token:()=>string, reloadEnabled:()=>boolean}}} deps
 */
function registerHandler(deps) {
  const session = require('electron').session.fromPartition(PREVIEW_PARTITION);
  const handler = async (request) => {
    try {
      const url = new URL(request.url);
      const rootId = url.hostname || url.host;
      const resolved = await deps.files.resolveInRoot(rootId, url.pathname);
      if (!resolved) {
        return new Response(errorPage(404, 'Not Found', `pvs://${rootId}${url.pathname}`), {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      const mime = resolved.mime || mimeFor(resolved.file);
      const isHtml = /text\/html|application\/xhtml/.test(mime);
      if (isHtml) {
        const raw = await fs.readFile(resolved.file, 'utf8');
        const relDir = path.relative(resolved.root, path.dirname(resolved.file)).split(path.sep).filter(Boolean)
          .map(encodeURIComponent).join('/');
        const baseHref = `pvs://${rootId}/${relDir ? `${relDir}/` : ''}`;
        const html = injectIntoHtml(raw, {
          sessionId: url.searchParams.get('__pvsSession') || '',
          endpoint: deps.endpoint(),
          token: deps.token(),
          reload: deps.reloadEnabled() ? 1 : 0,
        }, baseHref);
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      // 其它资源：流式回源，避免大文件全量进内存
      const response = await net.fetch(`file://${resolved.file}`);
      const headers = new Headers(response.headers);
      headers.set('content-type', mime);
      headers.set('cache-control', 'no-cache');
      return new Response(response.body, { status: response.status, headers });
    } catch (err) {
      return new Response(errorPage(500, 'Preview Error', err && err.stack ? err.stack : String(err)), {
        status: 500,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
  };
  session.protocol.handle(SCHEME, handler);
  return { session, handler, unregister: () => session.protocol.unhandle(SCHEME) };
}

module.exports = { SCHEME, PREVIEW_PARTITION, registerScheme, registerHandler, injectionScript, injectIntoHtml, errorPage };
