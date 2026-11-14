import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { argvVerdict, ATTEMPT_ENV, childPayload, FOREGROUND_PAYLOAD_KEYS, HTTP_ENDPOINT_ENVS, isHttpEnrolled, LAUNCHED_BY_ENV, promptAnswersInForeground, recordLoginEnrolment, runHookFastPath } from '../hook-fast-path.js';
import { takePendingHint, writeContributeState } from '../contribute-check.js';
import { takePendingPackageHint } from '../pkg/pkg-hint.js';
import { takePendingMrHint } from '../mr-hint.js';
import { loadLocalAgentConfig } from '../local-agent.js';
import * as launchContext from '../launch-context.js';
import { deriveSessionId } from '../utils/session-id.js';
import { GIT_HOOK_TOOL } from '../git-hook.js';
import { TOOL_IDS, TOOLS } from '../tools.js';
import { INSTANCE_BASES } from '../tool-registry.js';

const READ = ['hook-dispatch', 'post-tool-use', '--tool', 'claude'];
const PAYLOAD = { kind: 'payload', hook: { event: 'post-tool-use', tool: 'claude', matcher: '*' } };
const PROMPT = ['hook-dispatch', 'prompt-submit', '--tool', 'claude'];

describe('argvVerdict', () => {
  it('reads the payload of the PostToolUse command teamai installs', () => {
    expect(argvVerdict(READ, {}, 'darwin')).toEqual(PAYLOAD);
    expect(argvVerdict([...READ, '--matcher', 'Bash'], {}, 'linux')).toEqual({ kind: 'payload', hook: { event: 'post-tool-use', tool: 'claude', matcher: 'Bash' } });
  });

  it('reads the payload of the UserPromptSubmit command teamai installs (#1788)', () => {
    expect(argvVerdict(PROMPT, {}, 'darwin')).toEqual({ kind: 'payload', hook: { event: 'prompt-submit', tool: 'claude', matcher: '*' } });
  });

  it.each([
    ['a matcher, which no prompt entry has', [...PROMPT, '--matcher', 'Bash']],
    ['team hooks', [...PROMPT, '--team-hooks']],
    ['Windows', PROMPT, 'win32'],
  ])('runs the full dispatch for a prompt with %s', (_case, argv, platform = 'darwin') => {
    expect(argvVerdict(argv, {}, platform as NodeJS.Platform)).toEqual({ kind: 'full' });
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
    ['a session start', ['hook-dispatch', 'session-start', '--tool', 'claude']],
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

  // The fast path cannot load the tool table, so its list of these tools is a copy of `hooks.needsBundle`.
  it.each(TOOL_IDS)('takes the full dispatch for %s exactly when TOOLS says its hooks need the bundle', (tool) => {
    for (const event of ['post-tool-use', 'prompt-submit']) {
      expect(argvVerdict(['hook-dispatch', event, '--tool', tool], {}, 'darwin').kind).toBe(TOOLS[tool].hooks.needsBundle ? 'full' : 'payload');
    }
  });

  // The fast path runs before any team config is read, so an instance's name is one it does not know.
  it.each(INSTANCE_BASES)('reads the payload of an instance of %s, a name it does not know, as it reads that tool\'s', (base) => {
    for (const event of ['post-tool-use', 'prompt-submit'] as const) {
      expect(argvVerdict(['hook-dispatch', event, '--tool', base], {}, 'darwin').kind).toBe('payload');
      expect(argvVerdict(['hook-dispatch', event, '--tool', `acme-${base}`], {}, 'darwin')).toEqual({ kind: 'payload', hook: { event, tool: `acme-${base}`, matcher: '*' } });
    }
  });

  it('reads the payload of a Claude instance with CURSOR_VERSION set, leaving Cursor\'s copy to the background pass, which skips it as the full dispatch skips Claude\'s', () => {
    expect(argvVerdict(['hook-dispatch', 'post-tool-use', '--tool', 'acme-claude'], { CURSOR_VERSION: '1.2.3' }, 'darwin').kind).toBe('payload');
  });

  it('runs the full dispatch for git, whose hook runs its handlers inline', () => {
    expect(argvVerdict(['hook-dispatch', 'post-tool-use', '--tool', GIT_HOOK_TOOL], {}, 'darwin')).toEqual({ kind: 'full' });
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['session_id', 'sessionId', 'conversation_id'])('hands on a payload with a %s as the host sent it', (field) => {
    const raw = JSON.stringify({ [field]: 's-1', tool_name: 'Read' });
    expect(childPayload(raw)).toEqual({ payload: raw, sessionId: 's-1' });
  });

  // The hint files the prompt fast path looks for are named by this id, so it must be the one the bundle derives.
  it.each([
    { session_id: 's-1', sessionId: 's-2', conversation_id: 's-3' },
    { sessionId: 's-2', conversation_id: 's-3' },
    { session_id: '', sessionId: 's-2', conversation_id: 's-3' },
    { sessionId: '', conversation_id: 's-3' },
    { conversation_id: 's-3' },
  ])('names the session %j as deriveSessionId does', (payload) => {
    vi.stubEnv('CLAUDE_SESSION_ID', undefined);

    expect(childPayload(JSON.stringify(payload))?.sessionId).toBe(deriveSessionId(payload));
  });

  it('skips an id field that holds no string', () => {
    expect(childPayload(JSON.stringify({ session_id: 7, conversation_id: 's-3' }))?.sessionId).toBe('s-3');
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
    expect(JSON.parse(childPayload(raw)?.payload ?? 'null')).toEqual({ session_id: 's-1' });
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

// A prompt's foreground prints what earlier work left for this session (#1788).
describe('promptAnswersInForeground', () => {
  let home: string;
  // Characters outside [a-zA-Z0-9._-] are replaced in the file names, as both hints write them.
  const SESSION = 'pid-1-/work/My Project';

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-prompt-fg-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    for (const name of HTTP_ENDPOINT_ENVS) vi.stubEnv(name, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('leaves a prompt with nothing waiting to the background', () => {
    expect(promptAnswersInForeground(SESSION, process.env)).toBe(false);
  });

  it('keeps a prompt in the foreground while a package hint waits for it', async () => {
    const file = path.join(home, '.teamai', 'package-hints', `${SESSION.replace(/[^a-zA-Z0-9._-]/g, '_')}.pending.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ message: 'Run npm install: package.json changed' }));

    expect(promptAnswersInForeground(SESSION, process.env)).toBe(true);
    // The hint the foreground handler takes is that same file.
    expect(await takePendingPackageHint(SESSION)).toBe('Run npm install: package.json changed');
    expect(promptAnswersInForeground(SESSION, process.env)).toBe(false);
  });

  it('keeps a prompt in the foreground while an MR hint the session start found waits for it', async () => {
    const file = path.join(home, '.teamai', 'sessions', `${SESSION.replace(/[^a-zA-Z0-9._-]/g, '_')}.mr-hint.pending.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ message: 'Found 1 recently merged MR(s)', shown: { owner: 'acme', repo: 'shop', ids: ['7'] } }));

    expect(promptAnswersInForeground(SESSION, process.env)).toBe(true);
    expect(JSON.parse(await takePendingMrHint(SESSION) ?? '').hookSpecificOutput.additionalContext).toBe('Found 1 recently merged MR(s)');
    expect(promptAnswersInForeground(SESSION, process.env)).toBe(false);
  });

  it('keeps a prompt in the foreground while a contribute hint waits for it', async () => {
    await writeContributeState(SESSION, { contributed: false, pendingHint: 'Share what you learned: teamai contribute' });

    expect(promptAnswersInForeground(SESSION, process.env)).toBe(true);
    expect(await takePendingHint(SESSION)).toBe('Share what you learned: teamai contribute');
    expect(promptAnswersInForeground(SESSION, process.env)).toBe(false);
  });

  it('keeps a prompt in the foreground on a machine that syncs over HTTP, whose local agent may print a notice', () => {
    vi.stubEnv('TEAMAI_HTTP_ENDPOINT', 'https://teamai.example');

    expect(promptAnswersInForeground(SESSION, process.env)).toBe(true);
  });
});

// A pass inside the login environment leaves, per session, what it saw of an HTTP enrolment from its cwd, for a prompt
// whose command deferred the login shell and so cannot see the profile's or the team env's variables (runLoginDeferredHook).
describe('recordLoginEnrolment', () => {
  let home: string;
  const record = () => path.join(home, '.teamai', 'sessions', 's-1.http-enrolment.json');
  const payload = (fields: object = {}) => JSON.stringify({ session_id: 's-1', cwd: '/work/a', ...fields });

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-login-enrolment-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each([
    { env: {}, enrolled: false },
    { env: { TEAMAI_HTTP_ENDPOINT: 'http://127.0.0.1:9' }, enrolled: true },
  ])('records the session\'s cwd and enrolled: $enrolled', ({ env, enrolled }) => {
    recordLoginEnrolment(payload(), env);

    expect(JSON.parse(fs.readFileSync(record(), 'utf8'))).toEqual({ cwd: '/work/a', enrolled });
  });

  it('writes nothing when the record already says the same, and rewrites it for another cwd', () => {
    recordLoginEnrolment(payload(), {});
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(record(), past, past);

    recordLoginEnrolment(payload(), {});
    expect(fs.statSync(record()).mtime).toEqual(past);
    recordLoginEnrolment(payload({ cwd: '/work/b' }), {});
    expect(JSON.parse(fs.readFileSync(record(), 'utf8'))).toEqual({ cwd: '/work/b', enrolled: false });
  });

  it.each([
    ['no session id', JSON.stringify({ cwd: '/work/a' })],
    ['no cwd', JSON.stringify({ session_id: 's-1' })],
    ['a payload the full dispatch handed its own background pass, whose cwd may be the scope\'s', payload({ teamai_run: { mode: 'attended' } })],
    ['no JSON', 'not json'],
  ])('records nothing for %s', (_case, raw) => {
    recordLoginEnrolment(raw, {});

    expect(fs.existsSync(record())).toBe(false);
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
