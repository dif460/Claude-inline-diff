import { FileChange } from '../core/changeBuilder';
import { CharSpan, DiffHunk } from '../core/lineDiff';

export type ReviewLineKind = 'context' | 'removed' | 'added';

export interface ReviewLineInfo {
  text: string;
  kind: ReviewLineKind;
  signature?: string;
  /** 0-based line in the current source file this merged line maps to. */
  sourceLine: number;
}

export interface ReviewWordSpan {
  line: number;
  start: number;
  end: number;
}

export interface ReviewModel {
  key: string;
  change: FileChange;
  lines: ReviewLineInfo[];
  hunkStartLine: Map<string, number>;
  removedWordSpans: ReviewWordSpan[];
  addedWordSpans: ReviewWordSpan[];
  /** Empty-state marker for files whose changes were all reviewed. */
  pendingHunks: DiffHunk[];
}

export function reviewKey(sessionId: string, fsPath: string): string {
  return `${sessionId}\u0000${fsPath}`;
}

function appendWordSpans(lineOffset: number, spans: CharSpan[], output: ReviewWordSpan[]): void {
  for (const span of spans) {
    output.push({ line: lineOffset, start: span.start, end: span.end });
  }
}

export function buildReviewModel(key: string, change: FileChange): ReviewModel {
  const lines: ReviewLineInfo[] = [];
  const hunkStartLine = new Map<string, number>();
  let sourceLine = 0;

  for (const line of change.diff.reviewLines) {
    if (line.kind === 'removed') {
      lines.push({
        text: line.text,
        kind: 'removed',
        signature: line.hunkSignature,
        sourceLine
      });
    } else if (line.kind === 'added') {
      lines.push({
        text: line.text,
        kind: 'added',
        signature: line.hunkSignature,
        sourceLine
      });
      sourceLine++;
    } else {
      lines.push({ text: line.text, kind: 'context', sourceLine });
      sourceLine++;
    }
  }

  for (const hunk of change.diff.hunks) {
    const firstRemovedOrAdded = lines.findIndex((line) => line.signature === hunk.signature);
    if (firstRemovedOrAdded >= 0) {
      hunkStartLine.set(hunk.signature, firstRemovedOrAdded);
    }
  }

  const removedWordSpans: ReviewWordSpan[] = [];
  const addedWordSpans: ReviewWordSpan[] = [];

  for (const hunk of change.diff.hunks) {
    const wordDiff = change.diff.wordDiffs.get(hunk.signature);
    if (!wordDiff) {
      continue;
    }
    const start = hunkStartLine.get(hunk.signature);
    if (start === undefined) {
      continue;
    }
    for (let i = 0; i < wordDiff.pairs.length; i++) {
      const pair = wordDiff.pairs[i];
      if (pair.removed.length > 0 && i < hunk.removed.length) {
        appendWordSpans(start + i, pair.removed, removedWordSpans);
      }
      const addedLine = start + hunk.removed.length + i;
      if (pair.added.length > 0 && i < hunk.added.length) {
        appendWordSpans(addedLine, pair.added, addedWordSpans);
      }
    }
  }

  return {
    key,
    change,
    lines,
    hunkStartLine,
    removedWordSpans,
    addedWordSpans,
    pendingHunks: change.diff.hunks
  };
}
