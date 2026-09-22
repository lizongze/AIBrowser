'use strict';
/**
 * 热重载关注的「文件类型」白名单。
 *
 * 关注范围本身很小 —— 只有面板（tab）里打开的文件，以及该页面真正加载过的本地资源，
 * 不做项目目录扫描。这里定义的是**类型**：哪些后缀算「改了就该重看页面」。
 *
 * 为什么要白名单：页面偶尔会高频读取某些文件（日志、临时文件、构建产物），
 * 那种变化会把预览刷成幻灯片，反而看不到页面本身的变化。
 */

/** 按用途分组，便于日志与文档直接引用 */
const EXTENSION_GROUPS = [
  {
    name: '前端脚本',
    exts: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro', 'elm', 'coffee'],
  },
  {
    name: '样式',
    exts: ['css', 'scss', 'sass', 'less', 'styl', 'stylus', 'pcss', 'postcss'],
  },
  {
    name: '页面与模板',
    exts: [
      'html', 'htm', 'xhtml', 'shtml',
      'hbs', 'handlebars', 'mustache', 'ejs', 'pug', 'jade', 'njk', 'nunjucks', 'liquid', 'twig', 'erb', 'haml', 'slim',
    ],
  },
  {
    name: '后端',
    exts: [
      'py', 'pyi', 'rb', 'php', 'phtml', 'java', 'kt', 'kts', 'scala', 'groovy', 'go', 'rs', 'cs', 'fs', 'fsx', 'vb',
      'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', 'swift', 'dart', 'lua', 'pl', 'pm', 'r', 'jl',
      'ex', 'exs', 'erl', 'hrl', 'hs', 'lhs', 'clj', 'cljs', 'cljc', 'edn', 'zig', 'nim', 'v', 'sol',
      'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
    ],
  },
  {
    name: '数据与接口',
    exts: ['sql', 'gsql', 'prisma', 'graphql', 'gql', 'proto', 'avsc', 'xml', 'csv', 'tsv', 'ics', 'vcf'],
  },
  {
    name: '测试',
    exts: ['spec', 'test', 'feature', 'snap', 'snapshot', 'cy'],
  },
  {
    name: '配置',
    exts: [
      'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config', 'properties',
      'env', 'editorconfig', 'babelrc', 'eslintrc', 'stylelintrc', 'webmanifest', 'plist', 'tf', 'tfvars', 'hcl',
    ],
  },
  {
    name: '文档',
    exts: ['md', 'markdown', 'mdx', 'rst', 'adoc', 'txt', 'tex'],
  },
  {
    name: '资源',
    exts: [
      'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
      'woff', 'woff2', 'ttf', 'otf', 'eot',
      'mp4', 'webm', 'ogg', 'mp3', 'wav', 'glb', 'gltf', 'wasm',
    ],
  },
];

/** 没有后缀、但改了就该刷新的常见文件 */
const SPECIAL_FILES = new Set([
  'makefile', 'gnumakefile', 'dockerfile', 'containerfile', 'procfile', 'gemfile', 'rakefile', 'brewfile',
  'cmakelists.txt', 'justfile', 'vagrantfile', '.env', '.env.local', '.env.development', '.env.production',
  '.gitignore', '.gitattributes', '.npmrc', '.nvmrc', '.babelrc', '.eslintrc', '.stylelintrc', '.editorconfig',
  'requirements.txt', 'pipfile', 'poetry.lock', 'cargo.toml', 'go.mod',
]);

const EXTENSION_SET = new Set(EXTENSION_GROUPS.flatMap((group) => group.exts));

/** 判断一个文件名是否属于「改了就该刷新预览」的类型 */
function isWatchedFile(name) {
  const base = String(name || '');
  if (!base) return false;
  const lower = base.toLowerCase();
  if (SPECIAL_FILES.has(lower)) return true;
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  if (!ext) return false;
  if (EXTENSION_SET.has(ext)) return true;
  // 测试/故事类双后缀：app.test.ts、view.spec.jsx、Button.stories.tsx、api.cy.ts
  const parts = lower.split('.');
  if (parts.length > 2 && parts.slice(1, -1).some((part) => EXTENSION_SET.has(part))) return true;
  return false;
}

/** 给日志/文档用的一行摘要：9 类 · 170 种后缀 */
function describeExtensions() {
  const count = EXTENSION_GROUPS.reduce((sum, group) => sum + group.exts.length, 0);
  return `${EXTENSION_GROUPS.length} 类 · ${count} 种后缀`;
}

module.exports = {
  EXTENSION_GROUPS,
  SPECIAL_FILES,
  isWatchedFile,
  describeExtensions,
};
