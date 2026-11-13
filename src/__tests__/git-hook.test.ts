import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describeMissingGitHook, gitHookStatus, guardedGitHookLine, installGitHook, removeGitHook } from '../git-hook.js';

const gitVersion = (): [number, number] => {
  const m = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }));
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};
const [major, minor] = gitVersion();
const configHooks = major > 2 || (major === 2 && minor >= 54);
const eventDisable = major > 2 || (major === 2 && minor >= 55);

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

describe.skipIf(!configHooks)('teamai git hook in the repository config', () => {
  let sandbox: string;
  let repo: string;
  let home: string;

  const git = (args: string[], cwd = repo) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, HOME: home } });

  /** A `teamai` on the wrapper path that records its arguments, then exits with `code`. */
  const fakeTeamai = (code: number) => {
    const bin = path.join(home, '.teamai', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'teamai'),
      `#!/bin/sh\necho "$@" >> "${path.join(sandbox, 'calls.txt')}"\necho noise\necho noise >&2\nexit ${code}\n`,
      { mode: 0o755 },
    );
  };
  const calls = () => {
    const file = path.join(sandbox, 'calls.txt');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
  };

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-hook-')));
    repo = path.join(sandbox, 'repo');
    home = path.join(sandbox, 'home');
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    git(['init', '-q', '-b', 'main']);
    git(['commit', '-q', '--allow-empty', '-m', 'init']);
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('registers one named hook per event, shared by every worktree', async () => {
    await installGitHook(repo);

    expect(git(['hook', 'list', 'post-checkout']).stdout.trim()).toBe('teamai-post-checkout');
    expect(git(['hook', 'list', 'post-merge']).stdout.trim()).toBe('teamai-post-merge');
    expect(git(['hook', 'list', 'post-rewrite']).stdout.trim()).toBe('teamai-post-rewrite');
    // Written to the common config: a linked worktree sees the same hooks.
    git(['worktree', 'add', '-q', path.join(sandbox, 'wt')]);
    expect(git(['hook', 'list', 'post-checkout'], path.join(sandbox, 'wt')).stdout.trim()).toBe('teamai-post-checkout');
  });

  it('removal drops only teamai\'s hook entries; a dry run reports them and writes nothing', async () => {
    git(['config', '--local', 'hook.mine.command', 'echo mine']);
    git(['config', '--local', 'hook.mine.event', 'post-checkout']);
    expect(await installGitHook(repo, { dryRun: true })).toEqual({ installed: true, changed: true });
    expect(git(['config', '--get-regexp', '^hook\\.teamai']).stdout).toBe('');
    await installGitHook(repo);

    const planned = await removeGitHook(repo, { dryRun: true });
    expect(planned).toEqual(['hook.teamai-post-checkout', 'hook.teamai-post-merge', 'hook.teamai-post-rewrite']);
    expect(git(['config', '--get-regexp', '^hook\\.teamai']).stdout).not.toBe('');

    expect(await removeGitHook(repo)).toEqual(planned);
    expect(git(['config', '--get-regexp', '^hook\\.']).stdout.trim().split('\n'))
      .toEqual(['hook.mine.command echo mine', 'hook.mine.event post-checkout']);
  });

  it('is idempotent', async () => {
    await installGitHook(repo);
    await installGitHook(repo);

    expect(git(['config', '--local', '--get-all', 'hook.teamai-post-checkout.event']).stdout.trim()).toBe('post-checkout');
    expect(git(['config', '--local', '--get-all', 'hook.teamai-post-merge.event']).stdout.trim()).toBe('post-merge');
  });

  it('reports a named hook disabled, preserves the setting on pull and recognizes reactivation', async () => {
    await installGitHook(repo);
    git(['config', '--local', 'hook.teamai-post-checkout.enabled', 'false']);

    expect(await gitHookStatus(repo)).toEqual({
      installed: false, reason: 'disabled', event: 'post-checkout', disabledBy: 'hook', scope: 'local',
    });
    await installGitHook(repo);
    expect(git(['config', '--get', 'hook.teamai-post-checkout.enabled']).stdout.trim()).toBe('false');
    git(['config', '--local', 'hook.teamai-post-checkout.enabled', 'true']);
    expect(await gitHookStatus(repo)).toEqual({ installed: true });
    fakeTeamai(0);
    expect(git(['hook', 'run', 'post-checkout', '--', 'old', 'new', '1']).status).toBe(0);
    expect(calls()).toEqual(['hook-dispatch post-checkout --tool git old new 1']);
  });

  it.each([
    ['--local', 'hook'], ['--local', 'event'], ['--global', 'hook'], ['--global', 'event'],
  ].filter(([, disabledBy]) => disabledBy !== 'event' || eventDisable))('respects effective %s %s disable settings for post-rewrite', async (scope, disabledBy) => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(home, '.gitconfig'));
    try {
      await installGitHook(repo);
      const key = `hook.${disabledBy === 'hook' ? 'teamai-post-rewrite' : 'post-rewrite'}.enabled`;
      expect(git(['config', scope, key, 'false']).status).toBe(0);
      const status = await gitHookStatus(repo);
      expect(status).toEqual({ installed: false, reason: 'disabled', event: 'post-rewrite', disabledBy, scope: scope.slice(2) });
      if (!status.installed) {
        const advice = describeMissingGitHook(status);
        expect(advice).toContain(`${key}=false`);
        expect(advice).toContain(`git config --local ${key} true`);
      }
      await installGitHook(repo);
      expect(git(['config', '--get', key]).stdout.trim()).toBe('false');
      // The local override must be judged by Git, even when global config disables it.
      expect(git(['config', '--local', key, 'true']).status).toBe(0);
      expect(await gitHookStatus(repo)).toEqual({ installed: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('advises unsetting a disable set in per-worktree config, which --local cannot override', async () => {
    await installGitHook(repo);
    git(['config', 'extensions.worktreeConfig', 'true']);
    const key = 'hook.teamai-post-checkout.enabled';
    expect(git(['config', '--worktree', key, 'false']).status).toBe(0);
    const status = await gitHookStatus(repo);
    expect(status).toEqual({ installed: false, reason: 'disabled', event: 'post-checkout', disabledBy: 'hook', scope: 'worktree' });
    const advice = describeMissingGitHook(status as Exclude<typeof status, { installed: true }>);
    expect(advice).toContain(`Run \`git config --worktree --unset ${key}\``);
    expect(advice).not.toContain('git config --local');
    expect(advice).toContain('Teamai pull preserves explicit hook disable settings.');
    expect(git(['config', '--worktree', '--unset', key]).status).toBe(0);
    expect(await gitHookStatus(repo)).toEqual({ installed: true });
  });

  it('names a scope teamai cannot point at, and asks to unset or override it there', () => {
    const advice = describeMissingGitHook({ installed: false, reason: 'disabled', event: 'post-merge', disabledBy: 'hook', scope: 'command' });
    expect(advice).toContain('hook.teamai-post-merge.enabled=false in command config');
    expect(advice).toContain('Unset or override it there');
    expect(advice).not.toContain('git config --local');
    expect(advice).toContain('Teamai pull preserves explicit hook disable settings.');
  });

  it('passes the event and Git\'s arguments to the dispatcher, silently', async () => {
    await installGitHook(repo);
    fakeTeamai(0);

    const r = git(['hook', 'run', 'post-checkout', '--', 'old', 'new', '1']);

    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(calls()).toEqual(['hook-dispatch post-checkout --tool git old new 1']);
  });

  it('exits 0 and prints nothing when the dispatcher fails or teamai is missing', async () => {
    await installGitHook(repo);
    fakeTeamai(3);
    const failing = git(['hook', 'run', 'post-merge', '--', '0']);
    expect(failing.status).toBe(0);
    expect(failing.stdout + failing.stderr).toBe('');
    expect(calls()).toEqual(['hook-dispatch post-merge --tool git 0']);

    // Only git on PATH, so no globally installed teamai can answer.
    fs.rmSync(path.join(home, '.teamai'), { recursive: true, force: true });
    const onlyGit = path.join(sandbox, 'only-git');
    fs.mkdirSync(onlyGit);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.symlinkSync(realGit, path.join(onlyGit, 'git'));
    const missing = spawnSync(realGit, ['hook', 'run', 'post-merge', '--', '0'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${onlyGit}:/usr/bin:/bin` },
    });
    expect(missing.status).toBe(0);
    expect(missing.stdout + missing.stderr).toBe('');
  });
});

describe('teamai hook script on a Git without config hooks', () => {
  let sandbox: string;
  let repo: string;
  let home: string;
  let saved: { PATH?: string; HOME?: string };

  const run = (args: string[], cwd = repo) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  const hookFile = (event: string) => path.join(repo, '.git', 'hooks', event);
  const calls = () => {
    const file = path.join(sandbox, 'calls.txt');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
  };

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-hook-old-')));
    repo = path.join(sandbox, 'repo');
    home = path.join(sandbox, 'home');
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    // Old Git, simulated where teamai reads the version: a `git` on PATH that
    // reports 2.39 and hands every other command to the real one.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const shim = path.join(sandbox, 'old-git');
    fs.mkdirSync(shim);
    fs.writeFileSync(
      path.join(shim, 'git'),
      `#!/bin/sh\nif [ "$1" = --version ]; then echo "git version 2.39.5"; exit 0; fi\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    saved = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = `${shim}${path.delimiter}${process.env.PATH}`;
    process.env.HOME = home;
    run(['init', '-q', '-b', 'main']);
    run(['commit', '-q', '--allow-empty', '-m', 'init']);
  });

  afterEach(() => {
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const fakeTeamai = () => {
    fs.mkdirSync(path.join(home, '.teamai', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.teamai', 'bin', 'teamai'),
      `#!/bin/sh\necho "$@" >> "${path.join(sandbox, 'calls.txt')}"\necho noise\nexit 3\n`,
      { mode: 0o755 },
    );
  };

  it.each(['post-checkout', 'post-rewrite'])('adds a marked block to an existing %s script without changing its other lines', async (event) => {
    const original = '#!/bin/sh\n# the team\'s own hook\necho mine >> "$0.log"\n';
    fs.writeFileSync(hookFile(event), original, { mode: 0o755 });

    expect(await installGitHook(repo)).toEqual({ installed: true, changed: true });
    const text = fs.readFileSync(hookFile(event), 'utf8');
    const block = /# >>> teamai[^\n]*\n[\s\S]*?# <<< teamai[^\n]*\n/.exec(text);
    expect(block).not.toBeNull();
    expect(text.replace(block![0], '')).toBe(original);
    // A second run leaves it alone.
    expect(await installGitHook(repo)).toEqual({ installed: true, changed: false });
    expect(fs.readFileSync(hookFile(event), 'utf8')).toBe(text);
    // post-merge had no script: a new executable one.
    expect(fs.statSync(hookFile('post-merge')).mode & 0o111).not.toBe(0);
    expect(fs.statSync(hookFile('post-rewrite')).mode & 0o111).not.toBe(0);
    expect(await gitHookStatus(repo)).toEqual({ installed: true });
    await removeGitHook(repo);
    expect(fs.readFileSync(hookFile(event), 'utf8')).toBe(original);
    expect(fs.existsSync(hookFile('post-merge'))).toBe(false);
  });

  it('runs the dispatcher with Git\'s arguments, silently, keeping the script\'s own work and exit status', async () => {
    fs.writeFileSync(hookFile('post-checkout'), '#!/bin/sh\necho mine >> "$0.log"\n', { mode: 0o755 });
    await installGitHook(repo);
    fakeTeamai();

    const r = run(['worktree', 'add', '-q', path.join(sandbox, 'wt')]);

    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatch(/^hook-dispatch post-checkout --tool git 0+ [0-9a-f]{40} 1$/);
    expect(fs.readFileSync(`${hookFile('post-checkout')}.log`, 'utf8')).toBe('mine\n');
  });

  it('does not replace an existing hook when reading it fails', async () => {
    const file = hookFile('post-checkout');
    const original = '#!/bin/sh\necho owner-hook-content\n';
    fs.writeFileSync(file, original, { mode: 0o755 });
    fs.chmodSync(file, 0o000);
    try {
      await expect(installGitHook(repo)).rejects.toThrow('permission denied');
      fs.chmodSync(file, 0o755);
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      expect(fs.existsSync(hookFile('post-merge'))).toBe(false);
    } finally {
      fs.chmodSync(file, 0o755);
    }
  });

  it.skipIf(process.platform === 'win32')('leaves a disabled owner hook and its mode untouched', async () => {
    const file = hookFile('post-checkout');
    const original = '#!/bin/sh\nexit 42\n';
    fs.writeFileSync(file, original, { mode: 0o644 });
    expect(await installGitHook(repo)).toEqual({ installed: false, reason: 'other-hook' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(fs.existsSync(hookFile('post-merge'))).toBe(false);
    expect(run(['worktree', 'add', '-q', path.join(sandbox, 'disabled-wt')]).status).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('leaves a symlinked hook and the script it points to untouched', async () => {
    const shared = path.join(sandbox, 'shared-post-checkout');
    const original = '#!/bin/sh\nexit 0\n';
    fs.writeFileSync(shared, original, { mode: 0o755 });
    fs.symlinkSync(shared, hookFile('post-checkout'));
    expect(await installGitHook(repo)).toEqual({ installed: false, reason: 'other-hook' });
    expect(fs.readFileSync(shared, 'utf8')).toBe(original);
    expect(fs.lstatSync(hookFile('post-checkout')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(hookFile('post-merge'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('preserves the permissions of an executable owner hook', async () => {
    fs.writeFileSync(hookFile('post-checkout'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await installGitHook(repo);
    expect(fs.statSync(hookFile('post-checkout')).mode & 0o777).toBe(0o700);
  });

  it('leaves a core.hooksPath manager\'s files alone, and doctor advises upgrading or a guarded line', async () => {
    const managed = path.join(sandbox, 'managed');
    fs.mkdirSync(managed);
    fs.writeFileSync(path.join(managed, 'post-checkout'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    run(['config', 'core.hooksPath', managed]);

    expect(await installGitHook(repo)).toEqual({ installed: false, reason: 'hooks-path' });
    expect(fs.readdirSync(managed)).toEqual(['post-checkout']);
    expect(fs.readFileSync(path.join(managed, 'post-checkout'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect(fs.existsSync(hookFile('post-checkout'))).toBe(false);

    const status = await gitHookStatus(repo);
    expect(status).toMatchObject({ installed: false, reason: 'hooks-path' });
    const advice = describeMissingGitHook(status as Exclude<typeof status, { installed: true }>);
    const upgrade = advice.indexOf('Upgrade Git');
    const guarded = advice.indexOf('command -v teamai >/dev/null 2>&1 && teamai hook-dispatch post-checkout --tool git "$@"');
    expect(upgrade).toBeGreaterThan(-1);
    expect(guarded).toBeGreaterThan(upgrade);
    expect(advice).toContain('teamai hook-dispatch post-merge --tool git "$@"');
    expect(advice).toContain('sh -c');
  });

  it('a dry run reports the change without writing the hook', async () => {
    expect(await installGitHook(repo, { dryRun: true })).toEqual({ installed: true, changed: true });
    expect(fs.existsSync(hookFile('post-checkout'))).toBe(false);
    expect(fs.existsSync(hookFile('post-merge'))).toBe(false);
  });

  it('removal takes out only the block, and the script teamai created', async () => {
    const original = '#!/bin/sh\necho mine >> "$0.log"\n';
    fs.writeFileSync(hookFile('post-checkout'), original, { mode: 0o755 });
    await installGitHook(repo);

    const planned = await removeGitHook(repo, { dryRun: true });
    expect(planned).toEqual([hookFile('post-checkout'), hookFile('post-merge'), hookFile('post-rewrite')]);
    expect(fs.readFileSync(hookFile('post-checkout'), 'utf8')).not.toBe(original);

    expect(await removeGitHook(repo)).toEqual(planned);
    expect(fs.readFileSync(hookFile('post-checkout'), 'utf8')).toBe(original);
    expect(fs.existsSync(hookFile('post-merge'))).toBe(false);
    expect(await removeGitHook(repo)).toEqual([]);
  });

  it.skipIf(!configHooks)('after a Git upgrade, the config hook replaces the block (no double dispatch)', async () => {
    const original = '#!/bin/sh\necho mine >> "$0.log"\n';
    fs.writeFileSync(hookFile('post-checkout'), original, { mode: 0o755 });
    await installGitHook(repo);
    process.env.PATH = saved.PATH;

    expect(await installGitHook(repo)).toEqual({ installed: true, changed: true });
    expect(fs.readFileSync(hookFile('post-checkout'), 'utf8')).toBe(original);
    expect(fs.existsSync(hookFile('post-merge'))).toBe(false);
    expect(fs.existsSync(hookFile('post-rewrite'))).toBe(false);
    expect(run(['hook', 'list', 'post-checkout']).stdout).toContain('teamai-post-checkout');
  });

  it('the guarded line does nothing and exits 0 without teamai', () => {
    const line = guardedGitHookLine('post-checkout');
    const r = spawnSync('/bin/sh', ['-c', line, 'post-checkout', '0', '1', '1'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: home },
    });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
  });
});
