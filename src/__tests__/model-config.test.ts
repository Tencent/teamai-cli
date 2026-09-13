import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { contextSuffix } from '../model/tool-targets.js';
import { deepMerge } from '../model/merge.js';
import { DEFAULT_PROVIDER, getProvider, resolveApiKey, uniqueModels } from '../model/providers.js';
import { ModelConfigService } from '../model/service.js';

const DIR_OVERRIDES = [
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'DSH_HOME',
  'CODEX_HOME',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_CONFIG_PATH',
  'HERMES_HOME',
  'QODER_CONFIG_DIR',
];

let home: string;
let originalHome: string | undefined;
let originalDirs: Record<string, string | undefined>;
let originalKey: string | undefined;

beforeEach(async () => {
  home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-'));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  originalDirs = {};
  for (const key of DIR_OVERRIDES) {
    originalDirs[key] = process.env[key];
    delete process.env[key];
  }
  originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const [key, value] of Object.entries(originalDirs)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
  vi.restoreAllMocks();
  await fse.remove(home);
});

const service = new ModelConfigService();

describe('contextSuffix', () => {
  it('uses m for millions and k for thousands', () => {
    expect(contextSuffix(1_000_000)).toBe('[1m]');
    expect(contextSuffix(2_000_000)).toBe('[2m]');
    expect(contextSuffix(128_000)).toBe('[128k]');
  });

  it('falls back to raw tokens for non-round values and empty for invalid ones', () => {
    expect(contextSuffix(12_345)).toBe('[12345]');
    expect(contextSuffix(undefined)).toBe('');
    expect(contextSuffix(0)).toBe('');
    expect(contextSuffix(-1)).toBe('');
    expect(contextSuffix(1.5)).toBe('');
  });
});

describe('deepMerge', () => {
  it('overwrites scalars and merges nested objects', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 9, c: 3 })).toEqual({ a: 1, b: 9, c: 3 });
    expect(deepMerge({ env: { A: '1', B: '2' } }, { env: { B: '9', C: '3' } })).toEqual({
      env: { A: '1', B: '9', C: '3' },
    });
  });

  it('appends arrays without duplicates', () => {
    expect(deepMerge({ list: ['a', 'b'] }, { list: ['b', 'c'] })).toEqual({ list: ['a', 'b', 'c'] });
  });

  it('upserts object arrays by id instead of appending a second entry', () => {
    const merged = deepMerge(
      { models: [{ id: 'a', key: 'old' }, { id: 'b' }] },
      { models: [{ id: 'a', key: 'new' }, { id: 'c' }] },
    );
    expect(merged.models).toEqual([{ id: 'a', key: 'new' }, { id: 'b' }, { id: 'c' }]);
  });

  it('does not mutate its inputs', () => {
    const base = { models: [{ id: 'a' }], env: { A: '1' } };
    const patch = { models: [{ id: 'b' }], env: { B: '2' } };
    const snapshot = JSON.stringify({ base, patch });
    deepMerge(base, patch);
    expect(JSON.stringify({ base, patch })).toBe(snapshot);
  });
});

describe('providers', () => {
  it('defaults to deepseek and lists the built-ins', () => {
    expect(DEFAULT_PROVIDER).toBe('deepseek');
    expect(getProvider('deepseek').name).toBe('DeepSeek');
    expect(() => getProvider('nope')).toThrow(/available/);
  });

  it('deduplicates models reused across tiers', () => {
    expect(uniqueModels(getProvider('deepseek')).map((m) => m.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
    ]);
    expect(uniqueModels(getProvider('qwen')).map((m) => m.id)).toEqual(['qwen3-coder-plus']);
  });

  it('resolves the api-key placeholder from the environment', () => {
    expect(resolveApiKey(getProvider('deepseek'))).toEqual({
      isPlaceholder: true,
      envName: 'DEEPSEEK_API_KEY',
      value: 'test-key',
    });
  });
});

