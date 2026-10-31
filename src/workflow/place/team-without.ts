/**
 * The team commit a clone installs for a treatment `{ without: paths }`: the treatment's revision without those files
 * and directories, made from git plumbing in the clone's own bare team repo, with no network.
 */
import type { Git } from '../worktree.js';

/** Who made a commit without some paths, and when: fixed, so its id depends on its tree and parent alone. */
const MADE_BY = 'teamai <teamai@localhost> 0 +0000';

/**
 * Makes, in `repo`, the commit of `revision`'s tree without the files and directories `paths` name, whose parent is
 * `revision`, with a fixed author, committer, date and message: the same revision and paths make the same commit in any
 * repo. `repo` is a bare repo that holds `revision`; its index, which a bare repo does not use, holds the tree as it is
 * made. Paths are read literally, never as globs.
 */
export async function commitWithout(git: Git, { repo, revision, paths }: { repo: string; revision: string; paths: readonly string[] }): Promise<{ commit: string } | { failed: string }> {
  const listed = await git(repo, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', revision, '--', ...paths]);
  if (listed.code !== 0) return { failed: `git ls-tree: ${listed.stderr.trim()}` };
  const read = await git(repo, ['read-tree', revision]);
  if (read.code !== 0) return { failed: `git read-tree: ${read.stderr.trim()}` };
  // update-index runs only with a work tree, and --force-remove never reads it.
  const removed = await git(repo, [`--work-tree=${repo}`, 'update-index', '--force-remove', '-z', '--stdin'], { input: listed.stdout });
  if (removed.code !== 0) return { failed: `git update-index: ${removed.stderr.trim()}` };
  const tree = await git(repo, ['write-tree']);
  if (tree.code !== 0) return { failed: `git write-tree: ${tree.stderr.trim()}` };
  const message = `teamai: ${revision} without ${paths.join(', ')}`;
  const made = await git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: `tree ${tree.stdout.trim()}\nparent ${revision}\nauthor ${MADE_BY}\ncommitter ${MADE_BY}\n\n${message}\n`,
  });
  return made.code === 0 ? { commit: made.stdout.trim() } : { failed: `git hash-object: ${made.stderr.trim()}` };
}
