/**
 * Branch tracking for standalone git team repos.
 *
 * teamai's sync loop follows getDefaultBranch(), which reads the local
 * origin/HEAD symbolic ref. Pinning a team repo to a product-line branch
 * therefore means: checkout the branch, point tracking and origin/HEAD at it,
 * and keep that state healthy on every pull.
 *
 * All helpers are no-ops unless localConfig.repo.branch is set (kind 'git').
 */
import { createGit } from './git.js';
import { log } from './logger.js';
import fs from 'node:fs';
import path from 'node:path';

/** Thrown when the configured tracking branch no longer exists on the remote. */
export class BranchVanishedError extends Error {
  constructor(branch: string) {
    super(
      `Branch '${branch}' does not exist on the remote. It may have been renamed or deleted. ` +
        `Check the team repo's current branch names (git ls-remote --heads origin), then re-run ` +
        `teamai init --branch <new-name>, or edit repo.branch in .teamai/config.yaml.`,
    );
    this.name = 'BranchVanishedError';
  }
}

/** Cheap remote existence check for a branch (one ls-remote round-trip). */
async function remoteBranchExists(git: ReturnType<typeof createGit>, branch: string): Promise<boolean> {
  try {
    const refs = await git.raw(['ls-remote', 'origin', `refs/heads/${branch}`]);
    return refs.trim().length > 0;
  } catch {
    return true; // cannot tell — assume present, let later git calls surface real errors
  }
}

export interface BranchAwareConfig {
  repo: {
    localPath: string;
    kind?: string;
    branch?: string;
  };
}

/** The configured tracking branch, or null when tracking the default branch. */
export function configuredBranch(localConfig: BranchAwareConfig): string | null {
  if (localConfig.repo.kind && localConfig.repo.kind !== 'git') return null;
  const b = localConfig.repo.branch?.trim();
  return b ? b : null;
}

/**
 * Pin the clone at localPath to `branch`: fetch it, create/checkout a local
 * branch tracking origin/<branch>, and repoint origin/HEAD so every
 * getDefaultBranch() consumer (pull reset, push MR target, roles, remove)
 * follows it. Throws when the remote branch does not exist.
 */
export async function pinCloneToBranch(localPath: string, branch: string): Promise<void> {
  const git = createGit(localPath);
  try {
    await git.fetch(['origin', branch]);
  } catch (e) {
    // Distinguish "branch gone" (renamed / deleted on the remote) from real
    // network errors, so members get an actionable message instead of a raw
    // transport error after e.g. a product-line branch rename.
    try {
      if (!(await remoteBranchExists(git, branch))) {
        throw new BranchVanishedError(branch);
      }
    } catch (e2) {
      if (e2 instanceof BranchVanishedError) throw e2;
      // ls-remote itself failed — surface the original fetch error.
    }
    throw e;
  }
  const localExists = await git.branchLocal().then(bs => bs.all.includes(branch)).catch(() => false);
  if (localExists) {
    await git.checkout(branch);
  } else {
    // Create the local branch FROM the remote ref. A bare `checkout -b` forks
    // off the current HEAD (the default branch right after a fresh clone),
    // leaving the pinned branch at the wrong position — later `git pull` then
    // fails with "Need to specify how to reconcile divergent branches".
    await git.checkoutBranch(branch, `origin/${branch}`);
  }
  await git.branch([`--set-upstream-to=origin/${branch}`, branch]);
  await git.raw(['remote', 'set-head', 'origin', branch]);
  log.info(`Team repo pinned to branch '${branch}'`);
}

/**
 * Heal drift detected on pull: wrong branch checked out, missing upstream
 * tracking, or origin/HEAD pointing elsewhere. Returns true when any repair
 * happened (callers should invalidate their revision cache accordingly).
 */
