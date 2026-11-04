/**
 * What `teamai score --run` and `--session` check before a teamai-score run starts: the pass, its step and the scorers
 * the run pinned, and a hand label's shape, each refused with its code before any run exists.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// The team's reports checkout is refreshed from origin before a pushed session is read; these fixtures have no origin.
vi.mock('../utils/reports-branch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/reports-branch.js')>();
  const { getReportsDir } = await import('../types.js');
  return { ...actual, readableReportsWorktree: async (config: Parameters<typeof getReportsDir>[0]) => getReportsDir(config) };
});

import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import { knownSecrets } from '../env-resolution.js';
import { NamedSubject } from '../scorers/named-subject.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import type { Session } from '../session-flow/ir.js';
import { defaultSyncMeta, getRepoIdentity, SyncManager } from '../session-flow/sync.js';
import { getReportsDir, type LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import type { WorkflowEnvelope } from '../workflow/types.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
  await syncScorersThenWorkflows(config);
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
    ['a scorer file', { scorers: ['./scorers/quality.md'] }, 'invalid_arguments', '--run takes scorer names, not the file ./scorers/quality.md: a run reads its scorers at the team revision it started from'],
    ['a scorer the run does not list', { scorers: ['style'], step: 'review' }, 'scorer_not_found', 'Scorer style is not a scorer of run {run} at the team revision it started from, so it has no rubric to judge its passes with. Its scorers: quality.'],
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
    ['--batch', { scorers: ['quality'] as const, label: 'good', batch: true }, '--label runs no judge. Leave out --batch.'],
  ])('refuses a hand label with %s before it looks for the session', async (_, demand, message) => {
    const config = await team(ONE_STEP);

    expect(await NamedSubject.ofSession(config, { ...demand, session: 'gone' })).toEqual({ ok: false, code: 'invalid_arguments', message });
  });
});

const SESSION = '7c1e0000-0000-4000-8000-000000000003';

/** A Claude Code session SESSION in `cwd`, under the home `team` made, whose first prompt is `prompt`. */
function plantSession(cwd: string, prompt: string): void {
  const project = path.join(process.env.HOME ?? '', '.claude', 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(project, { recursive: true });
  const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
  fs.writeFileSync(path.join(project, `${SESSION}.jsonl`),
    line({ type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: prompt } })
    + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } }));
}

/** What `named` printed for the person, line by line. */
function printed(info: { mock: { calls: unknown[][] } }): string[] {
  return info.mock.calls.map(([text]) => String(text));
}

describe('NamedSubject.ofSession of a session on this machine', () => {
  it('says which session it judges and its first prompt, and takes the scorers pull cached', async () => {
    const config = await team(ONE_STEP);
    const cwd = path.join(config.projectRoot ?? '', 'app');
    plantSession(cwd, 'Add retries to the client');
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);

    const named = await NamedSubject.ofSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality', 'teamai:routing:review-notes'] });

    expect(named).toMatchObject({ ok: true, subject: { kind: 'session', subject: { platform: 'claude-code', sessionId: SESSION } } });
    expect(named.ok && [...named.definitions.keys()]).toEqual(['quality']);
    expect(printed(info)).toEqual([`Scoring claude-code session ${SESSION} in ${cwd}`, 'First prompt: Add retries to the client']);
  });

  it('takes a hand label that is a value of its scorer, and refuses one that is not, naming the values', async () => {
    const config = await team(ONE_STEP);
    const cwd = path.join(config.projectRoot ?? '', 'app');
    plantSession(cwd, 'Add retries to the client');
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const asked = { session: SESSION, source: 'claude-code', scorers: ['quality'] } as const;

    expect(await NamedSubject.ofSession(config, { ...asked, label: 'flaky' })).toEqual({ ok: false, code: 'label_invalid', message: '"flaky" is not a label of scorer quality. Use one of: good, missed.' });
    expect(info).not.toHaveBeenCalled();
    expect(await NamedSubject.ofSession(config, { ...asked, label: 'missed' })).toMatchObject({ ok: true, subject: { kind: 'session' } });
    expect(printed(info)[0]).toBe(`Labelling claude-code session ${SESSION} in ${cwd}`);
  });

  it('refuses a scorer pull did not cache, naming the ones it did, or saying to pull when it cached none', async () => {
    const config = await team(ONE_STEP);
    plantSession(path.join(config.projectRoot ?? '', 'app'), 'Add retries to the client');

    expect(await NamedSubject.ofSession(config, { session: SESSION, source: 'claude-code', scorers: ['style'] })).toEqual({ ok: false, code: 'scorer_not_found', message: 'Scorer style is not cached here. Scorers: quality.' });
    fs.rmSync(path.join(config.repo.localPath, 'scorers', 'quality.md'));
    await syncScorersThenWorkflows(config);
    expect(await NamedSubject.ofSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] })).toEqual({
      ok: false, code: 'scorer_not_found', message: 'Scorer quality is not cached here. Run teamai pull to cache the team\'s scorers.',
    });
  });
});

