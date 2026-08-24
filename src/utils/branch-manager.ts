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
  await git.fetch(['origin', branch]);
  const localExists = await git.branchLocal().then(bs => bs.all.includes(branch)).catch(() => false);
  if (localExists) {
    await git.checkout(branch);
  } else {
    await git.checkoutLocalBranch(branch);
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
