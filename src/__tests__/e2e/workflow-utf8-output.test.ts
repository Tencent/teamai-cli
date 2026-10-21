import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import YAML from 'yaml';
import { resolveProjectDataHome } from '../../config.js';
import type { LocalConfig } from '../../types.js';
import { syncWorkflowDefinitions } from '../../workflow/cache.js';
import type { RunState } from '../../workflow/types.js';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
let sandbox: string;
afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

it('keeps split UTF-8 Agent stdout in the real CLI workflow state and result file', async () => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-utf8-')));
  const repo = path.join(sandbox, 'app');
  const bin = path.join(sandbox, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('init', '-q', '-b', 'main');
  git('add', 'README.md');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  git('remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git');
  const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: repo, env: { ...env, FORCE_COLOR: '0' }, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return result.stdout;
  };
  const dataHome = await resolveProjectDataHome(repo);
  const team = path.join(sandbox, 'team');
  const config: LocalConfig = {
    repo: { localPath: team, remote: 'http://127.0.0.1:9/team/workflow.git', kind: 'git' },
    username: 'tester', scope: 'project', projectRoot: repo, dataHome, updatePolicy: 'skip', additionalRoles: [],
  };
  fs.mkdirSync(dataHome, { recursive: true });
  fs.writeFileSync(path.join(dataHome, 'config.yaml'), YAML.stringify(config));
  const workflows = path.join(team, 'workflows');
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(path.join(team, 'teamai.yaml'), YAML.stringify({
    team: 'unicode-test', repo: config.repo.remote, provider: 'git', usageReport: false,
  }));
  fs.writeFileSync(path.join(workflows, 'unicode.yaml'), `schemaVersion: v1alpha1
name: unicode
description: Preserve a streamed result.
steps:
  - id: review
    prompt: Review without editing the repository.
    output:
      summary: string
`);
  await syncWorkflowDefinitions(config);

  const output = { summary: '检查完成 café 😀' };
  const fake = path.join(bin, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const bytes = Buffer.from(JSON.stringify({ type: 'result', result: JSON.stringify(${JSON.stringify(output)}) }));
const split = bytes.indexOf(Buffer.from('检')) + 1;
fs.writeSync(1, bytes.subarray(0, split));
setTimeout(() => fs.writeSync(1, bytes.subarray(split)), 150);
`);
  fs.chmodSync(fake, 0o755);
  if (process.platform === 'win32') {
    fs.copyFileSync(fake, `${fake}.cjs`);
    fs.writeFileSync(`${fake}.cmd`, `@echo off\r\n"${process.execPath}" "${fake}.cjs" %*\r\n`);
  }
  const stdout = run(['workflow', 'start', 'unicode', '--driver', 'local', '--tools', 'default=claude'], {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  });
  const envelope = JSON.parse(stdout.trim().split('\n').filter((line) => line.startsWith('{')).at(-1)!);
  expect(envelope).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  const runId = envelope.data.done.run as string;
  const runDir = path.join(dataHome, 'workflows', 'runs');
  const stored = JSON.parse(fs.readFileSync(path.join(runDir, `${runId}.json`), 'utf8')) as RunState;
  expect(stored.steps[0]).toMatchObject({ status: 'succeeded', outputs: output });
  const attempts = path.join(runDir, runId, 'attempts');
  const attempt = fs.readdirSync(attempts)[0]!;
  expect(JSON.parse(fs.readFileSync(path.join(attempts, attempt, 'result.json'), 'utf8'))).toEqual({ output });
}, 60_000);
