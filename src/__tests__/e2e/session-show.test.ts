/**
 * Real CLI: `teamai session show` prints a session of this machine that is not the caller's own, redacted as a judge
 * reads it, from a JSONL store (Claude Code) and from a SQLite one (Hermes), and fails with a code for one it cannot find.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCwdClaude } from '../../session-flow/fs.js';
import { findSqlite3 } from '../../session-flow/sqlite.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const CLAUDE_SESSION = '7c1e0000-0000-4000-8000-00000000a001';
const HERMES_SESSION = '20261104_091523_a1b2c3d4';
const SECRET = 'sk-ant-api03-Zq8vN2pL7xR4tY9wK3mB6cF1hJ5dS0gA';

let root = '';
let app = '';
let env: NodeJS.ProcessEnv = {};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env, stdio: 'pipe' });
}

function teamai(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, env, encoding: 'utf8', timeout: 120_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-show-')));
  const home = path.join(root, 'home');
  app = path.join(root, 'app');
  fs.mkdirSync(home);
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = tester\n\temail = tester@example.com\n');
  env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), FORCE_COLOR: '0' };
  for (const name of ['CLAUDE_CONFIG_DIR', 'HERMES_HOME', 'HERMES_DATA_DIR_SUFFIX', 'CLAUDE_CODE_SESSION_ID', 'TEAMAI_WORKFLOW_ATTEMPT', 'TEAMAI_LAUNCHED_BY']) delete env[name];
  git(app, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(app, 'README.md'), 'fixture\n');
  git(app, 'add', '.');
  git(app, 'commit', '-qm', 'fixture');
  git(app, 'remote', 'add', 'origin', 'http://127.0.0.1:9/acme/app.git');
  const initialized = teamai('init', '--self', '--agent', 'claude', '--force');
  expect(initialized.code, initialized.stderr).toBe(0);

  const project = path.join(home, '.claude', 'projects', encodeCwdClaude(app));
  fs.mkdirSync(project, { recursive: true });
  const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
  fs.writeFileSync(path.join(project, `${CLAUDE_SESSION}.jsonl`),
    line({ type: 'user', uuid: 'u1', parentUuid: null, cwd: app, sessionId: CLAUDE_SESSION, timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: `Deploy with the key ${SECRET} and add retries.` } })
    + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd: app, sessionId: CLAUDE_SESSION, timestamp: '2026-11-01T10:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added retries to the deploy client.' }] } }));
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('teamai session show', () => {
  it('prints a Claude Code session with a secret it holds redacted', () => {
    const shown = teamai('session', 'show', CLAUDE_SESSION, '--source', 'claude-code');

    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('Deploy with the key <REDACTED:anthropic> and add retries.');
    expect(shown.stdout).toContain('Added retries to the deploy client.');
    expect(shown.stdout).not.toContain(SECRET);
  });

  it.skipIf(findSqlite3() === null)('prints a Hermes session from its SQLite store', () => {
    const db = path.join(String(env.HOME), '.hermes', 'state.db');
    fs.rmSync(path.dirname(db), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(db), { recursive: true });
    execFileSync(String(findSqlite3()), [db, [
      'CREATE TABLE sessions (id TEXT, source TEXT, created_source TEXT, model TEXT, cwd TEXT, title TEXT, started_at REAL, ended_at REAL, last_activity_at REAL, message_count INTEGER);',
      'CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL, finish_reason TEXT, reasoning TEXT, reasoning_content TEXT, active INTEGER, compacted INTEGER);',
      `INSERT INTO sessions VALUES ('${HERMES_SESSION}', 'cli', NULL, 'anthropic/claude-sonnet', '${app}', 'Fix the parser', 1793761200, 1793761260, 1793761260, 2);`,
      `INSERT INTO messages VALUES (1, '${HERMES_SESSION}', 'user', 'Fix the parser so it keeps comments', NULL, NULL, NULL, 1793761201, NULL, NULL, NULL, 1, 0);`,
      `INSERT INTO messages VALUES (2, '${HERMES_SESSION}', 'assistant', 'The parser now keeps comments.', NULL, NULL, NULL, 1793761202, 'stop', NULL, NULL, 1, 0);`,
    ].join(' ')]);

    const shown = teamai('session', 'show', HERMES_SESSION, '--source', 'hermes');

    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('Fix the parser so it keeps comments');
    expect(shown.stdout).toContain('The parser now keeps comments.');
  });

  it('fails with session_not_found for a session it cannot find, and with no_adapter for a source it does not know', () => {
    const missing = teamai('session', 'show', '7c1e0000-0000-4000-8000-00000000dead', '--source', 'claude-code', '--json');

    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toEqual({ error: { code: 'session_not_found', message: 'No claude-code session 7c1e0000-0000-4000-8000-00000000dead on this machine has anything to show. Run teamai session list --finished --all for the sessions it can show.' } });
    expect(missing.stderr).toContain('Error: No claude-code session 7c1e0000-0000-4000-8000-00000000dead on this machine has anything to show.');

    const unknown = teamai('session', 'show', CLAUDE_SESSION, '--source', 'nope', '--json');

    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ error: { code: 'no_adapter' } });
  });
});
