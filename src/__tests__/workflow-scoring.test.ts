import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import { LabelStore } from '../scorers/label-store.js';
import { RunScorers } from '../scorers/run-scorers.js';
import type { LocalConfig } from '../types.js';
import { leaseNext, parseNextPayload, parseReport, reportAttempt, startRun, type NextOptions } from '../workflow/engine.js';
import { projectRun } from '../workflow/snapshot.js';
import { scoredPasses } from '../workflow/judge-work.js';
import { cancelRun } from '../workflow/run-controls.js';
import { installOwner, readRun } from '../workflow/store.js';
import type { StepState } from '../workflow/step-state.js';
import type { DriverIdentity, RunState, WorkflowEnvelope } from '../workflow/types.js';
import { knownSecrets } from '../env-resolution.js';
import { scoreEvidenceDir, scoreJudgePrompt, scoreWrite } from './helpers/score-run.js';
import * as cliPaths from '../utils/cli-path.js';


const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const scorer = (samplingRate: number, isolation = '') => `---
labels:
  - { value: good, score: 1, description: Finds the real defects }
  - { value: missed, score: 0, description: Misses a real defect }
passingScore: 0.5
samplingRate: ${samplingRate}
${isolation}---
Judge the review.
`;

const WORKFLOW = `schemaVersion: v1alpha1
name: review
description: One reviewed step.
steps:
  - id: review
    prompt: Review the change.
    scorers: [quality, nope]
`;

function fixture(scorerText: string, overrides: Partial<LocalConfig> = {}): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-scoring-'));
  dirs.push(root);
  vi.spyOn(cliPaths, 'resolveCliPath').mockImplementation((cmd) => {
    const executable = path.join(root, 'bin', cmd);
    return fs.existsSync(executable) ? executable : null;
  });
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'workflows', 'review.yaml'), WORKFLOW);
  fs.writeFileSync(path.join(knowledge, 'scorers', 'quality.md'), scorerText);
  return {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'),
    ...overrides,
  };
}


const workDriver: DriverIdentity = { kind: 'external', machine: 'm1', workspace: '/w' };

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

async function runOf(config: LocalConfig, runId: string): Promise<RunState> {
  const run = await readRun(config, runId);
  if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
  return run;
}

/**
 * Starts the review workflow and settles its one step through workflow next and report, as an external driver would,
 * with `reported` added to its report payload and `asked` to its first next payload.
 */
async function settledRun(config: LocalConfig, reported: Record<string, unknown> = {}, asked: Omit<NextOptions, 'env'> = {}): Promise<string> {
  await syncScorersThenWorkflows(config);
  const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
  const lease = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, runId, workDriver, asked)).lease);
  const parsed = parseReport({ attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: workDriver, outputs: { reviewed: true }, ...reported });
  if (typeof parsed === 'string') throw new Error(parsed);
  data(await reportAttempt(config, runId, parsed.report));
  expect(data(await leaseNext(config, runId, workDriver))).toMatchObject({ done: { outcome: 'succeeded' } });
  return runId;
}

/** The label `teamai score write` keeps of the one pass of run `runId`'s review step, judged `good`. */
async function labelled(config: LocalConfig, runId: string, step = 'review'): Promise<Record<string, unknown>> {
  const written = await scoreWrite(config, `run:${runId}:${step}:1`, ['quality'], { label: 'good', reasoning: 'r' });
  if (!written.ok) throw new Error(`${written.code}: ${written.message}`);
  return z.object({}).passthrough().parse((await LabelStore.local(config))[0]);
}

describe('a scored run', () => {
  it('reads the scorers a run lists, skipping one with no valid file', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const run = await runOf(config, runId);
    const read = await RunScorers.of(config, run);
    expect(read.ok ? Object.keys(read.pins) : read.reason).toEqual(['quality']);
    expect(run.steps[0]).toMatchObject({ installId: (await installOwner(config)).id });
  });
});

