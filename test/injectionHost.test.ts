import assert from 'node:assert/strict';
import Module from 'node:module';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type * as vscode from 'vscode';
import { computeDiff } from '../src/diff';

class Uri {
  constructor(readonly fsPath: string, readonly scheme = 'file') {}
  static joinPath(uri: Uri, ...parts: string[]) { return new Uri(path.join(uri.fsPath, ...parts)); }
  toString() { return `${this.scheme}://${this.fsPath}`; }
}
const settings = new Map<string, unknown>();
const commands = new Map<string, (...args: unknown[]) => unknown>();
const calls: [string, unknown[]][] = [];
const env = { uiKind: 1, remoteName: 'wsl' as string | undefined, appRoot: '' };
const document = { uri: new Uri('/home/user/a file.ts'), version: 17, isClosed: false };
const fake = {
  Uri, env, UIKind: { Desktop: 1 }, ExtensionKind: { UI: 1, Workspace: 2 }, ConfigurationTarget: { Global: 1 },
  window: { visibleTextEditors: [{ document }], createOutputChannel: () => ({ appendLine() {}, dispose() {} }), showInformationMessage: async () => undefined, showErrorMessage: async () => undefined },
  workspace: { getConfiguration: (section: string) => ({
    get: (key: string, fallback: unknown) => settings.get(`${section}.${key}`) ?? fallback,
    update: async (key: string, value: unknown) => { settings.set(`${section}.${key}`, value); },
  }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  commands: {
    registerCommand: (name: string, action: (...args: unknown[]) => unknown) => { commands.set(name, action); return { dispose: () => commands.delete(name) }; },
    // Declared UI commands are absent until activation.
    getCommands: async () => [],
    executeCommand: async (name: string, ...args: unknown[]) => { calls.push([name, args]); const action=commands.get(name);if(!action)throw new Error(`command '${name}' not found`);return action(...args); },
  },
};
const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const original = loader._load;
loader._load = function (id, ...args) { return id === 'vscode' ? fake : original.call(this, id, ...args); };
const { WorkbenchInjection } = require('../src/injection/host') as typeof import('../src/injection/host');
const { WorkbenchInstaller } = require('../src/injection/installer') as typeof import('../src/injection/installer');
loader._load = original;

async function fixture(t: TestContext, kind: number) {
  settings.clear(); commands.clear(); calls.length = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), 'guttered-host-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dist'));
  const bundle = 'var GutteredWorkbench={connect(){return 2}};';
  await writeFile(path.join(root, 'dist/workbench.js'), bundle);
  const revision = createHash('sha256').update(bundle).digest('hex');
  const context = { extensionUri: new Uri(root), extension: { extensionKind: kind } } as unknown as vscode.ExtensionContext;
  env.appRoot = root;env.remoteName = 'wsl';
  return { root, context, revision };
}

test('WSL delegates installation to the UI helper and accepts only revived current-session file targets', async t => {
  const { root, context, revision } = await fixture(t, 2);
  const remoteFile = path.join(root, 'remote-server-canary');
  await writeFile(remoteFile, 'remote installation');
  for (const action of ['connect', 'enable', 'disable', 'status', 'disconnect']) commands.set(`guttered.workbench.${action}`, async (_session, expected) => {
    if (action !== 'disconnect') assert.equal(expected, revision);
    return { protocol: 2, revision, active: action !== 'disable' };
  });
  commands.set('guttered.previewChange', () => {});
  const comparison = { version: 17, diff: computeDiff('old\n', 'changed\n') };
  const controller = { enabled: true, getComparison: () => comparison } as unknown as import('../src/controller').Controller;
  const host = new WorkbenchInjection(context, controller);t.after(() => host.dispose());
  await commands.get('guttered.enableWorkbenchInjection')!();
  const enabled = calls.find(([name]) => name === 'guttered.workbench.enable');assert.ok(enabled);
  const session = enabled[1][0];assert.equal(typeof session, 'string');
  const preview = commands.get('guttered._workbenchPreview')!;
  assert.equal(await preview(document.uri, 0, 17, session), true);
  assert.ok(calls.some(([name,args]) => name === 'guttered.previewChange' && args[0] === document.uri.toString() && args[1] === 0));
  for (const args of [[document.uri,0,16,session],[document.uri,0,17,'old-session'],[document.uri.toString(),0,17,session],[new Uri('/home/user/a file.ts','vscode-remote'),0,17,session],[new Uri('/other/file'),0,17,session],[document.uri,50,17,session]]) assert.equal(await preview(...args),false);
  settings.set('guttered.gutterPlacement','inset');assert.equal(await preview(document.uri,0,17,session),false);
  settings.delete('guttered.gutterPlacement');
  await commands.get('guttered.disableWorkbenchInjection')!();
  assert.ok(calls.some(([name]) => name === 'guttered.workbench.disable'));
  assert.equal(await readFile(remoteFile,'utf8'),'remote installation');
  host.dispose();assert.equal(await preview(document.uri,0,17,session),false);
});

