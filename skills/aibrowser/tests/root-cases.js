#!/usr/bin/env node
'use strict';
/**
 * `--root` 行为自检（给人和 AI 核对用）。
 *
 * 想验证的规则只有三条，但组合起来很容易出错，所以这里把各种情况都摆出来跑一遍：
 *   1) 打开时**声明过 root**（CLI 的 `--root`、清单里每项的 `root`）→ 地址栏显示「相对该 root」的路径；
 *   2) 没有可用 root（没给 --root、文件也不在任何已记录的根里）→ 显示**绝对路径**；
 *   3) 一批里每项各自带 root 时，**每项按自己的 root 显示**（不能只看最深/最外层的那个根）。
 *
 * 用法（任选其一）：
 *   # 打包版（skill 自带应用，不需要装 node）
 *   set ELECTRON_RUN_AS_NODE=1
 *   "%USERPROFILE%\.agents\skills\aibrowser\bundle\win32-x64\AIBrowser.exe" ^
 *     "%USERPROFILE%\.agents\skills\aibrowser\bundle\win32-x64\resources\app.asar\tests\root-cases.js"
 *   # 或者直接： node <skill>/tests/root-cases.js          （装了 node 时）
 *   # 仓库里开发： node skills/aibrowser/tests/root-cases.js
 *
 * 说明：脚本自己造一份临时项目（tmp 目录），不会碰你的真实文件；会复用/拉起一个 GUI 服务。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------- 找到 pvs CLI 与运行时目录 ----------
const TEST_DIR = __dirname;
const SKILL_DIR = path.resolve(TEST_DIR, '..');
const REPO_DIR = path.resolve(SKILL_DIR, '..', '..');

function findCli() {
  // 1) 打包版：<skill>/bundle/<平台>-<架构>/{AIBrowser.exe|AIBrowser|AIBrowser.app/...}
  const key = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
  const bundle = process.env.AIBROWSER_BUNDLE || path.join(SKILL_DIR, 'bundle', key);
  const app = path.join(bundle, 'resources', 'app.asar');
  const exe = process.platform === 'win32'
    ? path.join(bundle, 'AIBrowser.exe')
    : process.platform === 'darwin'
      ? path.join(bundle, 'AIBrowser.app', 'Contents', 'MacOS', 'AIBrowser')
      : path.join(bundle, 'AIBrowser');
  if (fs.existsSync(exe) && fs.existsSync(app)) {
    return {
      kind: 'bundle',
      describe: `${exe} ${app}/bin/pvs.js`,
      command: {
        cmd: exe,
        prefix: [path.join(app, 'bin', 'pvs.js')],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AIBROWSER_PACKAGED: '1' },
      },
      run: (args) => spawnSync(exe, [path.join(app, 'bin', 'pvs.js'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AIBROWSER_PACKAGED: '1' },
      }),
    };
  }
  // 2) 仓库版：node bin/pvs.js
  const repoCli = path.join(REPO_DIR, 'bin', 'pvs.js');
  if (fs.existsSync(repoCli)) {
    return {
      kind: 'repo',
      describe: `node ${repoCli}`,
      command: { cmd: process.execPath, prefix: [repoCli], env: { ...process.env } },
      run: (args) => spawnSync(process.execPath, [repoCli, ...args], {
        encoding: 'utf8',
        env: { ...process.env, AIBROWSER_PACKAGED: '' },
      }),
    };
  }
  // 3) PATH 里的 pvs
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pvs'], { encoding: 'utf8' });
  if (which.status === 0) {
    return { kind: 'path', describe: 'pvs (PATH)', run: (args) => spawnSync('pvs', args, { encoding: 'utf8' }) };
  }
  throw new Error('找不到 pvs：请把 skill 的 bundle 一起带上，或在仓库里跑');
}

const cli = findCli();

function runtimeDir() {
  if (process.env.AIBROWSER_RUNTIME) return process.env.AIBROWSER_RUNTIME;
  if (process.platform === 'linux' && process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'aibrowser');
  }
  return path.join(os.homedir(), '.aibrowser');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(runtimeDir(), 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 异步跑 CLI（「一边跑批处理一边采样地址栏」要用） */
function spawnCli(args) {
  const spec = cli.command;
  return spawn(spec.cmd, [...spec.prefix, ...args], { env: spec.env, stdio: ['ignore', 'ignore', 'ignore'] });
}

