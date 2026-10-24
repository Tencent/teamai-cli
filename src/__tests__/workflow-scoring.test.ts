import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { JudgeAnswer } from '../scorers/batch.js';
import { localAliasesPath } from '../models/aliases.js';
import { AttemptStore } from '../scorers/attempts.js';
import { LabelStore } from '../scorers/label-store.js';
import { getReportsDir, type LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, parseReport, reportAttempt, startRun } from '../workflow/engine.js';
import { workflowRunDetail } from '../dashboard/workflow-runs.js';
import { buildEndRecord } from '../workflow/records.js';
import { projectRun } from '../workflow/snapshot.js';
import { nextJudgeLease, parseJudgeRequest, parseJudgeSubmission, runJudgeLease, scoreOnDemand, scoredPasses, submitJudgeLease, type JudgeRequest } from '../workflow/scoring.js';
import { cancelRun, retryStep } from '../workflow/run-controls.js';
import { installOwner, readRun, updateRun } from '../workflow/store.js';
import type { StepState } from '../workflow/step-state.js';
import type { DriverIdentity, RunState, WorkflowEnvelope } from '../workflow/types.js';
import { knownSecrets } from '../env-resolution.js';

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
const judgeDriver = { kind: 't3', machine: 'm1', workspace: '/w' };
const request = (overrides: Partial<JudgeRequest> = {}): JudgeRequest => ({
  driver: judgeDriver, judge: { isolation: 'verified', tools: ['claude'] }, running: [], ...overrides,
});

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

const LeaseSchema = z.object({ ref: z.string(), evidence: z.string(), prompt: z.string(), expiresAt: z.string() }).passthrough();

function leaseOf(envelope: WorkflowEnvelope): z.infer<typeof LeaseSchema> {
  return LeaseSchema.parse(data(envelope).lease);
}

async function runOf(config: LocalConfig, runId: string): Promise<RunState> {
  const run = await readRun(config, runId);
  if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
  return run;
}

/**
 * Starts the review workflow and settles its one step through workflow next and report, as an external driver would,
 * with `reported` added to its report payload.
 */
async function settledRun(config: LocalConfig, reported: Record<string, unknown> = {}): Promise<string> {
  await syncWorkflowDefinitions(config);
  const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
  const lease = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, runId, workDriver)).lease);
  const parsed = parseReport({ attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: workDriver, outputs: { reviewed: true }, ...reported });
  if (typeof parsed === 'string') throw new Error(parsed);
  data(await reportAttempt(config, runId, parsed.report));
  expect(data(await leaseNext(config, runId, workDriver))).toMatchObject({ done: { outcome: 'succeeded' } });
  return runId;
}

/** Rewrites run `runId`'s one step as `step`, with the run still running, as a delivery would leave it. */
async function setStep(config: LocalConfig, runId: string, step: (run: RunState) => StepState): Promise<void> {
  await updateRun(config, runId, await knownSecrets(config), async (run) => (run === 'missing' ? { value: undefined } : { value: undefined, write: { ...run, status: 'running', steps: [step(run)] } }));
}

describe('judge work', () => {
  it('judges a step while it delivers, and its label stays the judgement however the delivery ends', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const settled = (await runOf(config, runId)).steps[0];
    if (settled?.status !== 'succeeded') throw new Error('review did not succeed');
    const reported = (run: RunState) => ({ ...settled, delivery: { branch: `teamai/${run.id}/review/p1`, head: 'c'.repeat(40) } });
    await setStep(config, runId, (run) => ({ ...reported(run), status: 'delivering' }));

    const lease = leaseOf(await nextJudgeLease(config, request()));
    data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'r' } }));
    const labels = await LabelStore.local(config);
    expect(labels).toMatchObject([{ subject: { runId, step: 'review', pass: 1 }, label: 'good' }]);

    await setStep(config, runId, (run) => ({ ...reported(run), status: 'failed', outcome: 'failed', failure: { code: 'delivery_failed', message: 'm' } }));
    expect(data(await nextJudgeLease(config, request()))).not.toHaveProperty('lease');
    await setStep(config, runId, (run) => ({ ...reported(run), status: 'succeeded', outcome: 'success' }));
    expect(data(await nextJudgeLease(config, request()))).not.toHaveProperty('lease');
    expect(await LabelStore.local(config)).toEqual(labels);
  });

  it('judges a step cancelled while it delivers as its agent left it, and the run record keeps the tokens of that pass', async () => {
    const config = fixture(scorer(100));
    const tokens = { input: 1200, output: 80 };
    const runId = await settledRun(config, { tokens });
    const settled = (await runOf(config, runId)).steps[0];
    if (settled?.status !== 'succeeded') throw new Error('review did not succeed');
    await setStep(config, runId, (run) => ({ ...settled, status: 'delivering', delivery: { branch: `teamai/${run.id}/review/p1`, head: 'c'.repeat(40) } }));
    expect(await cancelRun(config, runId, await knownSecrets(config), 'review')).toMatchObject({ data: { cancelled: { steps: ['review'] } } });

    const cancelled = await runOf(config, runId);
    expect(cancelled.steps[0]).toMatchObject({ status: 'cancelled', tokens, outputs: { reviewed: true } });
    expect(buildEndRecord(cancelled, workDriver, 'tester').steps).toEqual([expect.objectContaining({ step: 'review', pass: 1, outcome: 'cancelled', tokens })]);
    expect(data(await nextJudgeLease(config, request()))).toHaveProperty('lease');

    expect(await retryStep(config, runId, await knownSecrets(config), 'review')).toMatchObject({ data: { retried: { step: 'review', pass: 2 } } });
    const install = (await installOwner(config)).id;
    expect(scoredPasses(await runOf(config, runId), install)).toEqual([{ subject: { runId, step: 'review', pass: 1 }, scorers: ['quality'] }]);
  });

  it('finalizes the selected Codex tool in the lease', async () => {
    const config = fixture(scorer(100));
    await settledRun(config);
    expect(data(await nextJudgeLease(config, request({ judge: { isolation: 'best-effort', tools: ['codex'] } })))).toMatchObject({ lease: { judge: { tool: 'codex', by: 'tool_default' } } });
  });

  it('judges a lease with the local tool and settles it through the submit path with the access of the tool profile', async () => {
    const config = fixture(scorer(100));
    await settledRun(config);
    const bin = path.join(config.projectRoot ?? '', 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'judge-model' }));
