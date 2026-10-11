import * as vscode from 'vscode';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { WorkbenchPatch } from './patch';
import { hookCommand, disconnectCommand, localWorkbenchHost, payload, validSession, type Connection } from './protocol';

export class WorkbenchInstaller implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Guttered Gutter Clicks');
  private readonly configurationListener: vscode.Disposable;
  private session?: string;
  private expectedRevision?: string;
  private active = false;
  private disposed = false;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('guttered.workbenchInjection') && this.session && this.expectedRevision) {
        void this.connect(this.session, this.expectedRevision).catch(error => this.output.appendLine(String(error)));
      }
    });
  }
  private enabled(): boolean { return vscode.workspace.getConfiguration('guttered').get<boolean>('workbenchInjection', false); }
  private async setEnabled(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('guttered');
    // VS Code's Global write target prefers an existing remote value, even
    // when application scope excludes it from reads. Remove a legacy remote
    // override first so the next write targets the client settings.
    if (vscode.env.remoteName) await config.update('workbenchInjection', undefined, vscode.ConfigurationTarget.Global);
    await config.update('workbenchInjection', enabled, vscode.ConfigurationTarget.Global);
  }
  private requireClient(): void {
    if (!localWorkbenchHost(this.context)) throw new Error('Workbench installation requires a desktop UI extension host. Install Guttered Remote/WSL Helper locally on the Windows/client side, not in WSL or another remote.');
  }
  private async compatible(revision: unknown) {
    this.requireClient();
    const bundle = await payload(this.context);
    if (revision !== bundle.revision) throw new Error('Guttered and Guttered Remote/WSL Helper have different gutter-click hooks. Install matching versions on the workspace and client sides, then reload.');
    return bundle;
  }
  private async patch(): Promise<WorkbenchPatch> {
    this.requireClient();
    const file = path.join(vscode.env.appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
    await access(file);
    return new WorkbenchPatch(file);
  }
  async connect(session: unknown, revision: unknown): Promise<Connection> {
    if (!validSession(session)) throw new Error('Invalid gutter-click session.');
    const bundle = await this.compatible(revision);
    if (this.disposed) return { protocol: 2, revision: bundle.revision, active: false };
    this.session = session;
    this.expectedRevision = bundle.revision;
    this.active = false;
    try {
      const result = await vscode.commands.executeCommand<Connection>(hookCommand, this.enabled(), bundle.revision, session);
      this.active = result?.protocol === 2 && result.revision === bundle.revision && result.active && this.enabled() && !this.disposed;
      return { protocol: result?.protocol ?? 0, revision: result?.revision ?? '', active: this.active };
    } catch {
      return { protocol: 0, revision: '', active: false };
    }
  }
  async disconnect(session: unknown): Promise<void> {
    // A late shutdown from an old remote host must not disconnect its successor.
    if (session !== this.session) return;
    this.session = undefined;
    this.active = false;
    await vscode.commands.executeCommand(disconnectCommand, session).then(() => {}, () => {});
  }
  private reloadMessage(message: string): void {
    void vscode.window.showInformationMessage(`Guttered: ${message}`, 'Reload Window').then(action => {
      if (action === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  }
  async enable(session: unknown, revision: unknown): Promise<Connection> {
    if (!validSession(session)) throw new Error('Invalid gutter-click session.');
    const bundle = await this.compatible(revision);
    const patch = await this.patch();
    const changed = await patch.apply(bundle.text);
    await this.setEnabled(true);
    const result = await this.connect(session, bundle.revision);
    this.output.appendLine(`Client hook installed. Backup: ${patch.backup}`);
    if (changed || !result.active) this.reloadMessage('Gutter-click hook installed in the desktop client. Reload the window to activate it. This experimental feature modifies a VS Code file and may trigger an installation-integrity warning.');
    else void vscode.window.showInformationMessage('Guttered: experimental gutter clicks are active.');
    return result;
  }
  async disable(session: unknown): Promise<void> {
    this.requireClient();
    await this.setEnabled(false);
    await this.disconnect(session);
    // Stop even if the caller belongs to a stale session. This is an explicit
    // user disable, unlike the lifetime-only disconnect request.
    await vscode.commands.executeCommand(hookCommand, false).then(() => {}, () => {});
    const changed = await (await this.patch()).restore();
    this.output.appendLine('Gutter clicks disabled; client workbench hook restored.');
    if (changed) this.reloadMessage('Gutter clicks disabled and the desktop workbench file restored. Reload to unload the hook.');
    else void vscode.window.showInformationMessage('Guttered: gutter clicks disabled. No installed hook needed restoration.');
  }
  async status(session: unknown, revision: unknown): Promise<string> {
    const connection = await this.connect(session, revision);
    const message = !this.enabled() ? 'Experimental gutter clicks are disabled.' : connection.active
      ? 'Experimental gutter clicks are active in this window, including remote workspace files.'
      : 'Gutter clicks are enabled but the client workbench hook is unavailable. Run Enable Gutter Clicks and reload this window.';
    this.output.appendLine(message);
    void vscode.window.showInformationMessage(`Guttered: ${message}`);
    return message;
  }
  dispose(): void {
    this.disposed = true;
    this.configurationListener.dispose();
    if (this.session) void this.disconnect(this.session);
    this.output.dispose();
  }
}
