import { lines, type Hunk } from './diff';

/** Stable scm/change/title arguments use one-based inclusive line numbers. */
export interface QuickDiffChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

function span(start: number, end: number, count: number): [number, number] | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < 0) return;
  const result: [number, number] = end === 0 ? [start, start] : [start - 1, end];
  if (result[0] < 0 || result[1] < result[0] || result[1] > count) return;
  return result;
}

/** Refuse stale/malformed ranges and restore the complete hunk VS Code displays. */
export function quickDiffHunk(baseline: string, current: string, changes: unknown, index: unknown): Hunk | undefined {
  if (!Array.isArray(changes) || changes.length > 50_000 || !Number.isSafeInteger(index)
    || (index as number) < 0 || (index as number) >= changes.length) return;
  const oldText = baseline.replace(/\r\n/g, '\n'), newText = current.replace(/\r\n/g, '\n');
  const old = oldText.split('\n'), working = newText.split('\n');
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);
  let oldEnd = 0, newEnd = 0;
  let selected: { old: [number, number]; current: [number, number] } | undefined;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i] as QuickDiffChange | undefined;
    if (!change) return;
    const left = span(change.originalStartLineNumber, change.originalEndLineNumber, old.length);
    const right = span(change.modifiedStartLineNumber, change.modifiedEndLineNumber, working.length);
    if (!left || !right || left[0] < oldEnd || right[0] < newEnd
      || !same(old.slice(oldEnd, left[0]), working.slice(newEnd, right[0]))) return;
    if (i === index) selected = { old: left, current: right };
    oldEnd = left[1]; newEnd = right[1];
  }
  if (!selected || !same(old.slice(oldEnd), working.slice(newEnd))) return;
  // At EOF, include the preceding line so insertion/removal of its newline is
  // represented as text, rather than an edit beyond the document's last line.
  if ((selected.old[0] >= old.length - 1 || selected.current[0] >= working.length - 1)
    && selected.old[0] > 0 && selected.current[0] > 0) {
    selected.old[0]--; selected.current[0]--;
  }
  const offsets = (text: string) => {
    const result = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') result.push(i + 1);
    result.push(text.length);
    return result;
  };
  const oldOffsets = offsets(oldText), newOffsets = offsets(newText);
  return {
    oldStart: selected.old[0], newStart: selected.current[0],
    oldLines: lines(oldText.slice(oldOffsets[selected.old[0]], oldOffsets[selected.old[1]])),
    newLines: lines(newText.slice(newOffsets[selected.current[0]], newOffsets[selected.current[1]])),
  };
}
