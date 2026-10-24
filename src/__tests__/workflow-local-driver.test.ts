import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as envExec from '../env-exec.js';
import { loadStateForScope, saveStateForScope } from '../config.js';
import { checkoutRecordKey, type CheckoutRecord } from '../pull.js';
import { getAdapter } from '../session-flow/adapters/index.js';
import { AgentSession } from '../session-flow/agent-session.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import type { Session } from '../session-flow/ir.js';
import { SyncManager, defaultSyncMeta, getRepoIdentity } from '../session-flow/sync.js';
import { getDataHome, getReportsDir, type LocalConfig, type TeamaiConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { cancelRun, respondToHitl, retryStep } from '../workflow/run-controls.js';
import { createLocalToolAdapter, type LocalToolAdapter, type LocalToolResult, type LocalToolRun, type ToolSpawn } from '../workflow/local-tool-adapter.js';
import { _setDriverPollMs, localDriver, runLocalDriver } from '../workflow/local-driver.js';
import { pendingRecords, type WorkflowRunRecord } from '../workflow/records.js';
import { driverLockPath, readRun } from '../workflow/store.js';
import * as worktreeSnapshot from '../workflow/worktree-snapshot.js';
import type { DriverIdentity } from '../workflow/types.js';
import { commitFile, fakeClaude, git, recordDelivery } from './helpers/delivered-checkout.js';
import { knownSecrets } from '../env-resolution.js';

_setDriverPollMs(20);

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
  const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
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
      runInteractive: vi.fn(),
      run: vi.fn(async (_tool, value) => {
        input = value;
        return {
          started: true as const,
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
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn() };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ failure: { code: 'tool_unconfigured' } }],
    });
  });

  it('fails before spawn when a deployed agent is missing', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn() };

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
      runInteractive: vi.fn(),
      run: vi.fn(async (_tool, value) => {
        input = value;
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(adapter.run).toHaveBeenCalledWith('claude', expect.anything(), expect.any(AbortSignal));
    expect(input?.agent).toMatchObject({
      name: 'reviewer',
      instructions: 'Follow the review checklist.',
      model: 'gateway-model',
    });
    // The file's model is what the launch asked for, not what the tool reported (#1176).
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ steps: [{ status: 'succeeded', tool: 'claude' }] });
    expect(typeof stored === 'object' && stored.steps[0]).toEqual(expect.not.objectContaining({ model: expect.anything() }));
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
      runInteractive: vi.fn(),
      run: vi.fn(async (_tool, value) => {
        input = value;
        return { started: true as const, exitCode: 0, output: { ok: true } };
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
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        fs.writeFileSync(path.join(workspace, 'left-behind.txt'), 'inspect me\n');
        return { started: true as const, exitCode: 0, output: { ok: true } };
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
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        fs.writeFileSync(tracked, 'changed again\n');
        return { started: true as const, exitCode: 0, output: { ok: true } };
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
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        if (change === 'remove') fs.rmSync(changed);
        else fs.writeFileSync(changed, 'after\n');
        return { started: true as const, exitCode: 0, output: { ok: true } };
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
      runInteractive: vi.fn(),
      run: vi.fn(async () => ({ started: true as const, exitCode: 0, output: { ok: true } })),
    };

    expect(await runLocalDriver(config, runId, workspace, { adapter, toolPaths }))
      .toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('detects when a tool removes a path that was dirty before the step', async () => {
    const { config, workspace, runId } = await fixture();
    const dirty = path.join(workspace, 'dirty-before.txt');
    fs.writeFileSync(dirty, 'remove me\n');
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        fs.rmSync(dirty);
        return { started: true as const, exitCode: 0, output: { ok: true } };
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
      runInteractive: vi.fn(),
      run: vi.fn(async (_selected, value) => {
        input = value;
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    await runLocalDriver(config, runId, workspace, {
      adapter,
      toolPaths: { ...toolPaths, [tool]: { agents: agentsDir } } as TeamaiConfig['toolPaths'],
    });

    expect(adapter.run).toHaveBeenCalledWith(tool, expect.anything(), expect.any(AbortSignal));
    expect(input?.agent).toMatchObject({
      instructions: 'Implement the change.',
      model: 'gpt-5.4',
    });
  });

  it('loads a user-scope OpenCode agent from the home XDG_CONFIG_HOME moves', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    const xdg = path.join(path.dirname(workspace), 'xdg');
    vi.stubEnv('HOME', path.join(path.dirname(workspace), 'home'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    fs.mkdirSync(path.join(xdg, 'opencode', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'opencode', 'agents', 'reviewer.md'), '---\ndescription: Reviews changes.\nmode: subagent\n---\n\nReview the change.\n');
    const userConfig: LocalConfig = { ...config, scope: 'user', workflows: { tools: { reviewer: 'opencode' } } };
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_selected, value) => {
        input = value;
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    try {
      await runLocalDriver(userConfig, runId, workspace, {
        adapter,
        toolPaths: { opencode: { agents: '.opencode/agents', userScope: { agents: '.config/opencode/agents' } } } as TeamaiConfig['toolPaths'],
      });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(await readRun(userConfig, runId)).toMatchObject({ steps: [{ status: 'succeeded' }] });
    expect(input?.agent).toMatchObject({ instructions: 'Review the change.' });
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
      runInteractive: vi.fn(),
      run: vi.fn(async () => ({ started: true as const, exitCode: 0, output: { ok: true } })),
    };

    await runLocalDriver(config, runId, workspace, {
      adapter,
      toolPaths: { ...toolPaths, codex: { agents: '.codex/agents' } } as TeamaiConfig['toolPaths'],
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sandbox_mode'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not blocked'));
    expect(adapter.run).toHaveBeenCalledWith('codex', expect.anything(), expect.any(AbortSignal));
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ status: 'succeeded' }] });
  });

  it('stores a structured child failure', async () => {
    const { config, workspace, runId } = await fixture();
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => ({
        started: true as const,
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

describe('the agent a local pass ran as (#1176)', () => {
  const restore: Array<() => void> = [];
  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  type Observed = Awaited<ReturnType<typeof workflowFixture>> & { rev: string; skill: string; agentFile: string };

  /** The reviewer agent as pull deploys it for each tool, and the model it resolved to. */
  const reviewer = {
    claude: {
      file: '.claude/agents/reviewer.md',
      content: '---\nname: reviewer\ndescription: Reviews changes.\nmodel: claude-opus-4-1\n---\nFollow the review checklist.\n',
      model: 'claude-opus-4-1',
    },
    codex: {
      file: '.codex/agents/reviewer.toml',
      content: 'name = "reviewer"\ndescription = "Reviews changes."\ndeveloper_instructions = "Follow the review checklist."\nmodel = "gpt-5.4"\n',
      model: 'gpt-5.4',
    },
    opencode: {
      file: '.opencode/agents/reviewer.md',
      content: '---\ndescription: Reviews changes.\nmode: subagent\nmodel: anthropic/claude-sonnet-4-5\nvariant: high\n---\nFollow the review checklist.\n',
      model: 'anthropic/claude-sonnet-4-5',
    },
  } as const;

  /**
   * A run whose checkout a pull of the team clone's head delivered a skill and the reviewer agent into, with a fake
   * `claude --version` on PATH. `record` overrides fields of that pull's record.
   */
  async function observed(yaml: string, { tool = 'claude', record = {} }: { tool?: keyof typeof reviewer; record?: Partial<CheckoutRecord> } = {}): Promise<Observed> {
    const fixture = await workflowFixture(yaml);
    const team = fixture.config.repo.localPath;
    git(team, 'init', '-q');
    const rev = commitFile(team, 'agents/reviewer.yaml');
    const skill = path.join(fixture.workspace, '.claude', 'skills', 'review', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, 'Review carefully.\n');
    const agentFile = path.join(fixture.workspace, reviewer[tool].file);
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, reviewer[tool].content);
    fixture.config.workflows = { tools: { default: tool } };
    await recordDelivery(fixture.config, {
      rev: rev.slice(0, 7),
      targets: [tool],
      files: [skill, agentFile],
      agentModels: { reviewer: { [tool]: { step: 'spec', model: reviewer[tool].model } } },
      ...record,
    });
    restore.push(fakeClaude(path.dirname(fixture.workspace), '2.1.301'));
    return { ...fixture, rev, skill, agentFile };
  }

  const reviewStep = (agent?: string) => `schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt: Review this project.
${agent ? `    agent: ${agent}\n` : ''}`;

  const reports = (result: Partial<Extract<LocalToolResult, { started: true }>> = {}): LocalToolAdapter => ({
    runInteractive: vi.fn(),
    run: vi.fn(async () => ({ started: true as const, exitCode: 0, ...result })),
  });
  const codexToolPaths = { codex: { agents: '.codex/agents' } } as TeamaiConfig['toolPaths'];

  async function entry(config: LocalConfig): Promise<NonNullable<WorkflowRunRecord['steps']>[number] | undefined> {
    return (await endRecord(config))?.steps?.[0];
  }

  it('publishes the definition, tool version, team commit and requested model of a Claude pass', async () => {
    const { config, workspace, runId, rev } = await observed(reviewStep('reviewer'));

    await runLocalDriver(config, runId, workspace, { adapter: reports({ model: 'claude-opus-4-1-20250805', applied: 'main' }), toolPaths });

    expect(await entry(config)).toMatchObject({
      tool: 'claude',
      model: 'claude-opus-4-1-20250805',
      agent: {
        v: 1,
        definition: { name: 'reviewer', applied: 'main' },
        tool: { name: 'claude', version: '2.1.301' },
        model: { requested: 'claude-opus-4-1', reported: 'claude-opus-4-1-20250805' },
        team: { revision: rev, localChanges: false },
        project: { commit: git(workspace, 'rev-parse', 'HEAD'), dirty: false },
        driver: 'local',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  describe('the team skills a pass used', () => {
    const SESSION = 'b0d5e000-0000-4000-8000-0000000000d1';
    const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
    const skillCall = (uuid: string, skill: string, sidechain = false, timestamp = new Date().toISOString()): string => line({
      type: 'assistant', uuid, parentUuid: 'u1', sessionId: SESSION, timestamp, ...(sidechain ? { isSidechain: true } : {}),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${uuid}`, name: 'Skill', input: { skill } }] },
    });

    /**
     * A Claude pass that runs `during`, then writes a session whose main thread loads `main` and whose subagent loads
     * `subagent` through the skill tool, after a pass before it that loaded `earlier` when the pass resumes one.
     */
    const loading = (workspace: string, { main, subagent, earlier }: { main: string; subagent: string; earlier?: string }, during = () => {}): LocalToolAdapter => ({
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        during();
        const project = path.join(os.homedir(), '.claude', 'projects', encodeCwdClaude(workspace));
        const subagents = path.join(project, SESSION, 'subagents');
        fs.mkdirSync(subagents, { recursive: true });
        const before = new Date(Date.now() - 3_600_000).toISOString();
        fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), (earlier ? skillCall('m0', earlier, false, before) : '') + line({
          type: 'user', uuid: 'u1', parentUuid: null, cwd: workspace, sessionId: SESSION, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Review this project.' },
        }) + skillCall('m1', main));
        fs.writeFileSync(path.join(subagents, 'agent-a.meta.json'), JSON.stringify({ toolUseId: 'toolu_m1', spawnDepth: 1 }));
        fs.writeFileSync(path.join(subagents, 'agent-a.jsonl'), skillCall('s1', subagent, true));
        return { started: true as const, exitCode: 0, session: SESSION };
      }),
    });

    async function usedOf(config: LocalConfig, runId: string): Promise<unknown> {
      const run = await readRun(config, runId);
      if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
      const [step] = run.steps;
      return step && 'used' in step ? step.used : 'absent';
    }

    it('records a team skill its subagent loaded that the checkout held as delivered at launch, and not the member\'s own skill', async () => {
      const { config, workspace, runId } = await observed(reviewStep());
      commitFile(config.repo.localPath, 'skills/review/SKILL.md');
      fs.mkdirSync(path.join(workspace, '.claude', 'skills', 'mine'), { recursive: true });
      fs.writeFileSync(path.join(workspace, '.claude', 'skills', 'mine', 'SKILL.md'), 'Mine.\n');

      await runLocalDriver(config, runId, workspace, { adapter: loading(workspace, { main: 'mine', subagent: 'review' }), toolPaths });

      expect(await usedOf(config, runId)).toEqual({ skills: ['review'] });
    });

    it('still records a team skill that a pull removed while the pass ran', async () => {
      const { config, workspace, runId, skill } = await observed(reviewStep());
      commitFile(config.repo.localPath, 'skills/review/SKILL.md');
      const pulled = () => {
        fs.rmSync(path.join(config.repo.localPath, 'skills'), { recursive: true });
        fs.rmSync(path.dirname(skill), { recursive: true });
      };

      await runLocalDriver(config, runId, workspace, { adapter: loading(workspace, { main: 'review', subagent: 'review' }, pulled), toolPaths });

      expect(await usedOf(config, runId)).toEqual({ skills: ['review'] });
    });

    it('records no skill whose copy in the checkout is not the one teamai delivered, though the team has one of its name', async () => {
      const { config, workspace, runId, skill } = await observed(reviewStep());
      commitFile(config.repo.localPath, 'skills/review/SKILL.md');
      fs.writeFileSync(skill, 'Review my way.\n');

      await runLocalDriver(config, runId, workspace, { adapter: loading(workspace, { main: 'review', subagent: 'review' }), toolPaths });

      expect(await usedOf(config, runId)).toEqual({ skills: [] });
    });

    it('records no skill that only a pass before it loaded in the session this pass resumes', async () => {
      const { config, workspace, runId } = await observed(reviewStep());
      commitFile(config.repo.localPath, 'skills/review/SKILL.md');

      await runLocalDriver(config, runId, workspace, { adapter: loading(workspace, { main: 'mine', subagent: 'mine', earlier: 'review' }), toolPaths });

      expect(await usedOf(config, runId)).toEqual({ skills: [] });
    });

    it('records nothing for a checkout no pull delivered to', async () => {
      const { config, workspace, runId } = await workflowFixture(reviewStep());
      fs.mkdirSync(path.join(config.repo.localPath, 'skills', 'review'), { recursive: true });
      fs.writeFileSync(path.join(config.repo.localPath, 'skills', 'review', 'SKILL.md'), 'Review carefully.\n');

      await runLocalDriver(config, runId, workspace, { adapter: loading(workspace, { main: 'review', subagent: 'review' }), toolPaths });

      expect(await usedOf(config, runId)).toBe('absent');
    });
  });

  it('launches the tool bound to its checkout, so its session-start hook keeps the delivery', async () => {
    const { config, workspace, runId } = await observed(reviewStep('reviewer'));
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async (_tool, value) => {
      input = value;
      return { started: true as const, exitCode: 0 };
    }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(input?.launch).toEqual({ by: 'workflow', tool: 'claude', checkout: await checkoutRecordKey(config) });
  });

  it('publishes the --model a Codex launch passed as the requested model', async () => {
    const { config, workspace, runId } = await observed(reviewStep('reviewer'), { tool: 'codex' });
    let argv: string[] = [];
    const codex: ToolSpawn = (_command, args, options) => {
      argv = args;
      return spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, "{}")'], options);
    };

    await runLocalDriver(config, runId, workspace, { adapter: createLocalToolAdapter(codex, () => process.execPath), toolPaths: codexToolPaths });

    expect(argv).toEqual(expect.arrayContaining(['--model', 'gpt-5.4']));
    expect((await entry(config))?.agent).toMatchObject({
      definition: { name: 'reviewer', applied: 'prompt' },
      tool: { name: 'codex' },
      model: { requested: argv[argv.indexOf('--model') + 1] },
    });
  });

  it('publishes an OpenCode pass with the handoff its launch used and the model and variant of its file it passed', async () => {
    const opencodeToolPaths = { opencode: { agents: '.opencode/agents' } } as TeamaiConfig['toolPaths'];
    const agentModels = { reviewer: { opencode: { step: 'alias', model: 'anthropic/claude-sonnet-4-5', alias: 'smart' } } };
    const viaPrompt = await observed(reviewStep('reviewer'), { tool: 'opencode', record: { agentModels } });
    const viaAgent = await observed(reviewStep('reviewer'), { tool: 'opencode', record: { agentModels } });

    await runLocalDriver(viaPrompt.config, viaPrompt.runId, viaPrompt.workspace, { adapter: reports({ applied: 'prompt' }), toolPaths: opencodeToolPaths });
    await runLocalDriver(viaAgent.config, viaAgent.runId, viaAgent.workspace, { adapter: reports({ applied: 'main' }), toolPaths: opencodeToolPaths });

    const requested = { model: { requested: 'anthropic/claude-sonnet-4-5', alias: 'smart' }, effort: { requested: 'high' } };
    expect((await entry(viaPrompt.config))?.agent).toMatchObject({ v: 1, definition: { name: 'reviewer', applied: 'prompt' }, tool: { name: 'opencode' }, ...requested });
    expect((await entry(viaAgent.config))?.agent).toMatchObject({ definition: { name: 'reviewer', applied: 'main' }, ...requested });
  });

  it('names the alias of defaults.model only for a step it chose the model of', async () => {
    const yaml = `schemaVersion: v1alpha1
name: build
description: Review the project.
defaults:
  model: strong
steps:
  - id: review
    prompt: Review this project.
    agent: reviewer
  - id: plan
    needs: [review]
    prompt: Plan it.
`;
    const { config, workspace, runId } = await observed(yaml);
    fs.mkdirSync(path.join(config.repo.localPath, 'models'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), 'aliases:\n  strong:\n    claude: claude-opus-4-1\n');

    await runLocalDriver(config, runId, workspace, { adapter: reports(), toolPaths });

    const [review, plan] = (await endRecord(config))?.steps ?? [];
    expect(review?.agent).toMatchObject({ model: { requested: 'claude-opus-4-1' } });
    expect(review?.agent).not.toHaveProperty('model.alias');
    expect(plan?.agent).toMatchObject({ model: { requested: 'claude-opus-4-1', alias: 'strong' } });
  });

  it('has no definition for a step without agent:', async () => {
    const { config, workspace, runId } = await observed(reviewStep());

    await runLocalDriver(config, runId, workspace, { adapter: reports(), toolPaths });

    const published = await entry(config);
    expect(published?.agent).toMatchObject({ v: 1, tool: { name: 'claude' } });
    expect(published?.agent).not.toHaveProperty('definition');
  });

  it('reports no model when the tool names none, and still the requested one', async () => {
    const { config, workspace, runId } = await observed(reviewStep('reviewer'));

    await runLocalDriver(config, runId, workspace, { adapter: reports(), toolPaths });

    const published = await entry(config);
    expect(published).not.toHaveProperty('model');
    expect(published?.agent).toMatchObject({ model: { requested: 'claude-opus-4-1' } });
    expect(published?.agent).not.toHaveProperty('model.reported');
  });

  it('records local changes and no fingerprint after a delivered skill is edited', async () => {
    const { config, workspace, runId, rev, skill } = await observed(reviewStep('reviewer'));
    fs.appendFileSync(skill, 'My own note.\n');

    await runLocalDriver(config, runId, workspace, { adapter: reports({ model: 'claude-opus-4-1' }), toolPaths });

    const published = await entry(config);
    expect(published?.agent).toMatchObject({ team: { revision: rev, localChanges: true } });
    expect(published?.agent).not.toHaveProperty('fingerprint');
  });

  it('requests no model after the deployed agent file\'s model is edited', async () => {
    const { config, workspace, runId, agentFile } = await observed(reviewStep('reviewer'));
    fs.writeFileSync(agentFile, fs.readFileSync(agentFile, 'utf8').replace('claude-opus-4-1', 'claude-haiku-4-5'));

    await runLocalDriver(config, runId, workspace, { adapter: reports(), toolPaths });

    expect((await entry(config))?.agent).not.toHaveProperty('model');
  });

  it.each([
    ['a push base at another commit', (team: string) => ({ pushBaseRevs: [commitFile(team, 'agents/later.yaml')] })],
    ['no delivered baseline', () => ({ delivered: undefined })],
  ])('names no team and no fingerprint for a record with %s', async (_case, record) => {
    const { config, workspace, runId } = await observed(reviewStep('reviewer'));
    const key = await checkoutRecordKey(config);
    const state = await loadStateForScope(config);
    Object.assign(state.lastPullByWorkspace![key!]!, record(config.repo.localPath));
    await saveStateForScope(state, config);

    await runLocalDriver(config, runId, workspace, { adapter: reports({ model: 'claude-opus-4-1' }), toolPaths });

    const published = await entry(config);
    expect(published?.agent).toMatchObject({ v: 1, tool: { name: 'claude' } });
    expect(published?.agent).not.toHaveProperty('team');
    expect(published?.agent).not.toHaveProperty('fingerprint');
  });

  it('records no observation of a tool that never started', async () => {
    const { config, workspace, runId } = await observed(reviewStep('reviewer'));

    await runLocalDriver(config, runId, workspace, { adapter: createLocalToolAdapter(undefined, () => null), toolPaths });

    expect((await entry(config))?.agent).toEqual({ definition: { name: 'reviewer' } });
  });

  it('gives each pass a loop ran its own agent', async () => {
    const { config, workspace, runId } = await observed(`${reviewStep('reviewer')}    loop: { back_to: review, while: "length(steps.review.passes) < 3", max_iterations: 3 }
`);
    let pass = 0;
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async () => ({ started: true as const, exitCode: 0, model: `claude-model-${++pass}` })) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    const published = (await endRecord(config))?.steps ?? [];
    expect(published.map((step) => [step.pass, step.agent && 'model' in step.agent ? step.agent.model?.reported : undefined])).toEqual([
      [1, 'claude-model-1'],
      [2, 'claude-model-2'],
      [3, 'claude-model-3'],
    ]);
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
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        commandExitedFirst.push(fs.existsSync(path.join(workspace, '..', 'slow.done')));
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(commandExitedFirst).toEqual([true]);
  });

  it.each([
    ['a command in another worktree', (mark: (name: string, untilRelease?: boolean) => string) => `  - id: change
    workspace: new
    prompt: Implement.
  - id: lint
    needs: []
    workspace: new
    command: ${mark('lint')}
`, ['lint'], []],
    ['a command in the current checkout', (mark: (name: string, untilRelease?: boolean) => string) => `  - id: change
    workspace: new
    prompt: Implement.
  - id: lint
    needs: []
    command: ${mark('lint')}
`, ['lint'], []],
    ['a command in the prompt\'s own worktree', (mark: (name: string, untilRelease?: boolean) => string) => `  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          prompt: Implement.
        - id: lint
          needs: []
          workspace: continue
          command: ${mark('lint')}
`, [], ['lint']],
    ['a command past max_parallel, counting the prompt', (mark: (name: string, untilRelease?: boolean) => string) => `  - id: change
    workspace: new
    prompt: Implement.
  - id: first
    needs: []
    workspace: new
    command: ${mark('first', true)}
  - id: second
    needs: []
    workspace: new
    command: ${mark('second')}
`, ['first'], ['second']],
  ] as const)('runs a ready step beside a headless prompt only in a free checkout and slot: %s', async (_name, steps, overlaps, waits) => {
    const markers = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-markers-'));
    dirs.push(markers);
    const mark = (name: string, untilRelease = false): string => `node -e "const fs=require('fs'),p=require('path'); fs.writeFileSync(p.join('${markers}','${name}'),'');${
      untilRelease ? ` const t=setInterval(()=>{ if (fs.existsSync(p.join('${markers}','release'))) clearInterval(t); },20);` : ''}"`;
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Steps beside a prompt.
steps:
${steps(mark)}`, 2);
    const exists = (name: string): boolean => fs.existsSync(path.join(markers, name));
    const seen: string[] = [];
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        for (const deadline = Date.now() + 3000; Date.now() < deadline && !overlaps.every(exists);) await new Promise((resolve) => setTimeout(resolve, 20));
        if (waits.length > 0) await new Promise((resolve) => setTimeout(resolve, 500));
        seen.push(...[...overlaps, ...waits].filter(exists));
        fs.writeFileSync(path.join(markers, 'release'), '');
        return { started: true as const, exitCode: 0 };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(seen).toEqual(overlaps);
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
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async () => ({ started: true as const, exitCode: 0, output: { ok: true } })) };

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
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        commandExitedFirst.push(fs.existsSync(path.join(workspace, '..', 'markers', 'lingering.exited')));
        return { started: true as const, exitCode: 0, output: { ok: true } };
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
    // The other caller runs with room for a second open lease.
    const leased = await leaseNext({ ...config, workflows: { tools: {}, max_parallel: 2 } }, runId, same, { running: [slow.attempt] });
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
    // The earlier driver ran while this machine allowed more open leases.
    const before: LocalConfig = { ...config, workflows: { tools: {}, max_parallel: 2 } };
    const a = await leaseNext(before, runId, earlier);
    const attempt = 'data' in a ? (a.data.lease as { attempt: string }).attempt : '';
    expect(await leaseNext(before, runId, earlier, { running: [attempt] })).toMatchObject({ data: { lease: { step: 'b' } } });

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
    // The earlier driver ran while this machine allowed more open leases.
    const before: LocalConfig = { ...config, workflows: { tools: {}, max_parallel: 3 } };
    const running: string[] = [];
    for (const step of ['c1', 'ask', 'c2']) {
      const leased = await leaseNext(before, runId, earlier, { running });
      expect(leased).toMatchObject({ data: { lease: { step } } });
      if ('data' in leased) running.push((leased.data.lease as { attempt: string }).attempt);
    }
    const logAtPrompt: string[] = [];
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        logAtPrompt.push(fs.readFileSync(path.join(workspace, '..', 'log.txt'), 'utf8'));
        return { started: true as const, exitCode: 0, output: { ok: true } };
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

  it.skipIf(process.platform === 'win32')('kills an attached descendant that ignores SIGTERM after its shell exits', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Cancel a foreground command with a stubborn descendant.
steps:
  - id: parent
    command: node parent.js; true
`, 1);
    fs.writeFileSync(path.join(workspace, 'parent.js'), `require('child_process').spawn(process.execPath, ['-e', \`process.on('SIGTERM', () => {});
require('fs').writeFileSync('child.pid', String(process.pid));
setInterval(() => {}, 1000);\`], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`);
    const driving = runLocalDriver(config, runId, workspace);
    let pid: number | undefined;
    try {
      await vi.waitFor(() => expect(fs.existsSync(path.join(workspace, 'child.pid'))).toBe(true), { timeout: 10_000, interval: 20 });
      pid = Number(fs.readFileSync(path.join(workspace, 'child.pid'), 'utf8'));
      expect(await cancelRun(config, runId, await knownSecrets(config))).not.toHaveProperty('error');

      expect(await driving).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
      expect(await exitsWithin(pid, 1000)).toBe(true);
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
      await cancelRun(config, runId, await knownSecrets(config));
      await driving;
    }
  }, 30_000);

  const controls = ['retry step', 'retry ancestor', 'cancel step then retry', 'cancel run then retry'] as const;
  it.each(controls.flatMap((control) => [1, 2].flatMap((maxParallel) =>
    ['exec node work.js', 'node work.js; true'].map((command) => ({ control, maxParallel, command })))))(
    '$control never overlaps live attempts at max_parallel $maxParallel with $command', async ({ control, maxParallel, command }) => {
      const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Keep retry and cancel attempts separate.
steps:
  - id: plan
    choose: { message: Which plan?, options: [small, big] }
  - id: work
    needs: [plan]
    command: ${command}
`, maxParallel);
      const markers = path.join(workspace, '..', 'markers');
      fs.mkdirSync(markers);
      fs.writeFileSync(path.join(workspace, 'work.js'), `const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'markers');
const file = (name) => path.join(dir, name);
try { fs.writeFileSync(file('live'), '', { flag: 'wx' }); }
catch { fs.writeFileSync(file('overlap'), ''); process.exit(1); }
if (fs.existsSync(file('first.started'))) {
  fs.writeFileSync(file('second.saw'), fs.existsSync(file('first.cleaned')) ? 'cleaned' : 'running');
  fs.unlinkSync(file('live'));
  process.exit(0);
}
process.once('SIGTERM', () => {
  fs.writeFileSync(file('first.stopping'), '');
  setTimeout(() => {
    fs.writeFileSync(file('first.cleaned'), '');
    fs.unlinkSync(file('live'));
    process.exit(1);
  }, 2500);
});
fs.writeFileSync(file('first.pid'), String(process.pid));
fs.writeFileSync(file('first.started'), '');
setInterval(() => {}, 1000);
`);
      expect(await respondToHitl(config, runId, await knownSecrets(config), { step: 'plan', choice: 'small', channel: 'cli', agent: false }))
        .not.toHaveProperty('error');
      const options = { hitl: true, question: async () => 'big' };
      const driving = runLocalDriver(config, runId, workspace, options);
      try {
        await vi.waitFor(() => expect(fs.existsSync(path.join(markers, 'first.started'))).toBe(true), { timeout: 10_000, interval: 20 });
        expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'plan', status: 'succeeded' }, { id: 'work', status: 'leased' }] });
        if (control.startsWith('cancel')) {
          expect(await cancelRun(config, runId, await knownSecrets(config), control.startsWith('cancel step') ? 'work' : undefined)).not.toHaveProperty('error');
        }
        expect(await retryStep(config, runId, await knownSecrets(config), control === 'retry ancestor' ? 'plan' : 'work'))
          .toMatchObject({ data: { retried: { pass: 2 } } });
        await vi.waitFor(() => expect(fs.existsSync(path.join(markers, 'first.stopping'))).toBe(true), { timeout: 7000, interval: 20 });
        expect(await driving).not.toHaveProperty('error');
        const pid = Number(fs.readFileSync(path.join(markers, 'first.pid'), 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow();
        expect(await runLocalDriver(config, runId, workspace, options)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
        expect(fs.existsSync(path.join(markers, 'first.stopping'))).toBe(true);
        expect(fs.existsSync(path.join(markers, 'first.cleaned'))).toBe(true);
        expect(fs.existsSync(path.join(markers, 'live'))).toBe(false);
        expect(fs.existsSync(path.join(markers, 'overlap'))).toBe(false);
        expect(fs.readFileSync(path.join(markers, 'second.saw'), 'utf8')).toBe('cleaned');
      } finally {
        await cancelRun(config, runId, await knownSecrets(config));
        const pidFile = path.join(markers, 'first.pid');
        if (fs.existsSync(pidFile) && !fs.existsSync(path.join(markers, 'first.cleaned'))) {
          try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* Already exited. */ }
        }
        await driving;
      }
    }, 30_000,
  );
});

describe('the model a prompt step runs on', () => {
  type FakeTool = 'claude' | 'codex' | 'opencode';

  const AGENT_FILES: Record<FakeTool, { dir: string; ext: string }> = {
    claude: { dir: '.claude/agents', ext: '.md' },
    codex: { dir: '.codex/agents', ext: '.toml' },
    opencode: { dir: '.opencode/agents', ext: '.md' },
  };

  /** What each tool prints in its JSON mode, so the adapter reads stdout as it would from the real tool. */
  const STDOUT: Record<FakeTool, string> = {
    claude: '{"type":"system","subtype":"init","model":"claude-opus-4-1-20250805"}\n{"type":"result","result":"done","session_id":"session-1"}',
    codex: '{"type":"thread.started","thread_id":"thread-1"}',
    opencode: '{"type":"step_finish","sessionID":"session-1"}',
  };

  const TEAM_ALIASES = `aliases:
  strong:
    claude: { model: opus, effort: high }
    codex: { model: gpt-6-sol, effort: high }
    opencode: { model: anthropic/claude-opus, effort: high }
  fast:
    claude: haiku
    codex: gpt-6-mini
`;

  afterEach(() => {
    fs.rmSync(path.join(os.homedir(), '.teamai', 'models'), { recursive: true, force: true });
  });

  /**
   * Runs `yaml` on `tool` through the real adapter, with a fake executable that appends its arguments as one JSON
   * line to a file and writes a result, and answers `--version` with `version`. Like OpenCode, it first reads stdin
   * to its end. Returns every argument list the tool was started with, in order.
   */
  async function runOn(
    tool: FakeTool,
    yaml: string,
    options: { agents?: Record<string, string>; aliases?: string; localAliases?: string; version?: string } = {},
  ) {
    const { config, workspace, runId } = await workflowFixture(yaml);
    const root = path.dirname(workspace);
    config.workflows = { tools: { default: tool } };
    for (const [name, content] of Object.entries(options.agents ?? {})) {
      fs.mkdirSync(path.join(workspace, AGENT_FILES[tool].dir), { recursive: true });
      fs.writeFileSync(path.join(workspace, AGENT_FILES[tool].dir, `${name}${AGENT_FILES[tool].ext}`), content);
    }
    fs.mkdirSync(path.join(config.repo.localPath, 'models'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), options.aliases ?? TEAM_ALIASES);
    if (options.localAliases !== undefined) {
      fs.mkdirSync(path.join(os.homedir(), '.teamai', 'models'), { recursive: true });
      fs.writeFileSync(path.join(os.homedir(), '.teamai', 'models', 'aliases.yaml'), options.localAliases);
    }
    const argvFile = path.join(root, 'argv.jsonl');
    const executable = path.join(root, `fake-${tool}`);
    fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') {
  process.stdout.write(${JSON.stringify(options.version ?? '1.18.23')} + '\\n');
  process.exit(0);
}
fs.readFileSync(0);
fs.appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, '{"output":{"ok":true}}');
process.stdout.write(${JSON.stringify(STDOUT[tool])} + '\\n');
`, { mode: 0o755 });
    const done = await runLocalDriver(config, runId, workspace, {
      adapter: createLocalToolAdapter(undefined, () => executable),
      toolPaths: Object.fromEntries(Object.entries(AGENT_FILES).map(([name, { dir }]) => [name, { agents: dir }])) as TeamaiConfig['toolPaths'],
    });
    const argv = fs.existsSync(argvFile)
      ? fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
      : undefined;
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run was not stored');
    return { done, argv, run, workspace };
  }

  function oneStep(fields: string, header = ''): string {
    return `schemaVersion: v1alpha1
name: build
description: Review the project.
${header}steps:
  - id: plan
    prompt: Review this project.
${fields}`;
  }

  /** The prompt every tool receives for `text`, with the result instruction the adapter adds. */
  const prompt = (text: string) => expect.stringMatching(new RegExp(`^${text.replaceAll('.', '\\.')}\\n\\nWrite the workflow result as JSON to .+result\\.json\\. Use this shape`, 's'));

  it('launches claude with --model and --effort of the alias for claude', async () => {
    const { argv, run } = await runOn('claude', oneStep('    model: strong\n'));

    expect(argv).toEqual([['-p', prompt('Review this project.'), '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--effort', 'high']]);
    expect(run.steps[0]).toMatchObject({
      status: 'succeeded',
      model: 'claude-opus-4-1-20250805',
      agent: { model: { requested: 'opus', alias: 'strong', reported: 'claude-opus-4-1-20250805' }, effort: { requested: 'high' } },
    });
  });

  it('launches codex with --model of the alias for codex, and -c model_reasoning_effort only when the alias sets an effort', async () => {
    const strong = await runOn('codex', oneStep('    model: strong\n'));
    const fast = await runOn('codex', oneStep('    model: fast\n'));

    expect(strong.argv).toEqual([['exec', '--json', '--model', 'gpt-6-sol', '-c', 'model_reasoning_effort=high', prompt('Review this project.')]]);
    expect(fast.argv).toEqual([['exec', '--json', '--model', 'gpt-6-mini', prompt('Review this project.')]]);
  });

  it('runs an agent with a model, an effort and allowed tools on the step model and effort, and keeps its other settings', async () => {
    const reviewer = `---
name: reviewer
description: Reviews changes.
model: haiku
effort: low
tools: Read, Grep
---
Follow the review checklist.
`;
    const claude = await runOn('claude', oneStep('    agent: reviewer\n    model: strong\n'), { agents: { reviewer } });

    expect(claude.argv).toEqual([['-p', prompt('Review this project.'), '--output-format', 'stream-json', '--verbose', '--agent', 'reviewer', '--model', 'opus', '--effort', 'high']]);
    expect(fs.readFileSync(path.join(claude.workspace, '.claude', 'agents', 'reviewer.md'), 'utf8')).toBe(reviewer);
    expect(claude.run.steps[0]).toMatchObject({
      status: 'succeeded',
      model: 'claude-opus-4-1-20250805',
      agent: { definition: { applied: 'main' }, model: { requested: 'opus', alias: 'strong' }, effort: { requested: 'high' } },
    });

    const codex = await runOn('codex', oneStep('    agent: reviewer\n    model: strong\n'), { agents: { reviewer: `name = "reviewer"
description = "Reviews changes."
developer_instructions = "Follow the review checklist."
model = "gpt-5.4"
model_reasoning_effort = "low"
` } });

    expect(codex.argv).toEqual([['exec', '--json', '--model', 'gpt-6-sol', '-c', 'model_reasoning_effort=high', prompt('Follow the review checklist.\n\nReview this project.')]]);
    expect(codex.argv?.flat()).not.toContain('gpt-5.4');
  });

  it('passes a model that is not an alias unchanged, at the tool default effort', async () => {
    const claude = await runOn('claude', oneStep('    model: claude-opus-4.1\n'));
    const opencode = await runOn('opencode', oneStep('    model: anthropic/claude-sonnet\n'));

    expect(claude.argv).toEqual([['-p', prompt('Review this project.'), '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-4.1']]);
    expect(opencode.argv).toEqual([['run', '--format', 'json', prompt('Review this project.'), '--model', 'anthropic/claude-sonnet']]);
  });

  it('fails an alias without a model for the tool with model_unavailable, and does not start the tool', async () => {
    const step = await runOn('codex', oneStep('    model: strong\n'), { aliases: 'aliases:\n  strong:\n    claude: opus\n' });
    const defaults = await runOn('codex', `schemaVersion: v1alpha1
name: build
description: Summarize the review.
defaults:
  model: fast
steps:
  - id: summary
    prompt: Summarize the review.
`, { aliases: 'aliases:\n  fast:\n    claude: haiku\n' });

    expect(step.argv).toBeUndefined();
    expect(step.run.steps[0]).toMatchObject({
      status: 'failed',
      tool: 'codex',
      failure: {
        code: 'model_unavailable',
        message: 'Step "plan" asks for model alias "strong", which has no model for codex in models/aliases.yaml. Add one or remove model from the step.',
      },
    });
    expect(defaults.argv).toBeUndefined();
    expect(defaults.run.steps[0]).toMatchObject({
      status: 'failed',
      failure: {
        code: 'model_unavailable',
        message: 'Step "summary" gets model alias "fast" from defaults, which has no model for codex in models/aliases.yaml. Add one, or set model on the step.',
      },
    });
  });

  it('fails an alias the member turns off for the tool in their local aliases file', async () => {
    const { argv, run } = await runOn('claude', oneStep('    model: strong\n'), { localAliases: 'aliases:\n  strong:\n    claude: ~\n' });

    expect(argv).toBeUndefined();
    const local = path.join(os.homedir(), '.teamai', 'models', 'aliases.yaml');
    expect(run.steps[0]).toMatchObject({
      status: 'failed',
      failure: {
        code: 'model_unavailable',
        message: `Step "plan" asks for model alias "strong", which ${local} turns off for claude. Remove that entry or remove model from the step.`,
      },
    });
  });

  it('fails a step model while the aliases cannot be read, naming a value it cannot tell to be an alias as a model', async () => {
    const reserved = await runOn('claude', oneStep('    model: strong\n'), { aliases: 'aliases: [\n' });
    const other = await runOn('claude', oneStep('    model: claude-opus-4.1\n'), { aliases: 'aliases: [\n' });

    expect(reserved.argv).toBeUndefined();
    expect(reserved.run.steps[0]).toMatchObject({
      failure: { code: 'model_unavailable', message: expect.stringMatching(/^Step "plan" asks for model alias "strong", which cannot be resolved for claude: Invalid model aliases YAML at models\/aliases\.yaml: .+\. Fix that, or remove model from the step\.$/) },
    });
    expect(other.argv).toBeUndefined();
    expect(other.run.steps[0]).toMatchObject({
      failure: { code: 'model_unavailable', message: expect.stringMatching(/^Step "plan" asks for model "claude-opus-4\.1", which cannot be resolved for claude: /) },
    });
  });

  it('launches each tool as before when neither the step nor the workflow sets a model', async () => {
    const claude = await runOn('claude', oneStep('    agent: reviewer\n'), { agents: { reviewer: `---
name: reviewer
description: Reviews changes.
model: haiku
---
Follow the review checklist.
` } });
    const codex = await runOn('codex', oneStep('    agent: reviewer\n'), { agents: { reviewer: `name = "reviewer"
description = "Reviews changes."
developer_instructions = "Follow the review checklist."
model = "gpt-5.4"
` } });
    const opencode = await runOn('opencode', oneStep(''));

    expect(claude.argv).toEqual([['-p', prompt('Review this project.'), '--output-format', 'stream-json', '--verbose', '--agent', 'reviewer']]);
    expect(codex.argv).toEqual([['exec', '--json', '--model', 'gpt-5.4', prompt('Follow the review checklist.\n\nReview this project.')]]);
    expect(opencode.argv).toEqual([['run', '--format', 'json', prompt('Review this project.')]]);
  });

  it('runs defaults.model where neither the step nor its definition sets a model, and leaves the others to theirs', async () => {
    const { argv } = await runOn('claude', `schemaVersion: v1alpha1
name: build
description: Plan, review, and summarize.
defaults:
  model: fast
steps:
  - id: plain
    prompt: Plan it.
  - id: unpinned
    needs: [plain]
    agent: helper
    prompt: Help with it.
  - id: pinned
    needs: [unpinned]
    agent: reviewer
    prompt: Review it.
  - id: own
    needs: [pinned]
    prompt: Summarize it.
    model: strong
`, { agents: {
      helper: '---\nname: helper\ndescription: Helps.\n---\nHelp out.\n',
      reviewer: '---\nname: reviewer\ndescription: Reviews changes.\nmodel: sonnet\n---\nFollow the review checklist.\n',
    } });

    expect(argv).toEqual([
      ['-p', prompt('Plan it.'), '--output-format', 'stream-json', '--verbose', '--model', 'haiku'],
      ['-p', prompt('Help with it.'), '--output-format', 'stream-json', '--verbose', '--agent', 'helper', '--model', 'haiku'],
      ['-p', prompt('Review it.'), '--output-format', 'stream-json', '--verbose', '--agent', 'reviewer'],
      ['-p', prompt('Summarize it.'), '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--effort', 'high'],
    ]);
  });

  it('passes --variant for an OpenCode agent, and fails an OpenCode 1 step on its primary agent\'s own model with no effort when the agent sets a variant', async () => {
    const reviewer = '---\ndescription: Reviews changes.\nmodel: anthropic/claude-sonnet\nvariant: low\n---\nFollow the review checklist.\n';
    const strong = await runOn('opencode', oneStep('    agent: reviewer\n    model: strong\n'), { agents: { reviewer } });
    const other = await runOn('opencode', oneStep('    agent: reviewer\n    model: anthropic/claude-haiku\n'), { agents: { reviewer } });
    const none = await runOn('opencode', oneStep('    agent: reviewer\n'), { agents: { reviewer } });
    const defaults = await runOn('opencode', oneStep('    agent: helper\n', 'defaults:\n  model: anthropic/claude-haiku\n'), {
      agents: { helper: '---\ndescription: Helps.\nvariant: low\n---\nHelp out.\n' },
    });
    const own = await runOn('opencode', oneStep('    agent: reviewer\n    model: anthropic/claude-sonnet\n'), { agents: { reviewer } });
    const ownOn2 = await runOn('opencode', oneStep('    agent: reviewer\n    model: anthropic/claude-sonnet\n'), {
      agents: { reviewer }, version: 'opencode v2.0.30',
    });
    const subagent = await runOn('opencode', oneStep('    agent: reviewer\n    model: anthropic/claude-sonnet\n'), {
      agents: { reviewer: reviewer.replace('variant: low', 'mode: subagent\nvariant: low') },
    });

    expect(strong.argv).toEqual([[
      'run', '--format', 'json', prompt('Review this project.'), '--agent', 'reviewer', '--model', 'anthropic/claude-opus', '--variant', 'high',
    ]]);
    expect(other.argv).toEqual([['run', '--format', 'json', prompt('Review this project.'), '--agent', 'reviewer', '--model', 'anthropic/claude-haiku']]);
    expect(none.argv).toEqual([[
      'run', '--format', 'json', prompt('Review this project.'), '--agent', 'reviewer', '--model', 'anthropic/claude-sonnet', '--variant', 'low',
    ]]);
    expect(defaults.argv).toEqual([['run', '--format', 'json', prompt('Review this project.'), '--agent', 'helper', '--model', 'anthropic/claude-haiku']]);
    expect(ownOn2.argv).toEqual([['run', '--format', 'json', prompt('Review this project.'), '--agent', 'reviewer', '--model', 'anthropic/claude-sonnet']]);
    expect(subagent.argv).toEqual([['run', '--format', 'json', prompt('Follow the review checklist.\n\nReview this project.'), '--model', 'anthropic/claude-sonnet']]);
    expect(own.argv).toBeUndefined();
    expect(own.run.steps[0]).toMatchObject({
      status: 'failed',
      failure: {
        code: 'model_unavailable',
        message: 'Agent "reviewer" runs on its own model "anthropic/claude-sonnet" with no effort, and opencode 1 applies the agent\'s variant "low" '
          + 'to that model. Remove model from the step to run at that variant, or set it to an alias with an effort for opencode.',
      },
    });
  });

  it('runs an OpenCode definition on its model and variant, as --agent on OpenCode 2 and from the prompt for a subagent on OpenCode 1', async () => {
    const reviewer = '---\ndescription: Reviews changes.\nmode: subagent\nmodel: anthropic/claude-sonnet\nvariant: low\npermission:\n  edit: deny\n---\n'
      + 'Follow the review checklist.\n';
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const on2 = await runOn('opencode', oneStep('    agent: reviewer\n'), { agents: { reviewer }, version: 'opencode v2.0.30' });
    expect(warn).not.toHaveBeenCalled();
    const on1 = await runOn('opencode', oneStep('    agent: reviewer\n'), { agents: { reviewer } });

    expect(on2.argv).toEqual([['run', '--format', 'json', prompt('Review this project.'), '--agent', 'reviewer', '--model', 'anthropic/claude-sonnet#low']]);
    expect(on1.argv).toEqual([[
      'run', '--format', 'json', prompt('Follow the review checklist.\n\nReview this project.'), '--model', 'anthropic/claude-sonnet', '--variant', 'low',
    ]]);
    const requested = { model: { requested: 'anthropic/claude-sonnet' }, effort: { requested: 'low' } };
    expect(on2.run.steps[0]).toMatchObject({ agent: { definition: { applied: 'main' }, ...requested } });
    expect(on1.run.steps[0]).toMatchObject({ agent: { definition: { applied: 'prompt' }, ...requested } });
    expect(warn).toHaveBeenCalledWith(
      'Agent "reviewer" runs on opencode 1 from the prompt, since opencode run does not start a subagent there, so it does not apply permission '
        + 'from the deployed agent file. The step is not blocked.',
    );

    const helper = '---\ndescription: Helps.\nmode: subagent\nvariant: low\n---\nHelp out.\n';
    const helperOn1 = await runOn('opencode', oneStep('    agent: helper\n'), { agents: { helper } });
    expect(helperOn1.argv).toEqual([['run', '--format', 'json', prompt('Help out.\n\nReview this project.')]]);
    expect(warn).toHaveBeenLastCalledWith(
      'Agent "helper" runs on opencode 1 from the prompt, since opencode run does not start a subagent there, so it does not apply variant '
        + 'from the deployed agent file. The step is not blocked.',
    );
    const helperOn2 = await runOn('opencode', oneStep('    agent: helper\n'), { agents: { helper }, version: 'opencode v2.0.30' });
    expect(helperOn2.argv).toEqual([['run', '--format', 'json', prompt('Review this project.'), '--agent', 'helper']]);
    expect(warn).toHaveBeenLastCalledWith(
      'Agent "helper" sets a variant with no model, and opencode 2 takes a variant only with a model, so it does not apply variant '
        + 'from the deployed agent file. The step is not blocked.',
    );
  });

  it('passes the effort to OpenCode 2, which has no --variant, as model#variant', async () => {
    const strong = await runOn('opencode', oneStep('    model: strong\n'), { version: 'opencode v2.0.30' });
    const literal = await runOn('opencode', oneStep('    model: anthropic/claude-sonnet\n'), { version: 'opencode v2.0.30' });

    expect(strong.argv).toEqual([['run', '--format', 'json', prompt('Review this project.'), '--model', 'anthropic/claude-opus#high']]);
    expect(literal.argv).toEqual([['run', '--format', 'json', prompt('Review this project.'), '--model', 'anthropic/claude-sonnet']]);
  });
});

describe('local workflow HITL controls', () => {
  it.each([false, true])('never asks without HITL while a headless prompt is held, required %s', async (required) => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Keep questions out of a driver without HITL.
steps:
  - id: a
    command: sleep 0.3
  - id: p
    needs: []
    prompt: Review it.
  - id: ship
    needs: [a]
    approve: { message: Ship it?, required: ${required} }
    command: "true"
`);
    config.workflows!.max_parallel = 2;
    const question = vi.fn(async () => 'yes');
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return { started: true as const, exitCode: 0 };
      }),
    };
    const result = await runLocalDriver(config, runId, workspace, { hitl: false, adapter, question });
    expect(result).toMatchObject({ data: { done: { outcome: required ? 'failed' : 'succeeded' } } });
    expect(question).not.toHaveBeenCalled();
    const run = await readRun(config, runId);
    if (typeof run === 'string' || run === null) throw new Error('Run was not saved');
    const ship = run.steps.find((step) => step.id === 'ship');
    if (required) {
      expect(ship).toMatchObject({ status: 'failed', failure: { code: 'hitl_required' } });
      expect(ship?.answer).toBeUndefined();
    } else {
      expect(ship).toMatchObject({ status: 'skipped', answer: { choice: 'no', channel: 'no_hitl' } });
    }
  });

  it('asks inline, re-asks an invalid choice, and records the note', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Ask inline.
steps:
  - id: ask
    approve: Build it?
    command: echo ok
`);
    const question = vi.fn().mockResolvedValueOnce('bad').mockResolvedValueOnce('yes Keep the flag');
    const result = await runLocalDriver(config, runId, workspace, { hitl: true, question });
    expect(result).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(question).toHaveBeenCalledTimes(2);
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.steps[0]?.answer).toMatchObject({ choice: 'yes', note: 'Keep the flag', channel: 'tty', agent: false });
  });

  it('aborts a question when another process answers its HITL request', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Ask elsewhere.
steps:
  - id: ask
    choose: { message: Pick one, options: [one, two] }
`);
    let aborted = false;
    const question = vi.fn((_hitl, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      void knownSecrets(config).then((secrets) => respondToHitl(config, runId, secrets, { step: 'ask', choice: 'one', channel: 'cli', agent: true }));
    }));
    expect(await runLocalDriver(config, runId, workspace, { hitl: true, question })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(aborted).toBe(true);
    expect(question).toHaveBeenCalledTimes(1);
  });

  it('polls and aborts a cancelled prompt while the adapter is running', async () => {
    const { config, workspace, runId } = await fixture();
    let aborted = false;
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn<LocalToolAdapter['run']>((_tool, _input, signal) => new Promise<LocalToolResult>((resolve) => {
        signal!.addEventListener('abort', () => {
          aborted = true;
          resolve({ started: true, exitCode: 1 });
        });
        void knownSecrets(config).then((secrets) => cancelRun(config, runId, secrets));
      })),
    };
    expect(await runLocalDriver(config, runId, workspace, { adapter })).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
    expect(aborted).toBe(true);
  });

  it('runs an interactive prompt through the foreground entry point', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Work together.
steps:
  - id: pair
    prompt: Work together.
    interactive: true
`);
    const adapter: LocalToolAdapter = {
      run: vi.fn(),
      runInteractive: vi.fn(async () => ({ started: true as const, exitCode: 0 })),
    };
    expect(await runLocalDriver(config, runId, workspace, { hitl: true, adapter })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(adapter.runInteractive).toHaveBeenCalledWith('claude', expect.objectContaining({ prompt: 'Work together.', cwd: workspace }), expect.any(AbortSignal));
    expect(adapter.run).not.toHaveBeenCalled();
  });

  it('caps the turns of headless Claude, and reports max_turns as unenforced for another tool and for an interactive prompt', async () => {
    const yaml = (interactive: boolean) => `schemaVersion: v1alpha1
name: build
description: Plan in a few turns.
steps:
  - id: plan
    prompt: Plan it.
    max_turns: 3
${interactive ? '    interactive: true\n' : ''}`;
    const inputs: LocalToolRun[] = [];
    const ran = vi.fn(async (_tool: string, input: LocalToolRun) => {
      inputs.push(input);
      return { started: true as const, exitCode: 0, tokens: { input: 1, output: 1 } };
    });
    const adapter: LocalToolAdapter = { run: ran, runInteractive: ran };
    const headless = await workflowFixture(yaml(false));
    const codex = await workflowFixture(yaml(false));
    codex.config.workflows = { tools: { default: 'codex' } };
    const interactive = await workflowFixture(yaml(true));
    for (const { config, workspace, runId } of [headless, codex, interactive]) {
      expect(await runLocalDriver(config, runId, workspace, { hitl: true, adapter })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    }
    expect(inputs.map((input) => input.maxTurns)).toEqual([3, undefined, undefined]);
    const unenforced = async ({ config, runId }: { config: LocalConfig; runId: string }) => {
      const run = await readRun(config, runId);
      return typeof run === 'object' && run.steps[0] && 'unenforced' in run.steps[0] ? run.steps[0].unenforced : undefined;
    };
    expect(await unenforced(headless)).toBeUndefined();
    expect(await unenforced(codex)).toEqual([{ requirement: 'max_turns', asked: 3 }]);
    expect(await unenforced(interactive)).toEqual([{ requirement: 'max_turns', asked: 3 }]);
  });

  it('auto-approves only for this driver process without HITL', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Approve in CI.
steps:
  - id: ask
    approve: Continue?
`);
    expect(await runLocalDriver(config, runId, workspace, { hitl: false, autoApprove: true })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(config.workflows?.auto_approve).toBeUndefined();
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.steps[0]?.answer).toMatchObject({ choice: 'yes', channel: 'auto_approve' });
  });
});


describe('local workflow driver ownership', () => {
  it('refuses a second driver, then releases ownership when the first finishes', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Hold a HITL request.
steps:
  - id: ask
    approve: Continue?
`);
    let asking = (): void => {};
    const asked = new Promise<void>((resolve) => { asking = resolve; });
    const first = runLocalDriver(config, runId, workspace, { hitl: true, question: (_hitl, signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('closed')));
      asking();
    }) });
    await asked;
    expect(await runLocalDriver(config, runId, workspace)).toEqual({ error: { code: 'driver_running', message: `Run ${runId} is already driven by process ${process.pid} on this machine. Stop that driver, or wait for it.` } });
    await respondToHitl(config, runId, await knownSecrets(config), { step: 'ask', choice: 'no', channel: 'cli', agent: true });
    expect(await first).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.existsSync(driverLockPath(config, runId))).toBe(false);
    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('reclaims a dead driver lock and releases it on an engine error', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Reclaim a stopped driver.
steps:
  - id: work
    command: echo work
`);
    const lock = driverLockPath(config, runId);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, owner: 'dead' }));
    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const absent = 'r0123456789abcdef';
    expect(await runLocalDriver(config, absent, workspace)).toMatchObject({ error: { code: 'run_not_found' } });
    expect(fs.existsSync(driverLockPath(config, absent))).toBe(false);
  });

  it.each([
    [false, [{ requirement: 'network', asked: false }, { requirement: 'isolation', asked: 'sandbox', provided: 'none' }]],
    [true, [{ requirement: 'network', asked: false }]],
  ])('records what it cannot enforce, and isolates to sandbox only on a host marked sandbox (%s)', async (sandbox, unenforced) => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Run contained.
steps:
  - id: work
    command: echo work
    requires: { network: false, isolation: sandbox }
`);
    config.workflows = { tools: {}, sandbox };
    expect(await runLocalDriver(config, runId, workspace, { hitl: false })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'work', status: 'succeeded', unenforced }] });
  });

  it('gives each command only the env keys its step requires, the team value first, and keeps the rest of the environment', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Scope env.
steps:
  - id: deploy
    command: test "$DEPLOY_TOKEN" = deploy-value && test "$TEAM_URL" = https://team.example && test -n "$PATH"
    requires: { env: [DEPLOY_TOKEN, TEAM_URL] }
  - id: check
    needs: []
    command: test -z "$DEPLOY_TOKEN" && test -z "$TEAM_URL" && test -n "$PATH"
`);
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'env.yaml'), 'variables:\n  - key: TEAM_URL\n    value: https://team.example\n');
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-value');
    vi.stubEnv('TEAM_URL', 'exported-by-another-shell');
    expect(await runLocalDriver(config, runId, workspace, { hitl: false })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    vi.unstubAllEnvs();
  });

  it('leaves no secret value in the result file an attempt keeps on disk', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Print a secret.
steps:
  - id: deploy
    command: printf '{"token":"%s"}' "$DEPLOY_TOKEN"
    requires: { env: [DEPLOY_TOKEN] }
`);
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-secret-value-1082');
    expect(await runLocalDriver(config, runId, workspace, { hitl: false })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    vi.unstubAllEnvs();
    const attempts = path.join(getDataHome(config), 'workflows', 'runs', runId, 'attempts');
    const [attempt] = fs.readdirSync(attempts);
    const kept = fs.readFileSync(path.join(attempts, attempt ?? '', 'result.json'), 'utf8');
    expect(kept).toContain('<REDACTED:DEPLOY_TOKEN>');
    expect(kept).not.toContain('deploy-secret-value-1082');
  });

  it('masks the environment value of a key env/secrets.yaml declares whose name does not look secret, and not a plain env.yaml value', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Print a required value.
steps:
  - id: migrate
    command: echo "could not connect to $DATABASE_URL from $TEAM_URL" >&2; exit 1
    requires: { env: [DATABASE_URL, TEAM_URL] }
`);
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'env.yaml'), 'variables:\n  - key: TEAM_URL\n    value: https://team.example\n');
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: DATABASE_URL\n');
    vi.stubEnv('DATABASE_URL', 'postgres://ci:pw@db.example/app');
    expect(await runLocalDriver(config, runId, workspace, { hitl: false })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    vi.unstubAllEnvs();
    const runFile = JSON.stringify(await readRun(config, runId));
    expect(runFile).toContain('could not connect to <REDACTED:DATABASE_URL> from https://team.example');
    expect(runFile).not.toContain('postgres://ci:pw@db.example/app');
    expect(JSON.stringify(await endRecord(config))).not.toContain('postgres://ci:pw@db.example/app');
  });

  it('masks a value an attempt was given after the value changes while the attempt runs', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Print a secret late.
steps:
  - id: deploy
    command: sleep 0.5; echo "deploying with $DEPLOY_TOKEN" >&2; exit 1
    requires: { env: [DEPLOY_TOKEN] }
`);
    vi.stubEnv('DEPLOY_TOKEN', 'old-deploy-secret-value');
    const rotated = setTimeout(() => vi.stubEnv('DEPLOY_TOKEN', 'new-deploy-secret-value'), 200);
    expect(await runLocalDriver(config, runId, workspace, { hitl: false })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    clearTimeout(rotated);
    vi.unstubAllEnvs();
    const runFile = JSON.stringify(await readRun(config, runId));
    expect(runFile).toContain('deploying with <REDACTED:DEPLOY_TOKEN');
    expect(runFile).not.toContain('old-deploy-secret-value');
  });

  function keptResult(config: LocalConfig, runId: string): string {
    const attempts = path.join(getDataHome(config), 'workflows', 'runs', runId, 'attempts');
    return fs.readdirSync(attempts).map((attempt) => fs.readFileSync(path.join(attempts, attempt, 'result.json'), 'utf8')).join('\n');
  }

  it('masks a result file that is not valid JSON', async () => {
    const { config, workspace, runId } = await fixture();
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-secret-value-1082');
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn<LocalToolAdapter['run']>(async (_tool, input) => {
      fs.mkdirSync(path.dirname(input.resultPath), { recursive: true });
      fs.writeFileSync(input.resultPath, '{"output":{"token":"deploy-secret-value-1082');
      return { started: true, exitCode: 1, failure: { code: 'tool_failed', message: 'claude wrote no result' } };
    }) };
    expect(await runLocalDriver(config, runId, workspace, { hitl: false, adapter })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    vi.unstubAllEnvs();
    expect(keptResult(config, runId)).toBe('{"output":{"token":"<REDACTED:DEPLOY_TOKEN>');
  });

  it('masks a secret JSON escaped in a result file that is not valid JSON', async () => {
    const { config, workspace, runId } = await fixture();
    const secret = 'deploy"secret\\value-1082';
    vi.stubEnv('DEPLOY_TOKEN', secret);
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn<LocalToolAdapter['run']>(async (_tool, input) => {
      fs.mkdirSync(path.dirname(input.resultPath), { recursive: true });
      fs.writeFileSync(input.resultPath, `{"output":{"token":${JSON.stringify(secret)}`);
      return { started: true, exitCode: 1, failure: { code: 'tool_failed', message: 'claude wrote no result' } };
    }) };
    expect(await runLocalDriver(config, runId, workspace, { hitl: false, adapter })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    vi.unstubAllEnvs();
    expect(keptResult(config, runId)).toBe('{"output":{"token":"<REDACTED:DEPLOY_TOKEN>"');
  });

  it('masks every result file when the driver stops on an error before it reports', async () => {
    const { config, workspace, runId } = await fixture();
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-secret-value-1082');
    let ran = false;
    const snapshot = worktreeSnapshot.snapshotWorktree;
    vi.spyOn(worktreeSnapshot, 'snapshotWorktree').mockImplementation(async (dir) => {
      if (ran) throw new Error('snapshot failed');
      return snapshot(dir);
    });
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn<LocalToolAdapter['run']>(async (_tool, input) => {
      fs.mkdirSync(path.dirname(input.resultPath), { recursive: true });
      fs.writeFileSync(input.resultPath, JSON.stringify({ output: { token: 'deploy-secret-value-1082' } }));
      ran = true;
      return { started: true, exitCode: 0 };
    }) };
    await expect(runLocalDriver(config, runId, workspace, { hitl: false, adapter })).rejects.toThrow('snapshot failed');
    vi.unstubAllEnvs();
    expect(keptResult(config, runId)).toContain('<REDACTED:DEPLOY_TOKEN>');
    expect(keptResult(config, runId)).not.toContain('deploy-secret-value-1082');
  });

  it('masks the result file of a prompt a signal stopped before it was reported', async () => {
    const { config, workspace, runId } = await fixture();
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-secret-value-1082');
    vi.spyOn(envExec, 'exitLike').mockImplementation(() => {});
    const before = new Set(process.listeners('SIGTERM'));
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn<LocalToolAdapter['run']>((_tool, input, signal) => new Promise((resolve) => {
      fs.mkdirSync(path.dirname(input.resultPath), { recursive: true });
      fs.writeFileSync(input.resultPath, JSON.stringify({ output: { token: 'deploy-secret-value-1082' } }));
      signal?.addEventListener('abort', () => resolve({ started: true, exitCode: 1 }));
      for (const handler of process.listeners('SIGTERM')) if (!before.has(handler)) handler('SIGTERM');
    })) };
    expect(await runLocalDriver(config, runId, workspace, { hitl: false, adapter })).toMatchObject({ error: { code: 'interrupted' } });
    vi.unstubAllEnvs();
    expect(keptResult(config, runId)).toContain('<REDACTED:DEPLOY_TOKEN>');
    expect(keptResult(config, runId)).not.toContain('deploy-secret-value-1082');
  });
});


