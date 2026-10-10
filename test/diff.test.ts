import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDiff, hunkAtLine, hunkLine, lineMarkers, minimalTextChange, previewHunk, restoreHunk } from '../src/diff';

test('hunk previews distinguish removed and added lines, including blank lines and a missing final newline', () => {
  const hunk = computeDiff('keep\nold\n\n', 'keep\nnew\nlast').hunks[0]!;
  assert.deepEqual(previewHunk(hunk), {
    text: '@@ -2,2 +2,2 @@\n-old\n-\n+new\n+last\n\\ No newline at end of file',
    truncated: false,
  });
  assert.equal(previewHunk(computeDiff('', 'new\n').hunks[0]!).text, '@@ -0,0 +1,1 @@\n+new');
  assert.equal(previewHunk(computeDiff('old\n', '').hunks[0]!).text, '@@ -1,1 +0,0 @@\n-old');
});

test('large hunk previews stay bounded and show both sides of a replacement', () => {
  const hunk = computeDiff('old\n'.repeat(500), 'new\n'.repeat(500)).hunks[0]!;
  const preview = previewHunk(hunk);
  assert.equal(preview.truncated, true);
  assert.equal(preview.text.split('\n').length, 25);
  assert.ok(preview.text.includes('-old') && preview.text.includes('+new'));
  const long = previewHunk(computeDiff('', 'x'.repeat(100_000) + '\n').hunks[0]!);
  assert.equal(long.truncated, true);
  assert.ok(long.text.length < 500);
  assert.ok(long.text.endsWith('…'));
});

test('normalizes CRLF without ignoring a missing final newline or whitespace changes', () => {
  assert.equal(computeDiff('a\r\nb\r\n', 'a\nb\n').hunks.length, 0);
  assert.deepEqual(computeDiff('a\n', 'a').modified, [{ start: 0, count: 1 }]);
  assert.deepEqual(computeDiff('a\n', ' a\n').modified, [{ start: 0, count: 1 }]);
});

test('new files, blank lines, and empty documents', () => {
  assert.deepEqual(computeDiff('', '').hunks, []);
  assert.deepEqual(computeDiff('', 'one\ntwo\n').added, [{ start: 0, count: 2 }]);
  assert.deepEqual(computeDiff('', '\n').added, [{ start: 0, count: 1 }]);
  assert.deepEqual(computeDiff('old\n', '').deleted, [{ line: 0, placement: 'before', count: 1 }]);
});

test('deletions have accurate beginning, middle, and end anchors', () => {
  assert.deepEqual(computeDiff('x\na\n', 'a\n').deleted, [{ line: 0, placement: 'before', count: 1 }]);
  assert.deepEqual(computeDiff('a\nx\nb\n', 'a\nb\n').deleted, [{ line: 0, placement: 'after', count: 1 }]);
  assert.deepEqual(computeDiff('a\nx\n', 'a\n').deleted, [{ line: 0, placement: 'after', count: 1 }]);
});

test('mixed replacement hunks distinguish modifications and excess additions/deletions', () => {
  const added = computeDiff('a\nold\nz\n', 'a\nnew\nextra\nz\n');
  assert.deepEqual(added.modified, [{ start: 1, count: 1 }]);
  assert.deepEqual(added.added, [{ start: 2, count: 1 }]);
  const removed = computeDiff('a\nold\nextra\nz\n', 'a\nnew\nz\n');
  assert.deepEqual(removed.modified, [{ start: 1, count: 1 }]);
  assert.deepEqual(removed.deleted, [{ line: 1, placement: 'after', count: 1 }]);
});

test('restoring individual hunks preserves unrelated edits and line endings', () => {
  const current = 'a\r\nNEW\r\nseparator\nOTHER\r\n';
  const diff = computeDiff('a\nold\nseparator\nother\n', current);
  assert.equal(diff.hunks.length, 2);
  assert.equal(restoreHunk(current, diff.hunks[0]!, '\r\n'), 'a\r\nold\r\nseparator\nOTHER\r\n');
  for (const [before, after] of [['a\n', 'a'], ['a', 'a\n'], ['old\n', ''], ['', 'new\n'], ['a\nb\n', 'a\n'], ['a\nb', 'a']]) {
    const hunks = computeDiff(before!, after!).hunks;
    assert.equal(restoreHunk(after!, hunks[0]!, '\n'), before);
  }
});

