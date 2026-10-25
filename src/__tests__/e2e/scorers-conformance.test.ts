import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JUDGES_UNDER_TEST, runJudgeConformanceScenario } from '../../workflow/conformance-interpreter.js';
import { judgeConformanceScenarios } from '../../workflow/conformance/judge.js';
import type { WorkflowEnvelope } from '../../workflow/types.js';
import { cliConformanceClient, envelope, fileUnder, runCLI } from '../helpers/cli-conformance.js';

/** Stops the clock of the process at CONFORMANCE_CLOCK, as the in-process runner fakes Date. */
const FROZEN_CLOCK = `const at = Date.parse(process.env.CONFORMANCE_CLOCK);
class FrozenDate extends Date {
  constructor(...args) { super(...(args.length > 0 ? args : [at])); }
  static now() { return at; }
}
globalThis.Date = FrozenDate;
`;

describe.each(JUDGES_UNDER_TEST)('judge lease conformance through the CLI as %s', (profile) => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const scenario of judgeConformanceScenarios) {
    it(scenario.name, async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-judge-cli-conformance-')));
      dirs.push(root);
      const home = path.join(root, 'home');
      const checkout = path.join(root, 'checkout');
      const origin = path.join(root, 'origin.git');
      const clock = path.join(root, 'clock.mjs');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n');
      fs.writeFileSync(clock, FROZEN_CLOCK);
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
      delete env.CLAUDE_CONFIG_DIR;
      delete env.CODEX_HOME;
      const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
      git(root, 'init', '-q', '-b', 'main', checkout);
      fs.writeFileSync(path.join(checkout, 'README.md'), '# fixture\n');
      git(checkout, 'add', '-A');
      git(checkout, 'commit', '-qm', 'initial');
      git(root, 'init', '-q', '--bare', '-b', 'main', origin);
      git(checkout, 'remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git');
      const initialized = await runCLI(['init', '--self', '--agent', 'claude', '--force'], checkout, env);
      expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
      git(checkout, 'remote', 'set-url', 'origin', origin);
      git(checkout, 'push', '-q', 'origin', 'main');
      const knowledge = path.join(checkout, '.teamai');
      fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
      fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
      fs.writeFileSync(path.join(knowledge, 'workflows', 'judged.yaml'), scenario.yaml);
      for (const [name, text] of Object.entries(scenario.scorers)) fs.writeFileSync(path.join(knowledge, 'scorers', `${name}.md`), text);
      const pulled = await runCLI(['pull'], checkout, env);
      expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
      let now = '';
      const call = async (args: string[], input?: string): Promise<WorkflowEnvelope> => {
        const { stdout, stderr } = await runCLI(args, checkout, { ...env, CONFORMANCE_CLOCK: now }, { input, node: ['--import', pathToFileURL(clock).href] });
        if (!stdout.includes('{')) throw new Error(`${args.slice(0, 2).join(' ')} printed no JSON envelope:\n${stdout}\n${stderr}`);
        return envelope(stdout);
      };
      await runJudgeConformanceScenario(scenario, {
        client: {
          ...cliConformanceClient((args) => call(['workflow', ...args])),
          scoreNext: (body) => call(['score', '--next', '--json', JSON.stringify(body)]),
          submit: (ref, body) => call(['score', '--lease', ref, '--submit', '--stdin'], JSON.stringify(body)),
        },
        readRevision: async (runId) => {
          const file = fileUnder(home, path.join('workflows', 'runs', `${runId}.json`));
          if (!file) throw new Error(`run ${runId} has no run file under ${home}`);
          return z.object({ revision: z.number() }).parse(JSON.parse(fs.readFileSync(file, 'utf8'))).revision;
        },
        setClock: async (at) => { now = at; },
        expect,
      }, profile);
    });
  }
});
