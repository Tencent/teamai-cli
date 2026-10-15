import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';
import { execFileSync, spawnSync } from 'node:child_process';
import { EnvHandler, describeEnvYamlShapeProblem, parseEnvFile, parseEnvFileKept, readEnvBackup } from '../resources/env.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import { TEAMAI_ENV_START, TEAMAI_ENV_END } from '../types.js';
import { memberEnvironment } from '../member-env.js';
import type { TeamaiConfig, LocalConfig, ResourceItem } from '../types.js';

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
}));

/**
 * The source line `generateShellBlock` must emit for a given env loader script.
 *
 * Built by mirroring the production transform rather than hard-coding a
 * separator: the real path is machine-dependent (`C:\Users\...` on Windows,
 * `/home/...` elsewhere) and the block is asserted from CI runners that are
 * never Windows, so the expectation has to normalise the same way the source
 * does. Only Windows-form paths are rewritten — a POSIX home keeps its
 * backslashes, which are filename characters there, not separators.
 */
const expectedSourceLine = (loaderPath: string): string => {
  const isWindowsForm = /^[A-Za-z]:[\\/]/.test(loaderPath) || loaderPath.startsWith('\\\\');
  const quoted = `'${isWindowsForm ? loaderPath.replace(/\\/g, '/') : loaderPath}'`;
  return `[ -f ${quoted} ] && . ${quoted}`;
};

