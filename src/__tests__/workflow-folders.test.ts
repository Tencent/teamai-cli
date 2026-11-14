import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { knownSecrets } from '../env-resolution.js';
import { DefaultWorkflows } from '../default-workflows.js';
import { getHandler } from '../resources/index.js';
import { RESOURCE_LAYOUTS, Resources } from '../resources/resolver.js';
import { getDataHome } from '../types.js';
import { log } from '@teamai/shared/log';
import { getCurrentVersion } from '../package-info.js';
import { folderOf, loadCachedWorkflow, namespaceConflictOf } from '../workflow/cache.js';
import { _setDriverPollMs, runLocalDriver, type DriverRuntimes } from '../workflow/drivers/local/local-driver.js';
import { hostStepRuntime } from '../workflow/runtimes/host.js';
import type { PlaceView } from '@teamai/runtime-protocol';
import { startRun } from '../workflow/engine.js';
import { WorkflowFolder } from '../workflow/folder.js';
import { claimRun, publishRun } from '../workflow/handoff.js';
import { sweepLeftovers } from '../workflow/leftovers.js';
import { readRun, RunIdSchema } from '../workflow/store.js';
import { skillHarness } from './helpers/skill-harness.js';
import { dirs as handoffDirs, pull, team as handoffTeam } from './helpers/workflow-handoff-fixture.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of [...dirs.splice(0), ...handoffDirs.splice(0)]) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A project scope whose team repo is a git checkout with an empty first commit. */
function teamScope(): { config: LocalConfig; put: (file: string, content: string | Buffer) => void; commit: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-wf-folders-'));
  dirs.push(root);
  const repo = path.join(root, 'team-repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'TeamAI Test');
  git(repo, 'config', 'user.email', 'test@example.com');

  return {
    config: { repo: { localPath: repo, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') },
    put: (file, content) => {
      const full = path.join(repo, ...file.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    },
    commit: () => {
      git(repo, 'add', '-A');
      git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'team content');
    },
  };
}

const RELEASE = `schemaVersion: v1alpha1
name: release
description: Plan the release, summarise it and open the PR.
steps:
  - id: plan
    command: python3 "$TEAMAI_WORKFLOW_DIR/plan.py"
    output: { version: string }
`;

describe('workflow folders', () => {
  it('caches workflows/<name>/WORKFLOW.yaml as the workflow named after its directory, with every file of the folder', async () => {
    const team = teamScope();
    team.put('workflows/release/WORKFLOW.yaml', RELEASE);
    team.put('workflows/release/plan.py', 'print("{\\"version\\": \\"1.2.0\\"}")\n');
    team.put('workflows/release/README.md', '# Release\n');
    team.commit();

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toEqual([]);
    expect(result.cached).toEqual(['release']);
    const cached = await loadCachedWorkflow(team.config, 'release');
    expect(cached?.relativePath).toBe('workflows/release/WORKFLOW.yaml');
    expect(cached?.definition.description).toBe('Plan the release, summarise it and open the PR.');
    expect(cached?.files?.map((file) => file.path)).toEqual(['README.md', 'WORKFLOW.yaml', 'plan.py']);
  });

  it('finds a folder in a namespace, keeps a namespace without the marker and a lower-case workflow.yaml as today, and notes a YAML file inside a folder', async () => {
    const team = teamScope();
    team.put('workflows/payments/release/WORKFLOW.yaml', RELEASE);
    team.put('workflows/payments/release/checks.yaml', 'not: a workflow\n');
    team.put('workflows/payments/deploy.yaml', RELEASE.replace('name: release', 'name: deploy'));
    team.put('workflows/lower/workflow.yaml', RELEASE.replace('name: release', 'name: workflow'));
    team.commit();
    const info = vi.spyOn(log, 'info');

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toEqual([]);
    expect(result.cached.sort()).toEqual(['deploy', 'release', 'workflow']);
    expect((await loadCachedWorkflow(team.config, 'release'))?.relativePath).toBe('workflows/payments/release/WORKFLOW.yaml');
    expect((await loadCachedWorkflow(team.config, 'workflow'))?.relativePath).toBe('workflows/lower/workflow.yaml');
    expect(info).toHaveBeenCalledWith('[workflows] workflows/payments/release/ is a workflow folder; checks.yaml in it is not a workflow');
  });

  it('drops the last valid version of a folder that holds a symlink, naming the file', async () => {
    const team = teamScope();
    team.put('workflows/release/WORKFLOW.yaml', RELEASE);
    team.commit();
    await syncScorersThenWorkflows(team.config);
    fs.mkdirSync(path.join(team.config.repo.localPath, 'workflows', 'release', 'lib'));
    fs.symlinkSync(path.join(team.config.repo.localPath, 'workflows', 'release', 'WORKFLOW.yaml'), path.join(team.config.repo.localPath, 'workflows', 'release', 'lib', 'link.yaml'));

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toMatchObject([{ file: 'workflows/release/WORKFLOW.yaml', code: 'workflow_folder_invalid', message: 'workflows/release/ is not a valid workflow folder: lib/link.yaml is a symlink' }]);
    expect(await loadCachedWorkflow(team.config, 'release')).toBeNull();
  });

  it('drops the last valid version of a folder that becomes a symlink, naming it', async () => {
    const team = teamScope();
    team.put('workflows/release/WORKFLOW.yaml', RELEASE);
    team.commit();
    await syncScorersThenWorkflows(team.config);
    const workflows = path.join(team.config.repo.localPath, 'workflows');
    fs.renameSync(path.join(workflows, 'release'), path.join(team.config.repo.localPath, 'shared-release'));
    fs.symlinkSync(path.join('..', 'shared-release'), path.join(workflows, 'release'), 'dir');

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toMatchObject([{
      file: 'workflows/release/WORKFLOW.yaml',
      code: 'workflow_folder_invalid',
      message: 'workflows/release/ is a symlink, and a folder holds its own files, never a link, so nothing is read from it. Put the directory itself in the team repo.',
    }]);
    expect(await loadCachedWorkflow(team.config, 'release')).toBeNull();
  });

  it('refuses a folder holding a file that is not UTF-8 text, naming it', async () => {
    const team = teamScope();
    team.put('workflows/release/WORKFLOW.yaml', RELEASE);
    team.put('workflows/release/assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]));
    team.commit();

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toMatchObject([{ code: 'workflow_folder_invalid', message: 'workflows/release/ is not a valid workflow folder: assets/logo.png is not UTF-8 text' }]);
  });

  it('refuses a folder of more than 1 MB in total, naming its five largest files', async () => {
    const team = teamScope();
    team.put('workflows/release/WORKFLOW.yaml', RELEASE);
    team.put('workflows/release/README.md', 'r'.repeat(10));

    for (const [index, size] of [300_000, 250_000, 200_000, 150_000, 100_000, 60_000].entries()) {
      team.put(`workflows/release/data/part-${index}.txt`, 'x'.repeat(size));
    }

    team.commit();

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toMatchObject([{
      code: 'workflow_folder_invalid',
      message: `workflows/release/ is not a valid workflow folder: it holds ${Buffer.byteLength(RELEASE) + 10 + 1_060_000} bytes, more than the 1048576 bytes (1 MB) a folder may hold. `
        + 'Its largest files: data/part-0.txt (300000 bytes), data/part-1.txt (250000 bytes), data/part-2.txt (200000 bytes), data/part-3.txt (150000 bytes), data/part-4.txt (100000 bytes)',
    }]);
  });

  it('hashes a folder by the mode git records and by its text with LF line endings, so checkouts on any system agree', async () => {
    const lf = teamScope();
    lf.put('workflows/release/WORKFLOW.yaml', RELEASE);
    lf.put('workflows/release/plan.sh', 'echo one\necho two\n');
    fs.chmodSync(path.join(lf.config.repo.localPath, 'workflows', 'release', 'plan.sh'), 0o755);
    lf.commit();
    // As on Windows: no executable bit on disk, git keeps the mode, and the text checks out with CRLF.
    const crlf = teamScope();
    git(crlf.config.repo.localPath, 'config', 'core.fileMode', 'false');
    crlf.put('workflows/release/WORKFLOW.yaml', RELEASE.replace(/\n/g, '\r\n'));
    crlf.put('workflows/release/plan.sh', 'echo one\r\necho two\r\n');
    git(crlf.config.repo.localPath, 'add', '-A');
    git(crlf.config.repo.localPath, 'update-index', '--chmod=+x', 'workflows/release/plan.sh');
    crlf.commit();

    await syncScorersThenWorkflows(lf.config);
    await syncScorersThenWorkflows(crlf.config);

    const [left, right] = await Promise.all([loadCachedWorkflow(lf.config, 'release'), loadCachedWorkflow(crlf.config, 'release')]);
    expect(right?.files?.find((file) => file.path === 'plan.sh')).toEqual({ path: 'plan.sh', executable: true, content: 'echo one\necho two\n' });
    expect(right?.sourceHash).toBe(left?.sourceHash);
  });

  it('gives a file and a folder of one name in one place no runnable version, as a duplicate', async () => {
    const team = teamScope();
    team.put('workflows/release.yaml', RELEASE);
    team.put('workflows/release/WORKFLOW.yaml', RELEASE);
    team.commit();

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toMatchObject([{
      file: 'workflows/release.yaml',
      message: 'Workflow "release" is defined twice in one place, as workflows/release.yaml and as workflows/release/; a workflow defined twice has no runnable version',
    }]);
    expect(await loadCachedWorkflow(team.config, 'release')).toBeNull();
    expect(await namespaceConflictOf(team.config, 'release')).toBe(
      'Workflow "release" is defined twice in one place, as workflows/release.yaml and as workflows/release/; a workflow defined twice has no runnable version. '
      + 'Remove one of them, push, run teamai pull, and start again.',
    );
  });

  it('reads prompt_file and answer_file inside a folder from the folder root, subdirectories included, as written', async () => {
    const team = teamScope();
    team.put('workflows/release/WORKFLOW.yaml', `${RELEASE}  - id: summary
    needs: [plan]
    prompt_file: summary.md
  - id: notes
    needs: [summary]
    answer_file: texts/notes.md
    output: { text: string }
`);
    team.put('workflows/release/summary.md', 'Summarise release {{ steps.plan.outputs.version }}.');
    team.put('workflows/release/texts/notes.md', 'Write the notes.\n\n');
    team.commit();

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toEqual([]);
    const steps = (await loadCachedWorkflow(team.config, 'release'))?.definition.steps;
    expect(steps?.[1]?.prompt).toBe('Summarise release {{ steps.plan.outputs.version }}.');
    expect(steps?.[2]?.answer).toBe('Write the notes.\n\n');
  });

  it.each([
    ['../shared/summary.md', 'prompt_file must be a relative path inside the workflow folder, without ..'],
    ['/etc/summary.md', 'prompt_file must be a relative path inside the workflow folder, without ..'],
  ])('refuses prompt_file %s in a folder', async (promptFile, message) => {
    const team = teamScope();
    team.put('workflows/release/WORKFLOW.yaml', `${RELEASE}  - id: summary\n    needs: [plan]\n    prompt_file: ${promptFile}\n`);
    team.commit();

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toMatchObject([{ field: 'steps[1].prompt_file', message }]);
  });

  it('warns at pull of a confined step whose prompt names TEAMAI_WORKFLOW_DIR', async () => {
    const team = teamScope();
    team.put('workflows/review/WORKFLOW.yaml', 'schemaVersion: v1alpha1\nname: review\ndescription: Review.\nsteps:\n'
      + '  - id: evidence\n    command: node -e "0"\n'
      + '  - id: group\n    needs: [evidence]\n    workflow:\n      steps:\n'
      + '        - id: judge\n          workspace: { confined: evidence }\n          prompt_file: judge.md\n'
      + '        - id: plain\n          needs: [judge]\n          workspace: { confined: evidence }\n          prompt: Judge the change.\n');
    team.put('workflows/review/judge.md', 'Judge the change against $TEAMAI_WORKFLOW_DIR/rubric.md.');
    team.put('workflows/review/rubric.md', 'Be strict.');
    team.commit();
    const warn = vi.spyOn(log, 'warn');

    expect((await syncScorersThenWorkflows(team.config)).invalid).toEqual([]);

    expect(warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('confined'))).toEqual([
      '[workflows] workflows/review/WORKFLOW.yaml: step group.judge is confined and may not be able to read $TEAMAI_WORKFLOW_DIR',
    ]);
  });

  it('looks answer_file up under prompts/ in the active namespaces outside a folder', async () => {
    const team = teamScope();
    team.put('workflows/notes.yaml', 'schemaVersion: v1alpha1\nname: notes\ndescription: Notes.\nsteps:\n  - id: notes\n    answer_file: prompts/notes.md\n    output: { text: string }\n');
    team.put('prompts/notes.md', 'Root notes.');
    team.put('prompts/ops/notes.md', 'Ops notes.');
    team.commit();

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toEqual([]);
    expect((await loadCachedWorkflow(team.config, 'notes'))?.definition.steps[0]?.answer).toBe('Ops notes.');
  });
});

_setDriverPollMs(20);

/** A command that prints its `TEAMAI_WORKFLOW_DIR`, or null without one, and the file `name` there, as `{ dir, text }`. */
function printsFolder(name: string): string {
  return `node -e "const d=process.env.TEAMAI_WORKFLOW_DIR;const f=d&&require('path').join(d,'${name}');console.log(JSON.stringify({dir:d??null,text:f&&require('fs').existsSync(f)?require('fs').readFileSync(f,'utf8'):null}))"`;
}

/** A project scope with a team repo, synced, and a git checkout to run in. */
async function runScope(files: Record<string, string>): Promise<{ config: LocalConfig; workspace: string }> {
  const team = teamScope();

  for (const [file, content] of Object.entries(files)) team.put(file, content);
  team.commit();
  const workspace = path.join(path.dirname(team.config.repo.localPath), 'workspace');
  fs.mkdirSync(workspace);
  git(workspace, 'init', '--quiet');
  git(workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'initial');
  const config = { ...team.config, projectRoot: workspace };
  const synced = await syncScorersThenWorkflows(config);
  expect(synced.invalid).toEqual([]);

  return { config, workspace };
}

/** Starts `name` and drives it with the local driver to its end, returning each step's outputs by id. */
async function runToEnd(config: LocalConfig, workspace: string, name: string, runtimes?: DriverRuntimes): Promise<Record<string, unknown>> {
  const started = await startRun(config, name, {}, { secrets: await knownSecrets(config) });

  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  expect(await runLocalDriver(config, runId, workspace, { ...(runtimes && { runtimes }) })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  const run = await readRun(config, runId);

  if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);

  return Object.fromEntries(run.steps.map((step) => [step.id, 'outputs' in step ? step.outputs : undefined]));
}

describe('running a workflow folder', () => {
  it('gives a command step TEAMAI_WORKFLOW_DIR, the run\'s copy of the folder in the data home', async () => {
    const { config, workspace } = await runScope({
      'workflows/release/WORKFLOW.yaml': `schemaVersion: v1alpha1\nname: release\ndescription: Release.\nsteps:\n  - id: plan\n    command: ${printsFolder('plan.txt')}\n    output: { dir: string, text: string }\n`,
      'workflows/release/plan.txt': 'version 1.2.0\n',
    });
    const cached = await loadCachedWorkflow(config, 'release');

    const outputs = await runToEnd(config, workspace, 'release');

    expect(outputs.plan).toEqual({ dir: path.join(getDataHome(config), 'workflows', 'folders', cached?.sourceHash ?? ''), text: 'version 1.2.0\n' });
  });

  // A runtime that runs the step elsewhere, such as a sandbox, makes only what the place names reachable there.
  it('names the folder among the read-only paths of a step runtime\'s place, so the step reads it where it runs', async () => {
    const { config, workspace } = await runScope({
      'workflows/release/WORKFLOW.yaml': `schemaVersion: v1alpha1\nname: release\ndescription: Release.\nsteps:\n  - id: plan\n    command: ${printsFolder('plan.txt')}\n    output: { dir: string, text: string }\n`,
      'workflows/release/plan.txt': 'version 1.2.0\n',
    });
    const host = hostStepRuntime({ config });
    const views: PlaceView[] = [];
    const runtime: typeof host = { ...host, open: (request, events) => {
      if (request.view) views.push(request.view);

      return host.open(request, events);
    } };
    const runtimes: DriverRuntimes = { driver: 'box', asked: 'box', runtimes: [{ kind: 'external', use: 'box', runtime, can: {}, launchesAgents: false, engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }] };

    const outputs = await runToEnd(config, workspace, 'release', runtimes);

    expect(outputs.plan).toMatchObject({ text: 'version 1.2.0\n' });
    expect(views.map((view) => view.readonly)).toEqual([expect.arrayContaining([path.join(getDataHome(config), 'workflows', 'folders', (await loadCachedWorkflow(config, 'release'))?.sourceHash ?? '')])]);
  });

  it('lists no path a step\'s own env names as its workflow folder among a step runtime\'s read-only paths', async () => {
    const { config, workspace } = await runScope({
      'workflows/plain.yaml': `schemaVersion: v1alpha1\nname: plain\ndescription: Plain.\nsteps:\n  - id: alone\n    env: { TEAMAI_WORKFLOW_DIR: ${JSON.stringify(os.homedir())} }\n    command: echo '{}'\n    output: json\n`,
    });
    const host = hostStepRuntime({ config });
    const views: PlaceView[] = [];
    const runtime: typeof host = { ...host, open: (request, events) => {
      if (request.view) views.push(request.view);

      return host.open(request, events);
    } };
    const runtimes: DriverRuntimes = { driver: 'box', asked: 'box', runtimes: [{ kind: 'external', use: 'box', runtime, can: {}, launchesAgents: false, engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }] };

    await runToEnd(config, workspace, 'plain', runtimes);

    expect(views).toHaveLength(1);
    expect(views[0]?.readonly).not.toContain(path.resolve(os.homedir()));
  });

  it('gives each step of a nested workflow the folder of the file that defines it, and none to a single file', async () => {
    const step = (id: string, extra = ''): string => `  - id: ${id}\n${extra}    command: ${printsFolder('which.txt')}\n    output: json\n`;
    const { config, workspace } = await runScope({
      'workflows/release/WORKFLOW.yaml': `schemaVersion: v1alpha1\nname: release\ndescription: Release.\nsteps:\n${step('own')}`
        + '  - id: inline\n    needs: [own]\n    workflow:\n      steps:\n        - id: inner\n          command: ' + printsFolder('which.txt') + '\n          output: json\n'
        + '  - id: folder\n    needs: [inline]\n    workflow: notes\n'
        + '  - id: single\n    needs: [folder]\n    workflow: plain\n',
      'workflows/release/which.txt': 'release',
      'workflows/notes/WORKFLOW.yaml': `schemaVersion: v1alpha1\nname: notes\ndescription: Notes.\nsteps:\n${step('write')}`,
      'workflows/notes/which.txt': 'notes',
      'workflows/plain.yaml': `schemaVersion: v1alpha1\nname: plain\ndescription: Plain.\nsteps:\n${step('alone')}`
        + '  - id: inline\n    needs: [alone]\n    workflow:\n      steps:\n        - id: inner\n          command: ' + printsFolder('which.txt') + '\n          output: json\n',
    });

    const outputs = await runToEnd(config, workspace, 'release');

    expect(outputs).toMatchObject({
      own: { text: 'release' },
      'inline.inner': { text: 'release' },
      'folder.write': { text: 'notes' },
      'single.alone': { dir: null, text: null },
      'single.inline.inner': { dir: null, text: null },
    });
  });

  it('gives a workflow a from step of a folder workflow generated the folder of that workflow', async () => {
    const generated = { schemaVersion: 'v1alpha1', name: 'generated', description: 'Generated.', steps: [{ id: 'g', command: 'node "$TEAMAI_WORKFLOW_DIR/print.js"', output: 'json' }] };
    const { config, workspace } = await runScope({
      'workflows/release/WORKFLOW.yaml': 'schemaVersion: v1alpha1\nname: release\ndescription: Release.\nsteps:\n'
        + '  - id: make\n    command: node "$TEAMAI_WORKFLOW_DIR/make.js"\n    output: { definition: workflow }\n'
        + '  - id: run\n    needs: [make]\n    workflow: { from: make }\n',
      'workflows/release/make.js': `console.log(JSON.stringify({ definition: { definition: ${JSON.stringify(generated)} } }));\n`,
      'workflows/release/print.js': "const d = process.env.TEAMAI_WORKFLOW_DIR;\nconsole.log(JSON.stringify({ text: require('fs').readFileSync(require('path').join(d, 'which.txt'), 'utf8') }));\n",
      'workflows/release/which.txt': 'release',
    });

    const outputs = await runToEnd(config, workspace, 'release');

    expect(outputs['run.g']).toEqual({ text: 'release' });
  });

  it('keeps the files a run started with after the folder changes and after it is deleted', async () => {
    const { config, workspace } = await runScope({
      'workflows/release/WORKFLOW.yaml': `schemaVersion: v1alpha1\nname: release\ndescription: Release.\nsteps:\n  - id: plan\n    command: ${printsFolder('plan.txt')}\n    output: json\n`,
      'workflows/release/plan.txt': 'as started',
    });
    const started = await startRun(config, 'release', {}, { secrets: await knownSecrets(config) });

    if ('error' in started) throw new Error(started.error.message);
    const folder = path.join(config.repo.localPath, 'workflows', 'release');
    fs.writeFileSync(path.join(folder, 'plan.txt'), 'changed');
    await syncScorersThenWorkflows(config);
    fs.rmSync(folder, { recursive: true });
    await syncScorersThenWorkflows(config);

    expect(await runLocalDriver(config, String(started.data.run), workspace, {})).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(await readRun(config, String(started.data.run))).toMatchObject({ steps: [{ id: 'plan', outputs: { text: 'as started' } }] });
  });

  it('removes on doctor --fix a stored folder that no run record and no cached workflow references, once an hour old', async () => {
    const { config, workspace } = await runScope({
      'workflows/release/WORKFLOW.yaml': `schemaVersion: v1alpha1\nname: release\ndescription: Release.\nsteps:\n  - id: plan\n    command: ${printsFolder('plan.txt')}\n    output: json\n`,
      'workflows/release/plan.txt': 'ran',
    });
    await runToEnd(config, workspace, 'release');
    const ran = await loadCachedWorkflow(config, 'release');
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'release', 'plan.txt'), 'cached');
    await syncScorersThenWorkflows(config);
    const cached = await loadCachedWorkflow(config, 'release');
    const pinned = async (text: string, age: number): Promise<string> => {
      const files = [{ path: 'plan.txt', executable: false, content: text }];
      const sourceHash = WorkflowFolder.hash(files);
      await WorkflowFolder.pin(config, { sourceHash, files });
      const dir = WorkflowFolder.dir(config, sourceHash) ?? '';
      fs.utimesSync(dir, new Date(Date.now() - age), new Date(Date.now() - age));
      return dir;
    };
    const cachedFolder = cached && folderOf(cached);
    if (!cachedFolder) throw new Error('release is not cached as a folder');
    await WorkflowFolder.pin(config, cachedFolder);
    const old = await pinned('no longer used', 2 * 60 * 60 * 1000);
    const fresh = await pinned('a run is starting', 0);
    // A run pins the folders it reads before its record names them.
    const retaken = await pinned('a member takes a step of it', 2 * 60 * 60 * 1000);
    const retakenFiles = [{ path: 'plan.txt', executable: false, content: 'a member takes a step of it' }];
    await WorkflowFolder.pin(config, { sourceHash: WorkflowFolder.hash(retakenFiles), files: retakenFiles });

    await sweepLeftovers(config, null, { now: Date.now(), checkout: workspace });

    expect(fs.readdirSync(path.join(getDataHome(config), 'workflows', 'folders')).sort()).toEqual(
      [ran?.sourceHash, cached?.sourceHash, path.basename(fresh), path.basename(retaken)].sort(),
    );
    expect(fs.existsSync(old)).toBe(false);
  });

  it('removes on doctor --fix the stored folder of a run swept past workflows.retention, which no retry can reopen', async () => {
    const { config, workspace } = await runScope({
      'workflows/release/WORKFLOW.yaml': `schemaVersion: v1alpha1\nname: release\ndescription: Release.\nsteps:\n  - id: plan\n    command: ${printsFolder('plan.txt')}\n    output: json\n`,
      'workflows/release/plan.txt': 'ran',
    });
    await runToEnd(config, workspace, 'release');
    const ran = await loadCachedWorkflow(config, 'release');
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'release', 'plan.txt'), 'cached');
    await syncScorersThenWorkflows(config);
    const cached = await loadCachedWorkflow(config, 'release');
    const cachedFolder = cached && folderOf(cached);
    if (!cachedFolder) throw new Error('release is not cached as a folder');
    await WorkflowFolder.pin(config, cachedFolder);

    await sweepLeftovers(config, null, { now: Date.now() + 15 * 24 * 60 * 60 * 1000, checkout: workspace });

    const folders = path.join(getDataHome(config), 'workflows', 'folders');
    expect([fs.existsSync(path.join(folders, ran?.sourceHash ?? 'missing')), fs.readdirSync(folders)]).toEqual([false, [cached?.sourceHash]]);
  });
});