function pvs(args, { timeout = 120000 } = {}) {
  const out = cli.run(args);
  if (out.error) return { ok: false, stdout: '', stderr: String(out.error.message || out.error), status: -1 };
  return {
    ok: out.status === 0,
    status: out.status,
    stdout: String(out.stdout || '').trim(),
    stderr: String(out.stderr || '').trim(),
    timeout,
  };
}

function jsonOf(res) {
  for (const line of String(res.stdout || '').split('\n').reverse()) {
    const text = line.trim();
    if (text.startsWith('{')) {
      try {
        return JSON.parse(text);
      } catch {
        /* 继续找 */
      }
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 此刻「已记录」的根（排除 implicit：按 cwd 垫的那个不算记录过 root） */
function recordedRoots() {
  const list = jsonOf(pvs(['list', '--json']));
  return (list?.roots || [])
    .filter((r) => r.auto !== true && r.implicit !== true)
    .map((r) => r.dir);
}

/** 只留下「与本次测试目录相关」的根：上次运行残留的根会干扰阅读，但确实会影响行为，
 *  所以相关的一条都不隐藏，无关的折叠成计数。 */
function relevantRoots(dirs) {
  const mine = dirs.filter((d) => dirs.every((x) => !x.startsWith(d)) || true);
  const related = dirs.filter((dir) => mine.some((p) => dir === p || dir.startsWith(p + path.sep)));
  const others = dirs.length - related.length;
  return `${related.length ? related.join(' , ') : '（无）'}${others ? ` （另有 ${others} 个与本次测试无关的根）` : ''}`;
}

/** 读地址栏当前值（面板动作 font-report 里带着它） */
async function addressValue() {
  const state = readState();
  if (!state || !state.port) return '(服务未运行)';
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/panelAction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pvs-token': state.token || '' },
      body: JSON.stringify({ action: 'font-report' }),
    });
    const payload = await res.json();
    const inner = payload?.result?.result || payload?.result || {};
    return inner.address?.value ?? '(读不到地址栏)';
  } catch (err) {
    return `(读取失败 ${err.message})`;
  }
}

/** 等服务就绪（拉起即返回的 serve 之后要自己轮询） */
async function ensureService() {
  const running = jsonOf(pvs(['status', '--json']));
  if (running?.running && running.mode === 'gui') return { started: false, mode: running.mode };
  pvs(['serve', '--gui', '--json']);
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    const st = jsonOf(pvs(['status', '--json']));
    if (st?.running && st.mode === 'gui') return { started: true, mode: st.mode, seconds: (i + 1) / 2 };
  }
  const st = jsonOf(pvs(['status', '--json']));
  throw new Error(`服务没能就绪：${JSON.stringify(st)}`);
}

// ---------- 造一份临时项目 ----------
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pvs-root-cases-'));
const proj = path.join(workRoot, 'proj');
const files = {
  app: path.join(proj, 'src', 'app.vue'),
  wxml: path.join(proj, 'src', 'views', 'page', 'index.wxml'),
  index: path.join(proj, 'index.html'),
  outside: path.join(workRoot, 'outside.txt'),
  // 完全独立的第三个临时目录：确保「不在任何被记录过的根里」这条规则测得到
  outsider: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pvs-root-c-')), 'outsider.txt'),
};
fs.mkdirSync(path.dirname(files.wxml), { recursive: true });
fs.writeFileSync(files.app, '<template>\n  <view class="app">{{ title }}</view>\n</template>\n');
fs.writeFileSync(files.wxml, '<view class="page">\n  <text>{{ msg }}</text>\n</view>\n');
fs.writeFileSync(files.index, '<!doctype html><html><body><h1>hi</h1></body></html>\n');
fs.writeFileSync(files.outside, 'outside the project root\n');
fs.writeFileSync(files.outsider, 'outside every recorded root\n');

