import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

/**
 * Drives the built CLI against a scratch HOME so a switch here never touches
 * the developer's real ~/.teamai or ~/.pi. Pi's agent directory is addressed
 * through PI_CODING_AGENT_DIR, the same override a member would use.
 */
describe('teamai models switch --agent pi (e2e)', () => {
  let sandbox: string;
  let home: string;
  let agentDir: string;

  /** The provider a member already had: TeamAI must never touch it. */
  const personal = {
    providers: {
      HAIHUB: {
        baseUrl: 'https://api.model.haihub.cn/v1',
        api: 'openai-completions',
        apiKey: 'sk-personal-untouched',
        models: [{ id: 'DeepSeek-V4-Flash' }],
      },
    },
  };

  const modelsFile = () => path.join(agentDir, 'models.json');

  function cli(...args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: sandbox,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: agentDir,
        TEAMAI_E2E_KEY: 'sk-e2e-secret',
        FORCE_COLOR: '0',
      },
      encoding: 'utf8',
    });
  }

  const output = (result: ReturnType<typeof cli>) => `${result.stdout}${result.stderr}`;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error('Run npm run build before the E2E test.');
  });

  // Each case gets its own HOME: `models add` refuses a profile that already
  // exists, so a shared sandbox would make a case depend on the one before it —
  // and the config retries flaky cases, which would then fail on the retry.
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pi-models-e2e-'));
    home = path.join(sandbox, 'home');
    agentDir = path.join(home, '.pi', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(modelsFile(), JSON.stringify(personal, null, 2));
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** Add the profile a case switches to, in the sandbox the case set up. */
  function addTokenhub() {
    const added = cli('models', 'add', 'tokenhub',
      '--name', 'Tencent TokenHub',
      '--protocol', 'openai-chat-completions',
      '--base-url', 'https://tokenhub.example.test',
      '--model', 'glm-5.3,deepseek-v4-flash',
      '--from-env', 'TEAMAI_E2E_KEY');
    expect(output(added)).toContain('Added local model profile');
  }

  it('writes one provider named after the profile and restores the file', () => {
    addTokenhub();

    expect(output(cli('models', 'switch', 'local:tokenhub', '--agent', 'pi')))
      .toContain('pi switched to local:tokenhub');

    const written = fs.readFileSync(modelsFile(), 'utf8');
    const provider = JSON.parse(written).providers['local:tokenhub'];
    // The provider key is the catalog id; `name` carries the display name.
    expect(provider.name).toBe('Tencent TokenHub');
    expect(provider.baseUrl).toBe('https://tokenhub.example.test/v1');
    expect(provider.api).toBe('openai-completions');
    expect(provider.models).toEqual([{ id: 'glm-5.3' }, { id: 'deepseek-v4-flash' }]);
    // The member's own provider survives, and no secret reaches the file.
    expect(JSON.parse(written).providers.HAIHUB).toEqual(personal.providers.HAIHUB);
    expect(written).not.toContain('sk-e2e-secret');
    expect(provider.apiKey).toBe('$TEAMAI_E2E_KEY');
    // `id` keys the entry for TeamAI; it is not part of Pi's provider schema.
    expect(provider).not.toHaveProperty('id');

    expect(output(cli('models', 'restore', '--agent', 'pi'))).toContain('restored');
    expect(JSON.parse(fs.readFileSync(modelsFile(), 'utf8'))).toEqual(personal);
  });

  it('serves a catalog mixing Anthropic with an OpenAI protocol as one provider', () => {
    expect(output(cli('models', 'add', 'mixedgw',
      '--name', 'Mixed Gateway',
      '--protocol', 'anthropic,openai-chat-completions',
      '--base-url', 'https://mixed.example.test',
      '--model', 'glm-5.3',
      '--from-env', 'TEAMAI_E2E_KEY'))).toContain('Added local model profile');

    expect(output(cli('models', 'switch', 'local:mixedgw', '--agent', 'pi')))
      .toContain('pi switched to local:mixedgw');

    // A Pi provider carries one baseUrl and api, but a model overrides both,
    // so the OpenAI route is the provider default and Anthropic departs from
    // it per model rather than being refused. The one model is reached over
    // both protocols, so it is registered once, on the OpenAI side.
    const provider = JSON.parse(fs.readFileSync(modelsFile(), 'utf8')).providers['local:mixedgw'];
    expect(provider.api).toBe('openai-completions');
    expect(provider.baseUrl).toBe('https://mixed.example.test/v1');
    expect(provider.models).toEqual([{ id: 'glm-5.3' }]);
  });

  it('pins a model to Anthropic Messages by declaring it in its own group', () => {
    // The shape a team uses when a gateway serves Claude models over Anthropic
    // Messages and everything else over OpenAI-compatible chat completions.
    const catalogDir = path.join(home, '.teamai', 'models');
    fs.mkdirSync(catalogDir, { recursive: true });
    fs.writeFileSync(path.join(catalogDir, 'models.yaml'), [
      'profiles:',
      '  - id: split',
      '    name: Split Gateway',
      '    base_url: https://split.example.test',
      '    api_key: ${API_KEY}',
      '    model_groups:',
      '      - protocols: [anthropic]',
      '        models: [claude-opus-4-8]',
      '      - protocols: [openai-chat-completions]',
      '        models: [glm-5.3, deepseek-v4-flash]',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(catalogDir, 'values.json'),
      JSON.stringify({ 'local:split': { API_KEY: { env: 'TEAMAI_E2E_KEY' } } }));

    expect(output(cli('models', 'switch', 'local:split', '--agent', 'pi')))
      .toContain('pi switched to local:split');
    const provider = JSON.parse(fs.readFileSync(modelsFile(), 'utf8')).providers['local:split'];
    // OpenAI-compatible is the provider default; the Claude model overrides
    // both the api and the url, and the plain models repeat nothing.
    expect(provider.api).toBe('openai-completions');
    expect(provider.baseUrl).toBe('https://split.example.test/v1');
    expect(provider.models).toEqual([
      { id: 'glm-5.3' },
      { id: 'deepseek-v4-flash' },
      { id: 'claude-opus-4-8', api: 'anthropic-messages', baseUrl: 'https://split.example.test' },
    ]);
  });

  it('leaves settings.json alone so the default model stays the member\'s', () => {
    const settingsFile = path.join(agentDir, 'settings.json');
    const original = { theme: 'dark', defaultProvider: 'HAIHUB', defaultModel: 'DeepSeek-V4-Flash' };
    fs.writeFileSync(settingsFile, JSON.stringify(original, null, 2));
    addTokenhub();

    expect(output(cli('models', 'switch', 'local:tokenhub', '--agent', 'pi')))
      .toContain('pi switched to local:tokenhub');
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toEqual(original);

    expect(output(cli('models', 'restore', '--agent', 'pi'))).toContain('restored');
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toEqual(original);
  });
});