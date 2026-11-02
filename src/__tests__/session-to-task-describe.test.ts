import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncTeamDefinitions } from '../benchmark/suite-cache.js';
import { skillHarness } from './helpers/skill-harness.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SESSION = '7c1e-session';
const SESSION_CALL = { evidence: { kind: 'session', variable: 'CLAUDE_CODE_SESSION_ID' }, session: SESSION, tool: 'claude' } as const;
const NO_SESSION = { evidence: { kind: 'session', variable: 'CLAUDE_CODE_SESSION_ID' }, session: undefined, tool: undefined } as const;
const ORIGIN = 'https://github.com/acme/frontend.git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

const suite = (name: string, repo = ORIGIN) => `schemaVersion: v1alpha1
name: ${name}
repo: ${repo}
defaults: { tool: claude }
arms: [{ name: main }]
repetitions: 1
timeout: 1h
`;

const task = (source = '') => `schemaVersion: v1alpha1
title: Fix it
prompt: Make the test pass.
startingCommit: ${'a'.repeat(40)}
check: { run: node test.js, protect: [test.js] }
${source}`;

interface Fixture {
  /** Team files, by team-repo-relative path, or made from the commit at HEAD. */
  team?: Record<string, string> | ((head: string) => Record<string, string>);
  /** The checkout's origin, or none. */
  origin?: string | null;
  /** A URL git rewrites the origin to, as `url.<base>.insteadOf` does. */
  rewrittenTo?: string;
  /** The session's dashboard events, oldest first; `start` stands for the commit the checkout starts at. */
  events?: (start: string) => Array<{ type: string; timestamp: string; gitAtStart?: { head: string; dirty: boolean } }>;
  /** What the session did to the checkout after it started. */
  work?: 'commit' | 'dirty' | 'commit-then-dirty' | 'nothing';
  caller?: typeof SESSION_CALL | typeof NO_SESSION;
}

/**
 * describe of teamai-session-to-task from a checkout that starts at one commit, with `origin`, whose session wrote
 * `events` and then did `work`, in a team that has `team`. The inputs its question lists, and the two commits.
 */