describe('a workflow folder under the skill driver', () => {
  it('gives a command step the runner starts TEAMAI_WORKFLOW_DIR, as the local driver does', async () => {
    const made = await skillHarness({}, { teamFiles: {
      'workflows/release/WORKFLOW.yaml': `schemaVersion: v1alpha1\nname: release\ndescription: Release.\ninvoke: allow\nsteps:\n  - id: plan\n    command: ${printsFolder('plan.txt')}\n    output: json\n`,
      'workflows/release/plan.txt': 'from the folder',
    } });
    dirs.push(made.root);
    await syncScorersThenWorkflows(made.config);
    const sourceHash = (await loadCachedWorkflow(made.config, 'release'))?.sourceHash ?? '';

    const start = await made.call({ kind: 'start', name: 'release', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in start) || !('turn' in start.data)) throw new Error(JSON.stringify(start));
    const { run } = start.data.turn;
    for (let poll = 0; poll < 10; poll += 1) {
      const next = await made.call({ kind: 'next', run, wait: true });
      if ('data' in next && 'turn' in next.data && next.data.turn.status === 'done') break;
    }

    expect(await readRun(made.config, run)).toMatchObject({
      status: 'succeeded',
      steps: [{ id: 'plan', outputs: { dir: path.join(getDataHome(made.config), 'workflows', 'folders', sourceHash), text: 'from the folder' } }],
    });
  });
});

