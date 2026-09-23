import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';
import { EnvHandler, describeEnvYamlShapeProblem, resolveDeliverableEnvVariables } from '../resources/env.js';
import { TEAMAI_ENV_START, TEAMAI_ENV_END } from '../types.js';
import type { TeamaiConfig, LocalConfig, ResourceItem } from '../types.js';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

/**
 * The source line `generateShellBlock` must emit for a given teamai home.
 *
 * Built by mirroring the production transform rather than hard-coding a
 * separator: the real path is machine-dependent (`C:\Users\...` on Windows,
 * `/home/...` elsewhere) and the block is asserted from CI runners that are
 * never Windows, so the expectation has to normalise the same way the source
 * does. Only Windows-form paths are rewritten — a POSIX home keeps its
 * backslashes, which are filename characters there, not separators.
 */
const expectedSourceLine = (teamaiHome: string): string => {
  const isWindowsForm = /^[A-Za-z]:[\\/]/.test(teamaiHome) || teamaiHome.startsWith('\\\\');
  const shellHome = isWindowsForm ? teamaiHome.replace(/\\/g, '/') : teamaiHome;
  const envShPath = `'${shellHome}/env.sh'`;
  return `[ -f ${envShPath} ] && source ${envShPath}`;
};

describe('EnvHandler', () => {
  let handler: EnvHandler;
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    handler = new EnvHandler();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-env-test-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'env'));
    await fse.ensureDir(path.join(homeDir, '.teamai'));

    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/bash');
    // These tests exercise the SHELL-based POSIX branch of detectShellProfile;
    // pin the platform so they assert the same thing on a Windows dev machine
    // as they do in CI (ubuntu/macos). The win32 branch has its own tests.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

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
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fse.remove(tmpDir);
  });

  // ─── scanTeamForPull ─────────────────────────────────────

  describe('scanTeamForPull', () => {
    it('should return empty array when env.yaml does not exist', async () => {
      const items = await handler.scanTeamForPull(teamConfig, localConfig);
      expect(items).toEqual([]);
    });

    it('should return resource item when env.yaml exists', async () => {
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      await fse.writeFile(envYamlPath, YAML.stringify({ variables: [] }));

      const items = await handler.scanTeamForPull(teamConfig, localConfig);
      expect(items).toHaveLength(1);
      expect(items[0].name).toBe('env.yaml');
      expect(items[0].type).toBe('env');
      expect(items[0].relativePath).toBe('env/env.yaml');
    });
  });

  // ─── parseEnvYaml ────────────────────────────────────────

  describe('parseEnvYaml', () => {
    it('should parse valid env.yaml', async () => {
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      await fse.writeFile(envYamlPath, YAML.stringify({
        variables: [
          { key: 'FOO', value: 'bar', description: 'test var' },
          { key: 'BAZ', value: 'qux' },
        ],
      }));

      const result = await handler.parseEnvYaml(envYamlPath);
      expect(result.variables).toHaveLength(2);
      expect(result.variables[0]).toEqual({ key: 'FOO', value: 'bar', description: 'test var' });
      expect(result.variables[1]).toEqual({ key: 'BAZ', value: 'qux' });
    });

    it('should return empty variables for non-existent file', async () => {
      const result = await handler.parseEnvYaml('/no/such/file.yaml');
      expect(result.variables).toEqual([]);
    });

    it('should return empty variables for invalid yaml', async () => {
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      await fse.writeFile(envYamlPath, ':::invalid yaml[[[');

      const result = await handler.parseEnvYaml(envYamlPath);
      expect(result.variables).toEqual([]);
    });

    it('should default variables to empty array when missing', async () => {
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      await fse.writeFile(envYamlPath, YAML.stringify({ other: 'data' }));

      const result = await handler.parseEnvYaml(envYamlPath);
      expect(result.variables).toEqual([]);
    });
  });

  // ─── writeEnvYaml ────────────────────────────────────────

  // ─── describeEnvYamlShapeProblem ─────────────────────────

  describe('describeEnvYamlShapeProblem', () => {
    it('reports a mapping with no variables key but other top-level keys', () => {
      const warning = describeEnvYamlShapeProblem({ FOO: 'bar', BAZ: 'qux' });

      expect(warning).toContain('no top-level `variables:` key');
      expect(warning).toContain('`FOO`');
      expect(warning).toContain('`BAZ`');
      expect(warning).toContain('`key`/`value`');
    });

    it('stays silent for a valid variables list', () => {
      expect(describeEnvYamlShapeProblem({ variables: [{ key: 'A', value: 'b' }] })).toBeNull();
    });

    it('stays silent when an extra top-level key rides along with variables', () => {
      // Must stay permissive: a team repo already shipping this shape has to
      // keep delivering rather than start failing to parse.
      expect(describeEnvYamlShapeProblem({ variables: [], extra: true })).toBeNull();
    });

    it('stays silent for an empty or absent mapping', () => {
      expect(describeEnvYamlShapeProblem({})).toBeNull();
      expect(describeEnvYamlShapeProblem(null)).toBeNull();
      expect(describeEnvYamlShapeProblem(undefined)).toBeNull();
    });

    it('stays silent for documents that are not mappings', () => {
      expect(describeEnvYamlShapeProblem([])).toBeNull();
      expect(describeEnvYamlShapeProblem('FOO=bar')).toBeNull();
      expect(describeEnvYamlShapeProblem(42)).toBeNull();
    });
  });

  describe('writeEnvYaml', () => {
    it('should write env.yaml correctly', async () => {
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      const envConfig = {
        variables: [{ key: 'MY_VAR', value: 'hello' }],
      };

      await handler.writeEnvYaml(envYamlPath, envConfig);

      const content = await fse.readFile(envYamlPath, 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables).toHaveLength(1);
      expect(parsed.variables[0].key).toBe('MY_VAR');
      expect(parsed.variables[0].value).toBe('hello');
    });

    it('should create parent directories if needed', async () => {
      const envYamlPath = path.join(tmpDir, 'new', 'dir', 'env.yaml');
      await handler.writeEnvYaml(envYamlPath, { variables: [] });
      expect(await fse.pathExists(envYamlPath)).toBe(true);
    });
  });

  // ─── countEnvVars ────────────────────────────────────────

  describe('countEnvVars', () => {
    it('should count variables in env.yaml', async () => {
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      await fse.writeFile(envYamlPath, YAML.stringify({
        variables: [
          { key: 'A', value: '1' },
          { key: 'B', value: '2' },
          { key: 'C', value: '3' },
        ],
      }));

      const count = await handler.countEnvVars(envYamlPath);
      expect(count).toBe(3);
    });

    it('should return 0 for non-existent file', async () => {
      const count = await handler.countEnvVars('/no/such/file.yaml');
      expect(count).toBe(0);
    });

    it('should return 0 for invalid yaml', async () => {
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      await fse.writeFile(envYamlPath, ':::bad');

      const count = await handler.countEnvVars(envYamlPath);
      expect(count).toBe(0);
    });

    it('counts the declared total, which the pull summary pairs with the deliverable one', async () => {
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      await fse.writeFile(envYamlPath, YAML.stringify({
        variables: [
          { key: 'A', value: '1', projects: ['checkout'] },
          { key: 'B', value: '2', projects: ['billing'] },
          { key: 'C', value: '3' },
        ],
      }));

      // `pullForScope` pairs this with resolveDeliverableEnvVariables to print
      // "Synced 2 of 3". The count itself stays unfiltered (see #662 above).
      expect(await handler.countEnvVars(envYamlPath)).toBe(3);
      const read = await handler.readEnvYaml(envYamlPath);
      expect(read.ok && resolveDeliverableEnvVariables(read.variables, { roles: null, projects: ['checkout'] }))
        .toHaveLength(2);
      expect(read.ok && resolveDeliverableEnvVariables(read.variables, { roles: null, projects: null }))
        .toHaveLength(3);
    });

    it('counts what the team declares, not what reaches this member', async () => {
      // countEnvVars gates the #662 "no variables: key" warning in pull.ts: a
      // count of 0 means the file may be malformed. Filtering it would fire that
      // warning at a member scoped out of every variable, on a valid file.
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      await fse.writeFile(envYamlPath, YAML.stringify({
        variables: [
          { key: 'A', value: '1', projects: ['checkout'] },
          { key: 'B', value: '2', roles: ['devops'] },
        ],
      }));

      expect(await handler.countEnvVars(envYamlPath)).toBe(2);
    });
  });

  // ─── membership scoping ──────────────────────────────────

  describe('resolveDeliverableEnvVariables', () => {
    const variables = [
      { key: 'CHECKOUT_URL', value: 'c', projects: ['checkout'] },
      { key: 'BILLING_URL', value: 'b', projects: ['billing'] },
      { key: 'DEVOPS_TOKEN', value: 'd', roles: ['devops'] },
      { key: 'FE_CHECKOUT', value: 'f', roles: ['frontend'], projects: ['checkout'] },
      { key: 'SHARED', value: 's' },
      { key: 'NOBODY', value: 'n', projects: [] },
    ];
    const keys = (m: { roles: string[] | null; projects: string[] | null }) =>
      resolveDeliverableEnvVariables(variables, m).map((v) => v.key);

    it('delivers every variable to a member who has configured neither axis', () => {
      expect(keys({ roles: null, projects: null })).toEqual([
        'CHECKOUT_URL', 'BILLING_URL', 'DEVOPS_TOKEN', 'FE_CHECKOUT', 'SHARED', 'NOBODY',
      ]);
    });

    it('delivers a project-scoped variable only to a directory bound to that project', () => {
      expect(keys({ roles: null, projects: ['checkout'] }))
        .toEqual(['CHECKOUT_URL', 'DEVOPS_TOKEN', 'FE_CHECKOUT', 'SHARED']);
    });

    it('delivers a role-scoped variable only to a member holding that role', () => {
      expect(keys({ roles: ['devops'], projects: null }))
        .toEqual(['CHECKOUT_URL', 'BILLING_URL', 'DEVOPS_TOKEN', 'SHARED', 'NOBODY']);
    });

    it('requires both axes when a variable scopes both (AND, not OR)', () => {
      expect(keys({ roles: ['frontend'], projects: ['checkout'] })).toContain('FE_CHECKOUT');
      expect(keys({ roles: ['frontend'], projects: ['billing'] })).not.toContain('FE_CHECKOUT');
      expect(keys({ roles: ['devops'], projects: ['checkout'] })).not.toContain('FE_CHECKOUT');
    });

    it('can filter every variable away', () => {
      expect(keys({ roles: ['pm'], projects: ['legacy'] })).toEqual(['SHARED']);
    });
  });

  // ─── generateShellBlock ──────────────────────────────────

  describe('generateShellBlock', () => {
    it('should generate source line block with markers', () => {
      const block = handler.generateShellBlock('/home/dev/.teamai');

      expect(block).toContain(TEAMAI_ENV_START);
      expect(block).toContain(TEAMAI_ENV_END);
      expect(block).toContain('# DO NOT EDIT: This section is auto-managed by teamai');
      expect(block).toContain(expectedSourceLine('/home/dev/.teamai'));
      // Should NOT contain inline export lines
      expect(block).not.toMatch(/^export /m);
    });

    it('normalises a Windows path so the block still loads from a POSIX shell', () => {
      // Even on Windows the block is read back by bash/zsh, where the native
      // form `C:\Users\me\.teamai` is an escape-laden string: `[ -f ... ]`
      // fails and `source` never runs, with nothing reporting it (#661).
      const block = handler.generateShellBlock('C:\\Users\\me\\.teamai');

      expect(block).toContain(
        "[ -f 'C:/Users/me/.teamai/env.sh' ] && source 'C:/Users/me/.teamai/env.sh'",
      );
    });

    it('leaves a backslash in a POSIX home alone', () => {
      // On POSIX a backslash is an ordinary filename character; collapsing it
      // would point the block at a different directory (bot review on #680).
      const block = handler.generateShellBlock('/home/a\\b/.teamai');

      expect(block).toContain(expectedSourceLine('/home/a\\b/.teamai'));
      expect(block).toContain(
        "[ -f '/home/a\\b/.teamai/env.sh' ] && source '/home/a\\b/.teamai/env.sh'",
      );
    });

    it('quotes the path so a home directory containing a space cannot break the block', () => {
      const block = handler.generateShellBlock('C:\\Users\\John Doe\\.teamai');

      expect(block).toContain(expectedSourceLine('C:\\Users\\John Doe\\.teamai'));
      expect(block).toContain(
        "[ -f 'C:/Users/John Doe/.teamai/env.sh' ] && source 'C:/Users/John Doe/.teamai/env.sh'",
      );
    });
  });

  // ─── generateEnvFile ─────────────────────────────────────

  describe('generateEnvFile', () => {
    it('should generate export lines for env.sh', () => {
      const content = handler.generateEnvFile([
        { key: 'API_URL', value: 'https://example.com' },
        { key: 'TOKEN', value: 'abc123' },
      ]);

      expect(content).toBe(
        "export API_URL='https://example.com'\nexport TOKEN='abc123'\n",
      );
    });

    it('should shell-quote values containing shell metacharacters', () => {
      // Values flow from the team repo's env/env.yaml into env.sh, which every
      // member sources from their shell profile. Quotes / `$` / backticks must
      // be taken literally and must not break or inject into the sourced shell.
      const content = handler.generateEnvFile([
        { key: 'CONN', value: 'a"b$c' },
        { key: 'GREETING', value: "it's" },
      ]);

      expect(content).toBe(
        "export CONN='a\"b$c'\nexport GREETING='it'\\''s'\n",
      );
      // No raw double-quote wrapping that the old code produced.
      expect(content).not.toContain('="a');
    });

    it('should return just a newline for empty variables', () => {
      const content = handler.generateEnvFile([]);
      expect(content).toBe('\n');
    });
  });

  // ─── pullItem ────────────────────────────────────────────

  describe('pullItem', () => {
    const envYaml = {
      variables: [
        { key: 'TGIT_API_BASE', value: 'https://git.woa.com/api/v3', description: 'TGit API' },
        { key: 'MODEL_ENDPOINT', value: 'https://api.example.com' },
      ],
    };

    let item: ResourceItem;

    beforeEach(async () => {
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      await fse.writeFile(envYamlPath, YAML.stringify(envYaml));
      item = {
        name: 'env.yaml',
        type: 'env',
        sourcePath: envYamlPath,
        relativePath: 'env/env.yaml',
      };
    });

    it('should write backup to ~/.teamai/env in KEY=VALUE format', async () => {
      await handler.pullItem(item, teamConfig, localConfig);

      const backupPath = path.join(homeDir, '.teamai', 'env');
      expect(await fse.pathExists(backupPath)).toBe(true);
      const content = await fse.readFile(backupPath, 'utf-8');
      expect(content).toContain('TGIT_API_BASE=https://git.woa.com/api/v3');
      expect(content).toContain('MODEL_ENDPOINT=https://api.example.com');
    });

    it('should write ~/.teamai/env.sh with export lines', async () => {
      await handler.pullItem(item, teamConfig, localConfig);

      const envShPath = path.join(homeDir, '.teamai', 'env.sh');
      expect(await fse.pathExists(envShPath)).toBe(true);
      const content = await fse.readFile(envShPath, 'utf-8');
      expect(content).toContain("export TGIT_API_BASE='https://git.woa.com/api/v3'");
      expect(content).toContain("export MODEL_ENDPOINT='https://api.example.com'");
    });

    it('should inject source line into shell profile (bash)', async () => {
      vi.stubEnv('SHELL', '/bin/bash');
      const bashrcPath = path.join(homeDir, '.bashrc');
      await fse.writeFile(bashrcPath, '# existing config\nexport PATH=$PATH\n');

      await handler.pullItem(item, teamConfig, localConfig);

      const content = await fse.readFile(bashrcPath, 'utf-8');
      expect(content).toContain('# existing config');
      expect(content).toContain(TEAMAI_ENV_START);
      expect(content).toContain(expectedSourceLine(`${homeDir}/.teamai`));
      expect(content).toContain(TEAMAI_ENV_END);
      // Should NOT have inline export lines in the profile
      expect(content).not.toContain('export TGIT_API_BASE');
    });

    it('should inject source line into .zshrc for zsh users', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const zshrcPath = path.join(homeDir, '.zshrc');
      await fse.writeFile(zshrcPath, '# zsh config\n');

      await handler.pullItem(item, teamConfig, localConfig);

      const content = await fse.readFile(zshrcPath, 'utf-8');
      expect(content).toContain(TEAMAI_ENV_START);
      expect(content).toContain(expectedSourceLine(`${homeDir}/.teamai`));
    });

    it('should idempotently replace existing block (including old-style with exports)', async () => {
      vi.stubEnv('SHELL', '/bin/bash');
      const bashrcPath = path.join(homeDir, '.bashrc');

      // Existing content with OLD-style env block (inline exports)
      const existingContent = [
        '# my config',
        TEAMAI_ENV_START,
        '# DO NOT EDIT: This section is auto-managed by teamai',
        'export OLD_VAR="old_value"',
        TEAMAI_ENV_END,
        '# other config',
      ].join('\n');
      await fse.writeFile(bashrcPath, existingContent);

      await handler.pullItem(item, teamConfig, localConfig);

      const content = await fse.readFile(bashrcPath, 'utf-8');
      // Old inline export should be gone
      expect(content).not.toContain('OLD_VAR');
      // Source line should be present instead
      expect(content).toContain(expectedSourceLine(`${homeDir}/.teamai`));
      expect(content).toContain('# my config');
      expect(content).toContain('# other config');
      // Only one start/end pair
      expect(content.split(TEAMAI_ENV_START).length).toBe(2);
      expect(content.split(TEAMAI_ENV_END).length).toBe(2);
    });

    it('should create shell profile if it does not exist', async () => {
      vi.stubEnv('SHELL', '/bin/bash');
      const bashrcPath = path.join(homeDir, '.bashrc');
      // Don't create .bashrc — it should be created by pullItem

      await handler.pullItem(item, teamConfig, localConfig);

      expect(await fse.pathExists(bashrcPath)).toBe(true);
      const content = await fse.readFile(bashrcPath, 'utf-8');
      expect(content).toContain(TEAMAI_ENV_START);
    });

    // Regression (#693 review round 7): Git for Windows' own
    // /etc/profile.d/bash_profile.sh auto-generates ~/.bash_profile (a plain
    // forwarding file, not a symlink) the first time a login shell starts
    // with ~/.bashrc present but none of the other candidates. Without
    // sticking to wherever the block already lives, the next pull would
    // prefer that newly-existing .bash_profile and inject a second, separate
    // block there instead of updating the one already in .bashrc.
    // Root writes a read-only file, and Windows has no POSIX mode bits.
    const cannotRevokeWrite = process.platform === 'win32' || process.getuid?.() === 0;
    it.skipIf(cannotRevokeWrite)('leaves an unchanged shell profile alone on a repeat pull', async () => {
      // pullItem runs on every pull, including the revision fast path a
      // SessionStart hook takes each session. A profile that already carries
      // the block must not be rewritten: made read-only here, so a write would
      // throw rather than merely bump a timestamp.
      const bashrcPath = path.join(homeDir, '.bashrc');
      await handler.pullItem(item, teamConfig, localConfig);
      const first = await fse.readFile(bashrcPath, 'utf-8');
      expect(first).toContain(TEAMAI_ENV_START);

      await fse.chmod(bashrcPath, 0o444);
      try {
        await expect(handler.pullItem(item, teamConfig, localConfig)).resolves.toBeUndefined();
      } finally {
        await fse.chmod(bashrcPath, 0o644);
      }
      expect(await fse.readFile(bashrcPath, 'utf-8')).toBe(first);
    });

    it('keeps updating .bashrc in place after Git for Windows auto-generates a forwarding .bash_profile', async () => {
      vi.stubEnv('SHELL', '');
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const bashrcPath = path.join(homeDir, '.bashrc');
      const bashProfilePath = path.join(homeDir, '.bash_profile');

      // First pull: nothing exists yet, falls back to .bashrc.
      await handler.pullItem(item, teamConfig, localConfig);
      expect(await fse.pathExists(bashrcPath)).toBe(true);
      expect(await fse.pathExists(bashProfilePath)).toBe(false);

      // Git for Windows generates the forwarding .bash_profile on its own,
      // between the two pulls — teamai never wrote this file.
      await fse.writeFile(
        bashProfilePath,
        '# generated by Git for Windows\ntest -f ~/.profile && . ~/.profile\ntest -f ~/.bashrc && . ~/.bashrc\n',
      );

      await handler.pullItem(item, teamConfig, localConfig);

      const bashrcContent = await fse.readFile(bashrcPath, 'utf-8');
      expect(bashrcContent).toContain(TEAMAI_ENV_START);
      expect(bashrcContent.split(TEAMAI_ENV_START).length).toBe(2);

      const bashProfileContent = await fse.readFile(bashProfilePath, 'utf-8');
      expect(bashProfileContent).not.toContain(TEAMAI_ENV_START);
    });

    it('should skip shell injection when injectShellProfile is false', async () => {
      const noInjectConfig: TeamaiConfig = {
        ...teamConfig,
        sharing: {
          ...teamConfig.sharing,
          env: { injectShellProfile: false },
        },
      };

      vi.stubEnv('SHELL', '/bin/bash');
      const bashrcPath = path.join(homeDir, '.bashrc');
      await fse.writeFile(bashrcPath, '# original\n');

      await handler.pullItem(item, noInjectConfig, localConfig);

      // Backup and env.sh should still be written
      const backupPath = path.join(homeDir, '.teamai', 'env');
      expect(await fse.pathExists(backupPath)).toBe(true);
      const envShPath = path.join(homeDir, '.teamai', 'env.sh');
      expect(await fse.pathExists(envShPath)).toBe(true);

      // Shell profile should NOT be modified
      const content = await fse.readFile(bashrcPath, 'utf-8');
      expect(content).toBe('# original\n');
      expect(content).not.toContain(TEAMAI_ENV_START);
    });

    it('should use custom shellProfilePath when specified', async () => {
      const customPath = path.join(tmpDir, 'custom_profile');
      await fse.writeFile(customPath, '# custom\n');

      const customConfig: TeamaiConfig = {
        ...teamConfig,
        sharing: {
          ...teamConfig.sharing,
          env: { injectShellProfile: true, shellProfilePath: customPath },
        },
      };

      await handler.pullItem(item, customConfig, localConfig);

      const content = await fse.readFile(customPath, 'utf-8');
      expect(content).toContain(TEAMAI_ENV_START);
      expect(content).toContain(expectedSourceLine(`${homeDir}/.teamai`));
    });

    it('should skip when env.yaml has no variables', async () => {
      const emptyYamlPath = path.join(repoPath, 'env', 'empty.yaml');
      await fse.writeFile(emptyYamlPath, YAML.stringify({ variables: [] }));

      const emptyItem: ResourceItem = {
        name: 'empty.yaml',
        type: 'env',
        sourcePath: emptyYamlPath,
        relativePath: 'env/empty.yaml',
      };

      vi.stubEnv('SHELL', '/bin/bash');
      const bashrcPath = path.join(homeDir, '.bashrc');
      await fse.writeFile(bashrcPath, '# original\n');

      await handler.pullItem(emptyItem, teamConfig, localConfig);

      const content = await fse.readFile(bashrcPath, 'utf-8');
      expect(content).toBe('# original\n');
    });

    it('delivers only the variables this member and directory are scoped to', async () => {
      const scopedPath = path.join(repoPath, 'env', 'scoped.yaml');
      await fse.writeFile(scopedPath, YAML.stringify({
        variables: [
          { key: 'CHECKOUT_URL', value: 'https://checkout.example.com', projects: ['checkout'] },
          { key: 'BILLING_URL', value: 'https://billing.example.com', projects: ['billing'] },
          { key: 'SHARED', value: 'everyone' },
        ],
      }));
      const scopedItem: ResourceItem = {
        name: 'scoped.yaml', type: 'env', sourcePath: scopedPath, relativePath: 'env/scoped.yaml',
      };

      await handler.pullItem(scopedItem, teamConfig, { ...localConfig, projects: ['checkout'] });

      const envSh = await fse.readFile(path.join(homeDir, '.teamai', 'env.sh'), 'utf-8');
      expect(envSh).toContain('export CHECKOUT_URL=');
      expect(envSh).toContain('export SHARED=');
      expect(envSh).not.toContain('BILLING_URL');

      // The KEY=value backup mcp-reconcile resolves ${VAR} from must match, or a
      // server would resolve a variable the member's shell never exported.
      const backup = await fse.readFile(path.join(homeDir, '.teamai', 'env'), 'utf-8');
      expect(backup).toContain('CHECKOUT_URL=');
      expect(backup).not.toContain('BILLING_URL');
    });

    it('removes a variable from env.sh once the directory stops being bound to its project', async () => {
      const scopedPath = path.join(repoPath, 'env', 'scoped.yaml');
      await fse.writeFile(scopedPath, YAML.stringify({
        variables: [
          { key: 'CHECKOUT_URL', value: 'c', projects: ['checkout'] },
          { key: 'SHARED', value: 's' },
        ],
      }));
      const scopedItem: ResourceItem = {
        name: 'scoped.yaml', type: 'env', sourcePath: scopedPath, relativePath: 'env/scoped.yaml',
      };
      const envShPath = path.join(homeDir, '.teamai', 'env.sh');

      await handler.pullItem(scopedItem, teamConfig, { ...localConfig, projects: ['checkout'] });
      expect(await fse.readFile(envShPath, 'utf-8')).toContain('CHECKOUT_URL');

      await handler.pullItem(scopedItem, teamConfig, { ...localConfig, projects: ['billing'] });
      const after = await fse.readFile(envShPath, 'utf-8');
      expect(after).not.toContain('CHECKOUT_URL');
      expect(after).toContain('SHARED');
    });

    it('writes an empty env.sh, and still injects, when every variable is filtered out', async () => {
      // The team declares variables, so this is not the "nothing declared" skip:
      // the member must end up with an env.sh that exports nothing, which is what
      // removes variables a previous pull had given them.
      const scopedPath = path.join(repoPath, 'env', 'scoped.yaml');
      await fse.writeFile(scopedPath, YAML.stringify({
        variables: [{ key: 'CHECKOUT_URL', value: 'c', projects: ['checkout'] }],
      }));
      const scopedItem: ResourceItem = {
        name: 'scoped.yaml', type: 'env', sourcePath: scopedPath, relativePath: 'env/scoped.yaml',
      };
      vi.stubEnv('SHELL', '/bin/bash');
      await fse.writeFile(path.join(homeDir, '.bashrc'), '# original\n');

      await handler.pullItem(scopedItem, teamConfig, { ...localConfig, projects: ['billing'] });

      const envSh = await fse.readFile(path.join(homeDir, '.teamai', 'env.sh'), 'utf-8');
      expect(envSh.trim()).toBe('');
      expect(await fse.readFile(path.join(homeDir, '.bashrc'), 'utf-8')).toContain(TEAMAI_ENV_START);
    });

    it('should handle invalid env.yaml gracefully', async () => {
      const badYamlPath = path.join(repoPath, 'env', 'bad.yaml');
      await fse.writeFile(badYamlPath, ':::bad yaml');

      const badItem: ResourceItem = {
        name: 'bad.yaml',
        type: 'env',
        sourcePath: badYamlPath,
        relativePath: 'env/bad.yaml',
      };

      vi.stubEnv('SHELL', '/bin/bash');
      const bashrcPath = path.join(homeDir, '.bashrc');
      await fse.writeFile(bashrcPath, '# original\n');

      await handler.pullItem(badItem, teamConfig, localConfig);

      // Should not crash and should not modify shell profile
      const content = await fse.readFile(bashrcPath, 'utf-8');
      expect(content).toBe('# original\n');
    });

    it('reports the missing `variables:` key from a real env.yaml file', async () => {
      // The shape zod used to swallow: a bare key/value mapping. The file
      // parses cleanly, so the pull looked successful while nothing shipped
      // (#662). `pullForScope` reads it through this method, because it skips
      // the resource before `pullItem` — where the check used to live — runs.
      const shapeYamlPath = path.join(repoPath, 'env', 'shape.yaml');
      await fse.writeFile(shapeYamlPath, 'FOO: bar\nBAZ: qux\n');

      const problem = await handler.describeEnvYamlShapeProblemAt(shapeYamlPath);

      expect(problem).toContain('no top-level `variables:` key');
      expect(problem).toContain('`FOO`');
      expect(problem).toContain('`BAZ`');
    });

    it('reports nothing for a usable, empty, malformed or missing env.yaml', async () => {
      const okPath = path.join(repoPath, 'env', 'ok.yaml');
      await fse.writeFile(okPath, YAML.stringify({ variables: [{ key: 'A', value: 'b' }] }));
      expect(await handler.describeEnvYamlShapeProblemAt(okPath)).toBeNull();

      const emptyPath = path.join(repoPath, 'env', 'empty.yaml');
      await fse.writeFile(emptyPath, YAML.stringify({ variables: [] }));
      expect(await handler.describeEnvYamlShapeProblemAt(emptyPath)).toBeNull();

      // Malformed YAML is a separate failure and must not be dressed up as a
      // shape problem.
      const brokenPath = path.join(repoPath, 'env', 'broken.yaml');
      await fse.writeFile(brokenPath, 'variables: [unclosed\n');
      expect(await handler.describeEnvYamlShapeProblemAt(brokenPath)).toBeNull();

      expect(
        await handler.describeEnvYamlShapeProblemAt(path.join(repoPath, 'env', 'absent.yaml')),
      ).toBeNull();
    });
  });

  // ─── removeItem ──────────────────────────────────────────

  describe('removeItem', () => {
    it('should return empty array and warn', async () => {
      const { log } = await import('../utils/logger.js');
      const result = await handler.removeItem('test', teamConfig, localConfig);
      expect(result).toEqual([]);
      expect(log.warn).toHaveBeenCalled();
    });
  });
});
