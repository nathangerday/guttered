import * as vscode from 'vscode';
import type { Configuration } from './config';
import type { Marker } from './diff';

export class Decorations implements vscode.Disposable {
  private readonly types = new Map<string, vscode.TextEditorDecorationType>();
  private readonly applied = new Map<vscode.TextEditor, { types: Set<vscode.TextEditorDecorationType>; markers: readonly Marker[] | undefined; version: number }>();

  private type(marker: Marker, config: Configuration): vscode.TextEditorDecorationType {
    const key = JSON.stringify([config.gutter, config.overviewRuler, config.opacity, config.branch, !!marker.before, !!marker.after]);
    let type = this.types.get(key);
    if (!type) {
      const alpha = (opacity: number) => Math.round(opacity * 255).toString(16).padStart(2, '0');
      const color = `${config.branch}${alpha(config.opacity)}`;
      type = vscode.window.createTextEditorDecorationType({
        // Backgrounds and borders paint over the existing line box. Attachments,
        // injected hints and glyph-margin icons alter layout or intercept clicks.
        isWholeLine: true,
        ...(config.gutter ? {
          backgroundColor: `${config.branch}${alpha(config.opacity * 0.4)}`,
          ...(marker.before || marker.after ? {
            borderColor: color,
            borderStyle: 'dashed',
            borderWidth: `${marker.before ? 1 : 0}px 0 ${marker.after ? 1 : 0}px 0`,
          } : {}),
        } : {}),
        ...(config.overviewRuler ? { overviewRulerColor: color, overviewRulerLane: vscode.OverviewRulerLane.Right } : {}),
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      });
      this.types.set(key, type);
    }
    return type;
  }

  apply(editor: vscode.TextEditor, markers: readonly Marker[] | undefined, config: Configuration): void {
    const previous = this.applied.get(editor);
    if (previous && previous.markers === markers && previous.version === editor.document.version) return;
    const groups = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();
    if (config.gutter || config.overviewRuler) {
      for (const marker of markers ?? []) {
        const type = this.type(marker, config);
        let ranges = groups.get(type);
        if (!ranges) groups.set(type, ranges = []);
        ranges.push(new vscode.Range(marker.line, 0, marker.line, 0));
      }
    }
    for (const type of previous?.types ?? this.types.values()) {
      if (!groups.has(type)) editor.setDecorations(type, []);
    }
    for (const [type, ranges] of groups) editor.setDecorations(type, ranges);
    this.applied.set(editor, { types: new Set(groups.keys()), markers, version: editor.document.version });
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
