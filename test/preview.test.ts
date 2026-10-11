import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDiff } from '../src/diff';
import { hunkPatch } from '../src/preview';

test('copy patch includes whole lines, blank additions and missing-final-newline markers', () => {
  const hunk = computeDiff('old\n', 'new\n\nlast').hunks[0]!;
  assert.equal(hunkPatch(hunk), '@@ -1,1 +1,3 @@\n-old\n+new\n+\n+last\n\\ No newline at end of file\n');
});
