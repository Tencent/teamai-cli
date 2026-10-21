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
      name: 'core.worktree set to another directory',
      dir: () => (repo(dirAt('repo')), dirAt('elsewhere'), path.join(root, 'repo')),
      change: (dir) => git(dir, 'config', 'core.worktree', path.join(root, 'elsewhere')),
    },
    {
      name: 'core.worktree set in the per-worktree config',
      dir: () => {
        const dir = repo(dirAt('repo'));
        git(dir, 'config', 'extensions.worktreeConfig', 'true');
        dirAt('elsewhere');
        return dir;
      },
      change: (dir) => git(dir, 'config', '--worktree', 'core.worktree', path.join(root, 'elsewhere')),
    },
    {
      // Git finds the work tree from the repository's own config, never from a
      // file it includes, so the stamp leaves included files out: this case
      // fails first should git ever read them there.
      name: 'core.worktree changed in a file the config includes',
      dir: () => {
        const main = repo(dirAt('repo'));
        const included = path.join(root, 'included.cfg');
        fs.writeFileSync(included, `[core]\n\tworktree = ${main}\n`);
        git(main, 'config', 'include.path', included);
        return dirAt('repo', 'sub');
      },
      change: (dir) => fs.writeFileSync(path.join(root, 'included.cfg'), `[core]\n\tworktree = ${dir}\n`),
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

describe('a later run', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-later-')));
    for (const name of GIT_REPOSITORY_ENV) vi.stubEnv(name, undefined);
    fs.mkdirSync(path.join(root, 'tmp'));
    vi.stubEnv('TMPDIR', path.join(root, 'tmp'));
    vi.stubEnv('TMP', path.join(root, 'tmp'));
    vi.stubEnv('TEMP', path.join(root, 'tmp'));
  });

  const checkout = (): { repo: string; sub: string } => {
    const repo = path.join(root, 'repo');
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    return { repo, sub };
  };

  const laterRunWithoutGit = async (): Promise<typeof import('../utils/git.js')> => {
    vi.resetModules();
    vi.stubEnv('PATH', path.join(root, 'no-git'));
    return import('../utils/git.js');
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.getuid === undefined)('answers from what an earlier run asked git, without starting git', async () => {
    const { repo, sub } = checkout();
    const earlier = { location: await checkoutLocation(sub), worktrees: await listWorktrees(sub) };
    expect(earlier.location?.toplevel).toBe(repo);
    expect(earlier.worktrees).toEqual([repo]);

    const later = await laterRunWithoutGit();
    expect({ location: await later.checkoutLocation(sub), worktrees: await later.listWorktrees(sub) }).toEqual(earlier);
  });

  it.skipIf(process.getuid === undefined)('keeps every answer an earlier run asked for at once', async () => {
    const { repo } = checkout();
    const dirs = ['a', 'b', 'c', 'd'].map((name) => path.join(repo, name));
    for (const dir of dirs) fs.mkdirSync(dir);
    const earlier = await Promise.all(dirs.map((dir) => checkoutLocation(dir)));

    const later = await laterRunWithoutGit();
    expect(await Promise.all(dirs.map((dir) => later.checkoutLocation(dir)))).toEqual(earlier);
  });

  it.skipIf(process.getuid === undefined)('reads no answers another release kept', async () => {
    const { sub } = checkout();
    expect(await checkoutLocation(sub)).not.toBeNull();

    vi.doMock('../package-info.js', () => ({ getCurrentVersion: () => '0.0.0-another-release' }));
    try {
      const later = await laterRunWithoutGit();
      expect(await later.checkoutLocation(sub)).toBeNull();
    } finally {
      vi.doUnmock('../package-info.js');
    }
  });

  it.skipIf(process.getuid === undefined)('answers in a submodule from what an earlier run asked git', async () => {
    const { repo } = checkout();
    const lib = path.join(root, 'lib');
    fs.mkdirSync(lib);
    execFileSync('git', ['init', '-q'], { cwd: lib });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: lib });
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib'], { cwd: repo });
    const submodule = path.join(repo, 'lib');
    const earlier = await checkoutLocation(submodule);
    expect(earlier?.toplevel).toBe(submodule);

    const later = await laterRunWithoutGit();
    expect(await later.checkoutLocation(submodule)).toEqual(earlier);
  });

  it('answers nothing for a directory removed since an earlier run', async () => {
    const { sub } = checkout();
    expect(await checkoutLocation(sub)).not.toBeNull();

    fs.rmSync(sub, { recursive: true });
    const later = await laterRunWithoutGit();
    expect(await later.checkoutLocation(sub)).toBeNull();
  });

  it('asks git again for a checkout whose work tree moved since an earlier run', async () => {
    const { repo, sub } = checkout();
    expect((await checkoutLocation(sub))?.toplevel).toBe(repo);

    execFileSync('git', ['config', 'core.worktree', sub], { cwd: repo });
    vi.resetModules();
    const later = await import('../utils/git.js');
    expect((await later.checkoutLocation(sub))?.toplevel).toBe(sub);
  });

  // Where the symlink points first and then, relative to the checkout, the
  // core.worktree value, and the config line that sets it.
  const retargets: Array<{ name: string; from: string; to: string; value: (link: string) => string; line?: boolean }> = [
    { name: 'to a subdirectory', from: 'sub', to: 'other', value: (link) => link },
    { name: 'to its own checkout', from: '.', to: 'other', value: (link) => link },
    { name: 'followed before a parent segment', from: 'sub/inside', to: 'other/inside', value: (link) => `${link}/..` },
    { name: 'set after another section header on its line', from: 'sub', to: 'other', value: (link) => link, line: true },
  ];

  it.each(retargets)('asks git again for a work tree named through a symlink $name, retargeted since', async ({ from, to, value, line }) => {
    const { repo } = checkout();
    for (const dir of [from, to]) fs.mkdirSync(path.join(repo, dir), { recursive: true });
    const link = path.join(root, 'link');
    fs.symlinkSync(path.join(repo, from), link);
    if (line) fs.appendFileSync(path.join(repo, '.git', 'config'), `[unused] [core] worktree = ${value(link)}\n`);
    else execFileSync('git', ['config', 'core.worktree', value(link)], { cwd: repo });
    const gitToplevel = (): string => execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim();
    expect((await checkoutLocation(repo))?.toplevel).toBe(gitToplevel());

    fs.rmSync(link);
    fs.symlinkSync(path.join(repo, to), link);
    vi.resetModules();
    const later = await import('../utils/git.js');
    expect((await later.checkoutLocation(repo))?.toplevel).toBe(gitToplevel());
  });

  it('asks git again for a relative work tree whose symlink, beside a git directory linked as .git, was retargeted', async () => {
    const project = path.join(root, 'project');
    const ext = path.join(root, 'ext');
    for (const dir of [path.join(project, 'wt'), path.join(ext, 'a'), path.join(ext, 'b')]) fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', path.join(ext, 'gd')]);
    execFileSync('git', ['config', 'core.bare', 'false'], { cwd: path.join(ext, 'gd') });
    execFileSync('git', ['config', 'core.worktree', '../wt'], { cwd: path.join(ext, 'gd') });
    fs.symlinkSync(path.join(ext, 'gd'), path.join(project, '.git'));
    fs.symlinkSync(path.join(ext, 'a'), path.join(ext, 'wt'));
    const gitToplevel = (): string => execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: project, encoding: 'utf8' }).trim();
    expect((await checkoutLocation(project))?.toplevel).toBe(gitToplevel());

    fs.rmSync(path.join(ext, 'wt'));
    fs.symlinkSync(path.join(ext, 'b'), path.join(ext, 'wt'));
    vi.resetModules();
    const later = await import('../utils/git.js');
    expect((await later.checkoutLocation(project))?.toplevel).toBe(gitToplevel());
  });

  it('lists a worktree added after an earlier run asked', async () => {
    const { repo, sub } = checkout();
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
    expect(await listWorktrees(sub)).toEqual([repo]);

    const linked = path.join(root, 'linked');
    execFileSync('git', ['worktree', 'add', '-q', linked, 'HEAD'], { cwd: repo });
    vi.resetModules();
    const later = await import('../utils/git.js');
    expect(await later.listWorktrees(sub)).toEqual([repo, linked]);
  });

  it('lists no main checkout made bare in its own config after an earlier run asked', async () => {
    const { repo } = checkout();
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
    const linked = path.join(root, 'linked');
    execFileSync('git', ['worktree', 'add', '-q', linked, 'HEAD'], { cwd: repo });
    execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: repo });
    expect(await listWorktrees(linked)).toEqual([repo, linked]);

    execFileSync('git', ['config', '--worktree', 'core.bare', 'true'], { cwd: repo });
    vi.resetModules();
    const later = await import('../utils/git.js');
    expect(await later.listWorktrees(linked)).toEqual([linked]);
  });

  // How the main checkout is made bare after an earlier run listed it: the
  // config read then, and the change the later run must see.
  const madeBare: Array<{ name: string; before: (repo: string, linked: string) => void; change: (repo: string, linked: string) => void }> = [
    {
      name: 'in a file its config includes',
      before: (repo) => {
        fs.writeFileSync(path.join(root, 'included.cfg'), '[core]\n\tbare = false\n');
        fs.appendFileSync(path.join(repo, '.git', 'config'), `[include]\n\tpath = ${path.join(root, 'included.cfg')}\n`);
      },
      change: () => fs.writeFileSync(path.join(root, 'included.cfg'), '[core]\n\tbare = true\n'),
    },
    {
      name: 'in a file its config includes from a header after another on its line',
      before: (repo) => {
        fs.writeFileSync(path.join(root, 'included.cfg'), '[core]\n\tbare = false\n');
        fs.appendFileSync(path.join(repo, '.git', 'config'), `[core][include]\n\tpath = ${path.join(root, 'included.cfg')}\n`);
      },
      change: () => fs.writeFileSync(path.join(root, 'included.cfg'), '[core]\n\tbare = true\n'),
    },
    {
      name: 'in the asking worktree\'s own config',
      before: (repo) => execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: repo }),
      change: (_repo, linked) => execFileSync('git', ['config', '--worktree', 'core.bare', 'true'], { cwd: linked }),
    },
    {
      name: 'by the environment',
      before: () => undefined,
      change: () => {
        vi.stubEnv('GIT_CONFIG_COUNT', '1');
        vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare');
        vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
      },
    },
  ];

  it.each(madeBare)('lists the main checkout as git does once made bare $name after an earlier run asked', async ({ before, change }) => {
    const { repo } = checkout();
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
    const linked = path.join(root, 'linked');
    execFileSync('git', ['worktree', 'add', '-q', linked, 'HEAD'], { cwd: repo });
    before(repo, linked);
    expect(await listWorktrees(linked)).toEqual([repo, linked]);

    change(repo, linked);
    const gitLists = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: linked, encoding: 'utf8' });
    vi.resetModules();
    const later = await import('../utils/git.js');
    expect(await later.listWorktrees(linked)).toEqual(gitLists.includes('\nbare\n') ? [linked] : [repo, linked]);
  });

  it.skipIf(process.getuid === undefined)('trusts no answers kept where another user can write', async () => {
    fs.mkdirSync(path.join(root, 'tmp', `teamai-${process.getuid?.()}`), { mode: 0o777 });
    fs.chmodSync(path.join(root, 'tmp', `teamai-${process.getuid?.()}`), 0o777);
    const { sub } = checkout();
    expect(await checkoutLocation(sub)).not.toBeNull();

    const later = await laterRunWithoutGit();
    expect(await later.checkoutLocation(sub)).toBeNull();
  });

  it('keeps no answers where it cannot tell the directory is this user\'s alone', async () => {
    const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    try {
      const { sub } = checkout();
      expect(await checkoutLocation(sub)).not.toBeNull();

      const later = await laterRunWithoutGit();
      expect(await later.checkoutLocation(sub)).toBeNull();
    } finally {
      if (getuid) Object.defineProperty(process, 'getuid', getuid);
    }
  });
});
