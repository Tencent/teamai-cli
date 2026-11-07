import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { knownSecrets } from '../env-resolution.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { readRun } from '../workflow/store.js';
import { claimRun, publishRun } from '../workflow/handoff.js';
import { retryStep } from '../workflow/run-controls.js';
import { sweepLeftovers } from '../workflow/leftovers.js';
import { runCopyToMerge } from '../workflow/workspace.js';
import { getReportsDir, REPORTS_LOCK_FILENAME } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { log } from '../utils/logger.js';
import { fakeGh } from './helpers/fake-gh.js';
import type { LocalConfig } from '../types.js';
import type { RunState } from '../workflow/types.js';

_setDriverPollMs(20);

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** A product checkout whose origin git rewrites to a bare repository, and a team repo holding `workflow` as ship.yaml. */
async function fixture(workflow: string, inputs: Record<string, unknown> = {}): Promise<{ config: LocalConfig; cwd: string; root: string; origin: string; runId: string }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-leftovers-')));
  dirs.push(root);
  const cwd = path.join(root, 'product');
  const origin = path.join(root, 'remote.git');
  const knowledge = path.join(root, 'team');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(cwd, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.teamai/\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'base']);
  git(cwd, ['remote', 'add', 'origin', 'https://github.com/fixture/app.git']);
  git(cwd, ['config', `url.${origin}.insteadOf`, 'https://github.com/fixture/app.git']);
  git(cwd, ['push', '-q', 'origin', 'main']);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' }, scope: 'project', username: 'tester', usageReportEnabled: false,
    additionalRoles: [], projectRoot: cwd, dataHome: path.join(root, 'data'), workflows: { tools: {}, max_parallel: 1 },
  };
  fs.writeFileSync(path.join(knowledge, 'workflows', 'ship.yaml'), workflow);
  await syncWorkflowDefinitions(config, {});
  const started = await startRun(config, 'ship', inputs, { checkout: cwd, base: { ref: 'main', commit: git(cwd, ['rev-parse', 'HEAD']) }, secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  return { config, cwd, root, origin, runId: String(started.data.run) };
}

async function state(config: LocalConfig, runId: string): Promise<RunState> {
  const run = await readRun(config, runId);
  if (typeof run === 'string') throw new Error(run);
  return run;
}

/** The run's branches in `repo`, without the `teamai/<run>/` prefix. */
function branches(repo: string, runId: string): string[] {
  return git(repo, ['for-each-ref', '--format=%(refname)', `refs/heads/teamai/${runId}/`]).split('\n').filter(Boolean)
    .map((ref) => ref.slice(`refs/heads/teamai/${runId}/`.length));
}

/**
 * Puts a git first on PATH that, the first time a command matching `deleting` runs, commits on `branch` in the repository
 * git reaches with `repo` before it runs that command, as another machine pushing meanwhile would. Answers the new tip.
 */
function movesBefore(root: string, { deleting, repo, branch }: { deleting: string; repo: string; branch: string }): () => string {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(root, 'racing-bin');
  const marker = path.join(root, 'raced');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
if test ! -f '${marker}' && echo " $* " | grep -Eq -- '${deleting}'; then
  parent=$('${real}' ${repo} rev-parse 'refs/heads/${branch}')
  new=$(echo concurrent | '${real}' -c user.name=Test -c user.email=test@example.com ${repo} commit-tree "$parent^{tree}" -p "$parent")
  '${real}' ${repo} update-ref 'refs/heads/${branch}' "$new"
  echo "$new" > '${marker}'
fi
exec '${real}' "$@"
`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
  return () => fs.readFileSync(marker, 'utf8').trim();
}

/**
 * Puts a git first on PATH that holds the first command matching `pattern` until `go`, as a slow network would.
 * `reached` resolves once that command is held.
 */
function pausesOn(root: string, pattern: string): { reached: () => Promise<void>; go: () => void } {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(root, 'pausing-bin');
  const held = path.join(root, 'held');
  const released = path.join(root, 'released');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
if test ! -f '${held}' && echo " $* " | grep -Eq -- '${pattern}'; then
  touch '${held}'
  while test ! -f '${released}'; do sleep 0.05; done
fi
exec '${real}' "$@"
`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);

  return {
    reached: () => vi.waitFor(() => {
      if (!fs.existsSync(held)) throw new Error(`no git command matching ${pattern} ran`);
    }, { timeout: 20_000, interval: 20 }),
    go: () => fs.writeFileSync(released, ''),
  };
}

const SHIP_ISSUE = `schemaVersion: v1alpha1
name: ship
description: Build each part on its own branch, then deliver them together.
inputs: { parts: [string] }
steps:
  - id: build
    for_each: inputs.parts
    workspace: new
    env: { PART: "{{ item }}" }
    command: node -e "require('fs').writeFileSync(process.env.PART + '.txt', 'built')"
  - id: change
    needs: [build]
    workspace: new
    deliver: pr
    command: node -e "require('fs').writeFileSync('change.txt', 'C')"
`;

const NO_DELIVERY = `schemaVersion: v1alpha1
name: ship
description: Two branches merged into a third.
steps:
  - id: left
    workspace: new
    command: node -e "require('fs').writeFileSync('left.txt', 'L')"
  - id: join
    needs: [left]
    workspace: new
    command: node -e "require('fs').writeFileSync('join.txt', 'J')"
`;

