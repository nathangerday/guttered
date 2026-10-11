// Runs inside the desktop workbench. This file deliberately imports no VS Code
// source modules: the patch supplies services discovered in the installed build.
interface Model { uri: { scheme: string; toString(): string }; getVersionId(): number }
interface Target { type: number; position?: { lineNumber: number }; element?: HTMLElement; detail?: { isAfterLines?: boolean } }
interface Editor {
  getDomNode(): HTMLElement | null;
  getModel(): Model | null;
  getTargetAtClientPoint(x: number, y: number): Target | null;
  getLineDecorations(line: number): { options: { glyphMarginClassName?: string } }[] | null;
}
interface Editors { listCodeEditors(): Editor[] }
interface Commands { executeCommand(id: string, ...args: unknown[]): Promise<unknown> }
interface Configuration { getValue<T>(key: string): T }
const markerId = 'guttered-marker-v1';
const icons = new Map<string, boolean>();
function isMarker(element: HTMLElement): boolean {
  const background = getComputedStyle(element).backgroundImage;
  if (icons.has(background)) return icons.get(background)!;
  const match = /data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/.exec(background);
  let marker = false;
  try { marker = !!match && atob(match[1]!).includes(`id="${markerId}"`); } catch {}
  if (icons.size >= 64) icons.clear();
  icons.set(background, marker);
  return marker;
}
let detach: (() => void) | undefined;
let activeSession: unknown;

export function disconnect(session: unknown): void {
  if (session !== activeSession) return;
  detach?.();
  detach = undefined;
  activeSession = undefined;
}

export function connect(editors: Editors, commands: Commands, config: Configuration, enabled: unknown, session: unknown): number {
  detach?.();
  detach = undefined;
  activeSession = undefined;
  if (enabled !== true || typeof session !== 'string' || !session || session.length > 128) return 2;
  activeSession = session;
  const handle = (event: MouseEvent) => {
    if (!config.getValue<boolean>('guttered.workbenchInjection') || event.button !== 0 || event.detail > 1
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !(event.target instanceof HTMLElement)) return;
    for (const editor of editors.listCodeEditors()) {
      if (!editor.getDomNode()?.contains(event.target)) continue;
      const target = editor.getTargetAtClientPoint(event.clientX, event.clientY);
      const element = target?.element;
      const model = editor.getModel();
      // MouseTargetType.GUTTER_GLYPH_MARGIN is 2 in the supported desktop builds.
      // The SVG tag identifies our actual rendered icon, including wrapped rows.
      if (!model || (model.uri.scheme !== 'file' && model.uri.scheme !== 'vscode-remote') || target?.type !== 2 || !target.position || target.detail?.isAfterLines
        || !element || !isMarker(element)) return;
      // A breakpoint or another glyph may occupy the same rendered slot. Give
      // every non-Guttered class in that slot its usual native click behavior.
      const glyphs = editor.getLineDecorations(target.position.lineNumber) ?? [];
      const matching = glyphs.filter(glyph => glyph.options.glyphMarginClassName?.split(' ').filter(Boolean).every(name => element.classList.contains(name)));
      if (matching.length !== 1 || element.className.includes('breakpoint') || element.className.includes('codicon-')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void commands.executeCommand('guttered._workbenchPreview', model.uri, target.position.lineNumber - 1, model.getVersionId(), session)
        .catch(error => console.warn('Guttered gutter click:', error));
      return;
    }
  };
  // Capture before the editor's native mouse handler. Only plain left clicks on
  // a uniquely identified Guttered glyph are consumed; context menus pass through.
  window.addEventListener('mousedown', handle, true);
  detach = () => window.removeEventListener('mousedown', handle, true);
  return 2;
}
