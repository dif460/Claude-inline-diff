import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import {
  buildFileChanges,
  FileChange,
  latestClaudeEventTime,
  LocalBaseline,
  selectReviewChanges
} from '../src/core/changeBuilder';
import { buildReviewModel } from '../src/ui/reviewModel';
import { pathKey } from '../src/core/lines';
import { SnapshotFileBackup, TranscriptSnapshot, TranscriptState } from '../src/claude/transcript';

const ROOT = path.join(os.tmpdir(), 'claude-inline-builder-ws');
const FILE = path.join(ROOT, 'src', 'a.ts');

function backup(name: string | null): SnapshotFileBackup {
  return { backupFileName: name, version: 1, backupTime: '2025-01-01T00:00:00.000Z' };
}

function snapshot(messageId: string, timestamp: string, tracked: [string, SnapshotFileBackup][]): TranscriptSnapshot {
  return { messageId, timestamp, tracked: new Map(tracked) };
}

function baseState(overrides?: Partial<TranscriptState>): TranscriptState {
  return {
    sessionId: 'session-1',
    cwd: ROOT,
    prompts: [
      { uuid: 'prompt-1', timestamp: '2025-01-01T00:00:00.000Z' },
      { uuid: 'prompt-2', timestamp: '2025-01-01T00:10:00.000Z' }
    ],
    snapshots: new Map([[ 'prompt-1', snapshot('prompt-1', '2025-01-01T00:00:00.000Z', [[FILE, backup('v1@v1')]]) ]]),
    deltas: [],
    ...overrides
  };
}

function buildWith(
  state: TranscriptState,
  currentText: string,
  options?: { localBaselines?: Map<string, LocalBaseline>; baselineMode?: 'session' | 'turn'; exclude?: string[] }
) {
  return buildFileChanges({
    session: state,
    sessionId: 'session-1',
    baselineMode: options?.baselineMode ?? 'session',
    localBaselines: options?.localBaselines ?? new Map(),
    workspaceRoots: [ROOT],
    exclude: options?.exclude ?? [],
    maxFileSizeBytes: 1024 * 1024,
    readBackup: async (name) => (name === 'v1@v1' ? 'line1\nline2\n' : null),
    readCurrent: async () => ({ text: currentText, missing: false })
  });
}

test('session mode uses the earliest snapshot as baseline', async () => {
  const changes = await buildWith(baseState(), 'line1\nline2\nline3\n');
  assert.equal(changes.length, 1);
  const change = changes[0];
  assert.equal(change.path, FILE);
  assert.equal(change.relativePath, 'src/a.ts');
  assert.equal(change.baselineText, 'line1\nline2\n');
  assert.equal(change.addedCount, 1);
  assert.equal(change.removedCount, 0);
});

test('turn mode uses the latest prompt snapshot', async () => {
  const state = baseState();
  state.snapshots.set(
    'prompt-2',
    snapshot('prompt-2', '2025-01-01T00:10:00.000Z', [[FILE, backup('v2@v1')]])
  );
  const changes = await buildFileChanges({
    session: state,
    sessionId: 'session-1',
    baselineMode: 'turn',
    localBaselines: new Map(),
    workspaceRoots: [ROOT],
    exclude: [],
    maxFileSizeBytes: 1024 * 1024,
    readBackup: async (name) => (name === 'v2@v1' ? 'line1\nline2\nline3\n' : 'line1\nline2\n'),
    readCurrent: async () => ({ text: 'line1\nline2\nline3\nline4\n', missing: false })
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].baselineText, 'line1\nline2\nline3\n');
  assert.equal(changes[0].addedCount, 1);
});

test('a local reviewed baseline overrides the transcript baseline', async () => {
  const local = new Map<string, LocalBaseline>([
    [pathKey(FILE), { path: FILE, text: 'line1\nline2\nline3\n' }]
  ]);
  const changes = await buildWith(baseState(), 'line1\nline2\nline3\nline4\n', { localBaselines: local });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].addedCount, 1);
  assert.deepEqual(changes[0].diff.hunks[0].added, ['line4']);
});

test('local baseline equal to current content hides the file entirely', async () => {
  const text = 'line1\nline2\nline3\n';
  const local = new Map<string, LocalBaseline>([[pathKey(FILE), { path: FILE, text }]]);
  const changes = await buildWith(baseState(), text, { localBaselines: local });
  assert.equal(changes.length, 0);
});