console.log(JSON.stringify({ type: 'result', structured_output: { label: 'good', reasoning: 'found the defect' } }));
});\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const lease = leaseOf(await nextJudgeLease(config, request()));
    expect(data(await runJudgeLease(config, lease.ref, { driver: judgeDriver }))).toMatchObject({ label: { label: 'good', score: 1, passed: true } });
    const labels = fs.readFileSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(labels).toEqual([expect.objectContaining({ judge: { kind: 'model', tool: 'claude', model: { reported: 'judge-model' }, isolation: 'verified', access: 'read' } })]);
    expect(fs.existsSync(lease.evidence)).toBe(false);
    expect(data(await nextJudgeLease(config, request()))).toMatchObject({ idle: { open: 0, leased: 0 } });
  });

  it('labels a best-effort lease judged locally with the isolation the local run measured', async () => {
    const config = fixture(scorer(100));
    await settledRun(config);
    const bin = path.join(config.projectRoot ?? '', 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'result', structured_output: { label: 'good', reasoning: 'found the defect' } }));
});\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const lease = leaseOf(await nextJudgeLease(config, request({ judge: { isolation: 'best-effort', tools: ['claude'] } })));
    data(await runJudgeLease(config, lease.ref, { driver: judgeDriver }));
    expect((await LabelStore.local(config))[0]?.judge).toMatchObject({ isolation: 'verified' });
  });

  it('counts the tokens of a local judge call whose answer does not fit the lease', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const bin = path.join(config.projectRoot ?? '', 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'result', structured_output: { label: 'great', reasoning: 'r' }, usage: { input_tokens: 1200, output_tokens: 60 } }));
});\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const lease = leaseOf(await nextJudgeLease(config, request()));

    expect(await runJudgeLease(config, lease.ref, { driver: judgeDriver })).toMatchObject({ error: { code: 'judge_answer_invalid' } });
    expect(await LabelStore.scoringTotal(config, runId, 'local')).toEqual({ judged: 1, inputTokens: 1200, outputTokens: 60 });

    data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'r' }, judge: { usage: { inputTokens: 10, outputTokens: 2 } } }));
    expect((await LabelStore.local(config))[0]?.judge).toMatchObject({ usage: { inputTokens: 1210, outputTokens: 62 } });
    expect(await LabelStore.scoringTotal(config, runId, 'local')).toEqual({ judged: 1, inputTokens: 1210, outputTokens: 62 });
  });

  it('skips a scorer whose model the driver\'s tools cannot run, and leaves it open for a driver whose tools can', async () => {
    const config = fixture(scorer(100).replace('samplingRate: 100', 'samplingRate: 100\nmodel: fast'));
    fs.mkdirSync(path.join(config.repo.localPath, 'models'));
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), 'aliases:\n  fast:\n    codex: gpt-6-mini\n');
    const runId = await settledRun(config);
    const file = path.join(config.dataHome ?? '', 'workflows', 'runs', `${runId}.json`);
    const before = fs.readFileSync(file, 'utf8');
    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 1, leased: 0 }, skipped: [{
      scorer: 'quality',
      subject: { runId, step: 'review', pass: 1 },
      code: 'judge_model_unavailable',
      message: 'Scorer "quality" asks for model alias "fast", which has no model for claude in models/aliases.yaml. Add one, or remove model from the scorer.',
    }] });
    expect(data(await nextJudgeLease(config, request({ judge: { isolation: 'verified', tools: ['codex'] } })))).toMatchObject({ lease: { judge: { tool: 'codex', model: { name: 'gpt-6-mini' } } } });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('pins the scorers a run lists at start, skipping one with no valid file', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const run = await runOf(config, runId);
    expect(Object.keys(run.scorers ?? {})).toEqual(['quality']);
    expect(run.steps[0]).toMatchObject({ installId: (await installOwner(config)).id });
  });

  it('records the access the driver declares for its judge, full when it declares none', async () => {
    const config = fixture(scorer(100));
    await settledRun(config);
    const undeclared = parseJudgeRequest({ driver: { ...judgeDriver, can: { judge: { isolation: 'verified', tools: ['claude'] } } } });
    if (typeof undeclared === 'string') throw new Error(undeclared);
    expect(leaseOf(await nextJudgeLease(config, undeclared))).toMatchObject({ judge: { access: 'full' } });

    const other = { ...judgeDriver, machine: 'm2' };
    const answering = parseJudgeRequest({ driver: { ...other, can: { judge: { isolation: 'verified', access: 'answer', tools: ['claude'] } } } });
    if (typeof answering === 'string') throw new Error(answering);
    const runId = await settledRun(config);
    const lease = leaseOf(await nextJudgeLease(config, answering));
    expect(lease).toMatchObject({ subject: { runId }, judge: { access: 'answer' } });
    data(await submitJudgeLease(config, lease.ref, { driver: other, outcome: 'success', answer: { label: 'good', reasoning: 'r' } }));
    const labels = fs.readFileSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(labels).toEqual([expect.objectContaining({ subject: expect.objectContaining({ runId }), judge: expect.objectContaining({ access: 'answer' }) })]);
    expect(parseJudgeRequest({ driver: { ...other, can: { judge: { isolation: 'verified', access: 'write', tools: ['claude'] } } } })).toContain('driver.can.judge.access');
  });

  it('leases a sampled pass of a settled run, refuses a label the scorer lacks, and records the right one', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const before = fs.readFileSync(path.join(config.dataHome ?? '', 'workflows', 'runs', `${runId}.json`), 'utf8');

    const lease = leaseOf(await nextJudgeLease(config, request()));
    expect(lease).toMatchObject({
      scorer: 'quality',
      subject: { runId, step: 'review', pass: 1 },
      judge: { tool: 'claude', by: 'tool_default', isolation: 'verified', access: 'full' },
      answer: { schema: { properties: { label: { enum: ['good', 'missed'] } } } },
      submit: `teamai score --lease ${lease.ref} --submit --stdin`,
    });
    expect(JSON.parse(fs.readFileSync(path.join(lease.evidence, 'evidence.json'), 'utf8'))).toEqual({
      subject: { runId, step: 'review', pass: 1 }, kind: 'prompt', ranges: [], gaps: ['no_recorded_range', 'transcript_not_found'],
    });
    expect(fs.readFileSync(lease.prompt, 'utf8')).toContain('Judge the review.');

    const bad = await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'great', reasoning: 'r' } });
    expect(bad).toMatchObject({ error: { code: 'label_invalid' } });
    // The lease stays open: the same driver gets it back.
    expect(data(await nextJudgeLease(config, request())).lease).toMatchObject({ ref: lease.ref, handedBack: true });

    const info = vi.spyOn(log, 'info');
    const good = data(await submitJudgeLease(config, lease.ref, {
      driver: judgeDriver, outcome: 'success', answer: { label: 'missed', reasoning: 'It skipped the race.' },
      judge: { tool: 'claude', model: 'm1', usage: { inputTokens: 10, outputTokens: 2 } },
    }));
    expect(good).toMatchObject({ label: { scorer: 'quality', label: 'missed', score: 0, passed: false } });
    const { reasoning } = z.object({ reasoning: z.string() }).parse(good.label);
    expect(info.mock.calls).toEqual([[`To share what went wrong, ask your agent to read ${reasoning} and share it with the team (teamai contribute).`]]);
    const labels = fs.readFileSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(labels).toEqual([expect.objectContaining({
      scorer: 'quality', label: 'missed', score: 0, passed: false, source: 'workflow', subject: { runId, step: 'review', pass: 1 },
      judge: { kind: 'model', tool: 'claude', model: { reported: 'm1' }, usage: { inputTokens: 10, outputTokens: 2 }, isolation: 'verified', access: 'full' },
    })]);
    expect(fs.existsSync(lease.evidence)).toBe(false);
    // A repeated submit answers the same label; nothing is left to judge.
    expect(data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'x' } }))).toEqual(good);
    expect(info).toHaveBeenCalledTimes(1);
    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 } });
    // Scoring never writes the run file.
    expect(fs.readFileSync(path.join(config.dataHome ?? '', 'workflows', 'runs', `${runId}.json`), 'utf8')).toBe(before);
  });

  it('refuses a lapsed lease once a later lease of the same pass labelled it, and replays the later lease\'s own verdict', async () => {
    const config = fixture(scorer(100));
    const start = Date.parse((await runOf(config, await settledRun(config))).updatedAt);
    const minutes = (count: number) => new Date(start + count * 60 * 1000).toISOString();
    const second = { ...judgeDriver, machine: 'm2' };
    const first = leaseOf(await nextJudgeLease(config, request(), minutes(0)));
    const replaced = leaseOf(await nextJudgeLease(config, request({ driver: second }), minutes(31)));
    const answer = { driver: second, outcome: 'success' as const, answer: { label: 'good', reasoning: 'Found the race.' } };
    const settled = data(await submitJudgeLease(config, replaced.ref, answer, minutes(32)));
    expect(await submitJudgeLease(config, first.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'missed', reasoning: 'Missed it.' } }, minutes(33)))
      .toMatchObject({ error: { code: 'lease_expired' } });
    expect((await LabelStore.local(config)).map((label) => label.label)).toEqual(['good']);

    const replay = data(await submitJudgeLease(config, replaced.ref, answer, minutes(34)));
    expect(replay).toEqual(settled);
    const reasoning = z.object({ label: z.object({ reasoning: z.string() }) }).parse(replay).label.reasoning;
    expect(fs.readFileSync(reasoning, 'utf8')).toContain('Found the race.');
  });

  it('never hands judge work to workflow next, and workflow report refuses a judge ref', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const lease = leaseOf(await nextJudgeLease(config, request()));
    expect(data(await leaseNext(config, runId, workDriver))).toEqual(expect.objectContaining({ done: expect.anything() }));
    expect(await reportAttempt(config, runId, { attempt: lease.ref, revision: 1, outcome: 'success', driver: workDriver, outputs: { reviewed: true } }))
      .toMatchObject({ error: { code: 'judge_lease', message: expect.stringContaining(`teamai score --lease ${lease.ref} --submit`) } });
  });

  it('names the entry it closed for empty evidence in the next answer', async () => {
    const config = fixture(scorer(100));
    await syncWorkflowDefinitions(config);
    const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
    const work = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, runId, workDriver)).lease);
    data(await reportAttempt(config, runId, { ...work, outcome: 'success', driver: workDriver }));

    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 }, closed: [{ ref: expect.stringMatching(/^s[0-9a-f]{13}\/a[0-9a-f]{8}$/), code: 'evidence_empty' }] });
  });

  it('offers nothing at samplingRate 0', async () => {
    const config = fixture(scorer(0));
    await settledRun(config);
    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 } });
  });

  it('leases a verified scorer only to a verified judge', async () => {
    const config = fixture(scorer(100, 'isolation: verified\n'));
    await settledRun(config);
    expect(data(await nextJudgeLease(config, request({ judge: { isolation: 'best-effort', tools: ['codex'] } })))).toEqual({ idle: { open: 1, leased: 0 } });
    expect(data(await nextJudgeLease(config, request()))).toHaveProperty('lease');
  });

  it('refuses a best-effort answer for a verified scorer and keeps the lease open', async () => {
    const config = fixture(scorer(100, 'isolation: verified\n'));
    await settledRun(config);
    const lease = leaseOf(await nextJudgeLease(config, request()));
    const answer = { driver: judgeDriver, outcome: 'success' as const, answer: { label: 'good', reasoning: 'r' } };

    expect(await submitJudgeLease(config, lease.ref, { ...answer, judge: { isolation: 'best-effort' } })).toMatchObject({ error: { code: 'isolation_unmet' } });
    expect(await LabelStore.local(config)).toEqual([]);
    expect(data(await submitJudgeLease(config, lease.ref, answer))).toMatchObject({ label: { label: 'good' } });
  });

  it('names the file of a namespaced scorer that asks for a verified judge', async () => {
    const config = fixture(scorer(100));
    const scorers = path.join(config.repo.localPath, 'scorers');
    fs.rmSync(path.join(scorers, 'quality.md'));
    fs.mkdirSync(path.join(scorers, 'ops'));
    fs.writeFileSync(path.join(scorers, 'ops', 'quality.md'), scorer(100, 'isolation: verified\n'));
    await settledRun(config);
    const lease = leaseOf(await nextJudgeLease(config, request()));

    expect(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'r' }, judge: { isolation: 'best-effort' } }))
      .toMatchObject({ error: { code: 'isolation_unmet', message: expect.stringContaining('scorers/ops/quality.md isolation asks for verified') } });
  });

  it('names the namespaced file once activation at one team revision selects it over an identical root scorer', async () => {
    const config = fixture(scorer(100, 'isolation: verified\n'));
    const knowledge = config.repo.localPath;
    fs.mkdirSync(path.join(knowledge, 'scorers', 'ops'));
    fs.writeFileSync(path.join(knowledge, 'scorers', 'ops', 'quality.md'), scorer(100, 'isolation: verified\n'));
    fs.mkdirSync(path.join(knowledge, 'manifest'));
    fs.writeFileSync(path.join(knowledge, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [] }\n');
    const origin = path.join(config.projectRoot ?? '', 'origin.git');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: knowledge, encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '--bare', '-q', origin]);
    git('init', '-q');
    git('config', 'user.name', 'T');
    git('config', 'user.email', 't@example.test');
    git('add', '.');
    git('commit', '-qm', 'one rubric in root and namespace');
    git('remote', 'add', 'origin', origin);
    git('push', '-qu', 'origin', 'HEAD');
    const member: LocalConfig = { ...config, repo: { ...config.repo, kind: 'git', remote: origin } };
    await syncWorkflowDefinitions({ ...member, primaryRole: 'dev' });
    await settledRun(member);
    const lease = leaseOf(await nextJudgeLease(member, request()));

    expect(await submitJudgeLease(member, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'r' }, judge: { isolation: 'best-effort' } }))
      .toMatchObject({ error: { code: 'isolation_unmet', message: expect.stringContaining('scorers/ops/quality.md isolation asks for verified') } });
  });

  it.each([
    ['the team', 'verified', {}],
    ['this machine', undefined, { scoring: { isolation: 'verified' } }],
    ['an unknown value, counted as verified,', undefined, { scoring: { isolation: 'strict' } }],
  ])('leases only to a verified judge when %s asks for it', async (_who, teamIsolation, machine) => {
    const config = fixture(scorer(100), machine);
    if (teamIsolation) fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'scoring.yaml'), `isolation: ${teamIsolation}\n`);
    await settledRun(config);
    expect(data(await nextJudgeLease(config, request({ judge: { isolation: 'best-effort', tools: ['codex'] } })))).toEqual({ idle: { open: 1, leased: 0 } });
    expect(data(await nextJudgeLease(config, request()))).toHaveProperty('lease');
  });

  it('refuses to judge locally with a tool below the isolation the team asks for', async () => {
    const config = fixture(scorer(100));
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'scoring.yaml'), 'isolation: verified\n');
    await settledRun(config);
    const bin = path.join(config.projectRoot ?? '', 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', structured_output: { label: 'good', reasoning: 'r' } })));\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const lease = leaseOf(await nextJudgeLease(config, request()));
    expect(await runJudgeLease(config, lease.ref, { driver: judgeDriver })).toMatchObject({ error: { code: 'judge_tool_unavailable' } });
  });

  it('hands out no judge work and keeps a lease open while the team scoring settings cannot be read', async () => {
    const config = fixture(scorer(100));
    await settledRun(config);
    const lease = leaseOf(await nextJudgeLease(config, request()));
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'scoring.yaml'), 'isolation: [verified\n');

    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 } });
    expect(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'r' } }))
      .toMatchObject({ error: { code: 'scoring_settings_invalid', message: expect.stringMatching(/^scorers\/scoring\.yaml is not valid YAML: /) } });
    expect(await LabelStore.local(config)).toEqual([]);
  });

  it('releases a lease its driver can no longer judge as leased, on hand-back and on renewal', async () => {
    const config = fixture(scorer(100, 'isolation: verified\n'));
    await settledRun(config);
    const downgraded = request({ judge: { isolation: 'best-effort', tools: ['codex'] } });
    const handedBack = leaseOf(await nextJudgeLease(config, request()));
    expect(data(await nextJudgeLease(config, downgraded))).toEqual({ idle: { open: 1, leased: 0 } });
    expect(await submitJudgeLease(config, handedBack.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'r' } }))
      .toMatchObject({ error: { code: 'lease_settled' } });

    const renewed = leaseOf(await nextJudgeLease(config, request()));
    expect(renewed.ref).not.toBe(handedBack.ref);
    expect(data(await nextJudgeLease(config, { ...downgraded, running: [renewed.ref] }))).toEqual({ idle: { open: 1, leased: 0 } });
    expect(leaseOf(await nextJudgeLease(config, request())).ref).not.toBe(renewed.ref);
  });

  it('renews a lease the driver lists in running and hands another driver nothing while it is live', async () => {
    const config = fixture(scorer(100));
    await settledRun(config);
    const lease = leaseOf(await nextJudgeLease(config, request(), '2026-10-22T12:00:00.000Z'));
    expect(lease.expiresAt).toBe('2026-10-22T12:30:00.000Z');
    expect(data(await nextJudgeLease(config, request({ running: [lease.ref] }), '2026-10-22T12:20:00.000Z'))).toEqual({ idle: { open: 0, leased: 1 } });
    const other = { kind: 't3', machine: 'm2', workspace: '/w' };
    expect(data(await nextJudgeLease(config, request({ driver: other }), '2026-10-22T12:45:00.000Z'))).toEqual({ idle: { open: 0, leased: 1 } });
    expect(data(await nextJudgeLease(config, request({ driver: other }), '2026-10-22T12:51:00.000Z')).lease).not.toMatchObject({ ref: lease.ref });
  });

  it('renews a lease taken just before its run leaves the entry window', async () => {
    const config = fixture(scorer(100));
    const run = await runOf(config, await settledRun(config));
    const closes = Date.parse(run.updatedAt) + 14 * 24 * 60 * 60 * 1000;
    const at = (ms: number) => new Date(closes + ms).toISOString();
    const lease = leaseOf(await nextJudgeLease(config, request(), at(-1000)));
    expect(data(await nextJudgeLease(config, request({ running: [lease.ref] }), at(1000)))).toEqual({ idle: { open: 0, leased: 1 } });
    expect(leaseOf(await nextJudgeLease(config, request(), at(30 * 60 * 1000)))).toMatchObject({ ref: lease.ref, expiresAt: at(1000 + 30 * 60 * 1000), handedBack: true });
  });

  it('refuses a submit once the work it was for has closed', async () => {
    const answer = { driver: judgeDriver, outcome: 'success' as const, answer: { label: 'good', reasoning: 'late' } };
    const labels = (config: LocalConfig) => path.join(config.dataHome ?? '', 'scores', 'labels.jsonl');
    const lapsed = fixture(scorer(100));
    const start = Date.parse((await runOf(lapsed, await settledRun(lapsed))).updatedAt);
    const minutes = (count: number) => new Date(start + count * 60 * 1000).toISOString();
    let lease = leaseOf(await nextJudgeLease(lapsed, request(), minutes(0)));
    for (const count of [31, 62, 93]) lease = leaseOf(await nextJudgeLease(lapsed, request(), minutes(count)));
    expect(data(await nextJudgeLease(lapsed, request(), minutes(124)))).toEqual({ idle: { open: 0, leased: 0 } });
    expect(await submitJudgeLease(lapsed, lease.ref, answer, minutes(125))).toMatchObject({ error: { code: 'entry_closed', message: expect.stringContaining('lease_expired') } });
    expect(fs.existsSync(labels(lapsed))).toBe(false);

    const old = fixture(scorer(100));
    const closes = Date.parse((await runOf(old, await settledRun(old))).updatedAt) + 14 * 24 * 60 * 60 * 1000;
    const kept = leaseOf(await nextJudgeLease(old, request(), new Date(closes - 1000).toISOString()));
    expect(await submitJudgeLease(old, kept.ref, answer, new Date(closes + 31 * 60 * 1000).toISOString())).toMatchObject({ error: { code: 'entry_closed' } });
    expect(fs.existsSync(labels(old))).toBe(false);
  });

  it('offers nothing while the project keeps its data inside the repository', async () => {
    const config = fixture(scorer(100));
    await settledRun(config);
    const inRepo = path.join(config.projectRoot ?? '', '.teamai');
    fs.renameSync(config.dataHome ?? '', inRepo);
    const legacy: LocalConfig = { ...config, repo: { ...config.repo, kind: 'git' }, dataHome: inRepo };
    expect(data(await nextJudgeLease(legacy, request()))).toEqual({ idle: { open: 0, leased: 0 } });
    // The same data in self mode, whose .teamai is team knowledge and not the data home rule, is offered.
    expect(data(await nextJudgeLease({ ...legacy, repo: config.repo }, request()))).toHaveProperty('lease');
  });

  it('refuses a submission whose usage is not a finite number', () => {
    const payload: unknown = JSON.parse('{"driver":{"kind":"t3","machine":"m1","workspace":"/w"},"outcome":"success","answer":{"label":"good","reasoning":"r"},"judge":{"usage":{"inputTokens":1e309}}}');
    expect(parseJudgeSubmission(payload)).toMatch(/^judge\.usage\.inputTokens: /);
  });
});

