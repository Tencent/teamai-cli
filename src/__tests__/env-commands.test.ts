import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';
import { execFileSync } from 'node:child_process';

// Mock external dependencies before importing modules
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
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

vi.mock('../utils/prompt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/prompt.js')>()),
  askSecret: vi.fn(),
  readStdin: vi.fn(),
}));

import { envList, envAdd, envRemove, envSet, envUnset } from '../env-commands.js';
import { askSecret, readStdin } from '../utils/prompt.js';
import { getMachineSecretsPath, getTeamSecretsPath, writeSecretStore } from '../secret-store.js';
import { NotInitializedError, detectProjectConfig, requireInit } from '../config.js';
import { resolveAnchors } from '../utils/git.js';
import { projectDataHome } from '../utils/partition.js';
import { resolveSecretDeclarations } from '../resources/secrets.js';
import { log } from '../utils/logger.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import { pullRepo } from '../utils/git.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('env-commands', () => {
  let tmpDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-env-cmd-test-'));
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'env'));

    vi.stubEnv('HOME', path.join(tmpDir, 'home'));

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {},
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    };

    vi.mocked(requireInit).mockResolvedValue({ localConfig, teamConfig });
    vi.mocked(log.info).mockClear();
    vi.mocked(log.success).mockClear();
    vi.mocked(log.error).mockClear();
    vi.mocked(log.dim).mockClear();
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.persist).mockClear();
    resetWarnOnce();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    consoleSpy.mockRestore();
    await fse.remove(tmpDir);
  });

  // ─── envList ─────────────────────────────────────────────

  describe('envList', () => {
    it('should show message when env.yaml does not exist', async () => {
      await envList({});
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('No env variables'));
    });

    it('should show message when env.yaml has no variables', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({ variables: [] }),
      );

      await envList({});
      expect(log.info).toHaveBeenCalledWith('No env variables defined');
    });

    it('should list variables with masked values by default', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [
            { key: 'API_URL', value: 'https://api.example.com', description: 'API endpoint' },
            { key: 'TOKEN', value: 'secret' },
          ],
        }),
      );

      await envList({});

      const allOutput = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('Team env variables (2)');
      // Default: values should be masked
      expect(allOutput).toContain('API_URL=ht****');
      expect(allOutput).toContain('TOKEN=se****');
      expect(allOutput).not.toContain('https://api.example.com');
    });

    it('lists root and active namespace variables, each with where it comes from (#707)', async () => {
      await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'), YAML.stringify({
        version: 1,
        projects: [{ id: 'checkout', resources: { env: ['checkout'] } }, { id: 'billing', resources: { env: ['billing'] } }],
      }));
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({
        variables: [{ key: 'API_BASE', value: 'root-value' }, { key: 'SHARED', value: 's' }],
      }));
      await fse.outputFile(path.join(repoPath, 'env', 'checkout', 'env.yaml'), YAML.stringify({
        variables: [{ key: 'API_BASE', value: 'checkout-value' }, { key: 'CHECKOUT_ONLY', value: 'c' }],
      }));
      await fse.outputFile(path.join(repoPath, 'env', 'billing', 'env.yaml'), YAML.stringify({
        variables: [{ key: 'BILLING_ONLY', value: 'b' }],
      }));
      const { detectProjectConfig } = await import('../config.js');
      vi.mocked(detectProjectConfig).mockResolvedValueOnce({ ...localConfig, projects: ['checkout'] });

      await envList({ reveal: true });

      const allOutput = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('API_BASE=checkout-value  env.yaml  (checkout, overrides root)');
      expect(allOutput).toContain('SHARED=s  env.yaml  (root)');
      expect(allOutput).toContain('CHECKOUT_ONLY=c  env.yaml  (checkout)');
      expect(allOutput).not.toContain('BILLING_ONLY');
    });

    it('should reveal plaintext values when reveal=true', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [
            { key: 'API_URL', value: 'https://api.example.com', description: 'API endpoint' },
            { key: 'TOKEN', value: 'secret' },
          ],
        }),
      );

      await envList({ reveal: true });

      const allOutput = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('Team env variables (2)');
      expect(allOutput).toContain('API_URL=https://api.example.com');
      expect(allOutput).toContain('TOKEN=secret');
    });

    it('should show descriptions in verbose mode', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [
            { key: 'API_URL', value: 'https://api.example.com', description: 'My API endpoint' },
          ],
        }),
      );

      await envList({ verbose: true });

      expect(log.dim).toHaveBeenCalledWith(expect.stringContaining('My API endpoint'));
    });

    // #875: a declared secret is listed with where its value comes from, never the value.
    it('lists each declared secret with its state and never its value, --reveal included', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'API_URL', value: 'u' }] }));
      await fse.writeFile(path.join(repoPath, 'env', 'secrets.yaml'), YAML.stringify({
        secrets: [
          { key: 'GITHUB_TOKEN', description: 'GitHub token', url: 'https://github.com/settings/tokens' },
          { key: 'GITLAB_TOKEN' },
        ],
      }));
      vi.stubEnv('GITHUB_TOKEN', 'fixture-github-value');
      vi.stubEnv('GITLAB_TOKEN', '');

      await envList({ reveal: true, verbose: true });

      const allOutput = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('API_URL=u  env.yaml  (root)');
      expect(allOutput).toContain('Team secrets (2):');
      expect(allOutput).toContain('GITHUB_TOKEN  environment  (root)');
      expect(allOutput).toContain('GITLAB_TOKEN  missing  (root)');
      expect(allOutput).not.toContain('fixture-github-value');
      expect(vi.mocked(log.dim).mock.calls.map(c => c[0])).toEqual(expect.arrayContaining([
        expect.stringContaining('GitHub token'),
        expect.stringContaining('https://github.com/settings/tokens'),
      ]));
    });

    it('lists declared secrets when the team has no env variables', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: GITHUB_TOKEN\n');
      vi.stubEnv('GITHUB_TOKEN', '');

      await envList({});

      const allOutput = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('GITHUB_TOKEN  missing  (root)');
      expect(allOutput).not.toContain('Team env variables');
      expect(log.info).not.toHaveBeenCalledWith('No env variables defined');
    });

    // #879 Conflict 14: while the declarations fail, any variable may be a
    // secret whose repo value is ignored, so no value is shown, --reveal included.
    it('still lists the variables when the secrets file is broken, without their values, and says so in secret wording', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'API_URL', value: 'fixture-url' }] }));
      await fse.writeFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets: [\n');

      await envList({ reveal: true });

      const allOutput = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('API_URL  (root)');
      expect(allOutput).not.toContain('fixture-url');
      expect(log.error).toHaveBeenCalledWith(expect.stringMatching(
        /^env\/secrets\.yaml is not valid YAML: .*Team secrets were not resolved this run; env variables and MCP servers stay as they are\./s,
      ));
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    });
  });

  // ─── envSet / envUnset (#875) ────────────────────────────

  describe('envSet / envUnset', () => {
    const logged = (): string => [log.info, log.success, log.warn, log.error, log.dim]
      .flatMap((fn) => vi.mocked(fn).mock.calls.map((c) => String(c[0])))
      .concat(consoleSpy.mock.calls.map((c) => String(c[0])))
      .join('\n');
    const storeFile = (): string => getTeamSecretsPath(localConfig);
    const stored = async (): Promise<unknown> => fse.readJson(storeFile());

    beforeEach(async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: GITHUB_TOKEN\n  - key: GITLAB_TOKEN\n');
      vi.mocked(log.warn).mockClear();
      vi.mocked(askSecret).mockReset();
      vi.mocked(readStdin).mockReset();
      vi.stubEnv('GITHUB_TOKEN', '');
      process.exitCode = undefined;
    });
    afterEach(() => {
      process.exitCode = undefined;
    });

    it('keeps a value piped on stdin for this team, 0600, and never prints it', async () => {
      vi.mocked(readStdin).mockResolvedValue('fixture-token-value');

      await envSet('GITHUB_TOKEN', { stdin: true });

      expect(await stored()).toEqual({ GITHUB_TOKEN: { value: 'fixture-token-value', kind: 'secret' } });
      expect(storeFile().startsWith(path.join(tmpDir, 'home', '.teamai', 'secrets', 'teams') + path.sep)).toBe(true);
      if (process.platform !== 'win32') expect((await fse.stat(storeFile())).mode & 0o777).toBe(0o600);
      await envList({ reveal: true });
      expect(logged()).toContain('GITHUB_TOKEN  team  (root)');
      expect(logged()).not.toContain('fixture-token-value');
      expect(process.exitCode).toBeUndefined();
    });

    it.each(['BASH_ENV', 'ENV', 'ZDOTDIR', 'HOME', 'home', 'PROMPT_COMMAND', 'chpwd_functions', 'precmd_functions', 'preexec_functions', 'periodic_functions', 'zshaddhistory_functions', 'zshexit_functions', 'zsh_directory_name_functions', '__TEAMAI_ENV_FILES', '__teamai_env_apply'])('warns when env set targets reserved loader control %s', async (key) => {
      await fse.writeFile(path.join(repoPath, 'env', 'secrets.yaml'), `secrets:\n  - key: ${key}\n`);
      vi.mocked(readStdin).mockResolvedValue('reserved-value');

      await envSet(key, { stdin: true });

      expect(log.warn).toHaveBeenCalledWith(`${key} is reserved for TeamAI shell routing; those team env values are ignored.`);
      expect(process.exitCode).toBeUndefined();
    });

    it('reads the value from the hidden prompt without a flag', async () => {
      vi.mocked(askSecret).mockResolvedValue('fixture-prompt-value');

      await envSet('GITHUB_TOKEN', {});

      expect(askSecret).toHaveBeenCalledWith('Value for GITHUB_TOKEN: ');
      expect(await stored()).toEqual({ GITHUB_TOKEN: { value: 'fixture-prompt-value', kind: 'secret' } });
    });

    it('says how to pass a value when there is no terminal to prompt on', async () => {
      vi.mocked(askSecret).mockRejectedValue(new Error('Cannot prompt for a secret in non-interactive mode'));

      await envSet('GITHUB_TOKEN', {});

      expect(log.error).toHaveBeenCalledWith(
        'Cannot prompt for GITHUB_TOKEN without a terminal. Pipe the value with --stdin, or pass --from-env <VAR>. Nothing was changed.',
      );
      expect(process.exitCode).toBe(1);
      expect(await fse.pathExists(storeFile())).toBe(false);
    });

    it('refuses --stdin from a terminal', async () => {
      const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      try {
        await envSet('GITHUB_TOKEN', { stdin: true });
      } finally {
        if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
        else delete (process.stdin as { isTTY?: boolean }).isTTY;
      }

      expect(readStdin).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('--stdin expects piped stdin'));
      expect(process.exitCode).toBe(1);
    });

    it('stores a --from-env reference, not a copy, and warns when that variable is unset', async () => {
      vi.stubEnv('WORK_GITHUB_TOKEN', '');

      await envSet('GITHUB_TOKEN', { fromEnv: 'WORK_GITHUB_TOKEN' });

      expect(await stored()).toEqual({ GITHUB_TOKEN: { env: 'WORK_GITHUB_TOKEN', kind: 'secret' } });
      expect(log.warn).toHaveBeenCalledWith('WORK_GITHUB_TOKEN is not set in this shell; GITHUB_TOKEN has no value until it is.');
    });

    it('accepts only a key the scope declares as a secret or receives as a variable', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'API_URL', value: 'u' }] }));
      vi.mocked(readStdin).mockResolvedValue('fixture-token-value');

      await envSet('OTHER_URL', { stdin: true });

      expect(log.error).toHaveBeenCalledWith(
        "OTHER_URL is neither a secret nor an env variable this directory's team declares, so it was not set. "
          + 'Its secrets: GITHUB_TOKEN, GITLAB_TOKEN. Its variables: API_URL. If the team added it recently, run `teamai pull` first.',
      );
      expect(process.exitCode).toBe(1);
      expect(readStdin).not.toHaveBeenCalled();
      expect(await fse.pathExists(storeFile())).toBe(false);
    });

    // #875 (#879 S9): a member overrides a variable for this team.
    it('keeps a value for an env variable the scope receives, for this team', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'API_URL', value: 'u' }] }));
      vi.mocked(readStdin).mockResolvedValue('https://mine.example');

      await envSet('API_URL', { stdin: true });

      expect(await stored()).toEqual({ API_URL: { value: 'https://mine.example', kind: 'variable' } });
      expect(log.info).toHaveBeenCalledWith('Run `teamai pull` to update MCP servers and env.sh.');
      expect(process.exitCode).toBeUndefined();
    });

    it('on Windows, sets and unsets a key under the name the team declares it by, in any case', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'API_URL', value: 'u' }] }));
      vi.mocked(readStdin).mockResolvedValue('fixture-token-value');
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        await envSet('github_token', { stdin: true });
        await envSet('api_url', { stdin: true });
        expect(await stored()).toEqual({
          GITHUB_TOKEN: { value: 'fixture-token-value', kind: 'secret' },
          API_URL: { value: 'fixture-token-value', kind: 'variable' },
        });

        await envUnset('github_token', {});
        await envUnset('Api_Url', {});
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      }
      expect(await stored()).toEqual({});
      expect(process.exitCode).toBeUndefined();
    });

    it('on Windows, replaces and removes every stored entry under another case of the key', async () => {
      await writeSecretStore(storeFile(), { github_token: { value: 'fixture-old', kind: 'secret' }, Github_Token: { value: 'fixture-older', kind: 'secret' } });
      vi.mocked(readStdin).mockResolvedValue('fixture-new');
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        await envSet('GITHUB_TOKEN', { stdin: true });
        expect(await stored()).toEqual({ GITHUB_TOKEN: { value: 'fixture-new', kind: 'secret' } });

        await writeSecretStore(storeFile(), { GITHUB_TOKEN: { value: 'fixture-new', kind: 'secret' }, github_token: { value: 'fixture-old', kind: 'secret' } });
        await envUnset('GITHUB_TOKEN', {});
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      }
      expect(await stored()).toEqual({});
    });

    it('says env.sh needs a pull too after unsetting a value for an env variable, and not for a secret', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'API_URL', value: 'u' }] }));
      await writeSecretStore(storeFile(), { API_URL: { value: 'https://mine.example', kind: 'variable' }, GITHUB_TOKEN: { env: 'WORK_GITHUB_TOKEN' } });

      await envUnset('API_URL', {});
      expect(log.info).toHaveBeenLastCalledWith('Run `teamai pull` to update MCP servers and env.sh.');

      await envUnset('GITHUB_TOKEN', {});
      expect(log.info).toHaveBeenLastCalledWith('Run `teamai pull` to update MCP servers.');
      expect(await stored()).toEqual({});
    });

    it("refuses to set a key it cannot tell is a variable when env.yaml can't be read", async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), 'variables: [\n');

      await envSet('API_URL', { fromEnv: 'MY_API_URL' });

      expect(log.error).toHaveBeenCalledWith('Cannot tell whether API_URL is an env variable this team sets. Nothing was changed.');
      expect(process.exitCode).toBe(1);
      expect(await fse.pathExists(storeFile())).toBe(false);
    });

    it('refuses to set anything when the declarations cannot be read', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets: [\n');

      await envSet('GITHUB_TOKEN', { fromEnv: 'WORK_GITHUB_TOKEN' });

      expect(log.error).toHaveBeenCalledWith('Cannot tell whether GITHUB_TOKEN is a secret this team declares. Nothing was changed.');
      expect(process.exitCode).toBe(1);
      expect(await fse.pathExists(storeFile())).toBe(false);
    });

    it('lets an unexpected failure reading stdin through, rather than report it as a user error', async () => {
      vi.mocked(readStdin).mockRejectedValue(new Error('EIO: i/o error, read'));

      await expect(envSet('GITHUB_TOKEN', { stdin: true })).rejects.toThrow('EIO: i/o error, read');
      expect(await fse.pathExists(storeFile())).toBe(false);
    });

    it('rejects --stdin with --from-env, and an invalid key', async () => {
      await envSet('GITHUB_TOKEN', { stdin: true, fromEnv: 'X' });
      await envSet('bad key', { fromEnv: 'X' });

      expect(vi.mocked(log.error).mock.calls.map((c) => c[0])).toEqual([
        'Pass either --stdin or --from-env, not both. Nothing was changed.',
        expect.stringContaining('Invalid env variable name "bad key"'),
      ]);
      expect(await fse.pathExists(storeFile())).toBe(false);
    });

    it('leaves a store it cannot read as it is, and names it without its content', async () => {
      const corrupt = '{"GITLAB_TOKEN": {"value": ghp_fixture_value}}';
      await fse.outputFile(storeFile(), corrupt);

      await envSet('GITHUB_TOKEN', { fromEnv: 'WORK_GITHUB_TOKEN' });
      await envUnset('GITLAB_TOKEN', {});

      expect(await fse.readFile(storeFile(), 'utf8')).toBe(corrupt);
      expect(vi.mocked(log.error).mock.calls.map((c) => c[0])).toEqual([
        expect.stringContaining(`${storeFile()} is not valid JSON.`),
        expect.stringContaining(`${storeFile()} is not valid JSON.`),
      ]);
      expect(logged()).not.toContain('ghp_fixture_value');
    });

    it('does not write on --dry-run, nor take the store lock', async () => {
      await envSet('GITHUB_TOKEN', { fromEnv: 'WORK_GITHUB_TOKEN', dryRun: true });
      expect(await fse.pathExists(path.dirname(storeFile()))).toBe(false);
    });

    it.each([
      ['the hidden prompt', {}],
      ['--stdin', { stdin: true }],
    ])('previews a --dry-run set without reading a value from %s', async (_source, flags) => {
      vi.mocked(askSecret).mockRejectedValue(new Error('Cannot prompt for a secret in non-interactive mode'));
      vi.mocked(readStdin).mockRejectedValue(new Error('stdin was read'));

      await envSet('GITHUB_TOKEN', { ...flags, dryRun: true });

      expect(askSecret).not.toHaveBeenCalled();
      expect(readStdin).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(`[dry-run] Would set GITHUB_TOKEN for this team in ${storeFile()}`);
      expect(process.exitCode).toBeUndefined();
      expect(await fse.pathExists(path.dirname(storeFile()))).toBe(false);
    });

    it('keeps every change when env set and env unset run at the same time', async () => {
      await writeSecretStore(storeFile(), { OLD_TOKEN: { env: 'OLD' } });
      await fse.writeFile(
        path.join(repoPath, 'env', 'secrets.yaml'),
        'secrets:\n  - key: GITHUB_TOKEN\n  - key: GITLAB_TOKEN\n  - key: OLD_TOKEN\n',
      );

      await Promise.all([
        envSet('GITHUB_TOKEN', { fromEnv: 'WORK_GITHUB_TOKEN' }),
        envSet('GITLAB_TOKEN', { fromEnv: 'WORK_GITLAB_TOKEN' }),
        envUnset('OLD_TOKEN', {}),
      ]);

      expect(await stored()).toEqual({
        GITHUB_TOKEN: { env: 'WORK_GITHUB_TOKEN', kind: 'secret' }, GITLAB_TOKEN: { env: 'WORK_GITLAB_TOKEN', kind: 'secret' },
      });
      expect(await fse.pathExists(`${storeFile()}.lock`)).toBe(false);
      expect(process.exitCode).toBeUndefined();
    });

    it('unset removes the team value and keeps the others', async () => {
      vi.mocked(readStdin).mockResolvedValue('fixture-token-value');
      await envSet('GITHUB_TOKEN', { stdin: true });
      await envSet('GITLAB_TOKEN', { fromEnv: 'WORK_GITLAB_TOKEN' });

      await envUnset('GITHUB_TOKEN', {});
      await envUnset('GITHUB_TOKEN', {});

      expect(await stored()).toEqual({ GITLAB_TOKEN: { env: 'WORK_GITLAB_TOKEN', kind: 'secret' } });
      expect(log.info).toHaveBeenCalledWith('GITHUB_TOKEN has no value for this team. Nothing was changed.');
      expect(process.exitCode).toBeUndefined();
    });

    // #875: one value for every team on the machine.
    it('--global keeps the value in machine.json, and env list shows it as global until a team value wins', async () => {
      vi.mocked(readStdin).mockResolvedValue('fixture-machine-value');

      await envSet('GITHUB_TOKEN', { stdin: true, global: true });

      const machineFile = path.join(tmpDir, 'home', '.teamai', 'secrets', 'machine.json');
      expect(getMachineSecretsPath()).toBe(machineFile);
      expect(await fse.readJson(machineFile)).toEqual({ GITHUB_TOKEN: { value: 'fixture-machine-value', kind: 'secret' } });
      if (process.platform !== 'win32') expect((await fse.stat(machineFile)).mode & 0o777).toBe(0o600);
      expect(await fse.pathExists(storeFile())).toBe(false);
      expect(log.success).toHaveBeenCalledWith(`Set GITHUB_TOKEN as your global value (every team on this machine) (${machineFile}).`);

      await envList({ reveal: true });
      expect(logged()).toContain('GITHUB_TOKEN  global  (root)');

      await envSet('GITHUB_TOKEN', { fromEnv: 'WORK_GITHUB_TOKEN' });
      vi.stubEnv('WORK_GITHUB_TOKEN', 'fixture-work-value');
      consoleSpy.mockClear();
      await envList({ reveal: true });
      expect(logged()).toContain('GITHUB_TOKEN  team  (root)');
      expect(logged()).not.toContain('fixture-machine-value');
      expect(logged()).not.toContain('fixture-work-value');
      expect(process.exitCode).toBeUndefined();
    });

    it('--global in a scope still accepts only a key the scope declares as a secret', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'API_URL', value: 'u' }] }));

      await envSet('API_URL', { fromEnv: 'MY_API_URL', global: true });

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining("API_URL is not a secret this directory's team declares, so it was not set."));
      expect(process.exitCode).toBe(1);
      expect(await fse.pathExists(getMachineSecretsPath())).toBe(false);
    });

    it('--global outside any scope accepts any valid key and notes that no team declares it yet', async () => {
      vi.mocked(requireInit).mockRejectedValue(new NotInitializedError('teamai is not initialized. Run `teamai init` first.'));

      await envSet('SENTRY_AUTH_TOKEN', { fromEnv: 'MY_SENTRY_TOKEN', global: true });

      expect(await fse.readJson(getMachineSecretsPath())).toEqual({ SENTRY_AUTH_TOKEN: { env: 'MY_SENTRY_TOKEN', kind: 'secret' } });
      expect(log.info).toHaveBeenCalledWith(
        'No teamai scope here, so no team declares SENTRY_AUTH_TOKEN yet. The value applies to every team on this machine that declares it.',
      );
      expect(process.exitCode).toBeUndefined();

      await envUnset('SENTRY_AUTH_TOKEN', { global: true });
      expect(await fse.readJson(getMachineSecretsPath())).toEqual({});
    });

    it.each([
      ['env set', () => envSet('GITHUB_TOKEN', { fromEnv: 'X' })],
      ['env unset', () => envUnset('GITHUB_TOKEN', {})],
      ['env list', () => envList({})],
      ['env add', () => envAdd('API_URL', 'u', {})],
      ['env remove', () => envRemove('API_URL', {})],
    ])('%s outside any scope says it is not initialized and exits 1, without a stack trace', async (_name, run) => {
      vi.mocked(requireInit).mockRejectedValue(new NotInitializedError('teamai is not initialized. Run `teamai init` first.'));

      await run();

      expect(log.error).toHaveBeenCalledWith('teamai is not initialized. Run `teamai init` first.');
      expect(process.exitCode).toBe(1);
    });

    it('unset does not call a key a variable when the declarations can\'t be read', async () => {
      await envSet('GITHUB_TOKEN', { fromEnv: 'WORK_GITHUB_TOKEN' });
      await fse.writeFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets: [\n');
      vi.mocked(log.info).mockClear();

      await envUnset('GITHUB_TOKEN', {});

      expect(log.info).toHaveBeenCalledWith('Run `teamai pull` to apply it.');
      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('env.sh'));
    });

    it('refuses set, unset and list in a project whose config cannot be read, and writes no store for any team', async () => {
      const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
      vi.mocked(detectProjectConfig).mockImplementation(actual.detectProjectConfig);
      const root = path.join(tmpDir, 'api');
      await fse.ensureDir(root);
      execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
      const anchors = await resolveAnchors(root);
      if (!anchors) throw new Error('no git anchors for the fixture project');
      const configPath = path.join(projectDataHome(anchors.projectAnchor), 'config.yaml');
      await fse.outputFile(configPath, 'repo: [not a config\n');
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      vi.mocked(readStdin).mockResolvedValue('fixture-work-token');

      try {
        await envSet('GITHUB_TOKEN', { stdin: true });
        await envUnset('GITHUB_TOKEN', {});
        await envList({});
      } finally {
        vi.mocked(process.cwd).mockRestore();
        vi.mocked(detectProjectConfig).mockResolvedValue(null);
      }

      expect(await fse.pathExists(path.join(tmpDir, 'home', '.teamai', 'secrets'))).toBe(false);
      expect(vi.mocked(log.error).mock.calls.map((c) => c[0])).toEqual([
        expect.stringMatching(/^Cannot tell which team this directory belongs to: .*config\.yaml/),
        expect.stringMatching(/^Cannot tell which team this directory belongs to: .*config\.yaml/),
        expect.stringMatching(/^Cannot tell which team this directory belongs to: .*config\.yaml/),
      ]);
      expect(String(vi.mocked(log.error).mock.calls[0][0])).toContain(configPath);
      expect(logged()).not.toContain('fixture-work-token');
      expect(process.exitCode).toBe(1);
    });

    it('unset --global removes only the machine value', async () => {
      await envSet('GITHUB_TOKEN', { fromEnv: 'WORK_GITHUB_TOKEN' });
      await envSet('GITHUB_TOKEN', { fromEnv: 'PERSONAL_GITHUB_TOKEN', global: true });
      await envSet('GITLAB_TOKEN', { fromEnv: 'PERSONAL_GITLAB_TOKEN', global: true });

      await envUnset('GITHUB_TOKEN', { global: true });
      await envUnset('GITHUB_TOKEN', { global: true });

      expect(await fse.readJson(getMachineSecretsPath())).toEqual({ GITLAB_TOKEN: { env: 'PERSONAL_GITLAB_TOKEN', kind: 'secret' } });
      expect(await stored()).toEqual({ GITHUB_TOKEN: { env: 'WORK_GITHUB_TOKEN', kind: 'secret' } });
      expect(log.success).toHaveBeenCalledWith(`Removed GITHUB_TOKEN's global value (every team on this machine) (${getMachineSecretsPath()}).`);
      expect(log.info).toHaveBeenCalledWith('GITHUB_TOKEN has no global value (every team on this machine). Nothing was changed.');
    });

    it('env list shows the member\'s value of an overridden variable, as team, and the team\'s value otherwise', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({
        variables: [{ key: 'GITLAB_HOST', value: 'gitlab.team.example' }, { key: 'API_URL', value: 'u' }],
      }));
      vi.mocked(readStdin).mockResolvedValue('gitlab.dave.example');
      await envSet('GITLAB_HOST', { stdin: true });
      consoleSpy.mockClear();

      await envList({ reveal: true });

      expect(logged()).toContain('GITLAB_HOST=gitlab.dave.example  team  (root)');
      expect(logged()).toContain('API_URL=u  env.yaml  (root)');
      expect(logged()).not.toContain('gitlab.team.example');
    });

    // #879: a value keeps the kind it was set as, so a former secret's value never becomes a variable override.
    it('env list says a value set while the key was a secret is not used for the variable it is now, and how to fix it', async () => {
      vi.mocked(readStdin).mockResolvedValue('fixture-old-secret');
      await envSet('GITLAB_TOKEN', { stdin: true });
      await fse.writeFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: GITHUB_TOKEN\n');
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'GITLAB_TOKEN', value: 'team-gitlab' }] }));
      consoleSpy.mockClear();

      await envList({ reveal: true });

      expect(logged()).toContain('GITLAB_TOKEN=team-gitlab  env.yaml  (root)');
      expect(logged()).toContain(
        '    Your value for this team was set while GITLAB_TOKEN was a secret, so it is not used. '
          + 'Run `teamai env unset GITLAB_TOKEN` to remove it, then `teamai env set GITLAB_TOKEN` to set one for the env variable.',
      );
      expect(logged()).not.toContain('fixture-old-secret');
      expect(process.exitCode).toBeUndefined();
    });

    it('env list says a variable override is not used for the secret the key is now', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'API_URL', value: 'u' }] }));
      vi.mocked(readStdin).mockResolvedValue('https://mine.example');
      await envSet('API_URL', { stdin: true });
      await fse.writeFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: API_URL\n');
      consoleSpy.mockClear();

      await envList({ reveal: true });

      expect(logged()).toContain('API_URL  missing  (root)');
      expect(logged()).toContain(
        '    Your value for this team was set while API_URL was an env variable, so it is not used. '
          + 'Run `teamai env unset API_URL` to remove it, then `teamai env set API_URL` to set one for the secret.',
      );
    });

    it('env list shows unreadable, not missing, while the member\'s values file can\'t be read, and exits 1', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'API_URL', value: 'u' }] }));
      await fse.outputFile(storeFile(), '{ "GITHUB_TOKEN": { "value": ghp_fixture_value } }');

      await envList({ reveal: true });

      expect(logged()).toContain('GITHUB_TOKEN  unreadable  (root)');
      expect(logged()).toContain('API_URL  unreadable  (root)');
      expect(logged()).toContain(`${storeFile()} is not valid JSON`);
      expect(logged()).not.toContain('ghp_fixture_value');
      expect(logged()).not.toContain('GITHUB_TOKEN is not set');
      expect(process.exitCode).toBe(1);
    });

    // #879 Conflict 13: a key declared twice is listed only as a secret.
    it('env list --reveal leaves out the env.yaml value of a key declared as a secret', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({
        variables: [{ key: 'GITHUB_TOKEN', value: 'fixture-repo-value' }, { key: 'API_URL', value: 'u' }],
      }));

      await envList({ reveal: true });

      expect(logged()).toContain('Team env variables (1):');
      expect(logged()).toContain('API_URL=u  env.yaml  (root)');
      expect(logged()).toContain('GITHUB_TOKEN  missing  (root)');
      expect(logged()).not.toContain('fixture-repo-value');
    });

    it('names the variable an unknown key takes out of the delivered set (#822)', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [
            { key: 'GOOD_URL', value: 'https://good.example' },
            { key: 'CACHE_TTL', value: '60', role: ['frontend'] },
          ],
        }),
      );

      await envList({});

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('env/env.yaml: variable "CACHE_TTL" has unknown key `role:`, so this entry is not delivered.'));
      const allOutput = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('GOOD_URL');
      expect(allOutput).not.toContain('CACHE_TTL');
    });

    it('names the variable a removed per-entry key takes out of the delivered set (#822)', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [
            { key: 'DB_URL', value: 'postgres://db', roles: ['legacy'] },
          ],
        }),
      );

      await envList({});

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('env/env.yaml: variable "DB_URL" is scoped with per-entry `roles:`, which this version no longer reads, so it reaches nobody.'));
    });
  });

  // ─── envAdd ──────────────────────────────────────────────

  describe('envAdd', () => {
    it('refuses a key that would not survive the round trip into env.sh', async () => {
      // `generateEnvFile` drops any key that is not a shell identifier, so
      // accepting one here would write a variable that never reaches the
      // member's shell — and `FOO;cmd` would run `cmd` there if it did. Better
      // to reject it at the point the user can still see the mistake.
      await envAdd('bad key', 'v', {});

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('bad key'));
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      // Nothing written, and no env.yaml is created just to hold nothing.
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      expect(await fse.pathExists(envYamlPath)).toBe(false);
      expect(log.success).not.toHaveBeenCalled();
    });

    it('should add a new variable locally and show push hint', async () => {
      await envAdd('NEW_VAR', 'new_value', {});

      // Verify env.yaml was written
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      const content = await fse.readFile(envYamlPath, 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables).toHaveLength(1);
      expect(parsed.variables[0]).toEqual({ key: 'NEW_VAR', value: 'new_value' });

      // Verify success message and push hint
      expect(log.success).toHaveBeenCalledWith('Added env variable: NEW_VAR=new_value');
      expect(log.info).toHaveBeenCalledWith('Run `teamai push` to sync to team repo.');
    });

    it('should add variable with description', async () => {
      await envAdd('MY_VAR', 'val', { description: 'A test variable' });

      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      const content = await fse.readFile(envYamlPath, 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables[0]).toEqual({
        key: 'MY_VAR',
        value: 'val',
        description: 'A test variable',
      });
    });

    it('should update existing variable locally and show push hint', async () => {
      // Pre-populate env.yaml
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [{ key: 'EXIST_VAR', value: 'old_value' }],
        }),
      );

      await envAdd('EXIST_VAR', 'new_value', {});

      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      const content = await fse.readFile(envYamlPath, 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables).toHaveLength(1);
      expect(parsed.variables[0].value).toBe('new_value');

      // Verify success message uses "Updated"
      expect(log.success).toHaveBeenCalledWith('Updated env variable: EXIST_VAR=new_value');
      expect(log.info).toHaveBeenCalledWith('Run `teamai push` to sync to team repo.');
    });

    it('preserves the roles and projects of a variable it updates', async () => {
      // `roles:`/`projects:` are hand-edited in env.yaml — `env add` has no flag
      // for them — so updating a scoped variable's value must not silently
      // unscope it and ship it to the whole team.
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [{ key: 'CHECKOUT_URL', value: 'old', roles: ['frontend'], projects: ['checkout'] }],
        }),
      );

      await envAdd('CHECKOUT_URL', 'new', {});

      const parsed = YAML.parse(await fse.readFile(path.join(repoPath, 'env', 'env.yaml'), 'utf-8'));
      expect(parsed.variables[0]).toEqual({
        key: 'CHECKOUT_URL',
        value: 'new',
        roles: ['frontend'],
        projects: ['checkout'],
      });
    });

    it('says an updated variable it cannot deliver is undelivered, naming the namespace file to move it to (#822)', async () => {
      // `roles:` on env is no longer read, so this update reaches nobody —
      // "Updated" alone would read as success.
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [{ key: 'DB_URL', value: 'old', roles: ['legacy'] }],
        }),
      );

      await envAdd('DB_URL', 'new', {});

      // The remedy has to name the namespace file, as pull's notice does:
      // dropping the key in env/env.yaml would deliver the secret to everyone.
      // No role or project declares `legacy`, so the notice says which
      // declaration makes env/legacy/env.yaml reach it.
      expect(log.warn).toHaveBeenCalledWith(
        'env/env.yaml: variable "DB_URL" is scoped with per-entry `roles:`, which this version no longer reads, '
          + 'so pull does not deliver it. Move it to env/legacy/env.yaml (declare env: [legacy] for role legacy '
          + 'in manifest/roles.yaml) and drop the key.',
      );
      expect(log.success).toHaveBeenCalledWith('Updated env variable: DB_URL=new');
    });

    // A role that declares the namespace names the file alone, as pull does.
    it('names the declared namespace file an updated variable belongs in (#822)', async () => {
      await fse.outputFile(path.join(repoPath, 'manifest', 'roles.yaml'), YAML.stringify({
        version: 1,
        roles: [{ id: 'legacy', description: '', resources: { knowledge: [], skills: [], env: ['legacy'] } }],
      }));
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [{ key: 'DB_URL', value: 'old', roles: ['legacy'] }],
        }),
      );

      await envAdd('DB_URL', 'new', {});

      expect(log.warn).toHaveBeenCalledWith(
        'env/env.yaml: variable "DB_URL" is scoped with per-entry `roles:`, which this version no longer reads, '
          + 'so pull does not deliver it. Move it to env/legacy/env.yaml and drop the key.',
      );
      expect(log.success).toHaveBeenCalledWith('Updated env variable: DB_URL=new');
    });

    // The same guidance pull gives when no role or project declares the id:
    // the namespace file the entry belongs in, with the declaration to add.
    it('names the namespace file to declare when no role declares the removed key\'s id (#822)', async () => {      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [{ key: 'DB_URL', value: 'old', projects: ['checkout'], roles: ['legacy'] }],
        }),
      );

      await envAdd('DB_URL', 'new', {});

      expect(log.warn).toHaveBeenCalledWith(
        'env/env.yaml: variable "DB_URL" is scoped with per-entry `projects:` and `roles:`, which this version '
          + 'no longer reads, so pull does not deliver it. Copy it into each of env/checkout/env.yaml (declare env: '
          + '[checkout] for project checkout in manifest/projects.yaml), env/legacy/env.yaml (declare env: [legacy] '
          + 'for role legacy in manifest/roles.yaml) and drop the key.',
      );
    });

    // A variable with a misspelled `roles:` reaches nobody (#822); a rewrite
    // that drops the key would deliver it to the whole team.
    it('preserves a key env does not know on a variable it updates', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({ variables: [{ key: 'DB_URL', value: 'old', role: ['frontend'] }] }),
      );

      await envAdd('DB_URL', 'new', {});

      const parsed = YAML.parse(await fse.readFile(path.join(repoPath, 'env', 'env.yaml'), 'utf-8'));
      expect(parsed.variables).toEqual([{ key: 'DB_URL', value: 'new', role: ['frontend'] }]);
      expect(log.warn).toHaveBeenCalledWith(
        'env/env.yaml: variable "DB_URL" has unknown key `role:`, so pull does not deliver it. '
          + 'Correct the key or remove it in env/env.yaml.',
      );
    });

    it('preserves the scope of other variables when adding a new one', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [{ key: 'CHECKOUT_URL', value: 'c', projects: ['checkout'] }],
        }),
      );

      await envAdd('SHARED', 's', {});

      const parsed = YAML.parse(await fse.readFile(path.join(repoPath, 'env', 'env.yaml'), 'utf-8'));
      expect(parsed.variables).toEqual([
        { key: 'CHECKOUT_URL', value: 'c', projects: ['checkout'] },
        { key: 'SHARED', value: 's' },
      ]);
    });

    it('should not write in dry-run mode', async () => {
      await envAdd('DRY_VAR', 'dry_value', { dryRun: true });

      // env.yaml should NOT exist
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      expect(await fse.pathExists(envYamlPath)).toBe(false);

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
    });
  });

  // ─── envRemove ───────────────────────────────────────────

  describe('--role / --project (#707)', () => {
    async function writeProjects(): Promise<void> {
      await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'), YAML.stringify({
        version: 1,
        projects: [
          { id: 'checkout', resources: { env: ['checkout-env'] } },
          { id: 'billing', resources: { skills: ['billing'] } },
        ],
      }));
    }
    const nsFile = (ns: string) => path.join(repoPath, 'env', ns, 'env.yaml');

    it('env add --role writes env/<ns>/env.yaml and leaves the root file alone', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'API_BASE', value: 'root' }] }));

      await envAdd('API_BASE', 'checkout', { role: 'checkout' });

      expect(YAML.parse(await fse.readFile(nsFile('checkout'), 'utf-8')).variables).toEqual([{ key: 'API_BASE', value: 'checkout' }]);
      expect(YAML.parse(await fse.readFile(path.join(repoPath, 'env', 'env.yaml'), 'utf-8')).variables)
        .toEqual([{ key: 'API_BASE', value: 'root' }]);
      expect(log.success).toHaveBeenCalledWith('Added env variable in env/checkout/env.yaml: API_BASE=checkout');
    });

    // A namespace file nobody declares reaches nobody, and doctor cannot tell.
    it('env add --role warns when no role or project declares the namespace, and still writes', async () => {
      await writeProjects();

      await envAdd('API_BASE', 'x', { role: 'checkout' });

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(
        'No role or project declares env namespace "checkout", so env/checkout/env.yaml reaches nobody',
      ));
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('manifest/roles.yaml'));
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('manifest/projects.yaml'));
      expect(await fse.pathExists(nsFile('checkout'))).toBe(true);
    });

    it('env add --role says nothing more when a project declares the namespace', async () => {
      await writeProjects();
      vi.mocked(log.warn).mockClear();

      await envAdd('API_BASE', 'x', { role: 'checkout-env' });

      expect(log.warn).not.toHaveBeenCalled();
    });

    it("env add --project writes the project's declared env namespace", async () => {
      await writeProjects();

      await envAdd('API_BASE', 'x', { project: 'checkout' });

      expect(YAML.parse(await fse.readFile(nsFile('checkout-env'), 'utf-8')).variables).toEqual([{ key: 'API_BASE', value: 'x' }]);
    });

    // Pull reads a declared namespace from its directory case-folded. A write
    // into a new exact-case directory would shadow that one on a
    // case-sensitive filesystem, and its variables would stop being delivered.
    it('env add --project writes into the existing directory whose name differs only in case', async () => {
      await writeProjects();
      await fse.outputFile(nsFile('Checkout-Env'), YAML.stringify({ variables: [{ key: 'DB_URL', value: 'db' }] }));

      await envAdd('API_BASE', 'x', { project: 'checkout' });

      expect(log.success).toHaveBeenCalledWith('Added env variable in env/Checkout-Env/env.yaml: API_BASE=x');
      expect(YAML.parse(await fse.readFile(nsFile('Checkout-Env'), 'utf-8')).variables)
        .toEqual([{ key: 'DB_URL', value: 'db' }, { key: 'API_BASE', value: 'x' }]);
    });

    // --project resolves through manifest/projects.yaml: a stale copy may name
    // a namespace the project no longer uses, and push would publish that file.
    it('env add --project changes nothing when the team repo cannot be refreshed', async () => {
      await writeProjects();
      vi.mocked(pullRepo).mockRejectedValueOnce(new Error('network down'));

      await envAdd('API_BASE', 'x', { project: 'checkout' });

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('network down'));
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Nothing was changed'));
      expect(await fse.pathExists(nsFile('checkout-env'))).toBe(false);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    });

    // Writing the parsed result back would replace every variable the file had.
    it('env add refuses to write into a namespace file that does not parse, and leaves it as it was', async () => {
      const broken = 'API_BASE: root\nDB_URL: db\n';
      await fse.outputFile(nsFile('checkout'), broken);

      await envAdd('NEW_KEY', 'x', { role: 'checkout' });

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('env/checkout/env.yaml'));
      expect(await fse.readFile(nsFile('checkout'), 'utf-8')).toBe(broken);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    });

    it('env remove refuses to write into a namespace file that does not parse, and leaves it as it was', async () => {
      const broken = 'variables:\n  - key: API_BASE\n    value: [\n';
      await fse.outputFile(nsFile('checkout'), broken);

      await envRemove('API_BASE', { role: 'checkout' });

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('env/checkout/env.yaml'));
      expect(await fse.readFile(nsFile('checkout'), 'utf-8')).toBe(broken);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    });

    it('env add --project refuses a project that declares no env namespace, and writes nothing', async () => {
      await writeProjects();

      await envAdd('API_BASE', 'x', { project: 'billing' });

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Project "billing" declares no env namespace'));
      expect(await fse.pathExists(path.join(repoPath, 'env', 'billing'))).toBe(false);
      process.exitCode = 0;
    });

    it('env add refuses --role together with --project', async () => {
      await envAdd('API_BASE', 'x', { role: 'a', project: 'checkout' });
      expect(log.error).toHaveBeenCalledWith('Use either --role or --project, not both.');
      process.exitCode = 0;
    });

    it('env remove --role removes from the namespace file only', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'API_BASE', value: 'root' }] }));
      await fse.outputFile(nsFile('checkout'), YAML.stringify({ variables: [{ key: 'API_BASE', value: 'checkout' }] }));

      await envRemove('API_BASE', { role: 'checkout' });

      expect(YAML.parse(await fse.readFile(nsFile('checkout'), 'utf-8')).variables).toEqual([]);
      expect(YAML.parse(await fse.readFile(path.join(repoPath, 'env', 'env.yaml'), 'utf-8')).variables)
        .toEqual([{ key: 'API_BASE', value: 'root' }]);
      expect(log.success).toHaveBeenCalledWith('Removed env variable in env/checkout/env.yaml: API_BASE');
    });
  });

  // ─── Declaring secrets (#875) ────────────────────────────

  describe('env add --secret / env remove of a secret (#875)', () => {
    const rootSecrets = () => path.join(repoPath, 'env', 'secrets.yaml');
    const nsSecrets = (ns: string) => path.join(repoPath, 'env', ns, 'secrets.yaml');
    const secretsIn = async (file: string): Promise<unknown> => YAML.parse(await fse.readFile(file, 'utf-8')).secrets;
    /** Every string the command logged, to assert a value never appears in it. */
    const logged = (): string => [log.info, log.success, log.warn, log.error, log.dim]
      .flatMap((fn) => vi.mocked(fn).mock.calls.flat()).join('\n');

    beforeEach(() => {
      vi.mocked(log.warn).mockClear();
      process.exitCode = 0;
    });
    afterEach(() => {
      process.exitCode = 0;
    });

    it('declares a secret in env/secrets.yaml with its description and url, and no value', async () => {
      await envAdd('GITHUB_TOKEN', undefined, {
        secret: true, description: 'GitHub token for gh', url: 'https://github.com/settings/tokens',
      });

      expect(await secretsIn(rootSecrets())).toEqual([
        { key: 'GITHUB_TOKEN', description: 'GitHub token for gh', url: 'https://github.com/settings/tokens' },
      ]);
      expect(await fse.pathExists(path.join(repoPath, 'env', 'env.yaml'))).toBe(false);
      expect(log.success).toHaveBeenCalledWith('Declared secret: GITHUB_TOKEN');
      expect(log.info).toHaveBeenCalledWith('Run `teamai push` to sync to team repo.');
      // What was written is what a member's CLI reads back.
      const declarations = await resolveSecretDeclarations(localConfig);
      expect(declarations.kind === 'resolved' && declarations.entries.map((s) => s.name)).toEqual(['GITHUB_TOKEN']);
    });

    it('on Windows, updates and removes an env.yaml variable typed in another case, before any secret of that name', async () => {
      const envYaml = path.join(repoPath, 'env', 'env.yaml');
      await fse.outputFile(envYaml, YAML.stringify({ variables: [{ key: 'TOKEN', value: 'a' }] }));
      await fse.outputFile(rootSecrets(), YAML.stringify({ secrets: [{ key: 'token' }] }));
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        await envAdd('token', 'b', {});
        expect((YAML.parse(await fse.readFile(envYaml, 'utf-8')) as { variables: unknown[] }).variables).toEqual([{ key: 'TOKEN', value: 'b' }]);

        await envRemove('token', {});
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      }
      expect((YAML.parse(await fse.readFile(envYaml, 'utf-8')) as { variables?: unknown[] }).variables ?? []).toEqual([]);
      expect(await secretsIn(rootSecrets())).toEqual([{ key: 'token' }]);
    });

    it('on Windows, updates and removes a declaration typed in another case, rather than add a second one', async () => {
      await fse.outputFile(rootSecrets(), YAML.stringify({ secrets: [{ key: 'TOKEN' }] }));
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        await envAdd('token', undefined, { secret: true, description: 'the token' });
        expect(await secretsIn(rootSecrets())).toEqual([{ key: 'TOKEN', description: 'the token' }]);

        await envRemove('Token', { secret: true });
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      }
      expect(await secretsIn(rootSecrets())).toEqual([]);
    });

    it('declares a secret with the key alone', async () => {
      await envAdd('NPM_TOKEN', undefined, { secret: true });

      expect(await secretsIn(rootSecrets())).toEqual([{ key: 'NPM_TOKEN' }]);
    });

    it('--role declares it in env/<ns>/secrets.yaml, and --role names that file when no one declares the namespace', async () => {
      await fse.outputFile(rootSecrets(), YAML.stringify({ secrets: [{ key: 'GITHUB_TOKEN' }] }));

      await envAdd('GITHUB_TOKEN', undefined, { secret: true, role: 'checkout', description: 'checkout token' });

      expect(await secretsIn(nsSecrets('checkout'))).toEqual([{ key: 'GITHUB_TOKEN', description: 'checkout token' }]);
      expect(await secretsIn(rootSecrets())).toEqual([{ key: 'GITHUB_TOKEN' }]);
      expect(log.success).toHaveBeenCalledWith('Declared secret in env/checkout/secrets.yaml: GITHUB_TOKEN');
    });

    it('--role warns about the secrets file when no role or project declares the namespace', async () => {
      await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'), YAML.stringify({
        version: 1, projects: [{ id: 'billing', resources: { env: ['billing'] } }],
      }));

      await envAdd('GITHUB_TOKEN', undefined, { secret: true, role: 'checkout' });

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(
        'No role or project declares env namespace "checkout", so env/checkout/secrets.yaml reaches nobody',
      ));
    });

    it("--project declares it in the project's env namespace", async () => {
      await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'), YAML.stringify({
        version: 1, projects: [{ id: 'checkout', resources: { env: ['checkout-env'] } }],
      }));

      await envAdd('GITHUB_TOKEN', undefined, { secret: true, project: 'checkout' });

      expect(await secretsIn(nsSecrets('checkout-env'))).toEqual([{ key: 'GITHUB_TOKEN' }]);
    });

    it('updates a declared secret: a new description replaces the old one, the url and other entries stay', async () => {
      await fse.outputFile(rootSecrets(), YAML.stringify({
        secrets: [
          { key: 'GITHUB_TOKEN', description: 'old', url: 'https://github.com/settings/tokens' },
          { key: 'NPM_TOKEN', owner: 'infra' },
        ],
      }));

      await envAdd('GITHUB_TOKEN', undefined, { secret: true, description: 'new' });

      expect(await secretsIn(rootSecrets())).toEqual([
        { key: 'GITHUB_TOKEN', description: 'new', url: 'https://github.com/settings/tokens' },
        { key: 'NPM_TOKEN', owner: 'infra' },
      ]);
      expect(log.success).toHaveBeenCalledWith('Updated secret: GITHUB_TOKEN');
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('updates the first declaration of a key declared twice, removes the rest, and says how many', async () => {
      await fse.outputFile(rootSecrets(), YAML.stringify({
        secrets: [{ key: 'GITHUB_TOKEN', description: 'first' }, { key: 'NPM_TOKEN' }, { key: 'GITHUB_TOKEN' }, { key: 'GITHUB_TOKEN' }],
      }));

      await envAdd('GITHUB_TOKEN', undefined, { secret: true, url: 'https://github.com/settings/tokens' });

      expect(await secretsIn(rootSecrets())).toEqual([
        { key: 'GITHUB_TOKEN', description: 'first', url: 'https://github.com/settings/tokens' },
        { key: 'NPM_TOKEN' },
      ]);
      expect(log.success).toHaveBeenCalledWith('Updated secret: GITHUB_TOKEN, and removed 2 duplicate declarations of it');
    });

    it('updating a secret with an unknown key warns that it is still not declared, without printing a value', async () => {
      await fse.outputFile(rootSecrets(), YAML.stringify({
        secrets: [{ key: 'GITHUB_TOKEN', value: 'ghp_do_not_print', owner: 'infra' }],
      }));

      await envAdd('GITHUB_TOKEN', undefined, { secret: true, description: 'new' });

      expect(await secretsIn(rootSecrets())).toEqual([
        { key: 'GITHUB_TOKEN', value: 'ghp_do_not_print', owner: 'infra', description: 'new' },
      ]);
      expect(log.warn).toHaveBeenCalledWith(
        'env/secrets.yaml: secret "GITHUB_TOKEN" has unknown keys `value:`, `owner:`, so it is not declared. '
          + 'Correct the keys or remove them in env/secrets.yaml.',
      );
      expect(logged()).not.toContain('ghp_do_not_print');
    });

    it('writes nothing on dry-run', async () => {
      await envAdd('GITHUB_TOKEN', undefined, { secret: true, dryRun: true });

      expect(await fse.pathExists(rootSecrets())).toBe(false);
      expect(log.info).toHaveBeenCalledWith('[dry-run] Would declare secret: GITHUB_TOKEN');
    });

    it('rejects a value with --secret, writes nothing and never prints the value', async () => {
      await envAdd('GITHUB_TOKEN', 'ghp_do_not_print', { secret: true });

      expect(await fse.pathExists(rootSecrets())).toBe(false);
      expect(await fse.pathExists(path.join(repoPath, 'env', 'env.yaml'))).toBe(false);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('A secret has no value in the team repo'));
      expect(logged()).not.toContain('ghp_do_not_print');
      expect(process.exitCode).toBe(1);
    });

    it('rejects a variable without a value', async () => {
      await envAdd('API_BASE', undefined, {});

      expect(await fse.pathExists(path.join(repoPath, 'env', 'env.yaml'))).toBe(false);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('No value for "API_BASE"'));
      expect(process.exitCode).toBe(1);
    });

    it('rejects --url without --secret', async () => {
      await envAdd('API_BASE', 'x', { url: 'https://example.com' });

      expect(await fse.pathExists(path.join(repoPath, 'env', 'env.yaml'))).toBe(false);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('--url'));
      expect(process.exitCode).toBe(1);
    });

    it('refuses to write into a secrets file that does not parse, and leaves it as it was', async () => {
      const broken = 'GITHUB_TOKEN: x\n';
      await fse.outputFile(rootSecrets(), broken);

      await envAdd('NPM_TOKEN', undefined, { secret: true });

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('env/secrets.yaml'));
      expect(await fse.readFile(rootSecrets(), 'utf-8')).toBe(broken);
      expect(process.exitCode).toBe(1);
    });

    it('env remove removes a declared secret', async () => {
      await fse.outputFile(rootSecrets(), YAML.stringify({ secrets: [{ key: 'GITHUB_TOKEN' }, { key: 'NPM_TOKEN' }] }));

      await envRemove('GITHUB_TOKEN', {});

      expect(await secretsIn(rootSecrets())).toEqual([{ key: 'NPM_TOKEN' }]);
      expect(log.success).toHaveBeenCalledWith('Removed secret: GITHUB_TOKEN');
      expect(log.info).toHaveBeenCalledWith('Run `teamai push` to sync to team repo.');
    });

    it('env remove --secret removes every declaration of a key declared twice, and says how many', async () => {
      await fse.outputFile(rootSecrets(), YAML.stringify({ secrets: [{ key: 'GITHUB_TOKEN' }, { key: 'NPM_TOKEN' }, { key: 'GITHUB_TOKEN' }] }));

      await envRemove('GITHUB_TOKEN', { secret: true });

      expect(await secretsIn(rootSecrets())).toEqual([{ key: 'NPM_TOKEN' }]);
      expect(log.success).toHaveBeenCalledWith('Removed secret: GITHUB_TOKEN, and 1 duplicate declaration of it');
    });

    it('env remove --role removes the secret from the namespace file only', async () => {
      await fse.outputFile(rootSecrets(), YAML.stringify({ secrets: [{ key: 'GITHUB_TOKEN' }] }));
      await fse.outputFile(nsSecrets('checkout'), YAML.stringify({ secrets: [{ key: 'GITHUB_TOKEN' }] }));

      await envRemove('GITHUB_TOKEN', { role: 'checkout' });

      expect(await secretsIn(nsSecrets('checkout'))).toEqual([]);
      expect(await secretsIn(rootSecrets())).toEqual([{ key: 'GITHUB_TOKEN' }]);
      expect(log.success).toHaveBeenCalledWith('Removed secret in env/checkout/secrets.yaml: GITHUB_TOKEN');
    });

    // An admin moving a token out of env.yaml declares it first, then removes the value.
    it('with the key in both files, env remove removes the variable and --secret removes the secret', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'GITHUB_TOKEN', value: 'v' }] }));
      await fse.outputFile(rootSecrets(), YAML.stringify({ secrets: [{ key: 'GITHUB_TOKEN' }] }));

      await envRemove('GITHUB_TOKEN', {});

      expect(YAML.parse(await fse.readFile(path.join(repoPath, 'env', 'env.yaml'), 'utf-8')).variables).toEqual([]);
      expect(await secretsIn(rootSecrets())).toEqual([{ key: 'GITHUB_TOKEN' }]);

      await envRemove('GITHUB_TOKEN', { secret: true });

      expect(await secretsIn(rootSecrets())).toEqual([]);
    });

    it('env remove --secret leaves a variable alone and says the secret is not declared', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'GITHUB_TOKEN', value: 'v' }] }));

      await envRemove('GITHUB_TOKEN', { secret: true });

      expect(YAML.parse(await fse.readFile(path.join(repoPath, 'env', 'env.yaml'), 'utf-8')).variables)
        .toEqual([{ key: 'GITHUB_TOKEN', value: 'v' }]);
      expect(log.error).toHaveBeenCalledWith(
        'Secret "GITHUB_TOKEN" is not declared in env/secrets.yaml. Nothing was changed. For a namespace\'s file, pass '
          + '--role <ns> or --project <id>; `teamai env list` shows where each secret this directory receives comes from.',
      );
      expect(process.exitCode).toBe(1);
    });

    it('env remove of a variable env.yaml lacks names the broken secrets file and still says the variable is not there', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [{ key: 'API_URL', value: 'u' }] }));
      await fse.outputFile(rootSecrets(), 'secrets: [\n');

      await envRemove('FOO', {});

      expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/^env\/secrets\.yaml is not valid YAML/));
      expect(log.error).toHaveBeenCalledWith('Env variable "FOO" not found');
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    });

    it('env remove of a secret writes nothing on dry-run', async () => {
      await fse.outputFile(rootSecrets(), YAML.stringify({ secrets: [{ key: 'GITHUB_TOKEN' }] }));

      await envRemove('GITHUB_TOKEN', { dryRun: true });

      expect(await secretsIn(rootSecrets())).toEqual([{ key: 'GITHUB_TOKEN' }]);
      expect(log.info).toHaveBeenCalledWith('[dry-run] Would remove secret: GITHUB_TOKEN');
    });
  });

  describe('envRemove', () => {
    it('should remove existing variable locally and show push hint', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [
            { key: 'KEEP', value: 'a' },
            { key: 'REMOVE_ME', value: 'b' },
          ],
        }),
      );

      await envRemove('REMOVE_ME', {});

      // Verify env.yaml was updated
      const content = await fse.readFile(path.join(repoPath, 'env', 'env.yaml'), 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables).toHaveLength(1);
      expect(parsed.variables[0].key).toBe('KEEP');

      // Verify success message and push hint
      expect(log.success).toHaveBeenCalledWith('Removed env variable: REMOVE_ME');
      expect(log.info).toHaveBeenCalledWith('Run `teamai push` to sync to team repo.');
    });

    it('should error when env.yaml does not exist', async () => {
      // Remove the env dir to ensure no env.yaml
      await fse.remove(path.join(repoPath, 'env'));

      await envRemove('MISSING', {});

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('should error when variable key does not exist', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [{ key: 'OTHER', value: 'x' }],
        }),
      );

      await envRemove('NONEXIST', {});

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('"NONEXIST" not found'));
    });

    it('should not modify in dry-run mode', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [{ key: 'DRY_VAR', value: 'x' }],
        }),
      );

      await envRemove('DRY_VAR', { dryRun: true });

      // Variable should still be there
      const content = await fse.readFile(path.join(repoPath, 'env', 'env.yaml'), 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables).toHaveLength(1);

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
    });
  });

  // self-mode guard

  describe('self-mode: pullRepo is skipped', () => {
    beforeEach(() => {
      vi.mocked(pullRepo).mockClear();
    });

    it('envAdd does not call pullRepo in self mode but still writes env.yaml', async () => {
      const selfConfig: LocalConfig = {
        ...localConfig,
        repo: { ...localConfig.repo, kind: 'self' },
      };
      vi.mocked(requireInit).mockResolvedValue({ localConfig: selfConfig, teamConfig });

      await envAdd('SELF_VAR', 'self_value', {});

      expect(pullRepo).not.toHaveBeenCalled();
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      const content = await fse.readFile(envYamlPath, 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables).toHaveLength(1);
      expect(parsed.variables[0]).toEqual({ key: 'SELF_VAR', value: 'self_value' });
    });

    it('envRemove does not call pullRepo in self mode', async () => {
      const selfConfig: LocalConfig = {
        ...localConfig,
        repo: { ...localConfig.repo, kind: 'self' },
      };
      vi.mocked(requireInit).mockResolvedValue({ localConfig: selfConfig, teamConfig });

      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({ variables: [{ key: 'SELF_VAR', value: 'x' }] }),
      );

      await envRemove('SELF_VAR', {});

      expect(pullRepo).not.toHaveBeenCalled();
      const content = await fse.readFile(path.join(repoPath, 'env', 'env.yaml'), 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables).toHaveLength(0);
    });
  });
});
