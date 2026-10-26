import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkflowEnv } from '../env-resolution.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { DRIVERS_UNDER_TEST, inProcessConformanceClient, runConformanceScenario, type ConformanceClient } from '../workflow/conformance-interpreter.js';
import { PLACE_CHECKOUT_FILES, workflowPlaceConformanceScenarios } from '../workflow/conformance/place.js';
import { inProcessClient, type HostPlaceRequest } from '../workflow/protocol.js';
import { pull } from '../pull.js';
import { pendingRecords } from '../workflow/records.js';
import { findRunConfig } from '../workflow/run-location.js';
import { cancelRun } from '../workflow/run-controls.js';
import { AttemptIdSchema, readRun, RunIdSchema, withRunLock } from '../workflow/store.js';

vi.mock('../pull.js', () => ({ pull: vi.fn() }));
/** The git steps of a prepare to kill the process after, each once. */
const killAfter = vi.hoisted(() => new Set<string>());
vi.mock('../workflow/worktree.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workflow/worktree.js')>();
  const killable = <A extends unknown[], R>(name: string, run: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    const result = await run(...args);
    if (killAfter.delete(name)) throw new Error(`killed after ${name}`);
    return result;
  };
  return {
    ...real,
    ensureWorktree: killable('ensureWorktree', real.ensureWorktree),
    markSetup: killable('markSetup', real.markSetup),
    markReadCopy: killable('markReadCopy', real.markReadCopy),
    mergeBranch: killable('mergeBranch', real.mergeBranch),
    worktreeHooks: killable('worktreeHooks', real.worktreeHooks),
  };
});
// Setup's process runs on once the process that started it is killed, as it does when a runner is killed.
vi.mock('../tool-launch/process-stop.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tool-launch/process-stop.js')>();
  return {
    ...real,
    recordGroup: (...args: Parameters<typeof real.recordGroup>) => {
      real.recordGroup(...args);
      if (killAfter.delete('recordGroup')) throw new Error('killed while setup ran');
    },
  };
});
/** Waits for `file`, which a setup that outlived its process writes. */
async function written(file: string): Promise<void> {
  for (let wait = 0; wait < 100 && !fs.existsSync(file); wait += 1) await new Promise((resolve) => { setTimeout(resolve, 50); });
  if (!fs.existsSync(file)) throw new Error(`${file} was not written`);
}
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); killAfter.clear(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
async function fixture(yaml?: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-place-'))); dirs.push(root);
  const home = path.join(root, 'home'); fs.mkdirSync(home); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  const work = path.join(root, 'work'); const repo = path.join(root, 'knowledge'); const remote = path.join(root, 'remote.git');
  fs.mkdirSync(work); fs.mkdirSync(path.join(repo, 'workflows'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main'); git(work, 'config', 'user.name', 'Test'); git(work, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(work, 'AGENTS.md'), 'Trusted base instructions.\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'fixture'); git(work, 'init', '-q', '--bare', '-b', 'main', remote);
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', '-q', 'origin', 'main');
  const config: LocalConfig = { repo: { kind: 'self', localPath: repo, remote }, username: 'test', scope: 'project', projectRoot: work, additionalRoles: [], dataHome: path.join(home, '.teamai', 'projects', 'fixture') };
  fs.mkdirSync(path.join(home, '.teamai', 'projects', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(home, '.teamai', 'projects', 'fixture', 'config.yaml'), YAML.stringify(config));
  fs.writeFileSync(path.join(repo, 'workflows', 'build.yaml'), yaml ?? `schemaVersion: v1alpha1
name: build
description: Session work.
invoke: allow
alias: ship
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          prompt: Edit the project.
        - id: polish
          needs: [write]
          prompt: Polish the project.
`);
  await syncWorkflowDefinitions(config);
  const env = await resolveWorkflowEnv(config);
  const client = inProcessClient({ config, env });
  const started = await client.start('ship', { checkout: work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
  if ('error' in started) throw new Error(started.error.message);
  return { config, env, client, work, remote, runId: String(started.data.run), driver: { kind: 'skill', machine: 'fixture', workspace: work } };
}
async function next(f: Awaited<ReturnType<typeof fixture>>) {
  const answer = await f.client.next(f.runId, { driver: { ...f.driver, can: { hitl: true, setup: true, workspace: ['read-only', 'new', 'continue'] } } }, { prepare: true });
  if ('error' in answer || !answer.data.lease) throw new Error(JSON.stringify({ answer, run: await readRun(f.config, f.runId) }));
  return answer.data.lease as { attempt: string; revision: number; step: string; cwd: string; workspace: { branch: string } };
}

describe('prepared places through the workflow client', () => {
  it.each([false, true])('preserves interactive prompt write permissions with explicit read-only=%s', async (readOnly) => {
    const f = await fixture(`schemaVersion: v1alpha1\nname: build\ndescription: Interactive session.\nalias: ship\nsteps:\n  - id: pair\n    prompt: Pair on the code.\n    interactive: true\n${readOnly ? '    workspace: read-only\n' : ''}`);
    const lease = await next(f);
    fs.writeFileSync(path.join(lease.cwd, 'pair.txt'), 'human edits\n');
    expect(await f.client.report(f.runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: f.driver }))
      .toMatchObject({ data: { accepted: true, step: { status: readOnly ? 'failed' : 'succeeded' } } });
    expect(fs.readFileSync(path.join(f.work, 'pair.txt'), 'utf8')).toBe('human edits\n');
  });
  it('reuses a prepared lease without overwriting edits, restores base instructions, and reports committed changes', async () => {
    const f = await fixture(); const first = await next(f);
    expect(await findRunConfig(f.runId, { ...f.config, projectRoot: first.cwd })).toMatchObject({ config: { projectRoot: f.work } });
    fs.writeFileSync(path.join(first.cwd, 'code.txt'), 'first\n'); fs.writeFileSync(path.join(first.cwd, 'AGENTS.md'), 'Untrusted branch instructions.\n');
    expect((await next(f)).cwd).toBe(first.cwd);
    expect(fs.readFileSync(path.join(first.cwd, 'code.txt'), 'utf8')).toBe('first\n');
    const report = { attempt: first.attempt, revision: first.revision, outcome: 'success' as const, driver: f.driver };
    expect(await f.client.report(f.runId, report)).toMatchObject({ data: { accepted: true } });
    const committed = git(f.work, 'rev-parse', first.workspace.branch);
    expect(await f.client.report(f.runId, report)).toMatchObject({ error: { code: 'repeated_report' } });
    expect(git(f.work, 'rev-parse', first.workspace.branch)).toBe(committed);
    const second = await next(f);
    expect(fs.readFileSync(path.join(second.cwd, 'AGENTS.md'), 'utf8')).toBe('Trusted base instructions.\n');
    fs.appendFileSync(path.join(second.cwd, 'code.txt'), 'second\n');
    expect(await f.client.report(f.runId, { attempt: second.attempt, revision: second.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true, cleanup: true } });
    expect(git(f.remote, 'show', `${first.workspace.branch}:code.txt`)).toBe('first\nsecond');
    expect(fs.existsSync(second.cwd)).toBe(false);
    const attempts = path.join(f.config.dataHome ?? '', 'workflows', 'runs', f.runId, 'attempts');
    const stored = fs.readdirSync(attempts).map((attempt) => fs.readFileSync(path.join(attempts, attempt, 'place.json'), 'utf8')).join('\n');
    expect(stored).not.toContain('Edit the project.'); expect(stored).not.toContain('Untrusted branch instructions.');
  });
  it.each(['success', 'failed'] as const)('preserves a prepared writer when origin rejects a %s report push', async (outcome) => {
    const f = await fixture();
    const lease = await next(f);
    fs.writeFileSync(path.join(lease.cwd, 'code.txt'), 'keep this work');
    const hook = path.join(f.remote, 'hooks/pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const answer = await f.client.report(f.runId, { attempt: lease.attempt, revision: lease.revision, outcome, driver: f.driver,
      ...(outcome === 'failed' ? { failure: { code: 'tool_failed', message: 'Original tool failure' } } : {}) });
    expect(answer).toMatchObject({ data: { accepted: true, step: { status: 'failed' } } });
    const run = await readRun(f.config, f.runId);
    expect(run).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ id: 'change.write', status: 'failed', failure: { code: outcome === 'success' ? 'push_failed' : 'tool_failed', message: expect.stringContaining('push') } })]) });
    expect(fs.existsSync(lease.cwd)).toBe(true);
    expect(git(f.work, 'show', `${lease.workspace.branch}:code.txt`)).toBe('keep this work');
  });

  describe('a process killed after a git step of a prepare, before the place is recorded', () => {
    const SETUP = `schemaVersion: v1alpha1
name: build
description: Build in a set-up workspace.
alias: ship
setup:
  command: touch "$(git rev-parse --git-path setup-ran)"
steps:
  - id: build
    workspace: new
    prompt: Build it.
`;
    const setupRan = (dir: string): boolean => fs.existsSync(path.resolve(dir, git(dir, 'rev-parse', '--git-path', 'setup-ran')));

    it.each(['ensureWorktree', 'markSetup'])('runs setup in the place the next prepare of the attempt makes, after a kill after %s', async (step) => {
      const f = await fixture(SETUP);
      killAfter.add(step);
      await expect(next(f)).rejects.toThrow(`killed after ${step}`);
      const lease = await next(f);
      expect(setupRan(lease.cwd)).toBe(true);
      expect(await f.client.report(f.runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true } });
    });

    it.each([
      ['the mode its next sent', { runMode: 'unattended' }, 'unattended'],
      ['the mode of the process, when its next sent none', {}, 'attended'],
    ])('runs setup in %s', async (_, sent, mode) => {
      vi.stubEnv('TEAMAI_MODE', 'attended');
      const f = await fixture(SETUP.replace('touch "$(git rev-parse --git-path setup-ran)"', 'echo "$TEAMAI_MODE" > "$(git rev-parse --git-path setup-ran)"'));
      const answer = await f.client.next(f.runId, { driver: { ...f.driver, can: { hitl: true, setup: true, workspace: ['read-only', 'new', 'continue'] } }, ...sent }, { prepare: true });
      const { cwd } = z.object({ cwd: z.string() }).parse('data' in answer ? answer.data.lease : answer);
      expect(fs.readFileSync(path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'setup-ran')), 'utf8')).toBe(`${mode}\n`);
    });

    it('lets the next prepare of a reader use the copy it marked', async () => {
      const f = await fixture(`schemaVersion: v1alpha1
name: build
description: A reader of the copy a writer made.
alias: ship
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          prompt: Write the code.
        - id: check
          needs: [write]
          workspace: read-only
          prompt: Check the code.
`);
      const write = await next(f);
      fs.writeFileSync(path.join(write.cwd, 'code.txt'), 'written\n');
      expect(await f.client.report(f.runId, { attempt: write.attempt, revision: write.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true } });
      killAfter.add('markReadCopy');
      await expect(next(f)).rejects.toThrow('killed after markReadCopy');
      const check = await next(f);
      expect(check.step).toBe('change.check');
      expect(await f.client.report(f.runId, { attempt: check.attempt, revision: check.revision, outcome: 'success', driver: f.driver }))
        .toMatchObject({ data: { accepted: true, step: { status: 'succeeded' } } });
    });

    it('reports the merge a killed prepare made among the changes of the attempt', async () => {
      const f = await fixture(`schemaVersion: v1alpha1
name: build
description: A step starts from one branch and merges another.
alias: ship
steps:
  - id: right
    workspace: new
    prompt: Write the right side.
  - id: left
    needs: []
    workspace: new
    prompt: Write the left side.
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Join both sides.
`);
      for (let side = 0; side < 2; side += 1) {
        const lease = await next(f);
        fs.writeFileSync(path.join(lease.cwd, `${lease.step}.txt`), `${lease.step}\n`);
        expect(await f.client.report(f.runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true } });
      }
      killAfter.add('mergeBranch');
      await expect(next(f)).rejects.toThrow('killed after mergeBranch');
      const join = await next(f);
      const merge = git(join.cwd, 'rev-parse', 'HEAD');
      const start = git(join.cwd, 'rev-parse', 'HEAD^1');
      fs.writeFileSync(path.join(join.cwd, 'joined.txt'), 'joined\n');
      expect(await f.client.report(f.runId, { attempt: join.attempt, revision: join.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true } });
      const run = await readRun(f.config, f.runId);
      const joined = typeof run === 'object' ? run.steps.find((step) => step.id === 'join') : undefined;
      if (joined?.status !== 'succeeded') throw new Error(JSON.stringify(joined));
      expect(joined.changes?.from).toBe(start);
      expect(joined.changes?.commits).toContain(merge);
    });
  });

  describe('a process killed while setup runs', () => {
    // Setup caches its key in a file git ignores, and skips the write once the file is there.
    const CACHE = `schemaVersion: v1alpha1
name: build
description: Build in a set-up workspace.
alias: ship
setup:
  requires: { env: [CACHE_TOKEN] }
  command: test -f .cache || printf %s "$CACHE_TOKEN" > .cache
steps:
  - id: build
    workspace: new
    prompt: Build it.
`;
    const TOKEN = 'cache-token-value-1304';
    const body = (f: Awaited<ReturnType<typeof fixture>>) => ({ driver: { ...f.driver, can: { hitl: true, setup: true, env: true, workspace: ['read-only', 'new', 'continue'] } } });

    it('makes the place again for the next prepare of the attempt, whose setup is checked from the start', async () => {
      vi.stubEnv('CACHE_TOKEN', TOKEN);
      const f = await fixture(CACHE);
      fs.appendFileSync(path.join(f.work, '.git', 'info', 'exclude'), '.cache\n');
      killAfter.add('recordGroup');
      await expect(f.client.next(f.runId, body(f), { prepare: true })).rejects.toThrow('killed while setup ran');
      const copy = git(f.work, 'worktree', 'list', '--porcelain').split('\n').flatMap((line) => (line.startsWith('worktree ') ? [line.slice('worktree '.length)] : [])).find((dir) => dir !== f.work);
      await written(path.join(copy ?? '', '.cache'));
      expect(await f.client.next(f.runId, body(f), { prepare: true }))
        .toMatchObject({ error: { code: 'setup_secret', message: expect.stringContaining('CACHE_TOKEN in .cache') } });
    });
  });

  describe('a process killed while it puts the base agent files over the branch', () => {
    /** Runs the first step, which commits its own AGENTS.md, then crashes the prepare of the second while it delivers the team's assets. */
    async function crashedPrepare() {
      const f = await fixture(); const first = await next(f);
      fs.writeFileSync(path.join(first.cwd, 'AGENTS.md'), 'Branch instructions.\n');
      expect(await f.client.report(f.runId, { attempt: first.attempt, revision: first.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true } });
      vi.mocked(pull).mockRejectedValueOnce(new Error('killed while delivering'));
      await expect(next(f)).rejects.toThrow('killed while delivering');
      return { f, dir: first.cwd };
    }

    it('lets the next prepare of the attempt finish the overlay', async () => {
      const { f, dir } = await crashedPrepare();
      const second = await next(f);
      expect(second.cwd).toBe(dir);
      expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe('Trusted base instructions.\n');
      expect(await f.client.report(f.runId, { attempt: second.attempt, revision: second.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true } });
      expect(git(f.remote, 'show', `${second.workspace.branch}:AGENTS.md`)).toBe('Branch instructions.');
    });

    it('puts the branch agent files back when the attempt is given up', async () => {
      const { f, dir } = await crashedPrepare();
      const run = await readRun(f.config, f.runId);
      const polish = typeof run === 'object' ? run.steps.find((step) => step.id === 'change.polish') : undefined;
      if (polish?.status !== 'leased') throw new Error(JSON.stringify(polish));
      await cancelRun(f.config, f.runId, f.env.secrets);
      await f.client.report(f.runId, { attempt: polish.lease.attempt, revision: polish.lease.revision, outcome: 'released', driver: f.driver });
      expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe('Branch instructions.\n');
      expect(git(dir, 'status', '--porcelain')).toBe('');
    });
  });

  it('does not commit or push a cancelled attempt', async () => {
    const f = await fixture(); const lease = await next(f); fs.writeFileSync(path.join(lease.cwd, 'code.txt'), 'preserve me');
    const before = git(f.work, 'rev-parse', lease.workspace.branch);
    await cancelRun(f.config, f.runId, f.env.secrets);
    expect(await f.client.report(f.runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: f.driver })).toMatchObject({ error: { code: 'lease_cancelled' } });
    expect(git(f.work, 'rev-parse', lease.workspace.branch)).toBe(before);
    expect(fs.readFileSync(path.join(lease.cwd, 'code.txt'), 'utf8')).toBe('preserve me');
  });
  it('does not prepare a second attempt in the place another open attempt holds, and prepares it there once that one reports', async () => {
    const f = await fixture(`schemaVersion: v1alpha1
name: build
description: Read the code twice.
alias: ship
steps:
  - id: review
    prompt: Review the code.
  - id: audit
    needs: []
    prompt: Audit the code.
`);
    const can = { hitl: true, setup: true, workspace: ['read-only', 'new', 'continue'] };
    const review = await next(f);
    expect(review.cwd).toBe(f.work);
    const audit = await f.client.next(f.runId, { driver: { ...f.driver, can }, running: [review.attempt] }, { prepare: true });
    const run = await readRun(f.config, f.runId);
    const leased = typeof run === 'object' ? run.steps.find((step) => step.id === 'audit') : undefined;
    if (leased?.status !== 'leased') throw new Error(JSON.stringify({ audit, run }));
    const attempt = AttemptIdSchema.parse(leased.lease.attempt);
    expect(audit).toEqual({ error: {
      code: 'busy',
      message: `Attempt ${attempt} of run ${f.runId} runs in ${f.work}, the place of attempt ${review.attempt}, which is still open, so it was not prepared. Report attempt ${review.attempt}, then prepare this one with next --prepare --attempt ${attempt}.`,
    } });

    expect(await f.client.report(f.runId, { attempt: review.attempt, revision: review.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true } });
    expect(await f.client.next(f.runId, { driver: { ...f.driver, can } }, { prepare: { attempt } })).toMatchObject({ data: { lease: { attempt, cwd: f.work } } });
  });
  it('holds the place of an attempt the run cancelled until its driver reports it stopped, so nothing runs beside what it left running', async () => {
    const f = await fixture(`schemaVersion: v1alpha1
name: build
description: Read the code twice.
alias: ship
steps:
  - id: review
    prompt: Review the code.
  - id: audit
    needs: []
    prompt: Audit the code.
`);
    const can = { hitl: true, setup: true, workspace: ['read-only', 'new', 'continue'] };
    const review = await next(f);
    expect(await f.client.cancel(f.runId, 'review')).toMatchObject({ data: { cancelled: { attempts: [review.attempt] } } });
    const audit = await f.client.next(f.runId, { driver: { ...f.driver, can }, running: [review.attempt] }, { prepare: true });
    expect(audit).toMatchObject({ error: { code: 'busy', message: expect.stringContaining(`the place of attempt ${review.attempt}, which is still open`) } });

    expect(await f.client.report(f.runId, { attempt: review.attempt, revision: review.revision, outcome: 'released', driver: f.driver })).toMatchObject({ error: { code: 'lease_cancelled' } });
    const run = await readRun(f.config, f.runId);
    const leased = typeof run === 'object' ? run.steps.find((step) => step.id === 'audit') : undefined;
    if (leased?.status !== 'leased') throw new Error(JSON.stringify({ audit, run }));
    const attempt = AttemptIdSchema.parse(leased.lease.attempt);
    expect(await f.client.next(f.runId, { driver: { ...f.driver, can } }, { prepare: { attempt } })).toMatchObject({ data: { lease: { attempt, cwd: f.work } } });
  });

  it('leaves the place of an attempt another driver had to the next driver, as that driver may never report it stopped', async () => {
    const f = await fixture(`schemaVersion: v1alpha1
name: build
description: Read the code twice.
alias: ship
steps:
  - id: review
    prompt: Review the code.
  - id: audit
    needs: []
    prompt: Audit the code.
`);
    const can = { hitl: true, setup: true, workspace: ['read-only', 'new', 'continue'] };
    const review = await next(f);
    expect(await f.client.cancel(f.runId, 'review')).toMatchObject({ data: { cancelled: { attempts: [review.attempt] } } });
    const audit = await f.client.next(f.runId, { driver: { ...f.driver, kind: 'other', can } }, { prepare: true });
    expect(audit).toMatchObject({ data: { lease: { step: 'audit', cwd: f.work } } });
  });
});

