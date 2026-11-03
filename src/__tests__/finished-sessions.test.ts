import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home, default: { ...actual, homedir: () => mocks.home } };
});

import type { RunMode } from '../launch-context.js';
import { saveLocalConfig } from '../config.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import { FinishedSessions, type ListOptions } from '../session-flow/finished-sessions.js';
import { SessionPublish } from '../session-flow/session-publish.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import type { LocalConfig } from '../types.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import { projectDataHome } from '../utils/partition.js';
import { Marks } from '../scorers/marks.js';
import { pinScorers } from '../scorers/cache.js';
import { attemptEnv } from '../workflow/attempt-marker.js';
import { leaseNext, startRun } from '../workflow/engine.js';
import { resolveWorkflowEnv } from '../env-resolution.js';
import { inProcessClient } from '../workflow/protocol.js';
import { readRun } from '../workflow/store.js';
import type { StartedBy, WorkflowEnvelope } from '../workflow/types.js';

const SCORER = `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 100
sessions: true
---
Judge the session.
`;

const IDLE = '7c1e0000-0000-4000-8000-000000000011';
const ACTIVE = '7c1e0000-0000-4000-8000-000000000012';
const HOUR = 60 * 60 * 1000;

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-finished-sessions-')));
  mocks.home = path.join(root, 'home');
  fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
  for (const name of AGENT_SESSION_ENV) vi.stubEnv(name, '');
  vi.stubEnv('HOME', mocks.home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** A git-kind team whose repo holds `files`, saved as this machine's user install with `member` settings, its scorers cached. */
async function team(files: Record<string, string> = {}, member: Partial<LocalConfig> = {}): Promise<LocalConfig> {
  const seed = path.join(root, 'seed');
  for (const [file, text] of Object.entries({ 'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\n', 'scorers/quality.md': SCORER, ...files })) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), text);
  }
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'team');
  const origin = path.join(root, 'team.git');
  git(root, 'clone', '-q', '--bare', seed, origin);
  const clone = path.join(root, 'team');
  git(root, 'clone', '-q', origin, clone);
  const config: LocalConfig = { repo: { localPath: clone, remote: origin, kind: 'git' }, username: 'tester', scope: 'user', additionalRoles: [], ...member };
  await saveLocalConfig(config);
  await syncScorerDefinitions(config);
  return config;
}

/** A Claude session `sessionId`, captured in the user scope's data home in `runMode`, with nothing happening in it for `idleFor`. */
function capturedSession(sessionId: string, runMode: RunMode, { idleFor = 7 * HOUR } = {}): void {
  const cwd = path.join(root, 'app');
  const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
  fs.writeFileSync(file,
    line({ type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'Add retries to the client' } })
    + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added.' }] } }));
  const idleSince = new Date(Date.now() - idleFor);
  fs.utimesSync(file, idleSince, idleSince);
  const captures = path.join(mocks.home, '.teamai', 'sessions', 'captures', 'claude-code', sessionId);
  fs.mkdirSync(captures, { recursive: true });
  const captureId = `0b6f2a52-5d7e-4c7e-9a43-${sessionId.slice(-12)}`;
  fs.writeFileSync(path.join(captures, `${captureId}.json`), JSON.stringify({ captureId, platform: 'claude-code', sessionId,
    capturedAt: idleSince.toISOString(), runMode, agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, sessionFile: file }));
}

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

async function listed(config: LocalConfig, options: ListOptions = {}, env: NodeJS.ProcessEnv = {}) {
  return FinishedSessions.list(options, { env, current: config, now: new Date().toISOString() });
}

