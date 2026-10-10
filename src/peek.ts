import * as vscode from 'vscode';
import path from 'node:path';
import type { Comparison } from './controller';
import { previewHunk, type Hunk } from './diff';

/** Read-only snapshots: edits after opening a peek cannot change its contents. */
export class ChangePeek implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'guttered-hunk';
  private readonly previews = new Map<string, string>();
  private sequence = 0;

  create(comparison: Comparison, hunk: Hunk): vscode.Uri {
    const preview = previewHunk(hunk);
    // Quote unusual filenames so a newline cannot become a fake patch header.
    const file = (prefix: string) => JSON.stringify(`${prefix}/${comparison.path}`);
    const text = [
      `# ${comparison.snapshot.baseRef} · merge base ${comparison.snapshot.mergeBase.slice(0, 8)} · buffer version ${comparison.version}`,
      `--- ${file('a')}`,
      `+++ ${file('b')}`,
      preview.text,
      ...(preview.truncated ? ['# Preview shortened. Use Guttered: Open Diff with Merge Base for the full comparison.'] : []),
    ].join('\n');
    const uri = vscode.Uri.from({
      scheme: ChangePeek.scheme,
      path: `/Branch change - ${path.basename(comparison.path)}.diff`,
      query: String(++this.sequence),
    });
    this.previews.set(uri.toString(), text);
    if (this.previews.size > 48) this.previews.delete(this.previews.keys().next().value!);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const text = this.previews.get(uri.toString());
    if (text === undefined) throw new Error('This change preview has expired. Run Guttered: Peek Change again.');
    return text;
  }

  dispose(): void { this.previews.clear(); }
}