describe('judge work and a work budget', () => {
  const BUDGETED = `schemaVersion: v1alpha1
name: review
description: A reviewed step, then a fix, under one token budget.
budget: { tokens: 100 }
steps:
  - id: review
    prompt: Review the change.
    scorers: [quality]
  - id: fix
    needs: [review]
    prompt: Fix what the review found.
`;
  const reports = { can: { tokens: true } };

  /** Settles the review with 90 of the run's 100 tokens and returns the run, still running. */
  async function reviewed(config: LocalConfig): Promise<string> {
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'review.yaml'), BUDGETED);
    await syncWorkflowDefinitions(config);
    const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
    const lease = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, runId, workDriver, reports)).lease);
    data(await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: workDriver, outputs: { reviewed: true }, tokens: { input: 60, output: 30 } }));
    return runId;
  }

  it('leaves the work budget as it was when a judge spends tokens on a pass of the running run', async () => {
    const config = fixture(scorer(100));
    const runId = await reviewed(config);
    const before = await runOf(config, runId);
    const lease = leaseOf(await nextJudgeLease(config, request()));
    data(await submitJudgeLease(config, lease.ref, {
      driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'r' }, judge: { usage: { inputTokens: 5000, outputTokens: 500 } },
    }));
    expect(await runOf(config, runId)).toEqual(before);
    expect(data(await leaseNext(config, runId, workDriver, reports))).toMatchObject({ lease: { step: 'fix' } });
  });

  it('settles a judge lease that keeps lapsing without a label, and the run it judged goes on', async () => {
    const config = fixture(scorer(100));
    const runId = await reviewed(config);
    const before = await runOf(config, runId);
    const start = Date.parse(before.updatedAt);
    const minutes = (count: number): string => new Date(start + count * 60 * 1000).toISOString();
    for (const count of [0, 31, 62, 93]) leaseOf(await nextJudgeLease(config, request(), minutes(count)));
    expect(data(await nextJudgeLease(config, request(), minutes(124)))).toEqual({ idle: { open: 0, leased: 0 } });
    expect(fs.existsSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'))).toBe(false);
    expect(await runOf(config, runId)).toEqual(before);
    expect(data(await leaseNext(config, runId, workDriver, reports))).toMatchObject({ lease: { step: 'fix' } });
  });
});

