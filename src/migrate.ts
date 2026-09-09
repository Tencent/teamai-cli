import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';
import { LocalConfigSchema, SYNC_LOCK_FILENAME } from './types.js';
import { resolveAnchors } from './utils/git.js';
import { projectDataHome } from './utils/partition.js';
import { realpath } from 'node:fs/promises';
import { expandHome, pathExists, readFileSafe, remove, writeFile } from './utils/fs.js';
import { acquireLock, releaseLock } from './update.js';
import { log } from './utils/logger.js';

/**
 * P1-3 automatic migration (issue #374).
 *
 * Old installs kept teamai's project-scope machine data (config, state, the
 * team-repo clone, search index, per-worktree managed-mcp + resource cache …)
 * inside the business repo at `<workspaceRoot>/.teamai/`. P1-2 flipped NEW
 * installs to the partition `~/.teamai/projects/<slug>/` and reads old installs
 * via a legacy fallback. This module moves a real legacy `.teamai/` INTO the
 * partition the first time a write command (`init`/`pull`/`push`) runs, so the
 * business workspace ends up with zero teamai residue.
 *
 * Safety model (issue R2): copy → verify → atomic rename, so an interruption
 * never leaves the data half-in-both-places. The source is only renamed to
 * `.teamai.bak/` AFTER the partition is fully in place; we never delete it.
 *
 * Trigger is narrowed by the caller (the global preAction hook): hook-dispatch
 * and read-only commands never reach here. self mode is a hard no-op (its
 * `.teamai/` is team knowledge committed to main, not machine data).
 */

/** Directories/files under a legacy `.teamai/` that must NOT be copied. */
const SKIP_ENTRIES = new Set([
  // Disposable git worktrees: their gitdir records an ABSOLUTE path, so moving
  // them breaks the linkage. They are rebuilt on demand (git.ts calls them
  // "disposable worktrees"). Self-mode only, but skip defensively either way.
  'reports-wt',
  'knowledge-wt',
  // Lock files: transient, and a stale one copied into the partition would be
  // mistaken for a live lock.
  SYNC_LOCK_FILENAME,
  '.update-lock',
]);

export interface MigrationPlan {
  legacyDir: string;
  partitionDir: string;
  anchor: string;
  /**
   * 'full': copy legacy → partition, then retire the source.
   * 'retire-only': the partition is already built (e.g. a prior run crashed
   * between the partition rename and the source retire), so just clean up the
   * leftover legacy dir. Without this, planMigration would return null on the
   * "partition exists" check and the legacy dir — including its plaintext `env`
   * — would linger in the workspace forever, breaking the zero-residue promise.
   */
  mode: 'full' | 'retire-only';
}

/**
 * Decide whether the current working directory is a legacy install that needs
 * migration, WITHOUT going through detectProjectConfig (which short-circuits on
 * an existing partition and runs the self-heal bootstrap as a side effect — both
 * would mask the raw "legacy exists, partition doesn't" state we must observe).
 *
 * Returns the plan when migration should run, or null to skip. Skip when:
 *  - not a git repo (the partition only exists for git repos; a non-git
 *    `.teamai/` is already at its final location),
 *  - no legacy config.yaml (nothing to migrate),
 *  - the legacy config is user scope (user data never lives under `.teamai/`),
 *  - the legacy config is self mode (its `.teamai/` is committed team knowledge).
 *
 * When a partition config already exists AND a legacy dir still lingers, returns
 * a 'retire-only' plan to finish an interrupted migration instead of skipping.
 */
export async function planMigration(cwd?: string): Promise<MigrationPlan | null> {
  const anchors = await resolveAnchors(cwd ?? process.cwd());
  if (!anchors) return null;

  const legacyDir = path.join(anchors.workspaceRoot, '.teamai');
  const legacyConfig = path.join(legacyDir, 'config.yaml');
  if (!(await pathExists(legacyConfig))) return null;

  // Read the legacy config directly to gate on scope/kind. A malformed config is
  // treated as "nothing to migrate" rather than crashing a write command.
  const content = await readFileSafe(legacyConfig);
  if (!content) return null;
  let scope: string | undefined;
  let kind: string | undefined;
  try {
    const parsed = LocalConfigSchema.parse(YAML.parse(content));
    scope = parsed.scope;
    kind = parsed.repo.kind;
  } catch {
    return null;
  }
  if (scope !== 'project') return null;
  if (kind === 'self') return null;

  const partitionDir = projectDataHome(anchors.projectAnchor);
  // If the partition is already built, the copy is done (or was done by a prior
  // run that crashed before retiring the source). Don't re-copy onto the
  // authoritative partition — just finish the job by retiring the leftover
  // legacy dir, so the workspace really does end up residue-free.
  const mode: MigrationPlan['mode'] =
    (await pathExists(path.join(partitionDir, 'config.yaml'))) ? 'retire-only' : 'full';

  return { legacyDir, partitionDir, anchor: anchors.projectAnchor, mode };
}

