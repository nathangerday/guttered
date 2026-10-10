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
  readonly event = this.subscribe;
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  dispose(): void { this.listeners.clear(); }
}

const visibleChanged = new Event<void>();
const focusedChanged = new Event<{ focused: boolean }>();
const textChanged = new Event<{ document: vscode.TextDocument; contentChanges: unknown[] }>();
const noopEvent = () => ({ dispose() {} });
const settings = new Map<string, unknown>();
let decorationId = 0;
const decorationOptions = new Map<string, vscode.DecorationRenderOptions>();
const fakeWindow = {
  state: { focused: true },
  visibleTextEditors: [] as vscode.TextEditor[],
  activeTextEditor: undefined,
  onDidChangeVisibleTextEditors: visibleChanged.subscribe,
  onDidChangeActiveTextEditor: noopEvent,
  onDidChangeWindowState: focusedChanged.subscribe,
  createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
  createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
  createTextEditorDecorationType: (options: vscode.DecorationRenderOptions) => {
    const key = String(++decorationId);
    decorationOptions.set(key, options);
    return { key, dispose() {} };
  },
};
const fakeVSCode = {
  EventEmitter: Event,
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
  OverviewRulerLane: { Left: 1, Right: 4 },
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
  decorationOptions.clear();
});
function setup(t: TestContext, document = new Document(), baseline = 'original\n', head = baseline) {
  const controller = new Controller();
  controllers.push(controller);
  const repository = new Repository('/repo', new Git());
  const snapshot: Snapshot = { root: '/repo', mergeBase: 'a'.repeat(40), baseRef: 'origin/trunk', branch: 'feature', head: (head === baseline ? 'a' : 'b').repeat(40), baseTip: 'a'.repeat(40), key: 'snapshot' };
  const locate = t.mock.method(controller.git, 'locate', async () => ({ repository, path: 'file.txt' }));
  const readSnapshot = t.mock.method(repository, 'snapshot', async () => snapshot);
  const readBaseline = t.mock.method(controller.git, 'baseline', async (ref: Pick<Snapshot, 'root' | 'mergeBase'>) => {
    const text = ref.mergeBase === snapshot.mergeBase ? baseline : head;
    return { text, exists: true, bytes: Buffer.byteLength(text) };
  });
  const readIndex = t.mock.method(controller.git, 'index', async () => ({
    key: 'index', baseline: { text: head, exists: true, bytes: Buffer.byteLength(head) },
  }));
  const view = editor(document);
  fakeWindow.visibleTextEditors = [view.api];
  return { controller, document, view, repository, snapshot, locate, readSnapshot, readBaseline, readIndex };
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

test('workspace toggle discards pending results, stops Git reads, and resumes comparisons', async t => {
  const { controller, document, readSnapshot, readBaseline } = setup(t);
  const entered = deferred();
  const release = deferred();
  readBaseline.mock.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return { text: 'original\n', exists: true, bytes: 9 };
  });
  const pending = controller.compare(document.api);
  await entered.promise;
  controller.setEnabled(false);
  release.resolve();
  assert.equal(await pending, undefined);
  assert.equal(controller.getComparison(document.uri), undefined);
  assert.match(controller.reason(document.uri)!, /disabled for this workspace/);
  const reads = readSnapshot.mock.callCount();
  document.version++;
  textChanged.fire({ document: document.api, contentChanges: [{}] });
  await controller.refresh(true);
  await controller.compare(document.api, true);
  assert.equal(readSnapshot.mock.callCount(), reads, 'disabled comparisons never read Git');
  controller.setEnabled(true);
  await controller.refresh();
  assert.equal(controller.enabled, true);
  assert.equal(controller.getComparison(document.uri)?.version, document.version);
});

test('comparison notifications refresh consumers for changes without repeating on idle polls', async t => {
  const { controller, document, snapshot, readSnapshot } = setup(t);
  let notifications = 0;
  const listener = controller.onDidChangeComparison(() => notifications++);
  await controller.compare(document.api);
  assert.equal(notifications, 1);
  await controller.compare(document.api, true);
  assert.equal(notifications, 1, 'unchanged references and text do not notify consumers');
  readSnapshot.mock.mockImplementation(async () => ({ ...snapshot, key: 'new-reference', baseRef: 'origin/release' }));
  await controller.compare(document.api, true);
  assert.equal(notifications, 2, 'a new reference refreshes even when the diff is unchanged');
  document.text = 'another edit\n';
  document.version++;
  await controller.compare(document.api);
  assert.equal(notifications, 3);
  settings.set('guttered.enabled', false);
  await controller.compare(document.api);
  assert.equal(notifications, 4, 'inactive comparisons notify consumers');
  listener.dispose();
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
  const { controller, document, view } = setup(t, new Document(), 'original\n', 'changed\n');
  const second = editor(document);
  fakeWindow.visibleTextEditors.push(second.api);
  await controller.compare(document.api);
  const count = (value: typeof view) => [...value.decorations].reduce((sum, [key, ranges]) =>
    sum + (decorationOptions.get(key)?.overviewRulerColor ? ranges.length : 0), 0);
  assert.equal(count(view), 1);
  assert.equal(count(second), 1);
  document.text = 'original\n';
  document.version++;
  await controller.compare(document.api);
  assert.equal(count(view), 0);
  assert.equal(count(second), 0);
});

