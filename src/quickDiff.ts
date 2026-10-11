import * as vscode from 'vscode';
import path from 'node:path';
import { configuration } from './config';
import type { Comparison, Controller } from './controller';
import { baselineUri, matchLanguage } from './nativeDiff';

interface Provider {
  scm: vscode.SourceControl;
  group: vscode.SourceControlResourceGroup;
  fingerprint: string;
}

/** Stable SCM quick-diff providers; VS Code owns the gutter, grammar and peek. */
export class QuickDiff implements vscode.Disposable {
  private readonly providers = new Map<string, Provider>();
  private readonly originals = new Map<string, { mergeBase: string; version: number }>();
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;

  constructor(private readonly controller: Controller) {
    this.subscriptions = [
      controller.onDidChangeComparison(() => this.sync()),
      controller.onDidRefresh(() => this.sync()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.sync()),
    ];
    this.sync();
  }

  sync(): void {
    if (this.disposed) return;
    const roots = new Map<string, { document: vscode.TextDocument; comparison: Comparison }[]>();
    for (const editor of vscode.window.visibleTextEditors) {
      const document = editor.document, config = configuration(document.uri);
      const comparison = this.controller.getComparison(document.uri);
      if (!this.controller.enabled || document.isClosed || document.uri.scheme !== 'file'
        || !config.enabled || config.diffView !== 'quickDiff' || !comparison) continue;
      const files = roots.get(comparison.snapshot.root) ?? [];
      if (!files.some(file => file.document === document)) files.push({ document, comparison });
      roots.set(comparison.snapshot.root, files);
    }
    for (const [root, entry] of this.providers) {
      if (!roots.has(root)) { entry.scm.dispose(); this.providers.delete(root); }
    }
    const visible = new Set([...roots.values()].flatMap(files => files.map(file => file.document.uri.toString())));
    for (const key of this.originals.keys()) if (!visible.has(key)) this.originals.delete(key);
    for (const [root, files] of roots) {
      let entry = this.providers.get(root);
      if (!entry) {
        const scm = vscode.scm.createSourceControl('guttered', `Guttered merge base (${path.basename(root)})`, vscode.Uri.file(root));
        scm.inputBox.visible = false;
        scm.count = 0;
        const group = scm.createResourceGroup('openChanges', 'Changes in open files');
        group.hideWhenEmpty = true;
        entry = { scm, group, fingerprint: '' };
        this.providers.set(root, entry);
        const provider = entry;
        scm.quickDiffProvider = { provideOriginalResource: async (uri, token) => {
          if (this.disposed || token.isCancellationRequested || this.providers.get(root) !== provider || uri.scheme !== 'file') return;
          const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
          if (!document || document.isClosed) return;
          const config = configuration(uri);
          if (!this.controller.enabled || !config.enabled || config.diffView !== 'quickDiff') return;
          let comparison = this.controller.getComparison(uri);
          if (comparison?.version !== document.version) comparison = await this.controller.compare(document);
          if (!comparison || document.isClosed || comparison.version !== document.version || comparison.snapshot.root !== root
            || token.isCancellationRequested || this.providers.get(root) !== provider) return;
          const original = baselineUri(uri, comparison.snapshot, comparison.path, config.maxBytes);
          await matchLanguage(original, document);
          if (token.isCancellationRequested || this.providers.get(root) !== provider) return;
          this.originals.set(uri.toString(), { mergeBase: comparison.snapshot.mergeBase, version: document.version });
          return original;
        } };
      }
      const fingerprint = JSON.stringify(files.map(({ document, comparison }) => [document.uri.toString(), document.version, comparison.snapshot.key, comparison.diff.hunks.length]));
      if (fingerprint === entry.fingerprint) continue;
      entry.fingerprint = fingerprint;
      // A resource update also re-asks the provider after a ref/merge-base change.
      entry.group.resourceStates = files.filter(file => file.comparison.diff.hunks.length).map(({ document, comparison }) => ({
        resourceUri: document.uri, contextValue: `${comparison.snapshot.key}:${document.version}`,
        command: { command: 'guttered.openDiff', title: 'Open Diff with Merge Base', arguments: [document.uri.toString(), 0] },
      }));
    }
    if (!this.providers.size) this.originals.clear();
  }

  hasOriginal(uri: vscode.Uri, mergeBase: string): boolean {
    return this.originals.get(uri.toString())?.mergeBase === mergeBase;
  }

  async show(editor: vscode.TextEditor, line: number): Promise<void> {
    this.sync();
    const document = editor.document, version = document.version;
    const deadline = Date.now() + 2_000;
    while (this.originals.get(document.uri.toString())?.version !== version && Date.now() < deadline
      && !document.isClosed && document.version === version && this.controller.enabled) {
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    // Give the native diff worker time to consume a newly registered baseline.
    await new Promise(resolve => setTimeout(resolve, 150));
    if (this.disposed || document.isClosed || document.version !== version || !this.controller.enabled
      || configuration(document.uri).diffView !== 'quickDiff' || vscode.window.activeTextEditor?.document !== document) return;
    const commands = await vscode.commands.getCommands();
    await vscode.commands.executeCommand(commands.includes('closeQuickDiff') ? 'closeQuickDiff' : 'closeDirtyDiff');
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    // Opening the native peek has no public API. This existing editor command
    // can initially select Git at overlaps; its native selector chooses a base.
    await vscode.commands.executeCommand('editor.action.dirtydiff.next');
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.providers.values()) entry.scm.dispose();
    this.providers.clear(); this.originals.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
