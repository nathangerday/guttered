import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDiff } from '../src/diff';
import { hunkPatch, previewRows } from '../src/preview';

test('preview shows matching context and original/working line numbers after insertions', () => {
  const old = 'first\nsecond\nthird\nlast\n', current = 'first\nnew\nsecond\nthird\nchanged\n';
  const diff = computeDiff(old, current);
  const rows = previewRows(old, current, diff.hunks, 1);
  assert.deepEqual(rows.map(row => [row.kind, row.old?.number, row.current?.number]),
    [['context', 2, 3], ['context', 3, 4], ['change', 4, 5]]);
  assert.equal(rows[2]!.old!.segments.map(part => part.text).join(''), 'last');
  assert.equal(rows[2]!.current!.segments.map(part => part.text).join(''), 'changed');
});

test('context does not include another hunk as unchanged source', () => {
  const old = 'a\nb\nc\nd\ne\n', current = 'a\nB\nc\nD\ne\n';
  const diff = computeDiff(old, current);
  const rows = previewRows(old, current, diff.hunks, 0);
  assert.deepEqual(rows.map(row => row.current?.number), [1, 2, 3]);
  assert.equal(rows.some(row => row.current?.segments.some(part => part.text === 'D')), false);
});

test('added, deleted, blank, Unicode and final-newline changes retain their content', () => {
  for (const [old, current] of [['', '\n😀\n'], ['old\n', ''], ['🌍\n', '🌎'], ['a\n', 'a']]) {
    const hunks = computeDiff(old!, current!).hunks;
    const rows = previewRows(old!, current!, hunks, 0).filter(row => row.kind === 'change');
    assert.equal(rows.flatMap(row => row.old ? [row.old.segments.map(part => part.text).join('') + (row.old.noNewline ? '' : '\n')] : []).join(''), old);
    assert.equal(rows.flatMap(row => row.current ? [row.current.segments.map(part => part.text).join('') + (row.current.noNewline ? '' : '\n')] : []).join(''), current);
  }
});

test('large changes have a bounded excerpt, correct tail line numbers, and a full copyable patch', () => {
  const old = 'old\n'.repeat(1000), current = 'new\n'.repeat(1200);
  const hunks = [{ oldStart: 0, newStart: 0, oldLines: Array<string>(1000).fill('old\n'), newLines: Array<string>(1200).fill('new\n') }];
  const rows = previewRows(old, current, hunks, 0);
  assert.equal(rows.length, 401);
  assert.equal(rows[300]!.omitted, 800);
  assert.equal(rows[301]!.current!.number, 1101);
  assert.equal(rows.at(-1)!.current!.number, 1200);
  assert.equal(hunkPatch(hunks[0]!).split('\n').length, 2202);
});

test('character highlights isolate edits and keep surrounding source intact', () => {
  const old = 'const threshold = 100;\n', current = 'const threshold = 60;\n';
  const rows = previewRows(old, current, computeDiff(old, current).hunks, 0);
  assert.equal(rows[0]!.old!.segments.filter(part => part.changed).map(part => part.text).join(''), '10');
  assert.equal(rows[0]!.current!.segments.filter(part => part.changed).map(part => part.text).join(''), '6');
});

test('copy patch includes whole lines, blank additions and missing-final-newline markers', () => {
  const hunk = computeDiff('old\n', 'new\n\nlast').hunks[0]!;
  assert.equal(hunkPatch(hunk), '@@ -1,1 +1,3 @@\n-old\n+new\n+\n+last\n\\ No newline at end of file\n');
});

test('very long lines have bounded previews without splitting Unicode, while copy retains the full source', () => {
  const current = 'x' + '😀'.repeat(5000) + '\n';
  const hunk = { oldStart: 0, newStart: 0, oldLines: [], newLines: [current] };
  const row = previewRows('', current, [hunk], 0)[0]!;
  const text = row.current!.segments.map(part => part.text).join('');
  assert.equal(row.current!.shortened, true);
  assert.ok(text.length <= 2000);
  assert.ok(text.endsWith('😀'));
  assert.ok(hunkPatch(hunk).includes('+' + current));
});
