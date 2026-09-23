'use strict';
// pvs CLI 参数解析（不依赖 electron，纯 Node 可单测）
const ALIASES = {
  h: 'help',
  human: 'text',
  v: 'version',
  j: 'json',
  o: 'out',
  f: 'file',
  u: 'url',
  s: 'session',
  r: 'root',
  p: 'port',
};

const BOOLEAN_FLAGS = new Set([
  'help', 'version', 'json', 'new', 'daemon', 'gui', 'headless', 'no-spawn',
  'full-page', 'hard', 'clear', 'html', 'on', 'off', 'all', 'quiet', 'verbose', 'open', 'force-daemon',
  'hot-reload', 'no-hot-reload', 'win', 'wsl',
  'fresh', 'keep', 'native-ua', 'text', 'human', 'no-json', 'detach', 'background',
  'fullscreen', 'no-fullscreen', 'show-sidebar',
]);

const VALUE_FLAGS = new Set([
  'from', 'dir', 'ext', 'format',
  'scale-factor',
  'out', 'format', 'quality', 'selector', 'session', 'root', 'port', 'line', 'column', 'timeout', 'mode', 'file', 'url', 'base64', 'input', 'identity', 'target', 'platform', 'arch',
]);

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const queue = [...argv];
  while (queue.length) {
    const token = queue.shift();
    if (token === '--') {
      out._.push(...queue);
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      let key = eq === -1 ? token.slice(2) : token.slice(2, eq);
      let value = eq === -1 ? undefined : token.slice(eq + 1);
      key = ALIASES[key] || key;
      if (value === undefined) {
        if (BOOLEAN_FLAGS.has(key)) value = true;
        else if (VALUE_FLAGS.has(key)) value = queue.shift();
        else value = true;
      }
      out.flags[key] = value;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const letters = token.slice(1).split('');
      for (let i = 0; i < letters.length; i += 1) {
        const key = ALIASES[letters[i]] || letters[i];
        if (BOOLEAN_FLAGS.has(key)) {
          out.flags[key] = true;
        } else {
          const rest = letters.slice(i + 1).join('');
          out.flags[key] = rest ? rest : queue.shift();
          break;
        }
      }
      continue;
    }
    out._.push(token);
  }
  return out;
}

/** 从 electron 的 process.argv 中剥掉 electron 自身、app 路径与脚本路径 */
function stripElectronArgv(argv) {
  const args = argv.slice();
  // args[1] 恒为 app 路径（electron . / electron /abs/path）
  if (args.length > 1 && !String(args[1]).startsWith('-')) args.splice(1, 1);
  // 兼容直接以脚本方式启动（electron src/main/main.js）
  if (args.length > 1 && /\.(m?js|cjs)$/i.test(String(args[1])) && !String(args[1]).startsWith('-')) args.splice(1, 1);
  return args.slice(1);
}

const HELP = `AIBrowser (pvs) — Chromium 网页预览 + 代码高亮预览，AI 可调用

用法:
  pvs open <file|url> [--root dir] [--new] [--json]      打开网页预览（自动识别 HTML / 目录 / URL）
                                                          --fresh 打开前关掉所有旧面板；--keep 保留旧面板
  pvs code <file> [--line n] [--json]                     打开代码高亮预览
  pvs list [--json]                                       列出会话与已打开的项目目录
  pvs shot [sessionId] [--out file] [--format png|jpeg] [--full-page] [--selector css] [--json]
                                                          截图（无头也能截）
  pvs content [sessionId] [--selector css] [--html] [--json]   取渲染后的文本 / HTML
  pvs eval "<js>" [--session id] [--json]                 在页面里执行 JS
  pvs console [sessionId] [--clear] [--json]              读取控制台日志
  pvs packages [--target win32|linux|darwin] [--arch x64]  列出打包产物（AI 按平台挑应用文件）
  pvs tree [dir] [--all] [--json]                         列出目录（默认忽略 node_modules/.git 等）
  pvs debugWatch [--json]                                 热重载当前关注哪些文件（tab 文件 + 页面引用的资源）
  pvs network [sessionId] [--on|--off] [--clear] [--json] 网络请求记录
  pvs reload [sessionId] [--hard] [--json]                重新加载
  pvs close [sessionId|--all] [--json]                    关闭会话
  pvs status [--json]                                     控制入口状态（端口 / pid / socket / token）

 输出格式：默认按「有没有终端」判断 —— 管道/重定向捕获（AI、脚本）用单行 JSON，终端里用人读文本；
           --json / --text（--human）/ AIBROWSER_FORMAT=json|text 可强制。
  pvs serve [--gui] [--port n] [--native-ua] [--detach]   常驻服务：--gui 开面板窗口，否则无头守护
                                                          --detach 拉起后立刻返回（不等就绪，自己轮询 status）
                                                          --native-ua 保留 Electron 原始 UA（默认伪装成同版本 Chrome）
  pvs stop                                                关闭常驻服务

通用参数:
  --json        以单行 JSON 输出（给脚本 / AI 解析）
  --daemon      强制使用/启动无头实例（忽略已开的面板）
  --gui         强制在 GUI 面板中操作（没有则启动面板）
  --no-spawn    目标不可用时直接失败，不自动拉起进程
  --port n      指定控制端口
  --quiet       静默模式，只输出结果

环境变量:
  AIBROWSER_RUNTIME   控制通道目录（默认 $XDG_RUNTIME_DIR/aibrowser）
  AIBROWSER_PORT      固定控制端口
  AIBROWSER_TOKEN     固定控制令牌
`;

module.exports = { parseArgs, stripElectronArgv, HELP, BOOLEAN_FLAGS, VALUE_FLAGS };
