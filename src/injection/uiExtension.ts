import * as vscode from 'vscode';
import { WorkbenchInstaller } from './installer';
import { helperCommand } from './protocol';

// The companion is pinned to the UI host. In a Windows/WSL window this module
// runs on Windows, while the controller and Git remain in the WSL extension.
export function activate(context: vscode.ExtensionContext): void {
  const installer = new WorkbenchInstaller(context);
  context.subscriptions.push(installer);
  let operation: Promise<unknown> = Promise.resolve();
  for (const name of ['connect', 'enable', 'disable', 'status', 'disconnect'] as const) {
    context.subscriptions.push(vscode.commands.registerCommand(helperCommand(name), (session: unknown, revision: unknown) => {
      const action = () => name === 'disable' || name === 'disconnect' ? installer[name](session) : installer[name](session, revision);
      const result = operation.then<unknown>(action);
      operation = result.catch(() => {});
      return result;
    }));
  }
}
