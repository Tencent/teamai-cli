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
import { evidencePlan } from '../workflow/scoring-evidence.js';
import { readRun } from '../workflow/store.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import { AgentSession } from '../session-flow/agent-session.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { nextJudgeLease, submitJudgeLease, type JudgeRequest } from '../workflow/scoring.js';
import { branchName } from '../workflow/workspace.js';
import { worktreePath } from '../workflow/worktree.js';
import type { DriverIdentity, WorkflowEnvelope } from '../workflow/types.js';
import { knownSecrets } from '../env-resolution.js';

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
