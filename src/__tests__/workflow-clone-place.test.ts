/**
 * A clone place on an ordinary workflow: teamai prepares a fresh clone of the place's commit, with no remotes, for the
 * first step in it, every later step that continues it runs there, its commits stay in the clone, and the clone is gone
 * once the run ends.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { knownSecrets, resolveWorkflowEnv } from '../env-resolution.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { startRun } from '../workflow/engine.js';
import { claimRun } from '../workflow/handoff.js';
import { inProcessClient } from '../workflow/protocol.js';
import { buildEndRecord } from '../workflow/records.js';
import { retryStep } from '../workflow/run-controls.js';
import { nextJudgeLease } from '../workflow/scoring.js';
import { readRun, RunIdSchema } from '../workflow/store.js';
import type { DriverCan } from '../workflow/requirements.js';
import type { DriverIdentity } from '../workflow/types.js';
import { branchName } from '../workflow/workspace.js';
import { cloneHead } from '../workflow/place/place.js';

_setDriverPollMs(20);

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A checkout with two commits, a team repo holding `yaml(first commit)`, and a started run of it. */
async function fixture(yaml: (commit: string) => string, scorers: Record<string, string> = {}): Promise<{ config: LocalConfig; workspace: string; runId: string; first: string }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-clone-place-')));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(workspace);
  git(['init', '-q', '-b', 'main'], workspace);
  const commit = (file: string, text: string): string => {
    fs.writeFileSync(path.join(workspace, file), text);
    git(['add', file], workspace);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', file], workspace);
    return git(['rev-parse', 'HEAD'], workspace);
  };
  const first = commit('first.txt', 'one\n');
  commit('second.txt', 'two\n');
  git(['remote', 'add', 'origin', 'https://git.example.com/acme/app.git'], workspace);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: workspace,
    dataHome: path.join(root, 'data'),
    workflows: { tools: {}, max_parallel: 1 },
  };
  fs.writeFileSync(path.join(knowledge, 'workflows', 'build.yaml'), yaml(first));
  fs.mkdirSync(path.join(knowledge, 'scorers'));
  for (const [name, text] of Object.entries(scorers)) fs.writeFileSync(path.join(knowledge, 'scorers', `${name}.md`), text);
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config), checkout: workspace, base: { ref: 'main', commit: git(['rev-parse', 'HEAD'], workspace) } });
  if ('error' in started) throw new Error(started.error.message);
  return { config, workspace, runId: String(started.data.run), first };
}

/** A command that writes `file` in its cwd and prints where it ran: its cwd, HEAD, remotes, and the files it found. */
function probe(file: string): string {
  return `node -e "const { execFileSync } = require('child_process'); const fs = require('fs'); const g = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim(); const files = fs.readdirSync('.').filter((f) => f !== '.git').sort().join(','); fs.writeFileSync('${file}', 'x'); console.log(JSON.stringify({ cwd: process.cwd(), head: g('rev-parse', 'HEAD'), remotes: g('remote'), files }))"`;
}

const CLONED = (commit: string): string => `schemaVersion: v1alpha1
name: build
description: Work in a clean clone of the first commit.
steps:
  - id: trial
    workspace: { clone: { commit: ${commit}, team: { treatment: none } } }
    workflow:
      steps:
        - id: work
          workspace: continue
          command: ${JSON.stringify(probe('made.txt'))}
          output: { cwd: string, head: string, remotes: string, files: string }
        - id: check
          needs: [work]
          workspace: continue
          command: ${JSON.stringify(probe('checked.txt'))}
          output: { cwd: string, head: string, remotes: string, files: string }
`;

