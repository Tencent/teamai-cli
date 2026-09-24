import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelProfileSchema, resolveProfile } from '../models/profile.js';
import { activeModelProfiles, restoreModelProfiles, switchModelProfile } from '../models/switch.js';
import { entryHash } from '../resources/mcp-format.js';

let home: string;
let originalEnv: Record<string, string | undefined>;

// Claude reads ANTHROPIC_* and provider flags from the shell. Clear whatever
// the host (for example a Claude Code session) injected so tests are hermetic.
const SHELL_KEYS = (key: string) => key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_USE_')
  || key === 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY';

beforeEach(async () => {
  const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG', 'TEAMAI_TEST_MODEL_KEY',
    ...Object.keys(process.env).filter(SHELL_KEYS)];
  originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-switch-'));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
});

afterEach(async () => {
  for (const key of Object.keys(process.env).filter(SHELL_KEYS)) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fse.remove(home);
});

function routed(
  routes: Record<string, string[]>,
  options: { env?: string; model?: string; baseUrl?: string; id?: string } = {},
) {
  const groups: Array<{ protocols: string[]; models: string[] }> = [];
  for (const model of new Set(Object.values(routes).flat())) {
    const protocols = Object.entries(routes).filter(([, models]) => models.includes(model)).map(([protocol]) => protocol);
    let group = groups.find((item) => item.protocols.join('|') === protocols.join('|'));
    if (!group) {
      group = { protocols, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  const id = options.id ?? 'tokenhub';
  const profile = ModelProfileSchema.parse({
    id, name: 'TokenHub', base_url: options.baseUrl ?? 'https://gateway.example.test',
    api_key: '${API_KEY}', model_groups: groups,
  });
  return resolveProfile({ source: 'team', profile, team: 'demo-team' }, {
    [`team:${id}`]: { API_KEY: options.env ? { env: options.env } : { value: 'local-secret' } },
  }, options.model);
}

const claudeFile = () => path.join(home, '.claude', 'settings.json');
const codexFile = () => path.join(home, '.codex', 'config.toml');
const openCodeFile = () => path.join(home, '.config', 'opencode', 'opencode.json');

describe('Claude model switching', () => {
  it('offers all Anthropic route models in modelPicker and restores prior settings', async () => {
    const original = { model: 'personal', modelPicker: { options: [{ model: 'personal' }] }, env: { KEEP_ME: 'yes', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' } };
    await fse.outputJson(claudeFile(), original);
    const profile = routed({ anthropic: ['claude-opus-4-8', 'claude-sonnet-4-6', 'deepseek-v4-flash'] });
    expect((await switchModelProfile(profile, ['claude']))[0].status).toBe('switched');
    const active = await fse.readJson(claudeFile());
    expect(active.model).toBe('claude-opus-4-8');
    expect(active.modelPicker).toEqual({
      options: [{ model: 'claude-opus-4-8' }, { model: 'claude-sonnet-4-6' }, { model: 'deepseek-v4-flash' }],
      replaceBuiltInOptions: true,
    });
    expect(active.env).toEqual({
      KEEP_ME: 'yes',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '0',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_AUTH_TOKEN: 'local-secret',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-opus-4-8',
    });
    expect((await restoreModelProfiles(['claude']))[0].status).toBe('restored');
    expect(await fse.readJson(claudeFile())).toEqual(original);
  });

  it('points every Claude model family at the default when the gateway has no Claude models', async () => {
    await fse.ensureDir(path.join(home, '.claude'));
    const profile = routed({ anthropic: ['glm-5.3', 'deepseek-v4-flash'] }, { model: 'deepseek-v4-flash' });
    expect((await switchModelProfile(profile, ['claude']))[0].status).toBe('switched');
    const active = await fse.readJson(claudeFile());
    expect(active.model).toBe('deepseek-v4-flash');
    expect(active.modelPicker.options.map((row: { model: string }) => row.model)).toEqual(['deepseek-v4-flash', 'glm-5.3']);
    expect(active.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-flash');
    expect(active.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-flash');
    expect(active.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash');
  });

  it('removes conflicting Claude auth, headers, and ANTHROPIC_MODEL only while managed', async () => {
    const original = { permissions: { allow: ['Read'] }, env: { ANTHROPIC_API_KEY: 'personal-key', ANTHROPIC_CUSTOM_HEADERS: 'X-Private: user', ANTHROPIC_MODEL: 'personal-model', KEEP_ME: 'yes' } };
    await fse.outputJson(claudeFile(), original);
    expect((await switchModelProfile(routed({ anthropic: ['claude-opus-4-8'] }), ['claude']))[0].status).toBe('switched');
    const active = await fse.readJson(claudeFile());
    expect(active.permissions).toEqual({ allow: ['Read'] });
    expect(active.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(active.env).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS');
    expect(active.env).not.toHaveProperty('ANTHROPIC_MODEL');
    expect((await restoreModelProfiles(['claude']))[0].status).toBe('restored');
    expect(await fse.readJson(claudeFile())).toEqual(original);
  });

  it('switches but warns when the shell overrides Claude settings', async () => {
    await fse.ensureDir(path.join(home, '.claude'));
    process.env.ANTHROPIC_BASE_URL = 'https://host-app.example.test';
    const [result] = await switchModelProfile(routed({ anthropic: ['claude-opus-4-8'] }), ['claude']);
    expect(result.status).toBe('switched');
    expect(result.warning).toMatch(/ANTHROPIC_BASE_URL/);
    expect((await fse.readJson(claudeFile())).env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.test');
  });

  it('warns about any shell value that differs from what TeamAI writes', async () => {
    await fse.outputJson(claudeFile(), { env: { ANTHROPIC_BASE_URL: 'https://old.example.test' } });
    const profile = routed({ anthropic: ['new-model'] });
    // Matching the old settings.json value does not make an exported value harmless.
    process.env.ANTHROPIC_BASE_URL = 'https://old.example.test';
    expect((await switchModelProfile(profile, ['claude'], { dryRun: true }))[0].warning).toMatch(/ANTHROPIC_BASE_URL/);
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'local-secret';
    const [result] = await switchModelProfile(profile, ['claude']);
    expect(result.status).toBe('switched');
    expect(result.warning).toBeUndefined();
  });

  it('refuses while settings.json selects another provider, and warns for a shell provider flag', async () => {
    const original = { env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://old.example.test' } };
    await fse.outputJson(claudeFile(), original);
    const profile = routed({ anthropic: ['new-model'] });
    expect((await switchModelProfile(profile, ['claude']))[0].status).toBe('skipped');
    expect(await fse.readJson(claudeFile())).toEqual(original);
    await fse.outputJson(claudeFile(), {});
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    const [result] = await switchModelProfile(profile, ['claude']);
    expect(result.status).toBe('switched');
    expect(result.warning).toMatch(/CLAUDE_CODE_USE_VERTEX/);
  });

  it('temporarily clears server-delivered Claude custom model selection', async () => {
    const original = { env: {
      ANTHROPIC_BASE_URL: 'https://server.example.test',
      ANTHROPIC_AUTH_TOKEN: 'server-token',
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'server-model',
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Server Model',
    } };
    await fse.outputJson(claudeFile(), original);
    expect((await switchModelProfile(routed({ anthropic: ['new-model'] }), ['claude']))[0].status).toBe('switched');
    const active = await fse.readJson(claudeFile());
    expect(active.env).not.toHaveProperty('ANTHROPIC_CUSTOM_MODEL_OPTION');
    expect(active.env).not.toHaveProperty('ANTHROPIC_CUSTOM_MODEL_OPTION_NAME');
    expect((await restoreModelProfiles(['claude']))[0].status).toBe('restored');
    expect(await fse.readJson(claudeFile())).toEqual(original);
  });

  it('writes the resolved key for Claude even when it comes from the environment', async () => {
    await fse.ensureDir(path.join(home, '.claude'));
    process.env.TEAMAI_TEST_MODEL_KEY = 'from-env';
    await switchModelProfile(routed({ anthropic: ['new-model'] }, { env: 'TEAMAI_TEST_MODEL_KEY' }), ['claude']);
    expect((await fse.readJson(claudeFile())).env.ANTHROPIC_AUTH_TOKEN).toBe('from-env');
  });

  it('does not overwrite managed fields edited after a TeamAI switch', async () => {
    await fse.ensureDir(path.join(home, '.claude'));
    await switchModelProfile(routed({ anthropic: ['team-model'] }), ['claude']);
    const edited = await fse.readJson(claudeFile());
    edited.env.ANTHROPIC_BASE_URL = 'https://user-changed-it.example.test';
    await fse.writeJson(claudeFile(), edited);
    expect((await restoreModelProfiles(['claude']))[0].status).toBe('skipped');
    expect((await switchModelProfile(routed({ anthropic: ['other-model'] }), ['claude']))[0].status).toBe('skipped');
    expect((await fse.readJson(claudeFile())).env.ANTHROPIC_BASE_URL).toBe('https://user-changed-it.example.test');
  });

  it('treats a /model pick as a choice, not a takeover', async () => {
    await fse.outputJson(claudeFile(), { model: 'personal' });
    await switchModelProfile(routed({ anthropic: ['glm-5.3', 'deepseek-v4-flash'] }), ['claude']);
    // Claude's /model command persists the pick to settings.json.
    const picked = await fse.readJson(claudeFile());
    picked.model = 'deepseek-v4-flash[1m]';
    await fse.writeJson(claudeFile(), picked);
    const updated = routed({ anthropic: ['glm-5.3', 'deepseek-v4-flash', 'kimi-k3'] });
    expect((await switchModelProfile(updated, ['claude']))[0].status).toBe('switched');
    const active = await fse.readJson(claudeFile());
    expect(active.model).toBe('deepseek-v4-flash[1m]');
    expect(active.modelPicker.options).toHaveLength(3);
    expect((await switchModelProfile(routed({ anthropic: ['glm-5.3', 'deepseek-v4-flash', 'kimi-k3'] }, { model: 'kimi-k3' }), ['claude']))[0].status).toBe('switched');
    expect((await fse.readJson(claudeFile())).model).toBe('kimi-k3');
    expect((await restoreModelProfiles(['claude']))[0].status).toBe('restored');
    expect(await fse.readJson(claudeFile())).toEqual({ model: 'personal' });
  });

  it('keeps a model the user chose outside the catalog when restoring', async () => {
    await fse.outputJson(claudeFile(), { model: 'personal' });
    await switchModelProfile(routed({ anthropic: ['glm-5.3'] }), ['claude']);
    const picked = await fse.readJson(claudeFile());
    picked.model = 'typed-by-user';
    await fse.writeJson(claudeFile(), picked);
    expect((await restoreModelProfiles(['claude']))[0].status).toBe('restored');
    expect(await fse.readJson(claudeFile())).toEqual({ model: 'typed-by-user' });
  });
});

describe('Codex model switching', () => {
  it('exposes only a Responses route to Codex', async () => {
    await fse.ensureDir(path.join(home, '.codex'));
    const chatOnly = routed({ anthropic: ['claude-opus-4-8'], 'openai-chat-completions': ['deepseek-v4-flash'] });
    expect((await switchModelProfile(chatOnly, ['codex']))[0].status).toBe('unsupported');
    expect(await fse.pathExists(codexFile())).toBe(false);
    const responses = routed({ 'openai-responses': ['glm-5.3', 'deepseek-v4-flash'] });
    expect((await switchModelProfile(responses, ['codex']))[0].status).toBe('switched');
    const config = await fse.readFile(codexFile(), 'utf8');
    expect(config).toContain('model = "glm-5.3"');
    expect(config).toContain('model_provider = "teamai"');
    expect(config).toContain('base_url = "https://gateway.example.test/v1"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('experimental_bearer_token = "local-secret"');
  });

  it('references an environment variable instead of writing the key', async () => {
    await fse.ensureDir(path.join(home, '.codex'));
    process.env.TEAMAI_TEST_MODEL_KEY = 'from-env';
    await switchModelProfile(routed({ 'openai-responses': ['glm-5.3'] }, { env: 'TEAMAI_TEST_MODEL_KEY' }), ['codex']);
    const config = await fse.readFile(codexFile(), 'utf8');
    expect(config).toContain('env_key = "TEAMAI_TEST_MODEL_KEY"');
    expect(config).not.toContain('from-env');
  });

  it('preserves Codex comments and never touches auth.json', async () => {
    await fse.outputFile(codexFile(), '# keep this comment\napproval_policy = "on-request"\n\n[profiles.personal]\nmodel = "keep-profile-model"\n');
    await fse.writeJson(path.join(home, '.codex', 'auth.json'), { OPENAI_API_KEY: 'official' });
    await switchModelProfile(routed({ 'openai-responses': ['gpt-team'] }), ['codex']);
    const config = await fse.readFile(codexFile(), 'utf8');
    expect(config).toContain('# keep this comment');
    expect(config).toContain('approval_policy = "on-request"');
    expect(config).toContain('[profiles.personal]\nmodel = "keep-profile-model"');
    expect(await fse.readJson(path.join(home, '.codex', 'auth.json'))).toEqual({ OPENAI_API_KEY: 'official' });
  });

  it('restores single-quoted Codex model settings', async () => {
    await fse.outputFile(codexFile(), "# keep this comment\nmodel = 'personal-model'\nmodel_provider = 'personal-provider'\n");
    expect((await switchModelProfile(routed({ 'openai-responses': ['gpt-team'] }), ['codex']))[0].status).toBe('switched');
    expect((await restoreModelProfiles(['codex']))[0].status).toBe('restored');
    const restored = await fse.readFile(codexFile(), 'utf8');
    expect(restored).toContain('# keep this comment');
    expect(restored).toMatch(/^model = "personal-model"$/m);
    expect(restored).toMatch(/^model_provider = "personal-provider"$/m);
    expect(restored).not.toContain('[model_providers.teamai]');
  });

  it('updates quoted Codex keys without duplicate TOML assignments or losing inline comments', async () => {
    await fse.outputFile(codexFile(), '"model" = "personal" # keep model note\n\'model_provider\' = "custom" # keep provider note\n');
    expect((await switchModelProfile(routed({ 'openai-responses': ['gpt-team'] }), ['codex']))[0].status).toBe('switched');
    const active = await fse.readFile(codexFile(), 'utf8');
    expect(active).toContain('"model" = "gpt-team" # keep model note');
    expect(active).toContain("'model_provider' = \"teamai\" # keep provider note");
    expect((await restoreModelProfiles(['codex']))[0].status).toBe('restored');
    expect(await fse.readFile(codexFile(), 'utf8')).toContain('"model" = "personal" # keep model note');
    expect(await fse.readFile(codexFile(), 'utf8')).toContain("'model_provider' = \"custom\" # keep provider note");
  });

  it('preserves unrelated Codex blank-line formatting across provider replacement and restore', async () => {
    await fse.outputFile(codexFile(), 'model = "personal"\n\n\n\n[profiles.personal]\nmodel = "private"\n\n\n\n[model_providers.personal]\nname = "Mine"\n');
    expect((await switchModelProfile(routed({ 'openai-responses': ['first'] }), ['codex']))[0].status).toBe('switched');
    expect((await switchModelProfile(routed({ 'openai-responses': ['second'] }), ['codex']))[0].status).toBe('switched');
    expect((await restoreModelProfiles(['codex']))[0].status).toBe('restored');
    const restored = await fse.readFile(codexFile(), 'utf8');
    expect(restored).toContain('model = "personal"');
    expect(restored).toContain('model = "private"\n\n\n\n[model_providers.personal]');
  });

  it.each([
    '[model_providers."teamai"]\nname = "Personal"\n',
    'model_providers.teamai = { name = "Personal" }\n',
    'model_providers = "reserved"\n',
    'model_providers = { personal = { name = "Mine" } }\n',
    '"model_providers" = { personal = { name = "Mine" } }\n',
  ])('does not overwrite a Codex provider defined with alternate TOML syntax', async (source) => {
    await fse.outputFile(codexFile(), source);
    expect((await switchModelProfile(routed({ 'openai-responses': ['gpt-team'] }), ['codex']))[0].status).toBe('skipped');
    expect(await fse.readFile(codexFile(), 'utf8')).toBe(source);
  });

  it('refuses a Codex edit that would not produce the intended TOML', async () => {
    const source = 'model = """\npersonal\n"""\n';
    await fse.outputFile(codexFile(), source);
    const [result] = await switchModelProfile(routed({ 'openai-responses': ['gpt-team'] }), ['codex']);
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/Cannot safely update/);
    expect(await fse.readFile(codexFile(), 'utf8')).toBe(source);
    expect(await activeModelProfiles()).toEqual({});
  });
});

describe('OpenCode model switching', () => {
  it('registers all OpenCode models under the right protocol provider and restores prior config', async () => {
    const original = { model: 'personal/one', provider: { personal: { npm: 'custom' } }, instructions: ['rules/*.md'] };
    await fse.outputJson(openCodeFile(), original);
    const profile = routed({
      anthropic: ['claude-opus-4-8', 'deepseek-v4-flash', 'glm-5.3'],
      'openai-chat-completions': ['deepseek-v4-flash', 'glm-5.3'],
    });
    expect((await switchModelProfile(profile, ['opencode']))[0].status).toBe('switched');
    const active = await fse.readJson(openCodeFile());
    expect(active.model).toBe('teamai-anthropic/claude-opus-4-8');
    expect(active.provider.personal).toEqual({ npm: 'custom' });
    expect(active.instructions).toEqual(['rules/*.md']);
    expect(Object.keys(active.provider['teamai-anthropic'].models)).toEqual(['claude-opus-4-8']);
    expect(Object.keys(active.provider['teamai-chat'].models)).toEqual(['deepseek-v4-flash', 'glm-5.3']);
    expect(active.provider['teamai-anthropic'].npm).toBe('@ai-sdk/anthropic');
    expect(active.provider['teamai-chat'].npm).toBe('@ai-sdk/openai-compatible');
    expect(active.provider['teamai-anthropic'].options.baseURL).toBe('https://gateway.example.test');
    expect(active.provider['teamai-chat'].options).toEqual({ baseURL: 'https://gateway.example.test/v1', apiKey: 'local-secret' });
    expect((await restoreModelProfiles(['opencode']))[0].status).toBe('restored');
    expect(await fse.readJson(openCodeFile())).toEqual(original);
  });

  it('selects the chosen default model and references an environment key', async () => {
    await fse.ensureDir(path.dirname(openCodeFile()));
    process.env.TEAMAI_TEST_MODEL_KEY = 'from-env';
    const profile = routed({ 'openai-responses': ['glm-5.3', 'deepseek-v4-flash'] }, { env: 'TEAMAI_TEST_MODEL_KEY', model: 'deepseek-v4-flash' });
    await switchModelProfile(profile, ['opencode']);
    const active = await fse.readJson(openCodeFile());
    expect(active.model).toBe('teamai-responses/deepseek-v4-flash');
    expect(active.provider['teamai-responses'].npm).toBe('@ai-sdk/openai');
    expect(active.provider['teamai-responses'].options.apiKey).toBe('{env:TEAMAI_TEST_MODEL_KEY}');
  });

  it('does not overwrite a user-owned OpenCode route provider', async () => {
    await fse.outputJson(openCodeFile(), { provider: { 'teamai-chat': { npm: 'mine' } } });
    expect((await switchModelProfile(routed({ 'openai-chat-completions': ['deepseek-v4-flash'] }), ['opencode']))[0].status).toBe('skipped');
    expect(await fse.readJson(openCodeFile())).toEqual({ provider: { 'teamai-chat': { npm: 'mine' } } });
  });
});

describe.each(['codebuddy', 'workbuddy'] as const)('%s model switching', (agent) => {
  const file = () => path.join(home, `.${agent}`, 'models.json');

  it('installs every chat model without touching personal models', async () => {
    await fse.outputJson(file(), { models: [{ id: 'personal', name: 'Mine' }] });
    expect((await switchModelProfile(routed({ 'openai-chat-completions': ['deepseek-v4-flash', 'glm-5.3'] }), [agent]))[0].status).toBe('switched');
    const active = await fse.readJson(file());
    expect(active.models.map((model: { id: string }) => model.id)).toEqual(['personal', 'deepseek-v4-flash', 'glm-5.3']);
    expect(active.models[1]).toEqual({
      id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', vendor: 'TokenHub', apiKey: 'local-secret',
      url: 'https://gateway.example.test/v1/chat/completions', supportsToolCall: true,
    });
    expect((await restoreModelProfiles([agent]))[0].status).toBe('restored');
    expect(await fse.readJson(file())).toEqual({ models: [{ id: 'personal', name: 'Mine' }] });
  });

  it('writes an environment key as ${VAR}, the syntax the Buddy apps expand', async () => {
    await fse.ensureDir(path.dirname(file()));
    process.env.TEAMAI_TEST_MODEL_KEY = 'fixture-secret';
    await switchModelProfile(routed({ 'openai-chat-completions': ['glm-5.3'] }, { env: 'TEAMAI_TEST_MODEL_KEY' }), [agent]);
    const doc = await fse.readJson(file());
    expect(doc.models[0].apiKey).toBe('${TEAMAI_TEST_MODEL_KEY}');
    expect(JSON.stringify(doc)).not.toContain('fixture-secret');
  });

  it('can replace a model still owned by local-agent delivery', async () => {
    const original = { id: 'shared-model', name: 'Delivered', vendor: 'server', apiKey: 'old-key', url: 'https://old.example.test/chat/completions' };
    await fse.outputJson(file(), { models: [original] });
    await fse.outputJson(path.join(home, '.teamai', 'local-agent', 'model-manifest.json'), { [agent]: { 'shared-model': entryHash(original) } });
    expect((await switchModelProfile(routed({ 'openai-chat-completions': ['shared-model'] }), [agent]))[0].status).toBe('switched');
    expect((await fse.readJson(file())).models[0].vendor).toBe('TokenHub');
    expect((await restoreModelProfiles([agent]))[0].status).toBe('restored');
    expect((await fse.readJson(file())).models).toEqual([original]);
  });

  it('restores a local-agent entry exactly, without metadata the app added later', async () => {
    const original = { id: 'shared-model', name: 'Delivered', vendor: 'server', apiKey: 'old-key', url: 'https://old.example.test/chat/completions' };
    await fse.outputJson(file(), { models: [original] });
    await fse.outputJson(path.join(home, '.teamai', 'local-agent', 'model-manifest.json'), { [agent]: { 'shared-model': entryHash(original) } });
    await switchModelProfile(routed({ 'openai-chat-completions': ['shared-model'] }), [agent]);
    const normalized = await fse.readJson(file());
    normalized.models[0].supportsVision = true;
    await fse.writeJson(file(), normalized);
    expect((await restoreModelProfiles([agent]))[0].status).toBe('restored');
    const [restored] = (await fse.readJson(file())).models;
    expect(restored).toEqual(original);
    expect(entryHash(restored)).toBe(entryHash(original));
  });

  it('releases a model dropped from the catalog, so a user entry reusing its ID survives restore', async () => {
    await fse.outputJson(file(), { models: [], availableModels: ['personal'] });
    await switchModelProfile(routed({ 'openai-chat-completions': ['model-a'] }), [agent]);
    expect((await switchModelProfile(routed({ 'openai-chat-completions': ['model-b'] }), [agent]))[0].status).toBe('switched');
    const doc = await fse.readJson(file());
    expect(doc.models.map((model: { id: string }) => model.id)).toEqual(['model-b']);
    expect(doc.availableModels).toEqual(['personal', 'model-b']);
    doc.models.push({ id: 'model-a', name: 'Mine now' });
    doc.availableModels.push('model-a');
    await fse.writeJson(file(), doc);
    expect((await restoreModelProfiles([agent]))[0].status).toBe('restored');
    expect(await fse.readJson(file())).toEqual({ models: [{ id: 'model-a', name: 'Mine now' }], availableModels: ['personal', 'model-a'] });
  });

  it('puts back a local-agent entry as soon as the catalog stops using its ID', async () => {
    const original = { id: 'shared-model', name: 'Delivered', vendor: 'server', apiKey: 'old-key', url: 'https://old.example.test/chat/completions' };
    await fse.outputJson(file(), { models: [original] });
    await fse.outputJson(path.join(home, '.teamai', 'local-agent', 'model-manifest.json'), { [agent]: { 'shared-model': entryHash(original) } });
    await switchModelProfile(routed({ 'openai-chat-completions': ['shared-model'] }), [agent]);
    await switchModelProfile(routed({ 'openai-chat-completions': ['other-model'] }), [agent]);
    expect((await fse.readJson(file())).models).toEqual([expect.objectContaining({ id: 'other-model' }), original]);
    expect((await restoreModelProfiles([agent]))[0].status).toBe('restored');
    expect((await fse.readJson(file())).models).toEqual([original]);
  });

  it('updates a non-empty allowlist and restores only managed IDs', async () => {
    await fse.outputJson(file(), { models: [{ id: 'personal', name: 'Mine' }], availableModels: ['personal'] });
    expect((await switchModelProfile(routed({ 'openai-chat-completions': ['deepseek-v4-flash'] }), [agent]))[0].status).toBe('switched');
    expect((await fse.readJson(file())).availableModels).toEqual(['personal', 'deepseek-v4-flash']);
    expect((await switchModelProfile(routed({ 'openai-chat-completions': ['glm-5.3'] }), [agent]))[0].status).toBe('switched');
    expect((await fse.readJson(file())).availableModels).toEqual(['personal', 'glm-5.3']);
    const edited = await fse.readJson(file());
    edited.availableModels.push('user-added');
    await fse.writeJson(file(), edited);
    expect((await restoreModelProfiles([agent]))[0].status).toBe('restored');
    expect((await fse.readJson(file())).availableModels).toEqual(['personal', 'user-added']);
  });

  it('restores all models after switching between catalogs', async () => {
    await fse.outputJson(file(), { models: [{ id: 'personal', name: 'Mine' }] });
    await switchModelProfile(routed({ 'openai-chat-completions': ['one', 'two'] }), [agent]);
    expect((await switchModelProfile(routed({ 'openai-chat-completions': ['two', 'three'] }), [agent]))[0].status).toBe('switched');
    expect((await fse.readJson(file())).models.map((model: { id: string }) => model.id)).toEqual(['personal', 'two', 'three']);
    expect((await restoreModelProfiles([agent]))[0].status).toBe('restored');
    expect(await fse.readJson(file())).toEqual({ models: [{ id: 'personal', name: 'Mine' }] });
  });

  it('ignores app-added metadata but still guards TeamAI fields', async () => {
    await fse.outputJson(file(), { models: [] });
    expect((await switchModelProfile(routed({ 'openai-chat-completions': ['team-model'] }), [agent]))[0].status).toBe('switched');
    const normalized = await fse.readJson(file());
    normalized.models[0].supportsVision = true;
    await fse.writeJson(file(), normalized);
    const other = routed({ 'openai-chat-completions': ['team-model'] }, { baseUrl: 'https://other.example.test' });
    expect((await switchModelProfile(other, [agent]))[0].status).toBe('switched');
    expect((await fse.readJson(file())).models[0].supportsVision).toBe(true);
    const edited = await fse.readJson(file());
    edited.models[0].url = 'https://user.example.test/chat';
    await fse.writeJson(file(), edited);
    expect((await restoreModelProfiles([agent]))[0].status).toBe('skipped');
    edited.models[0].url = 'https://other.example.test/v1/chat/completions';
    await fse.writeJson(file(), edited);
    expect((await restoreModelProfiles([agent]))[0].status).toBe('restored');
  });

  it('refuses to replace a same-ID user model, also on a later switch', async () => {
    await fse.outputJson(file(), { models: [{ id: 'personal', name: 'Personal' }] });
    expect((await switchModelProfile(routed({ 'openai-chat-completions': ['personal'] }), [agent]))[0].status).toBe('skipped');
    await switchModelProfile(routed({ 'openai-chat-completions': ['first-team-model'] }), [agent]);
    const [result] = await switchModelProfile(routed({ 'openai-chat-completions': ['personal'] }), [agent]);
    expect(result.status).toBe('skipped');
    expect((await fse.readJson(file())).models).toEqual([
      { id: 'personal', name: 'Personal' },
      expect.objectContaining({ id: 'first-team-model' }),
    ]);
  });
});

describe('model switch bookkeeping', () => {
  it('records the profile, team, and chosen model per agent', async () => {
    await fse.ensureDir(path.join(home, '.claude'));
    await fse.ensureDir(path.dirname(openCodeFile()));
    await switchModelProfile(routed({ anthropic: ['glm-5.3', 'deepseek-v4-flash'] }, { model: 'deepseek-v4-flash' }), ['claude', 'opencode']);
    expect(await activeModelProfiles()).toEqual({
      claude: { profile: 'team:tokenhub', team: 'demo-team', model: 'deepseek-v4-flash' },
      opencode: { profile: 'team:tokenhub', team: 'demo-team', model: 'deepseek-v4-flash' },
    });
  });

  it('leaves an agent alone when it moved to another profile before a pull re-apply', async () => {
    await fse.ensureDir(path.join(home, '.claude'));
    const team = routed({ anthropic: ['team-model'] });
    await switchModelProfile(team, ['claude']);
    const personal = routed({ anthropic: ['personal-model'] }, { id: 'personal' });
    await switchModelProfile(personal, ['claude']);
    const updatedTeam = routed({ anthropic: ['team-model', 'new-team-model'] });
    const [result] = await switchModelProfile(updatedTeam, ['claude'], {
      onlyIfActive: { profile: 'team:tokenhub', team: 'demo-team' },
    });
    expect(result.status).toBe('unchanged');
    expect((await fse.readJson(claudeFile())).model).toBe('personal-model');
    expect((await activeModelProfiles()).claude?.profile).toBe('team:personal');
  });

  it('reports per-agent failures and continues switching other agents', async () => {
    await fse.outputFile(openCodeFile(), '{ invalid json');
    await fse.ensureDir(path.join(home, '.claude'));
    const results = await switchModelProfile(routed({ anthropic: ['team-model'] }), ['opencode', 'claude']);
    expect(results.map((result) => result.status)).toEqual(['failed', 'switched']);
    expect((await fse.readJson(claudeFile())).model).toBe('team-model');
  });

  it('fails closed when the ownership manifest is corrupted', async () => {
    await fse.outputJson(claudeFile(), { model: 'personal-model' });
    await fse.outputFile(path.join(home, '.teamai', 'models', 'managed.json'), '{broken');
    await expect(switchModelProfile(routed({ anthropic: ['team-model'] }), ['claude'])).rejects.toThrow(/ownership manifest/);
    expect((await fse.readJson(claudeFile())).model).toBe('personal-model');
  });

  it('serializes concurrent switches so ownership of both agents survives', async () => {
    await fse.ensureDir(path.join(home, '.claude'));
    await fse.ensureDir(path.join(home, '.codex'));
    const profile = routed({ anthropic: ['claude-model'], 'openai-responses': ['codex-model'] });
    const [claude, codex] = await Promise.all([
      switchModelProfile(profile, ['claude']),
      switchModelProfile(profile, ['codex']),
    ]);
    expect(claude[0].status).toBe('switched');
    expect(codex[0].status).toBe('switched');
    expect(Object.keys(await activeModelProfiles()).sort()).toEqual(['claude', 'codex']);
    expect((await restoreModelProfiles(['claude', 'codex'])).map((result) => result.status)).toEqual(['restored', 'restored']);
  });

  it('does not create a TeamAI directory during a dry run', async () => {
    await fse.ensureDir(path.join(home, '.claude'));
    expect((await switchModelProfile(routed({ anthropic: ['claude-model'] }), ['claude'], { dryRun: true }))[0].status).toBe('switched');
    expect(await fse.pathExists(path.join(home, '.teamai'))).toBe(false);
  });

  const manifestFile = () => path.join(home, '.teamai', 'models', 'managed.json');

  it('recovers an interrupted first switch before the agent file was written', async () => {
    const original = { model: 'personal', permissions: { allow: ['Read'] } };
    await fse.outputJson(claudeFile(), original);
    await switchModelProfile(routed({ anthropic: ['team'] }), ['claude']);
    const manifest = await fse.readJson(manifestFile());
    manifest.agents.claude.pending = { kind: 'switch', before: manifest.agents.claude.previous, prior: null };
    await fse.writeJson(manifestFile(), manifest);
    await fse.writeJson(claudeFile(), original);
    expect((await restoreModelProfiles(['claude']))[0].status).toBe('unchanged');
    expect((await fse.readJson(manifestFile())).agents).toEqual({});
    expect(await fse.readJson(claudeFile())).toEqual(original);
  });

  it('recovers an interrupted switch after the agent file was written', async () => {
    await fse.outputJson(claudeFile(), { model: 'personal' });
    await switchModelProfile(routed({ anthropic: ['team'] }), ['claude']);
    const manifest = await fse.readJson(manifestFile());
    manifest.agents.claude.pending = { kind: 'switch', before: manifest.agents.claude.previous, prior: null };
    await fse.writeJson(manifestFile(), manifest);
    expect((await restoreModelProfiles(['claude']))[0].status).toBe('restored');
    expect((await fse.readJson(claudeFile())).model).toBe('personal');
  });

  it('does not recover over an external model edit during an interrupted switch', async () => {
    await fse.outputJson(claudeFile(), { model: 'personal' });
    await switchModelProfile(routed({ anthropic: ['team'] }), ['claude']);
    const manifest = await fse.readJson(manifestFile());
    manifest.agents.claude.pending = { kind: 'switch', before: manifest.agents.claude.previous, prior: null };
    await fse.writeJson(manifestFile(), manifest);
    const edited = await fse.readJson(claudeFile());
    edited.env.ANTHROPIC_BASE_URL = 'https://user-edited.example.test';
    await fse.writeJson(claudeFile(), edited);
    expect((await restoreModelProfiles(['claude']))[0].status).toBe('skipped');
    expect((await fse.readJson(claudeFile())).env.ANTHROPIC_BASE_URL).toBe('https://user-edited.example.test');
    expect((await fse.readJson(manifestFile())).agents.claude.pending.kind).toBe('switch');
  });

  it('recovers an interrupted restore after the agent file was restored', async () => {
    await fse.outputJson(claudeFile(), { model: 'personal' });
    await switchModelProfile(routed({ anthropic: ['team'] }), ['claude']);
    const manifest = await fse.readJson(manifestFile());
    manifest.agents.claude.pending = { kind: 'restore', before: manifest.agents.claude.lastWritten };
    await restoreModelProfiles(['claude']);
    await fse.writeJson(manifestFile(), manifest);
    expect((await restoreModelProfiles(['claude']))[0].status).toBe('unchanged');
    expect((await fse.readJson(manifestFile())).agents).toEqual({});
    expect((await fse.readJson(claudeFile())).model).toBe('personal');
  });

  it('keeps the original personal settings when a second switch was interrupted', async () => {
    await fse.outputJson(claudeFile(), { model: 'personal' });
    await switchModelProfile(routed({ anthropic: ['first'] }), ['claude']);
    const prior = await fse.readJson(manifestFile());
    const firstConfig = await fse.readJson(claudeFile());
    await switchModelProfile(routed({ anthropic: ['second'] }), ['claude']);
    const pending = await fse.readJson(manifestFile());
    pending.agents.claude.pending = { kind: 'switch', before: prior.agents.claude.lastWritten, prior: prior.agents.claude };
    await fse.writeJson(manifestFile(), pending);
    await fse.writeJson(claudeFile(), firstConfig);
    expect((await restoreModelProfiles(['claude']))[0].status).toBe('restored');
    expect((await fse.readJson(claudeFile())).model).toBe('personal');
  });

  it('uses agent-specific configuration directory overrides', async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(home, 'custom-claude');
    process.env.CODEX_HOME = path.join(home, 'custom-codex');
    process.env.XDG_CONFIG_HOME = path.join(home, 'custom-xdg');
    await fse.outputJson(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), { env: { KEEP: 'yes' } });
    await fse.outputFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'model = "personal"\n');
    await fse.outputJson(path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), { instructions: ['keep.md'] });
    expect((await switchModelProfile(routed({ anthropic: ['team'] }), ['claude', 'opencode'])).map((row) => row.status)).toEqual(['switched', 'switched']);
    expect((await fse.readJson(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'))).env.KEEP).toBe('yes');
    expect((await fse.readJson(path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'))).instructions).toEqual(['keep.md']);
    expect((await switchModelProfile(routed({ 'openai-responses': ['team'] }), ['codex']))[0].status).toBe('switched');
    expect(await fse.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8')).toContain('model = "team"');
    expect((await restoreModelProfiles(['claude', 'codex', 'opencode'])).map((row) => row.status)).toEqual(['restored', 'restored', 'restored']);
    process.env.OPENCODE_CONFIG = path.join(home, 'custom-opencode.json');
    await fse.outputJson(process.env.OPENCODE_CONFIG, { plugin: ['keep'] });
    expect((await switchModelProfile(routed({ 'openai-chat-completions': ['team'] }), ['opencode']))[0].status).toBe('switched');
    expect((await fse.readJson(process.env.OPENCODE_CONFIG)).plugin).toEqual(['keep']);
  });

  it('does not restore into a different Codex configuration directory', async () => {
    const first = path.join(home, 'first-codex');
    const second = path.join(home, 'second-codex');
    process.env.CODEX_HOME = first;
    await fse.outputFile(path.join(first, 'config.toml'), 'model = "personal"\n');
    expect((await switchModelProfile(routed({ 'openai-responses': ['team-model'] }), ['codex']))[0].status).toBe('switched');
    process.env.CODEX_HOME = second;
    await fse.outputFile(path.join(second, 'config.toml'), 'model = "another-personal"\n');
    expect((await restoreModelProfiles(['codex']))[0].status).toBe('skipped');
    expect(await fse.readFile(path.join(second, 'config.toml'), 'utf8')).toBe('model = "another-personal"\n');
    process.env.CODEX_HOME = first;
    expect((await restoreModelProfiles(['codex']))[0].status).toBe('restored');
    expect(await fse.readFile(path.join(first, 'config.toml'), 'utf8')).toContain('model = "personal"');
  });
});
