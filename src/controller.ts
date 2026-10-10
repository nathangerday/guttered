import * as vscode from 'vscode';
import { configuration, type Configuration } from './config';
import { Decorations } from './decorations';
import { computeDiff, type LineDiff } from './diff';
import { Git, GitService, type Snapshot } from './git';

const REFERENCE_POLL_MS = 3_000;

export interface Comparison {
  version: number;
  snapshot: Snapshot;
  path: string;
  baselineExists: boolean;
  diff: LineDiff;
}
interface State {
  comparison?: Comparison;
  reason?: string;
  noRepository?: boolean;
  diffKey?: string;
}
interface PendingComparison {
  version: number;
  request: number;
  refreshRefs: boolean;
  result: Promise<Comparison | undefined>;
}

// Use the built-in Git extension's resolved executable and repository events.
// Polling and git.path also work when that extension is disabled.
interface GitRepository { state: { onDidChange: vscode.Event<void> } }
export interface GitAPI {
  git: { path: string };
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}
export interface GitExtension { getAPI(version: 1): GitAPI }

export class Controller implements vscode.Disposable {
  readonly git: GitService;
  private readonly comparisonChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeComparison = this.comparisonChanged.event;
  private readonly refreshed = new vscode.EventEmitter<void>();
  readonly onDidRefresh = this.refreshed.event;
  private readonly decorations = new Decorations();
  private readonly status = vscode.window.createStatusBarItem('guttered.comparison', vscode.StatusBarAlignment.Left, 99);
  private readonly output = vscode.window.createOutputChannel('Guttered');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly gitSubscriptions = new Map<GitRepository, vscode.Disposable>();
  private readonly states = new Map<string, State>();
  // Latest request per document; results from older requests are discarded.
  private readonly requests = new Map<string, number>();
  private readonly pending = new Map<string, PendingComparison>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly poll: ReturnType<typeof setInterval>;
  private sequence = 0;
  private refreshTask?: Promise<void>;
  private refreshRequested = false;
  private manualRefreshRequested = false;
  private disposed = false;

