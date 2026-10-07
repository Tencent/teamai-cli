import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

/**
 * Drives the built CLI against a scratch HOME so a switch here never touches
 * the developer's real ~/.teamai or ~/.omp.
 *
 * OMP reads no agent-dir override for models: its `PI_CODING_AGENT_DIR` is the
 * variable Pi honors, so TeamAI deliberately writes only the default
 * `~/.omp/agent/models.yml` and the scratch HOME is what redirects it here. The
 * file is YAML, and the assertions parse it as YAML — an OMP provider catalog
 * written as JSON would pass a JSON parse but is not what the tool documents.
 */
describe('teamai models switch --agent omp (e2e)', () => {
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

  const modelsFile = () => path.join(agentDir, 'models.yml');

  function cli(...args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: sandbox,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TEAMAI_E2E_KEY: 'sk-e2e-secret',
        FORCE_COLOR: '0',
      },
      encoding: 'utf8',
    });
  }

  const output = (result: ReturnType<typeof cli>) => `${result.stdout}${result.stderr}`;

  /** The written catalog, parsed the way OMP parses it. */
  const writtenDoc = () => YAML.parse(fs.readFileSync(modelsFile(), 'utf8'));

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error('Run npm run build before the E2E test.');
  });

  // Each case gets its own HOME: `models add` refuses a profile that already
  // exists, so a shared sandbox would make a case depend on the one before it.
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-omp-models-e2e-'));
    home = path.join(sandbox, 'home');
    agentDir = path.join(home, '.omp', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(modelsFile(), YAML.stringify(personal));
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

  it('writes one YAML provider named after the profile and restores the file', () => {
    addTokenhub();

    expect(output(cli('models', 'switch', 'local:tokenhub', '--agent', 'omp')))
      .toContain('omp switched to local:tokenhub');

    const provider = writtenDoc().providers['local:tokenhub'];
    // The provider key is the catalog id; `name` carries the display name.
    expect(provider.name).toBe('Tencent TokenHub');
    expect(provider.baseUrl).toBe('https://tokenhub.example.test/v1');
    expect(provider.api).toBe('openai-completions');
    expect(provider.models).toEqual([{ id: 'glm-5.3' }, { id: 'deepseek-v4-flash' }]);
    // The member's own provider survives.
    expect(writtenDoc().providers.HAIHUB).toEqual(personal.providers.HAIHUB);
    // `id` keys the entry for TeamAI; it is not part of the provider schema.
    expect(provider).not.toHaveProperty('id');

    expect(output(cli('models', 'restore', '--agent', 'omp'))).toContain('restored');
    expect(writtenDoc()).toEqual(personal);
  });

  it('references an environment-backed key through a command, keeping it out of the file', () => {
    addTokenhub();

    expect(output(cli('models', 'switch', 'local:tokenhub', '--agent', 'omp')))
      .toContain('omp switched to local:tokenhub');

    // OMP expands no `$VAR`, but runs a `!command` value and uses its output,
    // so the key stays in the environment instead of being written beside it.
    const written = fs.readFileSync(modelsFile(), 'utf8');
    expect(writtenDoc().providers['local:tokenhub'].apiKey).toBe('!printenv TEAMAI_E2E_KEY');
    expect(written).not.toContain('sk-e2e-secret');
  });

  it('writes YAML, not the JSON that happens to parse as YAML', () => {
    addTokenhub();

    expect(output(cli('models', 'switch', 'local:tokenhub', '--agent', 'omp')))
      .toContain('omp switched to local:tokenhub');

    // OMP's parser accepts JSON because JSON is a YAML subset, so a JSON file
    // would pass a read-back test while not being what a member writing this
    // file by hand — or OMP's own docs — would produce.
    const written = fs.readFileSync(modelsFile(), 'utf8');
    expect(written.trimStart().startsWith('{')).toBe(false);
    expect(written).toContain('providers:\n');
  });

  it('serves a catalog mixing Anthropic with an OpenAI protocol as one provider', () => {
    expect(output(cli('models', 'add', 'mixedgw',
      '--name', 'Mixed Gateway',
      '--protocol', 'anthropic,openai-chat-completions',
      '--base-url', 'https://mixed.example.test',
      '--model', 'glm-5.3',
      '--from-env', 'TEAMAI_E2E_KEY'))).toContain('Added local model profile');

    expect(output(cli('models', 'switch', 'local:mixedgw', '--agent', 'omp')))
      .toContain('omp switched to local:mixedgw');

    // One baseUrl and api at the provider, and a model overrides both, so the
    // OpenAI route is the default and Anthropic departs from it per model.
    const provider = writtenDoc().providers['local:mixedgw'];
    expect(provider.api).toBe('openai-completions');
    expect(provider.baseUrl).toBe('https://mixed.example.test/v1');
    expect(provider.models).toEqual([{ id: 'glm-5.3' }]);
  });

  it('pins a model to Anthropic Messages by declaring it in its own group', () => {
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

    expect(output(cli('models', 'switch', 'local:split', '--agent', 'omp')))
      .toContain('omp switched to local:split');
    const provider = writtenDoc().providers['local:split'];
    expect(provider.api).toBe('openai-completions');
    expect(provider.baseUrl).toBe('https://split.example.test/v1');
    expect(provider.models).toEqual([
      { id: 'glm-5.3' },
      { id: 'deepseek-v4-flash' },
      { id: 'claude-opus-4-8', api: 'anthropic-messages', baseUrl: 'https://split.example.test' },
    ]);
  });

  it('ignores PI_CODING_AGENT_DIR, which addresses Pi rather than OMP', () => {
    addTokenhub();

    // The variable is Pi's. Honoring it here would write OMP's catalog into
    // Pi's directory on a machine that sets it for Pi — the ambiguity the
    // default-only policy avoids.
    const piDir = path.join(sandbox, 'pi-agent');
    const result = spawnSync(process.execPath, [CLI, 'models', 'switch', 'local:tokenhub', '--agent', 'omp'], {
      cwd: sandbox,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: piDir,
        TEAMAI_E2E_KEY: 'sk-e2e-secret',
        FORCE_COLOR: '0',
      },
      encoding: 'utf8',
    });
    expect(`${result.stdout}${result.stderr}`).toContain('omp switched to local:tokenhub');

    expect(writtenDoc().providers['local:tokenhub']).toBeDefined();
    expect(fs.existsSync(path.join(piDir, 'models.json'))).toBe(false);
    expect(fs.existsSync(path.join(piDir, 'models.yml'))).toBe(false);
  });

  it('skips a file the member owns, and reports it', () => {
    // A same-named provider the member wrote outside TeamAI is theirs: the
    // collision check refuses rather than overwriting it.
    fs.writeFileSync(modelsFile(), YAML.stringify({
      providers: { 'local:tokenhub': { baseUrl: 'https://mine.example.test', api: 'openai-completions' } },
    }));
    addTokenhub();

    expect(output(cli('models', 'switch', 'local:tokenhub', '--agent', 'omp')))
      .toContain('already has a user-owned provider named local:tokenhub');
    expect(writtenDoc().providers['local:tokenhub'].baseUrl).toBe('https://mine.example.test');
  });

  it('leaves an unparseable catalog alone rather than replacing it', () => {
    // The file is the member's until TeamAI can read it. Replacing a file it
    // could not parse would discard whatever they had.
    const broken = 'providers:\n  bad: [unclosed\n';
    fs.writeFileSync(modelsFile(), broken);
    addTokenhub();

    const result = cli('models', 'switch', 'local:tokenhub', '--agent', 'omp');
    expect(output(result)).toContain('Cannot parse');
    expect(fs.readFileSync(modelsFile(), 'utf8')).toBe(broken);
  });
});