describe('the branches of a run that succeeded', () => {
  it('keeps the pull request branch, and deletes the item branches it holds, here and on origin', async () => {
    const { config, cwd, root, origin, runId } = await fixture(SHIP_ISSUE, { parts: ['api', 'web'] });
    const gh = fakeGh(path.join(root, 'gh'));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    expect(gh.pulls().map((pull) => pull.head)).toEqual([`teamai/${runId}/change/p1`]);
    expect(branches(origin, runId)).toEqual(['change/p1']);
    expect(branches(cwd, runId)).toEqual(['change/p1']);
    expect((await state(config, runId)).leftovers).toMatchObject({
      by: 'success', kept: [{ branch: `teamai/${runId}/change/p1`, why: 'pr' }],
      deleted: [`teamai/${runId}/build-0/p1`, `teamai/${runId}/build-1/p1`], failed: [],
    });
  });

  it('deletes the branches answers read in worktrees of their own', async () => {
    const { config, cwd, root, origin, runId } = await fixture(`schemaVersion: v1alpha1
name: ship
description: Ask about each part in a worktree of its own.
inputs: { parts: [string] }
steps:
  - id: ask
    for_each: { items: inputs.parts, max_parallel: 2 }
    answer: "Describe {{ item }}."
    output: { text: string }
    workspace: new
`, { parts: ['api', 'web'] });
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'described' }))}));\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    vi.stubEnv('TEAMAI_AI_TOOL', 'claude');

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    expect(branches(cwd, runId)).toEqual([]);
    expect(branches(origin, runId)).toEqual([]);
    expect((await state(config, runId)).leftovers).toMatchObject({ by: 'success', kept: [], failed: [] });
  });

  it('keeps the final copy of a run that delivered nothing', async () => {
    const { config, cwd, origin, runId } = await fixture(NO_DELIVERY);

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    expect(branches(origin, runId)).toEqual(['join/p1']);
    expect(git(origin, ['show', `teamai/${runId}/join/p1:left.txt`])).toBe('L');
  });

  it('keeps the run copy it tells the person to merge, though a later step forked it', async () => {
    const { config, cwd, origin, runId } = await fixture(`schemaVersion: v1alpha1
name: ship
description: A run copy, and a step that forks it.
workspace: new
steps:
  - id: write
    workspace: continue
    command: node -e "require('fs').writeFileSync('root.txt', 'R')"
  - id: fork
    needs: [write]
    workspace: new
    command: node -e "require('fs').writeFileSync('fork.txt', 'F')"
`);

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    expect(runCopyToMerge(await state(config, runId))).toBe(`teamai/${runId}/_run`);
    expect(branches(origin, runId)).toContain('_run');
    expect(branches(cwd, runId)).toContain('_run');
    expect((await state(config, runId)).leftovers?.kept).toContainEqual({ branch: `teamai/${runId}/_run`, why: 'final' });
  });

  it('keeps a branch another machine moved on origin after its tip was checked, and warns naming it', async () => {
    const { config, cwd, root, origin, runId } = await fixture(NO_DELIVERY);
    const left = `teamai/${runId}/left/p1`;
    const moved = movesBefore(root, { deleting: `push .*--delete`, repo: `--git-dir=${origin}`, branch: left });
    const warn = vi.spyOn(log, 'warn');

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const tip = moved();
    expect(git(origin, ['for-each-ref', '--format=%(objectname)', `refs/heads/${left}`])).toBe(tip);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Branch ${left} of run ${runId} was not deleted on origin`));
    expect((await state(config, runId)).leftovers).toMatchObject({ failed: [{ branch: left }] });
  });

  it('keeps a branch that moved in the checkout after its tip was checked', async () => {
    const { config, cwd, root, runId } = await fixture(NO_DELIVERY);
    const left = `teamai/${runId}/left/p1`;
    const moved = movesBefore(root, { deleting: `(branch -D|update-ref -d refs/heads/).*${left}`, repo: `-C ${cwd}`, branch: left });
    vi.spyOn(log, 'warn');

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const tip = moved();
    expect(git(cwd, ['for-each-ref', '--format=%(objectname)', `refs/heads/${left}`])).toBe(tip);
    expect((await state(config, runId)).leftovers).toMatchObject({ failed: [{ branch: left }] });
  });

  it('still succeeds when origin refuses a deletion, and warns naming the branch, which it keeps for doctor --fix', async () => {
    const { config, cwd, origin, runId } = await fixture(NO_DELIVERY);
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$new" in 0000000000000000000000000000000000000000) echo "deleting is not allowed" >&2; exit 1;; esac; done\n');
    fs.chmodSync(hook, 0o755);
    const warn = vi.spyOn(log, 'warn');

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const left = `teamai/${runId}/left/p1`;
    expect(branches(origin, runId)).toEqual(['join/p1', 'left/p1']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^Branch ${left} of run ${runId} was not deleted on origin: .*deleting is not allowed.*\\. teamai doctor --fix tries again\\.$`, 's')));
    expect((await state(config, runId)).leftovers).toMatchObject({ failed: [{ branch: left }] });
  });

  it('leaves a branch checked out where the host put it in the checkout, without a warning, and still publishes the run', async () => {
    const { config, cwd, root, origin, runId } = await fixture(NO_DELIVERY);
    const driver = { kind: 'remote', machine: 'host', workspace: cwd };
    const can = { workspace: ['read-only', 'new', 'continue'] as Array<'read-only' | 'new' | 'continue'> };
    const host = path.join(root, 'host');
    const warn = vi.spyOn(log, 'warn');

    const commitOn = async (expected: string, from: string): Promise<void> => {
      const next = await leaseNext(config, runId, driver, { can });
      if (!('data' in next) || !next.data.lease) throw new Error(JSON.stringify(next));
      const lease = next.data.lease as { step: string; attempt: string; revision: number; workspace: { branch: string; base: { commit: string } } };
      expect(lease.step).toBe(expected);
      const dir = expected === 'left' ? host : path.join(root, expected);
      git(cwd, ['worktree', 'add', '-q', '-b', lease.workspace.branch, dir, from]);
      fs.writeFileSync(path.join(dir, `${expected}.txt`), expected);
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', expected]);
      git(dir, ['push', '-q', 'origin', lease.workspace.branch]);
      const to = git(dir, ['rev-parse', 'HEAD']);
      expect(await reportAttempt(config, runId, {
        attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver,
        changes: { branch: lease.workspace.branch, base: lease.workspace.base.commit, from, to, commits: [to] },
      })).toMatchObject({ data: { accepted: true } });
    };

    const base = git(cwd, ['rev-parse', 'HEAD']);
    await commitOn('left', base);
    await commitOn('join', git(host, ['rev-parse', 'HEAD']));

    expect(await leaseNext(config, runId, driver, { can })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(branches(origin, runId)).toEqual(['join/p1']);
    expect(branches(cwd, runId)).toEqual(['join/p1', 'left/p1']);
    expect(warn).not.toHaveBeenCalled();
    expect((await state(config, runId)).leftovers).toMatchObject({
      kept: expect.arrayContaining([{ branch: `teamai/${runId}/left/p1`, why: 'host' }]), deleted: [], failed: [],
    });

    shareTeam(config, root);
    expect(await publishRun(config, runId, { checkout: cwd, env: {} })).toMatchObject({ ok: true });
  });
});