describe('scoring totals', () => {
  /** Settles a run at `samplingRate`, judges whatever is offered with a released then a labelled attempt, and returns its end record. */
  async function judgedRun(samplingRate: number) {
    const config = fixture(scorer(samplingRate));
    const runId = await settledRun(config);
    const usage = { inputTokens: 1000, outputTokens: 50 };
    for (const outcome of ['released', 'success'] as const) {
      const lease = LeaseSchema.optional().parse(data(await nextJudgeLease(config, request())).lease);
      if (!lease) break;
      data(await submitJudgeLease(config, lease.ref, outcome === 'success'
        ? { driver: judgeDriver, outcome, judge: { tool: 'claude', usage }, answer: { label: 'good', reasoning: 'Quokka-marmalade verdict.' } }
        : { driver: judgeDriver, outcome, judge: { tool: 'claude', usage } }));
    }
    const run = await runOf(config, runId);
    const { stepCounts, iterations, failure, steps } = buildEndRecord(run, workDriver, 'tester');
    return { config, runId, totals: { stepCounts, iterations, failure, tokens: steps?.map((step) => step.tokens) } };
  }

  it('leaves a run\'s counts, iterations, failure and work tokens as they are at samplingRate 0', async () => {
    const sampled = await judgedRun(100);
    const unsampled = await judgedRun(0);
    expect(sampled.totals).toEqual(unsampled.totals);

    const detail = await workflowRunDetail(sampled.config, 'local', sampled.runId);
    expect(detail?.steps).toEqual([expect.objectContaining({ step: 'review', pass: 1, scores: [{ scorer: 'quality', label: 'good', passed: true }] })]);
    expect(detail?.scoring).toEqual({ judged: 2, inputTokens: 2000, outputTokens: 100 });
    expect(JSON.stringify(detail)).not.toContain('Quokka-marmalade');
    expect((await workflowRunDetail(unsampled.config, 'local', unsampled.runId))?.scoring).toEqual({ judged: 0, inputTokens: 0, outputTokens: 0 });
  });
});

