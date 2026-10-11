import { build, context } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const options = {
  entryPoints: { extension: 'src/extension.ts', integration: 'test/integration.ts' },
  outdir: 'dist', bundle: true, external: ['vscode'], platform: 'node',
  format: 'cjs', target: 'node20', sourcemap: true,
};
const panel = {
  entryPoints: { panel: 'src/panel/webview.ts', syntax: 'src/panel/syntaxWorker.mts' }, outdir: 'dist', bundle: true,
  platform: 'browser', format: 'iife', target: 'es2022',
};
if (process.argv.includes('--watch')) {
  await (await context(options)).watch();
  await (await context(panel)).watch();
} else {
  await build(options);
  await build(panel);
}
const notices = await Promise.all([
  ['diff', 'LICENSE'], ['lowlight', 'license'], ['highlight.js', 'LICENSE'], ['devlop', 'license'],
].map(async ([name, file]) => `${name}\n\n${await readFile(`node_modules/${name}/${file}`, 'utf8')}`));
await mkdir('dist', { recursive: true });
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n----------------------------------------\n\n'));
