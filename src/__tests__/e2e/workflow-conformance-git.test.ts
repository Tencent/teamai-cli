import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DRIVER_PROFILES, DRIVERS_UNDER_TEST, driveByProtocol, profileDriver } from '../../workflow/conformance-interpreter.js';
import { workflowGitConformanceScenarios, type GitConformanceName } from '../../workflow/conformance/git.js';
import type { StepState } from '../../workflow/step-state.js';
import type { RunState, WorkflowEnvelope } from '../../workflow/types.js';
import type { WorkspaceContract } from '../../workflow/workspace.js';
import { cliConformanceClient, envelope, runCLI } from '../helpers/cli-conformance.js';

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

describe.each(DRIVERS_UNDER_TEST)('workflow git conformance through the CLI as %s', (profile) => {
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

      // A handoff run is not on this install yet: resume, or the first next, claims it before it drives.
      if (profile === 'local') {
        const resumed = await call(['resume', runId], checkout, tester);
        expect(resumed, JSON.stringify(resumed)).toMatchObject({ data: { done: { run: runId } } });
      } else {
        const client = cliConformanceClient((args) => call(args, checkout, tester));
        const driver = { ...profileDriver(profile), workspace: checkout };
        expect(await driveByProtocol({ client, runId, driver, can: DRIVER_PROFILES[profile].can, ...(scenario.handoff ? { claim: true as const } : {}) })).toMatchObject({ data: { done: {} } });
      }

      const run = JSON.parse(fs.readFileSync(path.join(root, 'tester', '.teamai', 'workflows', 'runs', `${runId}.json`), 'utf8')) as RunState;
      const steps = run.steps.map((step) => `${step.id} ${step.status}${'message' in step && step.message ? `: ${step.message}` : ''}`);
      const refused = scenario.refusedBy?.[profile];
      const end = refused ?? scenario;
      expect(run, steps.join('\n')).toMatchObject(end.expectState);
      for (const [id, files] of Object.entries(end.expectPushed ?? {})) {
        const changes = changesOf(run, id);
        expect(git(origin, 'for-each-ref', '--format=%(objectname)', `refs/heads/${changes.branch}`), `${id} is pushed`).toBe(changes.to);
        for (const [file, text] of Object.entries(files)) expect(git(origin, 'show', `${changes.to}:${file}`)).toBe(text);
      }
      if (!refused && scenario.expectFailure) {
        const { step: id, names, codeIsNot } = scenario.expectFailure;
        const step = run.steps.find((item) => item.id === id);
        const message = step && 'message' in step ? step.message ?? '' : '';
        for (const name of names) expect(message, name).toMatch(asWord(valueOf(run, name)));
        if (codeIsNot) expect(step && 'failure' in step ? step.failure?.code : undefined).not.toBe(codeIsNot);
      }
    });
  }
});
