import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkbenchPatch, injectionSuffix } from '../src/injection/patch';

const source = 'var E=id("codeEditorService"),C=id("commandService"),F=id("configurationService"),R=new class{constructor(){this.items=new Map}registerCommand(c){}};export{start as main};\n';
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'guttered-patch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workbench.desktop.main.js');
  await writeFile(file, source, { mode: 0o644 });
  return { file, patch: new WorkbenchPatch(file) };
}

test('patch discovers identifiers, applies idempotently and restores original bytes/mode', async t => {
  const { file, patch } = await fixture(t);
  const mode = (await stat(file)).mode;
  assert.equal(await patch.apply('var GutteredWorkbench={connect(){}};'), true);
  assert.match(await readFile(file, 'utf8'), /R.registerCommand.*accessor.get\(E\).*accessor.get\(C\).*accessor.get\(F\)/);
  assert.equal(await readFile(patch.backup, 'utf8'), source);
  assert.equal(await patch.apply('var GutteredWorkbench={connect(){}};'), false);
  assert.equal(await patch.restore(), true);
  assert.equal(await readFile(file, 'utf8'), source);
  assert.equal((await stat(file)).mode, mode);
  assert.equal(await patch.restore(), false);
});

test('unsupported formats fail without editing the module or creating a backup', async t => {
  const { file, patch } = await fixture(t);
  await writeFile(file, 'unsupported');
  await assert.rejects(patch.apply('bundle'), /unsupported/);
  assert.equal(await readFile(file, 'utf8'), 'unsupported');
  await assert.rejects(readFile(patch.backup), { code: 'ENOENT' });
  assert.throws(() => injectionSuffix(source.replace('codeEditorService', 'other'), 'bundle'), /codeEditorService/);
  assert.throws(() => injectionSuffix(source + 'var Z=id("commandService");', 'bundle'), /commandService/);
});

test('restore preserves independent edits and refuses tampered injected code', async t => {
  const { file, patch } = await fixture(t);
  await patch.apply('firstBundle');
  await writeFile(file, '// another tool\n' + await readFile(file, 'utf8'));
  await patch.apply('secondBundle');
  assert.equal(await patch.restore(), true);
  assert.equal(await readFile(file, 'utf8'), '// another tool\n' + source);
  await patch.apply('firstBundle');
  const changed = (await readFile(file, 'utf8')).replace('firstBundle', 'tamperedBundle');
  await writeFile(file, changed);
  await assert.rejects(patch.restore(), /changed/);
  assert.equal(await readFile(file, 'utf8'), changed);
});

test('an editor update is never replaced by the previous installation backup', async t => {
  const { file, patch } = await fixture(t);
  await patch.apply('bundle');
  const update = '// desktop update\n' + source;
  await writeFile(file, update);
  assert.equal(await patch.restore(), false);
  assert.equal(await readFile(file, 'utf8'), update);
  await patch.apply('bundle');
  await writeFile(file, source);
  await patch.apply('newBundle');
  await patch.restore();
  assert.equal(await readFile(file, 'utf8'), source);
});

test('corrupt recovery artifacts and concurrent patch operations fail safely', async t => {
  const { file, patch } = await fixture(t);
  await patch.apply('bundle');
  const original = await readFile(file, 'utf8');
  const state = await readFile(file + '.guttered-state.json', 'utf8');
  await writeFile(file + '.guttered-state.json', '{invalid');
  await assert.rejects(patch.restore(), /metadata.*Backup/);
  assert.equal(await readFile(file, 'utf8'), original);
  await writeFile(file + '.guttered-state.json', state);
  await writeFile(patch.backup, 'corrupted');
  await assert.rejects(patch.restore(), /verification/);
  assert.equal(await readFile(file, 'utf8'), original);
  await writeFile(file + '.guttered-lock', 'another operation');
  await assert.rejects(patch.apply('bundle'), /in progress/);
  assert.equal(await readFile(file + '.guttered-lock', 'utf8'), 'another operation');
});

test('interrupted replacement retains a valid suffix for restoration', async t => {
  const { file, patch } = await fixture(t);
  await patch.apply('oldBundle');
  const previous = await readFile(file, 'utf8');
  await patch.apply('newBundle');
  // Simulate the metadata reaching disk before the atomic module replacement.
  await writeFile(file, previous);
  await patch.restore();
  assert.equal(await readFile(file, 'utf8'), source);
});