describe('scoredPasses', () => {
  it('judges the agent pass of a step that delivers, for the install that reported it, whatever becomes of its delivery', async () => {
    const config = fixture(scorer(100));
    const run = await runOf(config, await settledRun(config));
    const install = (await installOwner(config)).id;
    const reported = { id: 'review', settledAt: 2, attempt: 'a1', installId: install, delivery: { branch: `teamai/${run.id}/review/p1`, head: 'c'.repeat(40) } };
    const judged = [{ subject: { runId: run.id, step: 'review', pass: 1 }, scorers: ['quality', 'nope'] }];
    const withStep = (step: StepState): RunState => ({ ...run, status: 'running', steps: [step] });

    expect(scoredPasses(withStep({ ...reported, status: 'delivering' }), install)).toEqual(judged);
    expect(scoredPasses(withStep({ ...reported, status: 'succeeded', outcome: 'success' }), install)).toEqual(judged);
    for (const code of ['delivery_failed', 'protected_path']) {
      expect(scoredPasses(withStep({ ...reported, status: 'failed', outcome: 'failed', failure: { code, message: 'm' } }), install)).toEqual(judged);
      const retried: StepState = { id: 'review', status: 'pending', pass: 2, passes: [{ pass: 1, outcome: 'failed', failure: { code, message: 'm' }, installId: install }] };
      expect(scoredPasses(withStep(retried), install)).toEqual(judged);
    }
    expect(scoredPasses(withStep({ id: 'review', status: 'failed', outcome: 'failed', settledAt: 2, installId: install, failure: { code: 'tool_failed', message: 'm' } }), install)).toEqual([]);
    // Claimed mid-delivery: the install that reported the pass judges it, the one that claimed the run does not.
    const claimed = { ...withStep({ ...reported, status: 'delivering' }), publication: { stateRevision: 2 } };
    expect(scoredPasses(claimed, install)).toEqual(judged);
    expect(scoredPasses(claimed, 'claimer')).toEqual([]);
  });

  it('keeps only the passes this install settled, and attributes archived children to the workflow pass that held them', async () => {
    const config = fixture(scorer(100));
    const run = await runOf(config, await settledRun(config));
    const install = (await installOwner(config)).id;
    expect(scoredPasses(run, install)).toEqual([{ subject: { runId: run.id, step: 'review', pass: 1 }, scorers: ['quality', 'nope'] }]);
    expect(await RunScorers.scoredPasses(config, run, install)).toEqual({ ok: true, passes: [{ subject: { runId: run.id, step: 'review', pass: 1 }, scorers: ['quality'] }] });
    expect(scoredPasses(run, 'another-install')).toEqual([]);
    const unstamped = structuredClone(run);
    for (const step of unstamped.steps) if ('installId' in step) delete step.installId;
    expect(scoredPasses(unstamped, install)).toEqual(scoredPasses(run, install));
    expect(scoredPasses({ ...unstamped, publication: { stateRevision: 1 } }, install)).toEqual([]);

    const nested: RunState = {
      ...run,
      definition: { ...run.definition, steps: [{ id: 'check', scorers: { names: ['quality'] }, workflow: { steps: [{ id: 'review', prompt: 'p' }] } }] },
      steps: [{ id: 'check', status: 'succeeded', outcome: 'success', settledAt: 3, pass: 2 }],
      archive: [{ step: 'check.review', pass: 1, outcome: 'success', installId: 'elsewhere', within: { step: 'check', pass: 1 } }],
    };
    expect(scoredPasses(nested, install)).toEqual([{ subject: { runId: run.id, step: 'check', pass: 2 }, scorers: ['quality'] }]);
    expect(scoredPasses({ ...nested, archive: [{ ...nested.archive?.[0], step: 'check.review', pass: 1, outcome: 'success', installId: install, within: { step: 'check', pass: 2 } }] }, 'elsewhere')).toEqual([]);
  });

  it('gives a workflow pass to the install that settled its first child pass, archived before a live one another install settled', async () => {
    const config = fixture(scorer(100));
    const run = await runOf(config, await settledRun(config));
    const looped: RunState = {
      ...run,
      definition: { ...run.definition, steps: [{ id: 'check', scorers: { names: ['quality'] }, workflow: { steps: [{ id: 'review', prompt: 'p' }] } }] },
      steps: [
        { id: 'check', status: 'succeeded', outcome: 'success', settledAt: 3 },
        { id: 'check.review', status: 'succeeded', outcome: 'success', settledAt: 2, pass: 2, installId: 'install-b' },
      ],
      archive: [{ step: 'check.review', pass: 1, outcome: 'success', installId: 'install-a', within: { step: 'check', pass: 1 } }],
      publication: { stateRevision: 1 },
    };

    expect(scoredPasses(looped, 'install-a')).toEqual([{ subject: { runId: run.id, step: 'check', pass: 1 }, scorers: ['quality'] }]);
    expect(scoredPasses(looped, 'install-b')).toEqual([]);
  });

  it('offers a handed-over workflow pass to the install that settled a prompt pass a nested loop archived', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const run = await runOf(config, runId);
    const install = (await installOwner(config)).id;
    const looped: RunState = {
      ...run,
      definition: { ...run.definition, steps: [{ id: 'check', scorers: { names: ['quality'] }, workflow: { steps: [{ id: 'inner', workflow: { steps: [{ id: 'review', prompt: 'p' }] } }] } }] },
      steps: [
        { id: 'check', status: 'succeeded', outcome: 'success', settledAt: 6 },
        { id: 'check.inner', status: 'succeeded', outcome: 'success', settledAt: 5, pass: 2, passes: [{ pass: 1, outcome: 'success' }] },
        { id: 'check.inner.review', status: 'skipped', settledAt: 4, pass: 2 },
      ],
      archive: [{ step: 'check.inner.review', pass: 1, outcome: 'success', installId: install, within: { step: 'check.inner', pass: 1 } }],
      publication: { stateRevision: 1 },
    };
    fs.writeFileSync(path.join(config.dataHome ?? '', 'workflows', 'runs', `${runId}.json`), JSON.stringify(looped));

    expect(scoredPasses(looped, install)).toEqual([{ subject: { runId, step: 'check', pass: 1 }, scorers: ['quality'] }]);
    expect(scoredPasses(looped, 'elsewhere')).toEqual([]);
  });

  it('scores the items of a for_each step, never the step that fans them out', async () => {
    const config = fixture(scorer(100));
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'review.yaml'), WORKFLOW.replace('    scorers:', "    for_each: '[]'\n    scorers:"));
    await syncScorersThenWorkflows(config);
    const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
    expect(data(await leaseNext(config, runId, workDriver))).toMatchObject({ done: { outcome: 'succeeded' } });
    const install = (await installOwner(config)).id;
    const run = await runOf(config, runId);
    expect(scoredPasses(run, install)).toEqual([]);

    const items: RunState = {
      ...run,
      steps: [
        { id: 'review', status: 'succeeded', outcome: 'success', settledAt: 3 },
        { id: 'review[0]', status: 'succeeded', outcome: 'success', settledAt: 2, item: 'a', installId: install },
        { id: 'review[1]', status: 'succeeded', outcome: 'success', settledAt: 2, item: 'b', installId: install },
      ],
    };
    expect(scoredPasses(items, install).map(({ subject }) => subject.step)).toEqual(['review[0]', 'review[1]']);
  });
});


