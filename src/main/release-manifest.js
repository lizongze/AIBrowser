'use strict';
// 打包清单（release/manifest.json）的读取与挑选逻辑。
// CLI（pvs packages）、控制 API（packages 动作）、MCP（browser_packages）共用同一份，
// 免得三处各写一套「按平台挑产物」的规则而慢慢漂移。
const fs = require('node:fs');
const path = require('node:path');

/** 清单文件位置：项目根下的 release/manifest.json */
function manifestPath(projectRoot) {
  return path.join(String(projectRoot || ''), 'release', 'manifest.json');
}

/**
 * 读清单。两个来源：
 *   1) 项目里的 release/manifest.json（开发/打包机：各平台产物清单）；
 *   2) skill 自带应用时，由 skill 的 pvs.sh 传进来的 AIBROWSER_BUNDLE_MANIFEST
 *      （自带 bundle/manifest.json：这份 skill 里带了哪些平台的应用）。
 * 返回值里带 source 字段说明是哪一个。
 */
function readManifest(projectRoot) {
  const bundleFile = process.env.AIBROWSER_BUNDLE_MANIFEST || '';
  const projectFile = manifestPath(projectRoot);
  const candidates = [
    ...(bundleFile ? [{ file: bundleFile, source: 'bundle' }] : []),
    { file: projectFile, source: 'release' },
  ];
  // 打包版里 projectRoot() 指向 resources/app.asar，release/manifest.json 不可能存在，跳过
  for (const candidate of candidates) {
    if (!candidate.file || candidate.file.includes('.asar' + path.sep)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(candidate.file, 'utf8'));
      return { file: candidate.file, source: candidate.source, manifest };
    } catch {
      /* 试下一个 */
    }
  }
  return { file: bundleFile || projectFile, source: null, manifest: null };
}

/** 自带 bundle 的清单用的是 platforms 字段（key 形如 linux-x64），转成与 release 清单一致的形状 */
function normalizeManifest(manifest, source) {
  if (!manifest) return null;
  if (Array.isArray(manifest.artifacts)) return { ...manifest, source };
  const artifacts = Object.entries(manifest.platforms || {}).map(([key, info]) => {
    const [platform, arch] = key.split('-');
    return {
      platform,
      arch,
      ok: true,
      ...info,
      bundled: true, // skill 自带：不需要下载，解压后直接跑
      archive: info.dir || null,
      archiveBytes: info.bytes || info.archiveBytes || 0,
      executableRel: info.executable,
      note: info.note || 'skill 自带的平台应用（无需下载）',
    };
  });
  return { ...manifest, source: source || 'bundle', artifacts };
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

module.exports = { manifestPath, readManifest, normalizeManifest, normalizePlatform, pickArtifacts, summarize };
