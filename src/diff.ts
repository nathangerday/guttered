import { diffArrays } from 'diff';

export interface Hunk {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
}
export interface LineRange { start: number; count: number }
export interface Deletion { line: number; placement: 'before' | 'after'; count: number }
export interface LineDiff {
  hunks: Hunk[];
  added: LineRange[];
  modified: LineRange[];
  deleted: Deletion[];
}

/** Keep inline previews small, even for new files or very long lines. */
export function previewHunk(hunk: Hunk): { text: string; truncated: boolean } {
  const rows = [`@@ -${hunk.oldStart + (hunk.oldLines.length ? 1 : 0)},${hunk.oldLines.length} +${hunk.newStart + (hunk.newLines.length ? 1 : 0)},${hunk.newLines.length} @@`];
  let truncated = false;
  for (const [prefix, content] of [['-', hunk.oldLines], ['+', hunk.newLines]] as const) {
    truncated ||= content.length > 12;
    for (const line of content.slice(0, 12)) {
      const text = line.replace(/\n$/, '');
      truncated ||= text.length > 400;
      rows.push(prefix + text.slice(0, 400) + (text.length > 400 ? '…' : ''));
      if (!line.endsWith('\n')) rows.push('\\ No newline at end of file');
    }
  }
  return { text: rows.join('\n'), truncated };
}

// Retain line terminators so a missing final newline remains a real edit.
export function lines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function checkLineLimit(text: string): void {
  let count = 1;
  let offset = -1;
  while ((offset = text.indexOf('\n', offset + 1)) !== -1) {
    if (++count > 50_000) throw new Error('Comparison paused: the file exceeds the 50,000-line limit.');
  }
}

export function computeDiff(baseline: string, current: string, timeout = 100): LineDiff {
  checkLineLimit(baseline);
  checkLineLimit(current);
  const parts = diffArrays(lines(baseline), lines(current), { timeout });
  if (!parts) throw new Error('Comparison paused: this diff exceeds the computation time limit.');
  const result: LineDiff = { hunks: [], added: [], modified: [], deleted: [] };
  let oldStart = 0;
  let newStart = 0;
  let pending: Hunk | undefined;
  const flush = () => {
    if (!pending) return;
    const { oldLines, newLines, newStart: start } = pending;
    result.hunks.push(pending);
    const modifiedCount = Math.min(oldLines.length, newLines.length);
    if (modifiedCount) result.modified.push({ start, count: modifiedCount });
    if (newLines.length > modifiedCount) result.added.push({ start: start + modifiedCount, count: newLines.length - modifiedCount });
    if (oldLines.length > modifiedCount) {
      const boundary = start + newLines.length;
      result.deleted.push({ line: Math.max(0, boundary - 1), placement: boundary === 0 ? 'before' : 'after', count: oldLines.length - modifiedCount });
    }
    pending = undefined;
  };
  for (const part of parts) {
    if (!part.added && !part.removed) {
      flush();
      oldStart += part.value.length;
      newStart += part.value.length;
      continue;
    }
    pending ??= { oldStart, newStart, oldLines: [], newLines: [] };
    if (part.removed) {
      pending.oldLines.push(...part.value);
      oldStart += part.value.length;
    } else {
      pending.newLines.push(...part.value);
      newStart += part.value.length;
    }
  }
  flush();
  return result;
}

/** Undo one hunk while retaining the editor's line ending convention. */
export function restoreHunk(current: string, hunk: Hunk, eol: string): string {
  // Keep existing CRLFs and mixed endings outside the restored hunk untouched.
  const content = current.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  content.splice(hunk.newStart, hunk.newLines.length, ...hunk.oldLines.map(line => line.replace(/\n/g, eol)));
  return content.join('');
}

export interface TextChange { start: number; end: number; text: string }

/** Return a minimal replacement without splitting CRLFs or UTF-16 surrogate pairs. */
export function minimalTextChange(current: string, replacement: string): TextChange {
  let start = 0;
  while (start < current.length && start < replacement.length && current[start] === replacement[start]) start++;
  let end = current.length;
  let replacementEnd = replacement.length;
  while (end > start && replacementEnd > start && current[end - 1] === replacement[replacementEnd - 1]) {
    end--;
    replacementEnd--;
  }
  // VS Code adjusts ranges inside CRLFs or after high surrogates. Include the
  // whole pair in our replacement so that adjustment cannot corrupt the text.
  const splitsPair = (index: number) =>
    (current[index - 1] === '\r' && current[index] === '\n') ||
    /[\uD800-\uDBFF]/.test(current[index - 1] ?? '');
  if (start > 0 && splitsPair(start)) start--;
  if (end > start && end < current.length && splitsPair(end)) {
    end++;
    replacementEnd++;
  }
  return { start, end, text: replacement.slice(start, replacementEnd) };
}

export function hunkLine(hunk: Hunk, lineCount: number): number {
  const marker = hunk.newLines.length ? hunk.newStart : Math.max(0, hunk.newStart - 1);
  return Math.min(marker, lineCount - 1);
}

export function hunkAtLine(hunks: Hunk[], line: number, lineCount: number): Hunk | undefined {
  // A deletion can also be selected from the following line. Prefer an actual
  // marker there so a neighboring deletion never steals the cursor's hunk.
  const marked = hunks.find(hunk => hunkLine(hunk, lineCount) === line);
  if (marked) return marked;
  return hunks.find(hunk => {
    const start = hunkLine(hunk, lineCount);
    const end = Math.min(lineCount - 1, hunk.newStart + Math.max(1, hunk.newLines.length) - 1);
    return line >= start && line <= end;
  });
}

export interface Marker { line: number; change?: 'added' | 'modified'; before: number; after: number }

/** A line gets one glyph, including when multiple changes share its position. */
export function lineMarkers(diff: LineDiff): Marker[] {
  const markers = new Map<number, Marker>();
  const at = (line: number) => {
    let marker = markers.get(line);
    if (!marker) {
      marker = { line, before: 0, after: 0 };
      markers.set(line, marker);
    }
    return marker;
  };
  for (const change of ['added', 'modified'] as const) {
    for (const range of diff[change]) {
      for (let line = range.start; line < range.start + range.count; line++) {
        at(line).change = change;
      }
    }
  }
  for (const deletion of diff.deleted) at(deletion.line)[deletion.placement] += deletion.count;
  return [...markers.values()];
}

/** Leave uncommitted lines (including deletion anchors) to the native Git gutter. */
export function branchMarkers(diff: LineDiff, ...localDiffs: LineDiff[]): Marker[] {
  const localLines = new Set(localDiffs.flatMap(localDiff => lineMarkers(localDiff).map(marker => marker.line)));
  return lineMarkers(diff).filter(marker => !localLines.has(marker.line));
}