const listSameRoot = path.join(workRoot, 'list-same-root.json');
const listDiffRoot = path.join(workRoot, 'list-diff-root.json');
const listRelative = path.join(workRoot, 'list-relative.json');
fs.writeFileSync(listSameRoot, JSON.stringify([
  { file: files.app, root: proj, name: 'app' },
  { file: files.wxml, root: proj, name: 'wxml' },
], null, 2));
fs.writeFileSync(listDiffRoot, JSON.stringify([
  { file: files.app, root: proj, name: 'app' },
  { file: files.wxml, root: path.join(proj, 'src'), name: 'wxml' },
], null, 2));
fs.writeFileSync(listRelative, JSON.stringify([
  { file: path.join('src', 'app.vue'), root: proj, name: 'app' },
  { file: path.join('src', 'views', 'page', 'index.wxml'), root: proj, name: 'wxml' },
], null, 2));

// ---------- 用例 ----------
const rel = (...parts) => path.join(...parts);
const cases = [];
const add = (name, expected, fn) => cases.push({ name, expected, fn });

add('open：文件 + --root（相对显示）', 'src/app.vue', async () => {
  pvs(['code', files.app, '--root', proj, '--json']);
  await sleep(1500);
  return addressValue();
});

add('open：更深目录 + --root', 'src/views/page/index.wxml', async () => {
  pvs(['code', files.wxml, '--root', proj, '--json']);
  await sleep(1500);
  return addressValue();
});

add('open：不给 --root，但此刻 proj 已被记录过 → 相对 proj', 'src/app.vue', async () => {
  pvs(['code', files.app, '--json']);
  await sleep(1500);
  return addressValue();
});

add('open：文件在项目外、不给 --root', files.outside, async () => {
  pvs(['code', files.outside, '--json']);
  await sleep(1500);
  return addressValue();
});

add('open：--root 比文件浅一层', rel('proj', 'src', 'app.vue'), async () => {
  pvs(['code', files.app, '--root', workRoot, '--json']);
  await sleep(1500);
  return addressValue();
});

add('open：--root 就是文件所在目录', 'app.vue', async () => {
  pvs(['code', files.app, '--root', path.join(proj, 'src'), '--json']);
  await sleep(1500);
  return addressValue();
});

add('open：file:// URL + --root（也当本地文件）', 'src/app.vue', async () => {
  const url = `file://${files.app.split(path.sep).join('/')}`;
  pvs(['code', url, '--root', proj, '--json']);
  await sleep(1500);
  return addressValue();
});

add('open：--root 目录不存在（要明确报错）', '报错', async () => {
  const res = pvs(['code', files.app, '--root', path.join(workRoot, 'no-such-dir'), '--json']);
  const text = `${res.stdout}${res.stderr}`;
  return /不存在|ENOENT/.test(text) ? '报错' : text.slice(0, 80);
});

