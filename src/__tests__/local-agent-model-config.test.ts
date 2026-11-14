import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';
import JSON5 from 'json5';
import { z } from 'zod';
import * as localAgent from '../local-agent.js';
import type { DeliveredModel, ModelDeliveryCommit, ModelDeliveryRecord } from '../local-agent.js';

const { ModelDeliveryRecordSchema, scanDeliveredModels } = localAgent;

const writers = {
  openclaw: localAgent.reconcileOpenclawModels,
  hermes: localAgent.reconcileHermesModels,
  dsh: localAgent.reconcileDshModels,
} as const;

function reconcile(
  agent: keyof typeof writers,
  models: readonly DeliveredModel[],
  fullSnapshot: boolean,
  previous: ModelDeliveryRecord | undefined,
  root: string,
  commit?: ModelDeliveryCommit,
): Promise<ModelDeliveryRecord> {
  return writers[agent](models, fullSnapshot, previous, root, commit);
}

vi.mock('@teamai/shared/log', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let home: string;
let originalHome: string | undefined;

// The Claude gateway guard treats any user-set ANTHROPIC_* shell var as
// user-owned config and skips the write. Clear them so a runner's own shell
// env (a common setup for Claude power users) can't turn these tests flaky.
const GUARDED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];
let originalGuardedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-config-'));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  originalGuardedEnv = {};
  for (const key of GUARDED_ENV_KEYS) {
    originalGuardedEnv[key] = process.env[key];
    delete process.env[key];
  }
  await fse.outputJson(path.join(home, '.teamai/local-agent/config.json'), {
    endpoint: 'https://clawpro.example.com',
    token: 'reporter-token',
    localAgentId: '0123456789abcdef',
    createdAt: '2026-09-02T00:00:00.000Z',
    workspaceBindings: {},
  });
});

afterEach(async () => {
  process.env.HOME = originalHome;
  for (const key of GUARDED_ENV_KEYS) {
    const value = originalGuardedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fse.remove(home);
});

function stubSync(command: Record<string, unknown>) {
  const acks: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: { body?: string }) => {
    const url = String(input);
    if (url.includes('/local-agent/sync')) {
      return new Response(JSON.stringify({ ok: true, version: 'v2', cmds: [command] }));
    }
    if (url.includes('/commands/ack')) {
      acks.push(JSON.parse(init?.body ?? '{}'));
    }
    return new Response(JSON.stringify({ ok: true }));
  }));
  return acks;
}

const deliveredModel = {
  provider: 'tokenhub',
  model_id: 'deepseek-v3-0324',
  name: 'DeepSeek V3 0324',
  base_url: 'https://proxy.example.com/v1',
  api_key: 'proxy-token',
  max_tokens: 5555,
  context_window: 128000,
};

