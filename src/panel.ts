import * as vscode from 'vscode';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { configuration } from './config';
import type { Comparison, Controller } from './controller';
import { hunkAtLine, hunkLine, minimalTextChange, restoreHunk } from './diff';
import { hunkPatch, previewRows } from './preview';
import type { PanelMessage, PanelView } from './panel/model';

export class DiffPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private document?: vscode.TextDocument;
  private comparison?: Comparison;
  private view?: PanelView;
  private sourceColumn?: vscode.ViewColumn;
  private index = 0;
  private revision = 0;
  private request = 0;
  private undoVersion?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private actions: Promise<void> = Promise.resolve();
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly context: vscode.ExtensionContext, private readonly controller: Controller) {
    this.subscriptions = [
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document !== this.document) return;
        if (event.contentChanges.length) this.schedule();
        else this.post(); // Saved/dirty state can change without changing the diff.
      }),
      controller.onDidChangeComparison(() => {
        if (!this.document || !this.panel?.visible) return;
        const comparison = controller.getComparison(this.document.uri);
        if (comparison && comparison.version === this.document.version) {
          if (comparison.diff !== this.comparison?.diff || comparison.snapshot.key !== this.comparison?.snapshot.key) {
            void this.update(comparison);
          }
        } else if (!controller.enabled) void this.unavailable(controller.reason(this.document.uri));
      }),
      controller.onDidRefresh(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (this.document && event.affectsConfiguration('guttered', this.document.uri)) this.schedule();
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (document === this.document) void this.unavailable('This file is closed. Open it again to continue comparing.');
      }),
    ];
  }

  async show(editor: vscode.TextEditor, comparison: Comparison, line: number): Promise<void> {
    const changedDocument = this.document !== editor.document;
    this.document = editor.document;
    this.sourceColumn = editor.viewColumn;
    if (changedDocument) this.undoVersion = undefined;
    const hunk = hunkAtLine(comparison.diff.hunks, line, editor.document.lineCount);
    this.index = hunk ? comparison.diff.hunks.indexOf(hunk)
      : Math.max(0, comparison.diff.hunks.findIndex(change => hunkLine(change, editor.document.lineCount) >= line));
    this.view = undefined;
    this.comparison = undefined;
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('guttered.diffPanel', 'Guttered: Changes',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] });
      this.panel = panel;
      panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'icon.png');
      panel.webview.html = this.html(panel.webview);
      panel.onDidDispose(() => {
        ++this.request;
        clearTimeout(this.timer);
        this.panel = undefined;
        this.document = undefined;
        this.comparison = undefined;
        this.view = undefined;
        this.undoVersion = undefined;
      });
      panel.webview.onDidReceiveMessage((message: unknown) => {
        this.actions = this.actions.then(() => this.receive(message)).catch(error => {
          this.notice(error instanceof Error ? error.message : String(error), true);
        });
      });
      panel.onDidChangeViewState(event => { if (event.webviewPanel.visible) this.schedule(); });
    } else this.panel.reveal(this.panel.viewColumn);
    await this.update(comparison);
  }

  private schedule(): void {
    if (!this.panel?.visible || !this.document || this.document.isClosed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.refresh(); }, configuration(this.document.uri).debounceMs);
  }

  private async refresh(): Promise<void> {
    const document = this.document;
    if (!document) return;
    if (document.isClosed) { await this.unavailable('This file is closed. Open it again to continue comparing.'); return; }
    try {
      const comparison = await this.controller.compare(document, true);
      if (document !== this.document || document.isClosed) return;
      if (comparison) await this.update(comparison);
      else await this.unavailable(this.controller.reason(document.uri) ?? 'The comparison changed. Refresh to try again.');
    } catch (error) {
      if (document === this.document) await this.unavailable(error instanceof Error ? error.message : String(error));
    }
  }

  private async update(comparison: Comparison): Promise<void> {
    const document = this.document, panel = this.panel;
    if (!document || !panel || comparison.version !== document.version) return;
    if (this.comparison?.diff === comparison.diff && this.comparison.snapshot.key === comparison.snapshot.key
      && this.view?.index === this.index && !this.view.reason) {
      if (this.view.dirty !== document.isDirty || this.view.canUndo !== (this.undoVersion === document.version)) this.post();
      return;
    }
    const request = ++this.request;
    try {
      const baseline = await this.controller.git.baseline(comparison.snapshot, comparison.path, configuration(document.uri).maxBytes);
      if (request !== this.request || document !== this.document || comparison.version !== document.version) return;
      const same = this.comparison?.diff === comparison.diff && this.comparison?.snapshot.key === comparison.snapshot.key;
      // Follow the same source location when edits or a revert shift the change list.
      if (!same && this.view) {
        const line = this.view.line - 1;
        const found = comparison.diff.hunks.findIndex(hunk => hunkLine(hunk, document.lineCount) >= line);
        this.index = found < 0 ? comparison.diff.hunks.length - 1 : found;
      }
      this.index = Math.max(0, Math.min(this.index, comparison.diff.hunks.length - 1));
      this.comparison = comparison;
      const hunk = comparison.diff.hunks[this.index];
      const current = document.getText();
      this.view = {
        revision: ++this.revision,
        name: path.basename(comparison.path), path: comparison.path,
        baseRef: comparison.snapshot.baseRef, mergeBase: comparison.snapshot.mergeBase.slice(0, 8),
        branch: comparison.snapshot.branch, dirty: document.isDirty,
        index: this.index, count: comparison.diff.hunks.length,
        line: hunk ? hunkLine(hunk, document.lineCount) + 1 : 1,
        added: comparison.diff.hunks.reduce((count, hunk) => count + hunk.newLines.length, 0),
        removed: comparison.diff.hunks.reduce((count, hunk) => count + hunk.oldLines.length, 0),
        rows: previewRows(baseline.text, current, comparison.diff.hunks, this.index),
        // Tokenization runs in an isolated worker. Keep its input bounded too.
        syntax: hunk && baseline.text.length <= 1024 * 1024 && current.length <= 1024 * 1024 ? {
          key: `${document.uri.toString()}:${document.version}:${comparison.snapshot.mergeBase}:${document.languageId}`,
          language: document.languageId, old: baseline.text, current,
        } : undefined,
        canUndo: this.undoVersion === document.version,
      };
      panel.title = `${this.view.name} · Guttered`;
      this.post();
    } catch (error) {
      if (request === this.request) await this.unavailable(error instanceof Error ? error.message : String(error));
    }
  }

  private async unavailable(reason = 'The comparison is unavailable.'): Promise<void> {
    ++this.request;
    this.comparison = undefined;
    if (this.view) {
      this.view = { ...this.view, revision: ++this.revision, rows: [], syntax: undefined, count: 0, canUndo: false, reason };
      this.post();
    } else void this.panel?.webview.postMessage({ type: 'unavailable', reason });
  }

  private post(): void {
    if (this.view && this.panel) {
      this.view.dirty = this.document?.isDirty ?? this.view.dirty;
      this.view.canUndo = this.undoVersion === this.document?.version && !this.view.reason;
      void this.panel.webview.postMessage({ type: 'view', view: this.view });
    }
  }

  private notice(text: string, error = false): void {
    void this.panel?.webview.postMessage({ type: 'notice', text, error });
  }

  private async receive(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return;
    const { action, revision } = value as Partial<PanelMessage>;
    if (action === 'ready') { this.post(); return; }
    if (action === 'refresh') { await this.refresh(); return; }
    const document = this.document, comparison = this.comparison, view = this.view;
    if (!document || document.isClosed || !view) return;
    if (action === 'openFile') {
      await this.focusSource(Math.min(view.line - 1, document.lineCount - 1));
      return;
    }
    if (revision !== view.revision || document.version !== comparison?.version) {
      await this.refresh();
      this.notice('The comparison changed. Review the updated change and try again.', true);
      return;
    }
    if (action === 'previous' || action === 'next') {
      const count = comparison.diff.hunks.length;
      if (count) { this.index = (this.index + (action === 'next' ? 1 : count - 1)) % count; await this.update(comparison); }
      return;
    }
    const hunk = comparison.diff.hunks[this.index];
    if (action === 'copy' && hunk) {
      await vscode.env.clipboard.writeText(hunkPatch(hunk));
      this.notice('Change copied as a unified patch.');
    } else if (action === 'openDiff') {
      await vscode.commands.executeCommand('guttered.openDiff', document.uri.toString(), view.line - 1);
    } else if (action === 'revert' && hunk) {
      // Re-resolve Git refs too: the buffer can be unchanged after a branch switch.
      const latest = await this.controller.compare(document, true);
      if (document !== this.document || document.version !== comparison.version || !latest
        || latest.snapshot.key !== comparison.snapshot.key || latest.diff !== comparison.diff) {
        await this.refresh();
        this.notice('The comparison changed. Review it before reverting.', true);
        return;
      }
      const editor = await this.focusSource(view.line - 1);
      if (!editor || document.version !== comparison.version) { await this.refresh(); return; }
      const current = document.getText();
      const replacement = restoreHunk(current, hunk, document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
      const change = minimalTextChange(current, replacement);
      const edited = await editor.edit(edit => edit.replace(
        new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text),
      { undoStopBefore: true, undoStopAfter: true });
      if (!edited) throw new Error('The editor could not apply this revert. Refresh and try again.');
      this.undoVersion = document.version;
      this.panel?.reveal(this.panel.viewColumn);
      await this.refresh();
      this.notice('Change reverted in the editor. Your file has not been saved or staged.');
    } else if (action === 'undo' && this.undoVersion === document.version) {
      const editor = await this.focusSource(view.line - 1);
      if (!editor || document.version !== this.undoVersion) return;
      this.undoVersion = undefined;
      await vscode.commands.executeCommand('undo');
      this.panel?.reveal(this.panel.viewColumn);
      await this.refresh();
      this.notice('Revert undone.');
    }
  }

  private async focusSource(line: number): Promise<vscode.TextEditor | undefined> {
    const document = this.document;
    if (!document || document.isClosed) return;
    const editor = await vscode.window.showTextDocument(document, { viewColumn: this.sourceColumn,
      preserveFocus: false, preview: false, selection: new vscode.Range(line, 0, line, 0) });
    return editor.document === this.document ? editor : undefined;
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'panel.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'panel.css'));
    const syntax = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'syntax.js'));
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource}; worker-src blob:;">
      <link rel="stylesheet" href="${style}"><title>Guttered changes</title></head>
      <body><main id="app" data-syntax-worker="${syntax}" aria-label="Changes from merge base"><p class="loading" role="status">Loading comparison…</p></main>
      <script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.panel?.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
