import fs from 'node:fs';
import path from 'node:path';
import { GIT_REPOSITORY_ENV } from './git-env.js';

const exists = (p: string): Promise<boolean> => fs.promises.lstat(p).then(() => true, () => false);

/** Where git starts looking from `dir`: its real path, symlinks resolved, as the working directory git runs in reads. */
const realDir = (dir: string): Promise<string> => fs.promises.realpath(dir).catch(() => path.resolve(dir));

/**
 * The `.git` entry, or else the `HEAD`, git finds first at or above `real`
 * (see realDir) when it looks for a repository; null when none. Git walks up
 * the real path: a symlink's own parents are never searched.
 */
async function firstRepositoryEntry(real: string): Promise<{ file: string; stat: fs.Stats } | null> {
  const lstat = (file: string): Promise<fs.Stats | null> => fs.promises.lstat(file).catch(() => null);
  for (let at = real; ; at = path.dirname(at)) {
    const [dotGit, head] = await Promise.all([lstat(path.join(at, '.git')), lstat(path.join(at, 'HEAD'))]);
    if (dotGit) return { file: path.join(at, '.git'), stat: dotGit };
    if (head) return { file: path.join(at, 'HEAD'), stat: head };
    if (path.dirname(at) === at) return null;
  }
}

/**
 * Whether git is sure to find no repository for `dir`, told without starting
 * it. Git looks for one at `dir` and every directory above it: a `.git` entry
 * there, or the directory being a git directory itself (a bare repository, or
 * inside a `.git`), which holds `HEAD`. With neither anywhere, and no
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` naming one, every git command
 * that needs a repository fails there. Anything found is left to git to judge.
 *
 * A project outside git, and the user scope, asked git several times per
 * command and got the same failure each time: a few lstat calls instead of a
 * process each.
 */
export async function gitFindsNoRepository(dir: string): Promise<boolean> {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return false;
  return await firstRepositoryEntry(await realDir(dir)) === null;
}

/**
 * What tells a later read of an entry from this one: none, or its device and
 * inode, and for a file its last change and size. Not a directory's last
 * change: git writing its config or index there changes nothing git finds.
 */
const identity = (stat: fs.Stats | null): number[] | null =>
  stat && (stat.isDirectory() ? [stat.dev, stat.ino] : [stat.dev, stat.ino, stat.mtimeMs, stat.size]);

/**
 * Which repository git finds for `dir`, told without starting it: `dir`'s real
 * path, the entry gitFindsNoRepository looks for, the git directory git opens
 * from it (`.git` itself, the one a `.git` file names, or the directory
 * holding `HEAD`), and the identity of each, of its `HEAD`, of the common
 * directory it names and of the config files there (`core.worktree`, also
 * in `config.worktree`; git never takes it from a file those include), plus
 * the variables that stop git's search, and the real path each `core.worktree`
 * there resolves to, since git follows its symlinks. While the stamp stays
 * equal, what git said about where `dir` sits still holds, provided git
 * opened `gitDir`: a symlink pointed elsewhere, a repository moved, cloned
 * again, broken, removed, created inside it later, or given another work tree
 * changes it. Null when `dir` is missing or git finds none, when the
 * environment hands git a repository (GIT_REPOSITORY_ENV), which no file
 * tells, and when a `worktree =` line names no path this can resolve.
 */
