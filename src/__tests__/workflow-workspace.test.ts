/**
 * Workspaces: a command with no workspace is read-only, `new` steps get distinct
 * branches, a later step merges them, and `continue` stays with the driver that opened it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProjectConfig, loadStateForScope } from '../config.js';
import { resolveAnchors } from '../utils/git.js';
import { resolvePartitionDir } from '../utils/partition.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { runLocalDriver } from '../workflow/local-driver.js';
import type { LocalToolAdapter } from '../workflow/local-tool-adapter.js';
import { parseWorkflow } from '../workflow/parse.js';
import { readRun } from '../workflow/store.js';
import type { DriverIdentity } from '../workflow/types.js';
import { branchName } from '../workflow/workspace.js';
import { pushIfOrigin, worktreePath } from '../workflow/worktree.js';

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

  it('delivers a team skill into a new workspace and leaves it out of the branch', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workspace-')));
    dirs.push(root);
    const workspace = path.join(root, 'workspace');
    const knowledge = path.join(workspace, '.teamai');
    fs.mkdirSync(path.join(knowledge, 'skills', 'fe-skill'), { recursive: true });
    fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), [
      'team: workspace',
      'mode: self',
      'repo: https://git.example.com/team/workspace.git',
      'provider: git',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(knowledge, '.gitignore'), 'config.yaml\nstate.json\n');
    fs.writeFileSync(path.join(knowledge, 'skills', 'fe-skill', 'SKILL.md'), '---\nname: fe-skill\ndescription: fixture\n---\n\nTeam skill.\n');
    fs.writeFileSync(path.join(knowledge, 'workflows', 'build.yaml'), `schemaVersion: v1alpha1
name: build
description: Read the delivered team skill.
steps:
  - id: ask
    workspace: new
    prompt: Read the team skill.
`);
    fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'clean\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
    execFileSync('git', ['add', '-A'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], { cwd: workspace });
    const anchors = await resolveAnchors(workspace);
    if (!anchors) throw new Error('the workspace has no git anchors');
    const partition = await resolvePartitionDir(anchors.projectAnchor);
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(path.join(partition, 'config.yaml'), [
      'repo:',
      `  localPath: ${knowledge}`,
      '  remote: https://git.example.com/team/workspace.git',
      '  kind: self',
      `  businessRepoRoot: ${workspace}`,
      'username: tester',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${workspace}`,
      'enabledAgents: [claude]',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(workspace, '.claude'));
    const { pull } = await import('../pull.js');
    await pull({ silent: true, cwd: workspace });
    const config = await detectProjectConfig(workspace);
    if (!config) throw new Error('project config was not found');
    config.workflows = { tools: { default: 'claude' }, max_parallel: 1 };
    await syncWorkflowDefinitions(config);
    const started = await startRun(config, 'build');
    if ('error' in started) throw new Error(started.error.message);
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        const file = path.join(input.cwd, '.claude', 'skills', 'fe-skill', 'SKILL.md');
        if (!fs.existsSync(file)) return { started: false, exitCode: 1, failure: { code: 'missing_skill', message: `missing ${file}` } };
        return { started: true, exitCode: 0, output: { skill: fs.readFileSync(file, 'utf8') } };
      },
    };

    const done = await runLocalDriver(config, String(started.data.run), workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, String(started.data.run));
    const ask = typeof run === 'object' ? run.steps.find((step) => step.id === 'ask') : undefined;
    expect(ask && 'outputs' in ask ? ask.outputs : undefined).toMatchObject({ skill: expect.stringContaining('Team skill.') });
    const branch = ask && 'changes' in ask ? ask.changes?.branch : undefined;
    expect(() => git(['show', `${branch}:.claude/skills/fe-skill/SKILL.md`], workspace)).toThrow(/not in /);
    const memberRoot = fs.realpathSync(workspace);
    const later = await detectProjectConfig(workspace);
    const state = await loadStateForScope(later ?? config);
    const records = Object.values(state.lastPullByWorkspace ?? {});
    const member = records.find((record) => record.root === memberRoot);
    const delivered = records.find((record) => record.root?.includes(`${path.sep}.teamai${path.sep}workflow-worktrees${path.sep}`));
    expect(records.map((record) => ({ root: record.root, rev: record.rev })), `homes ${config.dataHome} / ${later?.dataHome}`).toEqual(expect.arrayContaining([
      expect.objectContaining({ root: memberRoot, rev: expect.any(String) }),
      expect.objectContaining({ root: expect.stringContaining('workflow-worktrees'), rev: member?.rev }),
    ]));
    expect(delivered?.rev).toBe(member?.rev);
  });

  it('keeps hooksPath on the workflow worktree and runs from a linked checkout', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Check that hooks stay on the workflow worktree.
steps:
  - id: check
    workspace: new
    command: node check.js
`);
    fs.writeFileSync(path.join(workspace, 'check.js'), `const {execFileSync} = require('child_process');
const read = (args) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; } };
if (read(['config', '--local', '--get', 'core.hooksPath']) !== '') process.exit(2);
if (!read(['config', '--worktree', '--get', 'core.hooksPath']).endsWith('workflow-hooks')) process.exit(3);
`);
    execFileSync('git', ['add', 'check.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'check'], { cwd: workspace });
    const linked = path.join(path.dirname(workspace), 'linked');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked', linked, 'HEAD'], { cwd: workspace });

    const done = await runLocalDriver(config, runId, linked);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(() => git(['config', '--local', '--get', 'core.hooksPath'], workspace)).toThrow();
    expect(() => git(['config', '--local', '--get', 'core.hooksPath'], linked)).toThrow();
  });

  it('merges every item branch when a step needs a for_each', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A later step reads files from each fan item.
inputs:
  names: [string]
steps:
  - id: fan
    needs: []
    for_each:
      items: inputs.names
    workspace: new
    command: node -e "require('fs').writeFileSync('item-' + process.env.NAME + '.txt', process.env.NAME)"
    env:
      NAME: "{{ item }}"
  - id: gather
    needs: [fan]
    workspace: new
    command: node -e "const fs=require('fs'); if (fs.readFileSync('item-a.txt','utf8')!=='a' || fs.readFileSync('item-b.txt','utf8')!=='b') process.exit(1)"
`, { names: ['a', 'b'] });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('reports a commit the step made itself, and a merge that added no other file', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: The reported range includes the step's own commit and a merge.
steps:
  - id: own
    needs: []
    workspace: new
    command: node own.js
  - id: side
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('side.txt', 'S')"
  - id: take
    needs: [own, side]
    workspace: new
    command: node -e "process.exit(0)"
`);
    fs.writeFileSync(path.join(workspace, 'own.js'), `const {execFileSync} = require('child_process');
require('fs').writeFileSync('own.txt', '1');
const git = (args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'ignore' });
git(['add', 'own.txt']);
git(['commit', '-qm', 'own']);
`);
    execFileSync('git', ['add', 'own.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'script'], { cwd: workspace });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const own = run.steps.find((step) => step.id === 'own');
    const take = run.steps.find((step) => step.id === 'take');
    expect(own && 'changes' in own ? own.changes?.commits.length : 0).toBeGreaterThan(0);
    expect(take && 'changes' in take ? take.changes?.commits.length : 0).toBeGreaterThan(0);
    const branch = take && 'changes' in take ? take.changes?.branch : undefined;
    expect(git(['show', `${branch}:own.txt`], workspace)).toBe('1');
  });

  it('leaves the index clean when a later step does not edit the agent file', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A continuation that edits nothing still succeeds.
steps:
  - id: edit
    workspace: new
    workflow:
      steps:
        - id: first
          workspace: continue
          command: node -e "require('fs').writeFileSync('AGENTS.md', 'changed\\n')"
        - id: next
          needs: [first]
          workspace: continue
          command: node -e "process.exit(0)"
`);
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'base\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: workspace });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const next = typeof run === 'object' ? run.steps.find((step) => step.id === 'edit.next') : undefined;
    const branch = next && 'changes' in next ? next.changes?.branch : undefined;
    expect(git(['show', `${branch}:AGENTS.md`], workspace)).toBe('changed\n');
  });

  it('does not delete the target of a directory symlink while restoring agent files', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Restoring agent files leaves a linked directory alone.
steps:
  - id: idle
    workspace: new
    command: node -e "process.exit(0)"
`);
    const outside = path.join(path.dirname(workspace), 'outside');
    fs.mkdirSync(path.join(workspace, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'keep');
    fs.symlinkSync(outside, path.join(workspace, '.claude', 'skills', 'shared'));
    execFileSync('git', ['add', '.claude'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'link'], { cwd: workspace });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('keep');
  });

  it('merges the commit a dependency reported, not a later commit on the same branch', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A join that needs the first commit does not take the later one.
steps:
  - id: edit
    workspace: new
    workflow:
      steps:
        - id: marker
          needs: []
          workspace: new
          command: node -e "require('fs').writeFileSync('m.txt', 'M')"
        - id: first
          needs: []
          workspace: continue
          command: node -e "require('fs').writeFileSync('a.txt', 'A')"
        - id: later
          needs: [first]
          workspace: continue
          command: node -e "require('fs').writeFileSync('b.txt', 'B')"
        - id: join
          needs: [marker, first]
          workspace: new
          command: node -e "const fs=require('fs'); if (fs.existsSync('b.txt')) process.exit(1); if (fs.readFileSync('a.txt','utf8')!=='A' || fs.readFileSync('m.txt','utf8')!=='M') process.exit(1)"
`);
    config.workflows = { tools: {}, max_parallel: 1 };

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('merges a workflow child branch when a step needs the workflow', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A later step reads the file a workflow's child wrote.
steps:
  - id: work
    needs: []
    workspace: new
    workflow:
      steps:
        - id: write
          needs: []
          workspace: continue
          command: node -e "require('fs').writeFileSync('output.txt', 'written')"
  - id: read
    needs: [work]
    workspace: new
    command: node -e "if (require('fs').readFileSync('output.txt','utf8')!=='written') process.exit(1)"
`);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('keeps a relative agent symlink relative after a step that does not edit it', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Restoring agent files keeps a relative symlink target.
steps:
  - id: idle
    workspace: new
    command: node -e "process.exit(0)"
`);
    fs.mkdirSync(path.join(workspace, 'docs'));
    fs.writeFileSync(path.join(workspace, 'docs', 'agent-rules.md'), 'rules\n');
    fs.symlinkSync('docs/agent-rules.md', path.join(workspace, 'AGENTS.md'));
    execFileSync('git', ['add', 'AGENTS.md', 'docs'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'link'], { cwd: workspace });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const idle = typeof run === 'object' ? run.steps.find((step) => step.id === 'idle') : undefined;
    const branch = idle && 'changes' in idle ? idle.changes?.branch : undefined;
    expect(git(['show', `${branch}:AGENTS.md`], workspace)).toBe('docs/agent-rules.md');
  });

  it('pushes commits an earlier attempt left unpublished when this attempt adds none', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workspace-push-'));
    dirs.push(root);
    const bare = path.join(root, 'origin.git');
    const repo = path.join(root, 'repo');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'one'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'HEAD:main'], { cwd: repo });
    execFileSync('git', ['checkout', '-q', '-b', 'teamai/demo'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'two\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'two'], { cwd: repo });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'teamai/demo'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'three\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'three'], { cwd: repo });

    expect(await pushIfOrigin(repo, 'teamai/demo', [])).toBe('pushed');
    expect(git(['rev-parse', 'teamai/demo'], bare)).toBe(git(['rev-parse', 'HEAD'], repo));
    expect(await pushIfOrigin(repo, 'teamai/demo', [])).toBe('unchanged');
    expect(await pushIfOrigin(repo, 'teamai/never-pushed', [])).toBe('unchanged');

    execFileSync('git', ['checkout', '-q', '-b', 'teamai/first'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'four\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'four'], { cwd: repo });
    expect(await pushIfOrigin(repo, 'teamai/first', [])).toBe('pushed');
    expect(git(['rev-parse', 'teamai/first'], bare)).toBe(git(['rev-parse', 'HEAD'], repo));
    expect(await pushIfOrigin(repo, 'teamai/first', [])).toBe('unchanged');

    execFileSync('git', ['checkout', '-q', '-b', 'teamai/already', 'main'], { cwd: repo });
    expect(await pushIfOrigin(repo, 'teamai/already', [])).toBe('unchanged');
  });

  it('keeps an executable hook executable after a step that does not edit it', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Restoring agent files keeps a hook executable.
steps:
  - id: idle
    workspace: new
    command: node -e "process.exit(0)"
`);
    const hook = path.join(workspace, '.githooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hook));
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(hook, 0o755);
    execFileSync('git', ['add', '.githooks'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'hook'], { cwd: workspace });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const idle = typeof run === 'object' ? run.steps.find((step) => step.id === 'idle') : undefined;
    const branch = idle && 'changes' in idle ? idle.changes?.branch : undefined;
    expect(git(['ls-tree', String(branch), '.githooks/pre-commit'], workspace)).toContain('100755');
    expect(idle && 'changes' in idle ? idle.changes?.commits : undefined).toEqual([]);
  });

  it('restores a directory the branch replaced with a symlink', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A later step puts back a symlink that replaced a directory.
steps:
  - id: work
    needs: []
    workspace: new
    workflow:
      steps:
        - id: link
          needs: []
          workspace: continue
          command: node -e "const fs=require('fs'); fs.rmSync('.claude/skills/shared',{recursive:true}); fs.symlinkSync('elsewhere', '.claude/skills/shared')"
        - id: idle
          needs: [link]
          workspace: continue
          command: node -e "process.exit(0)"
`);
    fs.mkdirSync(path.join(workspace, '.claude', 'skills', 'shared'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.claude', 'skills', 'shared', 'tool.md'), 'tool\n');
    fs.mkdirSync(path.join(workspace, '.claude', 'skills', 'elsewhere'));
    fs.writeFileSync(path.join(workspace, '.claude', 'skills', 'elsewhere', 'kept.md'), 'kept\n');
    execFileSync('git', ['add', '.claude'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'skills'], { cwd: workspace });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const idle = typeof run === 'object' ? run.steps.find((step) => step.id === 'work.idle') : undefined;
    const branch = idle && 'changes' in idle ? idle.changes?.branch : undefined;
    expect(git(['show', `${branch}:.claude/skills/shared`], workspace)).toBe('elsewhere');
    expect(git(['show', `${branch}:.claude/skills/elsewhere/kept.md`], workspace)).toBe('kept\n');
  });
});
