import * as os from 'os';
import * as path from 'path';
import { pathKey } from '../core/lines';

export function getClaudeHome(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), '.claude');
}

export function getProjectsRoot(): string {
  return path.join(getClaudeHome(), 'projects');
}

export function getFileHistoryRoot(): string {
  return path.join(getClaudeHome(), 'file-history');
}

/**
 * Claude Code stores sessions under ~/.claude/projects/<project-key>.
 * The key replaces every non-alphanumeric character with "-" (see the
 * extension's own path formatting).
 */
export function projectKeyForPath(fsPath: string): string {
  return projectKeyForPathUnsafe(fsPath).slice(0, 200);
}

function projectKeyForPathUnsafe(fsPath: string): string {
  const key = fsPath.replace(/[^a-zA-Z0-9]/g, '-');
  // Claude Code writes sessions using the cwd it was launched with, which on
  // Windows has a lower-case drive letter even if VS Code reports "E:\\...".
  if (process.platform === 'win32' && /^[A-Za-z]--/.test(key)) {
    return key[0].toLowerCase() + key.slice(1);
  }
  return key;
}

export function pathsEqual(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when child is inside parent (or equal). */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isRelatedToWorkspace(cwd: string, workspaceRoots: string[]): boolean {
  return workspaceRoots.some((root) => isPathInside(root, cwd) || isPathInside(cwd, root));
}
