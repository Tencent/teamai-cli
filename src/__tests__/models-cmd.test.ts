import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelsAdd, modelsConfigure, modelsList, modelsRemove, modelsRestore, modelsShow, modelsSwitch } from '../models-cmd.js';
import { getLocalValuesPath, loadLocalProfiles, loadModelInputs } from '../models/profile.js';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let home: string;
let originalEnv: Record<string, string | undefined>;

beforeEach(async () => {
  const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG', 'MY_MODEL_KEY',
    ...Object.keys(process.env).filter((key) => key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_USE_'))];
  originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-models-cmd-'));
  process.env.HOME = home;
  process.env.MY_MODEL_KEY = 'sk-from-env';
});

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.exitCode = undefined;
  await fse.remove(home);
});

async function captureOutput(run: () => Promise<void>): Promise<string[]> {
  const output: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => { output.push(line); });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return output;
}

async function addMine(overrides: Record<string, unknown> = {}) {
  await modelsAdd('mine', {
    name: 'Mine', protocol: 'anthropic,openai-chat-completions', baseUrl: 'https://gateway.example.test',
    model: 'glm-5.3,deepseek-v4-flash', fromEnv: 'MY_MODEL_KEY', ...overrides,
  });
}

describe('models commands', () => {
  it('adds a multi-protocol personal profile without touching agents or storing the key', async () => {
    await fse.outputJson(path.join(home, '.claude', 'settings.json'), { model: 'keep' });
    await addMine();
    const [profile] = (await loadLocalProfiles()).profiles;
    expect(profile).toEqual({
      id: 'mine', name: 'Mine', base_url: 'https://gateway.example.test', api_key: '${API_KEY}',
      model_groups: [{ protocols: ['anthropic', 'openai-chat-completions'], models: ['glm-5.3', 'deepseek-v4-flash'] }],
    });
    expect(await loadModelInputs(getLocalValuesPath())).toEqual({ 'local:mine': { API_KEY: { env: 'MY_MODEL_KEY' } } });
    expect(await fse.readJson(path.join(home, '.claude', 'settings.json'))).toEqual({ model: 'keep' });
    await expect(addMine()).rejects.toThrow(/already exists/);
    await expect(modelsAdd('bad', { name: 'Bad', protocol: 'grpc', baseUrl: 'https://x.example.test', model: 'm', fromEnv: 'K' }))
      .rejects.toThrow(/Unknown protocol grpc/);
    await expect(modelsAdd('bad', { name: 'Bad', protocol: 'anthropic', baseUrl: 'https://x.example.test/v1', model: 'm', fromEnv: 'K' }))
      .rejects.toThrow(/Invalid model profile: base_url: must be the gateway root without \/v1/);
  });

  it('shows the key source, gateway, models, and compatible agents', async () => {
    await addMine();
    const output = await captureOutput(() => modelsShow('local:mine'));
    expect(output).toEqual([
      'local:mine — Mine',
      'API key: environment MY_MODEL_KEY',
      'Gateway: https://gateway.example.test',
      'Models:',
      '  anthropic, openai-chat-completions: glm-5.3, deepseek-v4-flash',
      'Agents: claude, opencode, codebuddy, workbuddy',
    ]);
  });

  it('extends a personal profile while keeping the first model as the default', async () => {
    await addMine({ protocol: 'anthropic' });
    await modelsConfigure('local:mine', { protocol: 'openai-responses', model: 'glm-5.3' });
    await modelsConfigure('local:mine', { model: 'kimi-k3' });
    await modelsConfigure('local:mine', { protocol: 'openai-chat-completions' });
    const [profile] = (await loadLocalProfiles()).profiles;
    expect(profile.model_groups).toEqual([
      { protocols: ['anthropic', 'openai-responses', 'openai-chat-completions'], models: ['glm-5.3', 'kimi-k3'] },
      { protocols: ['anthropic', 'openai-chat-completions'], models: ['deepseek-v4-flash'] },
    ]);
  });

  it('leaves models.yaml unchanged when an edit is invalid or no key is configured', async () => {
    await addMine();
    const file = path.join(home, '.teamai', 'models', 'models.yaml');
    const before = await fse.readFile(file, 'utf8');
    await expect(modelsConfigure('local:mine', { baseUrl: 'https://gateway.example.test?key=1' })).rejects.toThrow(/without embedded credentials/);
    await fse.writeJson(getLocalValuesPath(), {});
    await expect(modelsConfigure('local:mine', { name: 'Renamed' })).rejects.toThrow(/has no API key/);
    expect(await fse.readFile(file, 'utf8')).toBe(before);
    await modelsConfigure('local:mine', { name: 'Renamed', fromEnv: 'MY_MODEL_KEY' });
    expect((await loadLocalProfiles()).profiles[0].name).toBe('Renamed');
  });

  it('switches every compatible installed agent by default and lists where a profile is active', async () => {
    await fse.outputJson(path.join(home, '.claude', 'settings.json'), {});
    await fse.outputJson(path.join(home, '.codebuddy', 'models.json'), { models: [] });
    await addMine();
    const output = await captureOutput(() => modelsSwitch('mine', { model: 'deepseek-v4-flash' }));
    expect(output.filter((line) => line.startsWith('switched')).length).toBe(2);
    expect(output.some((line) => line.startsWith('not-installed') && line.includes('workbuddy'))).toBe(true);
    expect(process.exitCode).toBeUndefined();
    expect((await fse.readJson(path.join(home, '.claude', 'settings.json'))).model).toBe('deepseek-v4-flash');
    expect(await captureOutput(() => modelsList())).toEqual(['local:mine  Mine  [claude, opencode, codebuddy, workbuddy]  active: claude, codebuddy']);

    await captureOutput(() => modelsSwitch('mine', { agent: ['workbuddy'] }));
    expect(process.exitCode).toBe(1);
  });

  it('asks for a missing key instead of failing only when interactive', async () => {
    await addMine();
    await fse.writeJson(getLocalValuesPath(), {});
    await expect(modelsSwitch('mine', {})).rejects.toThrow(/has no API key. Run `teamai models configure local:mine`/);
  });

  it('restores every managed agent by default and reports when nothing is managed', async () => {
    await fse.outputJson(path.join(home, '.claude', 'settings.json'), { model: 'personal' });
    await addMine();
    await captureOutput(() => modelsSwitch('mine', { agent: ['claude'] }));
    await modelsRemove('local:mine');
    const output = await captureOutput(() => modelsRestore({}));
    expect(output).toEqual(['restored      claude model settings restored']);
    expect(await fse.readJson(path.join(home, '.claude', 'settings.json'))).toEqual({ model: 'personal' });
    expect(await captureOutput(() => modelsRestore({}))).toEqual([]);
  });

  it('removes only local profiles and leaves agent settings untouched', async () => {
    await addMine();
    await fse.outputJson(path.join(home, '.claude', 'settings.json'), { model: 'keep' });
    await modelsRemove('local:mine');
    expect(await fse.readJson(path.join(home, '.claude', 'settings.json'))).toEqual({ model: 'keep' });
    expect(await fse.readFile(path.join(home, '.teamai', 'models', 'models.yaml'), 'utf8')).not.toContain('mine');
    await expect(modelsRemove('team:corp')).rejects.toThrow(/read-only/);
  });
});
