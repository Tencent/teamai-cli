import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(), persist: vi.fn(),
  },
}));

import YAML from 'yaml';
import { EnvHandler, parseEnvFile, type EnvVariable } from '../resources/env.js';
import { resolveTeamEnv, secretState, type SecretValue, type StoreResolution, type TeamEnv } from '../env-resolution.js';
import { getMachineSecretsPath, getTeamSecretsPath, readSecretStore, writeSecretStore } from '../secret-store.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * A member's value for a declared secret (#875): stored per team repo under
 * ~/.teamai/secrets/, or once for the machine, resolved team value > machine
 * value > the member's own environment.
 */
describe('team secret values', () => {
  let tmpDir: string;
  let home: string;
  let localConfig: LocalConfig;

  const teamConfig: TeamaiConfig = {
    team: 'acme', description: '', repo: 'https://example.com/acme/team.git', provider: 'git', reviewers: [],
    sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: false } },
    toolPaths: {},
  };
  const variable = (key: string, value: string): EnvVariable => ({ key, value });
  const keys = (...names: string[]): readonly string[] => names;
  const values = (resolution: StoreResolution<SecretValue>): Record<string, string> =>
    resolution.kind === 'resolved' ? Object.fromEntries([...resolution.values].map(([k, v]) => [k, `${v.source}:${v.value}`])) : {};
  /** This scope's env with this env, as the team repo declares `declared` and sets `variables`. */
  const resolveTeamEnvWith = async (
    declared: readonly string[],
    variables: readonly EnvVariable[],
    env: NodeJS.ProcessEnv = {},
  ): Promise<TeamEnv> => {
    const repoPath = localConfig.repo.localPath;
    await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), YAML.stringify({ secrets: declared.map((key) => ({ key })) }));
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables }));
    return resolveTeamEnv(localConfig, undefined, env);
  };
  /** The secrets `declared` resolve to with this env. */
  const resolveSecretValues = async (
    declared: readonly string[],
    variables: readonly EnvVariable[],
    env: NodeJS.ProcessEnv,
  ): Promise<StoreResolution<SecretValue>> => (await resolveTeamEnvWith(declared, variables, env)).secrets;

  const variableSources = (teamEnv: TeamEnv): Record<string, string> => teamEnv.variableValues.kind === 'resolved'
    ? Object.fromEntries([...teamEnv.variableValues.values].map(([k, v]) => [k, `${v.source}:${v.value}`]))
    : {};

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-secret-values-'));
    home = path.join(tmpDir, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.outputFile(path.join(repoPath, 'teamai.yaml'), 'team: acme\n');
    localConfig = { repo: { localPath: repoPath, remote: 'https://example.com/acme/team.git' }, username: 't', scope: 'user', additionalRoles: [] };
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  describe('store', () => {
    it('keeps values per team repo under ~/.teamai/secrets/teams, readable by the member only', async () => {
      const file = getTeamSecretsPath(localConfig);
      expect(path.dirname(file)).toBe(path.join(home, '.teamai', 'secrets', 'teams'));
      expect(path.basename(file)).toMatch(/^[0-9a-f]{64}\.json$/);

      await writeSecretStore(file, { GITHUB_TOKEN: { value: 'fixture-token' }, GITLAB_TOKEN: { env: 'WORK_GITLAB_TOKEN' } });

      expect(await readSecretStore(file)).toEqual({
        ok: true,
        values: { GITHUB_TOKEN: { value: 'fixture-token' }, GITLAB_TOKEN: { env: 'WORK_GITLAB_TOKEN' } },
      });
      if (process.platform !== 'win32') expect((await fse.stat(file)).mode & 0o777).toBe(0o600);
    });

    it("keeps the values when the team is renamed in teamai.yaml, and only for this team repo", async () => {
      await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { value: 'team-token' } });
      await fse.outputFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), 'team: Acme Engineering\n');

      expect(await readSecretStore(getTeamSecretsPath(localConfig))).toEqual({ ok: true, values: { GITHUB_TOKEN: { value: 'team-token' } } });

      const otherRepo: LocalConfig = { ...localConfig, repo: { ...localConfig.repo, remote: 'https://example.com/other/team.git' } };
      expect(getTeamSecretsPath(otherRepo)).not.toBe(getTeamSecretsPath(localConfig));
      expect(await readSecretStore(getTeamSecretsPath(otherRepo))).toEqual({ ok: true, values: {} });
    });

    it("keys the values by the configured team repo URL, not by teamai.yaml's repo:", async () => {
      const otherPath = path.join(tmpDir, 'copied-repo');
      const claim = 'team: acme\nrepo: https://example.com/acme/team.git\n';
      await fse.outputFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), claim);
      await fse.outputFile(path.join(otherPath, 'teamai.yaml'), claim);
      const copied: LocalConfig = { ...localConfig, repo: { localPath: otherPath, remote: 'https://example.com/mallory/team.git' } };

      expect(getTeamSecretsPath(copied)).not.toBe(getTeamSecretsPath(localConfig));
    });

    it('keys the values by the repo URL when the remote is only an alias (fork), so two teams behind one alias stay apart', () => {
      const behindFork = (url: string): LocalConfig => ({ ...localConfig, repo: { ...localConfig.repo, remote: 'fork', url } });

      expect(getTeamSecretsPath(behindFork('https://example.com/acme/team.git')))
        .not.toBe(getTeamSecretsPath(behindFork('https://example.com/other/team.git')));
      expect(getTeamSecretsPath(behindFork('https://example.com/acme/team.git')))
        .toBe(getTeamSecretsPath({ ...localConfig, repo: { ...localConfig.repo, remote: 'origin', url: 'https://example.com/acme/team.git' } }));
    });

    describe('naming the file by the team repo URL', () => {
      const fileFor = (remote: string): string => getTeamSecretsPath({ ...localConfig, repo: { ...localConfig.repo, remote } });

      it('gives the credentialed, default-port and trailing-slash forms of one https URL the same file', () => {
        for (const remote of [
          'https://user:fixture-pass@EXAMPLE.com/acme/team/',
          'https://example.com:443/acme/team.git',
        ]) expect(fileFor(remote)).toBe(getTeamSecretsPath(localConfig));
      });

      it('gives the http and https URLs of a repo different files, each with its default port written or not', () => {
        expect(fileFor('http://example.com/acme/team.git')).not.toBe(getTeamSecretsPath(localConfig));
        expect(fileFor('http://example.com:80/acme/team')).toBe(fileFor('http://example.com/acme/team.git'));
        expect(fileFor('http://example.com:443/acme/team.git')).not.toBe(getTeamSecretsPath(localConfig));
      });

      it('gives the scp form and the ssh URL of one repo the same file, with the default port written or not', () => {
        for (const remote of [
          'ssh://git@example.com/~/acme/team',
          'ssh://git@EXAMPLE.com:22/~/acme/team.git/',
          'git+ssh://git@example.com/~/acme/team.git',
          'ssh+git://git@example.com:22/~/acme/team.git',
          'git@example.com:~/acme/team.git',
        ]) {
          expect(fileFor(remote)).toBe(fileFor('git@example.com:acme/team.git'));
        }
        expect(fileFor('ssh://git@example.com:22/acme/team.git')).toBe(fileFor('git@example.com:/acme/team.git'));
        expect(fileFor('ssh://example.com/~/acme/team')).toBe(fileFor('example.com:acme/team'));
      });

      it('gives an scp path in the ssh user\'s home and the ssh URL of that path from the root different files', () => {
        expect(fileFor('ssh://git@example.com/acme/team.git')).not.toBe(fileFor('git@example.com:acme/team.git'));
        expect(fileFor('git@example.com:/acme/team.git')).not.toBe(fileFor('git@example.com:acme/team.git'));
      });

      it('gives two ssh users on one host different files, in the scp form and the ssh URL alike', () => {
        expect(fileFor('alice@example.com:team.git')).not.toBe(fileFor('bob@example.com:team.git'));
        expect(fileFor('ssh://alice@example.com/team')).not.toBe(fileFor('ssh://bob@example.com/team'));
        expect(fileFor('ssh://alice@example.com:22/~/team.git')).toBe(fileFor('alice@example.com:team.git'));
        expect(fileFor('ssh://example.com/team')).not.toBe(fileFor('alice@example.com:team.git'));
      });

      it('gives repos on one host with different ports different files', () => {
        expect(fileFor('ssh://git@example.com:2222/acme/team.git')).not.toBe(fileFor('ssh://git@example.com:2223/acme/team.git'));
        expect(fileFor('ssh://git@example.com:2222/acme/team.git')).not.toBe(fileFor('git@example.com:acme/team.git'));
        expect(fileFor('https://example.com:8443/acme/team.git')).not.toBe(getTeamSecretsPath(localConfig));
      });

      it('gives file:// repos that differ only by a .git suffix different files: they are two directories', () => {
        expect(fileFor('file:///srv/team')).not.toBe(fileFor('file:///srv/team.git'));
        expect(fileFor('file:///srv/team/')).toBe(fileFor('file:///srv/team'));
      });

      it('gives URLs that differ only in the query or the fragment different files', () => {
        expect(fileFor('https://example.com/acme/team?tenant=a')).not.toBe(fileFor('https://example.com/acme/team?tenant=b'));
        expect(fileFor('https://example.com/acme/team?tenant=a')).not.toBe(getTeamSecretsPath(localConfig));
        expect(fileFor('https://example.com/acme/team#a')).not.toBe(fileFor('https://example.com/acme/team#b'));
        expect(fileFor('ssh://git@example.com/acme/team?tenant=a')).not.toBe(fileFor('ssh://git@example.com/acme/team?tenant=b'));
      });

      it('keeps the query while dropping the credentials, the default port and a trailing .git or slash before it', () => {
        for (const remote of [
          'https://user:fixture-pass@EXAMPLE.com/acme/team.git?tenant=a',
          'https://example.com:443/acme/team/?tenant=a',
        ]) expect(fileFor(remote)).toBe(fileFor('https://example.com/acme/team?tenant=a'));
      });

      it('gives the ssh and https URLs of a repo different files', () => {
        expect(fileFor('git@example.com:acme/team.git')).not.toBe(getTeamSecretsPath(localConfig));
      });

      it('keeps the case of the path', () => {
        expect(fileFor('https://example.com/Acme/Team.git')).not.toBe(getTeamSecretsPath(localConfig));
      });
    });

    it('keeps an entry named __proto__ as an own key, through a write and a read', async () => {
      const file = getTeamSecretsPath(localConfig);
      await writeSecretStore(file, { ['__proto__']: { value: 'proto-value' }, API_URL: { value: 'u' } });

      expect(JSON.parse(await fse.readFile(file, 'utf8'))).toEqual({ ['__proto__']: { value: 'proto-value' }, API_URL: { value: 'u' } });
      const read = await readSecretStore(file);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(Object.keys(read.values)).toEqual(['__proto__', 'API_URL']);
      expect(Object.hasOwn(read.values, '__proto__')).toBe(true);
    });

    it('keeps whether an entry is a secret or a variable override, and rejects any other kind', async () => {
      const file = getTeamSecretsPath(localConfig);
      await writeSecretStore(file, { GITHUB_TOKEN: { value: 't', kind: 'secret' }, API_URL: { env: 'MY_API_URL', kind: 'variable' } });

      expect(await readSecretStore(file)).toEqual({
        ok: true, values: { GITHUB_TOKEN: { value: 't', kind: 'secret' }, API_URL: { env: 'MY_API_URL', kind: 'variable' } },
      });
      await fse.outputJson(file, { GITHUB_TOKEN: { value: 't', kind: 'token' } });
      expect((await readSecretStore(file)).ok).toBe(false);
    });

    it('does not touch the env backup file ~/.teamai/env', async () => {
      await fse.outputFile(path.join(home, '.teamai', 'env'), 'API_URL=u\n');
      await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { value: 'fixture-token' } });
      expect(await fse.readFile(path.join(home, '.teamai', 'env'), 'utf8')).toBe('API_URL=u\n');
    });

    it('keeps the machine values beside the team files, in ~/.teamai/secrets/machine.json', () => {
      expect(getMachineSecretsPath()).toBe(path.join(home, '.teamai', 'secrets', 'machine.json'));
    });

    it('reads a missing file as no values', async () => {
      expect(await readSecretStore(getTeamSecretsPath(localConfig))).toEqual({ ok: true, values: {} });
    });

    it('reports a hand-corrupted file by path only, never with the value or the parser message', async () => {
      const file = getTeamSecretsPath(localConfig);
      await fse.outputFile(file, '{\n  "GITHUB_TOKEN": { "value": ghp_fixture_value }\n}\n');

      const read = await readSecretStore(file);

      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.reason).toBe(`${file} is not valid JSON. Fix the file, or delete it and set the values again with \`teamai env set\`.`);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says what to check when the file cannot be read', async () => {
      const file = getTeamSecretsPath(localConfig);
      await writeSecretStore(file, { GITHUB_TOKEN: { value: 'fixture-token' } });
      await fse.chmod(file, 0o000);
      try {
        const read = await readSecretStore(file);

        expect(read).toEqual({
          ok: false,
          reason: `Cannot read your secret values at ${file} (EACCES). Check that the file is yours and readable (\`ls -l ${file}\`), `
            + 'or delete it and set the values again with `teamai env set`.',
        });
      } finally {
        await fse.chmod(file, 0o600);
      }
    });

    it('rejects an entry that is not exactly one of a value or a variable reference', async () => {
      const file = getTeamSecretsPath(localConfig);
      for (const entry of ['{"value": "ghp_fixture_value", "env": "X"}', '{}', '"ghp_fixture_value"']) {
        await fse.outputFile(file, `{"OK": {"env": "X"}, "GITHUB_TOKEN": ${entry}}`);
        const read = await readSecretStore(file);
        expect(read.ok).toBe(false);
        if (read.ok) continue;
        expect(read.reason).toContain(`${file} has an invalid entry (entry 2)`);
        expect(read.reason).not.toContain('ghp_fixture_value');
      }
    });
  });

  describe('resolution', () => {
    it('takes the team value over the environment, and the environment when no team value is set', async () => {
      await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { value: 'team-token' } });
      const resolved = await resolveSecretValues(keys('GITHUB_TOKEN', 'GITLAB_TOKEN', 'ACME_TOKEN'), [], {
        GITHUB_TOKEN: 'exported-token', GITLAB_TOKEN: 'exported-gitlab', ACME_TOKEN: '',
      });

      expect(values(resolved)).toEqual({ GITHUB_TOKEN: 'team:team-token', GITLAB_TOKEN: 'environment:exported-gitlab' });
      expect(secretState(resolved, 'GITHUB_TOKEN')).toBe('team');
      expect(secretState(resolved, 'GITLAB_TOKEN')).toBe('environment');
      expect(secretState(resolved, 'ACME_TOKEN')).toBe('missing');
    });

    it('reads a --from-env reference when the value is used, and does not fall back to the environment when it is unset', async () => {
      await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { env: 'WORK_GITHUB_TOKEN' } });
      const secret = keys('GITHUB_TOKEN');

      expect(values(await resolveSecretValues(secret, [], { WORK_GITHUB_TOKEN: 'work-1', GITHUB_TOKEN: 'personal' })))
        .toEqual({ GITHUB_TOKEN: 'team:work-1' });
      expect(values(await resolveSecretValues(secret, [], { WORK_GITHUB_TOKEN: 'work-2' })))
        .toEqual({ GITHUB_TOKEN: 'team:work-2' });
      expect(values(await resolveSecretValues(secret, [], { GITHUB_TOKEN: 'personal' }))).toEqual({});
    });

    it('takes the team value over the machine value, and the machine value over the environment', async () => {
      await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { value: 'team-token' } });
      await writeSecretStore(getMachineSecretsPath(), { GITHUB_TOKEN: { value: 'machine-github' }, GITLAB_TOKEN: { value: 'machine-gitlab' } });
      const resolved = await resolveSecretValues(keys('GITHUB_TOKEN', 'GITLAB_TOKEN', 'SENTRY_TOKEN'), [], {
        GITHUB_TOKEN: 'exported-github', GITLAB_TOKEN: 'exported-gitlab', SENTRY_TOKEN: 'exported-sentry',
      });

      expect(values(resolved)).toEqual({
        GITHUB_TOKEN: 'team:team-token', GITLAB_TOKEN: 'global:machine-gitlab', SENTRY_TOKEN: 'environment:exported-sentry',
      });
      expect(secretState(resolved, 'GITLAB_TOKEN')).toBe('global');
    });

    it('lets an entry decide even when its --from-env variable is unset: a team entry over the machine, a machine entry over the environment', async () => {
      await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { env: 'WORK_GITHUB_TOKEN' } });
      await writeSecretStore(getMachineSecretsPath(), { GITHUB_TOKEN: { value: 'personal' }, GITLAB_TOKEN: { env: 'PERSONAL_GITLAB_TOKEN' } });

      expect(values(await resolveSecretValues(keys('GITHUB_TOKEN', 'GITLAB_TOKEN'), [], { GITLAB_TOKEN: 'exported' })))
        .toEqual({});
    });

    // #879: secrets and variable overrides share the team store; each entry says which it is.
    it('never resolves a variable from a value stored while the key was a secret, an entry without a kind counting as one', async () => {
      await writeSecretStore(getTeamSecretsPath(localConfig), {
        API_URL: { value: 'fixture-old-secret' }, GITLAB_HOST: { value: 'fixture-old-secret-2', kind: 'secret' },
      });
      const teamEnv = await resolveTeamEnvWith(keys(), [variable('API_URL', 'team-url'), variable('GITLAB_HOST', 'gitlab.team')]);

      expect(variableSources(teamEnv)).toEqual({ API_URL: 'env.yaml:team-url', GITLAB_HOST: 'env.yaml:gitlab.team' });
      expect([...teamEnv.staleEntries]).toEqual([['API_URL', 'secret'], ['GITLAB_HOST', 'secret']]);
    });

    it('never resolves a secret from a variable override of the same key', async () => {
      await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { value: 'fixture-override', kind: 'variable' } });
      await writeSecretStore(getMachineSecretsPath(), { GITLAB_TOKEN: { value: 'machine-gitlab', kind: 'secret' } });
      const teamEnv = await resolveTeamEnvWith(keys('GITHUB_TOKEN', 'GITLAB_TOKEN'), [], { GITHUB_TOKEN: 'exported-token' });

      expect(values(teamEnv.secrets)).toEqual({ GITHUB_TOKEN: 'environment:exported-token', GITLAB_TOKEN: 'global:machine-gitlab' });
      expect([...teamEnv.staleEntries]).toEqual([['GITHUB_TOKEN', 'variable']]);
    });

    it('on Windows, treats an env.yaml variable as the secret declared under the same name in another case', async () => {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      let teamEnv: TeamEnv;
      try {
        teamEnv = await resolveTeamEnvWith(keys('GITHUB_TOKEN'), [variable('github_token', 'fixture-repo-token')]);
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      }
      expect(variableSources(teamEnv)).toEqual({});

      teamEnv = await resolveTeamEnvWith(keys('GITHUB_TOKEN'), [variable('github_token', 'repo-value')]);
      expect(variableSources(teamEnv)).toEqual({ github_token: 'env.yaml:repo-value' });
    });

    it("on Windows, never takes an env.yaml value under another case of a secret's name for the member's own", async () => {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      let teamEnv: TeamEnv;
      try {
        teamEnv = await resolveTeamEnvWith(keys('GITHUB_TOKEN'), [variable('github_token', 'fixture-repo-token')], { GITHUB_TOKEN: 'fixture-repo-token' });
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      }
      expect(values(teamEnv.secrets)).toEqual({});
    });

    it('on Windows, resolves a secret from a value stored under another case of its name', async () => {
      await writeSecretStore(getTeamSecretsPath(localConfig), { github_token: { value: 'fixture-team-token', kind: 'secret' } });
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      let teamEnv: TeamEnv;
      try {
        teamEnv = await resolveTeamEnvWith(keys('GITHUB_TOKEN'), []);
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      }
      expect(values(teamEnv.secrets)).toEqual({ GITHUB_TOKEN: 'team:fixture-team-token' });
    });

    it("resolves a variable from the member's override and a secret from its value, each by its kind", async () => {
      await writeSecretStore(getTeamSecretsPath(localConfig), {
        API_URL: { value: 'member-url', kind: 'variable' }, GITHUB_TOKEN: { value: 'team-token', kind: 'secret' },
      });
      const teamEnv = await resolveTeamEnvWith(keys('GITHUB_TOKEN'), [variable('API_URL', 'team-url')]);

      expect(variableSources(teamEnv)).toEqual({ API_URL: 'team:member-url' });
      expect(values(teamEnv.secrets)).toEqual({ GITHUB_TOKEN: 'team:team-token' });
      expect(teamEnv.staleEntries.size).toBe(0);
    });

    it('leaves every secret without a value when the machine store cannot be read', async () => {
      await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { value: 'team-token' } });
      await fse.outputFile(getMachineSecretsPath(), '{ "GITLAB_TOKEN": { "value": ghp_fixture_value } }');
      const resolved = await resolveSecretValues(keys('GITHUB_TOKEN', 'GITLAB_TOKEN'), [], { GITLAB_TOKEN: 'exported' });

      expect(resolved.kind).toBe('store-unreadable');
      if (resolved.kind !== 'store-unreadable') return;
      expect(resolved.reason).toContain(`${getMachineSecretsPath()} is not valid JSON`);
      expect(resolved.reason).not.toContain('ghp_fixture_value');
    });

    it('leaves every secret without a value when the store cannot be read, and says so rather than missing', async () => {
      await fse.outputFile(getTeamSecretsPath(localConfig), '{ "GITHUB_TOKEN": { "value": ghp_fixture_value } }');
      const resolved = await resolveSecretValues(keys('GITHUB_TOKEN'), [], { GITHUB_TOKEN: 'exported' });

      expect(resolved.kind).toBe('store-unreadable');
      expect(secretState(resolved, 'GITHUB_TOKEN')).toBe('unreadable');
      expect(JSON.stringify(resolved)).not.toContain('ghp_fixture_value');
    });
  });

  // #879 Conflict 10: the environment in the order is the member's own.
  describe("the member's environment", () => {
    const resolve = async (env: NodeJS.ProcessEnv, variables: EnvVariable[] = []): Promise<Record<string, string>> =>
      values(await resolveSecretValues(keys('GITHUB_TOKEN'), variables, env));

    it.each([
      ['counts a value the member exported by hand', null, [], 'hand-export', { GITHUB_TOKEN: 'environment:hand-export' }],
      ["leaves out a value another scope's env.sh exports", 'projects/other-slug/env.sh', [], 'other-team-token', {}],
      ["leaves out a value the user scope's env.sh exports", 'env.sh', [], 'user-scope-token', {}],
      ["leaves out this scope's env.yaml value for a key now declared as a secret", null, [variable('GITHUB_TOKEN', 'repo-token')], 'repo-token', {}],
    ] as const)('%s', async (_name, envSh, variables, exported, expected) => {
      if (envSh) await fse.outputFile(path.join(home, '.teamai', envSh), `export GITHUB_TOKEN='${exported}'\n`);
      expect(await resolve({ GITHUB_TOKEN: exported }, [...variables])).toEqual(expected);
    });

    it("leaves out this scope's previous env.sh value after a pull rewrote it", async () => {
      const envSh = path.join(home, '.teamai', 'env.sh');
      await fse.outputFile(envSh, "export GITHUB_TOKEN='old-repo-token'\n");

      await new EnvHandler().writeResolvedEnv([], teamConfig, localConfig);

      expect(await fse.readFile(envSh, 'utf8')).not.toContain('old-repo-token');
      expect(await resolve({ GITHUB_TOKEN: 'old-repo-token' })).toEqual({});
      expect(await resolve({ GITHUB_TOKEN: 'hand-export' })).toEqual({ GITHUB_TOKEN: 'environment:hand-export' });
    });

    // A shell opened before a pull keeps what env.sh exported then, through
    // every later command, not only the one that rewrote it.
    it('leaves out a value an earlier rewrite of env.sh exported, after a later rewrite dropped it', async () => {
      const write = (value?: string): Promise<boolean> =>
        new EnvHandler().writeResolvedEnv(value ? [{ key: 'GITHUB_TOKEN', value }] : [], teamConfig, localConfig);
      await write('repo-token');
      await write();

      expect(await resolve({ GITHUB_TOKEN: 'repo-token' })).toEqual({});
      expect(await resolve({ GITHUB_TOKEN: 'hand-export' })).toEqual({ GITHUB_TOKEN: 'environment:hand-export' });
    });

    // No scan finds every env.sh a shell may have loaded: a non-git project
    // keeps its own under `<dir>/.teamai/`. The marker each one exports says so.
    describe('an env.sh at a path no scan reaches', () => {
      const MARKER_LINE = /^export (TEAMAI_ENV_SH_[0-9a-f]{64})='([^']*)'$/m;
      /** The environment of a shell that sourced a project's env.sh in `<tmp>/elsewhere/.teamai`. */
      const sourcedProjectEnvSh = async (variables: EnvVariable[]): Promise<{ env: NodeJS.ProcessEnv; content: string }> => {
        const projectRoot = path.join(tmpDir, 'elsewhere');
        const project: LocalConfig = { ...localConfig, scope: 'project', projectRoot };
        await new EnvHandler().writeResolvedEnv(variables, teamConfig, project);
        const content = await fse.readFile(path.join(projectRoot, '.teamai', 'env.sh'), 'utf8');
        const env = Object.fromEntries([...content.matchAll(/^export (\w+)='([^']*)'$/gm)].map((m) => [m[1], m[2]]));
        return { env, content };
      };

      it('leaves out a value that env.sh exported', async () => {
        const { env } = await sourcedProjectEnvSh([variable('GITHUB_TOKEN', 'project-a-token'), variable('API_URL', 'https://a')]);

        expect(env.GITHUB_TOKEN).toBe('project-a-token');
        expect(await resolve(env)).toEqual({});
      });

      it('counts a different value the member exported by hand for the same key', async () => {
        const { env } = await sourcedProjectEnvSh([variable('GITHUB_TOKEN', 'project-a-token')]);

        expect(await resolve({ ...env, GITHUB_TOKEN: 'hand-export' })).toEqual({ GITHUB_TOKEN: 'environment:hand-export' });
      });

      it('exports one marker of hashes, never a value, that env.sh does not read back as a variable', async () => {
        const { content } = await sourcedProjectEnvSh([variable('GITHUB_TOKEN', 'project-a-token'), variable('API_URL', 'https://a')]);
        const marker = content.match(MARKER_LINE);

        expect(marker?.[2]).toMatch(/^[0-9a-f]{12} [0-9a-f]{12}$/);
        expect(marker?.[0]).not.toContain('project-a-token');
        expect(marker?.[0]).not.toContain('https://a');
        expect([...parseEnvFile(content).keys()]).toEqual(['GITHUB_TOKEN', 'API_URL']);
      });

      // The shell re-sources the rewritten env.sh: the old value stays
      // exported, and the new marker replaces the old one.
      it('keeps marking a value that env.sh exported before a rewrite dropped it, in a shell that sources it again', async () => {
        const first = await sourcedProjectEnvSh([variable('GITHUB_TOKEN', 'project-a-token'), variable('API_URL', 'https://a')]);
        const second = await sourcedProjectEnvSh([variable('API_URL', 'https://a')]);
        const env = { ...first.env, ...second.env };

        expect(second.content).not.toContain('project-a-token');
        expect(env.GITHUB_TOKEN).toBe('project-a-token');
        expect(await resolve(env)).toEqual({});
        expect(await resolve({ ...env, GITHUB_TOKEN: 'hand-export' })).toEqual({ GITHUB_TOKEN: 'environment:hand-export' });
      });
    });

    // Windows compares environment names case-insensitively, so `github_token`
    // another scope exported is the member's GITHUB_TOKEN there.
    describe('a key exported in another case', () => {
      const original = process.platform;
      const onPlatform = (platform: NodeJS.Platform): void => {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      };
      afterEach(() => onPlatform(original));

      const exportedInLowerCase = async (): Promise<void> => {
        await fse.outputFile(path.join(home, '.teamai', 'projects', 'other-slug', 'env.sh'), "export github_token='other-team-token'\n");
      };
      const recordedInLowerCase = async (): Promise<void> => {
        const write = (exports: EnvVariable[]): Promise<boolean> => new EnvHandler().writeResolvedEnv(exports, teamConfig, localConfig);
        await write([variable('github_token', 'repo-token')]);
        await write([]);
      };
      /** A shell that sourced a project's env.sh no scan finds, exporting github_token. */
      const markedInLowerCase = async (): Promise<NodeJS.ProcessEnv> => {
        const projectRoot = path.join(tmpDir, 'elsewhere');
        await new EnvHandler().writeResolvedEnv([variable('github_token', 'project-token')], teamConfig, { ...localConfig, scope: 'project', projectRoot });
        const content = await fse.readFile(path.join(projectRoot, '.teamai', 'env.sh'), 'utf8');
        const marker = /^export (TEAMAI_ENV_SH_[0-9a-f]{64})='([^']*)'$/m.exec(content);
        expect(marker).not.toBeNull();
        return marker?.[1] ? { [marker[1]]: marker[2] } : {};
      };

      it('on Windows, leaves out a value another env.sh exports, has recorded or has marked in any case', async () => {
        onPlatform('win32');
        await exportedInLowerCase();
        await recordedInLowerCase();
        const marker = await markedInLowerCase();

        expect(await resolve({ GITHUB_TOKEN: 'other-team-token' })).toEqual({});
        expect(await resolve({ GITHUB_TOKEN: 'repo-token' })).toEqual({});
        expect(await resolve({ ...marker, GITHUB_TOKEN: 'project-token' })).toEqual({});
        expect(await resolve({ ...marker, GITHUB_TOKEN: 'hand-export' })).toEqual({ GITHUB_TOKEN: 'environment:hand-export' });
      });

      it('elsewhere, counts a value exported, recorded or marked only under another case as the member\'s', async () => {
        onPlatform('linux');
        await exportedInLowerCase();
        await recordedInLowerCase();
        const marker = await markedInLowerCase();

        expect(await resolve({ GITHUB_TOKEN: 'other-team-token' })).toEqual({ GITHUB_TOKEN: 'environment:other-team-token' });
        expect(await resolve({ GITHUB_TOKEN: 'repo-token' })).toEqual({ GITHUB_TOKEN: 'environment:repo-token' });
        expect(await resolve({ ...marker, GITHUB_TOKEN: 'project-token' })).toEqual({ GITHUB_TOKEN: 'environment:project-token' });
      });
    });

    it('records what env.sh exported as hashes beside it, readable by the member only, and forgets the oldest', async () => {
      const write = (value: string): Promise<boolean> =>
        new EnvHandler().writeResolvedEnv([{ key: 'GITHUB_TOKEN', value }], teamConfig, localConfig);
      for (let i = 1; i <= 21; i++) await write(`repo-token-${i}`);
      await new EnvHandler().writeResolvedEnv([], teamConfig, localConfig);

      const record = path.join(home, '.teamai', 'env.sh.exports.json');
      expect(await fse.readFile(record, 'utf8')).not.toContain('repo-token');
      if (process.platform !== 'win32') expect((await fse.stat(record)).mode & 0o777).toBe(0o600);
      expect(await resolve({ GITHUB_TOKEN: 'repo-token-1' })).toEqual({ GITHUB_TOKEN: 'environment:repo-token-1' });
      expect(await resolve({ GITHUB_TOKEN: 'repo-token-2' })).toEqual({});
    });
  });
});
