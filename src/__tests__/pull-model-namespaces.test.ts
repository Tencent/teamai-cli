/**
 * Team model profiles by namespace (#707): `models/<ns>/models.yaml`, where
 * `<ns>` is active in `resources.models`, replaces the root profile with the
 * same id. A member's stored team API key is bound to the profile id and the
 * gateway origin, so an override that moves a profile to another host never
 * receives the key configured for the first one. Asserted through `pull` and
 * the `models` commands, on the agent settings they leave on disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  autoDetectInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('Already up to date.'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    persist: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

// pull() and the model commands take real lock files; parallel workers would race on them.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/prompt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/prompt.js')>()),
  isInteractive: vi.fn(() => false),
  askSecret: vi.fn(),
}));

import { pull } from '../pull.js';
import { modelsConfigure, modelsList, modelsSwitch } from '../models-cmd.js';
import { getTeamValuesPath, saveModelInputs } from '../models/profile.js';
import { autoDetectInit, loadLocalConfigForScope, loadTeamConfig, requireInit } from '../config.js';
import { askSecret, isInteractive } from '../utils/prompt.js';
import { log } from '../utils/logger.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

const PROJECTS_YAML = `
version: 1
projects:
  - id: checkout
    resources:
      models: [checkout]
  - id: billing
    resources:
      models: [billing]
`;

const COMPANY = 'https://gw.company.test';
const CHECKOUT = 'https://gw.checkout.test';
const ELSEWHERE = 'https://gw.elsewhere.test';

function catalog(...profiles: Array<{ id?: string; base_url: string; models: string[] }>): string {
  return YAML.stringify({
    profiles: profiles.map(({ id = 'gw', base_url, models }) => ({
      id,
      name: `Gateway ${id}`,
      base_url,
      api_key: '${API_KEY}',
      model_groups: [{ protocols: ['anthropic'], models }],
    })),
  });
}

interface ClaudeModelSettings {
  url: unknown;
  token: unknown;
  model: unknown;
}

describe('pull: team model profiles by namespace', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;

  function configFor(projects: string[]): LocalConfig {
    return {
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      projects,
      resourceProfileVersion: 1,
      scope: 'user',
    };
  }

  /** Work in these projects, for pull and for the models commands. */
  const inProjects = (...projects: string[]): void => {
    const localConfig = configFor(projects);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(requireInit).mockResolvedValue({ localConfig, teamConfig });
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig, teamConfig });
  };
  const team = (rel: string, content: string): Promise<void> => fse.outputFile(path.join(repoPath, rel), content);
  const logged = (level: 'warn' | 'info' | 'error' | 'persist', pattern: RegExp): boolean => (
    vi.mocked(log[level]).mock.calls.some((args) => pattern.test(args.map(String).join(' ')))
  );
  async function claude(): Promise<ClaudeModelSettings> {
    const settings = await fse.readJson(path.join(homeDir, '.claude', 'settings.json')) as {
      env?: Record<string, unknown>;
      model?: unknown;
    };
    return { url: settings.env?.ANTHROPIC_BASE_URL, token: settings.env?.ANTHROPIC_AUTH_TOKEN, model: settings.model };
  }
  /** The invariant under test: each key only ever sits next to the gateway it was configured for. */
  async function expectNoKeyOnAnotherGateway(): Promise<void> {
    const { url, token } = await claude();
    if (token === 'company-secret') expect(String(url).startsWith(COMPANY)).toBe(true);
    if (token === 'checkout-secret') expect(String(url).startsWith(CHECKOUT)).toBe(true);
  }
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
  /** Switch Claude to team:<id> with a key read from the COMPANY_KEY variable. */
  async function switchTo(id: string): Promise<void> {
    await modelsConfigure(`team:${id}`, { fromEnv: 'COMPANY_KEY' });
    await captureOutput(() => modelsSwitch(`team:${id}`, { agent: ['claude'] }));
  }

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-model-ns-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await team('manifest/projects.yaml', PROJECTS_YAML);
    await team('models/models.yaml', catalog({ base_url: COMPANY, models: ['company-model'] }));
    await team('rules/team.md', '# Team rule\n');
    await fse.outputJson(path.join(homeDir, '.claude', 'settings.json'), {});

    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HERMES_HOME', path.join(homeDir, '.hermes'));
    for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG']) vi.stubEnv(key, '');
    for (const key of Object.keys(process.env).filter((name) => name.startsWith('ANTHROPIC_'))) vi.stubEnv(key, '');
    vi.stubEnv('COMPANY_KEY', 'company-secret');
    vi.stubEnv('CHECKOUT_KEY', 'checkout-secret');

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', agents: '.claude/agents', claudemd: '.claude/CLAUDE.md' },
      },
    };
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    inProjects();
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
    vi.mocked(log.error).mockClear();
    vi.mocked(log.persist).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    await fse.remove(tmpDir);
  });

  it('follows a same-gateway override while the namespace is active, and the root profile once it is not', async () => {
    await switchTo('gw');
    expect(await claude()).toEqual({ url: COMPANY, token: 'company-secret', model: 'company-model' });

    await team('models/checkout/models.yaml', catalog({ base_url: `${COMPANY}/checkout`, models: ['checkout-model'] }));
    inProjects('checkout');
    await pull({});
    expect(await claude()).toEqual({ url: `${COMPANY}/checkout`, token: 'company-secret', model: 'checkout-model' });

    inProjects();
    await pull({});
    expect(await claude()).toEqual({ url: COMPANY, token: 'company-secret', model: 'company-model' });
  });

  it('never sends the key to the gateway of an override on another origin', async () => {
    await switchTo('gw');
    await team('models/checkout/models.yaml', catalog({ base_url: CHECKOUT, models: ['checkout-model'] }));
    inProjects('checkout');

    await pull({});
    // The agent is left alone and the member is told how to set the other key.
    expect(await claude()).toEqual({ url: COMPANY, token: 'company-secret', model: 'company-model' });
    expect(logged('warn', /team:gw now uses https:\/\/gw\.checkout\.test.*claude keeps? its settings.*teamai models switch team:gw/)).toBe(true);
    // A SessionStart pull runs silent: the line is in debug.log too.
    expect(logged('persist', /team:gw now uses https:\/\/gw\.checkout\.test.*teamai models switch team:gw/)).toBe(true);

    // `switch` does not reuse the company key for the checkout gateway either.
    await expect(modelsSwitch('team:gw', { agent: ['claude'] })).rejects.toThrow(/no API key for https:\/\/gw\.checkout\.test/);
    await expectNoKeyOnAnotherGateway();

    await modelsConfigure('team:gw', { fromEnv: 'CHECKOUT_KEY' });
    await captureOutput(() => modelsSwitch('team:gw', { agent: ['claude'] }));
    expect(await claude()).toEqual({ url: CHECKOUT, token: 'checkout-secret', model: 'checkout-model' });

    // Leaving the project returns to the root profile with the key stored for it.
    inProjects();
    await pull({});
    expect(await claude()).toEqual({ url: COMPANY, token: 'company-secret', model: 'company-model' });

    inProjects('checkout');
    await pull({});
    expect(await claude()).toEqual({ url: CHECKOUT, token: 'checkout-secret', model: 'checkout-model' });
  });

  it('keeps the settings of a profile whose only namespace deactivates, and says so', async () => {
    await team('models/checkout/models.yaml', catalog({ id: 'proj', base_url: COMPANY, models: ['proj-model'] }));
    inProjects('checkout');
    await switchTo('proj');
    expect((await claude()).model).toBe('proj-model');

    inProjects();
    await pull({});
    expect(await claude()).toEqual({ url: COMPANY, token: 'company-secret', model: 'proj-model' });
    expect(logged('warn', /team:proj is no longer active in your namespaces; claude keeps? (its|their) settings/)).toBe(true);
    expect(logged('persist', /team:proj is no longer active in your namespaces/)).toBe(true);
  });

  it('still says a profile was removed when no namespace defines it', async () => {
    await switchTo('gw');
    await team('models/models.yaml', catalog({ id: 'other', base_url: COMPANY, models: ['other-model'] }));

    await pull({});
    expect((await claude()).model).toBe('company-model');
    expect(logged('warn', /team:gw was removed/)).toBe(true);
  });

  it('says a profile was removed in legacy mode, even when some namespace file defines it', async () => {
    await fse.remove(path.join(repoPath, 'manifest'));
    await switchTo('gw');
    await team('models/models.yaml', catalog({ id: 'other', base_url: COMPANY, models: ['other-model'] }));
    await team('models/checkout/models.yaml', catalog({ base_url: COMPANY, models: ['checkout-model'] }));

    await pull({});
    expect(logged('warn', /team:gw was removed/)).toBe(true);
    expect(logged('warn', /no longer active in your namespaces/)).toBe(false);
  });

  it('reports profiles that cannot be resolved as an error of the command, not a crash', async () => {
    await team('models/checkout/models.yaml', catalog({ base_url: COMPANY, models: ['checkout-model'] }));
    await team('models/billing/models.yaml', catalog({ base_url: COMPANY, models: ['billing-model'] }));
    inProjects('checkout', 'billing');

    await captureOutput(() => modelsList());
    expect(logged('error', /"gw" is defined in both models\/(checkout|billing)\/models\.yaml and models\/(billing|checkout)\/models\.yaml/)).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('stops only models when two active namespaces define one profile id', async () => {
    await switchTo('gw');
    await team('models/checkout/models.yaml', catalog({ base_url: COMPANY, models: ['checkout-model'] }));
    await team('models/billing/models.yaml', catalog({ base_url: COMPANY, models: ['billing-model'] }));
    // Same commit: a root catalog change and a rule that lands after models in the pull.
    await team('models/models.yaml', catalog({ base_url: COMPANY, models: ['company-model-2'] }));
    await team('rules/later.md', '# Later rule\n');
    inProjects('checkout', 'billing');

    await pull({});
    expect(logged('warn', /"gw" is defined in both models\/(checkout|billing)\/models\.yaml and models\/(billing|checkout)\/models\.yaml/)).toBe(true);
    expect(await claude()).toEqual({ url: COMPANY, token: 'company-secret', model: 'company-model' });
    expect(await fse.readFile(path.join(homeDir, '.claude', 'rules', 'later.md'), 'utf8')).toBe('# Later rule\n');
  });

  it('keeps the agent settings when an active models file is broken', async () => {
    await switchTo('gw');
    await team('models/checkout/models.yaml', 'profiles:\n  - id: gw\n');
    await team('models/models.yaml', catalog({ base_url: COMPANY, models: ['company-model-2'] }));
    await team('rules/later.md', '# Later rule\n');
    inProjects('checkout');

    await pull({});
    expect(logged('warn', /models\/checkout\/models\.yaml.*models was not applied this run/)).toBe(true);
    expect(await claude()).toEqual({ url: COMPANY, token: 'company-secret', model: 'company-model' });
    expect(await fse.readFile(path.join(homeDir, '.claude', 'rules', 'later.md'), 'utf8')).toBe('# Later rule\n');
  });

  it('binds a key stored before namespaces existed to the root profile gateway', async () => {
    // What the 0.26.0 betas stored: keyed by profile id alone.
    await saveModelInputs(getTeamValuesPath(configFor([])), { 'team:gw': { API_KEY: { env: 'COMPANY_KEY' } } });
    await captureOutput(() => modelsSwitch('team:gw', { agent: ['claude'] }));
    expect(await claude()).toEqual({ url: COMPANY, token: 'company-secret', model: 'company-model' });

    await team('models/checkout/models.yaml', catalog({ base_url: CHECKOUT, models: ['checkout-model'] }));
    inProjects('checkout');
    await pull({});
    expect(await claude()).toEqual({ url: COMPANY, token: 'company-secret', model: 'company-model' });
    expect(logged('warn', /teamai models switch team:gw/)).toBe(true);

    await team('models/checkout/models.yaml', catalog({ base_url: `${COMPANY}/checkout`, models: ['checkout-model'] }));
    await pull({});
    expect(await claude()).toEqual({ url: `${COMPANY}/checkout`, token: 'company-secret', model: 'checkout-model' });
  });

  it('models list reads a key stored before namespaces existed bound, and leaves the file as it was (#893)', async () => {
    const file = getTeamValuesPath(configFor([]));
    await saveModelInputs(file, { 'team:gw': { API_KEY: { env: 'COMPANY_KEY' } } });
    const before = await fse.readFile(file, 'utf8');

    const output = await captureOutput(() => modelsList('team:gw'));

    expect(output).toContain('  API key: environment COMPANY_KEY');
    expect(await fse.readFile(file, 'utf8')).toBe(before);
  });

  it('binds a beta key to the gateway its agent was switched to, so a root profile that moved since never gets it', async () => {
    const beta = { 'team:gw': { API_KEY: { env: 'COMPANY_KEY' } } };
    await saveModelInputs(getTeamValuesPath(configFor([])), beta);
    await captureOutput(() => modelsSwitch('team:gw', { agent: ['claude'] }));
    expect(await claude()).toEqual({ url: COMPANY, token: 'company-secret', model: 'company-model' });
    // What a beta leaves behind: the agent on the company gateway, the key under the profile id alone.
    await saveModelInputs(getTeamValuesPath(configFor([])), beta);

    await team('models/models.yaml', catalog({ base_url: ELSEWHERE, models: ['elsewhere-model'] }));
    await pull({});

    expect(await claude()).toEqual({ url: COMPANY, token: 'company-secret', model: 'company-model' });
    expect(logged('warn', /team:gw now uses https:\/\/gw\.elsewhere\.test.*teamai models switch team:gw/)).toBe(true);
    await expect(modelsSwitch('team:gw', { agent: ['claude'] })).rejects.toThrow(/no API key for https:\/\/gw\.elsewhere\.test/);
    await expectNoKeyOnAnotherGateway();
  });

  it('binds a beta key no agent used to the root gateway at the first pull, and does not follow a later move', async () => {
    await saveModelInputs(getTeamValuesPath(configFor([])), { 'team:gw': { API_KEY: { env: 'COMPANY_KEY' } } });
    await pull({});

    await team('models/models.yaml', catalog({ base_url: ELSEWHERE, models: ['elsewhere-model'] }));
    await expect(modelsSwitch('team:gw', { agent: ['claude'] })).rejects.toThrow(/no API key for https:\/\/gw\.elsewhere\.test/);
    const output = await captureOutput(() => modelsList('team:gw'));
    expect(output).toContain('  API key: not configured for https://gw.elsewhere.test (one is stored for another gateway)');
  });

  it('stores a key on the first interactive switch to a team profile and resolves it in the same run', async () => {
    // No stored key: the first `switch` must ask for one, save it under its
    // own origin lock, and resolve the profile the same run — not fail with
    // "has no API key" and demand a rerun for the key to take effect.
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askSecret).mockResolvedValue('switched-secret');
    try {
      await captureOutput(() => modelsSwitch('team:gw', { agent: ['claude'] }));
      expect(await claude()).toEqual({ url: COMPANY, token: 'switched-secret', model: 'company-model' });
    } finally {
      vi.mocked(isInteractive).mockReturnValue(false);
    }
  });

  it('reads the root catalog only in legacy mode', async () => {
    await fse.remove(path.join(repoPath, 'manifest'));
    await switchTo('gw');
    await team('models/checkout/models.yaml', catalog({ base_url: `${COMPANY}/checkout`, models: ['checkout-model'] }));
    await team('models/models.yaml', catalog({ base_url: COMPANY, models: ['company-model-2'] }));

    await pull({});
    expect(await claude()).toEqual({ url: COMPANY, token: 'company-secret', model: 'company-model-2' });
  });

  it('lists where each team profile comes from', async () => {
    await team('models/checkout/models.yaml', catalog(
      { base_url: CHECKOUT, models: ['checkout-model'] },
      { id: 'proj', base_url: CHECKOUT, models: ['proj-model'] },
    ));
    await modelsConfigure('team:gw', { fromEnv: 'COMPANY_KEY' });
    inProjects('checkout');

    const output = await captureOutput(() => modelsList());
    expect(output).toContain('team:gw — Gateway gw');
    expect(output).toContain('  From: models/checkout/models.yaml (checkout, overrides root)');
    expect(output).toContain('  From: models/checkout/models.yaml (checkout)');
    // The company key is not a key for the checkout gateway.
    expect(output).toContain('  API key: not configured for https://gw.checkout.test (one is stored for another gateway)');

    inProjects();
    const root = await captureOutput(() => modelsList('team:gw'));
    expect(root).toContain('  From: models/models.yaml (root)');
    expect(root).toContain('  API key: environment COMPANY_KEY');
  });
});
