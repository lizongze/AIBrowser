'use strict';
// 显示缩放探测（WSLg / 高 DPI 场景）。
//
// 背景：WSLg 只把屏幕的物理像素和一张 96dpi 的 X 屏交给 Linux 应用，Electron 因此
// 以为 devicePixelRatio = 1；而 Windows 桌面实际按 150% 缩放显示，于是面板里的
// 文字看起来只有原生应用的三分之二大、发虚、显小。
// 这里把 Windows 的真实缩放比例算出来，交给 Chromium 的 force-device-scale-factor，
// 让面板与 Windows 原生应用保持一致的物理字号。
const { execFileSync } = require('node:child_process');
const { env } = require('./control/state');
const fs = require('node:fs');
const path = require('node:path');

const CANDIDATE_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];

function isWsl() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** X 屏的物理像素宽（WSLg 会按物理像素暴露屏幕） */
function physicalWidth() {
  // xdpyinfo 在 WSLg 下能拿到真实物理像素（例如 4976x1586）
  const fromXdpyinfo = (() => {
    try {
      const out = execFileSync('xdpyinfo', [], { encoding: 'utf8', timeout: 2000, env: process.env });
      const match = out.match(/dimensions:\s+(\d+)x(\d+)\s+pixels/i);
      if (match) return { width: Number(match[1]), height: Number(match[2]) };
    } catch {
      /* 没有 xdpyinfo 就走别的路 */
    }
    return null;
  })();
  if (fromXdpyinfo) return fromXdpyinfo.width;

  const fromXrandr = (() => {
    try {
      const out = execFileSync('xrandr', ['--current'], { encoding: 'utf8', timeout: 1500 });
      const match = out.match(/(\d+)x(\d+)\+0\+0/);
      if (match) return Number(match[1]);
    } catch {
      /* xrandr 不一定存在 */
    }
    return null;
  })();
  if (fromXrandr) return fromXrandr;

  // 回退：直接读 DRM 模式
  try {
    const cards = fs.readdirSync('/sys/class/drm').filter((name) => name.startsWith('card') && name.includes('-'));
    let best = 0;
    for (const card of cards) {
      const modes = fs.readFileSync(path.join('/sys/class/drm', card, 'modes'), 'utf8').trim().split('\n');
      const first = modes[0] || '';
      const match = first.match(/^(\d+)x(\d+)$/);
      if (match) best = Math.max(best, Number(match[1]));
    }
    return best || null;
  } catch {
    return null;
  }
}

/** Windows 逻辑分辨率（DIP 宽度）：PowerShell 报告的就是 96dpi 下的尺寸 */
function windowsLogicalWidth() {
  const queries = [
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width']],
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; (Get-CimInstance Win32_VideoController | Select-Object -First 1).CurrentHorizontalResolution']],
  ];
  for (const [cmd, args] of queries) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 4000, windowsHide: true });
      const value = Number(String(out).replace(/[^0-9]/g, ''));
      if (Number.isFinite(value) && value > 200) return value;
    } catch {
      /* 换下一个查询 */
    }
  }
  return null;
}

function snapToKnownScale(ratio) {
  let best = CANDIDATE_SCALES[0];
  let bestDelta = Infinity;
  for (const scale of CANDIDATE_SCALES) {
    const delta = Math.abs(scale - ratio);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = scale;
    }
  }
  // 偏差过大（超过 20%）说明推断不可靠，交给上层按 0.25 取整
  return bestDelta / best <= 0.2 ? best : null;
}

/**
 * 推断应该使用的渲染缩放。
 * @param {number|null} explicit 命令行 / 环境变量显式指定的值
 * @returns {{scale:number|null, source:string, detail?:string}}
 */
function detectScaleFactor(explicit = null) {
  if (explicit && Number.isFinite(explicit) && explicit > 0) {
    return { scale: explicit, source: 'explicit' };
  }
  const configured = env('SCALE');
  if (configured) {
    const value = Number(configured);
    if (Number.isFinite(value) && value > 0) return { scale: value, source: 'env' };
  }
  if (!isWsl()) return { scale: null, source: 'native' };

  const physical = physicalWidth();
  const logical = windowsLogicalWidth();
  const detail = `physical=${physical ?? '?'} logical=${logical ?? '?'}`;
  // 实测：WSLg 交给 Chromium 的 devicePixelRatio 是 2.25，而 Windows 桌面实际是 150%。
  // 物理像素（xdpyinfo 4976x1586）与 Windows 逻辑分辨率（3440/2293 两种口径）不同源，
  // 直接相除会得到 2.17~2.25 这种明显偏大的值 —— 因此这里不再自动推断，
  // 只把观测值作为提示，实际缩放由调用方的 wslgRecommendedScale() 决定。
  return { scale: null, source: 'wslg-info', detail };
}

/**
 * WSLg 下建议的渲染缩放。
 * 取 1.5 的依据：WSLg 会把 devicePixelRatio 报成 2.25（偏大），而笔记本屏是
 * 1536 逻辑 / 2304 物理 = 150%。用 1.5 时窗口缓冲区 ≈ 物理像素，呈现层不必再缩放；
 * 用 1.25 则还需要额外的 1.2 倍小数重采样，笔画会发虚。
 */
function wslgRecommendedScale() {
  const configured = env('WSLG_SCALE');
  if (configured === '0') return null;
  if (configured) {
    const value = Number(configured);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return isWsl() ? 1.5 : null;
}

module.exports = { detectScaleFactor, wslgRecommendedScale, isWsl, physicalWidth, windowsLogicalWidth };
