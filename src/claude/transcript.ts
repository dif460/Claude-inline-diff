import * as fs from 'fs';
import * as path from 'path';

export interface SnapshotFileBackup {
  backupFileName: string | null;
  version: number;
  backupTime: string;
}

export interface TranscriptSnapshot {
  messageId: string;
  timestamp: string;
  tracked: Map<string, SnapshotFileBackup>;
}

export interface TranscriptDelta {
  timestamp: string;
  snapshotMessageId: string;
  trackingPath: string;
  backup: SnapshotFileBackup;
}

export interface TranscriptPrompt {
  uuid: string;
  timestamp: string;
}

export interface TranscriptState {
  sessionId?: string;
  cwd?: string;
  prompts: TranscriptPrompt[];
  snapshots: Map<string, TranscriptSnapshot>;
  deltas: TranscriptDelta[];
  lastEndTurnTimestamp?: string;
}

export interface TranscriptUpdate {
  changed: boolean;
  reset: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function parseBackup(value: unknown): SnapshotFileBackup | undefined {
  const obj = asRecord(value);
  if (!obj) {
    return undefined;
  }
  const version = asNumber(obj.version);
  const backupTime = asString(obj.backupTime);
  const backupFileName = obj.backupFileName === null ? null : asString(obj.backupFileName);
  if (version === undefined || backupTime === undefined || backupFileName === undefined) {
    return undefined;
  }
  return { backupFileName, version, backupTime };
}

function isUserPrompt(content: unknown): boolean {
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  let hasText = false;
  for (const item of content) {
    const block = asRecord(item);
    if (!block) {
      continue;
    }
    if (block.type === 'tool_result') {
      return false;
    }
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      hasText = true;
    }
  }
  return hasText;
}

/**
 * Incremental parser for Claude Code's session transcript (JSONL).
 *
 * It intentionally only JSON-parses lines that can affect our model; the
 * transcript also contains very large API payload lines.
 */
export class TranscriptParser {
  private readonly state: TranscriptState = {
    prompts: [],
    snapshots: new Map(),
    deltas: []
  };
  /** Byte offset just past the last newline we have consumed. */
  private parsedBytes = 0;
  private lastSize = -1;
  private lastMtimeMs = -1;

  constructor(readonly filePath: string) {}

  get fileName(): string {
    return path.basename(this.filePath);
  }

  get sessionId(): string | undefined {
    return this.state.sessionId ?? path.basename(this.filePath, '.jsonl');
  }

  getState(): Readonly<TranscriptState> {
    return this.state;
  }

  getLastPrompt(): TranscriptPrompt | undefined {
    return this.state.prompts[this.state.prompts.length - 1];
  }

  getSnapshotForPrompt(promptUuid: string): TranscriptSnapshot | undefined {
    return this.state.snapshots.get(promptUuid);
  }

