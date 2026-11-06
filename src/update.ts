import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fse from 'fs-extra';
import { z } from 'zod';
import { loadState, saveState, loadLocalConfig, loadTeamConfig, resolveConfigForDir } from './config.js';
import { resolveEffectiveUpdatePolicy, VERSION_CHECK_TIMEOUT, INSTALL_TIMEOUT, HOOK_REFRESH_TIMEOUT } from './update-policy.js';
import { resolveTeamaiEntryScript } from './builtin-hooks.js';
import { log } from './utils/logger.js';
import { errnoCode, expandHome, ensureDir } from './utils/fs.js';
import { getTeamaiHomeDir, getUpdateLockPath, JsonValueSchema, type LocalConfig } from './types.js';
import { askConfirmation, isInteractive } from './utils/prompt.js';

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

const KilledErrorSchema = z.object({ killed: z.literal(true) });

/**
 * Whether an `execFile` rejection is the install being cut off rather than
 * npm reporting a problem of its own. Three shapes reach here:
 *
 * - the `timeout` firing: Node kills the child with a signal, leaves `code`
 *   null and puts the bare command line in the message;
 * - the output cap: an install that writes more than `maxBuffer` fails with
 *   `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, which on a verbose npm install is
 *   a long build, not a broken one;
 * - npm giving up on the registry itself: it exits 1 and prints
 *   `npm error code ETIMEDOUT`, which Node appends to the message while the
 *   error code stays 1.
 *
 * Only the third names the timeout, so the message still has to be read for it
 * — npm's own registry timeout has no other tell (#1685).
 */
