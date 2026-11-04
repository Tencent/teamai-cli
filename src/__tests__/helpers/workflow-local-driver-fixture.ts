import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { getDataHome, getUserConfigPath, type LocalConfig, type TeamaiConfig } from '../../types.js';
import { syncScorersThenWorkflows } from '../../scorers/team-sync.js';
import { startRun } from '../../workflow/engine.js';
import { pendingRecords, type WorkflowRunRecord } from '../../workflow/records.js';
import { knownSecrets } from '../../env-resolution.js';

/** A step command that appends a learning to its attempt's outcome file, in the data home beside the checkout it runs in. */
export const APPEND_LEARNING = `node -e "const [r,a]=process.env.TEAMAI_WORKFLOW_ATTEMPT.split('/');const p=require('path');const d=p.join('..','data','workflows','runs',r,'outcomes');require('fs').mkdirSync(d,{recursive:true});require('fs').appendFileSync(p.join(d,a+'.jsonl'),JSON.stringify({kind:'learning',id:'retry-backoff'})+'\\n')"`;

export const dirs: string[] = [];

/** Sets `ai.tool` in the member's ~/.teamai/config.yaml, removed when the test ends. */
export function memberAiTool(tool: string): void {
  const file = getUserConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The file a member writes by hand on a machine with no user-scope install.
  fs.writeFileSync(file, `ai:\n  tool: ${tool}\n`);
  onTestFinished(() => { fs.rmSync(file, { force: true }); });
}

/** Sets `ai.tool` in `config`'s own scope, as a load of its config file reads it, and returns that file. */
export function projectAiTool(config: LocalConfig, tool: string): string {
  config.ai = { tool };
  return path.join(getDataHome(config), 'config.yaml');
}

export async function fixture(agent?: string): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
  return workflowFixture(`schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt: Review this project.
${agent ? `    agent: ${agent}\n` : ''}    output:
      ok: boolean
`);
}

export async function workflowFixture(yaml: string): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-driver-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(workspace);
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'clean\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: workspace });
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: workspace,
    dataHome: path.join(root, 'data'),
    workflows: { tools: { default: 'claude' } },
  };
  fs.writeFileSync(path.join(knowledge, 'workflows', 'build.yaml'), yaml);
  await syncScorersThenWorkflows(config);
  const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  return { config, workspace, runId: String(started.data.run) };
}

export const toolPaths = {
  claude: { agents: '.claude/agents' },
} as TeamaiConfig['toolPaths'];

/** The end record the run queued; the fixtures have no reports remote, so it stays queued. */
export async function endRecord(config: LocalConfig): Promise<WorkflowRunRecord | undefined> {
  return (await pendingRecords(config)).find((record) => record.phase === 'end');
}

export const BARRIER = `const fs = require('fs');
const path = require('path');
const [me, other] = process.argv.slice(2);
const dir = path.join(__dirname, '..', 'markers');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, me + '.ready'), '');
const deadline = Date.now() + 2000;
setInterval(() => {
  if (fs.existsSync(path.join(dir, other + '.ready'))) process.exit(0);
  if (Date.now() > deadline) process.exit(1);
}, 20);
`;

export const LOG = `const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'log.txt');
fs.appendFileSync(file, 'start ' + process.argv[2] + '\\n');
setTimeout(() => fs.appendFileSync(file, 'end ' + process.argv[2] + '\\n'), 100);
`;

export const TWO_BARRIERS = `schemaVersion: v1alpha1
name: build
description: Two roots that each wait for the other.
steps:
  - id: left
    needs: []
    workspace: new
    command: node barrier.js left right
  - id: right
    needs: []
    workspace: new
    command: node barrier.js right left
`;

export async function parallelFixture(yaml: string, maxParallel: number): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
  const built = await workflowFixture(yaml);
  built.config.workflows = { tools: { default: 'claude' }, max_parallel: maxParallel };
  fs.writeFileSync(path.join(built.workspace, 'barrier.js'), BARRIER);
  execFileSync('git', ['add', 'barrier.js'], { cwd: built.workspace });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'scripts'], { cwd: built.workspace });
  return built;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function exitsWithin(pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; alive(pid); waited += 20) {
    if (waited >= ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}
