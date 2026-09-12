import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fse from 'fs-extra';
import { loadState, saveState, loadLocalConfig, loadTeamConfig } from './config.js';
import { resolveEffectiveUpdatePolicy } from './update-policy.js';
import { resolveTeamaiEntryScript } from './builtin-hooks.js';
import { log } from './utils/logger.js';
import { expandHome, ensureDir } from './utils/fs.js';
import { getUpdateLockPath } from './types.js';
import { askConfirmation } from './utils/prompt.js';

// `getCurrentVersion` and `getCurrentPackageName` live in `./package-info.ts`
// so both this module and the provider registry can read package metadata
// without pulling in update.ts' dependency graph. They are re-exported here
// for backwards compatibility with existing callers of `./update.js`.
import { getCurrentVersion, getCurrentPackageName } from './package-info.js';
export { getCurrentVersion, getCurrentPackageName };

const execFileAsync = promisify(execFile);

// ─── Constants ──────────────────────────────────────────

/** Public npm registry (open-source users). */
const PUBLIC_REGISTRY = 'https://registry.npmjs.org';
/** Tencent internal tnpm registry (for @tencent/ scoped package). */
const TNPM_REGISTRY = 'http://r.tnpm.oa.com';

const VERSION_CHECK_TIMEOUT = 5000;
const INSTALL_TIMEOUT = 60000;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ─── Helpers ────────────────────────────────────────────

/**
 * Resolve the npm registry to use for the given package name.
 * Scoped packages under `@tencent/` go to tnpm; everything else to public npm.
 * Honor `TEAMAI_NPM_REGISTRY` env var for manual override (useful for testing
 * or private mirrors).
 */
export function resolveRegistryForPackage(pkgName: string): string {
  const override = process.env.TEAMAI_NPM_REGISTRY?.trim();
  if (override) return override;
  if (pkgName.startsWith('@tencent/')) return TNPM_REGISTRY;
  return PUBLIC_REGISTRY;
}

/**
 * Resolve the npm CLI belonging to the running Node. Bundled runtimes
 * (WorkBuddy/CodeBuddy) ship npm inside their install dir, and their hook
 * subprocesses have no npm on PATH, so prefer the co-located npm-cli.js and
 * fall back to `npm` from PATH. All standard layouts are probed regardless
 * of platform — a layout mismatch must not silently disable self-update in
 * exactly the PATH-less contexts this resolver exists for.
 */
export function resolveNpmCommand(): { cmd: string; args: string[] } {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    // Bundled runtimes: npm installed flat next to node.exe.
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // POSIX layout rooted at the node dir itself.
    path.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Canonical POSIX install (official tarball, Homebrew, nvm): node lives in
    // <prefix>/bin with npm at <prefix>/lib/node_modules — one level up.
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { cmd: process.execPath, args: [c] };
  }
  log.debug('No npm-cli.js found next to the running Node; falling back to npm from PATH');
  return { cmd: 'npm', args: [] };
}

/**
 * Derive the npm install prefix from an entry-script path: the slice before
 * `<prefix>/[lib/]node_modules/<pkg>`, sanity-checked so only genuine
 * npm-managed layouts yield a prefix. `posix` selects the layout — POSIX npm
 * global installs nest one level deeper (<prefix>/lib/node_modules) and npm
 * re-adds the lib/ component itself, so the prefix it expects is the slice
 * above it. Exported for testing — split out from resolveInstallPrefix.
 */
export function prefixFromEntryPath(entry: string, posix: boolean): string | null {
  const marker = `${path.sep}node_modules${path.sep}`;
  const idx = entry.lastIndexOf(marker);
  if (idx <= 0) return null;
  const root = entry.slice(0, idx);
  const prefix = posix && path.basename(root) === 'lib' ? path.dirname(root) : root;
  // Sanity-check the slice: only trust it when the running package actually
  // sits in the npm-managed layout under the prefix we would hand back.
  const nmDir = posix ? path.join('lib', 'node_modules') : 'node_modules';
  return fs.existsSync(path.join(prefix, nmDir, getCurrentPackageName()))
    ? prefix
    : null;
}

/**
 * Resolve the install prefix the running CLI lives in
 * (<prefix>/node_modules/<pkg>/...) so a self-update reinstalls into the
 * same location. Returns null when the entry cannot be attributed to an
 * npm-managed install (e.g. a linked checkout) — callers then keep the
 * default global install behavior.
 */
function resolveInstallPrefix(): string | null {
  return prefixFromEntryPath(fileURLToPath(import.meta.url), process.platform !== 'win32');
}

/**
 * Fetch the latest version from the npm registry
 * Returns null on any error (timeout, network, etc.)
 *
 * Defaults to the registry resolved from the currently installed package name.
 */