function isInterruptedInstall(cause: unknown, message: string): boolean {
  const code = errnoCode(cause);

  if (code === 'ETIMEDOUT' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return true;

  if (message.includes('ETIMEDOUT')) return true;

  return KilledErrorSchema.safeParse(cause).success;
}

/**
 * Resolve the npm CLI belonging to the running Node. Bundled runtimes
 * (WorkBuddy/CodeBuddy) ship npm inside their install dir, and their hook
 * subprocesses have no npm on PATH, so prefer the co-located npm-cli.js and
 * fall back to `npm` from PATH. All standard layouts are probed regardless
 * of platform — a layout mismatch must not silently disable self-update in
 * exactly the PATH-less contexts this resolver exists for.
 */
/** How to run npm: the program and the arguments that come before npm's own. */
export interface NpmCommand {
  cmd: string;
  args: string[];
}

export function resolveNpmCommand(): NpmCommand {
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
 * Derive the npm install target from an entry-script path. Two npm-managed
 * layouts are recognized:
 * - POSIX global: `<prefix>/lib/node_modules/<pkg>` — npm -g re-adds the lib/
 *   component itself, so the prefix it expects is the slice above it.
 * - Flat/vendored: `<prefix>/node_modules/<pkg>` (bundled runtimes). POSIX npm
 *   -g CANNOT reinstall into this layout (it always nests under lib/), so the
 *   caller must install non-globally with --prefix — hence the `global` flag.
 * Returns null when the entry cannot be attributed to an npm-managed install
 * (e.g. a linked checkout). Exported for testing — split out from
 * resolveInstallPrefix.
 */
export function prefixFromEntryPath(entry: string, posix: boolean): { prefix: string; global: boolean } | null {
  const marker = `${path.sep}node_modules${path.sep}`;
  const idx = entry.lastIndexOf(marker);

  if (idx <= 0) return null;
  const root = entry.slice(0, idx);
  const pkgDir = getCurrentPackageName();

  // POSIX global layout: npm re-adds the lib/ component, so hand it the slice
  // above and let it nest back down to where the running package sits.
  if (posix && path.basename(root) === 'lib') {
    const prefix = path.dirname(root);

    return fs.existsSync(path.join(prefix, 'lib', 'node_modules', pkgDir))
      ? { prefix, global: true }
      : null;
  }

  // Flat layout (<root>/node_modules/<pkg>): the sanity check verifies the
  // layout that was actually matched, not the one npm would have created.
  return fs.existsSync(path.join(root, 'node_modules', pkgDir))
    ? { prefix: root, global: !posix }
    : null;
}

/**
 * Resolve the install target the running CLI lives in
 * (<prefix>/[lib/]node_modules/<pkg>/...) so a self-update reinstalls into
 * the same location. Returns null when the entry cannot be attributed to an
 * npm-managed install (e.g. a linked checkout) — callers must not install
 * then, since npm's default global prefix is where `npm link` put its symlink.
 */
function resolveInstallPrefix(): { prefix: string; global: boolean } | null {
  return prefixFromEntryPath(fileURLToPath(import.meta.url), process.platform !== 'win32');
}

/** The one file the package cannot work without. */
const CLI_ENTRY = path.join('dist', 'index.js');

/**
 * npm moves the installed package aside to `.<name>-<hash>` inside
 * node_modules before it unpacks the new copy, and renames it back only once
 * that copy is written. An install that dies in between — the 60 s timeout, or
 * a running `teamai` holding the files on Windows — leaves the moved copy
 * behind and nothing where the CLI was, which is how the `teamai` command
 * disappears. The moved directory still holds the last version that worked, so
 * put it back.
 *
 * Never deletes anything: a leftover from an even older npm stays where it is,
 * and the most recent one is the one restored.
 *
 * npm creates the new `teamai-cli/` before it fetches the tarball, so a hard
 * kill (TerminateProcess on Windows) leaves an *empty* directory where the
 * package was — and nothing in it. That counts as missing here: it is moved
 * aside, never deleted, and the previous copy comes back over it.
 *
 * Returns the directory that was moved back, or null when there was nothing to
 * do.
 */
export function restoreInterruptedInstall(pkgDir: string): string | null {
  // npm writes the tarball file by file and package.json tends to land first,
  // so a manifest proves nothing: a kill after it leaves a "complete" package
  // with no CLI in it. Only the entry means the copy is usable.
  if (fs.existsSync(path.join(pkgDir, CLI_ENTRY))) return null;

  if (fs.existsSync(pkgDir)) {
    // Empty or half-written: step it aside so the previous copy can take the
    // name. Renamed, not removed — a partial tree may hold something the user
    // put there, and leaving it is cheaper than guessing.
    try {
      fs.renameSync(pkgDir, `${pkgDir}.incomplete-${Date.now()}`);
    } catch {
      return null; // held by a surviving process: cannot free the name
    }
  }

  const parent = path.dirname(pkgDir);
  const stagingPrefix = `.${path.basename(pkgDir)}-`;
  const leftovers: { dir: string; mtime: number }[] = [];

  try {
    for (const name of fs.readdirSync(parent)) {
      if (!name.startsWith(stagingPrefix)) continue;

      const dir = path.join(parent, name);

      try {
        const stat = fs.statSync(dir);

        if (stat.isDirectory()) leftovers.push({ dir, mtime: stat.mtimeMs });
      } catch { /* gone between readdir and stat */ }
    }
  } catch {
    return null; // no parent directory: nothing to restore from
  }

  leftovers.sort((a, b) => b.mtime - a.mtime);

  for (const { dir } of leftovers) {
    try {
      fs.renameSync(dir, pkgDir);

      return dir;
    } catch { /* locked by a surviving process: an older copy beats none */ }
  }

  return null;
}

/**
 * Put back the command shims npm moved aside with the package.
 *
 * npm renames `<prefix>/bin/teamai` to `bin/.teamai-<hash>` the same way it
 * renames the package, and on Windows the `teamai.cmd` / `teamai.ps1` shims in
 * the prefix get the same treatment. Restoring the package directory alone
 * leaves the command gone, which is the half of the symptom a user notices.
 *
 * The prefix comes from the caller: on POSIX the package sits at
 * `<prefix>/lib/node_modules/<pkg>`, so walking up from `pkgDir` lands on
 * `<prefix>/lib` and misses `bin/`. Both shim locations are checked, because a
 * Windows install with Git Bash on PATH gets the extensionless shim too.
 *
 * Returns the shim names that were put back.
 */
export function restoreInterruptedBins(pkgDir: string, prefix: string): string[] {
  const names = binNames(pkgDir);
  const restored: string[] = [];

  for (const dir of [path.join(prefix, 'bin'), prefix]) {
    for (const name of names) {
      for (const ext of ['', '.cmd', '.ps1']) {
        const target = `${name}${ext}`;
        const movedAside = newestMovedAside(dir, `.${target}-`);

        if (!movedAside) continue;

        const destination = path.join(dir, target);

        if (fs.existsSync(destination)) continue;

        try {
          fs.renameSync(movedAside, destination);
          restored.push(target);
        } catch { /* held by a surviving process: leave it */ }
      }
    }
  }

  return restored;
}

/** A manifest whose `bin` is the command name, or a map of name to entry. */
const ManifestWithSingleBin = z.object({ name: z.string(), bin: z.string() });
const ManifestWithBinMap = z.object({ bin: z.record(z.string(), z.string()) });

/** Shims named in the restored manifest; `teamai` when it cannot be read. */
function binNames(pkgDir: string): string[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const single = ManifestWithSingleBin.safeParse(raw);

    if (single.success) return [single.data.name];

    const mapped = ManifestWithBinMap.safeParse(raw);

    if (mapped.success) {
      const names = Object.keys(mapped.data.bin);

      if (names.length > 0) return names;
    }
  } catch { /* restored copy has no manifest: fall back to the package name */ }

  return ['teamai'];
}

/** Newest file in `dir` whose name starts with `marker`, else null. */
function newestMovedAside(dir: string, marker: string): string | null {
  let newest: { file: string; mtime: number } | null = null;

  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith(marker)) continue;

      const file = path.join(dir, entry);

      try {
        const stat = fs.statSync(file);

        if (stat.isFile() && (!newest || stat.mtimeMs > newest.mtime)) {
          newest = { file, mtime: stat.mtimeMs };
        }
      } catch { /* gone between readdir and stat */ }
    }
  } catch {
    return null; // no such directory in this prefix
  }

  return newest?.file ?? null;
}

