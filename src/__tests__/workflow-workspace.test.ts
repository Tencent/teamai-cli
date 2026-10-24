/**
 * Workspaces: a command with no workspace is read-only, `new` steps get distinct
 * branches, a later step merges them, and `continue` stays with the driver that opened it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectProjectConfig, loadStateForScope } from '../config.js';
import { resolveAnchors } from '../utils/git.js';
import { resolvePartitionDir } from '../utils/partition.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import * as engine from '../workflow/engine.js';
import { leaseNext, parseReport, reportAttempt, startRun } from '../workflow/engine.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/local-driver.js';
import { cancelRun, respondToHitl, retryStep } from '../workflow/run-controls.js';
import type { LocalToolAdapter } from '../workflow/local-tool-adapter.js';
import { parseWorkflow } from '../workflow/parse.js';
import { readRun, updateRun } from '../workflow/store.js';
import type { DriverIdentity, RunState } from '../workflow/types.js';
import { branchName } from '../workflow/workspace.js';
import { applyBaseConfig, ensureWorktree, hooksPath, pushIfOrigin, worktreePath } from '../workflow/worktree.js';
import { launchHoldsCheckout } from '../launch-context.js';
import { teamDelivery } from '../pull.js';
import { pendingRecords } from '../workflow/records.js';
import { knownSecrets } from '../env-resolution.js';

_setDriverPollMs(20);

/** Saves an edited run file under its lock, as a hand edit or an older teamai leaves one. */
async function saveRun(config: LocalConfig, run: RunState): Promise<void> {
  await updateRun(config, run.id, {}, async () => ({ value: undefined, write: run }));
}

const dirs: string[] = [];

async function fixture(yaml: string, inputs: unknown = {}): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
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
  const started = await startRun(config, 'build', inputs, { secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  return { config, workspace, runId: String(started.data.run) };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A checkout whose team repo is its own `.teamai`, pulled once with Claude enabled, and a started run of `yaml`. */
async function teamWorkspace(yaml: string): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
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
  fs.writeFileSync(path.join(knowledge, 'workflows', 'build.yaml'), yaml);
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
  const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  return { config, workspace, runId: String(started.data.run) };
}

/** Commits a submodule `vendor` holding `inside.txt` (`one`) to the workspace, and returns the commit it records. */
function addSubmodule(workspace: string, inner?: string): string {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sub-'));
  dirs.push(source);
  execFileSync('git', ['init', '-q'], { cwd: source });
  fs.writeFileSync(path.join(source, 'inside.txt'), 'one\n');
  execFileSync('git', ['add', 'inside.txt'], { cwd: source });
  if (inner) execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'inner'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'one'], { cwd: source });
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'vendor'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'vendor'], { cwd: workspace });
  return git(['rev-parse', 'HEAD:vendor'], workspace).trim();
}

const driver = (workspace: string, machine = 'host'): DriverIdentity => ({ kind: 'local', machine, workspace });

