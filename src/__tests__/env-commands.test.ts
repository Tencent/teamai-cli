import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

// Mock external dependencies before importing modules
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/git.js', () => ({
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

import { envList, envAdd, envRemove } from '../env-commands.js';
import { requireInit } from '../config.js';
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
      expect(allOutput).toContain('API_BASE=checkout-value  (checkout, overrides root)');
      expect(allOutput).toContain('SHARED=s  (root)');
      expect(allOutput).toContain('CHECKOUT_ONLY=c  (checkout)');
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