/**
 * Run migration for a decided plan.
 *
 * Locking (the load-bearing part): a concurrent pull/push from any worktree of
 * the same repo races the shared team-repo clone. Before migration those
 * processes lock `<legacyDir>/.sync-lock` (their `getDataHome` still resolves to
 * the legacy dir until the partition exists); after migration they lock
 * `<partitionDir>/.sync-lock`. To be mutually exclusive with the PRE-migration
 * side — the only side that can run concurrently, since planMigration stands
 * down once the partition exists — migration takes `<legacyDir>/.sync-lock`, the
 * exact path an un-migrated pull/push contends on. The lock lives INSIDE
 * legacyDir, which is renamed to `.bak` at the very end; we release it BEFORE
 * that rename so the lock path stays valid for release and no live lock is
 * carried into the backup.
 *
 * dryRun previews without touching disk.
 */
export async function runMigration(
  plan: MigrationPlan,
  opts: { dryRun?: boolean } = {},
): Promise<'migrated' | 'skipped' | 'dry-run'> {
  const { legacyDir, partitionDir, anchor, mode } = plan;

  if (opts.dryRun) {
    if (mode === 'retire-only') {
      log.info(
        `[dry-run] partition already built at ${partitionDir}; would retire the ` +
          `leftover ${legacyDir} to ${legacyDir}.bak`,
      );
    } else {
      const entries = await listMigratableEntries(legacyDir);
      log.info(
        `[dry-run] would migrate ${entries.length} item(s) from ${legacyDir} ` +
          `to ${partitionDir}, then rename the old directory to ${legacyDir}.bak`,
      );
    }
    return 'dry-run';
  }

  const lockPath = path.join(legacyDir, SYNC_LOCK_FILENAME);
  if (!(await acquireLock(lockPath))) {
    log.debug('migration skipped: a concurrent pull/push holds the sync lock');
    return 'skipped';
  }

  const staging = `${partitionDir}.staging`;
  let lockReleased = false;
  try {
    // 'retire-only': a prior run already built the partition but crashed before
    // retiring the source. The partition is authoritative — do NOT re-copy onto
    // it — just finish by retiring the leftover legacy dir.
    if (mode === 'retire-only') {
      await releaseLock(lockPath);
      lockReleased = true;
      const backup = await retireLegacy(legacyDir);
      log.success(`Finished an interrupted migration: retired ${legacyDir} to ${backup}`);
      return 'migrated';
    }

    // Re-check under the lock: a sibling worktree may have migrated while we
    // waited (TOCTOU). If the partition config now exists, retire our leftover
    // legacy dir rather than copying onto the authoritative partition.
    if (await pathExists(path.join(partitionDir, 'config.yaml'))) {
      await releaseLock(lockPath);
      lockReleased = true;
      const backup = await retireLegacy(legacyDir);
      log.debug(`partition built by a concurrent process; retired ${legacyDir} to ${backup}`);
      return 'migrated';
    }

    // 1. Copy into a sibling staging dir (NOT the partition itself) so an
    //    interrupted copy never looks like a built partition. Use raw fse.copy
    //    (NOT copyDir): copyDir filters out `.git`, which would corrupt the
    //    team-repo clone. Skip disposable worktrees and lock files.
    await remove(staging);
    await fse.ensureDir(path.dirname(partitionDir));
    await fse.copy(legacyDir, staging, {
      overwrite: true,
      filter: (src) => {
        const rel = path.relative(legacyDir, src);
        if (!rel) return true; // the root itself
        const top = rel.split(path.sep)[0];
        return !SKIP_ENTRIES.has(top);
      },
    });

    // 2. Verify the staged copy before making it authoritative.
    await verifyStaging(legacyDir, staging);

    // 2b. Rebase absolute paths persisted in config.yaml that pointed INTO the
    //     legacy dir (chiefly repo.localPath → <legacyDir>/team-repo) onto the
    //     partition. Without this, the migrated config would still name the old
    //     team-repo location, so the next pull would read/clone the wrong path.
    //     Done in staging (pre-rename) so it stays inside the atomic window.
    await rebaseConfigPaths(path.join(staging, 'config.yaml'), legacyDir, partitionDir);

    // 3. Atomic switch: same-filesystem rename of the staged dir onto the final
    //    partition path. partitionDir does not exist yet (planMigration + the
    //    under-lock re-check both gate on its config.yaml, and nothing else
    //    creates it), so the rename lands on a clean name.
    await remove(partitionDir);
    await fse.rename(staging, partitionDir);

    // 4. Write the anchor reverse-lookup file. The slug is a one-way sha256, so
    //    the original projectAnchor is only recoverable from this file — which
    //    lives inside the partition, off the workspace, preserving zero-residue.
    await writeFile(path.join(partitionDir, 'anchor'), `${anchor}\n`);

    // 5. Release the lock BEFORE renaming legacyDir away, so releaseLock finds
    //    the lock at its original path and no live lock is buried in the backup.
    await releaseLock(lockPath);
    lockReleased = true;

    const backup = await retireLegacy(legacyDir);
    log.success(`Migrated teamai data to ${partitionDir}`);
    log.info(
      `Old data preserved at ${backup} — remove it once you've confirmed ` +
        `everything works (downgrading to an older teamai is not supported).`,
    );
    return 'migrated';
  } catch (e) {
    // Any failure before the rename leaves the source untouched; discard the
    // partial staging dir so a rerun starts clean.
    await remove(staging).catch(() => {});
    throw e;
  } finally {
    if (!lockReleased) await releaseLock(lockPath);
  }
}

