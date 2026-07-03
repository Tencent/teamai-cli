import { execSync } from 'node:child_process';
import fse from 'fs-extra';
import { loadState, saveState, loadLocalConfig, loadTeamConfig } from './config.js';
import { resolveEffectiveUpdatePolicy } from './update-policy.js';
import { log } from './utils/logger.js';
import { expandHome } from './utils/fs.js';
import { TEAMAI_UPDATE_LOCK_PATH } from './types.js';
import { askConfirmation } from './utils/prompt.js';

// `getCurrentVersion` and `getCurrentPackageName` live in `./package-info.ts`
// so both this module and the provider registry can read package metadata
// without pulling in update.ts' dependency graph. They are re-exported here
// for backwards compatibility with existing callers of `./update.js`.
import { getCurrentVersion, getCurrentPackageName } from './package-info.js';
export { getCurrentVersion, getCurrentPackageName };

// ─── Constants ──────────────────────────────────────────

/** Public npm registry (open-source users). */
const PUBLIC_REGISTRY = 'https://registry.npmjs.org';
/** Tencent internal tnpm registry (for @tencent/ scoped package). */
const TNPM_REGISTRY = 'http://r.tnpm.oa.com';

const VERSION_CHECK_TIMEOUT = 5000;
const INSTALL_TIMEOUT = 60000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    const output = execSync(
      `npm view ${pkgName} version --registry=${resolvedRegistry}`,
      { timeout, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const version = output.trim();
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
 * Try to acquire update lock. Returns false if another update is in progress.
 */
export async function acquireLock(lockPath?: string): Promise<boolean> {
  const resolved = lockPath ?? expandHome(TEAMAI_UPDATE_LOCK_PATH);
  try {
    if (await fse.pathExists(resolved)) {
      const content = await fse.readFile(resolved, 'utf-8');
      const pid = parseInt(content.trim(), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          // Process is alive — lock is held
          return false;
        } catch {
          // Process is dead — stale lock, remove it
          await fse.remove(resolved);
        }
      } else {
        // Invalid PID content — remove stale lock
        await fse.remove(resolved);
      }
    }
    await fse.writeFile(resolved, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the update lock
 */
export async function releaseLock(lockPath?: string): Promise<void> {
  const resolved = lockPath ?? expandHome(TEAMAI_UPDATE_LOCK_PATH);
  try {
    await fse.remove(resolved);
  } catch {
    // Ignore errors on cleanup
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
    execSync(
      `npm install -g ${pkgName} --registry=${registry}`,
      { timeout: INSTALL_TIMEOUT, stdio: 'pipe' },
    );
    log.success(`Updated teamai to v${result.latest}`);

    // Refresh hooks using new version's code (spawn new process so updated code is loaded)
    try {
      execSync('teamai hooks inject --silent', {
        timeout: 15_000,
        stdio: 'pipe',
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