describe('NamedSubject.ofPass of other runs', () => {
  const step = (id: string, extra = '') => `  - id: ${id}\n    prompt: Review {{ item }}.\n${extra}`;
  const workflow = (inputs: string, steps: string) => `schemaVersion: v1alpha1\nname: review\ndescription: Review.\n${inputs}steps:\n${steps}`;

  /** Starts review with `inputs` and settles each lease as an external driver, `session` recorded on each: the run id. */
  async function ran(config: LocalConfig, inputs: Record<string, unknown> = {}, session?: string): Promise<string> {
    const run = String(data(await startRun(config, 'review', inputs, { secrets: await knownSecrets(config) })).run);
    for (let turn = 0; turn < 10; turn += 1) {
      const lease = z.object({ attempt: z.string(), revision: z.number() }).optional().parse(data(await leaseNext(config, run, driver)).lease);
      if (!lease) break;
      data(await reportAttempt(config, run, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, ...(session ? { tool: 'claude', session } : {}) }));
    }
    return run;
  }

  it('lists each item of a for_each step that lists the scorer, never the step around them', async () => {
    const config = await team(workflow('inputs: { files: [string] }\n', step('fan', '    for_each: inputs.files\n    scorers: [quality]\n')));
    const run = await ran(config, { files: ['a.ts', 'b.ts'] });

    expect(await NamedSubject.ofPass(config, { run, scorers: ['quality'] })).toEqual({
      ok: false, code: 'step_ambiguous', message: `Run ${run} lists scorer quality on steps fan[0], fan[1]. Pass --step <path> to pick one.`,
    });
  });

  it('lists each item of a for_each step inside the workflow another step runs', async () => {
    const inner = '    workflow:\n      steps:\n        - id: fan\n          for_each: inputs.files\n          prompt: Review {{ item }}.\n          scorers: [quality]\n';
    const config = await team(workflow('inputs: { files: [string] }\n', `  - id: group\n${inner}`));
    const run = await ran(config, { files: ['a.ts', 'b.ts'] });

    expect(await NamedSubject.ofPass(config, { run, scorers: ['quality'] })).toEqual({
      ok: false, code: 'step_ambiguous', message: `Run ${run} lists scorer quality on steps group.fan[0], group.fan[1]. Pass --step <path> to pick one.`,
    });
  });

  it('takes the latest pass of an item a loop ran again, whose earlier pass the loop archived', async () => {
    const config = await team(workflow('inputs: { files: [string] }\n', `${step('fan', '    for_each: inputs.files\n    scorers: [quality]\n')}  - id: fix\n    needs: [fan]\n    prompt: Fix it.\n    output: { again: boolean }\n    loop: { back_to: fan, max_iterations: 2, while: steps.fix.outputs.again }\n`));
    const run = String(data(await startRun(config, 'review', { files: ['a.ts'] }, { secrets: await knownSecrets(config) })).run);
    let fixes = 0;
    for (let turn = 0; turn < 10; turn += 1) {
      const lease = z.object({ attempt: z.string(), revision: z.number(), step: z.string() }).optional().parse(data(await leaseNext(config, run, driver)).lease);
      if (!lease) break;
      const outputs = lease.step === 'fix' ? { outputs: { again: (fixes += 1) === 1 } } : {};
      data(await reportAttempt(config, run, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, ...outputs }));
    }

    expect(await NamedSubject.ofPass(config, { run, step: 'fan[0]', scorers: ['quality'] })).toMatchObject({ ok: true, subject: { subject: { step: 'fan[0]', pass: 2 } } });
    expect(await NamedSubject.ofPass(config, { run, step: 'fan[0]', scorers: ['quality'], pass: 3 })).toMatchObject({ message: expect.stringContaining('Succeeded passes: 1, 2.') });
  });

  it('takes the one scored step beside steps that list no scorer', async () => {
    const config = await team(workflow('', `${step('build')}${step('review', '    needs: [build]\n    scorers: [quality]\n')}`));
    const run = await ran(config);

    expect(await NamedSubject.ofPass(config, { run, scorers: ['quality'] })).toMatchObject({ ok: true, subject: { subject: { step: 'review', pass: 1 } } });
  });

  it('says no step succeeded when no step lists the scorer and none ran', async () => {
    const config = await team(ONE_STEP);
    const run = await settled(config, 0);

    expect(await NamedSubject.ofPass(config, { run, scorers: ['style'] })).toEqual({ ok: false, code: 'step_not_found', message: `Run ${run} lists scorer style on no step. No step of it succeeded.` });
  });

  it('takes the latest of two succeeded passes, and refuses a pass that is not one of them', async () => {
    const config = await team(workflow('', step('review', '    output: { again: boolean }\n    loop: { back_to: review, max_iterations: 2, while: steps.review.outputs.again }\n    scorers: [quality]\n')));
    const run = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
    for (const again of [true, false]) {
      const lease = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, run, driver)).lease);
      data(await reportAttempt(config, run, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, outputs: { again } }));
    }

    expect(await NamedSubject.ofPass(config, { run, scorers: ['quality'] })).toMatchObject({ ok: true, subject: { subject: { step: 'review', pass: 2 } } });
    for (const pass of [0, 3]) {
      expect(await NamedSubject.ofPass(config, { run, scorers: ['quality'], pass })).toEqual({
        ok: false, code: 'pass_not_found', message: `Pass ${pass} of step review did not succeed in run ${run}. Succeeded passes: 1, 2.`,
      });
    }
  });

  it('refuses a pass whose recorded session is gone from this machine', async () => {
    const config = await team(ONE_STEP);
    const run = await ran(config, {}, 'gone-session');

    expect(await NamedSubject.ofPass(config, { run, scorers: ['quality'] })).toMatchObject({ ok: false, code: 'evidence_missing' });
  });

  it('refuses a scorer on a run whose steps list none', async () => {
    const config = await team(workflow('', step('review')));
    const run = await ran(config);

    expect(await NamedSubject.ofPass(config, { run, step: 'review', scorers: ['quality'] })).toEqual({
      ok: false, code: 'scorer_not_found', message: `Scorer quality is not a scorer of run ${run} at the team revision it started from, so it has no rubric to judge its passes with. Its steps list no scorer it can read.`,
    });
  });
});

