/**
 * E2E (#810): hook events that arrive after their worktree is deleted stay in
 * the session's project.
 *
 * The scope of a hook event is resolved from its `cwd`, and a directory that
 * no longer exists resolved to the user scope. So once `git worktree remove`
 * ran, a session's last events were recorded under the user scope (and counted
 * by it), or dropped when there was none, and its skill uses went to the user
 * scope's usage file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataHomeKey } from '../../dashboard-collector.js';
import { projectSlug } from '../../utils/partition.js';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface RunResult {
  code: number | null;
  output: string;
}

interface RecordedEvent {
  type: string;
  sessionId: string;
  cwd?: string;
  dataHomeKey?: string;
  projectAnchor?: string;
}

const SESSION = 's-b';
/** The turns that use `team-skill`: p1's call, p2's `/team-skill` (its call and `track` repeat it), p3's `track-slash`. */
const SKILL_USES = 3;

function cliEnv(home: string): NodeJS.ProcessEnv {
  // The host's session id would override the payloads' own.
  const { CLAUDE_SESSION_ID: _ignored, ...env } = process.env;
  return { ...env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', NO_COLOR: '1' };
}

function runCLI(args: string[], cwd: string, home: string, input = ''): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { cwd, env: cliEnv(home), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}

interface ScenarioOptions {
  /** Also set up the user scope, which the events must not reach. */
  userScope: boolean;
  /** Make the project's config unreadable once `b` is removed. */
  breakProjectConfig?: boolean;
  /** Turn the share reminder off in the project only, and score the session so a Stop would show it. */
  projectHintOff?: boolean;
  /**
   * The session records an event in a user-scope directory before `b` is
   * removed, as when it moves on while `b`'s detached Stop has yet to run.
   */
  movedOn?: boolean;
  /** A bare repo (`proj/.bare`) whose checkouts are all worktrees (`proj/main`, `proj/b`). */
  bare?: boolean;
}

/**
 * One sandbox: a project installed in its partition, a worktree `b` outside
 * the checkout, and optionally a user-scope config. A session in `b` records a
 * prompt and a skill use, `b` is removed, and the session keeps sending hooks.
 */
function scenario({ userScope, breakProjectConfig = false, bare = false, projectHintOff = false, movedOn = false }: ScenarioOptions) {
  const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue810-e2e-')));
  const home = path.join(sandbox, 'home');
  // The checkout the project was set up in, and the repo's anchor (its main worktree).
  const repo = bare ? path.join(sandbox, 'proj', 'main') : path.join(sandbox, 'repo');
  const anchor = bare ? path.join(sandbox, 'proj', '.bare') : repo;
  const worktree = bare ? path.join(sandbox, 'proj', 'b') : path.join(sandbox, 'b');
  const partition = path.join(home, '.teamai', 'projects', projectSlug(anchor));
  const eventsFile = path.join(home, '.teamai', 'dashboard', 'events.jsonl');
  const state = { sandbox, home, repo, anchor, worktree, partition, eventsFile, before: 0, stopOutput: '', settled: false };

  const hook = async (event: string, payload: Record<string, unknown>, matcher = '*', tool = 'claude') => {
    const r = await runCLI(['hook-dispatch', event, '--tool', tool, '--matcher', matcher, '--stdin'], home, home,
      JSON.stringify({ session_id: SESSION, cwd: worktree, ...payload }));
    expect(r.code, r.output).toBe(0);
    return r.output;
  };
  const legacy = async (args: string[], payload: Record<string, unknown>) => {
    const r = await runCLI([...args, '--stdin', '--tool', 'claude'], home, home,
      JSON.stringify({ session_id: SESSION, cwd: worktree, ...payload }));
    expect(r.code, r.output).toBe(0);
  };
  const skillUse = { hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'team-skill' }, tool_response: {} };

  const setup = async () => {
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team-remote.git');
    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: issue-810-e2e\nrepo: https://example.com/team.git\nprovider: tgit\n');
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);

    const source = bare ? path.join(sandbox, 'src') : repo;
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'README.md'), '# repo\n');
    git(['init', '-q', '-b', 'main'], source);
    git(['add', '-A'], source);
    git(['commit', '-q', '-m', 'project'], source);
    if (bare) {
      git(['clone', '-q', '--bare', source, anchor], sandbox);
      git(['worktree', 'add', '-q', repo, 'main'], anchor);
    }
    git(['worktree', 'add', '-q', worktree, '-b', 'b'], repo);

    fs.mkdirSync(partition, { recursive: true });
    git(['clone', '-q', remote, path.join(partition, 'team-repo')], sandbox);
    fs.writeFileSync(path.join(partition, 'anchor'), `${anchor}\n`);
    fs.writeFileSync(path.join(partition, 'config.yaml'), [
      'repo:',
      `  localPath: ${path.join(partition, 'team-repo')}`,
      `  remote: ${remote}`,
      'username: ci-810',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${repo}`,
      'enabledAgents: [claude]',
      // A relocated Claude Code that only the project records.
      'toolRoots:',
      '  claude: ~/.claude-alt',
      ...(projectHintOff ? ['contributeHintEnabled: false'] : []),
      '',
    ].join('\n'));
    if (userScope) {
      git(['clone', '-q', remote, path.join(home, '.teamai', 'team-repo')], sandbox);
      fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
        'repo:',
        `  localPath: ${path.join(home, '.teamai', 'team-repo')}`,
        `  remote: ${remote}`,
        'username: ci-810',
        'updatePolicy: auto',
        'scope: user',
        'enabledAgents: [claude]',
        // The share reminder needs recall; only the user scope turns it on.
        ...(projectHintOff ? ['recallEnabled: true'] : []),
        '',
      ].join('\n'));
    }
    // A skill on disk under the project's Claude root, so a use of `team-skill`
    // counts only when the hook looks there.
    fs.mkdirSync(path.join(home, '.claude-alt', 'skills', 'team-skill'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude-alt', 'skills', 'team-skill', 'SKILL.md'), '---\nname: team-skill\ndescription: fixture\n---\n');

    // While the worktree exists: a prompt and a skill use.
    // Each turn carries Claude Code's `prompt_id`; a skill counts once per turn (#1221).
    await hook('prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: 'work in b', prompt_id: 'p1' });
    await hook('post-tool-use', { ...skillUse, prompt_id: 'p1' });
    // Its credit is written by the detached pass, which also prepares the new
    // worktree (#1424); the turn ends before the worktree goes.
    await waitForDetachedChildren();
    if (movedOn) {
      // Another repo, in the user scope: it records a scope and an anchor of its own.
      const elsewhere = path.join(sandbox, 'elsewhere');
      fs.mkdirSync(elsewhere);
      git(['init', '-q', '-b', 'main'], elsewhere);
      git(['commit', '-q', '--allow-empty', '-m', 'init'], elsewhere);
      await hook('prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: 'work elsewhere', cwd: elsewhere });
    }
    state.before = readJsonl<RecordedEvent>(eventsFile).length;

    git(['worktree', 'remove', '--force', worktree], repo);
    if (breakProjectConfig) fs.writeFileSync(path.join(partition, 'config.yaml'), 'repo: [unterminated\n');
    if (projectHintOff) writeSessionState({ smartScore: 30, toolCount: 20, lastEvaluated: Date.now(),
      friction: { interrupt: 1, toolReject: 0, correction: 0, toolError: 0 }, promptSummary: 'work in b' });

    // After it is gone, through the dispatcher...
    await hook('prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: '/team-skill again', prompt_id: 'p2' });
    await hook('post-tool-use', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {}, tool_response: {}, prompt_id: 'p2' });
    await hook('post-tool-use', { ...skillUse, prompt_id: 'p2' });
    await hook('session-end', { hook_event_name: 'SessionEnd' });
    state.stopOutput = await hook('stop', { hook_event_name: 'Stop' });
    // ...and through the entry points hooks from an earlier install still call.
    await legacy(['dashboard-report'], { hook_event_name: 'UserPromptSubmit', prompt: 'legacy prompt' });
    await legacy(['track'], { ...skillUse, prompt_id: 'p2' });
    await legacy(['track-slash'], { hook_event_name: 'UserPromptSubmit', prompt: '/team-skill go', prompt_id: 'p3' });

    // SessionEnd and Stop are recorded by a detached child: wait for them. Where
    // nothing may be recorded, wait instead for a later session's detached Stop,
    // spawned after this session's, so theirs have had their turn.
    if (breakProjectConfig) await hook('stop', { hook_event_name: 'Stop', session_id: 'control', cwd: home });
    const settled = breakProjectConfig
      ? () => readJsonl<RecordedEvent>(eventsFile).some((e) => e.sessionId === 'control' && e.type === 'stop')
      : () => ['session_end', 'stop'].every((type) => afterRemoval().some((e) => e.type === type))
        && readJsonl(path.join(partition, 'usage.jsonl')).length >= SKILL_USES;
    const deadline = Date.now() + 20_000;
    while (!settled() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    state.settled = settled();
  };

  // The session's contribute state, as the Stop hook's scoring leaves it.
  const writeSessionState = (fields: Record<string, unknown>) => {
    fs.mkdirSync(path.join(home, '.teamai', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'sessions', `${SESSION}.json`), JSON.stringify(fields));
  };

  const afterRemoval = () => readJsonl<RecordedEvent>(eventsFile).slice(state.before).filter((e) => e.sessionId === SESSION);
  // Every hook here goes through `hook-dispatch`, which spawns a detached child
  // for the background-only handlers (SessionEnd, Stop). The suite waits for the
  // events that child writes, never for the child itself to exit: it keeps
  // writing `state.json` and `debug.log` under `.teamai` for a moment after,
  // so a removal that runs straight afterwards raced it into ENOTEMPTY on CI
  // (#1413). Teardown joins every detached pid the suite recorded before
  // removing the sandbox; the maxRetries rmSync stays as a backstop.
  const cleanup = async (): Promise<void> => {
    await waitForDetachedChildren();
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { state, setup, afterRemoval, cleanup, hook, writeSessionState };
}

describe('hook events after their worktree is deleted (#810)', () => {
  describe('with a user-scope config as well', () => {
    const s = scenario({ userScope: true });
    beforeAll(async () => {
      if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
      await s.setup();
    }, 120_000);
    afterAll(() => s.cleanup());

    it('records them under the project, with the session\'s repo', async () => {
      const events = s.afterRemoval();
      expect(events.map((e) => e.type).sort()).toEqual(['prompt_submit', 'prompt_submit', 'session_end', 'stop', 'tool_use', 'tool_use']);
      const key = await dataHomeKey(s.state.partition);
      expect(events.map((e) => [e.type, e.dataHomeKey, e.projectAnchor])).toEqual(
        events.map((e) => [e.type, key, s.state.anchor]));
    });

    it('does not count the session in the user scope\'s stats', async () => {
      const user = await runCLI(['stats'], s.state.home, s.state.home);
      expect(user.code, user.output).toBe(0);
      expect(user.output).not.toMatch(/Sessions:\s+[1-9]/);
      const project = await runCLI(['stats'], s.state.repo, s.state.home);
      expect(project.output).toMatch(/Sessions:\s+1\b/);
    });

    it('records the skill uses in the project\'s usage, not the user scope\'s', () => {
      expect(readJsonl(path.join(s.state.partition, 'usage.jsonl'))).toHaveLength(SKILL_USES);
      expect(readJsonl(path.join(s.state.home, '.teamai', 'user-usage.jsonl'))).toHaveLength(0);
    });
  });

  describe('without a user-scope config', () => {
    const s = scenario({ userScope: false });
    beforeAll(async () => {
      if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
      await s.setup();
    }, 120_000);
    afterAll(() => s.cleanup());

    it('records them under the project instead of dropping them', async () => {
      const events = s.afterRemoval();
      expect(events.map((e) => e.type).sort()).toEqual(['prompt_submit', 'prompt_submit', 'session_end', 'stop', 'tool_use', 'tool_use']);
      const key = await dataHomeKey(s.state.partition);
      expect(events.every((e) => e.dataHomeKey === key && e.projectAnchor === s.state.anchor)).toBe(true);
    });

    it('records the skill uses in the project\'s usage', () => {
      expect(readJsonl(path.join(s.state.partition, 'usage.jsonl'))).toHaveLength(SKILL_USES);
    });
  });

  describe('when the project\'s config can no longer be read', () => {
    const s = scenario({ userScope: true, breakProjectConfig: true });
    beforeAll(async () => {
      if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
      await s.setup();
    }, 120_000);
    afterAll(() => s.cleanup());

    it('drops them rather than handing them to the user scope (#748)', () => {
      expect(s.state.settled).toBe(true);
      expect(s.afterRemoval()).toEqual([]);
      expect(readJsonl(path.join(s.state.home, '.teamai', 'user-usage.jsonl'))).toHaveLength(0);
    });
  });

  describe('in a bare repo, whose anchor is the git directory', () => {
    const s = scenario({ userScope: true, bare: true });
    beforeAll(async () => {
      if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
      await s.setup();
    }, 120_000);
    afterAll(() => s.cleanup());

    it('records them under the project, with the session\'s repo', async () => {
      const events = s.afterRemoval();
      expect(events.map((e) => e.type).sort()).toEqual(['prompt_submit', 'prompt_submit', 'session_end', 'stop', 'tool_use', 'tool_use']);
      const key = await dataHomeKey(s.state.partition);
      expect(events.map((e) => [e.type, e.dataHomeKey, e.projectAnchor])).toEqual(
        events.map((e) => [e.type, key, s.state.anchor]));
    });

    it('records the skill uses in the project\'s usage, not the user scope\'s', () => {
      expect(readJsonl(path.join(s.state.partition, 'usage.jsonl'))).toHaveLength(SKILL_USES);
      expect(readJsonl(path.join(s.state.home, '.teamai', 'user-usage.jsonl'))).toHaveLength(0);
    });
  });

  describe('a session that moved on before the late hooks of its removed worktree', () => {
    const s = scenario({ userScope: true, movedOn: true });
    beforeAll(async () => {
      if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
      await s.setup();
    }, 120_000);
    afterAll(() => s.cleanup());

    it('records them under the worktree\'s project, not where the session went next', async () => {
      const events = s.afterRemoval();
      expect(events.map((e) => e.type).sort()).toEqual(['prompt_submit', 'prompt_submit', 'session_end', 'stop', 'tool_use', 'tool_use']);
      const key = await dataHomeKey(s.state.partition);
      expect(events.map((e) => [e.type, e.dataHomeKey, e.projectAnchor])).toEqual(
        events.map((e) => [e.type, key, s.state.anchor]));
      expect(readJsonl(path.join(s.state.partition, 'usage.jsonl'))).toHaveLength(SKILL_USES);
    });
  });

  describe('the share reminder, which only the user scope allows', () => {
    const s = scenario({ userScope: true, projectHintOff: true });
    beforeAll(async () => {
      if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
      await s.setup();
    }, 120_000);
    afterAll(() => s.cleanup());

    it('is not shown on the Stop of a removed worktree\'s session', () => {
      expect(s.state.stopOutput).not.toContain('worth documenting');
    });

    it('is not delivered from a stash on the next prompt either', async () => {
      // A tool whose Stop cannot print stashes the hint for its next prompt.
      s.writeSessionState({ pendingHint: '[teamai] STASHED-REMINDER' });
      const output = await s.hook('prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: 'next' }, '*', 'codebuddy');
      expect(output).not.toContain('STASHED-REMINDER');
    });

    it('is not shown by the legacy contribute-check command either', async () => {
      s.writeSessionState({ smartScore: 30, toolCount: 20, lastEvaluated: Date.now(),
        friction: { interrupt: 1, toolReject: 0, correction: 0, toolError: 0 }, promptSummary: 'work in b' });
      const r = await runCLI(['contribute-check', '--stdin', '--tool', 'claude'], s.state.home, s.state.home,
        JSON.stringify({ session_id: SESSION, cwd: s.state.worktree, hook_event_name: 'Stop' }));
      expect(r.code, r.output).toBe(0);
      expect(r.output).not.toContain('worth documenting');
    });
  });
});


it.runIf(process.platform !== 'win32').each([[false, false], [true, false], [true, true]])('recovers an omitted cwd after deletion, user scope %s, moved on %s', async (userScope, movedOn) => {
  const fixture = scenario({ userScope });
  try {
    await fixture.setup();
    const { state } = fixture;
    if (movedOn) {
      const elsewhere = path.join(state.home, 'elsewhere');
      fs.mkdirSync(elsewhere);
      git(['init', '-q', '-b', 'main'], elsewhere);
      git(['commit', '-q', '--allow-empty', '-m', 'fixture'], elsewhere);
      const prompt = await runCLI(['hook-dispatch', 'prompt-submit', '--tool', 'claude'], elsewhere, state.home,
        JSON.stringify({ session_id: SESSION, cwd: elsewhere, prompt: 'work elsewhere' }));
      expect(prompt.code, prompt.output).toBe(0);
      expect(readJsonl<RecordedEvent & { cwd: string }>(state.eventsFile).at(-1)?.cwd).toBe(elsewhere);
    }
    const before = readJsonl<RecordedEvent>(state.eventsFile).length;
    fs.mkdirSync(state.worktree);
    const stopped = spawnSync('/bin/sh', ['-c', 'rmdir "$REMOVED_WORK" && exec "$TEST_NODE" "$TEST_CLI" hook-dispatch stop --tool claude --bg-only'], {
      cwd: state.worktree, env: { ...cliEnv(state.home), REMOVED_WORK: state.worktree, TEST_NODE: process.execPath, TEST_CLI: CLI },
      input: JSON.stringify({ session_id: SESSION, hook_event_name: 'Stop' }), encoding: 'utf8', timeout: 30000,
    });
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
    expect(stopped.stdout + stopped.stderr).not.toContain('uv_cwd');
    const events = readJsonl<RecordedEvent>(state.eventsFile).slice(before).filter(event => event.sessionId === SESSION && event.type === 'stop');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ dataHomeKey: await dataHomeKey(state.partition), projectAnchor: state.anchor });
  } finally { await fixture.cleanup(); }
});