test('branch shading has no attachments, gutter icons or hover targets and keeps local Git distinct', async t => {
  const { controller, document, view } = setup(t, new Document('same\nchanged\n'), 'same\noriginal\n', 'same\nchanged\n');
  await controller.compare(document.api);
  const markedLines: number[] = [];
  for (const [key, ranges] of view.decorations) {
    const options = decorationOptions.get(key)!;
    assert.equal(options.gutterIconPath, undefined);
    assert.equal(options.before, undefined);
    assert.equal(options.after, undefined);
    assert.equal(options.isWholeLine, true);
    assert.equal(options.backgroundColor, '#8B5CF61f');
    assert.equal(options.overviewRulerLane, 4, 'branch overview markers use a separate lane');
    markedLines.push(...ranges.map(range => range.start.line));
  }
  assert.deepEqual(markedLines, [1]);
  settings.set('guttered.gutter', false);
  document.version++;
  await controller.compare(document.api);
  for (const [key, ranges] of view.decorations) {
    if (ranges.length) assert.equal(decorationOptions.get(key)?.backgroundColor, undefined);
  }
  settings.set('guttered.overviewRuler', false);
  document.version++;
  await controller.compare(document.api);
  assert.ok([...view.decorations.values()].every(ranges => ranges.length === 0));
});

test('committed deletions use dashed boundaries without adding text or taking the breakpoint gutter', async t => {
  const { controller, document, view } = setup(t, new Document('a\nb\n'), 'before\na\nafter\nb\n', 'a\nb\n');
  await controller.compare(document.api);
  for (const [key, ranges] of view.decorations) {
    if (!ranges.length) continue;
    const options = decorationOptions.get(key)!;
    assert.equal(options.borderWidth, '1px 0 1px 0');
    assert.equal(options.borderStyle, 'dashed');
    assert.equal(options.before, undefined);
    assert.equal(options.after, undefined);
    assert.equal(options.gutterIconPath, undefined);
    assert.deepEqual(ranges.map(range => range.start.line), [0]);
  }
});

test('local edits keep the complete comparison but receive no decorations', async t => {
  const baseline = 'same\nbranch-old\nseparator\nlocal-old\n';
  const head = baseline.replace('branch-old', 'branch-new');
  const current = head.replace('local-old', 'local-new');
  const { controller, document, view } = setup(t, new Document(current), baseline, head);
  const comparison = await controller.compare(document.api);
  assert.deepEqual(comparison?.diff.modified, [{ start: 1, count: 1 }, { start: 3, count: 1 }]);
  assert.deepEqual(comparison?.markers.map(marker => marker.line), [1]);
  for (const ranges of view.decorations.values()) {
    assert.ok(ranges.every(range => range.start.line === 1));
  }

  document.text = current.replace('branch-new', 'branch-edited');
  document.version++;
  await controller.compare(document.api);
  assert.deepEqual(controller.getComparison(document.uri)?.markers, []);
  assert.equal(controller.getComparison(document.uri)?.diff.hunks.length, 2);
  assert.ok([...view.decorations.values()].every(ranges => ranges.length === 0));
});

test('committing a local edit updates markers even when the merge base and buffer stay the same', async t => {
  const { controller, document, readBaseline, readIndex, snapshot } = setup(t);
  assert.deepEqual((await controller.compare(document.api))?.markers, []);
  snapshot.head = 'c'.repeat(40);
  snapshot.key = 'committed-local-edit';
  readBaseline.mock.mockImplementation(async (ref: Pick<Snapshot, 'root' | 'mergeBase'>) => {
    const text = ref.mergeBase === snapshot.mergeBase ? 'original\n' : document.text;
    return { text, exists: true, bytes: Buffer.byteLength(text) };
  });
  readIndex.mock.mockImplementation(async () => ({ key: 'committed', baseline: { text: document.text, exists: true, bytes: document.text.length } }));
  assert.deepEqual((await controller.compare(document.api, true))?.markers.map(marker => marker.line), [0]);
});

test('a staged edit reversed in the working tree hides the branch marker until the index is restored', async t => {
  const { controller, document, readIndex } = setup(t, new Document('committed\n'), 'original\n', 'committed\n');
  readIndex.mock.mockImplementation(async () => ({ key: 'staged', baseline: { text: 'staged\n', exists: true, bytes: 7 } }));
  assert.deepEqual((await controller.compare(document.api))?.markers, []);
  readIndex.mock.mockImplementation(async () => ({ key: 'restored', baseline: { text: 'committed\n', exists: true, bytes: 10 } }));
  assert.deepEqual((await controller.compare(document.api, true))?.markers.map(marker => marker.line), [0]);
  assert.equal(document.version, 1, 'staging updates are detected without a text edit');
});

test('a transient HEAD read failure recovers on an ordinary comparison without a text or ref change', async t => {
  const { controller, document, readBaseline, snapshot } = setup(t, new Document('committed\n'), 'original\n', 'committed\n');
  let fail = true;
  readBaseline.mock.mockImplementation(async (ref: Pick<Snapshot, 'root' | 'mergeBase'>) => {
    if (ref.mergeBase === snapshot.head && fail) {
      fail = false;
      throw new Error('Transient HEAD read failure');
    }
    const text = ref.mergeBase === snapshot.mergeBase ? 'original\n' : 'committed\n';
    return { text, exists: true, bytes: text.length };
  });
  assert.equal(await controller.compare(document.api), undefined);
  assert.match(controller.reason(document.uri)!, /Transient HEAD/);
  assert.deepEqual((await controller.compare(document.api))?.markers.map(marker => marker.line), [0]);
  assert.equal(document.version, 1);
});

test('large sparse branch changes decorate only the changed line', async t => {
  const baseline = Array.from({ length: 15_000 }, (_, index) => `line ${index}\n`).join('');
  const current = baseline.replace('line 7500\n', 'committed change\n');
  const { controller, document, view } = setup(t, new Document(current), baseline, current);
  await controller.compare(document.api);
  const ranges = [...view.decorations.values()].flat();
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.start.line, 7500);
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
