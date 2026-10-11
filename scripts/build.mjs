import { build, context } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
await Promise.all(['panel.js', 'panel.js.map', 'panel.css', 'panel.css.map', 'syntax.js', 'syntax.js.map'].map(file => rm(`dist/${file}`, { force: true })));
const options = {
  entryPoints: { extension: 'src/extension.ts', integration: 'test/integration.ts', workbenchExtension: 'src/injection/uiExtension.ts' },
  outdir: 'dist', bundle: true, external: ['vscode'], platform: 'node',
  format: 'cjs', target: 'node20', sourcemap: true,
};
const companion = { name: 'guttered-companion', setup(build) { build.onEnd(async result => {
  if (result.errors.length) return;
  await mkdir('workbench-extension/dist', { recursive: true });
  await copyFile('dist/workbenchExtension.js', 'workbench-extension/dist/extension.js');
  await copyFile('LICENSE', 'workbench-extension/LICENSE');
  await copyFile('assets/icon.png', 'workbench-extension/icon.png');
}); } };
options.plugins = [companion];
const workbench = {
  entryPoints: ['src/injection/workbench.ts'], outfile: 'dist/workbench.js', bundle: true,
  platform: 'browser', format: 'iife', globalName: 'GutteredWorkbench', target: 'es2022',
  plugins: [{ name: 'guttered-companion-payload', setup(build) { build.onEnd(async result => {
    if (result.errors.length) return;
    await mkdir('workbench-extension/dist', { recursive: true });
    await copyFile('dist/workbench.js', 'workbench-extension/dist/workbench.js');
  }); } }],
};
if (process.argv.includes('--watch')) {
  await (await context(options)).watch();
  await (await context(workbench)).watch();
} else {
  await build(options);
  await build(workbench);
}
const notices = await Promise.all([
  ['diff', 'LICENSE'],
].map(async ([name, file]) => `${name}\n\n${await readFile(`node_modules/${name}/${file}`, 'utf8')}`));
await mkdir('dist', { recursive: true });
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n----------------------------------------\n\n'));
