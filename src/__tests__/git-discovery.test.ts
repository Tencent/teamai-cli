import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitFindsNoRepository, linkedWorktreesStamp } from '../utils/git-discovery.js';
import { GIT_REPOSITORY_ENV } from '../utils/git-env.js';
import { checkoutLocation, gitCommonDir, isDedicatedRepoRoot, listWorktrees } from '../utils/git.js';

describe('gitFindsNoRepository', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-discovery-')));
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) vi.stubEnv(name, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** What git itself answers in `dir`. */
  function gitFindsRepository(dir: string): boolean {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  it('agrees with git outside any checkout', async () => {
    const dir = path.join(root, 'a', 'b');
    fs.mkdirSync(dir, { recursive: true });

    // True wherever the temp dir is outside every repository, as on CI.
    expect(await gitFindsNoRepository(dir)).toBe(!gitFindsRepository(dir));
  });

  it('is false in a checkout and below it', async () => {
    const dir = path.join(root, 'repo', 'sub');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'repo') });

    expect(await gitFindsNoRepository(dir)).toBe(false);
  });

  it('is false in a linked worktree, whose .git is a file', async () => {
    const dir = path.join(root, 'wt');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');

    expect(await gitFindsNoRepository(dir)).toBe(false);
  });

  it('is false in a bare repository and inside a git directory', async () => {
    const bare = path.join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);

    expect(await gitFindsNoRepository(bare)).toBe(false);
    expect(await gitFindsNoRepository(path.join(bare, 'refs', 'heads'))).toBe(false);
  });

  it('is false when the environment names a repository', async () => {
    vi.stubEnv('GIT_DIR', path.join(root, 'elsewhere.git'));

    expect(await gitFindsNoRepository(root)).toBe(false);
  });
});

describe('linkedWorktreesStamp', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-worktrees-stamp-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, stdio: 'ignore' });
  };

  it('stays equal while nothing changes, and changes with a lock and a prune', async () => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'commit', '--allow-empty', '-q', '-m', 'init');
    const commonDir = path.join(repo, '.git');
    const wt = path.join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, 'HEAD');

    const added = await linkedWorktreesStamp(commonDir);
    expect(await linkedWorktreesStamp(commonDir)).toBe(added);

    git(repo, 'worktree', 'lock', wt);
    const locked = await linkedWorktreesStamp(commonDir);
    expect(locked).not.toBe(added);

    git(repo, 'worktree', 'unlock', wt);
    fs.rmSync(wt, { recursive: true, force: true });
    const deleted = await linkedWorktreesStamp(commonDir);
    git(repo, 'worktree', 'prune');
    expect(await linkedWorktreesStamp(commonDir)).not.toBe(deleted);
  });
});