test('new files use an empty baseline', async () => {
  const state = baseState();
  state.snapshots.set(
    'prompt-1',
    snapshot('prompt-1', '2025-01-01T00:00:00.000Z', [[FILE, backup(null)]])
  );
  const changes = await buildWith(state, 'created\n');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].baselineText, '');
  assert.equal(changes[0].baselineExisted, false);
  assert.equal(changes[0].addedCount, 1);
});

test('existing files keep the baseline-existed flag so reject restores content', async () => {
  const changes = await buildWith(baseState(), 'line1\nline2\nline3\n');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].baselineExisted, true);
});

test('deleted files are reported with their whole baseline as removed', async () => {
  const changes = await buildFileChanges({
    session: baseState(),
    sessionId: 'session-1',
    baselineMode: 'session',
    localBaselines: new Map(),
    workspaceRoots: [ROOT],
    exclude: [],
    maxFileSizeBytes: 1024 * 1024,
    readBackup: async (name) => (name === 'v1@v1' ? 'line1\nline2\n' : null),
    readCurrent: async () => ({ text: '', missing: true })
  });
  assert.equal(changes.length, 1);
  const change = changes[0];
  assert.equal(change.currentMissing, true);
  assert.equal(change.baselineExisted, true);
  assert.equal(change.baselineText, 'line1\nline2\n');
  assert.equal(change.removedCount, 2);
  assert.equal(change.addedCount, 0);
  assert.equal(change.diff.hunks[0].kind, 'remove');
});

test('local reviewed baselines always count as an existing file', async () => {
  const local = new Map<string, LocalBaseline>([
    [pathKey(FILE), { path: FILE, text: 'line1\n' }]
  ]);
  const changes = await buildWith(baseState(), 'line1\nline2\n', { localBaselines: local });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].baselineExisted, true);
});

test('excluded paths are skipped', async () => {
  const changes = await buildWith(baseState(), 'line1\nline2\nline3\n', {
    exclude: ['**/src/a.ts']
  });
  assert.equal(changes.length, 0);
});

test('each change reports the newest Claude event for its path', async () => {
  const state = baseState();
  state.deltas.push({
    timestamp: '2025-01-01T00:05:00.000Z',
    snapshotMessageId: 'prompt-1',
    trackingPath: FILE,
    backup: backup('v1@v1')
  });
  const changes = await buildWith(state, 'line1\nline2\nline3\n');
  assert.equal(changes[0].lastClaudeEventAt, Date.parse('2025-01-01T00:05:00.000Z'));
  // Only backup events count as Claude activity; user prompts do not.
  assert.equal(latestClaudeEventTime(state), Date.parse('2025-01-01T00:05:00.000Z'));
});

test('review stays empty when no Claude event is newer than the reviewed watermark', async () => {
  const changes = await buildWith(baseState(), 'line1\nline2\nline3\n');
  assert.equal(changes.length, 1);
  // Everything up to (and including) the newest event was already reviewed.
  const reviewedThrough = latestClaudeEventTime(baseState());
  assert.deepEqual(selectReviewChanges(changes, reviewedThrough), []);
});

test('an unreviewed Claude event surfaces every pending diff', async () => {
  const changes = await buildWith(baseState(), 'line1\nline2\nline3\n');
  assert.equal(selectReviewChanges(changes, 0).length, 1);
});

test('files tracked only by a local baseline never start a review', async () => {
  const local = new Map<string, LocalBaseline>([
    [pathKey(FILE), { path: FILE, text: 'line1\n' }]
  ]);
  const emptyState: TranscriptState = {
    sessionId: 'session-1',
    cwd: ROOT,
    prompts: [],
    snapshots: new Map(),
    deltas: []
  };
  const changes = await buildWith(emptyState, 'line1\nline2\n', { localBaselines: local });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].lastClaudeEventAt, 0);
  assert.deepEqual(selectReviewChanges(changes, 0), []);
});

test('review model maps merged lines back to source lines', async () => {
  const changes = await buildWith(baseState(), 'line1\nCHANGED\nline2\nline3\n');
  assert.equal(changes.length, 1);
  const change: FileChange = changes[0];
  const model = buildReviewModel('key', change);
  assert.deepEqual(
    model.lines.map((line) => [line.kind, line.text]),
    [
      ['context', 'line1'],
      ['added', 'CHANGED'],
      ['context', 'line2'],
      ['added', 'line3']
    ]
  );
  assert.deepEqual(
    model.lines.map((line) => line.sourceLine),
    [0, 1, 2, 3]
  );
  const hunk = change.diff.hunks[0];
  assert.equal(model.hunkStartLine.get(hunk.signature), 1);
});