test('all hunks can reconstruct the baseline across deterministic randomized inputs', () => {
  let seed = 2026;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const text = () => Array.from({ length: Math.floor(random() * 30) }, () => `${Math.floor(random() * 8)}\n`).join('').slice(0, random() > 0.5 ? -1 : undefined);
  for (let iteration = 0; iteration < 300; iteration++) {
    const before = text();
    let after = text();
    for (const hunk of computeDiff(before, after).hunks.reverse()) after = restoreHunk(after, hunk, '\n');
    assert.equal(after, before);
  }
});

test('hunk selection works on deletion markers and navigation stays inside the editor', () => {
  const hunk = computeDiff('a\nremoved\n', 'a\n').hunks[0]!;
  assert.equal(hunkAtLine([hunk], 0, 2), hunk);
  assert.equal(hunkAtLine([hunk], 1, 2), hunk);
  assert.equal(hunkLine(hunk, 1), 0);
  assert.equal(hunkAtLine([hunk], 5, 6), undefined);
});

test('excessive line counts and expensive diffs stop gracefully', () => {
  assert.throws(() => computeDiff('', '\n'.repeat(50_000)), /line limit/);
  assert.throws(() => computeDiff('a\n'.repeat(10_000), 'b\n'.repeat(10_000), 1), /time limit/);
});

test('one gutter glyph retains overlapping modification and deletion markers', () => {
  assert.deepEqual(lineMarkers(computeDiff('old\nextra\n', 'new\n')), [
    { line: 0, change: 'modified', before: 0, after: 1 },
  ]);
  assert.deepEqual(lineMarkers(computeDiff('before\nkeep\nafter\n', 'keep\n')), [
    { line: 0, before: 1, after: 1 },
  ]);
});

test('restoring a deletion marker chooses that hunk instead of its neighbor', () => {
  const current = 'a\nb\nc\n';
  const diff = computeDiff('a\nX\nb\nY\nc\n', current);
  const hunk = hunkAtLine(diff.hunks, 1, 4)!;
  assert.deepEqual(hunk.oldLines, ['Y\n']);
  assert.equal(restoreHunk(current, hunk, '\n'), 'a\nb\nY\nc\n');
});

test('minimal restoration edits preserve unrelated text and never split CRLF or surrogate pairs', () => {
  const cases = [
    ['prefix changed suffix', 'prefix original suffix'],
    ['a\r\nb\r\n', 'a\r\nB\r\n'],
    ['a\r\n', 'a'], ['a', 'a\r\n'],
    ['a\r\n', 'a\nb\r\n'],
    ['a\r\nb', 'a\rb'],
    ['status: 👎 ok\n', 'status: 👍 ok\n'],
    ['a\uD83C\uDE00b', 'a\uD83D\uDE00b'],
    ['a\n👍 kept\n', 'a\n👎 removed\n👍 kept\n'],
    ['', 'new\n'], ['old\n', ''], ['unchanged', 'unchanged'],
  ];
  for (const [current, replacement] of cases) {
    const change = minimalTextChange(current!, replacement!);
    assert.equal(current!.slice(0, change.start) + change.text + current!.slice(change.end), replacement);
    for (const boundary of [change.start, change.end]) {
      assert.notEqual(current!.slice(boundary - 1, boundary + 1), '\r\n');
      assert.equal(/[\uD800-\uDBFF]/.test(current![boundary - 1] ?? ''), false);
    }
  }
  assert.deepEqual(minimalTextChange('prefix new suffix', 'prefix old suffix'), { start: 7, end: 10, text: 'old' });
});

test('minimal edits safely restore randomized Unicode hunks', () => {
  let seed = 2026;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const alphabet = ['a', '👍', '👎', '\uD83C\uDE00', '𝒜', '𠮷', ''];
  const text = (eol: string) => Array.from({ length: Math.floor(random() * 20) },
    () => alphabet[Math.floor(random() * alphabet.length)] + eol).join('');
  for (let iteration = 0; iteration < 300; iteration++) {
    const eol = iteration % 2 ? '\r\n' : '\n';
    const before = text(eol);
    let after = text(eol);
    for (const hunk of computeDiff(before, after).hunks.reverse()) {
      const restored = restoreHunk(after, hunk, eol);
      const change = minimalTextChange(after, restored);
      for (const boundary of [change.start, change.end]) {
        assert.notEqual(after.slice(boundary - 1, boundary + 1), '\r\n');
        assert.equal(/[\uD800-\uDBFF]/.test(after[boundary - 1] ?? ''), false);
      }
      after = after.slice(0, change.start) + change.text + after.slice(change.end);
      assert.equal(after, restored);
    }
    assert.equal(after, before);
  }
});
