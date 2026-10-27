import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';
import { AGENT_SESSION_ENV } from '../../utils/session-id.js';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

/** A product checkout with the workflows `workflows` gives for its root pulled, the built CLI to call in it, and a reader of its run files. */
function fixture(prefix: string, workflows: (root: string) => Record<string, string>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(root, 'home'); const repo = path.join(root, 'product');
  for (const dir of [home, repo]) fs.mkdirSync(dir);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TEAMAI_WORKFLOW_ATTEMPT', ...AGENT_SESSION_ENV]) delete env[name];
  const run = (command: string, args: string[], options: { cwd?: string; extra?: Record<string, string> } = {}) => spawnSync(command, args, {
    cwd: options.cwd ?? repo, env: { ...env, ...options.extra }, encoding: 'utf8', timeout: 120_000,
  });
  const git = (...args: string[]) => { const result = run('git', args); expect(result.status, result.stderr).toBe(0); return result.stdout.trim(); };
  /** The JSON envelope `teamai workflow <args>` printed. */
  const workflow = (args: string[], options: { cwd?: string; extra?: Record<string, string> } = {}) => {
    const { stdout, stderr } = run(process.execPath, [cli, 'workflow', ...args], options);
    const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
    if (line === undefined) throw new Error(`workflow ${args.join(' ')} printed no JSON envelope:\n${stdout}\n${stderr}`);
    return JSON.parse(line) as { data?: Record<string, unknown>; error?: { code: string; message: string; next?: unknown } };
  };
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  git('remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git');
  const initialized = run(process.execPath, [cli, 'init', '--self', '--agent', 'claude', '--force']); expect(initialized.status, initialized.stderr).toBe(0);
  const dir = path.join(repo, '.teamai', 'workflows'); fs.mkdirSync(dir, { recursive: true });
  for (const [name, yaml] of Object.entries(workflows(root))) fs.writeFileSync(path.join(dir, `${name}.yaml`), yaml);
  const pulled = run(process.execPath, [cli, 'pull']); expect(pulled.status, pulled.stderr).toBe(0);
  const runsDir = () => {
    const projects = path.join(home, '.teamai', 'projects');
    const [project] = fs.readdirSync(projects);
    return path.join(projects, project ?? '', 'workflows', 'runs');
  };
  return {
    root, repo, git, workflow,
    runFile: (id: string) => JSON.parse(fs.readFileSync(path.join(runsDir(), `${id}.json`), 'utf8')) as { status: string; steps: Array<{ id: string; status: string; outputs?: unknown }> },
    runIds: () => (fs.existsSync(runsDir()) ? fs.readdirSync(runsDir()).filter((name) => /^r[0-9a-f]+\.json$/.test(name)) : []),
    cleanup: async () => { await waitForDetachedChildren(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const COMMAND = 'schemaVersion: v1alpha1\nname: build\ndescription: One command.\nsteps:\n  - id: work\n    command: echo work\n';

describe('nested workflow starts through the CLI', () => {
  it('nested-start: the attempt marker refuses every run-changing call but its runner\'s own report, and a workflow place refuses only a start', async () => {
    const made = fixture('teamai-nested-start-', () => ({ build: COMMAND }));
    try {
      const started = made.workflow(['start', 'build']);
      const run = String(started.data?.run);
      expect(run).toMatch(/^r[0-9a-f]{16}$/);
      const driver = { kind: 'external', machine: 'fixture', workspace: made.repo };
      const marker = { TEAMAI_WORKFLOW_ATTEMPT: `${run}/a0000000a` };
      const nested = { error: { code: 'nested_workflow' } };

      for (const args of [
        ['start', 'build'], ['start', 'build', '--driver', 'local'], ['start', '--describe', 'build', '--driver', 'skill'],
        ['next', run, '--json', JSON.stringify({ driver })], ['next', run, '--driver', 'skill'],
        ['report', run, '--json', JSON.stringify({ driver, attempt: 'a0000000a', revision: 1, outcome: 'success' })],
        ['respond', run, 'work', 'yes'], ['retry', run, 'work'], ['cancel', run], ['resume', run], ['publish', run],
      ]) expect(made.workflow(args, { extra: marker }), args.join(' ')).toMatchObject(nested);
      expect(made.workflow(['next', run, '--driver', 'skill'], { extra: marker })).toMatchObject({ error: { code: 'nested_workflow', next: null } });

      // The runner of the attempt the marker names passes, and the skill driver answers it: this run has no such attempt.
      expect(made.workflow(['report', run, '--driver', 'skill', '--attempt', 'a0000000a'], { extra: marker })).toEqual({ data: { runner: { attempt: 'a0000000a', status: 'gone' } } });
      expect(made.workflow(['report', run, '--driver', 'skill', '--attempt', 'a0000000b'], { extra: marker })).toMatchObject(nested);

      const worktree = path.join(made.repo, '.teamai', 'workflow-worktrees', 'teamai-x');
      fs.mkdirSync(worktree, { recursive: true });
      expect(made.workflow(['start', 'build'], { cwd: worktree })).toMatchObject(nested);
      // A driver drives its own run from a step's place: next and report there are not nested calls.
      expect(made.workflow(['next', run, '--json', JSON.stringify({ driver })], { cwd: worktree })).toMatchObject({ data: { lease: { step: 'work' } } });

      const place = path.join(made.root, 'host-place');
      made.git('worktree', 'add', '-q', '-b', `teamai/${run}/work/p1`, place);
      expect(made.workflow(['start', 'build'], { cwd: place })).toMatchObject(nested);
      expect(made.workflow(['start', 'build'])).toMatchObject({ data: { run: expect.stringMatching(/^r/) } });
    } finally { await made.cleanup(); }
  });

  it('a step command that starts a workflow gets nested_workflow under either driver, and one that reports as its runner gets held while the runner reports the step', async () => {
    const script = (root: string, name: string) => JSON.stringify(path.join(root, name));
    const made = fixture('teamai-nested-step-', (root) => ({
      other: COMMAND.replace('name: build', 'name: other'),
      outer: `schemaVersion: v1alpha1\nname: outer\ndescription: Starts another workflow from a step.\nsteps:\n  - id: spawn\n    command: node ${script(root, 'start-other.cjs')}\n`,
      poser: `schemaVersion: v1alpha1\nname: poser\ndescription: Reports its own attempt from its command.\ninvoke: allow\nsteps:\n  - id: pose\n    command: node ${script(root, 'pose-as-runner.cjs')}\n  - id: spawn\n    needs: [pose]\n    command: node ${script(root, 'start-other.cjs')}\n`,
    }));
    try {
      // Each prints the last envelope the CLI printed, which a step reports as its outputs.
      const last = "process.stdout.write(result.stdout.trim().split('\\n').filter((line) => line.startsWith('{')).at(-1) ?? 'null');";
      fs.writeFileSync(path.join(made.root, 'start-other.cjs'), `const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, [${JSON.stringify(cli)}, 'workflow', 'start', 'other'], { encoding: 'utf8' });
${last}\n`);
      fs.writeFileSync(path.join(made.root, 'pose-as-runner.cjs'), `const { spawnSync } = require('node:child_process');
const [run, attempt] = (process.env.TEAMAI_WORKFLOW_ATTEMPT ?? '').split('/');
const result = spawnSync(process.execPath, [${JSON.stringify(cli)}, 'workflow', 'report', run, '--driver', 'skill', '--attempt', attempt], { encoding: 'utf8' });
${last}\n`);

      const local = made.workflow(['start', 'outer', '--driver', 'local']);
      expect(local).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const localRun = made.runIds().map((file) => made.runFile(file.replace(/\.json$/, ''))).find((state) => state.steps.some((step) => step.id === 'spawn'));
      expect(localRun?.steps.find((step) => step.id === 'spawn')?.outputs).toMatchObject({ error: { code: 'nested_workflow' } });

      const agent = { CLAUDE_CODE_SESSION_ID: 'session-nested' };
      const started = made.workflow(['start', 'poser', '--driver', 'skill'], { extra: agent });
      const run = String((started.data?.turn as { run?: string } | undefined)?.run);
      let status = '';
      for (let poll = 0; poll < 10 && status !== 'done'; poll += 1) {
        const turn = made.workflow(['next', run, '--driver', 'skill', '--wait'], { extra: agent });
        status = String((turn.data?.turn as { status?: string } | undefined)?.status);
      }
      expect(status).toBe('done');
      const skillRun = made.runFile(run);
      expect(skillRun.status).toBe('succeeded');
      expect(skillRun.steps.find((step) => step.id === 'pose')?.outputs).toMatchObject({ data: { runner: { status: 'held' } } });
      expect(skillRun.steps.find((step) => step.id === 'spawn')?.outputs).toMatchObject({ error: { code: 'nested_workflow' } });
      expect(made.runIds()).toHaveLength(2);
    } finally { await made.cleanup(); }
  });
});