describe('a clone place', () => {
  it('runs every step that continues it in one fresh clone of its commit, with no remotes, and removes the clone once the run ends', async () => {
    const { config, workspace, runId, first } = await fixture(CLONED);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const work = run.steps.find((step) => step.id === 'trial.work');
    const check = run.steps.find((step) => step.id === 'trial.check');
    const worked = work && 'outputs' in work ? work.outputs : undefined;
    const checked = check && 'outputs' in check ? check.outputs : undefined;
    expect(worked).toMatchObject({ head: first, remotes: '', files: 'first.txt' });
    expect(checked).toMatchObject({ cwd: (worked as { cwd: string }).cwd, remotes: '', files: 'first.txt,made.txt' });
    expect(String((worked as { cwd: string }).cwd).startsWith(workspace)).toBe(false);
    const branch = branchName(runId, 'trial', 1);
    expect(work && 'changes' in work ? work.changes : undefined).toMatchObject({ branch, base: first, from: first, commits: [expect.any(String)] });
    expect(run.copies?.[branch]).toMatchObject({ kind: 'clone' });
    expect(fs.existsSync(String((worked as { cwd: string }).cwd))).toBe(false);
    expect(git(['status', '--porcelain'], workspace)).toBe('');
    expect(git(['branch', '--list', 'teamai/*'], workspace)).toBe('');
  });

  it('isolates a run that opens a clone: it is not retried or claimed, and its record says it is isolated', async () => {
    const { config, workspace, runId } = await fixture(CLONED);
    await runLocalDriver(config, runId, workspace);

    const retried = await retryStep(config, runId, await knownSecrets(config), 'trial.work');
    const claimed = await claimRun(config, runId, { checkout: workspace });
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');

    expect(retried).toMatchObject({ error: { code: 'not_retryable', message: expect.stringContaining(`Run ${runId} is isolated`) } });
    expect(claimed).toMatchObject({ ok: false, error: { code: 'isolated_run', message: expect.stringContaining(`Run ${runId} is isolated`) } });
    expect(buildEndRecord(run, run.driver, '')).toMatchObject({ isolated: true });
  });

  it('sets a fresh clone up before its first step, and gives the step that continues it the clone as the first left it', async () => {
    const { config, runId } = await fixture((commit) => PROMPTED(commit, 'setup:\n  command: touch "$(git rev-parse --git-path setup-ran)"\n'));
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });

    const work = leaseOf(await prepared(client, runId));
    const setUp = fs.existsSync(path.join(work.cwd, '.git', 'setup-ran'));
    fs.writeFileSync(path.join(work.cwd, 'made.txt'), 'M');
    await client.report(runId, { attempt: work.attempt, revision: work.revision, outcome: 'success', driver });
    const check = leaseOf(await prepared(client, runId));

    expect(setUp).toBe(true);
    expect(check).toMatchObject({ step: 'trial.check', cwd: work.cwd });
    expect(fs.readFileSync(path.join(check.cwd, 'made.txt'), 'utf8')).toBe('M');
  });

  it('gives an attempt prepared again a fresh clone, and removes the one it had', async () => {
    const { config, runId } = await fixture((commit) => PROMPTED(commit));
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });

    const first = leaseOf(await prepared(client, runId));
    fs.writeFileSync(path.join(first.cwd, 'left.txt'), 'L');
    const again = leaseOf(await prepared(client, runId));

    expect(again.attempt).toBe(first.attempt);
    expect(again.cwd).not.toBe(first.cwd);
    expect(fs.existsSync(first.cwd)).toBe(false);
    expect(fs.readdirSync(again.cwd).sort()).toEqual(['.git', 'first.txt']);
  });

  it('holds a step in a clone from a driver that provides no clones', async () => {
    const { config, runId } = await fixture((commit) => PROMPTED(commit));
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });

    const answer = await client.next(runId, { driver: { ...driver, can: { ...can, workspace: ['read-only', 'new', 'continue'] } }, running: [] }, { prepare: true });

    expect(answer).toMatchObject({ data: { wait: { held: [{ step: 'trial.work', missing: ['workspace.clone'] }] } } });
  });

  it('fails a read-only step inside a clone, as a clone has no reader place', async () => {
    const { config, runId } = await fixture((commit) => PROMPTED(commit).replace('workspace: continue\n          prompt: Make a file.', 'workspace: read-only\n          prompt: Make a file.'));
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });

    await prepared(client, runId);
    const run = await readRun(config, runId);

    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'trial.work')).toMatchObject({ status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining('runs read-only inside a clone') } });
  });

  it('removes the clone a driver releases, and leases the step again in a fresh one', async () => {
    const { config, runId } = await fixture((commit) => PROMPTED(commit));
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
    const first = leaseOf(await prepared(client, runId));
    fs.writeFileSync(path.join(first.cwd, 'left.txt'), 'L');

    const released = await client.report(runId, { attempt: first.attempt, revision: first.revision, outcome: 'released', driver });
    const again = leaseOf(await prepared(client, runId));

    expect(released).not.toHaveProperty('error');
    expect(fs.existsSync(first.cwd)).toBe(false);
    expect(again).toMatchObject({ step: 'trial.work' });
    expect(fs.readdirSync(again.cwd).sort()).toEqual(['.git', 'first.txt']);
  });

  it('keeps the clone when a step that continues it is released, with the work committed there', async () => {
    const { config, runId } = await fixture((commit) => PROMPTED(commit));
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
    const work = leaseOf(await prepared(client, runId));
    fs.writeFileSync(path.join(work.cwd, 'made.txt'), 'M');
    await client.report(runId, { attempt: work.attempt, revision: work.revision, outcome: 'success', driver });
    const check = leaseOf(await prepared(client, runId));

    await client.report(runId, { attempt: check.attempt, revision: check.revision, outcome: 'released', driver });
    const again = leaseOf(await prepared(client, runId));

    expect(again).toMatchObject({ step: 'trial.check', cwd: work.cwd });
    expect(fs.readFileSync(path.join(again.cwd, 'made.txt'), 'utf8')).toBe('M');
  });

  it('turns git hooks off in a fresh clone, pointing them at a directory that does not exist', async () => {
    const { config, runId } = await fixture((commit) => PROMPTED(commit));
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });

    const work = leaseOf(await prepared(client, runId));
    const hooks = git(['config', '--get', 'core.hooksPath'], work.cwd);

    expect(hooks).not.toBe('');
    expect(fs.existsSync(path.resolve(work.cwd, hooks))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('starts no git in a strictly sandboxed clone with a credential the sandbox withholds', async () => {
    const { config, runId } = await fixture((commit) => PROMPTED(commit).replace('team: { treatment: none } } }', 'team: { treatment: none } } }\n    requires: { isolation: sandbox, strict: true }'));
    const bin = path.join(path.dirname(config.repo.localPath), 'bin');
    const seen = path.join(path.dirname(config.repo.localPath), 'git-seen.txt');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$(pwd) \${GH_TOKEN:-none}" >> ${JSON.stringify(seen)}\nexec ${JSON.stringify(execFileSync('which', ['git'], { encoding: 'utf8' }).trim())} "$@"\n`, { mode: 0o755 });
    vi.stubEnv('GH_TOKEN', 'withheld-token');
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });

    leaseOf(await client.next(runId, { driver: { ...driver, can: { ...can, env: true } }, running: [] }, { prepare: true }));
    const inClone = fs.readFileSync(seen, 'utf8').split('\n').filter((line) => line.includes('teamai-clones'));

    expect(inClone.length).toBeGreaterThan(0);
    expect(inClone.filter((line) => line.includes('withheld-token'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('stops reading the head of a clone at its deadline when git there never returns', async () => {
    const { config, runId } = await fixture((commit) => PROMPTED(commit));
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
    const { branch } = z.object({ data: z.object({ lease: z.object({ workspace: z.object({ branch: z.string() }) }) }) }).parse(await prepared(client, runId)).data.lease.workspace;
    const bin = path.join(path.dirname(config.repo.localPath), 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = status ] && exec sleep 30; done\nexec ${JSON.stringify(execFileSync('which', ['git'], { encoding: 'utf8' }).trim())} "$@"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const started = Date.now();

    const head = await cloneHead(config, RunIdSchema.parse(runId), branch, new Date(started + 500).toISOString());

    expect(head).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('fails the step whose clone is of a commit no source has, and leaves no clone', async () => {
    const { config, runId } = await fixture(() => PROMPTED('f'.repeat(40)));
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });

    const answer = await prepared(client, runId);
    const run = await readRun(config, runId);

    expect(answer).toMatchObject({ error: { code: 'clone_prepare_failed', message: expect.stringContaining('f'.repeat(40)) } });
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'trial.work')).toMatchObject({ status: 'failed', failure: { code: 'clone_prepare_failed' } });
    expect(fs.existsSync(path.join(config.dataHome ?? '', 'workflows', 'runs', runId, 'clones'))
      ? fs.readdirSync(path.join(config.dataHome ?? '', 'workflows', 'runs', runId, 'clones')) : []).toEqual([]);
  });

  it('fails a step that continues work committed in a clone that is gone, rather than run it in a fresh one', async () => {
    const { config, runId } = await fixture((commit) => PROMPTED(commit));
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
    const work = leaseOf(await prepared(client, runId));
    fs.writeFileSync(path.join(work.cwd, 'made.txt'), 'M');
    await client.report(runId, { attempt: work.attempt, revision: work.revision, outcome: 'success', driver });
    fs.rmSync(path.dirname(work.cwd), { recursive: true, force: true });

    const answer = await prepared(client, runId);

    expect(answer).toMatchObject({ error: { code: 'workspace_base', message: expect.stringContaining('is gone, so step "trial.check" cannot continue the work committed there') } });
  });

  it('gives the judges of a prompt in a clone the work it committed there, after the clone is gone', async () => {
    const { runId, first, evidence, patch } = await judgedAfterClone(SCORED('work'));

    expect(evidence).toMatchObject({ subject: { runId, step: 'trial.work', pass: 1 }, kind: 'prompt', ranges: [{ step: 'trial.work', pass: 1, from: first }] });
    expect(patch).toContain('+made in the clone');
  });

  it('gives the judges of the workflow step that opened a clone the work its steps committed there, after the clone is gone', async () => {
    const { runId, first, evidence, patch } = await judgedAfterClone(SCORED('trial'));

    expect(evidence).toMatchObject({ subject: { runId, step: 'trial', pass: 1 }, kind: 'workflow', ranges: [{ step: 'trial', pass: 1, from: first }, { step: 'trial.work', pass: 1, from: first }] });
    expect(patch).toContain('+made in the clone');
  });

  it('stages the evidence of a scored workflow step in a clone in the next that settles it, before its dependent is leased', async () => {
    const { config, runId } = await fixture(SCORED_THEN_AFTER, { quality: SCORER });
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
    const work = leaseOf(await prepared(client, runId));
    fs.writeFileSync(path.join(work.cwd, 'made.txt'), 'made in the clone\n');
    await client.report(runId, { attempt: work.attempt, revision: work.revision, outcome: 'success', driver });

    // A plain next, which sweeps no clone: the one that settles `trial` and leases `after`.
    const after = await client.next(runId, { driver: { ...driver, can }, running: [] });
    const judged = z.object({ data: z.object({ lease: z.object({ evidence: z.string() }) }) })
      .parse(await nextJudgeLease(config, { driver: { kind: 't3', machine: 'm1', workspace: '/w' }, judge: { isolation: 'verified', tools: ['claude'] }, running: [] })).data.lease;

    expect(after).toMatchObject({ data: { lease: { step: 'after' } } });
    expect(fs.readFileSync(path.join(judged.evidence, 'diff.patch'), 'utf8')).toContain('+made in the clone');
  });
});

