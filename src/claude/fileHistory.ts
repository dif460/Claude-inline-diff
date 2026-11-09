import * as fs from 'fs';
import * as path from 'path';
import { getFileHistoryRoot } from './paths';

const BACKUP_NAME = /^[0-9a-fA-F]+@v[0-9]+$/;

export class FileHistoryReader {
  private readonly cache = new Map<string, string | null>();

  async readBackup(sessionId: string, backupFileName: string): Promise<string | null> {
    if (!BACKUP_NAME.test(backupFileName)) {
      return null;
    }
    const cacheKey = `${sessionId}\u0000${backupFileName}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) ?? null;
    }
    const backupPath = path.join(getFileHistoryRoot(), sessionId, backupFileName);
    try {
      const text = await fs.promises.readFile(backupPath, 'utf8');
      this.cache.set(cacheKey, text);
      return text;
    } catch {
      // Claude Code writes the backup around the same moment it appends the
      // transcript line, so the first read can hit a sharing violation or a
      // half-written file (Windows especially). Never cache that failure: the
      // next build retries, otherwise the file would be skipped for the whole
      // lifetime of the session binding.
      return null;
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
