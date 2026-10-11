import * as vscode from 'vscode';
import type { Snapshot } from './git';

export const baselineScheme = 'guttered-base';

/** Preserve the real path for file associations and installed language grammars. */
export function baselineUri(current: vscode.Uri, snapshot: Pick<Snapshot, 'root' | 'mergeBase'>, file: string, maxBytes: number): vscode.Uri {
  return current.with({ scheme: baselineScheme, query: JSON.stringify({ root: snapshot.root, mergeBase: snapshot.mergeBase, file, maxBytes }), fragment: '' });
}

export async function matchLanguage(original: vscode.Uri, current: vscode.TextDocument): Promise<void> {
  const baseline = await vscode.workspace.openTextDocument(original);
  if (baseline.languageId !== current.languageId) await vscode.languages.setTextDocumentLanguage(baseline, current.languageId);
}

export async function openNativeDiff(original: vscode.Uri, modified: vscode.Uri, title: string, line?: number): Promise<void> {
  const current = await vscode.workspace.openTextDocument(modified);
  if (modified.scheme === 'guttered-empty') {
    const baseline = await vscode.workspace.openTextDocument(original);
    if (current.languageId !== baseline.languageId) await vscode.languages.setTextDocumentLanguage(current, baseline.languageId);
  } else await matchLanguage(original, current);
  const selection = line === undefined ? undefined : new vscode.Range(Math.min(line, current.lineCount - 1), 0, Math.min(line, current.lineCount - 1), 0);
  await vscode.commands.executeCommand('vscode.diff', original, modified, title, { preview: true, selection });
}