describe('scoredPasses', () => {
  it('judges the agent pass of a step that delivers, for the install that reported it, whatever becomes of its delivery', async () => {
    const config = fixture(scorer(100));
    const run = await runOf(config, await settledRun(config));
    const install = (await installOwner(config)).id;
    const reported = { id: 'review', settledAt: 2, attempt: 'a1', installId: install, delivery: { branch: `teamai/${run.id}/review/p1`, head: 'c'.repeat(40) } };
    const judged = [{ subject: { runId: run.id, step: 'review', pass: 1 }, scorers: ['quality'] }];
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
    expect(scoredPasses(run, install)).toEqual([{ subject: { runId: run.id, step: 'review', pass: 1 }, scorers: ['quality'] }]);
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
    // Taken here, then closed: the hand-built pass recorded nothing to judge.
    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 }, closed: [{ ref: expect.any(String), code: 'evidence_empty' }] });
  });

  it('scores the items of a for_each step, never the step that fans them out', async () => {
    const config = fixture(scorer(100));
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'review.yaml'), WORKFLOW.replace('    scorers:', "    for_each: '[]'\n    scorers:"));
    await syncWorkflowDefinitions(config);
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
  const labelled = async (config: LocalConfig): Promise<unknown> => {
    const lease = leaseOf(await nextJudgeLease(config, request()));
    data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'r' } }));
    return (await LabelStore.local(config))[0];
  };

  it('labels a pass with the team skills its driver reported, without a value not shaped like a skill name', async () => {
    const config = fixture(scorer(100));
    await settledRun(config, { used: { skills: ['review-notes', '/Users/me/.claude/skills/deploy/SKILL.md'] } });
    expect(await labelled(config)).toMatchObject({ source: 'workflow', used: { skills: ['review-notes'] } });
  });

  it.each([
    ['no used', {}, 'absent'],
    ['no skill loaded', { used: { skills: [] } }, { skills: [] }],
    ['only values not shaped like a skill name', { used: { skills: ['/Users/me/.claude/skills/deploy/SKILL.md'] } }, 'absent'],
  ])('labels a pass whose driver reported %s with what it observed', async (_, reported, used) => {
    const config = fixture(scorer(100));
    await settledRun(config, reported);
    const label = z.object({ source: z.literal('workflow') }).passthrough().parse(await labelled(config));
    expect('used' in label ? label.used : 'absent').toEqual(used);
  });

  it.each([
    ['each child reported skills', [{ used: { skills: ['review-notes'] } }, { used: { skills: ['deploy-notes', 'review-notes'] } }], { skills: ['deploy-notes', 'review-notes'] }],
    ['one child reported skills', [{ used: { skills: ['review-notes'] } }, {}], { skills: ['review-notes'] }],
    ['no child reported used', [{}, {}], 'absent'],
  ])('labels a sub-workflow pass with the team skills its child passes used when %s', async (_, reports, used) => {
    const config = fixture(scorer(100));
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'review.yaml'), `schemaVersion: v1alpha1
name: review
description: One reviewed sub-workflow.
steps:
  - id: check
    scorers: [quality]
    workflow:
      steps:
        - id: draft
          prompt: Draft the change.
        - id: review
          needs: [draft]
          prompt: Review the change.
`);
    await syncWorkflowDefinitions(config);
    const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
    for (const reported of reports) {
      const lease = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, runId, workDriver)).lease);
      const parsed = parseReport({ attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: workDriver, outputs: { done: true }, ...reported });
      if (typeof parsed === 'string') throw new Error(parsed);
      data(await reportAttempt(config, runId, parsed.report));
    }
    expect(data(await leaseNext(config, runId, workDriver))).toMatchObject({ done: { outcome: 'succeeded' } });

    const label = z.object({ subject: z.object({ step: z.literal('check') }) }).passthrough().parse(await labelled(config));
    expect('used' in label ? label.used : 'absent').toEqual(used);
  });

  it('refuses a report whose used is not a list of skill names', () => {
    expect(parseReport({ attempt: 'a1', revision: 1, outcome: 'success', driver: workDriver, used: { skills: 'review-notes' } }))
      .toBe('used must be an object whose skills is an array of skill names');
  });
});

