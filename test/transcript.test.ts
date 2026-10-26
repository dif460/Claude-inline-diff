import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TranscriptParser } from '../src/claude/transcript';

function line(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

function workspaceFile(): string {
  return path.join(os.tmpdir(), 'claude-inline-transcript-ws', 'a.ts');
}

function sampleTranscript(): string {
  const file = workspaceFile();
  return (
    line({
      type: 'user',
      uuid: 'prompt-1',
      sessionId: 'session-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      cwd: path.dirname(file),
      message: { role: 'user', content: 'first request' }
    }) +
    line({
      type: 'file-history-snapshot',
      messageId: 'prompt-1',
      snapshot: {
        messageId: 'prompt-1',
        timestamp: '2025-01-01T00:00:01.000Z',
        trackedFileBackups: {
          [file]: {
            backupFileName: 'abc123@v1',
            version: 1,
            backupTime: '2025-01-01T00:00:01.000Z'
          }
        }
      }
    }) +
    line({
      type: 'file-history-delta',
      snapshotMessageId: 'prompt-1',
      trackingPath: file,
      timestamp: '2025-01-01T00:00:02.000Z',
      backup: { backupFileName: null, version: 1, backupTime: '2025-01-01T00:00:02.000Z' }
    }) +
    line({
      type: 'assistant',
      timestamp: '2025-01-01T00:00:03.000Z',
      message: { role: 'assistant', stop_reason: 'tool_use', content: [] }
    }) +
    line({
      type: 'assistant',
      timestamp: '2025-01-01T00:00:04.000Z',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [] }
    }) +
    line({
      type: 'user',
      uuid: 'tool-result-1',
      timestamp: '2025-01-01T00:00:05.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] }
    }) +
    line({
      type: 'user',
      uuid: 'prompt-2',
      timestamp: '2025-01-01T00:00:06.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'second request' }] }
    })
  );
}

test('parses prompts, snapshots, deltas and turn ends', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-inline-transcript-'));
  const filePath = path.join(dir, 'session-1.jsonl');
  await fs.promises.writeFile(filePath, sampleTranscript(), 'utf8');
  try {
    const parser = new TranscriptParser(filePath);
    const update = await parser.update();
    assert.equal(update.changed, true);
    assert.equal(update.reset, false);
    const state = parser.getState();
    assert.equal(state.sessionId, 'session-1');
    assert.equal(state.cwd, path.dirname(workspaceFile()));
    assert.deepEqual(
      state.prompts.map((prompt) => prompt.uuid),
      ['prompt-1', 'prompt-2']
    );
    assert.equal(state.snapshots.size, 1);
    assert.equal(state.deltas.length, 1);
    assert.equal(state.deltas[0].backup.backupFileName, null);
    assert.equal(state.lastEndTurnTimestamp, '2025-01-01T00:00:04.000Z');
    assert.equal(parser.getLastPrompt()?.uuid, 'prompt-2');

    const unchanged = await parser.update();
    assert.equal(unchanged.changed, false);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('resets state when the transcript is replaced by a shorter file', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-inline-transcript-'));
  const filePath = path.join(dir, 'session-1.jsonl');
  await fs.promises.writeFile(filePath, sampleTranscript(), 'utf8');
  try {
    const parser = new TranscriptParser(filePath);
    await parser.update();
    assert.equal(parser.getState().prompts.length, 2);

    const shorter =
      line({
        type: 'user',
        uuid: 'new-prompt',
        sessionId: 'session-1',
        timestamp: '2025-01-02T00:00:00.000Z',
        message: { role: 'user', content: 'restarted' }
      }) + '\n';
    await fs.promises.writeFile(filePath, shorter, 'utf8');
    const update = await parser.update();
    assert.equal(update.reset, true);
    assert.equal(update.changed, true);
    assert.deepEqual(
      parser.getState().prompts.map((prompt) => prompt.uuid),
      ['new-prompt']
    );
    assert.equal(parser.getState().snapshots.size, 0);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('ignores a partially written trailing line until it is complete', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-inline-transcript-'));
  const filePath = path.join(dir, 'session-1.jsonl');
  await fs.promises.writeFile(filePath, sampleTranscript(), 'utf8');
  try {
    const parser = new TranscriptParser(filePath);
    await parser.update();
    const partial = JSON.stringify({
      type: 'user',
      uuid: 'prompt-3',
      timestamp: '2025-01-01T00:00:07.000Z',
      message: { role: 'user', content: 'third request' }
    });
    await fs.promises.appendFile(filePath, partial, 'utf8');
    const future = new Date(Date.now() + 5000);
    await fs.promises.utimes(filePath, future, future);
    const update = await parser.update();
    assert.equal(update.changed, false);
    assert.equal(parser.getLastPrompt()?.uuid, 'prompt-2');

    await fs.promises.appendFile(filePath, '\n', 'utf8');
    const later = new Date(Date.now() + 10000);
    await fs.promises.utimes(filePath, later, later);
    const completed = await parser.update();
    assert.equal(completed.changed, true);
    assert.equal(parser.getLastPrompt()?.uuid, 'prompt-3');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