/** A scored workflow step that opens a clone, holding one prompt, and a prompt after it outside the clone. */
const SCORED_THEN_AFTER = (commit: string): string => `schemaVersion: v1alpha1
name: build
description: Judge work done in a clean clone, then go on.
steps:
  - id: trial
    workspace: { clone: { commit: ${commit}, team: { treatment: none } } }
    scorers: [quality]
    workflow:
      steps:
        - id: work
          workspace: continue
          prompt: Make a file.
  - id: after
    needs: [trial]
    workspace: read-only
    prompt: Say it is done.
`;

/**
 * Runs `yaml` through next --prepare and report, as an external driver would, with its one prompt writing a file in the
 * clone; then the evidence the first judge lease gives, once the run ended and its clone is gone.
 */
async function judgedAfterClone(yaml: (commit: string) => string): Promise<{ runId: string; first: string; evidence: unknown; patch: string }> {
  const { config, runId, first } = await fixture(yaml, { quality: SCORER });
  const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
  const leased = z.object({ data: z.object({ lease: z.object({ attempt: z.string(), revision: z.number(), cwd: z.string() }) }) })
    .parse(await client.next(runId, { driver: { ...driver, can }, running: [] }, { prepare: true })).data.lease;
  fs.writeFileSync(path.join(leased.cwd, 'made.txt'), 'made in the clone\n');
  expect(await client.report(runId, { attempt: leased.attempt, revision: leased.revision, outcome: 'success', driver })).toMatchObject({ data: { step: { outcome: 'success' } } });
  expect(await client.next(runId, { driver: { ...driver, can }, running: [] }, { prepare: true })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  expect(fs.existsSync(leased.cwd)).toBe(false);
  const judged = z.object({ data: z.object({ lease: z.object({ evidence: z.string() }) }) })
    .parse(await nextJudgeLease(config, { driver: { kind: 't3', machine: 'm1', workspace: '/w' }, judge: { isolation: 'verified', tools: ['claude'] }, running: [] })).data.lease;
  return {
    runId, first,
    evidence: JSON.parse(fs.readFileSync(path.join(judged.evidence, 'evidence.json'), 'utf8')) as unknown,
    patch: fs.readFileSync(path.join(judged.evidence, 'diff.patch'), 'utf8'),
  };
}

const driver: DriverIdentity = { kind: 'external', machine: 'ci', workspace: '/work' };

/** `next --prepare` for `driver`, as an external driver that lets teamai prepare its places asks it. */
function prepared(client: ReturnType<typeof inProcessClient>, runId: string): ReturnType<ReturnType<typeof inProcessClient>['next']> {
  return client.next(runId, { driver: { ...driver, can }, running: [] }, { prepare: true });
}

const LeaseSchema = z.object({ data: z.object({ lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number(), cwd: z.string() }) }) });

