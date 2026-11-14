import { z } from 'zod';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { claudeFake } from '@teamai/tool-claude/testing';
import { fakeAgent, type FakeAgent } from '@teamai/tool-testing/fake-agent';
import { launchEnv, sessionRun } from '../launch-context.js';
import { loadStateForScope, saveStateForScope } from '../config.js';
import { checkoutRecordKey, type CheckoutRecord } from '../pull.js';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { type LocalConfig, type TeamaiConfig } from '../types.js';
import type { JsonValue } from '@teamai/shared/json';
import { log } from '@teamai/shared/log';
import { type StepLauncher, type StepRunResult, type StepRun, type ToolSpawn } from '@teamai/runtime-tools';
import { hostLauncher } from './helpers/host-launcher.js';
import { saveToolHomes } from '../tool-home.js';
import { getUserHome } from '@teamai/shared/home';
import { INSTANCE_BASES, useToolInstances } from '../tool-registry.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { type WorkflowRunRecord } from '../workflow/records.js';
import { attemptDir, AttemptIdSchema, attemptResultPath, readRun, RunIdSchema } from '../workflow/store.js';
import { recordGroup } from '@teamai/shared/process-group';
import { attemptRuntimePath, attemptToolHome, readAttemptPlacement, recordInProcessAttempt } from '../workflow/runtimes/attempt.js';
import { homeEnvOf, openDriver } from '../workflow/runtimes/sources.js';
import { personalDir } from '../workflow/runtimes/layers.js';
import { cancelRun } from '../workflow/run-controls.js';
import { stdioStepRuntime } from '../workflow/runtimes/stdio.js';
import type { DriverRuntimes } from '../workflow/drivers/local/local-driver.js';
import { knownSecrets } from '../env-resolution.js';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import { leaseNext, startRun } from '../workflow/engine.js';
import { driverIdentity } from '../driver-identity.js';
import { TOY_RUNTIME } from './helpers/toy-runtime.js';
import { commitFile, fakeClaude, git, recordDelivery } from './helpers/delivered-checkout.js';
import { dirs, endRecord, fixture, memberAiTool, projectAiTool, toolPaths, workflowFixture } from './helpers/workflow-local-driver-fixture.js';

_setDriverPollMs(20);

const fakeAgents: FakeAgent[] = [];

afterEach(async () => {
  const left = (await Promise.all(fakeAgents.splice(0).map((agent) => agent.stopLeft()))).flat();

  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  expect(left, 'fake agents left running').toEqual([]);
});

