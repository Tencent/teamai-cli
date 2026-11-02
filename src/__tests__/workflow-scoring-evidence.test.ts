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
import { collectEvidence, evidencePlan } from '../workflow/scoring-evidence.js';
import { readRun, updateRun } from '../workflow/store.js';
import type { StepState } from '../workflow/step-state.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import { AgentSession } from '../session-flow/agent-session.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun, type NextOptions } from '../workflow/engine.js';
import { nextJudgeLease, scoreOnDemand, submitJudgeLease, type JudgeRequest } from '../workflow/scoring.js';
import { LabelStore } from '../scorers/label-store.js';
import { workflowRunDetail } from '../dashboard/workflow-runs.js';
import { branchName } from '../workflow/workspace.js';
import { worktreePath } from '../workflow/worktree.js';
import type { DriverIdentity, RunState, WorkflowEnvelope } from '../workflow/types.js';
import { fakeGh } from './helpers/fake-gh.js';
import { PrUrlSchema } from '../workflow/pr-url.js';
import { knownSecrets } from '../env-resolution.js';
import { getTeamSecretsPath, writeSecretStore } from '../secret-store.js';
import { removeSubjectEvidence, subjectEvidenceDirOf } from '../scorers/evidence.js';

const SECRET = 'sk-ABCDEFGH1234567890abcdefghij';

const SCORER = `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 100
---
Judge the work.
`;