add('open：地址栏显示值回车后还能打开同一个文件', 'same', async () => {
  pvs(['code', files.wxml, '--root', proj, '--json']);
  await sleep(1500);
  const shown = await addressValue();
  const st0 = readState();
  await fetch(`http://127.0.0.1:${st0.port}/panelAction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pvs-token': st0.token || '' },
    body: JSON.stringify({ action: 'type-address', value: shown }),
  }).catch(() => null);
  await sleep(1500);
  const list = jsonOf(pvs(['list', '--json']));
  const active = (list?.sessions || []).find((s) => s.focused) || (list?.sessions || [])[0];
  return active?.file === files.wxml ? 'same' : `打开成了 ${active?.file || '空'}`;
});

add('batch：--root + 两个文件（都相对该 root）', 'src/views/page/index.wxml', async () => {
  const res = pvs(['batch', files.app, files.wxml, '--root', proj, '--out', rel(workRoot, 'out1'), '--json']);
  const report = jsonOf(res);
  if (!report || report.succeeded !== 2) return `batch 失败：${res.stdout.slice(0, 120)}${res.stderr.slice(0, 120)}`;
  await sleep(1200);
  return addressValue();
});

add('batch --from-json：两项 root 相同', 'src/views/page/index.wxml', async () => {
  const res = pvs(['batch', '--from-json', listSameRoot, '--out', rel(workRoot, 'out2'), '--json']);
  const report = jsonOf(res);
  if (!report || report.succeeded !== 2) return `batch 失败：${res.stdout.slice(0, 120)}${res.stderr.slice(0, 120)}`;
  await sleep(1200);
  return addressValue();
});

add('batch --from-json：两项 root 不同（第二项 root 更深）', 'views/page/index.wxml', async () => {
  const res = pvs(['batch', '--from-json', listDiffRoot, '--out', rel(workRoot, 'out3'), '--json']);
  const report = jsonOf(res);
  if (!report || report.succeeded !== 2) return `batch 失败：${res.stdout.slice(0, 120)}${res.stderr.slice(0, 120)}`;
  await sleep(1200);
  return addressValue();
});

add('batch --from-json：两项 root 不同 → 期间两项各自显示（连续采样地址栏）', 'src/app.vue → views/page/index.wxml', async () => {
  const seen = [];
  const before = await addressValue(); // 批处理开始前地址栏里的残留值，采样时要排除掉
  const child = spawnCli(['batch', '--from-json', listDiffRoot, '--out', rel(workRoot, 'out3b'), '--json']);
  let running = true;
  child.on('exit', () => { running = false; });
  while (running) {
    const v = await addressValue();
    if (v && seen[seen.length - 1] !== v) seen.push(v);
    await sleep(120);
  }
  await sleep(900);
  const last = await addressValue();
  if (seen[seen.length - 1] !== last) seen.push(last);
  // 只保留与本次两项相关的采样，并丢掉「开头那个等于批处理前残留值」的样本
  const interesting = seen.filter((v) => v.includes('app.vue') || v.includes('index.wxml'));
  if (interesting.length > 1 && interesting[0] === before) interesting.shift();
  return interesting.join(' → ');
});

add('batch --from-json：清单里用相对路径 + 每项 root', 'src/views/page/index.wxml', async () => {
  const res = pvs(['batch', '--from-json', listRelative, '--out', rel(workRoot, 'out4'), '--json']);
  const report = jsonOf(res);
  if (!report || report.succeeded !== 2) return `batch 失败：${res.stdout.slice(0, 120)}${res.stderr.slice(0, 120)}`;
  await sleep(1200);
  return addressValue();
});

add('累积行为：先带 --root 打开过，再不带 --root 打开同一 root 内的文件', 'src/views/page/index.wxml', async () => {
  pvs(['code', files.app, '--root', proj, '--json']);
  await sleep(1200);
  pvs(['code', files.wxml, '--json']); // 不带 root
  await sleep(1500);
  return addressValue();
});

add('batch：--root 之外的条目（按设计显示绝对路径）', files.outsider, async () => {
  const res = pvs(['batch', files.outsider, '--root', proj, '--out', rel(workRoot, 'out5'), '--json']);
  const report = jsonOf(res);
  if (!report || report.succeeded !== 1) return `batch 失败：${res.stdout.slice(0, 120)}${res.stderr.slice(0, 120)}`;
  await sleep(1200);
  return addressValue();
});

// ---------- 跑起来 ----------
(async () => {
  console.log(`[root-cases] CLI：${cli.describe}（${cli.kind}）`);
  console.log(`[root-cases] 临时项目：${proj}`);
  const svc = await ensureService();
  console.log(`[root-cases] 服务：gui${svc.started ? `（本次拉起，用时 ${svc.seconds}s）` : '（已在运行）'}`);
  console.log('');

  let failed = 0;
  const TEST_DIRS = [workRoot, proj, path.join(proj, 'src'), path.dirname(files.outsider), path.dirname(files.outside)];
  for (const item of cases) {
    // **不重启服务**：root 会随用例累积，这正是真实会话的样子；
    // 每个用例都会打印「此刻已记录的根」，方便对照期望值。
    const before = await recordedRoots();
    let actual = '';
    try {
      actual = String(await item.fn());
    } catch (err) {
      actual = `抛错：${err.message}`;
    }
    const after = await recordedRoots();
    const ok = actual === item.expected;
    if (!ok) failed += 1;
    console.log(`${ok ? '✓' : '✗'} ${item.name}`);
    console.log(`    用例前已记录 root：${relevantRoots(before.filter((d) => TEST_DIRS.some((t) => d === t || d.startsWith(t + path.sep))))}`);
    const added = after.filter((d) => !before.includes(d));
    if (added.length) console.log(`    用例后新增 root：${added.join(' , ')}`);
    console.log(`    期望：${item.expected}`);
    console.log(`    实际：${actual}`);
  }

  console.log('');
  console.log(`结果：${cases.length - failed}/${cases.length} 通过`);
  console.log(`临时项目保留在 ${workRoot}（想清理直接删掉即可）`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((err) => {
  console.error(`[root-cases] 失败：${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