describe('rendering per tool', () => {
  it('claude maps tiers to ANTHROPIC env vars with context suffixes', () => {
    const plan = service.buildPlan({ providerId: 'deepseek', tool: 'claude' });
    const env = (plan.fragment as { env: Record<string, string> }).env;
    expect(plan.endpointName).toBe('anthropic');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash[1m]');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-flash-vision-exp[1m]');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro[1m]');
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  it('codex renders the provider block and env_key', () => {
    const plan = service.buildPlan({ providerId: 'deepseek', tool: 'codex' });
    const fragment = plan.fragment as Record<string, any>;
    expect(fragment.model).toBe('deepseek-v4-flash-vision-exp');
    expect(fragment.model_provider).toBe('deepseek');
    expect(fragment.model_context_window).toBe(1000000);
    expect(fragment.model_providers.deepseek).toEqual({
      name: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      env_key: 'DEEPSEEK_API_KEY',
      wire_api: 'responses',
    });
  });

  it('opencode renders a provider entry and default model', () => {
    const plan = service.buildPlan({ providerId: 'deepseek', tool: 'opencode' });
    const fragment = plan.fragment as Record<string, any>;
    const entry = fragment.provider.deepseek;
    expect(entry.options.baseURL).toBe('https://api.deepseek.com/v1');
    expect(entry.options.apiKey).toBe('test-key');
    expect(fragment.model).toBe('deepseek/deepseek-v4-flash-vision-exp');
    expect(entry.models['deepseek-v4-flash-vision-exp'].limit.context).toBe(1000000);
  });

  it('dsh renders llm-pi-ai providers and the default model', () => {
    const plan = service.buildPlan({ providerId: 'deepseek', tool: 'dsh' });
    const fragment = plan.fragment as Record<string, any>;
    const entry = fragment['llm-pi-ai'].providers.deepseek;
    expect(entry.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
    expect(entry.api).toBe('openai-completions');
    expect(entry.baseURL).toBe('https://api.deepseek.com/v1');
    expect(fragment['agent-default-model'].model).toBe('deepseek-v4-flash-vision-exp');
  });

  it.each(['codebuddy', 'workbuddy'])('%s renders a flat OpenAI-compatible model list', (tool) => {
    const plan = service.buildPlan({ providerId: 'deepseek', tool });
    const fragment = plan.fragment as { models: Array<Record<string, any>> };
    expect(fragment.models).toHaveLength(3);
    expect(fragment.models[0]).toMatchObject({
      id: 'deepseek-v4-flash',
      vendor: 'DeepSeek',
      apiKey: 'test-key',
      maxInputTokens: 1000000,
      maxOutputTokens: 4096,
      url: 'https://api.deepseek.com/v1/chat/completions',
      supportsToolCall: true,
    });
  });

  it('openclaw renders models.providers and the agent default model', () => {
    const plan = service.buildPlan({ providerId: 'deepseek', tool: 'openclaw' });
    const fragment = plan.fragment as Record<string, any>;
    const entry = fragment.models.providers.deepseek;
    expect(entry.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(entry.apiKey).toBe('test-key');
    expect(entry.api).toBe('openai-completions');
    expect(entry.models[0]).toMatchObject({ id: 'deepseek-v4-flash', contextWindow: 1000000 });
    expect(fragment.agents.defaults.model.primary).toBe('deepseek/deepseek-v4-flash-vision-exp');
  });

  it('openclaw uses the anthropic adapter for the anthropic endpoint', () => {
    const plan = service.buildPlan({ tool: 'openclaw', endpoint: 'anthropic' });
    const fragment = plan.fragment as Record<string, any>;
    expect(fragment.models.providers.deepseek.api).toBe('anthropic-messages');
    expect(fragment.models.providers.deepseek.baseUrl).toBe('https://api.deepseek.com/anthropic');
  });

  it('hermes renders a custom-endpoint model block', () => {
    const plan = service.buildPlan({ providerId: 'deepseek', tool: 'hermes' });
    expect(plan.endpointName).toBe('openai');
    expect((plan.fragment as Record<string, any>).model).toEqual({
      provider: 'custom',
      default: 'deepseek-v4-flash-vision-exp',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'test-key',
      context_length: 1000000,
    });
  });

  it('qoder renders customModels and the active model', () => {
    const plan = service.buildPlan({ providerId: 'deepseek', tool: 'qoder' });
    const fragment = plan.fragment as Record<string, any>;
    expect(fragment.modelConfigs.customModels).toHaveLength(3);
    expect(fragment.modelConfigs.customModels[0]).toMatchObject({
      provider: 'deepseek',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseURL: 'https://api.deepseek.com/v1',
      key: 'deepseek-v4-flash',
      format: 'openai',
      maxInputTokens: 1000000,
    });
    expect(fragment.model.name).toBe('deepseek-v4-flash-vision-exp');
  });

  it('zcode renders a provider registry entry and main/lite models', () => {
    const plan = service.buildPlan({ providerId: 'deepseek', tool: 'zcode' });
    const fragment = plan.fragment as Record<string, any>;
    const entry = fragment.provider.deepseek;
    expect(entry.kind).toBe('openai-compatible');
    expect(entry.options).toEqual({
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      apiKeyRequired: true,
    });
    expect(entry.models['deepseek-v4-pro']).toMatchObject({ contextWindow: 1000000 });
    expect(fragment.model).toEqual({
      main: 'deepseek/deepseek-v4-flash-vision-exp',
      lite: 'deepseek/deepseek-v4-flash-vision-exp',
    });
  });

  it('zcode uses the anthropic kind for the anthropic endpoint', () => {
    const plan = service.buildPlan({ tool: 'zcode', endpoint: 'anthropic' });
    expect((plan.fragment as Record<string, any>).provider.deepseek.kind).toBe('anthropic');
  });

  it('defaults to deepseek when the provider is omitted', () => {
    expect(service.buildPlan({ tool: 'opencode' }).provider.provider).toBe('deepseek');
  });

  it('errors when the provider api-key env var is unset', () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => service.buildPlan({ providerId: 'deepseek', tool: 'opencode' })).toThrow(/DEEPSEEK_API_KEY/);
  });
});

describe('config paths', () => {
  it('honors each tool config-dir env override and expands ~', () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude-cfg');
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg-cfg');
    process.env.DSH_HOME = path.join(home, 'dsh-cfg');
    process.env.CODEX_HOME = '~/.codex-alt';

    expect(service.buildPlan({ tool: 'claude' }).configFile.filePath)
      .toBe(path.join(home, 'claude-cfg', 'settings.json'));
    expect(service.buildPlan({ tool: 'opencode' }).configFile.filePath)
      .toBe(path.join(home, 'xdg-cfg', 'opencode', 'opencode.json'));
    expect(service.buildPlan({ tool: 'dsh' }).configFile.filePath)
      .toBe(path.join(home, 'dsh-cfg', 'settings.yaml'));
    expect(service.buildPlan({ tool: 'codex' }).configFile.filePath)
      .toBe(path.join(home, '.codex-alt', 'config.toml'));
  });

  it('defaults to the home-relative config path', () => {
    expect(service.buildPlan({ tool: 'codebuddy' }).configFile.filePath)
      .toBe(path.join(home, '.codebuddy', 'models.json'));
  });

  it('honors the phase-2 tool config-dir overrides', () => {
    process.env.OPENCLAW_STATE_DIR = path.join(home, 'oc-state');
    process.env.HERMES_HOME = '~/.hermes-alt';
    process.env.QODER_CONFIG_DIR = path.join(home, 'qoder-cfg');

    expect(service.buildPlan({ tool: 'openclaw' }).configFile.filePath)
      .toBe(path.join(home, 'oc-state', 'openclaw.json'));
    expect(service.buildPlan({ tool: 'hermes' }).configFile.filePath)
      .toBe(path.join(home, '.hermes-alt', 'config.yaml'));
    expect(service.buildPlan({ tool: 'qoder' }).configFile.filePath)
      .toBe(path.join(home, 'qoder-cfg', 'settings.json'));
    expect(service.buildPlan({ tool: 'zcode' }).configFile.filePath)
      .toBe(path.join(home, '.zcode', 'cli', 'config.json'));
  });

  it('prefers OPENCLAW_CONFIG_PATH over the state dir', () => {
    process.env.OPENCLAW_STATE_DIR = path.join(home, 'oc-state');
    process.env.OPENCLAW_CONFIG_PATH = '~/oc/custom.json';
    expect(service.buildPlan({ tool: 'openclaw' }).configFile.filePath)
      .toBe(path.join(home, 'oc', 'custom.json'));
  });
});

