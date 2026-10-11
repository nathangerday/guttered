import './panel.css';
import type { PanelAction, PanelView } from './model';
import type { PreviewLine, PreviewRow } from '../preview';
import { colorSegments } from './syntax';
import { SyntaxHighlighting } from './syntaxClient';

declare function acquireVsCodeApi(): {
  postMessage(value: unknown): void;
  getState(): { mode?: string } | undefined;
  setState(value: unknown): void;
};
const vscode = acquireVsCodeApi();
const savedMode = vscode.getState()?.mode;
let mode = savedMode === 'inline' || savedMode === 'split' ? savedMode : window.innerWidth < 760 ? 'inline' : 'split';
let view: PanelView | undefined;
let pending = false;
const root = document.getElementById('app')!;
const syntax = new SyntaxHighlighting(root.dataset.syntaxWorker!, paintSyntax);

// Source text and repository names are inserted as text, never as HTML.
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function action(name: PanelAction): void {
  if (pending && name !== 'ready') return;
  if (['revert', 'undo', 'previous', 'next', 'refresh'].includes(name)) {
    pending = true;
    for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-action]')) button.disabled = true;
  }
  vscode.postMessage({ action: name, revision: view?.revision });
}
function button(text: string, name: PanelAction, title = text, className = ''): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button'; node.title = title;
  node.setAttribute('aria-label', title);
  node.dataset.action = name;
  node.addEventListener('click', () => action(name));
  return node;
}

function content(line: PreviewLine, side: 'old' | 'current'): HTMLElement {
  const code = element('code', 'source');
  code.dataset.side = side;
  code.dataset.line = String(line.number);
  paintContent(code, line, side);
  return code;
}

function paintContent(code: HTMLElement, line: PreviewLine, side: 'old' | 'current'): void {
  code.replaceChildren();
  for (const segment of colorSegments(line.segments, syntax.tokens(side, line.number))) {
    code.append(element('span', [...(segment.changed ? ['word-change'] : []), ...segment.classes].join(' '), segment.text));
  }
  if (!line.segments.some(segment => segment.text)) code.append(document.createTextNode('\u200b'));
  if (line.shortened) code.append(element('span', 'line-note', '… Line shortened; open Full diff'));
  if (line.noNewline) {
    const marker = element('span', 'no-newline', 'No final newline');
    marker.title = 'This line does not end with a newline.';
    code.append(marker);
  }
}

function paintSyntax(): void {
  if (!view) return;
  const lines = new Map<string, PreviewLine>();
  for (const row of view.rows) {
    if (row.old) lines.set(`old:${row.old.number}`, row.old);
    if (row.current) lines.set(`current:${row.current.number}`, row.current);
  }
  for (const code of root.querySelectorAll<HTMLElement>('.source[data-side][data-line]')) {
    const line = lines.get(`${code.dataset.side}:${code.dataset.line}`);
    if (line) paintContent(code, line, code.dataset.side as 'old' | 'current');
  }
}

function splitCell(line: PreviewLine | undefined, kind: 'context' | 'removed' | 'added', side: 'old' | 'current'): HTMLElement {
  const cell = element('div', `cell ${line ? kind : 'missing'}`);
  cell.append(element('span', 'line-number', line ? String(line.number) : ''));
  if (line) cell.append(content(line, side));
  else cell.setAttribute('aria-hidden', 'true');
  return cell;
}
function inlineRow(row: PreviewRow, kind: 'context' | 'removed' | 'added'): HTMLElement {
  const line = kind === 'removed' ? row.old! : row.current!;
  const node = element('div', `inline-row ${kind}`);
  node.append(element('span', 'line-number', kind === 'added' ? '' : String(row.old!.number)),
    element('span', 'line-number', kind === 'removed' ? '' : String(row.current!.number)),
    element('span', 'sign', kind === 'added' ? '+' : kind === 'removed' ? '−' : ''), content(line, kind === 'removed' ? 'old' : 'current'));
  return node;
}