/** Claude as its recorded call prints it, in a `bin` beside `workspace`, keeping its sessions under a home of its own. */
function claudeBeside(workspace: string, options: Omit<Parameters<typeof fakeAgent>[1], 'bin'>): FakeAgent {
  vi.stubEnv('HOME', path.join(path.dirname(workspace), 'home'));
  const agent = fakeAgent(claudeFake, { bin: path.join(path.dirname(workspace), 'bin'), ...options });
  fakeAgents.push(agent);

  return agent;
}
describe('local workflow prompt driver', () => {
  it('runs a prompt with a private result path and stores metadata', async () => {
    const { config, workspace, runId } = await fixture();
    let input: StepRun | undefined;
    const adapter: StepLauncher = {
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

  it('launches the tool without the marker of a Claude session teamai itself runs in, which turns the tool\'s transcript off', async () => {
    const { config, workspace, runId } = await fixture();
    vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1');
    let input: StepRun | undefined;
    const adapter: StepLauncher = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_tool, value) => {
        input = value;
        return { started: true as const, exitCode: 0, output: { ok: true }, session: 'session-1' };
      }),
    };

    expect(await runLocalDriver(config, runId, workspace, { adapter, toolPaths })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    expect(input?.env).toBeDefined();
    expect(input?.env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION');
  });

  it('records how long the tool ran and the cost it stated, and neither for a tool that never started', async () => {
    const ran = await fixture();
    const unstarted = await fixture();
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { started: true as const, exitCode: 0, output: { ok: true }, cost: { amount: 0.25, unit: 'USD' } };
    }) };

    await runLocalDriver(ran.config, ran.runId, ran.workspace, { adapter, toolPaths });
    await runLocalDriver(unstarted.config, unstarted.runId, unstarted.workspace, { adapter: hostLauncher(undefined, () => null), toolPaths });

    const stored = await readRun(ran.config, ran.runId);
    const step = typeof stored === 'object' && stored.steps[0]?.status === 'succeeded' ? stored.steps[0] : undefined;
    expect(step).toMatchObject({ cost: { amount: 0.25, unit: 'USD' }, durationMs: expect.any(Number) });
    expect(step?.durationMs).toBeGreaterThanOrEqual(50);
    const never = await readRun(unstarted.config, unstarted.runId);
    expect(typeof never === 'object' && never.steps[0]).toMatchObject({ status: 'failed', failure: { code: 'tool_unavailable' } });
    expect(typeof never === 'object' && never.steps[0]).not.toHaveProperty('durationMs');
  });

  it.each([
    [{}, 'attended'],
    [{ CI: '1' }, 'unattended'],
  ])('launches the tool with the run mode of the process that drives the run: %o gives %s', async (env, mode) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await fixture();
    let input: StepRun | undefined;
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn(async (_tool, value) => {
      input = value;
      return { started: true as const, exitCode: 0 };
    }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(input?.env?.TEAMAI_MODE).toBe(mode);
    // What the launched session's hook records (#1384), and the pass's own record of the mode it ran in.
    expect(sessionRun({ ...input?.env, ...input?.launchEnv })).toEqual({ runMode: mode, launchedBy: 'workflow' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ runMode: mode }] });
  });

  // Every tool an instance may extend: one added without the variable its own launch reads its home from fails here.
  it.each(INSTANCE_BASES.map((base) => ({ base, name: `acme-${base}`, variable: ({ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' } as Record<string, string>)[base] })))(
    'launches $name, an instance of $base with only a home of its own, with $variable at that home', async ({ base, name, variable }) => {
    expect(variable).toBeDefined();
    vi.stubEnv(variable!, path.join(os.tmpdir(), 'member-moved-home'));
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await fixture();
    useToolInstances(new Map([[name, {
      kind: 'instance', name, extends: base, home: { dir: `.${name}` },
      source: 'personal', file: `/home/.teamai/tools/${name}.yaml`, location: `~/.teamai/tools/${name}.yaml`, revision: 'r1',
    }]]));
    onTestFinished(() => { useToolInstances(new Map()); });
    let launched: { tool: string; input: StepRun } | undefined;
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn(async (tool: string, input: StepRun) => {
      launched = { tool, input };
      return { started: true as const, exitCode: 0 };
    }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths, tools: { default: name } });

    expect(launched?.tool).toBe(base);
    expect(launched?.input.instance?.command).toBeUndefined();
    expect(launched?.input.env?.[variable!]).toBe(path.join(getUserHome(), `.${name}`));
  });

  // With no command of its own the instance runs stock Codex, which reads only CODEX_HOME, so that is set to its home too.
  it.each([
    { case: 'names its own, as the member set it', own: { home: { dir: '.acme-codex', env: 'ACME_CODEX_HOME' } }, shell: true, acme: 'acme-moved', codex: 'acme-moved' },
    // A pull recorded the home the variable named, and teamai delivers there from a shell without it, so the build reads it too.
    { case: 'names its own, at the home recorded for it from a shell without it', own: { home: { dir: '.acme-codex', env: 'ACME_CODEX_HOME' } }, shell: false, acme: 'acme-recorded', codex: 'acme-recorded' },
    // Its project paths are Codex's, which stock Codex reads in a project whatever its home; its user paths are in its home.
    { case: 'keeps the project paths of Codex and its user paths in its home', own: { home: { dir: '.acme-codex' }, paths: { skills: '.codex/skills', userScope: { skills: '.acme-codex/skills' } } }, shell: true, acme: 'acme-moved', codex: '~/.acme-codex' },
  ])('starts an instance that $case, with CODEX_HOME at $codex', async ({ own, shell, acme, codex }) => {
    const { config, workspace, runId } = await fixture();
    const recorded = path.join(getUserHome(), 'acme-recorded');
    if (shell) vi.stubEnv('ACME_CODEX_HOME', path.join(os.tmpdir(), 'acme-moved'));
    else await saveToolHomes({ 'acme-codex': recorded });
    fs.mkdirSync(recorded, { recursive: true });
    vi.stubEnv('CODEX_HOME', path.join(os.tmpdir(), 'member-codex'));
    onTestFinished(async () => { vi.unstubAllEnvs(); await saveToolHomes({}); });
    useToolInstances(new Map([['acme-codex', {
      kind: 'instance', name: 'acme-codex', extends: 'codex', ...own,
      source: 'personal', file: '/home/.teamai/tools/acme-codex.yaml', location: '~/.teamai/tools/acme-codex.yaml', revision: 'r1',
    }]]));
    onTestFinished(() => { useToolInstances(new Map()); });
    let input: StepRun | undefined;
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn(async (_tool, value) => {
      input = value;
      return { started: true as const, exitCode: 0 };
    }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths, tools: { default: 'acme-codex' } });

    const at = (dir: string): string => dir === 'acme-recorded' ? path.join(getUserHome(), dir) : dir.startsWith('~/') ? path.join(getUserHome(), dir.slice(2)) : path.join(os.tmpdir(), dir);

    expect(input?.env?.ACME_CODEX_HOME).toBe(at(acme));
    expect({ ...process.env, ...input?.env }.CODEX_HOME).toBe(at(codex));
  });

  it.each([
    // A pull recorded the home the variable named, and teamai delivers there from a shell without it, as a confined run reads it.
    { case: 'at the home recorded for it from a shell without its variable', shell: undefined, home: 'codebuddy-recorded' },
    // Delivery puts the recorded home first, so the step reads where teamai delivered and doctor names the shell's.
    { case: 'at the home recorded for it, over the variable of the shell, as delivery', shell: 'codebuddy-shell', home: 'codebuddy-recorded' },
    { case: 'at the home its variable names in a shell with no home recorded', shell: 'codebuddy-shell', home: 'codebuddy-shell', unrecorded: true },
  ])('starts a shipped tool $case', async ({ shell, home, unrecorded }) => {
    const { config, workspace, runId } = await fixture();
    const at = (dir: string): string => dir === 'codebuddy-recorded' ? path.join(getUserHome(), dir) : path.join(os.tmpdir(), dir);
    await saveToolHomes(unrecorded ? {} : { codebuddy: at('codebuddy-recorded') });
    fs.mkdirSync(at('codebuddy-recorded'), { recursive: true });
    vi.stubEnv('CODEBUDDY_CONFIG_DIR', shell === undefined ? undefined : at(shell));
    onTestFinished(async () => { vi.unstubAllEnvs(); await saveToolHomes({}); });
    let input: StepRun | undefined;
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn(async (_tool, value) => {
      input = value;
      return { started: true as const, exitCode: 0 };
    }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths, tools: { default: 'codebuddy' } });

    expect({ ...process.env, ...input?.env }.CODEBUDDY_CONFIG_DIR).toBe(at(home));
  });

  it.each([
    // init recorded CODEX_HOME as the Codex root, and teamai delivers and trusts there from any shell.
    { case: 'Codex at the root init recorded, from a shell without CODEX_HOME', tool: 'codex', shell: undefined },
    { case: 'Codex at the root init recorded, over the CODEX_HOME of the shell, as delivery', tool: 'codex', shell: 'codex-shell' },
    { case: 'an instance that keeps the home of Codex at the root init recorded for Codex', tool: 'acme-codex', shell: undefined },
  ])('starts $case', async ({ tool, shell }) => {
    const recorded = path.join(getUserHome(), '.codex-work');
    vi.stubEnv('CODEX_HOME', shell === undefined ? undefined : path.join(getUserHome(), shell));
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await fixture();
    fs.mkdirSync(recorded, { recursive: true });
    config.toolRoots = { codex: recorded };
    useToolInstances(new Map([['acme-codex', {
      kind: 'instance', name: 'acme-codex', extends: 'codex',
      source: 'personal', file: '/home/.teamai/tools/acme-codex.yaml', location: '~/.teamai/tools/acme-codex.yaml', revision: 'r1',
    }]]));
    onTestFinished(() => { useToolInstances(new Map()); });
    let input: StepRun | undefined;
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn(async (_tool: string, value: StepRun) => {
      input = value;
      return { started: true as const, exitCode: 0 };
    }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths, tools: { default: tool } });

    expect({ ...process.env, ...input?.env }.CODEX_HOME).toBe(recorded);
  });

  // The record wins even once its directory is gone, and delivery then skips the tool (toolGateRoot): a step does not start it elsewhere.
  it.each([
    { case: 'Codex at the root init recorded', tool: 'codex', variable: 'CODEX_HOME', gone: '.codex-gone' },
    { case: 'an instance at the home recorded for its own variable', tool: 'acme-codex', variable: 'ACME_CODEX_HOME', gone: '.acme-gone' },
    { case: 'CodeBuddy at the home recorded for its variable', tool: 'codebuddy', variable: 'CODEBUDDY_CONFIG_DIR', gone: '.codebuddy-gone' },
  ])('does not start $case once that directory is gone, and says how to fix it', async ({ tool, variable, gone }) => {
    const dir = path.join(getUserHome(), gone);
    const { config, workspace, runId } = await fixture();
    if (tool === 'codex') config.toolRoots = { codex: dir };
    else await saveToolHomes({ [tool]: dir });
    useToolInstances(new Map([['acme-codex', {
      kind: 'instance', name: 'acme-codex', extends: 'codex', home: { dir: '.acme-codex', env: 'ACME_CODEX_HOME' },
      source: 'personal', file: '/home/.teamai/tools/acme-codex.yaml', location: '~/.teamai/tools/acme-codex.yaml', revision: 'r1',
    }]]));
    onTestFinished(async () => { useToolInstances(new Map()); await saveToolHomes({}); });
    const run = vi.fn(async () => ({ started: true as const, exitCode: 0 }));

    await runLocalDriver(config, runId, workspace, { adapter: { runInteractive: vi.fn(), run }, toolPaths, tools: { default: tool } });

    expect(run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ status: 'failed', failure: {
      code: 'tool_unavailable',
      message: `The ${tool} home recorded on this machine, ${dir}, does not exist, so teamai did not start ${tool} there. `
        + `Point ${variable} at the home ${tool} uses and re-run \`teamai init\`, or clear the record with \`${variable}= teamai init\`.`,
    } }] });
  });

  it.each<{ case: string; flags: Record<string, string>; configured: Record<string, string>; env: string; project?: string; machine?: string; ran: string }>([
    { case: 'TEAMAI_AI_TOOL over workflows.tools.default', flags: {}, configured: { default: 'claude' }, env: 'codex', ran: 'codex' },
    { case: '--tools over TEAMAI_AI_TOOL', flags: { default: 'claude' }, configured: {}, env: 'codex', ran: 'claude' },
    { case: "workflows.tools.default over the project's ai.tool", flags: {}, configured: { default: 'codex' }, env: '', project: 'opencode', machine: 'claude', ran: 'codex' },
    { case: "the project's ai.tool over the machine's", flags: {}, configured: {}, env: '', project: 'codex', machine: 'opencode', ran: 'codex' },
    { case: "the machine's ai.tool when nothing else names a tool", flags: {}, configured: {}, env: '', machine: 'opencode', ran: 'opencode' },
    { case: "the machine's ai.tool when the project's names a tool without workflow steps", flags: {}, configured: {}, env: '', project: 'pi', machine: 'opencode', ran: 'opencode' },
    { case: 'the next rung when TEAMAI_AI_TOOL names a tool without workflow steps', flags: {}, configured: { default: 'claude' }, env: 'openclaw', ran: 'claude' },
  ])('runs a prompt step on $case', async ({ flags, configured, env, project, machine, ran }) => {
    vi.stubEnv('TEAMAI_AI_TOOL', env);
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await fixture();
    config.workflows = { tools: configured };
    if (project) projectAiTool(config, project);
    if (machine) memberAiTool(machine);
    const tools: string[] = [];
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn(async (tool: string) => { tools.push(tool); return { started: true as const, exitCode: 0 }; }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths, tools: flags });

    expect(tools).toEqual([ran]);
  });

  it('runs a prompt step on the tool it names, over --tools, workflows.tools and TEAMAI_AI_TOOL', async () => {
    vi.stubEnv('TEAMAI_AI_TOOL', 'opencode');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt: Review this project.
    tool: claude
`);
    onTestFinished(fakeClaude(path.dirname(workspace), '2.1.301'));
    config.workflows = { tools: { default: 'codex' } };
    const tools: string[] = [];
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn(async (tool: string) => { tools.push(tool); return { started: true as const, exitCode: 0 }; }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths, tools: { default: 'codex' } });

    expect(tools).toEqual(['claude']);
  });

  it("fails a prompt step when the project's ai.tool names a tool teamai does not launch, naming its file", async () => {
    vi.stubEnv('TEAMAI_AI_TOOL', '');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await fixture();
    config.workflows = { tools: {} };
    const file = projectAiTool(config, 'gemini');
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn() };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ failure: { code: 'tool_unsupported', message: expect.stringContaining(`ai.tool in the workspace config ${file} is "gemini", which is not a tool teamai launches.`) } }],
    });
  });

  it('fails a prompt step when TEAMAI_AI_TOOL names a tool teamai does not launch', async () => {
    vi.stubEnv('TEAMAI_AI_TOOL', 'gemini');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await fixture();
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn() };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ failure: { code: 'tool_unsupported', message: expect.stringContaining('TEAMAI_AI_TOOL is "gemini", which is not a tool teamai launches.') } }],
    });
  });

  it('fails without a configured tool and does not invoke the adapter', async () => {
    const { config, workspace, runId } = await fixture();
    config.workflows = undefined;
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn() };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ failure: { code: 'tool_unconfigured' } }],
    });
  });

  it('fails before spawn when a deployed agent is missing', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn() };

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
    let input: StepRun | undefined;
    const adapter: StepLauncher = {
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
    let input: StepRun | undefined;
    const adapter: StepLauncher = {
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
    const adapter: StepLauncher = {
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
    const adapter: StepLauncher = {
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
    const adapter: StepLauncher = {
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
    const adapter: StepLauncher = {
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
    const adapter: StepLauncher = {
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
    let input: StepRun | undefined;
    const adapter: StepLauncher = {
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

  it('launches a step after a from step on the tool its agent maps to, as it did before teamai checked that tool', async () => {
    const definition = { schemaVersion: 'v1alpha1', name: 'generated', description: 'Say hello.', steps: [{ id: 'hello', command: 'true' }] };
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Run what plan brings, then review.
steps:
  - id: plan
    command: printf '%s' '${JSON.stringify({ definition: { definition }, plan: {} })}'
    output: { definition: workflow, plan: json }
  - id: work
    needs: [plan]
    workflow: { from: plan }
  - id: review
    needs: [work]
    prompt: Review this project.
    agent: reviewer
    output:
      ok: boolean
`);
    config.workflows = { tools: { reviewer: 'codex-internal' } };
    const agents = path.join(workspace, '.codex-internal/agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'reviewer.toml'), 'name = "reviewer"\ndescription = "Reviews changes."\ndeveloper_instructions = "Review the change."\n');
    const adapter: StepLauncher = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => ({ started: true as const, exitCode: 0, output: { ok: true } })),
    };

    const ran = await runLocalDriver(config, runId, workspace, {
      adapter,
      toolPaths: { ...toolPaths, 'codex-internal': { agents: '.codex-internal/agents' } } as TeamaiConfig['toolPaths'],
    });

    expect(ran).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(adapter.run).toHaveBeenCalledWith('codex-internal', expect.anything(), expect.any(AbortSignal));
  });

  it('loads a user-scope OpenCode agent from the home XDG_CONFIG_HOME moves', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    const xdg = path.join(path.dirname(workspace), 'xdg');
    vi.stubEnv('HOME', path.join(path.dirname(workspace), 'home'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    fs.mkdirSync(path.join(xdg, 'opencode', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'opencode', 'agents', 'reviewer.md'), '---\ndescription: Reviews changes.\nmode: subagent\n---\n\nReview the change.\n');
    const userConfig: LocalConfig = { ...config, scope: 'user', workflows: { tools: { reviewer: 'opencode' } } };
    let input: StepRun | undefined;
    const adapter: StepLauncher = {
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
    const adapter: StepLauncher = {
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
    const adapter: StepLauncher = {
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

  it('removes the git locks a timed-out tool left in its worktree, and names the ones it left in the member\'s checkout', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Change the project.
steps:
  - id: change
    workspace: new
    prompt: Change this project.
`);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const ref = path.join(workspace, '.git', 'refs', 'heads', 'main.lock');
    let own = '';
    const adapter: StepLauncher = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_tool, input) => {
        own = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'], { cwd: input.cwd, encoding: 'utf8' }).trim();
        fs.writeFileSync(own, '');
        fs.writeFileSync(ref, '');

        return { started: true as const, exitCode: 143, stoppedBy: 'timeout' as const };
      }),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(own).toContain(path.join('.git', 'worktrees'));
    expect([fs.existsSync(own), fs.existsSync(ref)]).toEqual([false, true]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`rm '${ref}'`));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(own));
  });

  it('keeps the git locks a tool stopped at its step\'s deadline left in the member\'s checkout, and names them with the command that removes them', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt: Review this project.
    timeout: 1s
    output:
      ok: boolean
`);
    const lock = path.join(workspace, '.git', 'index.lock');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const adapter: StepLauncher = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_tool, input, signal) => {
        fs.writeFileSync(path.join(input.cwd, '.git', 'index.lock'), '');
        await new Promise((resolve) => { signal?.addEventListener('abort', resolve, { once: true }); });

        return { started: true as const, exitCode: 143 };
      }),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(fs.existsSync(lock)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`rm '${lock}'`));
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ status: 'failed', failure: { code: 'timeout' } }] });
  });

  it('publishes the failure code it sets when the tool is not on PATH', async () => {
    const { config, workspace, runId } = await fixture();

    await runLocalDriver(config, runId, workspace, { adapter: hostLauncher(undefined, () => null), toolPaths });

    expect(await endRecord(config)).toMatchObject({ status: 'failed', failure: { code: 'tool_unavailable' } });
  });

  it('runs a headless Claude prompt step on a member\'s own definition that lists only the tools runtime', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt: Review this project.
    budget: { tokens: 5 }
    on_limit: end_turn
    output:
      ok: boolean
`);
    // The tool writes its result, then streams a message that spends 12 input and 3 output tokens, past the step's
    // budget of 5, and goes on.
    const claude = claudeBeside(workspace, { before: `
      const resultPath = [prompt, ...args].join(' ').match(/as JSON to (\\S+)\\. /)[1];
      fs.writeFileSync(resultPath, JSON.stringify({ output: { ok: true } }));
      await say(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-over', model: 'claude-sonnet-4-5' }));
      await say(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'message-1', usage: { input_tokens: 12, output_tokens: 3 } } } }));
      return hang();
    ` });
    fs.mkdirSync(personalDir('drivers'), { recursive: true });
    onTestFinished(() => fs.rmSync(personalDir('drivers'), { recursive: true, force: true }));
    fs.writeFileSync(path.join(personalDir('drivers'), 'mine.yaml'), 'schemaVersion: v1alpha1\nname: mine\nruntimes:\n  - use: tools\n');
    const opened = await openDriver(config, 'mine', { personal: true, mode: 'attended', canAsk: false, purpose: 'run', checkout: workspace });
    if (!opened.ok) throw new Error(opened.failure.message);

    const done = await runLocalDriver(config, runId, workspace, {
      adapter: hostLauncher(undefined, () => claude.executable), toolPaths, runtimes: { driver: 'mine', asked: 'mine', runtimes: opened.opened.runtimes },
    });

    expect(claude.calls()).toHaveLength(1);
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'review', status: 'succeeded', tool: 'claude', outputs: { ok: true }, session: 'session-over', tokens: { input: 12, output: 3 }, limit: 'budget' }] });
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('records each step on a [tools] definition by what it ran: a command and an answer on the host, a prompt on tools', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: A command, an answer and a prompt.
steps:
  - id: build
    command: node -e "process.exit(0)"
  - id: ask
    needs: [build]
    answer: Name one color.
    output: { color: string }
  - id: review
    needs: [ask]
    prompt: Review this project.
    output:
      ok: boolean
`);
    vi.stubEnv('TEAMAI_AI_TOOL', '');
    const claude = claudeBeside(workspace, { answer: '{"ok":true}', answers: [{ when: 'Name one color', answer: '{"color":"red"}' }] });
    fs.mkdirSync(personalDir('drivers'), { recursive: true });
    onTestFinished(() => fs.rmSync(personalDir('drivers'), { recursive: true, force: true }));
    fs.writeFileSync(path.join(personalDir('drivers'), 'mine.yaml'), 'schemaVersion: v1alpha1\nname: mine\nruntimes:\n  - use: tools\n');
    const opened = await openDriver(config, 'mine', { personal: true, mode: 'attended', canAsk: false, purpose: 'run', checkout: workspace });
    if (!opened.ok) throw new Error(opened.failure.message);

    const done = await runLocalDriver(config, runId, workspace, {
      adapter: hostLauncher(undefined, () => claude.executable), toolPaths, resolveTool: (command) => (command === 'claude' ? claude.executable : null),
      runtimes: { driver: 'mine', asked: 'mine', runtimes: opened.opened.runtimes },
    });

    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'build', status: 'succeeded', runtime: 'host' },
      { id: 'ask', status: 'succeeded', outputs: { color: 'red' }, runtime: 'host' },
      { id: 'review', status: 'succeeded', runtime: 'tools' },
    ] });
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('stops a Claude prompt step that prints nothing for workflows.idle_timeout, and fails it naming the limit', async () => {
    const { config, workspace, runId } = await fixture();
    config.workflows = { tools: { default: 'claude' }, idle_timeout: '1s' };
    const claude = claudeBeside(workspace, { always: ['hang'] });
    const started = Date.now();

    await runLocalDriver(config, runId, workspace, { adapter: hostLauncher(undefined, () => claude.executable), toolPaths });

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ id: 'review', status: 'failed', failure: { code: 'tool_failed', message: 'claude printed nothing for 1s, longer than its idle limit (workflows.idle_timeout). Raise the limit if this tool works silently for longer.' } }],
    });
  });

  it('keeps a Claude prompt step that streams for longer than the idle limit but never stays silent that long', async () => {
    const { config, workspace, runId } = await fixture();
    // The fake prints three lines, each after a pause of half the limit: it streams for one and a half limits, and a
    // pause would have to double under load before the limit stops it.
    const idleMs = 2000;
    config.workflows = { tools: { default: 'claude' }, idle_timeout: `${idleMs / 1000}s` };
    const claude = claudeBeside(workspace, { answer: '{"ok":true}', always: ['slow'], slowMs: idleMs / 2 });

    await runLocalDriver(config, runId, workspace, { adapter: hostLauncher(undefined, () => claude.executable), toolPaths });

    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'review', status: 'succeeded', outputs: { ok: true } }] });
  });

  it('refuses an idle limit that is no duration before it launches the prompt step\'s tool, naming the setting to fix', async () => {
    const { config, workspace, runId } = await fixture();
    config.workflows = { tools: { default: 'claude' }, idle_timeout: 'soon' };
    const claude = claudeBeside(workspace, { answer: '{"ok":true}' });

    await runLocalDriver(config, runId, workspace, { adapter: hostLauncher(undefined, () => claude.executable), toolPaths });

    expect(claude.calls()).toEqual([]);
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ id: 'review', status: 'failed', failure: { code: 'tool_unconfigured', message: 'workflows.idle_timeout is "soon", which is no duration. Set it to one, such as 2m, or remove it.' } }],
    });
  });

  it('reads only the result its own tool wrote when it runs again an attempt whose tool a killed driver left, which wrote one as it was stopped', async () => {
    const { config, workspace, runId } = await fixture();
    config.workflows = { tools: { default: 'claude' } };
    const leased = await leaseNext(config, runId, driverIdentity('local', workspace));
    if (!('data' in leased)) throw new Error(leased.error.message);
    const run = RunIdSchema.parse(runId);
    const attempt = AttemptIdSchema.parse((leased.data.lease as { attempt: string }).attempt);
    // What the killed driver left: its tool, still running in the attempt's process group, which writes a result as it stops.
    const result = attemptResultPath(config, run, attempt);
    fs.mkdirSync(path.dirname(result), { recursive: true });
    const left = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify({ output: { ok: true } })); process.exit(0); }); setInterval(() => {}, 1000); process.stdout.write('up');`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((resolve) => left.stdout.once('data', resolve));
    recordGroup(left, attemptDir(config, run, attempt));
    onTestFinished(() => { left.kill('SIGKILL'); });
    // The tool this driver starts ends without a result.
    const claude = claudeBeside(workspace, { before: 'process.exit(0);' });

    await runLocalDriver(config, runId, workspace, { adapter: hostLauncher(undefined, () => claude.executable), toolPaths });

    expect(claude.calls()).toHaveLength(1);
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'review', status: 'failed', failure: { code: 'tool_failed', message: 'claude did not write a valid workflow result' } }] });
  });

  it('publishes no failure code the tool wrote into its result', async () => {
    const { config, workspace, runId } = await fixture();
    const claude = claudeBeside(workspace, {
      before: 'fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ failure: { code: "secret-x", message: "secret-x happened" } }));',
    });

    await runLocalDriver(config, runId, workspace, { adapter: hostLauncher(undefined, () => claude.executable), toolPaths });

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
    const wf = await workflowFixture(yaml);
    const team = wf.config.repo.localPath;
    git(team, 'init', '-q');
    const rev = commitFile(team, 'agents/reviewer.yaml');
    const skill = path.join(wf.workspace, '.claude', 'skills', 'review', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, 'Review carefully.\n');
    const agentFile = path.join(wf.workspace, reviewer[tool].file);
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, reviewer[tool].content);
    wf.config.workflows = { tools: { default: tool } };
    await recordDelivery(wf.config, {
      rev: rev.slice(0, 7),
      targets: [tool],
      files: [skill, agentFile],
      agentModels: { reviewer: { [tool]: { step: 'spec', model: reviewer[tool].model } } },
      ...record,
    });
    restore.push(fakeClaude(path.dirname(wf.workspace), '2.1.301'));
    return { ...wf, rev, skill, agentFile };
  }

  const reviewStep = (agent?: string) => `schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt: Review this project.