afterEach(() => {
  vi.restoreAllMocks();
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

  it.each([
    ['switches to a new branch', "cp.execFileSync('git',['switch','-q','-c','side'])", 'refs/heads/side'],
    ['detaches HEAD', "cp.execFileSync('git',['checkout','-q','--detach'])", ''],
  ])('fails a command with no workspace when it %s without committing, and leaves HEAD there', async (_name, script, ref) => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A read-only command that moves HEAD off its branch changes the checkout.
steps:
  - id: move
    command: node -e "const cp=require('child_process'); ${script}"
`);

    await runLocalDriver(config, runId, workspace);

    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('HEAD') } }],
    });
    const head = ((): string => {
      try {
        return git(['symbolic-ref', '--quiet', 'HEAD'], workspace).trim();
      } catch {
        return '';
      }
    })();
    expect(head).toBe(ref);
  });

  it('fails a command with no workspace when it commits, and leaves the commit', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A read-only command that commits still changes the checkout.
steps:
  - id: write
    command: node -e "const cp=require('child_process'); require('fs').writeFileSync('tracked.txt','edited\\n'); cp.execFileSync('git',['add','tracked.txt']); cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','edit'])"
`);
    const before = git(['rev-parse', 'HEAD'], workspace).trim();

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('HEAD') } }],
    });
    expect(git(['rev-parse', 'HEAD'], workspace).trim()).not.toBe(before);
    expect(fs.readFileSync(path.join(workspace, 'tracked.txt'), 'utf8')).toBe('edited\n');
  });

  it('fails a command with no workspace when it stages an existing edit', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Staging an existing edit changes the checkout.
steps:
  - id: stage
    command: git add tracked.txt
`);
    fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'edited\n');

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('tracked.txt') } }],
    });
    expect(git(['diff', '--cached', '--name-only'], workspace)).toContain('tracked.txt');
  });

  it('fails a command with no workspace when it stages another hunk and leaves one unstaged', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Staging more of a file changes the index even when the status stays mixed.
steps:
  - id: stage
    command: node -e "const cp=require('child_process'); const blob=cp.execFileSync('git',['hash-object','-w','--stdin'],{input:'base\\nstaged\\nmore\\n'}).toString().trim(); cp.execFileSync('git',['update-index','--cacheinfo', '100644,'+blob+',tracked.txt'])"
`);
    fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'base\nstaged\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'base\nstaged\nunstaged\n');

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('tracked.txt') } }],
    });
    expect(git(['show', ':tracked.txt'], workspace)).toBe('base\nstaged\nmore\n');
    expect(fs.readFileSync(path.join(workspace, 'tracked.txt'), 'utf8')).toBe('base\nstaged\nunstaged\n');
  });

  it('fails a command with no workspace when it changes the mode of a dirty file', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A permission change on an already dirty file still changes the checkout.
steps:
  - id: mode
    command: chmod +x tracked.txt
`);
    const file = path.join(workspace, 'tracked.txt');
    fs.writeFileSync(file, 'edited\n');

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('tracked.txt') } }],
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('edited\n');
    expect(fs.statSync(file).mode & 0o111).not.toBe(0);
  });

  it('fails a command with no workspace when it edits a quoted path', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A quoted non-ASCII path is still a checkout change.
steps:
  - id: edit
    command: node -e "require('fs').writeFileSync('résumé.txt','edited\\n')"
`);
    const file = path.join(workspace, 'résumé.txt');
    fs.writeFileSync(file, 'clean\n');
    execFileSync('git', ['add', 'résumé.txt'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'note'], { cwd: workspace });
    fs.writeFileSync(file, 'dirty\n');

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('résumé.txt') } }],
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('edited\n');
  });

  it('fails a command with no workspace when it retargets a dirty symlink', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A symlink target change is a checkout change even when the file it names is unchanged.
steps:
  - id: link
    command: node -e "const fs=require('fs'); fs.unlinkSync('link.txt'); fs.symlinkSync('./target.txt','link.txt')"
`);
    fs.writeFileSync(path.join(workspace, 'target.txt'), 'body\n');
    fs.writeFileSync(path.join(workspace, 'other.txt'), 'other\n');
    fs.symlinkSync('other.txt', path.join(workspace, 'link.txt'));
    execFileSync('git', ['add', 'target.txt', 'other.txt', 'link.txt'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'link'], { cwd: workspace });
    fs.unlinkSync(path.join(workspace, 'link.txt'));
    fs.symlinkSync('target.txt', path.join(workspace, 'link.txt'));

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('link.txt') } }],
    });
    expect(fs.readlinkSync(path.join(workspace, 'link.txt'))).toBe('./target.txt');
  });

  it('fails a command with no workspace when it edits the destination of a staged rename', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: The new path of a staged rename is the file in the checkout.
steps:
  - id: edit
    command: node -e "require('fs').writeFileSync('new.txt','edited\\n')"
`);
    fs.writeFileSync(path.join(workspace, 'old.txt'), 'clean\n');
    execFileSync('git', ['add', 'old.txt'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'old'], { cwd: workspace });
    execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'new.txt'), 'dirty\n');

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('new.txt') } }],
    });
    expect(fs.readFileSync(path.join(workspace, 'new.txt'), 'utf8')).toBe('edited\n');
  });

  it('fails a command with no workspace when it edits a file in a dirty submodule', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A file inside an already dirty submodule is still a checkout change.
steps:
  - id: edit
    command: node -e "require('fs').writeFileSync('vendor/inside.txt','edited\\n')"
`);
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sub-'));
    dirs.push(source);
    execFileSync('git', ['init', '-q'], { cwd: source });
    fs.writeFileSync(path.join(source, 'inside.txt'), 'one\n');
    execFileSync('git', ['add', 'inside.txt'], { cwd: source });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'one'], { cwd: source });
    execFileSync('git', ['clone', '-q', source, 'vendor'], { cwd: workspace });
    execFileSync('git', ['-c', 'advice.addEmbeddedRepo=false', 'add', 'vendor'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'vendor'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'vendor', 'inside.txt'), 'dirty\n');

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('vendor') } }],
    });
    expect(fs.readFileSync(path.join(workspace, 'vendor', 'inside.txt'), 'utf8')).toBe('edited\n');
  });

  it('fails an interactive read-only prompt that edits the checkout, and leaves the edit', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: An interactive prompt in a read-only workspace still must not change the checkout.
steps:
  - id: pair
    prompt: Edit the note.
    interactive: true
    workspace: read-only
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 1 };
    const adapter: LocalToolAdapter = {
      async run() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'headless is not used' } };
      },
      async runInteractive(_tool, input) {
        fs.writeFileSync(path.join(input.cwd, 'tracked.txt'), 'edited\n');
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, hitl: true });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('tracked.txt') } }],
    });
    expect(fs.readFileSync(path.join(workspace, 'tracked.txt'), 'utf8')).toBe('edited\n');
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

  it('says where a failed push left the commits, so pushing them from there works', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: origin refuses the push.
steps:
  - id: change
    workspace: new
    command: node -e "require('fs').writeFileSync('new.txt','yes')"
`);
    git(['remote', 'add', 'origin', path.join(path.dirname(workspace), 'missing.git')], workspace);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const branch = branchName(runId, 'change', 1);
    const copy = worktreePath(workspace, branch);
    expect(run.steps.find((step) => step.id === 'change')).toMatchObject({
      status: 'failed',
      failure: {
        code: 'push_failed',
        message: expect.stringMatching(new RegExp(`^Step "change" committed on ${branch} in ${copy}, but pushing it to origin failed\\. The commits stay on ${branch}\\. Fix what blocked the push, then push ${branch} from ${copy} or retry the step\\. Git said: .*missing\\.git`, 's')),
      },
    });
    const bare = path.join(path.dirname(workspace), 'missing.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    git(['push', '-q', 'origin', branch], copy);
    expect(git(['show', `${branch}:new.txt`], bare)).toBe('yes');
  });

  it('keeps the failure of a prompt that fails, and adds that the push of its commits failed', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A prompt writes a file and fails, and origin refuses the push.
steps:
  - id: change
    workspace: new
    prompt: Change it.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 1 };
    git(['remote', 'add', 'origin', path.join(path.dirname(workspace), 'missing.git')], workspace);
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        fs.writeFileSync(path.join(input.cwd, 'new.txt'), 'yes');
        return { started: true, exitCode: 1, failure: { code: 'tool_failed', message: 'claude exited with status 1' } };
      },
    };

    await runLocalDriver(config, runId, workspace, { adapter });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const branch = branchName(runId, 'change', 1);
    expect(run.steps.find((step) => step.id === 'change')).toMatchObject({
      status: 'failed',
      changes: { branch },
      failure: { code: 'tool_failed', message: expect.stringMatching(new RegExp(`^claude exited with status 1\\. Step "change" committed on ${branch} in .*, but pushing it to origin failed\\.`)) },
    });
  });

  it('commits a writer whose only change is a new file when the repository hides untracked files from status', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: status.showUntrackedFiles=no does not hide a writer's new file.
steps:
  - id: change
    workspace: new
    command: node -e "require('fs').writeFileSync('new.txt','yes')"
`);
    git(['config', 'status.showUntrackedFiles', 'no'], workspace);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const change = run.steps.find((step) => step.id === 'change');
    expect(change && 'changes' in change && change.changes?.commits.length).toBe(1);
    expect(git(['show', `${branchName(runId, 'change', 1)}:new.txt`], workspace)).toBe('yes');
  });

  it('commits a writer whose change an external diff the user trusts calls equal', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: diff.external with diff.trustExitCode does not decide whether there is something to commit.
steps:
  - id: change
    workspace: new
    command: node -e "require('fs').writeFileSync('tracked.txt','clean \\\\n')"
`);
    const wrapper = path.join(path.dirname(workspace), 'diff-w.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexec diff -w "$2" "$5"\n', { mode: 0o755 });
    git(['config', 'diff.external', wrapper], workspace);
    git(['config', 'diff.trustExitCode', 'true'], workspace);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const change = run.steps.find((step) => step.id === 'change');
    expect(change && 'changes' in change && change.changes?.commits.length).toBe(1);
    expect(git(['show', `${branchName(runId, 'change', 1)}:tracked.txt`], workspace)).toBe('clean \n');
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
    const leased = await leaseNext(config, runId, owner, { base, can: { workspace: [...modes] } });
    const lease = 'data' in leased ? leased.data.lease as { attempt: string; revision: number; step: string; workspace?: { branch: string } } : undefined;
    if (!lease?.workspace) throw new Error(JSON.stringify(leased));
    expect(lease.step).toBe('edit.first');
    await reportAttempt(config, runId, {
      attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: owner,
      changes: { branch: lease.workspace.branch, base: base.commit, from: base.commit, to: base.commit, commits: [] },
    });

    const other = await leaseNext(config, runId, driver(workspace, 'other'), { base, can: { workspace: [...modes] } });

    expect(other).toMatchObject({ data: { wait: { reason: expect.stringContaining('another driver') } } });
  });

  it('runs a workspace step from a detached HEAD in its own worktree', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A detached checkout still opens a workspace.
steps:
  - id: edit
    workspace: new
    command: node -e "require('fs').writeFileSync('edited.txt','yes')"
`);
    git(['checkout', '-q', '--detach'], workspace);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const edit = typeof run === 'object' ? run.steps.find((step) => step.id === 'edit') : undefined;
    const branch = edit && 'changes' in edit ? edit.changes?.branch : undefined;
    expect(git(['show', `${branch}:edited.txt`], workspace)).toBe('yes');
    expect(fs.existsSync(path.join(workspace, 'edited.txt'))).toBe(false);
  });

  it('fails a step whose lease carries a workspace this driver cannot read, and does not run it in the checkout', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A newer workspace contract.
steps:
  - id: edit
    workspace: new
    command: node -e "require('fs').writeFileSync('edited.txt','yes')"
`);
    const leaseNextAsSent = engine.leaseNext;
    vi.spyOn(engine, 'leaseNext').mockImplementation(async (...args) => {
      const answer = await leaseNextAsSent(...args);
      const lease = 'data' in answer ? answer.data.lease : undefined;
      if (lease && typeof lease === 'object' && 'workspace' in lease) Object.assign(lease, { workspace: { mode: 'clone' } });
      return answer;
    });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' ? run.steps : run).toMatchObject([{ id: 'edit', status: 'failed', failure: { code: 'workspace_base' } }]);
    expect(fs.existsSync(path.join(workspace, 'edited.txt'))).toBe(false);
  });

  it('rejects a report whose changes name another branch or base than the lease, and keeps the step leased', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Changes must match the lease.
steps:
  - id: edit
    workspace: new
    command: echo edit
`);
    const owner = driver(workspace);
    const base = { ref: 'HEAD', commit: git(['rev-parse', 'HEAD'], workspace).trim() };
    const leased = await leaseNext(config, runId, owner, { base, can: { workspace: ['read-only', 'new', 'continue'] } });
    const lease = 'data' in leased ? leased.data.lease as { attempt: string; revision: number; workspace?: { branch: string } } : undefined;
    if (!lease?.workspace) throw new Error(JSON.stringify(leased));
    const changes = { branch: lease.workspace.branch, base: base.commit, from: base.commit, to: base.commit, commits: [] };
    const report = (override: Partial<typeof changes>) => reportAttempt(config, runId, {
      attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: owner, changes: { ...changes, ...override },
    });

    expect(await report({ branch: 'teamai/elsewhere' })).toMatchObject({ error: { code: 'invalid_report', message: expect.stringContaining('teamai/elsewhere') } });
    expect(await report({ base: 'f'.repeat(40) })).toMatchObject({ error: { code: 'invalid_report', message: expect.stringContaining('f'.repeat(40)) } });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' ? run.steps.find((step) => step.id === 'edit') : undefined).toMatchObject({ status: 'leased', lease: { attempt: lease.attempt } });
    expect(await report({})).toMatchObject({ data: { accepted: true, cleanup: true } });
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

  it('runs a later step on the base MCP and tool settings an earlier step committed, and keeps its own edit', async () => {
    const files = ['.mcp.json', 'opencode.json', '.tclaude/settings.json'];
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A later step does not see MCP or tool settings committed earlier.
steps:
  - id: work
    workspace: new
    workflow:
      steps:
        - id: plant
          workspace: continue
          command: node -e "const fs=require('fs'); for (const f of ${JSON.stringify(files).replace(/"/g, "'")}) fs.writeFileSync(f,'earlier')"
        - id: check
          needs: [plant]
          workspace: continue
          command: node -e "const fs=require('fs'); for (const f of ${JSON.stringify(files).replace(/"/g, "'")}) if (fs.readFileSync(f,'utf8')!=='base') process.exit(2); fs.writeFileSync('.mcp.json','later')"
`);
    fs.mkdirSync(path.join(workspace, '.tclaude'));
    for (const file of files) fs.writeFileSync(path.join(workspace, file), 'base');
    execFileSync('git', ['add', ...files], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'tool config'], { cwd: workspace });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const check = typeof run === 'object' ? run.steps.find((step) => step.id === 'work.check') : undefined;
    const branch = check && 'changes' in check ? check.changes?.branch : undefined;
    expect(git(['show', `${branch}:.mcp.json`], workspace)).toBe('later');
    expect(git(['show', `${branch}:opencode.json`], workspace)).toBe('earlier');
    expect(git(['show', `${branch}:.tclaude/settings.json`], workspace)).toBe('earlier');
  });

  it('keeps a .github agent file an earlier step committed on the branch after a later step runs on the base', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A later step runs without the Copilot instructions committed earlier, and the branch keeps them.
steps:
  - id: work
    workspace: new
    workflow:
      steps:
        - id: plant
          workspace: continue
          command: node -e "const fs=require('fs'); fs.mkdirSync('.github',{recursive:true}); fs.writeFileSync('.github/copilot-instructions.md','earlier')"
        - id: check
          needs: [plant]
          workspace: continue
          command: node -e "const fs=require('fs'); if (fs.existsSync('.github/copilot-instructions.md')) process.exit(2); fs.writeFileSync('ok.txt','yes')"
`);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const check = typeof run === 'object' ? run.steps.find((step) => step.id === 'work.check') : undefined;
    const branch = check && 'changes' in check ? check.changes?.branch : 'none';
    expect(git(['show', `${branch}:ok.txt`], workspace)).toBe('yes');
    expect(git(['show', `${branch}:.github/copilot-instructions.md`], workspace)).toBe('earlier');
  });

  it('fails a later step with base_config when an earlier step committed .github as a symlink, and leaves its target alone', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-outside-'));
    dirs.push(outside);
    fs.mkdirSync(path.join(outside, 'skills'));
    fs.writeFileSync(path.join(outside, 'skills', 'keep.txt'), 'keep');
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: An agent path under a symlinked parent is not touched.
steps:
  - id: work
    workspace: new
    workflow:
      steps:
        - id: plant
          workspace: continue
          command: node -e "require('fs').symlinkSync(${JSON.stringify(outside).replace(/"/g, "'")},'.github')"
        - id: check
          needs: [plant]
          workspace: continue
          command: node -e "require('fs').writeFileSync('ok.txt','yes')"
`);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    const check = typeof run === 'object' ? run.steps.find((step) => step.id === 'work.check') : undefined;
    expect(check).toMatchObject({ status: 'failed', failure: { code: 'base_config', message: expect.stringContaining('.github') } });
    const branch = branchName(runId, 'work', 1);
    expect(check).toMatchObject({ failure: { message: expect.stringContaining(`Commit .github as a directory on branch ${branch} in ${worktreePath(workspace, branch)}, then retry the step.`) } });
    expect(fs.readFileSync(path.join(outside, 'skills', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('fails a workspace step with base_config, telling the user to fix the base branch and start a new run, when the run base has .github as a symlink', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-outside-'));
    dirs.push(outside);
    const { config, workspace } = await fixture(`schemaVersion: v1alpha1
name: build
description: A symlink in the run base cannot be fixed by a step.
steps:
  - id: work
    workspace: new
    command: node -e "require('fs').writeFileSync('ok.txt','yes')"
`);
    fs.symlinkSync(outside, path.join(workspace, '.github'));
    execFileSync('git', ['add', '.github'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'link'], { cwd: workspace });
    const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    const work = typeof run === 'object' ? run.steps.find((step) => step.id === 'work') : undefined;
    expect(work).toMatchObject({ status: 'failed', failure: { code: 'base_config', message: expect.stringContaining('Commit .github as a directory on the base branch, then start a new run.') } });
  });

  it('leaves the target alone when a step replaces .github with a symlink while the base has agent files there', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-outside-'));
    dirs.push(outside);
    const shared = path.join(outside, 'shared');
    const { config, workspace } = await fixture(`schemaVersion: v1alpha1
name: build
description: Restoring agent files does not follow a parent symlink the step made.
steps:
  - id: work
    workspace: new
    command: node -e "const fs=require('fs'); fs.renameSync('.github',${JSON.stringify(shared).replace(/"/g, "'")}); fs.symlinkSync(${JSON.stringify(shared).replace(/"/g, "'")},'.github')"
`);
    fs.mkdirSync(path.join(workspace, '.github', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.github', 'agents', 'a.md'), 'agent');
    execFileSync('git', ['add', '.github'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agent'], { cwd: workspace });
    const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);

    await runLocalDriver(config, runId, workspace);

    expect(fs.readFileSync(path.join(shared, 'agents', 'a.md'), 'utf8')).toBe('agent');
    expect(git(['ls-tree', branchName(runId, 'work', 1), '--', '.github'], workspace)).toMatch(/^120000 /);
  });

  it('keeps .github workflows from the branch and resets only its agent paths', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A later step sees the workflows an earlier step committed, not its hooks.
steps:
  - id: work
    workspace: new
    workflow:
      steps:
        - id: plant
          workspace: continue
          command: node -e "const fs=require('fs'); fs.mkdirSync('.github/workflows',{recursive:true}); fs.mkdirSync('.github/hooks',{recursive:true}); fs.writeFileSync('.github/workflows/ci.yml','ci'); fs.writeFileSync('.github/hooks/x.json','{}')"
        - id: check
          needs: [plant]
          workspace: continue
          command: node -e "const fs=require('fs'); if (!fs.existsSync('.github/workflows/ci.yml') || fs.existsSync('.github/hooks/x.json')) process.exit(2); fs.writeFileSync('ok.txt','yes')"
`);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const check = typeof run === 'object' ? run.steps.find((step) => step.id === 'work.check') : undefined;
    const branch = check && 'changes' in check ? check.changes?.branch : 'none';
    expect(git(['show', `${branch}:ok.txt`], workspace)).toBe('yes');
    expect(git(['show', `${branch}:.github/workflows/ci.yml`], workspace)).toBe('ci');
    expect(git(['show', `${branch}:.github/hooks/x.json`], workspace)).toBe('{}');
  });

  it('never resets the whole worktree for a hooks file at the repository root', async () => {
    vi.resetModules();
    vi.doMock('../types.js', () => ({
      TeamaiConfigBaseSchema: { shape: { toolPaths: { parse: () => ({ tool: { hooks: 'hooks.json', skills: '.tool/skills' } }) } } },
    }));
    try {
      const { AGENT_PATHS } = await import('../workflow/worktree.js');
      expect(AGENT_PATHS).toContain('hooks.json');
      expect(AGENT_PATHS).not.toContain('.');
      expect(AGENT_PATHS).not.toContain('');
    } finally {
      vi.doUnmock('../types.js');
      vi.resetModules();
    }
  });

  it('delivers a team skill into a new workspace and leaves it out of the branch', async () => {
    const { config, workspace, runId } = await teamWorkspace(`schemaVersion: v1alpha1
name: build
description: Read the delivered team skill.
steps:
  - id: ask
    workspace: new
    prompt: Read the team skill.
`);
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

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
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

  it('observes a prompt in a new workspace through the worktree, so its tool keeps that delivery and the record its revision', async () => {
    const { config, workspace, runId } = await teamWorkspace(`schemaVersion: v1alpha1
name: build
description: Review in a workspace.
steps:
  - id: ask
    workspace: new
    prompt: Review the change.
`);
    // A member's own edit to a delivered skill is not a local change of the worktree the step runs in.
    fs.appendFileSync(path.join(workspace, '.claude', 'skills', 'fe-skill', 'SKILL.md'), 'Member edit.\n');
    let holds: boolean | undefined;
    let revision: string | undefined;
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        const own = await detectProjectConfig(input.cwd);
        holds = own && input.launch ? await launchHoldsCheckout(own, input.launch) : false;
        const delivery = own ? await teamDelivery(own, 'claude') : undefined;
        revision = delivery?.complete ? delivery.commit : undefined;
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(holds).toBe(true);
    expect(revision).toMatch(/^[0-9a-f]{40}$/);
    const record = (await pendingRecords(config)).find((item) => item.run === runId && item.phase === 'end');
    expect(record?.steps?.[0]).toMatchObject({ agent: { team: { revision, localChanges: false } } });
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

  it('pushes a branch whose first push never created a remote-tracking ref', async () => {
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
    execFileSync('git', ['checkout', '-q', '-b', 'teamai/solo'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'two\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'two'], { cwd: repo });

    expect(await pushIfOrigin(repo, 'teamai/solo', [])).toBe('pushed');
    expect(git(['rev-parse', 'teamai/solo'], bare)).toBe(git(['rev-parse', 'HEAD'], repo));
    execFileSync('git', ['checkout', '-q', '-b', 'teamai/same', 'main'], { cwd: repo });
    expect(await pushIfOrigin(repo, 'teamai/same', [])).toBe('unchanged');
  });

  it('pushes a branch only it holds when the user forces branch colors', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-push-'));
    dirs.push(root);
    const bare = path.join(root, 'origin.git');
    const repo = path.join(root, 'repo');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'one'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });
    execFileSync('git', ['checkout', '-q', '-b', 'teamai/solo'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'two'], { cwd: repo });
    git(['config', 'color.branch', 'always'], repo);

    expect(await pushIfOrigin(repo, 'teamai/solo', [])).toBe('pushed');
  });

  it('fails the agent configuration reset to a base commit this checkout does not have, and leaves the branch agent files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-base-config-'));
    dirs.push(root);
    const commitIn = (repo: string, text: string): string => {
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), text);
      execFileSync('git', ['add', 'AGENTS.md'], { cwd: repo });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: repo });
      return git(['rev-parse', 'HEAD'], repo).trim();
    };
    const repo = path.join(root, 'repo');
    const head = commitIn(repo, 'branch rules\n');
    const elsewhere = commitIn(path.join(root, 'elsewhere'), 'base rules\n');
    const opened = await ensureWorktree(repo, 'teamai/r/step/p1', head);
    if ('error' in opened) throw new Error(opened.error);

    const applied = await applyBaseConfig(opened.dir, elsewhere, hooksPath(repo));

    expect(applied).toEqual({ ok: false, message: expect.stringContaining(elsewhere) });
    expect(fs.readFileSync(path.join(opened.dir, 'AGENTS.md'), 'utf8')).toBe('branch rules\n');
  });

  it.each([
    ['git cannot check the base out', (repo: string) => {
      fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'AGENTS.md filter=boom\n');
      for (const [key, value] of [['smudge', 'false'], ['clean', 'cat'], ['required', 'true']]) git(['config', `filter.boom.${key}`, value], repo);
    }],
    ['the base checks out different from its commit', (repo: string) => {
      fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'AGENTS.md text\n');
    }],
  ])('leaves the branch agent files, its index and no temporary copy when %s', async (_fault, fault) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-base-config-')));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    const commit = (text: string): string => {
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), text);
      execFileSync('git', ['add', 'AGENTS.md'], { cwd: repo });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: repo });
      return git(['rev-parse', 'HEAD'], repo).trim();
    };
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const base = commit('base rules\r\n');
    const head = commit('branch rules\n');
    const opened = await ensureWorktree(repo, 'teamai/r/step/p1', head);
    if ('error' in opened) throw new Error(opened.error);
    fault(repo);
    const temp = path.join(root, 'tmp');
    fs.mkdirSync(temp);
    vi.stubEnv('TMPDIR', temp);

    const applied = await applyBaseConfig(opened.dir, base, hooksPath(repo));

    vi.unstubAllEnvs();
    expect(fs.readFileSync(path.join(opened.dir, 'AGENTS.md'), 'utf8')).toBe('branch rules\n');
    expect(git(['status', '--porcelain'], opened.dir)).toBe('');
    expect(fs.readdirSync(temp)).toEqual([]);
    expect(applied).toEqual({ ok: false, message: expect.stringContaining(base) });
  });

  it('keeps the branch agent files when a step is retried after git could not check out the base agent configuration', async () => {
    const { config, workspace } = await fixture(`schemaVersion: v1alpha1
name: build
description: A failed reset of the agent configuration leaves the branch copy for the retry.
steps:
  - id: work
    workspace: new
    workflow:
      steps:
        - id: plant
          workspace: continue
          command: node -e "require('fs').writeFileSync('AGENTS.md','branch rules\\n')" && git config filter.boom.smudge false && git config filter.boom.clean cat && git config filter.boom.required true && echo 'AGENTS.md filter=boom' > "$(git rev-parse --git-common-dir)/info/attributes"
        - id: check
          needs: [plant]
          workspace: continue
          command: node -e "require('fs').writeFileSync('ok.txt','yes')"
`);
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'base rules\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: workspace });
    const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const branch = branchName(runId, 'work', 1);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    expect(run.steps.find((step) => step.id === 'work.check')).toMatchObject({ status: 'failed', failure: { code: 'base_config', message: expect.stringContaining('smudge filter boom failed') } });
    fs.rmSync(path.join(workspace, '.git', 'info', 'attributes'));
    expect(await retryStep(config, runId, await knownSecrets(config), 'work.check')).toMatchObject({ data: { retried: { pass: 2 } } });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(git(['show', `${branch}:AGENTS.md`], workspace)).toBe('branch rules\n');
    expect(git(['show', `${branch}:ok.txt`], workspace)).toBe('yes');
  });

  it('fails a step with workspace_base, naming the branch, its commit and what git said, when a merge fails without a conflict', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A merge git refuses is not a conflict.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('left.txt','L')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('in-the-way.txt','R')"
  - id: join
    needs: [left, right]
    workspace: new
    command: node -e "require('fs').writeFileSync('ok.txt','yes')"
`);
    const opened = await ensureWorktree(workspace, branchName(runId, 'join', 1), git(['rev-parse', 'HEAD'], workspace).trim());
    if ('error' in opened) throw new Error(opened.error);
    fs.writeFileSync(path.join(opened.dir, 'in-the-way.txt'), 'untracked\n');

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const right = run.steps.find((step) => step.id === 'right');
    const commit = right && 'changes' in right ? right.changes?.to : undefined;
    if (!commit) throw new Error('right reported no commit');
    const join = run.steps.find((step) => step.id === 'join');
    expect(join).toMatchObject({ status: 'failed', failure: { code: 'workspace_base' } });
    const message = join && 'failure' in join ? join.failure?.message : undefined;
    expect(message).toContain(`branch ${branchName(runId, 'right', 1)} at ${commit}`);
    expect(message).toContain('untracked working tree files would be overwritten by merge');
    expect(message).toContain(`teamai workflow retry ${runId} join`);
    expect(fs.existsSync(path.join(opened.dir, 'ok.txt'))).toBe(false);
  });

  it('fails a step with workspace_base, committing nothing, when git cannot list its agent files to put the branch copy back', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A listing git fails is not an empty one.
steps:
  - id: work
    workspace: new
    command: node -e "const cp=require('child_process'); require('fs').writeFileSync('ok.txt','yes'); require('fs').writeFileSync(cp.execFileSync('git',['rev-parse','--git-path','index']).toString().trim(),'garbage')"
`);
    const start = git(['rev-parse', 'HEAD'], workspace).trim();

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const work = run.steps.find((step) => step.id === 'work');
    expect(work).toMatchObject({ status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining('index file smaller than expected') } });
    expect(work && 'failure' in work ? work.failure?.message : undefined).toContain('nothing was committed');
    expect(git(['rev-parse', branchName(runId, 'work', 1)], workspace).trim()).toBe(start);
  });

  it('fails a reader with workspace_base when git cannot list its copy to put the branch agent files back', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A reader whose copy git cannot list is not put back.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "const cp=require('child_process'); require('fs').writeFileSync(cp.execFileSync('git',['rev-parse','--git-path','index']).toString().trim(),'garbage')"
`);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    const test = typeof run === 'object' ? run.steps.find((step) => step.id === 'change.test') : undefined;
    expect(test).toMatchObject({ status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining('could NOT be put back') } });
    expect(test).toMatchObject({ failure: { message: expect.stringContaining('index file smaller than expected') } });
    expect(test).not.toMatchObject({ failure: { message: expect.stringContaining('changed repository paths') } });
  });

  it('commits a hook a step made executable without editing its text', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A step can turn a hook on without rewriting it.
steps:
  - id: enable
    workspace: new
    command: node -e "require('fs').chmodSync('.githooks/pre-commit', 0o755)"
`);
    const hook = path.join(workspace, '.githooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hook));
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(hook, 0o644);
    execFileSync('git', ['add', '.githooks'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'hook'], { cwd: workspace });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const enable = typeof run === 'object' ? run.steps.find((step) => step.id === 'enable') : undefined;
    const branch = enable && 'changes' in enable ? enable.changes?.branch : undefined;
    expect(git(['ls-tree', String(branch), '.githooks/pre-commit'], workspace)).toContain('100755');
    expect(enable && 'changes' in enable ? enable.changes?.commits : []).not.toEqual([]);
  });

  it('keeps a file a step wrote under a directory the branch had replaced with a symlink', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: An edit under a restored directory survives the saved symlink.
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
        - id: write
          needs: [link]
          workspace: continue
          command: node -e "require('fs').writeFileSync('.claude/skills/shared/new.md', 'fresh\\n')"
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
    const write = typeof run === 'object' ? run.steps.find((step) => step.id === 'work.write') : undefined;
    const branch = write && 'changes' in write ? write.changes?.branch : undefined;
    expect(git(['show', `${branch}:.claude/skills/shared/new.md`], workspace)).toBe('fresh\n');
    expect(git(['show', `${branch}:.claude/skills/elsewhere/kept.md`], workspace)).toBe('kept\n');
  });

  it('does not publish an agent conflict a prompt left untouched', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A prompt must resolve an agent-file conflict before it is published.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('AGENTS.md', 'left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('AGENTS.md', 'right\\n')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Resolve the agent file.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'base\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: workspace });
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run() {
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join') : undefined;
    expect(join && 'failure' in join ? join.failure : undefined).toMatchObject({ code: 'merge_conflict' });
  });

  it('keeps a prompt resolution of an agent conflict', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A prompt that rewrites a conflicted agent file publishes that resolution.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('AGENTS.md', 'left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('AGENTS.md', 'right\\n')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Resolve the agent file.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'base\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: workspace });
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        fs.writeFileSync(path.join(input.cwd, 'AGENTS.md'), 'resolved\n');
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join') : undefined;
    const branch = join && 'changes' in join ? join.changes?.branch : undefined;
    expect(git(['show', `${branch}:AGENTS.md`], workspace)).toBe('resolved\n');
  });

  it('merges a dependency through a nested workflow that omits needs', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A nested child receives the branch its outer workflow needs.
steps:
  - id: prepare
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('prepared.txt','yes')"
  - id: work
    needs: [prepare]
    workspace: new
    workflow:
      steps:
        - id: inner
          workflow:
            steps:
              - id: check
                workspace: continue
                command: node -e "const fs=require('fs'); if(fs.readFileSync('prepared.txt','utf8')!=='yes') process.exit(1)"
`);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('merges an earlier fan item into a workflow child that continues the next item', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A continued child sees the item its own item waits for.
inputs:
  items: [{ id: string, after: [string] }]
steps:
  - id: fan
    needs: []
    workspace: new
    for_each:
      items: inputs.items
    workflow:
      steps:
        - id: write
          workspace: continue
          command: node -e "const fs=require('fs'); const id=process.env.ITEM; if(id==='b' && fs.readFileSync('a.txt','utf8')!=='a') process.exit(1); fs.writeFileSync(id+'.txt', id)"
          env:
            ITEM: "{{ item.id }}"
`, { items: [{ id: 'a', after: [] }, { id: 'b', after: ['a'] }] });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('reports the branch of a workflow fan item on steps.fan.branches', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A later fan reads the branches a workflow fan published.
inputs:
  names: [string]
steps:
  - id: fan
    needs: []
    workspace: new
    for_each:
      items: inputs.names
    workflow:
      steps:
        - id: write
          needs: []
          workspace: continue
          command: node -e "require('fs').writeFileSync('item.txt', process.env.NAME)"
          env:
            NAME: "{{ item }}"
  - id: list
    needs: [fan]
    for_each: steps.fan.branches
    command: node -e "if (!process.env.BRANCH) process.exit(1)"
    env:
      BRANCH: "{{ item }}"
`, { names: ['a', 'b'] });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const fan = typeof run === 'object' ? run.steps.find((step) => step.id === 'fan') : undefined;
    const branches = fan && 'results' in fan ? fan.results?.map((item) => item.branch) : undefined;
    expect(branches).toEqual([
      expect.stringMatching(/\/fan-0\/p1$/),
      expect.stringMatching(/\/fan-1\/p1$/),
    ]);
  });

  it('restores the branch agent file when a prompt stops before it runs', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A prompt that cannot start puts the branch agent file back.
steps:
  - id: work
    needs: []
    workspace: new
    workflow:
      steps:
        - id: edit
          needs: []
          workspace: continue
          command: node -e "require('fs').writeFileSync('AGENTS.md', 'edited\\n')"
        - id: ask
          needs: [edit]
          workspace: continue
          prompt: Look
`);
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'base\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: workspace });

    const failed = await runLocalDriver(config, runId, workspace);
    expect(failed, JSON.stringify(failed)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const opened = await retryStep(config, runId, await knownSecrets(config), 'work.ask');
    expect(opened, JSON.stringify(opened)).toMatchObject({ data: { retried: { pass: 2 } } });
    config.workflows = { tools: { default: 'claude' }, max_parallel: 1 };
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run() {
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const ask = typeof run === 'object' ? run.steps.find((step) => step.id === 'work.ask' && step.status === 'succeeded') : undefined;
    const branch = ask && 'changes' in ask ? ask.changes?.branch : undefined;
    expect(git(['show', `${branch}:AGENTS.md`], workspace)).toBe('edited\n');
  });

  it('leaves the copy index clean when a prompt stops before it runs on a branch without most tool directories', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Putting the branch agent file back also puts its index entry back.
steps:
  - id: work
    needs: []
    workspace: new
    workflow:
      steps:
        - id: edit
          needs: []
          workspace: continue
          command: node -e "require('fs').writeFileSync('AGENTS.md', 'edited\\n')"
        - id: ask
          needs: [edit]
          workspace: continue
          prompt: Look
`);
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'base\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: workspace });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const copy = worktreePath(workspace, branchName(runId, 'work', 1));
    expect(git(['status', '--porcelain'], copy)).toBe('');
  });

  it('does not publish conflict markers when a prompt fails', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A failed prompt leaves an agent conflict unpublished.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('AGENTS.md', 'left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('AGENTS.md', 'right\\n')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Resolve the agent file.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'base\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: workspace });
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run() {
        return { started: true, exitCode: 1, failure: { code: 'tool_failed', message: 'stopped' } };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join') : undefined;
    const branch = join && 'changes' in join ? join.changes?.branch : undefined;
    if (branch) expect(git(['show', `${branch}:AGENTS.md`], workspace)).not.toContain('<<<<<<<');
    expect(join && 'failure' in join ? join.failure : undefined).toMatchObject({ code: 'merge_conflict' });
  });

  it('records a merge whose resolution matches the branch already checked out', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Choosing the current side of a conflict still records the merge.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('note.txt', 'left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('note.txt', 'right\\n')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Keep the current side.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'note.txt'), 'base\n');
    execFileSync('git', ['add', 'note.txt'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'note'], { cwd: workspace });
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        fs.writeFileSync(path.join(input.cwd, 'note.txt'), 'left\n');
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join') : undefined;
    const branch = join && 'changes' in join ? join.changes?.branch : undefined;
    expect(git(['show', `${branch}:note.txt`], workspace)).toBe('left\n');
    expect(git(['rev-list', '--parents', '-n', '1', String(branch)], workspace).trim().split(' ')).toHaveLength(3);
  });

  it('reports the later child branch when a fan item opens two workspaces', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A fan item reports the child that finished the work.
inputs:
  names: [string]
steps:
  - id: fan
    needs: []
    workspace: new
    for_each:
      items: inputs.names
    workflow:
      steps:
        - id: a
          needs: []
          workspace: new
          command: node -e "require('fs').writeFileSync('a.txt', 'a')"
        - id: b
          needs: [a]
          workspace: new
          command: node -e "const fs=require('fs'); if (fs.readFileSync('a.txt','utf8')!=='a') process.exit(1); fs.writeFileSync('b.txt', 'b')"
`, { names: ['only'] });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const fan = typeof run === 'object' ? run.steps.find((step) => step.id === 'fan') : undefined;
    const branch = fan && 'results' in fan ? fan.results?.[0]?.branch : undefined;
    expect(git(['show', `${branch}:b.txt`], workspace)).toBe('b');
    expect(git(['show', `${branch}:a.txt`], workspace)).toBe('a');
  });

  it('does not delete through a symlink a step put in place of a directory', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-outside-'));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'kept.md'), 'kept\n');
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Replacing a directory with a symlink must not delete the link target.
steps:
  - id: work
    needs: []
    workspace: new
    workflow:
      steps:
        - id: add
          needs: []
          workspace: continue
          command: node -e "require('fs').mkdirSync('.claude',{recursive:true}); require('fs').writeFileSync('.claude/extra.md','extra\\n')"
        - id: link
          needs: [add]
          workspace: continue
          command: node -e "const fs=require('fs'); fs.rmSync('.claude',{recursive:true,force:true}); fs.symlinkSync(process.env.OUT, '.claude')"
          env:
            OUT: ${JSON.stringify(outside)}
`);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(path.join(outside, 'kept.md'), 'utf8')).toBe('kept\n');
    const run = await readRun(config, runId);
    const link = typeof run === 'object' ? run.steps.find((step) => step.id === 'work.link') : undefined;
    const branch = link && 'changes' in link ? link.changes?.branch : undefined;
    expect(git(['show', `${branch}:.claude`], workspace)).toBe(outside);
  });

  it('does not treat an untouched modify/delete conflict as resolved', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A prompt must choose a side when one branch deletes a file the other edits.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('note.txt', 'left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').rmSync('note.txt')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Resolve the deletion.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'note.txt'), 'base\n');
    execFileSync('git', ['add', 'note.txt'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'note'], { cwd: workspace });
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run() {
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join') : undefined;
    expect(join && 'failure' in join ? join.failure : undefined).toMatchObject({ code: 'merge_conflict' });
  });

  it('gives an empty fan-out an empty branch list', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: No items means no branches, and the next fan runs nothing.
inputs:
  names: [string]
steps:
  - id: fan
    needs: []
    workspace: new
    for_each:
      items: inputs.names
    command: node -e "process.exit(1)"
  - id: next
    needs: [fan]
    for_each: steps.fan.branches
    command: node -e "process.exit(1)"
`, { names: [] });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('does not publish conflict markers a prompt left in an agent file', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Editing a conflict is not a resolution while conflict markers remain.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('AGENTS.md', 'left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('AGENTS.md', 'right\\n')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Resolve the agent file.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'base\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: workspace });
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        fs.writeFileSync(path.join(input.cwd, 'AGENTS.md'), '<<<<<<< left\nkept\n');
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join') : undefined;
    expect(join && 'failure' in join ? join.failure : undefined).toMatchObject({ code: 'merge_conflict' });
    expect(git(['show', `${branchName(runId, 'join', 1)}:AGENTS.md`], workspace)).not.toContain('<<<<<<<');
  });

  it('keeps a directory deleted when the branch had added a file inside it', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Deleting a directory stays deleted, including a file an earlier step added.
steps:
  - id: work
    needs: []
    workspace: new
    workflow:
      steps:
        - id: add
          needs: []
          workspace: continue
          command: node -e "require('fs').writeFileSync('.claude/extra.md', 'extra\\n')"
        - id: drop
          needs: [add]
          workspace: continue
          command: node -e "require('fs').rmSync('.claude', {recursive:true, force:true})"
`);
    fs.mkdirSync(path.join(workspace, '.claude'));
    fs.writeFileSync(path.join(workspace, '.claude', 'settings.json'), '{}\n');
    execFileSync('git', ['add', '.claude'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'claude'], { cwd: workspace });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const drop = typeof run === 'object' ? run.steps.find((step) => step.id === 'work.drop') : undefined;
    const branch = drop && 'changes' in drop ? drop.changes?.branch : undefined;
    expect(() => git(['show', `${branch}:.claude/extra.md`], workspace)).toThrow(/does not exist|not in /);
    expect(() => git(['show', `${branch}:.claude/settings.json`], workspace)).toThrow(/does not exist|not in /);
  });

  it('does not publish conflict markers a prompt staged', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Staging a file does not resolve it while conflict markers remain.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('note.txt', 'left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('note.txt', 'right\\n')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Resolve the note.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'note.txt'), 'base\n');
    execFileSync('git', ['add', 'note.txt'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'note'], { cwd: workspace });
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        fs.writeFileSync(path.join(input.cwd, 'note.txt'), '<<<<<<< left\nkept\n');
        execFileSync('git', ['add', '-A'], { cwd: input.cwd });
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join') : undefined;
    expect(join && 'failure' in join ? join.failure : undefined).toMatchObject({ code: 'merge_conflict' });
    expect(git(['show', `${branchName(runId, 'join', 1)}:note.txt`], workspace)).not.toContain('<<<<<<<');
  });

  it('does not publish conflict markers a prompt staged in a quoted path', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A quoted conflict path is still unresolved when markers remain.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('résumé.txt', 'left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('résumé.txt', 'right\\n')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Resolve the note.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'résumé.txt'), 'base\n');
    execFileSync('git', ['add', 'résumé.txt'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'note'], { cwd: workspace });
    execFileSync('git', ['config', 'core.quotepath', 'true'], { cwd: workspace });
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        fs.writeFileSync(path.join(input.cwd, 'résumé.txt'), '<<<<<<< left\nkept\n');
        execFileSync('git', ['add', '-A'], { cwd: input.cwd });
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join') : undefined;
    expect(join && 'failure' in join ? join.failure : undefined).toMatchObject({ code: 'merge_conflict' });
    expect(git(['show', `${branchName(runId, 'join', 1)}:résumé.txt`], workspace)).not.toContain('<<<<<<<');
  });

  it('does not publish a no-op resolution of a quoted agent conflict', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A quoted agent conflict stays unresolved when the prompt does not touch it.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').mkdirSync('.claude',{recursive:true}); require('fs').writeFileSync('.claude/résumé.md','left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').mkdirSync('.claude',{recursive:true}); require('fs').writeFileSync('.claude/résumé.md','right\\n')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Resolve the agent file.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.mkdirSync(path.join(workspace, '.claude'));
    fs.writeFileSync(path.join(workspace, '.claude', 'résumé.md'), 'base\n');
    execFileSync('git', ['add', '.claude'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: workspace });
    execFileSync('git', ['config', 'core.quotepath', 'true'], { cwd: workspace });
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run() {
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join') : undefined;
    expect(join && 'failure' in join ? join.failure : undefined).toMatchObject({ code: 'merge_conflict' });
    const dir = worktreePath(workspace, branchName(runId, 'join', 1));
    expect(fs.readFileSync(path.join(dir, '.claude', 'résumé.md'), 'utf8')).toContain('<<<<<<<');
  });

  it('keeps a modify/delete resolution a prompt staged without editing the file', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Staging the surviving agent file resolves a modify/delete conflict.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('AGENTS.md', 'left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').rmSync('AGENTS.md')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Keep the agent file.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'base\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: workspace });
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        execFileSync('git', ['add', 'AGENTS.md'], { cwd: input.cwd });
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join') : undefined;
    const branch = join && 'changes' in join ? join.changes?.branch : undefined;
    expect(git(['show', `${branch}:AGENTS.md`], workspace)).toBe('left\n');
    expect(git(['rev-list', '--parents', '-n', '1', String(branch)], workspace).trim().split(' ')).toHaveLength(3);
  });

  it('does not publish an untouched modify/delete conflict in an agent file', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Leaving a modify/delete agent conflict alone is not a resolution.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('AGENTS.md', 'left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').rmSync('AGENTS.md')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Resolve the agent file.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'base\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agents'], { cwd: workspace });
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run() {
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join') : undefined;
    expect(join && 'failure' in join ? join.failure : undefined).toMatchObject({ code: 'merge_conflict' });
    expect(git(['rev-list', '--parents', '-n', '1', branchName(runId, 'join', 1)], workspace).trim().split(' ')).toHaveLength(2);
  });

  it('does not publish conflict markers a later retry left staged', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A retry must not publish conflict markers an earlier attempt staged.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('note.txt', 'left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('note.txt', 'right\\n')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Resolve the note.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'note.txt'), 'base\n');
    execFileSync('git', ['add', 'note.txt'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'note'], { cwd: workspace });
    let calls = 0;
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        calls += 1;
        if (calls === 1) {
          fs.writeFileSync(path.join(input.cwd, 'note.txt'), '<<<<<<< left\nkept\n');
          execFileSync('git', ['add', '-A'], { cwd: input.cwd });
        }
        return { started: true, exitCode: 0 };
      },
    };

    const first = await runLocalDriver(config, runId, workspace, { adapter });
    expect(first, JSON.stringify(first)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    stored.status = 'running';
    delete stored.failure;
    delete stored.end;
    stored.steps = stored.steps.map((step) => step.id === 'join' ? { id: step.id, status: 'pending' as const, pass: step.pass } : step);
    await saveRun(config, stored);

    const second = await runLocalDriver(config, runId, workspace, { adapter });

    expect(second, JSON.stringify(second)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join' && step.status === 'failed') : undefined;
    expect(join && 'failure' in join ? join.failure : undefined).toMatchObject({ code: 'merge_conflict' });
    expect(git(['show', `${branchName(runId, 'join', 1)}:note.txt`], workspace)).not.toContain('<<<<<<<');
  });

  it('does not publish conflict markers a prompt committed before validation', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A prompt commit does not clear the conflict, and a later attempt must not publish it.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('note.txt', 'left\\n')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('note.txt', 'right\\n')"
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Resolve the note.
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'note.txt'), 'base\n');
    execFileSync('git', ['add', 'note.txt'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'note'], { cwd: workspace });
    let calls = 0;
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        calls += 1;
        if (calls === 1) {
          fs.writeFileSync(path.join(input.cwd, 'note.txt'), '<<<<<<< left\nkept\n');
          execFileSync('git', ['add', '-A'], { cwd: input.cwd });
          execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'markers'], { cwd: input.cwd });
        }
        return { started: true, exitCode: 0 };
      },
    };

    const first = await runLocalDriver(config, runId, workspace, { adapter });
    expect(first, JSON.stringify(first)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    stored.status = 'running';
    delete stored.failure;
    delete stored.end;
    stored.steps = stored.steps.map((step) => step.id === 'join' ? { id: step.id, status: 'pending' as const, pass: step.pass } : step);
    await saveRun(config, stored);

    const second = await runLocalDriver(config, runId, workspace, { adapter });

    expect(second, JSON.stringify(second)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    const join = typeof run === 'object' ? run.steps.find((step) => step.id === 'join' && step.status === 'failed') : undefined;
    expect(join && 'failure' in join ? join.failure : undefined).toMatchObject({ code: 'merge_conflict' });
  });

  it('keeps an earlier agent edit when a cancelled command is run again', async () => {
    const started = path.join(os.tmpdir(), `teamai-started-${Date.now()}`);
    const again = path.join(os.tmpdir(), `teamai-again-${Date.now()}`);
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Cancelling a command must not make the next attempt commit the base agent file.
steps:
  - id: work
    needs: []
    workspace: new
    workflow:
      steps:
        - id: edit
          needs: []
          workspace: continue
          command: node -e "require('fs').writeFileSync('AGENTS.md', 'edited\\n')"
        - id: slow
          needs: [edit]
          workspace: continue
          command: node slow.js
          env:
            STARTED: ${JSON.stringify(started)}
            AGAIN: ${JSON.stringify(again)}
`);
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'base\n');
    fs.writeFileSync(path.join(workspace, 'slow.js'), `const fs = require('fs');
if (fs.existsSync(process.env.AGAIN)) process.exit(0);
fs.writeFileSync(process.env.STARTED, '');
setInterval(() => {}, 1000);
`);
    execFileSync('git', ['add', 'AGENTS.md', 'slow.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'start'], { cwd: workspace });

    const driving = runLocalDriver(config, runId, workspace);
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(started)) {
      if (Date.now() > deadline) throw new Error('the command did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await cancelRun(config, runId, await knownSecrets(config), 'work.slow')).not.toHaveProperty('error');
    await driving;
    fs.writeFileSync(again, '');
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    stored.status = 'running';
    delete stored.failure;
    delete stored.end;
    stored.steps = stored.steps.map((step) => {
      if (step.id === 'work') return { id: step.id, status: 'running' as const, pass: step.pass };
      if (step.id === 'work.slow') return { id: step.id, status: 'pending' as const, pass: step.pass };
      return step;
    });
    await saveRun(config, stored);

    const second = await runLocalDriver(config, runId, workspace);

    expect(second, JSON.stringify(second)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(git(['show', `${branchName(runId, 'work', 1)}:AGENTS.md`], workspace)).toBe('edited\n');
  });
});

describe('read-only steps in a workspace', () => {
  const EXAMPLE = `schemaVersion: v1alpha1
name: build
description: A test reads the change it needs.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          prompt: Implement the change.
        - id: test
          needs: [implement]
          command: node verify.js
`;
  const modes = ['read-only', 'new', 'continue'] as const;
  const commit = (letter: string): string => letter.repeat(40);

  interface Leased { step: string; attempt: string; revision: number; workspace?: { mode: string; branch: string; base: { commit: string } } }

  function leaseOf(envelope: Awaited<ReturnType<typeof leaseNext>>): Leased {
    if ('error' in envelope || !envelope.data.lease) throw new Error(`expected a lease, got ${JSON.stringify(envelope)}`);
    return envelope.data.lease as Leased;
  }

  /** Leases and reports `change.implement` of the example as `owner`, with a commit `to` on the copy's branch. */
  async function implemented(yaml = EXAMPLE): Promise<{ config: LocalConfig; workspace: string; runId: string; owner: DriverIdentity; base: { commit: string }; branch: string }> {
    const { config, workspace, runId } = await fixture(yaml);
    const owner = driver(workspace);
    const base = { commit: git(['rev-parse', 'HEAD'], workspace).trim() };
    const implement = leaseOf(await leaseNext(config, runId, owner, { base, can: { workspace: [...modes] } }));
    const branch = branchName(runId, 'change', 1);
    expect(implement).toMatchObject({ step: 'change.implement', workspace: { mode: 'continue', branch } });
    const reported = await reportAttempt(config, runId, {
      attempt: implement.attempt, revision: implement.revision, outcome: 'success', driver: owner,
      changes: { branch, base: base.commit, from: base.commit, to: commit('c'), commits: [commit('c')] },
    });
    expect(reported).toMatchObject({ data: { accepted: true } });
    return { config, workspace, runId, owner, base, branch };
  }

  it('leases a read-only step inside a copy on the branch its need wrote, merging nothing', async () => {
    const { config, runId, owner, base, branch } = await implemented();

    const test = await leaseNext(config, runId, owner, { base, can: { workspace: [...modes] } });

    expect(test).toMatchObject({ data: { lease: { step: 'change.test', workspace: {
      mode: 'read-only', base: { commit: base.commit }, configCommit: base.commit, branch, start: { commit: commit('c') }, merge: [],
    } } } });
  });

  it('holds a reader in a copy back from a driver without continue, and from a driver that does not own the copy', async () => {
    const { config, runId, owner, base, branch } = await implemented();

    const reader = await leaseNext(config, runId, owner, { base, can: { workspace: ['read-only', 'new'] } });
    const other = await leaseNext(config, runId, driver(owner.workspace, 'other'), { base, can: { workspace: [...modes] } });

    const needsContinue = `step "change.test" reads workspace ${branch}, which needs continue`;
    const owned = 'step "change.test" reads a workspace owned by another driver';
    expect(reader).toEqual({ data: { wait: { reason: needsContinue, held: [{ step: 'change.test', reason: needsContinue, missing: ['workspace.continue'] }] }, cancelled: [] } });
    // Another driver owns the copy: this one lacks nothing, so `missing` is empty.
    expect(other).toEqual({ data: { wait: { reason: owned, held: [{ step: 'change.test', reason: owned, missing: [] }] }, cancelled: [] } });
  });

  it('runs an item reader on its own item branch, after the items its item waits for, and publishes only writer branches', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Each item reads its own change.
inputs:
  items: [{ id: string, after: [string] }]
steps:
  - id: fan
    workspace: new
    for_each:
      items: inputs.items
    workflow:
      steps:
        - id: implement
          prompt: Implement {{ item.id }}.
        - id: fix
          needs: [implement]
          workspace: new
          command: node fix.js
        - id: test
          needs: [implement]
          command: node verify.js
        - id: review
          needs: [test]
          command: node review.js
`, { items: [{ id: 'a', after: [] }, { id: 'b', after: ['a'] }] });
    const owner = driver(workspace);
    const base = { commit: git(['rev-parse', 'HEAD'], workspace).trim() };
    const ran = new Map<string, string | undefined>();
    for (;;) {
      const next = await leaseNext(config, runId, owner, { base, can: { workspace: [...modes] } });
      if ('data' in next && next.data.done) break;
      const lease = leaseOf(next);
      const contract = lease.workspace;
      ran.set(lease.step, contract?.branch);
      const to = createHash('sha1').update(lease.step).digest('hex');
      await reportAttempt(config, runId, {
        attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: owner,
        ...(contract?.mode === 'read-only' ? { read: { branch: contract.branch, base: base.commit, commit: base.commit } } : {}),
        ...(contract && contract.mode !== 'read-only' ? { changes: { branch: contract.branch, base: base.commit, from: base.commit, to, commits: [to] } } : {}),
      });
    }

    for (const item of ['fan[0]', 'fan[1]']) {
      expect(ran.get(`${item}.test`), item).toBe(branchName(runId, `${item}.implement`, 1));
      expect(ran.get(`${item}.review`), item).toBe(branchName(runId, `${item}.implement`, 1));
    }
    const run = await readRun(config, runId);
    const fan = typeof run === 'object' ? run.steps.find((step) => step.id === 'fan') : undefined;
    expect(fan && 'results' in fan ? fan.results?.map((item) => item.branch) : fan).toEqual([
      branchName(runId, 'fan[0].fix', 1),
      branchName(runId, 'fan[1].fix', 1),
    ]);
  });

  it('reads read from a report payload, and refuses one without branch, base, and commit', () => {
    const report = { attempt: 'a00000000', revision: 1, outcome: 'success', driver: driver('/work') };
    const read = { branch: 'teamai/r/change/p1', base: commit('b'), commit: commit('c') };

    const parsed = parseReport({ ...report, read });

    expect(parsed).toEqual({ report: { ...report, read }, ignored: [] });
    expect(parseReport({ ...report, read: { branch: read.branch, base: read.base } })).toBe('read must include branch, base, and commit');
  });

  it('accepts read for a read-only lease, refuses changes or a success without read, and keeps the copy for the reader', async () => {
    const { config, runId, owner, base, branch } = await implemented();
    const test = leaseOf(await leaseNext(config, runId, owner, { base, can: { workspace: [...modes] } }));
    const read = { branch, base: base.commit, commit: commit('d') };
    const report = (fields: Partial<engine.ReportInput>) => reportAttempt(config, runId, {
      attempt: test.attempt, revision: test.revision, outcome: 'success', driver: owner, ...fields,
    });

    expect(await report({ changes: { branch, base: base.commit, from: commit('c'), to: commit('c'), commits: [] } }))
      .toMatchObject({ error: { code: 'invalid_report', message: expect.stringContaining('leased read-only') } });
    expect(await report({})).toMatchObject({ error: { code: 'invalid_report', message: expect.stringContaining('no read') } });
    expect(await report({ read: { ...read, branch: 'teamai/elsewhere' } }))
      .toMatchObject({ error: { code: 'invalid_report', message: expect.stringContaining('teamai/elsewhere') } });
    const accepted = await report({ read });

    expect(accepted).toMatchObject({ data: { accepted: true, step: { id: 'change.test', status: 'succeeded' }, cleanup: true } });
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    expect(run.steps.find((step) => step.id === 'change.test')).toMatchObject({ read });
    expect(run.copies?.[branch]).toEqual({ owner, commit: commit('c'), used: true });
  });

  it('keeps the copy when a writer reports while its reader is pending, and refuses read for a writable lease', async () => {
    const { config, workspace, runId } = await fixture(EXAMPLE);
    const owner = driver(workspace);
    const base = { commit: git(['rev-parse', 'HEAD'], workspace).trim() };
    const implement = leaseOf(await leaseNext(config, runId, owner, { base, can: { workspace: [...modes] } }));
    const branch = branchName(runId, 'change', 1);
    const report = (fields: Partial<engine.ReportInput>) => reportAttempt(config, runId, {
      attempt: implement.attempt, revision: implement.revision, outcome: 'success', driver: owner, ...fields,
    });

    expect(await report({ read: { branch, base: base.commit, commit: base.commit } }))
      .toMatchObject({ error: { code: 'invalid_report', message: expect.stringContaining(`was leased branch ${branch}`) } });
    const accepted = await report({ changes: { branch, base: base.commit, from: base.commit, to: commit('c'), commits: [commit('c')] } });

    expect(accepted).toMatchObject({ data: { accepted: true, step: { id: 'change.implement' } } });
    expect(accepted).not.toHaveProperty('data.cleanup');
  });

  it.each([
    ['a sub-workflow that needs the writer', `steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          prompt: Implement.
        - id: verify
          needs: [implement]
          workflow:
            steps:
              - id: test
                command: npm test
`, [['change.implement', false], ['change.verify.test', true]]],
    ['a sub-workflow that also waits for a step in another copy', `steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          prompt: Implement.
        - id: side
          needs: []
          workspace: new
          command: echo side
        - id: verify
          needs: [implement, side]
          workflow:
            steps:
              - id: test
                command: npm test
`, [['change.implement', false], ['change.side', true], ['change.verify.test', true]]],
    ['a fan-out that waits for an answer and reads the writer', `inputs:
  items: [string]
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: fix
          workspace: new
          prompt: Fix.
        - id: gate
          needs: []
          approve: { message: Check now? }
        - id: check
          needs: [fix, gate]
          for_each: inputs.items
          command: npm test
`, [['change.fix', false], ['change.check[0]', false], ['change.check[1]', true]]],
    ['a step loop that runs the writer again', `steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          prompt: Implement.
        - id: review
          needs: [implement]
          command: npm run review
          loop: { back_to: implement, while: "length(steps.review.passes) < 2", max_iterations: 2 }
`, [['change.implement', false], ['change.review', false], ['change.implement', false], ['change.review', true]]],
    ['a step loop that runs the reporter again', `steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: review
          prompt: Review.
          loop: { back_to: review, while: "length(steps.review.passes) < 2", max_iterations: 2 }
`, [['change.review', false], ['change.review', true]]],
    ['a looping workflow that runs its steps again', `steps:
  - id: change
    workspace: new
    workflow:
      loop: { while: "length(steps.implement.passes) < 2", max_iterations: 2 }
      steps:
        - id: implement
          prompt: Implement.
`, [['change.implement', false], ['change.implement', true]]],
    ['a loop that opens the copy again on a new branch', `steps:
  - id: change
    workspace: new
    loop: { back_to: change, while: "length(steps.change.passes) < 2", max_iterations: 2 }
    workflow:
      steps:
        - id: implement
          prompt: Implement.
`, [['change.implement', true], ['change.implement', true]]],
  ] as const)('removes a copy only when no step that can still run uses it: %s', async (_name, steps, expected) => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A copy stays while a step that can still run uses it.
${steps}`, steps.startsWith('inputs:') ? { items: ['a', 'b'] } : undefined);
    const owner = driver(workspace);
    const base = { commit: git(['rev-parse', 'HEAD'], workspace).trim() };
    const open: Leased[] = [];
    const reported: Array<[string, boolean]> = [];
    for (let turn = 0; turn < 50; turn += 1) {
      const next = await leaseNext(config, runId, owner, { base, can: { workspace: [...modes], hitl: true }, running: open.map((lease) => lease.attempt) });
      if ('error' in next) throw new Error(JSON.stringify(next));
      if (next.data.done) break;
      if (next.data.lease) {
        open.push(next.data.lease as Leased);
        continue;
      }
      const lease = open.shift();
      if (!lease) {
        const hitl = next.data.hitl as { step: string } | undefined;
        if (!hitl) throw new Error(JSON.stringify(next));
        await respondToHitl(config, runId, await knownSecrets(config), { step: hitl.step, choice: 'yes', channel: 'cli', agent: false });
        continue;
      }
      const contract = lease.workspace;
      const to = createHash('sha1').update(`${lease.step}:${turn}`).digest('hex');
      const answer = await reportAttempt(config, runId, {
        attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: owner,
        ...(contract?.mode === 'read-only' ? { read: { branch: contract.branch, base: base.commit, commit: base.commit } } : {}),
        ...(contract && contract.mode !== 'read-only' ? { changes: { branch: contract.branch, base: base.commit, from: base.commit, to, commits: [to] } } : {}),
      });
      if ('error' in answer) throw new Error(JSON.stringify(answer));
      reported.push([lease.step, answer.data.cleanup === true]);
    }

    expect(reported).toEqual(expected);
  });

  it('runs a test in the copy its implement step changed, and records the commit it read', async () => {
    const { config, workspace, runId } = await fixture(EXAMPLE);
    fs.writeFileSync(path.join(workspace, 'verify.js'), "if (require('fs').readFileSync('tracked.txt', 'utf8') !== 'changed\\n') process.exit(1);\n");
    execFileSync('git', ['add', 'verify.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'verify'], { cwd: workspace });
    const base = git(['rev-parse', 'HEAD'], workspace).trim();
    config.workflows = { tools: { default: 'claude' }, max_parallel: 1 };
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        fs.writeFileSync(path.join(input.cwd, 'tracked.txt'), 'changed\n');
        return { started: true, exitCode: 0 };
      },
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const branch = branchName(runId, 'change', 1);
    const run = await readRun(config, runId);
    const test = typeof run === 'object' ? run.steps.find((step) => step.id === 'change.test') : undefined;
    expect(test).toMatchObject({ status: 'succeeded', read: { branch, base, commit: git(['rev-parse', branch], workspace).trim() } });
    expect(test).not.toHaveProperty('changes');
    expect(fs.readFileSync(path.join(workspace, 'tracked.txt'), 'utf8')).toBe('clean\n');
    expect(fs.existsSync(worktreePath(workspace, branch))).toBe(false);
  });

  it.each([
    ['writes a file', `require('fs').writeFileSync('junk.txt','x')`, { code: 'read_only_dirty', message: expect.stringContaining('junk.txt') }],
    ['writes a file and exits 1', `require('fs').writeFileSync('junk.txt','x'); process.exit(1)`, undefined],
    ['commits a file', `const cp=require('child_process'); require('fs').writeFileSync('junk.txt','x'); cp.execFileSync('git',['add','junk.txt']); cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','junk'])`, { code: 'read_only_dirty', message: expect.stringContaining('HEAD') }],
    ['commits on a branch it switched to', `const cp=require('child_process'); cp.execFileSync('git',['checkout','-qb','side']); require('fs').writeFileSync('junk.txt','x'); cp.execFileSync('git',['add','junk.txt']); cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','junk'])`, { code: 'read_only_dirty', message: expect.stringContaining('HEAD') }],
    ['detaches HEAD', `require('child_process').execFileSync('git',['checkout','-q','--detach','HEAD'])`, { code: 'read_only_dirty', message: expect.stringContaining('HEAD') }],
  ])('puts the copy back at the commit a reader read when it %s, so a later step does not commit it', async (_case, script, failure) => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A reader leaves the copy as it found it.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "${script}"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "require('fs').writeFileSync('polish.txt','yes')"
`);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const test = run.steps.find((step) => step.id === 'change.test');
    const polish = run.steps.find((step) => step.id === 'change.polish');
    const kept = `refs/teamai/kept/${test && 'attempt' in test ? test.attempt : 'none'}`;
    expect(test).toMatchObject({ status: 'failed', ...(failure ? { failure } : { message: expect.stringMatching(/^command exited with status 1\. Read-only command step changed repository paths: junk\.txt\. .*was put back/) }) });
    expect(test).toMatchObject({ message: expect.stringContaining(kept) });
    expect(polish).toMatchObject({ status: 'succeeded' });
    const branch = branchName(runId, 'change', 1);
    expect(test && 'read' in test ? test.read?.commit : undefined).toBe(polish && 'changes' in polish ? polish.changes?.from : 'none');
    expect(git(['show', `${branch}:polish.txt`], workspace)).toBe('yes');
    expect(() => git(['show', `${branch}:junk.txt`], workspace)).toThrow();
  });

  it('does not fail a reader that changed nothing when a tag has its branch name', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A tag named like the copy's branch is not a move off the branch.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('child_process').execFileSync('git',['tag',require('child_process').execFileSync('git',['symbolic-ref','--short','HEAD']).toString().trim()]); require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "0"
`);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('keeps what a reader changed on a ref named in its failure before putting the copy back', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A reader's edits are recoverable after the copy is put back.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "require('fs').writeFileSync('junk.txt','reader')"
`);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    const test = typeof run === 'object' ? run.steps.find((step) => step.id === 'change.test') : undefined;
    const kept = `refs/teamai/kept/${test && 'attempt' in test ? test.attempt : 'none'}`;
    expect(test).toMatchObject({ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining(kept) } });
    expect(git(['show', `${kept}:junk.txt`], workspace)).toBe('reader');
    expect(() => git(['show', `${branchName(runId, 'change', 1)}:junk.txt`], workspace)).toThrow();
  });

  it('says the changes were NOT saved, and leaves them in the copy, when they cannot be kept on a ref', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A ref in the way of refs/teamai/kept/<attempt> stops the keep.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "require('fs').writeFileSync('junk.txt','reader')"
`);
    git(['update-ref', 'refs/teamai/kept', 'HEAD'], workspace);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    const test = typeof run === 'object' ? run.steps.find((step) => step.id === 'change.test') : undefined;
    const copy = worktreePath(workspace, branchName(runId, 'change', 1));
    expect(test).toMatchObject({ status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining(`Its changes were NOT saved and are still in ${copy}`) } });
    expect(fs.readFileSync(path.join(copy, 'junk.txt'), 'utf8')).toBe('reader');
  });

  it('fails a reader with workspace_base, and does not say the copy was put back, when git cannot put it back', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A reader that deletes its copy's branch leaves a copy that cannot be put back.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "const cp=require('child_process'); const b=cp.execFileSync('git',['symbolic-ref','--short','HEAD']).toString().trim(); cp.execFileSync('git',['checkout','-q','--detach']); cp.execFileSync('git',['branch','-qD',b])"
`);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    const test = typeof run === 'object' ? run.steps.find((step) => step.id === 'change.test') : undefined;
    expect(test).toMatchObject({ status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining('could NOT be put back') } });
    expect(test).not.toMatchObject({ failure: { message: expect.stringContaining('was put back') } });
  });

  it('refuses a later writer in a copy a reader left off its branch, and runs it on the branch once the copy is back and the step is retried', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A copy that could not be put back blocks the next writer until a person puts it back.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "const cp=require('child_process'); const b=cp.execFileSync('git',['symbolic-ref','--short','HEAD']).toString().trim(); cp.execFileSync('git',['checkout','-q','--detach']); cp.execFileSync('git',['branch','-qD',b])"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "require('fs').writeFileSync('polish.txt','yes')"
`);
    const branch = branchName(runId, 'change', 1);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({
      status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining(`teamai workflow retry ${runId} change.polish`) },
    });
    const copy = worktreePath(workspace, branch);
    expect(fs.existsSync(path.join(copy, 'polish.txt'))).toBe(false);
    git(['checkout', '-q', '-b', branch], copy);
    expect(await retryStep(config, runId, await knownSecrets(config), 'change.polish')).toMatchObject({ data: { retried: { pass: 2 } } });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const again = await readRun(config, runId);
    if (typeof again !== 'object') throw new Error('run missing');
    expect(again.steps.find((step) => step.id === 'change.polish')).toMatchObject({ status: 'succeeded', changes: { branch } });
    expect(git(['show', `${branch}:polish.txt`], workspace)).toBe('yes');
  });

  it('fails a reader that created a git repository in its copy unrestored, keeps that repository, and refuses the next writer there', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A nested repository survives git clean, so the copy is not put back.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "const cp=require('child_process'); cp.execFileSync('git',['init','-q','nested']); require('fs').writeFileSync('nested/a.txt','x'); cp.execFileSync('git',['add','a.txt'],{cwd:'nested'}); cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','fixture'],{cwd:'nested'})"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "require('fs').writeFileSync('polish.txt','yes')"
`);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const branch = branchName(runId, 'change', 1);
    expect(run.steps.find((step) => step.id === 'change.test')).toMatchObject({
      status: 'failed', failure: { code: 'workspace_base', message: expect.stringMatching(/could NOT be put back.*nested/) },
    });
    expect(fs.existsSync(path.join(worktreePath(workspace, branch), 'nested', 'a.txt'))).toBe(true);
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({ status: 'failed', failure: { code: 'workspace_base' } });
    expect(() => git(['show', `${branch}:nested`], workspace)).toThrow();
    const test = run.steps.find((step) => step.id === 'change.test');
    const attempt = test && 'attempt' in test ? test.attempt : 'none';
    const nested = git(['rev-parse', `refs/teamai/kept/${attempt}:nested`], workspace).trim();
    expect(git(['show', `refs/teamai/kept-modules/${attempt}/${nested}:a.txt`], workspace)).toBe('x');
  });

  it('fails a reader that created a git repository in its copy unrestored when the repository hides untracked files from status', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: status.showUntrackedFiles=no does not hide a repository the reader left.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "const cp=require('child_process'); cp.execFileSync('git',['init','-q','nested']); require('fs').writeFileSync('nested/a.txt','x'); cp.execFileSync('git',['add','a.txt'],{cwd:'nested'}); cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','fixture'],{cwd:'nested'})"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "require('fs').writeFileSync('polish.txt','yes')"
`);
    git(['config', 'status.showUntrackedFiles', 'no'], workspace);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const branch = branchName(runId, 'change', 1);
    expect(run.steps.find((step) => step.id === 'change.test')).toMatchObject({
      status: 'failed', failure: { code: 'workspace_base', message: expect.stringMatching(/could NOT be put back.*nested/) },
    });
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({ status: 'failed', failure: { code: 'workspace_base' } });
    expect(() => git(['show', `${branch}:nested`], workspace)).toThrow();
  });

  it('refuses a writer in a copy whose reader never finished, and clears that by itself once the copy is back', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: The marker staging writes outlives a driver killed mid-reader.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "const m=require('child_process').execFileSync('git',['rev-parse','--git-path','teamai-unrestored']).toString().trim(); require('fs').copyFileSync(m,'../../../marker')"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "const fs=require('fs'); if (!fs.existsSync('../../../go')) process.exit(1); fs.writeFileSync('polish.txt','yes')"
`);
    const branch = branchName(runId, 'change', 1);
    const copy = worktreePath(workspace, branch);
    await runLocalDriver(config, runId, workspace);
    const marker = path.resolve(copy, git(['rev-parse', '--git-path', 'teamai-unrestored'], copy).trim());
    expect(fs.existsSync(marker)).toBe(false);
    const staged = fs.readFileSync(path.join(workspace, 'marker'), 'utf8');
    expect(JSON.parse(staged)).toMatchObject({ branch, step: 'change.test', reason: 'the reader did not finish', found: [] });
    // What a driver killed while the reader ran leaves: the marker as staging wrote it, and the reader's file.
    fs.writeFileSync(marker, staged);
    fs.writeFileSync(path.join(copy, 'junk.txt'), 'reader');
    fs.writeFileSync(path.join(workspace, 'go'), '');
    expect(await retryStep(config, runId, await knownSecrets(config), 'change.polish')).toMatchObject({ data: { retried: { pass: 2 } } });

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({
      status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining('junk.txt') },
    });
    expect(() => git(['show', `${branch}:junk.txt`], workspace)).toThrow();
    fs.rmSync(path.join(copy, 'junk.txt'));
    expect(await retryStep(config, runId, await knownSecrets(config), 'change.polish')).toMatchObject({ data: { retried: { pass: 3 } } });

    await runLocalDriver(config, runId, workspace);

    const again = await readRun(config, runId);
    if (typeof again !== 'object') throw new Error('run missing');
    expect(again.steps.find((step) => step.id === 'change.polish')).toMatchObject({ status: 'succeeded', changes: { branch } });
    expect(git(['show', `${branch}:polish.txt`], workspace)).toBe('yes');
    expect(() => git(['show', `${branch}:junk.txt`], workspace)).toThrow();
  });

  it('refuses a writer whose existing copy is on a detached HEAD, naming the branch to put it back on', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A copy left detached, as by a driver stopped before it put the copy back, is not reused.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "const fs=require('fs'); if (!fs.existsSync('../../../go')) process.exit(1); fs.writeFileSync('polish.txt','yes')"
`);
    const branch = branchName(runId, 'change', 1);
    await runLocalDriver(config, runId, workspace);
    const copy = worktreePath(workspace, branch);
    git(['checkout', '-q', '--detach'], copy);
    fs.writeFileSync(path.join(workspace, 'go'), '');
    expect(await retryStep(config, runId, await knownSecrets(config), 'change.polish')).toMatchObject({ data: { retried: { pass: 2 } } });

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({
      status: 'failed', failure: { code: 'workspace_base', message: expect.stringMatching(new RegExp(`${copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is detached at .*not on branch ${branch}`)) },
    });
    expect(() => git(['show', `${branch}:polish.txt`], workspace)).toThrow();
    expect(fs.existsSync(path.join(copy, 'polish.txt'))).toBe(false);
  });

  it.each([
    ['a command that switches to another branch', "cp.execFileSync('git',['switch','-q','-c','scratch']); fs.writeFileSync('edited.txt','yes')", 'on refs/heads/scratch'],
    ['a command that detaches HEAD and commits', "cp.execFileSync('git',['checkout','-q','--detach']); fs.writeFileSync('edited.txt','yes'); cp.execFileSync('git',['add','edited.txt']); cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','step'])", 'detached at'],
    ['a failing command that switches to another branch', "cp.execFileSync('git',['switch','-q','-c','scratch']); fs.writeFileSync('edited.txt','yes'); process.exit(3)", 'on refs/heads/scratch'],
    ['a prompt that switches to another branch', undefined, 'on refs/heads/scratch'],
  ])('fails a writer that leaves its branch without committing, reporting, or pushing for that branch: %s', async (_name, script, where) => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A writer's changes reach its branch only from that branch.
steps:
  - id: edit
    workspace: new
    ${script === undefined ? 'prompt: Edit.' : `command: node -e "const cp=require('child_process'),fs=require('fs'); ${script}"`}
`);
    const base = git(['rev-parse', 'HEAD'], workspace).trim();
    const origin = path.join(path.dirname(workspace), 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    git(['remote', 'add', 'origin', origin], workspace);
    config.workflows = { tools: { default: 'claude' }, max_parallel: 1 };
    const adapter: LocalToolAdapter = {
      async runInteractive() {
        return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
      },
      async run(_tool, input) {
        execFileSync('git', ['switch', '-q', '-c', 'scratch'], { cwd: input.cwd });
        fs.writeFileSync(path.join(input.cwd, 'edited.txt'), 'yes');
        return { started: true, exitCode: 0 };
      },
    };

    await runLocalDriver(config, runId, workspace, { adapter });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const branch = branchName(runId, 'edit', 1);
    const edit = run.steps.find((step) => step.id === 'edit');
    expect(edit).toMatchObject({ status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining(`${where}`) } });
    expect(edit).toMatchObject({ failure: { message: expect.stringContaining(`not on branch ${branch}`) } });
    expect(edit).not.toHaveProperty('changes');
    expect(git(['rev-parse', branch], workspace).trim()).toBe(base);
    expect(git(['log', '--all', '--format=%an'], workspace)).not.toContain('TeamAI');
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads'], origin)).toBe('');
  });

  it('creates the copy again when its directory was deleted', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A deleted copy is created again.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "const fs=require('fs'); if (!fs.existsSync('../../../go')) process.exit(1); fs.writeFileSync('polish.txt','yes')"
`);
    const branch = branchName(runId, 'change', 1);
    await runLocalDriver(config, runId, workspace);
    fs.rmSync(worktreePath(workspace, branch), { recursive: true, force: true });
    fs.writeFileSync(path.join(workspace, 'go'), '');
    expect(await retryStep(config, runId, await knownSecrets(config), 'change.polish')).toMatchObject({ data: { retried: { pass: 2 } } });

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({ status: 'succeeded', changes: { branch } });
    expect(git(['show', `${branch}:polish.txt`], workspace)).toBe('yes');
  });

  it('refuses a directory at the copy path that is not a workflow worktree, without telling the user to check out a branch there', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A plain directory where the copy goes is not used.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "const fs=require('fs'); if (!fs.existsSync('../../../go')) process.exit(1); fs.writeFileSync('polish.txt','yes')"
`);
    const branch = branchName(runId, 'change', 1);
    const copy = worktreePath(workspace, branch);
    fs.mkdirSync(copy, { recursive: true });
    const active = git(['symbolic-ref', 'HEAD'], workspace).trim();

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    expect(run.steps.find((step) => step.id === 'change.implement')).toMatchObject({
      status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining(`${copy} is not a workflow worktree`) },
    });
    expect(run.steps.find((step) => step.id === 'change.implement')).not.toMatchObject({ failure: { message: expect.stringContaining('Check out') } });
    expect(git(['symbolic-ref', 'HEAD'], workspace).trim()).toBe(active);
  });

  it('refuses a writer in a copy whose marker cannot be read', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: An unreadable marker fails closed.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('impl.txt','yes')"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "const fs=require('fs'); if (!fs.existsSync('../../../go')) process.exit(1); fs.writeFileSync('polish.txt','yes')"
`);
    const branch = branchName(runId, 'change', 1);
    const copy = worktreePath(workspace, branch);
    await runLocalDriver(config, runId, workspace);
    fs.mkdirSync(path.resolve(copy, git(['rev-parse', '--git-path', 'teamai-unrestored'], copy).trim()));
    fs.writeFileSync(path.join(workspace, 'go'), '');
    expect(await retryStep(config, runId, await knownSecrets(config), 'change.polish')).toMatchObject({ data: { retried: { pass: 2 } } });

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({
      status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining('has a marker teamai cannot read') },
    });
    expect(() => git(['show', `${branch}:polish.txt`], workspace)).toThrow();
  });

  it('puts a submodule a reader changed back at the commit the copy records, so a later step does not commit it', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A reader's commit inside a submodule does not reach the branch.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('child_process').execFileSync('git',['-c','protocol.file.allow=always','submodule','update','-q','--init']); require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "const cp=require('child_process'),fs=require('fs'); fs.writeFileSync('vendor/inside.txt','reader'); cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-qam','reader'],{cwd:'vendor'})"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "const fs=require('fs'); if (fs.readFileSync('vendor/inside.txt','utf8')!=='one\\\\n') process.exit(2); fs.writeFileSync('polish.txt','yes')"
