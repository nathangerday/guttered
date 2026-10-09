import { build, context } from 'esbuild';
const options = {
  entryPoints: { extension: 'src/extension.ts', integration: 'test/integration.ts' },
  outdir: 'dist', bundle: true, external: ['vscode'], platform: 'node',
  format: 'cjs', target: 'node20', sourcemap: true,
};
if (process.argv.includes('--watch')) {
  await (await context(options)).watch();
} else {
  await build(options);
}