describe('local-agent: apply_model_config', () => {
  it('persists a direct model payload for CodeBuddy, then acks with the task type', async () => {
    await fse.outputJson(path.join(home, '.codebuddy/models.json'), {
      models: [{ id: 'personal-model', name: 'Personal' }],
      availableModels: ['personal-model'],
    });
    const acks = stubSync({
      id: 16,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
      scope: '',
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    const codebuddy = await fse.readJson(path.join(home, '.codebuddy/models.json'));
    expect(codebuddy.models).toEqual([
      { id: 'personal-model', name: 'Personal' },
      {
        id: 'deepseek-v3-0324',
        name: 'DeepSeek V3 0324',
        vendor: 'tokenhub',
        apiKey: 'proxy-token',
        maxInputTokens: 128000,
        maxOutputTokens: 5555,
        url: 'https://proxy.example.com/v1/chat/completions',
        supportsToolCall: true,
      },
    ]);
    expect(codebuddy.availableModels).toEqual(['personal-model', 'deepseek-v3-0324']);

    expect(await fse.pathExists(path.join(home, '.claude/settings.json'))).toBe(false);
    expect(await fse.pathExists(path.join(home, '.claude/teamai-models.json'))).toBe(false);

    expect(acks).toContainEqual(expect.objectContaining({
      id: 16,
      type: 'apply_model_config',
      status: 'success',
    }));
    expect((await fs.promises.stat(path.join(home, '.codebuddy/models.json'))).mode & 0o777).toBe(0o600);
  });

  it('accepts the documented models wrapper and preserves conflicting user models and Claude gateway settings', async () => {
    await fse.outputJson(path.join(home, '.codebuddy/models.json'), {
      models: [{ id: deliveredModel.model_id, name: 'User-owned model', url: 'https://user.example.com/chat' }],
    });
    await fse.outputJson(path.join(home, '.claude/settings.json'), {
      env: { ANTHROPIC_BASE_URL: 'https://user-gateway.example.com' },
      model: 'sonnet',
    });
    const acks = stubSync({
      id: 17,
      type: 'apply_model_config',
      cmd: JSON.stringify({ models: [deliveredModel] }),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    const codebuddy = await fse.readJson(path.join(home, '.codebuddy/models.json'));
    expect(codebuddy.models).toEqual([
      { id: deliveredModel.model_id, name: 'User-owned model', url: 'https://user.example.com/chat' },
    ]);
    const claude = await fse.readJson(path.join(home, '.claude/settings.json'));
    expect(claude).toEqual({
      env: { ANTHROPIC_BASE_URL: 'https://user-gateway.example.com' },
      model: 'sonnet',
    });
    expect(await fse.pathExists(path.join(home, '.claude/teamai-models.json'))).toBe(false);
    expect(acks[0]?.status).toBe('success');
  });

  it('keeps an empty CodeBuddy availableModels list unrestricted', async () => {
    await fse.outputJson(path.join(home, '.codebuddy/models.json'), {
      models: [],
      availableModels: [],
    });
    stubSync({
      id: 22,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    const codebuddy = await fse.readJson(path.join(home, '.codebuddy/models.json'));
    expect(codebuddy.availableModels).toEqual([]);
  });

  it('treats direct model tasks as incremental upserts', async () => {
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    stubSync({
      id: 23,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    stubSync({
      id: 24,
      type: 'apply_model_config',
      cmd: JSON.stringify({
        ...deliveredModel,
        model_id: 'second-model',
        name: 'Second Model',
        max_tokens: '4096',
        context_window: '64000',
      }),
    });
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    const codebuddy = await fse.readJson(path.join(home, '.codebuddy/models.json'));
    expect(codebuddy.models.map((model: { id: string }) => model.id)).toEqual([
      'deepseek-v3-0324',
      'second-model',
    ]);
    expect(codebuddy.models[1]).toMatchObject({
      maxInputTokens: 64000,
      maxOutputTokens: 4096,
    });
  });

  it('reconciles models previously managed by TeamAI without deleting user edits', async () => {
    const firstAcks = stubSync({
      id: 18,
      type: 'apply_model_config',
      cmd: JSON.stringify({ models: [deliveredModel] }),
    });
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });
    expect(firstAcks[0]?.status).toBe('success');

    const configPath = path.join(home, '.codebuddy/models.json');
    const edited = await fse.readJson(configPath);
    edited.models[0].name = 'User took ownership';
    await fse.writeJson(configPath, edited);

    const secondAcks = stubSync({
      id: 19,
      type: 'apply_model_config',
      cmd: JSON.stringify({ models: [] }),
    });
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    const after = await fse.readJson(configPath);
    expect(after.models).toEqual([expect.objectContaining({ name: 'User took ownership' })]);
    expect(secondAcks[0]?.status).toBe('success');
  });

  it('does not inspect unrelated Claude settings when applying a CodeBuddy model', async () => {
    await fse.outputJson(path.join(home, '.claude/settings.json'), { env: 'invalid' });
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    const firstAcks = stubSync({
      id: 25,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });
    expect(firstAcks[0]?.status).toBe('success');

    await fse.outputJson(path.join(home, '.claude/settings.json'), {});
    const secondAcks = stubSync({
      id: 26,
      type: 'apply_model_config',
      cmd: JSON.stringify({ ...deliveredModel, name: 'Updated by TeamAI' }),
    });
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    const codebuddy = await fse.readJson(path.join(home, '.codebuddy/models.json'));
    expect(codebuddy.models).toEqual([
      expect.objectContaining({ id: deliveredModel.model_id, name: 'Updated by TeamAI' }),
    ]);
    expect(secondAcks[0]?.status).toBe('success');
  });

  it('defaults max_tokens to 4096 when the backend omits it or sends a Go zero value', async () => {
    const acks = stubSync({
      id: 25,
      type: 'apply_model_config',
      cmd: JSON.stringify({
        provider: 'tencentcodingplan',
        model_id: 'kimi-k2.5',
        name: 'kimi-k2.5',
        base_url: 'https://proxy.example.com/v1',
        api_key: 'proxy-token',
        max_tokens: 0,
        context_window: 128000,
      }),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    expect(acks[0]?.status).toBe('success');
    const codebuddy = await fse.readJson(path.join(home, '.codebuddy/models.json'));
    expect(codebuddy.models).toEqual([
      expect.objectContaining({
        id: 'kimi-k2.5',
        maxOutputTokens: 4096,
        maxInputTokens: 128000,
      }),
    ]);
  });

  it('acks failed for malformed model config without writing tool files', async () => {
    const acks = stubSync({
      id: 20,
      type: 'apply_model_config',
      cmd: JSON.stringify({ models: [{ ...deliveredModel, model_id: '' }] }),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    expect(acks).toContainEqual(expect.objectContaining({
      id: 20,
      type: 'apply_model_config',
      status: 'failed',
      error: expect.stringMatching(/model_id/i),
    }));
    expect(await fse.pathExists(path.join(home, '.codebuddy/models.json'))).toBe(false);
    expect(await fse.pathExists(path.join(home, '.claude/teamai-models.json'))).toBe(false);
  });

  it('rejects reserved model IDs used by object prototypes', async () => {
    const acks = stubSync({
      id: 49,
      type: 'apply_model_config',
      cmd: JSON.stringify({ ...deliveredModel, model_id: '__proto__' }),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'workbuddy', status: 'running' });

    expect(acks[0]).toMatchObject({
      id: 49,
      status: 'failed',
      error: expect.stringMatching(/reserved model_id/i),
    });
  });

  it('redacts the home directory from model parse errors sent in acks', async () => {
    const configPath = path.join(home, '.workbuddy/models.json');
    await fse.outputFile(configPath, '{ invalid json');
    const acks = stubSync({
      id: 50,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'workbuddy', status: 'running' });

    expect(acks[0]?.status).toBe('failed');
    expect(String(acks[0]?.error)).toContain('~/.workbuddy/models.json');
    expect(String(acks[0]?.error)).not.toContain(home);
  });

  it('silently skips unknown task types without acknowledging failure', async () => {
    const acks = stubSync({ id: 21, type: 'future_model_task', cmd: '{}' });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    expect(acks).toEqual([]);
  });

  it('reports an applied model immediately without waiting for the next session', async () => {
    const reports: Array<Record<string, unknown>> = [];
    const command = {
      id: 26,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('/local-agent/report')) {
        reports.push(JSON.parse(init?.body ?? '{}'));
      }
      if (url.includes('/local-agent/sync')) {
        return new Response(JSON.stringify({ ok: true, version: 'v2', cmds: [command] }));
      }
      return new Response(JSON.stringify({ ok: true }));
    }));

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    expect(reports).toHaveLength(2);
    expect((reports[1]?.user_level as { models?: unknown[] } | undefined)?.models).toEqual([
      {
        provider: 'tokenhub',
        model_id: 'deepseek-v3-0324',
        name: 'DeepSeek V3 0324',
        source: 'enterprise',
      },
    ]);
  });

  it('persists a direct model payload for WorkBuddy as a top-level array', async () => {
    await fse.outputJson(path.join(home, '.workbuddy/models.json'), [
      { id: 'hai-glm5-2', name: 'hai-glm5-2', vendor: 'Custom' },
    ]);
    const acks = stubSync({
      id: 35,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'workbuddy', status: 'running' });

    const workbuddy = await fse.readJson(path.join(home, '.workbuddy/models.json'));
    expect(Array.isArray(workbuddy)).toBe(true);
    expect(workbuddy).toEqual([
      { id: 'hai-glm5-2', name: 'hai-glm5-2', vendor: 'Custom' },
      {
        id: 'deepseek-v3-0324',
        name: 'DeepSeek V3 0324',
        vendor: 'tokenhub',
        apiKey: 'proxy-token',
        maxInputTokens: 128000,
        maxOutputTokens: 5555,
        url: 'https://proxy.example.com/v1/chat/completions',
        supportsToolCall: true,
      },
    ]);
    expect(await fse.pathExists(path.join(home, '.codebuddy/models.json'))).toBe(false);
    expect(acks).toContainEqual(expect.objectContaining({
      id: 35,
      type: 'apply_model_config',
      status: 'success',
    }));
    expect((await fs.promises.stat(path.join(home, '.workbuddy/models.json'))).mode & 0o777).toBe(0o600);
  });

  it('creates the documented object-wrapped WorkBuddy format when the file is absent', async () => {
    const acks = stubSync({
      id: 43,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'workbuddy', status: 'running' });

    const workbuddy = await fse.readJson(path.join(home, '.workbuddy/models.json'));
    expect(workbuddy).toEqual({
      models: [expect.objectContaining({ id: 'deepseek-v3-0324' })],
    });
    expect(acks[0]?.status).toBe('success');
  });

  it('preserves an object-wrapped WorkBuddy file and its availableModels filter', async () => {
    await fse.outputJson(path.join(home, '.workbuddy/models.json'), {
      models: [{ id: 'personal-model', name: 'Personal' }],
      availableModels: ['personal-model'],
    });
    stubSync({
      id: 44,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'workbuddy', status: 'running' });

    const workbuddy = await fse.readJson(path.join(home, '.workbuddy/models.json'));
    expect(workbuddy.models.map((entry: { id: string }) => entry.id)).toEqual([
      'personal-model',
      'deepseek-v3-0324',
    ]);
    expect(workbuddy.availableModels).toEqual(['personal-model', 'deepseek-v3-0324']);
  });

  it('writes a workspace-scoped WorkBuddy model to the project models file', async () => {
    const workspace = path.join(home, 'project');
    await fse.ensureDir(workspace);
    const configPath = path.join(home, '.teamai/local-agent/config.json');
    const config = await fse.readJson(configPath);
    config.workspaceBindings[workspace] = {
      projectId: 5,
      projectName: 'Project 5',
      boundAt: '2026-09-09T00:00:00.000Z',
      ideType: 'workbuddy',
    };
    await fse.writeJson(configPath, config);
    const acks = stubSync({
      id: 45,
      type: 'apply_model_config',
      scope: 'workspace',
      workspace_path: workspace,
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ cwd: workspace, tool: 'workbuddy', status: 'running' });

    const projectConfig = await fse.readJson(path.join(workspace, '.codebuddy/models.json'));
    expect(projectConfig.models[0].id).toBe('deepseek-v3-0324');
    // Outside any git repository nothing could commit it: the key is written, with no git exclude line,
    // no record of one, and no .gitignore (#915).
    expect(projectConfig.models[0].apiKey).toBe('proxy-token');
    expect(await fse.pathExists(path.join(workspace, '.codebuddy/.gitignore'))).toBe(false);
    expect(await fse.pathExists(path.join(home, '.teamai/local-agent/git-exclude.json'))).toBe(false);
    expect(await fse.pathExists(path.join(home, '.workbuddy/models.json'))).toBe(false);
    expect(acks[0]?.status).toBe('success');
  });

  it('keeps the record of a workspace model remove-http could not take out, and takes it out on the retry', async () => {
    const workspace = path.join(home, 'project');
    await fse.ensureDir(workspace);
    const configPath = path.join(home, '.teamai/local-agent/config.json');
    const config = await fse.readJson(configPath);
    config.workspaceBindings[workspace] = { projectId: 5, projectName: 'Project 5', boundAt: '2026-09-09T00:00:00.000Z', ideType: 'workbuddy' };
    await fse.writeJson(configPath, config);
    stubSync({ id: 46, type: 'apply_model_config', scope: 'workspace', workspace_path: workspace, cmd: JSON.stringify(deliveredModel) });
    const { reportAndSyncLocalAgent, removeLocalAgentHttp } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ cwd: workspace, tool: 'workbuddy', status: 'running' });
    const models = path.join(workspace, '.codebuddy/models.json');
    const delivered = await fse.readFile(models, 'utf8');
    const modelManifest = path.join(home, '.teamai/local-agent/model-manifest.json');
    expect(await fse.pathExists(modelManifest)).toBe(true);
    await fse.writeFile(models, `${delivered.trimEnd()},\n`);

    process.exitCode = undefined;
    await removeLocalAgentHttp();

    expect(process.exitCode).toBe(1);
    expect(await fse.readFile(models, 'utf8')).toContain('proxy-token');
    expect(await fse.pathExists(modelManifest)).toBe(true);

    await fse.writeFile(models, delivered);
    process.exitCode = undefined;
    await removeLocalAgentHttp();

    expect(process.exitCode).toBeUndefined();
    expect(await fse.pathExists(models)).toBe(false);
    expect(await fse.pathExists(modelManifest)).toBe(false);
  });

  it('keeps a model record remove-http cannot read, and takes the models out once it can', async () => {
    const workspace = path.join(home, 'project');
    await fse.ensureDir(workspace);
    const configPath = path.join(home, '.teamai/local-agent/config.json');
    const config = await fse.readJson(configPath);
    config.workspaceBindings[workspace] = { projectId: 5, projectName: 'Project 5', boundAt: '2026-09-09T00:00:00.000Z', ideType: 'workbuddy' };
    await fse.writeJson(configPath, config);
    stubSync({ id: 47, type: 'apply_model_config', scope: 'workspace', workspace_path: workspace, cmd: JSON.stringify(deliveredModel) });
    const { reportAndSyncLocalAgent, removeLocalAgentHttp } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ cwd: workspace, tool: 'workbuddy', status: 'running' });
    const models = path.join(workspace, '.codebuddy/models.json');
    const modelManifest = path.join(home, '.teamai/local-agent/model-manifest.json');
    const record = await fse.readFile(modelManifest, 'utf8');
    await fse.writeFile(modelManifest, `${record.trimEnd()},\n`);

    process.exitCode = undefined;
    await removeLocalAgentHttp();

    expect(process.exitCode).toBe(1);
    expect(await fse.readFile(models, 'utf8')).toContain('proxy-token');
    expect(await fse.readFile(modelManifest, 'utf8')).toBe(`${record.trimEnd()},\n`);

    await fse.writeFile(modelManifest, record);
    process.exitCode = undefined;
    await removeLocalAgentHttp();

    expect(process.exitCode).toBeUndefined();
    expect(await fse.pathExists(models)).toBe(false);
    expect(await fse.pathExists(modelManifest)).toBe(false);
  });

  it('rejects a workspace-scoped model for an unbound path', async () => {
    const workspace = path.join(home, 'unbound');
    await fse.ensureDir(workspace);
    const acks = stubSync({
      id: 47,
      type: 'apply_model_config',
      scope: 'workspace',
      workspace_path: workspace,
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    // Run outside the workspace: a session inside an unenrolled one does not sync at all.
    await reportAndSyncLocalAgent({ tool: 'workbuddy', status: 'running' });

    expect(acks[0]).toMatchObject({
      id: 47,
      status: 'failed',
      error: expect.stringMatching(/not a registered binding/i),
    });
    expect(await fse.pathExists(path.join(workspace, '.codebuddy/models.json'))).toBe(false);
  });

  it('supports a workspace-scoped CodeBuddy model without writing WorkBuddy user config', async () => {
    const workspace = path.join(home, 'code-project');
    await fse.ensureDir(workspace);
    const configPath = path.join(home, '.teamai/local-agent/config.json');
    const config = await fse.readJson(configPath);
    config.workspaceBindings[workspace] = {
      projectId: 6,
      projectName: 'Project 6',
      boundAt: '2026-09-09T00:00:00.000Z',
      ideType: 'codebuddy',
    };
    await fse.writeJson(configPath, config);
    const acks = stubSync({
      id: 48,
      type: 'apply_model_config',
      scope: 'workspace',
      workspace_path: workspace,
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ cwd: workspace, tool: 'codebuddy', status: 'running' });

    const projectConfig = await fse.readJson(path.join(workspace, '.codebuddy/models.json'));
    expect(projectConfig.models[0].id).toBe('deepseek-v3-0324');
    expect(await fse.pathExists(path.join(home, '.workbuddy/models.json'))).toBe(false);
    expect(acks[0]?.status).toBe('success');
  });

  it('fails apply_model_config for an unsupported reporting agent', async () => {
    const acks = stubSync({
      id: 27,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'cursor', status: 'running' });

    expect(acks[0]).toMatchObject({
      id: 27,
      type: 'apply_model_config',
      status: 'failed',
      error: expect.stringMatching(/unsupported agent/i),
    });
    expect(await fse.pathExists(path.join(home, '.codebuddy/models.json'))).toBe(false);
    expect(await fse.pathExists(path.join(home, '.workbuddy/models.json'))).toBe(false);
    expect(await fse.pathExists(path.join(home, '.claude/settings.json'))).toBe(false);
  });

  it('preserves a symlinked CodeBuddy models file', async () => {
    const target = path.join(home, 'dotfiles', 'codebuddy-models.json');
    const link = path.join(home, '.codebuddy', 'models.json');
    await fse.outputJson(target, { models: [] });
    await fse.ensureDir(path.dirname(link));
    await fse.symlink(target, link);
    const acks = stubSync({
      id: 28,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    expect(acks[0]?.status).toBe('success');
    expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
    expect((await fse.readJson(target)).models[0].id).toBe('deepseek-v3-0324');
  });

  it('preserves a symlinked WorkBuddy models file', async () => {
    const target = path.join(home, 'dotfiles', 'workbuddy-models.json');
    const link = path.join(home, '.workbuddy', 'models.json');
    await fse.outputJson(target, []);
    await fse.ensureDir(path.dirname(link));
    await fse.symlink(target, link);
    const acks = stubSync({
      id: 36,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'workbuddy', status: 'running' });

    expect(acks[0]?.status).toBe('success');
    expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
    expect((await fse.readJson(target))[0].id).toBe('deepseek-v3-0324');
  });

  // The root is a per-machine setting recorded by `teamai init`, and a member
  // who initialized in project scope has it in the project config — the local
  // agent resolves it the way every other command does, project config first.
  it('writes the Claude gateway into the root recorded by a project-scope config', async () => {
    const workspace = path.join(home, 'workspace');
    const relocated = path.join(home, '.claude-work');
    await fse.ensureDir(relocated);
    await fse.outputFile(path.join(workspace, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${path.join(workspace, '.teamai', 'team-repo')}`,
      '  remote: https://git.example.com/team/repo.git',
      'username: tester',
      'scope: project',
      `projectRoot: ${workspace}`,
      'toolRoots:',
      `  claude: ${relocated}`,
      '',
    ].join('\n'));
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    const acks = stubSync({
      id: 33,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });

    expect(acks[0]?.status).toBe('success');
    expect((await fse.readJson(path.join(relocated, 'settings.json'))).env.ANTHROPIC_CUSTOM_MODEL_OPTION)
      .toBe('deepseek-v3-0324');
    expect(await fse.pathExists(path.join(relocated, 'teamai-models.json'))).toBe(true);
    expect(await fse.pathExists(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('preserves a symlinked Claude settings file', async () => {
    const target = path.join(home, 'dotfiles', 'claude-settings.json');
    const link = path.join(home, '.claude', 'settings.json');
    await fse.outputJson(target, { env: {} });
    await fse.ensureDir(path.dirname(link));
    await fse.symlink(target, link);
    const acks = stubSync({
      id: 29,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });

    expect(acks[0]?.status).toBe('success');
    expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
    expect((await fse.readJson(target)).env.ANTHROPIC_CUSTOM_MODEL_OPTION).toBe('deepseek-v3-0324');
  });

  it('pauses server model sync during an explicit Claude profile and resumes after restore', async () => {
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    const { ModelProfileSchema, resolveProfile } = await import('../models/profile.js');
    const { switchModelProfile, restoreModelProfiles } = await import('../models/switch.js');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const manifestPath = path.join(home, '.teamai/local-agent/model-manifest.json');
    stubSync({ id: 61, type: 'apply_model_config', cmd: JSON.stringify(deliveredModel) });
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });
    const original = await fse.readJson(settingsPath);
    const originalManifest = await fse.readJson(manifestPath);
    const profile = resolveProfile({ source: 'local', profile: ModelProfileSchema.parse({
      id: 'personal', name: 'Personal', base_url: 'https://personal.example.test', api_key: '${API_KEY}',
      model_groups: [{ protocols: ['anthropic'], models: ['personal-model'] }],
    }) }, { 'local:personal': { API_KEY: { value: 'personal-token' } } });
    expect((await switchModelProfile(profile, ['claude']))[0].status).toBe('switched');
    stubSync({ id: 62, type: 'apply_model_config', cmd: JSON.stringify({ ...deliveredModel, model_id: 'new-server-model' }) });
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });
    const active = await fse.readJson(settingsPath);
    expect(active.env.ANTHROPIC_BASE_URL).toBe('https://personal.example.test');
    expect(active.env).not.toHaveProperty('ANTHROPIC_CUSTOM_MODEL_OPTION');
    expect(await fse.readJson(manifestPath)).toEqual(originalManifest);
    expect((await restoreModelProfiles(['claude']))[0].status).toBe('restored');
    expect(await fse.readJson(settingsPath)).toEqual(original);
  });

  it.each(['codebuddy', 'workbuddy'] as const)('pauses %s server model sync during an explicit profile', async (agent) => {
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    const { ModelProfileSchema, resolveProfile } = await import('../models/profile.js');
    const { switchModelProfile, restoreModelProfiles } = await import('../models/switch.js');
    const file = path.join(home, `.${agent}`, 'models.json');
    const manifestPath = path.join(home, '.teamai/local-agent/model-manifest.json');
    stubSync({ id: 71, type: 'apply_model_config', cmd: JSON.stringify(deliveredModel) });
    await reportAndSyncLocalAgent({ tool: agent, status: 'running' });
    const original = await fse.readJson(file);
    const originalManifest = await fse.readJson(manifestPath);
    const profile = resolveProfile({ source: 'local', profile: ModelProfileSchema.parse({
      id: 'personal', name: 'Personal', base_url: 'https://personal.example.test', api_key: '${API_KEY}',
      model_groups: [{ protocols: ['openai-chat-completions'], models: [deliveredModel.model_id] }],
    }) }, { 'local:personal': { API_KEY: { value: 'personal-token' } } });
    expect((await switchModelProfile(profile, [agent]))[0].status).toBe('switched');
    stubSync({ id: 72, type: 'apply_model_config', cmd: JSON.stringify({ ...deliveredModel, base_url: 'https://new-server.example.test/v1' }) });
    await reportAndSyncLocalAgent({ tool: agent, status: 'running' });
    expect((await fse.readJson(file)).models[0].vendor).toBe('Personal');
    expect(await fse.readJson(manifestPath)).toEqual(originalManifest);
    expect((await restoreModelProfiles([agent]))[0].status).toBe('restored');
    expect(await fse.readJson(file)).toEqual(original);
  });

  it('preserves the whole Claude gateway when one managed field was user-edited', async () => {
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    stubSync({
      id: 30,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });

    const settingsPath = path.join(home, '.claude', 'settings.json');
    const edited = await fse.readJson(settingsPath);
    edited.env.ANTHROPIC_BASE_URL = 'https://user.example.com';
    await fse.writeJson(settingsPath, edited);
    stubSync({
      id: 31,
      type: 'apply_model_config',
      cmd: JSON.stringify({ models: [] }),
    });

    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });

    expect((await fse.readJson(settingsPath)).env).toEqual(edited.env);
  });

  it('does not seize the Claude gateway when the user configures it via shell env', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-user-shell-token';
    const acks = stubSync({
      id: 32,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });

    // The gateway is user-owned via the shell, so settings.json is left alone.
    expect(await fse.pathExists(path.join(home, '.claude/settings.json'))).toBe(false);
    expect(await fse.pathExists(path.join(home, '.claude/teamai-models.json'))).toBe(true);
    expect(acks[0]?.status).toBe('success');

    const errorLog = await fse.readFile(
      path.join(home, '.teamai/reporter/errors.jsonl'),
      'utf-8',
    );
    expect(errorLog).toContain('skipped claude gateway');
    expect(errorLog).toContain('ANTHROPIC_BASE_URL');
  });

  it('does not seize the Claude gateway when the user pins a default model via shell env', async () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-8';
    stubSync({
      id: 33,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });

    expect(await fse.pathExists(path.join(home, '.claude/settings.json'))).toBe(false);
    const errorLog = await fse.readFile(
      path.join(home, '.teamai/reporter/errors.jsonl'),
      'utf-8',
    );
    expect(errorLog).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL');
  });

  // Regression: Claude injects settings.json.env into the hook's own process
  // environment, so a managed value we wrote last sync reappears in process.env.
  // The guard must recognise its own re-injected value and NOT treat it as a
  // user conflict — otherwise every follow-up sync is skipped and the managed
  // record is wiped, stranding the user on stale gateway/token forever.
  it('updates a managed gateway even when settings.json.env is re-injected into the hook env', async () => {
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    const settingsPath = path.join(home, '.claude', 'settings.json');

    // First delivery, clean env: seeds the managed gateway.
    stubSync({ id: 40, type: 'apply_model_config', cmd: JSON.stringify(deliveredModel) });
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });
    expect((await fse.readJson(settingsPath)).env.ANTHROPIC_BASE_URL).toBe('https://proxy.example.com');

    // Simulate Claude re-injecting the just-written settings.json.env into the
    // hook subprocess before the next sync.
    const written = (await fse.readJson(settingsPath)).env as Record<string, string>;
    for (const [key, value] of Object.entries(written)) process.env[key] = value;

    // Second delivery: a NEW gateway must go through despite the re-injection.
    const newModel = {
      ...deliveredModel,
      model_id: 'kimi-k2',
      name: 'Kimi K2',
      base_url: 'https://new-proxy.example.com/v1',
      api_key: 'new-proxy-token',
    };
    const acks = stubSync({ id: 41, type: 'apply_model_config', cmd: JSON.stringify(newModel) });
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });

    const after = await fse.readJson(settingsPath);
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://new-proxy.example.com');
    expect(after.env.ANTHROPIC_AUTH_TOKEN).toBe('new-proxy-token');
    expect(acks[0]?.status).toBe('success');

    // Managed record must survive so future syncs can keep reconciling.
    const manifest = await fse.readJson(path.join(home, '.teamai/local-agent/model-manifest.json'));
    expect(Object.keys(manifest.claudeEnv ?? {}).length).toBeGreaterThan(0);
  });

  it('removes a managed gateway on empty delivery even when it is re-injected into the hook env', async () => {
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    const settingsPath = path.join(home, '.claude', 'settings.json');

    stubSync({ id: 42, type: 'apply_model_config', cmd: JSON.stringify(deliveredModel) });
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });

    const written = (await fse.readJson(settingsPath)).env as Record<string, string>;
    for (const [key, value] of Object.entries(written)) process.env[key] = value;

    stubSync({ id: 43, type: 'apply_model_config', cmd: JSON.stringify({ models: [] }) });
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });

    const after = await fse.readJson(settingsPath);
    expect(after.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(after.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});

describe('local-agent: native candidate delivery', () => {
  it.each(['openclaw', 'hermes'] as const)('accumulates and reports %s candidates without changing the current model', async (tool) => {
    const file = path.join(home, `.${tool}`, tool === 'openclaw' ? 'openclaw.json' : 'config.yaml');
    const current = 'personal/current';
    const original = tool === 'openclaw' ? { agents: { defaults: { model: current } } } : { model: current };
    await fse.outputFile(file, tool === 'openclaw' ? JSON.stringify(original) : YAML.stringify(original));
    vi.stubEnv('OPENCLAW_CONFIG_PATH', '');
    vi.stubEnv('OPENCLAW_STATE_DIR', path.join(home, '.openclaw'));
    vi.stubEnv('HERMES_HOME', path.join(home, '.hermes'));
    const first = { ...deliveredModel, model_id: 'tokenhub/vendor/model-a' };
    const second = { ...deliveredModel, model_id: 'tokenhub/model-b' };

    for (const [index, candidate] of [first, second].entries()) {
      const acks = stubSync({ id: 80 + index, type: 'apply_model_config', cmd: JSON.stringify(candidate) });
      await localAgent.reportAndSyncLocalAgent({ tool, status: 'running' });
      expect(acks).toContainEqual(expect.objectContaining({ id: 80 + index, status: 'success' }));
    }

    const config = await localAgent.loadLocalAgentConfig();
    if (!config) throw new Error('missing HTTP source');
    const payload = await localAgent.buildReportPayload(config, { tool });
    expect(payload.user_level?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: first.provider, model_id: first.model_id }),
      expect.objectContaining({ provider: second.provider, model_id: second.model_id }),
    ]));
    const data = YAML.parse(await fse.readFile(file, 'utf8'));
    expect(tool === 'openclaw' ? data.agents.defaults.model : data.model).toBe(current);

    stubSync({ id: 85, type: 'apply_model_config', cmd: JSON.stringify({ models: [] }) });
    await localAgent.reportAndSyncLocalAgent({ tool, status: 'running' });
    const after = YAML.parse(await fse.readFile(file, 'utf8'));
    expect(tool === 'openclaw' ? after.agents.defaults.model : after.model).toBe(current);
    const cleared = await localAgent.buildReportPayload(config, { tool });
    expect(cleared.user_level?.models ?? []).toEqual([]);
  });

  it('follows an env-moved home rather than the default one', async () => {
    const moved = path.join(home, 'hermes-moved');
    await fse.ensureDir(moved);
    vi.stubEnv('HERMES_HOME', moved);
    const acks = stubSync({ id: 95, type: 'apply_model_config', cmd: JSON.stringify(deliveredModel) });

    await localAgent.reportAndSyncLocalAgent({ tool: 'hermes', status: 'running' });

    expect(acks).toContainEqual(expect.objectContaining({ id: 95, status: 'success' }));
    expect(await fse.pathExists(path.join(moved, 'config.yaml'))).toBe(true);
    expect(await fse.pathExists(path.join(home, '.hermes', 'config.yaml'))).toBe(false);
  });

  it.each(['openclaw', 'hermes', 'dsh'] as const)('writes project-scoped %s candidates to the home config that tool reads', async (tool) => {
    const workspace = path.join(home, 'workspace');
    await fse.ensureDir(workspace);
    const configFile = path.join(home, '.teamai/local-agent/config.json');
    const config = await fse.readJson(configFile);
    config.workspaceBindings = { [workspace]: { projectId: 1, ideType: tool } };
    await fse.writeJson(configFile, config);

    if (tool === 'dsh') {
      // DSH persists providers per profile: one that composes the base bundle.
      const profileDir = path.join(home, '.dsh', 'profiles', 'web');
      await fse.outputJson(path.join(profileDir, 'package.json'), {
        name: 'dsh-profile-web',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      });
      await fse.outputFile(path.join(profileDir, 'cordis.patch.yml'), '[]\n');
    }

    const acks = stubSync({
      id: 90, type: 'apply_model_config', cmd: JSON.stringify(deliveredModel),
      scope: 'workspace', workspace_path: workspace,
    });

    await localAgent.reportAndSyncLocalAgent({ tool, cwd: workspace, status: 'running' });

    expect(acks).toContainEqual(expect.objectContaining({ id: 90, status: 'success' }));
    const written = tool === 'openclaw' ? '.openclaw/openclaw.json'
      : tool === 'hermes' ? '.hermes/config.yaml' : '.dsh/profiles/web/cordis.patch.yml';
    expect(await fse.pathExists(path.join(home, written))).toBe(true);
  });
});

describe('local-agent: report local model inventory', () => {
  async function reportedModels(tool: string): Promise<Array<Record<string, unknown>> | undefined> {
    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const payload = (await buildReportPayload(config!, { tool })) as {
      user_level: { models?: Array<Record<string, unknown>> };
    };
    return payload.user_level.models;
  }

  async function reportedWorkspaceModels(
    tool: string,
    cwd: string,
  ): Promise<Array<Record<string, unknown>> | undefined> {
    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const payload = (await buildReportPayload(config!, { cwd, tool })) as {
      workspaces?: Array<{ models?: Array<Record<string, unknown>> }>;
    };
    return payload.workspaces?.find((workspace) => workspace.models)?.models;
  }

  it('omits models entirely when the tool has no model config on disk', async () => {
    expect(await reportedModels('codebuddy')).toBeUndefined();
  });

  it('reports only CodeBuddy models still matching a TeamAI delivery', async () => {
    await fse.outputJson(path.join(home, '.codebuddy/models.json'), {
      models: [{ id: 'user-model', name: 'User Model', vendor: 'openai' }],
    });
    stubSync({ id: 30, type: 'apply_model_config', cmd: JSON.stringify(deliveredModel) });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    expect(await reportedModels('codebuddy')).toEqual([
      {
        provider: 'tokenhub',
        model_id: 'deepseek-v3-0324',
        name: 'DeepSeek V3 0324',
        source: 'enterprise',
      },
    ]);
  });

  it('omits user-owned CodeBuddy models the backend did not deliver', async () => {
    await fse.outputJson(path.join(home, '.codebuddy/models.json'), {
      models: [{ id: 'ok', vendor: 'openai', name: 'OK' }],
    });

    expect(await reportedModels('codebuddy')).toBeUndefined();
  });

  it('still reports a delivered CodeBuddy model after CodeBuddy adds metadata', async () => {
    stubSync({ id: 32, type: 'apply_model_config', cmd: JSON.stringify(deliveredModel) });
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    const configPath = path.join(home, '.codebuddy', 'models.json');
    const config = await fse.readJson(configPath);
    config.models[0].supportsImages = false;
    await fse.writeJson(configPath, config);

    expect(await reportedModels('codebuddy')).toEqual([
      {
        provider: 'tokenhub',
        model_id: 'deepseek-v3-0324',
        name: 'DeepSeek V3 0324',
        source: 'enterprise',
      },
    ]);
  });

  it('keeps CodeBuddy report ownership after Claude receives a different full snapshot', async () => {
    stubSync({
      id: 33,
      type: 'apply_model_config',
      cmd: JSON.stringify({ models: [deliveredModel] }),
    });
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    stubSync({
      id: 34,
      type: 'apply_model_config',
      cmd: JSON.stringify({
        models: [{
          ...deliveredModel,
          provider: 'openai',
          model_id: 'gpt-4o',
          name: 'GPT-4o',
        }],
      }),
    });
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });

    expect(await reportedModels('codebuddy')).toEqual([
      {
        provider: 'tokenhub',
        model_id: 'deepseek-v3-0324',
        name: 'DeepSeek V3 0324',
        source: 'enterprise',
      },
    ]);
  });

  it('keeps CodeBuddy report ownership after WorkBuddy receives a different full snapshot', async () => {
    stubSync({
      id: 37,
      type: 'apply_model_config',
      cmd: JSON.stringify({ models: [deliveredModel] }),
    });
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    stubSync({
      id: 38,
      type: 'apply_model_config',
      cmd: JSON.stringify({
        models: [{
          ...deliveredModel,
          provider: 'Custom',
          model_id: 'hai',
          name: 'hai',
        }],
      }),
    });
    await reportAndSyncLocalAgent({ tool: 'workbuddy', status: 'running' });

    expect(await reportedModels('codebuddy')).toEqual([
      {
        provider: 'tokenhub',
        model_id: 'deepseek-v3-0324',
        name: 'DeepSeek V3 0324',
        source: 'enterprise',
      },
    ]);
    expect(await reportedModels('workbuddy')).toEqual([
      {
        provider: 'Custom',
        model_id: 'hai',
        name: 'hai',
        source: 'enterprise',
      },
    ]);
  });

  it('replaces a previously managed WorkBuddy model on a full snapshot', async () => {
    stubSync({ id: 40, type: 'apply_model_config', cmd: JSON.stringify(deliveredModel) });
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'workbuddy', status: 'running' });

    stubSync({
      id: 41,
      type: 'apply_model_config',
      cmd: JSON.stringify({
        models: [{
          ...deliveredModel,
          provider: 'Custom',
          model_id: 'hai',
          name: 'hai',
        }],
      }),
    });
    await reportAndSyncLocalAgent({ tool: 'workbuddy', status: 'running' });

    const file = await fse.readJson(path.join(home, '.workbuddy/models.json'));
    expect(file.models.map((entry: { id: string }) => entry.id)).toEqual(['hai']);
    expect(await reportedModels('workbuddy')).toEqual([
      {
        provider: 'Custom',
        model_id: 'hai',
        name: 'hai',
        source: 'enterprise',
      },
    ]);
  });

  it('still reports a delivered WorkBuddy model after WorkBuddy adds metadata', async () => {
    stubSync({ id: 42, type: 'apply_model_config', cmd: JSON.stringify(deliveredModel) });
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'workbuddy', status: 'running' });

    const configPath = path.join(home, '.workbuddy', 'models.json');
    const config = await fse.readJson(configPath);
    config.models[0].supportsImages = false;
    await fse.writeJson(configPath, config);

    expect(await reportedModels('workbuddy')).toEqual([
      {
        provider: 'tokenhub',
        model_id: 'deepseek-v3-0324',
        name: 'DeepSeek V3 0324',
        source: 'enterprise',
      },
    ]);
  });

  it('reports a workspace-scoped WorkBuddy model under that workspace', async () => {
    const workspace = path.join(home, 'project');
    await fse.ensureDir(workspace);
    const configPath = path.join(home, '.teamai/local-agent/config.json');
    const config = await fse.readJson(configPath);
    config.workspaceBindings[workspace] = {
      projectId: 5,
      projectName: 'Project 5',
      boundAt: '2026-09-09T00:00:00.000Z',
      ideType: 'workbuddy',
    };
    await fse.writeJson(configPath, config);
    stubSync({
      id: 46,
      type: 'apply_model_config',
      scope: 'workspace',
      workspace_path: workspace,
      cmd: JSON.stringify(deliveredModel),
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ cwd: workspace, tool: 'workbuddy', status: 'running' });

    expect(await reportedModels('workbuddy')).toBeUndefined();
    expect(await reportedWorkspaceModels('workbuddy', workspace)).toEqual([
      {
        provider: 'tokenhub',
        model_id: 'deepseek-v3-0324',
        name: 'DeepSeek V3 0324',
        source: 'enterprise',
      },
    ]);
  });

  it('reports the Claude gateway model with the delivered provider restored', async () => {
    stubSync({ id: 31, type: 'apply_model_config', cmd: JSON.stringify(deliveredModel) });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'claude', status: 'running' });

    expect(await reportedModels('claude')).toEqual([
      {
        provider: 'tokenhub',
        model_id: 'deepseek-v3-0324',
        name: 'DeepSeek V3 0324',
        source: 'enterprise',
      },
    ]);
  });

  it('does not report a user-configured Claude gateway', async () => {
    await fse.outputJson(path.join(home, '.claude/settings.json'), {
      env: {
        ANTHROPIC_BASE_URL: 'https://gateway.example.com',
        ANTHROPIC_CUSTOM_MODEL_OPTION: 'my-own-model',
      },
    });

    expect(await reportedModels('claude')).toBeUndefined();
  });
});

describe('releaseClaudeModelConfig', () => {
  it('drops the delivered gateway env and profile from the given root and forgets them', async () => {
    const { releaseClaudeModelConfig } = await import('../local-agent.js');
    const root = path.join(home, '.claude-old');
    const env = { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'secret', KEEP: 'mine' };
    await fse.outputJson(path.join(root, 'settings.json'), { env });
    await fse.outputJson(path.join(root, 'teamai-models.json'), { env });
    const { entryHash } = await import('../resources/mcp-format.js');
    await fse.outputJson(path.join(home, '.teamai/local-agent/model-manifest.json'), {
      claudeEnv: { ANTHROPIC_BASE_URL: entryHash(env.ANTHROPIC_BASE_URL), ANTHROPIC_AUTH_TOKEN: entryHash(env.ANTHROPIC_AUTH_TOKEN) },
    });

    await releaseClaudeModelConfig(root);

    expect((await fse.readJson(path.join(root, 'settings.json'))).env).toEqual({ KEEP: 'mine' });
    expect(await fse.pathExists(path.join(root, 'teamai-models.json'))).toBe(false);
    expect((await fse.readJson(path.join(home, '.teamai/local-agent/model-manifest.json'))).claudeEnv).toEqual({});
  });

  it('touches nothing when no model was ever delivered', async () => {
    const { releaseClaudeModelConfig } = await import('../local-agent.js');
    const root = path.join(home, '.claude-old');
    await releaseClaudeModelConfig(root);
    expect(await fse.pathExists(root)).toBe(false);
    // Nor is an empty manifest written just to record that nothing was there.
    expect(await fse.pathExists(path.join(home, '.teamai/local-agent/model-manifest.json'))).toBe(false);
  });
});

describe('delivered model settings', () => {

let root: string;
let savedOpenclawConfig: string | undefined;

function model(modelId: string, overrides: Partial<DeliveredModel> = {}): DeliveredModel {
  return {
    provider: 'deepseek',
    model_id: modelId,
    name: `Model ${modelId}`,
    base_url: 'https://proxy.example.test/v1',
    api_key: 'sk-teamai-test',
    context_window: 128_000,
    max_tokens: 8_192,
    ...overrides,
  };
}

const OpenclawModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
}).passthrough();

const OpenclawProviderSchema = z.object({
  api: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  models: z.array(OpenclawModelSchema).optional(),
}).passthrough();

const OpenclawDocSchema = z.object({
  agents: z.unknown().optional(),
  models: z.object({ providers: z.record(z.string(), OpenclawProviderSchema).optional() }).passthrough().optional(),
}).passthrough();

const HermesProviderSchema = z.object({
  api: z.string().optional(),
  api_key: z.string().optional(),
  transport: z.string().optional(),
  discover_models: z.boolean().optional(),
  models: z.record(z.string(), z.object({ context_length: z.number().optional() }).passthrough()).optional(),
}).passthrough();

const HermesDocSchema = z.object({
  model: z.unknown().optional(),
  providers: z.record(z.string(), HermesProviderSchema).optional(),
}).passthrough();

const DshModelSchema = z.object({ id: z.string(), name: z.string().optional() }).passthrough();

const DshProviderSchema = z.object({
  api: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  baseURL: z.string().optional(),
  models: z.array(DshModelSchema).optional(),
}).passthrough();

const DshRowSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  config: z.object({ providers: z.record(z.string(), DshProviderSchema).optional() }).passthrough().optional(),
}).passthrough();

const DshPatchSchema = z.array(DshRowSchema);

const CredentialsSchema = z.object({
  version: z.number().optional(),
  refs: z.record(z.string(), z.string()).optional(),
}).passthrough();

function readOpenclaw(file: string): z.infer<typeof OpenclawDocSchema> {
  return OpenclawDocSchema.parse(JSON5.parse(fs.readFileSync(file, 'utf8')));
}

function openclawProvider(file: string): z.infer<typeof OpenclawProviderSchema> {
  return readOpenclaw(file).models?.providers?.teamai ?? {};
}

function readHermes(file: string): z.infer<typeof HermesDocSchema> {
  return HermesDocSchema.parse(YAML.parse(fs.readFileSync(file, 'utf8')));
}

function readDshPatch(file: string): z.infer<typeof DshPatchSchema> {
  return DshPatchSchema.parse(YAML.parse(fs.readFileSync(file, 'utf8')));
}

function readCredentials(file: string): z.infer<typeof CredentialsSchema> {
  return CredentialsSchema.parse(YAML.parse(fs.readFileSync(file, 'utf8')));
}

function documentMap(doc: YAML.Document): YAML.YAMLMap {
  if (!YAML.isMap(doc.contents)) throw new Error('document root is not a mapping');

  return doc.contents;
}

function mapIn(node: YAML.YAMLMap, key: string): YAML.YAMLMap {
  const value = node.get(key);

  if (!YAML.isMap(value)) throw new Error(`${key} is not a mapping`);

  return value;
}

function seqIn(node: YAML.YAMLMap, key: string): YAML.YAMLSeq {
  const value = node.get(key);

  if (!YAML.isSeq(value)) throw new Error(`${key} is not a sequence`);

  return value;
}

function dshRow(doc: YAML.Document): YAML.YAMLMap {
  if (!YAML.isSeq(doc.contents)) throw new Error('patch is not a sequence');

  const row = doc.contents.items.find((item) => YAML.isMap(item) && item.get('id') === 'llm-pi-ai');

  if (!YAML.isMap(row)) throw new Error('no llm-pi-ai row');

  return row;
}

function firstMap(seq: YAML.YAMLSeq): YAML.YAMLMap {
  const [first] = seq.items;

  if (!YAML.isMap(first)) throw new Error('first item is not a mapping');

  return first;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-model-delivery-'));
  savedOpenclawConfig = process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_CONFIG_PATH;
});

afterEach(() => {
  if (savedOpenclawConfig === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
  else process.env.OPENCLAW_CONFIG_PATH = savedOpenclawConfig;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenClaw delivered model candidates', () => {
  it('adds two candidates, accumulates a later one, and never changes the current model', async () => {
    const file = path.join(root, 'openclaw.json');

    fs.writeFileSync(file, [
      '// member comment',
      '{',
      '  "agents": { "defaults": { "model": { "primary": "member/keep" } } },',
      '  "models": { "providers": {} }',
      '}',
      '',
    ].join('\n'));

    const first = await reconcile('openclaw', [model('deepseek-v4-pro')], false, undefined, root);
    const second = await reconcile('openclaw', [model('vendor/models/flash')], false, first, root);
    const updated = await reconcile(
      'openclaw',
      [model('deepseek-v4-pro', { name: 'Renamed Pro' })],
      false,
      second,
      root,
    );

    const provider = openclawProvider(file);

    expect(provider.api).toBe('openai-completions');
    expect(provider.baseUrl).toBe('https://proxy.example.test/v1');
    expect(provider.apiKey).toBe('sk-teamai-test');
    expect(provider.models?.map((entry) => entry.id)).toEqual(['deepseek-v4-pro', 'vendor/models/flash']);
    expect(provider.models?.[0]?.name).toBe('Renamed Pro');
    expect(provider.models?.[0]?.contextWindow).toBe(128_000);
    expect(provider.models?.[0]?.maxTokens).toBe(8_192);
    expect(fs.readFileSync(file, 'utf8')).toContain('// member comment');
    expect(readOpenclaw(file).agents).toEqual({ defaults: { model: { primary: 'member/keep' } } });
    expect(ModelDeliveryRecordSchema.parse(updated).files[file]?.entries['deepseek-v4-pro']).toBeDefined();
  });

  it('removes only managed entries on a full snapshot and keeps member entries', async () => {
    const file = path.join(root, 'openclaw.json');
    const installed = await reconcile(
      'openclaw',
      [model('managed-a'), model('managed-b')],
      false,
      undefined,
      root,
    );

    const doc = readOpenclaw(file);
    const providers = doc.models?.providers;

    if (!providers) throw new Error('no providers');

    providers.teamai?.models?.push({ id: 'member-model', name: 'Member' });
    providers.member = { baseUrl: 'https://member.test/v1', models: [{ id: 'member-only' }] };
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);

    const full = await reconcile('openclaw', [model('managed-b')], true, installed, root);

    expect(openclawProvider(file).models?.map((entry) => entry.id)).toEqual(['managed-b', 'member-model']);
    expect(Object.keys(readOpenclaw(file).models?.providers ?? {})).toEqual(['teamai', 'member']);

    const emptied = await reconcile('openclaw', [], true, full, root);

    expect(openclawProvider(file).models?.map((entry) => entry.id)).toEqual(['member-model']);
    expect(Object.keys(readOpenclaw(file).models?.providers ?? {})).toEqual(['teamai', 'member']);
    expect(emptied.files).toEqual({});
  });

  it('keeps a member-edited managed entry and reports the conflict instead of overwriting it', async () => {
    const file = path.join(root, 'openclaw.json');
    const installed = await reconcile('openclaw', [model('managed-a')], false, undefined, root);
    const doc = readOpenclaw(file);
    const entry = doc.models?.providers?.teamai?.models?.[0];

    if (!entry) throw new Error('no managed entry');
    entry.name = 'Member Edited';
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    const before = fs.readFileSync(file, 'utf8');

    await expect(reconcile('openclaw', [model('managed-a')], false, installed, root)).rejects.toThrow(/does not manage/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(await scanDeliveredModels('openclaw', installed)).toEqual([]);

    const cleaned = await reconcile('openclaw', [], true, installed, root);

    expect(openclawProvider(file).models?.[0]?.name).toBe('Member Edited');
    expect(cleaned.files).toEqual({});
  });

  it('refuses an existing unrecorded provider', async () => {
    const file = path.join(root, 'openclaw.json');

    fs.writeFileSync(file, `${JSON.stringify({
      models: { providers: { teamai: { baseUrl: 'https://other.test/v1', apiKey: 'sk-other', models: [] } } },
    }, null, 2)}\n`);
    const before = fs.readFileSync(file, 'utf8');

    await expect(reconcile('openclaw', [model('managed-a')], false, undefined, root))
      .rejects.toThrow(/different base URL/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('adopts a provider with the same connection details and no record', async () => {
    const file = path.join(root, 'openclaw.json');

    fs.writeFileSync(file, `${JSON.stringify({
      models: {
        providers: {
          teamai: { baseUrl: 'https://proxy.example.test/v1', apiKey: 'sk-teamai-test', api: 'openai-completions', models: [] },
        },
      },
    }, null, 2)}\n`);

    const installed = await reconcile('openclaw', [model('managed-a')], false, undefined, root);
    const entries = installed.files[file]?.entries ?? {};

    expect(openclawProvider(file).models?.map((entry) => entry.id)).toEqual(['managed-a']);
    expect(Object.keys(entries)).toEqual(['managed-a']);
  });

  it('adopts identical entries left by an earlier install', async () => {
    const file = path.join(root, 'openclaw.json');

    fs.writeFileSync(file, `${JSON.stringify({
      models: {
        providers: {
          teamai: {
            baseUrl: 'https://proxy.example.test/v1',
            apiKey: 'sk-teamai-test',
            api: 'openai-completions',
            models: [{ id: 'managed-a', name: 'Model managed-a', contextWindow: 128_000, maxTokens: 8_192 }],
          },
        },
      },
    }, null, 2)}\n`);

    const installed = await reconcile('openclaw', [model('managed-a')], false, undefined, root);

    expect(openclawProvider(file).models).toEqual([{ id: 'managed-a', name: 'Model managed-a', contextWindow: 128_000, maxTokens: 8_192 }]);
    expect(Object.keys(installed.files[file]?.entries ?? {})).toEqual(['managed-a']);
  });

  it('retains a provider whose metadata a member added when cleanup removes the last managed model', async () => {
    const file = path.join(root, 'openclaw.json');
    const installed = await reconcile('openclaw', [model('managed-a')], false, undefined, root);
    const doc = readOpenclaw(file);
    const provider = doc.models?.providers?.teamai;

    if (!provider) throw new Error('no managed provider');
    provider.timeoutSeconds = 30;
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);

    const cleaned = await reconcile('openclaw', [], true, installed, root);

    expect(openclawProvider(file).timeoutSeconds).toBe(30);
    expect(openclawProvider(file).models).toEqual([]);
    expect(cleaned.files).toEqual({});
  });

  it('keeps a full model id with slashes and scans the disk identity', async () => {
    const file = path.join(root, 'openclaw.json');
    const manifest = await reconcile('openclaw', [model('vendor/models/deepseek-v4')], false, undefined, root);

    expect(openclawProvider(file).models?.[0]?.id).toBe('vendor/models/deepseek-v4');
    expect(await scanDeliveredModels('openclaw', manifest)).toEqual([{
      provider: 'deepseek',
      model_id: 'vendor/models/deepseek-v4',
      name: 'Model vendor/models/deepseek-v4',
      source: 'enterprise',
    }]);

    const doc = readOpenclaw(file);
    const entry = doc.models?.providers?.teamai?.models?.[0];

    if (!entry) throw new Error('no managed entry');
    entry.name = 'Changed elsewhere';
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);

    expect(await scanDeliveredModels('openclaw', manifest)).toEqual([]);
  });

  it('leaves a malformed file untouched', async () => {
    const file = path.join(root, 'openclaw.json');
    const before = '{ not json at all';

    fs.writeFileSync(file, before);

    await expect(reconcile('openclaw', [model('managed-a')], false, undefined, root))
      .rejects.toThrow(/does not parse/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('honors OPENCLAW_CONFIG_PATH', async () => {
    const override = path.join(root, 'elsewhere', 'openclaw.json');

    fs.mkdirSync(path.dirname(override), { recursive: true });
    process.env.OPENCLAW_CONFIG_PATH = override;

    const manifest = await reconcile('openclaw', [model('managed-a')], false, undefined, root);

    expect(fs.existsSync(override)).toBe(true);
    expect(Object.keys(manifest.files)).toEqual([override]);
    expect(fs.existsSync(path.join(root, 'openclaw.json'))).toBe(false);
  });

  it('isolates roots and cleans the old root when the root moves', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-model-delivery-other-'));

    try {
      const first = await reconcile('openclaw', [model('root-a')], false, undefined, root);

      expect(openclawProvider(path.join(root, 'openclaw.json')).models?.[0]?.id).toBe('root-a');
      expect(fs.existsSync(path.join(other, 'openclaw.json'))).toBe(false);

      const moved = await reconcile('openclaw', [model('root-b')], false, first, other);

      expect(openclawProvider(path.join(root, 'openclaw.json')).models).toBeUndefined();
      expect(openclawProvider(path.join(other, 'openclaw.json')).models?.map((entry) => entry.id)).toEqual(['root-b']);
      expect(Object.keys(moved.files)).toEqual([path.join(other, 'openclaw.json')]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('Hermes delivered model candidates', () => {
  it('writes managed candidates while keeping the current model, member providers, and comments', async () => {
    const file = path.join(root, 'config.yaml');

    fs.writeFileSync(file, [
      '# member comment',
      'model:',
      '  provider: openrouter',
      '  default: keep-me',
      'providers:',
      '  other:',
      '    api: https://other.test/v1',
      '    key_env: OTHER_KEY',
      '    models:',
      '      other-model:',
      '        context_length: 1000',
      '',
    ].join('\n'));

    const first = await reconcile('hermes', [model('deepseek-v4-pro')], false, undefined, root);
    const manifest = await reconcile('hermes', [model('vendor/models/flash', { context_window: 64_000 })], false, first, root);
    const config = readHermes(file);

    expect(config.model).toEqual({ provider: 'openrouter', default: 'keep-me' });
    expect(config.providers?.other?.models).toEqual({ 'other-model': { context_length: 1000 } });
    expect(config.providers?.teamai).toEqual({
      api: 'https://proxy.example.test/v1',
      api_key: 'sk-teamai-test',
      transport: 'chat_completions',
      discover_models: false,
      models: {
        'deepseek-v4-pro': { context_length: 128_000 },
        'vendor/models/flash': { context_length: 64_000 },
      },
    });
    expect(fs.readFileSync(file, 'utf8')).toContain('# member comment');
    expect(await scanDeliveredModels('hermes', manifest)).toEqual([
      { provider: 'deepseek', model_id: 'deepseek-v4-pro', name: 'Model deepseek-v4-pro', source: 'enterprise' },
      { provider: 'deepseek', model_id: 'vendor/models/flash', name: 'Model vendor/models/flash', source: 'enterprise' },
    ]);
  });

  it('removes only managed models on cleanup and keeps a member-added model', async () => {
    const file = path.join(root, 'config.yaml');
    const installed = await reconcile('hermes', [model('managed-a'), model('managed-b')], false, undefined, root);
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    const models = mapIn(mapIn(documentMap(doc), 'providers'), 'teamai');

    mapIn(models, 'models').set('member-model', doc.createNode({ context_length: 2000 }));
    fs.writeFileSync(file, doc.toString());

    const full = await reconcile('hermes', [model('managed-b')], true, installed, root);

    expect(readHermes(file).providers?.teamai?.models).toEqual({
      'managed-b': { context_length: 128_000 },
      'member-model': { context_length: 2000 },
    });

    await reconcile('hermes', [], true, full, root);

    expect(readHermes(file).providers?.teamai?.models).toEqual({ 'member-model': { context_length: 2000 } });
  });

  it('refuses a provider that already uses a different credential mechanism', async () => {
    const file = path.join(root, 'config.yaml');

    fs.writeFileSync(file, [
      'providers:',
      '  teamai:',
      '    api: https://proxy.example.test/v1',
      '    key_env: MEMBER_KEY',
      '',
    ].join('\n'));
    const before = fs.readFileSync(file, 'utf8');

    await expect(reconcile('hermes', [model('managed-a')], false, undefined, root))
      .rejects.toThrow(/does not overwrite/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('leaves malformed YAML untouched', async () => {
    const file = path.join(root, 'config.yaml');
    const before = 'providers: [unclosed';

    fs.writeFileSync(file, before);

    await expect(reconcile('hermes', [model('managed-a')], false, undefined, root))
      .rejects.toThrow(/does not parse as YAML/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

function seedDshProfile(base: string, name = 'web'): string {
  const dir = path.join(base, 'profiles', name);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n');

  return path.join(dir, 'cordis.patch.yml');
}

describe('DeepSeek Harness delivered model candidates', () => {
  it('persists candidates in the profile patch and the credential store, then updates one', async () => {
    const patch = seedDshProfile(root);
    const credentials = path.join(root, '.credentials.yaml');
    const first = await reconcile('dsh', [model('deepseek-v4-pro')], false, undefined, root);
    const manifest = await reconcile('dsh', [model('vendor/models/flash')], false, first, root);
    const updated = await reconcile('dsh', [model('deepseek-v4-pro', { name: 'Renamed' })], false, manifest, root);
    const row = readDshPatch(patch).find((entry) => entry.id === 'llm-pi-ai');

    expect(row?.name).toBe('@deepseek-ai/dsh-llm-pi-ai');
    expect(row?.config?.providers?.teamai).toMatchObject({
      api: 'openai-completions',
      apiKeyEnv: 'TEAMAI_MODEL_API_KEY',
      baseURL: 'https://proxy.example.test/v1',
    });
    expect(row?.config?.providers?.teamai?.models?.map((entry) => entry.id)).toEqual(['deepseek-v4-pro', 'vendor/models/flash']);
    expect(row?.config?.providers?.teamai?.models?.[0]?.name).toBe('Renamed');

    const store = readCredentials(credentials);

    expect(store.version).toBe(1);
    expect(store.refs?.TEAMAI_MODEL_API_KEY).toBe('sk-teamai-test');

    if (process.platform !== 'win32') expect(fs.statSync(credentials).mode & 0o777).toBe(0o600);

    expect(readDshPatch(patch).some((entry) => entry.id === 'agent-default-model')).toBe(false);
    expect(updated.credentials?.[credentials]).toMatchObject({ ref: 'TEAMAI_MODEL_API_KEY', created: true });
    expect((await scanDeliveredModels('dsh', updated)).map((entry) => entry.model_id)).toEqual(['deepseek-v4-pro', 'vendor/models/flash']);
  });

  it('removes managed candidates on a full snapshot and empty cleanup while keeping member models', async () => {
    const patch = seedDshProfile(root);
    const installed = await reconcile('dsh', [model('managed-a'), model('managed-b')], false, undefined, root);
    const doc = YAML.parseDocument(fs.readFileSync(patch, 'utf8'));
    const row = dshRow(doc);
    const provider = mapIn(mapIn(row, 'config'), 'providers');

    seqIn(mapIn(provider, 'teamai'), 'models').items.push(doc.createNode({ id: 'member-model', name: 'Member' }));
    fs.writeFileSync(patch, doc.toString());

    const full = await reconcile('dsh', [model('managed-b')], true, installed, root);

    expect(readDshPatch(patch)[0]?.config?.providers?.teamai?.models?.map((entry) => entry.id))
      .toEqual(['managed-b', 'member-model']);

    await reconcile('dsh', [], true, full, root);

    expect(readDshPatch(patch)[0]?.config?.providers?.teamai?.models?.map((entry) => entry.id)).toEqual(['member-model']);
    expect(readCredentials(path.join(root, '.credentials.yaml')).refs?.TEAMAI_MODEL_API_KEY).toBe('sk-teamai-test');
  });

  it('removes the llm-pi-ai row and its credential entry on empty cleanup', async () => {
    const patch = seedDshProfile(root);
    const installed = await reconcile('dsh', [model('managed-a')], false, undefined, root);

    const cleaned = await reconcile('dsh', [], true, installed, root);

    expect(readDshPatch(patch)).toEqual([]);
    expect(cleaned.files).toEqual({});
    expect(fs.existsSync(path.join(root, '.credentials.yaml'))).toBe(false);
  });

  it('retains the provider and credential when a member changed provider metadata', async () => {
    const patch = seedDshProfile(root);
    const credentials = path.join(root, '.credentials.yaml');
    const installed = await reconcile('dsh', [model('managed-a')], false, undefined, root);
    const doc = YAML.parseDocument(fs.readFileSync(patch, 'utf8'));
    const provider = mapIn(mapIn(mapIn(dshRow(doc), 'config'), 'providers'), 'teamai');

    provider.set('displayName', 'Member Label');
    fs.writeFileSync(patch, doc.toString());

    const cleaned = await reconcile('dsh', [], true, installed, root);
    const retained = readDshPatch(patch)[0]?.config?.providers?.teamai;

    expect(retained?.displayName).toBe('Member Label');
    expect(retained?.models).toEqual([]);
    expect(fs.existsSync(credentials)).toBe(true);
    expect(cleaned.credentials?.[credentials]).toBeDefined();
    await reconcile('dsh', [], true, cleaned, root);
    expect(readCredentials(credentials).refs?.TEAMAI_MODEL_API_KEY).toBe('sk-teamai-test');
    expect(readDshPatch(patch)[0]?.config?.providers?.teamai?.displayName).toBe('Member Label');
  });

  it('does not overwrite a conflicting credential value', async () => {
    const patch = seedDshProfile(root);
    const credentials = path.join(root, '.credentials.yaml');

    fs.writeFileSync(credentials, 'version: 1\nrefs:\n  TEAMAI_MODEL_API_KEY: member-token\n');
    fs.chmodSync(credentials, 0o600);
    const beforePatch = fs.readFileSync(patch, 'utf8');
    const beforeCredentials = fs.readFileSync(credentials, 'utf8');

    await expect(reconcile('dsh', [model('managed-a')], false, undefined, root))
      .rejects.toThrow(/different API key/);
    expect(fs.readFileSync(patch, 'utf8')).toBe(beforePatch);
    expect(fs.readFileSync(credentials, 'utf8')).toBe(beforeCredentials);
  });

  it('keeps a member-edited managed model and reports the conflict', async () => {
    const patch = seedDshProfile(root);
    const installed = await reconcile('dsh', [model('managed-a')], false, undefined, root);
    const doc = YAML.parseDocument(fs.readFileSync(patch, 'utf8'));
    const models = mapIn(mapIn(mapIn(dshRow(doc), 'config'), 'providers'), 'teamai');

    firstMap(seqIn(models, 'models')).set('name', 'Member Edited');
    fs.writeFileSync(patch, doc.toString());
    const before = fs.readFileSync(patch, 'utf8');

    await expect(reconcile('dsh', [model('managed-a')], false, installed, root))
      .rejects.toThrow(/does not manage/);
    expect(fs.readFileSync(patch, 'utf8')).toBe(before);
    expect(await scanDeliveredModels('dsh', installed)).toEqual([]);
  });

  it('leaves a malformed patch and refuses a root without an initialized profile', async () => {
    const patch = seedDshProfile(root);

    fs.writeFileSync(patch, '- id: [unclosed');
    const before = fs.readFileSync(patch, 'utf8');

    await expect(reconcile('dsh', [model('managed-a')], false, undefined, root))
      .rejects.toThrow(/does not parse as YAML/);
    expect(fs.readFileSync(patch, 'utf8')).toBe(before);
    await expect(reconcile('dsh', [model('managed-a')], false, undefined, path.join(root, 'empty')))
      .rejects.toThrow(/no initialized profile/);
  });

  it('skips a profile whose bundles do not include the base bundle', async () => {
    seedDshProfile(root, 'sdk-minimal');
    const dir = path.join(root, 'profiles', 'sdk-minimal');

    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-sdk-minimal',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-sdk-minimal'] } },
    }, null, 2)}\n`);

    await expect(reconcile('dsh', [model('managed-a')], false, undefined, root))
      .rejects.toThrow(/no initialized profile/);
    expect(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')).toBe('[]\n');
  });

  it('includes a profile that already declares the llm-pi-ai row, even without the base bundle', async () => {
    const patch = seedDshProfile(root, 'custom');
    const dir = path.join(root, 'profiles', 'custom');

    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-custom',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-sdk-minimal'] } },
    }, null, 2)}\n`);
    fs.writeFileSync(patch, [
      '- id: llm-pi-ai',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers: {}',
      '',
    ].join('\n'));

    await reconcile('dsh', [model('managed-a')], false, undefined, root);

    expect(readDshPatch(patch)[0]?.config?.providers?.teamai?.models?.map((entry) => entry.id)).toEqual(['managed-a']);
  });

  it('includes a profile whose installed custom bundle composes the llm-pi-ai row', async () => {
    const patch = seedDshProfile(root, 'custom-bundle');
    const dir = path.join(root, 'profiles', 'custom-bundle');
    const bundleDir = path.join(root, 'profiles', 'node_modules', '@acme', 'dsh-custom-bundle');

    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-custom-bundle',
      dsh: { profile: { bundles: ['@acme/dsh-custom-bundle'] } },
    }, null, 2)}\n`);
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'package.json'), `${JSON.stringify({
      name: '@acme/dsh-custom-bundle',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(bundleDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: llm-pi-ai',
      "      name: '@deepseek-ai/dsh-llm-pi-ai'",
      '      config:',
      '        providers:',
      '          personal:',
      '            api: openai-completions',
      '            baseURL: https://personal.example/v1',
      '            models: [{id: personal-model}]',
      '',
    ].join('\n'));

    const installed = await reconcile('dsh', [model('managed-a')], false, undefined, root);

    expect(readDshPatch(patch)[0]?.config?.providers?.teamai?.models?.map((entry) => entry.id)).toEqual(['managed-a']);
    expect(readDshPatch(patch)[0]?.config?.providers?.personal?.models).toEqual([{ id: 'personal-model' }]);
    await reconcile('dsh', [], true, installed, root);
    expect(readDshPatch(patch)).toEqual([]);
  });

  it('edits an inline profile plugin without shadowing its personal providers', async () => {
    const patch = seedDshProfile(root);
    const personal = { api: 'openai-completions', baseURL: 'https://personal.example/v1', models: [{ id: 'mine' }] };
    const original = [{ insert: [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { personal } } }] }];
    fs.writeFileSync(patch, YAML.stringify(original));
    const installed = await reconcile('dsh', [model('managed-a')], false, undefined, root);
    const rows = z.array(z.object({ insert: z.array(DshRowSchema) })).parse(YAML.parse(fs.readFileSync(patch, 'utf8')));

    expect(rows[0]?.insert[0]?.config?.providers?.personal).toEqual(personal);
    expect(rows[0]?.insert[0]?.config?.providers?.teamai?.models?.[0]?.id).toBe('managed-a');
    expect(rows).toHaveLength(1);
    await reconcile('dsh', [], true, installed, root);
    expect(YAML.parse(fs.readFileSync(patch, 'utf8'))).toEqual(original);
  });

  it('rejects a home-level LLM override before changing any profile or credential', async () => {
    const patch = seedDshProfile(root);
    const original = fs.readFileSync(patch, 'utf8');
    const homePatch = path.join(root, 'cordis.patch.yml');
    const homeConfig = YAML.stringify([{ id: 'llm-pi-ai', config: { providers: { personal: { models: [{ id: 'mine' }] } } } }]);
    fs.writeFileSync(homePatch, homeConfig);

    await expect(reconcile('dsh', [model('managed-a')], false, undefined, root)).rejects.toThrow(/cordis.patch.yml/);
    expect(fs.readFileSync(patch, 'utf8')).toBe(original);
    expect(fs.readFileSync(homePatch, 'utf8')).toBe(homeConfig);
    expect(fs.existsSync(path.join(root, '.credentials.yaml'))).toBe(false);
  });
});

describe('model delivery transaction', () => {
  it('restores every written file when the record commit fails', async () => {
    const file = path.join(root, 'openclaw.json');
    const original = '// keep\n{\n  "models": { "providers": {} }\n}\n';

    fs.writeFileSync(file, original);

    await expect(reconcile('openclaw', [model('managed-a')], false, undefined, root, async () => {
      throw new Error('manifest write failed');
    })).rejects.toThrow(/manifest write failed.*restored/);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

});
});
