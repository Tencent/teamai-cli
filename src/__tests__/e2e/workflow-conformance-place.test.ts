import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DRIVERS_UNDER_TEST, runConformanceScenario, speaksAsDriverUnderTest } from '../../workflow/conformance-interpreter.js';
import { PLACE_CHECKOUT_FILES, workflowPlaceConformanceScenarios } from '../../workflow/conformance/place.js';
import type { RunState, WorkflowEnvelope } from '../../workflow/types.js';
import { cliConformanceClient, envelope, fileUnder, runCLI } from '../helpers/cli-conformance.js';

describe.each(DRIVERS_UNDER_TEST)('workflow place conformance through the CLI as %s', (profile) => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  // A scenario that never speaks as the driver under test makes the same calls under every profile, so it runs under the first.
  for (const scenario of workflowPlaceConformanceScenarios.filter((item) => profile === DRIVERS_UNDER_TEST[0] || speaksAsDriverUnderTest(item))) {
    it(scenario.name, async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-place-cli-conformance-')));
      dirs.push(root);
      const home = path.join(root, 'home');
      const checkout = path.join(root, 'checkout');
      const origin = path.join(root, 'origin.git');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n');
      const env: NodeJS.ProcessEnv = { ...process.env, ...scenario.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
      delete env.CLAUDE_CONFIG_DIR;
      delete env.CODEX_HOME;
      const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
      git(root, 'init', '-q', '-b', 'main', checkout);
      for (const [file, text] of Object.entries(PLACE_CHECKOUT_FILES)) fs.writeFileSync(path.join(checkout, file), text);
      git(checkout, 'add', '-A');
      git(checkout, 'commit', '-qm', 'initial');
      git(root, 'init', '-q', '--bare', '-b', 'main', origin);
      git(checkout, 'remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git');
      const initialized = await runCLI(['init', '--self', '--agent', 'claude', '--force'], checkout, env);
      expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
      git(checkout, 'remote', 'set-url', 'origin', origin);
      git(checkout, 'push', '-q', 'origin', 'main');
      const workflows = path.join(checkout, '.teamai', 'workflows');
      fs.mkdirSync(workflows, { recursive: true });
      fs.writeFileSync(path.join(workflows, `${scenario.workflowName}.yaml`), scenario.yaml);
      for (const [name, yaml] of Object.entries(scenario.workflows ?? {})) fs.writeFileSync(path.join(workflows, `${name}.yaml`), yaml);
      const pulled = await runCLI(['pull'], checkout, env);
      expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
      // Every call is a process of its own with a temporary directory of its own, gone once it exits.
      let calls = 0;
      const call = async (args: string[], extra: Record<string, string> = {}): Promise<WorkflowEnvelope> => {
        calls += 1;
        const tmp = path.join(root, `tmp-${calls}`);
        fs.mkdirSync(tmp);
        try {
          const { stdout, stderr } = await runCLI(['workflow', ...args], checkout, { ...env, ...extra, TMPDIR: tmp, TMP: tmp, TEMP: tmp });
          if (!stdout.includes('{')) throw new Error(`workflow ${args[0]} printed no JSON envelope:\n${stdout}\n${stderr}`);
          return envelope(stdout);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      };
      await runConformanceScenario(scenario, {
        client: cliConformanceClient(call),
        readRun: async (runId) => {
          const file = fileUnder(home, path.join('workflows', 'runs', `${runId}.json`));
          if (!file) throw new Error(`run ${runId} has no run file under ${home}`);
          return JSON.parse(fs.readFileSync(file, 'utf8')) as RunState;
        },
        readEndRecord: async (runId) => {
          const file = fileUnder(home, path.join('workflows', 'pending', `${runId}.end.json`));
          return file ? JSON.parse(fs.readFileSync(file, 'utf8')) as unknown : undefined;
        },
        advance: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
        expect,
        place: { checkout, origin },
      }, profile);
    });
  }
});