describe('apply', () => {
  it('merges into an existing opencode.json, preserving unrelated keys, and writes a backup', async () => {
    const file = path.join(home, '.config', 'opencode', 'opencode.json');
    await fse.outputJson(file, { instructions: ['CONTRIBUTING.md'], mcp: { srv: { type: 'local' } } });

    await service.apply({ providerId: 'deepseek', tool: 'opencode' });

    const doc = await fse.readJson(file);
    expect(doc.instructions).toEqual(['CONTRIBUTING.md']);
    expect(doc.mcp).toEqual({ srv: { type: 'local' } });
    expect(doc.provider.deepseek.options.apiKey).toBe('test-key');
    expect(doc.model).toBe('deepseek/deepseek-v4-flash-vision-exp');
    expect(await fse.pathExists(`${file}.bak`)).toBe(true);
    const backup = await fse.readJson(`${file}.bak`);
    expect(backup.provider).toBeUndefined();
  });

  it('writes claude settings.json with the literal token and 0600 perms', async () => {
    const plan = await service.apply({ providerId: 'deepseek', tool: 'claude' });
    const settings = await fse.readJson(plan.configFile.filePath);
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
    if (process.platform !== 'win32') {
      expect((await fs.promises.stat(plan.configFile.filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it('upserts CodeBuddy models by id without duplicating or dropping user models', async () => {
    const file = path.join(home, '.codebuddy', 'models.json');
    await fse.outputJson(file, {
      models: [{ id: 'personal', name: 'Personal', vendor: 'Custom' }],
      availableModels: ['personal'],
    });

    await service.apply({ providerId: 'deepseek', tool: 'codebuddy' });
    process.env.DEEPSEEK_API_KEY = 'rotated-key';
    await service.apply({ providerId: 'deepseek', tool: 'codebuddy' });

    const doc = await fse.readJson(file);
    const ids = doc.models.map((m: { id: string }) => m.id);
    expect(ids).toEqual([
      'personal',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
    ]);
    expect(doc.models.find((m: { id: string }) => m.id === 'deepseek-v4-pro').apiKey).toBe('rotated-key');
    expect(doc.availableModels).toEqual(['personal']);
  });

  it('preserves a legacy top-level array CodeBuddy file', async () => {
    const file = path.join(home, '.codebuddy', 'models.json');
    await fse.outputJson(file, [{ id: 'legacy', name: 'Legacy' }]);

    await service.apply({ providerId: 'deepseek', tool: 'codebuddy' });

    const doc = await fse.readJson(file);
    expect(Array.isArray(doc)).toBe(true);
    expect(doc.map((m: { id: string }) => m.id)).toContain('legacy');
    expect(doc.map((m: { id: string }) => m.id)).toContain('deepseek-v4-pro');
  });

  it('reads an existing file that starts with a UTF-8 BOM', async () => {
    const file = path.join(home, '.codebuddy', 'models.json');
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, '\uFEFF' + JSON.stringify({ models: [{ id: 'personal', name: 'Personal' }] }));

    await service.apply({ providerId: 'deepseek', tool: 'codebuddy' });

    const doc = await fse.readJson(file);
    const ids = doc.models.map((m: { id: string }) => m.id);
    expect(ids).toContain('personal');
    expect(ids).toContain('deepseek-v4-pro');
  });

  it('parses and upserts a Qoder settings.json containing JSON5 comments', async () => {
    const file = path.join(home, '.qoder', 'settings.json');
    await fse.outputFile(
      file,
      '{\n  // personal models stay put\n  "modelConfigs": { "customModels": [ { "key": "personal", "model": "personal" } ] }\n}\n',
    );

    await service.apply({ providerId: 'deepseek', tool: 'qoder' });
    process.env.DEEPSEEK_API_KEY = 'rotated-key';
    await service.apply({ providerId: 'deepseek', tool: 'qoder' });

    const doc = await fse.readJson(file);
    const keys = doc.modelConfigs.customModels.map((m: { key: string }) => m.key);
    expect(keys).toEqual([
      'personal',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
    ]);
    expect(doc.modelConfigs.customModels.find((m: { key: string }) => m.key === 'deepseek-v4-pro').apiKey)
      .toBe('rotated-key');
  });

  it('upserts OpenClaw provider models by id without duplicating', async () => {
    const file = path.join(home, '.openclaw', 'openclaw.json');
    await fse.outputFile(
      file,
      '{\n  // keep my gateway\n  "models": { "providers": { "deepseek": { "models": [ { "id": "deepseek-v4-pro", "name": "old" } ] } } }\n}\n',
    );

    await service.apply({ providerId: 'deepseek', tool: 'openclaw' });
    await service.apply({ providerId: 'deepseek', tool: 'openclaw' });

    const doc = await fse.readJson(file);
    const ids = doc.models.providers.deepseek.models.map((m: { id: string }) => m.id);
    expect(ids.filter((id: string) => id === 'deepseek-v4-pro')).toHaveLength(1);
    expect(ids).toContain('deepseek-v4-flash');
    expect(doc.agents.defaults.model.primary).toBe('deepseek/deepseek-v4-flash-vision-exp');
  });

  it('writes through a symlinked config file without replacing the link', async () => {
    const target = path.join(home, 'dotfiles', 'workbuddy-models.json');
    const link = path.join(home, '.workbuddy', 'models.json');
    await fse.outputJson(target, { models: [] });
    await fse.ensureDir(path.dirname(link));
    await fse.symlink(target, link);

    await service.apply({ providerId: 'deepseek', tool: 'workbuddy' });

    expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
    const doc = await fse.readJson(target);
    expect(doc.models.map((m: { id: string }) => m.id)).toContain('deepseek-v4-pro');
  });
});
