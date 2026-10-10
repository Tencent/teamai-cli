import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { EnvHandler } from '../resources/env.js';
import { directoryEnv, envLoaderFilesForProjects } from '../resources/env-loader.js';
import { projectDataHome } from '../utils/partition.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

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

    const files = await envLoaderFilesForProjects();

    expect(files).toContain(partition);
  });

  it('does not preserve a partition from a malformed project registry row', async () => {
    const partition = projectDataHome(path.join(tmpDir, 'unregistered'));
    await fse.ensureDir(partition);
    await fse.writeFile(path.join(homeDir, '.teamai', 'env-scopes'), `stamp\ttest\ndir\t${tmpDir}\t-\t0\n`);

    expect(await envLoaderFilesForProjects()).not.toContain(partition);
  });

  it.skipIf(process.platform === 'win32')('keeps a literal backslash in a POSIX partition path', async () => {
    const partition = `${tmpDir}/data\\name`;
    await fse.ensureDir(partition);
    await fse.writeFile(path.join(homeDir, '.teamai', 'env-scopes'), `stamp\ttest\ndir\t${tmpDir}\t-\t0\t${partition}\n`);

    expect(await envLoaderFilesForProjects()).toContain(partition);
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

  describe('restores the member environment exactly', () => {
    const shells = ['bash', 'zsh'].filter(hasShell);
    const states = [
      { name: 'unset', setup: '', expected: 'unset' },
      { name: 'local', setup: 'TOKEN=mine', expected: 'local:mine' },
      { name: 'exported', setup: 'export TOKEN=mine', expected: 'exported:mine' },
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
        expect(run.stdout.trim().split('\n').slice(-1)[0]).toBe(`parent=${state.expected}`);
        if (child) expect(run.stdout).toContain(`child=${state.name === 'exported' ? state.expected : 'unset'}\n`);
      },
    );
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

    it('says once that user env no longer loads in projects when the profile had both kinds of block', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const { log } = await import('../utils/logger.js');
      const a = await project('a');
      await fse.writeFile(path.join(homeDir, '.zshrc'), [
        oldBlock(path.join(homeDir, '.teamai', 'env.sh')),
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
    // only its login files); every zsh, `zsh -c` too, reads only .zshenv.
    it.each([
      { shell: 'zsh', override: '.zshrc', loaderIn: '.zshenv', warns: true },
      { shell: 'zsh', override: '.config/zsh/team.zsh', loaderIn: '.zshenv', warns: true },
      { shell: 'zsh', override: '.bash_profile', loaderIn: '.zshenv', warns: false },
      { shell: 'zsh', override: '.zshenv', loaderIn: '.zshenv', warns: false },
      { shell: 'bash', override: '.bash_profile', loaderIn: '.bash_profile', warns: false },
      { shell: 'bash', override: '.zshrc', loaderIn: '.bashrc', warns: true },
    ].filter(({ shell }) => hasShell(shell)))('puts the loader of a $shell member whose team sets shellProfilePath to ~/$override in ~/$loaderIn, moving an older block out', async ({ shell, override, loaderIn, warns }) => {
      vi.stubEnv('SHELL', `/bin/${shell}`);
      const { log } = await import('../utils/logger.js');
      const a = await project('a');
      const overridden = path.join(homeDir, override);
      await fse.outputFile(overridden, `${oldBlock(path.join(a.dataHome ?? '', 'env.sh'))}\n`);
      const config = { ...teamConfig, sharing: { ...teamConfig.sharing, env: { injectShellProfile: true, shellProfilePath: `~/${override}` } } };

      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], config, a);

      const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
      expect(await fse.readFile(path.join(homeDir, loaderIn), 'utf-8')).toContain(loader);
      if (overridden !== path.join(homeDir, loaderIn)) expect(await blocksIn(overridden)).toBe(0);
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
      { key: '__TEAMAI_ENV_FILES', value: '/tmp/team-env.sh' },
      { key: '__teamai_env_loader', value: '/tmp/team-loader.sh' },
    ])('ignores team env control variable $key and warns that it is reserved', async ({ key, value }) => {
      const a = await project('reserved');
      const { log } = await import('../utils/logger.js');

      await handler.writeResolvedEnv([{ key, value }], teamConfig, a);

      expect(await fse.readFile(path.join(a.dataHome ?? '', 'env.sh'), 'utf-8')).not.toContain(`export ${key}=`);
      expect(vi.mocked(log.warn).mock.calls.some(([message]) => String(message).includes('reserved for TeamAI shell routing'))).toBe(true);
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

      it('puts the user scope\'s variables under a project that inherits it, the project winning a shared key', async () => {
        const a = { ...await project('a'), inheritUserScope: true };
        await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);

        expect(shellSees('zsh', a.projectRoot ?? '', 'USER_ONLY')).toBe('u');
        expect(shellSees('zsh', a.projectRoot ?? '', 'SHARED')).toBe('project');
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

    it.skipIf(!hasBashAtLeast(0, 0, '/bin/bash'))('switches env at the prompt after cd and keeps the member\'s scalar PROMPT_COMMAND', async () => {
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);
      const elsewhere = path.join(tmpDir, 'elsewhere');
      await fse.ensureDir(elsewhere);

      const env: NodeJS.ProcessEnv = {
        HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash', SHARED: 'mine', PROMPT_COMMAND: 'echo kept',
      };
      const terminal = spawnSync('/bin/bash', ['-i'], {
        cwd: elsewhere, env, encoding: 'utf-8',
        input: `cd '${a.projectRoot}'\nprintenv SHARED\ncd '${elsewhere}'\nprintenv SHARED\nexit\n`,
      });

      expect(terminal.stdout.trim().split('\n').filter((line) => line !== 'kept')).toEqual(['project', 'mine']);
      expect(terminal.stdout).toContain('kept');
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
