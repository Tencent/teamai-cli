import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(), persist: vi.fn(),
  },
}));

import { EnvHandler } from '../resources/env.js';
import { resolveSecretValues, secretState, type SecretValues } from '../resources/secrets.js';
import { getTeamSecretsPath, readSecretStore, writeSecretStore } from '../secret-store.js';
import type { ResolvedEntry } from '../namespaced-entries.js';
import type { EnvVariable } from '../resources/env.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * A member's value for a declared secret (#875): stored per team repo under
 * ~/.teamai/secrets/, resolved team value > the member's own environment.
 */
describe('team secret values', () => {
  let tmpDir: string;
  let home: string;
  let localConfig: LocalConfig;

  const teamConfig = { sharing: { env: { injectShellProfile: false } } } as unknown as TeamaiConfig;
  const variable = (key: string, value: string): ResolvedEntry<EnvVariable> =>
    ({ name: key, entry: { key, value }, namespace: null, source: 'env/env.yaml' }) as ResolvedEntry<EnvVariable>;
  const keys = (...names: string[]): ReadonlySet<string> => new Set(names);
  const values = (resolution: SecretValues): Record<string, string> =>
    resolution.kind === 'resolved' ? Object.fromEntries([...resolution.values].map(([k, v]) => [k, `${v.source}:${v.value}`])) : {};

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-secret-values-'));
    home = path.join(tmpDir, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.outputFile(path.join(repoPath, 'teamai.yaml'), 'team: acme\n');
    localConfig = { repo: { localPath: repoPath, remote: 'https://example.com/acme/team.git' }, username: 't', scope: 'user', additionalRoles: [] } as LocalConfig;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  describe('store', () => {
    it('keeps values per team repo under ~/.teamai/secrets/teams, readable by the member only', async () => {
      const file = getTeamSecretsPath(localConfig);
      expect(path.dirname(file)).toBe(path.join(home, '.teamai', 'secrets', 'teams'));
      expect(path.basename(file)).toMatch(/^acme-[0-9a-f]{10}\.json$/);

      await writeSecretStore(file, { GITHUB_TOKEN: { value: 'fixture-token' }, GITLAB_TOKEN: { env: 'WORK_GITLAB_TOKEN' } });

      expect(await readSecretStore(file)).toEqual({
        ok: true,
        values: { GITHUB_TOKEN: { value: 'fixture-token' }, GITLAB_TOKEN: { env: 'WORK_GITLAB_TOKEN' } },
      });
      if (process.platform !== 'win32') expect((await fse.stat(file)).mode & 0o777).toBe(0o600);
    });

    it('does not touch the env backup file ~/.teamai/env', async () => {
      await fse.outputFile(path.join(home, '.teamai', 'env'), 'API_URL=u\n');
      await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { value: 'fixture-token' } });
      expect(await fse.readFile(path.join(home, '.teamai', 'env'), 'utf8')).toBe('API_URL=u\n');
    });

    it('reads a missing file as no values', async () => {
      expect(await readSecretStore(getTeamSecretsPath(localConfig))).toEqual({ ok: true, values: {} });
    });

    it('reports a hand-corrupted file by path and position, never with the value', async () => {
      const file = getTeamSecretsPath(localConfig);
      await fse.outputFile(file, '{\n  "GITHUB_TOKEN": { "value": ghp_fixture_value }\n}\n');

      const read = await readSecretStore(file);

      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.reason).toContain(`${file} is not valid JSON (line 2, column 30)`);
      expect(read.reason).not.toContain('ghp_fixture_value');
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
      const resolved = await resolveSecretValues(localConfig, keys('GITHUB_TOKEN', 'GITLAB_TOKEN', 'ACME_TOKEN'), [], {
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

      expect(values(await resolveSecretValues(localConfig, secret, [], { WORK_GITHUB_TOKEN: 'work-1', GITHUB_TOKEN: 'personal' })))
        .toEqual({ GITHUB_TOKEN: 'team:work-1' });
      expect(values(await resolveSecretValues(localConfig, secret, [], { WORK_GITHUB_TOKEN: 'work-2' })))
        .toEqual({ GITHUB_TOKEN: 'team:work-2' });
      expect(values(await resolveSecretValues(localConfig, secret, [], { GITHUB_TOKEN: 'personal' }))).toEqual({});
    });

    it('leaves every secret without a value when the store cannot be read', async () => {
      await fse.outputFile(getTeamSecretsPath(localConfig), '{ "GITHUB_TOKEN": { "value": ghp_fixture_value } }');
      const resolved = await resolveSecretValues(localConfig, keys('GITHUB_TOKEN'), [], { GITHUB_TOKEN: 'exported' });

      expect(resolved.kind).toBe('store-unreadable');
      expect(secretState(resolved, 'GITHUB_TOKEN')).toBe('missing');
      expect(JSON.stringify(resolved)).not.toContain('ghp_fixture_value');
    });
  });

  // #879 Conflict 10: the environment in the order is the member's own.
  describe("the member's environment", () => {
    const resolve = async (env: NodeJS.ProcessEnv, variables: ResolvedEntry<EnvVariable>[] = []): Promise<Record<string, string>> =>
      values(await resolveSecretValues(localConfig, keys('GITHUB_TOKEN'), variables, env));

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
  });
});
