import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, disconnect } from '../src/injection/workbench';

// Exercise the actual capture handler with the editor service contract, avoiding
// fragile assumptions about minified implementation names or screenshot pixels.
test('gutter capture dispatches the clicked editor target and preserves other actions', async t => {
  class Element {
    className = 'cgmr codicon guttered-icon';
    readonly classList = { contains: (name: string) => this.className.split(' ').includes(name) };
    contains(target: unknown) { return target === this; }
  }
  const element = new Element();
  let handler: ((event: MouseEvent) => void) | undefined;
  let background = `url("data:image/svg+xml;base64,${Buffer.from('<svg id="guttered-marker-v1"/>').toString('base64')}")`;
  let enabled = true;
  let targetType = 2;
  let decorations = [{ options: { glyphMarginClassName: 'guttered-icon' } }];
  const calls: unknown[][] = [];
  const replacements: Record<string, unknown> = {
    window: { addEventListener(_type: string, callback: typeof handler) { handler = callback; }, removeEventListener() { handler = undefined; } },
    HTMLElement: Element,
    getComputedStyle: () => ({ backgroundImage: background }),
  };
  for (const [key, value] of Object.entries(replacements)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  let scheme = 'file';
  const modelUri = { get scheme() { return scheme; }, toString: () => `${scheme}:///split/second.ts` };
  const editor = {
    getDomNode: () => element as unknown as HTMLElement,
    getModel: () => ({ uri: modelUri, getVersionId: () => 17 }),
    getTargetAtClientPoint: () => ({ type: targetType, position: { lineNumber: 23 }, element: element as unknown as HTMLElement }),
    getLineDecorations: () => decorations,
  };
  const editors = { listCodeEditors: () => [editor] };
  const commands = { executeCommand: async (...args: unknown[]) => { calls.push(args); } };
  const config = { getValue: <T>() => enabled as T };
  connect(editors, commands, config, true, 'session-a');
  const click = (overrides = {}) => {
    let stopped = false;
    handler?.({ button: 0, detail: 1, target: element, preventDefault() {}, stopImmediatePropagation() { stopped = true; }, ...overrides } as unknown as MouseEvent);
    return stopped;
  };
  assert.equal(click(), true);
  assert.deepEqual(calls, [['guttered._workbenchPreview', editor.getModel().uri, 22, 17, 'session-a']]);
  decorations.push({ options: { glyphMarginClassName: 'codicon codicon-debug-breakpoint' } });
  assert.equal(click(), true, 'A breakpoint in another lane must not block our glyph');
  decorations.pop();
  for (const overrides of [{ button: 2 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { detail: 2 }]) assert.equal(click(overrides), false);
  enabled = false;
  assert.equal(click(), false);
  enabled = true;
  targetType = 3; // line number
  assert.equal(click(), false);
  targetType = 2;
  decorations = [{ options: { glyphMarginClassName: 'guttered-icon' } }, { options: { glyphMarginClassName: 'other-icon' } }];
  element.className += ' other-icon';
  assert.equal(click(), false);
  element.className = 'cgmr codicon guttered-icon codicon-debug-breakpoint';
  assert.equal(click(), false);
  element.className = 'cgmr codicon guttered-icon';
  decorations = [{ options: { glyphMarginClassName: 'guttered-icon' } }];
  background = 'url("native-git.png")';
  assert.equal(click(), false);
  assert.equal(calls.length, 2);
  background = `url("data:image/svg+xml;base64,${Buffer.from('<svg id="guttered-marker-v1"/>').toString('base64')}")`;
  scheme = 'vscode-remote';
  assert.equal(click(), true, 'Remote editor glyphs must dispatch URI objects');
  assert.equal(calls[2]![1], modelUri);
  assert.equal(calls[2]![4], 'session-a');
  scheme = 'untitled';
  assert.equal(click(), false);
  connect(editors, commands, config, true, undefined);
  assert.equal(handler, undefined, 'A disconnected session must not capture clicks');
  connect(editors, commands, config, true, 'session-b');
  disconnect('session-a');
  assert.ok(handler, 'An old session must not detach the new one');
  disconnect('session-b');
  assert.equal(handler, undefined);
  connect(editors, commands, config, false, 'session-a');
  assert.equal(handler, undefined);
});
