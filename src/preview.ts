import type { Hunk } from './diff';

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
