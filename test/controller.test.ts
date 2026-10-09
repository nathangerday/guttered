import assert from 'node:assert/strict';
import Module from 'node:module';
import { afterEach, test, type TestContext } from 'node:test';
import type * as vscode from 'vscode';
import type { Controller as ControllerType } from '../src/controller';
import { Git, Repository, type Snapshot } from '../src/git';

class Event<T> {
  private readonly listeners = new Set<(value: T) => unknown>();
  readonly subscribe = (listener: (value: T) => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
}

const visibleChanged = new Event<void>();
const focusedChanged = new Event<{ focused: boolean }>();
const textChanged = new Event<{ document: vscode.TextDocument; contentChanges: unknown[] }>();
const noopEvent = () => ({ dispose() {} });
const settings = new Map<string, unknown>();
let decorationId = 0;
const fakeWindow = {
  state: { focused: true },
  visibleTextEditors: [] as vscode.TextEditor[],
  activeTextEditor: undefined,
  onDidChangeVisibleTextEditors: visibleChanged.subscribe,
  onDidChangeActiveTextEditor: noopEvent,
  onDidChangeWindowState: focusedChanged.subscribe,
  createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
  createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
  createTextEditorDecorationType: () => ({ key: String(++decorationId), dispose() {} }),
};
const fakeVSCode = {
  window: fakeWindow,
  workspace: {
    getConfiguration: (section: string) => ({ get: (key: string, fallback?: unknown) => settings.get(`${section}.${key}`) ?? fallback }),
    onDidChangeTextDocument: textChanged.subscribe,
    onDidSaveTextDocument: noopEvent,
    onDidCloseTextDocument: noopEvent,
    onDidChangeConfiguration: noopEvent,
    onDidChangeWorkspaceFolders: noopEvent,
  },
  StatusBarAlignment: { Left: 1 },
  OverviewRulerLane: { Left: 1 },
  DecorationRangeBehavior: { ClosedClosed: 1 },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  Range: class {
    readonly start;
    readonly end;
    constructor(line: number, character: number, endLine: number, endCharacter: number) {
      this.start = { line, character };
      this.end = { line: endLine, character: endCharacter };
    }
  },
};
// Only intercept the VS Code import. These tests exercise the real controller,
// Git cache interface, diff computation, and decoration lifecycle with controlled events.
const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (id, ...args) {
  return id === 'vscode' ? fakeVSCode : originalLoad.call(this, id, ...args);
};
const { Controller } = require('../src/controller') as typeof import('../src/controller');
loader._load = originalLoad;

class Document {
  version = 1;
  isClosed = false;
  readonly uri;
  constructor(public text = 'changed\n', name = 'file.txt') {
    this.uri = { scheme: 'file', fsPath: `/repo/${name}`, toString: () => `file:///repo/${name}` } as vscode.Uri;
  }
  get lineCount(): number { return this.text.split('\n').length; }
  getText(): string { return this.text; }
  get api(): vscode.TextDocument { return this as unknown as vscode.TextDocument; }
}

function editor(document: Document) {
  const decorations = new Map<string, readonly vscode.Range[]>();
  const api = {
    document: document.api,
    setDecorations: (type: vscode.TextEditorDecorationType, ranges: readonly vscode.Range[]) => decorations.set(type.key, ranges),
  } as unknown as vscode.TextEditor;
  return { api, decorations };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const controllers: ControllerType[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  fakeWindow.visibleTextEditors = [];
  fakeWindow.state.focused = true;
  settings.clear();
});
function setup(t: TestContext, document = new Document(), baseline = 'original\n') {
  const controller = new Controller();
  controllers.push(controller);
  const repository = new Repository('/repo', new Git());
  const snapshot: Snapshot = { root: '/repo', mergeBase: 'a'.repeat(40), baseRef: 'origin/trunk', branch: 'feature', head: 'b'.repeat(40), baseTip: 'a'.repeat(40), key: 'snapshot' };
  const locate = t.mock.method(controller.git, 'locate', async () => ({ repository, path: 'file.txt' }));
  const readSnapshot = t.mock.method(repository, 'snapshot', async () => snapshot);
  const readBaseline = t.mock.method(controller.git, 'baseline', async () => ({ text: baseline, exists: true, bytes: Buffer.byteLength(baseline) }));
  const view = editor(document);
  fakeWindow.visibleTextEditors = [view.api];
  return { controller, document, view, repository, snapshot, locate, readSnapshot, readBaseline };
}

test('commands and background refreshes share an in-flight comparison', async t => {
  const { controller, document, readBaseline } = setup(t);
  const entered = deferred();
  const release = deferred();
  readBaseline.mock.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return { text: 'original\n', exists: true, bytes: 9 };
  });
  const command = controller.compare(document.api, true);
  await entered.promise;
  const background = controller.compare(document.api, true);
  release.resolve();
  const [first, second] = await Promise.all([command, background]);
  assert.ok(first);
  assert.equal(first, second);
  assert.equal(readBaseline.mock.callCount(), 1);
});

