import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { createLocalToolAdapter, type LocalToolAdapter, type LocalToolRun, type ToolSpawn } from '../workflow/local-tool-adapter.js';
import { localDriver, runLocalDriver } from '../workflow/local-driver.js';
import { pendingRecords, type WorkflowRunRecord } from '../workflow/records.js';
import { readRun } from '../workflow/store.js';

const dirs: string[] = [];

async function fixture(agent?: string): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
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

async function workflowFixture(yaml: string): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
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
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, 'build');
  if ('error' in started) throw new Error(started.error.message);
  return { config, workspace, runId: String(started.data.run) };
}

const toolPaths = {
  claude: { agents: '.claude/agents' },
} as TeamaiConfig['toolPaths'];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('local workflow prompt driver', () => {
  it('runs a prompt with a private result path and stores metadata', async () => {
    const { config, workspace, runId } = await fixture();
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = {
      run: vi.fn(async (_tool, value) => {
        input = value;
        return {
          exitCode: 0,
          output: { ok: true },
          model: 'claude-sonnet',
          session: 'session-1',
          tokens: { input: 3, output: 1 },
        };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(input?.prompt).toBe('Review this project.');
    expect(input?.resultPath.startsWith(`${workspace}${path.sep}`)).toBe(false);
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({
      steps: [{
        status: 'succeeded',
        tool: 'claude',
        model: 'claude-sonnet',
        session: 'session-1',
        tokens: { input: 3, output: 1 },
        outputs: { ok: true },
      }],
    });
  });

  it('fails without a configured tool and does not invoke the adapter', async () => {
    const { config, workspace, runId } = await fixture();
    config.workflows = undefined;
    const adapter: LocalToolAdapter = { run: vi.fn() };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ failure: { code: 'tool_unconfigured' } }],
    });
  });

  it('fails before spawn when a deployed agent is missing', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    const adapter: LocalToolAdapter = { run: vi.fn() };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ failure: { code: 'agent_unavailable', message: expect.stringContaining('teamai pull') } }],
    });
  });

  it('loads a deployed agent and keeps its raw model without aliases', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    config.workflows = { tools: { default: 'opencode', reviewer: 'claude' } };
    const agents = path.join(workspace, '.claude', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'reviewer.md'), `---
name: reviewer
description: Reviews changes.
model: gateway-model
---
Follow the review checklist.
`);
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = {
      run: vi.fn(async (_tool, value) => {
        input = value;
        return { exitCode: 0, output: { ok: true } };
      }),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(adapter.run).toHaveBeenCalledWith('claude', expect.anything());
    expect(input?.agent).toMatchObject({
      name: 'reviewer',
      instructions: 'Follow the review checklist.',
      model: 'gateway-model',
    });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'succeeded', tool: 'claude', model: 'gateway-model' }],
    });
  });

  it('loads a user-scope agent from the home directory pull writes', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-home-'));
    dirs.push(home);
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    config.scope = 'user';
    delete config.projectRoot;
    const agents = path.join(home, '.claude', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'reviewer.md'), `---
name: reviewer
description: Reviews changes.
model: claude-sonnet
---
Follow the review checklist.
`);
    const decoy = path.join(workspace, '.claude', 'agents');
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, 'reviewer.md'), `---
name: reviewer
description: Wrong copy.
model: wrong-model
---
Do not use this copy.
`);
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = {
      run: vi.fn(async (_tool, value) => {
        input = value;
        return { exitCode: 0, output: { ok: true } };
      }),
    };

    try {
      await runLocalDriver(config, runId, workspace, { adapter, toolPaths });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }

    expect(input?.agent).toMatchObject({
      instructions: 'Follow the review checklist.',
      model: 'claude-sonnet',
    });
  });

  it('keeps repository changes and reports read_only_dirty', async () => {
    const { config, workspace, runId } = await fixture();
    const adapter: LocalToolAdapter = {
      run: vi.fn(async () => {
        fs.writeFileSync(path.join(workspace, 'left-behind.txt'), 'inspect me\n');
        return { exitCode: 0, output: { ok: true } };
      }),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(fs.existsSync(path.join(workspace, 'left-behind.txt'))).toBe(true);
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('left-behind.txt') } }],
    });
  });

  it('fails when a prompt step edits a file that was already dirty', async () => {
    const { config, workspace, runId } = await fixture();
    const tracked = path.join(workspace, 'tracked.txt');
    fs.writeFileSync(tracked, 'already dirty\n');
    const adapter: LocalToolAdapter = {
      run: vi.fn(async () => {
        fs.writeFileSync(tracked, 'changed again\n');
        return { exitCode: 0, output: { ok: true } };
      }),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(fs.readFileSync(tracked, 'utf8')).toBe('changed again\n');
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('tracked.txt') } }],
    });
  });

  it.each(['edit', 'add', 'remove'] as const)('detects a file change (%s) inside an existing untracked directory', async (change) => {
    const { config, workspace, runId } = await fixture();
    const directory = path.join(workspace, 'notes');
    fs.mkdirSync(directory);
    const existing = path.join(directory, 'draft.txt');
    fs.writeFileSync(existing, 'before\n');
    fs.writeFileSync(path.join(directory, 'keep.txt'), 'unchanged\n');
    const changed = change === 'add' ? path.join(directory, 'new.txt') : existing;
    const adapter: LocalToolAdapter = {
      run: vi.fn(async () => {
        if (change === 'remove') fs.rmSync(changed);
        else fs.writeFileSync(changed, 'after\n');
        return { exitCode: 0, output: { ok: true } };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining(`notes/${path.basename(changed)}`) } }],
    });
    if (change === 'remove') expect(fs.existsSync(changed)).toBe(false);
    else expect(fs.readFileSync(changed, 'utf8')).toBe('after\n');
  });

  it('allows an unchanged untracked directory', async () => {
    const { config, workspace, runId } = await fixture();
    fs.mkdirSync(path.join(workspace, 'notes'));
    fs.writeFileSync(path.join(workspace, 'notes', 'draft.txt'), 'before\n');
    const adapter: LocalToolAdapter = {
      run: vi.fn(async () => ({ exitCode: 0, output: { ok: true } })),
    };

    expect(await runLocalDriver(config, runId, workspace, { adapter, toolPaths }))
      .toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('detects when a tool removes a path that was dirty before the step', async () => {
    const { config, workspace, runId } = await fixture();
    const dirty = path.join(workspace, 'dirty-before.txt');
    fs.writeFileSync(dirty, 'remove me\n');
    const adapter: LocalToolAdapter = {
      run: vi.fn(async () => {
        fs.rmSync(dirty);
        return { exitCode: 0, output: { ok: true } };
      }),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('dirty-before.txt') } }],
    });
  });

  it.each(['codex-internal', 'tcodex'] as const)('loads a named %s agent with the Codex reader', async (tool) => {
    const { config, workspace, runId } = await fixture('reviewer');
    config.workflows = { tools: { reviewer: tool } };
    const agentsDir = tool === 'tcodex' ? '.tcodex/agents' : '.codex-internal/agents';
    const agents = path.join(workspace, agentsDir);
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'reviewer.toml'), `name = "reviewer"
description = "Reviews changes."
developer_instructions = "Implement the change."
model = "gpt-5.4"
`);
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = {
      run: vi.fn(async (_selected, value) => {
        input = value;
        return { exitCode: 0, output: { ok: true } };
      }),
    };

    await runLocalDriver(config, runId, workspace, {
      adapter,
      toolPaths: { ...toolPaths, [tool]: { agents: agentsDir } } as TeamaiConfig['toolPaths'],
    });

    expect(adapter.run).toHaveBeenCalledWith(tool, expect.anything());
    expect(input?.agent).toMatchObject({
      instructions: 'Implement the change.',
      model: 'gpt-5.4',
    });
  });

  it('warns when codex exec cannot apply the deployed agent settings, and still runs the step', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    config.workflows = { tools: { reviewer: 'codex' } };
    const agents = path.join(workspace, '.codex', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'reviewer.toml'), `name = "reviewer"
description = "Reviews changes."
developer_instructions = "Read only."
sandbox_mode = "read-only"
`);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const adapter: LocalToolAdapter = {
      run: vi.fn(async () => ({ exitCode: 0, output: { ok: true } })),
    };

    await runLocalDriver(config, runId, workspace, {
      adapter,
      toolPaths: { ...toolPaths, codex: { agents: '.codex/agents' } } as TeamaiConfig['toolPaths'],
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sandbox_mode'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not blocked'));
    expect(adapter.run).toHaveBeenCalledWith('codex', expect.anything());
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ status: 'succeeded' }] });
  });

  it('stores a structured child failure', async () => {
    const { config, workspace, runId } = await fixture();
    const adapter: LocalToolAdapter = {
      run: vi.fn(async () => ({
        exitCode: 1,
        failure: { code: 'tool_failed', message: 'claude exited with status 1' },
      })),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'tool_failed' } }],
    });
  });

  it('publishes the failure code it sets when the tool is not on PATH', async () => {
    const { config, workspace, runId } = await fixture();

    await runLocalDriver(config, runId, workspace, { adapter: createLocalToolAdapter(undefined, () => null), toolPaths });

    expect(await endRecord(config)).toMatchObject({ status: 'failed', failure: { code: 'tool_unavailable' } });
  });

  it('publishes no failure code the tool wrote into its result', async () => {
    const { config, workspace, runId } = await fixture();
    const writesFailure: ToolSpawn = (_command, _args, options) => spawn(process.execPath, [
      '-e',
      'require("fs").writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ failure: { code: "secret-x", message: "secret-x happened" } }))',
    ], options);

    await runLocalDriver(config, runId, workspace, { adapter: createLocalToolAdapter(writesFailure, () => process.execPath), toolPaths });

    expect(await readRun(config, runId)).toMatchObject({ steps: [{ status: 'failed', failure: { code: 'secret-x' } }] });
    const record = await endRecord(config);
    expect(record).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(record)).not.toContain('secret-x');
  });
});