/**
 * Convenience entry point for the preAction hook: plan + run, swallowing the
 * "nothing to do" case. Migration failures are surfaced (a write command should
 * not silently proceed on stale legacy data), but never crash a dry-run preview.
 */
export async function maybeMigrate(opts: { dryRun?: boolean } = {}): Promise<void> {
  const plan = await planMigration();
  if (!plan) return;
  await runMigration(plan, opts);
}

/**
 * Rewrite absolute paths in the staged config.yaml that pointed into the legacy
 * dir so they name the partition instead. Only `repo.localPath` is persisted as
 * an absolute path today (the team-repo clone at `<legacyDir>/team-repo`); a path
 * NOT inside legacyDir (e.g. an http install whose localPath sits elsewhere) is
 * left untouched. Preserves every other field verbatim via YAML round-trip.
 */
async function rebaseConfigPaths(
  stagedConfig: string,
  legacyDir: string,
  partitionDir: string,
): Promise<void> {
  const content = await readFileSafe(stagedConfig);
  if (!content) return;
  let doc: Record<string, unknown>;
  try {
    doc = YAML.parse(content);
  } catch {
    return; // verifyStaging already validated parseability; be defensive anyway
  }
  const repo = doc?.repo as { localPath?: string } | undefined;
  const rebased = await rebasePath(repo?.localPath, legacyDir, partitionDir);
  if (repo && rebased !== undefined && rebased !== repo.localPath) {
    repo.localPath = rebased;
    await writeFile(stagedConfig, YAML.stringify(doc));
  }
}

/**
 * If `p` is inside `fromDir`, return the equivalent path inside `toDir`;
 * otherwise return `p` unchanged (undefined stays undefined).
 *
 * `fromDir` is realpath-normalized (it comes from resolveAnchors), but the
 * persisted `p` may use a symlinked spelling (e.g. macOS `/tmp` → `/private/tmp`)
 * or a `~` prefix, so a raw string compare would miss the match. We expand `~`
 * and realpath `p` first — the old location still exists at this point in the
 * migration (the source is renamed to `.bak` only afterwards) — so both sides are
 * canonical before path.relative decides containment. A `..` result means `p`
 * escapes fromDir and is left alone (e.g. an external clone).
 */