/** `$VOLTA_HOME/tools/image/packages/<name>`, including the default `~/.volta` and `%LOCALAPPDATA%\\Volta` homes. */
const VOLTA_PACKAGE_IMAGE = /(?:^|\/)\.?volta\/tools\/image\/packages\//i;

/**
 * A Volta package image is not an npm prefix. `npm install -g --prefix` there
 * removes the current executable before the new one is in place.
 * `voltaHome` defaults to `VOLTA_HOME`; pass `''` to ignore a custom home.
 */
export function isVoltaPackageImage(filePath: string, voltaHome = process.env.VOLTA_HOME): boolean {
  if (voltaHome) {
    const root = path.resolve(voltaHome, 'tools', 'image', 'packages');
    const resolved = path.resolve(filePath);
    const fold = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const file = fold(resolved);
    const dir = fold(root);

    if (file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)) return true;
  }

  return VOLTA_PACKAGE_IMAGE.test(filePath.replace(/\\/g, '/'));
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
      { timeout, encoding: 'utf-8', windowsHide: true },
    );

    const version = stdout.trim();

    if (!version) return null;

    return version;
  } catch (e) {
    log.error(`Version check failed: ${e instanceof Error ? e.message : String(e)}`);

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

/** The `version` of the package.json an update installed, as written. */
const InstalledPackageSchema = z.object({ version: JsonValueSchema.optional() });

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
/** Who holds a lock: its process, and the owner token of a lock written in the JSON payload format. */
interface LockHolder {
  pid: number;
  owner?: string;
}

/** A lock file's JSON: the legacy bare integer PID, or the payload with a numeric pid. */
const LockContentSchema = z.union([
  z.number().refine(Number.isInteger).transform((pid): LockHolder => ({ pid })),
  z.object({ pid: z.number(), owner: z.string().optional().catch(undefined) }).transform(({ pid, owner }): LockHolder => ({ pid, owner })),
]);

function parseLockContent(content: string): LockHolder | null {
  const trimmed = content.trim();

  if (!trimmed) return null;

  try {
    const parsed = LockContentSchema.safeParse(JSON.parse(trimmed));

    return parsed.success ? parsed.data : null;
  } catch {
    // Legacy format: the file held only the bare PID as a string.
    const pid = parseInt(trimmed, 10);

    return isNaN(pid) ? null : { pid };
  }
}

/**
 * Inspect the lock at `resolved`: held by a live process, stale (its owning
 * process is gone), or missing. This is a pure read; it never mutates the lock.
 *
 * Only a verdict of stale lets a reclaimer rename over the lock, so only a
 * lock whose owner is provably gone reads as stale (#760). Anything that
 * cannot name a dead owner is held: a file denied by permissions (EACCES, e.g.
 * another user's 0600 lock), an empty or partly written one (its creator may
 * still be writing it: the O_EXCL fallback and older teamai open the file
 * before writing), and a pid that exists but belongs to another user (EPERM).
 * A lock that names no owner, or is permission-denied, stays until removed by hand
 * if a crash left it, so it is named in a warning.
 */
export async function lockState(resolved: string): Promise<'live' | 'stale' | 'missing'> {
  return (await inspectLock(resolved)).state;
}

/** lockState's verdict, with the dead holder when the lock is stale. */
type LockVerdict = { state: 'live' } | { state: 'missing' } | { state: 'stale'; holder: LockHolder };

async function inspectLock(resolved: string): Promise<LockVerdict> {
  let content: string;

  try {
    content = await fse.readFile(resolved, 'utf-8');
  } catch (err) {
    const code = errnoCode(err);

    if (code === 'ENOENT') return { state: 'missing' };

    if (code !== 'EACCES' && code !== 'EPERM') throw err;
    log.warn(`${resolved} cannot be read (${code}); treating it as held. Remove it if no teamai process is running.`);

    return { state: 'live' };
  }

  const parsed = parseLockContent(content);

  if (!parsed) {
    log.warn(`${resolved} names no owner; treating it as held. Remove it if no teamai process is running.`);

    return { state: 'live' };
  }

  try {
    process.kill(parsed.pid, 0);

    return { state: 'live' }; // process alive → lock genuinely held
  } catch (err) {
    // EPERM: alive, owned by another user. ESRCH: the owning process is gone.
    if (errnoCode(err) === 'EPERM') return { state: 'live' };
  }

  // The owner may have released the lock and exited after the read, and
  // another process created a fresh one: only the dead owner's own file is stale.
  try {
    return (await fse.readFile(resolved, 'utf-8')) === content ? { state: 'stale', holder: parsed } : { state: 'live' };
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { state: 'missing' };
    throw err;
  }
}

/**
 * Create the lock, or report who has it. A lock released between the failed
 * create and the read gets one more create: renaming over it could replace a
 * lock a third process just made, and reporting busy would turn a free lock
 * away (#760).
 */
async function createOrInspect(resolved: string, payload: string): Promise<'acquired' | 'live' | 'stale'> {
  if (await exclusiveCreate(resolved, payload)) return 'acquired';
  const state = await lockState(resolved);

  if (state !== 'missing') return state;

  return (await exclusiveCreate(resolved, payload)) ? 'acquired' : 'live';
}

/**
 * Atomic exclusive create. Returns true when this call created the file, false
 * when it already existed (EEXIST). Any error other than EEXIST from the O_EXCL
 * create propagates.
 *
 * The payload is written to a private temp file first and hard-linked to
 * `target`, which fails with EEXIST exactly like O_EXCL, so the lock never
 * exists without its content (#760): a contender never sees a lock that names
 * no owner, and an older teamai, which reclaims such a lock at once, cannot take
 * it over mid-create. A filesystem without hard links falls
 * back to O_EXCL, where the file is opened before it is written; lockState
 * never reclaims such a file while it names no dead owner.
 */
async function exclusiveCreate(target: string, payload: string): Promise<boolean> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  await fse.writeFile(tmp, payload);

  try {
    await fse.link(tmp, target);

    return true;
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false;

    return await exclusiveCreateInPlace(target, payload);
  } finally {
    await fse.remove(tmp).catch(() => {});
  }
}

