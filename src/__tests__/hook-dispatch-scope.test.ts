/**
 * Which scope a hook run belongs to (#748): the real dispatcher and handlers,
 * observed through the files they leave in HOME. Only the machine-level
 * handlers that reach the network or spawn processes are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  // The detached background pass: run inline instead (bgOnly) so its writes are observable.
  spawn: vi.fn(() => ({ on: vi.fn(), stdin: { on: vi.fn(), end: vi.fn((_: string, done: () => void) => done()) }, unref: vi.fn() })),
}));
vi.mock('../pull.js', () => ({ pull: vi.fn(async () => undefined) }));
vi.mock('../update.js', () => ({ doUpdate: vi.fn(async () => undefined) }));
vi.mock('../local-agent.js', () => ({ reportAndSyncFromHook: vi.fn(async () => null) }));
vi.mock('../utils/reports-branch.js', () => ({ updateReports: vi.fn(async () => undefined) }));

const { hookDispatchCli } = await import('../hook-dispatch-cli.js');
const { resolveProjectDataHome, saveLocalConfigForScope } = await import('../config.js');

let tmp: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dispatch-scope-')));
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const teamaiHome = () => path.join(tmp, 'home', '.teamai');

/** Run one hook event the way a host does: foreground pass, then the background pass. */
async function hook(event: string, matcher: string, payload: Record<string, unknown>): Promise<void> {
  for (const bgOnly of [false, true]) {
    const stdinFile = path.join(tmp, `stdin-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(stdinFile, JSON.stringify(payload));
    await hookDispatchCli(event, 'claude', matcher, { bgOnly, stdinFile });
  }
}

function gitRepo(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function userScope(): void {
  const teamRepo = path.join(teamaiHome(), 'team-repo');
  fs.mkdirSync(teamRepo, { recursive: true });
  fs.writeFileSync(path.join(teamaiHome(), 'config.yaml'),
    `repo:\n  localPath: ${teamRepo}\n  remote: https://example.test/acme/user-team.git\nusername: tester\nscope: user\n`);
}

describe('hook runs and the scope they belong to (#748)', () => {
  it('a session in a directory without teamai leaves no trace', async () => {
    const cwd = gitRepo('project-b');
    const base = { session_id: 'sid-b', cwd };
    await hook('session-start', '*', { ...base, hook_event_name: 'SessionStart' });
    await hook('prompt-submit', '*', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
    await hook('post-tool-use', 'Skill', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'skill-b' } });
    await hook('post-tool-use', '*', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} });
    await hook('stop', '*', { ...base, hook_event_name: 'Stop' });

    expect(fs.existsSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(teamaiHome(), 'usage.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(teamaiHome(), 'sessions', 'sid-b.json'))).toBe(false);
  });

  it('a host that sends no cwd records into the project it runs in', async () => {
    const root = gitRepo('project-a');
    const dataHome = await resolveProjectDataHome(root);
    await saveLocalConfigForScope({
      repo: { localPath: path.join(dataHome, 'team-repo'), remote: 'https://example.test/acme/team-a.git' },
      username: 'tester', scope: 'project', projectRoot: root, additionalRoles: [], dataHome,
    });
    // OpenClaw's plugin spawns hook-dispatch in the workspace without a cwd field.
    process.chdir(root);

    await hook('post-tool-use', 'Skill', { session_id: 'sid-a', hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'skill-a' } });

    expect(fs.readFileSync(path.join(dataHome, 'usage.jsonl'), 'utf-8')).toContain('skill-a');
  });

  it('a hook whose cwd no longer exists falls back to the user scope instead of failing', async () => {
    userScope();
    const gone = path.join(tmp, 'deleted-worktree');

    await hook('post-tool-use', 'Skill', { session_id: 'sid-g', cwd: gone, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'skill-g' } });

    expect(fs.readFileSync(path.join(teamaiHome(), 'usage.jsonl'), 'utf-8')).toContain('skill-g');
  });

  it('handlers follow the scope the dispatcher resolved, not the directory the hook process runs in (#752)', async () => {
    userScope();
    fs.writeFileSync(path.join(teamaiHome(), 'team-repo', 'teamai.yaml'), 'team: user-team\nrepo: https://example.test/acme/user-team.git\n');
    const root = gitRepo('project-a');
    const dataHome = await resolveProjectDataHome(root);
    const teamRepoA = path.join(dataHome, 'team-repo');
    fs.mkdirSync(teamRepoA, { recursive: true });
    fs.writeFileSync(path.join(teamRepoA, 'teamai.yaml'), [
      'team: team-a',
      'repo: https://example.test/acme/team-a.git',
      'sharing:',
      '  intervention:',
      '    correctionKeywords: [rehazlo]',
      '  webhooks:',
      '    enabled: true',
      '    endpoints:',
      '      - { url: "https://hooks.team-a.test/in", type: json, retries: 0 }',
      '',
    ].join('\n'));
    await saveLocalConfigForScope({
      repo: { localPath: teamRepoA, remote: 'https://example.test/acme/team-a.git' },
      username: 'alice', scope: 'project', projectRoot: root, additionalRoles: [], dataHome,
    });
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const transcript = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{
      type: 'text',
      text: '<!-- teamai:recalled-doc-ids: [doc-1] --> <!-- teamai:referenced-doc-ids: [doc-1] -->',
    }] } }) + '\n');
    // The session's worktree is gone, so chdir fails and the host's launch
    // directory, project A, stays the process cwd.
    process.chdir(root);
    const base = { session_id: 'sid-g', cwd: path.join(tmp, 'deleted-worktree') };

    try {
      await hook('prompt-submit', '*', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'rehazlo' });
      await hook('stop', '*', { ...base, hook_event_name: 'Stop', transcript_path: transcript });
    } finally {
      vi.unstubAllGlobals();
    }

    const events = fs.readFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; correction?: boolean });
    expect(events.find((e) => e.type === 'prompt_submit')?.correction).toBe(false);
    expect(fs.readdirSync(path.join(teamaiHome(), 'votes'))).toEqual(['tester.yaml']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a project whose config cannot be read records nothing, not even in the user scope', async () => {
    userScope();
    const root = gitRepo('project-a');
    const dataHome = await resolveProjectDataHome(root);
    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'config.yaml'), 'repo: [not: a, valid config\n');

    await hook('post-tool-use', 'Skill', { session_id: 'sid-a', cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'skill-a' } });

    expect(fs.existsSync(path.join(teamaiHome(), 'usage.jsonl'))).toBe(false);
  });
});
