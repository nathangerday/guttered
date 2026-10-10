import * as vscode from 'vscode';
import path from 'node:path';
import { configuration } from './config';
import { Controller, type Comparison, type GitAPI, type GitExtension } from './controller';
import { hunkAtLine, hunkLine, minimalTextChange, restoreHunk } from './diff';
import { ChangePeek } from './peek';
import { ChangedFiles } from './changedFiles';

const baselineScheme = 'guttered-base';

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
  const peek = new ChangePeek();
  context.subscriptions.push(peek, vscode.workspace.registerTextDocumentContentProvider(ChangePeek.scheme, peek));
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
  const withComparison = async (action: (editor: vscode.TextEditor, comparison: Comparison) => unknown) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const version = editor.document.version;
    // A visibility/configuration event may invalidate work without changing text.
    // Retry that case, but never apply an action after the user has edited or switched.
    for (let attempt = 0; attempt < 3; attempt++) {
      const comparison = await controller.compare(editor.document, true);
      if (vscode.window.activeTextEditor !== editor || editor.document.version !== version) return;
      if (comparison) return action(editor, comparison);
      if (controller.reason(editor.document.uri)) break;
    }
    void vscode.window.showInformationMessage(controller.reason(editor.document.uri) ?? 'Guttered: the comparison changed. Please try again.');
  };

  command('refresh', () => controller.refresh(true));
  command('toggle', async () => {
    const enabled = !controller.enabled;
    controller.setEnabled(enabled);
    await context.workspaceState.update('enabled', enabled);
  });
  command('showChangedFiles', () => vscode.commands.executeCommand('guttered.changedFiles.focus'));
  command('peekChange', () => withComparison(async (editor, comparison) => {
    const position = editor.selection.active;
    const hunk = hunkAtLine(comparison.diff.hunks, position.line, editor.document.lineCount);
    if (!hunk) {
      void vscode.window.showInformationMessage('Guttered: place the cursor on a changed line or deletion boundary first.');
      return;
    }
    await vscode.commands.executeCommand('editor.action.peekLocations', editor.document.uri, position,
      [new vscode.Location(peek.create(comparison, hunk), new vscode.Range(3, 0, 3, 0))], 'peek');
  }));
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
  command('openDiff', async (targetUri, targetLine) => {
    if (targetUri !== undefined) {
      if (typeof targetUri !== 'string' || typeof targetLine !== 'number' || !Number.isSafeInteger(targetLine) || targetLine < 0) {
        throw new Error('Invalid diff target.');
      }
      // Explicit targets keep their own document, even if focus has moved to a split editor.
      const document = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'file' && document.uri.toString() === targetUri);
      if (!document || document.isClosed) return;
      await vscode.window.showTextDocument(document);
      if (vscode.window.activeTextEditor?.document !== document) return;
    }
    return withComparison(async (editor, comparison) => {
      const { snapshot, path: file } = comparison;
      const uri = vscode.Uri.from({
        scheme: baselineScheme, path: `/${file}`,
        query: JSON.stringify({ root: snapshot.root, mergeBase: snapshot.mergeBase, file, maxBytes: configuration(editor.document.uri).maxBytes }),
      });
      const selection = typeof targetLine === 'number'
        ? new vscode.Range(Math.min(targetLine, editor.document.lineCount - 1), 0, Math.min(targetLine, editor.document.lineCount - 1), 0)
        : undefined;
      await vscode.commands.executeCommand('vscode.diff', uri, editor.document.uri,
        `${path.basename(file)} · ${snapshot.baseRef} merge-base ${snapshot.mergeBase.slice(0, 8)}`, { preview: true, selection });
    });
  });
  for (const [name, direction] of [['nextChange', 1], ['previousChange', -1]] as const) {
    command(name, () => withComparison((editor, comparison) => {
      const targets = [...new Set(comparison.diff.hunks.map(hunk => hunkLine(hunk, editor.document.lineCount)))];
      if (!targets.length) return;
      const current = editor.selection.active.line;
      const ordered = direction === 1 ? targets : targets.reverse();
      const target = ordered.find(line => direction === 1 ? line > current : line < current) ?? ordered[0]!;
      editor.selection = new vscode.Selection(target, 0, target, 0);
      editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }));
  }
  command('restoreChange', () => withComparison(async (editor, comparison) => {
    const document = editor.document;
    if (document.version !== comparison.version) return;
    const hunk = hunkAtLine(comparison.diff.hunks, editor.selection.active.line, document.lineCount);
    if (!hunk) {
      void vscode.window.showInformationMessage('Guttered: place the cursor on a changed line or deletion marker first.');
      return;
    }
    const current = document.getText();
    const replacement = restoreHunk(current, hunk, document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    const change = minimalTextChange(current, replacement);
    const range = new vscode.Range(document.positionAt(change.start), document.positionAt(change.end));
    await editor.edit(edit => edit.replace(range, change.text), { undoStopBefore: true, undoStopAfter: true });
    await controller.compare(document);
  }));
  command('actions', async () => {
    const actions = [
      { label: controller.enabled ? '$(circle-slash) Disable Guttered' : '$(check) Enable Guttered', command: 'toggle' },
      { label: '$(list-tree) Show Changed Files', command: 'showChangedFiles' },
      { label: '$(eye) Peek Change', description: 'Read-only diff below the cursor', command: 'peekChange' },
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
