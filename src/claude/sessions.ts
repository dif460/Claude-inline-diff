import * as fs from 'fs';
import * as path from 'path';
import { getProjectsRoot, isRelatedToWorkspace, projectKeyForPath } from './paths';

export interface SessionCandidate {
  sessionId: string;
  filePath: string;
  projectDir: string;
  cwd?: string;
  mtimeMs: number;
  size: number;
}

const SESSION_FILE = /^[0-9a-fA-F-]{36}\.jsonl$/;
const projectCwdCache = new Map<string, string>();

async function readProjectCwd(projectDir: string): Promise<string | undefined> {
  const cached = projectCwdCache.get(projectDir);
  if (cached) {
    return cached;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort();
  for (const name of candidates) {
    const filePath = path.join(projectDir, name);
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const buffer = Buffer.alloc(256 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead).toString('utf8');
      for (const line of head.split('\n')) {
        if (!line.includes('"cwd"')) {
          continue;
        }
        const match = /"cwd":"((?:\\.|[^"\\])*)"/.exec(line);
        if (!match) {
          continue;
        }
        try {
          const cwd = JSON.parse(`"${match[1]}"`) as string;
          if (cwd) {
            projectCwdCache.set(projectDir, cwd);
            return cwd;
          }
        } catch {
          // Keep looking in the next line.
        }
      }
    } catch {
      // Ignore this transcript and try the next one.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return undefined;
}

export async function discoverSessions(_workspaceRoots: string[], maxAgeHours: number): Promise<SessionCandidate[]> {
  const workspaceRoots = _workspaceRoots.filter((root) => root.length > 0);
  if (workspaceRoots.length === 0) {
    return [];
  }
  const projectsRoot = getProjectsRoot();
  let dirs: fs.Dirent[];
  try {
    dirs = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const now = Date.now();
  const minMtime = now - maxAgeHours * 3600_000;
  const sessions: SessionCandidate[] = [];

  for (const dir of dirs) {
    if (!dir.isDirectory()) {
      continue;
    }
    const projectDir = path.join(projectsRoot, dir.name);
    let cwd: string | undefined;
    let related = false;
    for (const root of workspaceRoots) {
      if (projectKeyForPath(root) === dir.name) {
        related = true;
        cwd = root;
        break;
      }
    }
    if (!related) {
      cwd = await readProjectCwd(projectDir);
      related = cwd !== undefined && isRelatedToWorkspace(cwd, workspaceRoots);
    }
    if (!related) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !SESSION_FILE.test(entry.name)) {
        continue;
      }
      const filePath = path.join(projectDir, entry.name);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs < minMtime) {
        continue;
      }
      sessions.push({
        sessionId: entry.name.slice(0, -'.jsonl'.length),
        filePath,
        projectDir,
        cwd,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      });
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

export function forgetProjectCwdCache(): void {
  projectCwdCache.clear();
}
