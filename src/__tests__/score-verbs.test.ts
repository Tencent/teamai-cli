import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '', ci: vi.fn() }));
vi.mock('../workflow/pr-delivery.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../workflow/pr-delivery.js')>(), deliveredCi: mocks.ci }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home, default: { ...actual, homedir: () => mocks.home } };
});

import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';
import { knownSecrets } from '../env-resolution.js';
import { attemptEnv } from '../workflow/attempt-marker.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { cancelRun, retryStep } from '../workflow/run-controls.js';
import type { DriverIdentity, StartedBy, WorkflowEnvelope } from '../workflow/types.js';
import { ScoreAnswer } from '../scorers/score-answer.js';
import { ScoreVerbs, type EvidenceOptions, type PlanOptions, type ScoreVerbAnswer, type ScoreVerbContext, type SubjectsOptions } from '../score-verbs.js';
import { labelVersion } from '../scorers/label.js';
import { LabelStore } from '../scorers/label-store.js';
import { log } from '../utils/logger.js';
import { Marks, type MarkKey } from '../scorers/marks.js';
import { markFacts } from '../scorers/score-plan.js';
import { PassScoring } from '../scorers/pass-scoring.js';
import { RunScorers } from '../scorers/run-scorers.js';
import type { ConfinedRunReport } from '../workflow/step-state.js';
import { evidenceHash, stageEvidence } from '../scorers/scoring-evidence.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import { checkConfinedDir } from '../workflow/confined-place.js';
import { readRun, RunIdSchema, runScratchDir, updateRun } from '../workflow/store.js';
import type { StepState } from '../workflow/step-state.js';
import { PrUrlSchema } from '../workflow/pr-url.js';
import { recallLogPath } from '../recall-log.js';
import { readUserVotes } from '../votes.js';
import { creditAdoptedDocs, drainRecallLog } from '../recall-adoption.js';
import { acquireLock, releaseLock } from '../update.js';
import { getVotesDir } from '../types.js';

const external: DriverIdentity = { kind: 'external', machine: 'm1', workspace: '/w' };
const NOW = '2026-11-03T10:00:00.000Z';

const scorer = ({ rate = 100, extra = '' }: { rate?: number; extra?: string } = {}) => `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 1
samplingRate: ${rate}
${extra}---
Judge the work.
`;

const REVIEW = `schemaVersion: v1alpha1
name: review
description: Review a change.
steps:
  - id: review
    prompt: Review the change.
    scorers: [quality, coverage]
`;

const SHIP = `schemaVersion: v1alpha1
name: ship
description: Deliver a change.
steps:
  - id: change
    prompt: Paginate /users.
    workspace: new
    deliver: pr
    scorers: { names: [clarity, delivered], batch: true }
`;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-verbs-')));
  mocks.home = path.join(root, 'home');
  fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
  vi.stubEnv('HOME', mocks.home);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A team with `workflows` and `scorers`, synced, and a checkout with one commit. */
async function team(workflows: Record<string, string>, scorers: Record<string, string>): Promise<LocalConfig> {
  const checkout = path.join(root, 'app');
  fs.mkdirSync(checkout, { recursive: true });
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.email', 't@example.com');
  git(checkout, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(checkout, 'users.ts'), 'export const users = () => all();\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-qm', 'base');
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  for (const [name, text] of Object.entries(workflows)) fs.writeFileSync(path.join(knowledge, 'workflows', `${name}.yaml`), text);
  for (const [name, text] of Object.entries(scorers)) fs.writeFileSync(path.join(knowledge, 'scorers', `${name}.md`), text);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: checkout, dataHome: path.join(root, 'data'),
  };
  await syncScorersThenWorkflows(config);
  return config;
}

const LeaseSchema = z.object({ attempt: z.string(), revision: z.number(), step: z.string() });