describe('foreground workflow terminal ownership', () => {
  it('waits for an interactive tool to exit before asking a parallel HITL request', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Own the terminal.
steps:
  - id: setup
    command: echo ready
  - id: pair
    needs: [setup]
    interactive: true
    prompt: Pair with me.
  - id: ship
    needs: [setup]
    approve: Ship it?
    command: echo ready
`);
    let interactive = false;
    const overlaps: boolean[] = [];
    const adapter: LocalToolAdapter = {
      run: vi.fn(),
      runInteractive: vi.fn<LocalToolAdapter['runInteractive']>(async () => {
        interactive = true;
        await new Promise((resolve) => setTimeout(resolve, 2300));
        interactive = false;
        return { started: true, exitCode: 0 };
      }),
    };
    const question = vi.fn(async () => { overlaps.push(interactive); return 'yes'; });
    expect(await runLocalDriver(config, runId, workspace, { hitl: true, adapter, question })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(overlaps).toEqual([false]);
  });

  it('closes an answered HITL question before its interactive lease starts', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Answer elsewhere.
steps:
  - id: pair
    approve: Pair now?
    interactive: true
    prompt: Pair with me.
`);
    let aborted = false;
    let abortedBeforeLaunch = false;
    const question = vi.fn((_hitl, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      void knownSecrets(config).then((secrets) => respondToHitl(config, runId, secrets, { step: 'pair', choice: 'yes', channel: 'cli', agent: true }));
    }));
    const adapter: LocalToolAdapter = { run: vi.fn(), runInteractive: vi.fn<LocalToolAdapter['runInteractive']>(async () => {
      abortedBeforeLaunch = aborted;
      return { started: true, exitCode: 0 };
    }) };
    await runLocalDriver(config, runId, workspace, { hitl: true, adapter, question });
    expect(abortedBeforeLaunch).toBe(true);
    expect(question).toHaveBeenCalledTimes(1);
  });

  it('lets a person keep repository edits from an interactive step', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Fix together.
steps:
  - id: pair
    prompt: Fix the build with me.
    interactive: true
`);
    const adapter: LocalToolAdapter = { run: vi.fn(), runInteractive: vi.fn<LocalToolAdapter['runInteractive']>(async () => {
      fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'fixed\n');
      return { started: true, exitCode: 0 };
    }) };
    expect(await runLocalDriver(config, runId, workspace, { hitl: true, adapter })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(path.join(workspace, 'tracked.txt'), 'utf8')).toBe('fixed\n');
  });

  it('gives up an interactive hand-back without HITL and leaves the step for a driver with HITL', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Need a person.
steps:
  - id: pair
    prompt: Pair with me.
    interactive: true
`);
    await leaseNext(config, runId, localDriver(workspace), { can: { hitl: true } });
    const adapter: LocalToolAdapter = { run: vi.fn(), runInteractive: vi.fn<LocalToolAdapter['runInteractive']>(async () => ({ started: true, exitCode: 0 })) };
    expect(await runLocalDriver(config, runId, workspace, { hitl: false, adapter })).toMatchObject({
      error: { code: 'busy', message: 'step "pair" needs hitl, which this driver does not declare' },
    });
    expect(adapter.runInteractive).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({ status: 'running', steps: [{ id: 'pair', status: 'pending' }] });
  });

  it.each([1, 2])('ignores terminal Ctrl-C and Ctrl-\\ in an interactive tool at max_parallel %s', async (parallel) => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Keep Ctrl-C in the tool.
steps:
  - id: pair
    prompt: Pair with me.
    interactive: true
`);
    config.workflows!.max_parallel = parallel;
    vi.spyOn(envExec, 'terminalReachesCommand').mockResolvedValue(true);
    const exit = vi.spyOn(envExec, 'exitLike').mockImplementation(() => {});
    const before = new Set(process.listeners('SIGINT'));
    let aborted = false;
    const adapter: LocalToolAdapter = { run: vi.fn(), runInteractive: vi.fn<LocalToolAdapter['runInteractive']>(async (_tool, _input, signal) => {
      signal!.addEventListener('abort', () => { aborted = true; });
      for (const handler of process.listeners('SIGINT')) if (!before.has(handler)) handler('SIGINT');
      for (const handler of process.listeners('SIGQUIT')) handler('SIGQUIT');
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { started: true, exitCode: 0 };
    }) };
    expect(await runLocalDriver(config, runId, workspace, { hitl: true, adapter })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(aborted).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });
});


it.each(['SIGTERM', 'SIGHUP'] as const)('forwards %s to an interactive tool and stops the local driver', async (signalName) => {
  const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Stop the foreground tool.
steps:
  - id: pair
    prompt: Pair with me.
    interactive: true
`);
  vi.spyOn(envExec, 'terminalReachesCommand').mockResolvedValue(true);
  const exit = vi.spyOn(envExec, 'exitLike').mockImplementation(() => {});
  const before = new Set(process.listeners(signalName));
  let reason: unknown;
  const adapter: LocalToolAdapter = { run: vi.fn(), runInteractive: vi.fn<LocalToolAdapter['runInteractive']>((_tool, _input, signal) => new Promise((resolve) => {
    signal!.addEventListener('abort', () => { reason = signal!.reason; resolve({ started: true, exitCode: 1 }); });
    for (const handler of process.listeners(signalName)) if (!before.has(handler)) handler(signalName);
  })) };
  expect(await runLocalDriver(config, runId, workspace, { hitl: true, adapter })).toMatchObject({ error: { code: 'interrupted' } });
  expect(reason).toBe(signalName);
  expect(exit).toHaveBeenCalledWith({ kind: 'signaled', signal: signalName });
});

