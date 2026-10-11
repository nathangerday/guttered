import type { Element, Root, RootContent } from 'hast';
import type { Segment } from '../preview';

export interface SyntaxSource { key: string; language: string; old: string; current: string }
export interface SyntaxToken { text: string; classes: string[] }
export interface SyntaxRequest extends SyntaxSource { id: number; oldLines: number[]; currentLines: number[] }
export interface SyntaxResponse { id: number; old: Record<number, SyntaxToken[]>; current: Record<number, SyntaxToken[]> }
export interface ColoredSegment extends Segment { classes: string[] }

export function syntaxLanguage(language: string): string {
  return ({ typescriptreact: 'tsx', javascriptreact: 'jsx', shellscript: 'bash',
    vue: 'xml', svelte: 'xml', properties: 'ini', vb: 'vbnet' } as Record<string, string>)[language] ?? language;
}

/** Keep full-file lexical context, but return only the bounded lines the panel displays. */
export function syntaxLines(tree: Root, numbers: number[]): Record<number, SyntaxToken[]> {
  const selected = new Set(numbers);
  const last = Math.max(0, ...numbers);
  const result: Record<number, SyntaxToken[]> = Object.fromEntries(numbers.map(number => [number, []]));
  const lengths = new Map<number, number>();
  let line = 1;
  const text = (value: string, classes: string[]) => {
    let start = 0;
    while (start < value.length && line <= last) {
      const newline = value.indexOf('\n', start);
      const end = newline < 0 ? value.length : newline;
      if (selected.has(line)) {
        const used = lengths.get(line) ?? 0;
        const fragment = value.slice(start, Math.min(end, start + Math.max(0, 2000 - used)));
        if (fragment) {
          const tokens = result[line]!;
          const previous = tokens[tokens.length - 1];
          if (previous && previous.classes.join(' ') === classes.join(' ')) previous.text += fragment;
          else tokens.push({ text: fragment, classes });
          lengths.set(line, used + fragment.length);
        }
      }
      if (newline < 0) break;
      line++; start = newline + 1;
    }
  };
  const visit = (nodes: RootContent[] | Element['children'], inherited: string[]) => {
    for (const node of nodes) {
      if (line > last) break;
      if (node.type === 'text') text(node.value, inherited);
      else if (node.type === 'element') {
        const names = node.properties.className;
        const classes = Array.isArray(names) ? names.filter((name): name is string =>
          typeof name === 'string' && /^[a-zA-Z_][\w-]*$/.test(name)) : [];
        visit(node.children, classes.length ? classes : inherited);
      }
    }
  };
  visit(tree.children, []);
  return result;
}

/** Intersect syntax spans with character-change spans without changing the displayed text. */
export function colorSegments(segments: Segment[], tokens?: SyntaxToken[]): ColoredSegment[] {
  const source = segments.map(segment => segment.text).join('');
  if (!tokens || !tokens.map(token => token.text).join('').startsWith(source)) {
    return segments.map(segment => ({ ...segment, classes: [] }));
  }
  const result: ColoredSegment[] = [];
  let index = 0, offset = 0;
  for (const segment of segments) {
    let used = 0;
    while (used < segment.text.length) {
      const token = tokens[index]!;
      const count = Math.min(segment.text.length - used, token.text.length - offset);
      if (count) result.push({ text: segment.text.slice(used, used + count), changed: segment.changed, classes: token.classes });
      used += count; offset += count;
      if (offset === token.text.length) { index++; offset = 0; }
    }
  }
  return result;
}