/** A Claude session `sessionId` in `cwd`, with one prompt. */
function plantSession(cwd: string, sessionId: string, text: string): void {
  const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(project, { recursive: true });
  const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`),
    line({ type: 'user', uuid: 'u1', parentUuid: null, cwd, timestamp: '2026-11-03T09:00:00.000Z', message: { role: 'user', content: text } })
    + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, timestamp: '2026-11-03T09:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Reviewed.' }] } }));
}

/** A run of `review` whose one pass succeeded in session `session-review`, as a driver reports it. */
async function reviewedRun(config: LocalConfig, session = 'session-review'): Promise<string> {
  const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config), checkout: config.projectRoot })).run);
  const lease = LeaseSchema.parse(data(await leaseNext(config, runId, external)).lease);
  if (session === 'session-review') plantSession(config.projectRoot ?? '', session, 'Review the change.');
  data(await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: external, tool: 'claude', session }));
  return runId;
}

/** A run of `ship` whose `change` pass committed a pagination, delivered in pull request 57 unless `failure` refused it. */
async function deliveredRun(config: LocalConfig, failure?: { code: 'protected_path'; message: string }): Promise<string> {
  const checkout = config.projectRoot ?? '';
  const from = git(checkout, 'rev-parse', 'HEAD');
  const runId = String(data(await startRun(config, 'ship', {}, { secrets: await knownSecrets(config), base: { ref: 'main', commit: from }, checkout })).run);
  const lease = LeaseSchema.extend({ workspace: z.object({ branch: z.string() }) })
    .parse(data(await leaseNext(config, runId, external, { can: { workspace: ['new', 'continue', 'read-only'] } })).lease);
  git(checkout, 'checkout', '-q', '-B', lease.workspace.branch, from);
  fs.writeFileSync(path.join(checkout, 'users.ts'), 'export const users = (page = 1) => all().slice((page - 1) * 50, page * 50);\n');
  git(checkout, 'commit', '-qam', 'paginate');
  const to = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', 'main');
  data(await reportAttempt(config, runId, {
    attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: external, tool: 'claude', changes: { branch: lease.workspace.branch, base: from, from, to, commits: [to] },
  }));
  await updateRun(config, runId, await knownSecrets(config), async (run) => (run === 'missing' ? { value: undefined } : { value: undefined, write: {
    ...run,
    steps: run.steps.map((step): StepState => (step.status !== 'delivering' ? step : failure ? { ...step, status: 'failed', outcome: 'failed', failure } : { ...step, status: 'succeeded', outcome: 'success' })),
    deliveries: failure ? [] : [{ url: PrUrlSchema.parse('https://github.com/acme/app/pull/57'), branch: lease.workspace.branch, base: 'main', step: 'change', pass: 1 }],
  } }));
  return runId;
}

/** What the external driver offers: a confined step at either level, on Claude, and the team workspace publish runs in. */
const JUDGING = { confined: [{ level: 'verified' as const, access: 'read' as const, tools: ['claude'] }], workspace: ['team' as const] };

/** A checkout of teamai-reports at origin's tip, holding `files`, as the place of a publish step is. */
function reportsTip(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(root, 'reports-'));
  git(dir, 'init', '-q', '-b', 'teamai-reports');
  for (const [file, text] of Object.entries({ '.gitignore': '', ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'tip');
  return dir;
}

/** What `dir` has staged against its tip, by file. */
function staged(dir: string): Record<string, string> {
  const files = git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  return Object.fromEntries(files.map((file) => [file, git(dir, 'show', `:${file}`)]));
}

interface Taken {
  ctx: ScoreVerbContext;
  attempt: string;
  revision: number;
}

interface ScoreRun {
  runId: string;
  /** The context of the attempt the engine leased next, for the step `step`. */
  next(step: string): Promise<Taken>;
  /** Reports what a verb answered as the attempt's outputs, or its failure, with what a confined run measured. */
  report(taken: Taken, answer: ScoreVerbAnswer, measured?: { confined?: ConfinedRunReport; tokens?: { input: number; output: number } }): Promise<void>;
}

/** A teamai-score run of `inputs`, started by `startedBy`, whose leases a test takes one by one. */
async function scoreRun(config: LocalConfig, inputs: Record<string, unknown>, startedBy: StartedBy = 'cli'): Promise<ScoreRun> {
  return runOf(config, String(data(await startRun(config, 'teamai-score', { scorers: [], label: '', batch: false, demand: 'auto', ...inputs }, { secrets: await knownSecrets(config), startedBy })).run));
}

/** Run `runId` of any workflow, whose leases a test takes one by one. */
function runOf(config: LocalConfig, runId: string): ScoreRun {
  return {
    runId,
    async next(step) {
      const lease = LeaseSchema.parse(data(await leaseNext(config, runId, external, step.endsWith('.judge') ? { can: JUDGING } : undefined)).lease);
      expect(lease.step).toBe(step);
      return { ctx: { env: attemptEnv(config, runId, lease.attempt, 'unattended'), current: config, now: NOW }, attempt: lease.attempt, revision: lease.revision };
    },
    async report({ attempt, revision }, answer, measured) {
      data(await reportAttempt(config, runId, answer.ok
        ? { attempt, revision, outcome: 'success', driver: external, outputs: answer.output, ...measured }
        : { attempt, revision, outcome: 'failed', driver: external, failure: { code: 'command_failed', message: answer.message }, ...measured?.tokens && { tokens: measured.tokens } }));
    },
  };
}

describe('score plan', () => {
  it('refuses a step of a workflow that is not teamai-score, and opens no mark', async () => {
    const config = await team({ fixes: FIXES }, { quality: scorer() });
    const run = runOf(config, String(data(await startRun(config, 'fixes', {}, { secrets: await knownSecrets(config), checkout: config.projectRoot })).run));
    const fix = await run.next('outer.fix');
    data(await reportAttempt(config, run.runId, { attempt: fix.attempt, revision: fix.revision, outcome: 'success', driver: external, tool: 'claude', session: 'session-fix' }));
    const lister = await run.next('outer.lister');

    expect(await ScoreVerbs.plan({ subject: `run:${run.runId}:outer.fix:1` }, lister.ctx)).toEqual({
      ok: false,
      code: 'score_attempt_required',
      message: expect.stringContaining(`step outer.lister of run ${run.runId} is not inside a teamai-score instance`),
    });
    expect(fs.existsSync(path.join(root, 'data', 'scores', 'marks.jsonl'))).toBe(false);
  });

  it('says why the run its attempt names cannot be found, rather than only that it is not here', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer() });
    const env = { TEAMAI_WORKFLOW_ATTEMPT: 'r0123456789abcdef/a01234567', TEAMAI_RUN_DIR: path.join(root, 'made-up') };

    expect(await ScoreVerbs.plan({ subject: 'run:r0123456789abcdef:review:1', scorers: '[]', batch: 'false', demand: 'auto' }, { env, current: config, now: NOW })).toEqual({
      ok: false,
      code: 'score_attempt_required',
      message: expect.stringContaining('run r0123456789abcdef is not on this machine (run_not_found: Run r0123456789abcdef was not found in the configured local scopes)'),
    });
  });

  it('refuses a call from a shell no teamai-score attempt runs, and opens no mark', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);

    expect(await ScoreVerbs.plan({ subject: `run:${runId}:review:1`, scorers: '[]', batch: 'false', demand: 'auto' }, { env: {}, current: config, now: NOW })).toEqual({
      ok: false,
      code: 'score_attempt_required',
      message: 'teamai score plan runs only as a step of a teamai-score run, in the attempt the engine leased it: TEAMAI_WORKFLOW_ATTEMPT and TEAMAI_RUN_DIR name no workflow attempt. Nothing was written.',
    });
    expect(fs.existsSync(path.join(root, 'data', 'scores', 'marks.jsonl'))).toBe(false);
  });

  it('gives each sampled scorer the pass\'s step pinned a group of its own', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const run = await scoreRun(config, { subject });
    const { ctx } = await run.next('plan');

    expect(await ScoreVerbs.plan({ subject, scorers: '[]', batch: 'false', demand: 'auto' }, ctx)).toEqual({ ok: true, output: { groups: [
      { subject, hand: '', scorers: 'quality', model: '', ci: false, protected: false },
      { subject, hand: '', scorers: 'coverage', model: '', ci: false, protected: false },
    ] } });
  });

  it('groups batched scorers by the stages they take: a scorer that does not wait for CI is judged apart from one that does', async () => {
    const config = await team({ ship: SHIP }, { clarity: scorer({ extra: 'stages: [protected]\n' }), delivered: scorer() });
    const runId = await deliveredRun(config);
    const subject = `run:${runId}:change:1`;
    const { ctx } = await (await scoreRun(config, { subject, batch: true })).next('plan');

    expect(await ScoreVerbs.plan({ subject, scorers: '[]', batch: 'true', demand: 'auto' }, ctx)).toEqual({ ok: true, output: { groups: [
      { subject, hand: '', scorers: 'clarity', model: '', ci: false, protected: true },
      { subject, hand: '', scorers: 'delivered', model: '', ci: true, protected: true },
    ] } });
  });

  it('keeps a scorer with a check apart on a delivered pass, and batches the rest', async () => {
    const config = await team({ ship: SHIP.replace('[clarity, delivered]', '[clarity, delivered, tests]') },
      { clarity: scorer(), delivered: scorer({ extra: 'check: { run: npm test, protect: [test] }\n' }), tests: scorer() });
    const runId = await deliveredRun(config);
    const subject = `run:${runId}:change:1`;
    const { ctx } = await (await scoreRun(config, { subject, batch: true })).next('plan');

    expect(await ScoreVerbs.plan({ subject, scorers: '[]', batch: 'true', demand: 'auto' }, ctx)).toMatchObject({ ok: true, output: { groups: [
      { scorers: 'clarity,tests', ci: true, protected: true },
      { scorers: 'delivered', ci: true, protected: true },
    ] } });
  });

  it('opens no mark for a scorer that does not sample the pass, and none twice for one another run holds', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer({ rate: 0 }), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const first = await (await scoreRun(config, { subject })).next('plan');
    const second = await (await scoreRun(config, { subject })).next('plan');

    expect(await ScoreVerbs.plan({ subject, scorers: '[]', batch: 'false', demand: 'auto' }, first.ctx)).toMatchObject({ ok: true, output: { groups: [{ scorers: 'coverage' }] } });
    expect(await ScoreVerbs.plan({ subject, scorers: '[]', batch: 'false', demand: 'auto' }, second.ctx)).toEqual({ ok: true, output: { groups: [] } });
  });

  it('counts a batch of scorers on one session once toward the daily limit, and past it plans nothing', async () => {
    const config = { ...await team({}, { quality: scorer(), coverage: scorer() }), scoring: { daily_limit: 1 } };
    const plan = async (subject: string, demand = 'auto') => ScoreVerbs.plan({ subject, scorers: '["quality","coverage"]', batch: 'true', demand },
      (await (await scoreRun(config, { subject, demand })).next('plan')).ctx);

    expect(await plan('session:claude-code:one')).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality,coverage' }] } });
    expect(await plan('session:claude-code:two')).toEqual({ ok: true, output: { groups: [] } });
    expect(await plan('session:claude-code:two', 'named')).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality,coverage' }] } });
  });

  it('takes every named scorer on a named demand, whatever it samples, of a session and of a pass', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer({ rate: 0 }), coverage: scorer({ rate: 0 }) });
    const planned = async (subject: string) => ScoreVerbs.plan({ subject, scorers: '["quality"]', batch: 'false', demand: 'named' },
      (await (await scoreRun(config, { subject, scorers: ['quality'], demand: 'named' })).next('plan')).ctx);

    expect(await planned('session:claude-code:one')).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality' }] } });
    expect(await planned(`run:${await reviewedRun(config)}:review:1`)).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality' }] } });
  });

  it('starts again only the scorer someone named, on an automatic demand, whatever it samples, judges sessions or the daily limit says', async () => {
    const config = { ...await team({ review: REVIEW }, { quality: scorer({ rate: 0 }), coverage: scorer({ rate: 0 }), sessq: scorer({ extra: 'sessions: true\n' }) }), scoring: { daily_limit: 1 } };
    const lapse = async (subject: string) => {
      const asked = await scoreRun(config, { subject, scorers: ['quality'], demand: 'named' });
      expect(await ScoreVerbs.plan({ subject, scorers: '["quality"]', batch: 'false', demand: 'named' }, (await asked.next('plan')).ctx)).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality' }] } });
      data(await cancelRun(config, asked.runId, await knownSecrets(config)));
    };
    const pass = `run:${await reviewedRun(config)}:review:1`;
    await lapse(pass);
    await lapse('session:claude-code:one');

    const listed = await ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now: NOW });

    expect(listed).toEqual({ ok: true, output: { list: [{ subject: pass, scorers: ['quality'] }, { subject: 'session:claude-code:one', scorers: ['quality'] }] } });
    for (const subject of [pass, 'session:claude-code:one']) {
      const { ctx } = await (await scoreRun(config, { subject, scorers: ['quality'] })).next('plan');
      expect(await ScoreVerbs.plan({ subject, scorers: '["quality"]', batch: 'false', demand: 'auto' }, ctx)).toEqual({ ok: true, output: { groups: [{ subject, hand: '', scorers: 'quality', model: '', ci: false, protected: false }] } });
    }
  });

  it('starts a lapsed session again with the scorers the team still has, once one of them was removed', async () => {
    const config = await team({}, { quality: scorer({ rate: 0 }), coverage: scorer({ rate: 0 }) });
    const subject = 'session:claude-code:one';
    const asked = await scoreRun(config, { subject, scorers: ['quality', 'coverage'], demand: 'named' });
    expect(await ScoreVerbs.plan({ subject, scorers: '["quality","coverage"]', batch: 'true', demand: 'named' }, (await asked.next('plan')).ctx)).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality,coverage' }] } });
    data(await cancelRun(config, asked.runId, await knownSecrets(config)));
    fs.rmSync(path.join(config.repo.localPath, 'scorers', 'coverage.md'));
    await syncScorersThenWorkflows(config);

    const listed = await ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now: NOW });

    expect(listed).toEqual({ ok: true, output: { list: [{ subject, scorers: ['quality'] }] } });
    const { ctx } = await (await scoreRun(config, { subject, scorers: ['quality'] })).next('plan');
    expect(await ScoreVerbs.plan({ subject, scorers: '["quality"]', batch: 'false', demand: 'auto' }, ctx)).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality' }] } });
  });

  it('judges a session automatically with each scorer that judges sessions and samples it, and only those', async () => {
    const config = await team({}, { quality: scorer({ extra: 'sessions: true\n' }), coverage: scorer({ rate: 0, extra: 'sessions: true\n' }), tests: scorer() });
    const subject = 'session:claude-code:one';
    const { ctx } = await (await scoreRun(config, { subject })).next('plan');

    expect(await ScoreVerbs.plan({ subject }, ctx)).toEqual({ ok: true, output: { groups: [{ subject, hand: '', scorers: 'quality', model: '', ci: false, protected: false }] } });
  });

  it('gives a group the model its scorer asks for', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer({ extra: 'model: gpt-5.4\n' }), coverage: scorer() });
    const subject = `run:${await reviewedRun(config)}:review:1`;
    const { ctx } = await (await scoreRun(config, { subject })).next('plan');

    expect(await ScoreVerbs.plan({ subject, scorers: '["quality"]' }, ctx)).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality', model: 'gpt-5.4' }] } });
  });

  it('groups batched scorers by the model they ask for, whichever judge tool this machine has, leaving the tool to the lease', async () => {
    const config = await team({ review: REVIEW.replace('[quality, coverage]', '[quality, coverage, tests]') }, { quality: scorer({ extra: 'model: fast\n' }), coverage: scorer(), tests: scorer({ extra: 'model: fast\n' }) });
    fs.mkdirSync(path.join(config.repo.localPath, 'models'));
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), 'aliases:\n  fast:\n    codex: gpt-6-mini\n');
    await syncScorersThenWorkflows(config);
    vi.stubEnv('PATH', ['/usr/bin', '/bin'].join(path.delimiter));
    const subject = `run:${await reviewedRun(config)}:review:1`;
    const { ctx } = await (await scoreRun(config, { subject, batch: true })).next('plan');

    expect(await ScoreVerbs.plan({ subject, scorers: '["quality","coverage","tests"]', batch: 'true' }, ctx)).toMatchObject({ ok: true, output: { groups: [
      { scorers: 'quality,tests', model: 'fast' },
      { scorers: 'coverage', model: '' },
    ] } });
  });

  it('keeps batched scorers that prefer another judge tool apart, so each judge call can run in the tool its scorers prefer', async () => {
    const config = await team({ review: REVIEW.replace('[quality, coverage]', '[quality, coverage, tests]') }, { quality: scorer({ extra: 'tool: codex\n' }), coverage: scorer(), tests: scorer({ extra: 'tool: codex\n' }) });
    const subject = `run:${await reviewedRun(config)}:review:1`;
    const { ctx } = await (await scoreRun(config, { subject, batch: true })).next('plan');

    expect(await ScoreVerbs.plan({ subject, scorers: '["quality","coverage","tests"]', batch: 'true' }, ctx)).toMatchObject({ ok: true, output: { groups: [
      { scorers: 'quality,tests' },
      { scorers: 'coverage' },
    ] } });
  });

  it('takes a hand label only from the label input of a run a person started, as one group with no stage', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const subject = 'session:claude-code:one';
    const options = { subject, scorers: '["quality"]', batch: 'false', demand: 'named' };
    const planAt = async (label: string, startedBy: StartedBy) => ScoreVerbs.plan(options, (await (await scoreRun(config, { subject, label, demand: 'named' }, startedBy)).next('plan')).ctx);

    expect(await planAt('good', 'cli')).toMatchObject({ ok: false, code: 'hand_label_refused' });
    expect(await planAt('great', 'person')).toEqual({ ok: false, code: 'label_invalid', message: '"great" is not a label of scorer quality. Use one of: good, bad.' });
    expect(fs.existsSync(path.join(root, 'data', 'scores', 'marks.jsonl'))).toBe(false);
    expect(await planAt('good', 'person')).toEqual({ ok: true, output: { groups: [{ subject, hand: 'good', scorers: 'quality', model: '', ci: false, protected: false }] } });
    expect(await planAt('', 'person')).toEqual({ ok: true, output: { groups: [{ subject, hand: '', scorers: 'quality', model: '', ci: false, protected: false }] } });
  });
});

describe('score plan asks a session\'s routing questions', () => {
  /** Session `one`, planted in the checkout, whose capture delivered the team skills `release` of `ops` and `review-notes`. */
  function deliveredSession(config: LocalConfig): void {
    plantSession(path.join(root, 'app'), 'one', 'Review this branch and cut a release.');
    const captures = path.join(config.dataHome ?? '', 'sessions', 'captures', 'claude-code', 'one');
    fs.mkdirSync(captures, { recursive: true });
    fs.writeFileSync(path.join(captures, '0b6f2a52-5d7e-4c7e-9a43-000000000001.json'), JSON.stringify({
      captureId: '0b6f2a52-5d7e-4c7e-9a43-000000000001', platform: 'claude-code', sessionId: 'one', capturedAt: '2026-11-03T09:00:00.000Z',
      agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, teamSkillInfo: { release: { namespace: 'ops' }, 'review-notes': {} },
    }));
  }

  const plan = async (config: LocalConfig, scorers: string[], batch = false) => ScoreVerbs.plan({ subject: 'session:claude-code:one', scorers: JSON.stringify(scorers), batch: String(batch), demand: scorers.length > 0 ? 'named' : 'auto' },
    (await (await scoreRun(config, { subject: 'session:claude-code:one', scorers, batch, demand: scorers.length > 0 ? 'named' : 'auto' })).next('plan')).ctx);

  it('puts every routing question in one group, apart from the team scorers without batch, while skill_routing is on', async () => {
    const config = await team({}, { quality: scorer({ extra: 'sessions: true\n' }) });
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'scoring.yaml'), 'skill_routing: true\n');
    deliveredSession(config);

    expect(await plan(config, [])).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality' }, { scorers: 'teamai:routing:ops:release,teamai:routing:review-notes' }] } });
  });

  it('asks none while skill_routing is off', async () => {
    const config = await team({}, { quality: scorer({ extra: 'sessions: true\n' }) });
    deliveredSession(config);

    expect(await plan(config, [])).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality' }] } });
  });

  it('labels a routing question named on demand, whatever skill_routing says', async () => {
    const config = await team({}, {});
    deliveredSession(config);
    const { answers } = await walk(config, 'session:claude-code:one', { inputs: { scorers: ['teamai:routing:ops:release'], demand: 'named' }, judge: { answer: { label: 'fit', reasoning: 'It cut the release with it.' } } });

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'teamai:routing:ops:release', label: 'fit', code: '' }] } });
    expect(await LabelStore.local(config)).toEqual([expect.objectContaining({ scorer: 'teamai:routing:ops:release', label: 'fit', subject: { platform: 'claude-code', sessionId: 'one' } })]);
  });

  it('labels a routing question with the team\'s scorers/teamai-routing.md, which replaces teamai\'s rubric', async () => {
    const config = await team({}, { 'teamai-routing': `---
labels:
  - { value: helped, score: 1, description: "{{ skill.name }} did what the session asked of it." }
  - { value: noise, score: 0, description: "{{ skill.name }} was loaded and did nothing." }
passingScore: 1
---
Judge only {{ skill.name }}.
` });
    deliveredSession(config);
    const { answers } = await walk(config, 'session:claude-code:one', { inputs: { scorers: ['teamai:routing:review-notes'], demand: 'named' }, judge: { answer: { label: 'helped', reasoning: 'It wrote the notes.' } } });

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'teamai:routing:review-notes', label: 'helped', code: '' }] } });
  });

  it('refuses a routing name that names no skill the session delivered, and says which it did', async () => {
    const config = await team({}, {});
    deliveredSession(config);

    expect(await plan(config, ['teamai:routing:deploy'])).toEqual({ ok: false, code: 'scorer_not_found',
      message: 'Scorer teamai:routing:deploy is not a routing question of session:claude-code:one. It names no team skill in this session\'s skills.available: teamai:routing:ops:release, teamai:routing:review-notes.' });
  });
});

/** A team's scorers/teamai-adoption.md, as the design's example writes it. */
const ADOPTION_OVERRIDE = `---
labels:
  - { value: used, score: 1, description: "The final reply used {{ doc.id }} to decide or to write code." }
  - { value: unused, score: 0, description: "Nothing in the final reply depends on {{ doc.id }}." }
passingScore: 1
sessions: true
---
Judge only {{ doc.id }}. Its text is in recalled/{{ doc.file }} in the evidence.
`;

describe('score plan asks a session\'s adoption questions (#1391)', () => {
  const RECALLED = ['pod-startup', 'helm-values', 'retry-policy'];
  const adoption = (doc: string): string => `teamai:adoption:${createHash('sha256').update(doc).digest('hex').slice(0, 12)}`;
  const docPath = (config: LocalConfig, doc: string): string => path.join(config.repo.localPath, 'docs', `${doc}.md`);

  /** Session `one`, whose recall returned the three team docs an hour before NOW, of which it opened `opened`. */
  function recalledSession(config: LocalConfig, opened: readonly string[] = ['helm-values']): void {
    plantSession(path.join(root, 'app'), 'one', 'Why do the pods restart on startup?');
    fs.mkdirSync(path.join(config.repo.localPath, 'docs'), { recursive: true });
    for (const doc of RECALLED) fs.writeFileSync(docPath(config, doc), `---\ntitle: ${doc}\n---\nWhat the team knows about ${doc}.\n`);
    const docs = RECALLED.map((doc) => ({ key: doc, scope: 'project', path: docPath(config, doc), score: 1, eligible: true }));
    const lines = [
      { kind: 'run', ts: '2026-11-03T09:00:00.000Z', run: 'run-1', session: 'one', via: 'env', unambiguous: true, docs },
      ...opened.map((doc, at) => ({ kind: 'evidence', ts: '2026-11-03T09:01:00.000Z', id: `ev-${at}`, session: 'one', path: docPath(config, doc), status: 'success', simple: true })),
    ];
    fs.mkdirSync(path.dirname(recallLogPath(config)), { recursive: true });
    fs.appendFileSync(recallLogPath(config), lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  }

  const plan = async (config: LocalConfig, scorers: string[]) => ScoreVerbs.plan({ subject: 'session:claude-code:one', scorers: JSON.stringify(scorers), batch: 'false', demand: scorers.length > 0 ? 'named' : 'auto' },
    (await (await scoreRun(config, { subject: 'session:claude-code:one', scorers, demand: scorers.length > 0 ? 'named' : 'auto' })).next('plan')).ctx);

  it('asks one question per recalled doc the session never opened, in one group, while recall_adoption is on', async () => {
    const config = await team({}, {});
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'scoring.yaml'), 'recall_adoption: true\n');
    recalledSession(config);

    expect(await plan(config, [])).toMatchObject({ ok: true, output: { groups: [{ scorers: `${adoption('pod-startup')},${adoption('retry-policy')}` }] } });
  });

  it('asks none while recall_adoption is off', async () => {
    const config = await team({}, {});
    recalledSession(config);

    expect(await plan(config, [])).toMatchObject({ ok: true, output: { groups: [] } });
  });

  /** A team with recall_adoption on, whose session `one` recalled the three docs and opened helm-values. */
  async function adopting(): Promise<LocalConfig> {
    const config = await team({}, {});
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'scoring.yaml'), 'recall_adoption: true\n');
    recalledSession(config);
    return config;
  }

  const verdicts = { [adoption('pod-startup')]: { label: 'adopted', reasoning: 'The reply raised the probe delay as the doc says.' }, [adoption('retry-policy')]: { label: 'ignored', reasoning: 'Nothing retried.' } };
  const votesOf = async (config: LocalConfig) => (await readUserVotes(path.join(getVotesDir(config), 'tester.yaml'))).votes;

  it('upvotes a doc an adopted label names, as a judge upvote within the total, and counts an ignored one judged', async () => {
    const config = await adopting();
    await walk(config, 'session:claude-code:one', { judge: { answer: verdicts } });

    const votes = await votesOf(config);
    expect(votes['pod-startup']).toMatchObject({ upvoted_count: 1, judge_upvoted_count: 1, judged_count: 1 });
    expect(votes['retry-policy']).toMatchObject({ upvoted_count: 0, judged_count: 1 });
    expect(votes['helm-values']?.judged_count).toBeUndefined();
    expect((await LabelStore.local(config)).map((stored) => [stored.scorer, stored.label])).toEqual([[adoption('pod-startup'), 'adopted'], [adoption('retry-policy'), 'ignored']]);
  });

  it('gives the judge each recalled doc as plan read it, beside the transcript', async () => {
    const config = await adopting();
    const asPlanned = fs.readFileSync(docPath(config, 'pod-startup'), 'utf8');
    const file = `recalled/${createHash('sha256').update('pod-startup').digest('hex').slice(0, 12)}.md`;
    const seen: { recalled?: string; prompt?: string } = {};

    // The run's scratch directory is removed when it ends, so the judge's files are read while it runs.
    await walk(config, 'session:claude-code:one', { judge: { answer: verdicts }, after: {
      plan: async () => fs.writeFileSync(docPath(config, 'pod-startup'), 'Rewritten since.\n'),
      'score[0].evidence': async (answers) => {
        const evidence = answers.get('score[0].evidence');
        const dir = evidence?.ok ? String(evidence.output.dir) : '';
        seen.recalled = fs.readFileSync(path.join(dir, file), 'utf8');
        seen.prompt = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8');
      },
    } });

    expect(seen.recalled).toBe(asPlanned);
    expect(seen.prompt).toContain(file);
  });

  it('credits a passing label of the team\'s scorers/teamai-adoption.md, which replaces teamai\'s rubric', async () => {
    const config = await team({}, { 'teamai-adoption': ADOPTION_OVERRIDE });
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'scoring.yaml'), 'recall_adoption: true\n');
    recalledSession(config);
    await walk(config, 'session:claude-code:one', { judge: { answer: { [adoption('pod-startup')]: { label: 'used', reasoning: 'It did.' }, [adoption('retry-policy')]: { label: 'unused', reasoning: 'No.' } } } });

    expect((await votesOf(config))['pod-startup']).toMatchObject({ upvoted_count: 1, judge_upvoted_count: 1, judged_count: 1 });
    expect((await LabelStore.local(config)).map(({ label }) => label)).toEqual(['used', 'unused']);
  });

  it('asks nothing of a recalled doc it cannot read under the knowledge roots', async () => {
    const config = await adopting();
    const outside = path.join(root, 'elsewhere.md');
    fs.writeFileSync(outside, 'Not team knowledge.\n');
    const run = { kind: 'run', ts: '2026-11-03T09:05:00.000Z', run: 'run-2', session: 'one', via: 'env', unambiguous: true, docs: [{ key: 'elsewhere', scope: 'project', path: outside, score: 1, eligible: true }] };
    fs.appendFileSync(recallLogPath(config), `${JSON.stringify(run)}\n`);

    expect(await plan(config, [])).toMatchObject({ ok: true, output: { groups: [{ scorers: `${adoption('pod-startup')},${adoption('retry-policy')}` }] } });
  });

  it('credits a session\'s doc once, however often the session is judged again', async () => {
    const config = await adopting();
    await walk(config, 'session:claude-code:one', { judge: { answer: verdicts } });
    const again = { inputs: { scorers: [adoption('pod-startup'), adoption('retry-policy')], demand: 'named' }, judge: { answer: { [adoption('pod-startup')]: { label: 'adopted', reasoning: 'Again.' }, [adoption('retry-policy')]: { label: 'adopted', reasoning: 'Now it did.' } } } };
    await walk(config, 'session:claude-code:one', again);

    const votes = await votesOf(config);
    expect(votes['pod-startup']).toMatchObject({ upvoted_count: 1, judge_upvoted_count: 1, judged_count: 1 });
    expect(votes['retry-policy']).toMatchObject({ upvoted_count: 0, judged_count: 1 });
  });

  it('asks nothing again of a doc the session was credited for, even under a new rubric', async () => {
    const config = await adopting();
    await walk(config, 'session:claude-code:one', { judge: { answer: verdicts } });
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'teamai-adoption.md'), ADOPTION_OVERRIDE);
    await syncScorersThenWorkflows(config);

    expect(await plan(config, [])).toMatchObject({ ok: true, output: { groups: [] } });
  });

  it('blocks a later read\'s credit of a doc a label credited in the session', async () => {
    const config = await adopting();
    await walk(config, 'session:claude-code:one', { judge: { answer: verdicts } });
    fs.appendFileSync(recallLogPath(config), `${JSON.stringify({ kind: 'evidence', ts: '2026-11-03T09:30:00.000Z', id: 'ev-late', session: 'one', path: docPath(config, 'retry-policy'), status: 'success', simple: true })}\n`);
    await creditAdoptedDocs(config, 'one');

    expect((await votesOf(config))['retry-policy']).toMatchObject({ upvoted_count: 0, judged_count: 1 });
  });

  it('keeps the credit of a label written while the votes file is busy, and writes it once at pull', async () => {
    const config = await adopting();
    const lock = `${path.join(getVotesDir(config), 'tester.yaml')}.lock`;
    fs.mkdirSync(getVotesDir(config), { recursive: true });
    expect(await acquireLock(lock)).toBe(true);
    try {
      const { answers } = await walk(config, 'session:claude-code:one', { judge: { answer: verdicts } });
      expect(answers.get('score[0].write')).toMatchObject({ ok: true });
    } finally {
      await releaseLock(lock);
    }
    expect((await votesOf(config))['pod-startup']?.judge_upvoted_count).toBeUndefined();

    await drainRecallLog(config);
    await drainRecallLog(config);
    expect((await votesOf(config))['pod-startup']).toMatchObject({ upvoted_count: 1, judge_upvoted_count: 1, judged_count: 1 });
  }, 30_000);
});

/** Plans `subject` in a new teamai-score run, reports the plan, and leases the first group's evidence step. */
const NESTED = `schemaVersion: v1alpha1
name: nested
description: Fix in an inline workflow, then mend in a workflow file.
defaults: { scorers: { batch: true } }
steps:
  - id: outer
    workflow:
      steps:
        - id: fix
          prompt: Fix the change.
          scorers: [quality, coverage]
  - id: filed
    needs: [outer]
    workflow: inner
`;
const INNER = `schemaVersion: v1alpha1
name: inner
description: Mend the change.
defaults: { scorers: { batch: false } }
steps:
  - id: mend
    prompt: Mend the change.
    scorers: [quality, coverage]
`;

describe('score plan reads the workflow a step is in', () => {
  it('batches the scorers of a step whose workflow sets defaults.scorers.batch', async () => {
    const config = await team({ review: REVIEW.replace('steps:', 'defaults: { scorers: { batch: true } }\nsteps:') }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const { ctx } = await (await scoreRun(config, { subject })).next('plan');

    expect(await ScoreVerbs.plan({ subject, scorers: '[]', batch: 'false', demand: 'auto' }, ctx)).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality,coverage' }] } });
  });

  it('batches a step of an inline workflow as the workflow around it says, and one of a workflow file as that file says', async () => {
    const config = await team({ nested: NESTED, inner: INNER }, { quality: scorer(), coverage: scorer() });
    const runId = String(data(await startRun(config, 'nested', {}, { secrets: await knownSecrets(config), checkout: config.projectRoot })).run);
    const steps: string[] = [];
    for (const session of ['session-fix', 'session-mend']) {
      const lease = LeaseSchema.parse(data(await leaseNext(config, runId, external)).lease);
      steps.push(lease.step);
      data(await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: external, tool: 'claude', session }));
    }
    const planned = async (step: string) => {
      const subject = `run:${runId}:${step}:1`;
      const { ctx } = await (await scoreRun(config, { subject })).next('plan');
      return ScoreVerbs.plan({ subject }, ctx);
    };

    expect(steps).toEqual(['outer.fix', 'filed.mend']);
    expect(await planned('outer.fix')).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality,coverage' }] } });
    expect(await planned('filed.mend')).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality' }, { scorers: 'coverage' }] } });
  });

  it('labels by hand in a teamai-score instance a step of another workflow runs, from that instance\'s label input', async () => {
    const rescore = `schemaVersion: v1alpha1
name: rescore
description: Label a subject again by hand.
inputs:
  subject: string
steps:
  - id: again
    workflow: teamai-score
    with: { subject: "{{ inputs.subject }}", scorers: [quality], label: good, batch: false, demand: named }
`;
    const config = await team({ review: REVIEW, rescore }, { quality: scorer(), coverage: scorer() });
    const subject = `run:${await reviewedRun(config)}:review:1`;
    const run = runOf(config, String(data(await startRun(config, 'rescore', { subject }, { secrets: await knownSecrets(config), startedBy: 'person' })).run));
    const plan = await run.next('again.plan');
    const planned = await ScoreVerbs.plan({ subject, scorers: '["quality"]', demand: 'named' }, plan.ctx);

    expect(planned).toMatchObject({ ok: true, output: { groups: [{ hand: 'good', scorers: 'quality', ci: false, protected: false }] } });
    await run.report(plan, planned);
    const evidence = await run.next('again.score[0].evidence');
    const written = await ScoreVerbs.evidence({ subject, scorers: 'quality' }, evidence.ctx);

    expect(written).toMatchObject({ ok: true, output: { rubric: '', schema: '', delivers: false } });
    await run.report(evidence, written);
    const label = await run.next('again.score[0].label');
    const dir = z.object({ dir: z.string() }).parse(written.ok ? written.output : {}).dir;

    expect(await ScoreVerbs.label({ evidence: dir, answer: '', judge: '' }, label.ctx)).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: 'good', code: '' }] } });
  });

  it('refuses a named scorer on a pass of a run whose steps list none', async () => {
    const config = await team({ review: REVIEW.replace('    scorers: [quality, coverage]\n', '') }, { quality: scorer() });
    const subject = `run:${await reviewedRun(config)}:review:1`;
    const { ctx } = await (await scoreRun(config, { subject })).next('plan');

    expect(await ScoreVerbs.plan({ subject, scorers: 'quality', demand: 'named' }, ctx)).toMatchObject({ ok: false, code: 'scorer_not_found', message: expect.stringContaining('at the team revision it started from') });
  });

  it('judges every pass of a step that samples all, whatever its scorers sample', async () => {
    const config = await team({ review: REVIEW.replace('scorers: [quality, coverage]', 'scorers: { names: [quality], sampling: all }') }, { quality: scorer({ rate: 0 }), coverage: scorer() });
    const subject = `run:${await reviewedRun(config)}:review:1`;
    const { ctx } = await (await scoreRun(config, { subject })).next('plan');

    expect(await ScoreVerbs.plan({ subject }, ctx)).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality' }] } });
  });
});

async function plannedGroup(config: LocalConfig, subject: string, inputs: Record<string, unknown> = {}, startedBy: StartedBy = 'cli'): Promise<{ run: ScoreRun; evidence: Taken; scorers: string }> {
  const run = await scoreRun(config, { subject, ...inputs }, startedBy);
  const plan = await run.next('plan');
  const planned = await ScoreVerbs.plan({ subject, scorers: JSON.stringify(inputs.scorers ?? []), batch: String(inputs.batch ?? false), demand: String(inputs.demand ?? 'auto') }, plan.ctx);
  await run.report(plan, planned);
  const groups = z.object({ groups: z.array(z.object({ scorers: z.string() })) }).parse(planned.ok ? planned.output : {});
  return { run, evidence: await run.next('score[0].evidence'), scorers: groups.groups[0]?.scorers ?? '' };
}

describe('marks of a score run that ended', () => {
  it('counts no lapse when the run ended before its judge was leased, and one once a judge attempt ran', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const key: MarkKey = { scorer: 'quality', subject: { kind: 'run', subject: { runId, step: 'review', pass: 1 } } };
    const states = async () => Marks.states(config, [key], markFacts(config, new Date().toISOString()));
    /** A score run of `quality` planned now, so its mark's 14 days start from now. */
    const planned = async () => {
      const run = await scoreRun(config, { subject, scorers: ['quality'] });
      const plan = await run.next('plan');
      await run.report(plan, await ScoreVerbs.plan({ subject, scorers: '["quality"]', batch: 'false', demand: 'auto' }, { ...plan.ctx, now: new Date().toISOString() }));
      return run;
    };

    const unjudged = await planned();
    data(await cancelRun(config, unjudged.runId, await knownSecrets(config)));
    expect(await states()).toEqual([{ kind: 'lapsed', lapses: 0 }]);

    const judged = await planned();
    const evidence = await judged.next('score[0].evidence');
    await judged.report(evidence, await ScoreVerbs.evidence({ subject, scorers: 'quality' }, evidence.ctx));
    await judged.next('score[0].judge');
    data(await cancelRun(config, judged.runId, await knownSecrets(config)));
    expect(await states()).toEqual([{ kind: 'lapsed', lapses: 1 }]);
  });

  it.each(['score[0]', 'score'])('counts a lapse for a judge attempt that ran before a retry of %s, which moved it to the archive', async (retried) => {
    const config = await team({ review: REVIEW }, { quality: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const key: MarkKey = { scorer: 'quality', subject: { kind: 'run', subject: { runId, step: 'review', pass: 1 } } };
    const run = await scoreRun(config, { subject, scorers: ['quality'] });
    const plan = await run.next('plan');
    await run.report(plan, await ScoreVerbs.plan({ subject, scorers: '["quality"]', batch: 'false', demand: 'auto' }, { ...plan.ctx, now: new Date().toISOString() }));
    const evidence = await run.next('score[0].evidence');
    await run.report(evidence, await ScoreVerbs.evidence({ subject, scorers: 'quality' }, evidence.ctx));
    await run.next('score[0].judge');
    data(await cancelRun(config, run.runId, await knownSecrets(config)));

    data(await retryStep(config, run.runId, await knownSecrets(config), retried));
    data(await cancelRun(config, run.runId, await knownSecrets(config)));

    expect(await Marks.states(config, [key], markFacts(config, new Date().toISOString()))).toEqual([{ kind: 'lapsed', lapses: 1 }]);
  });

  it('counts a lapse once the judge of a teamai-score another workflow runs was leased', async () => {
    const SCORING = `schemaVersion: v1alpha1
name: scoring
description: Score a pass of review inside another workflow.
inputs: { subject: string }
steps:
  - id: share
    workflow: teamai-score
    with: { subject: "{{ inputs.subject }}", scorers: [quality], label: "", batch: false, demand: auto }
`;
    const config = await team({ review: REVIEW, scoring: SCORING }, { quality: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const key: MarkKey = { scorer: 'quality', subject: { kind: 'run', subject: { runId, step: 'review', pass: 1 } } };
    const run = runOf(config, String(data(await startRun(config, 'scoring', { subject }, { secrets: await knownSecrets(config), startedBy: 'cli' })).run));
    const plan = await run.next('share.plan');
    await run.report(plan, await ScoreVerbs.plan({ subject, scorers: '["quality"]', batch: 'false', demand: 'auto' }, { ...plan.ctx, now: new Date().toISOString() }));
    const evidence = await run.next('share.score[0].evidence');
    await run.report(evidence, await ScoreVerbs.evidence({ subject, scorers: 'quality' }, evidence.ctx));
    await run.next('share.score[0].judge');
    data(await cancelRun(config, run.runId, await knownSecrets(config)));

    expect(await Marks.states(config, [key], markFacts(config, new Date().toISOString()))).toEqual([{ kind: 'lapsed', lapses: 1 }]);
  });

  it('counts a lapse once a judge attempt ran for a batch that one already labelled scorer left smaller', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const keyOf = (name: string): MarkKey => ({ scorer: name, subject: { kind: 'run', subject: { runId, step: 'review', pass: 1 } } });
    await Marks.close(config, [keyOf('quality')], { kind: 'labelled' }, { now: new Date().toISOString() });

    const run = await scoreRun(config, { subject, scorers: ['quality', 'coverage'] });
    const plan = await run.next('plan');
    const planned = await ScoreVerbs.plan({ subject, scorers: '["quality","coverage"]', batch: 'true', demand: 'auto' }, { ...plan.ctx, now: new Date().toISOString() });
    expect(planned).toMatchObject({ ok: true, output: { groups: [{ scorers: 'coverage' }] } });
    await run.report(plan, planned);
    const evidence = await run.next('score[0].evidence');
    await run.report(evidence, await ScoreVerbs.evidence({ subject, scorers: 'coverage' }, evidence.ctx));
    await run.next('score[0].judge');
    data(await cancelRun(config, run.runId, await knownSecrets(config)));

    expect(await Marks.states(config, [keyOf('coverage')], markFacts(config, new Date().toISOString()))).toEqual([{ kind: 'lapsed', lapses: 1 }]);
  });
});

describe('score evidence', () => {
  it('writes the evidence of a pass into the attempt\'s own directory, hashed', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer({ extra: 'isolation: verified\n' }) });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const { run, evidence, scorers } = await plannedGroup(config, subject, { scorers: ['coverage'] });
    const dir = path.join(runScratchDir(config, run.runId), evidence.attempt);

    expect(await ScoreVerbs.evidence({ subject, scorers }, evidence.ctx)).toEqual({ ok: true, output: {
      dir, rubric: expect.stringContaining('Judge the work.'), schema: path.join(dir, 'answer.schema.json'), delivers: false,
    } });
    expect(await evidenceHash(dir)).toMatch(/^sha256:/);
    expect(await checkConfinedDir({ step: 'judge', runDir: runScratchDir(config, run.runId), dir })).toEqual({ ok: true, place: {
      dir: fs.realpathSync(dir), level: 'verified', prefer: 'claude', schema: fs.realpathSync(path.join(dir, 'reply.schema.json')),
    } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'reply.schema.json'), 'utf8'))).toEqual({
      type: 'object', properties: { answer: JSON.parse(fs.readFileSync(path.join(dir, 'answer.schema.json'), 'utf8')) }, required: ['answer'], additionalProperties: false,
    });
  });

  it('asks the judge for the tool its scorer prefers, then the tool the pass ran in', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer({ extra: 'tool: codex\n' }), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const { run, evidence, scorers } = await plannedGroup(config, subject, { scorers: ['quality'] });
    const written = await ScoreVerbs.evidence({ subject, scorers }, evidence.ctx);
    const dir = z.object({ dir: z.string() }).parse(written.ok ? written.output : {}).dir;

    expect(await checkConfinedDir({ step: 'judge', runDir: runScratchDir(config, run.runId), dir })).toMatchObject({ ok: true, place: { prefer: ['codex', 'claude'] } });
  });

  it('refuses with evidence_missing when a session the pass recorded is gone, and writes no evidence', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config, 'session-gone');
    const subject = `run:${runId}:review:1`;
    const { run, evidence, scorers } = await plannedGroup(config, subject);

    expect(await ScoreVerbs.evidence({ subject, scorers }, evidence.ctx)).toMatchObject({ ok: false, code: 'evidence_missing', message: expect.stringContaining('session-gone') });
    expect(fs.existsSync(path.join(runScratchDir(config, run.runId), evidence.attempt))).toBe(false);
  });
});

/** `config`'s team files as a member's git checkout of a team origin, with one pushed commit. */
async function pushedTeam(config: LocalConfig): Promise<{ config: LocalConfig; edit(text: string): void; push(): void }> {
  const knowledge = config.repo.localPath;
  const origin = path.join(root, 'team-origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(knowledge, 'init', '-q', '-b', 'main');
  git(knowledge, 'remote', 'add', 'origin', origin);
  const push = (): void => {
    git(knowledge, 'add', '-A');
    git(knowledge, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'team');
    git(knowledge, 'push', '-q', '-u', 'origin', 'main');
  };
  push();
  const member: LocalConfig = { ...config, repo: { localPath: knowledge, remote: origin } };
  await syncScorersThenWorkflows(member);
  return { config: member, edit: (text) => fs.writeFileSync(path.join(knowledge, 'scorers', 'quality.md'), text), push };
}

/** The team commit run `runId` started from, and the commit a label of its scorer `name` records, when it records one. */
async function revisionsOf(config: LocalConfig, runId: string, name: string): Promise<{ pinned?: string; labelled?: string }> {
  const run = await readRun(config, runId);
  if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
  const read = await RunScorers.of(config, run);
  return { pinned: run.teamPin?.revision, labelled: read.ok ? read.pins[name]?.teamRevision : read.reason };
}

/** The rubric `score evidence` gives the judge of pass 1 of `review` in run `runId`. */
async function rubricOf(config: LocalConfig, runId: string): Promise<string> {
  const subject = `run:${runId}:review:1`;
  const { evidence, scorers } = await plannedGroup(config, subject);
  const written = await ScoreVerbs.evidence({ subject, scorers }, evidence.ctx);
  return z.object({ rubric: z.string() }).parse(written.ok ? written.output : { rubric: `${written.code}: ${written.message}` }).rubric;
}

describe('the rubric a pass is judged by is the one its run started with', () => {
  const REVIEW_ONE = REVIEW.replace('[quality, coverage]', '[quality]');

  it('judges an open run\'s pass with the rubric it started with after an edit is pushed and pulled, and the next run\'s with the edit', async () => {
    const { config, edit, push } = await pushedTeam(await team({ review: REVIEW_ONE }, { quality: scorer() }));
    const open = await reviewedRun(config);
    edit(scorer().replace('Judge the work.', 'Judge the tests first.'));
    push();
    await syncScorersThenWorkflows(config);
    const next = await reviewedRun(config);

    const opened = await rubricOf(config, open);

    expect(opened).toContain('Judge the work.');
    expect(opened).not.toContain('Judge the tests first.');
    expect(await rubricOf(config, next)).toContain('Judge the tests first.');
    for (const runId of [open, next]) {
      const { pinned, labelled } = await revisionsOf(config, runId, 'quality');
      expect(labelled).toBe(pinned);
    }
  });

  it('judges with an edit the checkout had not committed when the run started, and not with one made after', async () => {
    const { config, edit } = await pushedTeam(await team({ review: REVIEW_ONE }, { quality: scorer() }));
    edit(scorer().replace('Judge the work.', 'Judge the uncommitted rubric.'));
    const stdout = vi.spyOn(console, 'log');
    const runId = await reviewedRun(config);
    edit(scorer().replace('Judge the work.', 'Judge a later rubric.'));
    const rubric = await rubricOf(config, runId);
    const printed = stdout.mock.calls.flat().join('\n');
    stdout.mockRestore();

    expect(rubric).toContain('Judge the uncommitted rubric.');
    // The commit does not hold these bytes, so the label names none; and reading at the pin prints nothing on stdout.
    expect(await revisionsOf(config, runId, 'quality')).toEqual({ pinned: expect.stringMatching(/^[0-9a-f]{40}$/), labelled: undefined });
    expect(printed).not.toContain('team commit');
  });
});

/** A planned group of a delivered pass, its evidence written and reported, and the lease of its next step. */
async function deliveredGroup(config: LocalConfig, runId: string): Promise<{ run: ScoreRun; dir: string; next: Taken }> {
  const subject = `run:${runId}:change:1`;
  const { run, evidence, scorers } = await plannedGroup(config, subject);
  const written = await ScoreVerbs.evidence({ subject, scorers }, evidence.ctx);
  await run.report(evidence, written);
  const dir = z.object({ dir: z.string() }).parse(written.ok ? written.output : {}).dir;
  return { run, dir, next: await run.next('score[0].check') };
}

describe('score stage', () => {
  it('check runs nothing and decides nothing when no scorer of the group has a check', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const { dir, next } = await deliveredGroup(config, await deliveredRun(config));

    expect(await ScoreVerbs.stage({ stage: 'check', evidence: dir }, next.ctx)).toEqual({ ok: true, output: { decided: false } });
    expect(fs.existsSync(path.join(dir, 'stage-check.json'))).toBe(false);
  });

  it.each([
    ['a check that fails decides the group by check', 'exit 3', { kind: 'decided', by: 'check', reasoning: expect.stringContaining('`exit 3` exited 3') }],
    ['a check that cannot run is terminal, as check_could_not_run', 'exit 127', { kind: 'unrunnable', message: expect.stringContaining('could not run') }],
  ])('%s', async (_case, run, record) => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[delivered]') }, { delivered: scorer({ extra: `check: { run: "${run}", protect: [test] }\n` }) });
    const { dir, next } = await deliveredGroup(config, await deliveredRun(config));

    expect(await ScoreVerbs.stage({ stage: 'check', evidence: dir }, next.ctx)).toEqual({ ok: true, output: { decided: true } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stage-check.json'), 'utf8'))).toEqual(record);
  });

  it('ci reads the CI of the delivered commit once for the run, and a failed one decides', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const { dir, next } = await deliveredGroup(config, await deliveredRun(config));
    mocks.ci.mockResolvedValue({ kind: 'read', status: 'failed' });

    expect(await ScoreVerbs.stage({ stage: 'ci', evidence: dir, wait: '2h' }, next.ctx)).toEqual({ ok: true, output: { decided: true, pending: false } });
    expect(await ScoreVerbs.stage({ stage: 'ci', evidence: dir, wait: '2h' }, next.ctx)).toEqual({ ok: true, output: { decided: true, pending: false } });
    expect(mocks.ci).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stage-ci.json'), 'utf8'))).toEqual({ kind: 'decided', by: 'ci', reasoning: expect.stringContaining('pull/57 failed') });
  });

  it('ci that has not finished writes a pending record until --wait has passed, then is judged as no CI', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const { dir, next } = await deliveredGroup(config, await deliveredRun(config));
    mocks.ci.mockResolvedValue({ kind: 'read', status: 'pending' });

    expect(await ScoreVerbs.stage({ stage: 'ci', evidence: dir, wait: '2h' }, next.ctx)).toEqual({ ok: true, output: { decided: false, pending: true } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stage-ci.json'), 'utf8'))).toMatchObject({ kind: 'pending' });
    expect(await ScoreVerbs.stage({ stage: 'ci', evidence: dir, wait: '2h' }, { ...next.ctx, now: '2026-11-03T11:59:59.999Z' })).toEqual({ ok: true, output: { decided: false, pending: true } });
    expect(await ScoreVerbs.stage({ stage: 'ci', evidence: dir, wait: '2h' }, { ...next.ctx, now: '2026-11-03T12:00:00.000Z' })).toEqual({ ok: true, output: { decided: false, pending: false } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stage-ci.json'), 'utf8'))).toEqual({ kind: 'judge' });
  });

  it('ci without --wait reads a CI that has not finished as no CI', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const { dir, next } = await deliveredGroup(config, await deliveredRun(config));
    mocks.ci.mockResolvedValue({ kind: 'read', status: 'pending' });

    expect(await ScoreVerbs.stage({ stage: 'ci', evidence: dir }, next.ctx)).toEqual({ ok: true, output: { decided: false, pending: false } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stage-ci.json'), 'utf8'))).toEqual({ kind: 'judge' });
  });

  it('protected decides a pass whose delivery refused a protected path', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const { dir, next } = await deliveredGroup(config, await deliveredRun(config, { code: 'protected_path', message: 'Step "change" changed protected paths against the run base: AGENTS.md.' }));

    expect(await ScoreVerbs.stage({ stage: 'protected', evidence: dir }, next.ctx)).toEqual({ ok: true, output: { decided: true } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stage-protected.json'), 'utf8'))).toEqual({ kind: 'decided', by: 'protected', reasoning: expect.stringContaining('AGENTS.md') });
  });

  it('decides nothing for a hand label of a delivered pass, whatever stage its workflow runs', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const subject = `run:${await deliveredRun(config, { code: 'protected_path', message: 'Step "change" changed protected paths against the run base: AGENTS.md.' })}:change:1`;
    const { evidence, scorers } = await plannedGroup(config, subject, { scorers: ['clarity'], label: 'bad', demand: 'named' }, 'person');
    const written = await ScoreVerbs.evidence({ subject, scorers }, evidence.ctx);
    const dir = z.object({ dir: z.string() }).parse(written.ok ? written.output : {}).dir;

    expect(written).toMatchObject({ ok: true, output: { rubric: '', delivers: false } });
    expect(await ScoreVerbs.stage({ stage: 'protected', evidence: dir }, evidence.ctx)).toEqual({ ok: true, output: { decided: false } });
    expect(await ScoreVerbs.stage({ stage: 'ci', evidence: dir }, evidence.ctx)).toEqual({ ok: true, output: { decided: false, pending: false } });
  });

  it('refuses a directory that is not an evidence directory of the attempt\'s run', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const { next } = await deliveredGroup(config, await deliveredRun(config));

    expect(await ScoreVerbs.stage({ stage: 'protected', evidence: root }, next.ctx)).toMatchObject({ ok: false, code: 'evidence_unreadable' });
  });

  it('refuses a group whose second scorer no longer parses', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const { evidence, scorers } = await plannedGroup(config, subject, { batch: true });
    const written = await ScoreVerbs.evidence({ subject, scorers }, evidence.ctx);
    const file = path.join(z.object({ dir: z.string() }).parse(written.ok ? written.output : {}).dir, 'group.json');
    const group = z.looseObject({ scorers: z.array(z.looseObject({ pin: z.looseObject({ content: z.string() }) })) }).parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    fs.writeFileSync(file, JSON.stringify({ ...group, scorers: group.scorers.map((each, index) => (index === 1 ? { ...each, pin: { ...each.pin, content: 'no frontmatter' } } : each)) }));

    expect(scorers).toBe('quality,coverage');
    expect(await ScoreVerbs.stage({ stage: 'protected', evidence: path.dirname(file) }, evidence.ctx)).toMatchObject({ ok: false, code: 'evidence_unreadable' });
  });

  it.each([
    ['a stage that is none', 'lint', undefined],
    ['a wait that is not a duration', 'ci', 'soon'],
  ])('refuses %s', async (_case, stage, wait) => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const { dir, next } = await deliveredGroup(config, await deliveredRun(config));

    expect(await ScoreVerbs.stage({ stage, evidence: dir, wait }, next.ctx)).toMatchObject({ ok: false, code: 'invalid_arguments' });
    expect(mocks.ci).not.toHaveBeenCalled();
  });
});

const JUDGED: ConfinedRunReport = { tool: 'claude', model: { requested: 'claude-x' }, usage: { inputTokens: 10, outputTokens: 2 }, isolation: 'verified', access: 'read' };

interface Walk {
  /** The judge step's answer, or a failure. */
  judge?: { answer: unknown } | 'failed';
  /** Whether the judge step's report records the confined run that answered; true by default. */
  confinedRecorded?: boolean;
  inputs?: Record<string, unknown>;
  startedBy?: StartedBy;
  /** What a step answers in place of its verb, by step id. */
  fake?: Record<string, ScoreVerbAnswer>;
  /** The checkout of teamai-reports each publish step runs in; a fresh one at an empty tip by default. */
  tip?: string;
  /** The ci step's `--wait`; 2h, as shipped, by default. */
  wait?: string;
  /** What happens on this machine once a step reported, by step path. */
  after?: Record<string, (answers: ReadonlyMap<string, ScoreVerbAnswer>) => Promise<void>>;
}

/**
 * Drives a teamai-score run of `subject` to its end, each step by its verb, and returns what each verb answered by step
 * path, and what the engine answered when the run ended.
 */
async function walk(config: LocalConfig, subject: string, { judge, confinedRecorded = true, inputs = {}, startedBy = 'cli', fake = {}, tip, wait = '2h', after = {} }: Walk = {}): Promise<{ runId: string; answers: Map<string, ScoreVerbAnswer>; ended: WorkflowEnvelope }> {
  const run = await scoreRun(config, { subject, ...inputs }, startedBy);
  const answers = new Map<string, ScoreVerbAnswer>();
  const items = (index: string) => {
    const plan = answers.get('plan');
    const groups = z.object({ groups: z.array(z.object({ subject: z.string(), scorers: z.string() })) }).safeParse(plan?.ok ? plan.output : {}).data?.groups ?? [];
    const evidence = answers.get(`score[${index}].evidence`);
    return { item: groups[Number(index)], dir: z.object({ dir: z.string() }).safeParse(evidence?.ok ? evidence.output : {}).data?.dir };
  };
  for (;;) {
    const leased = await leaseNext(config, run.runId, external, { can: JUDGING });
    const next = data(leased);
    if (next.done) return { runId: run.runId, answers, ended: leased };
    const lease = LeaseSchema.parse(next.lease);
    const taken = { ctx: { env: attemptEnv(config, run.runId, lease.attempt, 'unattended'), current: config, now: NOW }, attempt: lease.attempt, revision: lease.revision };
    const [, index = '0', id = lease.step] = /^score\[(\d+)\]\.(.+)$/u.exec(lease.step) ?? [];
    const { item, dir } = items(index);
    const judged = answers.get(`score[${index}].judge`);
    const answer: ScoreVerbAnswer = fake[id] ?? (id === 'plan'
      ? await ScoreVerbs.plan({ subject, scorers: JSON.stringify(inputs.scorers ?? []), batch: String(inputs.batch ?? false), demand: String(inputs.demand ?? 'auto') }, taken.ctx)
      : id === 'evidence' ? await ScoreVerbs.evidence({ subject: item?.subject, scorers: item?.scorers }, taken.ctx)
        : id === 'check' || id === 'ci' || id === 'protected' ? await ScoreVerbs.stage({ stage: id, evidence: dir, wait }, taken.ctx)
          : id === 'judge' ? (judge === 'failed' || judge === undefined ? { ok: false, code: 'judge_failed', message: 'The judge exited 1.' } : { ok: true, output: { answer: z.json().parse(judge.answer) } })
            : id === 'label' ? await ScoreVerbs.label({ evidence: dir, answer: judged?.ok ? JSON.stringify(judged.output.answer) : '', judge: judged === undefined ? '' : judged.ok ? 'success' : 'failed' }, taken.ctx)
              : id === 'write' ? await ScoreVerbs.write({ evidence: dir }, taken.ctx)
                : id === 'publish' ? await ScoreVerbs.publish({ ...taken.ctx, cwd: tip ?? reportsTip() })
                  : await ScoreVerbs.settle({ subject: item?.subject, scorers: item?.scorers }, taken.ctx));
    answers.set(lease.step, answer);
    // A confined run that failed reports what it spent as tokens, with no confined run, as the local driver does.
    await run.report(taken, answer, id === 'judge' ? (answer.ok ? (confinedRecorded ? { confined: JUDGED } : undefined) : { tokens: { input: 10, output: 2 } }) : undefined);
    await after[lease.step]?.(answers);
  }
}

const marksOf = async (config: LocalConfig, runId: string, scorers: string[]) =>
  Marks.states(config, scorers.map((name) => ({ scorer: name, subject: { kind: 'run' as const, subject: { runId, step: 'review', pass: 1 } } })), { now: NOW, readRun: async () => ({ ended: true, changedAt: NOW, judgeRan: () => true }) });

describe('score label and score write', () => {
  it('remove the evidence staged from a clone once every mark of its pass closed, and keep it while one waits for CI', async () => {
    const config = await team({ ship: SHIP }, { clarity: scorer({ extra: 'stages: [protected]\n' }), delivered: scorer() });
    const runId = await deliveredRun(config);
    const run = await readRun(config, runId);
    if (run === 'missing' || run === 'corrupt') throw new Error(run);
    const copy = await stageEvidence(config, run, { runId, step: 'change', pass: 1 }, { checkout: config.projectRoot ?? '', untrustedEnv: process.env });
    const judged = { judge: { answer: { label: 'good', reasoning: 'ok' } }, inputs: { batch: true } };

    expect(copy !== undefined && fs.existsSync(copy)).toBe(true);
    mocks.ci.mockResolvedValue({ kind: 'read', status: 'pending' });
    expect((await walk(config, `run:${runId}:change:1`, judged)).answers.get('score[1].label')).toMatchObject({ ok: true, output: { labels: [{ scorer: 'delivered', code: 'ci_pending' }] } });
    expect(fs.existsSync(copy ?? '')).toBe(true);
    mocks.ci.mockResolvedValue({ kind: 'read', status: 'passed' });
    expect((await walk(config, `run:${runId}:change:1`, judged)).answers.get('score[0].label')).toMatchObject({ ok: true, output: { labels: [{ scorer: 'delivered' }] } });
    expect(fs.existsSync(copy ?? '')).toBe(false);
  });

  it('keep the evidence staged from a clone while a scorer its step lists has no mark yet, so a later run judges it', async () => {
    const config = await team({}, { clarity: scorer(), coverage: scorer() });
    const checkout = config.projectRoot ?? '';
    const from = git(checkout, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'trial.yaml'), `schemaVersion: v1alpha1
name: trial
description: Try a change in a clone.
steps:
  - id: work
    prompt: Paginate /users.
    workspace: { clone: { commit: ${from}, team: { treatment: none } } }
    scorers: { names: [clarity, coverage], start: workflow }
`);
    await syncScorersThenWorkflows(config);
    const runId = String(data(await startRun(config, 'trial', {}, { secrets: await knownSecrets(config), checkout })).run);
    const lease = LeaseSchema.extend({ workspace: z.object({ branch: z.string() }) })
      .parse(data(await leaseNext(config, runId, external, { can: { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', tools: ['claude'] }, prepare: true })).lease);
    git(checkout, 'checkout', '-q', '-B', lease.workspace.branch, from);
    fs.writeFileSync(path.join(checkout, 'users.ts'), 'export const users = (page = 1) => all().slice((page - 1) * 50, page * 50);\n');
    git(checkout, 'add', '.');
    git(checkout, 'commit', '-qm', 'paginate');
    const to = git(checkout, 'rev-parse', 'HEAD');
    data(await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: external, tool: 'claude', changes: { branch: lease.workspace.branch, base: from, from, to, commits: [to] } }));
    const run = await readRun(config, runId);
    if (run === 'missing' || run === 'corrupt') throw new Error(run);
    const copy = await stageEvidence(config, run, { runId, step: 'work', pass: 1 }, { checkout, untrustedEnv: process.env });
    git(checkout, 'checkout', '-q', 'main');
    const judged = (scorers: string[]) => ({ judge: { answer: { label: 'good', reasoning: 'ok' } }, inputs: { scorers } });

    expect(copy !== undefined && fs.existsSync(copy)).toBe(true);
    expect((await walk(config, `run:${runId}:work:1`, judged(['clarity']))).answers.get('score[0].label')).toMatchObject({ ok: true, output: { labels: [{ scorer: 'clarity', label: 'good' }] } });
    await ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now: NOW });
    expect((await walk(config, `run:${runId}:work:1`, judged(['coverage']))).answers.get('score[0].label')).toMatchObject({ ok: true, output: { labels: [{ scorer: 'coverage', label: 'good' }] } });
    expect(fs.existsSync(copy ?? '')).toBe(false);
  });

  it('remove, when the next run lists what lapsed, the evidence staged for a pass whose marks expired', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const runId = await deliveredRun(config);
    const run = await readRun(config, runId);
    if (run === 'missing' || run === 'corrupt') throw new Error(run);
    const copy = await stageEvidence(config, run, { runId, step: 'change', pass: 1 }, { checkout: config.projectRoot ?? '', untrustedEnv: process.env });
    mocks.ci.mockResolvedValue({ kind: 'read', status: 'pending' });
    await walk(config, `run:${runId}:change:1`);
    const lapsed = (now: string) => ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now });

    expect(await lapsed(NOW)).toEqual({ ok: true, output: { list: [] } });
    expect(fs.existsSync(copy ?? '')).toBe(true);
    expect(await lapsed('2027-01-01T00:00:00.000Z')).toEqual({ ok: true, output: { list: [] } });
    expect(fs.existsSync(copy ?? '')).toBe(false);
  });

  it('remove, once its run is past its 14 days, the evidence staged for a pass no teamai-score run ever marked', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const runId = await deliveredRun(config);
    const run = await readRun(config, runId);
    if (run === 'missing' || run === 'corrupt') throw new Error(run);
    const copy = await stageEvidence(config, run, { runId, step: 'change', pass: 1 }, { checkout: config.projectRoot ?? '', untrustedEnv: process.env });
    const lapsed = (now: string) => ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now });

    await lapsed(NOW);
    expect(fs.existsSync(copy ?? '')).toBe(true);
    await lapsed('2027-01-01T00:00:00.000Z');
    expect(fs.existsSync(copy ?? '')).toBe(false);
  });

  it('keep the evidence staged for a pass past its 14 days while a scorer its step does not list was asked for it', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer(), coverage: scorer() });
    const runId = await deliveredRun(config);
    const run = await readRun(config, runId);
    if (run === 'missing' || run === 'corrupt') throw new Error(run);
    const copy = await stageEvidence(config, run, { runId, step: 'change', pass: 1 }, { checkout: config.projectRoot ?? '', untrustedEnv: process.env });
    const asked = { scorer: 'coverage', subject: { kind: 'run' as const, subject: { runId, step: 'change', pass: 1 } } };

    expect(await Marks.open(config, { run: 'r00000000000000c1', demand: 'named', groups: [{ group: 'coverage', keys: [asked] }] }, markFacts(config, '2026-12-31T23:00:00.000Z'))).toMatchObject({ status: 'done' });
    await ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now: '2027-01-01T00:00:00.000Z' });
    expect(fs.existsSync(copy ?? '')).toBe(true);
  });

  it('label each scorer of a batch from the judge\'s answer, print no reasoning, and write them with what judged, closing their marks', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const { answers } = await walk(config, `run:${runId}:review:1`, { inputs: { batch: true }, judge: { answer: { quality: { label: 'good', reasoning: 'Covers it.' }, coverage: { label: 'bad', reasoning: 'No tests.' } } } });

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: 'good', code: '' }, { scorer: 'coverage', label: 'bad', code: '' }] } });
    expect(answers.get('score[0].write')).toEqual({ ok: true, output: { written: 2, labels: (await LabelStore.local(config)).map(labelVersion) } });
    const labels = await LabelStore.local(config);
    expect(labels).toEqual(expect.arrayContaining([
      expect.objectContaining({ scorer: 'quality', label: 'good', passed: true, decidedBy: 'judge', evidenceHash: expect.stringMatching(/^sha256:/), judge: { kind: 'model', ...JUDGED, batched: true } }),
      expect.objectContaining({ scorer: 'coverage', label: 'bad', passed: false, judge: { kind: 'model', tool: 'claude', model: { requested: 'claude-x' }, isolation: 'verified', access: 'read', batched: true } }),
    ]));
    expect(await LabelStore.unpublished(config)).toBe(2);
    expect(await marksOf(config, runId, ['quality', 'coverage'])).toEqual([{ kind: 'labelled' }, { kind: 'labelled' }]);
  });

  it.each([
    ['an answer outside the schema', { answer: { label: 'great', reasoning: 'x' } }, 'judge_answer_invalid'],
    ['a judge that failed', 'failed' as const, 'judge_failed'],
  ])('give each scorer a code for %s, and write records the failed attempt with what the judge spent', async (_case, judge, code) => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const { answers } = await walk(config, `run:${runId}:review:1`, { inputs: { scorers: ['quality'] }, judge });

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: '', code }] } });
    expect(answers.get('score[0].write')).toEqual({ ok: true, output: { written: 0, labels: [] } });
    expect(await LabelStore.local(config)).toEqual([]);
    expect(await marksOf(config, runId, ['quality'])).toEqual([{ kind: 'failed', code, usage: { inputTokens: 10, outputTokens: 2 } }]);
  });

  it('give judge_failed when the judge step recorded no confined run, so what judged is unknown', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const { answers } = await walk(config, `run:${runId}:review:1`, { inputs: { scorers: ['quality'] }, judge: { answer: { label: 'good', reasoning: 'ok' } }, confinedRecorded: false });

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: '', code: 'judge_failed' }] } });
  });

  it('refuse a call from a shell no teamai-score attempt runs, and write nothing', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const bare = { env: { TEAMAI_RUN_DIR: path.join(root, 'data') }, current: config, now: NOW };

    expect(await ScoreVerbs.label({ evidence: path.join(root, 'data'), answer: '{"label":"good","reasoning":"x"}', judge: 'success' }, bare)).toMatchObject({ ok: false, code: 'score_attempt_required' });
    expect(await ScoreVerbs.write({ evidence: path.join(root, 'data') }, bare)).toMatchObject({ ok: false, code: 'score_attempt_required' });
    expect(await LabelStore.local(config)).toEqual([]);
  });

  it('keep the label of a private run\'s pass out of the outbox', async () => {
    const config = await team({ review: REVIEW.replace('description: Review a change.', 'description: Review a change.\nprivate: true') }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    await walk(config, `run:${runId}:review:1`, { inputs: { scorers: ['quality'] }, judge: { answer: { label: 'good', reasoning: 'ok' } } });

    expect(await LabelStore.local(config)).toMatchObject([{ scorer: 'quality', label: 'good' }]);
    expect(await LabelStore.unpublished(config)).toBe(0);
  });

  it('stage nothing to publish for a private run\'s pass', async () => {
    const config = await team({ review: REVIEW.replace('description: Review a change.', 'description: Review a change.\nprivate: true') }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const tip = reportsTip();
    const { answers } = await walk(config, `run:${runId}:review:1`, { inputs: { scorers: ['quality'] }, judge: { answer: { label: 'good', reasoning: 'ok' } }, tip });

    expect(answers.get('score[0].publish')).toEqual({ ok: true, output: { staged: 0 } });
    expect(staged(tip)).toEqual({});
  });

  it('label a session by hand only in a run a person started, and set no mark', async () => {
    const config = await team({}, { quality: scorer() });
    plantSession(path.join(root, 'app'), 'one', 'Fix the login bug.');
    const subject = 'session:claude-code:one';
    const inputs = { scorers: ['quality'], label: 'good', demand: 'named' };

    expect((await walk(config, subject, { inputs })).answers.get('plan')).toMatchObject({ ok: false, code: 'hand_label_refused' });
    const { answers } = await walk(config, subject, { inputs, startedBy: 'person' });

    expect(answers.get('score[0].evidence')).toMatchObject({ ok: true, output: { rubric: '', delivers: false } });
    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: 'good', code: '' }] } });
    expect(await LabelStore.local(config)).toMatchObject([{ scorer: 'quality', label: 'good', source: 'session', subject: { platform: 'claude-code', sessionId: 'one' }, judge: { kind: 'human' }, used: { skills: [] } }]);
    expect(fs.existsSync(path.join(root, 'data', 'scores', 'marks.jsonl'))).toBe(false);
  });

  it('label by hand a session gone from this machine, with what it used unknown', async () => {
    const config = await team({}, { quality: scorer() });
    const { answers } = await walk(config, 'session:claude-code:gone', { inputs: { scorers: ['quality'], label: 'good', demand: 'named' }, startedBy: 'person' });
    const labels = await LabelStore.local(config);

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: 'good', code: '' }] } });
    expect(labels).toMatchObject([{ scorer: 'quality', label: 'good', source: 'session', subject: { platform: 'claude-code', sessionId: 'gone' }, judge: { kind: 'human' } }]);
    expect(labels[0]).not.toHaveProperty('used');
  });

  it('label a session by its judge for a scorer with a check, as a pass that delivered nothing', async () => {
    const config = await team({}, { quality: scorer({ extra: 'check: { run: "exit 3", protect: [test] }\n' }) });
    plantSession(path.join(root, 'app'), 'one', 'Fix the login bug.');
    const { answers } = await walk(config, 'session:claude-code:one', { inputs: { scorers: ['quality'], demand: 'named' }, judge: { answer: { label: 'good', reasoning: 'It fixed the bug.' } } });

    expect(answers.get('score[0].evidence')).toMatchObject({ ok: true, output: { delivers: false } });
    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: 'good', code: '' }] } });
  });

  it('write a session\'s label with the agent its captures agree on and the one model its messages name', async () => {
    const config = await team({}, { quality: scorer() });
    plantSession(path.join(root, 'app'), 'one', 'Fix the login bug.');
    const observed = { v: 1, tool: { name: 'claude', version: '2.1.308' }, model: { requested: 'claude-x' }, teamai: '1.0.0', driver: 'session' };
    const captures = path.join(root, 'data', 'sessions', 'captures', 'claude-code', 'one');
    fs.mkdirSync(captures, { recursive: true });
    const captureId = '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e2f10';
    fs.writeFileSync(path.join(captures, `${captureId}.json`), JSON.stringify({ captureId, platform: 'claude-code', sessionId: 'one', capturedAt: '2026-11-03T09:00:00.000Z', agent: observed }));
    await walk(config, 'session:claude-code:one', { inputs: { scorers: ['quality'], demand: 'named' }, judge: { answer: { label: 'good', reasoning: 'It fixed the bug.' } } });

    expect(await LabelStore.local(config)).toMatchObject([{ scorer: 'quality', label: 'good', agent: { tool: observed.tool, model: { requested: 'claude-x', reported: 'claude-x' } } }]);
  });

  it('judge a session by the rubric plan opened its mark with when a pull changed the scorer before evidence, and close that mark', async () => {
    const config = await team({}, { quality: scorer({ extra: 'sessions: true\n' }) });
    plantSession(path.join(root, 'app'), 'one', 'Fix the login bug.');
    const pulled = async () => {
      fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'quality.md'), scorer({ extra: 'sessions: true\n' }).replace('Judge the work.', 'Judge the work strictly.'));
      await syncScorersThenWorkflows(config);
    };
    const { answers } = await walk(config, 'session:claude-code:one', { judge: { answer: { label: 'good', reasoning: 'It fixed the bug.' } }, after: { plan: pulled } });

    expect(answers.get('score[0].evidence')).toMatchObject({ ok: true, output: { rubric: expect.not.stringContaining('strictly') } });
    expect(await LabelStore.local(config)).toMatchObject([{ scorer: 'quality', label: 'good' }]);
    expect(await ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now: NOW })).toEqual({ ok: true, output: { list: [] } });
  });

  it.each([100, 0])('judge a lapsed session once with the rubric a pull changed since, and list it no more, at sampling rate %i', async (rate) => {
    const config = await team({}, { quality: scorer({ rate }) });
    const subject = 'session:claude-code:one';
    plantSession(path.join(root, 'app'), 'one', 'Fix the login bug.');
    const asked = await scoreRun(config, { subject, scorers: ['quality'], demand: 'named' });
    expect(await ScoreVerbs.plan({ subject, scorers: '["quality"]', batch: 'false', demand: 'named' }, (await asked.next('plan')).ctx)).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality' }] } });
    data(await cancelRun(config, asked.runId, await knownSecrets(config)));
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'quality.md'), scorer({ rate }).replace('Judge the work.', 'Judge the work strictly.'));
    await syncScorersThenWorkflows(config);
    const lapsed = async () => ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now: NOW });

    expect(await lapsed()).toEqual({ ok: true, output: { list: [{ subject, scorers: ['quality'] }] } });
    await walk(config, subject, { inputs: { scorers: ['quality'] }, judge: { answer: { label: 'good', reasoning: 'It fixed the bug.' } } });

    expect(await LabelStore.local(config)).toMatchObject([{ scorer: 'quality', label: 'good' }]);
    expect(await lapsed()).toEqual({ ok: true, output: { list: [] } });
  });

  it('start a lapsed session again only until its fourth lapse, a pull having changed the rubric in between', async () => {
    const config = await team({}, { quality: scorer({ rate: 0 }) });
    const subject = 'session:claude-code:one';
    plantSession(config.projectRoot ?? '', 'one', 'Add retries.');
    /** A run that plans the session and leases its judge, then is cancelled: one lapse. */
    const lapse = async (demand: string) => {
      const started = await scoreRun(config, { subject, scorers: ['quality'], demand });
      const plan = await started.next('plan');
      const planned = await ScoreVerbs.plan({ subject, scorers: '["quality"]', batch: 'false', demand }, plan.ctx);
      expect(planned).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality' }] } });
      await started.report(plan, planned);
      const evidence = await started.next('score[0].evidence');
      await started.report(evidence, await ScoreVerbs.evidence({ subject, scorers: 'quality' }, evidence.ctx));
      await started.next('score[0].judge');
      data(await cancelRun(config, started.runId, await knownSecrets(config)));
    };
    const lapsed = async () => ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now: NOW });
    await lapse('named');
    await lapse('auto');
    await lapse('auto');
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'quality.md'), scorer({ rate: 0 }).replace('Judge the work.', 'Judge the work strictly.'));
    await syncScorersThenWorkflows(config);

    expect(await lapsed()).toEqual({ ok: true, output: { list: [{ subject, scorers: ['quality'] }] } });
    await lapse('auto');
    expect(await lapsed()).toEqual({ ok: true, output: { list: [] } });
  });

  it('settle a group whose evidence failed as a failed attempt, so automatic judging does not start it again', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config, 'session-gone');
    const { answers } = await walk(config, `run:${runId}:review:1`, { inputs: { scorers: ['quality'] } });

    expect(answers.get('score[0].evidence')).toMatchObject({ ok: false, code: 'evidence_missing' });
    expect(answers.get('score[0].settle')).toEqual({ ok: true, output: { settled: 1 } });
    expect(await marksOf(config, runId, ['quality'])).toEqual([{ kind: 'failed', code: 'judge_failed' }]);
  });
});

const FIXES = `schemaVersion: v1alpha1
name: fixes
description: Fix a change, then list its passes to score.
steps:
  - id: outer
    workflow:
      steps:
        - id: fix
          prompt: Fix the change.
          scorers: { names: [quality], start: workflow }
        - id: lister
          needs: [fix]
          command: teamai score subjects
  - id: other
    needs: [outer]
    prompt: Do something else.
    scorers: [quality]
`;

describe('score publish', () => {
  const MONTH = `scores/tester/${NOW.slice(0, 7)}.jsonl`;
  const lines = (text: string) => text.split('\n').filter(Boolean).map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));

  it('stages this member\'s pending labels, without reasoning, into its month file at origin\'s tip, merged by key with what that file holds', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const earlier = await reviewedRun(config);
    await walk(config, `run:${earlier}:review:1`, { inputs: { scorers: ['coverage'] }, judge: { answer: { label: 'bad', reasoning: 'No tests.' } } });
    const [theirs] = await LabelStore.local(config);
    const tip = reportsTip({ [MONTH]: `${JSON.stringify(theirs)}\n`, 'scores/someone/2026-11.jsonl': '{}\n' });
    const runId = await reviewedRun(config);
    const { answers } = await walk(config, `run:${runId}:review:1`, { inputs: { scorers: ['quality'] }, judge: { answer: { label: 'good', reasoning: 'Covers it.' } }, tip });

    expect(answers.get('score[0].publish')).toEqual({ ok: true, output: { staged: 1 } });
    const published = staged(tip);
    expect(Object.keys(published)).toEqual([MONTH]);
    expect(lines(published[MONTH] ?? '')).toEqual([
      expect.objectContaining({ scorer: 'coverage', label: 'bad' }),
      expect.objectContaining({ scorer: 'quality', label: 'good' }),
    ]);
    expect(published[MONTH]).not.toContain('Covers it.');
    expect(await LabelStore.unpublished(config)).toBe(1);
  });

  it('takes a pending label out of the outbox once origin\'s tip holds it or a newer label of its key, and stages nothing for it', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    await walk(config, `run:${runId}:review:1`, { inputs: { scorers: ['quality'] }, judge: { answer: { label: 'bad', reasoning: 'x' } } });
    const [label] = await LabelStore.local(config);
    const newer = { ...label, label: 'good', score: 1, passed: true, scoredAt: '2026-11-03T11:00:00.000Z' };
    const tip = reportsTip({ [MONTH]: `${JSON.stringify(newer)}\n` });
    const { ctx } = await (await scoreRun(config, { subject: `run:${runId}:review:1` })).next('plan');

    expect(await ScoreVerbs.publish({ ...ctx, cwd: tip })).toEqual({ ok: true, output: { staged: 0 } });
    expect(staged(tip)).toEqual({});
    expect(await LabelStore.unpublished(config)).toBe(0);
    expect(await LabelStore.local(config)).toMatchObject([{ scorer: 'quality', label: 'bad' }]);
  });

  it.each([
    ['usage reporting is off', (config: LocalConfig) => ({ ...config, usageReportEnabled: false }), (dir: string) => dir],
    ['it runs in no checkout of teamai-reports', (config: LocalConfig) => config, (dir: string) => path.join(dir, 'scores')],
  ])('stages nothing while %s, and keeps the labels pending', async (_case, configured, place) => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    await walk(config, `run:${runId}:review:1`, { inputs: { scorers: ['quality'] }, judge: { answer: { label: 'good', reasoning: 'ok' } } });
    const tip = reportsTip({ 'scores/.keep': '' });
    const { ctx } = await (await scoreRun(configured(config), { subject: `run:${runId}:review:1` })).next('plan');

    expect(await ScoreVerbs.publish({ ...ctx, current: configured(config), cwd: place(tip) })).toEqual({ ok: true, output: { staged: 0 } });
    expect(staged(tip)).toEqual({});
    expect(await LabelStore.unpublished(config)).toBe(1);
  });

  it('stages nothing in a teamai-score instance of an isolated run, as a benchmark\'s trials are, whatever is pending', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    await walk(config, `run:${runId}:review:1`, { inputs: { scorers: ['quality'] }, judge: { answer: { label: 'good', reasoning: 'ok' } } });
    const trial = `schemaVersion: v1alpha1
name: trial
description: Judge a pass, then try a change in a clone.
inputs: { subject: string }
steps:
  - id: score
    workflow: teamai-score
    with: { subject: "{{ inputs.subject }}", scorers: [quality], label: '', batch: false, demand: named }
  - id: try
    needs: [score]
    workspace: { clone: { commit: ${git(config.projectRoot ?? '', 'rev-parse', 'HEAD')}, team: { treatment: none } } }
    command: node try.js
`;
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'trial.yaml'), trial);
    await syncScorersThenWorkflows(config);
    const isolated = runOf(config, String(data(await startRun(config, 'trial', { subject: `run:${runId}:review:1` }, { secrets: await knownSecrets(config), checkout: config.projectRoot })).run));
    const { ctx } = await isolated.next('score.plan');
    const tip = reportsTip();

    expect(await ScoreVerbs.publish({ ...ctx, cwd: tip })).toEqual({ ok: true, output: { staged: 0 } });
    expect(staged(tip)).toEqual({});
    expect(await LabelStore.unpublished(config)).toBe(1);
  });

  it('refuses a call from a shell no teamai-score attempt runs, and stages nothing', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const tip = reportsTip();

    expect(await ScoreVerbs.publish({ env: { TEAMAI_RUN_DIR: path.join(root, 'data') }, current: config, now: NOW, cwd: tip })).toMatchObject({ ok: false, code: 'score_attempt_required' });
    expect(staged(tip)).toEqual({});
  });
});

describe('score subjects', () => {
  it('lists the passes of steps that start their own scoring, --step read from the workflow of the attempt of this run that calls it', async () => {
    const config = await team({ fixes: FIXES }, { quality: scorer() });
    const runId = String(data(await startRun(config, 'fixes', {}, { secrets: await knownSecrets(config), checkout: config.projectRoot })).run);
    const fix = LeaseSchema.parse(data(await leaseNext(config, runId, external)).lease);
    plantSession(config.projectRoot ?? '', 'session-fix', 'Fix the change.');
    data(await reportAttempt(config, runId, { attempt: fix.attempt, revision: fix.revision, outcome: 'success', driver: external, tool: 'claude', session: 'session-fix' }));
    const lister = LeaseSchema.parse(data(await leaseNext(config, runId, external)).lease);
    const ctx = { env: attemptEnv(config, runId, lister.attempt, 'unattended'), current: config, now: NOW };

    expect(lister.step).toBe('outer.lister');
    expect(await ScoreVerbs.subjects({ run: runId, step: 'fix' }, ctx)).toEqual({ ok: true, output: { list: [`run:${runId}:outer.fix:1`] } });
    expect(await ScoreVerbs.subjects({ run: runId, step: 'lister' }, ctx)).toEqual({ ok: true, output: { list: [] } });
    expect(await ScoreVerbs.subjects({ run: runId }, { env: {}, current: config, now: NOW })).toEqual({ ok: true, output: { list: [`run:${runId}:outer.fix:1`] } });
    expect(await ScoreVerbs.subjects({ run: runId, step: 'fix' }, { env: { TEAMAI_WORKFLOW_ATTEMPT: `r0000000000000001/${lister.attempt}` }, current: config, now: NOW })).toEqual({ ok: true, output: { list: [] } });
    data(await reportAttempt(config, runId, { attempt: lister.attempt, revision: lister.revision, outcome: 'success', driver: external, outputs: {} }));
    const other = LeaseSchema.parse(data(await leaseNext(config, runId, external)).lease);

    expect(other.step).toBe('other');
    expect(await ScoreVerbs.subjects({ run: runId, step: 'fix' }, ctx)).toEqual({ ok: true, output: { list: [] } });
    expect(await ScoreVerbs.subjects({ run: runId, step: 'outer' }, { env: attemptEnv(config, runId, other.attempt, 'unattended'), current: config, now: NOW })).toEqual({ ok: true, output: { list: [`run:${runId}:outer.fix:1`] } });
  });

  it.each<[string, SubjectsOptions]>([
    ['--lapsed with --run', { lapsed: true, run: 'r0000000000000001' }],
    ['--lapsed with --step', { lapsed: true, step: 'fix' }],
    ['neither --run nor --lapsed', {}],
  ])('refuses %s', async (_case, options) => {
    const config = await team({}, {});

    expect(await ScoreVerbs.subjects(options, { env: {}, current: config, now: NOW })).toMatchObject({ ok: false, code: 'invalid_arguments' });
  });

  it('lists a lapse, and a pass that waited on CI once its CI finished, but not one still waiting', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const runId = await deliveredRun(config);
    const pass = { kind: 'run' as const, subject: { runId, step: 'change', pass: 1 } };
    const session = { kind: 'session' as const, subject: { platform: 'claude-code', sessionId: 'one' } };
    const facts = { now: NOW, readRun: async () => undefined };
    await Marks.open(config, { run: 'r0000000000000001', demand: 'auto', groups: [{ group: 'clarity', keys: [{ scorer: 'clarity', subject: pass }] }, { group: 'clarity', keys: [{ scorer: 'clarity', subject: session, sourceHash: 'h' }] }] }, facts);
    await Marks.close(config, [{ scorer: 'clarity', subject: pass }], { kind: 'waiting' }, facts);
    const lapsed = () => ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now: NOW });

    mocks.ci.mockResolvedValue({ kind: 'read', status: 'pending' });
    expect(await lapsed()).toEqual({ ok: true, output: { list: [{ subject: 'session:claude-code:one', scorers: ['clarity'] }] } });
    mocks.ci.mockResolvedValue({ kind: 'read', status: 'passed' });
    expect(await lapsed()).toEqual({ ok: true, output: { list: [{ subject: `run:${runId}:change:1`, scorers: ['clarity'] }, { subject: 'session:claude-code:one', scorers: ['clarity'] }] } });
  });

  it('lists a pass whose CI is still pending once the ci step\'s --wait has passed, so the next run judges it without CI', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const runId = await deliveredRun(config);
    mocks.ci.mockResolvedValue({ kind: 'read', status: 'pending' });
    const { answers } = await walk(config, `run:${runId}:change:1`, { wait: '30m' });
    const lapsed = (now: string) => ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now });

    expect(answers.get('score[0].label')).toMatchObject({ ok: true, output: { labels: [{ code: 'ci_pending' }] } });
    expect(await lapsed('2026-11-03T10:29:59.999Z')).toEqual({ ok: true, output: { list: [] } });
    expect(await lapsed('2026-11-03T10:30:00.000Z')).toEqual({ ok: true, output: { list: [{ subject: `run:${runId}:change:1`, scorers: ['clarity'] }] } });
  });

  it('lists a pass of an ended run inside its 14 days that no teamai-score run planned, for a scorer that samples it', async () => {
    const config = await team({ review: REVIEW.replace('scorers: [quality, coverage]', 'scorers: [quality, rare]'), own: REVIEW.replace('name: review', 'name: own').replace('scorers: [quality, coverage]', 'scorers: { names: [rare], start: workflow }') }, { quality: scorer(), rare: scorer({ rate: 0 }) });
    const auto = await reviewedRun(config);
    const ownRun = String(data(await startRun(config, 'own', {}, { secrets: await knownSecrets(config), checkout: config.projectRoot })).run);
    const lease = LeaseSchema.parse(data(await leaseNext(config, ownRun, external)).lease);
    data(await reportAttempt(config, ownRun, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: external, tool: 'claude', session: 'session-review' }));
    for (const runId of [auto, ownRun]) expect(data(await leaseNext(config, runId, external))).toMatchObject({ done: { outcome: 'succeeded' } });
    const lapsed = (now = NOW) => ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now });

    expect(await lapsed()).toEqual({ ok: true, output: { list: [{ subject: `run:${auto}:review:1`, scorers: ['quality'] }] } });
    await Marks.open(config, { run: 'r0000000000000001', demand: 'auto', groups: [{ group: 'quality', keys: [{ scorer: 'quality', subject: { kind: 'run', subject: { runId: auto, step: 'review', pass: 1 } } }] }] }, { now: NOW, readRun: async () => undefined });
    await Marks.close(config, [{ scorer: 'quality', subject: { kind: 'run', subject: { runId: auto, step: 'review', pass: 1 } } }], { kind: 'labelled' }, { now: NOW });
    expect(await lapsed()).toEqual({ ok: true, output: { list: [] } });
  });

  it('lists a pass whose teamai-score run the scoring module started and nobody drove, while its run still runs', async () => {
    const config = await team({ review: `${REVIEW}  - id: later\n    needs: [review]\n    prompt: Do the rest.\n` }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const lapsed = () => ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now: NOW });

    expect(await lapsed()).toEqual({ ok: true, output: { list: [] } });
    const secrets = await knownSecrets(config);
    const started = await PassScoring.start(config, runId, { client: { start: (name, options) => startRun(config, name, options.inputs, { secrets, startedBy: 'cli' }) }, mode: 'attended' });

    expect(started.runs).toHaveLength(1);
    expect(await lapsed()).toEqual({ ok: true, output: { list: [{ subject: `run:${runId}:review:1`, scorers: ['quality', 'coverage'] }] } });
  });

  it('lists a pass of a step that samples all whose teamai-score run the scoring module started and nothing planned', async () => {
    const config = await team({ review: `${REVIEW.replace('scorers: [quality, coverage]', 'scorers: { names: [quality], sampling: all }')}  - id: later\n    needs: [review]\n    prompt: Do the rest.\n` }, { quality: scorer({ rate: 0 }) });
    const runId = await reviewedRun(config);
    const secrets = await knownSecrets(config);
    const started = await PassScoring.start(config, runId, { client: { start: (name, options) => startRun(config, name, options.inputs, { secrets, startedBy: 'cli' }) }, mode: 'attended' });

    expect(started.runs).toHaveLength(1);
    expect(await ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now: NOW })).toEqual({ ok: true, output: { list: [{ subject: `run:${runId}:review:1`, scorers: ['quality'] }] } });
  });

  it('lists a start: workflow pass with no scoring step only once its run ended, and not past the run\'s 14 days', async () => {
    const config = await team({ own: REVIEW.replace('name: review', 'name: own').replace('scorers: [quality, coverage]', 'scorers: { names: [quality], start: workflow }') }, { quality: scorer() });
    const ownRun = String(data(await startRun(config, 'own', {}, { secrets: await knownSecrets(config), checkout: config.projectRoot })).run);
    const lease = LeaseSchema.parse(data(await leaseNext(config, ownRun, external)).lease);
    plantSession(config.projectRoot ?? '', 'session-own', 'Review the change.');
    data(await reportAttempt(config, ownRun, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: external, tool: 'claude', session: 'session-own' }));
    const lapsed = (now: string) => ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now });
    const later = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();

    expect(await lapsed(new Date().toISOString())).toEqual({ ok: true, output: { list: [] } });
    expect(data(await leaseNext(config, ownRun, external))).toMatchObject({ done: { outcome: 'succeeded' } });
    expect(await lapsed(new Date().toISOString())).toEqual({ ok: true, output: { list: [{ subject: `run:${ownRun}:review:1`, scorers: ['quality'] }] } });
    expect(await lapsed(later)).toEqual({ ok: true, output: { list: [] } });
  });
});

/** labels.json as `score label` writes it, read loosely enough to tamper with. */
const LabelsFile = z.object({
  entries: z.array(z.looseObject({
    scorer: z.string(),
    label: z.looseObject({ label: z.string(), score: z.number(), passed: z.boolean(), judge: z.json(), rubric: z.looseObject({ sourceHash: z.string() }), subject: z.looseObject({ pass: z.number() }) }),
  })),
});

type LabelsFile = z.infer<typeof LabelsFile>;

const eachEntry = (change: (entry: LabelsFile['entries'][number]) => LabelsFile['entries'][number]) => (file: LabelsFile): LabelsFile => ({ entries: file.entries.map(change) });

describe('score verbs refuse what they cannot act on', () => {
  it.each<[string, PlanOptions, string]>([
    ['a subject that is none', { subject: 'pass:1' }, 'subject_invalid'],
    ['scorers that are neither JSON nor names', { scorers: '[1]' }, 'invalid_arguments'],
    ['a demand that is neither auto nor named', { demand: 'now' }, 'invalid_arguments'],
    ['an empty demand', { demand: '' }, 'invalid_arguments'],
    ['a batch that is not a boolean', { batch: 'yes' }, 'invalid_arguments'],
    ['a pass the run does not have', { subject: 'run:RUN:review:2' }, 'pass_not_found'],
    ['a scorer the run did not pin', { scorers: '["tests"]' }, 'scorer_not_found'],
  ])('plan refuses %s', async (_case, options, code) => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = (options.subject ?? 'run:RUN:review:1').replace('RUN', runId);
    const { ctx } = await (await scoreRun(config, { subject: `run:${runId}:review:1` })).next('plan');

    expect(await ScoreVerbs.plan({ scorers: '[]', batch: 'false', demand: 'auto', ...options, subject }, ctx)).toMatchObject({ ok: false, code });
  });

  it('plan refuses a hand label of two scorers', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const subject = `run:${await reviewedRun(config)}:review:1`;
    const { ctx } = await (await scoreRun(config, { subject, scorers: ['quality', 'coverage'], label: 'good', demand: 'named' }, 'person')).next('plan');

    expect(await ScoreVerbs.plan({ subject, scorers: '["quality","coverage"]', demand: 'named' }, ctx)).toMatchObject({ ok: false, code: 'invalid_arguments' });
  });

  it.each<[string, 'evidence' | 'settle', EvidenceOptions, string]>([
    ['evidence of a subject that is none', 'evidence', { subject: 'pass:1', scorers: 'quality' }, 'subject_invalid'],
    ['evidence for scorers that are neither JSON nor names', 'evidence', { scorers: '[1]' }, 'invalid_arguments'],
    ['evidence for no scorer', 'evidence', { scorers: '' }, 'invalid_arguments'],
    ['evidence for a scorer the run did not pin', 'evidence', { scorers: 'tests' }, 'scorer_not_found'],
    ['evidence for a scorer teamai pull did not cache', 'evidence', { subject: 'team-session:alice:claude-code:one', scorers: 'tests' }, 'scorer_not_found'],
    ['evidence of a member\'s session while the team\'s pushed sessions cannot be read', 'evidence', { subject: 'team-session:alice:claude-code:gone', scorers: 'quality' }, 'reports_unreachable'],
    ['evidence of a session gone from this machine', 'evidence', { subject: 'session:claude-code:gone', scorers: 'quality' }, 'evidence_empty'],
    ['to settle a subject that is none', 'settle', { subject: 'pass:1', scorers: 'quality' }, 'subject_invalid'],
    ['to settle scorers that are neither JSON nor names', 'settle', { scorers: '[1]' }, 'invalid_arguments'],
  ])('refuse %s', async (_case, verb, options, code) => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const { ctx } = await (await scoreRun(config, { subject: `run:${runId}:review:1` })).next('plan');

    expect(await ScoreVerbs[verb]({ subject: `run:${runId}:review:1`, ...options }, ctx)).toMatchObject({ ok: false, code });
  });

  it.each<[string, (file: LabelsFile) => LabelsFile, string]>([
    ['a label the scorer does not have', eachEntry((entry) => ({ ...entry, label: { ...entry.label, label: 'good' } })), '"good" with score 0 is not a label of scorer quality'],
    ['a label no scorer has', eachEntry((entry) => ({ ...entry, label: { ...entry.label, label: 'meh' } })), '"meh" with score 0 is not a label of scorer quality'],
    ['a score its label does not have', eachEntry((entry) => ({ ...entry, label: { ...entry.label, score: 1 } })), '"bad" with score 1 is not a label of scorer quality'],
    ['a passed its score does not give', eachEntry((entry) => ({ ...entry, label: { ...entry.label, passed: true } })), '"bad" with score 0 is not a label of scorer quality'],
    ['an entry of another scorer', eachEntry((entry) => ({ ...entry, scorer: 'coverage' })), 'entry 1 is not of scorer quality'],
    ['a rubric the run did not pin', eachEntry((entry) => ({ ...entry, label: { ...entry.label, rubric: { sourceHash: 'sha256:other' } } })), 'the label of quality is not of its pinned rubric'],
    ['a hand label in a run no person started', eachEntry((entry) => ({ ...entry, label: { ...entry.label, judge: { kind: 'human' } } })), 'the label of quality is a hand label'],
    ['a label of another pass', eachEntry((entry) => ({ ...entry, label: { ...entry.label, subject: { ...entry.label.subject, pass: 2 } } })), 'the label of quality is of another subject'],
    ['no entry for the group\'s scorer', () => ({ entries: [] }), 'the entries are not one per scorer of the group'],
  ])('write refuses labels.json with %s, and writes nothing', async (_case, tamper, problem) => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const { run, evidence, scorers } = await plannedGroup(config, subject, { scorers: ['quality'] });
    const written = await ScoreVerbs.evidence({ subject, scorers }, evidence.ctx);
    await run.report(evidence, written);
    const judge = await run.next('score[0].judge');
    await run.report(judge, { ok: true, output: { answer: { label: 'bad', reasoning: 'no' } } }, { confined: JUDGED });
    const label = await run.next('score[0].label');
    const dir = z.object({ dir: z.string() }).parse(written.ok ? written.output : {}).dir;
    await run.report(label, await ScoreVerbs.label({ evidence: dir, answer: '{"label":"bad","reasoning":"no"}', judge: 'success' }, label.ctx));
    const file = path.join(dir, 'labels.json');
    fs.writeFileSync(file, JSON.stringify(tamper(LabelsFile.parse(JSON.parse(fs.readFileSync(file, 'utf8'))))));

    expect(await ScoreVerbs.write({ evidence: dir }, (await run.next('score[0].write')).ctx)).toMatchObject({ ok: false, code: 'label_invalid', message: expect.stringContaining(problem) });
    expect(await LabelStore.local(config)).toEqual([]);
  });
});

describe('score label and score write read what the run recorded', () => {
  /** A group of `quality` on the reviewed pass, its evidence written and its judge step answered `answer`, at its label step. */
  async function judgedGroup(answer: unknown, startedBy: StartedBy = 'cli') {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const { run, evidence, scorers } = await plannedGroup(config, subject, { scorers: ['quality'] }, startedBy);
    const written = await ScoreVerbs.evidence({ subject, scorers }, evidence.ctx);
    await run.report(evidence, written);
    const judge = await run.next('score[0].judge');
    await run.report(judge, { ok: true, output: { answer: z.json().parse(answer) } }, { confined: JUDGED });
    return { config, runId, run, label: await run.next('score[0].label'), dir: z.object({ dir: z.string() }).parse(written.ok ? written.output : {}).dir };
  }

  it('write records the confined run that judged one scorer, with its usage and no batch', async () => {
    const { config, run, label, dir } = await judgedGroup({ label: 'good', reasoning: 'ok' });
    const labelled = await ScoreVerbs.label({ evidence: dir, answer: '{"label":"good","reasoning":"ok"}', judge: 'success' }, label.ctx);

    expect(labelled).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: 'good', code: '' }] } });
    await run.report(label, labelled);
    expect(await ScoreVerbs.write({ evidence: dir }, (await run.next('score[0].write')).ctx)).toEqual({ ok: true, output: { written: 1, labels: (await LabelStore.local(config)).map(labelVersion) } });
    const [stored] = await LabelStore.local(config);
    expect(stored).toMatchObject({ judge: { kind: 'model', tool: 'claude', usage: { inputTokens: 10, outputTokens: 2 } } });
    expect(stored?.judge).not.toHaveProperty('batched');
  });

  it('write records the access the judge\'s confined run reported, not the one its tool\'s profile gives', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const { run, evidence, scorers } = await plannedGroup(config, subject, { scorers: ['quality'] });
    const written = await ScoreVerbs.evidence({ subject, scorers }, evidence.ctx);
    await run.report(evidence, written);
    const judge = await run.next('score[0].judge');
    await run.report(judge, { ok: true, output: { answer: { label: 'good', reasoning: 'ok' } } }, { confined: { ...JUDGED, access: 'answer' } });
    const label = await run.next('score[0].label');
    const dir = z.object({ dir: z.string() }).parse(written.ok ? written.output : {}).dir;
    await run.report(label, await ScoreVerbs.label({ evidence: dir, answer: '{"label":"good","reasoning":"ok"}', judge: 'success' }, label.ctx));
    await ScoreVerbs.write({ evidence: dir }, (await run.next('score[0].write')).ctx);

    expect(await LabelStore.local(config)).toMatchObject([{ scorer: 'quality', judge: { kind: 'model', tool: 'claude', access: 'answer' } }]);
  });

  it('label gives judge_answer_invalid for an answer that is not JSON', async () => {
    const { label, dir } = await judgedGroup({ label: 'good', reasoning: 'ok' });

    expect(await ScoreVerbs.label({ evidence: dir, answer: 'good, I think', judge: 'success' }, label.ctx)).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: '', code: 'judge_answer_invalid' }] } });
  });

  it.each<[string, StartedBy]>([['an agent', 'cli'], ['a person', 'person']])('label refuses a group that claims a hand label the run started by %s never gave', async (_case, startedBy) => {
    const { label, dir } = await judgedGroup({ label: 'good', reasoning: 'ok' }, startedBy);
    const file = path.join(dir, 'group.json');
    fs.writeFileSync(file, JSON.stringify({ ...z.looseObject({}).parse(JSON.parse(fs.readFileSync(file, 'utf8'))), hand: true }));

    expect(await ScoreVerbs.label({ evidence: dir, answer: '{"label":"good","reasoning":"ok"}', judge: 'success' }, label.ctx)).toMatchObject({ ok: false, code: 'hand_label_refused' });
  });

  it('write refuses a group label has not labelled yet', async () => {
    const { label, dir } = await judgedGroup({ label: 'good', reasoning: 'ok' });

    expect(await ScoreVerbs.write({ evidence: dir }, label.ctx)).toMatchObject({ ok: false, code: 'evidence_unreadable', message: expect.stringContaining('Run the label step first') });
  });

  it('write of a hand label leaves open the mark automatic judging holds on the pass', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const holder = await plannedGroup(config, subject, { scorers: ['quality'] });
    const { answers } = await walk(config, subject, { inputs: { scorers: ['quality'], label: 'good', demand: 'named' }, startedBy: 'person' });

    expect(answers.get('score[0].write')).toEqual({ ok: true, output: { written: 1, labels: (await LabelStore.local(config)).map(labelVersion) } });
    const held = { scorer: 'quality', subject: { kind: 'run' as const, subject: { runId, step: 'review', pass: 1 } } };
    expect(await Marks.states(config, [held], { now: NOW, readRun: async () => ({ ended: false, changedAt: NOW, judgeRan: () => true }) })).toMatchObject([{ kind: 'open', run: holder.run.runId }]);
  });
});

describe('labels a stage decided', () => {
  const clarityOnly = SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]');

  it('give the scorer\'s best failing label, decided by protected paths, naming the stage and no judge tool', async () => {
    const config = await team({ ship: clarityOnly }, { clarity: scorer() });
    const runId = await deliveredRun(config, { code: 'protected_path', message: 'Step "change" changed protected paths against the run base: AGENTS.md.' });
    mocks.ci.mockResolvedValue({ kind: 'unsupported' });
    const { answers, runId: scoreRunId, ended } = await walk(config, `run:${runId}:change:1`);

    expect(answers.has('score[0].judge')).toBe(false);
    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'clarity', label: 'bad', code: '' }] } });
    expect(await LabelStore.local(config)).toMatchObject([{ scorer: 'clarity', label: 'bad', passed: false, decidedBy: 'protected', judge: { kind: 'stage' } }]);
    expect(await ScoreAnswer.of(config, scoreRunId, ended, ['clarity'])).toMatchObject({ data: { label: { scorer: 'clarity', judge: { kind: 'stage' }, decidedBy: 'protected' } } });
  });

  it('record the label a stage decided where no judge tool is installed', async () => {
    const config = await team({ ship: clarityOnly }, { clarity: scorer() });
    const runId = await deliveredRun(config, { code: 'protected_path', message: 'Step "change" changed protected paths against the run base: AGENTS.md.' });
    mocks.ci.mockResolvedValue({ kind: 'unsupported' });
    const { run, dir, next } = await deliveredGroup(config, runId);
    await run.report(next, await ScoreVerbs.stage({ stage: 'check', evidence: dir }, next.ctx));
    const ci = await run.next('score[0].ci');
    await run.report(ci, await ScoreVerbs.stage({ stage: 'ci', evidence: dir, wait: '2h' }, ci.ctx));
    const decided = await run.next('score[0].protected');
    await run.report(decided, await ScoreVerbs.stage({ stage: 'protected', evidence: dir }, decided.ctx));
    const label = await run.next('score[0].label');
    vi.stubEnv('PATH', '/usr/bin:/bin');

    expect(await ScoreVerbs.label({ evidence: dir, answer: '', judge: '' }, label.ctx)).toEqual({ ok: true, output: { labels: [{ scorer: 'clarity', label: 'bad', code: '' }] } });
  });

  it('give ci_pending while CI has not finished, and leave the mark waiting for it', async () => {
    const config = await team({ ship: clarityOnly }, { clarity: scorer() });
    const runId = await deliveredRun(config);
    mocks.ci.mockResolvedValue({ kind: 'read', status: 'pending' });
    const { answers } = await walk(config, `run:${runId}:change:1`);

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'clarity', label: '', code: 'ci_pending' }] } });
    expect(await Marks.states(config, [{ scorer: 'clarity', subject: { kind: 'run', subject: { runId, step: 'change', pass: 1 } } }], { now: NOW, readRun: async () => ({ ended: false, changedAt: NOW, judgeRan: () => true }) })).toEqual([{ kind: 'waiting' }]);
  });

  it('give check_could_not_run for a check that could not run', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[delivered]') }, { delivered: scorer({ extra: 'check: { run: "exit 127", protect: [test] }\n' }) });
    const runId = await deliveredRun(config);
    const { answers } = await walk(config, `run:${runId}:change:1`);

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'delivered', label: '', code: 'check_could_not_run' }] } });
  });

  it('refuse to label a scorer with a check whose check stage left no record, and settle it with what the judge spent', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[delivered]') }, { delivered: scorer({ extra: 'check: { run: "exit 3", protect: [test] }\n' }) });
    const runId = await deliveredRun(config);
    mocks.ci.mockResolvedValue({ kind: 'unsupported' });
    const { answers } = await walk(config, `run:${runId}:change:1`, { judge: { answer: { label: 'good', reasoning: 'ok' } }, fake: { check: { ok: true, output: { decided: false } } } });

    expect(answers.get('score[0].label')).toMatchObject({ ok: false, code: 'stage_record_missing' });
    expect(answers.get('score[0].settle')).toEqual({ ok: true, output: { settled: 1 } });
    expect(await LabelStore.local(config)).toEqual([]);
    expect(await Marks.states(config, [{ scorer: 'delivered', subject: { kind: 'run', subject: { runId, step: 'change', pass: 1 } } }], { now: NOW, readRun: async () => ({ ended: true, changedAt: NOW, judgeRan: () => true }) }))
      .toEqual([{ kind: 'failed', code: 'judge_failed', usage: { inputTokens: 10, outputTokens: 2 } }]);
  });
});

describe('what teamai score answers for a run its local driver drove', () => {
  it('gives no label to a scorer whose label the write step failed to store, and says which step failed', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer() });
    const reviewed = await reviewedRun(config);
    const { runId, ended } = await walk(config, `run:${reviewed}:review:1`, { inputs: { scorers: ['quality'], demand: 'named' }, judge: { answer: { label: 'good', reasoning: 'ok' } }, fake: { write: { ok: false, code: 'write_failed', message: 'The disk is full.' } } });

    expect(await ScoreAnswer.of(config, runId, ended, ['quality'])).toEqual({ error: { code: 'score_step_failed', message: `Run ${runId}: quality got no label (score_step_failed): step score[0].write failed: The disk is full.`, labels: [] } });
  });

  it('says, after the run, that a scorer whose label the write step failed to store got score_step_failed, not its label', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer() });
    const reviewed = await reviewedRun(config);
    const { runId, ended } = await walk(config, `run:${reviewed}:review:1`, { inputs: { scorers: ['quality'] }, judge: { answer: { label: 'good', reasoning: 'ok' } }, fake: { write: { ok: false, code: 'busy', message: 'Another teamai process holds the label store.' } } });

    expect(PassScoring.said(`run:${reviewed}:review:1`, RunIdSchema.parse(runId), ended)).toEqual({ kind: 'scored', line: `run:${reviewed}:review:1: quality score_step_failed (teamai-score run ${runId}).` });
  });

  it('answers the label the run wrote for the one scorer named, with where its reasoning is', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer() });
    const reviewed = await reviewedRun(config);
    const { runId, ended } = await walk(config, `run:${reviewed}:review:1`, { inputs: { scorers: ['quality'], demand: 'named' }, judge: { answer: { label: 'good', reasoning: 'ok' } } });

    expect(await ScoreAnswer.of(config, runId, ended, ['quality'])).toEqual({ data: { run: runId, label: expect.objectContaining({ scorer: 'quality', label: 'good', passed: true, judge: { kind: 'model', tool: 'claude' }, decidedBy: 'judge', reasoning: expect.stringContaining(path.join(config.dataHome ?? '', '')) }) } });
  });

  it('answers the label its own run wrote, not a newer one another run wrote for the same scorer on another pass', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer() });
    const first = await reviewedRun(config);
    const second = await reviewedRun(config);
    const { runId, ended } = await walk(config, `run:${first}:review:1`, { inputs: { scorers: ['quality'], demand: 'named' }, judge: { answer: { label: 'good', reasoning: 'ok' } } });
    await walk(config, `run:${second}:review:1`, { inputs: { scorers: ['quality'], demand: 'named' }, judge: { answer: { label: 'bad', reasoning: 'no' } } });

    expect(await ScoreAnswer.of(config, runId, ended, ['quality'])).toEqual({ data: { run: runId, label: expect.objectContaining({ scorer: 'quality', label: 'good', subject: { runId: first, step: 'review', pass: 1 } }) } });
  });

  it('answers every label of a batch', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const reviewed = await reviewedRun(config);
    const { runId, ended } = await walk(config, `run:${reviewed}:review:1`, { inputs: { batch: true, demand: 'named' }, judge: { answer: { quality: { label: 'good', reasoning: 'Covers it.' }, coverage: { label: 'bad', reasoning: 'No tests.' } } } });
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);

    const answered = await ScoreAnswer.of(config, runId, ended, ['quality', 'coverage']);

    expect(answered).toEqual({ data: { run: runId, labels: [expect.objectContaining({ scorer: 'quality', label: 'good' }), expect.objectContaining({ scorer: 'coverage', label: 'bad' })] } });
    const reasoning = z.object({ data: z.object({ labels: z.array(z.object({ reasoning: z.string() })) }) }).parse(answered).data.labels.map((label) => label.reasoning);
    expect(info.mock.calls.map(([line]) => line)).toEqual([
      `quality: good (score 1, passed). Reasoning: ${reasoning[0]}`,
      `coverage: bad (score 0, did not pass). Reasoning: ${reasoning[1]}`,
      `To share what went wrong, ask your agent to read ${reasoning[1]} and share it with the team (teamai contribute).`,
    ]);
  });

  it('names the session a label that did not pass is of, so the agent can share what went wrong with it', async () => {
    const config = await team({}, { quality: scorer() });
    plantSession(path.join(root, 'app'), 'one', 'Fix the login bug.');
    const { runId, ended } = await walk(config, 'session:claude-code:one', { inputs: { scorers: ['quality'], demand: 'named' }, judge: { answer: { label: 'bad', reasoning: 'It missed the bug.' } } });
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);

    await ScoreAnswer.of(config, runId, ended, ['quality']);

    expect(info.mock.calls.map(([line]) => line)).toContainEqual(expect.stringMatching(/^To share what went wrong, ask your agent to read .+ and share it with the team \(teamai contribute --session-id one\)\.$/u));
  });

  it('gives no label to a scorer whose evidence could not be gathered, and says why', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer() });
    const reviewed = await reviewedRun(config);
    const { runId, ended } = await walk(config, `run:${reviewed}:review:1`, { inputs: { scorers: ['quality'], demand: 'named' }, fake: { evidence: { ok: false, code: 'evidence_missing', message: 'The session is gone.' } } });

    expect(await ScoreAnswer.of(config, runId, ended, ['quality'])).toEqual({ error: { code: 'score_step_failed', message: `Run ${runId}: quality got no label (score_step_failed): step score[0].evidence failed: The session is gone.`, labels: [] } });
  });

  it('answers the code of a scorer its judge left unlabelled', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer() });
    const reviewed = await reviewedRun(config);
    const { runId, ended } = await walk(config, `run:${reviewed}:review:1`, { inputs: { scorers: ['quality'], demand: 'named' }, judge: 'failed' });

    expect(await ScoreAnswer.of(config, runId, ended, ['quality'])).toEqual({ error: { code: 'judge_failed', message: `Run ${runId}: quality got no label (judge_failed): its judge failed: The judge exited 1.`, labels: [] } });
  });

  it('says in words why a scorer got no label for every code its label step gives, not the bare code', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer() });
    const reviewed = await reviewedRun(config);
    const label: ScoreVerbAnswer = { ok: true, output: { labels: [{ scorer: 'quality', label: '', code: 'evidence_empty' }] } };
    const { runId, ended } = await walk(config, `run:${reviewed}:review:1`, { inputs: { scorers: ['quality'], demand: 'named' }, judge: { answer: { label: 'good', reasoning: 'ok' } }, fake: { label } });

    expect(await ScoreAnswer.of(config, runId, ended, ['quality'])).toMatchObject({ error: { code: 'evidence_empty', message: `Run ${runId}: quality got no label (evidence_empty): nothing of its transcript or diff was kept, so there was nothing to judge.` } });
  });

  it('answers not_planned for a scorer another teamai-score run holds, beside the label of one it judged', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const reviewed = await reviewedRun(config);
    const holder = await scoreRun(config, { subject: `run:${reviewed}:review:1`, scorers: ['coverage'], demand: 'named' });
    const planning = await holder.next('plan');
    await holder.report(planning, await ScoreVerbs.plan({ subject: `run:${reviewed}:review:1`, scorers: '["coverage"]', batch: 'false', demand: 'named' }, planning.ctx));
    const { runId, ended } = await walk(config, `run:${reviewed}:review:1`, { inputs: { scorers: ['quality', 'coverage'], demand: 'named' }, judge: { answer: { label: 'good', reasoning: 'ok' } } });

    expect(await ScoreAnswer.of(config, runId, ended, ['quality', 'coverage'])).toEqual({ error: {
      code: 'not_planned',
      message: `Run ${runId}: coverage got no label (not_planned): it was not planned: another teamai-score run holds its judge work. Kept the label of quality: good.`,
      labels: [expect.objectContaining({ scorer: 'quality', label: 'good' })],
    } });
  });

  it('answers judge_pending for a scorer whose judge step the local driver left open', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer() });
    const reviewed = await reviewedRun(config);
    const run = await scoreRun(config, { subject: `run:${reviewed}:review:1`, scorers: ['quality'], demand: 'named' });
    const planning = await run.next('plan');
    await run.report(planning, await ScoreVerbs.plan({ subject: `run:${reviewed}:review:1`, scorers: '["quality"]', batch: 'false', demand: 'named' }, planning.ctx));
    const gathering = await run.next('score[0].evidence');
    await run.report(gathering, await ScoreVerbs.evidence({ subject: `run:${reviewed}:review:1`, scorers: 'quality' }, gathering.ctx));
    const held: WorkflowEnvelope = { error: { code: 'confined_pending', message: 'No judge tool here runs model fast.' } };

    expect(await ScoreAnswer.of(config, run.runId, held, ['quality'])).toEqual({ error: {
      code: 'judge_pending',
      message: `Run ${run.runId} left the judge of quality open for a driver that can run it: No judge tool here runs model fast. The run waits for one until its timeout, and teamai score --drain lists it.`,
      labels: [],
    } });
  });

  it('answers nothing of its own for a run that did not succeed, or one it cannot read, so the driver\'s answer stands', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer() });
    const reviewed = await reviewedRun(config);
    const { runId } = await walk(config, `run:${reviewed}:review:1`, { inputs: { scorers: ['quality'], demand: 'named' }, judge: { answer: { label: 'good', reasoning: 'ok' } } });

    expect(await ScoreAnswer.of(config, runId, { data: { run: runId, done: { outcome: 'failed' } } }, ['quality'])).toBeUndefined();
    expect(await ScoreAnswer.of(config, runId, { error: { code: 'step_failed', message: 'The run failed.' } }, ['quality'])).toBeUndefined();
    expect(await ScoreAnswer.of(config, runId, { data: { run: runId } }, ['quality'])).toBeUndefined();
    expect(await ScoreAnswer.of(config, 'r0000000000000000', { data: { run: 'r0000000000000000', done: { outcome: 'succeeded' } } }, ['quality'])).toBeUndefined();
  });
});

describe('scorer files tried in a teamai-score run', () => {
  const SESSION_KEY = { kind: 'session' as const, subject: { platform: 'claude-code', sessionId: 'one' } };

  /** A team with no scorer, session `one` in its checkout, and the scorer file `<root>/draft/quality.md`. */
  async function drafted(): Promise<{ config: LocalConfig; file: string }> {
    const config = await team({}, {});
    plantSession(config.projectRoot ?? '', 'one', 'Add retries to the client.');
    const file = path.join(root, 'draft', 'quality.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, scorer({ rate: 0 }));
    return { config, file };
  }

  it('labels a session with a file, writes no label and opens no mark when store is false', async () => {
    const { config, file } = await drafted();
    const { answers } = await walk(config, 'session:claude-code:one', { judge: { answer: { label: 'good', reasoning: 'It ran the tests.' } }, inputs: { files: [file], store: false, demand: 'named' } });

    expect(answers.get('plan')).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality' }] } });
    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: 'good', code: '' }] } });
    expect(answers.get('score[0].write')).toEqual({ ok: true, output: { written: 0, labels: [] } });
    expect(await LabelStore.local(config)).toEqual([]);
    const sourceHash = createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex');
    expect(await Marks.states(config, [{ scorer: 'quality', subject: SESSION_KEY, sourceHash }], markFacts(config, NOW))).toEqual([{ kind: 'unmarked' }]);
  });

  it('gives the judge the session\'s first prompt alone when control is true', async () => {
    const { config, file } = await drafted();
    const seen: { transcript?: string } = {};
    await walk(config, 'session:claude-code:one', { judge: { answer: { label: 'bad', reasoning: 'Nothing was done.' } }, inputs: { files: [file], store: false, control: true, demand: 'named' }, after: {
      'score[0].evidence': async (answers) => {
        const evidence = answers.get('score[0].evidence');
        seen.transcript = fs.readFileSync(path.join(evidence?.ok ? String(evidence.output.dir) : '', 'transcripts', 'session.md'), 'utf8');
      },
    } });

    expect(seen.transcript).toContain('Add retries to the client.');
    expect(seen.transcript).not.toContain('Reviewed.');
  });

  it('refuses scorer files in a run that stores its labels, and a file teamai pull would not take', async () => {
    const { config, file } = await drafted();
    const planOf = async (inputs: Record<string, unknown>) => ScoreVerbs.plan({ subject: 'session:claude-code:one', scorers: '[]', batch: 'false', demand: 'named' }, (await (await scoreRun(config, { subject: 'session:claude-code:one', demand: 'named', ...inputs })).next('plan')).ctx);

    expect(await planOf({ files: [file], store: true })).toEqual({ ok: false, code: 'invalid_arguments', message: `A scorer file's label is never stored, and this teamai-score run stores its labels: ${file}. Start it with store false.` });
    fs.writeFileSync(file, scorer().replace('passingScore: 1', 'passingScore: 2'));
    expect(await planOf({ files: [file], store: false })).toMatchObject({ ok: false, code: 'scorer_invalid' });
  });
});
