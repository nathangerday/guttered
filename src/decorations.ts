import * as vscode from 'vscode';
import type { Configuration } from './config';
import { lineMarkers, type LineDiff, type Marker } from './diff';

export class Decorations implements vscode.Disposable {
  private readonly types = new Map<string, vscode.TextEditorDecorationType>();
  private readonly applied = new Map<vscode.TextEditor, { types: Set<vscode.TextEditorDecorationType>; diff: LineDiff | undefined; version: number }>();

  private type(marker: Marker | undefined, config: Configuration): vscode.TextEditorDecorationType {
    const key = JSON.stringify([config.gutter, config.overviewRuler, config.opacity, config.added, config.modified, config.deleted, marker?.change, !!marker?.before, !!marker?.after]);
    let type = this.types.get(key);
    if (!type) {
      const before = marker?.before ? `<path fill="${config.deleted}" d="M0 0h7L0 5z"/>` : '';
      const after = marker?.after ? `<path fill="${config.deleted}" d="M0 16h7L0 11z"/>` : '';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="16" viewBox="0 0 8 16" preserveAspectRatio="none" opacity="${config.opacity}">${before}${after}</svg>`;
      const alpha = Math.round(config.opacity * 255).toString(16).padStart(2, '0');
      type = vscode.window.createTextEditorDecorationType({
        // Keep the breakpoint gutter free with a 3 px bar and 5 px gap before text.
        ...(config.gutter ? {
          before: {
            // A zero-width space keeps the attachment on the text baseline;
            // 1lh fills the editor's line height, joining adjacent bars.
            contentText: '\u200b', width: '3px', height: '1lh', margin: '0 5px 0 0',
            backgroundColor: marker?.change ? `${config[marker.change]}${alpha}` : undefined,
          },
          // Draw deletion arrows over the same inset without adding width.
          // This attachment also keeps empty-line carets and guides aligned.
          after: before || after ? {
            contentIconPath: vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`),
            width: '8px', height: '1em', margin: '0 0 0 -8px',
            // The API has no verticalAlign field. Keep icons from raising small text.
            textDecoration: 'none; vertical-align: top',
          } : { contentText: '', width: '0px' },
        } : {}),
        ...(config.overviewRuler && marker ? { overviewRulerColor: `${config[marker.change ?? 'deleted']}${alpha}`, overviewRulerLane: vscode.OverviewRulerLane.Left } : {}),
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
    const markers = new Map((diff ? lineMarkers(diff) : []).map(marker => [marker.line, marker]));
    // Reserve the same inset on unchanged lines, so edits never shift the code.
    const lines = config.gutter && diff
      ? Array.from({ length: editor.document.lineCount }, (_, line) => line)
      : [...markers.keys()];
    for (const line of lines) {
      const type = this.type(markers.get(line), config);
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