describe('run snapshot', () => {
  it('publishes the pinned scorers by hash only, and the install and within stamps as they are', async () => {
    const config = fixture(scorer(100));
    const run = await runOf(config, await settledRun(config));
    const projected = projectRun({ ...run, archive: [{ step: 'x.y', pass: 1, outcome: 'success', within: { step: 'x', pass: 1 } }] }, {});
    if (!projected.ok) throw new Error(projected.error.message);
    expect(projected.value.scorers).toEqual({ quality: { sourceHash: run.scorers?.quality?.sourceHash } });
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

describe('batched judge work', () => {
  const tests = (extra = '') => `---
labels:
  - { value: covered, score: 1, description: Tests cover the change }
  - { value: thin, score: 0, description: Tests miss the change }
passingScore: 0.5
samplingRate: 100
${extra}---
Judge the tests.
`;
  const workflow = (scorers: string) => `schemaVersion: v1alpha1
name: review
description: One reviewed step.
steps:
  - id: review
    prompt: Review the change.
    scorers: ${scorers}
`;
  function batchFixture(scorers: string, testsExtra = '', team = ''): LocalConfig {
    const config = fixture(scorer(100));
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'tests.md'), tests(testsExtra));
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'review.yaml'), workflow(scorers));
    if (team) fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'scoring.yaml'), team);
    return config;
  }
  const BatchLeaseSchema = LeaseSchema.extend({ scorers: z.array(z.string()), batched: z.literal(true), answer: z.object({ schema: z.record(z.unknown()) }) });
  const labelsOf = (config: LocalConfig): unknown[] =>
    fs.readFileSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
  const both = { quality: { label: 'good', reasoning: 'Found the defect.' }, tests: { label: 'thin', reasoning: 'No test for it.' } };

  it('gives the scorers of one pass one lease, one evidence dir, one prompt with each rubric, and one label per scorer', async () => {
    const config = batchFixture('{ names: [quality, tests], batch: true }');
    const runId = await settledRun(config);

    const lease = BatchLeaseSchema.parse(data(await nextJudgeLease(config, request())).lease);
    expect(lease).toMatchObject({ scorers: ['quality', 'tests'], batched: true, subject: { runId, step: 'review', pass: 1 }, judge: { tool: 'claude' } });
    expect(lease.answer.schema).toMatchObject({
      required: ['quality', 'tests'],
      properties: { quality: { properties: { label: { enum: ['good', 'missed'] } } }, tests: { properties: { label: { enum: ['covered', 'thin'] } } } },
    });
    const prompt = fs.readFileSync(lease.prompt, 'utf8');
    expect(prompt).toContain('Judge the review.');
    expect(prompt).toContain('Judge the tests.');
    expect(data(await nextJudgeLease(config, request({ driver: { ...judgeDriver, machine: 'm2' } })))).toEqual({ idle: { open: 0, leased: 2 } });

    const settled = data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: both, judge: { tool: 'claude' } }));
    expect(settled).toMatchObject({ labels: [{ scorer: 'quality', label: 'good', passed: true }, { scorer: 'tests', label: 'thin', passed: false }] });
    expect(labelsOf(config)).toEqual([
      expect.objectContaining({ scorer: 'quality', label: 'good', judge: expect.objectContaining({ tool: 'claude', batched: true }) }),
      expect.objectContaining({ scorer: 'tests', label: 'thin', judge: expect.objectContaining({ tool: 'claude', batched: true }) }),
    ]);
    expect(fs.existsSync(lease.evidence)).toBe(false);
    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 } });
    expect(data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: both }))).toEqual(settled);
  });

  it('counts a batch\'s one judge call once in both the local and the published totals', async () => {
    const config = batchFixture('{ names: [quality, tests], batch: true }');
    const runId = await settledRun(config);
    const lease = BatchLeaseSchema.parse(data(await nextJudgeLease(config, request())).lease);
    const usage = { inputTokens: 4, outputTokens: 235 };

    data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: both, judge: { tool: 'claude', usage } }));

    expect((await workflowRunDetail(config, 'local', runId))?.scoring).toEqual({ judged: 2, ...usage });
    const published = path.join(getReportsDir(config), 'scores', 'tester', '2026-10.jsonl');
    fs.mkdirSync(path.dirname(published), { recursive: true });
    fs.writeFileSync(published, labelsOf(config).map((label) => `${JSON.stringify(label)}\n`).join(''));
    expect(await LabelStore.scoringTotal(config, runId, 'published')).toEqual({ judged: 2, ...usage });
  });

  it('rejects the whole answer when one label is not its scorer\'s, and keeps the lease open', async () => {
    const config = batchFixture('{ names: [quality, tests], batch: true }');
    await settledRun(config);
    const lease = BatchLeaseSchema.parse(data(await nextJudgeLease(config, request())).lease);

    const wrong: JudgeAnswer[] = [{ ...both, tests: { label: 'good', reasoning: 'r' } }, { quality: both.quality }, { label: 'good', reasoning: 'r' }];
    for (const answer of wrong) {
      expect(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer })).toMatchObject({ error: { code: 'label_invalid' } });
    }
    expect(fs.existsSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'))).toBe(false);
    expect(data(await nextJudgeLease(config, request())).lease).toMatchObject({ ref: lease.ref, handedBack: true, scorers: ['quality', 'tests'] });
    expect(data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: both }))).toMatchObject({ labels: [{ label: 'good' }, { label: 'thin' }] });
  });

  it('takes a batch afresh after an interrupted lease wrote only some of its scorers', async () => {
    const config = batchFixture('{ names: [quality, tests], batch: true }');
    await settledRun(config);
    const write = AttemptStore.write;
    const interrupted = vi.spyOn(AttemptStore, 'write').mockImplementation(async (...args) => {
      if (args[1].scorer === 'tests') throw new Error('interrupted');
      return write(...args);
    });
    await expect(nextJudgeLease(config, request())).rejects.toThrow('interrupted');
    interrupted.mockRestore();

    const lease = BatchLeaseSchema.parse(data(await nextJudgeLease(config, request())).lease);
    expect(lease.scorers).toEqual(['quality', 'tests']);
    expect(data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: both }))).toHaveProperty('labels');
  });

  it('offers the rest of a batch again after a submit labelled only some of its scorers', async () => {
    const config = batchFixture('{ names: [quality, tests], batch: true }');
    await settledRun(config);
    const lease = BatchLeaseSchema.parse(data(await nextJudgeLease(config, request())).lease);
    const append = LabelStore.append;
    const interrupted = vi.spyOn(LabelStore, 'append').mockImplementation(async (...args) => {
      if (args[1].scorer === 'tests') throw new Error('interrupted');
      return append(...args);
    });
    await expect(submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: both })).rejects.toThrow('interrupted');
    interrupted.mockRestore();

    const rest = leaseOf(await nextJudgeLease(config, request()));
    expect(rest).toMatchObject({ scorer: 'tests' });
    data(await submitJudgeLease(config, rest.ref, { driver: judgeDriver, outcome: 'success', answer: both.tests }));
    expect(labelsOf(config)).toEqual([expect.objectContaining({ scorer: 'quality', label: 'good' }), expect.objectContaining({ scorer: 'tests', label: 'thin' })]);
  });

  it('renews and releases a batch lease as one', async () => {
    const config = batchFixture('{ names: [quality, tests], batch: true }');
    await settledRun(config);
    const lease = BatchLeaseSchema.parse(data(await nextJudgeLease(config, request(), '2026-10-22T12:00:00.000Z')).lease);

    expect(data(await nextJudgeLease(config, request({ running: [lease.ref] }), '2026-10-22T12:20:00.000Z'))).toEqual({ idle: { open: 0, leased: 2 } });
    expect(data(await nextJudgeLease(config, request({ driver: { ...judgeDriver, machine: 'm2' } }), '2026-10-22T12:40:00.000Z'))).toEqual({ idle: { open: 0, leased: 2 } });
    expect(data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'released' }, '2026-10-22T12:41:00.000Z'))).toEqual({ settled: { ref: lease.ref, status: 'released' } });
    expect(BatchLeaseSchema.parse(data(await nextJudgeLease(config, request(), '2026-10-22T12:42:00.000Z')).lease).scorers).toEqual(['quality', 'tests']);
  });

  it('never batches scorers that resolve to different models, nor scorers no layer batches', async () => {
    for (const config of [batchFixture('{ names: [quality, tests], batch: true }', 'model: judge-x\n'), batchFixture('[quality, tests]')]) {
      await settledRun(config);
      const first = leaseOf(await nextJudgeLease(config, request()));
      expect(first).toMatchObject({ scorer: 'quality' });
      expect(first).not.toHaveProperty('batched');
      expect(leaseOf(await nextJudgeLease(config, request({ driver: { ...judgeDriver, machine: 'm2' } })))).toMatchObject({ scorer: 'tests' });
    }
  });

  it('batches scorers whose aliases give the same model, and labels each with its own alias', async () => {
    const config = batchFixture('{ names: [quality, tests], batch: true }', 'model: cheap\n');
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'quality.md'), scorer(100).replace('samplingRate: 100', 'samplingRate: 100\nmodel: fast'));
    fs.mkdirSync(path.join(config.repo.localPath, 'models'));
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), 'aliases:\n  fast:\n    claude: haiku\n  cheap:\n    claude: haiku\n');
    await settledRun(config);
    const lease = BatchLeaseSchema.parse(data(await nextJudgeLease(config, request())).lease);

    data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: both }));

    expect(labelsOf(config)).toEqual([
      expect.objectContaining({ scorer: 'quality', judge: expect.objectContaining({ model: { requested: 'haiku', alias: 'fast' }, batched: true }) }),
      expect.objectContaining({ scorer: 'tests', judge: expect.objectContaining({ model: { requested: 'haiku', alias: 'cheap' }, batched: true }) }),
    ]);
  });

  it('judges a batch locally in one tool run that answers every scorer', async () => {
    const config = batchFixture('{ names: [quality, tests], batch: true }');
    await settledRun(config);
    const bin = path.join(config.projectRoot ?? '', 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs');
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
fs.appendFileSync(${JSON.stringify(path.join(bin, 'runs'))}, 'run\\n');
process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', structured_output: ${JSON.stringify(both)} })));\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const lease = BatchLeaseSchema.parse(data(await nextJudgeLease(config, request())).lease);

    expect(data(await runJudgeLease(config, lease.ref, { driver: judgeDriver }))).toMatchObject({ labels: [{ scorer: 'quality', label: 'good' }, { scorer: 'tests', label: 'thin' }] });
    expect(fs.readFileSync(path.join(bin, 'runs'), 'utf8')).toBe('run\n');
  });

  it('batches from the team\'s scorers/scoring.yaml when neither the step nor its workflow says', async () => {
    const config = batchFixture('[quality, tests]', '', 'batch: true\n');
    await settledRun(config);
    expect(BatchLeaseSchema.parse(data(await nextJudgeLease(config, request())).lease).scorers).toEqual(['quality', 'tests']);
  });
});