describe('team skills a pass used', () => {
  it('labels a pass with the team skills its driver reported, without a value not shaped like a skill name', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config, { used: { skills: ['review-notes', '/Users/me/.claude/skills/deploy/SKILL.md'] } });
    expect(await labelled(config, runId)).toMatchObject({ source: 'workflow', used: { skills: ['review-notes'] } });
  });

  it.each([
    ['no used', {}, 'absent'],
    ['no skill loaded', { used: { skills: [] } }, { skills: [] }],
    ['only values not shaped like a skill name', { used: { skills: ['/Users/me/.claude/skills/deploy/SKILL.md'] } }, 'absent'],
  ])('labels a pass whose driver reported %s with what it observed', async (_, reported, used) => {
    const config = fixture(scorer(100));
    const label = await labelled(config, await settledRun(config, reported));
    expect('used' in label ? label.used : 'absent').toEqual(used);
  });

  it('refuses a report whose used is not a list of skill names', () => {
    expect(parseReport({ attempt: 'a1', revision: 1, outcome: 'success', driver: workDriver, used: { skills: 'review-notes' } }))
      .toBe('used must be an object whose skills is an array of skill names');
  });
});

describe('the run mode of a judged pass (#1384)', () => {
  it.each([
    ['unattended', { runMode: 'unattended' as const }, 'unattended'],
    ['no mode', {}, 'absent'],
  ])('labels a pass whose driver took its lease %s with its mode, never the judge\'s', async (_, asked, runMode) => {
    const config = fixture(scorer(100));
    const label = await labelled(config, await settledRun(config, {}, asked));

    expect('runMode' in label ? label.runMode : 'absent').toBe(runMode);
  });

  it('refuses a next payload whose runMode names no mode', () => {
    expect(parseNextPayload({ driver: workDriver, runMode: 'robot' })).toBe('runMode must be attended or unattended');
  });

  it('keeps the mode of a lease the run cancelled before its driver reported', async () => {
    const config = fixture(scorer(100));
    await syncScorersThenWorkflows(config);
    const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
    data(await leaseNext(config, runId, workDriver, { runMode: 'unattended' }));

    data(await cancelRun(config, runId, await knownSecrets(config)));

    expect(await runOf(config, runId)).toMatchObject({ steps: [{ status: 'cancelled', runMode: 'unattended' }] });
  });
});

