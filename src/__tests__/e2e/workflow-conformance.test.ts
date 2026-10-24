import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';
import { runConformanceScenario, type WorkflowClient } from '../../workflow/conformance-interpreter.js';
import { workflowConformanceScenarios, workflowGitConformanceScenarios, type GitConformanceName } from '../../workflow/conformance.js';
import type { StepState } from '../../workflow/step-state.js';
import type { RunState, WorkflowEnvelope } from '../../workflow/types.js';
import type { WorkspaceContract } from '../../workflow/workspace.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

function runCLI(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function envelope(stdout: string): WorkflowEnvelope {
  const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return JSON.parse(line) as WorkflowEnvelope;
}

describe('workflow protocol conformance through the CLI', () => {
  let repo: string;

  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-cli-conformance-'));
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], { cwd: repo });
    const initialized = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  for (const scenario of workflowConformanceScenarios) {
    it(scenario.name, async () => {
      const workflows = path.join(repo, '.teamai', 'workflows');
      fs.mkdirSync(workflows, { recursive: true });
      fs.writeFileSync(path.join(workflows, `${scenario.workflowName}.yaml`), scenario.yaml);
      for (const [name, yaml] of Object.entries(scenario.workflows ?? {})) {
        fs.writeFileSync(path.join(workflows, `${name}.yaml`), yaml);
      }
      const pulled = await runCLI(['pull'], repo);
      expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
      const env = { ...process.env, ...scenario.env };
      const call = async (args: string[]): Promise<WorkflowEnvelope> => {
        const { stdout } = await runCLI(['workflow', ...args], repo, env);
        for (const [name, value] of Object.entries(scenario.env ?? {})) expect(stdout.includes(value), `workflow ${args[0]} printed the value of ${name}`).toBe(false);
        return envelope(stdout);
      };
      const client: WorkflowClient = {
        start: (name) => call(['start', name]),
        next: (run, body) => call(['next', run, '--json', JSON.stringify(body)]),
        report: (run, body) => call(['report', run, '--json', JSON.stringify(body)]),
        respond: (run, step, choice, options) => call(['respond', run, step, choice, ...(options?.note !== undefined ? ['--note', options.note] : []), ...(options?.pass !== undefined ? ['--pass', String(options.pass)] : []), ...(options?.json !== undefined ? ['--json', JSON.stringify(options.json)] : [])]),
        retry: (run, step) => call(['retry', run, step]),
        cancel: (run, step) => call(['cancel', run, ...(step !== undefined ? [step] : [])]),
      };
      await runConformanceScenario(scenario, {
        client,
        readRun: async (runId) => {
          const dataHome = await resolveProjectDataHome(repo);
          return JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${runId}.json`), 'utf8')) as RunState;
        },
        readEndRecord: async (runId) => {
          const dataHome = await resolveProjectDataHome(repo);
          const file = path.join(dataHome, 'workflows', 'pending', `${runId}.end.json`);
          return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as unknown : undefined;
        },
        // Each CLI call reads the system clock, so the runner waits for real.
        advance: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
        expect,
      });
    });
  }
});

const TEAM_URL = 'https://github.com/acme/team.git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
}

function changesOf(run: RunState, id: string): { branch: string; to: string } {
  const step: StepState | undefined = run.steps.find((item) => item.id === id);
  if (!step || !('changes' in step) || !step.changes) throw new Error(`step ${id} reported no changes`);
  return step.changes;
}

function valueOf(run: RunState, name: GitConformanceName): string {
  if (name === 'base.commit' || name === 'base.ref') {
    const value = name === 'base.commit' ? run.base?.commit : run.base?.ref;
    if (!value) throw new Error(`the run has no ${name}`);
    return value;
  }
  const [, id = '', field] = /^steps\.(.+)\.(commit|branch)$/.exec(name) ?? [];
  const changes = changesOf(run, id);
  return field === 'commit' ? changes.to : changes.branch;
}

function asWord(value: string): RegExp {
  return new RegExp(`(^|[^\\w/.-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w/-])`);
}

describe('workflow git conformance of the local driver through the CLI', () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const scenario of workflowGitConformanceScenarios) {
    it(scenario.name, async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-cli-conformance-')));
      dirs.push(root);
      const origin = path.join(root, 'origin.git');
      const elsewhere = path.join(root, 'elsewhere');
      const checkout = path.join(root, 'checkout');
      git(root, 'init', '-q', '--bare', '-b', 'main', origin);
      git(root, 'init', '-q', '-b', 'main', elsewhere);
      git(elsewhere, 'remote', 'add', 'origin', origin);
      fs.writeFileSync(path.join(elsewhere, 'README.md'), '# fixture\n');
      git(elsewhere, 'add', 'README.md');
      git(elsewhere, 'commit', '-qm', 'initial');
      git(elsewhere, 'push', '-q', 'origin', 'main');
      git(root, 'clone', '-q', origin, checkout);
      if (scenario.base === 'elsewhere') {
        fs.writeFileSync(path.join(elsewhere, 'elsewhere.txt'), 'only on the other machine\n');
        git(elsewhere, 'add', 'elsewhere.txt');
        git(elsewhere, 'commit', '-qm', 'unpushed base');
      }
      const team = path.join(root, 'team.git');
      const knowledge = path.join(root, 'knowledge');
      fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), `team: acme\nrepo: ${TEAM_URL}\nprovider: github\n`);
      fs.writeFileSync(path.join(knowledge, 'workflows', `${scenario.workflowName}.yaml`), scenario.yaml);
      git(root, 'init', '-q', '-b', 'main', knowledge);
      git(knowledge, 'add', '-A');
      git(knowledge, 'commit', '-qm', 'team');
      git(root, 'clone', '-q', '--bare', knowledge, team);

      // An install is a HOME with teamai initialized against the team origin, which git maps from the forge URL init needs.
      const install = async (name: string): Promise<NodeJS.ProcessEnv> => {
        const home = path.join(root, name);
        fs.mkdirSync(home);
        fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = ${name}\n\temail = ${name}@example.com\n[url "file://${team}"]\n\tinsteadOf = ${TEAM_URL}\n`);
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
        for (const command of [['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'], ['pull']]) {
          const result = await runCLI(command, root, env);
          expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
        }
        return env;
      };
      const tester = await install('tester');
      // Without a handoff the other machine's driver reports into the same install.
      const starter = scenario.handoff ? await install('other') : tester;
      const call = async (args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<WorkflowEnvelope> => envelope((await runCLI(['workflow', ...args], cwd, env)).stdout);

      const started = await call(['start', scenario.workflowName], elsewhere, starter);
      if ('error' in started) throw new Error(started.error.message);
      const runId = String(started.data.run);

      const other = { kind: 'local', machine: 'elsewhere', workspace: elsewhere, can: { workspace: ['new', 'continue', 'read-only'] } };
      for (const step of scenario.elsewhere ?? []) {
        const next = await call(['next', runId, '--json', JSON.stringify({ driver: other })], elsewhere, starter);
        if (!('data' in next) || !next.data.lease) throw new Error(`no lease for ${step.step}: ${JSON.stringify(next)}`);
        const lease = next.data.lease as { step: string; attempt: string; revision: number; workspace: WorkspaceContract };
        expect(lease).toMatchObject({ step: step.step, workspace: { merge: [] } });
        const { branch, start, base } = lease.workspace;
        git(elsewhere, 'checkout', '-q', '-B', branch, start.commit);
        for (const [file, text] of Object.entries(step.files)) fs.writeFileSync(path.join(elsewhere, file), text);
        git(elsewhere, 'add', '-A');
        git(elsewhere, 'commit', '-qm', step.step);
        const to = git(elsewhere, 'rev-parse', 'HEAD');
        if (step.push) git(elsewhere, 'push', '-q', 'origin', branch);
        const reported = await call(['report', runId, '--json', JSON.stringify({
          attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: other,
          changes: { branch, base: base.commit, from: start.commit, to, commits: [to] },
        })], elsewhere, starter);
        expect(reported).toMatchObject({ data: { accepted: true } });
      }
      if (scenario.handoff) {
        expect(await call(['publish', runId], elsewhere, starter)).toMatchObject({ data: { publication: 'published' } });
      }
      if (scenario.refusePushes) {
        const hook = path.join(origin, 'hooks', 'pre-receive');
        fs.writeFileSync(hook, '#!/bin/sh\necho "origin refuses pushes" >&2\nexit 1\n');
        fs.chmodSync(hook, 0o755);
      }

      // A handoff run is not on this install yet: resume claims it before it drives.
      const resumed = await call(['resume', runId], checkout, tester);
      expect(resumed, JSON.stringify(resumed)).toMatchObject({ data: { done: { run: runId } } });

      const run = JSON.parse(fs.readFileSync(path.join(root, 'tester', '.teamai', 'workflows', 'runs', `${runId}.json`), 'utf8')) as RunState;
      const steps = run.steps.map((step) => `${step.id} ${step.status}${'message' in step && step.message ? `: ${step.message}` : ''}`);
      expect(run, steps.join('\n')).toMatchObject(scenario.expectState);
      for (const [id, files] of Object.entries(scenario.expectPushed ?? {})) {
        const changes = changesOf(run, id);
        expect(git(origin, 'for-each-ref', '--format=%(objectname)', `refs/heads/${changes.branch}`), `${id} is pushed`).toBe(changes.to);
        for (const [file, text] of Object.entries(files)) expect(git(origin, 'show', `${changes.to}:${file}`)).toBe(text);
      }
      if (scenario.expectFailure) {
        const { step: id, names, codeIsNot } = scenario.expectFailure;
        const step = run.steps.find((item) => item.id === id);
        const message = step && 'message' in step ? step.message ?? '' : '';
        for (const name of names) expect(message, name).toMatch(asWord(valueOf(run, name)));
        if (codeIsNot) expect(step && 'failure' in step ? step.failure?.code : undefined).not.toBe(codeIsNot);
      }
    });
  }
});
