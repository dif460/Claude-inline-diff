import { diffArrays, diffWordsWithSpace } from 'diff';

export type HunkKind = 'add' | 'remove' | 'modify';

export interface DiffHunk {
  /** Stable within one baseline/current pair: baseline start/end + current start/end. */
  signature: string;
  kind: HunkKind;
  baselineStart: number;
  baselineEnd: number;
  currentStart: number;
  currentEnd: number;
  removed: string[];
  added: string[];
}

export interface CharSpan {
  start: number;
  end: number;
}

export interface WordDiffPair {
  removed: CharSpan[];
  added: CharSpan[];
}

export interface HunkWordDiff {
  pairs: WordDiffPair[];
}

export type ReviewLineKind = 'context' | 'removed' | 'added';

export interface ReviewLine {
  text: string;
  kind: ReviewLineKind;
  hunkSignature?: string;
}

export interface DeletionAnchor {
  /** 0-based line in the current document where the deleted block used to be. */
  anchor: number;
  hunks: DiffHunk[];
}

export interface LineDiffResult {
  hunks: DiffHunk[];
  addedLineNumbers: number[];
  addedByLine: Map<number, DiffHunk>;
  deletionAnchors: DeletionAnchor[];
  reviewLines: ReviewLine[];
  wordDiffs: Map<string, HunkWordDiff>;
  addedCount: number;
  removedCount: number;
}

interface PendingRun {
  start: number;
  lines: string[];
}

const MAX_WORD_DIFF_LINES = 400;

function signatureOf(
  baselineStart: number,
  baselineEnd: number,
  currentStart: number,
  currentEnd: number
): string {
  return `${baselineStart}:${baselineEnd}:${currentStart}:${currentEnd}`;
}

function computeWordDiffPairs(removed: string[], added: string[]): HunkWordDiff | undefined {
  const count = Math.min(removed.length, added.length);
  if (count === 0 || removed.length > MAX_WORD_DIFF_LINES || added.length > MAX_WORD_DIFF_LINES) {
    return undefined;
  }
  const pairs: WordDiffPair[] = [];
  for (let i = 0; i < count; i++) {
    const oldLine = removed[i];
    const newLine = added[i];
    if (oldLine === newLine) {
      pairs.push({ removed: [], added: [] });
      continue;
    }
    const parts = diffWordsWithSpace(oldLine, newLine);
    let oldOffset = 0;
    let newOffset = 0;
    const removedSpans: CharSpan[] = [];
    const addedSpans: CharSpan[] = [];
    for (const part of parts) {
      const length = part.value.length;
      if (part.removed) {
        if (length > 0) {
          removedSpans.push({ start: oldOffset, end: oldOffset + length });
        }
        oldOffset += length;
      } else if (part.added) {
        if (length > 0) {
          addedSpans.push({ start: newOffset, end: newOffset + length });
        }
        newOffset += length;
      } else {
        oldOffset += length;
        newOffset += length;
      }
    }
    pairs.push({ removed: removedSpans, added: addedSpans });
  }
  return { pairs };
}

/**
 * Compute line-level hunks between baseline and current text.
 * Deleted blocks are attached to the line in the current document where they
 * were removed, so they can be rendered as a marker in the real editor.
 */