export async function ensureBranchState(localConfig: BranchAwareConfig): Promise<boolean> {
  const branch = configuredBranch(localConfig);
  if (!branch) return false;
  const git = createGit(localConfig.repo.localPath);

  // Abort early (and loudly) when the branch vanished from the remote — e.g.
  // a product-line rename. Syncing from a stale clone or silently falling
  // back to the default branch would ship the wrong skill set.
  if (!(await remoteBranchExists(git, branch))) {
    throw new BranchVanishedError(branch);
  }

  let repaired = false;

  const current = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  if (current !== branch) {
    await pinCloneToBranch(localConfig.repo.localPath, branch);
    repaired = true;
  }

  const tracking = await git.branch().then(b => (b.branches[branch] as { tracking?: string } | undefined)?.tracking).catch(() => null);
  if (tracking !== `origin/${branch}`) {
    await git.branch([`--set-upstream-to=origin/${branch}`, branch]);
    repaired = true;
    log.debug(`Restored tracking origin/${branch}`);
  }

  const head = await git.revparse(['--abbrev-ref', 'origin/HEAD']).catch(() => '');
  if (head.trim() !== `origin/${branch}`) {
    await git.raw(['remote', 'set-head', 'origin', branch]);
    repaired = true;
    log.debug(`Restored origin/HEAD -> origin/${branch}`);
  }

  // Diverged from upstream (local and remote each hold exclusive commits).
  // The pinned clone is a disposable mirror of the branch — real contributions
  // go through MR branches — so realign it to the remote tip. Any local-only
  // commits are logged (and remain recoverable via git reflog) before reset.
  // This also heals a legacy mis-pinned branch (created from the default
  // branch position by the pre-fix pinCloneToBranch).
  try {
    // Fetch FIRST: the local tracking ref may be stale, and divergence is
    // judged against the up-to-date remote tip.
    await git.fetch(['origin', branch]);
    const counts = (await git.raw(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`])).trim();
    const [localOnly, remoteOnly] = counts.split(/\s+/).map(Number);
    if (localOnly > 0 && remoteOnly > 0) {
      const discarded = (await git.raw(['log', '--oneline', `origin/${branch}..HEAD`])).trim();
      if (discarded) {
        log.info(`Branch diverged from origin/${branch}; discarding ${localOnly} local-only commit(s) (kept in reflog):`);
        for (const line of discarded.split('\n').slice(0, 5)) log.dim(`  ${line}`);
      }
      await git.reset(['--hard', `origin/${branch}`]);
      repaired = true;
    }
  } catch (e) {
    log.debug(`Divergence check skipped: ${(e as Error).message}`);
  }

  return repaired;
}

// ─── Installed-skills ledger (orphan cleanup) ────────────────

interface LedgerEntry { tool: string; name: string; dir: string }

function ledgerPath(localConfig: BranchAwareConfig): string {
  return path.join(localConfig.repo.localPath, '..', 'installed-skills.json');
}

function readLedger(localConfig: BranchAwareConfig): LedgerEntry[] {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(localConfig), 'utf8'));
  } catch {
    return [];
  }
}

function writeLedger(localConfig: BranchAwareConfig, entries: LedgerEntry[]): void {
  fs.writeFileSync(ledgerPath(localConfig), JSON.stringify(entries, null, 2) + '\n');
}

/**
 * Diff-based cleanup of skills teamai installed earlier but that are absent
 * from the current scan (removed from the branch, or present on a previous
 * branch and not on this one). Only ledger-recorded installs are ever
 * removed, so user-created skills in the same directory are never touched.
 */
export function cleanupOrphanSkills(
  localConfig: BranchAwareConfig,
  currentInstalls: Array<{ tool: string; name: string; dir: string }>,
): number {
  const prev = readLedger(localConfig);
  if (prev.length === 0) return 0;
  const currentKeys = new Set(currentInstalls.map(e => `${e.tool}::${e.name}`));
  let removed = 0;
  for (const entry of prev) {
    if (currentKeys.has(`${entry.tool}::${entry.name}`)) continue;
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true });
      log.info(`Removed skill '${entry.name}' (no longer on this branch)`);
      removed += 1;
    } catch (e) {
      log.debug(`Could not remove orphan skill ${entry.name}: ${(e as Error).message}`);
    }
  }
  writeLedger(localConfig, currentInstalls);
  return removed;
}

/** Record the installs of this pull for the next diff. */
export function recordInstalledSkills(
  localConfig: BranchAwareConfig,
  installs: Array<{ tool: string; name: string; dir: string }>,
): void {
  writeLedger(localConfig, installs);
}
