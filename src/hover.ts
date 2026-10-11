import * as vscode from 'vscode';
import { configuration } from './config';
import type { Comparison, Controller } from './controller';
import { hunkLine, previewHunk } from './diff';

/** A compact action in the normal code hover, alongside language documentation. */
export class ChangeActionHover implements vscode.HoverProvider {
  constructor(private readonly controller: Controller) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const config = configuration(document.uri);
    if (document.isClosed || !config.enabled || !config.hoverAction) return;
    const comparison = this.controller.getComparison(document.uri);
    if (!comparison || comparison.version !== document.version) return;
    const marked = comparison.diff.hunks.some(hunk => {
      const start = hunkLine(hunk, document.lineCount);
      const end = hunk.newLines.length ? hunk.newStart + hunk.newLines.length - 1 : start;
      return position.line >= start && position.line <= end;
    });
    if (!marked) return;

    const message = new vscode.MarkdownString();
    message.isTrusted = { enabledCommands: ['guttered.previewChange'] };
    message.supportThemeIcons = true;
    const args = encodeURIComponent(JSON.stringify([document.uri.toString(), position.line]));
    message.appendMarkdown(`[$(diff) Open change diff](command:guttered.previewChange?${args})`);
    return new vscode.Hover(message, document.lineAt(position.line).range);
  }
}

function previewsEnabled(uri: vscode.Uri): boolean {
  const config = configuration(uri);
  // The hint sits on the inset marker; glyph-margin markers have no hover target.
  // Native hint padding would turn the invisible target into a visible pill.
  return config.enabled && config.gutter && config.gutterPlacement === 'inset'
    && !vscode.workspace.getConfiguration('editor', uri).get<boolean>('inlayHints.padding', false);
}

class ChangeHint extends vscode.InlayHint {
  constructor(readonly document: vscode.TextDocument, readonly comparison: Comparison, line: number) {
    // A zero-width hint gives the existing marker its own hover target without
    // widening the inset. Ordinary hover providers merge with language docs.
    super(new vscode.Position(line, 0), '\u200b');
  }
}

export class ChangeHover implements vscode.InlayHintsProvider<ChangeHint> {
  readonly onDidChangeInlayHints: vscode.Event<void>;

  constructor(private readonly controller: Controller) {
    this.onDidChangeInlayHints = controller.onDidChangeComparison;
  }

  provideInlayHints(document: vscode.TextDocument, range: vscode.Range): ChangeHint[] | undefined {
    if (!previewsEnabled(document.uri)) return;
    const comparison = this.controller.getComparison(document.uri);
    if (!comparison || comparison.version !== document.version) return;
    const marked = new Set<number>();
    for (const hunk of comparison.diff.hunks) {
      const start = hunkLine(hunk, document.lineCount);
      const end = hunk.newLines.length ? hunk.newStart + hunk.newLines.length - 1 : start;
      for (let line = Math.max(start, range.start.line); line <= Math.min(end, range.end.line); line++) {
        if (range.contains(new vscode.Position(line, 0))) marked.add(line);
      }
    }
    return [...marked].map(line => new ChangeHint(document, comparison, line));
  }

  resolveInlayHint(hint: ChangeHint): ChangeHint | undefined {
    const { document, position } = hint;
    const comparison = this.controller.getComparison(document.uri);
    if (document.isClosed || !previewsEnabled(document.uri) || !comparison
      || comparison.version !== document.version || comparison.diff !== hint.comparison.diff
      || comparison.snapshot.key !== hint.comparison.snapshot.key) return;

    // Build only the hovered preview; a newly added file can have many markers.
    const hunks = comparison.diff.hunks.filter(hunk => {
      const start = hunkLine(hunk, document.lineCount);
      const end = hunk.newLines.length ? hunk.newStart + hunk.newLines.length - 1 : start;
      return position.line >= start && position.line <= end;
    });
    if (!hunks.length) return;

    const message = new vscode.MarkdownString();
    message.isTrusted = { enabledCommands: ['guttered.openDiff'] };
    message.appendText(`${comparison.snapshot.baseRef} · merge base ${comparison.snapshot.mergeBase.slice(0, 8)}`);
    for (const hunk of hunks) {
      const preview = previewHunk(hunk);
      message.appendCodeblock(preview.text, 'diff');
      if (preview.truncated) message.appendMarkdown('\n\nPreview shortened. Open the diff to see all changes.');
    }
    const args = encodeURIComponent(JSON.stringify([document.uri.toString(), position.line]));
    message.appendMarkdown(`\n\n[Open Diff with Merge Base](command:guttered.openDiff?${args})`);
    hint.tooltip = message;
    return hint;
  }
}