${agent ? `    agent: ${agent}\n` : ''}`;

  const reports = (result: Partial<Extract<StepRunResult, { started: true }>> = {}): StepLauncher => ({
    runInteractive: vi.fn(),
    run: vi.fn(async () => ({ started: true as const, exitCode: 0, ...result })),
  });
  const codexToolPaths = { codex: { agents: '.codex/agents' } } satisfies TeamaiConfig['toolPaths'];

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
    const loading = (workspace: string, { main, subagent, earlier }: { main: string; subagent: string; earlier?: string }, during = () => {}): StepLauncher => ({
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
    let input: StepRun | undefined;
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn(async (_tool, value) => {
      input = value;
      return { started: true as const, exitCode: 0 };
    }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(input?.launchEnv).toEqual(launchEnv({ by: 'workflow', tool: 'claude', checkout: String(await checkoutRecordKey(config)) }));
  });

  it('publishes the --model a Codex launch passed as the requested model', async () => {
    const { config, workspace, runId } = await observed(reviewStep('reviewer'), { tool: 'codex' });
    let argv: string[] = [];
    const codex: ToolSpawn = (_command, args, options) => {
      argv = args;
      return spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, "{}")'], options);
    };

    await runLocalDriver(config, runId, workspace, { adapter: hostLauncher(codex, () => process.execPath), toolPaths: codexToolPaths });

    expect(argv).toEqual(expect.arrayContaining(['--model', 'gpt-5.4']));
    expect((await entry(config))?.agent).toMatchObject({
      definition: { name: 'reviewer', applied: 'prompt' },
      tool: { name: 'codex' },
      model: { requested: argv[argv.indexOf('--model') + 1] },
    });
  });

  it('publishes an OpenCode pass with the handoff its launch used and the model and variant of its file it passed', async () => {
    const opencodeToolPaths = { opencode: { agents: '.opencode/agents' } } satisfies TeamaiConfig['toolPaths'];
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

    await runLocalDriver(config, runId, workspace, { adapter: hostLauncher(undefined, () => null), toolPaths });

    expect((await entry(config))?.agent).toEqual({ definition: { name: 'reviewer' } });
  });

  it('gives each pass a loop ran its own agent', async () => {
    const { config, workspace, runId } = await observed(`${reviewStep('reviewer')}    loop: { back_to: review, while: "length(steps.review.passes) < 3", max_iterations: 3 }
