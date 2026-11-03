import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import YAML from 'yaml';
import { resolveProjectDataHome } from '../../config.js';
import type { LocalConfig } from '../../types.js';
import { syncScorersThenWorkflows } from '../../scorers/team-sync.js';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
let sandbox: string;
afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

/**
 * A project whose team has `workflows`, and a `claude` on PATH that answers every prompt with `{}`, reporting `tokens`
 * input tokens. Runs the built CLI there.
 */
async function project(workflows: Record<string, string>, { tokens }: { tokens: number }) {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-resume-as-printed-')));
  const repo = path.join(sandbox, 'app');
  const bin = path.join(sandbox, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('init', '-q', '-b', 'main');
  git('add', 'README.md');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  const dataHome = await resolveProjectDataHome(repo);
  const team = path.join(sandbox, 'team');
  const config: LocalConfig = {
    repo: { localPath: team, remote: 'http://127.0.0.1:9/team/workflow.git', kind: 'git' },
    username: 'tester', scope: 'project', projectRoot: repo, dataHome, updatePolicy: 'skip', additionalRoles: [],
  };
  fs.mkdirSync(dataHome, { recursive: true });
  fs.writeFileSync(path.join(dataHome, 'config.yaml'), YAML.stringify(config));
  fs.mkdirSync(path.join(team, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(team, 'teamai.yaml'), YAML.stringify({ team: 'resume-test', repo: config.repo.remote, provider: 'git', usageReport: false }));
  for (const [name, yaml] of Object.entries(workflows)) fs.writeFileSync(path.join(team, 'workflows', `${name}.yaml`), yaml);
  await syncScorersThenWorkflows(config);

  const fake = path.join(bin, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', result: '{}', usage: { input_tokens: ${tokens}, output_tokens: 0 } }) + '\\n');
`);
  fs.chmodSync(fake, 0o755);
  if (process.platform === 'win32') {
    fs.copyFileSync(fake, `${fake}.cjs`);
    fs.writeFileSync(`${fake}.cmd`, `@echo off\r\n"${process.execPath}" "${fake}.cjs" %*\r\n`);
  }

  // Unattended, as in CI, so nobody answers an approval but --auto-approve.
  const env = { ...process.env, FORCE_COLOR: '0', TEAMAI_MODE: 'unattended', TEAMAI_AI_TOOL: '', PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };

  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    expect(result.error).toBeUndefined();
    const envelope: unknown = JSON.parse(result.stdout.trim().split('\n').findLast((line) => line.startsWith('{')) ?? 'null');

    return { envelope, stderr: result.stderr, status: result.status };
  };

  return { repo, run };
}

const SHIP = `schemaVersion: v1alpha1
name: ship
description: Verify, review, then ship once approved.
steps:
  - id: verify
    requires: { isolation: sandbox, strict: true }
    command: node -e "require('fs').statSync('verified')"
  - id: review
    needs: [verify]
    prompt: Review the change.
  - id: ship
    needs: [review]
    approve: { message: Ship it? }
    command: node -e "require('fs').writeFileSync('../shipped', '')"
`;

/** The command a line of stderr tells the person to run, as printed. */
function printed(stderr: string, pattern: RegExp): string[] {
  const match = pattern.exec(stderr);
  expect(match, stderr).not.toBeNull();

  return (match?.[1] ?? '').split(' ').slice(1);
}

it('continues a run with the commands it prints, on the --tools, --auto-approve and --sandbox it was started with (#1687)', async () => {
  const { repo, run } = await project({ ship: SHIP }, { tokens: 10 });

  const started = run(['workflow', 'start', 'ship', '--driver', 'local', '--tools', 'default=claude', '--auto-approve', '--sandbox']);
  expect(started).toMatchObject({ status: 1, envelope: { data: { done: { outcome: 'failed' } } } });
  const resume = printed(started.stderr, /continue it with: (teamai workflow resume \S+)$/m);
  const retry = printed(started.stderr, /Retry it with (teamai workflow retry \S+ verify), then/);
  expect(started.stderr).toContain(`Retry it with teamai workflow retry ${resume[2]} verify, then continue the run with teamai ${resume.join(' ')}`);

  fs.writeFileSync(path.join(repo, 'verified'), '');
  const retried = run(retry);
  expect(retried.envelope).toMatchObject({ data: { reopened: true, resume: `teamai ${resume.join(' ')}` } });

  const resumed = run(resume);
  expect(resumed.stderr).not.toContain('tool_unconfigured');
  expect(resumed, resumed.stderr).toMatchObject({ status: 0, envelope: { data: { done: { outcome: 'succeeded' } } } });
  expect(fs.existsSync(path.join(repo, '..', 'shipped'))).toBe(true);
}, 120_000);

it('says on stderr that a run failed because it spent its token budget (#1687)', async () => {
  const { run } = await project({ 'nightly-small': `schemaVersion: v1alpha1
name: nightly-small
description: One prompt on a small budget.
budget: { tokens: 300 }
steps:
  - id: triage
    prompt: Triage the backlog.
` }, { tokens: 350 });

  const started = run(['workflow', 'start', 'nightly-small', '--driver', 'local', '--tools', 'default=claude']);

  expect(started).toMatchObject({ status: 1, envelope: { data: { done: { outcome: 'failed', failure: { code: 'budget_exceeded' } } } } });
  expect(started.stderr).toMatch(/Run (\S+) failed with budget_exceeded: workflow "nightly-small" spent 350 of its 300-token budget/);
}, 120_000);
