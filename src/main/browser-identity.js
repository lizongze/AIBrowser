'use strict';
/**
 * 浏览器身份：让预览对外表现得像**同版本的普通 Chrome**。
 *
 * 为什么需要：不少站点看到 UA 里的 `Electron/x.y` 或自定义产品名（我们这里是 `AIBrowser/0.1.0`）
 * 会走特殊分支 —— 弹「请使用 Chrome 浏览器」、禁用某些能力、甚至直接拒绝服务，
 * 于是预览结果跟真实浏览器不一致，截图也就失去参考价值。预览工具只需要被当成普通 Chrome 对待。
 *
 * 这一层只改「自报身份」，且三处保持一致（UA 字符串 / Client Hints / navigator 可见值），
 * 因为三者互相矛盾本身就很显眼：
 *   - `navigator.userAgent`、`navigator.appVersion`
 *   - `navigator.userAgentData.brands` / `platform` / `mobile`（UA-CH）
 *   - `Sec-CH-UA*` 请求头、`Accept-Language`
 *
 * 边界（刻意不做）：不碰 `navigator.webdriver`，不伪造插件、字体、画布 / WebGL 指纹，
 * 不做 TLS 指纹伪装之类「对抗检测」的手段。这些属于反检测工具的范畴，不是预览工具该干的事。
 */

// 脱离 Electron 单独 require（CLI / 单测）时 process.versions.chrome 不存在，
// 给一个同代兜底版本，别拼出 Chrome/0.0.0.0 这种一眼假的 UA。
const FALLBACK_CHROME_VERSION = '140.0.0.0';
const CHROME_VERSION = /^\d+\./.test(String(process.versions.chrome || ''))
  ? String(process.versions.chrome)
  : FALLBACK_CHROME_VERSION;
const CHROME_MAJOR = CHROME_VERSION.split('.')[0];

/**
 * GREASE 品牌：Chromium 每次都会带上一个形如 `Not=A?Brand` 的「凑数」品牌，
 * 真实 Chrome 的列表是 [GREASE, Chromium, Google Chrome]。这里沿用本机 Chromium 的取值，
 * 只额外补上 Google Chrome（版本用真实 Chromium 版本，和 UA 字符串里的完全一致）。
 */
const GREASE_BRAND = { brand: 'Not=A?Brand', version: '24' };

const PROFILES = {
  /** 默认：同版本 Windows Chrome */
  chrome() {
    return {
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`,
      // 注意：这个字符串会被 Chromium 直接切成 navigator.languages，
      // 带上 q 值会得到 ['zh-CN','zh;q=0.9',…] 这种真实浏览器不会有的值，所以不写 q。
      acceptLanguage: 'zh-CN,zh,en',
      platform: 'Win32',
      userAgentMetadata: {
        brands: [
          GREASE_BRAND,
          { brand: 'Chromium', version: CHROME_MAJOR },
          { brand: 'Google Chrome', version: CHROME_MAJOR },
        ],
        fullVersionList: [
          { brand: 'Chromium', version: CHROME_VERSION },
          { brand: 'Google Chrome', version: CHROME_VERSION },
        ],
        fullVersion: CHROME_VERSION,
        platform: 'Windows',
        platformVersion: '15.0.0', // Windows 11 在 UA-CH 里报 15.0.0
        architecture: 'x86',
        bitness: '64',
        model: '',
        mobile: false,
        wow64: false,
      },
    };
  },
  /** 排查问题用：保留 Electron 原始身份（UA 里能看到 Electron / AIBrowser） */
  native() {
    return null;
  },
};

/** 身份模式：AIBROWSER_IDENTITY=chrome|native（默认 chrome；native 用于排查） */
function identityMode(explicit) {
  const raw = explicit
    || process.env.AIBROWSER_IDENTITY
    || (() => {
      try {
        return require('./config').read().browserIdentity;
      } catch {
        return null;
      }
    })()
    || 'chrome';
  const mode = String(raw).trim().toLowerCase();
  return mode === 'native' ? 'native' : 'chrome';
}

/** 当前应当使用的身份；native 模式返回 null（表示不改） */
function resolveIdentity(options = {}) {
  const mode = identityMode(options.mode);
  const build = PROFILES[mode] || PROFILES.chrome;
  const identity = build();
  if (!identity) return { mode, native: true, userAgent: null, label: '原生 Electron 身份（未伪装）' };
  return {
    mode,
    native: false,
    label: `Chrome/${CHROME_VERSION}（Windows）`,
    ...identity,
  };
}

/** 一句话摘要，写进启动日志 */
function describeIdentity(identity = resolveIdentity()) {
  return identity.native
    ? identity.label
    : `${identity.label} · UA 不含 Electron/AIBrowser 标识`;
}

/**
 * 把身份应用到某个 webContents。
 * 优先用 CDP 的 Network.setUserAgentOverride —— 它是 Chromium 自己的机制，
 * UA 字符串、UA-CH（brands / platform）、navigator.platform 会一起改，不会互相打架；
 * 旧环境不支持时退化成 setUserAgent（只改 UA 字符串）。
 */
async function applyIdentity(webContents, identity = resolveIdentity()) {
  if (!webContents || webContents.isDestroyed() || identity.native) return false;
  const payload = {
    userAgent: identity.userAgent,
    acceptLanguage: identity.acceptLanguage,
    platform: identity.platform,
    userAgentMetadata: identity.userAgentMetadata,
  };
  try {
    if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3');
    await webContents.debugger.sendCommand('Network.setUserAgentOverride', payload);
    return true;
  } catch {
    try {
      webContents.setUserAgent(identity.userAgent, identity.acceptLanguage);
      return true;
    } catch {
      return false;
    }
  }
}

/** 同步版本：只改 UA 字符串（窗口/会话刚创建、CDP 还没法用时） */
function applyIdentitySync(webContents, identity = resolveIdentity()) {
  if (!webContents || webContents.isDestroyed() || identity.native) return false;
  try {
    webContents.setUserAgent(identity.userAgent, identity.acceptLanguage);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  CHROME_MAJOR,
  CHROME_VERSION,
  GREASE_BRAND,
  identityMode,
  resolveIdentity,
  describeIdentity,
  applyIdentity,
  applyIdentitySync,
};
