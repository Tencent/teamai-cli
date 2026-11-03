import { execFileSync } from 'node:child_process';
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

import type { LocalConfig } from '../types.js';
import { knownSecrets } from '../env-resolution.js';
import { attemptEnv } from '../workflow/attempt-marker.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import type { DriverIdentity, StartedBy, WorkflowEnvelope } from '../workflow/types.js';
import { ScoreVerbs, type PlanOptions, type ScoreVerbAnswer, type ScoreVerbContext } from '../score-verbs.js';
import { LabelStore } from '../scorers/label-store.js';
import { Marks } from '../scorers/marks.js';
import type { JudgeRun } from '../scorers/score-labels.js';
import { evidenceHash } from '../scorers/scoring-evidence.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import { nextJudgeLease } from '../workflow/scoring.js';
import { runScratchDir, updateRun } from '../workflow/store.js';
import type { StepState } from '../workflow/step-state.js';
import { PrUrlSchema } from '../workflow/pr-url.js';

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

/** teamai-score as the issue writes it, with a command judge in place of the confined prompt step. */
const SCORE = `schemaVersion: v1alpha1
name: teamai-score
description: Label one subject with the scorers that apply to it.
invoke: deny
private: true
inputs:
  subject: string
  scorers: [string]
  label: string
  batch: boolean
  demand: string
steps:
  - id: plan
    command: teamai score plan
    output:
      groups: [{ subject: string, hand: string, scorers: string, model: string, ci: boolean, protected: boolean }]
  - id: score
    needs: [plan]
    if: length(steps.plan.outputs.groups) > 0
    for_each: steps.plan.outputs.groups
    continue_on_failure: true
    workflow:
      outputs: { labels: steps.label.outputs.labels }
      steps:
        - id: evidence
          command: teamai score evidence
          output: { dir: string, rubric: string, schema: string, delivers: boolean }
        - id: check
          needs: [evidence]
          if: item.hand == '' && steps.evidence.outputs.delivers
          command: teamai score stage check
          output: { decided: boolean }
        - id: ci
          needs: [evidence, check]
          if: item.hand == '' && item.ci && steps.evidence.outputs.delivers && steps.check.outputs.decided != true
          command: teamai score stage ci
          output: { decided: boolean, pending: boolean }
        - id: protected
          needs: [evidence, ci]
          if: item.hand == '' && item.protected && steps.evidence.outputs.delivers && steps.check.outputs.decided != true && steps.ci.outputs.decided != true && steps.ci.outputs.pending != true
          command: teamai score stage protected
          output: { decided: boolean }
        - id: judge
          needs: [evidence, protected]
          if: item.hand == '' && steps.check.outputs.decided != true && steps.ci.outputs.decided != true && steps.ci.outputs.pending != true && steps.protected.outputs.decided != true
          command: judge
          output: { answer: json }
        - id: label
          needs: [evidence, judge]
          if: steps.evidence.outcome == 'success' && steps.judge.outcome != 'cancelled'
          command: teamai score label
          output: { labels: [{ scorer: string, label: string, code: string }] }
        - id: write
          needs: [label]
          command: teamai score write
        - id: settle
          needs: [evidence, write]
          if: "!(steps.evidence.outcome == 'success' || steps.evidence.outcome == 'skipped') || !(steps.label.outcome == 'success' || steps.label.outcome == 'skipped') || !(steps.write.outcome == 'success' || steps.write.outcome == 'skipped')"
          command: teamai score settle
outputs: { labels: steps.score.results }
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
  for (const [name, text] of Object.entries({ 'teamai-score': SCORE, ...workflows })) fs.writeFileSync(path.join(knowledge, 'workflows', `${name}.yaml`), text);
  for (const [name, text] of Object.entries(scorers)) fs.writeFileSync(path.join(knowledge, 'scorers', `${name}.md`), text);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: checkout, dataHome: path.join(root, 'data'),
  };
  await syncWorkflowDefinitions(config);
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

interface Taken {
  ctx: ScoreVerbContext;
  attempt: string;
  revision: number;
}

interface ScoreRun {
  runId: string;
  /** The context of the attempt the engine leased next, for the step `step`. */
  next(step: string): Promise<Taken>;
  /** Reports what a verb answered as the attempt's outputs, or its failure. */
  report(taken: Taken, answer: ScoreVerbAnswer): Promise<void>;
}

/** A teamai-score run of `inputs`, started by `startedBy`, whose leases a test takes one by one. */
async function scoreRun(config: LocalConfig, inputs: Record<string, unknown>, startedBy: StartedBy = 'cli'): Promise<ScoreRun> {
  const runId = String(data(await startRun(config, 'teamai-score', { scorers: [], label: '', batch: false, demand: 'auto', ...inputs }, { secrets: await knownSecrets(config), startedBy })).run);
  return {
    runId,
    async next(step) {
      const lease = LeaseSchema.parse(data(await leaseNext(config, runId, external)).lease);
      expect(lease.step).toBe(step);
      return { ctx: { env: attemptEnv(config, runId, lease.attempt, 'unattended'), current: config, now: NOW }, attempt: lease.attempt, revision: lease.revision };
    },
    async report({ attempt, revision }, answer) {
      data(await reportAttempt(config, runId, answer.ok
        ? { attempt, revision, outcome: 'success', driver: external, outputs: answer.output }
        : { attempt, revision, outcome: 'failed', driver: external, failure: { code: 'command_failed', message: answer.message } }));
    },
  };
}

describe('score plan', () => {
  it('refuses a call from a shell no teamai-score attempt runs, and opens no mark', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);

    expect(await ScoreVerbs.plan({ subject: `run:${runId}:review:1`, scorers: '[]', label: '', batch: 'false', demand: 'auto' }, { env: {}, current: config, now: NOW })).toEqual({
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

    expect(await ScoreVerbs.plan({ subject, scorers: '[]', label: '', batch: 'false', demand: 'auto' }, ctx)).toEqual({ ok: true, output: { groups: [
      { subject, hand: '', scorers: 'quality', model: '', ci: false, protected: false },
      { subject, hand: '', scorers: 'coverage', model: '', ci: false, protected: false },
    ] } });
  });

  it('groups batched scorers by the stages they take: a scorer that does not wait for CI is judged apart from one that does', async () => {
    const config = await team({ ship: SHIP }, { clarity: scorer({ extra: 'stages: [protected]\n' }), delivered: scorer() });
    const runId = await deliveredRun(config);
    const subject = `run:${runId}:change:1`;
    const { ctx } = await (await scoreRun(config, { subject, batch: true })).next('plan');

    expect(await ScoreVerbs.plan({ subject, scorers: '[]', label: '', batch: 'true', demand: 'auto' }, ctx)).toEqual({ ok: true, output: { groups: [
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

    expect(await ScoreVerbs.plan({ subject, scorers: '[]', label: '', batch: 'true', demand: 'auto' }, ctx)).toMatchObject({ ok: true, output: { groups: [
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

    expect(await ScoreVerbs.plan({ subject, scorers: '[]', label: '', batch: 'false', demand: 'auto' }, first.ctx)).toMatchObject({ ok: true, output: { groups: [{ scorers: 'coverage' }] } });
    expect(await ScoreVerbs.plan({ subject, scorers: '[]', label: '', batch: 'false', demand: 'auto' }, second.ctx)).toEqual({ ok: true, output: { groups: [] } });
  });

  it('counts a batch of scorers on one session once toward the daily limit, and past it plans nothing', async () => {
    const config = { ...await team({}, { quality: scorer(), coverage: scorer() }), scoring: { daily_limit: 1 } };
    const plan = async (subject: string, demand = 'auto') => ScoreVerbs.plan({ subject, scorers: '["quality","coverage"]', label: '', batch: 'true', demand },
      (await (await scoreRun(config, { subject, demand })).next('plan')).ctx);

    expect(await plan('session:claude-code:one')).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality,coverage' }] } });
    expect(await plan('session:claude-code:two')).toEqual({ ok: true, output: { groups: [] } });
    expect(await plan('session:claude-code:two', 'named')).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality,coverage' }] } });
  });

  it('takes a hand label only from a run a person started, as one group with no stage', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const subject = 'session:claude-code:one';
    const options = { subject, scorers: '["quality"]', label: 'good', batch: 'false', demand: 'named' };

    expect(await ScoreVerbs.plan(options, (await (await scoreRun(config, { subject, label: 'good' })).next('plan')).ctx)).toMatchObject({ ok: false, code: 'hand_label_refused' });
    const byPerson = (await (await scoreRun(config, { subject, label: 'good' }, 'person')).next('plan')).ctx;
    expect(await ScoreVerbs.plan(options, byPerson)).toEqual({ ok: true, output: { groups: [{ subject, hand: 'good', scorers: 'quality', model: '', ci: false, protected: false }] } });
    expect(await ScoreVerbs.plan({ ...options, label: 'great' }, byPerson)).toEqual({ ok: false, code: 'label_invalid', message: '"great" is not a label of scorer quality. Use one of: good, bad.' });
    expect(fs.existsSync(path.join(root, 'data', 'scores', 'marks.jsonl'))).toBe(false);
  });
});

/** Plans `subject` in a new teamai-score run, reports the plan, and leases the first group's evidence step. */
async function plannedGroup(config: LocalConfig, subject: string, inputs: Record<string, unknown> = {}, startedBy: StartedBy = 'cli'): Promise<{ run: ScoreRun; evidence: Taken; scorers: string }> {
  const run = await scoreRun(config, { subject, ...inputs }, startedBy);
  const plan = await run.next('plan');
  const planned = await ScoreVerbs.plan({ subject, scorers: JSON.stringify(inputs.scorers ?? []), label: String(inputs.label ?? ''), batch: String(inputs.batch ?? false), demand: String(inputs.demand ?? 'auto') }, plan.ctx);
  await run.report(plan, planned);
  const groups = z.object({ groups: z.array(z.object({ scorers: z.string() })) }).parse(planned.ok ? planned.output : {});
  return { run, evidence: await run.next('score[0].evidence'), scorers: groups.groups[0]?.scorers ?? '' };
}

describe('score evidence', () => {
  it('writes the evidence of a pass into the attempt\'s own directory, hashed as the judge lease of main hashes it', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer({ extra: 'isolation: verified\n' }) });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const { run, evidence, scorers } = await plannedGroup(config, subject, { scorers: ['coverage'] });
    const dir = path.join(runScratchDir(config, run.runId), evidence.attempt);

    expect(await ScoreVerbs.evidence({ subject, scorers }, evidence.ctx)).toEqual({ ok: true, output: {
      dir, rubric: expect.stringContaining('Judge the work.'), schema: path.join(dir, 'answer.schema.json'), delivers: false,
    } });
    const lease = z.object({ evidence: z.string() }).parse(data(await nextJudgeLease(config, { driver: external, judge: { isolation: 'verified', tools: ['claude'] }, running: [] })).lease);
    expect(await evidenceHash(dir)).toBe(await evidenceHash(lease.evidence));
    expect(await evidenceHash(dir)).toMatch(/^sha256:/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'confined.json'), 'utf8'))).toEqual({
      level: 'verified', prefer: 'claude',
      schema: { type: 'object', properties: { answer: JSON.parse(fs.readFileSync(path.join(dir, 'answer.schema.json'), 'utf8')) }, required: ['answer'], additionalProperties: false },
    });
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

    expect(await ScoreVerbs.stage({ stage: 'ci', evidence: dir, wait: '2h' }, next.ctx)).toEqual({ ok: true, output: { decided: true } });
    expect(await ScoreVerbs.stage({ stage: 'ci', evidence: dir, wait: '2h' }, next.ctx)).toEqual({ ok: true, output: { decided: true } });
    expect(mocks.ci).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stage-ci.json'), 'utf8'))).toEqual({ kind: 'decided', by: 'ci', reasoning: expect.stringContaining('pull/57 failed') });
  });

  it('ci that has not finished writes a pending record, and past --wait is judged as no CI', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const { dir, next } = await deliveredGroup(config, await deliveredRun(config));
    mocks.ci.mockResolvedValue({ kind: 'read', status: 'pending' });

    expect(await ScoreVerbs.stage({ stage: 'ci', evidence: dir, wait: '2h' }, next.ctx)).toEqual({ ok: true, output: { decided: false, pending: true } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stage-ci.json'), 'utf8'))).toMatchObject({ kind: 'pending' });
    const later = { ...next.ctx, now: '2026-11-03T12:00:01.000Z' };
    expect(await ScoreVerbs.stage({ stage: 'ci', evidence: dir, wait: '2h' }, later)).toEqual({ ok: true, output: { decided: false } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stage-ci.json'), 'utf8'))).toEqual({ kind: 'judge' });
  });

  it('protected decides a pass whose delivery refused a protected path', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const { dir, next } = await deliveredGroup(config, await deliveredRun(config, { code: 'protected_path', message: 'Step "change" changed protected paths against the run base: AGENTS.md.' }));

    expect(await ScoreVerbs.stage({ stage: 'protected', evidence: dir }, next.ctx)).toEqual({ ok: true, output: { decided: true } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stage-protected.json'), 'utf8'))).toEqual({ kind: 'decided', by: 'protected', reasoning: expect.stringContaining('AGENTS.md') });
  });

  it('refuses a directory that is not an evidence directory of the attempt\'s run', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const { next } = await deliveredGroup(config, await deliveredRun(config));

    expect(await ScoreVerbs.stage({ stage: 'protected', evidence: root }, next.ctx)).toMatchObject({ ok: false, code: 'evidence_unreadable' });
  });
});

const JUDGED: JudgeRun = { tool: 'claude', model: { requested: 'claude-x' }, usage: { inputTokens: 10, outputTokens: 2 }, isolation: 'verified', access: 'read' };

interface Walk {
  /** The judge step's answer, or a failure. */
  judge?: { answer: unknown } | 'failed';
  readJudgeRun?: ScoreVerbContext['readJudgeRun'];
  inputs?: Record<string, unknown>;
  startedBy?: StartedBy;
  /** What a step answers in place of its verb, by step id. */
  fake?: Record<string, ScoreVerbAnswer>;
}

/** Drives a teamai-score run of `subject` to its end, each step by its verb, and returns what each verb answered by step path. */
async function walk(config: LocalConfig, subject: string, { judge, readJudgeRun = () => JUDGED, inputs = {}, startedBy = 'cli', fake = {} }: Walk = {}): Promise<{ runId: string; answers: Map<string, ScoreVerbAnswer> }> {
  const run = await scoreRun(config, { subject, ...inputs }, startedBy);
  const answers = new Map<string, ScoreVerbAnswer>();
  const items = (index: string) => {
    const plan = answers.get('plan');
    const groups = z.object({ groups: z.array(z.object({ subject: z.string(), scorers: z.string() })) }).safeParse(plan?.ok ? plan.output : {}).data?.groups ?? [];
    const evidence = answers.get(`score[${index}].evidence`);
    return { item: groups[Number(index)], dir: z.object({ dir: z.string() }).safeParse(evidence?.ok ? evidence.output : {}).data?.dir };
  };
  for (;;) {
    const next = data(await leaseNext(config, run.runId, external));
    if (next.done) return { runId: run.runId, answers };
    const lease = LeaseSchema.parse(next.lease);
    const taken = { ctx: { env: attemptEnv(config, run.runId, lease.attempt, 'unattended'), current: config, now: NOW, readJudgeRun }, attempt: lease.attempt, revision: lease.revision };
    const [, index = '0', id = lease.step] = /^score\[(\d+)\]\.(.+)$/u.exec(lease.step) ?? [];
    const { item, dir } = items(index);
    const judged = answers.get(`score[${index}].judge`);
    const answer: ScoreVerbAnswer = fake[id] ?? (id === 'plan'
      ? await ScoreVerbs.plan({ subject, scorers: JSON.stringify(inputs.scorers ?? []), label: String(inputs.label ?? ''), batch: String(inputs.batch ?? false), demand: String(inputs.demand ?? 'auto') }, taken.ctx)
      : id === 'evidence' ? await ScoreVerbs.evidence({ subject: item?.subject, scorers: item?.scorers }, taken.ctx)
        : id === 'check' || id === 'ci' || id === 'protected' ? await ScoreVerbs.stage({ stage: id, evidence: dir, wait: '2h' }, taken.ctx)
          : id === 'judge' ? (judge === 'failed' || judge === undefined ? { ok: false, code: 'judge_failed', message: 'The judge exited 1.' } : { ok: true, output: { answer: z.json().parse(judge.answer) } })
            : id === 'label' ? await ScoreVerbs.label({ evidence: dir, answer: judged?.ok ? JSON.stringify(judged.output.answer) : '', judge: judged === undefined ? '' : judged.ok ? 'success' : 'failed' }, taken.ctx)
              : id === 'write' ? await ScoreVerbs.write({ evidence: dir }, taken.ctx)
                : await ScoreVerbs.settle({ subject: item?.subject, scorers: item?.scorers }, taken.ctx));
    answers.set(lease.step, answer);
    await run.report(taken, answer);
  }
}

const marksOf = async (config: LocalConfig, runId: string, scorers: string[]) =>
  Marks.states(config, scorers.map((name) => ({ scorer: name, subject: { kind: 'run' as const, subject: { runId, step: 'review', pass: 1 } } })), { now: NOW, readRun: async () => ({ ended: true, changedAt: NOW }) });

describe('score label and score write', () => {
  it('label each scorer of a batch from the judge\'s answer, print no reasoning, and write them with what judged, closing their marks', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const { answers } = await walk(config, `run:${runId}:review:1`, { inputs: { batch: true }, judge: { answer: { quality: { label: 'good', reasoning: 'Covers it.' }, coverage: { label: 'bad', reasoning: 'No tests.' } } } });

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: 'good', code: '' }, { scorer: 'coverage', label: 'bad', code: '' }] } });
    expect(answers.get('score[0].write')).toEqual({ ok: true, output: { written: 2 } });
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
  ])('give each scorer a code for %s, and write records the failed attempt', async (_case, judge, code) => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const { answers } = await walk(config, `run:${runId}:review:1`, { inputs: { scorers: ['quality'] }, judge });

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: '', code }] } });
    expect(answers.get('score[0].write')).toEqual({ ok: true, output: { written: 0 } });
    expect(await LabelStore.local(config)).toEqual([]);
    expect(await marksOf(config, runId, ['quality'])).toEqual([{ kind: 'failed', code }]);
  });

  it('give judge_failed when the judge step recorded no confined run, so what judged is unknown', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const { answers } = await walk(config, `run:${runId}:review:1`, { inputs: { scorers: ['quality'] }, judge: { answer: { label: 'good', reasoning: 'ok' } }, readJudgeRun: () => undefined });

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

  it('label a session by hand only in a run a person started, and set no mark', async () => {
    const config = await team({}, { quality: scorer() });
    plantSession(path.join(root, 'app'), 'one', 'Fix the login bug.');
    const subject = 'session:claude-code:one';
    const inputs = { scorers: ['quality'], label: 'good', demand: 'named' };

    expect((await walk(config, subject, { inputs })).answers.get('plan')).toMatchObject({ ok: false, code: 'hand_label_refused' });
    const { answers } = await walk(config, subject, { inputs, startedBy: 'person' });

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'quality', label: 'good', code: '' }] } });
    expect(await LabelStore.local(config)).toMatchObject([{ scorer: 'quality', label: 'good', source: 'session', subject: { platform: 'claude-code', sessionId: 'one' }, judge: { kind: 'human' } }]);
    expect(fs.existsSync(path.join(root, 'data', 'scores', 'marks.jsonl'))).toBe(false);
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

describe('score subjects', () => {
  it('lists the passes of steps that start their own scoring, --step read from the calling attempt\'s workflow', async () => {
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
  });

  it('lists a lapse, and a pass that waited on CI once its CI finished, but not one still waiting', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]') }, { clarity: scorer() });
    const runId = await deliveredRun(config);
    const pass = { kind: 'run' as const, subject: { runId, step: 'change', pass: 1 } };
    const session = { kind: 'session' as const, subject: { platform: 'claude-code', sessionId: 'one' } };
    const facts = { now: NOW, readRun: async () => undefined };
    await Marks.open(config, { run: 'r0000000000000001', demand: 'auto', groups: [{ group: 'clarity', keys: [{ scorer: 'clarity', subject: pass }] }, { group: 'q', keys: [{ scorer: 'q', subject: session, sourceHash: 'h' }] }] }, facts);
    await Marks.close(config, [{ scorer: 'clarity', subject: pass }], { kind: 'waiting' }, facts);
    const lapsed = () => ScoreVerbs.subjects({ lapsed: true }, { env: {}, current: config, now: NOW });

    mocks.ci.mockResolvedValue({ kind: 'read', status: 'pending' });
    expect(await lapsed()).toEqual({ ok: true, output: { list: ['session:claude-code:one'] } });
    mocks.ci.mockResolvedValue({ kind: 'read', status: 'passed' });
    expect(await lapsed()).toEqual({ ok: true, output: { list: [`run:${runId}:change:1`, 'session:claude-code:one'] } });
  });
});

describe('score verbs refuse what they cannot act on', () => {
  it.each<[string, PlanOptions, string]>([
    ['a subject that is none', { subject: 'pass:1' }, 'subject_invalid'],
    ['scorers that are neither JSON nor names', { scorers: '[1]' }, 'invalid_arguments'],
    ['a demand that is neither auto nor named', { demand: 'now' }, 'invalid_arguments'],
    ['a batch that is not a boolean', { batch: 'yes' }, 'invalid_arguments'],
    ['a pass the run does not have', { subject: 'run:RUN:review:2' }, 'pass_not_found'],
    ['a scorer the run did not pin', { scorers: '["tests"]' }, 'scorer_not_found'],
  ])('plan refuses %s', async (_case, options, code) => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = (options.subject ?? 'run:RUN:review:1').replace('RUN', runId);
    const { ctx } = await (await scoreRun(config, { subject: `run:${runId}:review:1` })).next('plan');

    expect(await ScoreVerbs.plan({ scorers: '[]', label: '', batch: 'false', demand: 'auto', ...options, subject }, ctx)).toMatchObject({ ok: false, code });
  });

  it('plan batches the scorers of a step whose workflow sets defaults.scorers.batch', async () => {
    const config = await team({ review: REVIEW.replace('steps:', 'defaults: { scorers: { batch: true } }\nsteps:') }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const { ctx } = await (await scoreRun(config, { subject })).next('plan');

    expect(await ScoreVerbs.plan({ subject, scorers: '[]', label: '', batch: 'false', demand: 'auto' }, ctx)).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality,coverage' }] } });
  });

  it('write refuses labels.json that is not what label wrote, and writes nothing', async () => {
    const config = await team({ review: REVIEW }, { quality: scorer(), coverage: scorer() });
    const runId = await reviewedRun(config);
    const subject = `run:${runId}:review:1`;
    const { run, evidence, scorers } = await plannedGroup(config, subject, { scorers: ['quality'] });
    const written = await ScoreVerbs.evidence({ subject, scorers }, evidence.ctx);
    await run.report(evidence, written);
    const judge = await run.next('score[0].judge');
    await run.report(judge, { ok: true, output: { answer: { label: 'bad', reasoning: 'no' } } });
    const label = await run.next('score[0].label');
    const dir = z.object({ dir: z.string() }).parse(written.ok ? written.output : {}).dir;
    await run.report(label, await ScoreVerbs.label({ evidence: dir, answer: '{"label":"bad","reasoning":"no"}', judge: 'success' }, { ...label.ctx, readJudgeRun: () => JUDGED }));
    const file = path.join(dir, 'labels.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"label":"bad","score":0,"passed":false', '"label":"good","score":0,"passed":false'));

    expect(await ScoreVerbs.write({ evidence: dir }, (await run.next('score[0].write')).ctx)).toMatchObject({ ok: false, code: 'label_invalid', message: expect.stringContaining('"good" with score 0 is not a label of scorer quality') });
    expect(await LabelStore.local(config)).toEqual([]);
  });
});

/** A claude on PATH, which the stage-decided label names as the judge that would have run. */
function claudeOnPath(): void {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
}

describe('labels a stage decided', () => {
  const clarityOnly = SHIP.replace('{ names: [clarity, delivered], batch: true }', '[clarity]');

  it('give the scorer\'s best failing label, decided by protected paths, with the judge that would have run', async () => {
    const config = await team({ ship: clarityOnly }, { clarity: scorer() });
    claudeOnPath();
    const runId = await deliveredRun(config, { code: 'protected_path', message: 'Step "change" changed protected paths against the run base: AGENTS.md.' });
    mocks.ci.mockResolvedValue({ kind: 'unsupported' });
    const { answers } = await walk(config, `run:${runId}:change:1`);

    expect(answers.has('score[0].judge')).toBe(false);
    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'clarity', label: 'bad', code: '' }] } });
    expect(await LabelStore.local(config)).toMatchObject([{ scorer: 'clarity', label: 'bad', passed: false, decidedBy: 'protected', judge: { kind: 'model', tool: 'claude', isolation: 'best-effort' } }]);
  });

  it('give ci_pending while CI has not finished, and leave the mark waiting for it', async () => {
    const config = await team({ ship: clarityOnly }, { clarity: scorer() });
    const runId = await deliveredRun(config);
    mocks.ci.mockResolvedValue({ kind: 'read', status: 'pending' });
    const { answers } = await walk(config, `run:${runId}:change:1`);

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'clarity', label: '', code: 'ci_pending' }] } });
    expect(await Marks.states(config, [{ scorer: 'clarity', subject: { kind: 'run', subject: { runId, step: 'change', pass: 1 } } }], { now: NOW, readRun: async () => ({ ended: false, changedAt: NOW }) })).toEqual([{ kind: 'waiting' }]);
  });

  it('give check_could_not_run for a check that could not run', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[delivered]') }, { delivered: scorer({ extra: 'check: { run: "exit 127", protect: [test] }\n' }) });
    const runId = await deliveredRun(config);
    const { answers } = await walk(config, `run:${runId}:change:1`);

    expect(answers.get('score[0].label')).toEqual({ ok: true, output: { labels: [{ scorer: 'delivered', label: '', code: 'check_could_not_run' }] } });
  });

  it('refuse to label a scorer with a check whose check stage left no record, and settle it', async () => {
    const config = await team({ ship: SHIP.replace('{ names: [clarity, delivered], batch: true }', '[delivered]') }, { delivered: scorer({ extra: 'check: { run: "exit 3", protect: [test] }\n' }) });
    const runId = await deliveredRun(config);
    mocks.ci.mockResolvedValue({ kind: 'unsupported' });
    const { answers } = await walk(config, `run:${runId}:change:1`, { judge: { answer: { label: 'good', reasoning: 'ok' } }, fake: { check: { ok: true, output: { decided: false } } } });

    expect(answers.get('score[0].label')).toMatchObject({ ok: false, code: 'stage_record_missing' });
    expect(answers.get('score[0].settle')).toEqual({ ok: true, output: { settled: 1 } });
    expect(await LabelStore.local(config)).toEqual([]);
  });
});
