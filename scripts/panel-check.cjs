#!/usr/bin/env node
'use strict';
// 面板像素自检：读一张 GUI 面板截图，检查关键区域的配色是否符合「深色面板」设计。
// 用法：node scripts/panel-check.cjs /tmp/pvs-panel.png [--json]
// 依赖 electron 的 nativeImage（因此用 electron 运行；见 npm run verify:panel）
const fs = require('node:fs');

function analyze(file) {
  const { nativeImage } = require('electron');
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(`无法读取图片：${file}`);
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  const at = (x, y) => {
    const offset = (Math.round(y) * width + Math.round(x)) * 4;
    return { b: bitmap[offset], g: bitmap[offset + 1], r: bitmap[offset + 2], a: bitmap[offset + 3] };
  };
  const near = (c, target, tolerance = 26) =>
    Math.abs(c.r - target[0]) <= tolerance && Math.abs(c.g - target[1]) <= tolerance && Math.abs(c.b - target[2]) <= tolerance;
  const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  // 自动识别主题：内容区左上角是白/浅 → 白天模式；深 → 夜间模式
  const probe = at(width * 0.5, height * 0.5);
  const theme = luma(probe) > 140 ? 'light' : 'dark';

  const tokens = theme === 'light'
    ? { panel: [249, 250, 251], bg: [255, 255, 255], accent: [31, 111, 235] }
    : { panel: [21, 26, 33], bg: [13, 17, 23], accent: [76, 141, 255] };

  const regions = [
    { name: `标题栏（--panel ${theme === 'light' ? '#f9fafb' : '#151a21'}）`, point: [width / 2, 16], expect: tokens.panel, tolerance: 12 },
    { name: `侧栏背景（--bg ${theme === 'light' ? '#ffffff' : '#0d1117'}）`, point: [40, height * 0.6], expect: tokens.bg, tolerance: 12 },
    { name: '标签栏区域', point: [width * 0.6, 46], expect: tokens.panel, tolerance: 40 },
    { name: '内容区', point: [width * 0.5, height * 0.5], expect: tokens.bg, tolerance: 60 },
  ];

  const results = regions.map((region) => {
    const color = at(region.point[0], region.point[1]);
    return { ...region, color, ok: near(color, region.expect, region.tolerance) };
  });

  // 强调色抽样：整图里是否出现接近 --accent 的像素（激活标签的强调条、按钮、选中态）
  let accentHits = 0;
  let accentExact = 0;
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const c = at(x, y);
      const isBlueish = c.b > 150 && c.r < 140 && c.g > 70 && c.g < 200;
      if (isBlueish) {
        accentHits += 1;
        if (near(c, tokens.accent, 70)) accentExact += 1;
      }
    }
  }
  return { file, width, height, theme, regions: results, accentPixels: accentHits, accentExact };
}

function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    process.stderr.write('用法：electron scripts/panel-check.cjs <panel.png> [--json]\n');
    process.exitCode = 2;
    return;
  }
  const app = require('electron').app;
  app.whenReady().then(() => {
    try {
      const result = analyze(file);
      if (process.argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        process.stdout.write(`面板像素检查：${file}（${result.width}×${result.height} · ${result.theme === 'light' ? '白天模式' : '夜间模式'}）\n`);
        for (const region of result.regions) {
          process.stdout.write(
            `  ${region.ok ? '✓' : '✗'} ${region.name} → rgb(${region.color.r},${region.color.g},${region.color.b})\n`,
          );
        }
        process.stdout.write(`  · 强调色像素：${result.accentPixels} 个采样点（其中 ${result.accentExact} 个接近 #4c8dff）\n`);
      }
      const passed = result.regions.every((region) => region.ok) && result.accentPixels > 20;
      if (!passed) process.stderr.write('（提示：面板配色与主题基线不符，检查 styles.css 的令牌是否被改动）\n');
      app.exit(passed ? 0 : 1);
    } catch (err) {
      process.stderr.write(`检查失败：${err.message}\n`);
      app.exit(1);
    }
  });
}

main();