describe('judge on demand', () => {
  const extra = scorer(0).replace('Judge the review.', 'Judge the extra.');
  function fakeClaude(config: LocalConfig): void {
    const bin = path.join(config.projectRoot ?? '', 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'result', structured_output: { label: 'good', reasoning: 'found the defect' } }));
});\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
  }
  const labelsOf = (config: LocalConfig): unknown[] =>
    fs.readFileSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
  const success = (label = 'good') => ({ driver: judgeDriver, outcome: 'success' as const, answer: { label, reasoning: 'r' } });

  it('judges the latest succeeded pass here with the local tool, whatever sampling says', async () => {
    const config = fixture(scorer(0));
    const runId = await settledRun(config);
    fakeClaude(config);
    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 } });

    expect(data(await scoreOnDemand(config, { run: runId, step: 'review', scorers: ['quality'] }))).toMatchObject({
      label: { scorer: 'quality', subject: { runId, step: 'review', pass: 1 }, label: 'good', score: 1, passed: true },
    });
    expect(labelsOf(config)).toEqual([expect.objectContaining({ subject: { runId, step: 'review', pass: 1 }, judge: expect.objectContaining({ tool: 'claude', access: 'read' }) })]);
    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 } });
  });

  it('says which judge tools the scorer\'s alias has no model for, and in which file, and leaves the work open', async () => {
    const config = fixture(scorer(0).replace('samplingRate: 0', 'samplingRate: 0\nmodel: fast'));
    fs.mkdirSync(path.join(config.repo.localPath, 'models'));
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), 'aliases:\n  fast:\n    codex: gpt-6-mini\n');
    const runId = await settledRun(config);
    fakeClaude(config);
    vi.stubEnv('PATH', [path.join(config.projectRoot ?? '', 'bin'), '/usr/bin', '/bin'].join(path.delimiter));

    expect(await scoreOnDemand(config, { run: runId, step: 'review', scorers: ['quality'] })).toEqual({ error: {
      code: 'judge_model_unavailable',
      message: 'Scorer "quality" asks for model alias "fast", which has no model for claude in models/aliases.yaml. Add one, or remove model from the scorer.',
    } });
    expect(data(await nextJudgeLease(config, request({ judge: { isolation: 'verified', tools: ['codex'] } })))).toMatchObject({ lease: { judge: { tool: 'codex', model: { name: 'gpt-6-mini' } } } });
  });

  it('names the labels it kept when another scorer of the pass needs a model the local tool has none for', async () => {
    const config = fixture(scorer(0));
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'extra.md'), extra.replace('samplingRate: 0', 'samplingRate: 0\nmodel: fast'));
    fs.mkdirSync(path.join(config.repo.localPath, 'models'));
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), 'aliases:\n  fast:\n    codex: gpt-6-mini\n');
    const runId = await settledRun(config);
    fakeClaude(config);
    vi.stubEnv('PATH', [path.join(config.projectRoot ?? '', 'bin'), '/usr/bin', '/bin'].join(path.delimiter));
    const subject = { runId, step: 'review', pass: 1 };

    expect(await scoreOnDemand(config, { run: runId, step: 'review', scorers: ['quality', 'extra'] })).toEqual({ error: {
      code: 'judge_model_unavailable',
      message: 'Scorer "extra" asks for model alias "fast", which has no model for claude in models/aliases.yaml. Add one, or remove model from the scorer. Kept the label of quality: good.',
      labels: [expect.objectContaining({ scorer: 'quality', subject, label: 'good' })],
    } });
    expect(labelsOf(config)).toEqual([expect.objectContaining({ scorer: 'quality', subject, label: 'good' })]);
  });

  it('says the evidence is empty when a pass on demand recorded nothing to judge', async () => {
    const config = fixture(scorer(0));
    await syncWorkflowDefinitions(config);
    const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
    const work = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, runId, workDriver)).lease);
    data(await reportAttempt(config, runId, { ...work, outcome: 'success', driver: workDriver }));
    fakeClaude(config);

    expect(await scoreOnDemand(config, { run: runId, step: 'review', scorers: ['quality'] })).toMatchObject({ error: { code: 'evidence_empty' } });
  });

  it('queues a pass sampling skipped for any driver, the scorers of a batch as one lease', async () => {
    const config = fixture(scorer(0));
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'extra.md'), extra);
    const runId = await settledRun(config);
    const subject = { runId, step: 'review', pass: 1 };

    expect(data(await scoreOnDemand(config, { run: runId, step: 'review', pass: 1, scorers: ['quality', 'extra'], queue: true, batch: true }))).toEqual({
      queued: [{ scorer: 'quality', subject }, { scorer: 'extra', subject }],
    });
    const lease = leaseOf(await nextJudgeLease(config, request()));
    expect(lease).toMatchObject({ scorers: ['extra', 'quality'], batched: true, subject });
    expect(fs.readFileSync(lease.prompt, 'utf8')).toContain('Judge the extra.');
    data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { quality: { label: 'good', reasoning: 'r' }, extra: { label: 'missed', reasoning: 'r' } } }));
    expect(labelsOf(config)).toEqual([
      expect.objectContaining({ scorer: 'extra', label: 'missed', subject }),
      expect.objectContaining({ scorer: 'quality', label: 'good', subject }),
    ]);
    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 } });
  });

  it('reopens a failed or an expired entry only when asked', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const failed = leaseOf(await nextJudgeLease(config, request()));
    data(await submitJudgeLease(config, failed.ref, { driver: judgeDriver, outcome: 'failed' }));
    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 } });
    data(await scoreOnDemand(config, { run: runId, step: 'review', scorers: ['quality'], queue: true }));
    const again = leaseOf(await nextJudgeLease(config, request()));
    expect(again.ref).not.toBe(failed.ref);
    expect(data(await submitJudgeLease(config, again.ref, success()))).toMatchObject({ label: { label: 'good' } });

    const old = fixture(scorer(100));
    const oldRun = await settledRun(old);
    const later = new Date(Date.parse((await runOf(old, oldRun)).updatedAt) + 15 * 24 * 60 * 60 * 1000).toISOString();
    expect(data(await nextJudgeLease(old, request(), later))).toEqual({ idle: { open: 0, leased: 0 } });
    data(await scoreOnDemand(old, { run: oldRun, step: 'review', scorers: ['quality'], queue: true }, later));
    const reopened = leaseOf(await nextJudgeLease(old, request(), later));
    expect(data(await submitJudgeLease(old, reopened.ref, success(), later))).toMatchObject({ label: { label: 'good' } });
  });

  it('sweeps rubrics no attempt names, requests of closed entries and raw output of replaced attempts, and keeps labels', async () => {
    const config = fixture(scorer(0));
    const runId = await settledRun(config);
    const scores = path.join(config.dataHome ?? '', 'scores');
    const bin = path.join(config.projectRoot ?? '', 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', structured_output: { label: 'great', reasoning: 'r' } })));\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const orphan = path.join(scores, 'rubrics', `${'f'.repeat(64)}.json`);
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, JSON.stringify({ sourceHash: 'f'.repeat(64), content: 'old' }));
    data(await scoreOnDemand(config, { run: runId, step: 'review', scorers: ['quality'], queue: true }, '2026-10-23T10:00:00.000Z'));
    const first = leaseOf(await nextJudgeLease(config, request(), '2026-10-23T10:01:00.000Z'));
    expect(await runJudgeLease(config, first.ref, { driver: judgeDriver })).toMatchObject({ error: { code: 'judge_answer_invalid' } });
    const [entry = '', attempt = ''] = first.ref.split('/');
    expect(fs.existsSync(path.join(scores, 'raw', `${attempt}.txt`))).toBe(true);
    data(await submitJudgeLease(config, first.ref, { driver: judgeDriver, outcome: 'released' }, '2026-10-23T10:02:00.000Z'));
    const second = leaseOf(await nextJudgeLease(config, request(), '2026-10-23T10:03:00.000Z'));
    const labelled = data(await submitJudgeLease(config, second.ref, success(), '2026-10-23T10:04:00.000Z'));

    expect(data(await nextJudgeLease(config, request(), '2026-10-23T10:05:00.000Z'))).toEqual({ idle: { open: 0, leased: 0 } });

    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.readdirSync(path.join(scores, 'rubrics'))).toHaveLength(1);
    expect(fs.existsSync(path.join(scores, 'raw', `${attempt}.txt`))).toBe(false);
    expect(fs.existsSync(path.join(scores, 'attempts', entry, 'request.json'))).toBe(false);
    expect(labelsOf(config)).toHaveLength(1);
    expect(fs.existsSync(z.object({ reasoning: z.string() }).parse(labelled.label).reasoning)).toBe(true);
    expect(data(await submitJudgeLease(config, second.ref, success(), '2026-10-23T10:06:00.000Z'))).toEqual(labelled);
  });

  it('settles a live lease with its own rubric after another request takes the scorer\'s new one', async () => {
    const config = fixture(scorer(0));
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'extra.md'), extra);
    const runId = await settledRun(config);
    data(await scoreOnDemand(config, { run: runId, step: 'review', scorers: ['extra'], queue: true }, '2026-10-23T10:00:00.000Z'));
    const lease = leaseOf(await nextJudgeLease(config, request(), '2026-10-23T10:01:00.000Z'));
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'extra.md'), extra.replace('value: good', 'value: excellent'));
    await syncWorkflowDefinitions(config);
    data(await scoreOnDemand(config, { run: runId, step: 'review', scorers: ['extra'], queue: true }, '2026-10-23T10:02:00.000Z'));

    expect(data(await submitJudgeLease(config, lease.ref, success(), '2026-10-23T10:03:00.000Z'))).toMatchObject({ label: { scorer: 'extra', label: 'good' } });
  });

  it('hands back a live lease with its own rubric after a pull changed the scorer', async () => {
    const config = fixture(scorer(0));
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'extra.md'), extra);
    const runId = await settledRun(config);
    data(await scoreOnDemand(config, { run: runId, step: 'review', scorers: ['extra'], queue: true }, '2026-10-23T10:00:00.000Z'));
    const lease = leaseOf(await nextJudgeLease(config, request(), '2026-10-23T10:01:00.000Z'));
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'extra.md'), extra.replace('value: good', 'value: excellent'));
    await syncWorkflowDefinitions(config);
    data(await scoreOnDemand(config, { run: runId, step: 'review', scorers: ['extra'], queue: true }, '2026-10-23T10:02:00.000Z'));
    const back = leaseOf(await nextJudgeLease(config, request(), '2026-10-23T10:03:00.000Z'));

    expect(back).toMatchObject({ ref: lease.ref, handedBack: true, rubric: lease.rubric, answer: lease.answer });
    expect(fs.readFileSync(back.prompt, 'utf8')).not.toContain('excellent');
    expect(data(await submitJudgeLease(config, back.ref, success(), '2026-10-23T10:04:00.000Z'))).toMatchObject({ label: { scorer: 'extra', label: 'good' } });
  });

  it('settles a live lease with its own rubric after the run pins the scorer again', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const lease = leaseOf(await nextJudgeLease(config, request()));
    const file = path.join(config.dataHome ?? '', 'workflows', 'runs', `${runId}.json`);
    const run = z.object({ scorers: z.record(z.object({ sourceHash: z.string(), content: z.string() })) }).passthrough().parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    const content = scorer(100).replace('value: good', 'value: excellent');
    fs.writeFileSync(file, JSON.stringify({ ...run, scorers: { quality: { sourceHash: 'f'.repeat(64), content } } }));

    expect(data(await submitJudgeLease(config, lease.ref, success()))).toMatchObject({ label: { scorer: 'quality', label: 'good' } });
  });

  it('labels a copied scorer with the team revision its run pinned', async () => {
    const config = fixture(scorer(100));
    const cwd = config.repo.localPath;
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const origin = path.join(config.projectRoot ?? '', 'origin.git');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    git('init', '-q');
    git('config', 'user.name', 'T');
    git('config', 'user.email', 't@example.test');
    git('add', '.');
    git('commit', '-qm', 'quality');
    git('remote', 'add', 'origin', origin);
    git('push', '-qu', 'origin', 'HEAD');
    await settledRun(config);
    data(await submitJudgeLease(config, leaseOf(await nextJudgeLease(config, request())).ref, success()));
    fs.copyFileSync(path.join(cwd, 'scorers', 'quality.md'), path.join(cwd, 'scorers', 'tests.md'));
    fs.writeFileSync(path.join(cwd, 'workflows', 'review.yaml'), WORKFLOW.replace('[quality, nope]', '[tests]'));
    git('add', '.');
    git('commit', '-qm', 'tests');
    git('push', '-q');
    const runId = await settledRun(config);
    data(await submitJudgeLease(config, leaseOf(await nextJudgeLease(config, request())).ref, success()));

    const label = (await LabelStore.local(config)).find((one) => one.source === 'workflow' && one.subject.runId === runId);
    expect(label).toMatchObject({ scorer: 'tests', rubric: { teamRevision: git('rev-parse', 'HEAD') } });
  });

  it('names the valid runs, steps, passes and scorers when one is unknown', async () => {
    const config = fixture(scorer(0));
    const runId = await settledRun(config);
    const ask = (demand: Partial<Parameters<typeof scoreOnDemand>[1]>) =>
      scoreOnDemand(config, { run: runId, step: 'review', scorers: ['quality'], queue: true, ...demand });

    expect(await ask({ run: 'r0000000000000000' })).toMatchObject({ error: { code: 'run_not_found', message: expect.stringContaining(runId) } });
    expect(await ask({ step: 'nope' })).toMatchObject({ error: { code: 'step_not_found', message: expect.stringContaining('review') } });
    expect(await ask({ pass: 2 })).toMatchObject({ error: { code: 'pass_not_found', message: expect.stringContaining('Succeeded passes: 1') } });
    expect(await ask({ scorers: ['nope'] })).toMatchObject({ error: { code: 'scorer_not_found', message: expect.stringContaining('quality') } });
    expect(fs.existsSync(path.join(config.dataHome ?? '', 'scores', 'attempts'))).toBe(false);
  });
});

