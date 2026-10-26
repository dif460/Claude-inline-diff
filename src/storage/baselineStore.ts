import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { pathKey } from '../core/lines';
import { LocalBaseline } from '../core/changeBuilder';

interface StoredEntry {
  sessionId: string;
  path: string;
  file: string;
  updatedAt: number;
}

interface StoreIndex {
  version: 1;
  entries: Record<string, StoredEntry>;
}

const INDEX_VERSION = 1;
const MAX_AGE_MS = 30 * 24 * 3600_000;

function keyFor(sessionId: string, fsPath: string): string {
  return crypto.createHash('sha1').update(`${sessionId}\u0000${pathKey(fsPath)}`).digest('hex');
}

/**
 * Local "already reviewed" baselines. Accepting a hunk stores the mutated
 * baseline here; source files themselves are never modified by this extension.
 */
export class BaselineStore {
  private readonly root: string;
  private readonly indexPath: string;
  private index: StoreIndex = { version: INDEX_VERSION, entries: {} };
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly textCache = new Map<string, string | null>();

  constructor(context: vscode.ExtensionContext) {
    this.root = path.join(context.globalStorageUri.fsPath, 'baselines');
    this.indexPath = path.join(this.root, 'index.json');
  }

  async initialize(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    await fs.promises.mkdir(this.root, { recursive: true });
    try {
      const raw = await fs.promises.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreIndex>;
      if (parsed && parsed.version === INDEX_VERSION && parsed.entries) {
        this.index = { version: INDEX_VERSION, entries: parsed.entries };
      }
    } catch {
      this.index = { version: INDEX_VERSION, entries: {} };
    }
    await this.prune();
  }

  async get(sessionId: string, fsPath: string): Promise<string | undefined> {
    await this.initialize();
    const key = keyFor(sessionId, fsPath);
    const entry = this.index.entries[key];
    if (!entry) {
      return undefined;
    }
    if (this.textCache.has(key)) {
      const cached = this.textCache.get(key);
      return cached ?? undefined;
    }
    try {
      const text = await fs.promises.readFile(path.join(this.root, entry.file), 'utf8');
      this.textCache.set(key, text);
      return text;
    } catch {
      delete this.index.entries[key];
      this.textCache.set(key, null);
      this.scheduleIndexWrite();
      return undefined;
    }
  }

  async entriesForSession(sessionId: string): Promise<LocalBaseline[]> {
    await this.initialize();
    const result: LocalBaseline[] = [];
    for (const [key, entry] of Object.entries(this.index.entries)) {
      if (entry.sessionId !== sessionId) {
        continue;
      }
      let text: string | undefined;
      if (this.textCache.has(key)) {
        text = this.textCache.get(key) ?? undefined;
      } else {
        try {
          text = await fs.promises.readFile(path.join(this.root, entry.file), 'utf8');
          this.textCache.set(key, text);
        } catch {
          this.textCache.set(key, null);
          delete this.index.entries[key];
          this.scheduleIndexWrite();
          continue;
        }
      }
      if (text !== undefined) {
        result.push({ path: entry.path, text });
      }
    }
    return result;
  }

  async set(sessionId: string, fsPath: string, text: string): Promise<void> {
    await this.initialize();
    const key = keyFor(sessionId, fsPath);
    const fileName = `${key}.txt`;
    await fs.promises.mkdir(this.root, { recursive: true });
    await fs.promises.writeFile(path.join(this.root, fileName), text, 'utf8');
    this.index.entries[key] = {
      sessionId,
      path: fsPath,
      file: fileName,
      updatedAt: Date.now()
    };
    this.textCache.set(key, text);
    await this.writeIndex();
  }

  async delete(sessionId: string, fsPath: string): Promise<void> {
    await this.initialize();
    const key = keyFor(sessionId, fsPath);
    const entry = this.index.entries[key];
    if (!entry) {
      return;
    }
    delete this.index.entries[key];
    this.textCache.delete(key);
    await fs.promises.unlink(path.join(this.root, entry.file)).catch(() => undefined);
    await this.writeIndex();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.initialize();
    const keys = Object.entries(this.index.entries)
      .filter(([, entry]) => entry.sessionId === sessionId)
      .map(([key]) => key);
    for (const key of keys) {
      const entry = this.index.entries[key];
      delete this.index.entries[key];
      this.textCache.delete(key);
      await fs.promises.unlink(path.join(this.root, entry.file)).catch(() => undefined);
    }
    await this.writeIndex();
  }

  private async prune(): Promise<void> {
    const cutoff = Date.now() - MAX_AGE_MS;
    let changed = false;
    for (const [key, entry] of Object.entries(this.index.entries)) {
      if (entry.updatedAt >= cutoff) {
        continue;
      }
      delete this.index.entries[key];
      this.textCache.delete(key);
      await fs.promises.unlink(path.join(this.root, entry.file)).catch(() => undefined);
      changed = true;
    }
    if (changed) {
      await this.writeIndex();
    }
  }

  private scheduleIndexWrite(): void {
    void this.writeIndex();
  }

  private writeIndex(): Promise<void> {
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const temporary = `${this.indexPath}.tmp`;
        await fs.promises.writeFile(temporary, JSON.stringify(this.index, null, 2), 'utf8');
        await fs.promises.rename(temporary, this.indexPath).catch(async () => {
          await fs.promises.writeFile(this.indexPath, JSON.stringify(this.index, null, 2), 'utf8');
          await fs.promises.unlink(temporary).catch(() => undefined);
        });
      });
    return this.writeChain;
  }
}
