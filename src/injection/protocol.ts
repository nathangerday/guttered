import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const helperCommand = (name: string) => `guttered.workbench.${name}`;
export const helperId = 'nathangerday.guttered-workbench';
export const hookCommand = 'guttered._workbenchConnect';
export const disconnectCommand = 'guttered._workbenchDisconnect';
export interface Connection { protocol: number; revision: string; active: boolean }

// remoteName is also set in the Windows UI host of a WSL window. Host kind,
// rather than that name alone, decides whether appRoot belongs to the client.
export function localWorkbenchHost(context: vscode.ExtensionContext): boolean {
  return vscode.env.uiKind === vscode.UIKind.Desktop && !!vscode.env.appRoot
    && (context.extension.extensionKind === vscode.ExtensionKind.UI || !vscode.env.remoteName);
}
export async function payload(context: vscode.ExtensionContext): Promise<{ text: string; revision: string }> {
  const text = await readFile(vscode.Uri.joinPath(context.extensionUri, 'dist', 'workbench.js').fsPath, 'utf8');
  return { text, revision: createHash('sha256').update(text).digest('hex') };
}
export function validSession(session: unknown): session is string {
  return typeof session === 'string' && session.length > 0 && session.length <= 128;
}
