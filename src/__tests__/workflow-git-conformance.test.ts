import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { workflowGitConformanceScenarios, type GitConformanceName } from '../workflow/conformance.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { claimRun, publishRun } from '../workflow/handoff.js';
import { runLocalDriver } from '../workflow/local-driver.js';
import type { StepState } from '../workflow/step-state.js';
import { readRun } from '../workflow/store.js';
import type { DriverIdentity, RunState } from '../workflow/types.js';
import type { WorkspaceContract } from '../workflow/workspace.js';
import { knownSecrets } from '../env-resolution.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

describe('workflow git conformance of the local driver', () => {
  for (const scenario of workflowGitConformanceScenarios) {
    it(scenario.name, async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-conformance-')));
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
      const knowledge = path.join(root, 'knowledge');
      fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(knowledge, 'workflows', `${scenario.workflowName}.yaml`), scenario.yaml);
      const team = path.join(root, 'team.git');
      if (scenario.handoff) {
        git(root, 'init', '-q', '-b', 'main', knowledge);
        git(knowledge, 'add', '-A');
        git(knowledge, 'commit', '-qm', 'team');
        git(root, 'clone', '-q', '--bare', knowledge, team);
        git(knowledge, 'remote', 'add', 'origin', team);
        // Its own directory, since an install keeps teamai-reports beside its team clone.
        git(root, 'clone', '-q', team, path.join(root, 'other', 'team-repo'));
      }
      const install = (name: string, projectRoot: string, localPath: string): LocalConfig => ({
        repo: scenario.handoff ? { localPath, remote: team, kind: 'git' } : { localPath, remote: 'local', kind: 'self' },
        username: name,
        scope: 'project',
        additionalRoles: [],
        projectRoot,
        dataHome: path.join(root, `data-${name}`),
        workflows: { tools: {}, max_parallel: 1 },
      });
      const config = install('tester', checkout, knowledge);
      await syncWorkflowDefinitions(config);
      // Without a handoff the other machine's driver reports into the same install.
      const starter = scenario.handoff ? install('elsewhere', elsewhere, path.join(root, 'other', 'team-repo')) : config;
      if (starter !== config) await syncWorkflowDefinitions(starter);
      const started = await startRun(starter, scenario.workflowName, {}, { secrets: await knownSecrets(starter), base: { ref: 'main', commit: git(elsewhere, 'rev-parse', 'HEAD') } });
      if ('error' in started) throw new Error(started.error.message);
      const runId = String(started.data.run);

      const other: DriverIdentity = { kind: 'local', machine: 'elsewhere', workspace: elsewhere };
      for (const step of scenario.elsewhere ?? []) {
        const next = await leaseNext(starter, runId, other, { can: { workspace: ['new', 'continue', 'read-only'] } });
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
        const reported = await reportAttempt(starter, runId, {
          attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: other,
          changes: { branch, base: base.commit, from: start.commit, to, commits: [to] },
        });
        expect(reported).toMatchObject({ data: { accepted: true } });
      }
      if (scenario.handoff) {
        expect(await publishRun(starter, runId, { checkout: elsewhere, env: {} })).toMatchObject({ ok: true, value: { publication: 'published' } });
        expect(await claimRun(config, runId, { checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
      }
      if (scenario.refusePushes) {
        const hook = path.join(origin, 'hooks', 'pre-receive');
        fs.writeFileSync(hook, '#!/bin/sh\necho "origin refuses pushes" >&2\nexit 1\n');
        fs.chmodSync(hook, 0o755);
      }

      await runLocalDriver(config, runId, checkout);

      const run = await readRun(config, runId);
      if (typeof run !== 'object') throw new Error('run was not stored');
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
