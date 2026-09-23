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
    expect((reports[1]?.user_level as { models?: unknown[] }).models).toEqual([
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
    expect(await fse.readFile(path.join(workspace, '.codebuddy/.gitignore'), 'utf8')).toContain('models.json');
    expect(await fse.pathExists(path.join(home, '.workbuddy/models.json'))).toBe(false);
    expect(acks[0]?.status).toBe('success');
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
    await reportAndSyncLocalAgent({ cwd: workspace, tool: 'workbuddy', status: 'running' });

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
    process.env.ANTHROPIC_BASE_URL = 'https://api.model.haihub.cn';
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
