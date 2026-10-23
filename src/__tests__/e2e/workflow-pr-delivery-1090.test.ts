import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';
import type { RunState } from '../../workflow/types.js';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

describe('workflow PR delivery CLI (#1090)', () => {
  it('runs the documented CI path, creates/reuses a provider PR, retains generic-git work, and refuses required unattended approvals', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pr-cli-')));
    const home = path.join(root, 'home'); const product = path.join(root, 'product'); const team = path.join(root, 'team'); const bin = path.join(root, 'bin');
    for (const dir of [home, product, team, bin]) fs.mkdirSync(dir);
    const detached = trackDetachedProcesses(root);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FORCE_COLOR: '0',
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' '), PR_FIXTURE: path.join(root, 'pr.json') };
    delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME; delete env.GITHUB_TOKEN; delete env.GH_TOKEN;
    const run = (command: string, args: string[], cwd = product) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
    const git = (args: string[], cwd = product) => { const result = run('git', args, cwd); expect(result.status, result.stderr).toBe(0); return result.stdout.trim(); };
    const call = (args: string[]) => run(process.execPath, [cli, ...args]);
    const envelope = (stdout: string) => JSON.parse(stdout.trim().split('\n').filter((line) => line.startsWith('{')).at(-1)!);
    const productUrl = 'https://github.com/fixture/app.git'; const teamUrl = 'https://team.example.invalid/fixture/team.git';
    const bare = path.join(root, 'product.git');
    fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('fs'); const args = process.argv.slice(2); const file = process.env.PR_FIXTURE;
if (args[0] === '--version') { console.log('gh version 2.80.0'); process.exit(0); }
if (args[0] === 'api') {
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  console.log(JSON.stringify(args[1].includes('?') ? saved ? [saved] : [] : saved)); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  const val = key => args[args.indexOf(key) + 1];
  if (val('-R') !== 'fixture/app' || val('-B') !== 'main') process.exit(7);
  const pr = { state: 'open', html_url: 'https://github.com/fixture/app/pull/41', head: { ref: val('-H'), repo: { full_name: 'fixture/app' } }, base: { ref: val('-B'), repo: { full_name: 'fixture/app' } } };
  fs.writeFileSync(file, JSON.stringify(pr)); fs.appendFileSync(file + '.creates', 'create\\n'); console.log(pr.html_url); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') { console.log('[]'); process.exit(0); }
console.error('Unexpected provider operation: ' + args[0]); process.exit(9);
`, { mode: 0o755 });
    try {
      git(['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(product, 'README.md'), '# Product\n'); git(['add', '.']); git(['commit', '-qm', 'base']);
      git(['init', '-q', '--bare', '-b', 'main', bare]); git(['remote', 'add', 'origin', productUrl]);
      git(['config', '--global', `url.${bare}.insteadOf`, productUrl]); git(['push', '-qu', 'origin', 'main']);
      git(['init', '-q', '-b', 'main'], team); fs.mkdirSync(path.join(team, 'workflows'));
      fs.writeFileSync(path.join(team, 'teamai.yaml'), `team: fixture\nrepo: ${teamUrl}\nprovider: git\nusageReport: false\n`);
      const yaml = `schemaVersion: v1alpha1
name: ship-issue
description: Deliver an issue change for review.
inputs: { issue: number }
steps:
  - id: approve
    approve: { message: Start the fixture?, required: false }
  - id: work
    needs: [approve]
    workspace: new
    deliver: pr
    command: node -e "require('fs').writeFileSync('issue.txt', process.env.ISSUE)"
    env:
      ISSUE: "{{ inputs.issue }}"
`;
      fs.writeFileSync(path.join(team, 'workflows', 'ship-issue.yaml'), yaml);
      fs.writeFileSync(path.join(team, 'workflows', 'required.yaml'), yaml.replace('name: ship-issue', 'name: required').replace('required: false', 'required: true'));
      git(['add', '.'], team); git(['commit', '-qm', 'team workflows'], team);
      git(['config', '--global', `url.${team}.insteadOf`, teamUrl]);
      const initialized = call(['init', teamUrl, '--scope', 'workspace', '--agent', 'claude', '--force']); expect(initialized.status, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
      const pulled = call(['pull']); expect(pulled.status, pulled.stderr).toBe(0); await detached.waitForExit();
      const started = call(['workflow', 'start', 'ship-issue', '--driver', 'local', '--auto-approve', '--inputs', '{"issue":42}']);
      expect(started.status, `${started.stdout}\n${started.stderr}`).toBe(0);
      const done = envelope(started.stdout).data.done; expect(done.outcome).toBe('succeeded');
      const runFile = fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).find((file) => file.endsWith(path.join('workflows', 'runs', `${done.run}.json`)));
      expect(runFile).toBeDefined();
      const dataHome = path.dirname(path.dirname(path.dirname(path.join(root, runFile!))));
      const read = (id: string) => JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${id}.json`), 'utf8')) as RunState;
      const state = read(done.run); const work = state.steps.find((step) => step.id === 'work');
      expect(work).toMatchObject({ status: 'succeeded', changes: { pr_url: 'https://github.com/fixture/app/pull/41' } });
      const branch = `teamai/${done.run}/work/p1`;
      expect(git(['--git-dir', bare, 'show', `${branch}:issue.txt`])).toBe('42'); expect(fs.existsSync(path.join(product, 'issue.txt'))).toBe(false);
      // Re-enter durable post-agent delivery as after a crash: the open PR is reused, with no new agent work or create.
      if (work?.status !== 'succeeded') throw new Error('missing successful work');
      const persisted = state as unknown as { status: string; steps: Array<Record<string, unknown>> };
      persisted.status = 'running'; const target = persisted.steps.find((step) => step.id === 'work')!; target.status = 'delivering'; delete target.outcome;
      delete (target.changes as Record<string, unknown>).pr_url; delete (target.changes as Record<string, unknown>).prRecordedAt;
      fs.writeFileSync(path.join(dataHome, 'workflows', 'runs', `${done.run}.json`), JSON.stringify(persisted));
      const resumed = call(['workflow', 'resume', done.run]); expect(resumed.status, resumed.stderr).toBe(0);
      expect(fs.readFileSync(`${env.PR_FIXTURE}.creates`, 'utf8')).toBe('create\n');
      git(['remote', 'set-url', 'origin', bare]);
      const generic = call(['workflow', 'start', 'ship-issue', '--driver', 'local', '--auto-approve', '--inputs', '{"issue":43}']);
      expect(generic.status).toBe(1); const genericDone = envelope(generic.stdout).data.done;
      const failed = read(genericDone.run).steps.find((step) => step.id === 'work'); const failedBranch = `teamai/${genericDone.run}/work/p1`;
      expect(failed).toMatchObject({ failure: { code: 'delivery_failed', message: expect.stringContaining(failedBranch) } });
      expect(git(['--git-dir', bare, 'show', `${failedBranch}:issue.txt`])).toBe('43');
      const required = call(['workflow', 'start', 'required', '--driver', 'local', '--auto-approve', '--inputs', '{"issue":44}']);
      expect(required.status).toBe(1); expect(read(envelope(required.stdout).data.done.run).steps[0]).toMatchObject({ failure: { code: 'hitl_required' } });
      expect(fs.readFileSync(`${env.PR_FIXTURE}.creates`, 'utf8')).toBe('create\n');
    } finally { await detached.waitForExit(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
