import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
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

beforeEach(async () => {
  home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-config-'));
  originalHome = process.env.HOME;
  process.env.HOME = home;
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
  vi.restoreAllMocks();
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
  it('persists a direct model payload for CodeBuddy and Claude, then acks with the task type', async () => {
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

    const claude = await fse.readJson(path.join(home, '.claude/settings.json'));
    expect(claude.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'deepseek-v3-0324',
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'DeepSeek V3 0324',
    });
    const claudeProfile = await fse.readJson(path.join(home, '.claude/teamai-models.json'));
    expect(claudeProfile.env).toEqual(claude.env);

    expect(acks).toContainEqual(expect.objectContaining({
      id: 16,
      type: 'apply_model_config',
      status: 'success',
    }));
    expect((await fs.promises.stat(path.join(home, '.codebuddy/models.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.promises.stat(path.join(home, '.claude/teamai-models.json'))).mode & 0o777).toBe(0o600);
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
    expect(await fse.pathExists(path.join(home, '.claude/teamai-models.json'))).toBe(true);
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

  it('retains CodeBuddy ownership when Claude reconciliation fails', async () => {
    await fse.outputJson(path.join(home, '.claude/settings.json'), { env: 'invalid' });
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    const firstAcks = stubSync({
      id: 25,
      type: 'apply_model_config',
      cmd: JSON.stringify(deliveredModel),
    });
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });
    expect(firstAcks[0]?.status).toBe('failed');

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

  it('silently skips unknown task types without acknowledging failure', async () => {
    const acks = stubSync({ id: 21, type: 'future_model_task', cmd: '{}' });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', status: 'running' });

    expect(acks).toEqual([]);
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
