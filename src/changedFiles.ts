import * as vscode from 'vscode';
import path from 'node:path';
import { configuration } from './config';
import type { Controller } from './controller';
import { fileTree, includeUnsaved, type EditedFile, type FileNode } from './files';
import type { FileChange, Snapshot } from './git';
import { baselineUri } from './nativeDiff';

const changeScheme = 'guttered-change';
const statuses = {
  A: { label: 'Added', color: 'editorGutter.addedBackground' },
  M: { label: 'Modified', color: 'editorGutter.modifiedBackground' },
  D: { label: 'Deleted', color: 'editorGutter.deletedBackground' },
} as const;

export class ChangedFiles implements vscode.TreeDataProvider<FileNode>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<FileNode>;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly fileUris = new WeakMap<FileNode, vscode.Uri>();
  private nodes: FileNode[] = [];
  private anchor?: vscode.Uri;
  private snapshot?: Snapshot;
  private saved?: { root: string; mergeBase: string; files: FileChange[] };
  private fingerprint = '';
  private generation = 0;
  private diskRequested = false;
  private running = false;
  private queued = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly controller: Controller) {
    // Leave the view badge unset: VS Code adds it to the Source Control icon count.
    this.view = vscode.window.createTreeView('guttered.changedFiles', { treeDataProvider: this, showCollapseAll: true });
    this.view.title = 'Guttered: Branch Changes';
    this.anchor = vscode.window.activeTextEditor?.document.uri;
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const diskChanged = (uri: vscode.Uri) => {
      if (uri.fsPath.split(path.sep).includes('.git')) return;
      if (this.snapshot) {
        const relative = path.relative(this.snapshot.root, uri.fsPath);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
      }
      this.schedule(true);
    };
    this.subscriptions.push(
      vscode.window.registerFileDecorationProvider(this),
      watcher, watcher.onDidCreate(diskChanged), watcher.onDidChange(diskChanged), watcher.onDidDelete(diskChanged),
      this.view.onDidChangeVisibility(() => this.schedule(true)),
      controller.onDidRefresh(() => this.schedule(true)),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor?.document.uri.scheme === 'file') this.anchor = editor.document.uri;
        else if (!editor) this.anchor = undefined;
        this.schedule(true);
      }),
      vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) this.schedule(false); }),
      vscode.workspace.onDidSaveTextDocument(() => this.schedule(true)),
      vscode.workspace.onDidCloseTextDocument(() => this.schedule(false)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.anchor = vscode.window.activeTextEditor?.document.uri;
        this.schedule(true);
      }),
    );
    this.schedule(true);
  }

  get uri(): vscode.Uri | undefined { return this.anchor; }

  getChildren(node?: FileNode): FileNode[] { return node ? node.children : this.nodes; }

  async openFile(node: unknown): Promise<void> {
    if (!node || typeof node !== 'object') return;
    // Keep the action tied to the displayed row, even if the active repository changes.
    const uri = this.fileUris.get(node as FileNode);
    if (uri) await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const status = uri.query;
    if (uri.scheme !== changeScheme || (status !== 'A' && status !== 'M' && status !== 'D')) return;
    return new vscode.FileDecoration(status, statuses[status].label, new vscode.ThemeColor(statuses[status].color));
  }

  getTreeItem(node: FileNode): vscode.TreeItem {
    const snapshot = this.snapshot;
    if (!snapshot) return new vscode.TreeItem(path.posix.basename(node.path));
    const uri = vscode.Uri.file(path.join(snapshot.root, node.path));
    const item = new vscode.TreeItem(path.posix.basename(node.path), node.status
      ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
    item.id = JSON.stringify([snapshot.root, node.path, !!node.status]);
    item.iconPath = node.status ? vscode.ThemeIcon.File : vscode.ThemeIcon.Folder;
    if (node.status) {
      if (node.status !== 'D') {
        item.contextValue = 'gutteredFile';
        this.fileUris.set(node, uri);
      }
      // Keep theme file icons while isolating badges from working-tree Git.
      // Including the status in the URI also avoids stale decoration caches.
      item.resourceUri = uri.with({ scheme: changeScheme, query: node.status });
      item.tooltip = `${statuses[node.status].label}: ${node.path}\nCompared with ${snapshot.baseRef} merge base ${snapshot.mergeBase.slice(0, 8)}`;
      const baseline = baselineUri(uri, snapshot, node.path, configuration(uri).maxBytes);
      const current = node.status === 'D' ? uri.with({ scheme: 'guttered-empty' }) : uri;
      item.command = {
        command: 'guttered.openFileDiff', title: 'Open Diff with Merge Base',
        arguments: [baseline, current, `${path.posix.basename(node.path)} · ${snapshot.baseRef} merge-base ${snapshot.mergeBase.slice(0, 8)}`],
      };
    }
    return item;
  }

  private schedule(disk: boolean): void {
    ++this.generation;
    clearTimeout(this.timer);
    this.diskRequested ||= disk;
    if (this.disposed) return;
    if (!this.controller.enabled) {
      this.display([], undefined, 'Guttered is off. Use Toggle On/Off to enable it.');
      return;
    }
    // A collapsed or hidden view must not scan the repository on every poll.
    if (!this.view.visible) return;
    const delay = this.anchor ? configuration(this.anchor).debounceMs : 250;
    this.timer = setTimeout(() => { void this.refresh(); }, delay);
  }

  private async refresh(): Promise<void> {
    if (this.running) { this.queued = true; return; }
    this.running = true;
    try {
      do {
        this.queued = false;
        const generation = this.generation;
        const disk = this.diskRequested;
        this.diskRequested = false;
        await this.load(generation, disk);
      } while (this.queued && !this.disposed && this.controller.enabled && this.view.visible);
    } finally {
      this.running = false;
    }
  }

  private async load(generation: number, disk: boolean): Promise<void> {
    const valid = () => !this.disposed && this.controller.enabled && this.view.visible && generation === this.generation;
    try {
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
      const uri = this.anchor?.scheme === 'file' ? this.anchor : workspace && vscode.Uri.joinPath(workspace, '.guttered');
      if (!uri) { this.display([], undefined, 'Open a file or workspace in a Git repository.'); return; }
      const config = configuration(uri);
      if (!config.enabled) { this.display([], undefined, 'Comparison disabled in Guttered settings.'); return; }
      const location = await this.controller.git.locate(uri.fsPath);
      if (!valid()) return;
      if (!location) { this.display([], undefined, 'No Git repository contains the selected file or workspace.'); return; }
      const snapshot = await location.repository.snapshot(config.reference, disk);
      if (!valid()) return;
      let saved = this.saved;
      if (disk || !saved || saved.root !== snapshot.root || saved.mergeBase !== snapshot.mergeBase) {
        saved = { root: snapshot.root, mergeBase: snapshot.mergeBase, files: await location.repository.changedFiles(snapshot.mergeBase) };
      }
      if (!valid()) return;
      this.saved = saved;
      const documents: EditedFile[] = [];
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.scheme !== 'file' || !document.isDirty || document.isClosed) continue;
        const edited = await this.controller.git.locate(document.uri.fsPath);
        if (!valid()) return;
        // A dirty document in a nested repository belongs to its own comparison.
        if (edited?.repository.root === snapshot.root) {
          documents.push({ path: edited.path, text: document.getText(), maxBytes: configuration(document.uri).maxBytes });
        }
      }
      const files = await includeUnsaved(this.controller.git, location.repository, snapshot, saved.files, documents);
      if (valid()) this.display(files, snapshot, files.length ? undefined : `No changes from the ${snapshot.baseRef} merge base.`);
    } catch (error) {
      if (valid()) this.display([], undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private display(files: FileChange[], snapshot: Snapshot | undefined, message?: string): void {
    const fingerprint = JSON.stringify([snapshot?.key, files, message]);
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    this.snapshot = snapshot;
    this.nodes = fileTree(files);
    this.view.message = message;
    this.view.description = snapshot ? `${path.basename(snapshot.root)} · ${snapshot.baseRef} (merge-base)` : undefined;
    this.changed.fire();
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    clearTimeout(this.timer);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.view.dispose();
    this.changed.dispose();
  }
}