describe('judge model identity', () => {
  const withModel = (model: string) => scorer(100).replace('samplingRate: 100', `samplingRate: 100\nmodel: ${model}`);
  const teamAliases = (config: LocalConfig, yaml: string) => {
    fs.mkdirSync(path.join(config.repo.localPath, 'models'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), yaml);
  };
  const labelsOf = (config: LocalConfig): unknown[] =>
    fs.readFileSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
  afterEach(() => fs.rmSync(localAliasesPath(), { force: true }));

  it('records the model the lease named and the scorer\'s alias on the label of a submission that names no model', async () => {
    const config = fixture(withModel('fast'));
    teamAliases(config, 'aliases:\n  fast:\n    claude: { model: haiku, effort: low }\n');
    await settledRun(config);
    const lease = leaseOf(await nextJudgeLease(config, request()));
    expect(lease).toMatchObject({ judge: { tool: 'claude', model: { name: 'haiku', effort: 'low' }, by: 'scorer', alias: 'fast' } });

    data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'r' } }));

    expect(labelsOf(config)).toEqual([expect.objectContaining({
      judge: { kind: 'model', tool: 'claude', model: { requested: 'haiku', alias: 'fast' }, effort: { requested: 'low' }, isolation: 'verified', access: 'full' },
    })]);
  });

  it('records what the local judge launched with, what its tool reports, and the scorer\'s alias', async () => {
    const config = fixture(withModel('fast'));
    teamAliases(config, 'aliases:\n  fast:\n    claude: { model: haiku, effort: low }\n');
    await settledRun(config);
    const bin = path.join(config.projectRoot ?? '', 'bin');
    fs.mkdirSync(bin);
    const argv = path.join(config.projectRoot ?? '', 'argv.json');
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
require('node:fs').writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5' }));
console.log(JSON.stringify({ type: 'result', structured_output: { label: 'good', reasoning: 'found it' } }));
});\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const lease = leaseOf(await nextJudgeLease(config, request()));

    data(await runJudgeLease(config, lease.ref, { driver: judgeDriver }));

    expect(z.array(z.string()).parse(JSON.parse(fs.readFileSync(argv, 'utf8')))).toEqual(expect.arrayContaining(['--model', 'haiku', '--effort', 'low']));
    expect(labelsOf(config)).toEqual([expect.objectContaining({
      judge: { kind: 'model', tool: 'claude', model: { requested: 'haiku', reported: 'claude-haiku-4-5', alias: 'fast' }, effort: { requested: 'low' }, isolation: 'verified', access: 'read' },
    })]);
  });

  it('keeps the alias on the lease and the label when the member\'s ~ entry sends the judge to its tool default', async () => {
    const config = fixture(withModel('fast'));
    teamAliases(config, 'aliases:\n  fast:\n    claude: haiku\n');
    fs.mkdirSync(path.dirname(localAliasesPath()), { recursive: true });
    fs.writeFileSync(localAliasesPath(), 'aliases:\n  fast:\n    claude: ~\n');
    await settledRun(config);
    const lease = leaseOf(await nextJudgeLease(config, request()));
    expect(lease).toMatchObject({ judge: { tool: 'claude', by: 'tool_default', noModel: 'local', alias: 'fast' } });

    data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'r' } }));

    expect(labelsOf(config)).toEqual([expect.objectContaining({ judge: { kind: 'model', tool: 'claude', model: { alias: 'fast' }, isolation: 'verified', access: 'full' } })]);
  });
});
