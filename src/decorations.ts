import * as vscode from 'vscode';
import type { Configuration } from './config';
import { lineMarkers, type LineDiff, type Marker } from './diff';

export class Decorations implements vscode.Disposable {
  private readonly types = new Map<string, vscode.TextEditorDecorationType>();
  private readonly applied = new Map<vscode.TextEditor, { types: Set<vscode.TextEditorDecorationType>; diff: LineDiff | undefined; version: number }>();

  private type(marker: Marker, config: Configuration): vscode.TextEditorDecorationType {
    const key = JSON.stringify([config.gutter, config.overviewRuler, config.added, config.modified, config.deleted, marker.change, !!marker.before, !!marker.after]);
    let type = this.types.get(key);
    if (!type) {
      const bar = marker.change ? `<path fill="${config[marker.change]}" d="M12 0h3v16h-3z"/>` : '';
      const before = marker.before ? `<path fill="${config.deleted}" d="M9 0h7l-3.5 5z"/>` : '';
      const after = marker.after ? `<path fill="${config.deleted}" d="M9 16h7l-3.5-5z"/>` : '';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${bar}${before}${after}</svg>`;
      type = vscode.window.createTextEditorDecorationType({
        ...(config.gutter ? { gutterIconPath: vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`), gutterIconSize: 'contain' } : {}),
        ...(config.overviewRuler ? { overviewRulerColor: config[marker.change ?? 'deleted'], overviewRulerLane: vscode.OverviewRulerLane.Left } : {}),
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      });
      this.types.set(key, type);
    }
    return type;
  }

  apply(editor: vscode.TextEditor, diff: LineDiff | undefined, config: Configuration): void {
    const previous = this.applied.get(editor);
    if (previous && previous.diff === diff && previous.version === editor.document.version) return;
    const groups = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();
    for (const marker of diff ? lineMarkers(diff) : []) {
      const type = this.type(marker, config);
      const line = Math.min(marker.line, editor.document.lineCount - 1);
      let group = groups.get(type);
      if (!group) {
        group = [];
        groups.set(type, group);
      }
      group.push(new vscode.Range(line, 0, line, 0));
    }
    for (const type of previous?.types ?? this.types.values()) {
      if (!groups.has(type)) editor.setDecorations(type, []);
    }
    for (const [type, ranges] of groups) editor.setDecorations(type, ranges);
    this.applied.set(editor, { types: new Set(groups.keys()), diff, version: editor.document.version });
  }

  retain(editors: readonly vscode.TextEditor[]): void {
    for (const editor of this.applied.keys()) {
      if (!editors.includes(editor)) this.applied.delete(editor);
    }
  }
  dispose(): void {
    for (const type of this.types.values()) type.dispose();
    this.types.clear();
    this.applied.clear();
  }
}