test('UI helper in a WSL window patches the client and rejects remote-host placement and mismatched bundles', async t => {
  const { root, context, revision } = await fixture(t, 1);
  const directory = path.join(root,'out/vs/workbench');await mkdir(directory,{recursive:true});
  const file = path.join(directory,'workbench.desktop.main.js');
  const source = 'var E=id("codeEditorService"),C=id("commandService"),F=id("configurationService"),R=new class{constructor(){this.items=new Map}registerCommand(c){}};export{start as main};\n';
  await writeFile(file,source);
  commands.set('guttered._workbenchConnect', async (enabled, _revision, session) => ({protocol:2,revision,active:enabled===true&&typeof session==='string'}));
  const installer = new WorkbenchInstaller(context);t.after(() => installer.dispose());
  await assert.rejects(installer.enable('session-a','wrong-revision'),/matching versions/);
  assert.equal(await readFile(file,'utf8'),source);
  assert.equal((await installer.enable('session-a',revision)).active,true);
  assert.match(await readFile(file,'utf8'),/GUTTERED WORKBENCH INJECTION/);
  await installer.connect('session-b',revision);
  const count = calls.length;await installer.disconnect('session-a');assert.equal(calls.length,count,'Old session must not stop successor');
  await installer.disable('session-b');assert.equal(await readFile(file,'utf8'),source);
  const remote = new WorkbenchInstaller({...context,extension:{extensionKind:2}} as vscode.ExtensionContext);t.after(() => remote.dispose());
  await assert.rejects(remote.enable('session-c',revision),/UI extension host/);
  assert.equal(await readFile(file,'utf8'),source);
});


test('a remote host connects to a Windows-first hook without requiring a companion', async t => {
  const { context, revision } = await fixture(t, 2);
  settings.set('guttered.workbenchInjection', true);
  let connected = false;
  commands.set('guttered._workbenchConnect', async (enabled, expected, session) => {
    assert.equal(expected, revision);assert.equal(typeof session, 'string');connected = enabled === true;
    return {protocol:2,revision,active:connected};
  });
  commands.set('guttered._workbenchDisconnect', () => {connected=false;});
  const controller = {enabled:true,getComparison:()=>undefined} as unknown as import('../src/controller').Controller;
  const host = new WorkbenchInjection(context,controller);t.after(()=>host.dispose());
  const status=await commands.get('guttered.workbenchInjectionStatus')!();
  assert.match(String(status), /active in this remote window/);
  assert.equal(connected,true);
  host.dispose();
  // Wait for the failed companion disconnect to fall back to the workbench.
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(connected,false);
});

test('a UI helper migrates legacy remote settings before writing the client preference', async t => {
  const { root, context, revision } = await fixture(t, 1);
  const directory = path.join(root, 'out/vs/workbench');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workbench.desktop.main.js'),
    'var E=id("codeEditorService"),C=id("commandService"),F=id("configurationService"),R=new class{constructor(){this.items=new Map}registerCommand(c){}};export{start as main};\n');
  const legacyRemote = new Map<string, unknown>([['workbenchInjection', false]]);
  const getConfiguration = fake.workspace.getConfiguration;
  fake.workspace.getConfiguration = section => ({
    ...getConfiguration(section),
    update: async (key: string, value: unknown) => {
      // VS Code ignores this application setting remotely when reading, but
      // its Global write target still prefers an existing raw remote value.
      const target = legacyRemote.has(key) ? legacyRemote : settings;
      const targetKey = target === legacyRemote ? key : `${section}.${key}`;
      if (value === undefined) target.delete(targetKey);
      else target.set(targetKey, value);
    },
  });
  t.after(() => { fake.workspace.getConfiguration = getConfiguration; });
  commands.set('guttered._workbenchConnect', async enabled => ({ protocol: 2, revision, active: enabled === true }));
  const installer = new WorkbenchInstaller(context);
  t.after(() => installer.dispose());
  assert.equal((await installer.enable('session', revision)).active, true);
  assert.equal(settings.get('guttered.workbenchInjection'), true);
  assert.equal(legacyRemote.has('workbenchInjection'), false);
  await installer.disable('session');
  assert.equal(settings.get('guttered.workbenchInjection'), false);
  assert.equal(legacyRemote.has('workbenchInjection'), false);
});
