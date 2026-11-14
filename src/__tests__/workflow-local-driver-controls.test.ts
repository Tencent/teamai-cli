import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as envExec from '../env-exec.js';
import { getAdapter } from '../session-flow/adapters/index.js';
import { AgentSession } from '../session-flow/agent-session.js';
import type { Session } from '@teamai/tool-core/sessions/ir';
import { SyncManager, defaultSyncMeta, getRepoIdentity } from '../session-flow/sync.js';
import { getDataHome, getReportsDir, type LocalConfig, type TeamaiConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { leaseNext, reportAttempt } from '../workflow/engine.js';
import { cancelRun, respondProvenance, respondToHitl, retryStep } from '../workflow/run-controls.js';
import { createLocalToolAdapter, type LocalToolAdapter, type LocalToolResult, type LocalToolRun } from '../workflow/drivers/local/local-tool-adapter.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { driverIdentity } from '../driver-identity.js';
import { driverLockPath, readRun } from '../workflow/store.js';
// oxlint-disable-next-line teamai/workflow-boundaries -- fails the snapshot taken by a reader in the checkout
import * as worktreeSnapshot from '../workflow/place/worktree-snapshot.js';
import type { DriverIdentity } from '../workflow/types.js';
import { git } from './helpers/delivered-checkout.js';
import { knownSecrets, resolveWorkflowEnv } from '../env-resolution.js';
import { APPEND_LEARNING, dirs, endRecord, exitsWithin, fixture, toolPaths, workflowFixture } from './helpers/workflow-local-driver-fixture.js';

_setDriverPollMs(20);

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe('the model a prompt step runs on', () => {
  type FakeTool = 'claude' | 'codex' | 'opencode' | 'agy';

  const AGENT_FILES: Record<FakeTool, { dir: string; ext: string }> = {
    claude: { dir: '.claude/agents', ext: '.md' },
    codex: { dir: '.codex/agents', ext: '.toml' },
    opencode: { dir: '.opencode/agents', ext: '.md' },
    agy: { dir: '.agents/agents', ext: '.md' },
  };

  /** What each tool prints in its JSON mode, so the adapter reads stdout as it would from the real tool. */
  const STDOUT: Record<FakeTool, string> = {
    claude: '{"type":"system","subtype":"init","model":"claude-opus-4-1-20250805"}\n{"type":"result","result":"done","session_id":"session-1"}',
    codex: '{"type":"thread.started","thread_id":"thread-1"}',
    opencode: '{"type":"step_finish","sessionID":"session-1"}',
    agy: '{"event":"result","result":{"conversation_id":"3fa76afc-bf4b-4fab-b887-502589d2f711","status":"SUCCESS","response":"done"}}',
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
    const gatewayFile = path.join(root, 'gateway.json');
    const executable = path.join(root, `fake-${tool}`);
    fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') {
  process.stdout.write(${JSON.stringify(options.version ?? '1.18.23')} + '\\n');
  process.exit(0);
}
fs.readFileSync(0);
fs.appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
fs.writeFileSync(${JSON.stringify(gatewayFile)}, JSON.stringify({ key: process.env.GEMINI_API_KEY, url: process.env.GOOGLE_GEMINI_BASE_URL }));
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
    const gateway: unknown = fs.existsSync(gatewayFile) ? JSON.parse(fs.readFileSync(gatewayFile, 'utf8')) : undefined;
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run was not stored');
    return { done, argv, gateway, run, workspace };
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

  it('passes an exact model and effort as written, never through an alias of the same name', async () => {
    const { argv, run } = await runOn('claude', oneStep('    model: { name: strong, effort: max }\n'));

    expect(argv).toEqual([['-p', prompt('Review this project.'), '--output-format', 'stream-json', '--verbose', '--model', 'strong', '--effort', 'max']]);
    expect(run.steps[0]).toMatchObject({ status: 'succeeded', agent: { model: { requested: 'strong' }, effort: { requested: 'max' } } });
    expect(run.steps[0]).not.toMatchObject({ agent: { model: { alias: expect.anything() } } });
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

  it("runs an agy definition on the model pull gave it, over defaults.model", async () => {
    const reviewer = '---\nname: reviewer\ndescription: Reviews changes.\nmodel: gemini-3.8-flash-high\n---\nFollow the review checklist.\n';
    const { argv } = await runOn('agy', oneStep('    agent: reviewer\n', 'defaults:\n  model: gemini-3.8-flash-low\n'), { agents: { reviewer } });

    expect(argv?.[0]).toEqual(expect.arrayContaining(['--agent', 'reviewer', '--model', 'gemini-3.8-flash-high']));
    expect(argv?.[0]).not.toContain('gemini-3.8-flash-low');
  });

  // A model switch hands agy its gateway through a shell function; the driver's launch runs no shell.
  it("runs an agy step on the gateway a model switch gave it, over the member's own key", async () => {
    vi.stubEnv('GEMINI_API_KEY', 'member-own-key');
    fs.mkdirSync(path.join(os.homedir(), '.teamai', 'models'), { recursive: true });
    fs.writeFileSync(path.join(os.homedir(), '.teamai', 'models', 'agy-env.sh'), `agy() { GEMINI_API_KEY='gateway-key' GOOGLE_GEMINI_BASE_URL='https://gateway.example.test' command agy "$@"; }\n`);

    const { gateway } = await runOn('agy', oneStep(''));

    expect(gateway).toEqual({ key: 'gateway-key', url: 'https://gateway.example.test' });
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

  it('counts the timeout of a step waiting for the checkout from the answer to a question asked meanwhile', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Answer while a step waits for the checkout.
steps:
  - id: first
    command: node -e "setTimeout(() => {}, 3000)"
  - id: second
    needs: []
    timeout: 1s
    command: echo second
  - id: go
    needs: []
    approve: Go on?
    command: echo go
`);
    config.workflows!.max_parallel = 2;
    onTestFinished(() => _setDriverPollMs(20));
    const question = vi.fn(async () => {
      _setDriverPollMs(10_000);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return 'yes';
    });
    const result = await runLocalDriver(config, runId, workspace, { hitl: true, question });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'second')).toMatchObject({ status: 'succeeded' });
    expect(result).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(question).toHaveBeenCalledTimes(1);
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
      void knownSecrets(config).then((secrets) => respondToHitl(config, runId, secrets, { step: 'ask', choice: 'one', provenance: respondProvenance({ kind: 'terminal', caller: { tty: false, evidence: { kind: 'none' } } }) }));
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

  it.each([
    ['attended', false, { choice: 'yes', channel: 'tty' }],
    ['unattended', false, { choice: 'no', channel: 'no_hitl' }],
    ['unattended', true, { choice: 'yes', channel: 'auto_approve' }],
  ] as const)('on a terminal, answers an optional approval in a run that is %s, auto-approving %s, with %o', async (mode, autoApprove, answer) => {
    for (const stream of [process.stdin, process.stderr]) {
      const { isTTY } = stream;
      Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
      onTestFinished(() => { Object.defineProperty(stream, 'isTTY', { value: isTTY, configurable: true }); });
    }
    vi.stubEnv('TEAMAI_MODE', mode);
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Ask only a person who is there.
steps:
  - id: ask
    approve: Continue?
    command: echo ok
`);
    const question = vi.fn(async () => 'yes');
    expect(await runLocalDriver(config, runId, workspace, { question, autoApprove })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(question).toHaveBeenCalledTimes(answer.channel === 'tty' ? 1 : 0);
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.steps[0]?.answer).toMatchObject(answer);
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
    await respondToHitl(config, runId, await knownSecrets(config), { step: 'ask', choice: 'no', provenance: respondProvenance({ kind: 'terminal', caller: { tty: false, evidence: { kind: 'none' } } }) });
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

  it('launches a prompt with permissions: unattended in its tool\'s unattended mode, and any other prompt without it', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Fix it in a sandbox.
defaults: { requires: { isolation: sandbox, strict: true } }
steps:
  - id: fix
    prompt: Fix it.
    permissions: unattended
  - id: explain
    needs: [fix]
    prompt: Explain it.
`);
    config.workflows = { tools: { default: 'claude' }, sandbox: true };
    const inputs: LocalToolRun[] = [];
    const ran = vi.fn(async (_tool: string, input: LocalToolRun) => {
      inputs.push(input);
      return { started: true as const, exitCode: 0 };
    });

    expect(await runLocalDriver(config, runId, workspace, { hitl: false, adapter: { run: ran, runInteractive: ran } })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(inputs.map((input) => [input.prompt, input.unattended])).toEqual([['Fix it.', true], ['Explain it.', undefined]]);
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

  it('masks the value it gives a step when the value changes while the team env resolves', async () => {
    const { config } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Print a secret.
steps:
  - id: deploy
    command: echo "$DEPLOY_TOKEN"
`);
    const env: NodeJS.ProcessEnv = { DEPLOY_TOKEN: 'old-deploy-secret-value' };
    const resolving = resolveWorkflowEnv(config, env);
    env.DEPLOY_TOKEN = 'new-deploy-secret-value';
    const resolved = await resolving;
    expect(Object.values(resolved.secrets)).toContain(resolved.values.get('DEPLOY_TOKEN'));
  });

  it.each([
    { looks: 'for no tool when no step names one', tool: '', probed: [] },
    { looks: 'for codex alone when a step names it', tool: '\n    tool: codex', probed: ['codex'] },
  ])('looks $looks', async ({ tool, probed }) => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Name a tool or not.
steps:
  - id: build
    command: "true"
  - id: review
    needs: [build]
    if: steps.build.outcome == 'failed'
    prompt: Review.${tool}
`);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-lookups-'));
    dirs.push(bin);
    const lookups = path.join(bin, 'lookups.log');
    for (const name of ['which', 'bash', 'zsh']) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nfor last; do :; done\necho "$last" >> '${lookups}'\nexit 1\n`, { mode: 0o755 });
    }
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    expect(await runLocalDriver(config, runId, workspace, { hitl: false })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    vi.unstubAllEnvs();
    const looked = fs.existsSync(lookups) ? fs.readFileSync(lookups, 'utf8').split('\n').filter(Boolean) : [];
    expect([...new Set(looked)]).toEqual(probed);
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
      void knownSecrets(config).then((secrets) => respondToHitl(config, runId, secrets, { step: 'pair', choice: 'yes', provenance: respondProvenance({ kind: 'terminal', caller: { tty: false, evidence: { kind: 'none' } } }) }));
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

  it('fails an interactive hand-back without HITL that it cannot offer to a person, naming the retry', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Need a person.
steps:
  - id: pair
    prompt: Pair with me.
    interactive: true
`);
    await leaseNext(config, runId, driverIdentity('local', workspace), { can: { hitl: true } });
    const adapter: LocalToolAdapter = { run: vi.fn(), runInteractive: vi.fn<LocalToolAdapter['runInteractive']>(async () => ({ started: true, exitCode: 0 })) };
    expect(await runLocalDriver(config, runId, workspace, { hitl: false, adapter })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(adapter.runInteractive).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'pair', status: 'failed', failure: {
      code: 'hitl_required',
      message: expect.stringContaining(`Step "pair" needs a person, and run ${runId} could not be offered to one: `),
    } }] });
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
        const copy = (await getAdapter('claude-code').listConversations(workspace)).find((meta) => meta.sessionId === input.resume);
        const records = fs.readFileSync(copy?.filePath ?? '', 'utf8').trimEnd().split('\n').map((line): Record<string, unknown> => JSON.parse(line));
        const answer = records.toReversed().find((record) => record.type === 'assistant');
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
    const logFile = path.join(os.tmpdir(), `teamai-setup-log-${randomUUID()}`);
    dirs.push(logFile);
    const { config, workspace, runId } = await setupFixture(`  command: test "$SETUP_TOKEN" = setup-token-value-1082 && echo prepared > .prepared && echo ran >> ${logFile}\n  requires: { env: [SETUP_TOKEN] }`, `  - id: change
    workspace: new
    workflow:
      steps:
        - id: first
          command: test -f .prepared && test -z "$SETUP_TOKEN"
        - id: second
          needs: [first]
          command: test -f .prepared && test -z "$SETUP_TOKEN"
`);
    fs.writeFileSync(logFile, '');
    const done = await runLocalDriver(config, runId, workspace, { hitl: false });
    expect(done, JSON.stringify(await readRun(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(logFile, 'utf8')).toBe('ran\n');
  });

  it('gives setup and the step\'s command the run mode of the process that drives the run', async () => {
    vi.stubEnv('CI', '1');
    const { config, workspace, runId } = await setupFixture('  command: test "$TEAMAI_MODE" = unattended', `  - id: change
    workspace: new
    command: test "$TEAMAI_MODE" = unattended
`);
    const done = await runLocalDriver(config, runId, workspace, { hitl: false });
    expect(done, JSON.stringify(await readRun(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('runs setup again when a retried step finds the workspace of a copy a step already ran in gone', async () => {
    const logFile = path.join(os.tmpdir(), `teamai-setup-log-${randomUUID()}`);
    const ready = path.join(os.tmpdir(), `teamai-setup-ready-${randomUUID()}`);
    dirs.push(logFile, ready);
    const { config, workspace, runId } = await setupFixture(`  command: echo prepared > .prepared && echo ran >> ${logFile}`, `  - id: change
    workspace: new
    workflow:
      steps:
        - id: first
          command: test -f .prepared
        - id: second
          needs: [first]
          command: test -f .prepared && test -f ${JSON.stringify(ready)}
`);
    fs.writeFileSync(logFile, '');
    expect(await runLocalDriver(config, runId, workspace, { hitl: false })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    for (const line of worktrees(workspace)) fs.rmSync(line.slice('worktree '.length), { recursive: true, force: true });
    fs.writeFileSync(ready, '');
    expect(await retryStep(config, runId, await knownSecrets(config), 'change.second')).toMatchObject({ data: {} });

    const done = await runLocalDriver(config, runId, workspace, { hitl: false });
    expect(done, JSON.stringify(await readRun(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(logFile, 'utf8')).toBe('ran\nran\n');
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

  async function slowSetup(maxParallel: number, { timeout = '', setupMs = 4000 } = {}): Promise<{ config: LocalConfig; workspace: string; runId: string; pidFile: string; marker: string }> {
    const pidFile = path.join(os.tmpdir(), `teamai-setup-pid-${randomUUID()}`);
    const marker = path.join(os.tmpdir(), `teamai-setup-step-${randomUUID()}`);
    dirs.push(pidFile, marker);
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, ${setupMs})`;
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

  // The timeout counts from the lease, and a loaded runner took more than a second to make the worktree, so a 1s
  // timeout passed before setup started (#1504). This one leaves the worktree room and setup outlasts it; the real
  // setup processes and the timeout share the budget.
  it.each([1, 2])('stops setup when the lease passes its timeout at max_parallel %i, and never runs the step', { timeout: 60_000 }, async (maxParallel) => {
    const { config, workspace, runId, pidFile, marker } = await slowSetup(maxParallel, { timeout: '    timeout: 5s\n', setupMs: 9000 });
    const startedAt = Date.now();
    const done = await runLocalDriver(config, runId, workspace, { hitl: false });
    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(Date.now() - startedAt, 'the driver did not wait for setup to finish').toBeLessThan(7500);
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

describe('the outcomes a step\'s own commands report (#1387)', () => {
  it('puts what the attempt appended to its outcome file on the pass it settles', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: A step that records a learning.
steps:
  - id: close
    command: ${APPEND_LEARNING}
`);

    expect(await runLocalDriver(config, runId, workspace, { toolPaths })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'close', outcomes: [{ kind: 'learning', id: 'retry-backoff' }] }] });
  });
});