describe('session list --finished', () => {
  it('lists a session idle past --idle with the scorers scoring.sessions: auto names, and leaves out one still active', async () => {
    const config = await team({}, { scoring: { sessions: true } });
    capturedSession(IDLE, 'attended');
    capturedSession(ACTIVE, 'attended', { idleFor: 0 });

    expect(await listed(config, { idle: '6h' })).toEqual({
      ok: true,
      list: [{ session: IDLE, source: 'claude-code', publish: false, scorers: ['quality'], demand: 'auto' }],
    });
  });

  it('takes a session idle for --idle, so a team file with --idle 1h takes it one hour after its last activity', async () => {
    const config = await team({}, { scoring: { sessions: true } });
    capturedSession(IDLE, 'attended', { idleFor: 1.5 * HOUR });

    expect(await listed(config, { idle: '6h' })).toEqual({ ok: true, list: [] });
    expect(await listed(config, { idle: '1h' })).toMatchObject({ ok: true, list: [{ session: IDLE }] });
  });

  it('publishes a session where sessions.publish is auto for its run mode, and with scoring off lists it with no scorer', async () => {
    const config = await team({ 'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nsessions:\n  publish: { attended: auto }\n' });
    capturedSession(IDLE, 'attended');

    expect(await listed(config)).toEqual({ ok: true, list: [{ session: IDLE, source: 'claude-code', publish: true, scorers: [], demand: 'auto' }] });
    expect(await listed(config, { publish: 'never' })).toEqual({ ok: true, list: [] });
  });

  it('publishes again only a session that changed after this data home last archived it', async () => {
    const config = await team({ 'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nsessions:\n  publish: { attended: auto }\n' });
    capturedSession(IDLE, 'attended', { idleFor: 7 * HOUR });
    capturedSession(ACTIVE, 'attended', { idleFor: 7 * HOUR });
    await SessionPublish.recordArchived(config, { platform: 'claude-code', sessionId: IDLE }, new Date(Date.now() - 6 * HOUR).toISOString());
    await SessionPublish.recordArchived(config, { platform: 'claude-code', sessionId: ACTIVE }, new Date(Date.now() - 8 * HOUR).toISOString());

    expect(await listed(config)).toEqual({ ok: true, list: [{ session: ACTIVE, source: 'claude-code', publish: true, scorers: [], demand: 'auto' }] });
  });

  it('with no settings lists no attended session, and an unattended one only once a drain reached it, whatever --idle says', async () => {
    const config = await team();
    capturedSession(IDLE, 'attended');
    capturedSession(ACTIVE, 'unattended', { idleFor: 0 });

    expect(await listed(config)).toEqual({ ok: true, list: [] });
    fs.writeFileSync(path.join(mocks.home, '.teamai', 'sessions', 'captures', 'claude-code', ACTIVE, 'drained'), new Date().toISOString());

    expect(await listed(config)).toEqual({ ok: true, list: [{ session: ACTIVE, source: 'claude-code', publish: true, scorers: ['quality'], demand: 'auto' }] });
  });

  it('leaves out a scorer whose mark is open or closed, and keeps one whose mark lapsed', async () => {
    const config = await team({ 'scorers/tests.md': SCORER, 'scorers/docs.md': SCORER }, { scoring: { sessions: true } });
    capturedSession(IDLE, 'attended');
    const pins = await pinScorers(config, ['quality', 'tests', 'docs']);
    const key = (scorer: string) => ({ scorer, sourceHash: pins[scorer]?.sourceHash ?? '', subject: { kind: 'session' as const, subject: { platform: 'claude-code', sessionId: IDLE } } });
    const now = new Date().toISOString();
    const running = String(data(await startRun(config, 'teamai-finished-sessions', { publish: 'policy', scorers: [] }, { secrets: {}, startedBy: 'cli' })).run);
    const facts = { now, readRun: async () => undefined };
    await Marks.open(config, { run: running, demand: 'auto', groups: [{ group: 'quality', keys: [key('quality')] }] }, facts);
    // A run that is gone: its marks still open lapsed.
    await Marks.open(config, { run: 'r2222222222222222', demand: 'auto', groups: [{ group: 'tests', keys: [key('tests')] }, { group: 'docs', keys: [key('docs')] }] }, facts);
    await Marks.close(config, [key('tests')], { kind: 'labelled' }, { now });

    expect(await listed(config)).toEqual({ ok: true, list: [{ session: IDLE, source: 'claude-code', publish: false, scorers: ['docs'], demand: 'auto' }] });
  });

  it('lists every finished session for the scorers a person names, with policies off, unsampled and as a named demand', async () => {
    const config = await team({ 'scorers/rare.md': SCORER.replace('samplingRate: 100', 'samplingRate: 0').replace('sessions: true\n', '') });
    capturedSession(IDLE, 'attended');
    capturedSession(ACTIVE, 'attended', { idleFor: 0 });

    expect(await listed(config, { publish: 'never', scorers: '["rare"]' })).toEqual({ ok: true, list: [{ session: IDLE, source: 'claude-code', publish: false, scorers: ['rare'], demand: 'named' }] });
    expect(await listed(config, { scorers: '["nope"]' })).toMatchObject({ ok: false, code: 'scorer_not_found' });
  });

  it.each<[StartedBy, ListOptions, string]>([
    ['cli', { publish: 'always' }, 'policy_override_refused'],
    ['cli', { scorers: '["quality"]' }, 'policy_override_refused'],
    ['agent', { publish: 'never' }, 'policy_override_refused'],
    ['cli', {}, ''],
    ['person', { publish: 'never', scorers: '["quality"]' }, ''],
  ])('inside a teamai-finished-sessions run started by %s, with %j, refuses with "%s"', async (startedBy, options, code) => {
    const config = await team({}, { scoring: { sessions: true } });
    capturedSession(IDLE, 'attended');
    const runId = String(data(await startRun(config, 'teamai-finished-sessions', { publish: 'policy', scorers: [] }, { secrets: {}, startedBy })).run);
    const { attempt } = data(await leaseNext(config, runId, { kind: 'external', machine: 'm1', workspace: root })).lease as { attempt: string };

    const answer = await listed(config, options, attemptEnv(config, runId, attempt, 'attended'));

    if (code === '') expect(answer).toMatchObject({ ok: true, list: [{ session: IDLE }] });
    else expect(answer).toMatchObject({ ok: false, code, message: expect.stringContaining(`Run ${runId} was not started from a person's terminal`) });
  });
});

