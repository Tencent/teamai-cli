import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '' }));
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
import { ScoreVerbs, type ScoreVerbContext } from '../score-verbs.js';

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

/** A run of `review` whose one pass succeeded, as a driver reports it. */
async function reviewedRun(config: LocalConfig): Promise<string> {
  const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config), checkout: config.projectRoot })).run);
  const lease = LeaseSchema.parse(data(await leaseNext(config, runId, external)).lease);
  data(await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: external, tool: 'claude' }));
  return runId;
}

/** A run of `ship` whose `change` pass committed a pagination and went on to deliver it. */
async function deliveredRun(config: LocalConfig): Promise<string> {
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
  return runId;
}

interface ScoreRun {
  runId: string;
  /** The context of the attempt the engine leased next, for the step `step`. */
  next(step: string): Promise<{ ctx: ScoreVerbContext; attempt: string; revision: number }>;
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