  constructor(api?: GitAPI, private active = true) {
    const configuredPaths = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path');
    this.git = new GitService(new Git(api?.git.path || configuredPaths || 'git'));
    this.status.name = 'Guttered comparison';
    this.status.command = 'guttered.actions';
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.visibleChanged()),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        this.updateStatus();
        if (editor) this.schedule(editor.document, true);
      }),
      vscode.window.onDidChangeWindowState(state => {
        if (state.focused) void this.refresh();
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.contentChanges.length) this.schedule(event.document);
      }),
      vscode.workspace.onDidSaveTextDocument(document => this.schedule(document, true)),
      vscode.workspace.onDidCloseTextDocument(document => this.forget(document.uri.toString())),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('guttered')) return;
        this.decorations.dispose();
        this.states.clear();
        this.requests.clear();
        this.comparisonChanged.fire();
        this.refreshed.fire();
        this.visibleChanged();
        void this.refresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.refresh(); }),
    );
    this.poll = setInterval(() => {
      if (vscode.window.state.focused) void this.refresh();
    }, REFERENCE_POLL_MS);
    this.poll.unref();
    if (api) this.connectGitEvents(api);
    this.visibleChanged();
  }

  get enabled(): boolean { return this.active; }

  setEnabled(enabled: boolean): void {
    if (this.active === enabled) return;
    this.active = enabled;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.requests.clear();
    this.states.clear();
    this.decorations.dispose();
    this.comparisonChanged.fire();
    this.refreshed.fire();
    this.updateStatus();
    if (enabled) {
      this.visibleChanged();
      void this.refresh(true);
    }
  }

  private connectGitEvents(api: GitAPI): void {
    const subscribe = (repository: GitRepository) => {
      if (this.gitSubscriptions.has(repository)) return;
      this.gitSubscriptions.set(repository, repository.state.onDidChange(() => { void this.refresh(); }));
      void this.refresh();
    };
    api.repositories.forEach(subscribe);
    this.disposables.push(api.onDidOpenRepository(subscribe), api.onDidCloseRepository(repository => {
      this.gitSubscriptions.get(repository)?.dispose();
      this.gitSubscriptions.delete(repository);
      void this.refresh();
    }));
  }

  private visibleChanged(): void {
    const editors = vscode.window.visibleTextEditors;
    this.decorations.retain(editors);
    const visible = new Set(editors.map(editor => editor.document.uri.toString()));
    for (const key of this.requests.keys()) {
      if (!visible.has(key)) this.forget(key);
    }
    for (const document of new Set(editors.map(editor => editor.document))) this.schedule(document, true);
    this.updateStatus();
  }

  private forget(key: string): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.states.delete(key);
    this.requests.delete(key);
  }

  private schedule(document: vscode.TextDocument, immediate = false): void {
    if (!this.active || this.disposed) return;
    const visible = vscode.window.visibleTextEditors.some(editor => editor.document === document);
    if (document.uri.scheme !== 'file' || !visible) return;
    const key = document.uri.toString();
    // Invalidate older work immediately, before the debounce timer starts its replacement.
    this.requests.set(key, ++this.sequence);
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.compare(document);
    }, immediate ? 0 : configuration(document.uri).debounceMs));
  }

  refresh(manual = false): Promise<void> {
    if (this.disposed || !this.active) return Promise.resolve();
    this.refreshRequested = true;
    this.manualRefreshRequested ||= manual;
    this.refreshTask ??= this.refreshLoop().finally(() => { this.refreshTask = undefined; });
    return this.refreshTask;
  }

  private async refreshLoop(): Promise<void> {
    do {
      if (!this.active) break;
      this.refreshRequested = false;
      if (this.manualRefreshRequested) {
        this.manualRefreshRequested = false;
        this.git.clearTransientCaches();
        this.states.clear();
        this.requests.clear();
      }
      // Recheck repository boundaries and ignore rules even without built-in Git events.
      this.git.resetDiscovery();
      const documents = new Set(vscode.window.visibleTextEditors.map(editor => editor.document));
      await Promise.all([...documents].map(document => this.compare(document, true)));
    } while (this.refreshRequested && !this.disposed && this.active);
    this.refreshed.fire();
  }

  async compare(document: vscode.TextDocument, refreshRefs = false): Promise<Comparison | undefined> {
    if (this.disposed || !this.active || document.isClosed || document.uri.scheme !== 'file') return;
    const key = document.uri.toString();
    const running = this.pending.get(key);
    const canShare = running?.version === document.version && running.request === this.requests.get(key);
    if (canShare) {
      // A command and background refresh can share the same result. Upgrade a
      // cached-ref comparison afterward if either caller needs fresh refs.
      if (!refreshRefs || running.refreshRefs) return running.result;
      await running.result;
      return this.compare(document, true);
    }
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    const request = ++this.sequence;
    this.requests.set(key, request);
    const result = this.calculate(document, refreshRefs, request, configuration(document.uri)).finally(() => {
      if (this.pending.get(key)?.result === result) this.pending.delete(key);
    });
    this.pending.set(key, { version: document.version, request, refreshRefs, result });
    return result;
  }

  private async calculate(document: vscode.TextDocument, refreshRefs: boolean, request: number, config: Configuration): Promise<Comparison | undefined> {
    const key = document.uri.toString();
    const version = document.version;
    const valid = () => !this.disposed && this.active && !document.isClosed && document.version === version && this.requests.get(key) === request;
    let state: State;
    try {
      if (!config.enabled) throw new Error('Comparison disabled in Guttered settings.');
      const location = await this.git.locate(document.uri.fsPath);
      if (!valid()) return;
      if (!location) {
        state = { noRepository: true, reason: 'No Git repository contains this file.' };
      } else {
        const snapshot = await location.repository.snapshot(config.reference, refreshRefs);
        if (!valid()) return;
        const baseline = await this.git.baseline(snapshot, location.path, config.maxBytes);
        if (!baseline.exists && await location.repository.isIgnored(location.path)) {
          throw new Error('Comparison inactive: this file is ignored by Git.');
        }
        if (!valid()) return;
        const diffKey = JSON.stringify([version, snapshot.root, snapshot.mergeBase, location.path, config.maxBytes]);
        const previous = this.states.get(key);
        const canReuseDiff = previous?.diffKey === diffKey;
        if (canReuseDiff) {
          state = previous.comparison
            ? { diffKey, comparison: { ...previous.comparison, snapshot } }
            : previous;
        } else {
          // Text/algorithm failures depend on these same inputs. Cache them too,
          // so idle polls neither copy the buffer nor retry an expensive diff.
          try {
            const current = document.getText();
            if (Buffer.byteLength(current, 'utf8') > config.maxBytes) throw new Error('Comparison paused: the document exceeds Guttered: Max File Size KB.');
            if (current.includes('\0')) throw new Error('Comparison inactive: this is a binary file.');
            const diff = computeDiff(baseline.text, current);
            state = { diffKey, comparison: { version, snapshot, path: location.path, baselineExists: baseline.exists, diff } };
          } catch (error) {
            state = { diffKey, reason: error instanceof Error ? error.message : String(error) };
          }
        }
      }
    } catch (error) {
      // Git failures can recover without a document edit, so don't give them a diff key.
      state = { reason: error instanceof Error ? error.message : String(error) };
    }
    if (!valid()) return;
    if (state.reason && state.reason !== this.states.get(key)?.reason) this.output.appendLine(`${document.uri.fsPath}: ${state.reason}`);
    const previous = this.getComparison(document.uri);
    this.states.set(key, state);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) this.decorations.apply(editor, state.comparison?.diff, config);
    }
    if (previous?.diff !== state.comparison?.diff || previous?.snapshot.key !== state.comparison?.snapshot.key) {
      this.comparisonChanged.fire();
    }
    this.updateStatus();
    return state.comparison;
  }

  getComparison(uri: vscode.Uri): Comparison | undefined { return this.states.get(uri.toString())?.comparison; }
  reason(uri: vscode.Uri): string | undefined {
    return this.active ? this.states.get(uri.toString())?.reason : 'Guttered is disabled for this workspace. Use Toggle On/Off to enable it.';
  }

  private updateStatus(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      this.status.hide();
      return;
    }
    const state = this.states.get(editor.document.uri.toString());
    if (state?.noRepository) {
      this.status.hide();
      return;
    }
    const comparison = state?.comparison;
    const snapshot = comparison?.snapshot;
    this.status.text = !this.active ? '$(circle-slash) Guttered (off)'
      : snapshot ? `$(git-compare) ${snapshot.baseRef} (merge-base)` : '$(git-compare) Guttered';
    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(comparison
      ? [
        `Current branch: ${comparison.snapshot.branch}`,
        `Base reference: ${comparison.snapshot.baseRef}`,
        `Merge base: ${comparison.snapshot.mergeBase}`,
        'Comparison: active',
        `Changes: ${comparison.diff.hunks.length}`,
      ].join('\n')
      : `Comparison: ${this.reason(editor.document.uri) ?? 'detecting default branch…'}`);
    tooltip.appendMarkdown('\n\nClick for comparison actions.');
    this.status.tooltip = tooltip;
    this.status.show();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.poll);
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const subscription of this.gitSubscriptions.values()) subscription.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.comparisonChanged.dispose();
    this.refreshed.dispose();
    this.decorations.dispose();
    this.status.dispose();
    this.output.dispose();
    this.git.dispose();
  }
}
