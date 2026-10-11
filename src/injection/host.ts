import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { configuration } from '../config';
import { lineMarkers } from '../diff';
import type { Controller } from '../controller';
import { WorkbenchInstaller } from './installer';
import { helperCommand, helperId, hookCommand, disconnectCommand, localWorkbenchHost, payload, type Connection } from './protocol';

export class WorkbenchInjection implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly output = vscode.window.createOutputChannel('Guttered Gutter Click Bridge');
  private readonly session = randomUUID();
  private readonly installer?: WorkbenchInstaller;
  private operation: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(private readonly context: vscode.ExtensionContext, controller: Controller) {
    if (localWorkbenchHost(context)) this.installer = new WorkbenchInstaller(context);
    const command = (name: string, action: () => Promise<unknown>) => {
      this.subscriptions.push(vscode.commands.registerCommand(`guttered.${name}`, () => {
        const run = this.operation.then(action).catch(error => {
          const message = error instanceof Error ? error.message : String(error);
          this.output.appendLine(message);
          void vscode.window.showErrorMessage(`Guttered: ${message}`);
        });
        this.operation = run;
        return run;
      }));
    };
    command('enableWorkbenchInjection', async () => { await this.client('enable'); });
    command('disableWorkbenchInjection', async () => { await this.client('disable'); });
    command('workbenchInjectionStatus', () => this.client('status'));
    this.subscriptions.push(vscode.commands.registerCommand('guttered._workbenchPreview', async (uri: unknown, line: unknown, version: unknown, session: unknown) => {
      // Real URI objects are revived/transformed by VS Code's RPC bridge: the
      // client sees vscode-remote://wsl+... while the WSL host receives file://.
      // Never reinterpret a serialized path or strip a remote authority ourselves.
      if (this.disposed || session !== this.session || !controller.enabled || !(uri instanceof vscode.Uri)
        || uri.scheme !== 'file' || typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0 || typeof version !== 'number') return false;
      const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());
      if (!editor || editor.document.isClosed || editor.document.version !== version) return false;
      const config = configuration(editor.document.uri);
      const comparison = controller.getComparison(editor.document.uri);
      if (!config.enabled || !config.gutter || config.gutterPlacement !== 'glyphMargin' || config.opacity === 0
        || !comparison || comparison.version !== version || !lineMarkers(comparison.diff).some(marker => marker.line === line)) return false;
      await vscode.commands.executeCommand('guttered.previewChange', uri.toString(), line);
      return true;
    }));
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('guttered.workbenchInjection')) void this.connect(false);
    }));
    void this.connect(true);
  }
  private async client(action: 'connect' | 'enable' | 'disable' | 'status'): Promise<unknown> {
    const { revision } = await payload(this.context);
    if (this.installer) {
      if (action === 'disable') return this.installer.disable(this.session);
      return this.installer[action](this.session, revision);
    }
    if (vscode.env.uiKind !== vscode.UIKind.Desktop) throw new Error('Experimental gutter clicks require desktop VS Code.');
    // executeCommand activates a declared UI command on demand. getCommands
    // does not include all declarations before the companion activates.
    try {
      return await vscode.commands.executeCommand(helperCommand(action), this.session, revision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/command.*(?:not found|does not exist|not registered)/i.test(message)) {
        const enabled = vscode.workspace.getConfiguration('guttered').get<boolean>('workbenchInjection', false);
        if (action === 'connect' || action === 'status') {
          // A Windows-first installation already has this built-in workbench
          // command. Remote hosts can connect without a local companion.
          let result: Connection | undefined;
          try { result = await vscode.commands.executeCommand<Connection>(hookCommand, enabled, revision, this.session); } catch {}
          if (action === 'connect' && result) return result;
          const status = !enabled ? 'Experimental gutter clicks are disabled.' : result?.protocol === 2 && result.revision === revision && result.active
            ? 'Experimental gutter clicks are active in this remote window.'
            : 'Enable the gutter-click hook in a local Windows/client window and reload, or install Guttered Workbench locally to enable it from this remote window.';
          if (action === 'status') { void vscode.window.showInformationMessage(`Guttered: ${status}`); return status; }
        }
        throw new Error(`Enable or restore the hook from a local Windows/client window, or install Guttered Workbench (${helperId}) locally to do it from WSL or this remote workspace.`);
      }
      throw error;
    }
  }
  private async connect(notify: boolean): Promise<void> {
    if (this.disposed) return;
    try {
      const result = await this.client('connect') as Connection;
      const { revision } = await payload(this.context);
      if (result?.protocol !== 2 || result.revision !== revision) throw new Error('Gutter clicks need an updated client workbench hook. Run Enable Gutter Clicks and reload the window.');
    } catch (error) {
      if (this.disposed || !vscode.workspace.getConfiguration('guttered').get<boolean>('workbenchInjection', false)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      if (notify) void vscode.window.showInformationMessage(`Guttered: ${message}`);
    }
  }
  dispose(): void {
    this.disposed = true;
    if (this.installer) this.installer.dispose();
    else void Promise.resolve(vscode.commands.executeCommand(helperCommand('disconnect'), this.session))
      .catch(() => vscode.commands.executeCommand(disconnectCommand, this.session)).then(() => {}, () => {});
    for (const disposable of this.subscriptions) disposable.dispose();
    this.output.dispose();
  }
}
