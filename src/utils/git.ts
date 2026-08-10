import fs from 'node:fs';
import path from 'node:path';
import fse from 'fs-extra';
import simpleGit, { type SimpleGit } from 'simple-git';
import { log } from './logger.js';

/**
 * Create a SimpleGit instance for a given base path.
 *
 * Authentication is handled by credentials embedded in the remote URL
 * (set during clone by the provider). No credential-helper injection needed.
 */
export function createGit(basePath?: string): SimpleGit {
  if (basePath) {
    return simpleGit({ baseDir: basePath });
  }
  return simpleGit();
}

/**
 * Check whether localPath is a valid git repository (has a `.git` entry).
 *
 * Returns false if the path does not exist, or exists but is not a git repo
 * (e.g. a leftover directory from a previous non-git source such as an HTTP
 * repo). Callers use this to avoid running git commands against a non-repo.
 */
export async function isGitRepo(localPath: string): Promise<boolean> {
  if (!(await fse.pathExists(localPath))) {
    return false;
  }
  return fse.pathExists(path.join(localPath, '.git'));
}

/**
 * Initialize an empty git repo at localPath and add the remote.
 * Used as fallback when cloning an empty remote repo doesn't create the directory.
 */
export async function initRepo(remote: string, localPath: string): Promise<void> {
  await fse.ensureDir(localPath);
  const git = simpleGit({ baseDir: localPath });
  await git.init();
  await git.addRemote('origin', remote);
}

/**
 * Configure git user.name and user.email for a repo.
 *
 * If email is not provided and defaultEmailDomain is given,
 * generates `<username>@<domain>`. If neither is provided,
 * skips email configuration (uses git global config).
 */
export async function configureGitUser(
  localPath: string,
  username: string,
  displayName?: string,
  email?: string,
  defaultEmailDomain?: string,
): Promise<void> {
  const git = createGit(localPath);
  const name = displayName || username;
  await git.addConfig('user.name', name);

  const resolvedEmail = email
    || (defaultEmailDomain ? `${username}@${defaultEmailDomain}` : null);

  if (resolvedEmail) {
    await git.addConfig('user.email', resolvedEmail);
    log.debug(`Git user configured: ${name} <${resolvedEmail}>`);
  } else {
    log.debug(`Git user configured: ${name} (email from global git config)`);
  }
}

/**
 * Get the current HEAD commit hash (short form) of a repo.
 */
export async function getHeadRev(localPath: string): Promise<string> {
  const git = createGit(localPath);
  return git.revparse(['--short', 'HEAD']);
}

/**
 * Read the `origin` remote URL of the repo at localPath (or its enclosing repo).
 * Returns null when there is no origin remote or the path is not a git repo.
 * Used by single-repo mode to derive the provider/remote from the business repo.
 */
