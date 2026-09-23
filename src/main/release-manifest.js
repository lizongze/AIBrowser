'use strict';
// 打包清单（release/manifest.json）的读取与挑选逻辑。
// CLI（pvs packages）、控制 API（packages 动作）、MCP（browser_packages）共用同一份，
// 免得三处各写一套「按平台挑产物」的规则而慢慢漂移。
const fs = require('node:fs');
const path = require('node:path');

/** 清单文件位置：项目根下的 release/manifest.json */
function manifestPath(projectRoot) {
  return path.join(projectRoot, 'release', 'manifest.json');
}

/** 读清单；没有就返回 null（附上应有的路径） */
function readManifest(projectRoot) {
  const file = manifestPath(projectRoot);
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, manifest };
  } catch {
    return { file, manifest: null };
  }
}

/** 平台别名归一：windows→win32、mac/macos→darwin */
function normalizePlatform(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'windows' || raw === 'win') return 'win32';
  if (raw === 'mac' || raw === 'macos' || raw === 'osx') return 'darwin';
  return raw;
}

/** 按平台/架构挑产物；不传平台时返回全部可用项 */
function pickArtifacts(manifest, { platform, arch } = {}) {
  const wanted = normalizePlatform(platform);
  const wantArch = arch ? String(arch).trim().toLowerCase() : null;
  return (manifest?.artifacts || []).filter((item) => item && item.ok
    && (!wanted || item.platform === wanted)
    && (!wantArch || item.arch === wantArch));
}

/** 给 AI 的一句话摘要（挑到的第一个产物） */
function summarize(artifact) {
  if (!artifact) return null;
  return {
    platform: artifact.platform,
    arch: artifact.arch,
    archive: artifact.archive,
    executable: artifact.executableRel || artifact.executable,
    cli: artifact.cli || null,
    sha256: artifact.sha256 || null,
    bytes: artifact.archiveBytes || null,
    version: artifact.version || null,
    electron: artifact.electron || null,
    note: artifact.note || null,
  };
}

module.exports = { manifestPath, readManifest, normalizePlatform, pickArtifacts, summarize };
