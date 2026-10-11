import * as vscode from 'vscode';
import path from 'node:path';
import { configuration } from './config';
import { Controller, type Comparison, type GitAPI, type GitExtension } from './controller';
import { hunkAtLine, hunkLine, lineMarkers, minimalTextChange, restoreHunk } from './diff';
import { ChangeActionHover, ChangeHover } from './hover';
import { ChangedFiles } from './changedFiles';
import { DiffPanel } from './panel';

const baselineScheme = 'guttered-base';

interface Target { uri: string; line?: number }
const isLine = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// Hover links pass a URI string and a zero-based line. The editor context menu
// passes the document URI; the gutter context menu passes a one-based line.
function commandTarget(args: unknown[]): Target | undefined {
  const [first, second] = args;
  if (first === undefined) return;
  if (first instanceof vscode.Uri) return { uri: first.toString() };
  if (typeof first === 'string' && isLine(second)) return { uri: first, line: second };
  const { uri, lineNumber } = (first ?? {}) as { uri?: unknown; lineNumber?: unknown };
  if (uri instanceof vscode.Uri && isLine(lineNumber) && lineNumber > 0) return { uri: uri.toString(), line: lineNumber - 1 };
  throw new Error('Invalid command target.');
}

export async function activate(context: vscode.ExtensionContext): Promise<Controller> {
  let gitApi: GitAPI | undefined;
  try {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (extension && vscode.workspace.getConfiguration('git').get<boolean>('enabled', true)) {
      gitApi = (await extension.activate()).getAPI(1);
    }
  } catch {
    // Built-in Git is optional; use git.path and reference polling when unavailable.
  }
  const controller = new Controller(gitApi, context.workspaceState.get<boolean>('enabled', true));
  context.subscriptions.push(controller);
  const changedFiles = new ChangedFiles(controller);
  context.subscriptions.push(changedFiles);
  const diffPanel = new DiffPanel(context, controller);
  context.subscriptions.push(diffPanel);
  context.subscriptions.push(vscode.languages.registerInlayHintsProvider({ scheme: 'file' }, new ChangeHover(controller)));
  context.subscriptions.push(vscode.languages.registerHoverProvider({ scheme: 'file' }, new ChangeActionHover(controller)));
  // The gutter context menu offers actions on marked lines. Right-clicking the
  // gutter doesn't focus its editor, so include lines from every visible editor.
  let markedLines: string | undefined;
  const updateMarkedLines = () => {
    const lines = new Set<number>();
    for (const editor of vscode.window.visibleTextEditors) {
      const comparison = controller.getComparison(editor.document.uri);
      for (const marker of comparison ? lineMarkers(comparison.diff) : []) lines.add(marker.line + 1);
    }
    const value = [...lines].sort((a, b) => a - b);
    if (value.join() === markedLines) return;
    markedLines = value.join();
    void vscode.commands.executeCommand('setContext', 'guttered.markedLines', value);
  };
  context.subscriptions.push(controller.onDidChangeComparison(updateMarkedLines), vscode.window.onDidChangeVisibleTextEditors(updateMarkedLines));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(baselineScheme, {
    async provideTextDocumentContent(uri) {
      const { root, mergeBase, file, maxBytes } = JSON.parse(uri.query) as { root: string; mergeBase: string; file: string; maxBytes: number };
      const valid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(mergeBase)
        && typeof root === 'string' && path.isAbsolute(root)
        && typeof file === 'string'
        && Number.isFinite(maxBytes) && maxBytes >= 1 && maxBytes <= 10 * 1024 * 1024;
      if (!valid) {
        throw new Error('Invalid Guttered baseline URI.');
      }
      return (await controller.git.baseline({ root, mergeBase }, file, maxBytes)).text;
    },
  }));
  // Deleted files need an empty right side without recreating a working file.
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('guttered-empty', {
    provideTextDocumentContent: () => '',
  }));

  const command = (name: string, action: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(`guttered.${name}`, async (...args: unknown[]) => {
      try {
        return await action(...args);
      } catch (error) {
        void vscode.window.showErrorMessage(`Guttered: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  };
  // Menus and hover links name their own document, which may be in an unfocused split.
  const targetEditor = (target: Target | undefined) => {
    const active = vscode.window.activeTextEditor;
    if (!target || active?.document.uri.toString() === target.uri) return { editor: active, document: active?.document };
    const editor = vscode.window.visibleTextEditors.find(view => view.document.uri.toString() === target.uri);
    return { editor, document: editor?.document ?? vscode.workspace.textDocuments.find(document => document.uri.toString() === target.uri) };
  };
  const withComparison = async (target: Target | undefined, action: (editor: vscode.TextEditor, comparison: Comparison) => unknown) => {
    const { editor: shown, document } = targetEditor(target);
    if (!document || document.isClosed || document.uri.scheme !== 'file') return;
    // A target line refers to the text when the command ran, so record its
    // version before focusing. Never act after the user has edited or switched.
    const version = document.version;
    if (vscode.window.activeTextEditor?.document !== document) await vscode.window.showTextDocument(document, shown?.viewColumn);
    const editor = vscode.window.activeTextEditor;
    if (editor?.document !== document || document.version !== version) return;
    // A visibility/configuration event may invalidate work without changing text, so retry that case.
    for (let attempt = 0; attempt < 3; attempt++) {
      const comparison = await controller.compare(document, true);
      if (vscode.window.activeTextEditor !== editor || document.version !== version) return;
      if (comparison) return action(editor, comparison);
      if (controller.reason(document.uri)) break;
    }
    void vscode.window.showInformationMessage(controller.reason(document.uri) ?? 'Guttered: the comparison changed. Please try again.');
  };

  command('refresh', () => controller.refresh(true));
  command('toggle', async () => {
    const enabled = !controller.enabled;
    controller.setEnabled(enabled);
    await context.workspaceState.update('enabled', enabled);
  });
  command('showChangedFiles', () => vscode.commands.executeCommand('guttered.changedFiles.focus'));
  command('openFile', node => changedFiles.openFile(node));
  command('changeBase', async () => {
    const editorUri = vscode.window.activeTextEditor?.document.uri;
    const activeUri = editorUri?.scheme === 'file' ? editorUri : changedFiles.uri;
    const uri = activeUri?.scheme === 'file' ? activeUri : vscode.workspace.workspaceFolders?.[0]?.uri;
    const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    const scope = folder ? `workspace folder "${folder.name}"` : 'user settings, affecting all workspaces';
    const settings = vscode.workspace.getConfiguration('guttered', uri);
    const current = settings.get<string>('baseReference', '').trim();
    // locate expects a file path; a placeholder also works with no open editor.
    const file = activeUri?.scheme === 'file' ? activeUri.fsPath : uri && path.join(uri.fsPath, '.guttered');
    const repository = file ? (await controller.git.locate(file))?.repository : undefined;
    const branches = repository ? await repository.branches() : [];
    const items: (vscode.QuickPickItem & { reference?: string; custom?: boolean })[] = [
      { label: 'Default branch (automatic)', description: current ? undefined : 'Selected', detail: 'Merge base with the repository’s default branch', reference: '' },
      { label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
      ...branches.map(branch => ({
        label: branch.name,
        description: `${branch.ref.startsWith('refs/remotes/') ? 'Remote branch' : 'Local branch'}${current === branch.ref || current === branch.name ? ' · selected' : ''}`,
        reference: branch.ref,
      })),
      { label: 'Other reference', kind: vscode.QuickPickItemKind.Separator },
      { label: 'Enter another Git reference…', description: 'Tag, commit, or other ref', custom: true },
    ];
    const selected = await vscode.window.showQuickPick(items, {
      title: 'Guttered: Base Reference',
      placeHolder: `Type to filter branches. Applies to ${scope}.`,
    });
    if (!selected) return;
    const value = selected.custom ? await vscode.window.showInputBox({
      title: 'Guttered: Base Reference',
      prompt: `Applies to ${scope}. Leave empty to detect the default branch; comparisons always use the merge base.`,
      placeHolder: 'Automatic (remote default branch)',
      value: current,
      validateInput: input => input.trim().startsWith('-') || /\s/.test(input.trim()) ? 'Use a Git reference without whitespace or a leading hyphen.' : undefined,
    }) : selected.reference;
    if (value === undefined) return;
    const target = folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
    await settings.update('baseReference', value.trim(), target);
  });
  command('previewChange', async (...args) => {
    const target = commandTarget(args);
    const { editor: shown, document } = targetEditor(target);
    if (!document || document.isClosed || document.uri.scheme !== 'file') return;
    // Prefer an ordinary source editor when invoked from the native diff.
    // Read-only previews may follow a fresh comparison even if its editor object changed.
    const source = vscode.window.visibleTextEditors.find(editor => editor.document === document
      && vscode.window.tabGroups.all.some(group => group.viewColumn === editor.viewColumn
        && group.activeTab?.input instanceof vscode.TabInputText));
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: source?.viewColumn ?? shown?.viewColumn, preview: false,
    });
    const line = target?.line ?? editor.selection.active.line;
    for (let attempt = 0; attempt < 3; attempt++) {
      const comparison = await controller.compare(document, true);
      if (document.isClosed) return;
      if (comparison && comparison.version === document.version) return diffPanel.show(editor, comparison, line);
      if (controller.reason(document.uri)) break;
    }
    void vscode.window.showInformationMessage(controller.reason(document.uri) ?? 'Guttered: the comparison changed. Please try again.');
  });
  command('openDiff', async (...args) => {
    const target = commandTarget(args);
    return withComparison(target, async (editor, comparison) => {
      const { snapshot, path: file } = comparison;
      const uri = vscode.Uri.from({
        scheme: baselineScheme, path: `/${file}`,
        query: JSON.stringify({ root: snapshot.root, mergeBase: snapshot.mergeBase, file, maxBytes: configuration(editor.document.uri).maxBytes }),
      });
      const line = target?.line === undefined ? undefined : Math.min(target.line, editor.document.lineCount - 1);
      const selection = line === undefined ? undefined : new vscode.Range(line, 0, line, 0);
      await vscode.commands.executeCommand('vscode.diff', uri, editor.document.uri,
        `${path.basename(file)} · ${snapshot.baseRef} merge-base ${snapshot.mergeBase.slice(0, 8)}`, { preview: true, selection });
    });
  });
  for (const [name, direction] of [['nextChange', 1], ['previousChange', -1]] as const) {
    command(name, () => withComparison(undefined, (editor, comparison) => {
      const targets = [...new Set(comparison.diff.hunks.map(hunk => hunkLine(hunk, editor.document.lineCount)))];
      if (!targets.length) return;
      const current = editor.selection.active.line;
      const ordered = direction === 1 ? targets : targets.reverse();
      const target = ordered.find(line => direction === 1 ? line > current : line < current) ?? ordered[0]!;
      editor.selection = new vscode.Selection(target, 0, target, 0);
      editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }));
  }
  command('restoreChange', async (...args) => {
    const target = commandTarget(args);
    return withComparison(target, async (editor, comparison) => {
      const document = editor.document;
      if (document.version !== comparison.version) return;
      const line = target?.line ?? editor.selection.active.line;
      const hunk = hunkAtLine(comparison.diff.hunks, line, document.lineCount);
      if (!hunk) {
        void vscode.window.showInformationMessage(target?.line === undefined
          ? 'Guttered: place the cursor on a changed line or deletion marker first.'
          : `Guttered: line ${line + 1} has no change from the merge base.`);
        return;
      }
      const current = document.getText();
      const replacement = restoreHunk(current, hunk, document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
      const change = minimalTextChange(current, replacement);
      const range = new vscode.Range(document.positionAt(change.start), document.positionAt(change.end));
      await editor.edit(edit => edit.replace(range, change.text), { undoStopBefore: true, undoStopAfter: true });
      await controller.compare(document);
    });
  });
  command('actions', async () => {
    const actions = [
      { label: controller.enabled ? '$(circle-slash) Disable Guttered' : '$(check) Enable Guttered', command: 'toggle' },
      { label: '$(list-tree) Show Changed Files', command: 'showChangedFiles' },
      { label: '$(diff) Preview Change with Merge Base', command: 'previewChange' },
      { label: '$(diff) Open Diff with Merge Base', command: 'openDiff' },
      { label: '$(arrow-down) Go to Next Change', command: 'nextChange' },
      { label: '$(arrow-up) Go to Previous Change', command: 'previousChange' },
      { label: '$(discard) Restore Change from Merge Base', description: 'At the cursor; undoable, does not save or stage', command: 'restoreChange' },
      { label: '$(git-branch) Change Base Reference', command: 'changeBase' },
      { label: '$(refresh) Refresh Comparison', command: 'refresh' },
    ];
    const selected = await vscode.window.showQuickPick(actions, { title: 'Guttered', placeHolder: 'Changes since the branch’s merge base' });
    if (selected) await vscode.commands.executeCommand(`guttered.${selected.command}`);
  });
  return controller;
}
