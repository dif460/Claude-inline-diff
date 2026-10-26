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
  currentText: string;
  currentMissing: boolean;
  eol: Eol;
  diff: LineDiffResult;
  addedCount: number;
  removedCount: number;
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

async function readBaselineForEvent(
  event: BackupEvent,
  readBackup: (backupFileName: string) => Promise<string | null>
): Promise<string | undefined> {
  if (event.backup.backupFileName === null) {
    return '';
  }
  const text = await readBackup(event.backup.backupFileName);
  return text === null ? undefined : text;
}

async function resolveTranscriptBaseline(
  candidate: PathCandidate,
  input: BuildChangesInput
): Promise<string | undefined> {
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
    let baselineText: string | undefined = localBaseline?.text;
    if (baselineText === undefined) {
      baselineText = await resolveTranscriptBaseline(candidate, input);
    }
    if (baselineText === undefined) {
      input.log?.(`Skipping ${candidate.displayPath}: original snapshot is unavailable.`);
      continue;
    }

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
      currentText: cleanCurrent,
      currentMissing: current.missing,
      eol: currentSplit.eol,
      diff,
      addedCount: diff.addedCount,
      removedCount: diff.removedCount
    });
  }

  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

export function findHunkForSignature(change: FileChange, signature: string): DiffHunk | undefined {
  return change.diff.hunks.find((hunk) => hunk.signature === signature);
}
