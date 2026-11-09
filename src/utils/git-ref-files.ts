import fs from 'node:fs/promises';
import path from 'node:path';

/** A remote-tracking ref and the commit it points at. */
export interface RefTip {
  /** The full ref name, such as `refs/remotes/origin/main`. */
  ref: string;
  sha: string;
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The ref `origin/HEAD` names and its tip, read from the files of the git dir
 * `dir` belongs to, without starting git: a hook pays for every git process.
 *
 * Follows a `.git` file (a linked worktree, a submodule) and `commondir`, and
 * reads the loose ref before `packed-refs`, as git does. Anything else, such
 * as an environment that points git elsewhere, no `origin/HEAD`, or another
 * ref format, answers null, and the caller asks git.
 */
export async function readOriginHeadFromFiles(dir: string): Promise<RefTip | null> {
  if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_CEILING_DIRECTORIES) return null;

  try {
    const gitDir = await findGitDir(path.resolve(dir));

    if (!gitDir) return null;
    const commonDir = await readCommonDir(gitDir);
    const head = /^ref: (refs\/remotes\/origin\/\S+)\s*$/.exec(await fs.readFile(path.join(commonDir, 'refs', 'remotes', 'origin', 'HEAD'), 'utf8'));

    if (!head) return null;
    const sha = await readRefSha(commonDir, head[1]);

    return sha ? { ref: head[1], sha } : null;
  } catch {
    return null;
  }
}

/** The git dir of the repository `dir` is in: the nearest `.git` directory, or the one a `.git` file names. */
async function findGitDir(dir: string): Promise<string | null> {
  for (let current = dir; ; current = path.dirname(current)) {
    const dotGit = path.join(current, '.git');
    const stat = await fs.stat(dotGit).catch(() => null);

    if (stat?.isDirectory()) return dotGit;

    if (stat?.isFile()) {
      const named = /^gitdir: (.+)$/m.exec(await fs.readFile(dotGit, 'utf8'));

      return named ? path.resolve(current, named[1].trim()) : null;
    }

    if (path.dirname(current) === current) return null;
  }
}

/** Where a linked worktree's shared refs live: its `commondir`, or the git dir itself. */
async function readCommonDir(gitDir: string): Promise<string> {
  const common = await fs.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => null);

  return common === null ? gitDir : path.resolve(gitDir, common.trim());
}

/** `ref`'s commit from its loose file, then from `packed-refs`; null when neither has it. */
async function readRefSha(commonDir: string, ref: string): Promise<string | null> {
  const loose = await fs.readFile(path.join(commonDir, ...ref.split('/')), 'utf8').catch(() => null);

  if (loose !== null) return SHA.test(loose.trim()) ? loose.trim() : null;
  const packed = await fs.readFile(path.join(commonDir, 'packed-refs'), 'utf8').catch(() => null);

  for (const line of packed?.split('\n') ?? []) {
    const [sha, name] = line.trim().split(' ');

    if (name === ref && SHA.test(sha)) return sha;
  }

  return null;
}