/** The end record the run queued; the fixtures have no reports remote, so it stays queued. */
async function endRecord(config: LocalConfig): Promise<WorkflowRunRecord | undefined> {
  return (await pendingRecords(config)).find((record) => record.phase === 'end');
}

const BARRIER = `const fs = require('fs');
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

const LOG = `const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'log.txt');
fs.appendFileSync(file, 'start ' + process.argv[2] + '\\n');
setTimeout(() => fs.appendFileSync(file, 'end ' + process.argv[2] + '\\n'), 100);
`;

const TWO_BARRIERS = `schemaVersion: v1alpha1
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

async function parallelFixture(yaml: string, maxParallel: number): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
  const built = await workflowFixture(yaml);
  built.config.workflows = { tools: { default: 'claude' }, max_parallel: maxParallel };
  fs.writeFileSync(path.join(built.workspace, 'barrier.js'), BARRIER);
  execFileSync('git', ['add', 'barrier.js'], { cwd: built.workspace });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'scripts'], { cwd: built.workspace });
  return built;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exitsWithin(pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; alive(pid); waited += 20) {
    if (waited >= ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

describe('local workflow driver concurrency', () => {
  it('runs two command roots at the same time with max_parallel 2', async () => {
    const { config, workspace, runId } = await parallelFixture(TWO_BARRIERS, 2);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('holds a prompt leased while a command runs, and starts it once the command has exited', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: A command and a prompt with no needs.
steps:
  - id: slow
    needs: []
    command: node -e "setTimeout(() => require('fs').writeFileSync(require('path').join(process.cwd(), '..', 'slow.done'), ''), 300)"
  - id: ask
    needs: []
    prompt: Review this project.
    output:
      ok: boolean
`, 2);
    const commandExitedFirst: boolean[] = [];
    const adapter: LocalToolAdapter = {
      run: vi.fn(async () => {
        commandExitedFirst.push(fs.existsSync(path.join(workspace, '..', 'slow.done')));
        return { exitCode: 0, output: { ok: true } };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(commandExitedFirst).toEqual([true]);
  });

  it('drops a held prompt that an end cancels before it starts, and the run goes on', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: An inline workflow ends while its prompt is held.
steps:
  - id: w
    needs: []
    workflow:
      ends:
        stopped: succeeded
      steps:
        - id: finish
          needs: []
          command: node -e "setTimeout(() => {}, 200)"
          end: stopped
        - id: ask
          needs: []
          prompt: Review this project.
          output:
            ok: boolean
  - id: after
    needs: [w]
    command: node -e "process.exit(0)"
`, 2);
    const adapter: LocalToolAdapter = { run: vi.fn(async () => ({ exitCode: 0, output: { ok: true } })) };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({ id: 'w.ask', status: 'cancelled' }),
        expect.objectContaining({ id: 'after', status: 'succeeded' }),
      ]),
    });
  });

  it('kills a cancelled command that ignores SIGTERM after the grace period, and finishes', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: An end cancels a command that ignores SIGTERM.
ends:
  done: succeeded
steps:
  - id: stubborn
    needs: []
    workspace: new
    command: node stubborn.js
  - id: finish
    needs: []
    workspace: new
    command: node finish.js
    end: done
`, 2);
    const pidFile = path.join(workspace, '..', 'markers', 'stubborn.pid');
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'stubborn.js'), `process.on('SIGTERM', () => {});
require('fs').mkdirSync(${JSON.stringify(path.dirname(pidFile))}, { recursive: true });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
    fs.writeFileSync(path.join(workspace, 'finish.js'), `const timer = setInterval(() => {
  if (require('fs').existsSync(${JSON.stringify(pidFile)})) clearInterval(timer);
}, 20);
`);
    execFileSync('git', ['add', 'stubborn.js', 'finish.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'scripts'], { cwd: workspace });
    let pid: number | undefined;
    try {
      const done = await runLocalDriver(config, runId, workspace);
      pid = Number(fs.readFileSync(path.join(workspace, '..', 'markers', 'stubborn.pid'), 'utf8'));

      expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', end: 'done' } } });
      expect(await exitsWithin(pid, 1000)).toBe(true);
      expect(await readRun(config, runId)).toMatchObject({
        steps: [{ id: 'stubborn', status: 'cancelled' }, { id: 'finish', status: 'succeeded' }],
      });
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('kills a descendant that ignores SIGTERM after the cancelled command itself exited, and finishes', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: An end cancels a command whose child ignores SIGTERM and outlives it.
ends:
  done: succeeded
steps:
  - id: parent
    needs: []
    workspace: new
    command: node parent.js
  - id: finish
    needs: []
    workspace: new
    command: node finish.js
    end: done
`, 2);
    const pidFile = path.join(workspace, '..', 'markers', 'child.pid');
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'parent.js'), `require('child_process').spawn(process.execPath, ['-e', \`process.on('SIGTERM', () => {});
require('fs').mkdirSync(${JSON.stringify(path.dirname(pidFile))}, { recursive: true });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);\`], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`);
    fs.writeFileSync(path.join(workspace, 'finish.js'), `const timer = setInterval(() => {
  if (require('fs').existsSync(${JSON.stringify(pidFile)})) clearInterval(timer);
}, 20);
`);
    execFileSync('git', ['add', 'parent.js', 'finish.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'scripts'], { cwd: workspace });
    let pid: number | undefined;
    try {
      const done = await runLocalDriver(config, runId, workspace);
      pid = Number(fs.readFileSync(path.join(workspace, '..', 'markers', 'child.pid'), 'utf8'));

      expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', end: 'done' } } });
      expect(await exitsWithin(pid, 1000)).toBe(true);
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it.each([
    ['leased with the answer that cancels the command', 2, `  - id: ask
    needs: [w]
`],
    ['held when the command is cancelled', 3, `  - id: ask
    needs: []
`],
  ])('starts a prompt %s only once the command exits in its grace period', async (_case, maxParallel, ask) => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: An end cancels a command that takes a moment to exit, and a prompt waits for it.
steps:
  - id: w
    needs: []
    workflow:
      ends:
        stopped: succeeded
      steps:
        - id: finish
          needs: []
          workspace: new
          command: node finish.js
          end: stopped
        - id: lingering
          needs: []
          command: node lingering.js
${ask}    prompt: Review this project.
    output:
      ok: boolean
`, maxParallel);
    const startedFile = path.join(workspace, '..', 'markers', 'lingering.started');
    const exitedFile = path.join(workspace, '..', 'markers', 'lingering.exited');
    fs.mkdirSync(path.dirname(startedFile), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'lingering.js'), `const fs = require('fs');
process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(exitedFile)}, ''); process.exit(0); }, 300));
fs.mkdirSync(${JSON.stringify(path.dirname(startedFile))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(startedFile)}, '');
setInterval(() => {}, 1000);
`);
    fs.writeFileSync(path.join(workspace, 'finish.js'), `const timer = setInterval(() => {
  if (require('fs').existsSync(${JSON.stringify(startedFile)})) clearInterval(timer);
}, 20);
`);
    execFileSync('git', ['add', 'lingering.js', 'finish.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'scripts'], { cwd: workspace });
    const commandExitedFirst: boolean[] = [];
    const adapter: LocalToolAdapter = {
      run: vi.fn(async () => {
        commandExitedFirst.push(fs.existsSync(path.join(workspace, '..', 'markers', 'lingering.exited')));
        return { exitCode: 0, output: { ok: true } };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(commandExitedFirst).toEqual([true]);
    expect(await readRun(config, runId)).toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({ id: 'w.lingering', status: 'cancelled' }),
        expect.objectContaining({ id: 'ask', status: 'succeeded' }),
      ]),
    });
  });

  it('discards the lease_cancelled answer for a command cancelled while it ran, and finishes', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Another caller with the same identity reaches an end while slow runs.
ends:
  done: succeeded
steps:
  - id: slow
    needs: []
    command: node slow.js
  - id: finish
    needs: []
    command: node -e "process.exit(0)"
    end: done
`, 1);
    fs.writeFileSync(path.join(workspace, 'slow.js'), `const fs = require('fs');
fs.writeFileSync('slow.started', '');
const timer = setInterval(() => { if (fs.existsSync('go')) clearInterval(timer); }, 20);
`);
    const driving = runLocalDriver(config, runId, workspace);
    while (!fs.existsSync(path.join(workspace, 'slow.started'))) await new Promise((resolve) => setTimeout(resolve, 20));
    const run = await readRun(config, runId);
    const slow = typeof run === 'object' ? run.steps.find((step) => step.id === 'slow') : undefined;
    if (slow?.status !== 'leased') throw new Error('slow is not leased');
    const same = localDriver(workspace);
    const leased = await leaseNext(config, runId, same, { running: [slow.attempt] });
    const finish = 'data' in leased ? leased.data.lease as { attempt: string; revision: number } : undefined;
    if (!finish) throw new Error('finish was not leased');
    await reportAttempt(config, runId, { attempt: finish.attempt, revision: finish.revision, outcome: 'success', driver: same });
    expect(await leaseNext(config, runId, same, { running: [slow.attempt], canTakeLease: false })).toMatchObject({
      data: { cancelled: [slow.attempt] },
    });
    fs.writeFileSync(path.join(workspace, 'go'), '');

    expect(await driving).toMatchObject({ data: { done: { outcome: 'succeeded', end: 'done' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'slow', status: 'cancelled' }, { id: 'finish', status: 'succeeded' }] });
  });

  it.skipIf(process.platform === 'win32').each([
    [1, 'the driver\'s process group', true],
    [2, 'a process group of its own', false],
  ] as const)('runs a command with max_parallel %i in %s', async (maxParallel, _group, shared) => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Report the process group a command runs in.
steps:
  - id: group
    command: node pgid.js
    output:
      pgid: number
`, maxParallel);
    fs.writeFileSync(path.join(workspace, 'pgid.js'), `const pgid = require('child_process').execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]);
process.stdout.write(JSON.stringify({ pgid: Number(String(pgid).trim()) }));
`);
    const driverGroup = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    const outputs = typeof run === 'object' && run.steps[0]?.status === 'succeeded' ? run.steps[0].outputs as { pgid: number } : undefined;
    expect(outputs?.pgid).toEqual(expect.any(Number));
    expect(outputs?.pgid === driverGroup).toBe(shared);
  });

  it('gets the leases of an earlier driver back one at a time, and runs them one at a time with max_parallel 1', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Two roots an earlier driver leased and never reported.
steps:
  - id: a
    needs: []
    command: node log.js a
  - id: b
    needs: []
    command: node log.js b
`, 1);
    fs.writeFileSync(path.join(workspace, 'log.js'), LOG);
    const earlier = localDriver(workspace);
    const a = await leaseNext(config, runId, earlier);
    const attempt = 'data' in a ? (a.data.lease as { attempt: string }).attempt : '';
    expect(await leaseNext(config, runId, earlier, { running: [attempt] })).toMatchObject({ data: { lease: { step: 'b' } } });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(path.join(workspace, '..', 'log.txt'), 'utf8')).toBe('start a\nend a\nstart b\nend b\n');
  });

  it('runs a prompt an earlier driver leased alone, between the commands leased before and after it', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: A command, a prompt and a command an earlier driver leased.
steps:
  - id: c1
    needs: []
    command: node log.js c1
  - id: ask
    needs: []
    prompt: Review this project.
    output:
      ok: boolean
  - id: c2
    needs: []
    command: node log.js c2
`, 2);
    fs.writeFileSync(path.join(workspace, 'log.js'), LOG);
    const earlier = localDriver(workspace);
    const running: string[] = [];
    for (const step of ['c1', 'ask', 'c2']) {
      const leased = await leaseNext(config, runId, earlier, { running });
      expect(leased).toMatchObject({ data: { lease: { step } } });
      if ('data' in leased) running.push((leased.data.lease as { attempt: string }).attempt);
    }
    const logAtPrompt: string[] = [];
    const adapter: LocalToolAdapter = {
      run: vi.fn(async () => {
        logAtPrompt.push(fs.readFileSync(path.join(workspace, '..', 'log.txt'), 'utf8'));
        return { exitCode: 0, output: { ok: true } };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(logAtPrompt).toEqual(['start c1\nend c1\n']);
    expect(fs.readFileSync(path.join(workspace, '..', 'log.txt'), 'utf8')).toBe('start c1\nend c1\nstart c2\nend c2\n');
  });

  it('runs one command at a time with max_parallel 1, so the barrier fails', async () => {
    const { config, workspace, runId } = await parallelFixture(TWO_BARRIERS, 1);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ id: 'left', status: 'failed', exitCode: 1 }, { id: 'right', status: 'succeeded' }],
    });
  });
});
