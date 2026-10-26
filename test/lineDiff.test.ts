import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHunkToBaseline, computeLineDiff, findHunkAtLine, findHunkBySignature } from '../src/core/lineDiff';

test('detects a modification followed by an insertion', () => {
  const result = computeLineDiff(['a', 'b', 'c'], ['a', 'B', 'c', 'd']);
  assert.equal(result.hunks.length, 2);
  assert.equal(result.addedCount, 2);
  assert.equal(result.removedCount, 1);

  const [modify, add] = result.hunks;
  assert.equal(modify.kind, 'modify');
  assert.deepEqual(modify.removed, ['b']);
  assert.deepEqual(modify.added, ['B']);
  assert.equal(modify.baselineStart, 1);
  assert.equal(modify.currentStart, 1);

  assert.equal(add.kind, 'add');
  assert.deepEqual(add.added, ['d']);
  assert.equal(add.currentStart, 3);
  assert.equal(result.addedLineNumbers.includes(3), true);
  assert.equal(findHunkAtLine(result, 1), modify);
  assert.equal(findHunkBySignature(result, add.signature), add);
});

test('attaches a deleted block to its anchor line in the current document', () => {
  const result = computeLineDiff(['a', 'b', 'c'], ['a']);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].kind, 'remove');
  assert.equal(result.deletionAnchors.length, 1);
  assert.equal(result.deletionAnchors[0].anchor, 1);
  assert.deepEqual(result.deletionAnchors[0].hunks[0].removed, ['b', 'c']);
  assert.equal(result.reviewLines.filter((line) => line.kind === 'removed').length, 2);
  assert.equal(
    result.reviewLines.every((line) => line.kind === 'context' || line.hunkSignature !== undefined),
    true
  );
});

test('computes word spans for modified line pairs', () => {
  const result = computeLineDiff(
    ['const value = oldName;'],
    ['const value = newName;']
  );
  const hunk = result.hunks[0];
  const wordDiff = result.wordDiffs.get(hunk.signature);
  assert.ok(wordDiff);
  assert.equal(wordDiff.pairs.length, 1);
  const pair = wordDiff.pairs[0];
  assert.equal(pair.removed.length, 1);
  assert.equal(pair.added.length, 1);
  assert.equal('const value = oldName;'.slice(pair.removed[0].start, pair.removed[0].end), 'oldName');
  assert.equal('const value = newName;'.slice(pair.added[0].start, pair.added[0].end), 'newName');
});

test('accepting a hunk mutates only the baseline', () => {
  const baseline = ['a', 'b', 'c'];
  const current = ['a', 'B', 'c', 'd'];
  const result = computeLineDiff(baseline, current);
  const updated = applyHunkToBaseline(baseline, current, result.hunks[0]);
  assert.deepEqual(updated, ['a', 'B', 'c']);

  const remaining = computeLineDiff(updated, current);
  assert.equal(remaining.hunks.length, 1);
  assert.equal(remaining.hunks[0].kind, 'add');
  assert.deepEqual(remaining.hunks[0].added, ['d']);

  // The original arrays are untouched.
  assert.deepEqual(baseline, ['a', 'b', 'c']);
});

test('accepting a deletion-only hunk removes its anchor', () => {
  const baseline = ['a', 'b', 'c'];
  const current = ['a'];
  const result = computeLineDiff(baseline, current);
  const updated = applyHunkToBaseline(baseline, current, result.hunks[0]);
  assert.deepEqual(updated, ['a']);
  assert.equal(computeLineDiff(updated, current).hunks.length, 0);
});

test('handles empty baselines (new files) and empty current files (deletions)', () => {
  const added = computeLineDiff([], ['x', 'y']);
  assert.equal(added.hunks.length, 1);
  assert.equal(added.hunks[0].kind, 'add');
  assert.equal(added.addedCount, 2);

  const removed = computeLineDiff(['x', 'y'], []);
  assert.equal(removed.hunks.length, 1);
  assert.equal(removed.hunks[0].kind, 'remove');
  assert.equal(removed.removedCount, 2);
  assert.equal(removed.deletionAnchors[0].anchor, 0);
});