`);
    let pass = 0;
    const adapter: StepLauncher = { runInteractive: vi.fn(), run: vi.fn(async () => ({ started: true as const, exitCode: 0, model: `claude-model-${++pass}` })) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    const published = (await endRecord(config))?.steps ?? [];
    expect(published.map((step) => [step.pass, step.agent && 'model' in step.agent ? step.agent.model?.reported : undefined])).toEqual([
      [1, 'claude-model-1'],
      [2, 'claude-model-2'],
      [3, 'claude-model-3'],
    ]);
  });
});

describe('progress lines on the local driver', () => {
  it('shows each line a command writes to stderr as it writes it, and answers them, masked, with the run\'s end', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Say what it does.
steps:
  - id: say
    command: printf 'Found 2 entries.\\nUsing ' >&2; sleep 0.1; echo "$DEPLOY_TOKEN" >&2
    requires: { env: [DEPLOY_TOKEN] }
`);
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: DEPLOY_TOKEN\n');
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-secret-value');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const shown: string[] = [];

    const done = await runLocalDriver(config, runId, workspace, { hitl: false, progress: (line) => { shown.push(line); } });

    expect(shown).toEqual(['Found 2 entries.', 'Using <REDACTED:DEPLOY_TOKEN>']);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', progress: [{ step: 'say', lines: shown }] } } });
  });

  it('keeps the last lines a command writes to stdout that are not its outputs, masked, in its attempt\'s directory, names that file, and publishes none of them', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Say what it did.
steps:
  - id: say
    command: echo "built 3 files"; echo "with $DEPLOY_TOKEN"
    requires: { env: [DEPLOY_TOKEN] }
  - id: emit
    needs: [say]
    command: echo '{"count":3}'
`);
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: DEPLOY_TOKEN\n');
    // A key over two lines, as a PEM key is, is masked whole.
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-secret-value\nits-second-line');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    onTestFinished(() => { info.mockRestore(); });

    const done = await runLocalDriver(config, runId, workspace, { hitl: false });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, RunIdSchema.parse(runId));
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    const attemptOf = (id: string) => {
      const step = run.steps.find((one) => one.id === id);

      return AttemptIdSchema.parse(step && 'attempt' in step ? step.attempt : undefined);
    };
    const kept = path.join(attemptDir(config, RunIdSchema.parse(runId), attemptOf('say')), 'stdout.log');
    expect(fs.readFileSync(kept, 'utf8')).toBe('built 3 files\nwith <REDACTED:DEPLOY_TOKEN>\n');
    expect(fs.existsSync(path.join(attemptDir(config, RunIdSchema.parse(runId), attemptOf('emit')), 'stdout.log'))).toBe(false);
    expect(info.mock.calls.flat().filter((line) => String(line).includes('stdout'))).toEqual([`Step "say" printed text on stdout, which is not its outputs: its last lines are in ${kept}.`]);
    expect(JSON.stringify(await endRecord(config))).not.toContain('built 3 files');
  });
});

describe('a prompt runtime that runs each tool on the attempt\'s tool home', () => {
  it('offers a runtime on the attempt\'s tool home only the tools a tool home holds, so a step on another fails before it is leased there', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    tool: opencode
    prompt: Review this project.
    output:
      ok: boolean
`);
    const state = path.join(path.dirname(workspace), 'toy-state');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    onTestFinished(() => runtime.dispose());
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, can: { tools: ['claude', 'opencode'] }, agent: { output: { ok: true } }, prompt_tool_home: true }, mode: 'unattended' });
    if (!ready.ok) throw new Error(ready.failure.message);
    const runtimes: DriverRuntimes = {
      driver: 'toy', asked: 'toy',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, ...(ready.runsOnToolHome && { runsOnToolHome: true }), engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };

    await runLocalDriver(config, runId, workspace, { runtimes });

    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'review', status: 'failed', failure: { code: 'tool_unavailable' } }] });
  }, 30_000);

  it('gives each place the attempt\'s tool home, and resumes a session.from step from the earlier one\'s session seeded there', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Two steps of one session.
steps:
  - id: one
    prompt: Plan the change.
    output:
      ok: boolean
  - id: two
    needs: [one]
    session:
      from: one
    prompt: Make the change you planned.
    output:
      ok: boolean
`);
    const state = path.join(path.dirname(workspace), 'toy-state');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    onTestFinished(() => runtime.dispose());
    const ready = await runtime.init({ options: { state, agent: { output: { ok: true }, transcript: true, conversations: false }, prompt_tool_home: true }, mode: 'unattended', homeEnv: homeEnvOf([]) });
    if (!ready.ok) throw new Error(ready.failure.message);
    const runtimes: DriverRuntimes = {
      driver: 'toy', asked: 'toy',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, ...(ready.runsOnToolHome && { runsOnToolHome: true }), engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };

    expect(await runLocalDriver(config, runId, workspace, { runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    // The toy names each place `toy-<run>-<attempt>`, and keeps the view each was opened with.
    const homes = fs.readdirSync(path.join(state, 'views')).map((name) => {
      const attempt = AttemptIdSchema.parse(name.slice(`toy-${runId}-`.length, -'.json'.length));
      const view = z.object({ toolHome: z.record(z.string(), z.string()) }).parse(JSON.parse(fs.readFileSync(path.join(state, 'views', name), 'utf8')));

      return { attempt, given: view.toolHome.CLAUDE_CONFIG_DIR, home: attemptToolHome(config, RunIdSchema.parse(runId), attempt, 'claude') };
    });
    const run = await readRun(config, runId);
    if (typeof run === 'string') throw new Error(run);
    const [one, two] = run.steps;
    const session = one && 'session' in one ? String(one.session) : '';
    const transcript = (home: string): boolean => fs.existsSync(path.join(home, 'projects', encodeCwdClaude(fs.realpathSync(workspace)), `${session}.jsonl`));

    expect(homes).toHaveLength(2);
    for (const { given, home } of homes) expect(given).toBe(home);
    // Step one's agent kept its session in its attempt's home; step two's home was seeded with it and resumed it there.
    expect(homes.every(({ home }) => transcript(home))).toBe(true);
    expect(two).toMatchObject({ status: 'succeeded', resumed: { tool: 'claude', id: session } });
  }, 30_000);

  it('gives an instance that names its own home variable the attempt\'s tool home under that variable and under its tool\'s', async () => {
    useToolInstances(new Map([['acme-claude', {
      kind: 'instance', name: 'acme-claude', extends: 'claude', home: { dir: '.acme-claude', env: 'ACME_CLAUDE_HOME' },
      source: 'personal', file: '/home/.teamai/tools/acme-claude.yaml', location: '~/.teamai/tools/acme-claude.yaml', revision: 'r1',
    }]]));
    onTestFinished(() => { useToolInstances(new Map()); });
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    tool: acme-claude
    prompt: Review this project.
    output:
      ok: boolean
`);
    const state = path.join(path.dirname(workspace), 'toy-state');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    onTestFinished(() => runtime.dispose());
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, can: { tools: ['acme-claude'] }, agent: { output: { ok: true } }, prompt_tool_home: true }, mode: 'unattended' });
    if (!ready.ok) throw new Error(ready.failure.message);
    const runtimes: DriverRuntimes = {
      driver: 'toy', asked: 'toy',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, ...(ready.runsOnToolHome && { runsOnToolHome: true }), engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };

    expect(await runLocalDriver(config, runId, workspace, { runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const [view] = fs.readdirSync(path.join(state, 'views'));
    const attempt = AttemptIdSchema.parse(view?.slice(`toy-${runId}-`.length, -'.json'.length));
    const home = attemptToolHome(config, RunIdSchema.parse(runId), attempt, 'acme-claude');
    expect(JSON.parse(fs.readFileSync(path.join(state, 'views', view ?? ''), 'utf8'))).toMatchObject({ toolHome: { CLAUDE_CONFIG_DIR: home, ACME_CLAUDE_HOME: home } });
  }, 30_000);

  it('holds a Claude prompt to its budget on a runtime that runs it in the attempt\'s tool home, and lists the budget as enforced', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: One budgeted step.
steps:
  - id: review
    tool: claude
    prompt: Review this project.
    budget: { tokens: 1000 }
    on_limit: end_turn
    output:
      ok: boolean
`);
    const state = path.join(path.dirname(workspace), 'toy-state');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    onTestFinished(() => runtime.dispose());
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, agent: { output: { ok: true }, usage: { input: 300, output: 100 }, conversations: false }, prompt_tool_home: true, can: { end_turn: true } }, mode: 'unattended' });
    if (!ready.ok) throw new Error(ready.failure.message);
    const runtimes: DriverRuntimes = {
      driver: 'toy', asked: 'toy',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, ...(ready.runsOnToolHome && { runsOnToolHome: true }), engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };

    await runLocalDriver(config, runId, workspace, { runtimes });
    const run = await readRun(config, runId);
    if (typeof run === 'string') throw new Error(run);
    const sent = fs.readFileSync(path.join(state, 'prompts.jsonl'), 'utf8').trim().split('\n')
      .map((line) => z.object({ sent: z.object({ limits: z.unknown() }).partial().optional() }).parse(JSON.parse(line)).sent)
      .filter((lease) => lease !== undefined);

    expect(sent).toEqual([expect.objectContaining({ limits: expect.objectContaining({ budget: { tokens: 1000 } }) })]);
    expect(run.steps[0]).toMatchObject({ id: 'review', status: 'succeeded' });
    expect(run.steps[0]).not.toHaveProperty('unenforced');
  }, 30_000);

  it('fails a budgeted step whose runtime offers tokens and read none for it, with the runtime\'s reason', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: One budgeted step.
budget: { tokens: 1000 }
steps:
  - id: review
    tool: claude
    prompt: Review this project.
    output:
      ok: boolean
`);
    const state = path.join(path.dirname(workspace), 'toy-state');
    const why = { cause: 'teamai cannot read /home/al/.claude/projects/-repo because it has no permission to read it.', next: 'Let the user teamai runs as read it, then retry the step.' };
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    onTestFinished(() => runtime.dispose());
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, agent: { output: { ok: true }, unmeasured: why, conversations: false }, prompt_tool_home: true, can: { tokens: true } }, mode: 'unattended' });
    if (!ready.ok) throw new Error(ready.failure.message);
    const runtimes: DriverRuntimes = {
      driver: 'toy', asked: 'toy',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, ...(ready.runsOnToolHome && { runsOnToolHome: true }), engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };

    await runLocalDriver(config, runId, workspace, { runtimes });

    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'review', status: 'failed', failure: { code: 'budget_unmeasured', message: expect.stringContaining(`read none for it, so the budget cannot count what it spent: ${why.cause} ${why.next}`) } }] });
  }, 30_000);

  it('tells the person why it has no tokens for an unbudgeted step whose runtime read none, without calling for a retry of a step that succeeded', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: One step under no budget.
steps:
  - id: review
    tool: claude
    prompt: Review this project.
    output:
      ok: boolean
`);
    const state = path.join(path.dirname(workspace), 'toy-state');
    const cause = 'teamai cannot read /home/al/.claude/projects/-repo because it has no permission to read it.';
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    onTestFinished(() => runtime.dispose());
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, agent: { output: { ok: true }, unmeasured: { cause, next: 'Let the user teamai runs as read it, then retry the step.' }, conversations: false }, prompt_tool_home: true, can: { tokens: true } }, mode: 'unattended' });
    if (!ready.ok) throw new Error(ready.failure.message);
    const runtimes: DriverRuntimes = {
      driver: 'toy', asked: 'toy',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, ...(ready.runsOnToolHome && { runsOnToolHome: true }), engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    await runLocalDriver(config, runId, workspace, { runtimes });

    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'review', status: 'succeeded' }] });
    expect(warn.mock.calls).toEqual([[`teamai did not measure the tokens of step "review": ${cause}`]]);
  }, 30_000);

  it('sends an agent step the definition\'s instructions in its prompt and the definition\'s model, since the runtime starts the tool without --agent', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: One reviewer step.
steps:
  - id: review
    tool: claude
    agent: reviewer
    prompt: Review this project.
    output:
      ok: boolean
`);
    fs.mkdirSync(path.join(workspace, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews changes.\nmodel: claude-opus-4-1\n---\nFollow the review checklist.\n');
    const state = path.join(path.dirname(workspace), 'toy-state');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    onTestFinished(() => runtime.dispose());
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, agent: { output: { ok: true }, conversations: false }, prompt_tool_home: true }, mode: 'unattended' });
    if (!ready.ok) throw new Error(ready.failure.message);
    const runtimes: DriverRuntimes = {
      driver: 'toy', asked: 'toy',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, ...(ready.runsOnToolHome && { runsOnToolHome: true }), engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };

    await runLocalDriver(config, runId, workspace, { runtimes, toolPaths });
    const sent = fs.readFileSync(path.join(state, 'prompts.jsonl'), 'utf8').trim().split('\n')
      .map((line) => z.object({ sent: z.object({ prompt: z.string(), model: z.unknown() }).partial().optional() }).parse(JSON.parse(line)).sent)
      .filter((lease) => lease !== undefined);

    expect(sent).toEqual([expect.objectContaining({ prompt: expect.stringContaining('Follow the review checklist.'), model: { name: 'claude-opus-4-1' } })]);
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'review', status: 'succeeded' }] });
  }, 30_000);

  it('leases it no step on a tool whose sessions teamai does not read in a tool home, even one it lists', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: One OpenCode step.
steps:
  - id: one
    tool: opencode
    prompt: Plan the change.
    output:
      ok: boolean
`);
    const state = path.join(path.dirname(workspace), 'toy-state');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    onTestFinished(() => runtime.dispose());
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, agent: { output: { ok: true }, conversations: false }, prompt_tool_home: true, can: { tools: ['claude', 'opencode'] } }, mode: 'unattended' });
    if (!ready.ok) throw new Error(ready.failure.message);
    const runtimes: DriverRuntimes = {
      driver: 'toy', asked: 'toy',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, ...(ready.runsOnToolHome && { runsOnToolHome: true }), engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };

    await runLocalDriver(config, runId, workspace, { runtimes });
    const run = await readRun(config, runId);
    if (typeof run === 'string') throw new Error(run);

    // It never reached the runtime: the step found no slot that runs OpenCode, rather than a runtime that cannot read its session.
    expect(fs.existsSync(path.join(state, 'prompts.jsonl'))).toBe(false);
    expect(run.steps[0]).not.toMatchObject({ failure: { code: 'tool_unsupported' } });
    expect(run.steps[0]).toMatchObject({ status: 'failed' });
  }, 30_000);
});

describe('an answer step on the host slot', () => {
  const ASK = `schemaVersion: v1alpha1
name: build
description: Ask, then review.
steps:
  - id: ask
    answer: Name one color.
    output: { color: string }
  - id: review
    needs: [ask]
    prompt: Review this project.
    output:
      ok: boolean
`;

  it('answers an answer step here on a definition of an external runtime, which is sent only the prompt step', async () => {
    const { config, workspace, runId } = await workflowFixture(ASK);
    vi.stubEnv('TEAMAI_AI_TOOL', '');
    const claude = claudeBeside(workspace, { answers: [{ when: 'Name one color', answer: '{"color":"red"}' }] });
    const state = path.join(path.dirname(workspace), 'toy-state');
    const calls = path.join(path.dirname(workspace), 'toy-calls.jsonl');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    onTestFinished(() => runtime.dispose());
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, calls, agent: { output: { ok: true }, transcript: true } }, mode: 'unattended' });
    if (!ready.ok) throw new Error(ready.failure.message);
    const runtimes: DriverRuntimes = {
      driver: 'toy', asked: 'toy',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };

    expect(await runLocalDriver(config, runId, workspace, { runtimes, resolveTool: (command) => (command === 'claude' ? claude.executable : null) })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const prompted = fs.readFileSync(path.join(state, 'prompts.jsonl'), 'utf8').trim().split('\n')
      .map((line) => z.object({ sent: z.object({ step: z.string() }).optional() }).parse(JSON.parse(line)).sent?.step);
    expect(prompted.filter((step) => step !== undefined)).toEqual(['review']);
    expect(claude.calls()).toHaveLength(1);
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'ask', status: 'succeeded', outputs: { color: 'red' }, runtime: 'host' },
      { id: 'review', status: 'succeeded', runtime: 'toy' },
    ] });
  }, 30_000);

  it('answers on the tool TEAMAI_AI_TOOL names over ai.tool, and on ai.tool without it', async () => {
    const ask = async (env: string): Promise<unknown> => {
      const { config, workspace, runId } = await workflowFixture(ASK.replace(/  - id: review[\s\S]*$/u, ''));
      vi.stubEnv('TEAMAI_AI_TOOL', env);
      const claude = claudeBeside(workspace, { answers: [{ when: 'Name one color', answer: '{"color":"red"}' }] });
      memberAiTool('codex');
      await runLocalDriver(config, runId, workspace, { resolveTool: (command) => (command === 'claude' ? claude.executable : null) });
      const run = await readRun(config, runId);

      return typeof run === 'string' ? run : run.steps[0];
    };

    expect(await ask('claude')).toMatchObject({ status: 'succeeded', outputs: { color: 'red' }, tool: 'claude' });
    expect(await ask('')).toMatchObject({ status: 'failed', failure: { code: 'tool_unconfigured', message: expect.stringContaining('ai.tool in the machine config') } });
  });

  it('refuses at start an answer step under a strict sandbox in defaults.requires, which this machine does not keep', async () => {
    const { config } = await workflowFixture(ASK);
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'build.yaml'), ASK.replace('steps:\n', 'defaults:\n  requires: { isolation: sandbox, strict: true }\nsteps:\n'));
    await syncScorersThenWorkflows(config);

    expect(await startRun(config, 'build', {}, { secrets: await knownSecrets(config), alone: { driver: 'local', offers: [{ runtime: 'tools', can: { isolation: 'worktree', network: true, env: true } }] } }))
      .toMatchObject({ error: { code: 'requirement_unmet', message: 'Step "ask" requires strict isolation, and the local driver here is not a sandbox. Run it in CI or a container, and declare it with --sandbox or workflows.sandbox: true.' } });
  });

  it('refuses at start a strict answer step on a sandbox definition, saying it runs only on this machine\'s tools runtime', async () => {
    const { config } = await workflowFixture(ASK);
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'build.yaml'), ASK.replace('steps:\n', 'defaults:\n  requires: { isolation: sandbox, strict: true }\nsteps:\n'));
    await syncScorersThenWorkflows(config);
    const offers = [
      { runtime: 'sandbox', can: { isolation: 'sandbox', network: true, env: true, remote: true } },
      { runtime: 'tools', inProcess: true, can: { isolation: 'worktree', network: true, env: true } },
    ] as const;

    expect(await startRun(config, 'build', {}, { secrets: await knownSecrets(config), alone: { driver: 'teamai-sandbox', offers: [...offers] } }))
      .toMatchObject({ error: { code: 'requirement_unmet', message: 'Step "ask" requires strict isolation, and it runs only on this machine, on runtime tools of driver "teamai-sandbox", which is not a sandbox. Run the workflow in CI or a container with --sandbox.' } });
  });
});

describe('a prompt a runtime stopped at the idle limit', () => {
  it('fails as a tool teamai stopped for the same silence fails, with no limit to end at', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt: Review this project.
    output:
      ok: boolean
`);
    config.workflows = { tools: { default: 'claude' }, idle_timeout: '1s' };
    const state = path.join(path.dirname(workspace), 'toy-state');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    onTestFinished(() => runtime.dispose());
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, agent: { output: { ok: true }, stopped: 'idle' } }, mode: 'unattended' });
    if (!ready.ok) throw new Error(ready.failure.message);
    const runtimes: DriverRuntimes = {
      driver: 'mine', asked: 'mine',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };

    await runLocalDriver(config, runId, workspace, { toolPaths, runtimes });

    // The same record as "stops a Claude prompt step that prints nothing for workflows.idle_timeout" above, where
    // teamai's own launch stopped the tool.
    const run = await readRun(config, runId);
    expect(run).toMatchObject({
      steps: [{ id: 'review', status: 'failed', failure: { code: 'tool_failed', message: 'claude printed nothing for 1s, longer than its idle limit (workflows.idle_timeout). Raise the limit if this tool works silently for longer.' } }],
    });
    expect(typeof run === 'string' ? undefined : run.steps[0]).not.toHaveProperty('stoppedBy');
  }, 30_000);
});

