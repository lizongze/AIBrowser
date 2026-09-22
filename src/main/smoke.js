'use strict';
// 自检：无头启动一个本地示例页面，验证「加载 → eval → 控制台 → 截图」全链路。
// 用法：electron . --smoke-test   （退出码 0 表示通过）
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function log(ok, message, extra) {
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${message}${extra ? ` — ${extra}` : ''}\n`);
  return ok;
}

async function runSmokeTest({ manager, files, server, app }) {
  const results = [];
  const check = (ok, message, extra) => {
    results.push(ok);
    log(ok, message, extra);
  };

  process.stdout.write('\nAIBrowser 自检\n');

  // 准备临时示例页面
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvs-smoke-'));
  const page = path.join(dir, 'index.html');
  fs.writeFileSync(page, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Smoke</title></head>
<body style="background:#0d1117;color:#e6edf3;font:16px system-ui;padding:24px">
<h1 id="title">AIBrowser Smoke</h1>
<div id="box" style="width:120px;height:60px;background:#4c8dff;border-radius:8px"></div>
<script>console.log('smoke-ready', 6 * 7); window.__VALUE__ = { ok: true, n: 42 };</script>
</body></html>`);
  files.addRoot(dir);

  // 1. 控制服务
  check(Boolean(server.port), '控制服务已监听', `http://127.0.0.1:${server.port}`);
  check(fs.existsSync(server.state.socket), '控制 socket 已就绪', server.state.socket);

  // 2. 打开本地页面
  let session;
  try {
    session = await manager.open({ file: page, focus: true });
    check(true, '打开本地 HTML 预览', session.info().url);
  } catch (err) {
    check(false, '打开本地 HTML 预览', err.message);
    return 1;
  }

  // 3. 渲染结果
  try {
    const content = await session.getContent({});
    check(content.text.includes('AIBrowser Smoke'), '读取渲染后的文本', `${content.length} 字符`);
  } catch (err) {
    check(false, '读取渲染后的文本', err.message);
  }

  // 4. 执行 JS
  try {
    const evaluated = await session.evaluate('({ sum: 1 + 1, title: document.title, box: document.getElementById("box").getBoundingClientRect().width })');
    const parsed = JSON.parse(evaluated.value);
    check(parsed.sum === 2 && parsed.title === 'Smoke', '在页面中执行 JS', evaluated.value.replace(/\s+/g, ' '));
  } catch (err) {
    check(false, '在页面中执行 JS', err.message);
  }

  // 5. 控制台采集
  try {
    const logs = session.console({});
    const hit = logs.entries.some((entry) => entry.text.includes('smoke-ready 42'));
    check(hit, '控制台日志采集', `${logs.entries.length} 条`);
  } catch (err) {
    check(false, '控制台日志采集', err.message);
  }

  // 6. 截图 + 像素校验（不依赖人眼看图：直接检查位图内容）
  try {
    const shot = await session.screenshot({ format: 'png' });
    const out = path.join(dir, 'shot.png');
    fs.writeFileSync(out, shot.buffer);
    check(shot.bytes > 1000 && shot.width > 100, '截图（Chromium 渲染）', `${shot.width}×${shot.height} · ${Math.round(shot.bytes / 1024)}KB → ${out}`);

    const bitmap = shot.image.toBitmap();
    const { width, height } = shot.image.getSize();
    const pixel = (x, y) => {
      const offset = (y * width + x) * 4;
      return [bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]]; // B, G, R
    };
    const sampled = pixel(Math.round(width / 2), height - 12);
    const backgroundOk = sampled[0] < 60 && sampled[1] < 60 && sampled[2] < 60;
    check(backgroundOk, '截图底色为深色主题', `BGR(${sampled.join(',')})`);

    // 全图扫描页面上的蓝色块（#4c8dff ≈ BGR 255,141,76），确认页面元素真的被画出来
    let accentHits = 0;
    let accentSample = null;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const c = pixel(x, y);
        if (c[0] > 180 && c[1] > 90 && c[1] < 190 && c[2] < 130) {
          accentHits += 1;
          if (!accentSample) accentSample = c;
        }
      }
    }
    check(accentHits > 50, '截图包含页面上的强调色元素', `${accentHits} 个采样点 · BGR(${(accentSample || [0, 0, 0]).join(',')})`);
  } catch (err) {
    check(false, '截图（Chromium 渲染）', err.message);
  }

  // 7. 代码会话登记
  try {
    const codeFile = path.join(dir, 'demo.js');
    fs.writeFileSync(codeFile, 'export const answer = 42;\n');
    const codeSession = await manager.openCode({ file: codeFile });
    check(codeSession.language === 'javascript', '代码文件语言识别', codeSession.language);
  } catch (err) {
    check(false, '代码文件语言识别', err.message);
  }

  const passed = results.filter(Boolean).length;
  process.stdout.write(`\n结果：${passed}/${results.length} 项通过\n\n`);
  return passed === results.length ? 0 : 1;
}

module.exports = { runSmokeTest };