async function rebasePath(
  p: string | undefined,
  fromDir: string,
  toDir: string,
): Promise<string | undefined> {
  if (!p) return p;
  const expanded = expandHome(p);
  const canonical = await realpath(expanded).catch(() => expanded);
  const rel = path.relative(fromDir, canonical);
  if (rel === '') return toDir;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return path.join(toDir, rel);
}

/**
 * Retire the source dir to a `.bak` sibling (same-fs → atomic rename). Never
 * auto-deleted: it is the manual rollback path (downgrading to an older teamai
 * is not supported — see release notes / design doc R6). Returns the backup path.
 *
 * Two safety measures beyond a plain rename:
 *  - **Never overwrite an existing backup.** A pre-existing `.teamai.bak/` (from a
 *    prior migration, or the user's own) may hold irreplaceable data, so we pick
 *    the first FREE name (`.teamai.bak`, `.teamai.bak.1`, …) instead of removing
 *    whatever is there.
 *  - **Keep the backup git-ignored.** An old install's `.teamai/` was often
 *    protected only by a repo-root `.gitignore` rule matching `.teamai/`, which
 *    does NOT match `.teamai.bak/` — so after the rename a `git add -A` would
 *    stage the plaintext `env`/`token` in the backup. We drop a self-contained
 *    `.gitignore` (`*`) INTO the dir BEFORE renaming, so the backup ignores its
 *    own contents regardless of its final name or the repo's ignore rules.
 */
async function retireLegacy(legacyDir: string): Promise<string> {
  // Make the backup ignore everything it contains, independent of repo rules and
  // the backup's eventual name. Written before the rename so there is never a
  // window in which the credentials sit in a non-ignored directory.
  await writeFile(path.join(legacyDir, '.gitignore'), '# teamai migration backup — ignore everything\n*\n');

  let backup = `${legacyDir}.bak`;
  for (let n = 1; await pathExists(backup); n++) {
    backup = `${legacyDir}.bak.${n}`;
  }
  await fse.rename(legacyDir, backup);
  return backup;
}

/** Top-level entries under a legacy `.teamai/` that migration will copy. */
async function listMigratableEntries(legacyDir: string): Promise<string[]> {
  const names = await fse.readdir(legacyDir);
  return names.filter((n) => !SKIP_ENTRIES.has(n));
}

/**
 * Verify a staged copy is complete enough to become authoritative:
 *  - config.yaml parses as a LocalConfig,
 *  - if the source has a team-repo git clone, the staged copy has its `.git`
 *    AND `git rev-parse HEAD` works on it (proves the copy did NOT drop `.git`
 *    — the copyDir-vs-fse.copy trap — and the clone is actually usable, not just
 *    present-but-corrupt),
 *  - every migratable top-level entry made it across.
 * Runs on the STAGING copy, before the atomic rename, so any shortfall aborts
 * with the source untouched and the partial staging discarded.
 */
async function verifyStaging(legacyDir: string, staging: string): Promise<void> {
  const stagedConfig = path.join(staging, 'config.yaml');
  const content = await readFileSafe(stagedConfig);
  if (!content) throw new Error(`migration verify: ${stagedConfig} missing after copy`);
  try {
    LocalConfigSchema.parse(YAML.parse(content));
  } catch (e) {
    throw new Error(`migration verify: staged config.yaml is invalid (${(e as Error).message})`);
  }

  const legacyGit = path.join(legacyDir, 'team-repo', '.git');
  if (await pathExists(legacyGit)) {
    const stagedRepo = path.join(staging, 'team-repo');
    if (!(await pathExists(path.join(stagedRepo, '.git')))) {
      throw new Error('migration verify: team-repo/.git missing after copy (clone would be broken)');
    }
    // Smoke-check the clone: a working rev-parse proves the .git is intact, not
    // just present. Catches a partial/corrupt copy that a mere existence check
    // would wave through.
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: stagedRepo });
    } catch (e) {
      throw new Error(
        `migration verify: the staged team-repo clone is not a usable git ` +
          `repository (${(e as Error).message})`,
      );
    }
  }

  const expected = await listMigratableEntries(legacyDir);
  for (const name of expected) {
    if (!(await pathExists(path.join(staging, name)))) {
      throw new Error(`migration verify: ${name} missing after copy`);
    }
  }
}