describe('the runtime a step on the local driver records', () => {
  it('names the host for a command step when the loop is given no definition, as on teamai-local', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Build the project.
steps:
  - id: build
    command: node -e "process.exit(0)"
`);

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'build', status: 'succeeded', runtime: 'host' }] });
  });
});

describe('the record of an attempt in teamai\'s process', () => {
  it('names what ran, tools for a prompt and host for a command, on a definition that writes local', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Build, then review the project.
steps:
  - id: build
    command: node -e "process.exit(0)"
  - id: review
    needs: [build]
    prompt: Review this project.
    output:
      ok: boolean
`);
    const claude = claudeBeside(workspace, { answer: '{"ok":true}' });
    fs.mkdirSync(personalDir('drivers'), { recursive: true });
    onTestFinished(() => fs.rmSync(personalDir('drivers'), { recursive: true, force: true }));
    fs.writeFileSync(path.join(personalDir('drivers'), 'mine.yaml'), 'schemaVersion: v1alpha1\nname: mine\nruntimes:\n  - use: local\n');
    const opened = await openDriver(config, 'mine', { personal: true, mode: 'attended', canAsk: false, purpose: 'run', checkout: workspace });
    if (!opened.ok) throw new Error(opened.failure.message);

    expect(await runLocalDriver(config, runId, workspace, { adapter: hostLauncher(undefined, () => claude.executable), toolPaths, runtimes: { driver: 'mine', asked: 'mine', runtimes: opened.opened.runtimes } }))
      .toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const run = await readRun(config, runId);
    if (typeof run === 'string') throw new Error(run);
    const placements = await Promise.all(run.steps.map(async (step) => [step.id, await readAttemptPlacement(config, RunIdSchema.parse(runId), AttemptIdSchema.parse(step.status === 'succeeded' ? step.attempt : undefined))]));
    expect(placements).toEqual([['build', { kind: 'in_process', runtime: 'host' }], ['review', { kind: 'in_process', runtime: 'tools' }]]);
  }, 30_000);
});

