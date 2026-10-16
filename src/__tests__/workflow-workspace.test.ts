/**
 * Workspaces: a command with no workspace is read-only, `new` steps get distinct
 * branches, a later step merges them, and `continue` stays with the driver that opened it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { runLocalDriver } from '../workflow/local-driver.js';
import { parseWorkflow } from '../workflow/parse.js';
import { readRun } from '../workflow/store.js';
import type { DriverIdentity } from '../workflow/types.js';
import { branchName } from '../workflow/workspace.js';
import { worktreePath } from '../workflow/worktree.js';

const dirs: string[] = [];

async function fixture(yaml: string, inputs?: unknown): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workspace-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(workspace);
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'clean\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: workspace });
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: workspace,
    dataHome: path.join(root, 'data'),
    workflows: { tools: {}, max_parallel: 2 },
  };
  fs.writeFileSync(path.join(knowledge, 'workflows', 'build.yaml'), yaml);
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, 'build', inputs);
  if ('error' in started) throw new Error(started.error.message);
  return { config, workspace, runId: String(started.data.run) };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const driver = (workspace: string, machine = 'host'): DriverIdentity => ({ kind: 'local', machine, workspace });

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow workspaces', () => {
  it('keeps a literal hyphen distinct from a for_each index in branch names', () => {
    expect(branchName('run', 'foo-1', 1)).not.toBe(branchName('run', 'foo[1]', 1));
    expect(branchName('run', 'foo_1', 1)).not.toBe(branchName('run', 'foo[1]', 1));
    expect(branchName('run', 'foo[1]', 1)).toBe('teamai/run/foo-1/p1');
    expect(worktreePath('/repo', branchName('run', 'foo-1', 1))).not.toBe(
      worktreePath('/repo', branchName('run', 'foo[1]', 1)),
    );
  });

  it('rejects a session.from that is not a need, and one that names a for_each', () => {
    const parsed = parseWorkflow('workflows/build.yaml', `schemaVersion: v1alpha1
name: build
description: Bad session references.
steps:
  - id: build
    for_each:
      items: inputs.names
    command: echo build
  - id: ask
    needs: []
    prompt: Review
    session:
      from: build
`);
    if (parsed.ok) throw new Error('expected session.from of a for_each to fail');
    expect(parsed.diagnostics.map((item) => item.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('for_each'),
    ]));
    const missing = parseWorkflow('workflows/build.yaml', `schemaVersion: v1alpha1
name: build
description: A session that names a step this one does not need.
steps:
  - id: one
    command: echo one
  - id: two
    needs: []
    prompt: Review
    session:
      from: one
`);
    if (missing.ok) throw new Error('expected session.from of a step that is not a need to fail');
    expect(missing.diagnostics.map((item) => item.code)).toContain('bad_session');
  });

  it('fails a command with no workspace when it changes the checkout, and leaves the file', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A read-only command.
steps:
  - id: write
    command: node -e "require('fs').writeFileSync('dirty.txt', 'x')"
`);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty' } }],
    });
    expect(fs.readFileSync(path.join(workspace, 'dirty.txt'), 'utf8')).toBe('x');
  });

  it('gives parallel new steps distinct branches and merges them into the step that needs both', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Two change branches joined by a third.
inputs:
  names: [string]
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('left.txt', 'L')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('right.txt', 'R')"
  - id: join
    needs: [left, right]
    workspace: new
    command: node -e "const fs=require('fs'); if (fs.readFileSync('left.txt','utf8')!=='L' || fs.readFileSync('right.txt','utf8')!=='R') process.exit(1); fs.writeFileSync('joined.txt','J')"
  - id: fan
    needs: [join]
    for_each:
      items: inputs.names
    workspace: new
    command: node -e "require('fs').writeFileSync('item.txt', process.env.NAME)"
    env:
      NAME: "{{ item }}"
`, { names: ['a', 'b'] });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(git(['status', '--porcelain'], workspace)).toBe('');
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const join = run.steps.find((step) => step.id === 'join');
    const fan = run.steps.find((step) => step.id === 'fan');
    expect(join && 'changes' in join && join.changes?.commits.length).toBeGreaterThan(0);
    expect(fan && 'results' in fan && fan.results?.map((item) => item.branch)).toEqual([
      expect.stringMatching(/\/fan-0\/p1$/),
      expect.stringMatching(/\/fan-1\/p1$/),
    ]);
    const branch = join && 'changes' in join ? join.changes?.branch : undefined;
    expect(git(['show', `${branch}:joined.txt`], workspace)).toBe('J');
    expect(git(['show', `${branch}:left.txt`], workspace)).toBe('L');
    expect(git(['show', `${branch}:right.txt`], workspace)).toBe('R');
  });

  it('does not lease a continue step to a driver that does not own the copy', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Continue stays with the driver that opened the workspace.
steps:
  - id: edit
    workspace: new
    workflow:
      steps:
        - id: first
          workspace: continue
          command: echo first
        - id: more
          needs: [first]
          workspace: continue
          command: echo more
`);
    const owner = driver(workspace);
    const base = { ref: 'HEAD', commit: git(['rev-parse', 'HEAD'], workspace).trim() };
    const modes = ['read-only', 'new', 'continue'] as const;
    const leased = await leaseNext(config, runId, owner, { base, workspaceModes: [...modes] });
    const lease = 'data' in leased ? leased.data.lease as { attempt: string; revision: number; step: string; workspace?: { branch: string } } : undefined;
    if (!lease?.workspace) throw new Error(JSON.stringify(leased));
    expect(lease.step).toBe('edit.first');
    await reportAttempt(config, runId, {
      attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: owner,
      changes: { branch: lease.workspace.branch, base: base.commit, from: base.commit, to: base.commit, commits: [] },
    });

    const other = await leaseNext(config, runId, driver(workspace, 'other'), { base, workspaceModes: [...modes] });

    expect(other).toMatchObject({ data: { wait: { reason: expect.stringContaining('another driver') } } });
  });

  it('merges a parent dependency into the first child that continues its copy', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: The first child receives the branch its parent needs.
steps:
  - id: prepare
    workspace: new
    command: node -e "require('fs').writeFileSync('prepared.txt','yes')"
  - id: work
    needs: [prepare]
    workspace: new
    workflow:
      steps:
        - id: check
          workspace: continue
          command: node -e "const fs=require('fs'); if(fs.readFileSync('prepared.txt','utf8')!=='yes') process.exit(1); fs.writeFileSync('checked.txt','yes')"
`);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const check = typeof run === 'object' ? run.steps.find((step) => step.id === 'work.check') : undefined;
    const branch = check && 'changes' in check ? check.changes?.branch : undefined;
    expect(git(['show', `${branch}:prepared.txt`], workspace)).toBe('yes');
    expect(git(['show', `${branch}:checked.txt`], workspace)).toBe('yes');
  });

  it('starts a new workspace at the newest commit when two needs continued one branch', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A new child uses the newest commit from a continued branch.
steps:
  - id: work
    workspace: new
    workflow:
      steps:
        - id: first
          workspace: continue
          command: node -e "require('fs').writeFileSync('first.txt','yes')"
        - id: second
          needs: [first]
          workspace: continue
          command: node -e "require('fs').writeFileSync('second.txt','yes')"
        - id: join
          needs: [second, first]
          workspace: new
          command: node -e "const fs=require('fs'); if(fs.readFileSync('second.txt','utf8')!=='yes') process.exit(1)"
`);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('carries session continue from the previous pass', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Resume the same session on the next pass.
steps:
  - id: ask
    prompt: Review this project.
    session: continue
    loop: { back_to: ask, max_iterations: 2 }
`);
    const who = driver(workspace);
    const first = await leaseNext(config, runId, who);
    const lease = 'data' in first ? first.data.lease as { attempt: string; revision: number; session?: unknown } : undefined;
    if (!lease) throw new Error(JSON.stringify(first));
    expect(lease.session).toBeUndefined();
    await reportAttempt(config, runId, {
      attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: who, tool: 'claude', session: 'session-1',
    });

    const second = await leaseNext(config, runId, who);

    expect(second).toMatchObject({ data: { lease: { step: 'ask', pass: 2, session: { tool: 'claude', id: 'session-1' } } } });
  });

  it('runs a later step on the base agent configuration, so a hook an earlier step committed is absent', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A later step does not see a hook committed earlier.
steps:
  - id: work
    workspace: new
    workflow:
      steps:
        - id: plant
          workspace: continue
          command: node -e "const fs=require('fs'); fs.mkdirSync('.githooks',{recursive:true}); fs.writeFileSync('.githooks/pre-commit','#!/bin/sh\\n'); fs.mkdirSync('.cursor',{recursive:true}); fs.writeFileSync('.cursor/earlier.txt','earlier')"
        - id: check
          needs: [plant]
          workspace: continue
          command: node -e "const fs=require('fs'); if (fs.existsSync('.githooks/pre-commit') || fs.existsSync('.cursor/earlier.txt')) process.exit(2); fs.mkdirSync('.cursor',{recursive:true}); fs.writeFileSync('.cursor/later.txt','later'); fs.writeFileSync('ok.txt','yes')"
`);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const check = typeof run === 'object' ? run.steps.find((step) => step.id === 'work.check') : undefined;
    const branch = check && 'changes' in check ? check.changes?.branch : undefined;
    expect(git(['show', `${branch}:ok.txt`], workspace)).toBe('yes');
    expect(git(['show', `${branch}:.githooks/pre-commit`], workspace)).toContain('#!/bin/sh');
    expect(git(['show', `${branch}:.cursor/earlier.txt`], workspace)).toBe('earlier');
    expect(git(['show', `${branch}:.cursor/later.txt`], workspace)).toBe('later');
    expect(fs.existsSync(worktreePath(workspace, branch!))).toBe(false);
  });
});