it('closes an unrelated HITL request before starting a held interactive tool and asks it again afterwards', async () => {
  const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Transfer terminal ownership.
steps:
  - id: setup
    command: sleep 0.2
  - id: pair
    needs: [setup]
    interactive: true
    prompt: Pair with me.
  - id: ship
    needs: []
    approve: Ship it?
`);
  config.workflows!.max_parallel = 2;
  let closed = false;
  let ran = false;
  let closedBeforeLaunch = false;
  const question = vi.fn((_hitl, signal: AbortSignal) => {
    if (ran) return Promise.resolve('yes');
    return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => { closed = true; reject(new Error('closed')); }));
  });
  const adapter: LocalToolAdapter = { run: vi.fn(), runInteractive: vi.fn<LocalToolAdapter['runInteractive']>(async () => {
    closedBeforeLaunch = closed;
    ran = true;
    return { started: true, exitCode: 0 };
  }) };
  expect(await runLocalDriver(config, runId, workspace, { hitl: true, question, adapter })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  expect(closedBeforeLaunch).toBe(true);
  expect(question).toHaveBeenCalledTimes(2);
});


it('asks HITL only after a held interactive tool has run', async () => {
  const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Start the held tool before asking.
steps:
  - id: setup
    command: sleep 0.1
  - id: pair
    needs: []
    interactive: true
    prompt: Pair with me.
  - id: ship
    needs: [setup]
    approve: Ship it?
`);
  config.workflows!.max_parallel = 2;
  let ran = false;
  const askedAfterTool: boolean[] = [];
  const adapter: LocalToolAdapter = { run: vi.fn(), runInteractive: vi.fn<LocalToolAdapter['runInteractive']>(async () => {
    ran = true;
    return { started: true, exitCode: 0 };
  }) };
  const question = vi.fn(async () => { askedAfterTool.push(ran); return 'yes'; });
  expect(await runLocalDriver(config, runId, workspace, { hitl: true, adapter, question })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  expect(askedAfterTool).toEqual([true]);
});