describe('places the host made', () => {
  const SETUP = (command: string) => `schemaVersion: v1alpha1
name: build
description: Build in a set-up place the host makes.
alias: ship
setup:
  command: ${command}
steps:
  - id: build
    workspace: new
    prompt: Build it.
`;
  const LeaseSchema = z.object({ attempt: AttemptIdSchema, revision: z.number(), workspace: z.object({ branch: z.string(), start: z.object({ commit: z.string() }) }) });
  const body = (f: Awaited<ReturnType<typeof fixture>>) => ({ driver: { ...f.driver, can: { hitl: true, setup: true, workspace: ['read-only', 'new', 'continue'] } } });
  /** A lease the run gives without preparing it, and a place for it the host makes with `git worktree add` and `args`. */
  async function leased(f: Awaited<ReturnType<typeof fixture>>) {
    const answer = await f.client.next(f.runId, body(f));
    if (!('data' in answer) || !answer.data.lease) throw new Error(JSON.stringify(answer));
    const lease = LeaseSchema.parse(answer.data.lease);
    const host = (name: string, ...args: string[]): string => {
      const dir = path.join(path.dirname(f.work), 'hosts', name);
      git(f.work, 'worktree', 'add', '-q', ...args, dir, lease.workspace.start.commit);
      return dir;
    };
    return { ...lease, host };
  }
  const setupRan = (dir: string): boolean => fs.existsSync(path.resolve(dir, git(dir, 'rev-parse', '--git-path', 'setup-ran')));

  it('gives a place detached at the start the lease\'s branch, runs setup there, and leaves it after the step with its own hooks', async () => {
    const f = await fixture(SETUP('touch "$(git rev-parse --git-path setup-ran)"'));
    const lease = await leased(f);
    const dir = lease.host('detached', '--detach');
    const hooks = (): string => git(dir, 'config', '--worktree', '--default', '', '--get', 'core.hooksPath');
    expect(await f.client.next(f.runId, body(f), { prepare: { attempt: lease.attempt, adopt: dir } })).toMatchObject({ data: { lease: { attempt: lease.attempt, cwd: dir } } });
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe(lease.workspace.branch);
    expect(setupRan(dir)).toBe(true);
    expect(hooks()).not.toBe('');
    fs.writeFileSync(path.join(dir, 'code.txt'), 'adopted\n');
    expect(await f.client.report(f.runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true, cleanup: true } });
    expect(git(f.remote, 'show', `${lease.workspace.branch}:code.txt`)).toBe('adopted');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(hooks()).toBe('');
  });

  it.each([
    { end: 'fails', report: (f: Awaited<ReturnType<typeof fixture>>, lease: { attempt: string; revision: number }) => f.client.report(f.runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'failed', message: 'broke', driver: f.driver }), answer: { data: { accepted: true } } },
    {
      end: 'is cancelled',
      report: async (f: Awaited<ReturnType<typeof fixture>>, lease: { attempt: string; revision: number }) => {
        await f.client.cancel(f.runId);
        return f.client.report(f.runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: f.driver });
      },
      answer: { error: { code: 'lease_cancelled' } },
    },
  ])('leaves a place the host made with its own hooks when its step $end', async ({ report, answer }) => {
    const f = await fixture();
    const lease = await leased(f);
    const dir = lease.host('ended', '--detach');
    const hooks = (): string => git(dir, 'config', '--worktree', '--default', '', '--get', 'core.hooksPath');
    expect(await f.client.next(f.runId, body(f), { prepare: { attempt: lease.attempt, adopt: dir } })).toMatchObject({ data: { lease: { cwd: dir } } });
    expect(hooks()).not.toBe('');
    expect(await report(f, lease)).toMatchObject(answer);
    expect(hooks()).toBe('');
  });

  it('keeps a place whose setup failed, with the branch agent files back and its own hooks', async () => {
    const f = await fixture(SETUP('exit 3'));
    const lease = await leased(f);
    const dir = lease.host('failing', '-b', lease.workspace.branch);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Host instructions.\n');
    git(dir, 'commit', '-qam', 'host instructions');
    expect(await f.client.next(f.runId, body(f), { prepare: { attempt: lease.attempt, adopt: dir } })).toMatchObject({ error: { code: 'setup_failed' } });
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe('Host instructions.\n');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'config', '--worktree', '--default', '', '--get', 'core.hooksPath')).toBe('');
  });

  it('refuses a place whose setup was cut short until the host makes it again, and checks the setup of the new one from the start', async () => {
    vi.stubEnv('CACHE_TOKEN', 'cache-token-value-1304');
    const f = await fixture(`schemaVersion: v1alpha1
name: build
description: Build in a set-up place the host makes.
alias: ship
setup:
  requires: { env: [CACHE_TOKEN] }
  command: test -f .cache || printf %s "$CACHE_TOKEN" > .cache
steps:
  - id: build
    workspace: new
    prompt: Build it.
`);
    fs.appendFileSync(path.join(f.work, '.git', 'info', 'exclude'), '.cache\n');
    const withEnv = { driver: { ...f.driver, can: { hitl: true, setup: true, env: true, workspace: ['read-only', 'new', 'continue'] } } };
    const answer = await f.client.next(f.runId, withEnv);
    if (!('data' in answer) || !answer.data.lease) throw new Error(JSON.stringify(answer));
    const lease = LeaseSchema.parse(answer.data.lease);
    const dir = path.join(path.dirname(f.work), 'hosts', 'cut');
    git(f.work, 'worktree', 'add', '-q', '--detach', dir, lease.workspace.start.commit);
    const prepare = () => f.client.next(f.runId, withEnv, { prepare: { attempt: lease.attempt, adopt: dir } });

    killAfter.add('recordGroup');
    await expect(prepare()).rejects.toThrow('killed while setup ran');
    await written(path.join(dir, '.cache'));
    expect(await prepare()).toMatchObject({ error: { code: 'adopt_mismatch', message: expect.stringContaining(`Setup did not finish in ${dir}`) } });
    const run = await readRun(f.config, f.runId);
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'build')?.status).toBe('leased');

    git(f.work, 'worktree', 'remove', '--force', dir);
    git(f.work, 'worktree', 'add', '-q', dir, lease.workspace.branch);
    expect(await prepare()).toMatchObject({ error: { code: 'setup_secret', message: expect.stringContaining('CACHE_TOKEN in .cache') } });
  });

  it('refuses a second place for an attempt it adopted one for, and a prepare without --adopt answers with the first', async () => {
    const f = await fixture();
    const lease = await leased(f);
    const first = lease.host('first', '-b', lease.workspace.branch);
    expect(await f.client.next(f.runId, body(f), { prepare: { attempt: lease.attempt, adopt: first } })).toMatchObject({ data: { lease: { cwd: first } } });
    const second = lease.host('second', '--detach');
    expect(await f.client.next(f.runId, body(f), { prepare: { attempt: lease.attempt, adopt: second } }))
      .toMatchObject({ error: { code: 'adopt_mismatch', message: expect.stringContaining(`already prepared in ${first}`) } });
    expect(await f.client.next(f.runId, body(f), { prepare: { attempt: lease.attempt } })).toMatchObject({ data: { lease: { attempt: lease.attempt, cwd: first } } });
  });

  it('asks the host for the place of a new branch, and goes on in it for a later step on the branch, without its setup again', async () => {
    const f = await fixture(`schemaVersion: v1alpha1
name: build
description: Write a change, then polish it, in a set-up place the host makes.
alias: ship
setup:
  command: echo ran >> "$(git rev-parse --git-path setup-runs)"
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          prompt: Write the change.
        - id: polish
          needs: [write]
          prompt: Polish the change.
`);
    const run = RunIdSchema.parse(f.runId);
    const prepare = (lease: unknown, request: HostPlaceRequest) => withRunLock(f.config, run, (lock) => f.client.prepareHostPlace(lock, lease, request), { waitMs: 0 });
    const lease = async (): Promise<{ raw: unknown } & z.infer<typeof LeaseSchema>> => {
      const answer = await f.client.next(f.runId, body(f));
      if (!('data' in answer) || !answer.data.lease) throw new Error(JSON.stringify(answer));
      return { raw: answer.data.lease, ...LeaseSchema.parse(answer.data.lease) };
    };
    const write = await lease();
    expect(await prepare(write.raw, { kind: 'host' })).toEqual({
      kind: 'needs-place', name: expect.stringMatching(/^teamai-/), branch: write.workspace.branch, start: write.workspace.start.commit,
    });
    const dir = path.join(path.dirname(f.work), 'hosts', 'place');
    git(f.work, 'worktree', 'add', '-q', '--detach', dir, write.workspace.start.commit);
    expect(await prepare(write.raw, { kind: 'adopt', dir })).toMatchObject({ kind: 'prepared', dir });
    expect(await f.client.setup(run, write.attempt, 'attended')).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'change.txt'), 'written\n');
    expect(await f.client.report(f.runId, { attempt: write.attempt, revision: write.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true } });

    const polish = await lease();
    expect(polish.workspace.branch).toBe(write.workspace.branch);
    expect(await prepare(polish.raw, { kind: 'host' })).toMatchObject({ kind: 'prepared', dir });
    expect(await f.client.setup(run, polish.attempt, 'attended')).toBeUndefined();
    expect(fs.readFileSync(path.resolve(dir, git(dir, 'rev-parse', '--git-path', 'setup-runs')), 'utf8')).toBe('ran\n');
  });

  it('goes on in the place the host made for a later command and reader on its branch, and leaves it after the last with its own hooks', async () => {
    const f = await fixture(`schemaVersion: v1alpha1
name: build
description: Write a change, check it, then review it, in a place the host makes.
alias: ship
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          prompt: Write the change.
        - id: check
          needs: [write]
          command: cat change.txt
        - id: review
          needs: [check]
          workspace: read-only
          prompt: Review the change.
`);
    const run = RunIdSchema.parse(f.runId);
    const lease = async (): Promise<{ raw: unknown } & z.infer<typeof LeaseSchema>> => {
      const answer = await f.client.next(f.runId, body(f));
      if (!('data' in answer) || !answer.data.lease) throw new Error(JSON.stringify(answer));
      return { raw: answer.data.lease, ...LeaseSchema.parse(answer.data.lease) };
    };
    const write = await lease();
    const dir = path.join(path.dirname(f.work), 'hosts', 'place');
    git(f.work, 'worktree', 'add', '-q', '--detach', dir, write.workspace.start.commit);
    expect(await withRunLock(f.config, run, (lock) => f.client.prepareHostPlace(lock, write.raw, { kind: 'adopt', dir }), { waitMs: 0 })).toMatchObject({ kind: 'prepared', dir });
    fs.writeFileSync(path.join(dir, 'change.txt'), 'written\n');
    expect(await f.client.report(f.runId, { attempt: write.attempt, revision: write.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true } });

    for (const step of ['check', 'review']) {
      const later = await lease();
      expect(later.workspace.branch).toBe(write.workspace.branch);
      expect(await withRunLock(f.config, run, (lock) => f.client.prepare(lock, later.raw), { waitMs: 0 }), step).toMatchObject({ kind: 'prepared', dir });
      expect(await f.client.report(f.runId, { attempt: later.attempt, revision: later.revision, outcome: 'success', driver: f.driver }), step).toMatchObject({ data: { accepted: true } });
    }
    expect(fs.readFileSync(path.join(dir, 'change.txt'), 'utf8')).toBe('written\n');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'config', '--worktree', '--default', '', '--get', 'core.hooksPath')).toBe('');
  });

  it('says why the place the host made was passed over when the copy TeamAI then makes of its branch fails', async () => {
    const f = await fixture(`schemaVersion: v1alpha1
name: build
description: Write a change, then check it, in a place the host makes.
alias: ship
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          prompt: Write the change.
        - id: check
          needs: [write]
          command: cat change.txt
`);
    const run = RunIdSchema.parse(f.runId);
    const lease = async (): Promise<{ raw: unknown } & z.infer<typeof LeaseSchema>> => {
      const answer = await f.client.next(f.runId, body(f));
      if (!('data' in answer) || !answer.data.lease) throw new Error(JSON.stringify(answer));
      return { raw: answer.data.lease, ...LeaseSchema.parse(answer.data.lease) };
    };
    const write = await lease();
    const dir = path.join(path.dirname(f.work), 'hosts', 'place');
    git(f.work, 'worktree', 'add', '-q', '--detach', dir, write.workspace.start.commit);
    expect(await withRunLock(f.config, run, (lock) => f.client.prepareHostPlace(lock, write.raw, { kind: 'adopt', dir }), { waitMs: 0 })).toMatchObject({ kind: 'prepared', dir });
    fs.writeFileSync(path.join(dir, 'change.txt'), 'written\n');
    expect(await f.client.report(f.runId, { attempt: write.attempt, revision: write.revision, outcome: 'success', driver: f.driver })).toMatchObject({ data: { accepted: true } });
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'left by the host\n');

    const check = await lease();
    expect(await withRunLock(f.config, run, (lock) => f.client.prepare(lock, check.raw), { waitMs: 0 })).toEqual({ kind: 'failed', failure: {
      code: 'workspace_base',
      message: expect.stringMatching(new RegExp(`^TeamAI did not go on in ${dir}, the place the host made for branch ${write.workspace.branch}: ${dir} has changes the step would commit \\(\\?\\? stray\\.txt\\).* Making its own worktree of the branch failed too: .*already used by worktree`, 's')),
    } });
  });

  it('refuses a place another open attempt began to adopt, even when its prepare was killed before it made its branch there', async () => {
    const f = await fixture(`schemaVersion: v1alpha1
name: build
description: Build the API and the UI.
alias: ship
steps:
  - id: api
    workspace: new
    prompt: Build the API.
  - id: ui
    needs: []
    workspace: new
    prompt: Build the UI.
`);
    const run = RunIdSchema.parse(f.runId);
    const raw = async (running: string[]): Promise<unknown> => {
      const answer = await f.client.next(f.runId, { ...body(f), running });
      if (!('data' in answer) || !answer.data.lease) throw new Error(JSON.stringify(answer));
      return answer.data.lease;
    };
    const api = await raw([]);
    const { attempt, workspace } = LeaseSchema.parse(api);
    const ui = await raw([attempt]);
    const dir = path.join(path.dirname(f.work), 'hosts', 'shared');
    git(f.work, 'worktree', 'add', '-q', '--detach', dir, workspace.start.commit);
    const prepare = (lease: unknown) => withRunLock(f.config, run, (lock) => f.client.prepareHostPlace(lock, lease, { kind: 'adopt', dir }), { waitMs: 0 });

    killAfter.add('worktreeHooks');
    await expect(prepare(api)).rejects.toThrow('killed after worktreeHooks');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(await prepare(ui)).toMatchObject({ kind: 'needs-place', refused: expect.stringContaining(`is the place of attempt ${attempt}`) });
    expect(await prepare(api)).toMatchObject({ kind: 'prepared', dir });
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe(workspace.branch);
  });

  it('refuses through next --prepare a place another open attempt began to adopt, as a host-place prepare does, and the attempt stays leased', async () => {
    const f = await fixture(`schemaVersion: v1alpha1
name: build
description: Build the API and the UI.
alias: ship
steps:
  - id: api
    workspace: new
    prompt: Build the API.
  - id: ui
    needs: []
    workspace: new
    prompt: Build the UI.
`);
    const raw = async (running: string[]): Promise<unknown> => {
      const answer = await f.client.next(f.runId, { ...body(f), running });
      if (!('data' in answer) || !answer.data.lease) throw new Error(JSON.stringify(answer));
      return answer.data.lease;
    };
    const api = LeaseSchema.parse(await raw([]));
    const ui = LeaseSchema.parse(await raw([api.attempt]));
    const dir = path.join(path.dirname(f.work), 'hosts', 'shared');
    git(f.work, 'worktree', 'add', '-q', '--detach', dir, api.workspace.start.commit);
    const prepare = (attempt: string) => f.client.next(f.runId, body(f), { prepare: { attempt: AttemptIdSchema.parse(attempt), adopt: dir } });

    killAfter.add('worktreeHooks');
    await expect(prepare(api.attempt)).rejects.toThrow('killed after worktreeHooks');
    expect(await prepare(ui.attempt)).toMatchObject({ error: {
      code: 'adopt_mismatch',
      message: `${dir} is the place of attempt ${api.attempt} of run ${f.runId}, which is still open, so attempt ${ui.attempt} was not prepared there. Make another place for it, then adopt that one.`,
    } });
    const run = await readRun(f.config, f.runId);
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'ui')?.status).toBe('leased');
    expect(await prepare(api.attempt)).toMatchObject({ data: { lease: { attempt: api.attempt, cwd: dir } } });
  });

  it('says the run released an attempt the driver asked back with a can that no longer covers its step, and what to call instead', async () => {
    const f = await fixture(SETUP('exit 0'));
    const lease = await leased(f);
    const narrower = { driver: { ...f.driver, can: { hitl: true, workspace: ['read-only', 'new', 'continue'] } } };
    expect(await f.client.next(f.runId, narrower, { prepare: { attempt: lease.attempt } })).toEqual({ error: {
      code: 'wrong_attempt',
      message: `Run ${f.runId} released attempt ${lease.attempt} of step "build" when this driver asked for it back, since the can this next declares no longer covers the step, so it was not prepared. Call next without --attempt: the run leases the step again to a driver whose can covers it.`,
    } });
    const run = await readRun(f.config, f.runId);
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'build')?.status).toBe('pending');
  });

  it('refuses a place on the lease\'s branch whose history lacks the start, and the attempt stays leased', async () => {
    const f = await fixture();
    const lease = await leased(f);
    const dir = lease.host('orphan', '--detach');
    git(dir, 'checkout', '-q', '--orphan', lease.workspace.branch);
    git(dir, 'commit', '-qm', 'unrelated');
    expect(await f.client.next(f.runId, body(f), { prepare: { attempt: lease.attempt, adopt: dir } }))
      .toMatchObject({ error: { code: 'adopt_mismatch', message: expect.stringContaining(`does not contain ${lease.workspace.start.commit}`) } });
    const run = await readRun(f.config, f.runId);
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'change.write')?.status).toBe('leased');
  });
});