const FAILS_AFTER_DELIVERY = `schemaVersion: v1alpha1
name: ship
description: A step delivers its branch, a second one works on another, and a third fails.
steps:
  - id: change
    workspace: new
    deliver: pr
    command: node -e "require('fs').writeFileSync('change.txt', 'C')"
  - id: docs
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('docs.txt', 'D')"
  - id: broken
    needs: [change, docs]
    workspace: new
    command: node -e "require('fs').writeFileSync('broken.txt', 'B'); process.exit(1)"
`;

const DAY = 86_400_000;

const FAILS_LAST = NO_DELIVERY.replace("writeFileSync('join.txt', 'J')", "writeFileSync('join.txt', 'J'); process.exit(1)");

/** A branch, and a step that delivers a pull request from its own branch once the file `ready` exists, and fails before. */
function deliversOnce(ready: string): string {
  return `schemaVersion: v1alpha1
name: ship
description: A branch, and a step that delivers once it is ready.
steps:
  - id: left
    workspace: new
    command: node -e "require('fs').writeFileSync('left.txt', 'L')"
  - id: join
    needs: [left]
    workspace: new
    deliver: pr
    command: node -e "require('fs').writeFileSync('join.txt', 'J'); require('fs').existsSync('${ready}') || process.exit(1)"
`;
}

/** Makes the fixture's team repository one with an origin, which teamai-reports and the run records go to. */
function shareTeam(config: LocalConfig, root: string): void {
  const team = config.repo.localPath;
  const remote = path.join(root, 'team.git');
  git(team, ['init', '-q', '-b', 'main']);
  git(team, ['config', 'user.name', 'Test']);
  git(team, ['config', 'user.email', 'test@example.com']);
  git(team, ['add', '-A']);
  git(team, ['commit', '-qm', 'team']);
  git(root, ['clone', '-q', '--bare', team, remote]);
  git(team, ['remote', 'add', 'origin', remote]);
  config.repo = { ...config.repo, kind: 'git', remote };
  config.usageReportEnabled = true;
}

/** Another install of the same team, with its own data home and its own clone of the product. */
async function otherInstall(config: LocalConfig, root: string, origin: string): Promise<{ config: LocalConfig; cwd: string }> {
  const home = path.join(root, 'other');
  const team = path.join(home, 'team');
  const cwd = path.join(home, 'product');
  git(root, ['clone', '-q', config.repo.remote, team]);
  git(team, ['config', 'user.name', 'Test']);
  git(team, ['config', 'user.email', 'test@example.com']);
  git(root, ['clone', '-q', origin, cwd]);
  git(cwd, ['remote', 'set-url', 'origin', 'https://github.com/fixture/app.git']);
  git(cwd, ['config', `url.${origin}.insteadOf`, 'https://github.com/fixture/app.git']);
  const other: LocalConfig = { ...config, projectRoot: cwd, dataHome: path.join(home, 'data'), repo: { ...config.repo, localPath: team } };
  await syncWorkflowDefinitions(other, {});
  return { config: other, cwd };
}