describe('the judge prompt', () => {
  // A judge whose tool enforces no reply schema follows the prompt, and the judge step takes its answer under `answer`.
  it('asks for the answer under `answer`, the reply the judge step takes', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);

    expect(await scoreJudgePrompt(config, `run:${runId}:review:1`, ['quality'])).toContain('{"answer": ');
  });
});

describe('the harness a judged pass ran with', () => {
  const team = { revision: 'a'.repeat(40), localChanges: false, selection: { scope: 'project' as const, primaryRole: 'frontend', additionalRoles: [] } };
  const agentOfStep = (run: RunState, id: string) => {
    const step = run.steps.find((each) => each.id === id);
    return step && 'agent' in step ? step.agent : undefined;
  };

  it('labels a prompt pass with the agent its pass recorded, also when it recorded no model and so no fingerprint', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config, { tool: 'claude', agent: { tool: { version: '2.1.308' }, effort: { requested: 'high' }, team } });
    const recorded = agentOfStep(await runOf(config, runId), 'review');

    const label = await labelled(config, runId);

    expect(recorded).toMatchObject({ tool: { name: 'claude', version: '2.1.308' }, effort: { requested: 'high' }, team, driver: 'external' });
    expect(recorded).not.toHaveProperty('fingerprint');
    expect(label.agent).toEqual(recorded);
  });

  it('shows the judge nothing of the harness: its evidence names no tool version, model, role or team revision of the pass', async () => {
    const config = fixture(scorer(100));
    const stepTeam = { ...team, revision: 'e'.repeat(40), selection: { ...team.selection, primaryRole: 'harness-only-role' } };
    const runId = await settledRun(config, { tool: 'claude', model: 'harness-only-model', agent: { tool: { version: '9.8.7' }, team: stepTeam } });

    expect(await labelled(config, runId)).toMatchObject({ agent: { model: { reported: 'harness-only-model' }, team: stepTeam } });
    const evidence = await scoreEvidenceDir(config, `run:${runId}:review:1`, ['quality']);
    const read = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? read(file) : [fs.readFileSync(file, 'utf8')];
    });
    const shown = read(evidence).join('\n');

    expect(shown).toContain('Judge the review.');
    for (const harness of ['9.8.7', 'harness-only-model', 'harness-only-role', 'e'.repeat(40)]) expect(shown).not.toContain(harness);
  });

  describe('of a workflow step', () => {
    const subWorkflow = (reviewKeys: string) => `schemaVersion: v1alpha1
name: review
description: A drafted, checked and reviewed change, judged as one.
steps:
  - id: check
    scorers: [quality]
    workflow:
      steps:
        - id: draft
          prompt: Draft the change.
        - id: lint
          needs: [draft]
          command: npm run lint
        - id: review
          needs: [lint]
          prompt: Review the change.${reviewKeys}
`;
    const ran = { tool: 'claude', model: 'claude-review-1', agent: { effort: { requested: 'high' }, team } };
    const project = (commit: string) => ({ project: { commit: commit.repeat(40), dirty: false } });

    /** Runs the workflow with `reviewKeys` on its review step, reporting each step as `reports` gives, and labels `check`. */
    async function labelledCheck(reviewKeys: string, reports: Record<'draft' | 'lint' | 'review', Record<string, unknown>>) {
      const config = fixture(scorer(100));
      fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'review.yaml'), subWorkflow(reviewKeys));
      await syncScorersThenWorkflows(config);
      const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
      for (const step of ['draft', 'lint', 'review'] as const) {
        const lease = z.object({ attempt: z.string(), revision: z.number(), step: z.string() }).parse(data(await leaseNext(config, runId, workDriver)).lease);
        expect(lease.step).toBe(`check.${step}`);
        await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: workDriver, outputs: { done: true }, ...reports[step] });
      }
      expect(data(await leaseNext(config, runId, workDriver))).toMatchObject({ done: { outcome: 'succeeded' } });
      const run = await runOf(config, runId);
      const label = z.object({ subject: z.object({ step: z.literal('check') }) }).passthrough().parse(await labelled(config, runId, 'check'));
      return { label, run };
    }

    it('takes the agent of its first prompt pass when every prompt pass agrees on it, whatever its command passes recorded', async () => {
      const { label, run } = await labelledCheck('', {
        draft: { ...ran, agent: { ...ran.agent, ...project('c') } },
        lint: {},
        review: { ...ran, agent: { ...ran.agent, ...project('d') } },
      });

      const draft = agentOfStep(run, 'check.draft');
      expect(draft).toMatchObject({ tool: { name: 'claude' }, model: { reported: 'claude-review-1' }, project: { commit: 'c'.repeat(40) } });
      expect(label.agent).toEqual(draft);
    });

    it.each([
      ['their definitions differ', '\n          agent: reviewer', { review: ran }],
      ['one ran with a role of its own', '', { review: { ...ran, agent: { ...ran.agent, team: { ...team, selection: { ...team.selection, stepRole: 'review' } } } } }],
      ['one recorded no agent', '', { review: {} }],
    ])('records no agent when its prompt passes do not agree because %s', async (_, reviewKeys, reports) => {
      const { label } = await labelledCheck(reviewKeys, { draft: ran, lint: {}, ...reports });

      expect(label).not.toHaveProperty('agent');
    });
  });
});

