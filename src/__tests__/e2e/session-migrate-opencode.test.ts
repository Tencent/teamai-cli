/**
 * E2E: `teamai session migrate` copies a Claude Code session into OpenCode through the real
 * `opencode` CLI, with every OpenCode and Claude directory in a temporary home.
 *
 * The copy shows in `opencode session list` in the target workspace with its messages in
 * order, a copy into a second workspace imports, and a repeat into the first is reused.
 *
 * Writing needs OpenCode 2 (`opencode session import`). The `opencode-ai` package the suite
 * installs is OpenCode 1 (OpenCode 2 is the separate `@opencode/cli`), so this runs against an
 * OpenCode 2 found on PATH. Without one it is skipped, saying why, except under CI, which
 * installs OpenCode 2 and fails here when it is missing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const OPENCODE = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';

/** The first directory on PATH whose `opencode` is OpenCode 2 or later. */
function opencode2Dir(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const bin = path.join(dir, OPENCODE);
    if (!dir || !fs.existsSync(bin)) continue;
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout ?? '';
    if (Number(/(\d+)\.\d+/.exec(version)?.[1] ?? 0) >= 2) return dir;
  }
  return undefined;
}

const OPENCODE_DIR = opencode2Dir();
if (!OPENCODE_DIR && process.env.CI) {
  throw new Error(
    'OpenCode 2 is not on PATH: no `opencode` there reports version 2 or later, so the session migrate E2E cannot run. CI installs it in the "Install OpenCode 2" step of .github/workflows/ci.yml; check that the step ran and added its directory to PATH.',
  );
}
const SOURCE_ID = '6f0c2a9e-3b1d-4e5f-8a7b-9c0d1e2f3a4b';

describe.skipIf(!OPENCODE_DIR)('session migrate into OpenCode (needs OpenCode 2 on PATH)', () => {
  let sandbox: string;
  let env: NodeJS.ProcessEnv;
  let sourceCwd: string;
  const workspaces: Record<string, string> = {};

  /** One Claude Code session: a prompt, a Read tool call and its result, an answer. */
  function plantClaudeSession(home: string): void {
    const base = { isSidechain: false, cwd: sourceCwd, sessionId: SOURCE_ID, version: '2.1.0', userType: 'external' };
    const records = [
      { ...base, parentUuid: null, uuid: 'u-1', type: 'user', timestamp: '2026-10-01T09:00:00.000Z',
        message: { role: 'user', content: 'Read notes.txt and tell me what it says.' } },
      { ...base, parentUuid: 'u-1', uuid: 'a-1', type: 'assistant', timestamp: '2026-10-01T09:00:02.000Z',
        message: { role: 'assistant', model: 'claude-opus-4-5', content: [
          { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'notes.txt' } }] } },
      { ...base, parentUuid: 'a-1', uuid: 'u-2', type: 'user', timestamp: '2026-10-01T09:00:03.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'hello from notes' }] } },
      { ...base, parentUuid: 'u-2', uuid: 'a-2', type: 'assistant', timestamp: '2026-10-01T09:00:05.000Z',
        message: { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text: 'It says: hello from notes.' }] } },
    ];
    const dir = path.join(home, '.claude', 'projects', sourceCwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SOURCE_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  function run(command: string, args: string[], cwd: string): { code: number | null; stdout: string; stderr: string } {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000, shell: process.platform === 'win32' });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  function migrate(targetCwd: string): { sessionId: string; reused: boolean } {
    const result = run(
      process.execPath,
      [CLI, 'session', 'migrate', SOURCE_ID, '-s', 'claude-code', '-t', 'opencode', '--cwd', sourceCwd, '--target-cwd', targetCwd, '--json'],
      sourceCwd,
    );
    const envelope = JSON.parse(result.stdout) as { data?: { sessionId: string; reused: boolean }; error?: unknown };
    expect(envelope.error, result.stderr).toBeUndefined();
    return envelope.data!;
  }

  const opencode = (args: string[], cwd: string) => run(path.join(OPENCODE_DIR!, OPENCODE), [...args, '--standalone'], cwd);

  beforeAll(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-migrate-opencode-')));
    const home = path.join(sandbox, 'home');
    for (const name of ['source', 'ws-a', 'ws-b']) {
      workspaces[name] = path.join(sandbox, name);
      fs.mkdirSync(workspaces[name], { recursive: true });
    }
    sourceCwd = workspaces.source;
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: path.join(sandbox, 'data'),
      XDG_CONFIG_HOME: path.join(sandbox, 'config'),
      XDG_STATE_HOME: path.join(sandbox, 'state'),
      XDG_CACHE_HOME: path.join(sandbox, 'cache'),
      PATH: `${OPENCODE_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      FORCE_COLOR: '0',
    };
    // The Claude adapter reads ~/.claude/projects only.
    delete env.CLAUDE_CONFIG_DIR;
    for (const key of Object.keys(env)) if (key.startsWith('OPENCODE_')) delete env[key];
    // Each OpenCode run watches every directory above its workspace; in a
    // crowded temp directory that took 10-20 s a run and most of the test.
    env.OPENCODE_DISABLE_FILEWATCHER = '1';
    // An installed OpenCode has its data directory; TeamAI looks for it before writing.
    fs.mkdirSync(path.join(sandbox, 'data', 'opencode'), { recursive: true });
    plantClaudeSession(home);
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('lists the copy in the target workspace with its messages in order; another workspace imports, a repeat is reused', () => {
    const first = migrate(workspaces['ws-a']);
    expect(first.reused).toBe(false);
    expect(first.sessionId).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);

    const listed = opencode(['session', 'list', '--format', 'json'], workspaces['ws-a']);
    expect(listed.code, listed.stderr).toBe(0);
    const sessions = JSON.parse(listed.stdout) as Array<{ id: string; directory: string }>;
    expect(sessions.map((s) => s.id)).toContain(first.sessionId);

    const exported = opencode(['session', 'export', first.sessionId], workspaces['ws-a']);
    expect(exported.code, exported.stderr).toBe(0);
    const messages = (JSON.parse(exported.stdout) as { messages: Array<Record<string, any>> }).messages.filter((m) =>
      ['user', 'assistant'].includes(m.type),
    );
    expect(messages.map((m) => m.type)).toEqual(['user', 'assistant', 'assistant']);
    expect(messages[0].text).toBe('Read notes.txt and tell me what it says.');
    expect(messages[1].content[0]).toMatchObject({
      type: 'tool',
      name: 'read',
      state: { status: 'completed', input: { file_path: 'notes.txt' }, content: [{ type: 'text', text: 'hello from notes' }] },
    });
    expect(messages[2].content).toEqual([{ type: 'text', text: 'It says: hello from notes.' }]);
    const ids = messages.map((m) => m.id as string);
    expect([...ids].sort()).toEqual(ids);

    const second = migrate(workspaces['ws-b']);
    expect(second.reused).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);
    const listedB = JSON.parse(opencode(['session', 'list', '--format', 'json'], workspaces['ws-b']).stdout) as Array<{ id: string }>;
    expect(listedB.map((s) => s.id)).toContain(second.sessionId);

    const repeat = migrate(workspaces['ws-a']);
    expect(repeat).toMatchObject({ sessionId: first.sessionId, reused: true });
  }, 300_000);
});