describe('a session another machine ran', () => {
  const CONTINUED = `schemaVersion: v1alpha1
name: build
description: Review the project again in the same session.
steps:
  - id: review
    prompt: Review this project.
    session: continue
    loop: { back_to: review, while: "length(steps.review.passes) < 2", max_iterations: 2 }
`;

  function archivedSession(id: string): Session {
    return {
      sessionId: id,
      title: 'Review this project',
      cwd: '/elsewhere/app',
      platform: 'claude-code',
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:05.000Z',
      messages: [
        { role: 'user', timestamp: '2026-10-01T10:00:00.000Z', content: [{ type: 'text', text: 'Review this project.' }] },
        { role: 'assistant', timestamp: '2026-10-01T10:00:05.000Z', content: [{ type: 'text', text: 'Found two problems.' }] },
      ],
      metadata: {},
    };
  }

  /**
   * A run of `yaml` whose passes before this machine's ran Claude Code sessions `sessions` on another machine, and that
   * machine's member, alice, archived those in `archived` in this team's session archive. This machine has none of them.
   */
  async function ranElsewhere(yaml: string, sessions: string[], archived: string[]): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
    const { config, workspace, runId } = await workflowFixture(yaml);
    git(workspace, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    fs.mkdirSync(path.join(os.homedir(), '.claude', 'projects'), { recursive: true });
    const elsewhere: DriverIdentity = { kind: 'local', machine: 'alice-laptop', workspace: '/elsewhere/app' };
    for (const session of sessions) {
      const leased = await leaseNext(config, runId, elsewhere);
      const lease = 'data' in leased ? leased.data.lease as { attempt: string; revision: number } | undefined : undefined;
      if (!lease) throw new Error(JSON.stringify(leased));
      await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: elsewhere, tool: 'claude', session });
    }
    const archive = new SyncManager(getReportsDir(config));
    for (const id of archived) {
      const session = archivedSession(id);
      await archive.saveSession(session, defaultSyncMeta({
        platform: 'claude-code', author: 'alice', cwd: session.cwd, sessionId: id, repoIdentity: getRepoIdentity(workspace), title: session.title,
      }, session.createdAt));
    }
    return { config, workspace, runId };
  }

  /** A tool that records the session each run resumes, and reports none of its own. */
  function recordingTool(resumed: Array<string | undefined>): LocalToolAdapter {
    return {
      runInteractive: vi.fn(),
      run: vi.fn(async (_tool, input) => {
        resumed.push(input.resume);
        return { started: true as const, exitCode: 0 };
      }),
    };
  }

  it('continues a session only the team archive has, through a copy under its own id', async () => {
    const { config, workspace, runId } = await ranElsewhere(CONTINUED, ['session-a'], ['session-a']);
    const resumed: Array<string | undefined> = [];

    const done = await runLocalDriver(config, runId, workspace, { adapter: recordingTool(resumed) });

    expect(done, JSON.stringify(await readRun(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const [resume] = resumed;
    expect(resume).toEqual(expect.any(String));
    expect(resume).not.toBe('session-a');
    expect(await AgentSession.find({ platform: 'claude-code', sessionId: resume ?? '' }, { scrub: false })).toMatchObject({
      status: 'done',
      session: { messages: [{ content: [{ text: 'Review this project.' }] }, { content: [{ text: 'Found two problems.' }] }] },
    });
  });

  it('continues the same copy on a later pass, with the turns added to it', async () => {
    const { config, workspace, runId } = await ranElsewhere(
      CONTINUED.replace('< 2", max_iterations: 2', '< 3", max_iterations: 3'), ['session-a'], ['session-a'],
    );
    const resumed: Array<string | undefined> = [];
    const tool = recordingTool(resumed);
    const recorded = tool.run;
    tool.run = vi.fn(async (name, input) => {
      const result = await recorded(name, input);
      if (resumed.length === 1) {
        const [copy] = (await getAdapter('claude-code').listConversations(workspace)).filter((meta) => meta.sessionId === input.resume);
        const records = fs.readFileSync(copy?.filePath ?? '', 'utf8').trimEnd().split('\n').map((line): Record<string, unknown> => JSON.parse(line));
        const answer = [...records].reverse().find((record) => record.type === 'assistant');
        const turn = { ...answer, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix both.' }] }, uuid: randomUUID(), parentUuid: answer?.uuid };
        fs.appendFileSync(copy?.filePath ?? '', `${JSON.stringify(turn)}\n`);
      }
      return result;
    });

    await runLocalDriver(config, runId, workspace, { adapter: tool });

    expect(resumed).toHaveLength(2);
    expect(resumed[1]).toBe(resumed[0]);
    const copy = await AgentSession.find({ platform: 'claude-code', sessionId: resumed[0] ?? '' }, { scrub: false });
    expect(copy.status === 'done' && copy.session.messages).toHaveLength(3);
  });

  it('starts a new session and says why when the latest session is neither here nor archived, never an earlier pass\'s', async () => {
    const { config, workspace, runId } = await ranElsewhere(
      CONTINUED.replace('< 2", max_iterations: 2', '< 3", max_iterations: 3'), ['session-a', 'session-b'], ['session-a'],
    );
    const warn = vi.spyOn(log, 'warn');
    const resumed: Array<string | undefined> = [];

    await runLocalDriver(config, runId, workspace, { adapter: recordingTool(resumed) });

    expect(resumed).toEqual([undefined]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Step "review" starts a new claude session: .*session-b.*team session archive.*session-b/));
  });

  it('reads an archive whose index is damaged without rebuilding or rewriting it', async () => {
    const { config, workspace, runId } = await ranElsewhere(CONTINUED, ['session-a'], ['session-a']);
    const repos = path.join(getReportsDir(config), 'sessions', 'repos');
    const damaged = path.join(repos, fs.readdirSync(repos)[0] ?? '', '_index.json');
    fs.writeFileSync(damaged, '{"sessions": [');
    const resumed: Array<string | undefined> = [];
    const tool = recordingTool(resumed);
    const recorded = tool.run;
    let seen = '';
    // Read as the tool starts: the run's records, published as it ends, rebuild the reports checkout this archive is in.
    tool.run = vi.fn(async (name, input) => {
      seen = fs.readFileSync(damaged, 'utf8');
      return recorded(name, input);
    });

    await runLocalDriver(config, runId, workspace, { adapter: tool });

    expect(resumed).toEqual([undefined]);
    expect(seen).toBe('{"sessions": [');
  });
});

describe('local workflow driver setup', () => {
  const TOKEN = 'setup-token-value-1082';

  async function setupFixture(setup: string, steps: string): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
    const built = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Prepare each new workspace.
setup:
${setup}
steps:
${steps}`);
    fs.writeFileSync(path.join(built.workspace, '.gitignore'), '.npmrc\n.prepared\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: built.workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'ignore'], { cwd: built.workspace });
    vi.stubEnv('SETUP_TOKEN', TOKEN);
    return built;
  }

  function worktrees(workspace: string): string[] {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: workspace, encoding: 'utf8' })
      .split('\n').filter((line) => line.startsWith('worktree ')).slice(1);
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs setup once in the workspace it creates, with its keys, and the steps there never get them', async () => {
    const log = path.join(os.tmpdir(), `teamai-setup-log-${randomUUID()}`);
    dirs.push(log);
    const { config, workspace, runId } = await setupFixture(`  command: test "$SETUP_TOKEN" = setup-token-value-1082 && echo prepared > .prepared && echo ran >> ${log}\n  requires: { env: [SETUP_TOKEN] }`, `  - id: change
    workspace: new
    workflow:
      steps:
        - id: first
          command: test -f .prepared && test -z "$SETUP_TOKEN"
        - id: second
          needs: [first]
          command: test -f .prepared && test -z "$SETUP_TOKEN"
`);
    fs.writeFileSync(log, '');
    const done = await runLocalDriver(config, runId, workspace, { hitl: false });
    expect(done, JSON.stringify(await readRun(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(log, 'utf8')).toBe('ran\n');
  });

  it('runs setup again when a retried step finds the workspace of a copy a step already ran in gone', async () => {
    const log = path.join(os.tmpdir(), `teamai-setup-log-${randomUUID()}`);
    const ready = path.join(os.tmpdir(), `teamai-setup-ready-${randomUUID()}`);
    dirs.push(log, ready);
    const { config, workspace, runId } = await setupFixture(`  command: echo prepared > .prepared && echo ran >> ${log}`, `  - id: change
    workspace: new
    workflow:
      steps:
        - id: first
          command: test -f .prepared
        - id: second
          needs: [first]
          command: test -f .prepared && test -f ${JSON.stringify(ready)}
`);
    fs.writeFileSync(log, '');
    expect(await runLocalDriver(config, runId, workspace, { hitl: false })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    for (const line of worktrees(workspace)) fs.rmSync(line.slice('worktree '.length), { recursive: true, force: true });
    fs.writeFileSync(ready, '');
    expect(await retryStep(config, runId, await knownSecrets(config), 'change.second')).toMatchObject({ data: {} });

    const done = await runLocalDriver(config, runId, workspace, { hitl: false });
    expect(done, JSON.stringify(await readRun(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(log, 'utf8')).toBe('ran\nran\n');
  });

  it.each([
    ['setup_failed', 'echo broken; exit 4'],
    ['setup_dirty', 'echo changed > tracked.txt'],
    ['setup_secret', 'printf "//registry/:_authToken=%s\\n" "$SETUP_TOKEN" > .npmrc'],
  ])('fails %s without running the step, and removes the workspace', async (code, command) => {
    const marker = path.join(os.tmpdir(), `teamai-setup-step-${randomUUID()}`);
    dirs.push(marker);
    const { config, workspace, runId } = await setupFixture(`  command: ${JSON.stringify(command)}\n  requires: { env: [SETUP_TOKEN] }`, `  - id: change
    workspace: new
    command: touch ${JSON.stringify(marker)}
`);
    expect(await runLocalDriver(config, runId, workspace, { hitl: false })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    expect(run).toMatchObject({ steps: [{ id: 'change', status: 'failed', failure: { code } }] });
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    expect(fs.existsSync(marker)).toBe(false);
    expect(worktrees(workspace)).toEqual([]);
  });

  async function slowSetup(maxParallel: number, timeout = ''): Promise<{ config: LocalConfig; workspace: string; runId: string; pidFile: string; marker: string }> {
    const pidFile = path.join(os.tmpdir(), `teamai-setup-pid-${randomUUID()}`);
    const marker = path.join(os.tmpdir(), `teamai-setup-step-${randomUUID()}`);
    dirs.push(pidFile, marker);
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 4000)`;
    const built = await setupFixture(`  command: ${JSON.stringify(`node -e ${JSON.stringify(script)}`)}`, `  - id: change
    workspace: new
    command: touch ${JSON.stringify(marker)}
${timeout}`);
    built.config.workflows = { tools: { default: 'claude' }, max_parallel: maxParallel };
    return { ...built, pidFile, marker };
  }

  async function setupPid(pidFile: string): Promise<number> {
    for (let waited = 0; !fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf8') === ''; waited += 20) {
      if (waited > 10_000) throw new Error('setup did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return Number(fs.readFileSync(pidFile, 'utf8'));
  }

  it.each([1, 2])('stops setup when the run is cancelled while it runs at max_parallel %i, and never runs the step', async (maxParallel) => {
    const { config, workspace, runId, pidFile, marker } = await slowSetup(maxParallel);
    const driving = runLocalDriver(config, runId, workspace, { hitl: false });
    const pid = await setupPid(pidFile);
    const cancelledAt = Date.now();
    expect(await cancelRun(config, runId, await knownSecrets(config))).toMatchObject({ data: { run: { status: 'cancelled' } } });
    expect(await driving).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
    expect(Date.now() - cancelledAt, 'the driver did not wait for setup to finish').toBeLessThan(2500);
    expect(await exitsWithin(pid, 1000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect(fs.existsSync(marker)).toBe(false);
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'change', status: 'cancelled', failure: { code: 'cancelled' } }] });
  });

  it('stops setup on a terminal Ctrl-C at max_parallel 1, before the step command that would get it itself starts', async () => {
    const { config, workspace, runId, pidFile, marker } = await slowSetup(1);
    vi.spyOn(envExec, 'terminalReachesCommand').mockResolvedValue(true);
    const exit = vi.spyOn(envExec, 'exitLike').mockImplementation(() => {});
    const before = new Set(process.listeners('SIGINT'));
    const driving = runLocalDriver(config, runId, workspace, { hitl: false });
    const pid = await setupPid(pidFile);
    const handlers = process.listeners('SIGINT').filter((handler) => !before.has(handler));
    expect(handlers, 'the driver leaves Ctrl-C during setup to the terminal, which does not reach setup').not.toHaveLength(0);
    for (const handler of handlers) handler('SIGINT');

    expect(await driving).toMatchObject({ error: { code: 'interrupted' } });
    expect(exit).toHaveBeenCalledWith({ kind: 'signaled', signal: 'SIGINT' });
    expect(await exitsWithin(pid, 1000)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('stops setup on a terminal Ctrl-C before an interactive tool that would ignore it starts', async () => {
    const pidFile = path.join(os.tmpdir(), `teamai-setup-pid-${randomUUID()}`);
    dirs.push(pidFile);
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 4000)`;
    const { config, workspace, runId } = await setupFixture(`  command: ${JSON.stringify(`node -e ${JSON.stringify(script)}`)}`, `  - id: pair
    workspace: new
    interactive: true
    prompt: Pair with me.
`);
    vi.spyOn(envExec, 'terminalReachesCommand').mockResolvedValue(true);
    const exit = vi.spyOn(envExec, 'exitLike').mockImplementation(() => {});
    const before = new Set(process.listeners('SIGINT'));
    const adapter: LocalToolAdapter = { run: vi.fn(), runInteractive: vi.fn<LocalToolAdapter['runInteractive']>(async () => ({ started: true, exitCode: 0 })) };
    const driving = runLocalDriver(config, runId, workspace, { hitl: true, adapter });
    const pid = await setupPid(pidFile);
    for (const handler of process.listeners('SIGINT')) if (!before.has(handler)) handler('SIGINT');

    expect(await driving).toMatchObject({ error: { code: 'interrupted' } });
    expect(exit).toHaveBeenCalledWith({ kind: 'signaled', signal: 'SIGINT' });
    expect(await exitsWithin(pid, 1000)).toBe(true);
    expect(adapter.runInteractive).not.toHaveBeenCalled();
  });

  it.each([1, 2])('stops setup when the lease passes its timeout at max_parallel %i, and never runs the step', async (maxParallel) => {
    const { config, workspace, runId, pidFile, marker } = await slowSetup(maxParallel, '    timeout: 1s\n');
    const startedAt = Date.now();
    const done = await runLocalDriver(config, runId, workspace, { hitl: false });
    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(Date.now() - startedAt, 'the driver did not wait for setup to finish').toBeLessThan(3500);
    expect(await exitsWithin(await setupPid(pidFile), 1000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect(fs.existsSync(marker)).toBe(false);
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'change', status: 'failed', failure: { code: 'timeout' } }] });
  });

  it.each([1, 2])('does not start a step whose setup finished after its timeout, before the run said so, at max_parallel %i', async (maxParallel) => {
    const marker = path.join(os.tmpdir(), `teamai-setup-step-${randomUUID()}`);
    dirs.push(marker);
    const { config, workspace, runId } = await setupFixture(`  command: ${JSON.stringify('node -e "setTimeout(() => {}, 1500)"')}`, `  - id: change
    workspace: new
    timeout: 1s
    command: touch ${JSON.stringify(marker)}
`);
    config.workflows = { tools: { default: 'claude' }, max_parallel: maxParallel };
    _setDriverPollMs(10_000);
    try {
      expect(await runLocalDriver(config, runId, workspace, { hitl: false })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    } finally {
      _setDriverPollMs(20);
    }
    expect(fs.existsSync(marker)).toBe(false);
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'change', status: 'failed', failure: { code: 'timeout' } }] });
  });
});

describe('local workflow driver staging', () => {
  it.each([1, 2])('does not start a step whose run was cancelled while its workspace was checked out, at max_parallel %i', async (maxParallel) => {
    const marker = path.join(os.tmpdir(), `teamai-staged-step-${randomUUID()}`);
    const checkingOut = path.join(os.tmpdir(), `teamai-checking-out-${randomUUID()}`);
    dirs.push(marker, checkingOut);
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Change the project.
steps:
  - id: change
    workspace: new
    command: touch ${JSON.stringify(marker)}
`);
    // A smudge filter, as Git LFS uses, keeps the checkout busy while the run is cancelled.
    execFileSync('git', ['config', 'filter.slow.smudge', `touch ${JSON.stringify(checkingOut)}; sleep 2; cat`], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, '.gitattributes'), 'slow.txt filter=slow\n');
    fs.writeFileSync(path.join(workspace, 'slow.txt'), 'slow\n');
    execFileSync('git', ['add', '.gitattributes', 'slow.txt'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'slow checkout'], { cwd: workspace });
    config.workflows = { tools: { default: 'claude' }, max_parallel: maxParallel };
    const driving = runLocalDriver(config, runId, workspace, { hitl: false });
    for (let waited = 0; !fs.existsSync(checkingOut); waited += 20) {
      if (waited > 10_000) throw new Error('checkout did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await cancelRun(config, runId, await knownSecrets(config))).toMatchObject({ data: { run: { status: 'cancelled' } } });
    expect(await driving).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
    expect(fs.existsSync(marker)).toBe(false);
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'change', status: 'cancelled', failure: { code: 'cancelled' } }] });
  });
});