describe('run snapshot', () => {
  it('publishes no scorer, and the install and within stamps as they are', async () => {
    const config = fixture(scorer(100));
    const run = await runOf(config, await settledRun(config));
    const projected = projectRun({ ...run, archive: [{ step: 'x.y', pass: 1, outcome: 'success', within: { step: 'x', pass: 1 } }] }, {});
    if (!projected.ok) throw new Error(projected.error.message);
    expect(projected.value).not.toHaveProperty('scorers');
    expect(JSON.stringify(projected.value)).not.toContain('Judge the review.');
    expect(projected.value.steps[0]).toMatchObject({ installId: (await installOwner(config)).id });
    expect(projected.value.archive[0]).toMatchObject({ within: { step: 'x', pass: 1 } });
  });

  it('publishes the team skills a pass used, by name', async () => {
    const config = fixture(scorer(100));
    const run = await runOf(config, await settledRun(config, { used: { skills: ['review-notes'] } }));
    const projected = projectRun({ ...run, archive: [{ step: 'x.y', pass: 1, outcome: 'success', used: { skills: ['deploy-notes'] } }] }, {});
    if (!projected.ok) throw new Error(projected.error.message);
    expect(projected.value.steps[0]).toMatchObject({ used: { skills: ['review-notes'] } });
    expect(projected.value.archive[0]).toMatchObject({ used: { skills: ['deploy-notes'] } });
  });
});