test('an edit discards a delayed result before the debounce timer runs', async t => {
  const { controller, document, readBaseline } = setup(t);
  const entered = deferred();
  const release = deferred();
  readBaseline.mock.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { text: 'original\n', exists: true, bytes: 9 };
  });
  const older = controller.compare(document.api);
  await entered.promise;
  document.text = 'latest\n';
  document.version++;
  textChanged.fire({ document: document.api, contentChanges: [{}] });
  release.resolve();
  assert.equal(await older, undefined);
  assert.equal(controller.getComparison(document.uri), undefined);
  const latest = await controller.compare(document.api);
  assert.equal(latest?.version, document.version);
});

test('switching files discards a result for the editor that was hidden', async t => {
  const { controller, document, readBaseline } = setup(t);
  const entered = deferred();
  const release = deferred();
  readBaseline.mock.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { text: 'original\n', exists: true, bytes: 9 };
  });
  const old = controller.compare(document.api);
  await entered.promise;
  const next = new Document('next\n', 'next.txt');
  fakeWindow.visibleTextEditors = [editor(next).api];
  visibleChanged.fire();
  await controller.compare(next.api);
  release.resolve();
  assert.equal(await old, undefined);
  assert.equal(controller.getComparison(document.uri), undefined);
  assert.ok(controller.getComparison(next.uri));
});

test('an expensive diff failure is reused until an edit or manual refresh', async t => {
  const baseline = Array.from({ length: 30_000 }, (_, i) => `${String(i).padStart(6, '0')} abcdefghijklmnopqrstu\n`).join('');
  const current = baseline.split('\n').map((line, i) => i % 3 ? line : line.replace('abc', 'XYZ')).join('\n');
  const { controller, document } = setup(t, new Document(current), baseline);
  const getText = t.mock.method(document, 'getText');
  await controller.compare(document.api);
  assert.match(controller.reason(document.uri)!, /time limit/);
  await controller.refresh();
  await controller.refresh();
  assert.equal(getText.mock.callCount(), 1);
  document.version++;
  await controller.compare(document.api);
  assert.equal(getText.mock.callCount(), 2);
  await controller.refresh(true);
  assert.equal(getText.mock.callCount(), 3);
});

test('a refresh arriving mid-refresh queues another pass and rechecks discovery', async t => {
  const { controller, readBaseline, locate } = setup(t);
  const resetDiscovery = t.mock.method(controller.git, 'resetDiscovery');
  const entered = deferred();
  const release = deferred();
  readBaseline.mock.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { text: 'original\n', exists: true, bytes: 9 };
  });
  const first = controller.refresh();
  await entered.promise;
  const second = controller.refresh();
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(locate.mock.callCount(), 2);
  assert.equal(resetDiscovery.mock.callCount(), 2);
});

test('changed ignore rules can resume comparison without an editor edit', async t => {
  const { controller, document, repository, readBaseline } = setup(t);
  readBaseline.mock.mockImplementation(async () => ({ text: '', exists: false, bytes: 0 }));
  const ignored = t.mock.method(repository, 'isIgnored', async () => true);
  await controller.compare(document.api);
  assert.match(controller.reason(document.uri)!, /ignored by Git/);
  ignored.mock.mockImplementation(async () => false);
  await controller.refresh();
  assert.equal(controller.getComparison(document.uri)?.diff.added[0]?.count, 1);
});

test('both split editors receive markers and clear them when text is restored', async t => {
  const { controller, document, view } = setup(t);
  const second = editor(document);
  fakeWindow.visibleTextEditors.push(second.api);
  await controller.compare(document.api);
  const count = (value: typeof view) => [...value.decorations.values()].reduce((sum, ranges) => sum + ranges.length, 0);
  assert.equal(count(view), 1);
  assert.equal(count(second), 1);
  document.text = 'original\n';
  document.version++;
  await controller.compare(document.api);
  assert.equal(count(view), 0);
  assert.equal(count(second), 0);
});

test('background windows skip polling and focus restoration triggers a refresh', async t => {
  let tick!: () => void;
  const actualInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => {
    tick = callback as () => void;
    return actualInterval(callback, 60_000);
  });
  const { readSnapshot } = setup(t);
  fakeWindow.state.focused = false;
  tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readSnapshot.mock.callCount(), 0);
  fakeWindow.state.focused = true;
  focusedChanged.fire({ focused: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readSnapshot.mock.callCount(), 1);
});
