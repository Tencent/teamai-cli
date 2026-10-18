import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';
import { workflowConformanceScenarios, type WorkflowClient } from '../../workflow/conformance.js';
import type { DriverIdentity, RunState, WorkflowEnvelope } from '../../workflow/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const driver: DriverIdentity = { kind: 'local', machine: 'cli-conformance', workspace: '/work' };

function runCLI(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
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
      const call = async (args: string[]): Promise<WorkflowEnvelope> => envelope((await runCLI(['workflow', ...args], repo)).stdout);
      const client: WorkflowClient = {
        start: (name) => call(['start', name]),
        next: (run, body) => call(['next', run, '--json', JSON.stringify(body)]),
        report: (run, body) => call(['report', run, '--json', JSON.stringify(body)]),
        respond: (run, step, choice, options) => call(['respond', run, step, choice, ...(options?.note !== undefined ? ['--note', options.note] : []), ...(options?.pass !== undefined ? ['--pass', String(options.pass)] : []), ...(options?.json !== undefined ? ['--json', JSON.stringify(options.json)] : [])]),
        retry: (run, step) => call(['retry', run, step]),
        cancel: (run, step) => call(['cancel', run, ...(step !== undefined ? [step] : [])]),
      };
      const started = await client.start(scenario.workflowName);
      if ('error' in started) throw new Error(started.error.message);
      const runId = String(started.data.run);
      const leases = new Map<string, { attempt: string; revision: number }>();
      const attemptOf = (name: string): string | undefined => leases.get(name)?.attempt;
      for (const operation of scenario.operations) {
        if (operation.kind === 'next') {
          const value = await client.next(runId, {
            driver: { ...driver, ...(operation.hitl !== undefined ? { can: { hitl: operation.hitl } } : {}) },
            ...(operation.running ? { running: operation.running.map(attemptOf) } : {}),
            ...(operation.canTakeLease !== undefined ? { canTakeLease: operation.canTakeLease } : {}),
          });
          expect(value).toMatchObject(operation.expect);
          if (operation.saveAs === 'busy') {
            const dataHome = await resolveProjectDataHome(repo);
            const stored = JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${runId}.json`), 'utf8')) as RunState;
            expect(stored).toMatchObject({ steps: [{ id: 'work', status: 'waiting' }, { id: 'later', status: 'pending' }, { id: 'parallel', status: 'leased' }] });
          }
          if ('data' in value && value.data.hitl) {
            const hitl = value.data.hitl as { step: string; pass: number; respond: string };
            expect(hitl.respond).toBe(`teamai workflow respond ${runId} ${hitl.step} <option> --pass ${hitl.pass}`);
          }
          if (operation.cancelled) expect('data' in value && value.data.cancelled).toEqual(operation.cancelled.map(attemptOf));
          for (const field of operation.absent ?? []) expect('data' in value ? value.data.lease : undefined).not.toHaveProperty(field);
          if ('data' in value && value.data.lease) {
            leases.set(operation.saveAs, value.data.lease as { attempt: string; revision: number });
          }
          continue;
        }
        if (operation.kind === 'respond' || operation.kind === 'retry' || operation.kind === 'cancel') {
          const value = operation.kind === 'respond' ? await client.respond(runId, operation.step, operation.choice, { note: operation.note, pass: operation.pass, json: operation.json })
            : operation.kind === 'retry' ? await client.retry(runId, operation.step) : await client.cancel(runId, operation.step);
          expect(value).toMatchObject(operation.expect);
          continue;
        }
        const lease = operation.lease ? leases.get(operation.lease) : undefined;
        const value = await client.report(runId, {
          attempt: operation.attempt ?? lease?.attempt,
          revision: operation.revision ?? lease?.revision,
          driver,
          ...operation.body,
        });
        expect(value).toMatchObject(operation.expect);
      }
      if (scenario.expectState || scenario.name === 'two-step command success' || scenario.name === 'output mismatch fails the step') {
        const dataHome = await resolveProjectDataHome(repo);
        const stored = JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${runId}.json`), 'utf8')) as RunState;
        if (scenario.expectState) expect(stored).toMatchObject(scenario.expectState);
        if (scenario.name === 'two-step command success') {
          expect(stored.steps[1]).toMatchObject({
            status: 'succeeded',
            outputs: { ok: true },
            tool: 'claude',
            model: 'claude-sonnet',
            session: 'session-1',
            tokens: { input: 3, output: 2, cachedInput: 1 },
          });
        } else if (scenario.name === 'output mismatch fails the step') {
          expect(stored.steps[0]).toMatchObject({
            status: 'failed',
            failure: { code: 'invalid_output', message: expect.stringContaining('does not match output') },
          });
        }
      }
    });
  }
});