const WORKFLOW = `schemaVersion: v1alpha1
name: build
description: A change, a review of it, and a check.
steps:
  - id: write
    prompt: Add retries.
    workspace: new
    scorers: [quality]
  - id: review
    needs: [write]
    prompt: Review the retries.
    scorers: [quality]
  - id: check
    needs: [review]
    scorers: [quality]
    workflow:
      steps:
        - id: look
          prompt: Look again.
`;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const external: DriverIdentity = { kind: 'external', machine: 'm1', workspace: '/w' };
const judge = { kind: 't3', machine: 'm1', workspace: '/w' };
const request: JudgeRequest = { driver: judge, judge: { isolation: 'verified', tools: ['claude'] }, running: [] };

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-evidence-')));
  mocks.home = path.join(root, 'home');
  fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function plantSession(cwd: string, sessionId: string, text: string): void {
  const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(path.join(project, sessionId, 'subagents'), { recursive: true });
  const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`),
    line({ type: 'user', uuid: 'u1', parentUuid: null, cwd, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: text } })
    + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, timestamp: '2026-10-20T10:00:01.000Z',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { prompt: 'x'.repeat(5000) } }] } }));
  fs.writeFileSync(path.join(project, sessionId, 'subagents', 'agent-a.meta.json'), JSON.stringify({ toolUseId: 'toolu_1', spawnDepth: 1 }));
  fs.writeFileSync(path.join(project, sessionId, 'subagents', 'agent-a.jsonl'),
    line({ type: 'user', uuid: 'a1', parentUuid: null, isSidechain: true, message: { role: 'user', content: 'helper task' } })
    + line({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'helper done' }] } }));
}

async function scoredRun(driver: 'external' | 'local' = 'external', files: Record<string, string | Uint8Array> = {}, scorer = SCORER): Promise<{ config: LocalConfig; runId: string; checkout: string; from: string; to: string }> {
  const checkout = path.join(root, 'app');
  const work: DriverIdentity = driver === 'local' ? { kind: 'local', machine: 'm1', workspace: checkout } : external;
  fs.mkdirSync(path.join(checkout, 'src'), { recursive: true });
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.email', 't@example.com');
  git(checkout, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(checkout, 'src', 'app.ts'), 'export const run = () => task();\n');
  fs.symlinkSync('../../outside.txt', path.join(checkout, 'link'));
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(checkout, file), content);
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-qm', 'base');
  const from = git(checkout, 'rev-parse', 'HEAD');

  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'workflows', 'build.yaml'), WORKFLOW);
  fs.writeFileSync(path.join(knowledge, 'scorers', 'quality.md'), scorer);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: checkout, dataHome: path.join(root, 'data'),
  };
  await syncWorkflowDefinitions(config);
  const runId = String(data(await startRun(config, 'build', {}, { secrets: await knownSecrets(config), base: { ref: 'main', commit: from }, checkout })).run);

  const write = z.object({ attempt: z.string(), revision: z.number(), workspace: z.object({ branch: z.string() }) }).parse(data(await leaseNext(config, runId, work, { can: { workspace: ['new', 'continue', 'read-only'] } })).lease);
  git(checkout, 'checkout', '-q', '-B', write.workspace.branch, from);
  fs.writeFileSync(path.join(checkout, 'src', 'app.ts'), 'export const run = () => { for (let i = 0; i < 3; i++) if (task()) return; };\n');
  git(checkout, 'commit', '-qam', 'retries');
  const to = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', 'main');
  plantSession(driver === 'local' ? worktreePath(checkout, write.workspace.branch) : checkout, 'session-write', `Add retries. token ${SECRET}`);
  data(await reportAttempt(config, runId, {
    attempt: write.attempt, revision: write.revision, outcome: 'success', driver: work, tool: 'claude', session: 'session-write',
    outputs: { done: true }, changes: { branch: write.workspace.branch, base: from, from, to, commits: [to] },
  }));
  for (const session of ['session-review', 'session-look']) {
    const lease = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, runId, work, { can: { workspace: ['new', 'continue', 'read-only'] } })).lease);
    plantSession(checkout, session, `${session} prompt`);
    data(await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: work, tool: 'claude', session }));
  }
  expect(data(await leaseNext(config, runId, work))).toMatchObject({ done: { outcome: 'succeeded' } });
  return { config, runId, checkout, from, to };
}

const LeaseSchema = z.object({ ref: z.string(), evidence: z.string(), prompt: z.string(), subject: z.object({ step: z.string() }), handedBack: z.boolean().optional() });
type Lease = z.infer<typeof LeaseSchema>;

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const json = (file: string): unknown => JSON.parse(read(file));

function symlinksUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => fs.lstatSync(path.join(dir, name)).isSymbolicLink());
}

async function settle(config: LocalConfig, lease: Lease): Promise<void> {
  data(await submitJudgeLease(config, lease.ref, { driver: judge, outcome: 'success', answer: { label: 'good', reasoning: 'ok' }, judge: { tool: 'claude' } }));
}

describe('judge evidence', () => {
  it('uses the recorded read range and commit for a read-only review', async () => {
    const { config, runId, from, to } = await scoredRun();
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(String(run));
    const review = run.steps.find((step) => step.id === 'review');
    if (review?.status !== 'succeeded') throw new Error('Review did not succeed');
    review.read = { branch: 'judged-branch', base: from, commit: to };
    const plan = evidencePlan(run, { runId, step: 'review', pass: 1 });
    expect(plan).toMatchObject({ diff: { source: 'read', from, to }, repoAt: to, gaps: [] });
  });

  it('starts the diff of a workflow pass at its first child pass, archived or live', async () => {
    const { config, runId } = await scoredRun();
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(String(run));
    const look = run.steps.find((step) => step.id === 'check.look');
    if (look?.status !== 'succeeded') throw new Error('check.look did not succeed');
    const branch = 'teamai/copy/check.look';
    look.pass = 2;
    look.changes = { branch, base: 'c0', from: 'c1', to: 'c2', commits: ['c2'] };
    run.archive = [{ step: 'check.look', pass: 1, outcome: 'success', changes: { branch, base: 'c0', from: 'c0', to: 'c1', commits: ['c1'] }, within: { step: 'check', pass: 1 } }];
    run.copies = { [branchName(runId, 'check', 1)]: { commit: 'c2' } };
    const plan = evidencePlan(run, { runId, step: 'check', pass: 1 });
    expect(plan.diff).toMatchObject({ source: 'copy', from: 'c0', to: 'c2' });
  });

  it('holds the change, the repository at the judged commit with no symlink, and the redacted transcript with its subagents', async () => {
    const { config, runId, from, to } = await scoredRun();

    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);

    expect(lease.subject.step).toBe('write');
    expect(fs.existsSync(path.join(lease.evidence, '.ready'))).toBe(true);
    expect(json(path.join(lease.evidence, 'evidence.json'))).toEqual({
      subject: { runId, step: 'write', pass: 1 },
      kind: 'prompt',
      ranges: [{ step: 'write', pass: 1, branch: expect.stringContaining(`teamai/${runId}/`), from, to, source: 'changes' }],
      repoAt: to,
      gaps: [],
    });
    expect(read(path.join(lease.evidence, 'diff.patch'))).toContain('+export const run = () => { for (let i = 0; i < 3; i++)');
    expect(read(path.join(lease.evidence, 'repo', 'src', 'app.ts'))).toContain('for (let i = 0; i < 3; i++)');
    expect(read(path.join(lease.evidence, 'repo', 'link'))).toBe('../../outside.txt');
    expect(symlinksUnder(lease.evidence)).toEqual([]);
    const transcript = read(path.join(lease.evidence, 'transcripts', 'write#1.md'));
    expect(transcript).toContain('Add retries.');
    expect(transcript).not.toContain(SECRET);
    expect(transcript).toContain('helper done');
    expect(transcript).not.toContain('x'.repeat(3000));
    expect(json(path.join(lease.evidence, 'outputs.json'))).toEqual({ 'write#1': { done: true } });

    const prompt = read(lease.prompt);
    expect(prompt.indexOf('Judge the work.')).toBeLessThan(prompt.indexOf('UNTRUSTED'));
    expect(prompt).toContain('helper done');
    expect(prompt).toContain('+export const run = () => { for (let i = 0; i < 3; i++)');
  });

  it('reads nothing from the checkout once the run deadline passed, and says the change is missing', async () => {
    const { config, runId, checkout } = await scoredRun();
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(String(run));
    const dir = path.join(root, 'late-evidence');

    await collectEvidence(config, run, { runId, step: 'write', pass: 1 }, dir, { checkout, sessionCwd: checkout, expiresAt: new Date(Date.now() - 1000).toISOString() });

    expect(fs.existsSync(path.join(dir, 'diff.patch'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'repo'))).toEqual([]);
    expect(json(path.join(dir, 'evidence.json'))).toMatchObject({ gaps: ['commit_missing'] });
  });

  it('redacts every file it writes, and leaves out a file it cannot read as text and says which', async () => {
    const { config } = await scoredRun('external', { 'service.config': `api_key=${SECRET}\n`, 'logo.png': Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]) });

    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);

    const files = fs.readdirSync(lease.evidence, { recursive: true, encoding: 'utf8' }).filter((name) => fs.statSync(path.join(lease.evidence, name)).isFile());
    expect(files).toContain(path.join('repo', 'service.config'));
    expect(files.filter((name) => read(path.join(lease.evidence, name)).includes(SECRET))).toEqual([]);
    expect(fs.existsSync(path.join(lease.evidence, 'repo', 'logo.png'))).toBe(false);
    expect(json(path.join(lease.evidence, 'evidence.json'))).toMatchObject({ gaps: ['files_omitted'], omitted: ['repo/logo.png'] });
  });

  it('masks the value of a secret the team declares, whatever its name', async () => {
    const dsn = 'mysql-prod-7Hq2xVb9Lk';
    const { config, checkout } = await scoredRun('external', { 'deploy.env': `WAREHOUSE=${dsn}\n` });
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: WAREHOUSE_DSN\n');
    vi.stubEnv('WAREHOUSE_DSN', dsn);
    plantSession(checkout, 'session-write', `Add retries against ${dsn}.`);

    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);

    const files = fs.readdirSync(lease.evidence, { recursive: true, encoding: 'utf8' }).filter((name) => fs.statSync(path.join(lease.evidence, name)).isFile());
    expect(files.filter((name) => read(path.join(lease.evidence, name)).includes(dsn))).toEqual([]);
    expect(read(path.join(lease.evidence, 'repo', 'deploy.env'))).toContain('WAREHOUSE_DSN');
    expect(read(path.join(lease.evidence, 'transcripts', 'write#1.md'))).toContain('Add retries against');
  });

  it('masks a secret the team declares in the scorer\'s prompt as well', async () => {
    const dsn = 'mysql-prod-7Hq2xVb9Lk';
    const { config } = await scoredRun('external', {}, SCORER.replace('Judge the work.', `Judge the work. Fail any change that connects with ${dsn}.`));
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: WAREHOUSE_DSN\n');
    vi.stubEnv('WAREHOUSE_DSN', dsn);

    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);

    const prompt = read(lease.prompt);
    expect(prompt).toContain('Fail any change that connects with');
    expect(prompt).not.toContain(dsn);
  });

  it('masks both the environment value of a secret and the different value the team gives it', async () => {
    const personal = 'personal-token-value-1362';
    const team = 'team-token-value-1362';
    const { config, checkout } = await scoredRun('external', { 'deploy.env': `DEPLOY_HOOK=${team}\n` });
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { 'recursive': true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n - key: DEPLOY_HOOK\n');
    await writeSecretStore(getTeamSecretsPath(config), { DEPLOY_HOOK: { value: team } });
    vi.stubEnv('DEPLOY_HOOK', personal);
    plantSession(checkout, 'session-write', `Push with ${personal}`);

    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);

    const files = fs.readdirSync(lease.evidence, { recursive: true, encoding: 'utf8' }).filter((name) => fs.statSync(path.join(lease.evidence, name)).isFile());
    expect(files.filter((name) => [personal, team].some((value) => read(path.join(lease.evidence, name)).includes(value)))).toEqual([]);
    expect(read(path.join(lease.evidence, 'transcripts', 'write#1.md'))).toContain('Push with');
  });

  it('reads the transcript of a pass the local driver ran in its own worktree', async () => {
    const { config, runId } = await scoredRun('local');

    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);

    expect(json(path.join(lease.evidence, 'evidence.json'))).toMatchObject({ subject: { runId, step: 'write', pass: 1 }, gaps: [] });
    const transcript = read(path.join(lease.evidence, 'transcripts', 'write#1.md'));
    expect(transcript).toContain('Add retries.');
    expect(transcript).toContain('helper done');
  });

  it('says so when a subagent record does not show where its own work starts', async () => {
    const { config, runId } = await scoredRun();
    const find = AgentSession.find;
    vi.spyOn(AgentSession, 'find').mockImplementation(async (ref, options) => {
      const found = await find(ref, options);
      if (found.status !== 'done' || found.subagents?.status !== 'read') return found;
      return { ...found, subagents: { status: 'read', agents: found.subagents.agents.map((agent) => ({ ...agent, start: 'unknown' as const })) } };
    });

    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);

    expect(json(path.join(lease.evidence, 'evidence.json'))).toMatchObject({ subject: { runId, step: 'write' }, gaps: ['subagent_boundary_unknown'] });
    expect(read(path.join(lease.evidence, 'transcripts', 'write#1.md'))).toContain('helper done');
  });

  it('says so when a pass recorded no range, and gathers a workflow pass from its children', async () => {
    const { config, runId } = await scoredRun();
    await settle(config, LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease));

    const review = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);
    expect(json(path.join(review.evidence, 'evidence.json'))).toEqual({
      subject: { runId, step: 'review', pass: 1 }, kind: 'prompt', ranges: [], gaps: ['no_recorded_range'],
    });
    expect(fs.existsSync(path.join(review.evidence, 'diff.patch'))).toBe(false);
    expect(read(path.join(review.evidence, 'transcripts', 'review#1.md'))).toContain('session-review prompt');
    await settle(config, review);

    const check = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);
    expect(json(path.join(check.evidence, 'evidence.json'))).toMatchObject({ subject: { step: 'check' }, kind: 'workflow', gaps: ['no_recorded_range'] });
    expect(read(path.join(check.evidence, 'transcripts', 'check.look#1.md'))).toContain('session-look prompt');
  });

  it('hands back the evidence it built, and removes it once the lease is settled or lapsed', async () => {
    const { config } = await scoredRun();
    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request, '2026-10-22T12:00:00.000Z')).lease);
    fs.writeFileSync(path.join(lease.evidence, 'marker'), 'kept');

    const back = LeaseSchema.parse(data(await nextJudgeLease(config, request, '2026-10-22T12:01:00.000Z')).lease);
    expect(back).toMatchObject({ ref: lease.ref, handedBack: true, evidence: lease.evidence });
    expect(read(path.join(lease.evidence, 'marker'))).toBe('kept');

    const other = { ...request, driver: { ...judge, machine: 'm2' } };
    const next = LeaseSchema.parse(data(await nextJudgeLease(config, other, '2026-10-22T13:00:00.000Z')).lease);
    expect(fs.existsSync(lease.evidence)).toBe(false);
    data(await submitJudgeLease(config, next.ref, { driver: other.driver, outcome: 'success', answer: { label: 'good', reasoning: 'ok' }, judge: { tool: 'claude' } }));
    expect(fs.existsSync(next.evidence)).toBe(false);
  });

  it('keeps the head and the tail of evidence too long for one prompt, and says what it cut', async () => {
    const { config, checkout } = await scoredRun();
    const huge = Array.from({ length: 4000 }, (_, n) => `line ${n} ${'y'.repeat(80)}`).join('\n');
    plantSession(checkout, 'session-write', `HEAD-MARK\n${huge}\nTAIL-MARK`);

    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);
    const prompt = read(lease.prompt);

    expect(prompt.length).toBeLessThan(210_000);
    expect(prompt).toContain('HEAD-MARK');
    expect(prompt).toMatch(/characters? of evidence (were )?cut/);
  });
});

const SHIP = `schemaVersion: v1alpha1
name: ship-issue
description: Read an issue, then deliver the change it asks for.
inputs: { issue: number }
steps:
  - id: read-issue
    prompt: Read issue {{ inputs.issue }} and return its title and body.
    output: { title: string, body: string }
  - id: change
    needs: [read-issue]
    prompt: Make the change the issue asks for.
    workspace: new
    deliver: pr
    scorers: [quality]
`;

function writeAll(dir: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
}

/** A run of SHIP whose `change` step delivered a pagination commit, with the issue's text as `read-issue` returned it. */
async function deliveredRun(
  scorer = SCORER, files: { base?: Record<string, string>; change?: Record<string, string>; session?: string } = {},
): Promise<{ config: LocalConfig; runId: string; checkout: string }> {
  const checkout = path.join(root, 'app');
  fs.mkdirSync(checkout, { recursive: true });
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.email', 't@example.com');
  git(checkout, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(checkout, 'users.ts'), 'export const users = () => all();\n');
  writeAll(checkout, files.base ?? {});
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-qm', 'base');
  const from = git(checkout, 'rev-parse', 'HEAD');
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'workflows', 'ship-issue.yaml'), SHIP);
  fs.writeFileSync(path.join(knowledge, 'scorers', 'quality.md'), scorer);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: checkout, dataHome: path.join(root, 'data'),
  };
  await syncWorkflowDefinitions(config);
  const runId = String(data(await startRun(config, 'ship-issue', { issue: 42 }, { secrets: await knownSecrets(config), base: { ref: 'main', commit: from }, checkout })).run);
  const can: Omit<NextOptions, 'env'> = { can: { workspace: ['new', 'continue', 'read-only'] } };
  const issue = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, runId, external, can)).lease);
  data(await reportAttempt(config, runId, {
    attempt: issue.attempt, revision: issue.revision, outcome: 'success', driver: external, outputs: { title: 'Paginate /users', body: 'Add pagination to /users' },
  }));
  const change = z.object({ attempt: z.string(), revision: z.number(), workspace: z.object({ branch: z.string() }) }).parse(data(await leaseNext(config, runId, external, can)).lease);
  git(checkout, 'checkout', '-q', '-B', change.workspace.branch, from);
  fs.writeFileSync(path.join(checkout, 'users.ts'), 'export const users = (page = 1) => all().slice((page - 1) * 50, page * 50);\n');
  writeAll(checkout, files.change ?? {});
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-qm', 'paginate');
  const to = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', 'main');
  data(await reportAttempt(config, runId, {
    attempt: change.attempt, revision: change.revision, outcome: 'success', driver: external, ...(files.session ? { tool: 'claude', session: files.session } : {}),
    outputs: { summary: 'paginated' }, changes: { branch: change.workspace.branch, base: from, from, to, commits: [to] },
  }));
  return { config, runId, checkout };
}

/** The scorer of #1247's example: a red CI or a failed check gives `partial`, its best label below `passingScore`. */
const DELIVERED = `---
labels:
  - { value: complete, score: 1, description: Delivers what was asked and nothing else. }
  - { value: partial, score: 0.5, description: Delivers part of what was asked. }
  - { value: off-target, score: 0, description: Delivers something other than what was asked. }
passingScore: 1
samplingRate: 100
---
Judge whether the pull request delivers what the issue asked, and only that.
`;

/** Rewrites the `change` step of run `runId` as `rewrite` leaves it, and the run as `around` does. */
async function rewriteChange(config: LocalConfig, runId: string, rewrite: (step: StepState) => StepState, around: (run: RunState) => RunState = (run) => run): Promise<void> {
  await updateRun(config, runId, await knownSecrets(config), async (run) => (run === 'missing' ? { value: undefined }
    : { value: undefined, write: around({ ...run, steps: run.steps.map((step) => (step.id === 'change' ? rewrite(step) : step)) }) }));
}

const PR = PrUrlSchema.parse('https://github.com/acme/app/pull/57');

/** Settles `change` as delivered in pull request PR, from a checkout whose origin is on GitHub. */
async function deliverChange(config: LocalConfig, runId: string, checkout: string): Promise<void> {
  git(checkout, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  await rewriteChange(config, runId, (step) => (step.status !== 'delivering' ? step : { ...step, status: 'succeeded', outcome: 'success' }), (run) => {
    const change = run.steps.find((step) => step.id === 'change');
    const branch = change && 'delivery' in change ? change.delivery?.branch ?? 'missing' : 'missing';
    return { ...run, deliveries: [{ url: PR, branch, base: 'main', step: 'change', pass: 1 }] };
  });
}

describe('evidence of what a run delivered', () => {
  it('holds the run\'s inputs and the outputs every step reported, as the run stored them', async () => {
    const { config } = await deliveredRun();

    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);

    expect(lease.subject.step).toBe('change');
    expect(json(path.join(lease.evidence, 'inputs.json'))).toEqual({ issue: 42 });
    expect(json(path.join(lease.evidence, 'outputs.json'))).toEqual({
      'read-issue#1': { title: 'Paginate /users', body: 'Add pagination to /users' },
      'change#1': { summary: 'paginated' },
    });
    expect(read(lease.prompt)).toContain('Add pagination to /users');
  });

  it('labels the delivered pass as decided by the judge, with the hash of its evidence, unchanged when it is scored again', async () => {
    const { config, runId, checkout } = await deliveredRun();
    await settle(config, LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease));
    const [first] = await LabelStore.local(config);
    // The issue is edited and main moves on after delivery: neither is evidence of the run.
    fs.writeFileSync(path.join(checkout, 'users.ts'), 'export const users = (page = 1, filter = "") => all();\n');
    git(checkout, 'commit', '-qam', 'filters on main');

    data(await scoreOnDemand(config, { run: runId, step: 'change', scorers: ['quality'], queue: true }));
    await settle(config, LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease));

    const [second] = await LabelStore.local(config);
    expect(first).toMatchObject({ subject: { runId, step: 'change', pass: 1 }, decidedBy: 'judge', evidenceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(second?.scoredAt).not.toBe(first?.scoredAt);
    expect(second).toMatchObject({ evidenceHash: first && 'evidenceHash' in first ? first.evidenceHash : 'missing' });
  });

  it('gives a pass whose delivery changed protected paths the best label below passing, decided by protected, with no judge', async () => {
    const { config, runId } = await deliveredRun(DELIVERED);
    await rewriteChange(config, runId, (step) => (step.status !== 'delivering' ? step : {
      ...step, status: 'failed', outcome: 'failed',
      failure: { code: 'protected_path', message: 'Step "change" changed protected paths against the run base: .github/workflows/ci.yml.' },
    }));

    const answer = data(await nextJudgeLease(config, request));

    expect(answer).not.toHaveProperty('lease');
    expect(answer.decided).toEqual([expect.objectContaining({ scorer: 'quality', subject: { runId, step: 'change', pass: 1 }, label: 'partial', passed: false, decidedBy: 'protected' })]);
    const [label] = await LabelStore.local(config);
    expect(label).toMatchObject({ label: 'partial', score: 0.5, passed: false, decidedBy: 'protected', judge: { kind: 'model', tool: 'claude' }, evidenceHash: expect.stringMatching(/^sha256:/) });
    expect(label?.judge).not.toHaveProperty('usage');
  });

  it('shows on the run\'s page what decided the label of the delivered pass, and counts no judge call for it', async () => {
    const { config, runId } = await deliveredRun(DELIVERED);
    await rewriteChange(config, runId, (step) => (step.status !== 'delivering' ? step : {
      ...step, status: 'failed', outcome: 'failed', failure: { code: 'protected_path', message: 'Step "change" changed protected paths against the run base: AGENTS.md.' },
    }));
    data(await nextJudgeLease(config, request));

    const detail = await workflowRunDetail(config, 'local', runId);

    expect(detail?.steps.find((step) => step.step === 'change')?.scores).toEqual([{ scorer: 'quality', label: 'partial', passed: false, decidedBy: 'protected' }]);
    expect(detail?.scoring).toEqual({ judged: 0, inputTokens: 0, outputTokens: 0 });
  });

  it('gives a delivered pull request whose CI failed the best label below passing, decided by ci, with no judge', async () => {
    const { config, runId, checkout } = await deliveredRun(DELIVERED);
    await deliverChange(config, runId, checkout);
    const gh = fakeGh(path.join(root, 'gh'), { checks: { runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }] } });

    const answer = data(await nextJudgeLease(config, request));

    expect(answer).not.toHaveProperty('lease');
    expect(answer.decided).toEqual([expect.objectContaining({ subject: { runId, step: 'change', pass: 1 }, label: 'partial', decidedBy: 'ci' })]);
    expect(await LabelStore.local(config)).toMatchObject([{ label: 'partial', passed: false, decidedBy: 'ci', judge: { kind: 'model', tool: 'claude' } }]);
    const after = await readRun(config, runId);
    const change = typeof after === 'object' ? after.steps.find((step) => step.id === 'change') : undefined;
    const delivered = change && 'delivery' in change ? change.delivery?.head : undefined;
    expect(gh.calls().map((call) => call.args[1])).toContain(`repos/acme/app/commits/${delivered}/check-runs?per_page=100`);
  });

  /** A check that passes when users.ts holds `word`, as the base commit's test/users.cjs reads it. */
  const checked = (word: string) => ({
    scorer: DELIVERED.replace('passingScore: 1', "passingScore: 1\ncheck: { run: node test/users.cjs, protect: ['test/**'] }"),
    base: { 'test/users.cjs': `process.exit(require('fs').readFileSync('users.ts', 'utf8').includes('${word}') ? 0 : 1);\n` },
  });

  it('runs the scorer\'s check on the delivered commit with the protected paths put back, and a failed check decides', async () => {
    const { scorer, base } = checked('limit');
    // The agent made its own copy of the test pass; the check runs the base commit's.
    const { config } = await deliveredRun(scorer, { base, change: { 'test/users.cjs': 'process.exit(0);\n' } });

    const answer = data(await nextJudgeLease(config, request));

    expect(answer).not.toHaveProperty('lease');
    expect(answer.decided).toEqual([expect.objectContaining({ label: 'partial', decidedBy: 'check' })]);
    expect(await LabelStore.local(config)).toMatchObject([{ label: 'partial', passed: false, decidedBy: 'check' }]);
  });

  it('hands the delivered pass to the judge once the scorer\'s check passes', async () => {
    const { scorer, base } = checked('page');
    const { config } = await deliveredRun(scorer, { base });

    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);

    expect(lease.subject).toMatchObject({ step: 'change' });
    expect(await LabelStore.local(config)).toEqual([]);
  });

  it('hands a pass that delivered no commit to the judge, since the scorer\'s check has nothing of it to run on', async () => {
    const { scorer, base } = checked('limit');
    const { config, runId } = await deliveredRun(scorer, { base });
    // The agent changed nothing, so the step succeeded with no delivery.
    await rewriteChange(config, runId, (step) => {
      if (step.status !== 'delivering') return step;
      const { delivery: _, ...rest } = step;
      return { ...rest, status: 'succeeded', outcome: 'success' };
    });

    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);

    expect(lease.subject).toMatchObject({ step: 'change' });
    expect(await LabelStore.local(config)).toEqual([]);
  });

  it('settles the entry unscored, with no judge and no label, when the scorer\'s check cannot run', async () => {
    const scorer = DELIVERED.replace('passingScore: 1', "passingScore: 1\ncheck: { run: teamai-no-such-check-1247, protect: ['test/**'] }");
    const { config } = await deliveredRun(scorer);

    const answer = data(await nextJudgeLease(config, request));

    expect(answer).not.toHaveProperty('lease');
    expect(answer.closed).toEqual([expect.objectContaining({ code: 'check_could_not_run' })]);
    expect(await LabelStore.local(config)).toEqual([]);
    expect(data(await nextJudgeLease(config, request))).toMatchObject({ idle: { open: 0 } });
  });

  it('gives two passes that delivered two pull requests a label each, told apart by subject.pass', async () => {
    const { config, runId, checkout } = await deliveredRun(DELIVERED);
    await deliverChange(config, runId, checkout);
    // A loop ran `change` again: its first pass is kept in passes, and the second delivered pull request 58.
    await rewriteChange(config, runId, (step) => {
      if (step.status !== 'succeeded' || !step.delivery || !step.changes) return step;
      const first = { pass: 1, outcome: 'success' as const, changes: step.changes, delivery: step.delivery };
      return { ...step, pass: 2, passes: [first], delivery: { ...step.delivery, branch: `${step.delivery.branch}-2` } };
    }, (run) => ({ ...run, deliveries: [...run.deliveries ?? [], { url: PrUrlSchema.parse('https://github.com/acme/app/pull/58'), branch: 'p2', base: 'main', step: 'change', pass: 2 }] }));
    fakeGh(path.join(root, 'gh'), { checks: { runs: [{ status: 'completed', conclusion: 'failure' }] } });

    const answer = data(await nextJudgeLease(config, request));

    expect(answer.decided).toEqual([
      expect.objectContaining({ subject: { runId, step: 'change', pass: 1 }, decidedBy: 'ci' }),
      expect.objectContaining({ subject: { runId, step: 'change', pass: 2 }, decidedBy: 'ci' }),
    ]);
    expect((await LabelStore.local(config)).map((label) => label.subject)).toEqual([{ runId, step: 'change', pass: 1 }, { runId, step: 'change', pass: 2 }]);
  });

  it('hands a delivered pull request whose CI is still running to the judge, as one with no CI', async () => {
    const { config, runId, checkout } = await deliveredRun(DELIVERED);
    await deliverChange(config, runId, checkout);
    fakeGh(path.join(root, 'gh'), { checks: { runs: [{ status: 'in_progress', conclusion: null }] } });

    const lease = LeaseSchema.parse(data(await nextJudgeLease(config, request)).lease);

    expect(lease.subject).toMatchObject({ step: 'change' });
    expect(await LabelStore.local(config)).toEqual([]);
  });
});

describe('scoring what a run delivered on demand', () => {
  /** A claude on PATH that judges every pass `complete`. */
  function fakeClaude(): void {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'result', structured_output: { label: 'complete', reasoning: 'delivers the pagination' } }));
});\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
  }
  const unsampled = DELIVERED.replace('samplingRate: 100', 'samplingRate: 0');

  it('scores the delivering pass with only --run and --scorer, whatever sampling says', async () => {
    const { config, runId } = await deliveredRun(unsampled);
    fakeClaude();
    expect(data(await nextJudgeLease(config, request))).toMatchObject({ idle: { open: 0 } });

    expect(data(await scoreOnDemand(config, { run: runId, scorers: ['quality'] }))).toMatchObject({
      label: { scorer: 'quality', subject: { runId, step: 'change', pass: 1 }, label: 'complete', passed: true, decidedBy: 'judge' },
    });
    expect(await LabelStore.local(config)).toMatchObject([{ subject: { runId, step: 'change', pass: 1 }, decidedBy: 'judge', evidenceHash: expect.stringMatching(/^sha256:/) }]);
  });

  it('asks for --step when the run lists the scorer on no step', async () => {
    const { config, runId } = await deliveredRun(unsampled);
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'tests.md'), unsampled);
    await syncWorkflowDefinitions(config);
    fakeClaude();

    expect(await scoreOnDemand(config, { run: runId, scorers: ['tests'] })).toEqual({ error: {
      code: 'step_not_found',
      message: `Run ${runId} lists scorer tests on no step. Pass --step <path> to pick one: read-issue, change.`,
    } });
  });

  it('asks for --step when the workflow lists the scorer on two steps, though only one of them succeeded', async () => {
    const { config, runId } = await deliveredRun(unsampled);
    const scorers = { names: ['quality'] };
    await updateRun(config, runId, await knownSecrets(config), async (run) => (run === 'missing' ? { value: undefined } : { value: undefined, write: {
      ...run,
      definition: { ...run.definition, steps: run.definition.steps.map((step) => (step.id === 'read-issue' ? { ...step, scorers } : step)) },
      steps: run.steps.map((step): StepState => (step.id === 'read-issue' && step.status === 'succeeded' ? { ...step, status: 'failed', outcome: 'failed', failure: { code: 'tool_failed', message: 'The issue could not be read.' } } : step)),
    } }));
    fakeClaude();

    expect(await scoreOnDemand(config, { run: runId, scorers: ['quality'] })).toEqual({ error: {
      code: 'step_ambiguous',
      message: `Run ${runId} lists scorer quality on steps read-issue, change. Pass --step <path> to pick one.`,
    } });
  });

  it('asks for --step when the workflow lists the scorer on a second step that never ran', async () => {
    const { config, runId } = await deliveredRun(unsampled);
    const scorers = { names: ['quality'] };
    await updateRun(config, runId, await knownSecrets(config), async (run) => (run === 'missing' ? { value: undefined } : { value: undefined, write: {
      ...run,
      definition: { ...run.definition, steps: [...run.definition.steps, { id: 'announce', needs: ['change'], prompt: 'Announce the change.', scorers }] },
      steps: [...run.steps, { id: 'announce', status: 'pending' as const }],
    } }));
    fakeClaude();

    expect(await scoreOnDemand(config, { run: runId, scorers: ['quality'] })).toEqual({ error: {
      code: 'step_ambiguous',
      message: `Run ${runId} lists scorer quality on steps change, announce. Pass --step <path> to pick one.`,
    } });
  });

  it('fails, names the session that is gone, and writes no label', async () => {
    const { config, runId } = await deliveredRun(unsampled, { session: 'session-change' });
    fakeClaude();

    expect(await scoreOnDemand(config, { run: runId, scorers: ['quality'] })).toEqual({ error: {
      code: 'evidence_missing',
      message: `Pass 1 of step change in run ${runId} cannot be scored: no longer on this machine: claude-code session session-change of change#1. Restore what is missing, or score another pass. No label was written.`,
    } });
    expect(await LabelStore.local(config)).toEqual([]);
  });

  it('fails, names the check that could not run, and writes no label', async () => {
    const scorer = unsampled.replace('passingScore: 1', "passingScore: 1\ncheck: { run: teamai-no-such-check-1247, protect: ['test/**'] }");
    const { config, runId } = await deliveredRun(scorer);
    fakeClaude();

    expect(await scoreOnDemand(config, { run: runId, scorers: ['quality'] })).toEqual({ error: {
      code: 'check_could_not_run',
      message: expect.stringMatching(/^The check of scorer quality, `teamai-no-such-check-1247`, could not run on commit [0-9a-f]{40} \(.+\)\. Fix the check, then run this command again\. No label was written\.$/),
    } });
    expect(await LabelStore.local(config)).toEqual([]);
  });

  it('still judges a second scorer when the first one\'s check cannot run, and says which label it kept', async () => {
    const scorer = unsampled.replace('passingScore: 1', "passingScore: 1\ncheck: { run: teamai-no-such-check-1247, protect: ['test/**'] }");
    const { config, runId } = await deliveredRun(scorer);
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'tests.md'), unsampled);
    await syncWorkflowDefinitions(config);
    fakeClaude();

    const answered = await scoreOnDemand(config, { run: runId, step: 'change', scorers: ['quality', 'tests'] });

    expect(answered).toEqual({ error: {
      code: 'check_could_not_run',
      message: expect.stringMatching(/^The check of scorer quality, .+ No label was written\. Kept the label of tests: complete\.$/),
      labels: [expect.objectContaining({ scorer: 'tests', label: 'complete', decidedBy: 'judge' })],
    } });
    expect(await LabelStore.local(config)).toEqual([expect.objectContaining({ scorer: 'tests', label: 'complete' })]);
    // No lease is left behind for another driver to wait out.
    expect(data(await nextJudgeLease(config, request))).toMatchObject({ idle: { open: 0, leased: 0 } });
  });
});

describe('subject evidence removal', () => {
  it('also removes what a collection stopped midway left beside the evidence', async () => {
    const scores = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-subject-evidence-'));
    const subject = { runId: 'r0123456789abcdef', step: 'trials.r1.t.a.prompt', pass: 1 };
    const other = subjectEvidenceDirOf(scores, { ...subject, pass: 2 });
    const dir = subjectEvidenceDirOf(scores, subject);
    for (const each of [dir, `${dir}.tmp-1-abcdef`, other]) fs.mkdirSync(each, { recursive: true });

    await removeSubjectEvidence(scores, [subject]);

    expect(fs.readdirSync(path.dirname(dir))).toEqual([path.basename(other)]);
    fs.rmSync(scores, { recursive: true, force: true });
  });
});
