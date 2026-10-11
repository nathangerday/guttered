import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreHunk } from '../src/diff';
import { quickDiffHunk } from '../src/quickDiffChange';
import { hunkPatch } from '../src/preview';

const change = (oldStart: number, oldEnd: number, newStart: number, newEnd: number) => ({
  originalStartLineNumber: oldStart, originalEndLineNumber: oldEnd,
  modifiedStartLineNumber: newStart, modifiedEndLineNumber: newEnd,
});

test('Quick Diff restores the displayed native block including multiple nearby edits', () => {
  const baseline = 'before\nold\ncontext\nother\nafter\n';
  const current = 'before\nnew\ncontext\nchanged\nafter\n';
  const hunk = quickDiffHunk(baseline, current, [change(2, 4, 2, 4)], 0)!;
  assert.equal(restoreHunk(current, hunk, '\n'), baseline);
  assert.match(hunkPatch(hunk), /-context\n-other\n\+new\n\+context\n\+changed/);
});

test('Quick Diff ranges preserve other hunks and accept CRLF and Unicode', () => {
  const baseline = 'start\n😀 old\ncontext\nother\n';
  const current = 'start\r\n🌍 new\r\ncontext\r\nchanged\r\n';
  const hunk = quickDiffHunk(baseline, current, [change(2, 2, 2, 2), change(4, 4, 4, 4)], 0)!;
  assert.equal(restoreHunk(current, hunk, '\r\n'), 'start\r\n😀 old\r\ncontext\r\nchanged\r\n');
});

test('native insertion, deletion, empty-file and EOF newline ranges restore exact contents', () => {
  const cases: [string, string, ReturnType<typeof change>][] = [
    ['a\nb\n', 'a\nnew\nb\n', change(1, 0, 2, 2)],
    ['a\nold\nb\n', 'a\nb\n', change(2, 2, 1, 0)],
    ['', 'new\n', change(0, 0, 1, 1)],
    ['old\n', '', change(1, 1, 0, 0)],
    ['a\nold\n', 'a\n', change(2, 2, 1, 0)],
    ['a', 'a\nnew', change(1, 0, 2, 2)],
    ['a\n', 'a', change(2, 2, 1, 0)],
    ['a', 'a\n', change(1, 0, 2, 2)],
    ['a\nold', 'a', change(2, 2, 1, 0)],
  ];
  for (const [baseline, current, native] of cases) {
    const hunk = quickDiffHunk(baseline, current, [native], 0);
    assert.ok(hunk, JSON.stringify({ baseline, current, native }));
    assert.equal(restoreHunk(current, hunk, '\n'), baseline, JSON.stringify({ baseline, current }));
  }
});

test('stale, incomplete, unordered and invalid callback ranges never produce a destructive edit', () => {
  const baseline = 'a\nold\ncontext\n', current = 'a\nnew\nchanged context\n';
  assert.equal(quickDiffHunk(baseline, current, [change(2, 2, 2, 2)], 0), undefined);
  assert.equal(quickDiffHunk(baseline, current, [change(20, 20, 2, 2)], 0), undefined);
  assert.equal(quickDiffHunk(baseline, current, [change(2, 2, 2, 2)], -1), undefined);
  assert.equal(quickDiffHunk(baseline, current, [change(2, 2, 2, 2)], 1), undefined);
  assert.equal(quickDiffHunk(baseline, current, [change(3, 3, 3, 3), change(2, 2, 2, 2)], 0), undefined);
  assert.equal(quickDiffHunk(baseline, current, [null], 0), undefined);
});
