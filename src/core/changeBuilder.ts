import * as path from 'path';
import { minimatch } from 'minimatch';
import { computeLineDiff, DiffHunk, LineDiffResult } from './lineDiff';
import { isBinaryText, pathKey, slashPath, splitText, Eol, stripBom } from './lines';
import { isPathInside } from '../claude/paths';
import { SnapshotFileBackup, TranscriptState } from '../claude/transcript';

export type BaselineMode = 'session' | 'turn';

export interface FileChange {
  /** Absolute file path as recorded by Claude (or by the workspace for local baselines). */
  path: string;
  /** Absolute workspace-relative path with forward slashes. */
  relativePath: string;
  root: string;
  sessionId: string;
  baselineText: string;
  /** False when Claude created the file: rejecting the change deletes it. */
  baselineExisted: boolean;
  currentText: string;
  currentMissing: boolean;
  eol: Eol;
  diff: LineDiffResult;
  addedCount: number;
  removedCount: number;
  /**
   * Timestamp (ms) of the newest backup event Claude recorded for this path,
   * or 0 when the path only exists because of a stored local baseline.
   */
  lastClaudeEventAt: number;
  /**
   * True when the file content moved, since the caller last observed it, to a
   * state Claude had previously recorded (a checkpoint/rewind restore) rather
   * than to a new edit. Such a change is Claude withdrawing its own work, so it
   * must not be surfaced as a new review.
   */
  restoredFromBackup: boolean;
}

export interface LocalBaseline {
  path: string;
  text: string;
}

export interface BuildChangesInput {
  session: Readonly<TranscriptState>;
  sessionId: string;
  baselineMode: BaselineMode;
  localBaselines: Map<string, LocalBaseline>;
  workspaceRoots: string[];
  exclude: string[];
  maxFileSizeBytes: number;
  readBackup: (backupFileName: string) => Promise<string | null>;
  readCurrent: (fsPath: string) => Promise<{ text: string; missing: boolean; tooLarge?: boolean }>;
  /**
   * Last content the caller observed per path (null means the file was
   * missing). Mutated in place on every build so the next one can tell a new
   * Claude edit apart from a rewind to previously recorded content.
   */
  observedContents?: Map<string, string | null>;
  log?: (message: string) => void;
}

interface BackupEvent {
  timestamp: string;
  backup: SnapshotFileBackup;
  source: 'snapshot' | 'delta';
}

interface PathCandidate {
  displayPath: string;
  events: BackupEvent[];
}

interface WorkspaceLocation {
  root: string;
  relativePath: string;
}

function workspaceLocation(fsPath: string, workspaceRoots: string[]): WorkspaceLocation | undefined {
  let best: WorkspaceLocation | undefined;
  for (const root of workspaceRoots) {
    if (!isPathInside(root, fsPath)) {
      continue;
    }
    const relativePath = slashPath(path.relative(root, fsPath));
    if (best === undefined || root.length > best.root.length) {
      best = { root, relativePath };
    }
  }
  return best;
}

function isExcluded(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return minimatch(relativePath, pattern, { dot: true });
    } catch {
      return false;
    }
  });
}

function parseTimestamp(timestamp: string | undefined): number {
  if (!timestamp) {
    return 0;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Newest backup event timestamp (ms) present in the transcript, or 0. */
export function latestClaudeEventTime(session: Readonly<TranscriptState>): number {
  let latest = 0;
  for (const snapshot of session.snapshots.values()) {
    latest = Math.max(latest, parseTimestamp(snapshot.timestamp));
  }
  for (const delta of session.deltas) {
    latest = Math.max(latest, parseTimestamp(delta.timestamp));
  }
  return latest;
}

/**
 * Keeps the whole review empty unless at least one file carries a Claude edit
 * that is newer than the last fully reviewed state. While such a change is
 * pending every diff is shown (including manual/git edits), because they are
 * part of what the user is reviewing; with nothing pending no diff is shown.
 */
export function selectReviewChanges(changes: FileChange[], reviewedThrough: number): FileChange[] {
  return changes.some((change) => change.lastClaudeEventAt > reviewedThrough) ? changes : [];
}

function compareEvents(a: BackupEvent, b: BackupEvent): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp < b.timestamp ? -1 : 1;
  }
  if (a.source !== b.source) {
    return a.source === 'delta' ? -1 : 1;
  }
  return 0;
}

function collectCandidates(session: Readonly<TranscriptState>): Map<string, PathCandidate> {
  const candidates = new Map<string, PathCandidate>();
  const push = (displayPath: string, event: BackupEvent): void => {
    const key = pathKey(displayPath);
    const existing = candidates.get(key);
    if (existing) {
      existing.events.push(event);
    } else {
      candidates.set(key, { displayPath, events: [event] });
    }
  };

  for (const snapshot of session.snapshots.values()) {
    for (const [trackedPath, backup] of snapshot.tracked) {
      push(trackedPath, { timestamp: snapshot.timestamp, backup, source: 'snapshot' });
    }
  }
  for (const delta of session.deltas) {
    push(delta.trackingPath, { timestamp: delta.timestamp, backup: delta.backup, source: 'delta' });
  }
  for (const candidate of candidates.values()) {
    candidate.events.sort(compareEvents);
  }
  return candidates;
}

interface BaselineText {
  text: string;
  existed: boolean;
}

async function readBaselineForEvent(
  event: BackupEvent,
  readBackup: (backupFileName: string) => Promise<string | null>
): Promise<BaselineText | undefined> {
  if (event.backup.backupFileName === null) {
    // No backup means the file did not exist before Claude touched it.
    return { text: '', existed: false };
  }
  const text = await readBackup(event.backup.backupFileName);
  return text === null ? undefined : { text, existed: true };
}

