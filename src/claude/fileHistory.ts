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
    let text: string | null = null;
    try {
      text = await fs.promises.readFile(backupPath, 'utf8');
    } catch {
      text = null;
    }
    this.cache.set(cacheKey, text);
    return text;
  }

  clear(): void {
    this.cache.clear();
  }
}
