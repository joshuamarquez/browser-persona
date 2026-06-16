import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');

mkdirSync('dist', { recursive: true });
cpSync('public/manifest.json', 'dist/manifest.json');
cpSync('public/popup.html', 'dist/popup.html');
cpSync('public/popup.js', 'dist/popup.js');
cpSync('public/icon128.png', 'dist/icon128.png');

const options = {
  entryPoints: {
    background: 'src/background.ts',
    content: 'src/content.ts',
  },
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'chrome120',
  sourcemap: true,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching extension...');
} else {
  await esbuild.build(options);
  console.log('extension built -> dist/');
}
