import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { argvVerdict, ATTEMPT_ENV, childPayload, FOREGROUND_PAYLOAD_KEYS, HTTP_ENDPOINT_ENVS, isHttpEnrolled, LAUNCHED_BY_ENV, runHookFastPath } from '../hook-fast-path.js';
import { loadLocalAgentConfig } from '../local-agent.js';
import * as launchContext from '../launch-context.js';

const READ = ['hook-dispatch', 'post-tool-use', '--tool', 'claude'];
const PAYLOAD = { kind: 'payload', hook: { event: 'post-tool-use', tool: 'claude', matcher: '*' } };

describe('argvVerdict', () => {
  it('reads the payload of the PostToolUse command teamai installs', () => {
    expect(argvVerdict(READ, {}, 'darwin')).toEqual(PAYLOAD);
    expect(argvVerdict([...READ, '--matcher', 'Bash'], {}, 'linux')).toEqual({ kind: 'payload', hook: { event: 'post-tool-use', tool: 'claude', matcher: 'Bash' } });
  });

  it('always runs the full dispatch on Windows, whose child needs the WMI escape in the bundle', () => {
    expect(argvVerdict(READ, {}, 'win32')).toEqual({ kind: 'full' });
  });

  it.each([
    ['team hooks, which can block with exit 2', [...READ, '--team-hooks']],
    ['the background child itself', [...READ, '--bg-only']],
    ['a payload handed over as a file', [...READ, '--stdin-file', '/tmp/payload.json']],
    ['a Copilot user built-in', [...READ, '--copilot-global', 'user']],
    ['another event', ['hook-dispatch', 'stop', '--tool', 'claude']],
    ['a matcher flag without its value', [...READ, '--matcher']],
    ['a command without --tool', ['hook-dispatch', 'post-tool-use']],
    ['a flag spelled otherwise', ['hook-dispatch', 'post-tool-use', '--tools', 'claude']],
    ['another command', ['pull', 'post-tool-use', '--tool', 'claude']],
    ['a flag after the matcher', [...READ, '--matcher', 'Bash', '--bg-only']],
  ])('runs the full dispatch for %s', (_case, argv) => {
    expect(argvVerdict(argv, {}, 'darwin')).toEqual({ kind: 'full' });
  });

  it('runs the full dispatch for the TodoWrite entry, whose hint replies in the foreground', () => {
    expect(argvVerdict([...READ, '--matcher', 'TodoWrite'], {}, 'darwin')).toEqual({ kind: 'full' });
  });

  it.each(['copilot', 'agy', 'git'])('runs the full dispatch for %s', (tool) => {
    expect(argvVerdict(['hook-dispatch', 'post-tool-use', '--tool', tool], {}, 'darwin')).toEqual({ kind: 'full' });
  });

  it.each(['CURSOR_VERSION', 'COPILOT_PROJECT_DIR'])('runs the full dispatch for a Claude-format hook with %s set, which may be another host\'s', (variable) => {
    expect(argvVerdict(READ, { [variable]: '1.2.3' }, 'darwin')).toEqual({ kind: 'full' });
    expect(argvVerdict(READ, { [variable]: ' ' }, 'darwin')).toEqual(PAYLOAD);
  });

  it('keeps Cursor\'s own hooks on the fast path', () => {
    expect(argvVerdict(['hook-dispatch', 'post-tool-use', '--tool', 'cursor'], { CURSOR_VERSION: '1.2.3' }, 'darwin'))
      .toEqual({ kind: 'payload', hook: { event: 'post-tool-use', tool: 'cursor', matcher: '*' } });
  });

  it('runs the full dispatch in a workflow step, which uses its clone\'s install home', () => {
    expect(argvVerdict(READ, { [ATTEMPT_ENV]: 'run-1/attempt-1' }, 'darwin')).toEqual({ kind: 'full' });
  });

  it('skips the hook of a session teamai launched for itself, and keeps a workflow step\'s', () => {
    expect(argvVerdict(READ, { [LAUNCHED_BY_ENV]: 'answer' }, 'darwin')).toEqual({ kind: 'skip' });
    expect(argvVerdict(READ, { [LAUNCHED_BY_ENV]: 'workflow' }, 'darwin')).toEqual(PAYLOAD);
  });
});

describe('runHookFastPath', () => {
  // The full dispatch reads the pipe itself, so a Windows hook must leave it unread.
  it('leaves a Windows hook to the full dispatch without opening its stdin', async () => {
    const stdin = () => { throw new Error('stdin opened'); };

    expect(await runHookFastPath(READ, { env: {}, platform: 'win32', stdin, entry: 'unused' })).toBe('full');
  });
});