describe('NamedSubject.ofSession of a session a member pushed', () => {
  it('names the archived session by who pushed it, and says so, with no directory, which pushing scrubs', async () => {
    const self = await team(ONE_STEP);
    const config: LocalConfig = { ...self, repo: { ...self.repo, kind: 'git' } };
    await syncScorersThenWorkflows(config);
    const session: Session = {
      sessionId: SESSION, title: 'fix the retry loop', cwd: '/home/alice/app', platform: 'claude-code', createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T11:00:00.000Z',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the retry loop in sync.ts' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Added the retries.' }] }],
    };
    const meta = defaultSyncMeta({ platform: 'claude-code', author: 'alice', cwd: session.cwd, sessionId: SESSION, repoIdentity: getRepoIdentity(process.cwd()), title: session.title }, session.createdAt);
    const saved = await new SyncManager(getReportsDir(config)).saveSession(session, meta);
    if (saved.status !== 'written') throw new Error('the archive is busy');
    const name = path.basename(saved.value, '.jsonl');
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);

    expect(await NamedSubject.ofSession(config, { teamSession: { name }, scorers: ['quality'] })).toMatchObject({ ok: true, subject: { kind: 'team-session', subject: { author: 'alice', name } } });
    expect(printed(info)).toEqual([`Scoring claude-code session ${SESSION} in (directory unknown)`, 'Pushed by alice', 'First prompt: fix the retry loop in sync.ts']);
  });
});
