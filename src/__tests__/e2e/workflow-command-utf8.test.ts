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
const text = '检查完成 café 😀';
let sandbox: string;
afterEach(() => { if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true }); });

it.each([0, 1])('preserves split command UTF-8 through the real CLI (exit %i)', async (exitCode) => {
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-command-utf8-cli-')));
  const repo = path.join(sandbox, 'app');
  const team = path.join(sandbox, 'team');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(team, 'workflows'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git');
  fs.writeFileSync(path.join(repo, 'emit.cjs'), `
const fs = require('node:fs');
const bytes = Buffer.from(${JSON.stringify(exitCode === 0 ? JSON.stringify({ summary: text }) : text)});
const split = bytes.indexOf(Buffer.from('检')) + 1;
fs.writeSync(${exitCode === 0 ? 1 : 2}, bytes.subarray(0, split));
setTimeout(() => {
  fs.writeSync(${exitCode === 0 ? 1 : 2}, bytes.subarray(split));
  process.exitCode = ${exitCode};
}, 150);
`);
  fs.writeFileSync(path.join(repo, 'consume.cjs'), 'process.stdout.write(JSON.stringify({ seen: process.env.SUMMARY }));\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@teamai.test', 'commit', '-qm', 'fixture');

  const dataHome = await resolveProjectDataHome(repo);
  const config: LocalConfig = {
    repo: { localPath: team, remote: 'http://127.0.0.1:9/team/workflow.git', kind: 'git' },
    username: 'tester', scope: 'project', projectRoot: repo, dataHome, updatePolicy: 'skip', additionalRoles: [],
  };
  fs.mkdirSync(dataHome, { recursive: true });
  fs.writeFileSync(path.join(dataHome, 'config.yaml'), YAML.stringify(config));
  fs.writeFileSync(path.join(team, 'teamai.yaml'), YAML.stringify({
    team: 'command-unicode', repo: config.repo.remote, provider: 'git', usageReport: false,
  }));
  fs.writeFileSync(path.join(team, 'workflows', 'unicode.yaml'), `schemaVersion: v1alpha1
name: unicode
description: Pass command output to the next step.
steps:
  - id: emit
    command: node emit.cjs
    output: { summary: string }
  - id: consume
    needs: [emit]
    command: node consume.cjs
    env:
      SUMMARY: "{{ steps.emit.outputs.summary }}"
    output: { seen: string }
`);
  await syncWorkflowDefinitions(config);
  const result = spawnSync(process.execPath, [cli, 'workflow', 'start', 'unicode', '--driver', 'local'], {
    cwd: repo, env: { ...process.env, FORCE_COLOR: '0' }, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(exitCode);
  const envelope = JSON.parse(result.stdout.trim().split('\n').filter((line) => line.startsWith('{')).at(-1)!);
  expect(envelope, result.stderr).toMatchObject({ data: { done: { outcome: exitCode === 0 ? 'succeeded' : 'failed' } } });
  const runId = envelope.data.done.run as string;
  const runsDir = path.join(dataHome, 'workflows', 'runs');
  const stored = JSON.parse(fs.readFileSync(path.join(runsDir, `${runId}.json`), 'utf8')) as RunState;
  if (exitCode === 0) {
    expect(stored.steps).toMatchObject([
      { status: 'succeeded', outputs: { summary: text } },
      { status: 'succeeded', outputs: { seen: text } },
    ]);
    const attempts = path.join(runsDir, runId, 'attempts');
    const results = fs.readdirSync(attempts).map((attempt) => JSON.parse(fs.readFileSync(path.join(attempts, attempt, 'result.json'), 'utf8')));
    expect(results).toContainEqual({ output: { summary: text } });
    expect(results).toContainEqual({ output: { seen: text } });
  } else {
    expect(stored.steps[0]).toMatchObject({ status: 'failed', message: `command exited with status 1: ${text}` });
  }
}, 60_000);
