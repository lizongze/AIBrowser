#!/usr/bin/env node
'use strict';
// AIBrowser 的 MCP server（stdio，无第三方依赖）。
//
// 用途：让支持 MCP 的 agent 直接把「打开网页/文件、批量截图、取渲染内容、执行 JS、读报错」
// 当作工具调用，而不需要拼 shell 命令。
//
// 约定：
//   - stdout 只输出 JSON-RPC（逐行 JSON），所有日志走 stderr
//   - 批量能力以「列表参数」为一等公民：items: [{url|file, name?, fullPage?, waitFor?, content?, viewport?}]
//
// 配置示例（Claude Code / Cursor 等）：
//   {
//     "mcpServers": {
//       "aibrowser": {
//         "command": "node",
//         "args": ["/abs/path/to/aibrowser/src/main/mcp/server.js"],
//         "env": { "PVS_HOME": "/abs/path/to/aibrowser" }
//       }
//     }
//   }
const path = require('node:path');
const fs = require('node:fs');

const { send, ensureTarget, stopTarget, resolveTarget } = require('../cli/client');
const { readState } = require('../control/state');

const SERVER_INFO = { name: 'aibrowser', version: require('../../../package.json').version };
const PROTOCOL_VERSION = '2024-11-05';

const log = (message) => process.stderr.write(`[aibrowser-mcp] ${message}\n`);

// ---------------------------------------------------------------- 工具定义

const ITEM_SCHEMA = {
  anyOf: [
    { type: 'string', description: '要打开的 URL 或本地文件路径（无需区分类型）' },
    {
      type: 'object',
      properties: {
        url: { type: 'string', description: '网页地址' },
        file: { type: 'string', description: '本地文件路径（HTML 等）' },
        name: { type: 'string', description: '输出文件名（缺省自动推导）' },
        root: { type: 'string', description: '本地文件的授权根目录（缺省取父目录）' },
        fullPage: { type: 'boolean', description: '是否整页截图，默认 true' },
        waitFor: { type: 'string', description: '等待该 CSS 选择器出现后再截图' },
        waitMs: { type: 'number', description: '额外固定等待毫秒数' },
        content: { type: 'string', description: '额外提取该选择器的可见文本' },
        viewport: {
          type: 'object',
          properties: { width: { type: 'number' }, height: { type: 'number' } },
          description: '单尺寸截图视口，默认 1280×800（一般不用传）',
        },
        viewports: {
          type: 'array',
          items: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } },
          description: '仅当用户明确要求多种屏幕尺寸时才传：每个尺寸出一张图',
        },
        skip: { type: 'boolean', description: '跳过该项' },
      },
    },
  ],
};