function leaseOf(answer: unknown): z.infer<typeof LeaseSchema>['data']['lease'] {
  return LeaseSchema.parse(answer).data.lease;
}

/** A clone of `commit` holding two prompts, the second continuing the first; `head` goes before the steps. */
const PROMPTED = (commit: string, head = ''): string => `schemaVersion: v1alpha1
name: build
description: Two prompts in a clean clone.
${head}steps:
  - id: trial
    workspace: { clone: { commit: ${commit}, team: { treatment: none } } }
    workflow:
      steps:
        - id: work
          workspace: continue
          prompt: Make a file.
        - id: check
          needs: [work]
          workspace: continue
          prompt: Check the file.
`;
const can: DriverCan = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', tools: [], setup: true };

const SCORER = `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: missed, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 100
---
Judge the work.
`;

/** A clone holding one prompt, with the step `scored`, the prompt or the workflow step that opens the clone, judged. */
const SCORED = (scored: 'work' | 'trial') => (commit: string): string => `schemaVersion: v1alpha1
name: build
description: Judge work done in a clean clone of the first commit.
steps:
  - id: trial
    workspace: { clone: { commit: ${commit}, team: { treatment: none } } }
${scored === 'trial' ? '    scorers: [quality]\n' : ''}    workflow:
      steps:
        - id: work
          workspace: continue
          prompt: Make a file.
${scored === 'work' ? '          scorers: [quality]\n' : ''}`;
