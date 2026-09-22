// Preview Studio — build script
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

async function copyStatic() {
  await mkdir(distDir, { recursive: true });
  for (const file of ['index.html', 'styles.css']) {
    await cp(path.join(rendererDir, file), path.join(distDir, file));
  }
}

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
