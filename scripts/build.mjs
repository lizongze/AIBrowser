// AIBrowser — build script
// 用 esbuild 打包渲染进程（CodeMirror 需要打包），并把静态资源拷到 dist/
import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, '..');
const rendererDir = path.join(projectRoot, 'src', 'renderer');
const distDir = path.join(projectRoot, 'dist');

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(rendererDir, 'index.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outfile: path.join(distDir, 'renderer.js'),
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

/**
 * 预检：esbuild 是原生二进制，node_modules 在 WSL 与 Windows 之间是共享目录，
 * 在一侧执行 npm install 会把另一侧的二进制换掉（报错信息是「installed for another platform」，
 * 但不说怎么办）。这里直接告诉使用者修复命令，并尽量自动补装缺失的平台包。
 */
function esbuildPlatformPackage() {
  // esbuild 的命名就是 `<platform>-<arch>`：@esbuild/linux-x64、@esbuild/win32-x64、@esbuild/darwin-arm64
  return `@esbuild/${process.platform}-${process.arch}`;
}

async function preflightEsbuild() {
  const need = esbuildPlatformPackage();
  const target = path.join(projectRoot, 'node_modules', need);
  try {
    await import('node:fs/promises').then((m) => m.access(path.join(target, 'package.json')));
    return;
  } catch {
    /* 缺本平台的原生包 */
  }
  console.error(`\n[build] 缺少本平台的 esbuild 原生包：${need}`);
  console.error('        共享的 node_modules 被另一平台（WSL ↔ Windows）的 npm install 换过。');
  console.error('        修复（任选其一）：');
  console.error(`          npm i --no-save ${need}        # 只补这个平台的包，另一平台的会留着`);
  console.error('          rm -rf node_modules && npm install   # 代价更大，但最干净');
  console.error('        想两边都能构建：两个平台包可以共存，各装一次即可。\n');
  process.exit(1);
}

async function copyStatic() {
  await mkdir(distDir, { recursive: true });
  for (const file of ['index.html', 'styles.css']) {
    await cp(path.join(rendererDir, file), path.join(distDir, file));
  }
}

await preflightEsbuild();
await rm(distDir, { recursive: true, force: true });

if (watch) {
  await copyStatic();
  const ctx = await context(options);
  await ctx.watch();
  console.log('[build] watching renderer…');
} else {
  await build(options);
  await copyStatic();
  console.log('[build] done → dist/');
}