describe('a workflow folder\'s prompt step under the skill driver', () => {
  it('names the folder in the brief the agent works from, since the agent\'s shell is the session\'s', async () => {
    const made = await skillHarness({}, { teamFiles: {
      'workflows/release/WORKFLOW.yaml': 'schemaVersion: v1alpha1\nname: release\ndescription: Release.\ninvoke: allow\nsteps:\n  - id: plan\n    prompt: Read $TEAMAI_WORKFLOW_DIR/plan.txt and follow it.\n',
      'workflows/release/plan.txt': 'from the folder',
    } });
    dirs.push(made.root);
    await syncScorersThenWorkflows(made.config);
    const sourceHash = (await loadCachedWorkflow(made.config, 'release'))?.sourceHash ?? '';

    const start = await made.call({ kind: 'start', name: 'release', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in start) || !('turn' in start.data)) throw new Error(JSON.stringify(start));
    const chosen = await made.call({ kind: 'choose', run: RunIdSchema.parse(start.data.turn.run), choice: 'h1' });
    if (!('data' in chosen) || !('turn' in chosen.data)) throw new Error(JSON.stringify(chosen));
    const [dispatch] = chosen.data.turn.actions.flatMap((action) => (action.kind === 'dispatch' ? [action] : []));
    if (!dispatch) throw new Error(JSON.stringify(chosen));

    expect(fs.readFileSync(dispatch.brief, 'utf8')).toContain(`the workflow's folder \`${path.join(getDataHome(made.config), 'workflows', 'folders', sourceHash).split(path.sep).join('/')}\``);
  });
});