async function exclusiveCreateInPlace(target: string, payload: string): Promise<boolean> {
  try {
    await fse.writeFile(target, payload, { flag: 'wx' });

    return true;
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false;
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
 * rest back off. A sentinel whose own holder died is removed with
 * removeDeadFile and created again, so a crashed reclaimer cannot wedge
 * stale-lock recovery forever.
 */
async function acquireReclaimSentinel(sentinel: string, owner: string): Promise<boolean> {
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    owner,
  } satisfies LockPayload);

  if (await exclusiveCreate(sentinel, payload)) return true;

  // Sentinel is held. Only take it over if its holder is gone.
  if (!(await removeDeadFile(sentinel, owner))) return false;

  return exclusiveCreate(sentinel, payload);
}

/** The owner token acquireLock writes (randomUUID), the only kind removeDeadFile puts in a file name. */
const OWNER_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Remove `target` only while it is still the file of the dead owner inspectLock
 * judged stale; true when this call removed it.
 *
 * A rename or remove acts on whatever file has the name by then, which may be a
 * live one another reclaimer has just created. So the removal runs under an
 * exclusive claim `<target>.steal-<dead owner>`: an owner token is never
 * written again, so while one process holds that claim no other can remove the
 * dead file, and the holder re-reads the file before removing it. A claim whose
 * own holder died is removed the same way, one level deeper, before it is taken.
 */
async function removeDeadFile(target: string, owner: string): Promise<boolean> {
  const verdict = await inspectLock(target);

  if (verdict.state !== 'stale' || !verdict.holder.owner || !OWNER_TOKEN.test(verdict.holder.owner)) return false;
  const dead = verdict.holder.owner;
  const claim = `${target}.steal-${dead}`;

  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    owner,
  } satisfies LockPayload);

  const claimed = (await exclusiveCreate(claim, payload))
    || ((await removeDeadFile(claim, owner)) && (await exclusiveCreate(claim, payload)));

  if (!claimed) return false;

  try {
    let current: string;

    try {
      current = await fse.readFile(target, 'utf-8');
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false;
      throw err;
    }

    if (parseLockContent(current)?.owner !== dead) return false;
    await fse.remove(target);

    return true;
  } finally {
    await removeIfOwner(claim, owner);
  }
}

/**
 * Try to acquire a lock. Returns false when the lock is held (including a
 * permission-denied or ownerless existing lock); filesystem failures reject
 * with the lock path and original cause, so callers do not retry them as contention.
 *
 * The happy path is a single atomic exclusive create (a fully written temp file
 * hard-linked to the lock name, or O_CREAT|O_EXCL without hard links), so exactly
 * one racing process wins an uncontended lock — this replaces the previous
 * check-then-write, where two processes could both observe "no lock" and both
 * succeed.
 *
 * Reclaiming a STALE lock (its owner is provably dead; see lockState) is serialized
 * behind a reclaim sentinel and completed with an atomic rename-into-place, so
 * concurrent reclaimers cannot each end up believing they hold the lock, even
 * when a reclaimer dies holding the sentinel (see removeDeadFile).
 */
