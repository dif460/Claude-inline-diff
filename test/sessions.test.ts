import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverSessions, forgetProjectCwdCache } from '../src/claude/sessions';
import { projectKeyForPath } from '../src/claude/paths';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';

function transcript(cwd: string): string {
  return (
    JSON.stringify({
      type: 'user',
      uuid: 'prompt-1',
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      cwd,
      message: { role: 'user', content: 'hello' }
    }) + '\n'
  );
}

test('discovers sessions for the current workspace and ignores unrelated projects', async () => {
  const claudeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-inline-home-'));
  const workspace = path.join(os.tmpdir(), 'claude-inline-sessions-workspace');
  const otherWorkspace = path.join(os.tmpdir(), 'claude-inline-other-workspace');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    const relatedDir = path.join(claudeHome, 'projects', projectKeyForPath(workspace));
    const unrelatedDir = path.join(claudeHome, 'projects', projectKeyForPath(otherWorkspace));
    await fs.promises.mkdir(relatedDir, { recursive: true });
    await fs.promises.mkdir(unrelatedDir, { recursive: true });
    await fs.promises.writeFile(path.join(relatedDir, `${SESSION_ID}.jsonl`), transcript(workspace), 'utf8');
    await fs.promises.writeFile(
      path.join(unrelatedDir, '22222222-2222-2222-2222-222222222222.jsonl'),
      transcript(otherWorkspace),
      'utf8'
    );

    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    forgetProjectCwdCache();
    const sessions = await discoverSessions([workspace], 24);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, SESSION_ID);
    assert.equal(sessions[0].cwd, workspace);
    assert.ok(sessions[0].mtimeMs > 0);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
    forgetProjectCwdCache();
    await fs.promises.rm(claudeHome, { recursive: true, force: true });
  }
});

test('finds a nested Claude cwd that belongs to the workspace', async () => {
  const claudeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-inline-home-'));
  const workspace = path.join(os.tmpdir(), 'claude-inline-nested-workspace');
  const nested = path.join(workspace, 'packages', 'app');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    const unrelatedKey = 'some-other-project';
    const projectDir = path.join(claudeHome, 'projects', unrelatedKey);
    await fs.promises.mkdir(projectDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(projectDir, '33333333-3333-3333-3333-333333333333.jsonl'),
      transcript(nested),
      'utf8'
    );
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    forgetProjectCwdCache();
    const sessions = await discoverSessions([workspace], 24);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].cwd, nested);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
    forgetProjectCwdCache();
    await fs.promises.rm(claudeHome, { recursive: true, force: true });
  }
});