describe('claiming a run of a workflow folder', () => {
  it('gives the member who claims it the files the run started with, from the team commit it ran at', async () => {
    const acme = handoffTeam({}, {
      'workflows/release/WORKFLOW.yaml': `schemaVersion: v1alpha1\nname: release\ndescription: Release.\nsteps:\n  - id: plan\n    command: ${printsFolder('plan.txt')}\n    output: json\n`,
      'workflows/release/plan.txt': 'as started',
    });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    acme.change({ 'workflows/release/plan.txt': 'changed' });
    await pull(bob);
    const started = await startRun(alice.config, 'release', {}, { secrets: await knownSecrets(alice.config) });

    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const sourceHash = (await loadCachedWorkflow(alice.config, 'release'))?.sourceHash ?? '';
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true });

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(await runLocalDriver(bob.config, runId, bob.checkout, {})).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(await readRun(bob.config, runId)).toMatchObject({
      steps: [{ id: 'plan', outputs: { dir: path.join(getDataHome(bob.config), 'workflows', 'folders', sourceHash), text: 'as started' } }],
    });
  });
});

describe('default workflow folders', () => {
  it('reads a default folder of teamai\'s package once, with every file, hashed as a team folder is', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-wf-defaults-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'workflows', 'teamai-folder-demo', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'workflows', 'teamai-folder-demo', 'WORKFLOW.yaml'), 'schemaVersion: v1alpha1\nname: teamai-folder-demo\ndescription: Demo.\nsteps:\n  - id: run\n    command: sh "$TEAMAI_WORKFLOW_DIR/lib/run.sh"\n');
    fs.writeFileSync(path.join(root, 'workflows', 'teamai-folder-demo', 'lib', 'run.sh'), 'echo ok\r\n', { mode: 0o644 });
    const teamai = { root, read: DefaultWorkflows.layer.read };

    const first = await Resources.resolve(RESOURCE_LAYOUTS.workflows, 'teamai-folder-demo', { teamai });
    const again = await Resources.resolve(RESOURCE_LAYOUTS.workflows, 'teamai-folder-demo', { teamai });

    const shipped = first.kind === 'resolved' && first.item.layer === 'teamai' ? first.item.shipped : undefined;
    expect(shipped?.relativePath).toBe('workflows/teamai-folder-demo/WORKFLOW.yaml');
    expect(shipped?.files).toEqual([
      { path: 'WORKFLOW.yaml', executable: false, content: expect.stringContaining('name: teamai-folder-demo') },
      { path: 'lib/run.sh', executable: false, content: 'echo ok\n' },
    ]);
    expect(shipped?.sourceHash).toBe(WorkflowFolder.hash(shipped?.files ?? []));
    expect(again.kind === 'resolved' && again.item.layer === 'teamai' ? again.item.shipped : undefined).toBe(shipped);
  });

  it('refuses a default folder that ships an executable file, as a teamai bug', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-wf-defaults-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'workflows', 'teamai-folder-exec', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'workflows', 'teamai-folder-exec', 'WORKFLOW.yaml'), 'schemaVersion: v1alpha1\nname: teamai-folder-exec\ndescription: Demo.\nsteps:\n  - id: run\n    command: sh "$TEAMAI_WORKFLOW_DIR/lib/run.sh"\n');
    fs.writeFileSync(path.join(root, 'workflows', 'teamai-folder-exec', 'lib', 'run.sh'), 'echo ok\n', { mode: 0o755 });

    await expect(Resources.resolve(RESOURCE_LAYOUTS.workflows, 'teamai-folder-exec', { teamai: { root, read: DefaultWorkflows.layer.read } })).rejects.toThrow(
      'teamai\'s default workflows/teamai-folder-exec/WORKFLOW.yaml ships lib/run.sh as an executable file. An npm install on Windows drops the bit, '
        + 'so the folder would hash differently there and a run of it could not be claimed across systems. Clear the bit, and run the file through its interpreter, such as sh.',
    );
  });

  it('gives the steps of a default folder the text of the files their prompt_file and answer_file name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-wf-defaults-'));
    dirs.push(root);
    const folder = path.join(root, 'workflows', 'teamai-folder-texts');
    fs.mkdirSync(path.join(folder, 'texts'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'WORKFLOW.yaml'), `schemaVersion: v1alpha1
name: teamai-folder-texts
description: Demo.
steps:
  - id: review
    prompt_file: review.md
  - id: each
    needs: [review]
    workflow:
      steps:
        - id: ask
          answer_file: texts/ask.md
          output: { text: string }
`);
    fs.writeFileSync(path.join(folder, 'review.md'), 'Review this project.\n');
    fs.writeFileSync(path.join(folder, 'texts', 'ask.md'), 'Name one color.');

    const found = await Resources.resolve(RESOURCE_LAYOUTS.workflows, 'teamai-folder-texts', { teamai: { root, read: DefaultWorkflows.layer.read } });

    const shipped = found.kind === 'resolved' && found.item.layer === 'teamai' ? found.item.shipped : undefined;
    expect(shipped?.definition.steps).toMatchObject([
      { id: 'review', prompt: 'Review this project.\n' },
      { id: 'each', workflow: { steps: [{ id: 'ask', answer: 'Name one color.' }] } },
    ]);
  });

  const SCORE = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'workflows', 'teamai-score.yaml'), 'utf8');

  it('replaces a default with a team folder of its name', async () => {
    const team = teamScope();
    team.put('workflows/teamai-score/WORKFLOW.yaml', SCORE.replace('Judge one piece of work against a scorer\'s rubric.', 'Judge this change for our team, strictly.'));
    team.put('workflows/teamai-score/notes.md', 'How we judge.\n');
    team.commit();

    expect((await syncScorersThenWorkflows(team.config)).invalid).toEqual([]);

    expect(await loadCachedWorkflow(team.config, 'teamai-score')).toMatchObject({ source: 'team', relativePath: 'workflows/teamai-score/WORKFLOW.yaml' });
  });

  it('takes every file a team folder of a default folder\'s name leaves out from teamai\'s, and records the teamai version that gave them', async () => {
    const team = teamScope();
    team.put('workflows/teamai-import-from-repo/narrative.md', 'Write our narrative, in our words.\n');
    team.commit();

    expect((await syncScorersThenWorkflows(team.config)).invalid).toEqual([]);

    const cached = await loadCachedWorkflow(team.config, 'teamai-import-from-repo');
    const shipped = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'workflows', 'teamai-import-from-repo', 'WORKFLOW.yaml'), 'utf8');
    expect({
      source: cached?.source,
      files: cached?.files?.map((file) => [file.path, file.path === 'narrative.md' ? file.content : file.path === 'WORKFLOW.yaml' && file.content === shipped]),
      origin: cached ? DefaultWorkflows.originOf(cached) : undefined,
    }).toEqual({
      source: 'team',
      files: [['README.md', false], ['README.zh-CN.md', false], ['WORKFLOW.yaml', true], ['narrative.md', 'Write our narrative, in our words.\n']],
      origin: { source: 'team', teamaiVersion: getCurrentVersion() },
    });
  });

  it('refuses a team folder over a default whose resulting folder holds more than 1 MB, though its own files hold less', async () => {
    const team = teamScope();
    team.put('workflows/teamai-import-from-repo/narrative.md', 'x'.repeat(1024 * 1024 - 100));
    team.commit();

    const result = await syncScorersThenWorkflows(team.config);

    expect({
      invalid: result.invalid.map(({ file, code, message }) => ({ file, code, message: message.split(' bytes, ')[1]?.split('.')[0] })),
      source: (await loadCachedWorkflow(team.config, 'teamai-import-from-repo'))?.source,
    }).toEqual({
      invalid: [{ file: 'workflows/teamai-import-from-repo/WORKFLOW.yaml', code: 'workflow_folder_invalid', message: 'more than the 1048576 bytes (1 MB) a folder may hold' }],
      source: 'default',
    });
  });

  it('leaves out a file of a team folder over a default that replaces no file of it, warning about it', async () => {
    const team = teamScope();
    team.put('workflows/teamai-import-from-repo/narative.md', 'A typo.\n');
    team.commit();
    const warn = vi.spyOn(log, 'warn');

    const result = await syncScorersThenWorkflows(team.config);

    expect({ strays: result.strays, files: (await loadCachedWorkflow(team.config, 'teamai-import-from-repo'))?.files?.map((file) => file.path) }).toEqual({
      strays: [{ path: 'workflows/teamai-import-from-repo/narative.md', message: expect.stringContaining('replaces no file of teamai\'s default') }],
      files: ['README.md', 'README.zh-CN.md', 'WORKFLOW.yaml', 'narrative.md'],
    });
    expect(warn).toHaveBeenCalledWith('[workflows] workflows/teamai-import-from-repo/narative.md replaces no file of teamai\'s default, so it is not used and teamai\'s files stay in force. '
      + 'Name it after the file it replaces, or replace the folder\'s marker too, so it can name the file.');
  });

  it('skips a teamai- folder that matches no default with a warning, at the root and in a namespace, and keeps a teamai- file as today', async () => {
    const team = teamScope();
    team.put('workflows/teamai-release/WORKFLOW.yaml', RELEASE.replace('name: release', 'name: teamai-release'));
    team.put('workflows/payments/teamai-deploy/WORKFLOW.yaml', RELEASE.replace('name: release', 'name: teamai-deploy'));
    team.put('workflows/teamai-notes.yaml', RELEASE.replace('name: release', 'name: teamai-notes'));
    team.commit();
    const warn = vi.spyOn(log, 'warn');

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toEqual([]);
    expect(result.cached).toEqual(['teamai-notes']);
    expect(await loadCachedWorkflow(team.config, 'teamai-release')).toBeNull();
    expect(await loadCachedWorkflow(team.config, 'teamai-deploy')).toBeNull();
    expect(warn).toHaveBeenCalledWith('[workflows] workflows/teamai-release/ is skipped: a teamai- name only replaces a teamai default, and teamai has no workflow named teamai-release. Rename the folder.');
    expect(warn).toHaveBeenCalledWith('[workflows] workflows/payments/teamai-deploy/ is skipped: a teamai- name only replaces a teamai default, and teamai has no workflow named teamai-deploy. Rename the folder.');
  });

  it('refuses a team folder that replaces a default and breaks its contract, as it refuses a file', async () => {
    const team = teamScope();
    team.put('workflows/teamai-score/WORKFLOW.yaml', SCORE.replace('          if: inputs.store\n          workspace: { team: { branch: teamai-reports } }\n', '          workspace: { team: { branch: teamai-reports } }\n'));
    team.commit();

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid.map(({ file, field }) => ({ file, field }))).toEqual([{ file: 'workflows/teamai-score/WORKFLOW.yaml', field: 'steps.score.publish.if' }]);
    expect(await loadCachedWorkflow(team.config, 'teamai-score')).toMatchObject({ source: 'default' });
  });
});

