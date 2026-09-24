#!/usr/bin/env node
// 端到端验收：启动 GUI → 打开代码/网页/控制台 → 校验渲染结果 → 关闭。
// 用法：node scripts/verify.mjs   （需要先 npm run build）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// ESM 里没有 require：判断「真实 electron 二进制」路径时要用它（.bin/electron 是 node shim）
const require = createRequire(import.meta.url);

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
  // WSLg 下偶发 X/窗口层抖动会让单次请求直接 fetch failed；这类瞬时断连重试一次，
  // 真死了（进程退出）重试还是会失败，不会掩盖问题。
  let response;
  for (let attempt = 0; ; attempt += 1) {
    const state = readState();
    if (!state) throw new Error('控制入口未就绪');
    try {
      response = await fetch(`http://127.0.0.1:${state.port}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pvs-token': state.token },
        body: JSON.stringify(params),
      });
      break;
    } catch (err) {
      if (attempt >= 1) throw err;
      await sleep(600);
    }
  }
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

  // ---- 启动路径（静态检查）----
  // 目标：别人（别的 AI）第一次用就能起得来，不靠「记住某条命令」。
  // 实测在 agent 的 shell 里唯一稳的起法是 PowerShell 的 Start-Process（直接 spawn 会让调用方
  // 一直等这条进程链），所以源码里必须处处是这条路：CLI 的 serve/自动拉起 + 打包版 pvs.cmd。
  {
    const { serviceArgs } = require(path.join(root, 'src', 'main', 'cli', 'client.js'));
    const guiArgs = serviceArgs({ gui: true });
    const headArgs = serviceArgs({ gui: false });
    check(guiArgs.includes('--serve') && guiArgs.includes('--gui') && guiArgs.includes('--json'),
      'CLI 拉起服务用 --serve --gui --json', guiArgs.join(' '));
    check(headArgs.includes('--serve') && headArgs.includes('--headless'), '无头模式用 --serve --headless', headArgs.join(' '));
    const clientSrc = fs.readFileSync(path.join(root, 'src', 'main', 'cli', 'client.js'), 'utf8');
    check(clientSrc.includes('Start-Process -FilePath') && clientSrc.includes('AIBROWSER_LAZY_STARTED'),
      'CLI 在 Windows 走 Start-Process，并等待 shim 的惰性启动（不重复拉起）');
    const pkgSrc = fs.readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8');
    // 锚在 shim 那段数组字面量上（`platform === 'win32'` 在文件里出现 9 次，取第一个会切错地方）
    const shimAnchor = pkgSrc.indexOf("const lines = platform === 'win32'");
    const cmdTemplate = pkgSrc.slice(pkgSrc.indexOf('[', shimAnchor), pkgSrc.indexOf('\n    ]', shimAnchor));
    check(cmdTemplate.includes(':lazy_start') && cmdTemplate.includes('Start-Process -FilePath'),
      '打包版 pvs.cmd 首次调用时自己拉起服务');
    check(cmdTemplate.includes('AIBROWSER_NO_AUTO_START') && cmdTemplate.includes('state.json'),
      'pvs.cmd 的惰性启动可关掉，且已有服务时不重复拉起');
    check(!/^\s*'.*[^\x00-\x7F].*',$/m.test(cmdTemplate),
      'pvs.cmd 模板是纯 ASCII（cmd.exe 按控制台代码页解析，非 ASCII 会炸）');
    const ensureSrc = fs.readFileSync(path.join(root, 'skills', 'aibrowser', 'scripts', 'ensure-service.sh'), 'utf8');
    check(!ensureSrc.includes('--detach'), 'ensure-service.sh 不再传已删除的 --detach');
    const shSrc = fs.readFileSync(path.join(root, 'skills', 'aibrowser', 'scripts', 'pvs.sh'), 'utf8');
    check(/AIBROWSER_NO_AUTO_START/.test(shSrc) && /''\s*\|\s*stop\s*\|\s*serve\s*\|\s*status/.test(shSrc),
      'pvs.sh 的惰性启动与 pvs.cmd 同一份名单（查询类命令不起服务）');
    const psSrc = fs.readFileSync(path.join(root, 'skills', 'aibrowser', 'scripts', 'serve.ps1'), 'utf8');
    check(psSrc.includes("'--serve', '--gui', '--json'"), 'serve.ps1 与 pvs.cmd 用同一套启动参数');
    check(!/[^\x00-\x7F]/.test(psSrc), 'serve.ps1 是纯 ASCII（PowerShell 5.1 按 ANSI 读非 BOM 脚本）');
    // 单实例 + 不再「默默顶掉对方」：这是「重复启动互相顶掉、状态来回跳」的根因，必须锁住行为
    const mainSrc = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8');
    check(mainSrc.includes('requestSingleInstanceLock') && mainSrc.includes('existingInstance'),
      '应用是单实例：重复启动直接退出，并拒绝顶掉正在服务的那一个');
    const serverSrc = fs.readFileSync(path.join(root, 'src', 'main', 'control', 'server.js'), 'utf8');
    check(/adopt: takeover/.test(serverSrc) && serverSrc.includes('if (this.socketBound || !this.existingInstance)'),
      '控制通道：默认不接管，且只在真正持有时才写 state.json（不再覆盖别人的状态）');
    const cliSrc2 = fs.readFileSync(path.join(root, 'src', 'main', 'cli', 'index.js'), 'utf8');
    check(cliSrc2.includes('starting: true') && cliSrc2.includes('logTail') && cliSrc2.includes('stuck'),
      'status 会区分「正在启动 / 卡死」并带上日志尾巴与 hint（调用方不用猜、也不用无限等）');
    // serve 与 status 必须用同一套字段名：曾经 serve 回 spawning/ready、note 却让人等 running，
    // 调用方的等待条件永远不成立 → 一直等。这条断言就是防它复发。
    check(!/spawning: true/.test(cliSrc2) && /running: false,\s*\n\s*starting: true/.test(cliSrc2),
      'serve 的字段与 status 同一套（running / starting / spawned），不再自创 spawning / ready');
    const clientSrc2 = fs.readFileSync(path.join(root, 'src', 'main', 'cli', 'client.js'), 'utf8');
    check(/START_WINDOW_MS = \d+/.test(clientSrc2) && clientSrc2.includes('recentMs = START_WINDOW_MS'),
      '「启动窗口」有唯一定义：status 说 stuck 时，serve/ensureTarget 就会清掉重来');
  }

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

  // 第二个实例必须自己退出，且不能把正在服务的这个顶掉。
  // （这条是「agent 重试 serve / 双击 / shim 惰性启动 → 多实例互相顶掉 → 状态来回跳」的直接回归测试。）
  const second = spawnSync(electron, [...launchArgs, '--headless'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
  });
  const stillState = readState();
  const stillAlive = Boolean(stillState) && (() => {
    try {
      process.kill(stillState.pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  check(
    second.status === 0 && String(second.stderr || '').includes('单实例') && stillAlive && stillState.pid === state.pid,
    '再开一个实例会自己退出，且不顶掉正在服务的那个',
    `exit=${second.status} 原实例 ${state.pid} ${stillAlive ? '仍在' : '没了'}`,
  );
  const samePort = await api('panelState').then(() => true).catch(() => false);
  check(samePort, '第二个实例没有打断控制通道', `端口 ${state.port}`);

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

  // 代码区头部：文件名 → 类型 → 地址（截图时能看出代码在项目中的位置）
  const [nameSeg, langSeg, pathSeg] = panel.state.codeHead || [];
  check(
    [nameSeg, langSeg, pathSeg].every((seg) => seg && seg.visible),
    '代码区头部三段（文件名/类型/地址）都可见',
    (panel.state.codeHead || []).map((seg) => `${seg.id}@${seg.left}–${seg.right}`).join(' · '),
  );
  check(
    nameSeg && langSeg && pathSeg && nameSeg.right <= langSeg.left && langSeg.right <= pathSeg.left,
    '地址排在文件名与类型之后',
    `${nameSeg?.text} → ${langSeg?.text} → ${pathSeg?.text}`,
  );
  const expectedRel = path.relative(root, codeFile).split(path.sep).join('/');
  check(
    pathSeg && pathSeg.text === expectedRel,
    '地址为项目内相对路径（保留目录层级）',
    `${pathSeg?.text} vs ${expectedRel}`,
  );

  // 空间不足时从左侧省略目录，保留文件名一侧
  // 深路径放在项目内（临时目录），保证文件树根目录不变，用例结束即清理
  const deepDir = path.join(root, '.aibrowser', 'deep-verify');
  const deepFile = path.join(deepDir, ...Array.from({ length: 8 }, (_, i) => `level-${i}-nested-directory`), 'deep-target.js');
  fs.mkdirSync(path.dirname(deepFile), { recursive: true });
  fs.writeFileSync(deepFile, "const deepTarget = 'ok';\n", 'utf8');
  await api('openCode', { file: deepFile });
  const deepPanel = await waitFor(async () => {
    const s = await api('panelState');
    return s.state.codePath && s.state.codePath.includes('deep-target.js') ? { ok: true, state: s.state } : null;
  }, { label: '深路径提示' });
  const deepPathSeg = (deepPanel.state?.codeHead || [])[2] || {};
  const deepFullRel = path.relative(root, deepFile).split(path.sep).join('/');
  check(
    deepPathSeg.text.startsWith('…/')
      && deepPathSeg.text.endsWith('deep-target.js')
      && deepPathSeg.text !== deepFullRel,
    '长路径从左侧省略且保留文件名',
    `文本=${JSON.stringify(deepPathSeg.text)}（省略了前 ${deepFullRel.split('/').length - deepPathSeg.text.split('/').length} 段）`,
  );
  fs.rmSync(deepDir, { recursive: true, force: true });
  await api('openCode', { file: codeFile });
  await waitFor(async () => {
    const s = await api('panelState');
    return s.state.codePath === expectedRel ? { ok: true } : { ok: false };
  }, { label: '恢复项目内文件' });

  // 网页预览
  await api('open', { file: htmlFile });
  await sleep(1800);
  const webPanel = await api('panelState');
  check(webPanel.state.view === 'web', '打开 HTML 后切回网页视图', webPanel.state.view);
  const evaluated = await api('eval', { expression: '({ cards: document.querySelectorAll(".card").length, title: document.title })' });
  const value = JSON.parse(evaluated.value);
  check(value.cards === 3, 'Chromium 渲染出页面结构', `${value.cards} 张卡片`);
  check(value.title.includes('AIBrowser'), '页面标题正确', value.title);

  // 浏览器身份：默认对外伪装成同版本 Chrome，且 UA / Client Hints / navigator 三处一致
  const ping = await api('ping');
  check(
    ping.identity?.mode === 'chrome' && !/Electron|AIBrowser/.test(ping.identity.userAgent || ''),
    '对外自报身份是 Chrome（UA 里没有 Electron/AIBrowser）',
    ping.identity?.summary,
  );
  const fpRaw = await api('eval', {
    expression: 'JSON.stringify({ua:navigator.userAgent, platform:navigator.platform, brands:(navigator.userAgentData||{}).brands||[], uadPlatform:(navigator.userAgentData||{}).platform, langs:navigator.languages, webdriver:navigator.webdriver})',
  });
  const fp = JSON.parse(fpRaw.value);
  const chromeMajor = String(fp.ua).match(/Chrome\/(\d+)/)?.[1] || null;
  check(Boolean(chromeMajor) && !/Electron|AIBrowser/.test(fp.ua), '页面里的 UA 就是 Chrome', String(fp.ua).slice(0, 76));
  check(
    fp.brands.some((b) => b.brand === 'Google Chrome' && b.version === chromeMajor)
      && fp.brands.some((b) => b.brand === 'Chromium' && b.version === chromeMajor),
    'Client Hints 品牌与 UA 版本一致',
    JSON.stringify(fp.brands),
  );
  check(
    fp.platform === 'Win32' && fp.uadPlatform === 'Windows',
    'UA-CH platform 与 UA 字符串一致（不打架）',
    `${fp.platform} / ${fp.uadPlatform}`,
  );
  check(
    Array.isArray(fp.langs) && fp.langs[0] === 'zh-CN' && !fp.langs.some((l) => l.includes(';')),
    'languages 正常（不会出现 zh;q=0.9 这种怪值）',
    JSON.stringify(fp.langs),
  );

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

  // 文件树默认忽略依赖/版本库目录（node_modules 的各种变体也在内）
  const treeEntries = (await api('tree', { dir: root })).entries.map((e) => e.name);
  check(
    !treeEntries.some((name) => /^node_modules/i.test(name) || name === '.git' || name === '.aibrowser'),
    '文件树默认忽略 node_modules 与 .git',
    treeEntries.slice(0, 8).join(' ') + ' …',
  );
  const treeAll = (await api('tree', { dir: root, includeIgnored: true })).entries.map((e) => e.name);
  check(treeAll.some((name) => /^node_modules/i.test(name)), '需要时可以列出被忽略的目录', `--all 共 ${treeAll.length} 项`);

  // 打开项目外的临时文件只会注册 auto 根目录：不许跑到文件树里、也不许在切换栏冒出来
  // （用户看到过一个莫名的「pvs-edit-xxxx」胶囊，就是这种自动根目录）
  const autoRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvs-auto-root-'));
  const autoRootFile = path.join(autoRootDir, 'scratch.md');
  fs.writeFileSync(autoRootFile, '# scratch\n');
  const beforeAuto = await api('panelState');
  const autoSession = await api('openCode', { file: autoRootFile });
  await sleep(800);
  const afterAuto = await api('panelState');
  const autoRoot = (await api('roots')).roots.find((item) => item.dir === autoRootDir);
  check(autoRoot?.auto === true, '打开项目外的文件只注册 auto 根目录', JSON.stringify(autoRoot?.dir || null));
  check(
    afterAuto.state.treeRoot === beforeAuto.state.treeRoot && afterAuto.state.rootBarVisible === false,
    'auto 根目录不会进文件树也不会出现在切换栏',
    `树根 ${path.basename(afterAuto.state.treeRoot || '')} · 切换栏可见=${afterAuto.state.rootBarVisible}`,
  );
  await api('close', { sessionId: autoSession.sessionId });
  fs.rmSync(autoRootDir, { recursive: true, force: true });
  await sleep(300);

  // 点击文件树里的文件：高亮必须在点击的瞬间就落在那一行（不等文件装载完）
  const clickReadme = await api('panelAction', { action: 'open-tree', payload: { name: 'README.md' } });
  check(
    clickReadme.result?.activePath === clickReadme.result?.path && String(clickReadme.result?.path).endsWith('README.md'),
    '点击文件树后立刻高亮在点击的那一行',
    `activePath=${path.basename(clickReadme.result?.activePath || '')}`,
  );

  // 文件树的根目录必须稳定：展开子目录、点开里面的文件、或子目录被注册成根目录，
  // 都不该让树「跑到子目录里去」（父级消失、回不去 —— 曾经的 bug）
  const examplesDir = path.join(root, 'examples');
  const treeBefore = await api('panelState');
  await api('roots', { root: examplesDir }); // 等价于「打开项目外的文件时自动注册它的目录」
  await sleep(500);
  const treeAfterRoot = await api('panelState');
  check(
    treeAfterRoot.state.treeRoot === treeBefore.state.treeRoot && treeAfterRoot.state.treeRows === treeBefore.state.treeRows,
    '新增根目录不会让文件树跑到子目录里',
    `树根 ${path.basename(treeAfterRoot.state.treeRoot || '')} · ${treeBefore.state.treeRows} → ${treeAfterRoot.state.treeRows} 行`,
  );
  const rootBar = await api('panelState');
  check(rootBar.state.rootBarVisible === true && rootBar.state.rootBarText.includes('根目录'), '多根目录时出现根目录切换栏',
    rootBar.state.rootBarText);
  const toExample = await api('panelAction', { action: 'set-tree-root', payload: { dir: examplesDir } });
  await sleep(500);
  const treeAtExample = await api('panelState');
  check(
    toExample.result?.treeRoot === examplesDir && treeAtExample.state.treeRows > 0 && treeAtExample.state.treeRows < treeBefore.state.treeRows,
    '可以在根目录之间切换文件树',
    `树根 examples · ${treeAtExample.state.treeRows} 行`,
  );
  await api('panelAction', { action: 'set-tree-root', payload: { dir: root } });
  await sleep(500);
  const treeBack = await api('panelState');
  check(
    treeBack.state.treeRoot === treeBefore.state.treeRoot && treeBack.state.treeRows === treeBefore.state.treeRows,
    '能从子目录根切回项目根',
    `${treeBack.state.treeRows} 行`,
  );

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
  check(hotDefault.state.hotReload === true, '热重载默认开启', String(hotDefault.state.hotReload));

  // 关注范围：只盯面板里打开的文件 + 该页面实际加载的本地资源（不扫项目目录）
  await api('openPath', { path: htmlFile });
  await waitFor(async () => {
    const s = await api('panelState');
    return s.state.view === 'web' ? { ok: true } : { ok: false };
  }, { label: '切到网页会话' });
  const scope = await waitFor(async () => {
    const w = await api('debugWatch');
    return w.files.length >= 3 ? { ok: true, watch: w } : { ok: false, watch: w };
  }, { label: '热重载范围', timeoutMs: 8000 });
  const watched = (scope.watch?.files || []).map((f) => path.basename(f));
  check(
    scope.watch?.entry === htmlFile && watched.includes('demo.css') && watched.includes('demo.js'),
    '热重载范围 = 面板里的文件 + 页面实际引用的资源',
    `关注 ${watched.join(', ')}`,
  );
  check(
    !(scope.watch?.files || []).some((f) => f.includes('node_modules')),
    '热重载不会去扫项目/依赖目录',
    `${scope.watch?.files?.length || 0} 个文件 · 覆盖 ${scope.watch?.extensions}`,
  );
  const cssFile = path.join(root, 'examples', 'demo.css');
  const cssOriginal = fs.readFileSync(cssFile, 'utf8');
  fs.writeFileSync(cssFile, `${cssOriginal}\n/* pvs-verify-probe */\n`);
  const assetReload = await waitFor(async () => {
    const entries = await api('console');
    return entries.entries.some((e) => e.text.includes('热重载') && e.text.includes('demo.css'))
      ? { ok: true } : { ok: false };
  }, { label: '改被引用的 CSS 触发热重载', timeoutMs: 8000 });
  fs.writeFileSync(cssFile, cssOriginal);
  check(assetReload.ok, '改页面引用的 CSS 会触发热重载');
  // 没在面板里打开、页面也没引用的文件不该触发刷新
  await api('console');
  const untouchedFile = path.join(root, 'src', 'main', 'language.js');
  const untouchedOriginal = fs.readFileSync(untouchedFile, 'utf8');
  fs.writeFileSync(untouchedFile, `${untouchedOriginal}\n// pvs-verify-probe\n`);
  await sleep(2200);
  const unrelated = await api('console');
  const gotReload = unrelated.entries.some((e) => e.text.includes('热重载') && e.text.includes('language.js'));
  fs.writeFileSync(untouchedFile, untouchedOriginal);
  check(!gotReload, '没打开也没被引用的文件改了不触发刷新', `${unrelated.entries.length} 条日志`);

  // 单面板：fresh 会先关掉所有旧会话（skill 的 pvs.sh 默认带 --fresh）
  await api('open', { target: htmlFile, fresh: false });
  await api('open', { target: codeFile, force: 'code', fresh: true });
  const afterFresh = await api('list');
  check(
    afterFresh.sessions.length === 1 && afterFresh.sessions[0].kind === 'code',
    'fresh 打开会关掉之前所有面板',
    `${afterFresh.sessions.length} 个会话 · ${afterFresh.sessions.map((x) => x.title).join(', ')}`,
  );
  // 默认开启时改文件应当自动刷新
  await api('openPath', { path: htmlFile });
  await waitFor(async () => {
    const s = await api('panelState');
    return s.state.view === 'web' ? { ok: true } : { ok: false };
  }, { label: '切到网页会话' });
  const htmlOriginal = fs.readFileSync(htmlFile, 'utf8');
  fs.writeFileSync(htmlFile, htmlOriginal.replace('<h1>', '<h1 data-default="1">默认热重载 '));
  const autoReload = await waitFor(async () => {
    const r = await api('eval', { expression: 'document.querySelector("h1").hasAttribute("data-default")' });
    return r.value === 'true' ? { ok: true } : { ok: false };
  }, { label: '默认热重载生效', timeoutMs: 8000 });
  fs.writeFileSync(htmlFile, htmlOriginal);
  check(autoReload.ok, '默认开启时改文件会自动刷新');
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

  // 批量：混合 HTML + 代码文件，串行逐个激活标签再截；代码项在产品模式下必须走面板截图
  const batchDir = path.join(root, '.aibrowser', 'verify-batch');
  const sessionsBeforeBatch = (await api('list')).sessions.length;
  const batch = await api('batch', { items: [htmlFile, codeFile], outDir: batchDir });
  check(batch.total === 2 && batch.succeeded === 2, '批量任务：HTML + 代码文件都能截到图',
    `${batch.succeeded}/${batch.total} · ${batch.items.map((i) => `${i.name}:${i.source || i.error || ''}`).join(' · ')}`);
  const codeItem = batch.items.find((i) => i.target === codeFile) || {};
  check(codeItem.source === 'panel' && codeItem.width > 100,
    '批量里的代码项走面板截图（不是隐藏视图取帧）',
    `${codeItem.source} ${codeItem.width}×${codeItem.height}`);
  check(batch.items.every((i) => fs.existsSync(i.image)), '批量结果图片都落在磁盘上');
  check(fs.readFileSync(path.join(batchDir, 'report.json'), 'utf8').includes('"succeeded": 2'), '批量报告写入 outDir');
  const openAfterBatch = await api('list');
  // 批量自己开的标签要在下一项开始前关掉，只留最后一项；别的会话（验收前面的步骤开的）不归它管
  check(openAfterBatch.sessions.length <= sessionsBeforeBatch + 1, '批量结束后面板不堆标签',
    `会话 ${sessionsBeforeBatch} → ${openAfterBatch.sessions.length}`);

  // 打包产物清单：AI 按平台挑「该用哪个应用文件」——挑出来的文件必须真实存在，sha256 要对得上
  const packages = await api('packages', { target: process.platform === 'win32' ? 'win32' : process.platform });
  if (packages.ok) {
    const picked = packages.picked;
    const digest = createHash('sha256').update(fs.readFileSync(picked.archive)).digest('hex');
    check(
      fs.existsSync(picked.archive) && digest === picked.sha256 && Boolean(picked.executable),
      '打包清单能按平台挑出产物（文件与 sha256 都对得上）',
      `${path.basename(picked.archive)} · ${Math.round(picked.bytes / 1024 / 1024)}MB`,
    );
  } else {
    check(
      String(packages.error || '').includes('npm run package'),
      '没有（或没有匹配的）打包产物时给出生成命令',
      String(packages.error || ''),
    );
  }

  // 输出格式（AI 优先）：被捕获时默认 JSON，显式 --text / AIBROWSER_FORMAT=text 才是人读文本；
  // skill 的包装脚本即使跑在伪终端里也会注入 --json
  const cliJson = spawnSync(process.execPath, [path.join(root, 'bin', 'pvs.js'), 'status'], { encoding: 'utf8', timeout: 30000 });
  let cliParsed = null;
  try {
    cliParsed = JSON.parse(String(cliJson.stdout).trim().split('\n').pop());
  } catch {
    cliParsed = null;
  }
  check(Boolean(cliParsed && typeof cliParsed.ok === 'boolean'), 'CLI 被捕获时默认输出单行 JSON（AI 优先）',
    String(cliJson.stdout).trim().slice(0, 60));
  const cliText = spawnSync(process.execPath, [path.join(root, 'bin', 'pvs.js'), 'status', '--text'], { encoding: 'utf8', timeout: 30000 });
  check(!String(cliText.stdout).trim().startsWith('{'), '--text 可以要回人读文本', String(cliText.stdout).trim().split('\n')[0]);
  const ptyProbe = spawnSync('script', ['-qec', `bash ${path.join(root, 'skills', 'aibrowser', 'scripts', 'pvs.sh')} status`, '/dev/null'], { encoding: 'utf8', timeout: 40000 });
  const ptyLine = String(ptyProbe.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  check(
    ptyProbe.status === 0 || ptyLine.startsWith('{'),
    'skill 包装脚本在伪终端里也输出 JSON',
    ptyLine.slice(0, 60) || `script 不可用（status=${ptyProbe.status}）`,
  );

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

  // 收尾：把配置恢复成默认状态（失败的一轮不会给下一轮留下关闭的热重载等）
  await api('panelAction', { action: 'hot-reload', payload: { enabled: true } });
  await api('panelAction', { action: 'ui-zoom', payload: { factor: 1 } });
  await api('panelAction', { action: 'content-only', payload: { visible: true } });
  await sleep(400);

  await api('shutdown');
  await sleep(1500);

  // 面板常由「别的进程」拉起来（agent shell / cmd / npm），父进程一退管道就断，
  // 之后每次写日志都会 EPIPE —— 之前会在 Windows 上弹「A JavaScript error occurred
  // in the main process」。这里直接复现：启动一个实例，然后把读端全关掉，看它还能不能活。
  const pipeProbe = await (async () => {
    // 用真实二进制（.bin/electron 是个 node shim，pid 对不上，也不好判断存活）
    const electronBinary = require('electron');
    try {
      fs.rmSync(statePath, { force: true }); // 等一个「新的」实例，避免读到上一次留下的 state.json
    } catch {
      /* ignore */
    }
    const child = spawn(electronBinary, [root, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AIBROWSER_HEADLESS: '1' },
    });
    // 立刻把读端关掉：子进程随后的任何 stdout/stderr 写入都会拿到 EPIPE
    child.stdout.destroy();
    child.stderr.destroy();
    const started = Date.now();
    let ready = false;
    let lastState = null;
    while (Date.now() - started < 30000) {
      const state = readState();
      lastState = state;
      if (state && state.pid === child.pid) {
        try {
          const health = await fetch(`http://127.0.0.1:${state.port}/health`);
          if (health.ok) {
            ready = true;
            break;
          }
        } catch {
          /* 还没起来 */
        }
      }
      await sleep(300);
    }
    const alive = child.exitCode === null;
    child.kill('SIGTERM');
    await sleep(800);
    return { ready, alive, pid: child.pid, mode: lastState?.mode || null };
  })();
  check(pipeProbe.ready && pipeProbe.alive, '日志管道断开（EPIPE）时进程照常起来',
    `ready=${pipeProbe.ready} alive=${pipeProbe.alive} pid=${pipeProbe.pid} mode=${pipeProbe.mode}`);

  // 通过 CLI 拉起的实例，日志落在 <runtimeDir>/<mode>.log，不继承父进程的管道
  const logRun = spawnSync(process.execPath, [path.join(root, 'bin', 'pvs.js'), 'serve', '--json'], {
    encoding: 'utf8',
    timeout: 60000,
  });
  const daemonLog = path.join(os.homedir(), '.aibrowser', 'daemon.log');
  const logPathGuess = fs.existsSync(daemonLog)
    ? daemonLog
    : path.join(process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), '.aibrowser'), 'aibrowser', 'daemon.log');
  let logText = '';
  try {
    logText = fs.readFileSync(logPathGuess, 'utf8');
  } catch {
    logText = '';
  }
  check(
    logRun.status === 0 && logText.includes('[aibrowser] daemon · pid'),
    'CLI 拉起的实例把日志写在 runtimeDir（不继承父进程管道）',
    logPathGuess,
  );
  spawnSync(process.execPath, [path.join(root, 'bin', 'pvs.js'), 'stop'], { stdio: 'ignore' });

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
