import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import fse from 'fs-extra';
import { loadState, saveState, loadLocalConfig } from './config.js';
import { log } from './utils/logger.js';
import { expandHome } from './utils/fs.js';
import { TEAMAI_UPDATE_LOCK_PATH } from './types.js';

// ─── Constants ──────────────────────────────────────────

const REGISTRY = 'http://r.tnpm.oa.com';
const PACKAGE_NAME = '@tencent/teamai-cli';
const VERSION_CHECK_TIMEOUT = 5000;
const INSTALL_TIMEOUT = 60000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Helpers ────────────────────────────────────────────

/**
 * Get the currently installed version from package.json
 */
export function getCurrentVersion(): string {
  const require = createRequire(import.meta.url);
  const { version } = require('../package.json');
  return version as string;
}

/**
 * Fetch the latest version from the npm registry
 * Returns null on any error (timeout, network, etc.)
 */
export async function fetchLatestVersion(
  registry: string = REGISTRY,
  timeout: number = VERSION_CHECK_TIMEOUT,
): Promise<string | null> {
  try {
    const output = execSync(
      `npm view ${PACKAGE_NAME} version --registry=${registry}`,
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
 * Compare two semver version strings (x.y.z format)
 * Returns: -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const pa = partsA[i] ?? 0;
    const pb = partsB[i] ?? 0;
    if (pa > pb) return 1;
    if (pa < pb) return -1;
  }
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
 * Ask user for confirmation via readline (for manual prompt mode)
 */
function askConfirmation(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
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

  // Load config for update policy
  const localConfig = await loadLocalConfig();
  const policy = localConfig?.updatePolicy ?? 'auto';

  if (policy === 'skip') {
    log.debug('Update policy is skip, skipping update');
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
    execSync(
      `npm install -g ${PACKAGE_NAME} --registry=${REGISTRY}`,
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