describe('workflow folders in status and push', () => {
  const TEAM: TeamaiConfig = { team: 'acme', description: '', repo: 'https://github.com/acme/app.git', provider: 'github', reviewers: [], sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } }, toolPaths: {} };

  it('counts a folder as one workflow, named after it, beside single files', async () => {
    const team = teamScope();
    team.put('workflows/release/WORKFLOW.yaml', RELEASE);
    team.put('workflows/release/checks.yaml', 'checks: []\n');
    team.put('workflows/release/plan.py', 'print(1)\n');
    team.put('workflows/payments/deploy/WORKFLOW.yaml', RELEASE.replace('name: release', 'name: deploy'));
    team.put('workflows/payments/refund.yaml', RELEASE.replace('name: release', 'name: refund'));
    team.put('workflows/plain.yaml', RELEASE.replace('name: release', 'name: plain'));
    team.commit();

    const items = await getHandler('workflows').scanTeamForPull(TEAM, team.config);

    expect(items.map(({ name, relativePath }) => ({ name, relativePath })).sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual([
      { name: 'payments/deploy', relativePath: 'workflows/payments/deploy/' },
      { name: 'payments/refund.yaml', relativePath: 'workflows/payments/refund.yaml' },
      { name: 'plain.yaml', relativePath: 'workflows/plain.yaml' },
      { name: 'release', relativePath: 'workflows/release/' },
    ]);
  });

  it('pushes every file of a folder under .teamai/workflows/ in self mode, and only YAML outside one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-wf-push-'));
    dirs.push(root);
    const business = path.join(root, 'biz');
    const baseline = path.join(business, '.teamai', 'knowledge-wt', '.teamai');
    const put = (file: string, content: string): void => {
      fs.mkdirSync(path.dirname(path.join(business, '.teamai', file)), { recursive: true });
      fs.writeFileSync(path.join(business, '.teamai', file), content);
    };
    fs.mkdirSync(path.join(baseline, 'workflows'), { recursive: true });
    put('workflows/release/WORKFLOW.yaml', RELEASE);
    put('workflows/release/plan.py', 'print(1)\n');
    put('workflows/release/lib/notes.md', 'notes\n');
    put('workflows/plain.yaml', RELEASE.replace('name: release', 'name: plain'));
    put('workflows/stray.txt', 'not a workflow\n');
    const config: LocalConfig = {
      repo: { localPath: baseline, remote: 'https://github.com/acme/app.git', kind: 'self', businessRepoRoot: path.join(business, '.teamai', 'knowledge-wt') },
      username: 'alice', scope: 'project', projectRoot: business, additionalRoles: [], dataHome: path.join(root, 'data'),
    };

    const items = await getHandler('workflows').scanLocalForPush(TEAM, config);

    expect(items.map(({ relativePath, status }) => ({ relativePath, status })).sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))).toEqual([
      { relativePath: 'workflows/plain.yaml', status: 'new' },
      { relativePath: 'workflows/release/WORKFLOW.yaml', status: 'new' },
      { relativePath: 'workflows/release/lib/notes.md', status: 'new' },
      { relativePath: 'workflows/release/plan.py', status: 'new' },
    ]);
  });
});
