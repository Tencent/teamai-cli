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
import { log } from '../utils/logger.js';
import { fakeGh } from './helpers/fake-gh.js';
import type { LocalConfig } from '../types.js';
import type { RunState } from '../workflow/types.js';

_setDriverPollMs(20);

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
  await syncWorkflowDefinitions(config);
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

  it('keeps the final copy of a run that delivered nothing', async () => {
    const { config, cwd, origin, runId } = await fixture(NO_DELIVERY);

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    expect(branches(origin, runId)).toEqual(['join/p1']);
    expect(git(origin, ['show', `teamai/${runId}/join/p1:left.txt`])).toBe('L');
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

  it('leaves a branch checked out where the host put it in the checkout, without a warning', async () => {
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
  });
});