const TOOLS = [
  {
    name: 'browser_open',
    description: '打开网页或本地文件（真实 Chromium 渲染），返回会话 id、类型与标题。直接传 target 即可，不需要判断它是文件还是 URL；HTML/SVG 走网页预览，其它文件走代码预览。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '要打开的目标：网页地址、本地文件路径或目录（Windows 路径如 D:\\dir\\a.html 也支持）' },
        root: { type: 'string', description: '授权根目录（可选；本地文件的相对资源需要）' },
        force: { type: 'string', enum: ['web', 'code'], description: '强制预览方式，一般不用传' },
      },
      required: ['target'],
    },
  },
  {
    name: 'browser_batch',
    description: '批量：给一份 URL/文件清单，串行逐个打开并截图，返回结果清单（每项含截图路径、尺寸与可选文本）。默认每项只出一张整页图；只有用户明确要求多尺寸时才在项里加 viewports。适合「一次处理很多页面」而非逐个调用。',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: ITEM_SCHEMA, description: '目标清单（字符串或对象）' },
        outDir: { type: 'string', description: '截图输出目录，默认 ./aibrowser-shots' },
        fullPage: { type: 'boolean', description: '默认是否整页截图，默认 true' },
        timeout: { type: 'number', description: '单项超时毫秒数，默认 20000' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式，默认 png' },
      },
      required: ['items'],
    },
  },
  {
    name: 'browser_content',
    description: '取页面渲染后的内容（不是原始 HTML）：默认整页可见文本，可指定 CSS 选择器，或取 outerHTML。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器，缺省为整页' },
        format: { type: 'string', enum: ['text', 'html'], description: 'text（默认）或 html' },
        sessionId: { type: 'string', description: '会话 id，缺省用最近打开的' },
      },
    },
  },
  {
    name: 'browser_eval',
    description: '在页面里执行 JavaScript 并返回结果（序列化为字符串）。用于读取数据、触发交互、断言渲染结果。',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '要执行的 JS 表达式或语句块' },
        sessionId: { type: 'string', description: '会话 id，缺省用最近打开的' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_screenshot',
    description: '对当前页面截图。可整页、可只截某个 CSS 选择器对应的元素。返回文件路径与尺寸。',
    inputSchema: {
      type: 'object',
      properties: {
        out: { type: 'string', description: '输出文件路径（缺省写到临时目录）' },
        fullPage: { type: 'boolean', description: '是否整页，默认 false' },
        selector: { type: 'string', description: '只截该 CSS 选择器对应的元素' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: '默认 png' },
        sessionId: { type: 'string', description: '会话 id，缺省用最近打开的' },
      },
    },
  },
  {
    name: 'browser_console',
    description: '读取页面的控制台日志与运行时错误。定位前端问题时先调它。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        clear: { type: 'boolean', description: '读完后是否清空' },
      },
    },
  },
  {
    name: 'browser_network',
    description: '读取页面的网络请求记录（可开关记录、可清空）。',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: '是否开启记录' },
        clear: { type: 'boolean' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_read_file',
    description: '读取本地文件内容（带语言识别），用于查看代码或配置。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件路径' },
        maxLength: { type: 'number', description: '最多返回多少字符，默认 60000' },
      },
      required: ['file'],
    },
  },
  {
    name: 'browser_write_file',
    description: '写入本地文件（覆盖）。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的完整内容' },
      },
      required: ['file', 'content'],
    },
  },
  {
    name: 'browser_sessions',
    description: '列出当前所有预览会话与已授权的项目目录。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_health',
    description: '检查后台服务状态（是否运行、端口、版本、平台）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------- 动作调用

async function call(action, params = {}, { spawnIfNeeded = true } = {}) {
  let state = readState();
  const alive = await resolveTarget({ prefer: 'auto' });
  if (!alive.ok) {
    if (!spawnIfNeeded) throw new Error('后台服务未运行（ENOUNREACHABLE）');
    ({ state } = await ensureTarget({ mode: 'auto', quiet: true }));
  } else {
    state = alive.state;
  }
  return send(action, params, { state, timeoutMs: 1000 * 60 * 30 });
}

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

async function handleTool(name, args) {
  switch (name) {
    case 'browser_open': {
      // 统一入口：target 是什么就打开什么；file/url 仍兼容旧调用
      const result = await call('open', {
        target: args.target,
        url: args.target === undefined ? args.url : undefined,
        file: args.target === undefined ? args.file : undefined,
        root: args.root,
        force: args.force,
      });
      return textResult(result);
    }
    case 'browser_batch': {
      const items = Array.isArray(args.items) ? args.items : [];
      if (!items.length) return textResult({ ok: false, error: 'items 不能为空' });
      const report = await call('batch', {
        items,
        outDir: args.outDir || 'aibrowser-shots',
        fullPage: args.fullPage !== false,
        format: args.format === 'jpeg' ? 'jpeg' : 'png',
        timeout: args.timeout,
      });
      // 给 agent 一个紧凑摘要 + 完整清单路径，避免一次性灌入过多 token
      const summary = {
        ok: report.ok,
        total: report.total,
        succeeded: report.succeeded,
        failed: report.failed,
        skipped: report.skipped,
        elapsedMs: report.elapsedMs,
        outDir: report.outDir,
        reportPath: report.reportPath,
        items: report.items.map((i) => ({
          index: i.index,
          name: i.name,
          ok: i.ok,
          image: i.image,
          size: i.ok ? `${i.width}×${i.height}` : undefined,
          title: i.title,
          content: i.content,
          error: i.error,
        })),
      };
      return textResult(summary);
    }
    case 'browser_content': {
      const result = await call('content', {
        sessionId: args.sessionId,
        selector: args.selector,
        format: args.format === 'html' ? 'html' : 'text',
      });
      return textResult(result.text);
    }
    case 'browser_eval': {
      const result = await call('eval', { expression: args.expression, sessionId: args.sessionId });
      return textResult(result.value);
    }
    case 'browser_screenshot': {
      const params = {
        sessionId: args.sessionId,
        fullPage: Boolean(args.fullPage),
        selector: args.selector,
        format: args.format === 'jpeg' ? 'jpeg' : 'png',
      };
      const result = await call('screenshot', params);
      return textResult({
        filePath: result.filePath,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        format: result.format,
      });
    }
    case 'browser_console': {
      const result = await call('console', { sessionId: args.sessionId, clear: Boolean(args.clear) });
      return textResult(result.entries);
    }
    case 'browser_network': {
      const result = await call('network', {
        sessionId: args.sessionId,
        enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
        clear: Boolean(args.clear),
      });
      return textResult(result);
    }
    case 'browser_read_file': {
      const result = await call('read', { file: args.file, maxLength: args.maxLength });
      return textResult({ file: result.path, language: result.language, size: result.size, text: result.text });
    }
    case 'browser_write_file': {
      const result = await call('save', { file: args.file, content: args.content });
      return textResult(result);
    }
    case 'browser_sessions': {
      const result = await call('list', {});
      return textResult(result);
    }
    case 'browser_health': {
      const state = readState();
      const alive = state ? await resolveTarget({ prefer: 'auto' }) : { ok: false };
      return textResult({
        running: Boolean(alive.ok),
        mode: alive.ok ? alive.state.mode : null,
        port: alive.ok ? alive.state.port : null,
        version: alive.ok ? alive.state.version : null,
        socket: alive.ok ? alive.state.socket : null,
      });
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC over stdio

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message, data) {
  write({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'AIBrowser：用真实 Chromium 打开网页/本地文件，取渲染内容、执行 JS、截图、读报错。批量场景请用 browser_batch 一次传清单。',
    });
    return;
  }
  if (method === 'notifications/initialized' || (method && method.startsWith('notifications/'))) return;
  if (method === 'ping') {
    respond(id, {});
    return;
  }
  if (method === 'tools/list') {
    respond(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const result = await handleTool(name, args);
      respond(id, result);
    } catch (err) {
      // 工具级错误按 MCP 约定放在 content 里，让模型能读到并自行纠正
      respond(id, {
        content: [{ type: 'text', text: `错误：${err && err.message ? err.message : String(err)}` }],
        isError: true,
      });
    }
    return;
  }
  if (id !== undefined) respondError(id, -32601, `不支持的方法：${method}`);
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        log(`非法 JSON：${err.message}`);
        continue;
      }
      handleMessage(message).catch((err) => {
        if (message && message.id !== undefined) respondError(message.id, -32603, String(err && err.message ? err.message : err));
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
  log(`已启动（stdio）· version ${SERVER_INFO.version} · PVS_HOME=${process.env.PVS_HOME || '(未设置)'}`);
}

module.exports = { TOOLS, handleTool, main };

// 直接 `node server.js` 时自动启动；被 bin 包装 require 时由包装调用 main()
if (require.main === module) main();