export function computeLineDiff(baselineLines: string[], currentLines: string[]): LineDiffResult {
  const parts = diffArrays(baselineLines, currentLines, { comparator: (a, b) => a === b });

  const hunks: DiffHunk[] = [];
  const reviewLines: ReviewLine[] = [];
  const addedLineNumbers: number[] = [];
  const addedByLine = new Map<number, DiffHunk>();
  const deletionAnchors = new Map<number, DeletionAnchor>();
  const wordDiffs = new Map<string, HunkWordDiff>();

  let baselineIndex = 0;
  let currentIndex = 0;
  let pendingRemoved: PendingRun | undefined;
  let pendingAdded: PendingRun | undefined;

  const flushHunk = (): void => {
    if (!pendingRemoved && !pendingAdded) {
      return;
    }
    const baselineStart = pendingRemoved ? pendingRemoved.start : baselineIndex;
    const baselineEnd = pendingRemoved ? pendingRemoved.start + pendingRemoved.lines.length : baselineIndex;
    const currentStart = pendingAdded ? pendingAdded.start : currentIndex;
    const currentEnd = pendingAdded ? pendingAdded.start + pendingAdded.lines.length : currentIndex;
    const removed = pendingRemoved ? pendingRemoved.lines : [];
    const added = pendingAdded ? pendingAdded.lines : [];

    const kind: HunkKind = removed.length > 0 && added.length > 0 ? 'modify' : removed.length > 0 ? 'remove' : 'add';
    const hunk: DiffHunk = {
      signature: signatureOf(baselineStart, baselineEnd, currentStart, currentEnd),
      kind,
      baselineStart,
      baselineEnd,
      currentStart,
      currentEnd,
      removed,
      added
    };
    hunks.push(hunk);

    for (const line of removed) {
      reviewLines.push({ text: line, kind: 'removed', hunkSignature: hunk.signature });
    }
    for (const line of added) {
      reviewLines.push({ text: line, kind: 'added', hunkSignature: hunk.signature });
    }

    for (let line = currentStart; line < currentEnd; line++) {
      addedLineNumbers.push(line);
      addedByLine.set(line, hunk);
    }

    if (removed.length > 0) {
      const anchor = currentStart;
      const existing = deletionAnchors.get(anchor);
      if (existing) {
        existing.hunks.push(hunk);
      } else {
        deletionAnchors.set(anchor, { anchor, hunks: [hunk] });
      }
    }

    const wordDiff = computeWordDiffPairs(removed, added);
    if (wordDiff) {
      wordDiffs.set(hunk.signature, wordDiff);
    }

    pendingRemoved = undefined;
    pendingAdded = undefined;
  };

  for (const part of parts) {
    if (part.added) {
      if (!pendingAdded) {
        pendingAdded = { start: currentIndex, lines: [] };
      }
      pendingAdded.lines.push(...part.value);
      currentIndex += part.value.length;
    } else if (part.removed) {
      if (!pendingRemoved) {
        pendingRemoved = { start: baselineIndex, lines: [] };
      }
      pendingRemoved.lines.push(...part.value);
      baselineIndex += part.value.length;
    } else {
      flushHunk();
      for (const line of part.value) {
        reviewLines.push({ text: line, kind: 'context' });
      }
      baselineIndex += part.value.length;
      currentIndex += part.value.length;
    }
  }
  flushHunk();

  // Review lines carry hunk signatures on removed/added lines. The loop above
  // appended them without signatures (it doesn't know the hunk yet), so fill
  // them in now in document order.
  let reviewCursor = 0;
  for (const hunk of hunks) {
    while (reviewCursor < reviewLines.length && reviewLines[reviewCursor].kind === 'context') {
      reviewCursor++;
    }
    for (let i = 0; i < hunk.removed.length + hunk.added.length; i++) {
      if (reviewCursor < reviewLines.length) {
        reviewLines[reviewCursor].hunkSignature = hunk.signature;
        reviewCursor++;
      }
    }
  }

  return {
    hunks,
    addedLineNumbers,
    addedByLine,
    deletionAnchors: [...deletionAnchors.values()].sort((a, b) => a.anchor - b.anchor),
    reviewLines,
    wordDiffs,
    addedCount: addedLineNumbers.length,
    removedCount: hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0)
  };
}

/**
 * Apply one accepted hunk to the baseline: replace the baseline range with the
 * current range. This is how "reviewed" changes are made to disappear without
 * touching the user's working tree.
 */
export function applyHunkToBaseline(baselineLines: string[], currentLines: string[], hunk: DiffHunk): string[] {
  const before = baselineLines.slice(0, hunk.baselineStart);
  const middle = currentLines.slice(hunk.currentStart, hunk.currentEnd);
  const after = baselineLines.slice(hunk.baselineEnd);
  return [...before, ...middle, ...after];
}

export function findHunkBySignature(result: LineDiffResult, signature: string): DiffHunk | undefined {
  return result.hunks.find((hunk) => hunk.signature === signature);
}

export function findHunkAtLine(result: LineDiffResult, line: number): DiffHunk | undefined {
  return result.addedByLine.get(line) ?? result.deletionAnchors.find((a) => a.anchor === line)?.hunks[0];
}
