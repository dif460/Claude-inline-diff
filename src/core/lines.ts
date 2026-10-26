import * as path from 'path';

export type Eol = '\n' | '\r\n';

export interface SplitText {
  lines: string[];
  eol: Eol;
  finalNewline: boolean;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function detectEol(text: string): Eol {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Split text into logical lines. A single trailing newline does not produce an
 * extra empty line, but an intentional blank line in the middle does.
 */
export function splitText(raw: string): SplitText {
  const text = stripBom(raw);
  if (text.length === 0) {
    return { lines: [], eol: '\n', finalNewline: false };
  }
  const finalNewline = text.endsWith('\n') || text.endsWith('\r');
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n');
  if (finalNewline && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return {
    lines: parts,
    eol: detectEol(text),
    finalNewline
  };
}

export function joinLines(lines: string[], eol: Eol, finalNewline: boolean): string {
  if (lines.length === 0) {
    return '';
  }
  const body = lines.join(eol);
  return finalNewline ? body + eol : body;
}

/**
 * Key used for map lookups. Transcript paths and VS Code paths can disagree on
 * drive-letter casing and slash direction on Windows.
 */
export function pathKey(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function slashPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function isBinaryText(text: string): boolean {
  const probe = text.slice(0, 8000);
  return probe.includes('\u0000');
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + '\n…';
}

export function countLines(text: string): number {
  return splitText(text).lines.length;
}