describe('a fleet wake option that names an in-process runtime', () => {
  it.each(['local', 'tools'])('refuses %s as it refuses every runtime in teamai\'s own process, whatever its name', async (use) => {
    const { config, workspace } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Build the project.
steps:
  - id: build
    command: node -e "process.exit(0)"
`);
    fs.mkdirSync(personalDir('drivers'), { recursive: true });
    onTestFinished(() => fs.rmSync(personalDir('drivers'), { recursive: true, force: true }));
    fs.writeFileSync(path.join(personalDir('drivers'), 'pool.yaml'), `schemaVersion: v1alpha1\nname: pool\nruntimes:\n  - use: fleet\n    options:\n      pool: gpu\n      wake:\n        use: ${use}\n`);

    const opened = await openDriver(config, 'pool', { personal: true, mode: 'unattended', canAsk: false, purpose: 'run', checkout: workspace });

    expect(opened).toMatchObject({ ok: false, failure: { message: expect.stringContaining(`${use} runs in teamai's own process and wakes no fleet member`) } });
  });
});

describe('the driver a run on --driver local remembers', () => {
  it('remembers none, so a resume opens local again and says which teamai-local it took', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Build the project.
steps:
  - id: build
    command: node -e "process.exit(0)"
`);
    const opened = await openDriver(config, 'local', { personal: true, mode: 'attended', canAsk: false, purpose: 'run', checkout: workspace });
    if (!opened.ok) throw new Error(opened.failure.message);

    expect(await runLocalDriver(config, runId, workspace, { runtimes: { driver: opened.opened.driver.name, asked: opened.opened.asked, runtimes: opened.opened.runtimes } }))
      .toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const run = await readRun(config, runId);
    expect(typeof run === 'string' ? run : run.driveOptions?.driver).toBeUndefined();
  });
});

describe('a step an earlier driver leased in teamai\'s process', () => {
  it.each([
    { recorded: 'in_process', toolsFirst: false, goesTo: 'tools' },
    { recorded: 'none', toolsFirst: false, goesTo: 'toy' },
    { recorded: 'unreadable', toolsFirst: true, goesTo: 'toy' },
  ] as const)('with a record $recorded, goes back to $goesTo of a definition that lists tools first: $toolsFirst', async ({ recorded, toolsFirst, goesTo }) => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt: Review this project.
    output:
      ok: boolean
`);
    const claude = claudeBeside(workspace, { answer: '{"ok":true}' });
    const state = path.join(path.dirname(workspace), 'toy-state');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    onTestFinished(() => runtime.dispose());
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, agent: { output: { ok: true } } }, mode: 'unattended' });
    if (!ready.ok) throw new Error(ready.failure.message);
    fs.mkdirSync(personalDir('drivers'), { recursive: true });
    onTestFinished(() => fs.rmSync(personalDir('drivers'), { recursive: true, force: true }));
    fs.writeFileSync(path.join(personalDir('drivers'), 'mine.yaml'), 'schemaVersion: v1alpha1\nname: mine\nruntimes:\n  - use: tools\n');
    const opened = await openDriver(config, 'mine', { personal: true, mode: 'attended', canAsk: false, purpose: 'run', checkout: workspace });
    if (!opened.ok) throw new Error(opened.failure.message);
    // The earlier driver leased the prompt in its own process and recorded it there, then was killed. Without that record,
    // as when the file was lost, nothing says the attempt ran here, so it starts on the first runtime, as a new lease would.
    const leased = await leaseNext(config, runId, driverIdentity('local', workspace));
    expect(leased).toMatchObject({ data: { lease: { step: 'review' } } });
    const leasedRun = await readRun(config, runId);
    const leasedStep = typeof leasedRun === 'string' ? undefined : leasedRun.steps[0];
    const attempt = AttemptIdSchema.parse(leasedStep?.status === 'leased' ? leasedStep.lease.attempt : undefined);
    if (recorded === 'in_process') await recordInProcessAttempt(config, RunIdSchema.parse(runId), attempt, { runtime: 'tools', driver: 'mine' });

    // A record that cannot be read says nothing of where the attempt ran, so it is not taken as one in teamai's process,
    // which an external runtime may still be running.
    if (recorded === 'unreadable') {
      fs.mkdirSync(path.dirname(attemptRuntimePath(config, RunIdSchema.parse(runId), attempt)), { recursive: true });
      fs.writeFileSync(attemptRuntimePath(config, RunIdSchema.parse(runId), attempt), '{"runtime": "to');
    }

    const toy: DriverRuntimes['runtimes'][number] = { kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' };
    const [first, ...rest] = opened.opened.runtimes;
    const runtimes: DriverRuntimes = { driver: 'mine', asked: 'mine', runtimes: toolsFirst ? [first, ...rest, toy] : [toy, first, ...rest] };

    expect(await runLocalDriver(config, runId, workspace, { adapter: hostLauncher(undefined, () => claude.executable), toolPaths, runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    // On tools the member's Claude ran it here and the toy was sent no prompt; on the toy, the reverse.
    expect(claude.calls()).toHaveLength(goesTo === 'tools' ? 1 : 0);
    const toyPrompts = fs.existsSync(path.join(state, 'prompts.jsonl')) ? fs.readFileSync(path.join(state, 'prompts.jsonl'), 'utf8') : '';
    expect(toyPrompts.includes('"review"')).toBe(goesTo === 'toy');
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'review', status: 'succeeded' }] });
  }, 30_000);
});