export async function getRemoteUrl(localPath: string, remoteName = 'origin'): Promise<string | null> {
  const git = createGit(localPath);
  try {
    const url = (await git.raw(['remote', 'get-url', remoteName])).trim();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Whether the repo at localPath has at least one commit reachable from HEAD.
 * A freshly `git init`'d repo (HEAD points at an unborn branch) returns false.
 * Used by single-repo mode: knowledge worktrees/PRs need a base commit to exist.
 */
export async function hasCommits(localPath: string): Promise<boolean> {
  const git = createGit(localPath);
  try {
    // NB: `--quiet` makes git exit 1 silently on an unborn HEAD, and simple-git
    // does not throw on that — so we must validate the OUTPUT (a real sha), not
    // rely on a thrown error. An unborn HEAD yields empty/whitespace output.
    const out = (await git.raw(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    return /^[0-9a-f]{7,40}$/.test(out);
  } catch {
    return false;
  }
}

/**
 * Stage the given pathspecs and commit them on the current branch of the repo at
 * localPath. Best-effort helper for single-repo init: it seeds the business repo
 * with a base commit carrying the committed .teamai/ knowledge skeleton so later
 * knowledge PRs (which branch off HEAD) have something to branch from.
 *
 * Returns true if a commit was created, false if there was nothing to commit.
 * Does NOT push — the user pushes their business repo on their own cadence.
 */
export async function commitPaths(
  localPath: string,
  message: string,
  files: string[],
): Promise<boolean> {
  const git = createGit(localPath);
  const existing = files.filter((f) => fs.existsSync(path.join(localPath, f)));
  if (existing.length === 0) return false;
  // Add each path individually and tolerate `git add` failing on an
  // explicitly-gitignored path (it errors "Use -f if you really want to add
  // them"). Callers should not pass ignored paths, but a stray one must not
  // abort the whole commit. `--` guards against paths that look like options.
  let added = 0;
  for (const f of existing) {
    try {
      await git.add(['--', f]);
      added++;
    } catch {
      // ignored/unaddable path — skip it
    }
  }
  if (added === 0) return false;
  const status = await git.status();
  if (status.staged.length === 0) return false;
  await git.commit(message);
  return true;
}

export async function pullRepo(localPath: string): Promise<string> {
  const git = createGit(localPath);
  const result = await git.pull();
  if (result.summary.changes === 0 && result.summary.insertions === 0 && result.summary.deletions === 0) {
    return 'already up to date';
  }
  return `${result.summary.changes} file(s) changed`;
}

/**
 * Detect the default branch of a repo. Tries in order:
 *   1. origin/HEAD symbolic ref (set by clone or `git remote set-head -a`)
 *   2. origin/main (modern default)
 *   3. origin/master (legacy default)
 *   4. Falls back to 'main'
 *
 * Result is cached per-repo for the process lifetime to avoid repeated git calls.
 */
const defaultBranchCache = new Map<string, string>();
export async function getDefaultBranch(localPath: string): Promise<string> {
  const cached = defaultBranchCache.get(localPath);
  if (cached) return cached;

  const git = createGit(localPath);
  let branch: string | null = null;

  try {
    const ref = (await git.revparse(['--abbrev-ref', 'origin/HEAD'])).trim();
    if (ref.startsWith('origin/')) {
      branch = ref.slice('origin/'.length);
    }
  } catch {
    // origin/HEAD not set; fall through
  }

  if (!branch) {
    for (const candidate of ['main', 'master']) {
      try {
        await git.revparse([`origin/${candidate}`]);
        branch = candidate;
        break;
      } catch {
        // not found; try next
      }
    }
  }

  branch = branch ?? 'main';
  defaultBranchCache.set(localPath, branch);
  return branch;
}

/**
 * Push directly to the current branch (master). Used only during init for first-time setup.
 */
export async function pushRepoDirectly(localPath: string, message: string, files: string[]): Promise<void> {
  const git = createGit(localPath);
  const existingFiles = [];
  for (const f of files) {
    const fullPath = fs.existsSync(`${localPath}/${f}`);
    if (fullPath) existingFiles.push(f);
  }
  if (existingFiles.length === 0) {
    log.debug('No files to add');
    return;
  }
  await git.add(existingFiles);
  const status = await git.status();
  if (status.staged.length === 0) {
    log.debug('Nothing to commit');
    return;
  }
  await git.commit(message);
  // Use --set-upstream for first push on repos initialized from empty remotes
  const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  await git.push(['-u', 'origin', branch]);
}

/**
 * Best-effort push all changes in a team repo clone.
 * Logs success/failure without throwing.
 * @deprecated Use autoPushViaMR instead for import flows.
 */
export async function autoPushTeamRepo(repoPath: string, message: string): Promise<void> {
  try {
    await pushRepoDirectly(repoPath, message, ['.']);
  } catch (err) {
    log.warn(`[git] autoPush failed (non-blocking): ${(err as Error).message}`);
  }
}

/**
 * Push changes via branch + MR/PR instead of direct push to main.
 * Creates a branch, commits, pushes, creates MR, then returns to default branch.
 * Non-blocking: logs warnings on failure without throwing.
 */
export async function autoPushViaMR(
  repoPath: string,
  message: string,
  files: string[],
  teamConfig: { repo: string; provider?: string; reviewers?: string[] },
  localConfig: { repo: { remote: string; localPath: string }; username: string },
): Promise<string | null> {
  try {
    const branchName = generateBranchName(localConfig.username);
    const pushed = await pushRepoBranch(repoPath, message, files, branchName);
    if (!pushed) {
      log.debug('[git] autoPushViaMR: nothing to commit');
      return null;
    }

    const { createPrWithFallback } = await import('../push.js');
    const prUrl = await createPrWithFallback(
      teamConfig, localConfig, branchName, message, message,
    );

    await checkoutMaster(repoPath);
    return prUrl;
  } catch (err) {
    log.warn(`[git] autoPushViaMR failed (non-blocking): ${(err as Error).message}`);
    try { await checkoutMaster(repoPath); } catch { /* best effort */ }
    return null;
  }
}

/**
 * Check whether a unified diff contains only metadata/timestamp changes.
 * If ALL added/removed lines match known timestamp patterns, the diff is
 * metadata-only and should not trigger a new MR.
 */
export function isMetadataOnlyDiff(diff: string): boolean {
  if (!diff.trim()) return true;

  const METADATA_PATTERNS = [
    /^\s*"?lastUpdated"?\s*[:=]/i,
    /^\s*"?lastScan"?\s*[:=]/i,
    /^\s*"?syncedAt"?\s*[:=]/i,
    /^\s*"?generatedAt"?\s*[:=]/i,
    /^\s*"?updatedAt"?\s*[:=]/i,
  ];

  const lines = diff.split('\n');
  for (const line of lines) {
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    const content = line.slice(1);
    if (!content.trim()) continue;
    const isMetadata = METADATA_PATTERNS.some(pat => pat.test(content));
    if (!isMetadata) return false;
  }

  return true;
}

/**
 * Create a new branch, commit files, and push the branch to remote.
 * Returns false if there are no changes to commit (or only metadata changes).
 * Leaves the local repo on the new branch after pushing so that
 * the provider's createPullRequest (which may internally push HEAD)
 * sees the correct branch.
 * Callers should call `checkoutMaster()` when they are done.
 */
export async function pushRepoBranch(
  localPath: string,
  message: string,
  files: string[],
  branchName: string,
): Promise<boolean> {
  const git = createGit(localPath);

  // Create and switch to new branch
  await git.checkoutLocalBranch(branchName);

  // Stage files
  await git.add(files);
  const status = await git.status();
  if (status.staged.length === 0) {
    const defaultBranch = await getDefaultBranch(localPath);
    log.debug(`Nothing to commit, switching back to ${defaultBranch}`);
    await switchToDefaultBranch(git, defaultBranch);
    await git.deleteLocalBranch(branchName, true);
    return false;
  }

  // Second gate: skip if all staged changes are metadata-only (timestamps)
  const diffOutput = await git.diff(['--cached', '--unified=0']);
  if (isMetadataOnlyDiff(diffOutput)) {
    const defaultBranch = await getDefaultBranch(localPath);
    log.debug(`Only metadata/timestamp changes detected, switching back to ${defaultBranch}`);
    await switchToDefaultBranch(git, defaultBranch);
    await git.deleteLocalBranch(branchName, true);
    return false;
  }

  // Commit and push branch
  await git.commit(message);
  await git.push(['-u', 'origin', branchName]);

  return true;
}

/**
 * Switch a repo/worktree back to its default branch, tolerating the case where
 * that branch is already checked out in another worktree.
 *
 * In single-repo mode, teamai stages knowledge PRs in a disposable worktree while
 * the user's active tree holds the same default branch (e.g. `main`). Git refuses
 * `checkout main` in a second worktree ("'main' is already used by worktree ...").
 * That's harmless here: the worktree is about to be destroyed, and in a normal
 * clone a skipped switch self-heals via resetToCleanMaster on the next run. So we
 * swallow that specific conflict rather than letting it abort the whole operation.
 */
async function switchToDefaultBranch(git: SimpleGit, defaultBranch: string): Promise<void> {
  try {
    await git.checkout(defaultBranch);
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (/already (used|checked out) by worktree|is already checked out/i.test(msg)) {
      log.debug(`Skipping switch to ${defaultBranch}: already checked out in another worktree`);
      return;
    }
    throw e;
  }
}

/**
 * Switch the repo back to its default branch (main/master).
 * Used after pushRepoBranch + createPullRequest.
 *
 * Best-effort with respect to the "already used by worktree" conflict (see
 * switchToDefaultBranch): a self-mode knowledge worktree shares the default branch
 * with the user's active tree and is disposable, so failing to switch is a no-op.
 */
export async function checkoutMaster(localPath: string): Promise<void> {
  const git = createGit(localPath);
  const defaultBranch = await getDefaultBranch(localPath);
  await switchToDefaultBranch(git, defaultBranch);
}

/**
 * Generate a branch name for teamai push.
 */
export function generateBranchName(username: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `teamai/push/${username}/${timestamp}`;
}

/**
 * Reset the team repo to a clean default-branch state.
 *
 * The team repo is a local cache — any uncommitted or conflicted state is
 * safe to discard. This handles multiple failure modes:
 *
 *  1. Unmerged files WITHOUT MERGE_HEAD (incomplete merge where HEAD was
 *     removed but conflict markers remain) — `merge --abort` would fail,
 *     so we use `git reset --hard HEAD`.
 *  2. Active merge with MERGE_HEAD — `merge --abort` works, but
 *     `reset --hard` handles this too.
 *  3. Stuck on a stale push branch — switch back to the default branch.
 *  4. Uncommitted modifications — reset discards them.
 */
export async function resetToCleanMaster(git: SimpleGit, localPath?: string): Promise<void> {
  const status = await git.status();
  const hasConflicts = status.conflicted.length > 0;
  const isDirty = hasConflicts
    || status.modified.length > 0
    || status.not_added.length > 0
    || status.created.length > 0;

  if (isDirty) {
    log.debug(
      `Resetting dirty team repo (${status.conflicted.length} conflicted, `
      + `${status.modified.length} modified, ${status.not_added.length} untracked)`,
    );
    await git.reset(['--hard', 'HEAD']);
  }

  // Ensure we're on the default branch (previous push may have left us on a feature branch)
  const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  // Resolve default branch from localPath if given, otherwise infer from origin/HEAD via git
  let defaultBranch = 'main';
  if (localPath) {
    defaultBranch = await getDefaultBranch(localPath);
  } else {
    try {
      const ref = (await git.revparse(['--abbrev-ref', 'origin/HEAD'])).trim();
      if (ref.startsWith('origin/')) defaultBranch = ref.slice('origin/'.length);
    } catch {
      // origin/HEAD not set; use 'main' as best guess
    }
  }
  if (branch !== defaultBranch) {
    log.debug(`Switching from stale branch '${branch}' back to ${defaultBranch}`);
    await git.checkout(defaultBranch);
  }
}

/**
 * Get the raw content of a file at a specific git revision.
 * Uses `git show <rev>:<path>` to retrieve historical file content.
 * Returns null if the file doesn't exist at that revision or if the rev is invalid.
 */
export async function getFileContentAtRev(
  repoPath: string,
  rev: string,
  filePath: string,
): Promise<Buffer | null> {
  const git = createGit(repoPath);
  try {
    const result = await git.show([`${rev}:${filePath}`]);
    return Buffer.from(result);
  } catch {
    return null;
  }
}

export async function getRepoStatus(localPath: string): Promise<{ ahead: number; behind: number; modified: string[] }> {
  const git = createGit(localPath);
  await git.fetch();
  const status = await git.status();
  return {
    ahead: status.ahead,
    behind: status.behind,
    modified: [...status.modified, ...status.not_added, ...status.created],
  };
}