describe('childPayload', () => {
  it.each(['session_id', 'sessionId', 'conversation_id'])('hands on a payload with a %s as the host sent it', (field) => {
    const raw = JSON.stringify({ [field]: 's-1', tool_name: 'Read' });
    expect(childPayload(raw)).toBe(raw);
  });

  it.each([
    ['no session id', JSON.stringify({ tool_name: 'Read' })],
    ['an empty session id', JSON.stringify({ session_id: '', tool_name: 'Read' })],
    ['a JSON array', '["s-1"]'],
    ['JSON null', 'null'],
    ['a JSON number', '5'],
    ['text that is not JSON', '{"session_id":"s-1"'],
    // The TodoWrite hint answers in the foreground of the wildcard pass (#1788).
    ['a TodoWrite call', JSON.stringify({ session_id: 's-1', tool_name: 'TodoWrite' })],
  ])('leaves a payload with %s to the full dispatch', (_case, raw) => {
    expect(childPayload(raw)).toBeNull();
  });

  it('drops the keys only the foreground dispatcher may set', () => {
    const raw = JSON.stringify({ session_id: 's-1', teamai_run: { runMode: 'unattended' }, teamai_launch: { TEAMAI_LAUNCHED_BY: 'workflow' } });
    expect(JSON.parse(childPayload(raw) ?? 'null')).toEqual({ session_id: 's-1' });
  });
});

describe('isHttpEnrolled', () => {
  let home: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-enrolled-')));
    fs.mkdirSync(path.join(home, '.teamai', 'local-agent'), { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    for (const name of HTTP_ENDPOINT_ENVS) vi.stubEnv(name, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const write = (relative: string, content: string) => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const enrolledByConfigJson = () => write('.teamai/local-agent/config.json', JSON.stringify({ endpoint: 'https://teamai.example', createdAt: '2026-01-01T00:00:00.000Z', workspaceBindings: {} }));
  const httpMemberConfig = (file: string) => write(file, `repo:\n  localPath: ${path.join(home, 'team-repo')}\n  remote: https://teamai.example\n  kind: http\n  url: https://teamai.example\nusername: alice\n`);
  const env = () => process.env;

  // Each fixture is a way a machine enrolls; the check must see every one the local agent itself would sync with.
  const enrolments: Array<[string, () => void]> = [
    ['local-agent/config.json', enrolledByConfigJson],
    ['a v0.17 member config with an HTTP repo', () => httpMemberConfig('.teamai/config.yaml')],
    ...HTTP_ENDPOINT_ENVS.map((name): [string, () => void] => [name, () => vi.stubEnv(name, 'https://teamai.example')]),
  ];

  it.each(enrolments)('counts an enrolment through %s, as the local agent does', async (_case, enroll) => {
    enroll();

    expect(isHttpEnrolled(env())).toBe(true);
    expect(await loadLocalAgentConfig({ dryRun: true })).not.toBeNull();
  });

  it('counts no enrolment on a machine with none, as the local agent does', async () => {
    write('.teamai/config.yaml', `repo:\n  localPath: ${path.join(home, 'team-repo')}\n  remote: https://gitlab.example/acme/team.git\nusername: alice\n`);

    expect(isHttpEnrolled(env())).toBe(false);
    expect(await loadLocalAgentConfig({ dryRun: true })).toBeNull();
  });

  // `teamai` removed the source: nothing reconnects it, not even an endpoint variable.
  it('counts no enrolment once the source was removed, as the local agent does', async () => {
    write('.teamai/local-agent/config.json', JSON.stringify({ disabled: true }));
    vi.stubEnv('TEAMAI_HTTP_ENDPOINT', 'https://teamai.example');

    expect(isHttpEnrolled(env())).toBe(false);
    expect(await loadLocalAgentConfig({ dryRun: true })).toBeNull();
  });

  it('counts a config.json it cannot read as an enrolment, which costs a full dispatch at most', () => {
    write('.teamai/local-agent/config.json', '{"endpoint":');

    expect(isHttpEnrolled(env())).toBe(true);
  });
});

// The fast path loads before the bundle, so it keeps copies of what launch-context.ts owns.
describe('the fast path\'s copies', () => {
  it('names the launch variables and payload keys launch-context.ts uses', () => {
    expect(LAUNCHED_BY_ENV).toBe(launchContext.LAUNCHED_BY_ENV);
    expect(ATTEMPT_ENV).toBe(launchContext.ATTEMPT_ENV);
    expect([...FOREGROUND_PAYLOAD_KEYS].sort()).toEqual([launchContext.SESSION_RUN_PAYLOAD_KEY, launchContext.LAUNCH_PAYLOAD_KEY].sort());
  });
});
