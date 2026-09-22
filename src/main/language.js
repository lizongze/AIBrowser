'use strict';
// 语言/类型探测：把文件扩展名映射到 CodeMirror 语言包名与展示名。

const LANGUAGES = [
  ['html', ['html', 'htm', 'xhtml', 'vue', 'svelte', 'astro'], 'HTML'],
  ['javascript', ['js', 'mjs', 'cjs', 'jsx', 'es6'], 'JavaScript'],
  ['typescript', ['ts', 'mts', 'cts', 'tsx'], 'TypeScript'],
  ['json', ['json', 'jsonc', 'json5', 'webmanifest', 'map'], 'JSON'],
  ['css', ['css', 'scss', 'sass', 'less'], 'CSS'],
  ['markdown', ['md', 'markdown', 'mdx'], 'Markdown'],
  ['python', ['py', 'pyw', 'pyi'], 'Python'],
  ['rust', ['rs'], 'Rust'],
  ['go', ['go'], 'Go'],
  ['java', ['java'], 'Java'],
  ['kotlin', ['kt', 'kts'], 'Kotlin'],
  ['swift', ['swift'], 'Swift'],
  ['c', ['c', 'h'], 'C'],
  ['cpp', ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ino'], 'C++'],
  ['csharp', ['cs'], 'C#'],
  ['php', ['php', 'phtml'], 'PHP'],
  ['ruby', ['rb', 'rake', 'gemspec'], 'Ruby'],
  ['shell', ['sh', 'bash', 'zsh', 'fish', 'ksh'], 'Shell'],
  ['powershell', ['ps1', 'psm1', 'psd1'], 'PowerShell'],
  ['yaml', ['yml', 'yaml'], 'YAML'],
  ['toml', ['toml'], 'TOML'],
  ['ini', ['ini', 'cfg', 'conf', 'properties', 'env'], 'INI'],
  ['xml', ['xml', 'xsl', 'xsd', 'plist', 'csproj', 'props', 'targets'], 'XML'],
  ['sql', ['sql'], 'SQL'],
  ['dockerfile', ['dockerfile'], 'Dockerfile'],
  ['diff', ['diff', 'patch'], 'Diff'],
  ['lua', ['lua'], 'Lua'],
  ['perl', ['pl', 'pm'], 'Perl'],
  ['r', ['r', 'rmd'], 'R'],
  ['scala', ['scala', 'sc'], 'Scala'],
  ['dart', ['dart'], 'Dart'],
  ['elixir', ['ex', 'exs'], 'Elixir'],
  ['haskell', ['hs', 'lhs'], 'Haskell'],
  ['clojure', ['clj', 'cljs', 'edn'], 'Clojure'],
  ['proto', ['proto'], 'Protobuf'],
  ['graphql', ['graphql', 'gql'], 'GraphQL'],
  ['nginx', ['nginx'], 'Nginx'],
  ['makefile', ['makefile', 'mk'], 'Makefile'],
  ['cmake', ['cmake'], 'CMake'],
];

const BY_EXT = new Map();
const BY_NAME = new Map();
for (const [id, exts, label] of LANGUAGES) {
  for (const ext of exts) BY_EXT.set(ext, { id, label });
}

// 无扩展名但可识别的文件名
for (const [name, spec] of Object.entries({
  dockerfile: { id: 'dockerfile', label: 'Dockerfile' },
  makefile: { id: 'makefile', label: 'Makefile' },
  gnumakefile: { id: 'makefile', label: 'Makefile' },
  cmakelists: { id: 'cmake', label: 'CMake' },
  '.gitignore': { id: 'ini', label: 'Git Ignore' },
  '.npmrc': { id: 'ini', label: 'INI' },
  '.env': { id: 'ini', label: 'ENV' },
  'nginx.conf': { id: 'nginx', label: 'Nginx' },
})) {
  BY_NAME.set(name, spec);
}

const WEB_EXT = new Set(['html', 'htm', 'xhtml', 'svg']);

function extOf(filePath) {
  const base = String(filePath).replace(/\\/g, '/').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 返回 { id, label }；未知类型返回 { id:'plain', label:'Text' } */
function detectLanguage(filePath) {
  const base = String(filePath).replace(/\\/g, '/').split('/').pop() || '';
  const byName = BY_NAME.get(base.toLowerCase());
  if (byName) return { ...byName };
  const ext = extOf(filePath);
  if (ext && BY_EXT.has(ext)) return { ...BY_EXT.get(ext) };
  return { id: 'plain', label: ext ? ext.toUpperCase() : 'Text' };
}

/** 是否适合用 Chromium 网页方式预览 */
function isWebPreviewable(filePath) {
  return WEB_EXT.has(extOf(filePath));
}

/** 二进制判定：含 NUL 字节，或含大量不可打印字符 */
function looksBinary(buffer) {
  const len = Math.min(buffer.length, 8192);
  if (len === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < len; i += 1) {
    const byte = buffer[i];
    if (byte === 0) return true;
    const printable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 128;
    if (!printable) suspicious += 1;
  }
  return suspicious / len > 0.3;
}

module.exports = { detectLanguage, isWebPreviewable, looksBinary, extOf, LANGUAGES };