`);
    const recorded = addSubmodule(workspace);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const test = run.steps.find((step) => step.id === 'change.test');
    expect(test).toMatchObject({ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('vendor') } });
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({ status: 'succeeded' });
    const branch = branchName(runId, 'change', 1);
    expect(git(['show', `${branch}:polish.txt`], workspace)).toBe('yes');
    expect(git(['rev-parse', `${branch}:vendor`], workspace).trim()).toBe(recorded);
    const attempt = test && 'attempt' in test ? test.attempt : 'none';
    const reader = git(['rev-parse', `refs/teamai/kept/${attempt}:vendor`], workspace).trim();
    expect(reader).not.toBe(recorded);
    expect(fs.existsSync(worktreePath(workspace, branch))).toBe(false);
    expect(git(['cat-file', '-t', reader], workspace).trim()).toBe('commit');
    expect(git(['rev-parse', `refs/teamai/kept-modules/${attempt}/${reader}`], workspace).trim()).toBe(reader);
    expect(test).toMatchObject({ failure: { message: expect.stringContaining(`refs/teamai/kept-modules/${attempt}/`) } });
  });

  it('puts a submodule whose update mode is rebase back at the recorded commit after a reader commits in it', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A configured submodule update mode does not keep the reader's commit.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('child_process').execFileSync('git',['-c','protocol.file.allow=always','submodule','update','-q','--init']); require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "const cp=require('child_process'),fs=require('fs'); fs.writeFileSync('vendor/inside.txt','reader'); cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-qam','reader'],{cwd:'vendor'})"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "require('fs').writeFileSync('polish.txt','yes')"
`);
    const recorded = addSubmodule(workspace);
    git(['config', '-f', '.gitmodules', 'submodule.vendor.update', 'rebase'], workspace);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qam', 'rebase'], workspace);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    expect(run.steps.find((step) => step.id === 'change.test')).toMatchObject({ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('was put back') } });
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({ status: 'succeeded' });
    const branch = branchName(runId, 'change', 1);
    expect(git(['rev-parse', `${branch}:vendor`], workspace).trim()).toBe(recorded);
  });

  it('leaves a submodule a reader edited untouched, fails it unrestored, and refuses the next step in that copy', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Uncommitted and untracked files inside a submodule are not kept, so they stay.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('child_process').execFileSync('git',['-c','protocol.file.allow=always','submodule','update','-q','--init']); require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "const fs=require('fs'); fs.writeFileSync('vendor/inside.txt','reader'); fs.writeFileSync('vendor/untracked.txt','x')"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "require('fs').writeFileSync('polish.txt','yes')"
`);
    addSubmodule(workspace);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const branch = branchName(runId, 'change', 1);
    const copy = worktreePath(workspace, branch);
    expect(run.steps.find((step) => step.id === 'change.test')).toMatchObject({ status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining('vendor') } });
    expect(run.steps.find((step) => step.id === 'change.test')).toMatchObject({ failure: { message: expect.stringContaining('could NOT be put back') } });
    expect(fs.readFileSync(path.join(copy, 'vendor', 'inside.txt'), 'utf8')).toBe('reader');
    expect(fs.existsSync(path.join(copy, 'vendor', 'untracked.txt'))).toBe(true);
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({ status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining(`teamai workflow retry ${runId} change.polish`) } });
    expect(() => git(['show', `${branch}:polish.txt`], workspace)).toThrow();
  });

  it('puts the copy back around a submodule an earlier writer left dirty when the reader changed only a superproject file', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A reader is not blamed for a submodule it did not touch.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('child_process').execFileSync('git',['-c','protocol.file.allow=always','submodule','update','-q','--init']); require('fs').writeFileSync('vendor/inside.txt','writer'); require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "require('fs').writeFileSync('report.txt','reader')"
        - id: polish
          needs: [test]
          workspace: continue
          command: node -e "const fs=require('fs'); if (fs.readFileSync('vendor/inside.txt','utf8')!=='writer') process.exit(2); fs.writeFileSync('polish.txt','yes')"
`);
    addSubmodule(workspace);
    git(['config', 'submodule.recurse', 'true'], workspace);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const test = run.steps.find((step) => step.id === 'change.test');
    const kept = `refs/teamai/kept/${test && 'attempt' in test ? test.attempt : 'none'}`;
    expect(test).toMatchObject({ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining(kept) } });
    expect(git(['show', `${kept}:report.txt`], workspace)).toBe('reader');
  });

  it('leaves the copy untouched when a reader commits only in a nested submodule, and says its change was NOT saved', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A commit in vendor/inner shows only as an uncommitted gitlink in vendor, which the kept ref cannot hold.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('child_process').execFileSync('git',['-c','protocol.file.allow=always','submodule','update','-q','--init','--recursive']); require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "const cp=require('child_process'),fs=require('fs'); fs.writeFileSync('vendor/inner/inside.txt','reader'); cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-qam','reader'],{cwd:'vendor/inner'})"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "require('fs').writeFileSync('polish.txt','yes')"
`);
    const inner = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sub-'));
    dirs.push(inner);
    execFileSync('git', ['init', '-q'], { cwd: inner });
    fs.writeFileSync(path.join(inner, 'inside.txt'), 'one\n');
    execFileSync('git', ['add', 'inside.txt'], { cwd: inner });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'one'], { cwd: inner });
    const original = git(['rev-parse', 'HEAD'], inner).trim();
    addSubmodule(workspace, inner);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const branch = branchName(runId, 'change', 1);
    const copy = worktreePath(workspace, branch);
    expect(run.steps.find((step) => step.id === 'change.test')).toMatchObject({
      status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining(`Its changes were NOT saved and are still in ${copy}`) },
    });
    expect(git(['rev-parse', 'HEAD'], path.join(copy, 'vendor', 'inner')).trim()).not.toBe(original);
    expect(fs.readFileSync(path.join(copy, 'vendor', 'inner', 'inside.txt'), 'utf8')).toBe('reader');
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({ status: 'failed', failure: { code: 'workspace_base' } });
  });

  it('leaves a nested submodule commit an earlier writer made where it is when a reader changes only a superproject file', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Putting the copy back updates only the submodules the reader changed.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "const cp=require('child_process'),fs=require('fs'); cp.execFileSync('git',['-c','protocol.file.allow=always','submodule','update','-q','--init','--recursive']); fs.writeFileSync('vendor/inner/inside.txt','writer'); cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-qam','writer'],{cwd:'vendor/inner'}); fs.writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "require('fs').writeFileSync('report.txt','reader')"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "const fs=require('fs'); if (fs.readFileSync('vendor/inner/inside.txt','utf8')!=='writer') process.exit(2); fs.writeFileSync('polish.txt','yes')"
`);
    const inner = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sub-'));
    dirs.push(inner);
    execFileSync('git', ['init', '-q'], { cwd: inner });
    fs.writeFileSync(path.join(inner, 'inside.txt'), 'one\n');
    execFileSync('git', ['add', 'inside.txt'], { cwd: inner });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'one'], { cwd: inner });
    addSubmodule(workspace, inner);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    expect(run.steps.find((step) => step.id === 'change.test')).toMatchObject({ status: 'failed', failure: { code: 'read_only_dirty' } });
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({ status: 'succeeded' });
  });

  it('keeps a nested submodule commit the reader recorded in its parent after the copy is removed', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: Every submodule commit the reader made is kept, at any depth.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('child_process').execFileSync('git',['-c','protocol.file.allow=always','submodule','update','-q','--init','--recursive']); require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "const cp=require('child_process'),fs=require('fs'); const commit=(cwd)=>cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-qam','reader'],{cwd}); fs.writeFileSync('vendor/inner/inside.txt','reader'); commit('vendor/inner'); commit('vendor')"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "require('fs').writeFileSync('polish.txt','yes')"
`);
    const inner = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sub-'));
    dirs.push(inner);
    execFileSync('git', ['init', '-q'], { cwd: inner });
    fs.writeFileSync(path.join(inner, 'inside.txt'), 'one\n');
    execFileSync('git', ['add', 'inside.txt'], { cwd: inner });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'one'], { cwd: inner });
    addSubmodule(workspace, inner);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const test = run.steps.find((step) => step.id === 'change.test');
    expect(test).toMatchObject({ status: 'failed', failure: { code: 'read_only_dirty' } });
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({ status: 'succeeded' });
    expect(fs.existsSync(worktreePath(workspace, branchName(runId, 'change', 1)))).toBe(false);
    const attempt = test && 'attempt' in test ? test.attempt : 'none';
    const vendor = git(['rev-parse', `refs/teamai/kept/${attempt}:vendor`], workspace).trim();
    const nested = git(['rev-parse', `refs/teamai/kept-modules/${attempt}/${vendor}:inner`], workspace).trim();
    expect(git(['show', `refs/teamai/kept-modules/${attempt}/${nested}:inside.txt`], workspace)).toBe('reader');
  });

  it('refuses a later step in a copy whose reader edited a submodule an earlier writer left dirty, though its status line is the same', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: The same status line does not prove a copy that was dirty when the reader started is back.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "const cp=require('child_process'),fs=require('fs'); cp.execFileSync('git',['-c','protocol.file.allow=always','submodule','update','-q','--init']); fs.writeFileSync('vendor/inside.txt','writer'); fs.writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "require('fs').writeFileSync('vendor/inside.txt','reader')"
        - id: polish
          needs: [implement]
          workspace: continue
          command: node -e "require('fs').writeFileSync('polish.txt','yes')"
`);
    addSubmodule(workspace);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const copy = worktreePath(workspace, branchName(runId, 'change', 1));
    expect(run.steps.find((step) => step.id === 'change.test')).toMatchObject({ status: 'failed', failure: { code: 'workspace_base' } });
    expect(run.steps.find((step) => step.id === 'change.polish')).toMatchObject({ status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining('delete') } });
    expect(fs.readFileSync(path.join(copy, 'vendor', 'inside.txt'), 'utf8')).toBe('reader');
  });

  it('leaves the copy as the reader left it when it deletes a submodule that held uncommitted files, and says they were NOT saved', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A submodule directory the reader removed cannot be put back without losing what was in it.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('child_process').execFileSync('git',['-c','protocol.file.allow=always','submodule','update','-q','--init']); require('fs').writeFileSync('vendor/inside.txt','writer'); require('fs').writeFileSync('impl.txt','yes')"
        - id: test
          needs: [implement]
          command: node -e "require('fs').rmSync('vendor',{recursive:true,force:true})"
`);
    addSubmodule(workspace);

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    const copy = worktreePath(workspace, branchName(runId, 'change', 1));
    expect(run.steps.find((step) => step.id === 'change.test')).toMatchObject({
      status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining(`Its changes were NOT saved and are still in ${copy}`) },
    });
    expect(fs.existsSync(path.join(copy, 'vendor'))).toBe(false);
  });

  it.each([
    ['submodule.vendor.ignore=all in .gitmodules', ['config', '-f', '.gitmodules', 'submodule.vendor.ignore', 'all']],
    ['submodule.vendor.ignore=all in the git config', ['config', 'submodule.vendor.ignore', 'all']],
    ['diff.ignoreSubmodules=all', ['config', 'diff.ignoreSubmodules', 'all']],
  ])('sees what a step changed in a submodule whatever git is told to ignore: %s', async (_name, setting) => {
    const init = "cp.execFileSync('git',['-c','protocol.file.allow=always','submodule','update','-q','--init'])";
    const commit = "fs.writeFileSync('vendor/inside.txt','step'); cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-qam','step'],{cwd:'vendor'})";
    const run = (script: string): string => `node -e "const cp=require('child_process'),fs=require('fs'); ${script}"`;
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A submodule change is seen when git config hides it.
steps:
  - id: active
    command: ${run("fs.writeFileSync('vendor/inside.txt','step')")}
  - id: commits
    needs: []
    workspace: new
    workflow:
      steps:
        - id: init
          workspace: continue
          command: ${run(init)}
        - id: read
          needs: [init]
          command: ${run(commit)}
  - id: edits
    needs: []
    workspace: new
    workflow:
      steps:
        - id: init
          workspace: continue
          command: ${run(init)}
        - id: read
          needs: [init]
          command: ${run("fs.writeFileSync('vendor/inside.txt','step')")}
  - id: writes
    needs: []
    workspace: new
    command: ${run(`${init}; ${commit}`)}
`);
    const recorded = addSubmodule(workspace);
    git(setting, workspace);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qam', 'ignore', '--allow-empty'], workspace);

    await runLocalDriver(config, runId, workspace);

    const state = await readRun(config, runId);
    if (typeof state !== 'object') throw new Error('run missing');
    const step = (id: string) => state.steps.find((item) => item.id === id);
    expect(step('active')).toMatchObject({ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('vendor') } });
    const read = step('commits.read');
    expect(read).toMatchObject({ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('vendor') } });
    const attempt = read && 'attempt' in read ? read.attempt : 'none';
    const kept = git(['rev-parse', `refs/teamai/kept/${attempt}:vendor`], workspace).trim();
    expect(kept).not.toBe(recorded);
    expect(git(['rev-parse', `refs/teamai/kept-modules/${attempt}/${kept}`], workspace).trim()).toBe(kept);
    expect(step('edits.read')).toMatchObject({ status: 'failed', failure: { code: 'workspace_base', message: expect.stringContaining('NOT saved') } });
    expect(step('writes')).toMatchObject({ status: 'succeeded' });
    expect(git(['rev-parse', `${branchName(runId, 'writes', 1)}:vendor`], workspace).trim()).not.toBe(recorded);
  });

  it('runs a reader in a copy on the base tool settings, so a hook an earlier step committed there is absent', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A reader does not see tool settings committed earlier.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('.tclaude/settings.json','{\\"hooks\\":{}}')"
        - id: test
          needs: [implement]
          command: node -e "if (require('fs').readFileSync('.tclaude/settings.json','utf8')!=='base') process.exit(2)"
`);
    fs.mkdirSync(path.join(workspace, '.tclaude'));
    fs.writeFileSync(path.join(workspace, '.tclaude', 'settings.json'), 'base');
    execFileSync('git', ['add', '.tclaude'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'tool settings'], { cwd: workspace });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(git(['show', `${branchName(runId, 'change', 1)}:.tclaude/settings.json`], workspace)).toBe('{"hooks":{}}');
  });

  it('leases a read-only step outside any copy with no workspace, even when it needs a step that wrote one', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A top-level reader stays in the checkout.
steps:
  - id: edit
    workspace: new
    command: node edit.js
  - id: check
    needs: [edit]
    command: node check.js
`);
    const owner = driver(workspace);
    const base = { commit: git(['rev-parse', 'HEAD'], workspace).trim() };
    const edit = leaseOf(await leaseNext(config, runId, owner, { base, can: { workspace: [...modes] } }));
    const branch = branchName(runId, 'edit', 1);
    await reportAttempt(config, runId, {
      attempt: edit.attempt, revision: edit.revision, outcome: 'success', driver: owner,
      changes: { branch, base: base.commit, from: base.commit, to: commit('c'), commits: [commit('c')] },
    });

    const check = leaseOf(await leaseNext(config, runId, owner, { base, can: { workspace: [...modes] } }));

    expect(check.step).toBe('check');
    expect(check).not.toHaveProperty('workspace');
  });

  it('fails a reader whose needs changed two branches with workspace_base, naming both', async () => {
    const { config, workspace, runId } = await fixture(`schemaVersion: v1alpha1
name: build
description: A reader cannot read two branches at once.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: left
          workspace: new
          command: node left.js
        - id: right
          needs: []
          workspace: new
          command: node right.js
        - id: test
          needs: [left, right]
          command: node verify.js
`);
    const owner = driver(workspace);
    const base = { commit: git(['rev-parse', 'HEAD'], workspace).trim() };
    for (const [step, to] of [['left', commit('1')], ['right', commit('2')]] as const) {
      const leased = leaseOf(await leaseNext(config, runId, owner, { base, can: { workspace: [...modes] } }));
      expect(leased.step).toBe(`change.${step}`);
      await reportAttempt(config, runId, {
        attempt: leased.attempt, revision: leased.revision, outcome: 'success', driver: owner,
        changes: { branch: branchName(runId, `change.${step}`, 1), base: base.commit, from: base.commit, to, commits: [to] },
      });
    }

    const done = await leaseNext(config, runId, owner, { base, can: { workspace: [...modes] } });

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' ? run.steps.find((step) => step.id === 'change.test') : run).toMatchObject({
      status: 'failed',
      failure: {
        code: 'workspace_base',
        message: `step "change.test" reads branches ${branchName(runId, 'change.left', 1)}, ${branchName(runId, 'change.right', 1)}; add a step that merges them and need that step`,
      },
    });
  });
});
