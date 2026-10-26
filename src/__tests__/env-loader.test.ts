import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { EnvHandler, readEnvBackup } from '../resources/env.js';
import { directoryEnv, envLoaderFilesForProjects, markEnvScopePending, registerEnvScope, unregisterEnvScope, userEnvInShells } from '../resources/env-loader.js';
import { keptFromUserScope, type TeamEnv } from '../env-resolution.js';
import { projectDataHome } from '../utils/partition.js';
import { readEnvShExports } from '../env-sh-exports.js';
import { getDataHome, getEnvBackupPath, type LocalConfig, type TeamaiConfig } from '../types.js';
import { resolveConfigForDir, saveLocalConfigForScope } from '../config.js';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(), persist: vi.fn() },
}));

/**
 * A process started in a directory gets the team env of the scope that governs
 * that directory (#1018). Observed the way a member's tools observe it: through
 * a real shell started there, under a sandboxed HOME.
 */
const hasShell = (shell: string): boolean => spawnSync(shell, ['-c', 'true']).status === 0;

const hasBashAtLeast = (major: number, minor: number, bash = 'bash'): boolean => {
  const version = spawnSync(bash, ['-c', 'printf "%s %s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'], { encoding: 'utf-8' });
  if (version.status !== 0) return false;
  const [actualMajor, actualMinor] = version.stdout.trim().split(' ').map(Number);
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
};