describe('what teamai answers without git, against git itself', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-agrees-')));
    for (const name of GIT_REPOSITORY_ENV) vi.stubEnv(name, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const tryGit = (cwd: string, ...args: string[]): string | null => {
    try {
      return git(cwd, ...args);
    } catch {
      return null;
    }
  };
  const repo = (dir: string, ...initArgs: string[]): string => {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', ...initArgs);
    return dir;
  };
  const dirAt = (...parts: string[]): string => {
    const dir = path.join(root, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const symlink = (target: string, ...parts: string[]): string => {
    const link = path.join(root, ...parts);
    fs.symlinkSync(target, link, 'dir');
    return link;
  };

  /** Each answer as git gives it in `dir`. */
  function fromGit(dir: string) {
    const common = tryGit(dir, 'rev-parse', '--git-common-dir');
    const located = tryGit(dir, 'rev-parse', '--show-toplevel', '--show-prefix', '--git-common-dir');
    const [toplevel = '', prefix = '', commonDir = ''] = located?.split('\n') ?? [];
    const listed = tryGit(dir, 'worktree', 'list', '--porcelain');
    // Git prints a relative path from where it runs, the real directory.
    const real = fs.realpathSync(dir);
    const realCommon = common === null ? null : fs.realpathSync(path.resolve(real, common.trim()));
    return {
      noRepository: tryGit(dir, 'rev-parse', '--git-dir') === null,
      location: located === null ? null : { toplevel, prefix, commonDir: fs.realpathSync(path.resolve(real, commonDir)) },
      commonDir: realCommon,
      dedicated: located === null ? common === null || tryGit(dir, 'rev-parse', '--show-toplevel') === null
        : fs.realpathSync(toplevel) === real,
      worktrees: listed === null ? [] : listed.split('\n\n').filter((entry) => !/^(bare|prunable)/m.test(entry))
        .map((entry) => /^worktree (.+)$/m.exec(entry)?.[1]).filter((p): p is string => !!p)
        .map((p) => fs.realpathSync(p)).filter((p) => p !== realCommon),
    };
  }

  /** The same answers from teamai's lookups, which ask git only when they cannot tell. */
  async function fromTeamai(dir: string) {
    const location = await checkoutLocation(dir);
    return {
      noRepository: await gitFindsNoRepository(dir),
      location: location && { toplevel: location.toplevel, prefix: location.prefix, commonDir: location.commonDir },
      commonDir: await gitCommonDir(dir),
      dedicated: await isDedicatedRepoRoot(dir),
      worktrees: await listWorktrees(dir),
    };
  }

  /**
   * Teamai's answers equal git's. Not ruling a repository out, and a null
   * location, are teamai asking git instead, never another answer.
   */
  async function expectAgrees(dir: string): Promise<void> {
    const expected = fromGit(dir);
    const actual = await fromTeamai(dir);
    expect({
      ...actual,
      noRepository: actual.noRepository || expected.noRepository,
      location: actual.location ?? expected.location,
    }).toEqual(expected);
  }

  /** A case with `change` is asked, changed, and asked again: a remembered answer must still be git's. */
  const cases: Array<{ name: string; dir: () => string; change?: (dir: string) => void }> = [
    { name: 'a repository root', dir: () => repo(dirAt('repo')) },
    { name: 'a directory inside one', dir: () => (repo(dirAt('repo')), dirAt('repo', 'sub')) },
    { name: 'a symlink to a directory inside one', dir: () => (repo(dirAt('repo')), symlink(dirAt('repo', 'sub'), 'alias')) },
    { name: 'a symlink inside one to a directory outside any', dir: () => (repo(dirAt('repo')), symlink(dirAt('plain'), 'repo', 'out')) },
    { name: 'a repository nested in another', dir: () => (repo(dirAt('outer')), repo(dirAt('outer', 'inner'))) },
    { name: 'outside any repository', dir: () => dirAt('plain') },
    { name: 'a bare repository', dir: () => repo(dirAt('origin.git'), '--bare') },
    { name: 'inside a git directory', dir: () => path.join(repo(dirAt('repo')), '.git', 'refs') },
    {
      name: 'a linked worktree',
      dir: () => {
        const main = repo(dirAt('main'));
        git(main, 'commit', '--allow-empty', '-q', '-m', 'init');
        git(main, 'worktree', 'add', '-q', path.join(root, 'linked'), 'HEAD');
        return dirAt('linked', 'sub');
      },
    },
    {
      name: 'a repository created inside one already answered for',
      dir: () => (repo(dirAt('outer')), dirAt('outer', 'inner')),
      change: (dir) => repo(dir),
    },
    {
      name: 'a nested repository removed',
      dir: () => (repo(dirAt('outer')), repo(dirAt('outer', 'inner'))),
      change: (dir) => fs.rmSync(path.join(dir, '.git'), { recursive: true }),
    },
    {
      name: 'a symlink moved to another directory of its repository',
      dir: () => (repo(dirAt('repo')), dirAt('repo', 'b'), symlink(dirAt('repo', 'a'), 'alias')),
      change: (dir) => (fs.unlinkSync(dir), fs.symlinkSync(path.join(root, 'repo', 'b'), dir, 'dir')),
    },
    {
      name: 'the enclosing repository removed below a .git git does not take for one',
      dir: () => (repo(dirAt('repo')), dirAt('repo', 'sub', '.git'), path.join(root, 'repo', 'sub')),
      change: () => fs.rmSync(path.join(root, 'repo', '.git'), { recursive: true }),
    },
    {
      name: 'the environment handing git another repository',
      dir: () => (repo(dirAt('other')), repo(dirAt('repo'))),
      change: () => vi.stubEnv('GIT_DIR', path.join(root, 'other', '.git')),
    },
  ];

  it.each(cases)('$name', async ({ dir: build, change }) => {
    const dir = build();
    await expectAgrees(dir);
    if (!change) return;

    change(dir);
    await expectAgrees(dir);
  });
});
