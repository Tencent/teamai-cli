import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelsAdd, modelsConfigure, modelsList, modelsRemove, modelsRestore, modelsSwitch } from '../models-cmd.js';
import { getLocalValuesPath, loadLocalProfiles, loadModelInputs } from '../models/profile.js';
import { askSecret, isInteractive } from '../utils/prompt.js';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/prompt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/prompt.js')>()),
  isInteractive: vi.fn(() => false),
  askSecret: vi.fn(),
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

  it('lists every profile in full, or just the one named', async () => {
    await addMine();
    await modelsAdd('other', {
      name: 'Other', protocol: 'openai-responses', baseUrl: 'https://other.example.test',
      model: 'glm-5.3', apiKeyStdin: false, fromEnv: 'OTHER_KEY',
    });
    const mine = [
      'local:mine — Mine',
      '  API key: environment MY_MODEL_KEY',
      '  Gateway: https://gateway.example.test',
      '  Models:',
      '    anthropic, openai-chat-completions: glm-5.3, deepseek-v4-flash',
      '  Agents: claude, opencode, codebuddy, workbuddy, pi',
      '  Active: none',
    ];
    expect(await captureOutput(() => modelsList())).toEqual([
      ...mine,
      '',
      'local:other — Other',
      '  API key: environment OTHER_KEY',
      '  Gateway: https://other.example.test',
      '  Models:',
      '    openai-responses: glm-5.3',
      '  Agents: codex, opencode, pi',
      '  Active: none',
    ]);
    expect(await captureOutput(() => modelsList('mine'))).toEqual(mine);
    await expect(modelsList('missing')).rejects.toThrow(/Unknown model profile: missing/);
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

  it('stores a key piped with --api-key-stdin and refuses a terminal or empty input', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'stdin');
    const pipeStdin = (chunks: string[], isTTY?: true) => Object.defineProperty(process, 'stdin', {
      value: Object.assign(Readable.from(chunks), { isTTY }), configurable: true,
    });
    try {
      await addMine();
      pipeStdin(['sk-pi', 'ped\r\n']);
      await modelsConfigure('local:mine', { apiKeyStdin: true });
      expect(Object.values(await loadModelInputs(getLocalValuesPath())).map((entry) => entry.API_KEY))
        .toEqual([{ value: 'sk-piped' }]);

      pipeStdin([], true);
      await expect(modelsConfigure('local:mine', { apiKeyStdin: true })).rejects.toThrow('--api-key-stdin expects piped stdin');
      pipeStdin(['\n']);
      await expect(modelsConfigure('local:mine', { apiKeyStdin: true })).rejects.toThrow('No API key was provided on stdin');
    } finally {
      if (original) Object.defineProperty(process, 'stdin', original);
    }
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
    expect(await captureOutput(() => modelsList('local:mine'))).toContain('  Active: claude, codebuddy');

    await captureOutput(() => modelsSwitch('mine', { agent: ['workbuddy'] }));
    expect(process.exitCode).toBe(1);
  });

  it('asks for a missing key instead of failing only when interactive', async () => {
    await addMine();
    await fse.writeJson(getLocalValuesPath(), {});
    await expect(modelsSwitch('mine', {})).rejects.toThrow(/has no API key. Run `teamai models configure local:mine`/);
  });

  it('persists the key asked for on the first interactive switch to a personal profile', async () => {
    await fse.outputJson(path.join(home, '.claude', 'settings.json'), {});
    await addMine();
    await fse.writeJson(getLocalValuesPath(), {});
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askSecret).mockResolvedValue('sk-interactive');
    try {
      await captureOutput(() => modelsSwitch('mine', { agent: ['claude'] }));
      expect(await loadModelInputs(getLocalValuesPath())).toEqual({ 'local:mine': { API_KEY: { value: 'sk-interactive' } } });
      expect((await fse.readJson(path.join(home, '.claude', 'settings.json'))).model).toBe('glm-5.3');
    } finally {
      vi.mocked(isInteractive).mockReturnValue(false);
    }
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
