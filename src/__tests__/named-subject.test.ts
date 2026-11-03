/**
 * What `teamai score --run` and `--session` check before a teamai-score run starts: the pass, its step and the scorers
 * the run pinned, and a hand label's shape, each refused with its code before any run exists.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { knownSecrets } from '../env-resolution.js';
import { NamedSubject } from '../scorers/named-subject.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import type { WorkflowEnvelope } from '../workflow/types.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const QUALITY = `---
labels:
  - { value: good, score: 1, description: Finds the real defects }
  - { value: missed, score: 0, description: Misses a real defect }
passingScore: 0.5
---
Judge the review.
`;

const TWO_STEPS = `schemaVersion: v1alpha1
name: review
description: Review, then review again.
steps:
  - id: review
    prompt: Review the change.
    scorers: [quality]
  - id: recheck
    needs: [review]
    prompt: Review it again.
    scorers: [quality]
`;

const driver = { kind: 'external', machine: 'm1', workspace: '/w' };

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

/** A team with the quality scorer and `workflow` as review.yaml, in a home of its own. */
async function team(workflow: string): Promise<LocalConfig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-named-subject-'));
  dirs.push(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'workflows', 'review.yaml'), workflow);
  fs.writeFileSync(path.join(knowledge, 'scorers', 'quality.md'), QUALITY);
  const config: LocalConfig = { repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  await syncWorkflowDefinitions(config);
  return config;
}

/** Starts review and settles `steps` of it, in order, as an external driver: the run id. */
async function settled(config: LocalConfig, steps: number): Promise<string> {
  const run = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
  for (let step = 0; step < steps; step += 1) {
    const lease = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, run, driver)).lease);
    data(await reportAttempt(config, run, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver }));
  }
  return run;
}

const ONE_STEP = TWO_STEPS.slice(0, TWO_STEPS.indexOf('  - id: recheck'));

describe('NamedSubject.ofPass', () => {
  it('takes the one step that lists the scorer, its latest succeeded pass, and the rubric the run pinned', async () => {
    const config = await team(ONE_STEP);
    const run = await settled(config, 1);

    const named = await NamedSubject.ofPass(config, { run, scorers: ['quality'] });

    expect(named).toMatchObject({ ok: true, subject: { kind: 'run', subject: { runId: run, step: 'review', pass: 1 } } });
    expect(named.ok && named.definitions.get('quality')?.labels.map((label) => label.value)).toEqual(['good', 'missed']);
  });

  it.each([
    ['a scorer file', { scorers: ['./scorers/quality.md'] }, 'invalid_arguments', '--run takes scorer names, not the file ./scorers/quality.md: a run pins its scorers when it starts'],
    ['a scorer the run did not pin', { scorers: ['style'], step: 'review' }, 'scorer_not_found', 'Scorer style is not pinned by run {run}, so it has no rubric to judge its passes with. Scorers it pinned: quality.'],
    ['a pass that did not succeed', { scorers: ['quality'], pass: 2 }, 'pass_not_found', 'Pass 2 of step review did not succeed in run {run}. Succeeded passes: 1.'],
    ['a scorer no step lists', { scorers: ['style'] }, 'step_not_found', 'Run {run} lists scorer style on no step. Pass --step <path> to pick one: review.'],
    ['a step with no succeeded pass', { scorers: ['quality'], step: 'missing' }, 'step_not_found', 'Step missing has no succeeded pass in run {run}. Steps with one: review.'],
  ])('refuses %s before any run starts', async (_, named, code, message) => {
    const config = await team(ONE_STEP);
    const run = await settled(config, 1);

    expect(await NamedSubject.ofPass(config, { run, ...named })).toEqual({ ok: false, code, message: message.replace('{run}', run) });
  });

  it('refuses to guess between two steps that list the scorer', async () => {
    const config = await team(TWO_STEPS);
    const run = await settled(config, 2);

    expect(await NamedSubject.ofPass(config, { run, scorers: ['quality'] })).toEqual({
      ok: false, code: 'step_ambiguous', message: `Run ${run} lists scorer quality on steps review, recheck. Pass --step <path> to pick one.`,
    });
    expect(await NamedSubject.ofPass(config, { run, scorers: ['quality'], step: 'recheck' })).toMatchObject({ ok: true, subject: { subject: { step: 'recheck', pass: 1 } } });
  });

  it('refuses a step no pass of which succeeded, and says no step did', async () => {
    const config = await team(ONE_STEP);
    const run = await settled(config, 0);

    expect(await NamedSubject.ofPass(config, { run, scorers: ['quality'] })).toEqual({ ok: false, code: 'step_not_found', message: `Step review has no succeeded pass in run ${run}. No step of it succeeded.` });
  });
});

describe('NamedSubject.ofSession', () => {
  it.each([
    ['two scorers', { scorers: ['quality', 'style'] as const, label: 'good' }, '--label is a value of one scorer. Pass one --scorer.'],
    ['a scorer file', { scorers: ['./scorers/quality.md'] as const, label: 'good' }, '--label is stored, and the label of the scorer file ./scorers/quality.md is never stored. Pass the name of a scorer teamai pull cached.'],
    ['--batch', { scorers: ['quality'] as const, label: 'good', batch: true }, '--label runs no judge. Leave out --batch.'],
  ])('refuses a hand label with %s before it looks for the session', async (_, demand, message) => {
    const config = await team(ONE_STEP);

    expect(await NamedSubject.ofSession(config, { ...demand, session: 'gone' })).toEqual({ ok: false, code: 'invalid_arguments', message });
  });
});
