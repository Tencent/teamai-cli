import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';
import { DRIVERS_UNDER_TEST, runConformanceScenario, speaksAsDriverUnderTest } from '../../workflow/conformance-interpreter.js';
import { workflowConformanceScenarios } from '../../workflow/conformance/run.js';
import type { RunState, WorkflowEnvelope } from '../../workflow/types.js';
import { cliConformanceClient, envelope, runCLI } from '../helpers/cli-conformance.js';
import { inProcessConformanceRunner, normalized, recorded, UNREACHABLE_ORIGIN } from '../helpers/in-process-conformance.js';

describe.each(DRIVERS_UNDER_TEST)('workflow protocol conformance through the CLI as %s', (profile) => {
  let repo: string;

  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-cli-conformance-'));
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', UNREACHABLE_ORIGIN], { cwd: repo });
    const initialized = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
  });

  const dirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  // A scenario that never speaks as the driver under test makes the same calls under every profile, so it runs under the first.
  for (const scenario of workflowConformanceScenarios.filter((item) => profile === DRIVERS_UNDER_TEST[0] || speaksAsDriverUnderTest(item))) {
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
      const call = async (args: string[], extra: Record<string, string> = {}): Promise<WorkflowEnvelope> => {
        const { stdout } = await runCLI(['workflow', ...args], repo, { ...env, ...extra });
        for (const [name, value] of Object.entries(scenario.env ?? {})) expect(stdout.includes(value), `workflow ${args[0]} printed the value of ${name}`).toBe(false);
        return envelope(stdout);
      };
      const cli = recorded(cliConformanceClient(call));
      await runConformanceScenario(scenario, {
        client: cli.client,
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
      }, profile);

      // The in-process client answers the same scenario, started from a checkout as the CLI's is, with the envelopes the CLI prints.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-conformance-'));
      dirs.push(root);
      const inProcess = await inProcessConformanceRunner(scenario, root, { checkout: true });
      const local = recorded(inProcess.runner.client);
      await runConformanceScenario(scenario, { ...inProcess.runner, client: local.client, expect }, profile);
      const places = { knowledge: path.join(repo, '.teamai'), data: await resolveProjectDataHome(repo), project: repo };
      expect(normalized(cli.envelopes, places), 'the CLI and the in-process client answer alike').toEqual(normalized(inProcess.printed(local.envelopes), inProcess.places));
    });
  }
});
