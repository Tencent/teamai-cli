/**
 * Real CLI: what a step requires reaches it, and nothing else does. A secret a step prints stays out of the run file,
 * the record, and the JSON the CLI prints; a missing key fails before the step runs; a step past its timeout ends
 * `timeout`; setup that leaves its key in `.npmrc` fails `setup_secret` before the step runs; a network requirement
 * the local driver cannot enforce is recorded as unenforced.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const SAFETY_TOKEN = 'fixture-workflow-safety-token-1082';
const OTHER_TOKEN = 'fixture-workflow-other-token-1082';
const SETUP_TOKEN = 'fixture-workflow-setup-token-1082';

const EnvelopeSchema = z.object({ data: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
const DoneSchema = z.object({ data: z.object({ done: z.object({ run: z.string() }) }) });
const RunSchema = z.object({ steps: z.array(z.record(z.string(), z.unknown())).nonempty() });

function envelopeLine(stdout: string): unknown {
  const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return JSON.parse(line);
}

function envelope(stdout: string): z.infer<typeof EnvelopeSchema> {
  return EnvelopeSchema.parse(envelopeLine(stdout));
}

function runOf(stdout: string): string {
  return DoneSchema.parse(envelopeLine(stdout)).data.done.run;
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '.git' ? [] : filesUnder(full);
    return entry.isFile() ? [full] : [];
  });
}

describe('workflow requirements and limits (real CLI, #1082)', () => {
  let root: string;
  let home: string;
  let repo: string;
  let markers: string;
  let env: NodeJS.ProcessEnv;
  const outputs: string[] = [];

  function teamai(...args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 45_000 });
    outputs.push(result.stdout, result.stderr);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function git(...args: string[]): void {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }

  function workflow(name: string, yaml: string): void {
    fs.writeFileSync(path.join(repo, '.teamai', 'workflows', `${name}.yaml`), `schemaVersion: v1alpha1\nname: ${name}\n${yaml}`);
  }

  function runFile(runId: string): string {
    const found = filesUnder(home).find((file) => file.endsWith(path.join('workflows', 'runs', `${runId}.json`)) && !file.includes('reports-wt'));
    if (!found) throw new Error(`no run file for ${runId}`);
    return fs.readFileSync(found, 'utf8');
  }

  function endRecord(runId: string): string {
    const found = filesUnder(home).find((file) => path.basename(file) === `${runId}.end.json`);
    if (!found) throw new Error(`no end record for ${runId}`);
    return fs.readFileSync(found, 'utf8');
  }

  /** The run file and the run's records, queued or published. */
  function filesOfRun(runId: string): string[] {
    const found = filesUnder(home).filter((file) => path.basename(file).startsWith(runId) || file.includes(path.join('runs', runId, 'attempts')));
    expect(found.length).toBeGreaterThan(2);
    return found.map((file) => fs.readFileSync(file, 'utf8'));
  }

  function step(runId: string): Record<string, unknown> {
    return RunSchema.parse(JSON.parse(runFile(runId))).steps[0];
  }

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-safety-')));
    home = path.join(root, 'home');
    repo = path.join(root, 'repo');
    markers = path.join(root, 'markers');
    for (const dir of [home, repo, markers]) fs.mkdirSync(dir);
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      FORCE_COLOR: '0',
      WORKFLOW_SAFETY_TOKEN: SAFETY_TOKEN,
      WORKFLOW_OTHER_TOKEN: OTHER_TOKEN,
      WORKFLOW_SETUP_TOKEN: SETUP_TOKEN,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CODEX_HOME;
    delete env.WORKFLOW_MISSING_TOKEN;
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), '.npmrc\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    git('remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git');
    const initialized = teamai('init', '--self', '--agent', 'claude', '--force');
    expect(initialized.status, initialized.stderr + initialized.stdout).toBe(0);
    fs.mkdirSync(path.join(repo, '.teamai', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.teamai', 'env'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.teamai', 'env', 'secrets.yaml'), [
      'secrets:',
      '  - key: WORKFLOW_SAFETY_TOKEN',
      '  - key: WORKFLOW_OTHER_TOKEN',
      '  - key: WORKFLOW_SETUP_TOKEN',
      '  - key: WORKFLOW_MISSING_TOKEN',
      '',
    ].join('\n'));
    workflow('print', `description: Print the key the step requires.
steps:
  - id: print
    requires: { env: [WORKFLOW_SAFETY_TOKEN] }
    command: node -e 'console.log(JSON.stringify({token:process.env.WORKFLOW_SAFETY_TOKEN,[process.env.WORKFLOW_SAFETY_TOKEN]:"masked-key",other:process.env.WORKFLOW_OTHER_TOKEN??null}))'
`);
    workflow('missing', `description: Require a key with no value.
steps:
  - id: inspect
    requires: { env: [WORKFLOW_MISSING_TOKEN] }
    command: node -e 'require("fs").writeFileSync(${JSON.stringify(path.join(markers, 'missing'))}, "ran")'
`);
    workflow('deadline', `description: Run past the step timeout.
steps:
  - id: wait
    timeout: 1s
    command: node -e 'setTimeout(() => {}, 15000)'
`);
    workflow('setup-secret', `description: Setup that leaves its key in a file.
setup:
  command: node -e 'require("fs").writeFileSync(".npmrc", "//registry/:_authToken=" + process.env.WORKFLOW_SETUP_TOKEN)'
  requires: { env: [WORKFLOW_SETUP_TOKEN] }
steps:
  - id: work
    workspace: new
    command: node -e 'require("fs").writeFileSync(${JSON.stringify(path.join(markers, 'setup'))}, String(process.env.WORKFLOW_SETUP_TOKEN))'
`);
    workflow('offline', `description: Ask for no network.
steps:
  - id: offline
    requires: { network: false }
    command: node -e 'process.exit(0)'
`);
    const pulled = teamai('pull');
    expect(pulled.status, pulled.stderr).toBe(0);
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('gives a step the key it requires, keeps the others from it, and masks the value it prints', () => {
    const started = teamai('workflow', 'start', 'print', '--driver', 'local');
    expect(started.status, started.stderr).toBe(0);
    expect(envelope(started.stdout)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(started.stdout);
    expect(step(runId)).toMatchObject({ status: 'succeeded', outputs: { token: '<REDACTED:WORKFLOW_SAFETY_TOKEN>', '<REDACTED:WORKFLOW_SAFETY_TOKEN>': 'masked-key', other: null } });
    for (const content of filesOfRun(runId)) expect(content).not.toContain(SAFETY_TOKEN);
    expect(started.stdout + started.stderr).not.toContain(SAFETY_TOKEN);
  });

  it('fails a step whose required key has no value with missing_env before it runs', () => {
    const started = teamai('workflow', 'start', 'missing', '--driver', 'local');
    expect(started.status).toBe(1);
    const runId = runOf(started.stdout);
    expect(step(runId)).toMatchObject({ status: 'failed', failure: { code: 'missing_env', message: expect.stringContaining('teamai env set WORKFLOW_MISSING_TOKEN') } });
    expect(fs.existsSync(path.join(markers, 'missing'))).toBe(false);
  });

  it('stops a step past its timeout, which then reads timeout', () => {
    const before = Date.now();
    const started = teamai('workflow', 'start', 'deadline', '--driver', 'local');
    expect(started.status, started.stderr).toBe(1);
    expect(Date.now() - before).toBeLessThan(12_000);
    const runId = runOf(started.stdout);
    expect(step(runId)).toMatchObject({ status: 'failed', failure: { code: 'timeout' } });
    expect(endRecord(runId)).toContain('"outcome": "timeout"');
  });

  it('fails setup_secret when setup leaves its key in .npmrc, and the step never runs', () => {
    const started = teamai('workflow', 'start', 'setup-secret', '--driver', 'local');
    expect(started.status, started.stderr).toBe(1);
    const runId = runOf(started.stdout);
    expect(step(runId)).toMatchObject({ status: 'failed', failure: { code: 'setup_secret', message: expect.stringContaining('.npmrc') } });
    expect(fs.existsSync(path.join(markers, 'setup'))).toBe(false);
    for (const content of filesOfRun(runId)) expect(content).not.toContain(SETUP_TOKEN);
  });

  it('runs a step that asks for no network and records network as unenforced', () => {
    const started = teamai('workflow', 'start', 'offline', '--driver', 'local');
    expect(started.status, started.stderr).toBe(0);
    const runId = runOf(started.stdout);
    expect(step(runId)).toMatchObject({ status: 'succeeded', unenforced: [{ requirement: 'network', asked: false }] });
    expect(JSON.parse(endRecord(runId))).toMatchObject({ steps: [{ step: 'offline', unenforced: [{ requirement: 'network', asked: false }] }] });
  });

  it('printed no secret value in any command output', () => {
    const printed = outputs.join('\n');
    for (const value of [SAFETY_TOKEN, OTHER_TOKEN, SETUP_TOKEN]) expect(printed).not.toContain(value);
  });
});