describe('team env by directory (#1018)', () => {
  let tmpDir: string;
  let homeDir: string;
  let teamConfig: TeamaiConfig;
  const handler = new EnvHandler();

  beforeEach(async () => {
    tmpDir = fs.realpathSync(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-env-loader-')));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(path.join(homeDir, '.teamai'));
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('ZDOTDIR', '');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.example.com/team/repo.git',
      provider: 'git',
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {},
    } as TeamaiConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fse.remove(tmpDir);
  });

  it.each([
    { kind: 'dir', key: path.join(os.tmpdir(), 'teamai-unmounted-dir-project'), anchor: path.join(os.tmpdir(), 'teamai-unmounted-dir-project') },
    { kind: 'git', key: path.join(os.tmpdir(), 'teamai-unmounted-git-project', '.git'), anchor: path.join(os.tmpdir(), 'teamai-unmounted-git-project') },
  ])('keeps the registered $kind project partition when its env is opted out and anchor is unavailable', async ({ kind, key, anchor }) => {
    const partition = projectDataHome(anchor);
    await fse.ensureDir(partition);
    await fse.writeFile(path.join(homeDir, '.teamai', 'env-scopes'), `stamp\ttest\n${kind}\t${key}\t-\t0\t${partition}\n`);

    const { partitions } = await envLoaderFilesForProjects();

    expect(partitions).toContain(partition);
  });

  it('does not preserve a partition from a malformed project registry row', async () => {
    const partition = projectDataHome(path.join(tmpDir, 'unregistered'));
    await fse.ensureDir(partition);
    await fse.writeFile(path.join(homeDir, '.teamai', 'env-scopes'), `stamp\ttest\ndir\t${tmpDir}\t-\t0\n`);

    expect((await envLoaderFilesForProjects()).partitions).not.toContain(partition);
  });

  it('does not preserve a partition from a project registry row whose partition is relative', async () => {
    await fse.writeFile(path.join(homeDir, '.teamai', 'env-scopes'), `stamp\ttest\ndir\t${tmpDir}\t-\t0\trelative/partition\n`);

    expect(await envLoaderFilesForProjects()).toEqual({ files: [], partitions: [] });
  });

  it.skipIf(process.platform === 'win32')('keeps a literal backslash in a POSIX partition path', async () => {
    const partition = `${tmpDir}/data\\name`;
    await fse.ensureDir(partition);
    await fse.writeFile(path.join(homeDir, '.teamai', 'env-scopes'), `stamp\ttest\ndir\t${tmpDir}\t-\t0\t${partition}\n`);

    expect((await envLoaderFilesForProjects()).partitions).toContain(partition);
  });

  /** A project-scope install in its own git checkout, as `teamai init` leaves it. */
  const project = async (name: string): Promise<LocalConfig> => {
    const root = path.join(tmpDir, 'work', name);
    await fse.ensureDir(root);
    execFileSync('git', ['init', '-q', root]);
    return {
      repo: { localPath: path.join(tmpDir, 'team-repo'), remote: teamConfig.repo },
      username: 'member',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'project',
      projectRoot: root,
      dataHome: path.join(homeDir, '.teamai', 'projects', name),
    } as LocalConfig;
  };

  /** What `printenv key` prints in a non-interactive shell started in `dir`, as a tool runs a command there. */
  const shellSees = (shell: string, dir: string, key: string, inherited: NodeJS.ProcessEnv = {}): string => {
    const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: shell, ...inherited };
    const run = spawnSync(shell, ['-c', `printenv ${key} || true`], { cwd: dir, env, encoding: 'utf-8' });
    return run.stdout.trim();
  };

  // One resolution: a shell started in a directory loads the env of the scope
  // `resolveConfigForDir` resolves there, so it agrees with `env exec` and MCP.
  describe.each(['bash', 'zsh'].filter(hasShell))('%s loads the scope the CLI resolves', (shell) => {
    it.each([
      { name: 'a git project root', dir: 'git' },
      { name: 'a git project subdirectory', dir: 'git/src' },
      { name: 'a project root outside git', dir: 'plain-project' },
      { name: 'a project subdirectory outside git', dir: 'plain-project/src' },
      { name: 'a repository created at a moved git project\'s old path', dir: 'moved' },
      { name: 'the moved git project at its new path', dir: 'moved-to' },
      { name: 'a plain directory', dir: 'elsewhere' },
    ])('in $name', async ({ dir }) => {
      vi.stubEnv('SHELL', `/bin/${shell}`);
      const work = path.join(tmpDir, 'work');
      const base = {
        repo: { localPath: path.join(tmpDir, 'team-repo'), remote: teamConfig.repo },
        username: 'member', primaryRole: 'dev', updatePolicy: 'auto', additionalRoles: [],
      };
      const scopes: LocalConfig[] = [{ ...base, scope: 'user' } as LocalConfig];
      for (const name of ['git', 'moved']) {
        const root = path.join(work, name);
        await fse.ensureDir(path.join(root, 'src'));
        execFileSync('git', ['init', '-q', root]);
        scopes.push({ ...base, scope: 'project', projectRoot: root, dataHome: projectDataHome(root) } as LocalConfig);
      }
      await fse.ensureDir(path.join(work, 'plain-project', 'src'));
      scopes.push({ ...base, scope: 'project', projectRoot: path.join(work, 'plain-project') } as LocalConfig);
      await fse.ensureDir(path.join(work, 'elsewhere'));
      for (const scope of scopes) {
        await saveLocalConfigForScope(scope);
        await handler.writeResolvedEnv([{ key: 'TOKEN', value: getDataHome(scope) }], teamConfig, scope);
      }
      await fse.move(path.join(work, 'moved'), path.join(work, 'moved-to'));
      execFileSync('git', ['init', '-q', path.join(work, 'moved')]);
      const resolved = await resolveConfigForDir(path.join(work, dir));

      expect(shellSees(shell, path.join(work, dir), 'TOKEN')).toBe(resolved && getDataHome(resolved));
    });
  });

  describe('restores the member environment exactly', () => {
    const shells = ['bash', 'zsh'].filter(hasShell);
    const states = [
      { name: 'unset', setup: '', expected: 'unset' },
      { name: 'local', setup: 'TOKEN=mine', expected: 'local:mine' },
      { name: 'exported', setup: 'export TOKEN=mine', expected: 'exported:mine' },
      // An attribute beside export: `declare -p` prints `declare -ix`, zsh `export -i`.
      { name: 'exported integer', setup: 'typeset -ix TOKEN=3', expected: 'exported:3' },
      // Every attribute comes back, not only export: an integer still evaluates what it is given.
      // bash before 4.2 cannot give a global its attribute back from a function (see below).
      { name: 'exported integer, assigned after', setup: 'typeset -ix TOKEN=3', after: 'TOKEN=1+1', expected: 'exported:2', beforeBash42: 'exported:1+1', inChild: 'exported:3' },
      { name: 'local integer, assigned after', setup: 'typeset -i TOKEN=3', after: 'TOKEN=1+1', expected: 'local:2', beforeBash42: 'local:1+1' },
    ];
    const report = 'if [ "${TOKEN+x}" != x ]; then printf unset; else case " $(export -p) " in *" TOKEN="*) printf "exported:%s" "$TOKEN";; *) printf "local:%s" "$TOKEN";; esac; fi; printf "\\n"';

    it.each(shells.flatMap((shell) => states.flatMap((state) => [false, true].map((child) => ({ shell, state, child })))))(
      '$shell restores $state.name after enter → $child', async ({ shell, state, child }) => {
        const a = await project(`restore-${shell}-${state.name}-${child}`);
        const elsewhere = path.join(tmpDir, 'outside');
        await fse.ensureDir(elsewhere);
        await handler.writeResolvedEnv([{ key: 'TOKEN', value: 'team' }], teamConfig, a);
        const command = [
          state.setup,
          `cd '${a.projectRoot}'`,
          ...(child ? [`${shell} -c 'cd "${elsewhere}"; . "${path.join(homeDir, '.teamai', 'env-loader.sh')}"; printf "child="; ${report}'`] : []),
          `cd '${elsewhere}'`,
          state.after ?? '',
          `printf 'parent='; ${report}`,
          'exit',
        ].filter(Boolean).join('\n');
        const run = spawnSync(shell, ['-i'], {
          cwd: elsewhere,
          env: { HOME: homeDir, PATH: process.env.PATH, SHELL: `/bin/${shell}`, BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh') },
          input: command,
          encoding: 'utf-8',
        });
        expect(run.status, run.stderr).toBe(0);
        const expected = shell === 'bash' && !hasBashAtLeast(4, 2, shell) ? state.beforeBash42 ?? state.expected : state.expected;
        expect(run.stdout.trim().split('\n').slice(-1)[0]).toBe(`parent=${expected}`);
        const inChild = state.inChild ?? state.expected;
        if (child) expect(run.stdout).toContain(`child=${inChild.startsWith('exported:') ? inChild : 'unset'}\n`);
      },
    );

    // Inside the project the team's value arrives as written, as env exec gives
    // it, whatever attribute the member's variable has; leaving puts it back.
    // bash before 4.2 cannot set a global's attribute from a function, so
    // there the variable comes back without it.
    it.each([...new Set(['/bin/bash', 'bash', 'zsh'])].filter(hasShell).flatMap((shell) => [
      { attribute: 'integer', setup: 'typeset -ix TOKEN=3', team: '1+1', after: 'TOKEN=2+2', expected: '4', since: [3, 0] },
      { attribute: 'lowercase', setup: 'typeset -lx TOKEN=mine', team: 'Team', after: 'TOKEN=ABC', expected: 'abc', since: [4, 0] },
      { attribute: 'uppercase', setup: 'typeset -ux TOKEN=MINE', team: 'Team', after: 'TOKEN=abc', expected: 'ABC', since: [4, 0] },
    ].filter(({ since: [major, minor] }) => shell === 'zsh' || hasBashAtLeast(major, minor, shell)).map((state) => ({ shell, ...state }))))(
      '$shell delivers the team value to an $attribute variable as written', async ({ shell, setup, team, after, expected }) => {
        const a = await project(`attribute-${path.basename(shell)}-${shell.length}-${team}-${expected}`);
        const elsewhere = path.join(tmpDir, 'outside');
        await fse.ensureDir(elsewhere);
        await handler.writeResolvedEnv([{ key: 'TOKEN', value: team }], teamConfig, a);
        const run = spawnSync(shell, ['-i'], {
          cwd: elsewhere,
          env: { HOME: homeDir, PATH: process.env.PATH, SHELL: shell.startsWith('/') ? shell : `/bin/${shell}`, BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh') },
          input: [setup, `cd '${a.projectRoot}'`, 'printf "inside=%s child=%s\\n" "$TOKEN" "$(printenv TOKEN)"', `cd '${elsewhere}'`, after, 'printf "after=%s\\n" "$TOKEN"', 'exit'].join('\n'),
          encoding: 'utf-8',
        });
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout).toContain(`inside=${team} child=${team}\n`);
        const keepsAttribute = shell === 'zsh' || hasBashAtLeast(4, 2, shell);
        expect(run.stdout).toContain(`after=${keepsAttribute ? expected : after.slice('TOKEN='.length)}\n`);
      },
    );

    // The keys the loader saves, restores and unsets are the ones env.sh
    // assigns, never a line inside a value. On Windows the member's
    // `aws_secret_access_key` is another spelling of the same variable, which
    // the loader unsets when a file assigns the key.
    it.each(['bash', 'zsh'].filter(hasShell).flatMap((shell) => (['linux', 'win32'] as const).map((platform) => ({ shell, platform }))))(
      '$shell on $platform takes no key from an export line inside a multiline value', async ({ shell, platform }) => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
        const a = await project(`multiline-${shell}-${platform}`);
        const elsewhere = path.join(tmpDir, 'outside');
        await fse.ensureDir(elsewhere);
        // A quote inside the value is written as '\'' and does not end it.
        const value = "a\nit's\nexport AWS_SECRET_ACCESS_KEY=x\nback\\'\nexport AWS_SECRET_ACCESS_KEY=y\nb";
        await handler.writeResolvedEnv([{ key: 'MULTI', value }], teamConfig, a);
        const member = platform === 'win32' ? 'aws_secret_access_key' : 'AWS_SECRET_ACCESS_KEY';
        const multilineReport = `printf "%s|%s|%s\\n" "\${MULTI-unset}" "$(printenv ${member})" "$(env | grep -c __TEAMAI_ENV_PREV_)"`;

        const run = spawnSync(shell, ['-c', `. "$1"; ${multilineReport}; cd "$2" && __teamai_env_apply; ${multilineReport}`, 'teamai', path.join(homeDir, '.teamai', 'env-loader.sh'), elsewhere], {
          cwd: a.projectRoot,
          env: { HOME: homeDir, PATH: process.env.PATH, ZDOTDIR: tmpDir, [member]: 'real' },
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        expect(run.stdout, run.stderr).toBe(`${value}|real|0\nunset|real|0\n`);
      },
    );

    // A tool started from a shell in the project inherits the project's PATH;
    // the check runs the loader with the member's, which finds git.
    it.each(['bash', 'zsh'].filter(hasShell))('%s: the directory check runs with the member\'s PATH, not the one a project exports', async (shell) => {
      const a = await project(`check-path-${shell}`);
      await handler.writeResolvedEnv([{ key: 'PATH', value: '/no-such-path' }], teamConfig, a);
      const inherited = spawnSync(shell, ['-c', '. "$1"; /usr/bin/env -0', 'teamai', path.join(homeDir, '.teamai', 'env-loader.sh')], {
        cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, ZDOTDIR: tmpDir }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      }).stdout.split('\0').filter(Boolean).map((line) => line.split(/=(.*)/s));
      expect(Object.fromEntries(inherited).PATH).toBe('/no-such-path');
      for (const [key, value] of inherited) vi.stubEnv(key, value);

      expect(await directoryEnv(a, a.projectRoot ?? '', `/bin/${shell}`)).toEqual({ kind: 'loads-scope' });
    });
  });

  describe('isolates the loader from shell options', () => {
    it.each(['bash', 'zsh'].filter(hasShell))('%s preserves allexport and a local value without exporting loader state', async (shell) => {
      const a = await project(`allexport-${shell}`);
      const elsewhere = path.join(tmpDir, `outside-${shell}`);
      await fse.ensureDir(elsewhere);
      await handler.writeResolvedEnv([{ key: 'TOKEN', value: 'team' }], teamConfig, a);
      const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
      const enable = shell === 'bash' ? 'set -a' : 'setopt allexport';
      const state = shell === 'bash'
        ? 'case $- in *a*) printf enabled ;; *) printf disabled ;; esac'
        : '[[ -o allexport ]] && printf enabled || printf disabled';
      const localState = shell === 'bash'
        ? 'case $(declare -p TOKEN 2>/dev/null) in "declare -x TOKEN="*) printf exported ;; *) printf local ;; esac'
        : '[[ -o allexport ]] && [[ ${(t)parameters[TOKEN]} == *export* ]] && printf exported || printf local';
      const run = spawnSync(shell, ['-c', [
        'TOKEN=mine', enable, `cd '${a.projectRoot}'`, `. '${loader}'`,
        `cd '${elsewhere}'`, `. '${loader}'`,
        `printf 'value=%s state=' "$TOKEN"; ${localState}; printf ' option='; ${state}; printf '\\n'`,
        `if env | grep -q '^__TEAMAI_ENV_PREV_TOKEN='; then printf leaked; else printf clean; fi`,
      ].join('\n')], { cwd: elsewhere, env: { HOME: homeDir, PATH: process.env.PATH }, encoding: 'utf-8' });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim().split('\n')).toEqual(['value=mine state=local option=enabled', 'clean']);
    });

    it.skipIf(!hasShell('bash'))('bash nocasematch does not merge distinct variable names', async () => {
      const a = await project('nocasematch');
      const userEnv = path.join(homeDir, '.teamai', 'env.sh');
      await fse.writeFile(userEnv, "export token='user'\n");
      await handler.writeResolvedEnv([], teamConfig, a, ['TOKEN']);
      const scopes = path.join(homeDir, '.teamai', 'env-scopes');
      const lines = (await fse.readFile(scopes, 'utf-8')).trimEnd().split('\n');
      const projectRow = lines.find((line) => line.startsWith('git\t'))!;
      await fse.writeFile(scopes, [
        'stamp\ttest',
        `user\t-\t${userEnv}\t0\t-`,
        projectRow.replace(/\t0\t/, '\t1\t'),
        '',
      ].join('\n'));
      const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
      const run = spawnSync('bash', ['-c', `shopt -s nocasematch; . '${loader}'; printf '%s|%s\\n' "\${token-unset}" "\${TOKEN-unset}"`], {
        cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH }, encoding: 'utf-8',
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('user|unset');
    });

    it.each(['bash', 'zsh'].filter(hasShell))('%s keeps post-startup options out of hook-driven apply', async (shell) => {
      const a = await project(`post-startup-options-${shell}`);
      const elsewhere = path.join(tmpDir, `outside-post-startup-${shell}`);
      await fse.ensureDir(elsewhere);
      await handler.writeResolvedEnv([{ key: 'TOKEN', value: 'team' }], teamConfig, a);
      const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
      const options = shell === 'bash' ? 'set -a; shopt -s nocasematch' : 'setopt allexport';
      const optionState = shell === 'bash'
        ? 'case $- in *a*) printf enabled ;; *) printf disabled ;; esac'
        : '[[ -o allexport ]] && printf enabled || printf disabled';
      const localState = shell === 'bash'
        ? 'case $(declare -p TOKEN 2>/dev/null) in "declare -x TOKEN="*) printf exported ;; *) printf local ;; esac'
        : '[[ ${(t)parameters[TOKEN]} == *export* ]] && printf exported || printf local';
      const run = spawnSync(shell, ['-c', [
        'TOKEN=mine',
        `. '${loader}'`,
        options,
        `cd '${a.projectRoot}'`,
        '__teamai_env_apply',
        `cd '${elsewhere}'`,
        '__teamai_env_apply',
        `printf 'value=%s state=' "$TOKEN"; ${localState}; printf ' option='; ${optionState}; printf '\\n'`,
        'if env | grep -q "^__TEAMAI_ENV_PREV_TOKEN="; then printf leaked; else printf clean; fi',
      ].join('\n')], {
        cwd: elsewhere,
        env: { HOME: homeDir, PATH: process.env.PATH, SHELL: `/bin/${shell}` },
        encoding: 'utf-8',
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('value=mine state=local option=enabled');
      expect(run.stdout).toContain('clean');
    });

    it.skipIf(!hasShell('bash'))('bash keeps post-startup nocasematch from merging distinct env names', async () => {
      const a = await project('post-startup-nocasematch');
      const elsewhere = path.join(tmpDir, 'outside-post-startup-nocasematch');
      await fse.ensureDir(elsewhere);
      const userEnv = path.join(homeDir, '.teamai', 'env.sh');
      await fse.writeFile(userEnv, "export token='user'\n");
      await handler.writeResolvedEnv([], teamConfig, a, ['TOKEN']);
      const scopes = path.join(homeDir, '.teamai', 'env-scopes');
      const lines = (await fse.readFile(scopes, 'utf-8')).trimEnd().split('\n');
      const projectRow = lines.find((line) => line.startsWith('git\t'))!;
      await fse.writeFile(scopes, ['stamp\ttest', `user\t-\t${userEnv}\t0\t-`, projectRow.replace(/\t0\t/, '\t1\t'), ''].join('\n'));
      const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
      const run = spawnSync('bash', ['-c', [
        `. '${loader}'`,
        'set -a',
        'shopt -s nocasematch',
        `cd '${a.projectRoot}'`,
        '__teamai_env_apply',
        `printf '%s|%s ' "\${token-unset}" "\${TOKEN-unset}"`,
        `cd '${elsewhere}'`,
        '__teamai_env_apply',
        `printf '%s|%s ' "\${token-unset}" "\${TOKEN-unset}"`,
        'case $- in *a*) printf allexport-enabled ;; *) printf allexport-disabled ;; esac',
        'shopt -q nocasematch && printf nocasematch-enabled || printf nocasematch-disabled',
      ].join('\n')], {
        cwd: elsewhere,
        env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash' },
        encoding: 'utf-8',
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('user|unset user|unset allexport-enablednocasematch-enabled');
    });
  });

  /**
   * Every zsh, and every bash a terminal starts, runs the loader: a script's
   * output or its exit status must not change because of it, and it must not
   * add a noticeable cost to each command a tool runs.
   */
  describe('cost to every shell', () => {
    const runs = (shell: string, args: string[], dir: string) => {
      // A sandboxed tool (Codex's read-only sandbox) cannot create temp files:
      // the shells' here-document files go to these.
      const unwritable = path.join(tmpDir, 'no-such-dir');
      const env: NodeJS.ProcessEnv = {
        HOME: homeDir, PATH: process.env.PATH, SHELL: shell, BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh'),
        TMPDIR: unwritable, TMPPREFIX: path.join(unwritable, 'zsh'),
      };
      const started = process.hrtime.bigint();
      // stdin from /dev/null: Debian's bash reads /etc/bash.bashrc and ~/.bashrc when
      // stdin is a socket (it takes the caller for sshd), and Node's pipes are sockets.
      const run = spawnSync(shell, args, { cwd: dir, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { ...run, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    };

    it.each(['zsh', 'bash'].filter(hasShell))('%s prints nothing and fails nothing, even with nounset or no writable temp dir, in a project and outside one', async (shell) => {
      vi.stubEnv('SHELL', `/bin/${shell}`);
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      for (const dir of [a.projectRoot ?? '', tmpDir]) {
        const run = runs(shell, ['-u', '-c', 'true'], dir);
        expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: '', stderr: '' });
      }
    });

    // A row the CLI takes for malformed (registry rows name absolute paths) routes no shell either.
    it.each([
      { field: 'env.sh', index: 2 },
      { field: 'partition', index: 4 },
    ].filter(() => hasShell('bash')))('ignores a project row whose $field path is relative', async ({ index }) => {
      vi.stubEnv('SHELL', '/bin/bash');
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await fse.outputFile(path.join(a.projectRoot ?? '', 'relative', 'env.sh'), "export MARKER='from-checkout'\n");
      const registry = path.join(homeDir, '.teamai', 'env-scopes');
      const rows = (await fse.readFile(registry, 'utf-8')).split('\n').map((line) => {
        const fields = line.split('\t');
        if (fields[0] !== 'git' && fields[0] !== 'dir') return line;
        fields[index] = index === 2 ? 'relative/env.sh' : 'relative';
        return fields.join('\t');
      });
      await fse.writeFile(registry, rows.join('\n'));

      const run = runs('bash', ['-c', 'printf "%s" "${MARKER-unset}"'], a.projectRoot ?? '');

      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: 'unset', stderr: '' });
    });

    // validScopeLine takes a row for exactly five non-empty fields; the loader takes the same rows.
    it.each([
      { shape: 'a sixth field', edit: (row: string) => `${row}\textra` },
      { shape: 'a seventh field', edit: (row: string) => `${row}\textra\tignored` },
      { shape: 'a trailing tab', edit: (row: string) => `${row}\t` },
      { shape: 'a doubled tab', edit: (row: string) => row.replace('\t', '\t\t') },
    ].filter(() => hasShell('bash')))('ignores a project row with $shape, as the CLI does', async ({ edit }) => {
      vi.stubEnv('SHELL', '/bin/bash');
      const user: LocalConfig = {
        repo: { localPath: path.join(tmpDir, 'user-repo'), remote: teamConfig.repo },
        username: 'member', updatePolicy: 'auto', additionalRoles: [], scope: 'user',
        dataHome: path.join(homeDir, '.teamai'),
      } as LocalConfig;
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-user' }], teamConfig, user);
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      const registry = path.join(homeDir, '.teamai', 'env-scopes');
      const rows = (await fse.readFile(registry, 'utf-8')).split('\n')
        .map((line) => (line.startsWith('git\t') || line.startsWith('dir\t') ? edit(line) : line));
      await fse.writeFile(registry, rows.join('\n'));

      const run = runs('bash', ['-c', 'printf "%s" "${MARKER-unset}"'], a.projectRoot ?? '');

      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: 'unset', stderr: '' });
      expect(await envLoaderFilesForProjects()).toEqual({ files: [], partitions: [] });
    });

    it.skipIf(!hasShell('bash'))('does not route a directory with an unregistrable tab in its path to the user env', async () => {
      vi.stubEnv('SHELL', '/bin/bash');
      const user: LocalConfig = {
        repo: { localPath: path.join(tmpDir, 'user-repo'), remote: teamConfig.repo },
        username: 'member', updatePolicy: 'auto', additionalRoles: [], scope: 'user',
        dataHome: path.join(homeDir, '.teamai'),
      } as LocalConfig;
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-user' }], teamConfig, user);

      const root = path.join(tmpDir, 'work', 'tab\tproject');
      await fse.ensureDir(root);
      execFileSync('git', ['init', '-q', root]);
      const projectConfig: LocalConfig = {
        repo: { localPath: path.join(tmpDir, 'team-repo'), remote: teamConfig.repo },
        username: 'member', updatePolicy: 'auto', additionalRoles: [], scope: 'project',
        projectRoot: root,
        dataHome: path.join(homeDir, '.teamai', 'projects', 'tab-project'),
      } as LocalConfig;

      await expect(handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-project' }], teamConfig, projectConfig))
        .rejects.toThrow(/project path.*tab or newline/i);

      expect(shellSees('bash', root, 'MARKER')).toBe('');
    });

    it('does not register a project whose repository git cannot read as a plain directory', async () => {
      const a = await project('unreadable-repo');
      const gitDir = path.join(a.projectRoot ?? '', '.git');
      await fse.remove(gitDir);
      await fse.writeFile(gitDir, `gitdir: ${path.join(tmpDir, 'no-such-git-dir')}\n`);

      await expect(handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a))
        .rejects.toThrow(/git could not read the repository/);
      const registry = await fse.readFile(path.join(homeDir, '.teamai', 'env-scopes'), 'utf-8').catch(() => '');
      expect(registry).not.toContain(a.projectRoot ?? '');
    });

    it.each(hasShell('bash') ? [
      { failure: 'missing', prepare: async (file: string) => fse.remove(file), restore: async () => {} },
      { failure: 'unreadable', prepare: async (file: string) => fse.chmod(file, 0o000), restore: async (file: string) => fse.chmod(file, 0o644) },
    ] : [])('does not load inherited user env when the project env file is $failure', async ({ prepare, restore }) => {
      vi.stubEnv('SHELL', '/bin/bash');
      const user: LocalConfig = {
        repo: { localPath: path.join(tmpDir, 'user-repo'), remote: teamConfig.repo },
        username: 'member', updatePolicy: 'auto', additionalRoles: [], scope: 'user',
        dataHome: path.join(homeDir, '.teamai'),
      } as LocalConfig;
      await handler.writeResolvedEnv([{ key: 'TOKEN', value: 'user-secret' }], teamConfig, user);
      const a = { ...await project('missing-project-env'), inheritUserScope: true };
      await handler.writeResolvedEnv([{ key: 'OTHER', value: 'project-value' }], teamConfig, a);
      const envSh = path.join(a.dataHome ?? '', 'env.sh');
      await prepare(envSh);

      try {
        expect(shellSees('bash', a.projectRoot ?? '', 'TOKEN')).toBe('');
      } finally {
        await restore(envSh);
      }
    });

    it.skipIf(!hasShell('bash'))('does not inherit user env when the registry has no opted-in user row', async () => {
      vi.stubEnv('SHELL', '/bin/bash');
      const user: LocalConfig = {
        repo: { localPath: path.join(tmpDir, 'user-repo'), remote: teamConfig.repo },
        username: 'member', updatePolicy: 'auto', additionalRoles: [], scope: 'user',
        dataHome: path.join(homeDir, '.teamai'),
      } as LocalConfig;
      await handler.writeResolvedEnv([{ key: 'TOKEN', value: 'user-secret' }], teamConfig, user);
      const a = { ...await project('no-user-row'), inheritUserScope: true };
      await handler.writeResolvedEnv([{ key: 'OTHER', value: 'project-value' }], teamConfig, a);
      const registry = path.join(homeDir, '.teamai', 'env-scopes');
      const rows = (await fse.readFile(registry, 'utf-8')).split('\n').filter((line) => !line.startsWith('user\t'));
      await fse.writeFile(registry, rows.join('\n'));

      expect(await userEnvInShells()).toBe(false);
      expect(runs('bash', ['-c', 'printenv TOKEN || true'], a.projectRoot ?? '').stdout.trim()).toBe('');
    });

    // Which scope governs the directory, by what git answers there: a directory
    // git cannot answer for inside a repository gets no team env, never the user's.
    const asRoot = process.getuid?.() === 0;
    it.each(['bash', 'zsh'].filter(hasShell).flatMap((shell) => [
      { outcome: 'git names the registered project', where: 'project', git: 'real', expected: 'from-a' },
      { outcome: 'not a repository', where: 'plain', git: 'real', expected: 'from-user' },
      { outcome: 'git not found, in the project', where: 'project', git: 'missing', expected: 'unset' },
      { outcome: 'git not found, outside any repository', where: 'plain', git: 'missing', expected: 'from-user' },
      { outcome: 'git fails, in the project', where: 'project', git: 'failing', expected: 'unset' },
      { outcome: 'git fails, outside any repository', where: 'plain', git: 'failing', expected: 'from-user' },
      { outcome: 'the .git file names a missing directory', where: 'broken', git: 'real', expected: 'unset' },
      ...asRoot ? [] : [{ outcome: 'the .git directory is unreadable', where: 'unreadable', git: 'real', expected: 'unset' }],
    ].map((row) => ({ shell, ...row }))))('$shell: $outcome loads $expected', async ({ shell, where, git, expected }) => {
      const user: LocalConfig = {
        repo: { localPath: path.join(tmpDir, 'user-repo'), remote: teamConfig.repo },
        username: 'member', updatePolicy: 'auto', additionalRoles: [], scope: 'user',
        dataHome: path.join(homeDir, '.teamai'),
      } as LocalConfig;
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-user' }], teamConfig, user);
      const dirs: Record<string, string> = { plain: path.join(tmpDir, 'plain') };
      for (const name of ['project', 'broken', 'unreadable']) {
        const config = await project(name);
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, config);
        dirs[name] = config.projectRoot ?? '';
      }
      await fse.ensureDir(dirs.plain);
      const gitDir = path.join(dirs.broken, '.git');
      await fse.remove(gitDir);
      await fse.writeFile(gitDir, `gitdir: ${path.join(tmpDir, 'no-such-git-dir')}\n`);
      const bin = path.join(tmpDir, 'bin');
      await fse.ensureDir(bin);
      if (git === 'failing') {
        await fse.writeFile(path.join(bin, 'git'), '#!/bin/sh\necho "fatal: cannot read the repository" >&2\nexit 128\n', { mode: 0o755 });
      }
      const unreadable = path.join(dirs.unreadable, '.git');
      await fse.chmod(unreadable, 0o000);

      try {
        const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: git === 'real' ? process.env.PATH : bin, SHELL: shell, BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh') };
        const shellPath = execFileSync('/bin/sh', ['-c', `command -v ${shell}`], { encoding: 'utf-8' }).trim();
        const run = spawnSync(shellPath, ['-c', 'printf "%s" "${MARKER-unset}"'], { cwd: dirs[where], env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

        expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: expected, stderr: '' });
      } finally {
        await fse.chmod(unreadable, 0o755);
      }
    });

    it('keeps the old registry row when opt-out profile migration fails', async () => {
      vi.stubEnv('SHELL', '/bin/bash');
      const a = await project('profile-migration-failure');
      const envSh = path.join(a.dataHome ?? '', 'env.sh');
      await fse.ensureDir(path.dirname(envSh));
      await fse.writeFile(envSh, "export TOKEN='project-secret'\n");
      await handler.writeResolvedEnv([{ key: 'TOKEN', value: 'project-secret' }], teamConfig, a);
      const profile = path.join(homeDir, '.bashrc');
      await fse.appendFile(profile, `\n# [teamai:env:start]\n# DO NOT EDIT: This section is auto-managed by teamai\n[ -f '${envSh}' ] && source '${envSh}'\n# [teamai:env:end]\n`);
      const registry = path.join(homeDir, '.teamai', 'env-scopes');
      const before = (await fse.readFile(registry, 'utf-8')).split('\n').find((line) => line.startsWith('git\t') || line.startsWith('dir\t'))!;
      const optedOut = { ...teamConfig, sharing: { ...teamConfig.sharing, env: { injectShellProfile: false } } } as TeamaiConfig;
      const write = vi.spyOn(fse, 'writeFile').mockImplementation(async (file, data) => {
        if (path.dirname(String(file)) === homeDir && /^(\.bash|\.profile)/.test(path.basename(String(file)))) {
          throw Object.assign(new Error('read-only profile'), { code: 'EACCES' });
        }
        await fs.promises.writeFile(String(file), data as string | NodeJS.ArrayBufferView);
      });

      await expect(handler.writeResolvedEnv([{ key: 'TOKEN', value: 'project-secret' }], optedOut, a)).rejects.toThrow('read-only profile');
      write.mockRestore();

      const after = (await fse.readFile(registry, 'utf-8')).split('\n').find((line) => line.startsWith('git\t') || line.startsWith('dir\t'))!;
      expect(after).toBe(before);
      expect(shellSees('bash', a.projectRoot ?? '', 'TOKEN')).toBe('project-secret');
    });

    it('fails project registration when the registry lock stays held', async () => {
      vi.stubEnv('SHELL', '/bin/bash');
      const user: LocalConfig = {
        repo: { localPath: path.join(tmpDir, 'user-repo'), remote: teamConfig.repo },
        username: 'member', updatePolicy: 'auto', additionalRoles: [], scope: 'user',
        dataHome: path.join(homeDir, '.teamai'),
      } as LocalConfig;
      await handler.writeResolvedEnv([{ key: 'TOKEN', value: 'user-secret' }], teamConfig, user);
      const a = await project('registry-lock-timeout');
      const lock = path.join(homeDir, '.teamai', 'env-scopes.lock');
      await fse.writeFile(lock, 'held');

      await expect(registerEnvScope(a, true)).rejects.toThrow(/registry.*lock|another teamai command/i);
      expect(runs('bash', ['-c', 'printenv TOKEN || true'], a.projectRoot ?? '').stdout.trim()).toBe('');
      const { log } = await import('../utils/logger.js');
      expect(vi.mocked(log.warn).mock.calls.some(([message]) => String(message).includes(a.projectRoot ?? ''))).toBe(true);
    });

    it('marks a checkout as a project\'s only while no row routes it, and takes the mark with the row', async () => {
      const a = await project('pending');
      const mark = path.join(a.projectRoot ?? '', '.git', 'teamai-env-pending');
      await markEnvScopePending(a.projectRoot ?? '');
      expect(await fse.pathExists(mark)).toBe(true);
      await registerEnvScope(a, true);
      expect(await fse.pathExists(mark)).toBe(false);
      await markEnvScopePending(a.projectRoot ?? '');
      expect(await fse.pathExists(mark)).toBe(false);
      await fse.writeFile(mark, '');
      await unregisterEnvScope(a);
      expect(await fse.pathExists(mark)).toBe(false);
    });

    // No registry row matches any of these directories: a project set up in its
    // checkout fails closed, as a registered one does; anywhere else gets the user env.
    it.each([
      { name: 'a subdirectory of a checkout with .teamai/config.yaml', marker: '.teamai/config.yaml', git: true, sub: 'src', expected: '' },
      { name: 'a single-repo checkout with .teamai/teamai.yaml', marker: '.teamai/teamai.yaml', git: true, sub: '', expected: '' },
      { name: 'a directory outside git with .teamai/config.yaml', marker: '.teamai/config.yaml', git: false, sub: '', expected: '' },
      { name: 'a checkout whose project keeps its data in ~/.teamai/projects', marker: '.git/teamai-env-pending', git: true, sub: 'src', expected: '' },
      { name: 'a checkout with another file in .teamai', marker: '.teamai/notes.md', git: true, sub: '', expected: 'user-secret' },
      { name: 'a plain checkout', marker: null, git: true, sub: '', expected: 'user-secret' },
      { name: 'a plain directory', marker: null, git: false, sub: '', expected: 'user-secret' },
      { name: 'the home directory, whose .teamai is the user scope\'s', marker: null, git: false, sub: 'HOME', expected: 'user-secret' },
    ].filter(() => hasShell('bash')))('loads $expected in $name before any pull registered it', async ({ marker, git, sub, expected }) => {
      vi.stubEnv('SHELL', '/bin/bash');
      const user: LocalConfig = {
        repo: { localPath: path.join(tmpDir, 'user-repo'), remote: teamConfig.repo },
        username: 'member', updatePolicy: 'auto', additionalRoles: [], scope: 'user',
        dataHome: path.join(homeDir, '.teamai'),
      } as LocalConfig;
      await fse.outputFile(path.join(homeDir, '.teamai', 'config.yaml'), 'scope: user\n');
      await handler.writeResolvedEnv([{ key: 'TOKEN', value: 'user-secret' }], teamConfig, user);
      const root = path.join(tmpDir, 'work', 'unregistered');
      await fse.ensureDir(path.join(root, 'src'));
      if (git) execFileSync('git', ['init', '-q', root]);
      if (marker) await fse.outputFile(path.join(root, marker), 'scope: project\n');
      const dir = sub === 'HOME' ? homeDir : path.join(root, sub);

      expect(runs('bash', ['-c', 'printenv TOKEN || true'], dir).stdout.trim()).toBe(expected);
    });

    // A child shell in the same directory reuses its parent's routing while the
    // registry stamp holds. None of these changes the stamp, and each one moves
    // the directory out of the user env: the child must route again.
    it.each(['bash', 'zsh'].filter(hasShell).flatMap((shell) => [
      { name: 'a failed first pull marks the checkout pending', git: true, sub: 'src', change: '.git/teamai-env-pending', expected: '' },
      { name: 'the checkout gets .teamai/config.yaml', git: true, sub: 'src', change: '.teamai/config.yaml', expected: '' },
      { name: 'the checkout gets a single-repo .teamai/teamai.yaml', git: true, sub: '', change: '.teamai/teamai.yaml', expected: '' },
      { name: 'a directory outside git gets .teamai/config.yaml', git: false, sub: '', change: '.teamai/config.yaml', expected: '' },
      { name: 'a project directory outside git becomes a checkout', git: false, sub: 'src', change: 'git init', expected: '' },
      { name: 'the registry is created unreadable', git: true, sub: '', change: 'unreadable registry', expected: '' },
      { name: 'the checkout\'s .git becomes a broken gitdir reference', git: true, sub: 'src', change: 'broken gitdir', expected: '' },
      { name: 'nothing changes', git: true, sub: 'src', change: null, expected: 'user-secret' },
      { name: 'a registered project\'s .git becomes a broken gitdir reference', git: true, sub: 'src', change: 'broken gitdir', registered: true, expected: '' },
      { name: 'nothing changes in a registered project', git: true, sub: 'src', change: null, registered: true, expected: 'project-secret' },
    ].map((row) => ({ shell, registered: false, ...row }))))('$shell routes a child shell again once $name', async ({ shell, git, sub, change, registered, expected }) => {
      if (change === 'unreadable registry' && process.getuid?.() === 0) return;
      vi.stubEnv('SHELL', `/bin/${shell}`);
      const user: LocalConfig = {
        repo: { localPath: path.join(tmpDir, 'user-repo'), remote: teamConfig.repo },
        username: 'member', updatePolicy: 'auto', additionalRoles: [], scope: 'user',
        dataHome: path.join(homeDir, '.teamai'),
      } as LocalConfig;
      await fse.outputFile(path.join(homeDir, '.teamai', 'config.yaml'), 'scope: user\n');
      await handler.writeResolvedEnv([{ key: 'TOKEN', value: 'user-secret' }], teamConfig, user);
      const registry = path.join(homeDir, '.teamai', 'env-scopes');
      if (change === 'unreadable registry') await fse.remove(registry);
      const root = path.join(tmpDir, 'work', 'unregistered');
      await fse.ensureDir(path.join(root, 'src'));
      if (git) execFileSync('git', ['init', '-q', root]);
      if (registered) await handler.writeResolvedEnv([{ key: 'TOKEN', value: 'project-secret' }], teamConfig, await project('unregistered'));
      if (change === 'git init') await fse.outputFile(path.join(root, '.teamai', 'config.yaml'), 'scope: project\n');
      const dir = path.join(root, sub);
      const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
      const parent = JSON.parse(spawnSync(shell, ['-c', `'${process.execPath}' -e 'process.stdout.write(JSON.stringify(process.env))'`], {
        cwd: dir, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: `/bin/${shell}`, BASH_ENV: loader }, encoding: 'utf-8',
      }).stdout) as NodeJS.ProcessEnv;
      expect(parent.TOKEN).toBe(registered ? 'project-secret' : 'user-secret');

      if (change === 'git init') execFileSync('git', ['init', '-q', root]);
      else if (change === 'unreadable registry') await fse.outputFile(registry, '', { mode: 0o000 });
      else if (change === 'broken gitdir') {
        await fse.remove(path.join(root, '.git'));
        await fse.outputFile(path.join(root, '.git'), `gitdir: ${path.join(tmpDir, 'missing-gitdir')}\n`);
      }
      else if (change) await fse.outputFile(path.join(root, change), 'scope: project\n');

      try {
        expect(shellSees(shell, dir, 'TOKEN', parent)).toBe(expected);
      } finally {
        if (change === 'unreadable registry') await fse.chmod(registry, 0o644);
      }
    });

    // Unset IFS splits as the default whitespace; under nounset it must not be expanded bare.
    it.skipIf(!hasShell('bash'))('keeps a key with IFS unset under bash nounset, and leaves IFS unset', async () => {
      vi.stubEnv('SHELL', '/bin/bash');
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      const run = runs('bash', ['-u', '-c', 'unset IFS; __teamai_keys=" MARKER"; __teamai_env_keep MARKER; printf "%s\\n" "${IFS+set}"'], a.projectRoot ?? '');

      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: '\n', stderr: '' });
    });

    // The block can sit in ~/.profile, which a POSIX sh login shell reads too:
    // the loader returns before anything that shell cannot parse, and loads nothing.
    it.each(['dash', 'ksh'].filter(hasShell))('%s reads a ~/.profile with the block, goes on, and loads no env.sh', async (shell) => {
      vi.stubEnv('SHELL', '/bin/bash');
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await fse.outputFile(path.join(homeDir, '.profile'), `${handler.generateShellBlock(path.join(homeDir, '.teamai', 'env-loader.sh'))}\n`);

      const run = spawnSync(shell, ['-c', '. "$HOME/.profile"; printf "after:%s:%s\\n" "${MARKER-unset}" "${__TEAMAI_ENV_FILES-unset}"'], {
        cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH }, encoding: 'utf-8',
      });

      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: 'after:unset:unset\n', stderr: '' });
    });

    it.skipIf(!hasShell('zsh'))('adds little to a zsh -c started in a project', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const median = (dir: string): number => {
        const times = Array.from({ length: 7 }, () => runs('zsh', ['-c', 'true'], dir).ms).sort((x, y) => x - y);
        return times[3];
      };
      const without = median(a.projectRoot ?? '');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      expect(median(a.projectRoot ?? '') - without).toBeLessThan(100);
    });

    // A git on PATH that is a bash or zsh script starts a shell that runs the
    // loader again. Without a guard each one routes, so runs git, until fork
    // fails: the whole process group is killed after 10 s.
    it.each(['bash', 'zsh'].filter(hasShell))('%s: a git that is a script in this shell runs once per route', async (shell) => {
      vi.stubEnv('SHELL', `/bin/${shell}`);
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      const which = (command: string): string => execFileSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf-8' }).trim();
      const bin = path.join(tmpDir, 'bin');
      const gitLog = path.join(tmpDir, 'git-runs');
      await fse.outputFile(path.join(bin, 'git'), `#!${which(shell)}\nprintf 'run\\n' >> '${gitLog}'\nexec '${which('git')}' "$@"\n`, { mode: 0o755 });
      const env: NodeJS.ProcessEnv = {
        HOME: homeDir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SHELL: `/bin/${shell}`,
        ...(shell === 'bash' ? { BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh') } : { ZDOTDIR: homeDir }),
      };

      const run = await new Promise<{ stdout: string; timedOut: boolean }>((resolve) => {
        const child = spawn(shell, ['-c', 'printf "%s" "${MARKER-unset}"'], { cwd: a.projectRoot, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const killGroup = (): void => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
        let stdout = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; killGroup(); }, 10_000);
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.on('close', () => { clearTimeout(timer); killGroup(); resolve({ stdout, timedOut }); });
      });
      const gitRuns = (await fse.pathExists(gitLog)) ? (await fse.readFile(gitLog, 'utf-8')).split('\n').filter(Boolean).length : 0;

      expect({ ...run, gitRuns }).toEqual({ stdout: 'from-a', timedOut: false, gitRuns: 1 });
    }, 20_000);
  });

  describe('upgrading a profile an older version wrote', () => {
    /** A per-scope block as versions before #1018 wrote it. */
    const oldBlock = (envSh: string): string =>
      `# [teamai:env:start]\n# DO NOT EDIT: This section is auto-managed by teamai\n[ -f '${envSh}' ] && source '${envSh}'\n# [teamai:env:end]`;
    const blocksIn = async (file: string): Promise<number> =>
      ((await fse.readFile(file, 'utf-8').catch(() => '')).match(/# \[teamai:env:start\]/g) ?? []).length;

    it('replaces the user and project blocks in every profile file with the one loader block', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const zshrc = path.join(homeDir, '.zshrc');
      await fse.writeFile(zshrc, [
        'alias ll="ls -l"',
        oldBlock(path.join(homeDir, '.teamai', 'env.sh')),
        oldBlock(path.join(a.dataHome ?? '', 'env.sh')),
        'export EDITOR=vim',
        '',
      ].join('\n\n'));

      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      expect(await blocksIn(zshrc)).toBe(0);
      expect(await fse.readFile(zshrc, 'utf-8')).toContain('alias ll="ls -l"');
      expect(await fse.readFile(zshrc, 'utf-8')).toContain('export EDITOR=vim');
      expect(await blocksIn(path.join(homeDir, '.zshenv'))).toBe(1);
    });

    // All or nothing: the loader block is in and every older block is out, or
    // no file changes. The older blocks still load the team env without the
    // loader block, and with it, one left in .zshrc would load its scope's env
    // in every interactive zsh on top of the directory's. The pull reports the
    // failed write.
    const readOnly = async (file: string, content: string): Promise<void> => { await fse.writeFile(file, content); await fse.chmod(file, 0o444); };
    const state = async (file: string): Promise<string> =>
      (await fse.pathExists(file)) ? ((await fse.stat(file)).isDirectory() ? 'a directory' : await fse.readFile(file, 'utf-8')) : 'absent';
    it.each([
      { name: '~/.zshenv is a directory', zshenv: (file: string) => fse.ensureDir(file), zshrc: (file: string, content: string) => fse.writeFile(file, content) },
      { name: '~/.zshenv is read-only', zshenv: (file: string) => readOnly(file, '# mine\n'), zshrc: (file: string, content: string) => fse.writeFile(file, content) },
      { name: '.zshrc is read-only', zshenv: async () => {}, zshrc: readOnly },
      {
        name: '.zshrc links to a read-only file in a dotfiles repo',
        zshenv: async () => {},
        zshrc: async (file: string, content: string) => { const target = path.join(tmpDir, 'dotfiles', 'zshrc'); await fse.ensureDir(path.dirname(target)); await readOnly(target, content); await fse.symlink(target, file); },
      },
    ])('changes no profile file when $name', async ({ zshenv, zshrc }) => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const zshrcPath = path.join(homeDir, '.zshrc');
      const zshenvPath = path.join(homeDir, '.zshenv');
      await zshrc(zshrcPath, `${oldBlock(path.join(a.dataHome ?? '', 'env.sh'))}\n`);
      await zshenv(zshenvPath);
      const before = { zshrc: await state(zshrcPath), zshenv: await state(zshenvPath) };

      await expect(handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a)).rejects.toThrow(/EACCES|EISDIR|EPERM/);

      expect({ zshrc: await state(zshrcPath), zshenv: await state(zshenvPath) }).toEqual(before);
    });

    // A member often links one profile file to another, or into a dotfiles
    // repo: each file is rewritten once, through the path the member uses.
    it.each([
      { name: '.zshrc links to ~/.zshenv', shell: 'zsh', target: '.zshenv', links: { '.zshrc': '.zshenv' } },
      { name: '~/.zshenv and .zshrc link to one file in a dotfiles repo', shell: 'zsh', target: '../dotfiles/zsh/env', links: { '.zshenv': '../dotfiles/zsh/env', '.zshrc': 'ABSOLUTE' } },
      { name: '.bash_profile links to .bashrc', shell: 'bash', target: '.bashrc', links: { '.bash_profile': '.bashrc' } },
    ].filter(({ shell }) => hasShell(shell)))('leaves the loader block alone and the links in place when $name', async ({ shell, target, links }) => {
      vi.stubEnv('SHELL', `/bin/${shell}`);
      const a = await project('a');
      const file = path.resolve(homeDir, target);
      await fse.outputFile(file, `# mine\n${oldBlock(path.join(a.dataHome ?? '', 'env.sh'))}\n`);
      for (const [link, to] of Object.entries(links)) await fse.symlink(to === 'ABSOLUTE' ? file : to, path.join(homeDir, link));

      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      const content = await fse.readFile(file, 'utf-8');
      expect(content).toContain(path.join(homeDir, '.teamai', 'env-loader.sh'));
      expect(content).toBe(`# mine\n\n${handler.generateShellBlock(path.join(homeDir, '.teamai', 'env-loader.sh'))}\n`);
      for (const link of Object.keys(links)) expect((await fse.lstat(path.join(homeDir, link))).isSymbolicLink()).toBe(true);
      expect(spawnSync(shell, ['-i', '-c', 'printenv MARKER'], {
        cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: `/bin/${shell}` }, encoding: 'utf-8',
      }).stdout.trim()).toBe('from-a');
    });

    // A ~/.zshenv that links to a file not there yet is the member's: the
    // loader block goes in through it, and a failed pull removes only what it
    // created, never the link.
    // `created` is the first directory the write makes; a failed pull takes it out again.
    const danglingLinks = [
      { name: 'its directory exists', link: 'dotfiles/zshenv', created: 'dotfiles/zshenv' },
      { name: 'its directory does not exist', link: 'dotfiles/zsh/env', created: 'dotfiles/zsh' },
    ];
    const danglingZshenv = async (link: string): Promise<{ zshenv: string; target: string }> => {
      const zshenv = path.join(homeDir, '.zshenv');
      const target = path.join(tmpDir, link);
      await fse.ensureDir(path.join(tmpDir, 'dotfiles'));
      await fse.symlink(target, zshenv);
      return { zshenv, target };
    };
    it.each(danglingLinks)('creates the file a dangling ~/.zshenv link points to, and keeps the link, when $name', async ({ link }) => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const { zshenv, target } = await danglingZshenv(link);

      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      expect((await fse.lstat(zshenv)).isSymbolicLink()).toBe(true);
      expect(await fse.readFile(target, 'utf-8')).toBe(`\n${handler.generateShellBlock(path.join(homeDir, '.teamai', 'env-loader.sh'))}\n`);
    });
    it.each(danglingLinks)('keeps a dangling ~/.zshenv link and removes what it created when the pull fails and $name', async ({ link, created }) => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const { zshenv, target } = await danglingZshenv(link);
      const zshrc = path.join(homeDir, '.zshrc');
      await readOnly(zshrc, `${oldBlock(path.join(a.dataHome ?? '', 'env.sh'))}\n`);
      const before = await fse.readFile(zshrc, 'utf-8');

      await expect(handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a)).rejects.toThrow(/EACCES|EPERM/);

      expect((await fse.lstat(zshenv)).isSymbolicLink()).toBe(true);
      expect(await fse.readlink(zshenv)).toBe(target);
      expect(await fse.pathExists(path.join(tmpDir, created))).toBe(false);
      expect(await fse.pathExists(path.join(tmpDir, 'dotfiles'))).toBe(true);
      expect(await fse.readFile(zshrc, 'utf-8')).toBe(before);
    });

    // env.sh (what shells load), the env backup (what env exec and MCP
    // read) and the record of what env.sh exported change together or not at all.
    it.each([
      { name: 'env.sh is read-only', readOnlyFile: (a: LocalConfig) => path.join(a.dataHome ?? '', 'env.sh') },
      { name: 'the env backup is read-only', readOnlyFile: (a: LocalConfig) => getEnvBackupPath(a) },
    ])('keeps env.sh, the env backup and the export record as they were when $name', async ({ readOnlyFile }) => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'old' }], teamConfig, a);
      const envSh = path.join(a.dataHome ?? '', 'env.sh');
      const envState = async () => ({ envSh: await fse.readFile(envSh, 'utf-8'), backup: await readEnvBackup(a), exports: await readEnvShExports(envSh) });
      const before = await envState();
      await fse.chmod(readOnlyFile(a), 0o444);

      await expect(handler.writeResolvedEnv([{ key: 'MARKER', value: 'new' }], teamConfig, a)).rejects.toThrow(/EACCES|EPERM/);

      expect(await envState()).toEqual(before);
      expect(before.backup).toEqual({ MARKER: 'old' });
    });

    /** The first write to a file `fails` matches empties it, as an in-place write does, then fails with ENOSPC. */
    const failFirstWriteTo = (fails: (file: string) => boolean): void => {
      const realWriteFile = fse.writeFile;
      let failed = false;
      vi.spyOn(fse, 'writeFile').mockImplementation(async (file: unknown, data: unknown) => {
        if (typeof file !== 'string' || typeof data !== 'string') throw new Error('unexpected writeFile call in test');
        if (failed || !fails(file)) return realWriteFile(file, data, 'utf-8');
        failed = true;
        await realWriteFile(file, '', 'utf-8');
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      });
    };

    // A write that fails part way has changed its file: it is put back like
    // one that completed, or removed when it was not there.
    it.each([
      { name: 'env.sh', pulledBefore: true, failing: (a: LocalConfig) => path.join(a.dataHome ?? '', 'env.sh') },
      { name: 'the env backup', pulledBefore: true, failing: (a: LocalConfig) => getEnvBackupPath(a) },
      { name: 'the env backup of a first pull', pulledBefore: false, failing: (a: LocalConfig) => getEnvBackupPath(a) },
    ])('keeps env.sh, the env backup and the export record as they were when a write to $name fails part way', async ({ pulledBefore, failing }) => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      if (pulledBefore) await handler.writeResolvedEnv([{ key: 'MARKER', value: 'old' }], teamConfig, a);
      // Every file in the scope's data home, env.sh, the env backup and the export record among them.
      const dirState = async () => Promise.all((await fse.readdir(a.dataHome ?? '').catch(() => [])).sort().map(async (name) =>
        [name, await fse.readFile(path.join(a.dataHome ?? '', name), 'utf-8').catch(() => 'not a file')]));
      const before = await dirState();
      failFirstWriteTo((file) => file === failing(a));

      await expect(handler.writeResolvedEnv([{ key: 'MARKER', value: 'new' }], teamConfig, a)).rejects.toThrow(/ENOSPC/);

      expect(await dirState()).toEqual(before);
    });

    // So is a profile file, written through the name the member uses, so a link stays.
    it.each([
      { name: '~/.zshenv', link: false },
      { name: 'the file ~/.zshenv links to', link: true },
    ])('puts back $name when a write to it fails part way', async ({ link }) => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const zshenv = path.join(homeDir, '.zshenv');
      const target = link ? path.join(tmpDir, 'dotfiles', 'zshenv') : zshenv;
      await fse.outputFile(target, '# mine\nexport EDITOR=vim\n');
      if (link) await fse.symlink(target, zshenv);
      failFirstWriteTo((file) => path.basename(file) === path.basename(target));

      await expect(handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a)).rejects.toThrow(/ENOSPC/);

      expect(await fse.readFile(target, 'utf-8')).toBe('# mine\nexport EDITOR=vim\n');
      expect((await fse.lstat(zshenv)).isSymbolicLink()).toBe(link);
    });

    // A file the pull rewrites is read first: one it cannot read is reported,
    // never taken for empty and overwritten.
    it.each([
      { name: '.zshrc', file: () => path.join(homeDir, '.zshrc') },
      { name: 'env.sh', file: (a: LocalConfig) => path.join(a.dataHome ?? '', 'env.sh') },
    ])('reports a write-only $name and leaves it as it was', async ({ file }) => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const target = file(a);
      await fse.outputFile(target, `# mine\n${oldBlock(path.join(a.dataHome ?? '', 'env.sh'))}\n`);
      const before = await fse.readFile(target, 'utf-8');
      await fse.chmod(target, 0o200);

      await expect(handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a)).rejects.toThrow(/EACCES|EPERM/);

      await fse.chmod(target, 0o600);
      expect(await fse.readFile(target, 'utf-8')).toBe(before);
    });

    // Taking a block out leaves at most one blank line where it was.
    it.each([
      { name: 'the first block', before: (a: string, b: string) => `${a}\n\n${b}\n`, after: (b: string) => `${b}\n` },
      { name: 'a block between two lines', before: (a: string) => `# one\n\n${a}\n\n# two\n`, after: () => '# one\n\n# two\n' },
      { name: 'the last block', before: (a: string) => `# one\n\n${a}\n\n`, after: () => '# one\n' },
    ])('leaves no extra blank line when it takes out $name', async ({ before, after }) => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const b = await project('b');
      const bBlock = oldBlock(path.join(b.dataHome ?? '', 'env.sh'));
      const bashrc = path.join(homeDir, '.bashrc');
      await fse.writeFile(bashrc, before(oldBlock(path.join(a.dataHome ?? '', 'env.sh')), bBlock));
      const optedOut = { ...teamConfig, sharing: { ...teamConfig.sharing, env: { injectShellProfile: false } } } as TeamaiConfig;

      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], optedOut, a);

      expect(await fse.readFile(bashrc, 'utf-8')).toBe(after(bBlock));
    });

    // Opting out takes away every way this scope's env reached a shell. An
    // older block of another scope is that scope's to move.
    it('takes the project\'s older blocks out of every profile file once its team opts out, and leaves another scope\'s', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const b = await project('b');
      const aEnvSh = path.join(a.dataHome ?? '', 'env.sh');
      const bBlock = oldBlock(path.join(b.dataHome ?? '', 'env.sh'));
      await fse.outputFile(aEnvSh, "export MARKER='from-a'\n");
      await fse.writeFile(path.join(homeDir, '.zshrc'), `# mine\n${oldBlock(aEnvSh)}\n\n${bBlock}\n`);
      await fse.writeFile(path.join(homeDir, '.bashrc'), `${oldBlock(aEnvSh)}\n`);
      const optedOut = { ...teamConfig, sharing: { ...teamConfig.sharing, env: { injectShellProfile: false } } } as TeamaiConfig;

      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], optedOut, a);

      expect(await fse.readFile(path.join(homeDir, '.zshrc'), 'utf-8')).toBe(`# mine\n\n${bBlock}\n`);
      expect(await blocksIn(path.join(homeDir, '.bashrc'))).toBe(0);
      const row = (await fse.readFile(path.join(homeDir, '.teamai', 'env-scopes'), 'utf-8')).split('\n').find((line) => line.includes(a.projectRoot ?? ''));
      expect(row?.split('\t')[2]).toBe('-');
      for (const shell of ['bash', 'zsh'].filter(hasShell)) {
        expect(spawnSync(shell, ['-i', '-c', 'printenv MARKER || true'], {
          cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: `/bin/${shell}` }, encoding: 'utf-8',
        }).stdout.trim()).toBe('');
      }
    });

    // The inline-export format predates project scopes: only the user scope wrote it.
    it.each([
      { name: 'the user scope', optsOut: async () => ({ ...await project('a'), scope: 'user', projectRoot: undefined, dataHome: undefined } as LocalConfig), kept: false },
      { name: 'a project', optsOut: () => project('a'), kept: true },
    ])('takes the inline-export block out when $name opts out only if it is the user scope\'s', async ({ optsOut, kept }) => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const inline = '# [teamai:env:start]\n# DO NOT EDIT: This section is auto-managed by teamai\nexport TEAM_KEY="team"\n# [teamai:env:end]';
      const zshrc = path.join(homeDir, '.zshrc');
      await fse.writeFile(zshrc, `# mine\n\n${inline}\n\nexport EDITOR=vim\n`);
      const optedOut = { ...teamConfig, sharing: { ...teamConfig.sharing, env: { injectShellProfile: false } } } as TeamaiConfig;

      await handler.writeResolvedEnv([{ key: 'TEAM_KEY', value: 'team' }], optedOut, await optsOut());

      expect(await fse.readFile(zshrc, 'utf-8')).toBe(kept ? `# mine\n\n${inline}\n\nexport EDITOR=vim\n` : '# mine\n\nexport EDITOR=vim\n');
    });

    it('takes the user block out when the first pull after the upgrade is a project that ships no env', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const userEnvSh = path.join(homeDir, '.teamai', 'env.sh');
      await fse.writeFile(userEnvSh, "export USER_ONLY='u'\n");
      const zshrc = path.join(homeDir, '.zshrc');
      await fse.writeFile(zshrc, `${oldBlock(userEnvSh)}\n`);

      await handler.writeResolvedEnv([], teamConfig, a);

      expect(await blocksIn(zshrc)).toBe(0);
      expect(await blocksIn(path.join(homeDir, '.zshenv'))).toBe(1);
    });

    it.each([
      { name: 'one that sources its env.sh', userBlock: () => oldBlock(path.join(homeDir, '.teamai', 'env.sh')) },
      { name: 'the inline-export one', userBlock: () => '# [teamai:env:start]\nexport TEAM_KEY="team"\n# [teamai:env:end]' },
    ])('says once that user env no longer loads in projects when the profile had a project block and a user block, $name', async ({ userBlock }) => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const { log } = await import('../utils/logger.js');
      const a = await project('a');
      await fse.writeFile(path.join(homeDir, '.zshrc'), [
        userBlock(),
        oldBlock(path.join(a.dataHome ?? '', 'env.sh')),
      ].join('\n\n'));

      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      const notices = vi.mocked(log.info).mock.calls.filter(([message]) => String(message).includes('inheritUserScope'));
      expect(notices).toHaveLength(1);
      // The session-start pull is silent: debug.log keeps the notice.
      expect(vi.mocked(log.persist).mock.calls.filter(([message]) => String(message).includes('inheritUserScope'))).toHaveLength(1);
    });

    // `sharing.env.shellProfilePath` picks the file for bash (Git Bash reads
    // only its login files); every zsh, `zsh -c` too, reads only .zshenv. A
    // zsh member's existing bash file gets the loader too.
    it.each([
      { shell: 'zsh', override: '.zshrc', loaderIn: '.zshenv', warns: true },
      { shell: 'zsh', override: '.config/zsh/team.zsh', loaderIn: '.zshenv', warns: true },
      { shell: 'zsh', override: '.bash_profile', loaderIn: '.zshenv', warns: false, alsoIn: true },
      { shell: 'zsh', override: '.zshenv', loaderIn: '.zshenv', warns: false },
      { shell: 'bash', override: '.bash_profile', loaderIn: '.bash_profile', warns: false },
      { shell: 'bash', override: '.zshrc', loaderIn: '.bashrc', warns: true },
    ].filter(({ shell }) => hasShell(shell)))('puts the loader of a $shell member whose team sets shellProfilePath to ~/$override in ~/$loaderIn, moving an older block out', async ({ shell, override, loaderIn, warns, alsoIn }) => {
      vi.stubEnv('SHELL', `/bin/${shell}`);
      const { log } = await import('../utils/logger.js');
      const a = await project('a');
      const overridden = path.join(homeDir, override);
      await fse.outputFile(overridden, `${oldBlock(path.join(a.dataHome ?? '', 'env.sh'))}\n`);
      const config = { ...teamConfig, sharing: { ...teamConfig.sharing, env: { injectShellProfile: true, shellProfilePath: `~/${override}` } } };

      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], config, a);

      const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
      expect(await fse.readFile(path.join(homeDir, loaderIn), 'utf-8')).toContain(loader);
      if (overridden !== path.join(homeDir, loaderIn)) expect(await blocksIn(overridden)).toBe(alsoIn ? 1 : 0);
      if (alsoIn) expect(await fse.readFile(overridden, 'utf-8')).not.toContain(path.join(a.dataHome ?? '', 'env.sh'));
      expect(vi.mocked(log.warn).mock.calls.some(([message]) => String(message).includes('shellProfilePath'))).toBe(warns);
      if (shell === 'zsh') expect(shellSees('zsh', a.projectRoot ?? '', 'MARKER')).toBe('from-a');
    });
  });

  describe.skipIf(!hasShell('zsh'))('zsh', () => {
    beforeEach(() => { vi.stubEnv('SHELL', '/bin/zsh'); });

    it('gives a shell started in each project that project\'s env, whichever pulled last', async () => {
      const a = await project('a');
      const b = await project('b');

      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);

      expect(shellSees('zsh', a.projectRoot ?? '', 'MARKER')).toBe('from-a');
      expect(shellSees('zsh', b.projectRoot ?? '', 'MARKER')).toBe('from-b');
    });

    it('gives a zsh -c started with ZDOTDIR set its own directory\'s env, when ~/.zshenv is what sets ZDOTDIR', async () => {
      const zdotdir = path.join(homeDir, '.config', 'zsh');
      await fse.ensureDir(zdotdir);
      await fse.writeFile(path.join(homeDir, '.zshenv'), `export ZDOTDIR='${zdotdir}'\n`);
      vi.stubEnv('ZDOTDIR', zdotdir);
      const a = await project('a');
      const b = await project('b');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);
      const inA = JSON.parse(spawnSync('zsh', ['-c', `'${process.execPath}' -e 'process.stdout.write(JSON.stringify(process.env))'`], {
        cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh', ZDOTDIR: zdotdir }, encoding: 'utf-8',
      }).stdout) as NodeJS.ProcessEnv;

      expect(shellSees('zsh', b.projectRoot ?? '', 'MARKER', inA)).toBe('from-b');
    });

    it('gives a bash -c that a zsh starts in another project that project\'s env', async () => {
      const a = await project('a');
      const b = await project('b');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);

      const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh' };
      const run = spawnSync('zsh', ['-c', `printenv MARKER; cd '${b.projectRoot}' && bash -c 'printenv MARKER'`], {
        cwd: a.projectRoot, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });

      expect(run.stdout.trim().split('\n')).toEqual(['from-a', 'from-b']);
    });

    // A login bash reads .bash_profile, never BASH_ENV or .bashrc.
    it.skipIf(!hasShell('bash'))('gives a login bash that a zsh starts in one project the next project\'s env after cd, when ~/.bash_profile does not source ~/.bashrc', async () => {
      await fse.writeFile(path.join(homeDir, '.bashrc'), '# mine\n');
      await fse.writeFile(path.join(homeDir, '.bash_profile'), '# mine\n');
      const a = await project('a');
      const b = await project('b');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);

      const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh' };
      const run = spawnSync('zsh', ['-c', 'bash -l -i'], {
        cwd: a.projectRoot, env, encoding: 'utf-8', input: `printenv MARKER\ncd '${b.projectRoot}'\nprintenv MARKER\nexit\n`,
      });

      expect(run.stdout.trim().split('\n')).toEqual(['from-a', 'from-b']);
    });

    // With none of bash's startup files, an installed bash still gets the loader in each mode.
    it.skipIf(!hasShell('bash')).each(['-i', '-l -i'])('gives a bash %s that a zsh starts in one project the next project\'s env after cd, when no bash startup file existed', async (flags) => {
      const a = await project('a');
      const b = await project('b');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);

      const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh' };
      const run = spawnSync('zsh', ['-c', `bash ${flags}`], {
        cwd: a.projectRoot, env, encoding: 'utf-8', input: `printenv MARKER\ncd '${b.projectRoot}'\nprintenv MARKER\nexit\n`,
      });

      expect(run.stdout.trim().split('\n')).toEqual(['from-a', 'from-b']);
    });

    it.each([
      { key: 'BASH_ENV', value: '/tmp/team-bash-env' },
      { key: 'ENV', value: '/tmp/team-env' },
      { key: 'ZDOTDIR', value: '/tmp/team-zdotdir' },
      { key: 'HOME', value: '/tmp/team-home' },
      { key: 'home', value: '/tmp/team-home' },
      { key: 'PROMPT_COMMAND', value: 'echo team' },
      { key: 'chpwd_functions', value: 'team_chpwd' },
      { key: 'precmd_functions', value: 'team_precmd' },
      { key: 'preexec_functions', value: 'team_preexec' },
      { key: 'periodic_functions', value: 'team_periodic' },
      { key: 'zshaddhistory_functions', value: 'team_history' },
      { key: 'zshexit_functions', value: 'team_exit' },
      { key: 'zsh_directory_name_functions', value: 'team_directory_name' },
      { key: 'BASH_VERSINFO', value: '5' },
      { key: 'PIPESTATUS', value: '0' },
      { key: 'SHELLOPTS', value: 'braceexpand' },
      { key: 'BASHOPTS', value: 'cmdhist' },
      { key: 'UID', value: '0' },
      { key: 'EUID', value: '0' },
      { key: 'PPID', value: '1' },
      { key: '__TEAMAI_ENV_FILES', value: '/tmp/team-env.sh' },
      { key: '__teamai_env_loader', value: '/tmp/team-loader.sh' },
      { key: '__teamai_keys', value: 'OTHER' },
      { key: 'ZSH_VERSION', value: '0' },
      { key: 'IFS', value: ':' },
      { key: `TEAMAI_ENV_SH_${'ab'.repeat(32)}`, value: 'team' },
    ])('ignores team env control variable $key and warns that it is reserved', async ({ key, value }) => {
      const a = await project('reserved');
      const { log } = await import('../utils/logger.js');

      await handler.writeResolvedEnv([{ key, value }], teamConfig, a);

      expect(await fse.readFile(path.join(a.dataHome ?? '', 'env.sh'), 'utf-8')).not.toContain(`export ${key}=`);
      expect(vi.mocked(log.warn).mock.calls.some(([message]) => String(message).includes('reserved for TeamAI shell routing'))).toBe(true);
    });

    // A per-command `CDPATH= builtin cd` changes nothing the loader keeps.
    const memberNames = new Set(['CDPATH']);

    it.each(['linux', 'win32'] as const)('reserves every variable the loader and the env exec BASH_ENV read or write (%s)', async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      const { isReservedTeamEnvKey } = await import('../env-reserved.js');
      const { writeEnvExecBashEnv } = await import('../resources/env-loader.js');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, await project('names'));
      await writeEnvExecBashEnv();
      const script = (await Promise.all(['env-loader.sh', 'env-exec-bash-env.sh'].map((file) => fse.readFile(path.join(homeDir, '.teamai', file), 'utf-8'))))
        .join('\n').replace(/^\s*#.*$/gm, '');
      const names = new Set<string>();
      const name = '[A-Za-z_][A-Za-z0-9_]*';
      for (const pattern of [
        new RegExp(`\\$\\{?(${name})`, 'g'),
        new RegExp(`(?:^|[\\s;(\\\\"'])(${name})\\+?=`, 'gm'),
        new RegExp(`\\b(?:for|unset|export)\\s+(${name})`, 'g'),
        new RegExp(`\\bread -r ((?:${name}\\s*)+)`, 'g'),
        new RegExp(`(?:declare|typeset) -p "?\\$?(${name})`, 'g'),
      ]) {
        for (const match of script.matchAll(pattern)) for (const found of match[1].trim().split(/\s+/)) names.add(found);
      }

      expect(names.size).toBeGreaterThan(20);
      expect([...names].filter((found) => !memberNames.has(found) && !isReservedTeamEnvKey(found))).toEqual([]);
    });

    // zsh switches on cd; bash switches at the prompt, which a piped bash never shows.
    it.skipIf(!hasShell('zsh'))('unapplies team env on cd when the team declares a loader working name', async () => {
      const shell = 'zsh';
      const a = await project('working-names');
      const elsewhere = path.join(tmpDir, 'working-outside');
      await fse.ensureDir(elsewhere);
      await handler.writeResolvedEnv([{ key: 'TOKEN', value: 'team' }, { key: '__teamai_keys', value: 'OTHER' }], teamConfig, a);

      const run = spawnSync(shell, ['-i'], {
        cwd: elsewhere,
        env: { HOME: homeDir, PATH: process.env.PATH, SHELL: `/bin/${shell}` },
        input: `cd '${a.projectRoot}'\nprintf 'in=%s\\n' "\${TOKEN-unset}"\ncd '${elsewhere}'\nprintf 'out=%s\\n' "\${TOKEN-unset}"\nexit\n`,
        encoding: 'utf-8',
      });

      expect(run.stdout.trim().split('\n').slice(-2)).toEqual(['in=team', 'out=unset']);
    });

    // A BASH_ENV the member set: bash sources the loader, then theirs, once per bash.
    describe.skipIf(!hasShell('bash'))('with the member\'s own BASH_ENV', () => {
      const memberBashEnv = async (): Promise<{ file: string; log: string }> => {
        const file = path.join(homeDir, '.bash_env');
        const log = path.join(tmpDir, 'bash-env.log');
        await fse.writeFile(file, `export MEMBER_SET=1\necho x >> '${log}'\n`);
        return { file, log };
      };
      const sourced = async (log: string): Promise<number> => (await fse.readFile(log, 'utf-8').catch(() => '')).split('\n').filter(Boolean).length;

      it('gives a bash -c that a zsh starts in another project that project\'s env, then the member\'s BASH_ENV', async () => {
        const { file, log } = await memberBashEnv();
        const a = await project('a');
        const b = await project('b');
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);

        const run = spawnSync('zsh', ['-c', `cd '${b.projectRoot}' && bash -c 'printenv MARKER; printenv MEMBER_SET'`], {
          cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh', BASH_ENV: file }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
        });

        expect(run.stderr).toBe('');
        expect(run.stdout.trim().split('\n')).toEqual(['from-b', '1']);
        expect(await sourced(log)).toBe(1);
      });

      it('gives a bash -c the team value over the one the member\'s BASH_ENV sets, and the member\'s outside the project', async () => {
        const file = path.join(homeDir, '.bash_env');
        await fse.writeFile(file, 'export MARKER=member\n');
        const a = await project('a');
        const elsewhere = path.join(tmpDir, 'bash-env-outside');
        await fse.ensureDir(elsewhere);
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

        const run = spawnSync('zsh', ['-c', `bash -c 'printenv MARKER'; cd '${elsewhere}' && bash -c 'printenv MARKER'`], {
          cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh', BASH_ENV: file }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
        });

        expect(run.stdout.trim().split('\n')).toEqual(['from-a', 'member']);
      });

      it('sources the member\'s BASH_ENV once in each nested bash, and never chains the loader to itself', async () => {
        const { file, log } = await memberBashEnv();
        const a = await project('a');
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

        const run = spawnSync('zsh', ['-c', 'bash -c \'bash -c "printenv __TEAMAI_ENV_BASH_ENV"\''], {
          cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh', BASH_ENV: file }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
        });

        expect(run.stdout.trim()).toBe(file);
        expect(await sourced(log)).toBe(2);
      });

      // While the member's file runs, BASH_ENV names it, so it can find files beside it; then routing resumes.
      it.each(['zsh', 'bash'].filter(hasShell))('gives the member\'s BASH_ENV its own path while it runs, in a bash -c a %s starts and in a nested one', async (shell) => {
        const dir = path.join(homeDir, 'member-bash-env');
        const file = path.join(dir, 'bash_env');
        await fse.outputFile(path.join(dir, 'companion.sh'), 'export COMPANION=1\n');
        await fse.outputFile(file, 'printf "during:%s\\n" "$BASH_ENV"\n. "$(dirname "$BASH_ENV")/companion.sh"\n');
        vi.stubEnv('SHELL', `/bin/${shell}`);
        const a = await project('a');
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
        const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
        const child = 'printf "after:%s %s %s\\n" "$BASH_ENV" "$MARKER" "$COMPANION"';

        const run = spawnSync(shell, [...shell === 'bash' ? ['-i'] : [], '-c', `bash -c '${child}; bash -c '"'"'${child}'"'"''`], {
          cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: `/bin/${shell}`, BASH_ENV: file }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
        });

        expect(run.stderr).not.toContain('companion.sh');
        expect(run.stdout.trim().split('\n').filter((line) => /^(during|after):/.test(line))).toEqual([
          `during:${file}`, `after:${loader} from-a 1`, `during:${file}`, `after:${loader} from-a 1`,
        ]);
      });

      it('takes BASH_ENV back on cd in an interactive zsh whose .zshrc sets the member\'s own', async () => {
        const { file } = await memberBashEnv();
        await fse.writeFile(path.join(homeDir, '.zshrc'), `export BASH_ENV='${file}'\n`);
        const a = await project('a');
        const b = await project('b');
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);

        const terminal = spawnSync('zsh', ['-i'], {
          cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh' }, encoding: 'utf-8',
          input: `cd '${b.projectRoot}'\nbash -c 'printenv MARKER; printenv MEMBER_SET'\nexit\n`,
        });

        expect(terminal.stdout.trim().split('\n')).toEqual(['from-b', '1']);
      });

      // zsh runs chpwd only on a cd, so its prompt takes BASH_ENV back too, as bash's does.
      it('takes BASH_ENV back before the first prompt of an interactive zsh whose .zshrc sets the member\'s own', async () => {
        const { file } = await memberBashEnv();
        await fse.writeFile(path.join(homeDir, '.zshrc'), `export BASH_ENV='${file}'\n`);
        const a = await project('a');
        const b = await project('b');
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);
        // A tool started in a that runs bash -c in b, with no cd in the zsh.
        const tool = `process.chdir(process.argv[1]); require('child_process').spawnSync('bash', ['-c', 'printenv MARKER; printenv MEMBER_SET'], { stdio: ['ignore', 'inherit', 'inherit'] })`;

        const terminal = spawnSync('zsh', ['-i'], {
          cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh' }, encoding: 'utf-8',
          input: `'${process.execPath}' -e "${tool}" '${b.projectRoot}'\nexit\n`,
        });

        expect(terminal.stdout.trim().split('\n')).toEqual(['from-b', '1']);
      });

      it('restores the member BASH_ENV when an open shell notices the loader was uninstalled', async () => {
        const { file } = await memberBashEnv();
        const a = await project('uninstalled-loader');
        const elsewhere = path.join(tmpDir, 'uninstalled-outside');
        const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
        await fse.ensureDir(elsewhere);
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

        const terminal = spawnSync('zsh', ['-i'], {
          cwd: a.projectRoot,
          env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh', BASH_ENV: file },
          encoding: 'utf-8',
          input: `rm '${loader}'\ncd '${elsewhere}'\nbash -c 'printenv MEMBER_SET'\nexit\n`,
        });

        expect(terminal.stdout.trim().split('\n').slice(-1)[0]).toBe('1');
      });

      it('unsets BASH_ENV when an open shell notices the loader was uninstalled and had no member value', async () => {
        const a = await project('uninstalled-loader-no-bash-env');
        const elsewhere = path.join(tmpDir, 'uninstalled-outside-no-bash-env');
        const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
        await fse.ensureDir(elsewhere);
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

        const terminal = spawnSync('zsh', ['-i'], {
          cwd: a.projectRoot,
          env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh' },
          encoding: 'utf-8',
          input: `rm '${loader}'\ncd '${elsewhere}'\nbash -c 'if [ -n "\${BASH_ENV-}" ]; then echo present; else echo unset; fi'\nexit\n`,
        });

        expect(terminal.stdout.trim().split('\n').slice(-1)[0]).toBe('unset');
      });
    });

    it('switches env on cd in an interactive shell and puts back the member\'s own value on the way out', async () => {
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);
      const elsewhere = path.join(tmpDir, 'elsewhere');
      await fse.ensureDir(elsewhere);

      const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh', SHARED: 'mine' };
      const terminal = spawnSync('zsh', ['-i', '-c', `printenv SHARED; cd '${a.projectRoot}'; printenv SHARED; cd '${elsewhere}'; printenv SHARED`], {
        cwd: elsewhere, env, encoding: 'utf-8',
      });

      expect(terminal.stdout.trim().split('\n')).toEqual(['mine', 'project', 'mine']);
    });

    // The loader's lists are space-separated, whatever IFS the member sets.
    it.each(['bash', 'zsh'].filter(hasShell).flatMap((shell) => [' \t\n', ':', ''].map((ifs) => ({ shell, ifs }))))('$shell unapplies every key on the way out with IFS=$ifs', async ({ shell, ifs }) => {
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'ONE', value: '1' }, { key: 'TWO', value: '2' }], teamConfig, a);
      const elsewhere = path.join(tmpDir, 'elsewhere');
      await fse.ensureDir(elsewhere);

      const run = spawnSync(shell, ['-c', '. "$1"; printf "%s|%s\\n" "${ONE-unset}" "${TWO-unset}"; IFS=$3; cd "$2" && __teamai_env_apply; printf "%s|%s" "${ONE-unset}" "${TWO-unset}"', 'teamai', path.join(homeDir, '.teamai', 'env-loader.sh'), elsewhere, ifs], {
        cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, ZDOTDIR: elsewhere }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });

      expect(run.stdout.split('\n')).toEqual(['1|2', 'unset|unset']);
    });

    // The key scan is the loader's: it finds awk on the system's default path,
    // not the member's PATH, and a file whose keys it cannot read is not sourced.
    it.each([
      ...['bash', 'zsh'].filter(hasShell).map((shell) => ({ name: `${shell} with no awk on PATH`, shell, setup: '', loaded: '1|2' })),
      ...['bash'].filter(hasShell).map((shell) => ({ name: `${shell} when the key scan fails`, shell, setup: 'command() { return 1; }; ', loaded: 'unset|unset' })),
    ])('leaves no key applied after leaving a project: $name', async ({ shell, setup, loaded }) => {
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'ONE', value: '1' }, { key: 'TWO', value: '2' }], teamConfig, a);
      const elsewhere = path.join(tmpDir, 'elsewhere');
      const bin = path.join(tmpDir, 'bin-without-awk');
      await fse.ensureDir(elsewhere);
      await fse.ensureDir(bin);
      await fse.symlink(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim(), path.join(bin, 'git'));
      const shellPath = execFileSync('sh', ['-c', `command -v ${shell}`], { encoding: 'utf-8' }).trim();

      const run = spawnSync(shellPath, ['-c', `${setup}. "$1"; printf "%s|%s\\n" "\${ONE-unset}" "\${TWO-unset}"; cd "$2" && __teamai_env_apply; printf "%s|%s" "\${ONE-unset}" "\${TWO-unset}"`, 'teamai', path.join(homeDir, '.teamai', 'env-loader.sh'), elsewhere], {
        cwd: a.projectRoot, env: { HOME: homeDir, PATH: bin, ZDOTDIR: elsewhere }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });

      expect(run.stdout.split('\n')).toEqual([loaded, 'unset|unset']);
    });

    it('adds its cd hook once in an interactive zsh whose IFS is not a space', async () => {
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);
      const elsewhere = path.join(tmpDir, 'elsewhere');
      await fse.ensureDir(elsewhere);

      const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh' };
      const terminal = spawnSync('zsh', ['-i', '-c', `IFS=:; cd '${a.projectRoot}'; cd '${elsewhere}'; cd '${a.projectRoot}'; print -r -- \${#chpwd_functions}`], {
        cwd: elsewhere, env, encoding: 'utf-8',
      });

      expect(terminal.stdout.trim()).toBe('1');
    });

    it('resolves the project whatever the member\'s cd prints or which CDPATH it follows', async () => {
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      // A cd hook that prints, as `ls` on chpwd or zoxide's echo do.
      await fse.writeFile(path.join(homeDir, '.zshrc'), 'chpwd() { echo "now in $PWD"; }\n');
      const elsewhere = path.join(tmpDir, 'elsewhere');
      await fse.ensureDir(elsewhere);

      const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh', CDPATH: '.' };
      const terminal = spawnSync('zsh', ['-i', '-c', `cd '${a.projectRoot}' >/dev/null; printenv MARKER`], {
        cwd: elsewhere, env, encoding: 'utf-8',
      });

      expect(terminal.stdout.trim()).toBe('from-a');
    });

    it('gives a linked worktree its project\'s env before the worktree has pulled', async () => {
      const a = await project('a');
      const root = a.projectRoot ?? '';
      execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
      const worktree = path.join(tmpDir, 'work', 'a-feature');
      execFileSync('git', ['-C', root, 'worktree', 'add', '-q', worktree]);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      expect(shellSees('zsh', path.join(worktree), 'MARKER')).toBe('from-a');
    });

    describe('with a user scope', () => {
      const userScope = (): LocalConfig => ({
        repo: { localPath: path.join(tmpDir, 'team-repo'), remote: teamConfig.repo },
        username: 'member',
        updatePolicy: 'auto',
        additionalRoles: [],
        scope: 'user',
      } as LocalConfig);

      beforeEach(async () => {
        await handler.writeResolvedEnv([{ key: 'SHARED', value: 'user' }, { key: 'USER_ONLY', value: 'u' }], teamConfig, userScope());
      });

      it('gives a directory no project governs the user scope\'s env, and a project none of it', async () => {
        const a = await project('a');
        await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);
        const elsewhere = path.join(tmpDir, 'elsewhere');
        await fse.ensureDir(elsewhere);

        expect(shellSees('zsh', elsewhere, 'USER_ONLY')).toBe('u');
        expect(shellSees('zsh', a.projectRoot ?? '', 'USER_ONLY')).toBe('');
        expect(shellSees('zsh', a.projectRoot ?? '', 'SHARED')).toBe('project');
      });

      // The loader runs after the member's own startup files, so a function they
      // define by a command's name must not decide which scope governs a directory.
      it.each(['bash', 'zsh'].filter(hasShell).flatMap((shell) => [
        { shell, wrapper: 'pwd() { printf "%s\\n" /; }' },
        { shell, wrapper: 'git() { return 1; }' },
      ]))('$shell routes a project that does not inherit the user scope past a member\'s $wrapper', async ({ shell, wrapper }) => {
        const a = await project('a');
        await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);
        // No ~/.zshenv: the loader runs once, after the wrapper.
        const zdotdir = path.join(tmpDir, 'zdotdir');
        await fse.ensureDir(zdotdir);

        const run = spawnSync(shell, ['-c', `${wrapper}\n. "$1"; printf '%s|%s' "\${USER_ONLY-}" "\${SHARED-}"`, 'teamai', path.join(homeDir, '.teamai', 'env-loader.sh')], {
          cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, ZDOTDIR: zdotdir }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
        });

        expect(run.stdout, run.stderr).toBe('|project');
      });

      // A registry that exists but cannot be read may route this directory to a
      // project: the loader cannot tell, so it loads no scope's env there.
      it.skipIf(process.getuid?.() === 0).each(['bash', 'zsh'].filter(hasShell))('%s loads no env anywhere while the registry cannot be read', async (shell) => {
        const a = await project('a');
        await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);
        const elsewhere = path.join(tmpDir, 'elsewhere');
        await fse.ensureDir(elsewhere);
        const registry = path.join(homeDir, '.teamai', 'env-scopes');
        await fse.chmod(registry, 0o000);

        try {
          expect(shellSees(shell, a.projectRoot ?? '', 'SHARED', { BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh') })).toBe('');
          expect(shellSees(shell, elsewhere, 'USER_ONLY', { BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh') })).toBe('');
        } finally {
          await fse.chmod(registry, 0o644);
        }
      });

      // Unreadable is not empty: a pull that rewrote it would drop every other project.
      it.skipIf(process.getuid?.() === 0)('fails a pull and leaves the registry as it is while it cannot be read', async () => {
        const a = await project('a');
        const b = await project('b');
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
        const registry = path.join(homeDir, '.teamai', 'env-scopes');
        const before = await fse.readFile(registry, 'utf-8');
        await fse.chmod(registry, 0o000);

        let pulled: Promise<boolean>;
        try {
          pulled = handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);
          await expect(pulled).rejects.toThrow(`Could not read ${registry}`);
        } finally {
          await fse.chmod(registry, 0o644);
        }

        expect(await fse.readFile(registry, 'utf-8')).toBe(before);
        expect(shellSees('zsh', a.projectRoot ?? '', 'MARKER')).toBe('from-a');
      });

      it('puts the user scope\'s variables under a project that inherits it, the project winning a shared key', async () => {
        const a = { ...await project('a'), inheritUserScope: true };
        await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);

        expect(shellSees('zsh', a.projectRoot ?? '', 'USER_ONLY')).toBe('u');
        expect(shellSees('zsh', a.projectRoot ?? '', 'SHARED')).toBe('project');
      });

      it.each(['bash', 'zsh'].filter(hasShell).flatMap((shell) => [
        { shell, member: undefined, expected: '' },
        { shell, member: 'mine', expected: 'mine' },
      ]))('$shell keeps the member\'s $member for a key an inheriting project declares but does not export', async ({ shell, member, expected }) => {
        const a = { ...await project(`kept-${shell}-${member}`), inheritUserScope: true };
        await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a, ['USER_ONLY']);

        // stdin from /dev/null: a bash whose stdin is a socket skips BASH_ENV.
        const run = spawnSync(shell, ['-c', 'printf "%s|%s" "${USER_ONLY-}" "${SHARED-}"'], {
          cwd: a.projectRoot,
          env: { HOME: homeDir, PATH: process.env.PATH, BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh'), ...member === undefined ? {} : { USER_ONLY: member } },
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        expect(run.stdout).toBe(`${expected}|project`);
      });

      // On Windows `token` and `TOKEN` are one environment variable, as
      // resolution compares them (env-key.ts); elsewhere they are two.
      // Leaving puts back what the member had, in the spelling they had it.
      it.each(['bash', 'zsh'].filter(hasShell).flatMap((shell) => [
        { shell, platform: 'win32', exported: false, member: undefined, userToken: true, expected: 'unset|unset', left: 'unset|unset' },
        { shell, platform: 'win32', exported: true, member: undefined, userToken: true, expected: 'unset|project', left: 'unset|unset' },
        { shell, platform: 'win32', exported: false, member: 'mine', userToken: true, expected: 'mine|unset', left: 'mine|unset' },
        { shell, platform: 'win32', exported: true, member: 'mine', userToken: true, expected: 'unset|project', left: 'mine|unset' },
        { shell, platform: 'win32', exported: true, member: 'mine', userToken: false, expected: 'unset|project', left: 'mine|unset' },
        { shell, platform: 'linux', exported: false, member: undefined, userToken: true, expected: 'user|unset', left: 'unset|unset' },
        { shell, platform: 'linux', exported: true, member: 'mine', userToken: true, expected: 'user|project', left: 'mine|unset' },
      ] as const))('$shell on $platform: the user scope\'s token under an inheriting project that declares TOKEN (exported $exported, member token $member, user scope token $userToken) gives $expected, then $left in a project with no env', async ({ shell, platform, exported, member, userToken, expected, left }) => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
        await handler.writeResolvedEnv(userToken ? [{ key: 'token', value: 'user' }] : [], teamConfig, userScope());
        const a = { ...await project(`folded-${shell}-${platform}-${exported}-${member}-${userToken}`), inheritUserScope: true };
        const variables = exported ? [{ key: 'TOKEN', value: 'project' }] : [];
        const entry = { name: 'TOKEN', namespace: null, source: 'env/env.yaml', entry: { key: 'TOKEN', value: 'project' } };
        const teamEnv = {
          variables: { kind: 'resolved', entries: exported ? [entry] : [] },
          declarations: exported ? { kind: 'absent' } : { kind: 'resolved', entries: [{ ...entry, entry: { key: 'TOKEN' } }] },
        } as unknown as TeamEnv;
        await handler.writeResolvedEnv(variables, teamConfig, a, keptFromUserScope(a, teamEnv, variables));
        const zdotdir = path.join(tmpDir, 'zdotdir');
        await fse.ensureDir(zdotdir);

        const none = await project(`none-${shell}-${platform}-${exported}-${member}-${userToken}`);
        await handler.writeResolvedEnv([], teamConfig, none);

        const run = spawnSync(shell, ['-c', '. "$1"; printf "%s|%s\\n" "${token-unset}" "${TOKEN-unset}"; cd "$2" && __teamai_env_apply; printf "%s|%s" "${token-unset}" "${TOKEN-unset}"', 'teamai', path.join(homeDir, '.teamai', 'env-loader.sh'), none.projectRoot ?? ''], {
          cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, ZDOTDIR: zdotdir, ...member === undefined ? {} : { token: member } }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
        });

        expect(run.stdout.split('\n')).toEqual([expected, left]);
      });

      it.each([false, true])('loads nothing in an opted-out project, including inherited user env (inheritUserScope=$inheritUserScope)', async (inheritUserScope) => {
        const c = { ...await project(`c-${inheritUserScope}`), inheritUserScope };
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-c' }], {
          ...teamConfig, sharing: { ...teamConfig.sharing, env: { injectShellProfile: false } },
        } as TeamaiConfig, c);

        expect(shellSees('zsh', c.projectRoot ?? '', 'MARKER')).toBe('');
        expect(shellSees('zsh', c.projectRoot ?? '', 'USER_ONLY')).toBe('');
      });

      it('loads none of the user scope\'s env once its team opts out of shell-profile injection, outside projects or under one that inherits it', async () => {
        const optedOut = { ...teamConfig, sharing: { ...teamConfig.sharing, env: { injectShellProfile: false } } } as TeamaiConfig;
        await handler.writeResolvedEnv([{ key: 'USER_ONLY', value: 'u' }], optedOut, userScope());
        const a = { ...await project('a'), inheritUserScope: true };
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
        const elsewhere = path.join(tmpDir, 'elsewhere');
        await fse.ensureDir(elsewhere);

        expect(shellSees('zsh', elsewhere, 'USER_ONLY')).toBe('');
        expect(shellSees('zsh', a.projectRoot ?? '', 'USER_ONLY')).toBe('');
        expect(shellSees('zsh', a.projectRoot ?? '', 'MARKER')).toBe('from-a');
        expect(await directoryEnv(a, a.projectRoot ?? '', '/bin/zsh')).toEqual({ kind: 'loads-scope' });
      });

      it('loads none of the user scope\'s env under a project that inherits it once the project\'s team opts out, and keeps it outside projects', async () => {
        const optedOut = { ...teamConfig, sharing: { ...teamConfig.sharing, env: { injectShellProfile: false } } } as TeamaiConfig;
        const a = { ...await project('a'), inheritUserScope: true };
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], optedOut, a);
        const elsewhere = path.join(tmpDir, 'elsewhere');
        await fse.ensureDir(elsewhere);
        // stdin from /dev/null: a bash whose stdin is a socket skips BASH_ENV.
        const bashSees = (dir: string): string => spawnSync('bash', ['-c', 'printf "%s|%s" "${USER_ONLY-}" "${MARKER-}"'], {
          cwd: dir, env: { HOME: homeDir, PATH: process.env.PATH, BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh') }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
        }).stdout;

        expect(shellSees('zsh', elsewhere, 'USER_ONLY')).toBe('u');
        expect(shellSees('zsh', a.projectRoot ?? '', 'USER_ONLY')).toBe('');
        expect(shellSees('zsh', a.projectRoot ?? '', 'MARKER')).toBe('');
        if (hasShell('bash')) {
          expect(bashSees(elsewhere)).toBe('u|');
          expect(bashSees(a.projectRoot ?? '')).toBe('|');
        }
      });

      it('loads nothing in a project whose team ships no env', async () => {
        const a = await project('a');
        await handler.writeResolvedEnv([], teamConfig, a);

        expect(shellSees('zsh', a.projectRoot ?? '', 'USER_ONLY')).toBe('');
      });

      it.skipIf(!hasShell('zsh')).each([
        { inheritUserScope: true, expected: 'u' },
        { inheritUserScope: false, expected: '' },
      ])('restores the loader after its profile block was removed (inheritUserScope=$inheritUserScope)', async ({ inheritUserScope, expected }) => {
        const a = { ...await project('loader-repair'), inheritUserScope };
        await fse.remove(path.join(homeDir, '.zshenv'));
        await handler.writeResolvedEnv([], teamConfig, a);

        expect(await fse.readFile(path.join(homeDir, '.zshenv'), 'utf-8').catch(() => '')).toContain('env-loader.sh');
        expect(shellSees('zsh', a.projectRoot ?? '', 'USER_ONLY')).toBe(expected);
      });

      it.skipIf(!hasShell('zsh')).each([
        { shell: 'zsh' },
      ])('unapplies loaded env when a user opts out and the resolved file list becomes empty ($shell)', async () => {
        const userConfig = userScope();
        const optedOut = { ...teamConfig, sharing: { ...teamConfig.sharing, env: { injectShellProfile: false } } } as TeamaiConfig;
        await handler.writeResolvedEnv([{ key: 'USER_ONLY', value: 'u' }], teamConfig, userConfig);
        const a = { ...await project('a'), inheritUserScope: true };
        await handler.writeResolvedEnv([], teamConfig, a);
        const elsewhere = path.join(tmpDir, 'elsewhere');
        await fse.ensureDir(elsewhere);
        const inheritedResult = spawnSync('zsh', ['-c', 'env'], {
          cwd: elsewhere, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh' }, encoding: 'utf-8',
        });
        const inherited = Object.fromEntries(inheritedResult.stdout.split('\n').filter(Boolean).map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }));

        await handler.writeResolvedEnv([], optedOut, userConfig);
        const afterOptOut = spawnSync('zsh', ['-c', `printenv USER_ONLY || true`], {
          cwd: elsewhere, env: inherited, encoding: 'utf-8',
        });

        expect(inherited.USER_ONLY).toBe('u');
        expect(inherited.__TEAMAI_ENV_KEYS).toContain('USER_ONLY');
        expect(afterOptOut.stdout.trim()).toBe('');
      });
    });

    // A user scope an earlier version pulled has an env.sh but no registry
    // line: the next pull of any scope writes the line from the user scope's
    // own config and team repo, as a user-scope pull would.
    describe('with a user scope an earlier version pulled', () => {
      const userConfig = (repo: string): string => [
        'username: member', 'scope: user', 'primaryRole: dev', 'additionalRoles: []', 'repo:',
        `  localPath: ${repo}`, '  remote: https://git.example.com/team/user.git', '',
      ].join('\n');

      it.each([
        { userScope: 'opted out', teamYaml: { injectShellProfile: false }, config: true, loads: '', warns: false },
        { userScope: 'opted in', teamYaml: { injectShellProfile: true }, config: true, loads: 'u', warns: false },
        { userScope: 'with no team config', teamYaml: null, config: true, loads: '', warns: true },
        { userScope: 'with an invalid config', teamYaml: { injectShellProfile: true }, config: false, loads: '', warns: true },
      ])('loads the user scope $userScope as its own pull says, after a project pull', async ({ teamYaml, config, loads, warns }) => {
        const userRepo = path.join(tmpDir, 'user-team-repo');
        await fse.outputFile(path.join(homeDir, '.teamai', 'config.yaml'), config ? userConfig(userRepo) : 'scope: [');
        await fse.outputFile(path.join(homeDir, '.teamai', 'env.sh'), "export USER_ONLY='u'\n");
        if (teamYaml) {
          await fse.outputFile(path.join(userRepo, 'teamai.yaml'), JSON.stringify({ ...teamConfig, sharing: { ...teamConfig.sharing, env: teamYaml } }));
        }
        const a = { ...await project('a'), inheritUserScope: true };
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
        const elsewhere = path.join(tmpDir, 'elsewhere');
        await fse.ensureDir(elsewhere);

        expect(shellSees('zsh', elsewhere, 'USER_ONLY')).toBe(loads);
        expect(shellSees('zsh', a.projectRoot ?? '', 'USER_ONLY')).toBe(loads);
        expect(shellSees('zsh', a.projectRoot ?? '', 'MARKER')).toBe('from-a');
        const { log } = await import('../utils/logger.js');
        expect(vi.mocked(log.warn).mock.calls.some(([message]) => String(message).includes('user scope'))).toBe(warns);
      });
    });
  });

  // The registry holds a Windows project's native path, and each shell prints
  // its directory its own way: Git Bash `pwd -W` the native form, MSYS zsh
  // `/c/...`, Cygwin `/cygdrive/c/...`, either one `/home/...` that only
  // `cygpath -m` maps. The builtin `pwd` and the `cygpath` on PATH are
  // simulated; a member's own `tr` and `cygpath` functions are not used.
  it.each(['bash', 'zsh'].filter(hasShell).flatMap((shell) => [
    { shell, form: 'pwd -W', w: 'C:/Work/Repo', p: '/c/Work/Repo', cygpath: '', expected: 'win', member: '' },
    { shell, form: 'pwd -W in another case', w: 'c:/work/REPO', p: '/c/work/REPO', cygpath: '', expected: 'win', member: '' },
    { shell, form: 'pwd -W in another case, with a member\'s tr function', w: 'c:/work/REPO', p: '/c/work/REPO', cygpath: '', expected: 'win', member: 'tr() { cat; }' },
    { shell, form: 'MSYS /c/', w: '', p: '/c/Work/Repo', cygpath: '', expected: 'win', member: '' },
    { shell, form: 'Cygwin /cygdrive/c/', w: '', p: '/cygdrive/c/Work/Repo', cygpath: '', expected: 'win', member: '' },
    { shell, form: 'cygpath -m', w: '', p: '/home/me/repo', cygpath: 'C:/Work/Repo', expected: 'win', member: '' },
    { shell, form: 'cygpath -m, with a member\'s cygpath function', w: '', p: '/home/me/repo', cygpath: 'C:/Work/Repo', expected: 'win', member: 'cygpath() { printf "%s\\n" C:/Elsewhere; }' },
    { shell, form: 'another directory', w: '', p: '/c/Work/Other', cygpath: '', expected: '', member: '' },
  ]))('$shell on Windows loads the project registered as C:\\Work\\Repo from $form', async ({ shell, w, p, cygpath, expected, member }) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const win = { ...await project('win'), projectRoot: 'C:\\Work\\Repo' };
    await handler.writeResolvedEnv([{ key: 'MARKER', value: 'win' }], teamConfig, win);
    const zdotdir = path.join(tmpDir, 'zdotdir');
    await fse.ensureDir(zdotdir);
    const bin = path.join(tmpDir, 'bin');
    if (cygpath) {
      await fse.outputFile(path.join(bin, 'cygpath'), `#!/bin/sh\n[ "$1" = -m ] && [ "$2" = '${p}' ] && printf '%s\\n' '${cygpath}'\n`, { mode: 0o755 });
    }
    const stubs = [
      `builtin() { case $1 in pwd) case $2 in -W) [ -n '${w}' ] && printf '%s\\n' '${w}' ;; *) printf '%s\\n' '${p}' ;; esac ;; *) "$@" ;; esac; }`,
      ...member ? [member] : [],
    ].join('\n');

    const run = spawnSync(shell, ['-c', `${stubs}\n. "$1"; printf '%s' "\${MARKER-}"`, 'teamai', path.join(homeDir, '.teamai', 'env-loader.sh')], {
      cwd: tmpDir, env: { HOME: homeDir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ZDOTDIR: zdotdir }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(run.stdout, run.stderr).toBe(expected);
  });

  it.each(['zsh', 'bash'].filter(hasShell))('gives a %s started from a shell in the same directory the env a later pull wrote', async (shell) => {
    vi.stubEnv('SHELL', `/bin/${shell}`);
    const a = await project('a');
    await handler.writeResolvedEnv([{ key: 'MARKER', value: 'old' }, { key: 'DROPPED', value: 'x' }], teamConfig, a);
    const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
    const parent = JSON.parse(spawnSync(shell, ['-c', `'${process.execPath}' -e 'process.stdout.write(JSON.stringify(process.env))'`], {
      cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: `/bin/${shell}`, BASH_ENV: loader }, encoding: 'utf-8',
    }).stdout) as NodeJS.ProcessEnv;
    expect(parent.MARKER).toBe('old');

    await handler.writeResolvedEnv([{ key: 'MARKER', value: 'new' }], teamConfig, a);

    expect(shellSees(shell, a.projectRoot ?? '', 'MARKER', parent)).toBe('new');
    expect(shellSees(shell, a.projectRoot ?? '', 'DROPPED', parent)).toBe('');
  });

  describe.skipIf(!hasShell('bash'))('bash', () => {
    beforeEach(() => { vi.stubEnv('SHELL', '/bin/bash'); });

    it('gives the terminal and every bash -c it starts the env of their own directory', async () => {
      const a = await project('a');
      const b = await project('b');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);

      const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash' };
      const terminal = spawnSync('bash', ['-i', '-c', `printenv MARKER; cd '${b.projectRoot}' && bash -c 'printenv MARKER'`], {
        cwd: a.projectRoot, env, encoding: 'utf-8',
      });

      expect(terminal.stdout.trim().split('\n')).toEqual(['from-a', 'from-b']);
    });

    it.skipIf(!hasBashAtLeast(0, 0, '/bin/bash'))('switches env before the member\'s scalar PROMPT_COMMAND', async () => {
      const a = await project('scalar-prompt-order');
      await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);
      const elsewhere = path.join(tmpDir, 'scalar-prompt-outside');
      await fse.ensureDir(elsewhere);

      const env: NodeJS.ProcessEnv = {
        HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash', SHARED: 'mine', PROMPT_COMMAND: 'printf "hook:%s:%s:%s\\n" "$SHARED" "$?" "${PIPESTATUS[*]}"',
      };
      const terminal = spawnSync('/bin/bash', ['-i'], {
        cwd: elsewhere, env, encoding: 'utf-8',
        input: `false\nfalse | true\ncd '${a.projectRoot}'\nprintenv SHARED\ncd '${elsewhere}'\nprintenv SHARED\nexit\n`,
      });

      expect(terminal.stdout.trim().split('\n').filter((line) => !line.startsWith('hook:'))).toEqual(['project', 'mine']);
      expect(terminal.stdout.split('\n').filter((line) => line.startsWith('hook:'))).toEqual([
        'hook:mine:0:0', 'hook:mine:1:1', 'hook:mine:0:1 0', 'hook:project:0:0', 'hook:project:0:0', 'hook:mine:0:0', 'hook:mine:0:0',
      ]);
    });

    it.skipIf(!hasBashAtLeast(5, 1))('preserves command status in a scalar PROMPT_COMMAND', async () => {
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);
      const elsewhere = path.join(tmpDir, 'elsewhere');
      await fse.ensureDir(elsewhere);

      const env: NodeJS.ProcessEnv = {
        HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash', SHARED: 'mine', PROMPT_COMMAND: 'printf "hook:%s:%s:%s\\n" "$SHARED" "$?" "${PIPESTATUS[*]}"',
      };
      const terminal = spawnSync('bash', ['-i'], {
        cwd: elsewhere, env, encoding: 'utf-8',
        input: `false | true\ncd '${a.projectRoot}'\nprintenv SHARED\ncd '${elsewhere}'\nprintenv SHARED\nexit\n`,
      });

      expect(terminal.stdout.trim().split('\n').filter((line) => !line.startsWith('hook:'))).toEqual(['project', 'mine']);
      expect(terminal.stdout.split('\n').filter((line) => line.startsWith('hook:'))).toEqual([
        'hook:mine:0:0', 'hook:mine:0:1 0', 'hook:project:0:0', 'hook:project:0:0', 'hook:mine:0:0', 'hook:mine:0:0',
      ]);
    });

    // The member's scalar hook sees the $? and PIPESTATUS the command left, as it
    // would without the loader: negation and pipefail included.
    it.each([...new Set(['/bin/bash', 'bash'])].filter((bash) => hasBashAtLeast(0, 0, bash)))('%s gives a scalar PROMPT_COMMAND the status the command left', async (bash) => {
      const a = await project('scalar-prompt-status');
      await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);
      const hook = 'PROMPT_COMMAND=\'printf "hook:%s:%s\\n" "$?" "${PIPESTATUS[*]}"\'\n';
      const bare = path.join(tmpDir, 'bare-home');
      await fse.outputFile(path.join(bare, '.bashrc'), hook);
      const bashrc = path.join(homeDir, '.bashrc');
      await fse.writeFile(bashrc, hook + await fse.readFile(bashrc, 'utf-8'));
      const commands = ['true', 'false', '! true', '! false', 'true | false', 'false | true', '! true | false', '! false | true'];
      const input = ['+o', '-o'].flatMap((option) => [`set ${option} pipefail`, ...commands]).join('\n');
      const hooks = (home: string): string[] => {
        const run = spawnSync(bash, ['-i'], {
          cwd: a.projectRoot, encoding: 'utf-8', input: `${input}\nexit\n`,
          env: { HOME: home, PATH: process.env.PATH, SHELL: '/bin/bash' },
        });
        return run.stdout.split('\n').filter((line) => line.startsWith('hook:'));
      };

      const withoutLoader = hooks(bare);
      expect(withoutLoader).toContain('hook:1:0');
      expect(hooks(homeDir)).toEqual(withoutLoader);
    });

    it.skipIf(!hasBashAtLeast(5, 1))('routes before array prompt hooks and preserves their command status', async () => {
      const a = await project('prompt-order-a');
      const b = await project('prompt-order-b');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);
      await fse.writeFile(path.join(homeDir, '.bashrc'), [
        "member_prompt() { printf 'hook:%s:%s:%s\\n' \"$MARKER\" \"$?\" \"${PIPESTATUS[*]}\"; }",
        "PROMPT_COMMAND=('member_prompt')",
        `. '${path.join(homeDir, '.teamai', 'env-loader.sh')}'`,
        '',
      ].join('\n'));
      const run = spawnSync('bash', ['-i'], {
        cwd: a.projectRoot,
        env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash' },
        input: `false | true\ncd '${b.projectRoot}'\n. '${path.join(homeDir, '.teamai', 'env-loader.sh')}'\nprintf 'hooks:%s\\n' "\${PROMPT_COMMAND[*]}"\nexit\n`,
        encoding: 'utf-8',
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('hook:from-a:0:1 0');
      expect(run.stdout).toContain('hook:from-b:0:0');
      expect(run.stdout).toContain('hooks:__teamai_env_apply member_prompt');
    });

    // RHEL-family /etc/bashrc sets an entry like `printf "\033]0;%s\007" ...`.
    it.skipIf(!hasBashAtLeast(5, 1))('keeps an array prompt hook whole when it holds a `;`', async () => {
      const a = await project('prompt-array-semicolon');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
      await fse.writeFile(path.join(homeDir, '.bashrc'), [
        `PROMPT_COMMAND=('printf "title;%s\\n" "$MARKER"')`,
        `. '${loader}'`,
        '',
      ].join('\n'));
      const run = spawnSync('bash', ['-i'], {
        cwd: a.projectRoot,
        env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash' },
        input: `:\n. '${loader}'\nprintf 'hooks:%s\\n' "\${PROMPT_COMMAND[*]}"\nexit\n`,
        encoding: 'utf-8',
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).not.toContain('bash: PROMPT_COMMAND');
      expect(run.stdout).toContain('title;from-a');
      expect(run.stdout).toContain('hooks:__teamai_env_apply printf "title;%s\\n" "$MARKER"');
    });

    const promptBashes = [...new Set(['/bin/bash', 'bash'])].filter((bash) => hasBashAtLeast(0, 0, bash));
    const promptEdits = promptBashes.flatMap((bash) => [
      { bash, separator: ';', edit: 'PROMPT_COMMAND="$PROMPT_COMMAND; member_extra"' },
      { bash, separator: 'newline', edit: 'PROMPT_COMMAND="$PROMPT_COMMAND"$\'\\n\'"member_extra"' },
    ]);
    it.each(promptEdits)('$bash keeps one routing hook first when the member extends PROMPT_COMMAND after the loader ($separator)', async ({ bash, edit }) => {
      const a = await project('extend-prompt-a');
      const b = await project('extend-prompt-b');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);
      const bashrc = path.join(homeDir, '.bashrc');
      await fse.writeFile(bashrc, [
        "member_prompt() { printf 'hook:%s:%s\\n' \"$MARKER\" \"$?\"; }",
        "member_extra() { printf 'extra:%s\\n' \"$MARKER\"; }",
        'PROMPT_COMMAND=member_prompt',
        await fse.readFile(bashrc, 'utf-8'),
        edit,
        '',
      ].join('\n'));
      const run = spawnSync(bash, ['-i'], {
        cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash' }, encoding: 'utf-8', timeout: 20_000,
        input: `false\ncd '${b.projectRoot}'\nprintf 'hooks:%s|%s\\n' "\${#PROMPT_COMMAND[@]}" "\${PROMPT_COMMAND[*]}"\nexit\n`,
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.split('\n').filter((line) => /^(hook|extra):/.test(line))).toEqual([
        'hook:from-a:0', 'extra:from-a', 'hook:from-a:1', 'extra:from-a', 'hook:from-b:0', 'extra:from-b', 'hook:from-b:0', 'extra:from-b',
      ]);
      expect(run.stdout.split('\n').filter((line) => line.startsWith('hooks:'))).toEqual(['hooks:1|__teamai_env_prompt "$?" "${PIPESTATUS[@]}"']);
    });

    const promptForms = promptBashes.flatMap((bash) => [
      { bash, form: 'unset', setup: 'unset PROMPT_COMMAND' },
      { bash, form: 'empty', setup: 'PROMPT_COMMAND=' },
      { bash, form: 'local', setup: 'PROMPT_COMMAND=member_prompt' },
      { bash, form: 'exported', setup: 'export PROMPT_COMMAND=member_prompt' },
      { bash, form: 'array', setup: 'PROMPT_COMMAND=(member_prompt member_second)' },
    ]);
    it.each(promptForms)('$bash runs the member hooks and restores a $form PROMPT_COMMAND on uninstall', async ({ bash, setup }) => {
      const a = await project('prompt-form');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      const bashrc = path.join(homeDir, '.bashrc');
      const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
      await fse.writeFile(bashrc, [
        "member_prompt() { printf 'hook:%s\\n' \"$MARKER\"; }",
        'member_second() { :; }',
        setup,
        '__member_before=$(declare -p PROMPT_COMMAND 2>&1)',
        await fse.readFile(bashrc, 'utf-8'),
      ].join('\n'));
      const run = spawnSync(bash, ['-i'], {
        cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash' }, encoding: 'utf-8', timeout: 20_000,
        input: `:\nrm '${loader}'\n:\nif [ "$(declare -p PROMPT_COMMAND 2>&1)" = "$__member_before" ]; then echo restored; else printf 'changed:%s\\n' "$(declare -p PROMPT_COMMAND 2>&1)"; fi\nexit\n`,
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('restored');
      const firstHook = run.stdout.split('\n').find((line) => line.startsWith('hook:'));
      expect(firstHook).toBe(setup.includes('member_prompt') ? 'hook:from-a' : undefined);
    });

    it.each(promptBashes)('%s keeps an exported PROMPT_COMMAND in a child shell', async (bash) => {
      const a = await project('prompt-child');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      const run = spawnSync(bash, ['-i'], {
        cwd: a.projectRoot, encoding: 'utf-8', timeout: 20_000,
        env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash', PROMPT_COMMAND: 'printf "hook:%s:$BASH_SUBSHELL$SHLVL\\n" "$MARKER"' },
        input: `printf 'exit\\n' | '${bash}' -i\nexit\n`,
      });

      expect(run.status, run.stderr).toBe(0);
      expect(new Set(run.stdout.split('\n').filter((line) => line.startsWith('hook:')).map((line) => line.replace(/\d+$/, '')))).toEqual(new Set(['hook:from-a:']));
      expect(new Set(run.stdout.split('\n').filter((line) => line.startsWith('hook:'))).size).toBe(2);
    });

    it.skipIf(!hasShell('zsh'))('routes before zsh chpwd and precmd hooks and keeps one first entry after re-sourcing', async () => {
      const a = await project('chpwd-order-a');
      const b = await project('chpwd-order-b');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);
      const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
      const run = spawnSync('zsh', ['-i', '-c', [
        'member_chpwd() { print -r -- "hook:$MARKER" }',
        'chpwd_functions=(member_chpwd)',
        'member_precmd() { :; }',
        'precmd_functions=(member_precmd)',
        `. '${loader}'`,
        `. '${loader}'`,
        `cd '${b.projectRoot}'`,
        'print -r -- "hooks:${(j: :)chpwd_functions}"',
        'print -r -- "precmd:${(j: :)precmd_functions}"',
        `rm '${loader}'`,
        '__teamai_env_precmd',
        'print -r -- "after uninstall:${(j: :)chpwd_functions}|${(j: :)precmd_functions}"',
      ].join('\n')], {
        cwd: a.projectRoot,
        env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh' },
        encoding: 'utf-8',
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('hook:from-b');
      expect(run.stdout).toContain('hooks:__teamai_env_apply member_chpwd');
      expect(run.stdout).toContain('precmd:__teamai_env_precmd member_precmd');
      expect(run.stdout).toContain('after uninstall:member_chpwd|member_precmd');
    });

    // .zshrc runs after the block in .zshenv: a line that replaces chpwd_functions must not leave the shell on the first directory's env.
    it.skipIf(!hasShell('zsh'))('routes a cd in an interactive zsh whose .zshrc replaces chpwd_functions', async () => {
      const a = await project('chpwd-replaced-a');
      const b = await project('chpwd-replaced-b');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);
      await fse.outputFile(path.join(homeDir, '.zshrc'), 'member_chpwd() { :; }\nchpwd_functions=(member_chpwd)\n');

      const run = spawnSync('zsh', ['-i'], {
        cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh' }, encoding: 'utf-8', timeout: 20_000,
        input: `print -r -- "first:$MARKER"\ncd '${b.projectRoot}'\nprint -r -- "after cd:$MARKER"\nzsh -c 'print -r -- "child:$MARKER"'\ncd '${a.projectRoot}' && print -r -- "same line:$MARKER"\nexit\n`,
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.split('\n').filter((line) => /^(first|after cd|child|same line):/.test(line))).toEqual([
        'first:from-a', 'after cd:from-b', 'child:from-b', 'same line:from-a',
      ]);
    });

    // zsh restores $? before each precmd function it calls, so the routing hook ahead of the member's changes nothing they read.
    it.skipIf(!hasShell('zsh'))('keeps the last status for zsh precmd hooks after it and for the prompt', async () => {
      const a = await project('precmd-status');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await fse.outputFile(path.join(homeDir, '.zshrc'), [
        'member_precmd() { print -r -- "hook:$?" }',
        'precmd_functions=(member_precmd)',
        `. '${path.join(homeDir, '.teamai', 'env-loader.sh')}'`,
        "PROMPT='prompt:%?>'",
        '',
      ].join('\n'));
      const run = spawnSync('zsh', ['-i'], {
        cwd: a.projectRoot, encoding: 'utf-8', timeout: 20_000,
        env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh' },
        input: 'print -r -- "precmd:${(j: :)precmd_functions}"\nfalse\n(exit 7)\nexit 0\n',
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('precmd:__teamai_env_precmd member_precmd');
      expect(run.stdout.split('\n').filter((line) => line.startsWith('hook:'))).toEqual(['hook:0', 'hook:0', 'hook:1', 'hook:7']);
      expect(`${run.stdout}${run.stderr}`.match(/prompt:\d+>/g)).toEqual(['prompt:0>', 'prompt:0>', 'prompt:1>', 'prompt:7>']);
    });

    const r1Cases = ['PATH', 'GIT_DIR']
      .flatMap((key) => ['startup', 'cd/chpwd', 'prompt hook', 'BASH_ENV child'].map((entry) => ({ key, entry })))
      .filter(({ entry }) => (entry === 'cd/chpwd' ? hasShell('zsh') : hasShell('bash')));

    it.each(r1Cases)('unapplies $key before $entry resolves the new directory', async ({ key, entry }) => {
      const a = await project('a');
      const b = await project('b');
      const teamValue = key === 'GIT_DIR' ? path.join(a.projectRoot ?? '', '.git') : '/no-such-path';
      const shellName = entry === 'cd/chpwd' ? '/bin/zsh' : '/bin/bash';
      vi.stubEnv('SHELL', shellName);
      await handler.writeResolvedEnv([{ key, value: teamValue }, { key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);
      const env: NodeJS.ProcessEnv = {
        HOME: homeDir, PATH: process.env.PATH, SHELL: shellName,
        ...(entry === 'cd/chpwd' ? {} : { BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh') }),
      };
      let output = '';
      if (entry === 'startup') {
        const shell = env.SHELL === '/bin/zsh' ? 'zsh' : 'bash';
        const first = spawnSync(shell, ['-c', `'${process.execPath}' -e 'process.stdout.write(JSON.stringify(process.env))'`], {
          cwd: a.projectRoot, env, encoding: 'utf-8',
        });
        const inherited = JSON.parse(first.stdout) as NodeJS.ProcessEnv;
        output = spawnSync(`/bin/${shell}`, ['-c', `printf '%s\\n' "$MARKER"`], { cwd: b.projectRoot, env: inherited, encoding: 'utf-8' }).stdout;
      } else if (entry === 'cd/chpwd') {
        output = spawnSync('/bin/zsh', ['-i', '-c', `cd '${b.projectRoot}'; print -r -- "$MARKER"`], { cwd: a.projectRoot, env, encoding: 'utf-8' }).stdout;
      } else if (entry === 'prompt hook') {
        output = spawnSync('/bin/bash', ['-i'], {
          cwd: a.projectRoot, env: { ...env, SHELL: '/bin/bash' }, encoding: 'utf-8',
          input: `cd '${b.projectRoot}'\nprintf '%s\\n' "$MARKER"\nexit\n`,
        }).stdout;
      } else {
        output = spawnSync('/bin/bash', ['-c', `cd '${b.projectRoot}'; /bin/bash -c 'printf "%s\\n" "$MARKER"'`], {
          cwd: a.projectRoot, env, encoding: 'utf-8',
        }).stdout;
      }

      expect(output).toContain('from-b');
    });

    const r3Cases = ['startup', 'cd', 'BASH_ENV child']
      .filter((entry) => (entry === 'cd' ? hasShell('zsh') : hasShell('bash')));

    it.each(r3Cases)('restores env keys after a sourced file removes sed and git from PATH during $entry', async (entry) => {
      const a = await project('r3-a');
      const elsewhere = path.join(tmpDir, 'r3-elsewhere');
      await fse.ensureDir(elsewhere);
      const userConfig = {
        repo: { localPath: path.join(tmpDir, 'team-repo'), remote: teamConfig.repo }, username: 'member',
        updatePolicy: 'auto', additionalRoles: [], scope: 'user',
      } as LocalConfig;
      await handler.writeResolvedEnv([{ key: 'PATH', value: '/no-sed-or-git' }], teamConfig, userConfig);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, { ...a, inheritUserScope: true });
      const shell = entry === 'cd' ? '/bin/zsh' : '/bin/bash';
      const env: NodeJS.ProcessEnv = {
        HOME: homeDir, PATH: process.env.PATH, SHELL: shell,
        BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh'),
      };
      let output = '';
      if (entry === 'startup') {
        const first = spawnSync('/bin/bash', ['-c', `'${process.execPath}' -e 'process.stdout.write(JSON.stringify(process.env))'`], {
          cwd: a.projectRoot, env, encoding: 'utf-8',
        });
        const inherited = JSON.parse(first.stdout) as NodeJS.ProcessEnv;
        expect(inherited.MARKER).toBe('from-a');
        output = spawnSync('/bin/bash', ['-c', `printf '%s\\n' "\${MARKER-unset}"`], {
          cwd: elsewhere, env: inherited, encoding: 'utf-8',
        }).stdout;
      } else if (entry === 'cd') {
        output = spawnSync('/bin/zsh', ['-i', '-c', `cd '${elsewhere}'; print -r -- "\${MARKER-unset}"`], {
          cwd: a.projectRoot, env, encoding: 'utf-8',
        }).stdout;
      } else {
        output = spawnSync('/bin/bash', ['-c', `cd '${elsewhere}'; /bin/bash -c 'printf "%s\\n" "\${MARKER-unset}"'`], {
          cwd: a.projectRoot, env, encoding: 'utf-8',
        }).stdout;
      }

      expect(output.trim()).toBe('unset');
    });

    it.skipIf(!hasShell('bash') || !hasBashAtLeast(5, 1))('preserves PROMPT_COMMAND arrays and removes only the loader hook when the env is unapplied', async () => {
      const a = await project('a');
      const b = await project('b');
      await fse.writeFile(path.join(homeDir, '.bashrc'), [
        "first() { printf 'first\\n'; }",
        "second() { printf 'second\\n'; }",
        "PROMPT_COMMAND=('first' 'second')",
        '',
      ].join('\n'));
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);
      const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
      const run = spawnSync('bash', ['-i'], {
        cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash' }, encoding: 'utf-8',
        input: `cd '${b.projectRoot}'\nprintf '%s\\n' "$MARKER"\n__teamai_env_unapply\nprintf '%s\\n' "\${PROMPT_COMMAND[*]}"\n__teamai_env_hook\nrm '${loader}'\nprintf '%s\\n' "\${PROMPT_COMMAND[*]}"\nexit\n`,
      });

      expect(run.stdout).toContain('from-b');
      expect(run.stdout).toContain('first second');
      expect(run.stdout).not.toContain('__teamai_env_apply');
    });
  });
});
