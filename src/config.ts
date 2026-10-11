import * as vscode from 'vscode';

export function configuration(uri: vscode.Uri) {
  const config = vscode.workspace.getConfiguration('guttered', uri);
  const color = (name: string, fallback: string) => {
    const value = config.get<string>(`colors.${name}`, fallback);
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  };
  return {
    enabled: config.get<boolean>('enabled', true),
    reference: config.get<string>('baseReference', '').trim(),
    debounceMs: Math.max(50, Math.min(2000, config.get<number>('debounceMs', 250))),
    maxBytes: Math.max(1, Math.min(10240, config.get<number>('maxFileSizeKB', 1024))) * 1024,
    gutter: config.get<boolean>('gutter', true),
    hoverAction: config.get<boolean>('hoverAction', true),
    diffView: config.get<string>('diffView', 'native') === 'quickDiff' ? 'quickDiff' as const : 'native' as const,
    gutterPlacement: config.get<string>('gutterPlacement', 'glyphMargin') === 'inset' ? 'inset' as const : 'glyphMargin' as const,
    overviewRuler: config.get<boolean>('overviewRuler', true),
    opacity: Math.max(0, Math.min(1, config.get<number>('opacity', 0.3))),
    added: color('added', '#4CAF50'),
    modified: color('modified', '#E6A817'),
    deleted: color('deleted', '#F44336'),
  };
}
export type Configuration = ReturnType<typeof configuration>;