describe('the start of teamai-finished-sessions', () => {
  it('starts one run as the CLI\'s own, with the policy inputs, from the scope\'s own directory, whatever agent session runs it', async () => {
    const config = await team({}, { scoring: { sessions: true } });
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'the-agent-session');
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });

    const started = await FinishedSessions.start(config, { client, mode: 'attended' });

    if (!started.ok) throw new Error(started.failure.message);
    const run = await readRun(config, started.run);
    expect(run).toMatchObject({ name: 'teamai-finished-sessions', status: 'running', startedBy: 'cli', inputs: { publish: 'policy', scorers: [] }, checkout: path.join(mocks.home, '.teamai') });
    expect(started.cwd).toBe(path.join(mocks.home, '.teamai'));
  });

  it('answers the run already working on this data home instead of starting a second', async () => {
    const config = await team({}, { scoring: { sessions: true } });
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
    const first = await FinishedSessions.start(config, { client, mode: 'attended' });

    const second = await FinishedSessions.start(config, { client, mode: 'attended' });

    expect(first).toMatchObject({ ok: true, running: false });
    expect(second).toEqual(first.ok ? { ...first, running: true } : first);
  });
});

describe('the scopes a session start archives and judges sessions in', () => {
  /** The user scope's config.yaml, with `scoring` as given. */
  function userConfig(scoring: string): void {
    const knowledge = path.join(root, 'knowledge');
    fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
    fs.mkdirSync(path.join(mocks.home, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(mocks.home, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${JSON.stringify(knowledge)}\n  remote: local\n  kind: self\nusername: tester\nscope: user\nadditionalRoles: []\n${scoring}`);
  }

  it('is the user scope from a directory that no longer exists, when it turns session scoring on', async () => {
    userConfig('scoring:\n  sessions: true\n');
    expect(await FinishedSessions.backgroundScopes(path.join(root, 'gone'))).toMatchObject([{ scope: 'user' }]);
  });

  /** A workspace that selects project billing, with a child repo that selects checkout, and `files` in the team repo. */
  function workspace(files: Record<string, string>): string {
    const knowledge = path.join(root, 'knowledge');
    for (const [file, text] of Object.entries({
      'manifest/roles.yaml': 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [] }\n',
      'manifest/projects.yaml': 'version: 1\nprojects:\n  - id: billing\n    name: Billing\n    resources: { scorers: [billing] }\n  - id: checkout\n    name: Checkout\n    resources: { scorers: [checkout] }\n',
      ...files,
    })) {
      fs.mkdirSync(path.dirname(path.join(knowledge, file)), { recursive: true });
      fs.writeFileSync(path.join(knowledge, file), text);
    }
    const repoAt = (dir: string, project: string) => {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const home = projectDataHome(fs.realpathSync(dir));
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'config.yaml'),
        `repo:\n  localPath: ${JSON.stringify(knowledge)}\n  remote: https://git.example.com/team/team.git\nusername: tester\nscope: project\nadditionalRoles: []\nprojects: [${project}]\n`);
    };
    const ws = path.join(root, 'ws');
    repoAt(ws, 'billing');
    repoAt(path.join(ws, 'svc'), 'checkout');
    return ws;
  }

  it('reads the settings of the namespaces a workspace child makes active', async () => {
    const ws = workspace({ 'scorers/scoring.yaml': 'sessions: true\n', 'scorers/checkout/scoring.yaml': 'sessions: false\n' });
    expect(await FinishedSessions.backgroundScopes(ws)).toEqual([]);
  });

  it('is the workspace when only a workspace child\'s namespace turns session scoring on', async () => {
    const ws = workspace({ 'scorers/checkout/scoring.yaml': 'sessions: true\n' });
    expect(await FinishedSessions.backgroundScopes(ws)).toMatchObject([{ scope: 'project', children: expect.any(Object) }]);
  });

  it('is the user scope when it publishes attended sessions automatically, though it scores none', async () => {
    userConfig('sessions:\n  publish:\n    attended: auto\n');
    expect(await FinishedSessions.backgroundScopes(path.join(root, 'gone'))).toMatchObject([{ scope: 'user' }]);
  });

  it('is none while no scope turns session scoring on', async () => {
    userConfig('');
    expect(await FinishedSessions.backgroundScopes(path.join(root, 'gone'))).toEqual([]);
  });
});
