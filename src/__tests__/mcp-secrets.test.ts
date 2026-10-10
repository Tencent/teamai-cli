import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(), persist: vi.fn(),
  },
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  requireInit: vi.fn(),
}));

vi.mock('../utils/prompt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/prompt.js')>()),
  readStdin: vi.fn(),
}));

import { requireInit } from '../config.js';
import { envSet, envUnset } from '../env-commands.js';
import { readStdin } from '../utils/prompt.js';
import { buildVarTable, reconcileMcpForConfig } from '../mcp-reconcile.js';
import { resolvePlaceholders } from '../resources/mcp-format.js';
import type { McpServerDef } from '../types.js';
import { envShMarker } from '../env-sh-exports.js';
import { getMachineSecretsPath, getTeamSecretsPath, writeSecretStore } from '../secret-store.js';
import { log } from '../utils/logger.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * `${VAR}` in mcp.yaml for a declared secret (#875): the member's value for
 * this team, then their value for the machine, then their own environment
 * (#879 Conflict 10), never the repo's
 * env.yaml value for the same key.
 */
describe('MCP servers and declared secrets', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  const teamConfig: TeamaiConfig = {
    team: 't', description: '', repo: 'r', provider: 'tgit', reviewers: [],
    sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '~/.teamai/docs' }, env: { injectShellProfile: false } },
    toolPaths: { claude: { skills: '.claude/skills', settings: '.claude/settings.json', mcp: '.claude.json', mcpProject: '.mcp.json' } },
  };

  const write = (relativePath: string, content: string): Promise<void> =>
    fse.outputFile(path.join(repoPath, ...relativePath.split('/')), content);
  const githubAuthorization = async (): Promise<string | undefined> => {
    const file = path.join(homeDir, '.claude.json');
    if (!await fse.pathExists(file)) return undefined;
    const config = await fse.readJson(file) as { mcpServers?: Record<string, { headers?: Record<string, string> }> };
    return config.mcpServers?.github?.headers?.Authorization;
  };

  beforeEach(async () => {
    resetWarnOnce();
    vi.mocked(log.warn).mockClear();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-secrets-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);
    vi.stubEnv('GITHUB_TOKEN', undefined);
    localConfig = { repo: { localPath: repoPath, remote: 'r' }, username: 'u', scope: 'user', additionalRoles: [] };
    await write('mcp/mcp.yaml', [
      'servers:',
      '  - name: github',
      '    transport: http',
      '    url: https://api.example.com/mcp/',
      '    headers:',
      '      Authorization: Bearer ${GITHUB_TOKEN}',
    ].join('\n'));
    await write('env/secrets.yaml', 'secrets:\n  - key: GITHUB_TOKEN\n');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('gives a server the team value over an exported one', async () => {
    await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { value: 'team-token' } });
    vi.stubEnv('GITHUB_TOKEN', 'exported-token');

    await reconcileMcpForConfig(teamConfig, localConfig);

    expect(await githubAuthorization()).toBe('Bearer team-token');
  });

  it('gives a server the machine value when the team has none, over an exported one', async () => {
    await writeSecretStore(getMachineSecretsPath(), { GITHUB_TOKEN: { value: 'machine-token' } });
    vi.stubEnv('GITHUB_TOKEN', 'exported-token');

    await reconcileMcpForConfig(teamConfig, localConfig);
    expect(await githubAuthorization()).toBe('Bearer machine-token');

    await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { value: 'team-token' } });
    await reconcileMcpForConfig(teamConfig, localConfig);
    expect(await githubAuthorization()).toBe('Bearer team-token');
  });

  // What a member runs: set a value, pull, unset it with nothing exported, pull.
  it('keeps the entry and still owns it after env unset, so a later value replaces it', async () => {
    vi.mocked(requireInit).mockResolvedValue({ localConfig, teamConfig });
    vi.mocked(readStdin).mockResolvedValueOnce('first-token').mockResolvedValueOnce('second-token');

    await envSet('GITHUB_TOKEN', { stdin: true });
    await reconcileMcpForConfig(teamConfig, localConfig);
    expect(await githubAuthorization()).toBe('Bearer first-token');

    await envUnset('GITHUB_TOKEN', {});
    await reconcileMcpForConfig(teamConfig, localConfig);
    expect(await githubAuthorization()).toBe('Bearer first-token');

    await envSet('GITHUB_TOKEN', { stdin: true });
    const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);
    expect(await githubAuthorization()).toBe('Bearer second-token');
    expect(changes.filter((change) => change.server === 'github').map((change) => change.action)).not.toContain('skipped');
  });

  it("uses the member's own export when no team value is set", async () => {
    vi.stubEnv('GITHUB_TOKEN', 'exported-token');

    await reconcileMcpForConfig(teamConfig, localConfig);

    expect(await githubAuthorization()).toBe('Bearer exported-token');
  });

  it("does not use a value another scope's env.sh exported", async () => {
    await fse.outputFile(path.join(homeDir, '.teamai', 'projects', 'other-abc', 'env.sh'), "export GITHUB_TOKEN='other-team-token'\n");
    vi.stubEnv('GITHUB_TOKEN', 'other-team-token');

    await reconcileMcpForConfig(teamConfig, localConfig);

    expect(await githubAuthorization()).toBeUndefined();
  });

  it('does not use a value an env.sh no scan finds exported, and gives no server the marker that says so', async () => {
    const marker = envShMarker(path.join(tmpDir, 'elsewhere', '.teamai'), [['GITHUB_TOKEN', 'project-a-token']]);
    expect(marker).not.toBeNull();
    const [name, digests] = marker ?? ['', ''];
    vi.stubEnv('GITHUB_TOKEN', 'project-a-token');
    vi.stubEnv(name, digests);

    await reconcileMcpForConfig(teamConfig, localConfig);

    expect(await githubAuthorization()).toBeUndefined();
    expect(Object.hasOwn(await buildVarTable(localConfig), name)).toBe(false);
  });

  it("ignores the env.yaml value of a key declared as a secret, and the shell's copy of it", async () => {
    await write('env/env.yaml', 'variables:\n  - key: GITHUB_TOKEN\n    value: repo-token\n  - key: API_URL\n    value: u\n');
    vi.stubEnv('GITHUB_TOKEN', 'repo-token');

    const vars = await buildVarTable(localConfig);

    expect(vars.GITHUB_TOKEN).toBeUndefined();
    expect(vars.API_URL).toBe('u');
  });

  it.each(['BASH_ENV', 'ENV', 'ZDOTDIR', 'HOME', 'PROMPT_COMMAND', 'chpwd_functions', 'precmd_functions', 'preexec_functions', 'periodic_functions', 'zshaddhistory_functions', 'zshexit_functions', 'zsh_directory_name_functions', '__TEAMAI_ENV_FILES', '__teamai_env_apply'])('does not deliver reserved team variable %s to MCP', async (key) => {
    await write('env/env.yaml', `variables:\n  - key: ${key}\n    value: team-value\n`);

    const vars = await buildVarTable(localConfig);

    expect(vars[key]).not.toBe('team-value');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(key));
  });

  // #879: secrets and variable overrides share the team store; an entry is used only as the kind it was set as.
  it('gives a server the env.yaml value of a former secret, never its stored value, and a secret never a variable override', async () => {
    await write('env/env.yaml', 'variables:\n  - key: API_URL\n    value: team-url\n');
    await writeSecretStore(getTeamSecretsPath(localConfig), {
      API_URL: { value: 'fixture-old-secret' },
      GITHUB_TOKEN: { value: 'fixture-override', kind: 'variable' },
    });
    vi.stubEnv('GITHUB_TOKEN', 'exported-token');

    expect((await buildVarTable(localConfig)).API_URL).toBe('team-url');
    await reconcileMcpForConfig(teamConfig, localConfig);
    expect(await githubAuthorization()).toBe('Bearer exported-token');
  });

  it('on Windows, fills ${token} with the value of TOKEN, the same environment variable', () => {
    const def = { name: 'github', transport: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${github_token}' } } as McpServerDef;
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    let resolved: ReturnType<typeof resolvePlaceholders>;
    try {
      resolved = resolvePlaceholders(def, { GITHUB_TOKEN: 'fixture-token' });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
    expect(resolved.missing).toEqual([]);
    expect(resolved.def.headers?.Authorization).toBe('Bearer fixture-token');
    expect(resolvePlaceholders(def, { GITHUB_TOKEN: 'fixture-token' }).missing).toEqual(['github_token']);
  });

  it('on Windows, never lets an inherited value under another case of a team variable\'s name in', async () => {
    await write('env/env.yaml', 'variables:\n  - key: API_URL\n    value: team-url\n');
    vi.stubEnv('api_url', 'exported-url');
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    let vars: Record<string, string>;
    try {
      vars = await buildVarTable(localConfig);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
    expect(vars.API_URL).toBe('team-url');
    expect(Object.hasOwn(vars, 'api_url')).toBe(false);
  });

  // #875 (#879 S9): one order for a variable, member team value > env.yaml,
  // with no environment override and no machine value.
  it("resolves a variable from the member's value for this team, then env.yaml, never the environment", async () => {
    await write('env/env.yaml', 'variables:\n  - key: API_URL\n    value: team-url\n');
    vi.stubEnv('API_URL', 'exported-url');
    vi.stubEnv('UNRELATED_URL', 'exported-unrelated');
    vi.stubEnv('MY_API_URL', undefined);
    await writeSecretStore(getMachineSecretsPath(), { API_URL: { value: 'machine-url' } });

    let vars = await buildVarTable(localConfig);
    expect(vars.API_URL).toBe('team-url');
    expect(vars.UNRELATED_URL).toBe('exported-unrelated');

    await writeSecretStore(getTeamSecretsPath(localConfig), { API_URL: { value: 'member-url', kind: 'variable' } });
    expect((await buildVarTable(localConfig)).API_URL).toBe('member-url');

    await writeSecretStore(getTeamSecretsPath(localConfig), { API_URL: { env: 'MY_API_URL', kind: 'variable' } });
    expect((await buildVarTable(localConfig)).API_URL).toBe('team-url');
    vi.stubEnv('MY_API_URL', 'member-env-url');
    vars = await buildVarTable(localConfig);
    expect(vars.API_URL).toBe('member-env-url');
  });

  // `__proto__` is a valid env key: an ordinary object's inherited setter
  // would swallow it, and a missing one would read as Object.prototype.
  describe('a key named __proto__', () => {
    const protoAuthorization = async (): Promise<string | undefined> => {
      const file = path.join(homeDir, '.claude.json');
      if (!await fse.pathExists(file)) return undefined;
      const config = await fse.readJson(file) as { mcpServers?: Record<string, { headers?: Record<string, string> }> };
      return config.mcpServers?.proto?.headers?.Authorization;
    };
    beforeEach(async () => {
      await write('mcp/mcp.yaml', [
        'servers:',
        '  - name: proto',
        '    transport: http',
        '    url: https://api.example.com/mcp/',
        '    headers:',
        '      Authorization: Bearer ${__proto__}',
      ].join('\n'));
    });

    it('delivers a declared secret named __proto__, and leaves it unresolved when it has no value', async () => {
      await write('env/secrets.yaml', 'secrets:\n  - key: __proto__\n');

      let vars = await buildVarTable(localConfig);
      expect(Object.hasOwn(vars, '__proto__')).toBe(false);
      expect(vars['__proto__']).toBeUndefined();
      await reconcileMcpForConfig(teamConfig, localConfig);
      expect(await protoAuthorization()).toBeUndefined();

      await writeSecretStore(getTeamSecretsPath(localConfig), { ['__proto__']: { value: 'proto-secret' } });
      vars = await buildVarTable(localConfig);
      expect(Object.hasOwn(vars, '__proto__')).toBe(true);
      expect(vars['__proto__']).toBe('proto-secret');
      await reconcileMcpForConfig(teamConfig, localConfig);
      expect(await protoAuthorization()).toBe('Bearer proto-secret');
    });

    it('delivers a variable named __proto__, and leaves it unresolved when nothing sets it', async () => {
      let vars = await buildVarTable(localConfig);
      expect(vars['__proto__']).toBeUndefined();
      await reconcileMcpForConfig(teamConfig, localConfig);
      expect(await protoAuthorization()).toBeUndefined();

      await write('env/env.yaml', 'variables:\n  - key: __proto__\n    value: proto-team\n');
      vars = await buildVarTable(localConfig);
      expect(vars['__proto__']).toBe('proto-team');

      vi.mocked(requireInit).mockResolvedValue({ localConfig, teamConfig });
      vi.mocked(readStdin).mockResolvedValueOnce('proto-member');
      await envSet('__proto__', { stdin: true });
      expect((await buildVarTable(localConfig))['__proto__']).toBe('proto-member');
      await reconcileMcpForConfig(teamConfig, localConfig);
      expect(await protoAuthorization()).toBe('Bearer proto-member');
    });
  });

  it('keeps the variables the last pull wrote when the store cannot be read, without the value', async () => {
    await write('env/env.yaml', 'variables:\n  - key: API_URL\n    value: team-url\n');
    await fse.outputFile(path.join(homeDir, '.teamai', 'env'), 'API_URL=member-url\n');
    await fse.outputFile(getTeamSecretsPath(localConfig), '{"API_URL": {"value": fixture_member_url}}');
    vi.stubEnv('API_URL', 'exported-url');

    expect((await buildVarTable(localConfig)).API_URL).toBe('member-url');
    const warnings = vi.mocked(log.warn).mock.calls.map((call) => String(call[0])).join('\n');
    expect(warnings).toContain(`${getTeamSecretsPath(localConfig)} is not valid JSON`);
    expect(warnings).not.toContain('fixture_member_url');
  });

  it('warns without the value when the store cannot be read, and resolves the secret to nothing', async () => {
    await fse.outputFile(getTeamSecretsPath(localConfig), '{"GITHUB_TOKEN": {"value": ghp_fixture_value}}');
    vi.stubEnv('GITHUB_TOKEN', 'exported-token');

    const vars = await buildVarTable(localConfig);

    expect(vars.GITHUB_TOKEN).toBeUndefined();
    const warnings = vi.mocked(log.warn).mock.calls.map((call) => String(call[0]));
    expect(warnings).toEqual([expect.stringContaining(`${getTeamSecretsPath(localConfig)} is not valid JSON.`)]);
    expect(warnings.join('\n')).not.toContain('ghp_fixture_value');
  });
});