describe('a place held open for a conversation a later step continues', () => {
  /** What the toy was asked, in order: each request's type, operation and handle, and each prompt lease's continue. */
  // A request the toy logged to `calls`, and a prompt it was sent, as it appends them to `prompts.jsonl`.
  const AskedSchema = z.object({ type: z.string(), op: z.string().optional(), handle: z.string().optional() });
  type Asked = z.infer<typeof AskedSchema>;
  const ContinueSchema = z.object({ handle: z.string(), op: z.string() });
  const SentSchema = z.object({ op: z.string(), sent: z.object({ step: z.string(), continue: ContinueSchema.optional() }).optional() });

  const toyDriver = async (dir: string, { maxParallel, can = {}, release, conversations }: { maxParallel?: number; can?: Record<string, JsonValue>; release?: string; conversations?: false } = {}) => {
    const state = path.join(dir, 'toy-state');
    const calls = path.join(dir, 'toy-calls.jsonl');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    const agent = { output: { ok: true }, transcript: true, home: path.join(dir, 'toy-claude'), ...(release !== undefined && { release }), ...(conversations === false && { conversations }) };
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, calls, agent, can }, mode: 'unattended' });
    onTestFinished(() => runtime.dispose());

    if (!ready.ok) throw new Error(`toy did not start: ${ready.failure.message}`);
    const runtimes: DriverRuntimes = {
      driver: 'toy', asked: 'toy',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, ...(ready.keepsConversations && { keepsConversations: true }), engine: { logins: [], ...(maxParallel !== undefined && { maxParallel }) }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };

    const asked = (): Asked[] => fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => AskedSchema.parse(JSON.parse(line)));
    const leases = (): Array<{ op: string; step: string; continue?: z.infer<typeof ContinueSchema> }> => fs.readFileSync(path.join(state, 'prompts.jsonl'), 'utf8').trim().split('\n')
      .map((line) => SentSchema.parse(JSON.parse(line)))
      .flatMap(({ op, sent }) => (sent ? [{ op, step: sent.step, ...(sent.continue && { continue: sent.continue }) }] : []));

    return { runtimes, asked, leases };
  };

  /** The prompt of `step` the toy was sent, and the place it ran in. */
  const promptOf = (asked: Asked[], leases: ReturnType<Awaited<ReturnType<typeof toyDriver>>['leases']>, step: string) => {
    const lease = leases.find((sent) => sent.step === step);
    const prompt = asked.find((call) => call.type === 'prompt' && call.op === lease?.op);

    if (!lease || !prompt?.handle) throw new Error(`no prompt of ${step}: ${JSON.stringify(asked)}`);

    return { ...lease, handle: prompt.handle, at: asked.indexOf(prompt) };
  };

  const closedAt = (asked: Asked[], handle: string): number => asked.findIndex((call) => call.type === 'close' && call.handle === handle);

  const PAIR = `schemaVersion: v1alpha1
name: build
description: Two steps of one conversation.
steps:
  - id: one
    prompt: Plan the change.
    output:
      ok: boolean
  - id: two
    needs: [one]
    session:
      from: one
    prompt: Make the change you planned.
    output:
      ok: boolean
`;

  /** `workflow`'s steps inside a \`workflow\` step \`change\` that opens a workspace they all work in. */
  const inOneWorkspace = (workflow: string): string => {
    const [header = '', steps = ''] = workflow.split('steps:\n');

    return `${header}steps:\n  - id: change\n    workspace: new\n    workflow:\n      steps:\n${steps.replace(/^(?=.)/gmu, '      ')}`;
  };

  it('closes step one\'s place at its report when step two, a top-level step, gets a place of its own', async () => {
    const { config, workspace, runId } = await workflowFixture(PAIR);
    const toy = await toyDriver(path.dirname(workspace));

    expect(await runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const asked = toy.asked();
    const one = promptOf(asked, toy.leases(), 'one');
    const two = promptOf(asked, toy.leases(), 'two');
    expect(two.continue).toBeUndefined();
    expect(closedAt(asked, one.handle)).toBeGreaterThan(-1);
    expect(closedAt(asked, one.handle)).toBeLessThan(two.at);
  }, 30_000);

  it('keeps step one\'s place open until step two reports, and step two\'s lease continues its conversation', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(PAIR));
    const toy = await toyDriver(path.dirname(workspace));

    expect(await runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const asked = toy.asked();
    const one = promptOf(asked, toy.leases(), 'change.one');
    const two = promptOf(asked, toy.leases(), 'change.two');
    expect(two.continue).toEqual({ handle: one.handle, op: one.op });
    expect(closedAt(asked, one.handle)).toBeGreaterThan(two.at);
    // Step two's own place closes once its report is recorded; step one's, which held the conversation, only after it.
    expect(closedAt(asked, one.handle)).toBeGreaterThan(closedAt(asked, two.handle));
    expect(closedAt(asked, two.handle)).toBeGreaterThan(two.at);
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run was not stored');
    const sessionOf = (id: string) => { const step = run.steps.find((item) => item.id === id); return step && 'session' in step ? step.session : undefined; };
    expect(run.steps.find((step) => step.id === 'change.two')).toMatchObject({ resumed: { tool: 'claude', id: sessionOf('change.one') } });
  }, 30_000);

  it('holds no place on a runtime that launches agents but keeps no conversation, and step two resumes the session instead', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(PAIR));
    const toy = await toyDriver(path.dirname(workspace), { conversations: false });

    expect(await runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const asked = toy.asked();
    const one = promptOf(asked, toy.leases(), 'change.one');
    const two = promptOf(asked, toy.leases(), 'change.two');
    expect(two.continue).toBeUndefined();
    expect(closedAt(asked, one.handle)).toBeGreaterThan(-1);
    expect(closedAt(asked, one.handle)).toBeLessThan(two.at);
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run was not stored');
    const sessionOf = (id: string) => { const step = run.steps.find((item) => item.id === id); return step && 'session' in step ? step.session : undefined; };
    expect(run.steps.find((step) => step.id === 'change.two')).toMatchObject({ resumed: { tool: 'claude', id: sessionOf('change.one') } });
  }, 30_000);

  it('names no held conversation in the lease of a step with a workspace of its own, while that conversation is held for another step', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Step one's conversation goes on in step two; a step between them works in a copy of its own.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: one
          prompt: Plan the change.
          output:
            ok: boolean
        - id: aside
          needs: [one]
          workspace: new
          session:
            from: one
          prompt: Try the change on its own.
          output:
            ok: boolean
        - id: two
          needs: [aside]
          session:
            from: one
          prompt: Make the change you planned.
          output:
            ok: boolean
`);
    const toy = await toyDriver(path.dirname(workspace));

    expect(await runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const asked = toy.asked();
    const one = promptOf(asked, toy.leases(), 'change.one');
    const aside = promptOf(asked, toy.leases(), 'change.aside');
    const two = promptOf(asked, toy.leases(), 'change.two');
    // Step one's place is held while aside runs, since step two goes on in its conversation; aside's lease names none.
    expect(closedAt(asked, one.handle)).toBeGreaterThan(aside.at);
    expect(aside.continue).toBeUndefined();
    expect(two.continue).toEqual({ handle: one.handle, op: one.op });
  }, 30_000);

  it('records a held place it closed as closed, held for no conversation any more', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(PAIR));
    const toy = await toyDriver(path.dirname(workspace));

    expect(await runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run was not stored');
    const one = run.steps.find((step) => step.id === 'change.one');
    const attempt = AttemptIdSchema.parse(one && 'attempt' in one ? one.attempt : undefined);
    const placement = await readAttemptPlacement(config, RunIdSchema.parse(runId), attempt);
    expect(placement).toMatchObject({ kind: 'external', record: { phase: 'closed' } });
    expect(placement.kind === 'external' && placement.record).not.toHaveProperty('heldFor');
  }, 30_000);

  it('names the conversation\'s first step in the lease of every later step of a chain', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(`${PAIR}  - id: three
    needs: [two]
    session:
      from: two
    prompt: Test the change.
    output:
      ok: boolean
`));
    const toy = await toyDriver(path.dirname(workspace));

    expect(await runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const asked = toy.asked();
    const one = promptOf(asked, toy.leases(), 'change.one');
    const three = promptOf(asked, toy.leases(), 'change.three');
    expect(three.continue).toEqual({ handle: one.handle, op: one.op });
    expect(closedAt(asked, one.handle)).toBeGreaterThan(three.at);
  }, 30_000);

  it('keeps a pass\'s place open for the next pass of a step with session: continue, which goes on in its conversation', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(`schemaVersion: v1alpha1
name: build
description: A step that goes on in its own conversation each pass.
steps:
  - id: make
    session: continue
    prompt: Make the change, or improve it.
    output:
      ok: boolean
    loop: { back_to: make, while: steps.make.outputs.ok, max_iterations: 2 }
`));
    const toy = await toyDriver(path.dirname(workspace));

    await runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes });

    const asked = toy.asked();
    const [first, second, ...more] = toy.leases().filter((sent) => sent.step === 'change.make').map((sent) => promptOf(asked, [sent], 'change.make'));
    if (!first || !second || more.length > 0) throw new Error(`make did not run twice: ${JSON.stringify(toy.leases())}`);
    expect(second.continue).toEqual({ handle: first.handle, op: first.op });
    expect(closedAt(asked, first.handle)).toBeGreaterThan(second.at);
  }, 30_000);

  it('gives step two room under max_parallel: 1 while step one\'s place is held', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(PAIR));
    const toy = await toyDriver(path.dirname(workspace), { maxParallel: 1 });

    expect(await runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(promptOf(toy.asked(), toy.leases(), 'change.two').continue).toBeDefined();
  }, 30_000);

  it('closes step one\'s place at the run\'s end after the teamai that held it stopped between the two reports', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(PAIR.replace('    needs: [one]\n', '    needs: [go]\n').replace('  - id: two\n', '  - id: go\n    needs: [one]\n    choose: { message: Go on?, options: [yes, no] }\n  - id: two\n')));
    const dir = path.dirname(workspace);
    const before = await toyDriver(dir);
    // Nobody answers the gate after step one, so this teamai stops with step one's place held.
    const unanswered = async (): Promise<string> => { throw new Error('closed'); };

    expect(await runLocalDriver(config, runId, workspace, { runtimes: before.runtimes, hitl: true, question: unanswered })).toMatchObject({ error: { code: 'interrupted' } });
    const one = promptOf(before.asked(), before.leases(), 'change.one');
    expect(closedAt(before.asked(), one.handle)).toBe(-1);

    const after = await toyDriver(dir);
    expect(await runLocalDriver(config, runId, workspace, { runtimes: after.runtimes, hitl: true, question: async () => 'yes' })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const asked = after.asked();
    const two = promptOf(asked, after.leases(), 'change.two');
    expect(two.continue).toEqual({ handle: one.handle, op: one.op });
    expect(closedAt(asked, one.handle)).toBeGreaterThan(two.at);
  }, 30_000);

  it('closes step one\'s held place when the run is cancelled while step two runs', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(PAIR));
    const dir = path.dirname(workspace);
    // Step one's agent finishes at once; step two's works until the run is cancelled.
    fs.writeFileSync(path.join(dir, 'release-change.one'), '');
    const toy = await toyDriver(dir, { release: path.join(dir, 'release-{step}') });
    const driving = runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes });

    for (let waited = 0; !fs.existsSync(path.join(dir, 'toy-state', 'prompts.jsonl')) || !toy.leases().some((lease) => lease.step === 'change.two'); waited += 20) {
      if (waited > 20_000) throw new Error('step two was not sent');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(await cancelRun(config, runId, await knownSecrets(config))).toMatchObject({ data: { run: { status: 'cancelled' } } });
    expect(await driving).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
    const one = promptOf(toy.asked(), toy.leases(), 'change.one');
    expect(closedAt(toy.asked(), one.handle)).toBeGreaterThan(-1);
  }, 30_000);

  it('lets step one\'s place close at the report of a step that continues its session on another runtime', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(PAIR.replace('    prompt: Make the change you planned.\n', '    prompt: Make the change you planned.\n    tool: codex\n')));
    const toy = await toyDriver(path.dirname(workspace), { can: { tools: ['claude'] } });
    const local = { kind: 'tools' as const, use: 'tools' as const, engine: { logins: [] } };
    const adapter: StepLauncher = {
      run: async () => ({ started: true, exitCode: 0, session: 'codex-session', output: { ok: true } }),
      runInteractive: async () => ({ started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'not interactive' } }),
    };

    expect(await runLocalDriver(config, runId, workspace, { adapter, runtimes: { ...toy.runtimes, runtimes: [...toy.runtimes.runtimes, local] } })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const asked = toy.asked();
    const one = promptOf(asked, toy.leases(), 'change.one');
    expect(toy.leases().map((lease) => lease.step)).toEqual(['change.one']);
    expect(closedAt(asked, one.handle)).toBeGreaterThan(-1);
  }, 30_000);
});

describe('the built-in host driver, whose only runtime is the host slot', () => {
  const onHost = async (config: LocalConfig, workspace: string): Promise<DriverRuntimes> => {
    const opened = await openDriver(config, 'host', { personal: true, mode: 'attended', canAsk: false, purpose: 'run', checkout: workspace });
    if (!opened.ok) throw new Error(opened.failure.message);

    return { driver: opened.opened.driver.name, asked: opened.opened.asked, runtimes: opened.opened.runtimes };
  };

  it('runs commands and a gate on the host slot, and records host as the driver and the runtime of each step', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Build, then ship.
steps:
  - id: build
    command: node -e "process.exit(0)"
  - id: ship
    needs: [build]
    approve: { message: Ship the build? }
    command: node -e "process.exit(0)"
`);
    const asked: string[] = [];

    expect(await runLocalDriver(config, runId, workspace, { runtimes: await onHost(config, workspace), hitl: true, question: async (hitl) => { asked.push(hitl.step); return 'yes'; } }))
      .toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(asked).toEqual(['ship']);
    expect(await readRun(config, runId)).toMatchObject({ driveOptions: { driver: 'host' }, steps: [{ id: 'build', status: 'succeeded', runtime: 'host' }, { id: 'ship', status: 'succeeded', runtime: 'host' }] });
  });

  it('fails an answer step, which asks the member\'s AI tool, naming it and --driver local, and launches no tool', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Ask.
steps:
  - id: ask
    answer: Name one color.
    output: { color: string }
`);
    const adapter: StepLauncher = {
      run: async () => { throw new Error('no tool may launch on host'); },
      runInteractive: async () => { throw new Error('no tool may launch on host'); },
    };

    expect(await runLocalDriver(config, runId, workspace, { adapter, runtimes: await onHost(config, workspace) })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'ask', status: 'failed', failure: {
      code: 'requirement_unmet',
      message: 'Step "ask" is an answer step, which asks your AI tool, and driver "host" launches no AI tool: it runs only commands, gates and workflows whose steps need none. Run the workflow with --driver local.',
    } }] });
  });
});