export async function fetchLatestVersion(
  registry?: string,
  timeout: number = VERSION_CHECK_TIMEOUT,
): Promise<string | null> {
  const pkgName = getCurrentPackageName();
  const resolvedRegistry = registry ?? resolveRegistryForPackage(pkgName);
  try {
    // Async execFile so the hook dispatcher's event loop is not blocked while
    // the registry is queried — a synchronous execSync here would freeze all
    // sibling Stop handlers for up to `timeout` ms.
    const npm = resolveNpmCommand();
    const { stdout } = await execFileAsync(
      npm.cmd,
      [...npm.args, 'view', pkgName, 'version', `--registry=${resolvedRegistry}`],
      { timeout, encoding: 'utf-8' },
    );
    const version = stdout.trim();
    if (!version) return null;
    return version;
  } catch (e) {
    log.error(`Version check failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Compare two semver version strings.
 * Handles prerelease suffixes: a version with prerelease (e.g. 1.2.3-beta.1)
 * is always older than the same numeric version without one (semver §11).
 * Returns: -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = a.split('-', 2);
  const [coreB, preB] = b.split('-', 2);

  const partsA = coreA.split('.').map(Number);
  const partsB = coreB.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const pa = partsA[i] ?? 0;
    const pb = partsB[i] ?? 0;
    if (pa > pb) return 1;
    if (pa < pb) return -1;
  }

  // Numeric cores are equal — prerelease is lower than release (semver §11)
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  return 0;
}

/**
 * Check if the cached version check is still valid
 */
export function isCacheValid(lastCheck: string | null, ttlMs: number = CACHE_TTL_MS): boolean {
  if (!lastCheck) return false;
  try {
    const checkTime = new Date(lastCheck).getTime();
    if (isNaN(checkTime)) return false;
    return Date.now() - checkTime < ttlMs;
  } catch {
    return false;
  }
}

// ─── Lock file management ───────────────────────────────

/**
 * Owner tokens for locks this process currently holds, keyed by resolved lock
 * path. `releaseLock` consults this map + the on-disk owner so it only ever
 * deletes a lock this process actually acquired — never one another process
 * later took over after ours went stale.
 */
const heldLockOwners = new Map<string, string>();

interface LockPayload {
  pid: number;
  startedAt: string;
  owner: string;
}

/**
 * Parse a lock file's contents. Understands both the current JSON payload and
 * the legacy plain-integer PID format written by older teamai versions, so an
 * on-disk lock from a previous install is still evaluated for staleness rather
 * than treated as un-owned garbage.
 */
function parseLockContent(content: string): { pid: number; owner?: string } | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<LockPayload>;
    if (typeof parsed.pid === 'number' && !isNaN(parsed.pid)) {
      return { pid: parsed.pid, owner: typeof parsed.owner === 'string' ? parsed.owner : undefined };
    }
    return null;
  } catch {
    // Legacy format: the file held only the bare PID as a string.
    const pid = parseInt(trimmed, 10);
    return isNaN(pid) ? null : { pid };
  }
}

/**
 * Inspect the lock at `resolved` and report whether it is stale — its owning
 * process is gone, or its contents are unparseable (so no live owner can be
 * confirmed). A missing file is also "stale" (nothing holds it). This is a pure
 * read; it never mutates the lock.
 */
async function isLockStale(resolved: string): Promise<boolean> {
  let content: string;
  try {
    content = await fse.readFile(resolved, 'utf-8');
  } catch {
    // File vanished between EEXIST and read — treat as reclaimable.
    return true;
  }
  const parsed = parseLockContent(content);
  if (!parsed) return true; // unparseable → no confirmable live owner
  try {
    process.kill(parsed.pid, 0);
    return false; // process alive → lock genuinely held
  } catch {
    return true; // ESRCH → owning process is gone
  }
}

/**
 * Atomic exclusive create. Returns true when this call created the file, false
 * when it already existed (EEXIST). Any other error propagates.
 */
async function exclusiveCreate(target: string, payload: string): Promise<boolean> {
  try {
    await fse.writeFile(target, payload, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Remove `target` only if its on-disk owner is still `owner` (or it carries no
 * owner / is already gone). Prevents deleting a file another process legitimately
 * created after ours was reclaimed.
 */
async function removeIfOwner(target: string, owner: string): Promise<void> {
  try {
    const content = await fse.readFile(target, 'utf-8').catch(() => null);
    if (content !== null) {
      const parsed = parseLockContent(content);
      if (parsed?.owner && parsed.owner !== owner) return;
    }
    await fse.remove(target);
  } catch {
    // best effort
  }
}

/**
 * Acquire the reclaim sentinel that serializes stale-lock takeover.
 *
 * Serialization is what makes reclaim safe: without it, several processes can all
 * observe the same stale lock, all delete it, and all recreate it — ending with
 * more than one "winner". The sentinel is created with the same atomic exclusive
 * create as the lock itself, so exactly ONE process becomes the reclaimer; the
 * rest back off. A sentinel whose own holder died (dead pid) is stolen via an
 * atomic rename (only one process can rename a given file away) so a crashed
 * reclaimer cannot wedge stale-lock recovery forever.
 */
async function acquireReclaimSentinel(sentinel: string, owner: string): Promise<boolean> {
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    owner,
  } satisfies LockPayload);
  if (await exclusiveCreate(sentinel, payload)) return true;
  // Sentinel is held. Only reclaim it if its holder is gone.
  if (!(await isLockStale(sentinel))) return false;
  try {
    await fse.rename(sentinel, `${sentinel}.reclaim-${owner}`);
  } catch {
    return false; // another process stole it first
  }
  await fse.remove(`${sentinel}.reclaim-${owner}`).catch(() => {});
  return exclusiveCreate(sentinel, payload);
}

/**
 * Try to acquire a lock. Returns false if another live process holds it.
 *
 * The happy path is a single atomic exclusive create (`writeFile(..., { flag: 'wx' })`
 * = O_CREAT|O_EXCL), so exactly one racing process wins an uncontended lock — this
 * replaces the previous check-then-write, where two processes could both observe
 * "no lock" and both succeed.
 *
 * Reclaiming a STALE lock (dead owner / unparseable content) is serialized behind
 * a reclaim sentinel and completed with an atomic rename-into-place, so concurrent
 * reclaimers cannot each end up believing they hold the lock. (A residual, benign
 * window exists only if the reclaiming process itself crashes mid-reclaim; the
 * sentinel's dead-pid recovery bounds that.)
 */
export async function acquireLock(lockPath?: string): Promise<boolean> {
  const resolved = lockPath ?? expandHome(getUpdateLockPath());
  const owner = randomUUID();
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    owner,
  } satisfies LockPayload);

  try {
    await ensureDir(path.dirname(resolved));
  } catch {
    return false;
  }

  try {
    // Fast path: no lock present.
    if (await exclusiveCreate(resolved, payload)) {
      heldLockOwners.set(resolved, owner);
      return true;
    }
    // A lock exists. A live holder means busy; only a stale one may be reclaimed.
    if (!(await isLockStale(resolved))) return false;

    // Serialize the reclaim so only one process takes over the stale lock.
    const sentinel = `${resolved}.sentinel`;
    if (!(await acquireReclaimSentinel(sentinel, owner))) return false;
    try {
      // Re-evaluate now that we are the sole reclaimer.
      if (await exclusiveCreate(resolved, payload)) {
        heldLockOwners.set(resolved, owner);
        return true; // stale lock had vanished
      }
      if (!(await isLockStale(resolved))) return false; // became live under us
      // Still stale and present, and no other reclaimer can race us: replace it
      // atomically (write to a temp sibling, then rename over the stale file, so
      // the lock is never momentarily absent for a fresh acquirer to slip into).
      const tmp = `${resolved}.new-${owner}`;
      await fse.writeFile(tmp, payload);
      await fse.rename(tmp, resolved);
      heldLockOwners.set(resolved, owner);
      return true;
    } finally {
      await removeIfOwner(sentinel, owner);
    }
  } catch {
    return false;
  }
}

/**
 * Release a lock — but only one this process actually acquired. If we hold no
 * owner token for this path we return without touching the file (owner-verified
 * release: never delete a lock we did not take). If we do, we delete only when the
 * on-disk owner still matches ours; a mismatch means another process reclaimed it
 * after ours went stale, so we leave the new holder's lock alone.
 */
export async function releaseLock(lockPath?: string): Promise<void> {
  const resolved = lockPath ?? expandHome(getUpdateLockPath());
  const ourOwner = heldLockOwners.get(resolved);
  if (!ourOwner) return;
  try {
    const content = await fse.readFile(resolved, 'utf-8').catch(() => null);
    if (content !== null) {
      const parsed = parseLockContent(content);
      // A recorded owner mismatch means someone else now holds this lock.
      if (parsed?.owner && parsed.owner !== ourOwner) return;
    }
    await fse.remove(resolved);
  } catch {
    // Ignore errors on cleanup
  } finally {
    heldLockOwners.delete(resolved);
  }
}

// ─── Core logic ─────────────────────────────────────────

export interface CheckResult {
  available: boolean;
  current: string;
  latest: string;
}

/**
 * Check if a newer version is available.
 * Uses cached result if within TTL unless force is true.
 */
export async function checkForUpdate(options?: { force?: boolean }): Promise<CheckResult> {
  const state = await loadState();
  const current = getCurrentVersion();

  // Use cached result if valid
  if (!options?.force && isCacheValid(state.lastUpdateCheck) && state.availableUpdate) {
    const cmp = compareVersions(current, state.availableUpdate);
    return {
      available: cmp < 0,
      current,
      latest: state.availableUpdate,
    };
  }

  // Fetch latest version from registry
  const latest = await fetchLatestVersion();
  if (!latest) {
    return { available: false, current, latest: current };
  }

  // Compare and save state
  const available = compareVersions(current, latest) < 0;
  await saveState({
    ...state,
    lastUpdateCheck: new Date().toISOString(),
    availableUpdate: available ? latest : null,
  });

  return { available, current, latest };
}

/**
 * Perform the actual update (check + install based on policy)
 */
export async function doUpdate(): Promise<void> {
  const result = await checkForUpdate();
  if (!result.available) {
    log.info(`Already up to date (v${result.current})`);
    return;
  }

  // Load configs for update policy. Team config is the default; local
  // config overrides (user always wins).
  const localConfig = await loadLocalConfig();
  const teamConfig = localConfig
    ? await loadTeamConfig(localConfig.repo.localPath)
    : null;
  const policy = resolveEffectiveUpdatePolicy(localConfig, teamConfig);

  if (policy === 'skip') {
    const reason = teamConfig?.autoUpdate === false && localConfig?.updatePolicy === undefined
      ? 'team policy (autoUpdate: false)'
      : 'local updatePolicy: skip';
    log.debug(`Auto-update skipped: ${reason}`);
    return;
  }

  if (policy === 'prompt') {
    if (!process.stdin.isTTY) {
      log.info(`Update available: v${result.current} → v${result.latest}. Run "teamai update" to upgrade.`);
      return;
    }
    const confirmed = await askConfirmation(
      `Update available: v${result.current} → v${result.latest}. Update now? (y/N) `,
    );
    if (!confirmed) {
      log.info('Update skipped');
      return;
    }
  }

  // auto policy or user confirmed — proceed with install
  const locked = await acquireLock();
  if (!locked) {
    log.warn('Another update is in progress, skipping');
    return;
  }

  try {
    const pkgName = getCurrentPackageName();
    const registry = resolveRegistryForPackage(pkgName);
    const npm = resolveNpmCommand();
    const prefix = resolveInstallPrefix();
    await execFileAsync(
      npm.cmd,
      [
        ...npm.args,
        'install', '-g', pkgName,
        ...(prefix ? [`--prefix=${prefix}`] : []),
        `--registry=${registry}`,
      ],
      { timeout: INSTALL_TIMEOUT },
    );
    log.success(`Updated teamai to v${result.latest}`);

    // Refresh hooks using new version's code (spawn new process so updated code is loaded).
    // PATH-less subprocesses (bundled runtimes) may not have `teamai` on PATH:
    // resolve the running CLI's entry and run it with the current Node binary —
    // spawning the .js directly only works behind a shebang + PATH on POSIX.
    try {
      const entry = resolveTeamaiEntryScript();
      const refresh = entry
        ? { cmd: process.execPath, args: [entry, 'hooks', 'inject', '--silent'] }
        : { cmd: 'teamai', args: ['hooks', 'inject', '--silent'] };
      await execFileAsync(refresh.cmd, refresh.args, {
        timeout: 15_000,
      });
      log.success('Refreshed hooks with new version');
    } catch (e) {
      log.error(`Hook refresh after update skipped: ${(e as Error).message}`);
    }
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    const msg = error.message ?? '';
    if (msg.includes('EACCES') || error.code === 'EACCES') {
      log.warn(`Permission denied. Run "teamai update" manually with appropriate permissions.`);
    } else if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
      log.warn('Update timed out. Try again later.');
    } else {
      log.warn(`Update failed: ${msg}. Run "teamai update" manually.`);
    }
  } finally {
    await releaseLock();
  }
}

// ─── Public API ─────────────────────────────────────────

export interface UpdateOptions {
  check?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  silent?: boolean;
}

/**
 * Main entry point for `teamai update` command.
 * --check: only check and print whether an update is available
 * default: full update flow (check + install)
 */
export async function update(options: UpdateOptions): Promise<void> {
  if (options.check) {
    const result = await checkForUpdate();
    if (result.available) {
      log.info(`Update available: v${result.current} → v${result.latest}. Run "teamai update" to upgrade.`);
    } else {
      log.info(`Already up to date (v${result.current})`);
    }
    return;
  }

  await doUpdate();
}
