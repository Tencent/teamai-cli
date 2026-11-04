/**
 * Real CLI: a prompt step confined to a directory an earlier step wrote under `$TEAMAI_RUN_DIR` runs, under the local
 * driver, on a Claude whose confined profile is verified, with that directory as its working directory, none of the
 * team's secrets, and no session teamai keeps.
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

const TEAM_TOKEN = 'fixture-confined-team-token-1670';

const DoneSchema = z.object({ data: z.object({ done: z.object({ run: z.string(), outcome: z.string() }) }) });
const InvocationSchema = z.object({ args: z.array(z.string()), cwd: z.string(), env: z.record(z.string(), z.string()) });
const RunSchema = z.object({ steps: z.array(z.looseObject({ id: z.string() })) });

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '.git' ? [] : filesUnder(full);
    return entry.isFile() ? [full] : [];
  });
}

describe('a prompt step confined to a directory (real CLI, local driver)', () => {
  let root: string;
  let home: string;
  let repo: string;
  let invocation: string;
  let env: NodeJS.ProcessEnv;

  function teamai(...args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function git(...args: string[]): void {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-confined-')));
    home = path.join(root, 'home');
    repo = path.join(root, 'repo');
    const bin = path.join(root, 'bin');
    invocation = path.join(root, 'invocation.json');
    for (const dir of [home, repo, bin]) fs.mkdirSync(dir);
    // A Claude whose version has a verified confined profile, which records how it was started and answers the verdict.
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
fs.writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fixture', session_id: 'confined-session' }));
console.log(JSON.stringify({ type: 'result', session_id: 'confined-session', structured_output: { verdict: 'pass' }, usage: { input_tokens: 12, output_tokens: 3 } }));
`, { mode: 0o755 });
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      FORCE_COLOR: '0',
      WORKFLOW_CONFINED_TOKEN: TEAM_TOKEN,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    delete env.CLAUDE_CONFIG_DIR;
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    git('remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git');
    const initialized = teamai('init', '--self', '--agent', 'claude', '--force');
    expect(initialized.status, initialized.stderr + initialized.stdout).toBe(0);
    fs.mkdirSync(path.join(repo, '.teamai', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.teamai', 'env'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.teamai', 'env', 'secrets.yaml'), 'secrets:\n  - key: WORKFLOW_CONFINED_TOKEN\n');
    fs.writeFileSync(path.join(repo, '.teamai', 'workflows', 'judged.yaml'), `schemaVersion: v1alpha1
name: judged
description: Judge a change from the evidence an earlier step wrote.
steps:
  - id: evidence
    requires: { env: [WORKFLOW_CONFINED_TOKEN] }
    command: |
      node -e "const p=require('path'),fs=require('fs'),d=p.join(process.env.TEAMAI_RUN_DIR,'evidence');fs.mkdirSync(d);fs.writeFileSync(p.join(d,'confined.json'),JSON.stringify({level:'verified'}));fs.writeFileSync(p.join(d,'diff.txt'),'retries 3')"
  - id: judge
    needs: [evidence]
    workspace: { confined: evidence }
    prompt: Judge the change in diff.txt.
    output:
      verdict: pass | fail
`);
    const pulled = teamai('pull');
    expect(pulled.status, pulled.stderr + pulled.stdout).toBe(0);
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs it in the directory with no team secret, and keeps no session of it', () => {
    const started = teamai('workflow', 'start', 'judged', '--driver', 'local');
    expect(started.status, started.stderr + started.stdout).toBe(0);
    const line = started.stdout.trim().split('\n').findLast((item) => item.startsWith('{')) ?? '';
    const { run, outcome } = DoneSchema.parse(JSON.parse(line)).data.done;
    expect(outcome).toBe('succeeded');

    const runFile = filesUnder(home).find((file) => file.endsWith(path.join('workflows', 'runs', `${run}.json`)) && !file.includes('reports-wt'));
    if (!runFile) throw new Error(`no run file for ${run}`);
    const judge = RunSchema.parse(JSON.parse(fs.readFileSync(runFile, 'utf8'))).steps.find((step) => step.id === 'judge');
    expect(judge).toMatchObject({ status: 'succeeded', tool: 'claude', outputs: { verdict: 'pass' }, confined: { tool: 'claude', isolation: 'verified', access: 'read' } });
    expect(judge).not.toHaveProperty('session');

    const ran = InvocationSchema.parse(JSON.parse(fs.readFileSync(invocation, 'utf8')));
    expect(ran.cwd).toBe(path.join(path.dirname(runFile), run, 'scratch', 'evidence'));
    expect(Object.keys(ran.env)).not.toContain('WORKFLOW_CONFINED_TOKEN');
    expect(Object.values(ran.env)).not.toContain(TEAM_TOKEN);
    expect(ran.args).toContain('--no-session-persistence');
    expect(ran.env.TEAMAI_LAUNCHED_BY).toBeDefined();
  });
});
