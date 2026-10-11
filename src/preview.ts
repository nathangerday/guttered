import { diffChars } from 'diff';
import { lines, type Hunk } from './diff';

export interface Segment { text: string; changed?: boolean }
export interface PreviewLine { number: number; segments: Segment[]; noNewline: boolean; shortened?: boolean }
export interface PreviewRow { kind: 'context' | 'change' | 'gap'; old?: PreviewLine; current?: PreviewLine; omitted?: number }

function line(value: string, number: number): PreviewLine {
  const text = value.replace(/\n$/, '');
  let end = Math.min(2000, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return { number: number + 1, segments: [{ text: text.slice(0, end) }],
    noNewline: !value.endsWith('\n'), shortened: end < text.length };
}

/** Render one change with unchanged context; bound large changes before they reach the webview. */
export function previewRows(baseline: string, current: string, hunks: Hunk[], index: number): PreviewRow[] {
  const hunk = hunks[index];
  if (!hunk) return [];
  const old = lines(baseline), working = lines(current);
  const previous = hunks[index - 1], next = hunks[index + 1];
  const before = Math.min(3, hunk.oldStart - (previous ? previous.oldStart + previous.oldLines.length : 0),
    hunk.newStart - (previous ? previous.newStart + previous.newLines.length : 0));
  const oldEnd = hunk.oldStart + hunk.oldLines.length, newEnd = hunk.newStart + hunk.newLines.length;
  const after = Math.min(3, (next?.oldStart ?? old.length) - oldEnd, (next?.newStart ?? working.length) - newEnd);
  const rows: PreviewRow[] = [];
  for (let offset = before; offset > 0; offset--) {
    rows.push({ kind: 'context', old: line(old[hunk.oldStart - offset]!, hunk.oldStart - offset),
      current: line(working[hunk.newStart - offset]!, hunk.newStart - offset) });
  }
  const count = Math.max(hunk.oldLines.length, hunk.newLines.length);
  const highlightDeadline = performance.now() + 30;
  for (let offset = 0; offset < count; offset++) {
    if (count > 400 && offset === 300) {
      rows.push({ kind: 'gap', omitted: count - 400 });
      offset = count - 101;
      continue;
    }
    const left = hunk.oldLines[offset], right = hunk.newLines[offset];
    const row: PreviewRow = { kind: 'change',
      old: left === undefined ? undefined : line(left, hunk.oldStart + offset),
      current: right === undefined ? undefined : line(right, hunk.newStart + offset) };
    // Keep word/character highlighting cheap even for minified source files.
    if (row.old && row.current && left!.length < 2000 && right!.length < 2000 && performance.now() < highlightDeadline) {
      const parts = diffChars(row.old.segments[0]!.text, row.current.segments[0]!.text, { timeout: 5 });
      if (parts) {
        row.old.segments = parts.filter(part => !part.added).map(part => ({ text: part.value, changed: part.removed }));
        row.current.segments = parts.filter(part => !part.removed).map(part => ({ text: part.value, changed: part.added }));
      }
    }
    rows.push(row);
  }
  for (let offset = 0; offset < after; offset++) {
    rows.push({ kind: 'context', old: line(old[oldEnd + offset]!, oldEnd + offset),
      current: line(working[newEnd + offset]!, newEnd + offset) });
  }
  return rows;
}

/** A complete, copyable unified hunk, including final-newline markers. */
export function hunkPatch(hunk: Hunk): string {
  const rows = [`@@ -${hunk.oldStart + (hunk.oldLines.length ? 1 : 0)},${hunk.oldLines.length} +${hunk.newStart + (hunk.newLines.length ? 1 : 0)},${hunk.newLines.length} @@`];
  for (const [prefix, content] of [['-', hunk.oldLines], ['+', hunk.newLines]] as const) {
    for (const value of content) {
      rows.push(prefix + value.replace(/\n$/, ''));
      if (!value.endsWith('\n')) rows.push('\\ No newline at end of file');
    }
  }
  return rows.join('\n') + '\n';
}