async function described(fixture: Fixture): Promise<{ inputs: unknown[]; start: string; head: string }> {
  const harness = await skillHarness({});
  roots.push(harness.root);
  const { work, config } = harness;
  const origin = fixture.origin === undefined ? ORIGIN : fixture.origin;
  if (origin !== null) git(work, 'remote', 'add', 'origin', origin);
  if (origin !== null && fixture.rewrittenTo !== undefined) git(work, 'config', `url.${fixture.rewrittenTo}.insteadOf`, origin);
  const start = git(work, 'rev-parse', 'HEAD');
  const events = (fixture.events ?? ((head) => [{ type: 'session_start', timestamp: '2026-11-02T09:00:00.000Z', gitAtStart: { head, dirty: false } }]))(start);
  const dashboard = path.join(harness.root, 'home', '.teamai', 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  fs.writeFileSync(path.join(dashboard, 'events.jsonl'), events.map((event) => JSON.stringify({ ...event, sessionId: SESSION, tool: 'claude', cwd: work })).join('\n') + '\n');
  const action = fixture.work ?? 'commit';
  if (action === 'commit' || action === 'commit-then-dirty') {
    fs.writeFileSync(path.join(work, 'startup.js'), 'module.exports = 1;\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'fix startup');
  }
  if (action === 'dirty' || action === 'commit-then-dirty') fs.writeFileSync(path.join(work, 'README.md'), 'changed\n');
  const head = git(work, 'rev-parse', 'HEAD');
  const team = typeof fixture.team === 'function' ? fixture.team(head) : fixture.team ?? { 'benchmarks/frontend/suite.yaml': suite('frontend'), 'benchmarks/frontend/tasks/fix.yaml': task() };
  for (const [file, text] of Object.entries(team)) {
    fs.mkdirSync(path.dirname(path.join(config.repo.localPath, file)), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, file), text);
  }
  await syncTeamDefinitions(config);
  const answer = await harness.call({ kind: 'describe', name: 'teamai-session-to-task' }, fixture.caller ?? SESSION_CALL);
  if (!('data' in answer) || !('describe' in answer.data) || answer.data.describe.ask.kind !== 'ask') throw new Error(JSON.stringify(answer));
  return { inputs: answer.data.describe.ask.question.inputs, start, head };
}

/** The input named `name` of `inputs`. */
function input(inputs: unknown[], name: string): unknown {
  return inputs.find((entry) => typeof entry === 'object' && entry !== null && 'name' in entry && entry.name === name);
}

const STRING = { type: 'string' };

describe('describe of teamai-session-to-task', () => {
  it('proposes the session, its tool, the commit it started at, the solution at HEAD and the suite whose repo is origin', async () => {
    const { inputs, start, head } = await described({});

    expect(inputs).toEqual([
      { name: 'session', type: STRING, value: SESSION, why: 'This session: the one that made the change.' },
      { name: 'source', type: STRING, value: 'claude-code', why: 'This session\'s tool, as teamai session list names it.' },
      { name: 'suite', type: STRING, value: 'benchmarks/frontend', why: 'The one benchmark suite whose repo is this checkout\'s origin.' },
      { name: 'start', type: STRING, value: start, why: 'The commit this session started at.' },
      { name: 'solution', type: STRING, value: head, why: 'The commit at HEAD: the change this session made.' },
    ]);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('proposes no start when the session started with tracked files modified', async () => {
    const { inputs } = await described({ events: (head) => [{ type: 'session_start', timestamp: '2026-11-02T09:00:00.000Z', gitAtStart: { head, dirty: true } }] });

    expect(input(inputs, 'start')).toEqual({ name: 'start', type: STRING, why: 'No value: tracked files were modified when this session started, so no commit holds the starting state. Give the commit the task starts from.' });
    expect(input(inputs, 'solution')).toEqual({ name: 'solution', type: STRING, why: 'No value: there is no starting commit to compare HEAD with. Give the commit that completes the task.' });
  });

  it('proposes no start from a resume when the session\'s earliest start recorded no commit', async () => {
    const { inputs } = await described({
      events: (head) => [
        { type: 'session_start', timestamp: '2026-11-02T09:00:00.000Z' },
        { type: 'session_start', timestamp: '2026-11-02T11:00:00.000Z', gitAtStart: { head, dirty: false } },
      ],
    });

    expect(input(inputs, 'start')).toEqual({ name: 'start', type: STRING, why: 'No value: teamai did not record the commit this session started at. Give the commit the task starts from.' });
  });

  it('reads the earliest start, whatever order the events were written in', async () => {
    const { inputs, start } = await described({
      events: (head) => [
        { type: 'session_start', timestamp: '2026-11-02T11:00:00.000Z', gitAtStart: { head: 'b'.repeat(40), dirty: false } },
        { type: 'session_start', timestamp: '2026-11-02T09:00:00.000Z', gitAtStart: { head, dirty: false } },
      ],
    });

    expect(input(inputs, 'start')).toMatchObject({ value: start });
  });

  it('proposes no solution while HEAD is still the starting commit', async () => {
    const { inputs, start } = await described({ work: 'nothing' });

    expect(input(inputs, 'start')).toMatchObject({ value: start });
    expect(input(inputs, 'solution')).toEqual({ name: 'solution', type: STRING, why: 'No value: HEAD is still the starting commit. Commit the change, then ask again, or give the commit.' });
  });

  it('proposes no solution while tracked files are modified', async () => {
    const { inputs } = await described({ work: 'commit-then-dirty' });

    expect(input(inputs, 'solution')).toEqual({ name: 'solution', type: STRING, why: 'No value: tracked files are modified. Commit the change, then ask again, or give the commit.' });
  });

  it('says which task of the suite already comes from this session, or from this solution', async () => {
    const fromSession = await described({
      team: {
        'benchmarks/frontend/suite.yaml': suite('frontend'),
        'benchmarks/frontend/tasks/pod-startup.yaml': task(`source: { platform: claude-code, sessionId: ${SESSION} }\n`),
      },
    });
    expect(input(fromSession.inputs, 'session')).toEqual({ name: 'session', type: STRING, value: SESSION, why: 'This session: the one that made the change. benchmarks/frontend/tasks/pod-startup.yaml already comes from it.' });

    const fromSolution = await described({
      team: (head) => ({
        'benchmarks/frontend/suite.yaml': suite('frontend'),
        'benchmarks/frontend/tasks/pod-startup.yaml': task(`solutionCommit: ${head}\nsource: { platform: claude-code, sessionId: other }\n`),
      }),
    });
    expect(input(fromSolution.inputs, 'session')).toMatchObject({ why: 'This session: the one that made the change.' });
    expect(input(fromSolution.inputs, 'solution')).toEqual({ name: 'solution', type: STRING, value: fromSolution.head, why: 'The commit at HEAD: the change this session made. benchmarks/frontend/tasks/pod-startup.yaml already comes from it.' });
  });

  it('matches an SSH origin with a suite whose repo is HTTPS, and proposes a namespaced suite by its directory', async () => {
    const { inputs } = await described({
      origin: 'git@github.com:acme/frontend.git',
      team: {
        'manifest/roles.yaml': 'version: 1\nroles:\n  - id: web\n    resources: { knowledge: [], skills: [], benchmarks: [web] }\n',
        'benchmarks/web/frontend/suite.yaml': suite('frontend'),
        'benchmarks/web/frontend/tasks/fix.yaml': task(),
        'benchmarks/backend/suite.yaml': suite('backend', 'https://github.com/acme/backend.git'),
        'benchmarks/backend/tasks/fix.yaml': task(),
      },
    });

    expect(input(inputs, 'suite')).toEqual({ name: 'suite', type: STRING, value: 'benchmarks/web/frontend', why: 'The one benchmark suite whose repo is this checkout\'s origin.' });
  });

  it('matches the origin as written, when git rewrites it to a mirror', async () => {
    const { inputs } = await described({ rewrittenTo: 'ssh://git@mirror.example.com/acme/frontend.git' });

    expect(input(inputs, 'suite')).toMatchObject({ value: 'benchmarks/frontend' });
  });

  it('proposes no suite when two suites, or none, have this checkout\'s origin as repo', async () => {
    const two = await described({
      team: {
        'benchmarks/frontend/suite.yaml': suite('frontend'),
        'benchmarks/frontend/tasks/fix.yaml': task(),
        'benchmarks/frontend-perf/suite.yaml': suite('frontend-perf'),
        'benchmarks/frontend-perf/tasks/fix.yaml': task(),
      },
    });
    expect(input(two.inputs, 'suite')).toEqual({ name: 'suite', type: STRING, why: 'No value: benchmarks/frontend and benchmarks/frontend-perf both have this checkout\'s origin as repo. Give one of them.' });

    const none = await described({ origin: 'https://github.com/acme/other.git' });
    expect(input(none.inputs, 'suite')).toEqual({ name: 'suite', type: STRING, why: 'No value: no benchmark suite this checkout received has its origin as repo. Give the suite\'s directory, such as benchmarks/frontend.' });

    const noOrigin = await described({ origin: null });
    expect(input(noOrigin.inputs, 'suite')).toEqual({ name: 'suite', type: STRING, why: 'No value: this checkout has no origin remote. Give the suite\'s directory, such as benchmarks/frontend.' });
  });

  it('proposes no value when no agent session calls, and says why for each input', async () => {
    const { inputs } = await described({ caller: NO_SESSION });

    expect(inputs).toEqual([
      { name: 'session', type: STRING, why: 'No agent session found: give the session and its tool.' },
      { name: 'source', type: STRING, why: 'No agent session found: give the session and its tool.' },
      { name: 'suite', type: STRING, why: 'No value: no agent session found. Give the suite\'s directory, such as benchmarks/frontend.' },
      { name: 'start', type: STRING, why: 'No value: no agent session found. Give the commit the task starts from.' },
      { name: 'solution', type: STRING, why: 'No value: no agent session found. Give the commit that completes the task.' },
    ]);
  });
});