  async update(): Promise<TranscriptUpdate> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(this.filePath);
    } catch {
      return { changed: false, reset: false };
    }
    if (stat.size === this.lastSize && stat.mtimeMs === this.lastMtimeMs) {
      return { changed: false, reset: false };
    }
    this.lastSize = stat.size;
    this.lastMtimeMs = stat.mtimeMs;

    let reset = false;
    if (stat.size < this.parsedBytes) {
      // The file was replaced or truncated. Start over.
      this.state.prompts.length = 0;
      this.state.snapshots.clear();
      this.state.deltas.length = 0;
      this.state.lastEndTurnTimestamp = undefined;
      this.parsedBytes = 0;
      reset = true;
    }

    const start = this.parsedBytes;
    if (stat.size <= start) {
      return { changed: reset, reset };
    }

    // Read only the appended bytes. A partially written trailing line is left
    // unconsumed (parsedBytes points at the last newline), so it is re-read
    // together with its remainder next time.
    const length = stat.size - start;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(this.filePath, 'r');
      bytesRead = (await handle.read(buffer, 0, length, start)).bytesRead;
    } catch {
      return { changed: false, reset: false };
    } finally {
      await handle?.close().catch(() => undefined);
    }

    const chunk = buffer.subarray(0, bytesRead);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return { changed: reset, reset };
    }
    const completeText = chunk.subarray(0, lastNewline + 1).toString('utf8');
    let changed = false;
    for (const line of completeText.split('\n')) {
      if (line.length === 0) {
        continue;
      }
      if (this.consumeLine(line)) {
        changed = true;
      }
    }
    this.parsedBytes = start + lastNewline + 1;
    return { changed: changed || reset, reset };
  }

  private consumeLine(line: string): boolean {
    if (line.length === 0) {
      return false;
    }
    let changed = false;
    if (line.includes('"file-history-snapshot"')) {
      changed = this.consumeSnapshot(line) || changed;
    } else if (line.includes('"file-history-delta"')) {
      changed = this.consumeDelta(line) || changed;
    } else if (line.includes('"stop_reason"')) {
      changed = this.consumeAssistant(line) || changed;
    } else if (line.includes('"type":"user"')) {
      changed = this.consumeUser(line) || changed;
    }

    if (!this.state.cwd && line.includes('"cwd"')) {
      const cwd = this.extractCwd(line);
      if (cwd) {
        this.state.cwd = cwd;
        changed = true;
      }
    }
    if (!this.state.sessionId && line.includes('"sessionId"')) {
      const sessionId = this.extractSessionId(line);
      if (sessionId) {
        this.state.sessionId = sessionId;
        changed = true;
      }
    }
    return changed;
  }

  private parseLine(line: string): Record<string, unknown> | undefined {
    try {
      return asRecord(JSON.parse(line));
    } catch {
      return undefined;
    }
  }

  private consumeSnapshot(line: string): boolean {
    const obj = this.parseLine(line);
    const snapshot = asRecord(obj?.snapshot);
    if (!obj || !snapshot) {
      return false;
    }
    const messageId = asString(obj.messageId) ?? asString(snapshot.messageId);
    const timestamp = asString(snapshot.timestamp) ?? asString(obj.timestamp);
    if (!messageId || !timestamp) {
      return false;
    }
    const tracked = new Map<string, SnapshotFileBackup>();
    const rawTracked = asRecord(snapshot.trackedFileBackups);
    if (rawTracked) {
      for (const [filePath, rawBackup] of Object.entries(rawTracked)) {
        const backup = parseBackup(rawBackup);
        if (backup) {
          tracked.set(filePath, backup);
        }
      }
    }
    this.state.snapshots.set(messageId, { messageId, timestamp, tracked });
    return true;
  }

  private consumeDelta(line: string): boolean {
    const obj = this.parseLine(line);
    if (!obj) {
      return false;
    }
    const trackingPath = asString(obj.trackingPath);
    const snapshotMessageId = asString(obj.snapshotMessageId);
    const timestamp = asString(obj.timestamp);
    const backup = parseBackup(obj.backup);
    if (!trackingPath || !snapshotMessageId || !timestamp || !backup) {
      return false;
    }
    this.state.deltas.push({ trackingPath, snapshotMessageId, timestamp, backup });
    return true;
  }

  private consumeAssistant(line: string): boolean {
    const obj = this.parseLine(line);
    const message = asRecord(obj?.message);
    if (!obj || !message) {
      return false;
    }
    const stopReason = asString(message.stop_reason);
    if (!stopReason || stopReason === 'tool_use') {
      return false;
    }
    const timestamp = asString(obj.timestamp);
    if (!timestamp) {
      return false;
    }
    if (!this.state.lastEndTurnTimestamp || timestamp > this.state.lastEndTurnTimestamp) {
      this.state.lastEndTurnTimestamp = timestamp;
      return true;
    }
    return false;
  }

  private consumeUser(line: string): boolean {
    const obj = this.parseLine(line);
    if (!obj || obj.isSidechain === true) {
      return false;
    }
    const message = asRecord(obj.message);
    if (!message || message.role !== 'user') {
      return false;
    }
    if (!isUserPrompt(message.content)) {
      return false;
    }
    const uuid = asString(obj.uuid);
    const timestamp = asString(obj.timestamp);
    if (!uuid || !timestamp) {
      return false;
    }
    if (!this.state.prompts.some((prompt) => prompt.uuid === uuid)) {
      this.state.prompts.push({ uuid, timestamp });
    }
    return true;
  }

  private extractCwd(line: string): string | undefined {
    const match = /"cwd":"((?:\\.|[^"\\])*)"/.exec(line);
    if (!match) {
      return undefined;
    }
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1];
    }
  }

  private extractSessionId(line: string): string | undefined {
    const match = /"sessionId":"([^"]+)"/.exec(line);
    return match ? match[1] : undefined;
  }
}