export async function repositoryStamp(dir: string): Promise<{ stamp: string; gitDir: string } | null> {
  if (GIT_REPOSITORY_ENV.some((name) => process.env[name] !== undefined)) return null;
  // A directory gone since is no repository git enters, whatever was said about it.
  const real = await fs.promises.realpath(dir).catch(() => null);
  if (real === null) return null;
  const entry = await firstRepositoryEntry(real);
  if (!entry) return null;
  let gitDir = path.dirname(entry.file);
  let link = '';
  if (path.basename(entry.file) === '.git') {
    link = entry.stat.isFile() ? await fs.promises.readFile(entry.file, 'utf8').catch(() => '') : '';
    const named = /^gitdir: (.+)$/m.exec(link)?.[1]?.trim();
    gitDir = named ? path.resolve(path.dirname(entry.file), named) : entry.file;
  }
  const stat = (file: string): Promise<fs.Stats | null> => fs.promises.stat(file).catch(() => null);
  const commonDirFile = (await fs.promises.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
  const configFiles = [path.join(gitDir, 'config'), path.join(gitDir, 'config.worktree'), path.join(path.resolve(gitDir, commonDirFile), 'config')];
  const [gitDirStat, head, config, worktreeConfig, commonConfig] = await Promise.all([
    stat(gitDir), stat(path.join(gitDir, 'HEAD')), ...configFiles.map(stat),
  ]);
  const workTrees = await configuredWorkTrees(gitDir, configFiles);
  if (workTrees === null) return null;
  const search = [process.env.GIT_CEILING_DIRECTORIES, process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM];
  return {
    stamp: JSON.stringify([real, entry.file, identity(entry.stat), link, gitDir, identity(gitDirStat), identity(head),
      commonDirFile, identity(config), identity(worktreeConfig), identity(commonConfig), workTrees, search]),
    gitDir,
  };
}

/**
 * The real path of every `worktree =` value in `configFiles`, a relative one
 * taken from `gitDir` as git takes `core.worktree`, and followed as written,
 * so a symlink before a `..` resolves first. Lines in any section count, so
 * none is missed. Null when a line names `worktree` in a form this does not
 * read, or a value is quoted, escaped, commented or does not resolve: the
 * stamp could not follow it.
 */
async function configuredWorkTrees(gitDir: string, configFiles: readonly string[]): Promise<string[] | null> {
  const texts = await Promise.all(configFiles.map((file) => fs.promises.readFile(file, 'utf8').catch(() => '')));
  const values: string[] = [];
  for (const line of texts.flatMap((text) => text.split('\n')).filter((line) => /\bworktree\b/i.test(line))) {
    const value = /^\s*(?:\[[^\]"]*\]\s*)*worktree\s*=(.*)$/i.exec(line)?.[1]?.trim();
    if (value === undefined || /["\\#;]/.test(value)) return null;
    values.push(value);
  }
  const reals = await Promise.all(values.map((value) =>
    fs.promises.realpath(path.isAbsolute(value) ? value : `${gitDir}${path.sep}${value}`).catch(() => null)));
  return reals.every((real) => real !== null) ? reals : null;
}

/**
 * What `git worktree list` reads about the linked worktrees of the repository
 * whose common directory is `commonDir`, from git's own files: each worktree's
 * admin directory, where its checkout is, whether that is still there, and its
 * lock, and the config saying whether the main entry is bare (the common
 * `config`, each checkout's own `config.worktree`, and the `GIT_CONFIG*`
 * variables). Equal stamps mean an equal list; adding, moving, deleting,
 * locking or pruning a worktree changes it. Null when the admin directory
 * cannot be read for another reason than being absent: no stamp then tells
 * that list from an empty one. Null too when that config includes another
 * file, where git may also read `core.bare` and no stamp follows it.
 */
export async function linkedWorktreesStamp(commonDir: string): Promise<string | null> {
  const config = await configStamp([path.join(commonDir, 'config'), path.join(commonDir, 'config.worktree')]);
  if (config === null) return null;
  const env = Object.keys(process.env).filter((name) => name.startsWith('GIT_CONFIG')).sort().map((name) => [name, process.env[name]]);
  const admin = path.join(commonDir, 'worktrees');
  const names = await fs.promises.readdir(admin).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : null);
  if (names === null) return null;
  names.sort();
  const entries = await Promise.all(names.map(async (name) => {
    const dir = path.join(admin, name);
    const gitdir = (await fs.promises.readFile(path.join(dir, 'gitdir'), 'utf8').catch(() => '')).trim();
    const [live, locked, worktreeConfig] = await Promise.all([
      gitdir !== '' && fs.promises.stat(path.resolve(dir, gitdir)).then(() => true, () => false),
      exists(path.join(dir, 'locked')),
      configStamp([path.join(dir, 'config.worktree')]),
    ]);
    return worktreeConfig === null ? null : JSON.stringify([name, gitdir, live, locked, worktreeConfig]);
  }));
  if (entries.includes(null)) return null;
  return [JSON.stringify([config, env]), ...entries].join('\n');
}

/**
 * The identity of each config file in `files`, or null when one includes
 * another file, which no stamp follows. Any `[include` counts, wherever it
 * stands on its line: a false match only costs keeping the answer.
 */
async function configStamp(files: readonly string[]): Promise<Array<number[] | null> | null> {
  const read = await Promise.all(files.map(async (file) => {
    const [stat, text] = await Promise.all([
      fs.promises.stat(file).catch(() => null), fs.promises.readFile(file, 'utf8').catch(() => ''),
    ]);
    return { id: identity(stat), text };
  }));
  return read.some(({ text }) => /\[\s*include/i.test(text)) ? null : read.map(({ id }) => id);
}