function render(): void {
  if (!view) return;
  const focus = (document.activeElement as HTMLElement | null)?.dataset.action;
  const focusMode = (document.activeElement as HTMLElement | null)?.dataset.modeButton;
  root.replaceChildren();
  root.dataset.mode = mode;
  root.dataset.revision = String(view.revision);
  const header = element('header', 'header');
  const identity = element('div', 'identity');
  identity.append(element('h1', 'filename', view.name), element('div', 'filepath', view.path));
  const totals = element('div', 'totals');
  totals.setAttribute('aria-label', `${view.added} added lines, ${view.removed} removed lines`);
  totals.append(element('span', 'added-total', `+${view.added}`), element('span', 'removed-total', `−${view.removed}`));
  header.append(identity, totals);
  root.append(header);

  const toolbar = element('div', 'toolbar');
  const modes = element('div', 'modes');
  modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Comparison layout');
  for (const [value, title] of [['inline', 'Inline'], ['split', 'Side by side']]) {
    const node = element('button', mode === value ? 'active' : '', title);
    node.dataset.modeButton = value;
    node.type = 'button'; node.setAttribute('aria-pressed', String(mode === value));
    node.addEventListener('click', () => { mode = value!; vscode.setState({ mode }); render();
      root.querySelector<HTMLButtonElement>(`.modes button:nth-child(${mode === 'inline' ? 1 : 2})`)?.focus(); });
    modes.append(node);
  }
  const tools = element('div', 'tools');
  tools.append(button('Open file', 'openFile', 'Open the working file at this change'),
    button('Full diff ↗', 'openDiff', 'Open the full comparison in VS Code’s diff editor'));
  toolbar.append(modes, tools);
  root.append(toolbar);

  const comparison = element('div', 'comparison');
  const baseline = element('div', 'baseline-label');
  baseline.append(element('strong', '', view.baseRef), element('span', 'muted', `Merge base ${view.mergeBase}`));
  const working = element('div', 'working-label');
  working.append(element('strong', '', 'Working file'), element('span', view.dirty ? 'dirty-label' : 'muted', view.dirty ? 'Unsaved edits' : view.branch));
  comparison.append(baseline, working);
  root.append(comparison);

  const navigation = element('div', 'navigation');
  const position = element('div', 'position');
  const previous = button('↑', 'previous', 'Previous change (Alt+Up)', 'icon-button');
  const next = button('↓', 'next', 'Next change (Alt+Down)', 'icon-button');
  previous.disabled = next.disabled = view.count < 2 || pending;
  position.append(previous, next, element('strong', 'change-count', view.count ? `Change ${view.index + 1} of ${view.count}` : 'No changes'));
  if (view.count) position.append(element('span', 'muted', `Line ${view.line}`));
  const actions = element('div', 'change-actions');
  const copy = button('Copy patch', 'copy');
  const revert = button('↶ Revert change', 'revert', 'Restore this change from the merge base; editable with Undo', 'revert');
  copy.disabled = revert.disabled = !view.count || pending;
  actions.append(copy, revert);
  navigation.append(position, actions);
  root.append(navigation);

  const notice = element('div', 'notice');
  notice.id = 'notice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  root.append(notice);
  const diff = element('section', 'diff');
  diff.setAttribute('aria-label', 'Change comparison');
  if (view.reason || !view.count) {
    const empty = element('div', 'empty');
    empty.append(element('h2', '', view.reason ? 'Comparison unavailable' : 'No changes from merge base'),
      element('p', '', view.reason ?? 'This file matches its merge base.'));
    if (view.reason) empty.append(button('Refresh comparison', 'refresh'));
    diff.append(empty);
  } else if (mode === 'split') {
    for (const row of view.rows) {
      if (row.kind === 'gap') {
        diff.append(element('div', 'gap', `${row.omitted} change rows hidden. Open Full diff to see every line; Revert change restores the entire change.`));
      } else {
        const pair = element('div', 'split-row');
        pair.append(splitCell(row.old, row.kind === 'context' ? 'context' : 'removed', 'old'),
          splitCell(row.current, row.kind === 'context' ? 'context' : 'added', 'current'));
        diff.append(pair);
      }
    }
  } else {
    // Unified diffs group removals before additions, rather than alternating lines.
    let changed: PreviewRow[] = [];
    const flush = () => {
      for (const row of changed) if (row.old) diff.append(inlineRow(row, 'removed'));
      for (const row of changed) if (row.current) diff.append(inlineRow(row, 'added'));
      changed = [];
    };
    for (const row of view.rows) {
      if (row.kind === 'change') changed.push(row);
      else {
        flush();
        if (row.kind === 'context') diff.append(inlineRow(row, 'context'));
        else diff.append(element('div', 'gap', `${row.omitted} change rows hidden. Open Full diff to see every line; Revert change restores the entire change.`));
      }
    }
    flush();
  }
  root.append(diff);
  const footer = element('footer', 'footer');
  footer.append(element('span', 'muted', 'Revert edits the buffer. Saving and staging remain separate.'));
  const undo = button('Undo revert', 'undo');
  undo.disabled = !view.canUndo || pending;
  footer.append(undo); root.append(footer);
  if (focus) root.querySelector<HTMLButtonElement>(`button[data-action="${focus}"]`)?.focus({ preventScroll: true });
  else if (focusMode) root.querySelector<HTMLButtonElement>(`button[data-mode-button="${focusMode}"]`)?.focus({ preventScroll: true });
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'view') {
    view = message.view as PanelView;
    syntax.update(view);
    pending = false;
    render();
  } else if (message.type === 'notice') {
    pending = false;
    render();
    const notice = document.getElementById('notice')!;
    notice.textContent = message.text;
    notice.classList.toggle('error', !!message.error);
  } else if (message.type === 'unavailable') {
    syntax.update({ rows: [] });
    pending = false;
    const empty = element('div', 'empty');
    empty.append(element('h2', '', 'Comparison unavailable'), element('p', '', message.reason), button('Refresh comparison', 'refresh'));
    root.replaceChildren(empty);
  }
});
window.addEventListener('unload', () => syntax.dispose());
document.addEventListener('keydown', event => {
  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && (view?.count ?? 0) > 1) {
    event.preventDefault(); action(event.key === 'ArrowUp' ? 'previous' : 'next');
  }
});
action('ready');