export async function acquireLock(
  lockPath?: string,
  options: { dryRun?: boolean } = {},
): Promise<boolean> {
  const resolved = lockPath ?? expandHome(getUpdateLockPath());

  // A preview does not take the lock, because taking one is itself a write:
  // `ensureDir` below creates the lock's parent directory, which a fresh
  // self-mode clone has no partition for yet and which `releaseLock` has no
  // reason to remove — the directory would outlive the command (#866). What the
  // preview still owes its caller is the ANSWER the real command would get, so
  // it reads the lock's state instead of creating it: a live holder means the
  // real run would have reported contention, anything else means it would have
  // won. No owner is recorded, so `releaseLock` has nothing to undo.
  try {
    if (options.dryRun) return (await lockState(resolved)) !== 'live';
    const owner = randomUUID();

    const payload = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      owner,
    } satisfies LockPayload);

    // From the first real lock on, a best-effort sweep at process exit removes
    // whatever this process still holds (#1027). Dry runs never register it.
    ensureExitSweep();
    await ensureDir(path.dirname(resolved));
    // Fast path: no lock present. A live holder means busy; only a stale lock
    // may be reclaimed.
    const first = await createOrInspect(resolved, payload);

    if (first === 'acquired') {
      heldLockOwners.set(resolved, owner);

      return true;
    }

    if (first === 'live') return false;

    // Serialize the reclaim so only one process takes over the stale lock.
    const sentinel = `${resolved}.sentinel`;

    if (!(await acquireReclaimSentinel(sentinel, owner))) return false;

    try {
      // Re-evaluate now that we are the sole reclaimer.
      const second = await createOrInspect(resolved, payload);

      if (second === 'acquired') {
        heldLockOwners.set(resolved, owner);

        return true; // stale lock had vanished
      }

      if (second === 'live') return false; // became live under us
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
  } catch (err) {
    throw new Error(`Cannot acquire lock ${resolved}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
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

/**
 * Run `body` holding `lockPath`, trying up to `wait.attempts` times with
 * `wait.delayMs` between tries. `held: false` means the lock stayed busy and
 * `body` did not run.
 */
export async function withFileLock<T>(
  lockPath: string,
  wait: { attempts: number; delayMs: number },
  body: () => Promise<T>,
): Promise<{ held: true; value: T } | { held: false }> {
  for (let attempt = 0; attempt < wait.attempts; attempt++) {
    if (await acquireLock(lockPath)) {
      try {
        return { held: true, value: await body() };
      } finally {
        await releaseLock(lockPath);
      }
    }

    await new Promise((r) => setTimeout(r, wait.delayMs));
  }

  return { held: false };
}

/**
 * Synchronously remove the locks this process still holds when it exits —
 * the same owner-verified removal `releaseLock` does, but with sync fs calls,
 * because `process.on('exit')` handlers cannot await (#1027).
 *
 * This closes the common residue paths: a hook host's hard `process.exit(0)`
 * while best-effort background work (the auto-report) still holds a lock, and
 * any exit that skips a `finally releaseLock`. It cannot help against what no
 * process can catch (SIGKILL, a Windows job-object teardown): those locks stay
 * for the next `acquireLock` of the same path to reclaim, and for
 * `teamai doctor` to report. Errors are ignored: a lock that cannot be read is
 * left behind rather than guessed about.
 */
export function sweepHeldLocksOnExit(): void {
  for (const [resolved, owner] of heldLockOwners) {
    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      const parsed = parseLockContent(content);

      if (parsed?.owner && parsed.owner !== owner) continue; // someone else's now
      fs.rmSync(resolved, { force: true });
    } catch {
      // best effort
    }
  }

  heldLockOwners.clear();
}

let exitSweepRegistered = false;

/** Register the exit sweep once, when this process first takes a real lock. */
function ensureExitSweep(): void {
  if (exitSweepRegistered) return;
  exitSweepRegistered = true;
  process.on('exit', sweepHeldLocksOnExit);
}

/** The named locks the acquireLock family writes (no `.lock` suffix). */
const LOCK_BASENAMES = new Set([
  '.update-lock',
  '.sync-lock',
  '.reports-lock',
  '.learnings-lock',
  '.bootstrap-lock',
  '.local-agent-sync-lock',
  '.source-lifecycle-lock',
]);

/**
 * Every lock file under `roots` that the acquireLock family may have written:
 * the shared named locks, plus the per-file `<name>.lock` siblings (votes,
 * queue, secrets, models, …). `.git` and `node_modules` subtrees are skipped:
 * locks sit beside what they guard, never inside those.
 */
async function walkLockCandidates(roots: string[]): Promise<string[]> {
  const found: string[] = [];
  const queue = [...roots];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];

    try {
      entries = await fse.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // missing or unreadable directory
    }

    for (const entry of entries) {
      const p = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        queue.push(p);
      } else if (entry.isFile() && (LOCK_BASENAMES.has(entry.name) || entry.name.endsWith('.lock'))) {
        found.push(p);
      }
    }
  }

  return found;
}

/** True when `content` is a lock payload whose owning process is provably gone. */
function isDeadPidLock(content: string): boolean {
  const parsed = parseLockContent(content);

  if (!parsed) return false; // names no owner: never provably stale (#760)

  try {
    process.kill(parsed.pid, 0);

    return false;
  } catch (err) {
    // EPERM: the pid exists, owned by another user. Anything else: gone.
    return errnoCode(err) !== 'EPERM';
  }
}

/**
 * Lock files under `roots` whose owning process is dead — the zombies #1027
 * reports. A lock held by a live process, or one that names no owner (the
 * dashboard's raw-O_EXCL locks, an empty file mid-create), is never listed:
 * only a provably dead pid makes a lock removable.
 */
export async function listZombieLocks(roots: string[]): Promise<string[]> {
  const zombies: string[] = [];

  for (const p of await walkLockCandidates(roots)) {
    try {
      if (isDeadPidLock(await fse.readFile(p, 'utf-8'))) zombies.push(p);
    } catch {
      // unreadable: leave it alone
    }
  }

  return zombies;
}

/**
 * Remove the zombie locks under `roots`, returning the removed paths. Each one
 * is reclaimed through `acquireLock`/`releaseLock` — the same serialized,
 * owner-verified takeover the next real writer of that lock would run — so a
 * lock that became live again mid-cleanup is adopted and released, never
 * deleted out from under its holder.
 */
export async function removeZombieLocks(roots: string[]): Promise<string[]> {
  const removed: string[] = [];

  for (const p of await listZombieLocks(roots)) {
    try {
      if (await acquireLock(p)) {
        await releaseLock(p);
        removed.push(p);
      }
    } catch {
      // filesystem failure: report it as still present by not removing it
    }
  }

  return removed;
}

// ─── Core logic ─────────────────────────────────────────

export interface CheckResult {
  available: boolean;
  current: string;
  latest: string;
  /**
   * Where the answer came from: the registry, the cache within TTL, the cache
   * because the registry could not be reached (`last-check`), or nowhere.
   */
  source: 'registry' | 'cache' | 'last-check' | 'unknown';
}

/**
 * Check if a newer version is available.
 * Uses cached result if within TTL unless force is true. A forced check that
 * cannot reach the registry falls back to a cached result within TTL.
 */
export async function checkForUpdate(options?: { force?: boolean; dryRun?: boolean }): Promise<CheckResult> {
  const state = await loadState();
  const current = getCurrentVersion();

  const cached = (source: 'cache' | 'last-check'): CheckResult => {
    const latest = state.availableUpdate ?? current;

    return { available: compareVersions(current, latest) < 0, current, latest, source };
  };

  // A legacy null does not say which installation was current when the registry was checked.
  const hasCache = isCacheValid(state.lastUpdateCheck) && Boolean(state.availableUpdate);

  // Use cached result if valid
  if (!options?.force && hasCache) return cached('cache');

  // Fetch latest version from registry
  const home = getTeamaiHomeDir();
  const installed = fs.existsSync(home);
  const latest = await fetchLatestVersion();

  if (!latest) {
    return hasCache ? cached('last-check') : { available: false, current, latest: current, source: 'unknown' };
  }

  // An uninstall during the query removed the home; saving the check now would recreate it.
  if (installed && !fs.existsSync(home)) {
    return { available: false, current, latest: current, source: 'registry' };
  }

  // Compare and save state
  const available = compareVersions(current, latest) < 0;

  if (!options?.dryRun) {
    await saveState({
      ...state,
      lastUpdateCheck: new Date().toISOString(),
      availableUpdate: latest,
    });
  }

  return { available, current, latest, source: 'registry' };
}

/** The line to print when the registry could not answer, or null when it did. */
function registryUnreachableMessage(result: CheckResult): string | null {
  switch (result.source) {
    case 'registry':
    case 'cache':
      return null;
    case 'last-check':
      return result.available
        ? `Could not reach the registry; the last check found v${result.latest}. Run "teamai update" to upgrade.`
        : `Could not reach the registry; the last check found no newer version than v${result.current}.`;
    case 'unknown':
      return `Could not reach the registry and there is no recent check, so the update status is unknown (v${result.current}).`;
    default: {
      const unhandled: never = result.source;

      return unhandled;
    }
  }
}

/**
 * What a self-update attempt did. `failed` means the install itself failed:
 * the difference matters to `teamai update`, which must not report success,
 * and to the hook path, which discards the exit status anyway.
 */
export type UpdateOutcome = 'ok' | 'failed';

/**
 * Perform the actual update (check + install based on policy). The CLI is
 * shared by the whole machine, so one scope decides: the user scope when there
 * is one, else `runningScope`, the scope the update runs in.
 */
export async function doUpdate(runningScope: LocalConfig | null, options?: { force?: boolean }): Promise<UpdateOutcome> {
  const result = await checkForUpdate(options);
  const unreachable = registryUnreachableMessage(result);

  if (unreachable) log.warn(unreachable);

  if (!result.available) {
    if (!unreachable) log.info(`Already up to date (v${result.current})`);

    return 'ok';
  }

  // Load configs for update policy. Team config is the default; local
  // config overrides (user always wins).
  // oxlint-disable-next-line teamai/config-load-options -- automatic update policy retains normal config migration and has no preview option
  const localConfig = (await loadLocalConfig()) ?? runningScope;

  const teamConfig = localConfig
    ? await loadTeamConfig(localConfig.repo.localPath)
    : null;

  const policy = resolveEffectiveUpdatePolicy(localConfig, teamConfig);

  if (policy === 'skip') {
    const reason = teamConfig?.autoUpdate === false && localConfig?.updatePolicy === undefined
      ? 'team policy (autoUpdate: false)'
      : 'local updatePolicy: skip';

    log.debug(`Auto-update skipped: ${reason}`);

    return 'ok';
  }

  // Refuse unsupported install layouts before prompting, so nobody confirms
  // an update that is then skipped.
  const pkgName = getCurrentPackageName();
  const registry = resolveRegistryForPackage(pkgName);
  const target = resolveInstallPrefix();

  if (!target) {
    // A prefix-less `npm install -g` would land in npm's default global
    // prefix — for an `npm link` checkout that replaces the symlink with the
    // registry copy, so the checkout silently stops being the CLI that runs.
    // Hooks discard stderr, so debug.log keeps the record.
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

    const message =
      `Self-update skipped: teamai is running from ${root}, which is not an npm install ` +
      'it can update in place (for example an `npm link` checkout). For a checkout, pull ' +
      'and rebuild it; to switch to the published package, run ' +
      `"npm install -g ${pkgName} --registry=${registry}".`;

    log.warn(message);
    log.persist(message);

    return 'ok';
  }

  const entry = fileURLToPath(import.meta.url);
  // The directory the running CLI was installed into; npm is about to move it
  // aside and put a new copy there.
  const pkgDir = path.dirname(path.dirname(entry));

  if (isVoltaPackageImage(entry) || isVoltaPackageImage(target.prefix)) {
    // Volta's image looks like a POSIX global prefix (<image>/lib/node_modules),
    // so the check above accepts it. npm -g then deletes the live `teamai`
    // executable before writing the new one.
    const message =
      `Self-update skipped: teamai at ${target.prefix} is managed by Volta. ` +
      'npm install -g removes the current executable before the new one is installed, ' +
      'so an interrupted update leaves the `teamai` command missing. ' +
      `Upgrade with "volta install ${pkgName}@latest".`;

    log.warn(message);
    log.persist(message);

    return 'ok';
  }

  if (!target.global) {
    // POSIX vendored (flat) layouts cannot be reinstalled by npm without
    // destroying the tree: a non-global install reconciles <prefix> as a
    // project and prunes every undeclared sibling in <prefix>/node_modules
    // (including a co-located npm), while -g always lands in
    // <prefix>/lib. Stay out and let the user update manually.
    const message =
      `Self-update is not supported for the vendored install at ${target.prefix} ` +
      '(npm would relocate or prune the runtime tree) — update manually.';

    log.warn(message);
    log.persist(message);

    return 'ok';
  }

  if (policy === 'prompt') {
    if (!isInteractive()) {
      log.info(`Update available: v${result.current} → v${result.latest}. Run "teamai update" to upgrade.`);

      return 'ok';
    }

    const confirmed = await askConfirmation(
      `Update available: v${result.current} → v${result.latest}. Update now? (y/N) `,
    );

    if (!confirmed) {
      log.info('Update skipped');

      return 'ok';
    }
  }

  // auto policy or user confirmed — proceed with install
  const locked = await acquireLock();

  if (!locked) {
    log.warn('Another update is in progress, skipping');

    return 'ok';
  }

  try {
    const npm = resolveNpmCommand();
    await execFileAsync(
      npm.cmd,
      [
        ...npm.args,
        'install', '-g', pkgName,
        `--prefix=${target.prefix}`,
        `--registry=${registry}`,
      ],
      { timeout: INSTALL_TIMEOUT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    log.success(`Updated teamai to v${result.latest}`);

    // A zero exit does not prove the copy landed where the CLI runs from: npm
    // writes the new version aside and renames it in at the end, so a detached
    // install that outlived its parent can report success with the old copy
    // still moved aside.
    const restoredOnSuccess = restoreInterruptedInstall(pkgDir);
    const binsOnSuccess = restoreInterruptedBins(pkgDir, target.prefix);

    if (restoredOnSuccess) {
      const message =
        `npm reported success, but ${pkgDir} was missing: put the previous install back from ` +
        `${path.basename(restoredOnSuccess)}` +
        (binsOnSuccess.length > 0 ? ` and its command (${binsOnSuccess.join(', ')})` : '') +
        '. Run "teamai update" again to retry.';

      log.warn(message);
      log.persist(message);
    }

    const updatedEntry = resolveTeamaiEntryScript();

    // Verify the RUNNING install actually changed: a stale success message
    // here is exactly how self-update silently stops working.
    if (updatedEntry) {
      try {
        const installed = InstalledPackageSchema.parse(JSON.parse(fs.readFileSync(
          path.join(path.dirname(path.dirname(updatedEntry)), 'package.json'), 'utf-8',
        )));

        if (installed.version !== result.latest) {
          const message =
            `The running install at ${path.dirname(path.dirname(updatedEntry))} is still ` +
            `v${installed.version ?? 'unknown'} (expected v${result.latest}) — it may need a manual update.`;

          log.warn(message);
          log.persist(message);
        }
      } catch { /* verification is best-effort */ }
    }

    // Refresh hooks using new version's code (spawn new process so updated code is loaded).
    // PATH-less subprocesses (bundled runtimes) may not have `teamai` on PATH:
    // run the resolved entry with the current Node binary — spawning the .js
    // directly only works behind a shebang + PATH on POSIX.
    try {
      const refresh = updatedEntry
        ? { cmd: process.execPath, args: [updatedEntry, 'hooks', 'inject', '--silent'] }
        : { cmd: 'teamai', args: ['hooks', 'inject', '--silent'] };

      await execFileAsync(refresh.cmd, refresh.args, {
        timeout: HOOK_REFRESH_TIMEOUT,
        windowsHide: true,
      });
      log.success('Refreshed hooks with new version');
    } catch (e) {
      log.error(`Hook refresh after update skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';

    let message: string;

    if (msg.includes('EACCES') || errnoCode(e) === 'EACCES') {
      message = 'Permission denied. Run "teamai update" manually with appropriate permissions.';
    } else if (isInterruptedInstall(e, msg)) {
      message = 'Update was interrupted. Try again later.';
    } else {
      message = `Update failed: ${msg}. Run "teamai update" manually.`;
    }

    // Hooks discard stderr: without the file copy, a failed auto-update leaves
    // no trace anywhere — the one failure the reporter cannot hand over.
    // The install may also have taken the CLI's own directory with it: npm
    // renames the package aside first, so a failure in between leaves no
    // `teamai` to run at all.
    const restored = restoreInterruptedInstall(pkgDir);
    const restoredBins = restoreInterruptedBins(pkgDir, target.prefix);

    if (restored) {
      message += ` Put the previous install back from ${path.basename(restored)}`;
      message += restoredBins.length > 0
        ? ` and its command (${restoredBins.join(', ')}).`
        : '.';
    } else if (!fs.existsSync(path.join(pkgDir, CLI_ENTRY))) {
      message += ` ${pkgDir} is missing: reinstall with "npm install -g ${pkgName}".`;
    }

    log.warn(message);
    log.persist(message);

    return 'failed';
  } finally {
    await releaseLock();
  }

  return 'ok';
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
 * --dry-run: check without installing or saving the version-check state
 * default: full update flow (check + install)
 */
export async function update(options: UpdateOptions): Promise<void> {
  if (options.check || options.dryRun) {
    const result = await checkForUpdate({ force: true, dryRun: options.dryRun });
    const unreachable = registryUnreachableMessage(result);

    if (unreachable) {
      log.warn(unreachable);
    } else if (result.available) {
      log.info(`Update available: v${result.current} → v${result.latest}. Run "teamai update" to upgrade.`);
    } else {
      log.info(`Already up to date (v${result.current})`);
    }

    return;
  }

  // The failure is already on stderr; without this, a script running
  // `teamai update` would read a broken install as a successful update.
  if (await doUpdate(await resolveConfigForDir(), { force: true }) === 'failed') {
    process.exitCode = 1;
  }
}