describe('EnvHandler', () => {
  let handler: EnvHandler;
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    resetWarnOnce();
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

  describe('scanLocalForPush (#707)', () => {
    const run = (args: string[]): void => {
      execFileSync('git', args, {
        cwd: repoPath,
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      });
    };

    it('reports each changed env file, namespace files included, and skips unchanged ones', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), 'variables: []\n');
      await fse.outputFile(path.join(repoPath, 'env', 'billing', 'env.yaml'), 'variables: []\n');
      run(['init', '-q', '-b', 'main']);
      run(['add', '-A']);
      run(['commit', '-q', '-m', 'seed']);

      await fse.outputFile(path.join(repoPath, 'env', 'checkout', 'env.yaml'), 'variables:\n  - key: A\n    value: b\n');
      await fse.writeFile(path.join(repoPath, 'env', 'billing', 'env.yaml'), 'variables:\n  - key: B\n    value: c\n');

      const items = await handler.scanLocalForPush(teamConfig, localConfig);
      expect(items.map((item) => item.relativePath)).toEqual(['env/billing/env.yaml', 'env/checkout/env.yaml']);
      expect(items.map((item) => item.name)).toEqual(['billing/env.yaml', 'checkout/env.yaml']);
    });

    // #875: a declared secret is published by push like a variable.
    it('reports a changed secrets file, root and namespace', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), 'variables: []\n');
      run(['init', '-q', '-b', 'main']);
      run(['add', '-A']);
      run(['commit', '-q', '-m', 'seed']);

      await fse.writeFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: GITHUB_TOKEN\n');
      await fse.outputFile(path.join(repoPath, 'env', 'checkout', 'secrets.yaml'), 'secrets:\n  - key: NPM_TOKEN\n');

      const items = await handler.scanLocalForPush(teamConfig, localConfig);
      expect(items.map((item) => item.relativePath)).toEqual(['env/secrets.yaml', 'env/checkout/secrets.yaml']);
    });

    // git quotes a non-ASCII path in its default output, so it never matched.
    it('reports a changed namespace file whose name is not ASCII', async () => {
      await fse.outputFile(path.join(repoPath, 'env', 'café', 'env.yaml'), 'variables: []\n');
      run(['init', '-q', '-b', 'main']);
      run(['add', '-A']);
      run(['commit', '-q', '-m', 'seed']);

      await fse.writeFile(path.join(repoPath, 'env', 'café', 'env.yaml'), 'variables:\n  - key: A\n    value: b\n');

      const items = await handler.scanLocalForPush(teamConfig, localConfig);
      expect(items.map((item) => item.relativePath)).toEqual(['env/café/env.yaml']);
    });
  });

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

  // ─── generateShellBlock ──────────────────────────────────

  describe('generateShellBlock', () => {
    it('should generate source line block with markers', () => {
      const block = handler.generateShellBlock('/home/dev/.teamai/env-loader.sh');

      expect(block).toContain(TEAMAI_ENV_START);
      expect(block).toContain(TEAMAI_ENV_END);
      expect(block).toContain('# DO NOT EDIT: This section is auto-managed by teamai');
      expect(block).toContain(expectedSourceLine('/home/dev/.teamai/env-loader.sh'));
      // Should NOT contain inline export lines
      expect(block).not.toMatch(/^export /m);
    });

    it('normalises a Windows path so the block still loads from a POSIX shell', () => {
      // Even on Windows the block is read back by bash/zsh, where the native
      // form `C:\Users\me\.teamai` is an escape-laden string: `[ -f ... ]`
      // fails and `source` never runs, with nothing reporting it (#661).
      const block = handler.generateShellBlock('C:\\Users\\me\\.teamai\\env-loader.sh');

      expect(block).toContain(
        "[ -f 'C:/Users/me/.teamai/env-loader.sh' ] && . 'C:/Users/me/.teamai/env-loader.sh'",
      );
    });

    it('leaves a backslash in a POSIX home alone', () => {
      // On POSIX a backslash is an ordinary filename character; collapsing it
      // would point the block at a different directory (bot review on #680).
      const block = handler.generateShellBlock('/home/a\\b/.teamai/env-loader.sh');

      expect(block).toContain(
        "[ -f '/home/a\\b/.teamai/env-loader.sh' ] && . '/home/a\\b/.teamai/env-loader.sh'",
      );
    });

    it('quotes the path so a home directory containing a space cannot break the block', () => {
      const block = handler.generateShellBlock('C:\\Users\\John Doe\\.teamai\\env-loader.sh');

      expect(block).toContain(
        "[ -f 'C:/Users/John Doe/.teamai/env-loader.sh' ] && . 'C:/Users/John Doe/.teamai/env-loader.sh'",
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

    // env.sh is POSIX sh: sourced by any of these, and read back, each value is
    // exact. The keys the loader takes from it are covered in env-loader.test.ts.
    it.each(['dash', 'bash', 'zsh'].filter((shell) => spawnSync(shell, ['-c', 'true']).status === 0))('writes values that %s and parseEnvFile read back exactly', async (shell) => {
      const values = {
        MULTI: 'a\nexport AWS_SECRET_ACCESS_KEY=x\nb',
        TRAILING: 'line one\nline two\n',
        CONTROL: `cr\rtab\tbell\x07del\x7fsoh\x01esc\x1b`,
        ESCAPES: "back\\slash 'quote' $'ansi' \\n not a newline\n\\101",
        PLAIN: "it's $HOME `x` \"q\" é",
      };
      const content = handler.generateEnvFile(Object.entries(values).map(([key, value]) => ({ key, value })));
      const file = path.join(tmpDir, 'env.sh');
      await fse.writeFile(file, content);
      const run = spawnSync(shell, ['-c', `. "$1"; for k in ${Object.keys(values).join(' ')}; do printf '%s\\0' "$(eval "printf '%s.' \\"\\$$k\\"")"; done`, 'teamai', file], { encoding: 'utf-8' });

      expect(Object.fromEntries(parseEnvFile(content))).toEqual(values);
      expect(run.stdout.split('\0').slice(0, -1).map((v) => v.slice(0, -1)), run.stderr).toEqual(Object.values(values));
    });

    it('should return just a newline for empty variables', () => {
      const content = handler.generateEnvFile([]);
      expect(content).toBe('\n');
    });

    it('should drop keys that are not valid shell identifiers', () => {
      // A key is interpolated raw into `export <key>=...`, so anything that is
      // not an identifier either breaks the line or runs as shell code. The
      // whole variable is dropped, not the line rewritten: `parseEnvFile` skips
      // such a line anyway, so emitting it would put a variable in env.sh that
      // the CLI can never read back.
      const content = handler.generateEnvFile([
        { key: 'GOOD_KEY', value: 'ok' },
        { key: 'bad key', value: 'oops' },
        { key: 'FOO;touch /tmp/pwned', value: 'y' },
        { key: '$(whoami)', value: 'w' },
        { key: 'A=B', value: 'z' },
        { key: '9LEADING', value: 'n' },
      ]);

      expect(content).toBe("export GOOD_KEY='ok'\n");
    });

    it('should keep keys that are valid shell identifiers', () => {
      // The guard must not narrow what a legitimate team repo can express:
      // digits and underscores after the first character are all valid.
      const content = handler.generateEnvFile([
        { key: '_PRIVATE', value: 'a' },
        { key: 'A1_b2', value: 'b' },
      ]);

      expect(content).toBe("export _PRIVATE='a'\nexport A1_b2='b'\n");
    });

    // Doctor reads the kept keys back; on Windows a line matches every spelling.
    it.each([
      { platform: 'linux', key: 'tOKEN_2', pattern: 'tOKEN_2' },
      { platform: 'win32', key: 'tOKEN_2', pattern: '[tT][Oo][Kk][Ee][Nn]_2' },
    ] as const)('keeps $key from the user scope on $platform with the pattern $pattern, and reads it back', ({ platform, key, pattern }) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      const content = handler.generateEnvFile([], [key]);

      expect(content).toContain(`*" "${pattern}" "*)`);
      expect(parseEnvFileKept(content)).toEqual(new Set([key]));
    });

    // As the shell reads it: a kept-key line inside a multiline value is text.
    it('reads back only the kept keys the file declares, never a line inside a value', () => {
      const content = handler.generateEnvFile([{ key: 'MULTI', value: `a\ncase " \${__teamai_keys-} " in *" "TOKEN" "*) __teamai_env_keep 'TOKEN' ;; esac\nb` }], ['KEPT']);

      expect(parseEnvFileKept(content)).toEqual(new Set(['KEPT']));
    });

    it.each(['BASH_ENV', 'ENV', 'ZDOTDIR', 'HOME', 'home', 'PROMPT_COMMAND', 'chpwd_functions', 'precmd_functions', 'preexec_functions', 'periodic_functions', 'zshaddhistory_functions', 'zshexit_functions', 'zsh_directory_name_functions', '__TEAMAI_ENV_FILES', '__teamai_env_apply'])('should drop reserved loader variable %s', (key) => {
      expect(handler.generateEnvFile([{ key, value: 'team-value' }, { key: 'SAFE', value: 'yes' }]))
        .toBe("export SAFE='yes'\n");
    });

    it('does not mark a filtered reserved value as team-exported', async () => {
      await handler.writeResolvedEnv([{ key: 'BASH_ENV', value: '/tmp/team-bash-env' }], teamConfig, localConfig);

      const member = await memberEnvironment(localConfig, { secretKeys: new Set(), envYaml: new Map() }, { BASH_ENV: '/tmp/team-bash-env' });

      expect(member('BASH_ENV')).toBe('/tmp/team-bash-env');
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

    it('should write backup to ~/.teamai/env as a JSON object of values', async () => {
      await handler.pullItem(item, teamConfig, localConfig);

      const backupPath = path.join(homeDir, '.teamai', 'env');
      expect(await fse.pathExists(backupPath)).toBe(true);
      const content = JSON.parse(await fse.readFile(backupPath, 'utf-8'));
      expect(content.TGIT_API_BASE).toBe('https://git.woa.com/api/v3');
      expect(content.MODEL_ENDPOINT).toBe('https://api.example.com');
    });

    it('reports an unreadable env backup while treating a missing backup as empty', async () => {
      expect(await readEnvBackup(localConfig)).toEqual({});
      const backupPath = path.join(homeDir, '.teamai', 'env');
      await fse.ensureDir(backupPath);

      await expect(readEnvBackup(localConfig)).rejects.toThrow(/env backup.*unreadable/i);
    });

    // Content that starts as JSON is the JSON backup: one that does not parse is corrupt, not an older backup.
    it.each([
      { form: 'JSON', content: '{"A":"1","B":" two\\n"}', expected: { A: '1', B: ' two\n' } },
      { form: 'JSON after whitespace', content: '\n  {"A":"1"}', expected: { A: '1' } },
      { form: 'older KEY=value lines', content: '# comment\nA=1\n B = two \n', expected: { A: '1', B: 'two' } },
      { form: 'truncated JSON', content: '{"A":"1","B":', expected: null },
      { form: 'truncated JSON after whitespace', content: '  {"A"', expected: null },
      { form: 'JSON with a non-string value', content: '{"A":1}', expected: null },
    ])('reads a $form backup', async ({ content, expected }) => {
      await fse.outputFile(path.join(homeDir, '.teamai', 'env'), content);

      if (expected) expect(await readEnvBackup(localConfig)).toEqual(expected);
      else await expect(readEnvBackup(localConfig)).rejects.toThrow(/env backup is unreadable at .*: /i);
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
      expect(content).toContain(expectedSourceLine(`${homeDir}/.teamai/env-loader.sh`));
      expect(content).toContain(TEAMAI_ENV_END);
      // Should NOT have inline export lines in the profile
      expect(content).not.toContain('export TGIT_API_BASE');
    });

    it('should inject source line into .zshenv for zsh users, which every zsh reads', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const zshenvPath = path.join(homeDir, '.zshenv');
      await fse.writeFile(zshenvPath, '# zsh config\n');

      await handler.pullItem(item, teamConfig, localConfig);

      const content = await fse.readFile(zshenvPath, 'utf-8');
      expect(content).toContain(TEAMAI_ENV_START);
      expect(content).toContain(expectedSourceLine(`${homeDir}/.teamai/env-loader.sh`));
    });

    // Only these shells are on PATH.
    const installShells = async (shells: string[]): Promise<void> => {
      const bin = path.join(tmpDir, 'bin');
      await fse.emptyDir(bin);
      for (const shell of shells) await fse.writeFile(path.join(bin, shell), '#!/bin/sh\n', { mode: 0o755 });
      vi.stubEnv('PATH', bin);
    };

    // A member who runs both shells gets the loader in each one's profile, so
    // neither keeps another directory's env after a `cd`. The other shell's
    // profile is created when that shell is installed.
    it.each([
      { shell: '/bin/zsh', own: '.zshenv', other: '.bashrc', otherExists: true, otherInstalled: false, otherGetsLoader: true },
      { shell: '/bin/zsh', own: '.zshenv', other: '.bashrc', otherExists: false, otherInstalled: true, otherGetsLoader: true },
      { shell: '/bin/zsh', own: '.zshenv', other: '.bashrc', otherExists: false, otherInstalled: false, otherGetsLoader: false },
      { shell: '/bin/bash', own: '.bashrc', other: '.zshenv', otherExists: true, otherInstalled: false, otherGetsLoader: true },
      { shell: '/bin/bash', own: '.bashrc', other: '.zshenv', otherExists: false, otherInstalled: true, otherGetsLoader: true },
      { shell: '/bin/bash', own: '.bashrc', other: '.zshenv', otherExists: false, otherInstalled: false, otherGetsLoader: false },
    ])('with SHELL=$shell, ~/$other existing ($otherExists) and its shell installed ($otherInstalled), puts the loader block there: $otherGetsLoader', async ({ shell, own, other, otherExists, otherInstalled, otherGetsLoader }) => {
      vi.stubEnv('SHELL', shell);
      vi.stubEnv('ZDOTDIR', '');
      await installShells(otherInstalled ? [path.basename(other) === '.bashrc' ? 'bash' : 'zsh'] : []);
      if (otherExists) await fse.writeFile(path.join(homeDir, other), '# mine\n');

      await handler.pullItem(item, teamConfig, localConfig);

      const source = expectedSourceLine(`${homeDir}/.teamai/env-loader.sh`);
      expect(await fse.readFile(path.join(homeDir, own), 'utf-8')).toContain(source);
      if (otherGetsLoader) {
        const content = await fse.readFile(path.join(homeDir, other), 'utf-8');
        if (otherExists) expect(content).toContain('# mine');
        expect(content.split(TEAMAI_ENV_START)).toHaveLength(2);
        expect(content).toContain(source);
      } else {
        expect(await fse.pathExists(path.join(homeDir, other))).toBe(false);
      }
    });

    // bash reads .bashrc when interactive and not a login shell, and only the
    // first of .bash_profile, .bash_login, .profile when it is one. Each way
    // gets the block when bash is $SHELL or installed, unless that login file
    // already sources .bashrc. With none of the three, .profile is created:
    // last in bash's order, it shadows no login file the member adds later.
    // A $SHELL that is neither (fish) with no bash installed gets no bash file.
    const bashProfileSourcingBashrc = '[ -f ~/.bashrc ] && . ~/.bashrc\n';
    it.each([
      { shell: '/bin/zsh', installed: ['bash'], existing: { '.bashrc': '', '.bash_profile': '' }, loaderIn: ['.zshenv', '.bashrc', '.bash_profile'] },
      { shell: '/bin/zsh', installed: ['bash'], existing: { '.bashrc': '', '.bash_profile': bashProfileSourcingBashrc }, loaderIn: ['.zshenv', '.bashrc'] },
      { shell: '/bin/zsh', installed: ['bash'], existing: { '.bash_profile': bashProfileSourcingBashrc }, loaderIn: ['.zshenv', '.bashrc'] },
      { shell: '/bin/zsh', installed: [], existing: { '.bash_profile': bashProfileSourcingBashrc }, loaderIn: ['.zshenv', '.bash_profile'] },
      { shell: '/bin/zsh', installed: ['bash'], existing: { '.bash_login': '', '.profile': '' }, loaderIn: ['.zshenv', '.bashrc', '.bash_login'] },
      { shell: '/bin/zsh', installed: ['bash'], existing: { '.profile': '' }, loaderIn: ['.zshenv', '.bashrc', '.profile'] },
      { shell: '/bin/zsh', installed: ['bash'], existing: {}, loaderIn: ['.zshenv', '.bashrc', '.profile'] },
      { shell: '/bin/zsh', installed: [], existing: {}, loaderIn: ['.zshenv'] },
      { shell: '/bin/bash', installed: [], existing: { '.bash_profile': '' }, loaderIn: ['.bashrc', '.bash_profile'] },
      { shell: '/bin/bash', installed: [], existing: { '.bash_profile': bashProfileSourcingBashrc }, loaderIn: ['.bashrc'] },
      { shell: '/bin/bash', installed: [], existing: {}, loaderIn: ['.bashrc', '.profile'] },
      { shell: '/bin/bash', installed: ['zsh'], existing: {}, loaderIn: ['.zshenv', '.bashrc', '.profile'] },
      { shell: '/usr/bin/fish', installed: [], existing: {}, loaderIn: [] },
      { shell: '/usr/bin/fish', installed: [], existing: { '.profile': '' }, loaderIn: [] },
      { shell: '/usr/bin/fish', installed: ['zsh'], existing: {}, loaderIn: ['.zshenv'] },
      { shell: '/usr/bin/fish', installed: ['bash'], existing: {}, loaderIn: ['.bashrc', '.profile'] },
    ].map((row) => ({
      ...row,
      on: row.installed.join(', ') || 'no other shell',
      files: Object.entries(row.existing).map(([name, content]) => (content ? `${name} sourcing .bashrc` : name)).join(', ') || 'none',
      targets: row.loaderIn.join(', '),
    })))('with SHELL=$shell, $on on PATH and existing $files, puts the loader block in exactly $targets', async ({ shell, installed, existing, loaderIn }) => {
      vi.stubEnv('SHELL', shell);
      vi.stubEnv('ZDOTDIR', '');
      await installShells(installed);
      for (const [name, content] of Object.entries(existing)) await fse.writeFile(path.join(homeDir, name), `# mine\n${content}`);

      await handler.pullItem(item, teamConfig, localConfig);

      const names = ['.zshenv', '.bashrc', '.bash_profile', '.bash_login', '.profile'];
      const blocks = async (name: string): Promise<number> =>
        (await fse.readFile(path.join(homeDir, name), 'utf-8').catch(() => '')).split(TEAMAI_ENV_START).length - 1;
      expect(Object.fromEntries(await Promise.all(names.map(async (name) => [name, await blocks(name)]))))
        .toEqual(Object.fromEntries(names.map((name) => [name, loaderIn.includes(name) ? 1 : 0])));
      for (const name of names.filter((name) => !loaderIn.includes(name) && !(name in existing))) {
        expect(await fse.pathExists(path.join(homeDir, name))).toBe(false);
      }
    });

    // A `shellProfilePath` override for bash names the file for the startup
    // mode it serves; bash's other mode still gets the block by the rule
    // above, unless its file already reaches the override.
    it.each([
      { shell: '/bin/bash', installed: [], override: '.bashrc', existing: { '.bash_profile': '' }, loaderIn: ['.bashrc', '.bash_profile'] },
      { shell: '/bin/bash', installed: [], override: '.bashrc', existing: { '.bash_profile': bashProfileSourcingBashrc }, loaderIn: ['.bashrc'] },
      { shell: '/bin/bash', installed: [], override: '.bashrc', existing: {}, loaderIn: ['.bashrc', '.profile'] },
      { shell: '/bin/bash', installed: [], override: '.bash_profile', existing: { '.bash_profile': '' }, loaderIn: ['.bash_profile', '.bashrc'] },
      { shell: '/bin/bash', installed: [], override: '.profile', existing: {}, loaderIn: ['.profile', '.bashrc'] },
      { shell: '/bin/zsh', installed: ['bash'], override: '.bashrc', existing: { '.bash_profile': '' }, loaderIn: ['.zshenv', '.bashrc', '.bash_profile'] },
      { shell: '/bin/zsh', installed: [], override: '.bashrc', existing: {}, loaderIn: ['.zshenv'] },
    ].map((row) => ({
      ...row,
      on: row.installed.join(', ') || 'no other shell',
      files: Object.entries(row.existing).map(([name, content]) => (content ? `${name} sourcing .bashrc` : name)).join(', ') || 'none',
      targets: row.loaderIn.join(', '),
    })))('with SHELL=$shell, $on on PATH, override ~/$override and existing $files, puts the loader block in exactly $targets', async ({ shell, installed, override, existing, loaderIn }) => {
      vi.stubEnv('SHELL', shell);
      vi.stubEnv('ZDOTDIR', '');
      await installShells(installed);
      for (const [name, content] of Object.entries(existing)) await fse.writeFile(path.join(homeDir, name), `# mine\n${content}`);
      const overrideConfig: TeamaiConfig = {
        ...teamConfig,
        sharing: { ...teamConfig.sharing, env: { injectShellProfile: true, shellProfilePath: `~/${override}` } },
      };

      await handler.pullItem(item, overrideConfig, localConfig);

      const names = ['.zshenv', '.bashrc', '.bash_profile', '.bash_login', '.profile'];
      const blocks = async (name: string): Promise<number> =>
        (await fse.readFile(path.join(homeDir, name), 'utf-8').catch(() => '')).split(TEAMAI_ENV_START).length - 1;
      expect(Object.fromEntries(await Promise.all(names.map(async (name) => [name, await blocks(name)]))))
        .toEqual(Object.fromEntries(names.map((name) => [name, loaderIn.includes(name) ? 1 : 0])));
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
      expect(content).toContain(expectedSourceLine(`${homeDir}/.teamai/env-loader.sh`));
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
      expect(content).toContain(expectedSourceLine(`${homeDir}/.teamai/env-loader.sh`));
    });

    it('should install the loader when env.yaml has no variables but the scope is registered for shells', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({ variables: [] }));

      vi.stubEnv('SHELL', '/bin/bash');
      const bashrcPath = path.join(homeDir, '.bashrc');
      await fse.writeFile(bashrcPath, '# original\n');

      await handler.pullItem(item, teamConfig, localConfig);

      const content = await fse.readFile(bashrcPath, 'utf-8');
      expect(content).toContain(TEAMAI_ENV_START);
      expect(content).toContain(expectedSourceLine(`${homeDir}/.teamai/env-loader.sh`));
      expect(await fse.pathExists(path.join(homeDir, '.teamai', 'env.sh'))).toBe(false);
    });

    // ─── namespaces (#707) ────────────────────────────────

    /** A projects manifest where project checkout declares the env namespace `checkout`. */
    async function writeCheckoutProject(): Promise<void> {
      await fse.ensureDir(path.join(repoPath, 'manifest'));
      await fse.writeFile(path.join(repoPath, 'manifest', 'projects.yaml'), YAML.stringify({
        version: 1,
        projects: [
          { id: 'checkout', resources: { env: ['checkout'] } },
          { id: 'billing', resources: { skills: ['billing'] } },
        ],
      }));
    }

    async function writeNamespaceEnv(namespace: string, variables: { key: string; value: string }[]): Promise<void> {
      await fse.ensureDir(path.join(repoPath, 'env', namespace));
      await fse.writeFile(path.join(repoPath, 'env', namespace, 'env.yaml'), YAML.stringify({ variables }));
    }

    const envSh = (): Promise<string> => fse.readFile(path.join(homeDir, '.teamai', 'env.sh'), 'utf-8');

    it('delivers an active namespace variable in place of the root one of the same key', async () => {
      await writeCheckoutProject();
      await writeNamespaceEnv('checkout', [
        { key: 'MODEL_ENDPOINT', value: 'https://checkout.example.com' },
        { key: 'CHECKOUT_ONLY', value: 'yes' },
      ]);

      await handler.pullItem(item, teamConfig, { ...localConfig, projects: ['checkout'] });

      const content = await envSh();
      expect(content).toContain("export MODEL_ENDPOINT='https://checkout.example.com'");
      expect(content).not.toContain('https://api.example.com');
      expect(content).toContain("export CHECKOUT_ONLY='yes'");
      expect(content).toContain('export TGIT_API_BASE=');
    });

    it('restores the root value and drops namespace-only variables once the namespace deactivates', async () => {
      await writeCheckoutProject();
      await writeNamespaceEnv('checkout', [
        { key: 'MODEL_ENDPOINT', value: 'https://checkout.example.com' },
        { key: 'CHECKOUT_ONLY', value: 'yes' },
      ]);

      await handler.pullItem(item, teamConfig, { ...localConfig, projects: ['checkout'] });
      await handler.pullItem(item, teamConfig, { ...localConfig, projects: ['billing'] });

      const content = await envSh();
      expect(content).toContain("export MODEL_ENDPOINT='https://api.example.com'");
      expect(content).not.toContain('CHECKOUT_ONLY');
    });

    it('rewrites env.sh on deactivation even when the root env file is missing', async () => {
      await fse.remove(path.join(repoPath, 'env', 'env.yaml'));
      await writeCheckoutProject();
      await writeNamespaceEnv('checkout', [{ key: 'CHECKOUT_ONLY', value: 'yes' }]);

      await handler.pullItem(item, teamConfig, { ...localConfig, projects: ['checkout'] });
      expect(await envSh()).toContain('CHECKOUT_ONLY');

      await handler.pullItem(item, teamConfig, { ...localConfig, projects: ['billing'] });
      // Only the marker of what it exported before is left (env-sh-exports.ts).
      expect(await envSh()).not.toContain('CHECKOUT_ONLY');
      expect([...parseEnvFile(await envSh()).keys()]).toEqual([]);
      const backup = await fse.readFile(path.join(homeDir, '.teamai', 'env'), 'utf-8');
      expect(backup).not.toContain('CHECKOUT_ONLY');
    });

    it('keeps env.sh as it is when an active namespace file does not parse', async () => {
      await writeCheckoutProject();
      await handler.pullItem(item, teamConfig, { ...localConfig, projects: ['checkout'] });
      const before = await envSh();

      await fse.ensureDir(path.join(repoPath, 'env', 'checkout'));
      await fse.writeFile(path.join(repoPath, 'env', 'checkout', 'env.yaml'), 'variables: [unclosed\n');
      await handler.pullItem(item, teamConfig, { ...localConfig, projects: ['checkout'] });

      expect(await envSh()).toBe(before);
      const { log } = await import('../utils/logger.js');
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('env/checkout/env.yaml is not valid YAML'));
    });

    it('delivers no variable that carries the removed roles: or projects: keys', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({
        variables: [
          { key: 'CHECKOUT_URL', value: 'c', projects: ['checkout'] },
          { key: 'DEVOPS_TOKEN', value: 'd', roles: ['devops'] },
          { key: 'SHARED', value: 's' },
        ],
      }));

      await handler.pullItem(item, teamConfig, localConfig);

      const content = await envSh();
      expect(content).toContain('export SHARED=');
      expect(content).not.toContain('CHECKOUT_URL');
      expect(content).not.toContain('DEVOPS_TOKEN');
      const { log } = await import('../utils/logger.js');
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(
        'env/env.yaml: variable "CHECKOUT_URL" is scoped with per-entry `projects:`, which this version no longer reads, so it reaches nobody.',
      ));
    });

    // A typo of a scoping key (#822) must not widen who gets the variable.
    it('delivers no variable that carries a key env does not know, and names the file, variable and key', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({
        variables: [
          { key: 'DB_URL', value: 'db', role: ['frontend'] },
          { key: 'SHARED', value: 's' },
        ],
      }));
      const { log } = await import('../utils/logger.js');
      vi.mocked(log.warn).mockClear();

      await handler.pullItem(item, teamConfig, localConfig);

      const content = await envSh();
      expect(content).toContain('export SHARED=');
      expect(content).not.toContain('DB_URL');
      const warnings = vi.mocked(log.warn).mock.calls.map(([m]) => String(m))
        .filter((m) => m.includes('env/env.yaml') && m.includes('"DB_URL"'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/\brole\b/);
    });

    it('keeps the root variable when the active namespace copy of it carries an unknown key', async () => {
      await writeCheckoutProject();
      await fse.outputFile(path.join(repoPath, 'env', 'checkout', 'env.yaml'), YAML.stringify({
        variables: [{ key: 'MODEL_ENDPOINT', value: 'https://checkout.example.com', role: ['frontend'] }],
      }));
      const { log } = await import('../utils/logger.js');
      vi.mocked(log.warn).mockClear();

      await handler.pullItem(item, teamConfig, { ...localConfig, projects: ['checkout'] });

      const content = await envSh();
      expect(content).toContain("export MODEL_ENDPOINT='https://api.example.com'");
      expect(content).not.toContain('https://checkout.example.com');
      const warnings = vi.mocked(log.warn).mock.calls.map(([m]) => String(m))
        .filter((m) => m.includes('env/checkout/env.yaml') && m.includes('"MODEL_ENDPOINT"'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/\brole\b/);
    });

    it('delivers a variable with every key env knows, without a warning about it', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), YAML.stringify({
        variables: [{ key: 'FULL', value: 'f', description: 'every known key' }],
      }));
      const { log } = await import('../utils/logger.js');
      vi.mocked(log.warn).mockClear();

      await handler.pullItem(item, teamConfig, localConfig);

      expect(await envSh()).toContain("export FULL='f'");
      expect(vi.mocked(log.warn).mock.calls.map(([m]) => String(m)).filter((m) => m.includes('"FULL"'))).toEqual([]);
    });

    it('should handle invalid env.yaml gracefully', async () => {
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), ':::bad yaml');

      vi.stubEnv('SHELL', '/bin/bash');
      const bashrcPath = path.join(homeDir, '.bashrc');
      await fse.writeFile(bashrcPath, '# original\n');

      await handler.pullItem(item, teamConfig, localConfig);

      // Should not crash and should not modify shell profile
      const content = await fse.readFile(bashrcPath, 'utf-8');
      expect(content).toBe('# original\n');
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