describe.each(DRIVERS_UNDER_TEST)('workflow place conformance in process as %s', (profile) => {
  for (const scenario of workflowPlaceConformanceScenarios) {
    it(scenario.name, async () => {
      for (const [name, value] of Object.entries(scenario.env ?? {})) vi.stubEnv(name, value);
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-place-conformance-')));
      dirs.push(root);
      const knowledge = path.join(root, 'knowledge');
      const checkout = path.join(root, 'checkout');
      const origin = path.join(root, 'origin.git');
      fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
      git(root, 'init', '-q', '-b', 'main', checkout);
      git(checkout, 'config', 'user.name', 'Test');
      git(checkout, 'config', 'user.email', 'test@example.invalid');
      for (const [file, text] of Object.entries(PLACE_CHECKOUT_FILES)) fs.writeFileSync(path.join(checkout, file), text);
      git(checkout, 'add', '-A');
      git(checkout, 'commit', '-qm', 'initial');
      git(root, 'init', '-q', '--bare', '-b', 'main', origin);
      git(checkout, 'remote', 'add', 'origin', origin);
      git(checkout, 'push', '-q', 'origin', 'main');
      const config: LocalConfig = {
        repo: { localPath: knowledge, remote: 'local', kind: 'self' },
        username: 'tester',
        scope: 'project',
        additionalRoles: [],
        projectRoot: checkout,
        dataHome: path.join(root, 'data'),
      };
      fs.writeFileSync(path.join(knowledge, 'workflows', `${scenario.workflowName}.yaml`), scenario.yaml);
      for (const [name, yaml] of Object.entries(scenario.workflows ?? {})) fs.writeFileSync(path.join(knowledge, 'workflows', `${name}.yaml`), yaml);
      await syncWorkflowDefinitions(config);
      const inner = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
      // Every call gets a temporary directory of its own, gone once it returns, as a process of its own would.
      let calls = 0;
      const own = async <T>(call: () => Promise<T>): Promise<T> => {
        calls += 1;
        const tmp = path.join(root, `tmp-${calls}`);
        fs.mkdirSync(tmp);
        vi.stubEnv('TMPDIR', tmp);
        try {
          return await call();
        } finally {
          vi.stubEnv('TMPDIR', root);
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      };
      const scenarioClient = inProcessConformanceClient(inner);
      const client: ConformanceClient = {
        start: (name) => own(() => inner.start(name, { checkout, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } })),
        next: (run, body, options) => own(() => inner.next(run, body, options)),
        report: (run, body) => own(() => inner.report(run, body)),
        respond: (run, step, choice, options) => own(() => scenarioClient.respond(run, step, choice, options)),
        retry: (run, step) => own(() => inner.retry(run, step)),
        cancel: (run, step) => own(() => inner.cancel(run, step)),
      };
      await runConformanceScenario(scenario, {
        client,
        readRun: async (runId) => {
          const stored = await readRun(config, runId);
          if (typeof stored !== 'object') throw new Error('run was not stored');
          return stored;
        },
        readEndRecord: async (runId) => (await pendingRecords(config)).find((record) => record.run === runId && record.phase === 'end'),
        advance: async (ms) => {
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(Date.now() + ms);
        },
        expect,
        place: { checkout, origin },
      }, profile);
    });
  }
});
