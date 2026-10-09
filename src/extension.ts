import * as vscode from 'vscode';
import path from 'node:path';
import { configuration } from './config';
import { Controller, type Comparison, type GitAPI, type GitExtension } from './controller';
import { hunkAtLine, hunkLine, minimalTextChange, restoreHunk } from './diff';

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
  const controller = new Controller(gitApi);
  context.subscriptions.push(controller);
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

  const command = (name: string, action: () => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(`guttered.${name}`, async () => {
      try {
        return await action();
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
  command('changeBase', async () => {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const uri = activeUri?.scheme === 'file' ? activeUri : vscode.workspace.workspaceFolders?.[0]?.uri;
    const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    const scope = folder ? `workspace folder "${folder.name}"` : 'user settings, affecting all workspaces';
    const value = await vscode.window.showInputBox({
      title: 'Guttered: Base Reference',
      prompt: `Applies to ${scope}. Leave empty to detect the default branch; comparisons always use the merge base.`,
      placeHolder: 'Automatic (remote default branch)',
      value: vscode.workspace.getConfiguration('guttered', uri).get<string>('baseReference', ''),
      validateInput: input => input.trim().startsWith('-') || /\s/.test(input.trim()) ? 'Use a Git reference without whitespace or a leading hyphen.' : undefined,
    });
    if (value === undefined) return;
    const target = folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('guttered', uri).update('baseReference', value.trim(), target);
  });
  command('openDiff', () => withComparison(async (editor, comparison) => {
    const { snapshot, path: file } = comparison;
    const uri = vscode.Uri.from({
      scheme: baselineScheme, path: `/${file}`,
      query: JSON.stringify({ root: snapshot.root, mergeBase: snapshot.mergeBase, file, maxBytes: configuration(editor.document.uri).maxBytes }),
    });
    await vscode.commands.executeCommand('vscode.diff', uri, editor.document.uri,
      `${path.basename(file)} · ${snapshot.baseRef} merge-base ${snapshot.mergeBase.slice(0, 8)}`, { preview: true });
  }));
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