/**
 * True when the current state of the file matches content Claude recorded in
 * one of its own backup events (or "did not exist", for a null backup). This
 * is the signature of a checkpoint/rewind restoring an older snapshot: a fresh
 * edit writes content that no backup contains yet.
 */
async function matchesRecordedBackup(
  candidate: PathCandidate,
  currentMissing: boolean,
  currentText: string,
  readBackup: (backupFileName: string) => Promise<string | null>
): Promise<boolean> {
  const checked = new Set<string>();
  for (const event of candidate.events) {
    const backupFileName = event.backup.backupFileName;
    if (backupFileName === null) {
      if (currentMissing) {
        return true;
      }
      continue;
    }
    if (currentMissing || checked.has(backupFileName)) {
      continue;
    }
    checked.add(backupFileName);
    const text = await readBackup(backupFileName);
    if (text !== null && stripBom(text) === currentText) {
      return true;
    }
  }
  return false;
}

async function resolveTranscriptBaseline(
  candidate: PathCandidate,
  input: BuildChangesInput
): Promise<BaselineText | undefined> {
  if (input.baselineMode === 'session') {
    const first = candidate.events[0];
    if (!first) {
      return undefined;
    }
    return readBaselineForEvent(first, input.readBackup);
  }

  const prompt = input.session.prompts[input.session.prompts.length - 1];
  if (!prompt) {
    return undefined;
  }
  const snapshot = input.session.snapshots.get(prompt.uuid);
  if (snapshot) {
    const tracked = snapshot.tracked.get(candidate.displayPath);
    if (tracked) {
      return readBaselineForEvent(
        { timestamp: snapshot.timestamp, backup: tracked, source: 'snapshot' },
        input.readBackup
      );
    }
    // Path might be tracked with different casing.
    for (const [trackedPath, backup] of snapshot.tracked) {
      if (pathKey(trackedPath) === pathKey(candidate.displayPath)) {
        return readBaselineForEvent(
          { timestamp: snapshot.timestamp, backup, source: 'snapshot' },
          input.readBackup
        );
      }
    }
  }
  const delta = candidate.events.find(
    (event) => event.source === 'delta' && event.timestamp >= prompt.timestamp
  );
  if (!delta) {
    return undefined;
  }
  return readBaselineForEvent(delta, input.readBackup);
}

export async function buildFileChanges(input: BuildChangesInput): Promise<FileChange[]> {
  if (input.workspaceRoots.length === 0) {
    return [];
  }
  const candidates = collectCandidates(input.session);

  // Local (reviewed) baselines may refer to files that are no longer present in
  // the transcript after a session restore; keep them in the working set.
  for (const [key, local] of input.localBaselines) {
    if (!candidates.has(key)) {
      candidates.set(key, { displayPath: local.path, events: [] });
    }
  }

  const results: FileChange[] = [];
  const seen = new Set<string>();

  for (const [key, candidate] of candidates) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const localBaseline = input.localBaselines.get(key);
    const baseline: BaselineText | undefined = localBaseline
      ? { text: localBaseline.text, existed: true }
      : await resolveTranscriptBaseline(candidate, input);
    if (baseline === undefined) {
      input.log?.(`Skipping ${candidate.displayPath}: original snapshot is unavailable.`);
      continue;
    }
    const baselineText = baseline.text;

    const location = workspaceLocation(candidate.displayPath, input.workspaceRoots);
    if (!location) {
      continue;
    }
    if (isExcluded(location.relativePath, input.exclude)) {
      continue;
    }

    const current = await input.readCurrent(candidate.displayPath);
    if (current.tooLarge) {
      input.log?.(`Skipping ${candidate.displayPath}: file is too large.`);
      continue;
    }
    if (baselineText.length > input.maxFileSizeBytes || current.text.length > input.maxFileSizeBytes) {
      input.log?.(`Skipping ${candidate.displayPath}: file is too large.`);
      continue;
    }
    const cleanBaseline = stripBom(baselineText);
    const cleanCurrent = stripBom(current.text);
    if (isBinaryText(cleanBaseline) || isBinaryText(cleanCurrent)) {
      continue;
    }

    // Track the content we observe so a later build can tell a normal new
    // Claude edit from a rewind back to previously recorded content. Only a
    // path we already observed changing qualifies: the very first build, or a
    // turn-start snapshot whose backup equals the current file, must not look
    // like a restore.
    const observedValue = current.missing ? null : cleanCurrent;
    const previousValue = input.observedContents?.get(key);
    const contentMoved = previousValue !== undefined && previousValue !== observedValue;
    input.observedContents?.set(key, observedValue);
    const restoredFromBackup =
      contentMoved &&
      (await matchesRecordedBackup(candidate, current.missing, cleanCurrent, input.readBackup));

    const baselineSplit = splitText(cleanBaseline);
    const currentSplit = splitText(cleanCurrent);
    const diff = computeLineDiff(baselineSplit.lines, currentSplit.lines);
    if (diff.hunks.length === 0) {
      continue;
    }

    results.push({
      path: candidate.displayPath,
      relativePath: location.relativePath,
      root: location.root,
      sessionId: input.sessionId,
      baselineText: cleanBaseline,
      baselineExisted: baseline.existed,
      currentText: cleanCurrent,
      currentMissing: current.missing,
      eol: currentSplit.eol,
      diff,
      addedCount: diff.addedCount,
      removedCount: diff.removedCount,
      lastClaudeEventAt: parseTimestamp(candidate.events[candidate.events.length - 1]?.timestamp),
      restoredFromBackup
    });
  }

  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

export function findHunkForSignature(change: FileChange, signature: string): DiffHunk | undefined {
  return change.diff.hunks.find((hunk) => hunk.signature === signature);
}