describe('doctor --fix past workflows.retention', () => {
  it('lists a branch the host keeps checked out among what it kept, past the retention', async () => {
    const { config, cwd, root, origin, runId } = await fixture(FAILS_LAST);
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const left = `teamai/${runId}/left/p1`;
    const teamaiWorktree = git(cwd, ['worktree', 'list', '--porcelain']).split('\n\n')
      .find((entry) => entry.includes(`branch refs/heads/${left}`))?.match(/^worktree (.+)$/m)?.[1];
    if (teamaiWorktree) git(cwd, ['worktree', 'remove', '--force', teamaiWorktree]);
    git(cwd, ['worktree', 'add', '-q', path.join(root, 'host'), left]);

    await sweepLeftovers(config, null, { now: Date.parse((await state(config, runId)).updatedAt) + 14 * DAY, checkout: cwd });

    expect(branches(origin, runId)).not.toContain('left/p1');
    expect(branches(cwd, runId)).toContain('left/p1');
    expect((await state(config, runId)).leftovers).toMatchObject({ by: 'retention', kept: [{ branch: left, why: 'host' }] });
  });

  it('keeps what a failed run left until the retention passed, then removes it but the pull request branch, once', async () => {
    const { config, cwd, root, origin, runId } = await fixture(FAILS_AFTER_DELIVERY);
    fakeGh(path.join(root, 'gh'));
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    const attempt = run.steps.flatMap((step) => ('attempt' in step && step.attempt ? [step.attempt] : []))[0] ?? '';
    git(cwd, ['update-ref', `refs/teamai/kept/${attempt}`, 'HEAD']);
    git(cwd, ['push', '-q', 'origin', `HEAD:refs/heads/teamai/${runId}/base`]);
    const worktrees = () => git(cwd, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).length;
    expect(branches(origin, runId)).toEqual(['base', 'broken/p1', 'change/p1', 'docs/p1']);
    expect(worktrees()).toBe(2);
    const settled = Date.parse(run.updatedAt);

    expect(await sweepLeftovers(config, null, { now: settled + 13 * DAY, checkout: cwd })).toMatchObject({ swept: [] });
    expect(branches(origin, runId)).toEqual(['base', 'broken/p1', 'change/p1', 'docs/p1']);

    const swept = await sweepLeftovers(config, null, { now: settled + 14 * DAY, checkout: cwd });

    expect(swept.swept).toEqual([expect.objectContaining({
      run: runId, branches: [`teamai/${runId}/base`, `teamai/${runId}/broken/p1`, `teamai/${runId}/docs/p1`], refs: [`refs/teamai/kept/${attempt}`], failed: [],
    })]);
    expect(branches(origin, runId)).toEqual(['change/p1']);
    expect(branches(cwd, runId)).toEqual(['change/p1']);
    expect(worktrees()).toBe(1);
    expect(git(cwd, ['for-each-ref', 'refs/teamai/'])).toBe('');
    expect(await sweepLeftovers(config, null, { now: settled + 15 * DAY, checkout: cwd })).toMatchObject({ swept: [] });
  });

  it('removes on the next doctor --fix a kept ref it could not remove', async () => {
    const { config, cwd, runId } = await fixture(NO_DELIVERY.replace("writeFileSync('join.txt', 'J')", "writeFileSync('join.txt', 'J'); process.exit(1)"));
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    const attempt = run.steps.flatMap((step) => ('attempt' in step && step.attempt ? [step.attempt] : []))[0] ?? '';
    const ref = `refs/teamai/kept/${attempt}`;
    git(cwd, ['update-ref', ref, 'HEAD']);
    const lock = path.join(cwd, '.git', `${ref}.lock`);
    fs.writeFileSync(lock, '');
    const warn = vi.spyOn(log, 'warn');
    const settled = Date.parse(run.updatedAt);

    await sweepLeftovers(config, null, { now: settled + 14 * DAY, checkout: cwd });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Ref ${ref} of run ${runId} was not removed`));
    fs.rmSync(lock);

    expect((await sweepLeftovers(config, null, { now: settled + 15 * DAY, checkout: cwd })).swept).toEqual([expect.objectContaining({ run: runId, refs: [ref] })]);
    expect(git(cwd, ['for-each-ref', 'refs/teamai/'])).toBe('');
  });

  it('removes on the next doctor --fix a worktree on a pull request branch it could not remove', async () => {
    const { config, cwd, root, runId } = await fixture(FAILS_AFTER_DELIVERY);
    fakeGh(path.join(root, 'gh'));
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const dir = path.join(cwd, '.teamai', 'workflow-worktrees', 'inspect-change');
    git(cwd, ['worktree', 'add', '-q', dir, `teamai/${runId}/change/p1`]);
    git(cwd, ['worktree', 'lock', dir]);
    const warn = vi.spyOn(log, 'warn');
    const settled = Date.parse((await state(config, runId)).updatedAt);

    await sweepLeftovers(config, null, { now: settled + 14 * DAY, checkout: cwd });

    expect(fs.existsSync(dir)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Worktree ${dir} of run ${runId} was not removed`));
    git(cwd, ['worktree', 'unlock', dir]);

    expect((await sweepLeftovers(config, null, { now: settled + 15 * DAY, checkout: cwd })).swept).toEqual([expect.objectContaining({ run: runId, worktrees: [dir] })]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(branches(cwd, runId)).toEqual(['change/p1']);
  });

  it('keeps what a run needs that another install claimed and runs again, though it ended here past the retention', async () => {
    const { config, cwd, root, origin, runId } = await fixture(FAILS_LAST);
    shareTeam(config, root);
    expect(await publishRun(config, runId, { checkout: cwd, env: {} })).toMatchObject({ ok: true });
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const ended = await state(config, runId);
    const other = await otherInstall(config, root, origin);
    expect(await claimRun(other.config, runId, { checkout: other.cwd })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(await retryStep(other.config, runId, {}, 'join')).toMatchObject({ data: { reopened: true } });
    const before = branches(origin, runId);
    expect(before).toContain('left/p1');

    await sweepLeftovers(config, null, { now: Date.parse(ended.updatedAt) + 15 * DAY, checkout: cwd });

    expect(branches(origin, runId)).toEqual(before);
  });

  it('goes by until when the run was first kept, though the install that claimed it ended it later, a grace period more, and keeps the pull request branch it delivered', async () => {
    const ready = path.join(os.tmpdir(), `teamai-leftovers-ready-${process.pid}-${Date.now()}`);
    const { config, cwd, root, origin, runId } = await fixture(deliversOnce(ready));
    dirs.push(ready);
    shareTeam(config, root);
    fakeGh(path.join(root, 'gh'));
    expect(await publishRun(config, runId, { checkout: cwd, env: {} })).toMatchObject({ ok: true });
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const ended = await state(config, runId);
    const other = await otherInstall(config, root, origin);
    expect(await claimRun(other.config, runId, { checkout: other.cwd })).toMatchObject({ ok: true });
    expect(await retryStep(other.config, runId, {}, 'join')).toMatchObject({ data: { reopened: true } });
    fs.writeFileSync(ready, '');
    expect(await runLocalDriver(other.config, runId, other.cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const delivered = (await readRun(other.config, runId) as RunState).deliveries?.map((receipt) => receipt.branch);
    expect(delivered).toEqual([`teamai/${runId}/join/p2`]);
    const settled = Date.parse((await readRun(other.config, runId) as RunState).updatedAt);
    const until = Date.parse(ended.updatedAt) + 14 * DAY;
    const before = branches(origin, runId);

    expect(Date.parse(ended.updatedAt)).toBeLessThan(settled);

    await sweepLeftovers(config, null, { now: until + 7 * DAY - 1, checkout: cwd });

    expect(branches(origin, runId)).toEqual(before);

    await sweepLeftovers(config, null, { now: until + 7 * DAY, checkout: cwd });

    expect(branches(origin, runId)).toEqual(['join/p2']);
  });

  it('keeps what a run needs that a retry reopened after its end record reached teamai-reports, swept from another machine', async () => {
    const { config, cwd, root, origin, runId } = await fixture(FAILS_LAST);
    shareTeam(config, root);
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed', record: 'published' } } });
    const ended = await state(config, runId);
    expect(await retryStep(config, runId, {}, 'join')).toMatchObject({ data: { reopened: true } });
    const other = await otherInstall(config, root, origin);
    const before = branches(origin, runId);
    expect(before).toContain('left/p1');

    await sweepLeftovers(other.config, null, { now: Date.parse(ended.updatedAt) + 15 * DAY, checkout: other.cwd });

    expect(branches(origin, runId)).toEqual(before);
  });

  it('leaves a published run alone, with one warning, when teamai-reports cannot be fetched', async () => {
    const { config, cwd, root, origin, runId } = await fixture(FAILS_LAST);
    shareTeam(config, root);
    expect(await publishRun(config, runId, { checkout: cwd, env: {} })).toMatchObject({ ok: true });
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const ended = await state(config, runId);
    const other = await otherInstall(config, root, origin);
    expect(await claimRun(other.config, runId, { checkout: other.cwd })).toMatchObject({ ok: true });
    expect(await retryStep(other.config, runId, {}, 'join')).toMatchObject({ data: { reopened: true } });
    const before = branches(origin, runId);
    fs.renameSync(config.repo.remote, `${config.repo.remote}.offline`);
    const warn = vi.spyOn(log, 'warn');

    expect(await sweepLeftovers(config, null, { now: Date.parse(ended.updatedAt) + 15 * DAY, checkout: cwd })).toMatchObject({ swept: [] });

    expect(branches(origin, runId)).toEqual(before);
    const skipped = warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('teamai-reports'));
    expect(skipped).toEqual([expect.stringMatching(/^teamai-reports could not be fetched from origin \(.+\), so runs published there are not swept this time\. teamai doctor --fix tries again\.$/)]);
  });

  it('sweeps without a warning about teamai-reports when origin has none', async () => {
    const { config, cwd, root, origin, runId } = await fixture(FAILS_LAST);
    shareTeam(config, root);
    config.usageReportEnabled = false;
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const ended = await state(config, runId);
    await sweepLeftovers(config, null, { now: Date.parse(ended.updatedAt), checkout: cwd });
    const warn = vi.spyOn(log, 'warn');

    expect((await sweepLeftovers(config, null, { now: Date.parse(ended.updatedAt) + 15 * DAY, checkout: cwd })).swept).toEqual([expect.objectContaining({ run: runId })]);

    expect(branches(origin, runId)).toEqual([]);
    expect(warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('teamai-reports'))).toEqual([]);
  });

  it('leaves a published run alone while another teamai process writes teamai-reports', async () => {
    const { config, cwd, root, origin, runId } = await fixture(FAILS_LAST);
    shareTeam(config, root);
    expect(await publishRun(config, runId, { checkout: cwd, env: {} })).toMatchObject({ ok: true });
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const ended = await state(config, runId);
    const before = branches(origin, runId);
    const lock = path.join(path.dirname(getReportsDir(config)), REPORTS_LOCK_FILENAME);
    expect(await acquireLock(lock)).toBe(true);
    const warn = vi.spyOn(log, 'warn');

    try {
      expect(await sweepLeftovers(config, null, { now: Date.parse(ended.updatedAt) + 15 * DAY, checkout: cwd })).toMatchObject({ swept: [] });
    } finally {
      await releaseLock(lock);
    }

    expect(branches(origin, runId)).toEqual(before);
    expect(warn).toHaveBeenCalledWith(`teamai-reports is being written by another teamai process (${lock} is held), so runs published there are not swept this time. teamai doctor --fix tries again.`);
  });

  it('does not reopen a run while doctor --fix removes its branches', async () => {
    const { config, cwd, root, runId } = await fixture(FAILS_LAST);
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const ended = await state(config, runId);
    const release = pausesOn(root, '--delete');

    const sweeping = sweepLeftovers(config, null, { now: Date.parse(ended.updatedAt) + 15 * DAY, checkout: cwd });
    await release.reached();

    expect(await retryStep(config, runId, {}, 'join')).toEqual({ error: {
      code: 'busy', message: `Cleanup of run ${runId} is removing its branches, so it was not reopened. Try again shortly: teamai workflow retry ${runId} join`,
    } });
    release.go();
    expect((await sweeping).swept).toEqual([expect.objectContaining({ run: runId })]);
    expect(await state(config, runId)).toMatchObject({ status: 'failed', revision: ended.revision });
  });

  it('keeps every run with workflows.retention never', async () => {
    const { config, cwd, origin, runId } = await fixture(NO_DELIVERY.replace("writeFileSync('join.txt', 'J')", "writeFileSync('join.txt', 'J'); process.exit(1)"));
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    config.workflows = { tools: {}, retention: 'never' };

    expect(await sweepLeftovers(config, null, { now: Date.now() + 365 * DAY, checkout: cwd })).toMatchObject({ retention: { kind: 'never' }, swept: [] });
    expect(branches(origin, runId)).toEqual(['join/p1', 'left/p1']);
  });

  it('does not report a worktree it could not remove, and names it on the branch it leaves', async () => {
    const { config, cwd, runId } = await fixture(NO_DELIVERY.replace("writeFileSync('join.txt', 'J')", "writeFileSync('join.txt', 'J'); process.exit(1)"));
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const dir = git(cwd, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length)).find((at) => at !== cwd) ?? '';
    git(cwd, ['worktree', 'lock', dir]);
    vi.spyOn(log, 'warn');

    const swept = await sweepLeftovers(config, null, { now: Date.parse((await state(config, runId)).updatedAt) + 14 * DAY, checkout: cwd });

    expect(swept.swept).toEqual([expect.objectContaining({
      run: runId, worktrees: [], failed: [{ branch: `teamai/${runId}/join/p1`, reason: expect.stringContaining(`worktree ${dir} was not removed`) }],
    })]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('deletes again what a succeeded run could not delete as it settled', async () => {
    const { config, cwd, origin, runId } = await fixture(NO_DELIVERY);
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$new" in 0000000000000000000000000000000000000000) exit 1;; esac; done\n');
    fs.chmodSync(hook, 0o755);
    vi.spyOn(log, 'warn');
    await runLocalDriver(config, runId, cwd);
    expect(branches(origin, runId)).toEqual(['join/p1', 'left/p1']);
    fs.rmSync(hook);

    await sweepLeftovers(config, null, { now: Date.now(), checkout: cwd });

    expect(branches(origin, runId)).toEqual(['join/p1']);
    expect((await state(config, runId)).leftovers).toMatchObject({ by: 'success', failed: [] });
  });

  it('removes the branches on origin of a run another machine started, from its record on teamai-reports, but its pull request branch', async () => {
    const { config, cwd, origin } = await fixture(NO_DELIVERY);
    const ran = 'r0123456789abcdef';
    const recent = 'rfedcba9876543210';
    for (const branch of [`teamai/${ran}/build-0/p1`, `teamai/${ran}/change/p1`, `teamai/${ran}/base`, `teamai/${recent}/change/p1`]) git(cwd, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
    const http: LocalConfig = { ...config, repo: { ...config.repo, kind: 'http' } };
    const records = path.join(getReportsDir(http), 'workflows', 'runs');
    fs.mkdirSync(records, { recursive: true });
    const now = Date.parse('2026-11-03T12:00:00.000Z');
    const record = (run: string, endedAt: string, extra: object) => fs.writeFileSync(path.join(records, `${run}.json`), JSON.stringify({
      schemaVersion: 'v1alpha1', run, workflow: 'ship-issue', phase: 'end', status: 'failed', startedAt: endedAt, endedAt, username: 'ci', publishedAt: endedAt, ...extra,
    }));
    record(ran, '2026-10-01T12:00:00.000Z', { retainedUntil: '2026-10-15T12:00:00.000Z', prs: ['https://github.com/fixture/app/pull/1'], prBranches: [`teamai/${ran}/change/p1`] });
    record(recent, '2026-10-20T12:00:00.000Z', { retainedUntil: '2026-11-03T12:00:00.000Z' });

    const swept = await sweepLeftovers(http, null, { now, checkout: cwd });

    expect(swept.swept).toEqual([expect.objectContaining({ run: ran, from: 'teamai-reports', branches: [`teamai/${ran}/base`, `teamai/${ran}/build-0/p1`] })]);
    expect(branches(origin, ran)).toEqual(['change/p1']);
    expect(branches(origin, recent)).toEqual(['change/p1']);
  });

  it('warns naming a run record on teamai-reports it cannot read, and sweeps the others', async () => {
    const { config, cwd, origin } = await fixture(NO_DELIVERY);
    const ran = 'r0123456789abcdef';
    git(cwd, ['push', '-q', 'origin', `HEAD:refs/heads/teamai/${ran}/build-0/p1`]);
    const http: LocalConfig = { ...config, repo: { ...config.repo, kind: 'http' } };
    const records = path.join(getReportsDir(http), 'workflows', 'runs');
    fs.mkdirSync(records, { recursive: true });
    const endedAt = '2026-10-01T12:00:00.000Z';
    fs.writeFileSync(path.join(records, `${ran}.json`), JSON.stringify({ schemaVersion: 'v1alpha1', run: ran, workflow: 'ship', phase: 'end', status: 'failed', startedAt: endedAt, endedAt, retainedUntil: '2026-10-15T12:00:00.000Z', username: 'ci', publishedAt: endedAt }));
    const broken = path.join(records, 'rfedcba9876543210.json');
    fs.writeFileSync(broken, '{"run":');
    const warn = vi.spyOn(log, 'warn');

    const swept = await sweepLeftovers(http, null, { now: Date.parse('2026-11-03T12:00:00.000Z'), checkout: cwd });

    expect(swept.swept).toEqual([expect.objectContaining({ run: ran, branches: [`teamai/${ran}/build-0/p1`] })]);
    expect(branches(origin, ran)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^Run record ${broken} was not read \\(.+\\), so what its run left is not removed\\.$`)));
  });
});

describe('a run that settled longer ago than workflows.retention', () => {
  it('is not reopened by a retry, which names the command that starts the workflow again', async () => {
    const { config, cwd, runId } = await fixture(FAILS_LAST);
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const ended = await state(config, runId);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(ended.updatedAt) + 14 * DAY);

    try {
      expect(await retryStep(config, runId, {}, 'join')).toEqual({ error: {
        code: 'run_expired',
        message: `Run ${runId} was not reopened: workflows.retention kept what it left until ${new Date(Date.parse(ended.updatedAt) + 14 * DAY).toISOString()}, counted from when it first ended, so teamai doctor --fix may have removed its branches. Start the workflow again: teamai workflow start ship`,
      } });
    } finally {
      vi.useRealTimers();
    }

    expect(await state(config, runId)).toEqual(ended);
  });

  it('counts from when the run first ended, though a retry since ended it again', async () => {
    const { config, cwd, root, runId } = await fixture(FAILS_LAST);
    shareTeam(config, root);
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed', record: 'published' } } });
    const ended = await state(config, runId);
    const until = Date.parse(ended.updatedAt) + 14 * DAY;
    config.usageReportEnabled = false;
    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      vi.setSystemTime(until - DAY);
      expect(await retryStep(config, runId, {}, 'join')).toMatchObject({ data: { reopened: true } });
      expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
      expect((await state(config, runId)).retainedUntil).toBe(new Date(until).toISOString());

      vi.setSystemTime(until);
      expect(await retryStep(config, runId, {}, 'join')).toMatchObject({ error: { code: 'run_expired' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes with its end until when it is kept, and nothing under workflows.retention never', async () => {
    const { config, cwd, root, runId } = await fixture(FAILS_LAST);
    shareTeam(config, root);
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed', record: 'published' } } });
    const record = JSON.parse(git(config.repo.remote, ['show', `teamai-reports:workflows/runs/${runId}.json`])) as { endedAt: string; retainedUntil?: string };
    expect(record.retainedUntil).toBe(new Date(Date.parse(record.endedAt) + 14 * DAY).toISOString());

    const never = await fixture(FAILS_LAST);
    never.config.workflows = { tools: {}, retention: 'never' };
    expect(await runLocalDriver(never.config, never.runId, never.cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect((await state(never.config, never.runId)).retainedUntil).toBeUndefined();
  });

  it('is swept from another machine only a week after it was kept until', async () => {
    const { config, cwd, root, origin, runId } = await fixture(FAILS_LAST);
    shareTeam(config, root);
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed', record: 'published' } } });
    const until = Date.parse((await state(config, runId)).retainedUntil ?? '');
    const other = await otherInstall(config, root, origin);

    expect((await sweepLeftovers(other.config, null, { now: until + 7 * DAY - 1, checkout: other.cwd })).swept).toEqual([]);
    expect(branches(origin, runId)).toEqual(['join/p1', 'left/p1']);

    expect((await sweepLeftovers(other.config, null, { now: until + 7 * DAY, checkout: other.cwd })).swept)
      .toEqual([expect.objectContaining({ run: runId, from: 'teamai-reports' })]);
    expect(branches(origin, runId)).toEqual([]);
  });

  it('is never swept from another machine when its record says nothing of until when it is kept', async () => {
    const { config, cwd, origin } = await fixture(NO_DELIVERY);
    const ran = 'r0123456789abcdef';
    git(cwd, ['push', '-q', 'origin', `HEAD:refs/heads/teamai/${ran}/left/p1`]);
    const http: LocalConfig = { ...config, repo: { ...config.repo, kind: 'http' } };
    const records = path.join(getReportsDir(http), 'workflows', 'runs');
    fs.mkdirSync(records, { recursive: true });
    const endedAt = '2025-01-01T12:00:00.000Z';
    fs.writeFileSync(path.join(records, `${ran}.json`), JSON.stringify({ schemaVersion: 'v1alpha1', run: ran, workflow: 'ship', phase: 'end', status: 'failed', startedAt: endedAt, endedAt, username: 'ci', publishedAt: endedAt }));

    expect((await sweepLeftovers(http, null, { now: Date.parse('2026-11-03T12:00:00.000Z'), checkout: cwd })).swept).toEqual([]);
    expect(branches(origin, ran)).toEqual(['left/p1']);
  });

  it('is never swept from another machine when its settled snapshot says nothing of until when it is kept, though its record does', async () => {
    const { config, cwd, root, origin, runId } = await fixture(FAILS_LAST);
    shareTeam(config, root);
    expect(await publishRun(config, runId, { checkout: cwd, env: {} })).toMatchObject({ ok: true });
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed', record: 'published' } } });
    const until = Date.parse((await state(config, runId)).retainedUntil ?? '');
    // A snapshot an older teamai wrote as it settled the run again, which publishes no retainedUntil.
    const reports = path.join(root, 'older-writer');
    git(root, ['clone', '-q', '-b', 'teamai-reports', config.repo.remote, reports]);
    const snapshot = path.join(reports, 'workflows', 'runs', runId, 'state.json');
    const { retainedUntil: _dropped, ...older } = JSON.parse(fs.readFileSync(snapshot, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(snapshot, JSON.stringify(older, null, 2));
    git(reports, ['commit', '-qam', 'older settle']);
    git(reports, ['push', '-q', 'origin', 'teamai-reports']);
    const other = await otherInstall(config, root, origin);
    const before = branches(origin, runId);
    expect(before).toContain('left/p1');

    expect((await sweepLeftovers(other.config, null, { now: until + 7 * DAY, checkout: other.cwd })).swept).toEqual([]);
    expect(branches(origin, runId)).toEqual(before);
  });

  it('is swept from another machine by the record origin holds, though an interrupted write left an older one in its checkout', async () => {
    const ready = path.join(os.tmpdir(), `teamai-leftovers-ready-${process.pid}-${Date.now()}`);
    const { config, cwd, root, origin, runId } = await fixture(deliversOnce(ready));
    dirs.push(ready);
    shareTeam(config, root);
    fakeGh(path.join(root, 'gh'));
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed', record: 'published' } } });
    const until = Date.parse((await state(config, runId)).retainedUntil ?? '');
    const other = await otherInstall(config, root, origin);
    await sweepLeftovers(other.config, null, { now: Date.now(), checkout: other.cwd });
    fs.appendFileSync(path.join(getReportsDir(other.config), 'workflows', 'runs', `${runId}.json`), '\n');
    fs.writeFileSync(ready, '');
    expect(await retryStep(config, runId, {}, 'join')).toMatchObject({ data: { reopened: true } });
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded', record: 'published' } } });

    await sweepLeftovers(other.config, null, { now: until + 7 * DAY, checkout: other.cwd });

    expect(branches(origin, runId)).toEqual(['join/p2']);
  });
});

const CHOOSES = `schemaVersion: v1alpha1
name: ship
description: A branch, a choice, and a branch after it.
steps:
  - id: change
    workspace: new
    command: node -e "require('fs').writeFileSync('change.txt', 'C')"
  - id: decide
    needs: [change]
    choose: { message: Continue?, options: [yes, no], default: yes }
  - id: join
    needs: [decide]
    workspace: new
    command: node -e "require('fs').writeFileSync('join.txt', 'J')"
`;

describe('a retry of a run that succeeded', () => {
  it('does not reopen the run while it deletes its branches', async () => {
    const { config, cwd, root, runId } = await fixture(CHOOSES);
    vi.spyOn(log, 'warn');
    const release = pausesOn(root, 'push .*--delete');

    const driving = runLocalDriver(config, runId, cwd, { autoApprove: true });
    await release.reached();

    expect(await retryStep(config, runId, {}, 'decide')).toEqual({ error: {
      code: 'busy', message: `Cleanup of run ${runId} is removing its branches, so it was not reopened. Try again shortly: teamai workflow retry ${runId} decide`,
    } });
    release.go();
    expect(await driving).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(await state(config, runId)).toMatchObject({ status: 'succeeded', leftovers: { by: 'success', failed: [] } });
  });

  it('brings back the branches its cleanup deleted, so the run publishes its end again', async () => {
    const { config, cwd, root, origin, runId } = await fixture(CHOOSES);
    shareTeam(config, root);
    expect(await runLocalDriver(config, runId, cwd, { autoApprove: true })).toMatchObject({ data: { done: { outcome: 'succeeded', record: 'published' } } });
    const change = `teamai/${runId}/change/p1`;
    const tip = (await state(config, runId)).copies?.[change]?.commit;
    expect(branches(origin, runId)).toEqual(['join/p1']);

    expect(await retryStep(config, runId, {}, 'decide')).toMatchObject({ data: { reopened: true } });
    expect(git(origin, ['rev-parse', `refs/heads/${change}`])).toBe(tip);
    expect(git(cwd, ['rev-parse', `refs/heads/${change}`])).toBe(tip);

    const again = await runLocalDriver(config, runId, cwd, { autoApprove: true });
    expect(again).toMatchObject({ data: { done: { outcome: 'succeeded', record: 'published' } } });
    expect(again).not.toMatchObject({ data: { done: { notPublished: expect.anything() } } });
  });

  it('is published after its cleanup, and another install that claims it brings the deleted branch back on a retry', async () => {
    const { config, cwd, root, origin, runId } = await fixture(CHOOSES);
    shareTeam(config, root);
    expect(await runLocalDriver(config, runId, cwd, { autoApprove: true })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(branches(origin, runId)).toEqual(['join/p1']);

    // Publishing pins the base, as every publish does, and brings back no deleted branch.
    expect(await publishRun(config, runId, { checkout: cwd, env: {} })).toMatchObject({ ok: true });
    expect(branches(origin, runId)).toEqual(['base', 'join/p1']);

    const other = await otherInstall(config, root, origin);
    expect(await claimRun(other.config, runId, { checkout: other.cwd })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(await retryStep(other.config, runId, {}, 'decide')).toMatchObject({ data: { reopened: true } });
    expect(branches(origin, runId)).toEqual(['base', 'change/p1', 'join/p1']);
  });

  it('brings back on origin a branch its cleanup deleted there only, since the host had it checked out here', async () => {
    const { config, cwd, root, origin, runId } = await fixture(CHOOSES);
    shareTeam(config, root);
    const change = `teamai/${runId}/change/p1`;
    const release = pausesOn(root, 'push .*--delete');
    const driving = runLocalDriver(config, runId, cwd, { autoApprove: true });
    await release.reached();
    git(cwd, ['worktree', 'add', '-q', path.join(root, 'host'), change]);
    release.go();
    expect(await driving).toMatchObject({ data: { done: { outcome: 'succeeded', record: 'published' } } });
    const tip = (await state(config, runId)).copies?.[change]?.commit;
    expect(branches(origin, runId)).toEqual(['join/p1']);

    expect(await retryStep(config, runId, {}, 'decide')).toMatchObject({ data: { reopened: true } });
    expect(git(origin, ['rev-parse', `refs/heads/${change}`])).toBe(tip);

    const again = await runLocalDriver(config, runId, cwd, { autoApprove: true });
    expect(again).toMatchObject({ data: { done: { outcome: 'succeeded', record: 'published' } } });
    expect(again).not.toMatchObject({ data: { done: { notPublished: expect.anything() } } });
  });

  it('brings back the branches its cleanup deleted on the install that claimed the run since', async () => {
    const { config, cwd, root, origin, runId } = await fixture(CHOOSES);
    shareTeam(config, root);
    expect(await publishRun(config, runId, { checkout: cwd, env: {} })).toMatchObject({ ok: true });
    expect(await runLocalDriver(config, runId, cwd, { autoApprove: true })).toMatchObject({ data: { done: { outcome: 'succeeded', record: 'published' } } });
    const change = `teamai/${runId}/change/p1`;
    const tip = (await state(config, runId)).copies?.[change]?.commit;
    expect(branches(origin, runId)).toEqual(['join/p1']);
    const other = await otherInstall(config, root, origin);
    expect(await claimRun(other.config, runId, { checkout: other.cwd })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });

    expect(await retryStep(other.config, runId, {}, 'decide')).toMatchObject({ data: { reopened: true } });
    expect(git(origin, ['rev-parse', `refs/heads/${change}`])).toBe(tip);

    const again = await runLocalDriver(other.config, runId, other.cwd, { autoApprove: true });
    expect(again).toMatchObject({ data: { done: { outcome: 'succeeded', record: 'published' } } });
    expect(again).not.toMatchObject({ data: { done: { notPublished: expect.anything() } } });
  });

  it('is refused while origin refuses a branch back, naming it, and reopens the run once it takes it', async () => {
    const { config, cwd, origin, runId } = await fixture(CHOOSES);
    expect(await runLocalDriver(config, runId, cwd, { autoApprove: true })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const settled = await state(config, runId);
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$old" in 0000000000000000000000000000000000000000) echo "creating is not allowed" >&2; exit 1;; esac; done\n');
    fs.chmodSync(hook, 0o755);

    const refused = await retryStep(config, runId, {}, 'decide');
    expect(refused).toEqual({ error: { code: 'branches_not_restored', message: expect.stringMatching(new RegExp(
      `^Run ${runId} was not reopened: not every branch the run recorded is back at the commit it recorded\\. Branch teamai/${runId}/change/p1 is not back on origin: .*creating is not allowed.*\\. Try again once that is fixed: teamai workflow retry ${runId} decide$`, 's',
    )) } });
    expect(await state(config, runId)).toEqual(settled);
    expect(branches(origin, runId)).toEqual(['join/p1']);
    expect(branches(cwd, runId)).toEqual(['join/p1']);

    fs.rmSync(hook);
    expect(await retryStep(config, runId, {}, 'decide')).toMatchObject({ data: { reopened: true } });
    expect(branches(origin, runId)).toEqual(['change/p1', 'join/p1']);
    expect((await state(config, runId)).leftovers).toBeUndefined();
  });

  it('brings nothing back when it is refused for another reason', async () => {
    const { config, cwd, origin, runId } = await fixture(CHOOSES);
    expect(await runLocalDriver(config, runId, cwd, { autoApprove: true })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    expect(await retryStep(config, runId, {}, 'join')).toMatchObject({ error: { code: 'not_retryable' } });
    expect(branches(origin, runId)).toEqual(['join/p1']);
    expect(branches(cwd, runId)).toEqual(['join/p1']);
  });

  it('does not move a branch made again at another commit, and names it', async () => {
    const { config, cwd, origin, runId } = await fixture(CHOOSES);
    expect(await runLocalDriver(config, runId, cwd, { autoApprove: true })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const change = `teamai/${runId}/change/p1`;
    const other = git(cwd, ['rev-parse', 'main']);
    git(cwd, ['push', '-q', 'origin', `${other}:refs/heads/${change}`]);

    expect(await retryStep(config, runId, {}, 'decide')).toMatchObject({ error: {
      code: 'branches_not_restored',
      message: expect.stringContaining(`Branch ${change} is not back on origin: it is at ${other}, not at commit ${(await state(config, runId)).copies?.[change]?.commit} the run recorded, and teamai does not move it.`),
    } });
    expect(git(origin, ['rev-parse', `refs/heads/${change}`])).toBe(other);
    expect((await state(config, runId)).status).toBe('succeeded');
  });

  it('reopens the run when a retry stopped after a branch came back on origin only', async () => {
    const { config, cwd, origin, runId } = await fixture(CHOOSES);
    expect(await runLocalDriver(config, runId, cwd, { autoApprove: true })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const change = `teamai/${runId}/change/p1`;
    const tip = (await state(config, runId)).copies?.[change]?.commit ?? '';
    git(origin, ['update-ref', `refs/heads/${change}`, tip]);

    expect(await retryStep(config, runId, {}, 'decide')).toMatchObject({ data: { reopened: true } });
    expect(git(cwd, ['rev-parse', `refs/heads/${change}`])).toBe(tip);
    expect(git(origin, ['rev-parse', `refs/heads/${change}`])).toBe(tip);
  });
});
