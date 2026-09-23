// Bundled-runtime resolution: where GUI tools (WorkBuddy, CodeBuddy) ship
// their own Node and shell, and which of them provide a shell their hook
// commands can execute with — either a POSIX shell they bundle themselves
// (WorkBuddy's PortableGit) or one the OS guarantees (CodeBuddy's cmd.exe on
// Windows). All layout knowledge for these runtimes lives here so hook
// injection can stay tool-agnostic.
import fs from 'node:fs';
import path from 'node:path';
import { getUserHome } from './utils/home.js';
import { isOnPath, pathDirs } from './utils/lookpath.js';
import { log } from './utils/logger.js';

const WORKBUDDY_BUNDLED_NODE_DIR = '.workbuddy/bundled/node/versions';
const WORKBUDDY_PORTABLE_GIT_DIR = '.workbuddy/binaries/PortableGit/versions';

let _wbShellCache: string | null | undefined;
let _cbShellCache: string | null | undefined;

/** Reset cached bundled-runtime lookups. Test-only. */
export function resetBundledRuntimeCache(): void {
  _wbShellCache = undefined;
  _cbShellCache = undefined;
}

/**
 * Compare two semver-like version strings numerically (segment by segment).
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * Local copy rather than update.ts's compareVersions: this module sits on the
 * hook-injection fast path and must not drag in update's import graph.
 */
function compareSemver(a: string, b: string): number {
  const aParts = a.split('.').map(s => parseInt(s, 10) || 0);
  const bParts = b.split('.').map(s => parseInt(s, 10) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * All versioned runtime directories under a bundled-runtime root, newest
 * first (numeric semver comparison — avoids '9.0.0' > '10.11.0' lexicographic
 * error). Empty when the root is absent or unreadable.
 */
function versionDirsNewestFirst(relDir: string): string[] {
  try {
    const versionsDir = path.join(getUserHome(), relDir);
    return fs.readdirSync(versionsDir)
      .filter(d => !d.startsWith('.'))
      .sort((a, b) => compareSemver(b, a))
      .map(v => path.join(versionsDir, v));
  } catch {
    return [];
  }
}

/**
 * Resolve <home>/<relDir>/<latest-version> — the newest versioned runtime
 * directory under a bundled-runtime root, or null when absent.
 */
function latestVersionDir(relDir: string): string | null {
  return versionDirsNewestFirst(relDir)[0] ?? null;
}

/**
 * Find WorkBuddy's bundled Node binary. WorkBuddy ships its own Node under
 * ~/.workbuddy/bundled/node/versions/<ver>/bin/node. Pick the latest version
 * using numeric semver comparison.
 */
export function resolveWorkbuddyNode(): string | null {
  const dir = latestVersionDir(WORKBUDDY_BUNDLED_NODE_DIR);
  const nodeBin = dir && path.join(dir, 'bin', 'node');
  return nodeBin && fs.existsSync(nodeBin) ? nodeBin : null;
}

/**
 * Find CodeBuddy's bundled Node binary. CodeBuddy ships its own Node under
 * ~/.codebuddy-server-<variant>/bin/stable-<version>/node (prefix may vary).
 */
export function resolveCodebuddyNode(): string | null {
  const home = getUserHome();
  try {
    const entries = fs.readdirSync(home);
    for (const entry of entries) {
      if (!entry.startsWith('.codebuddy-server')) continue;
      try {
        const binDir = path.join(home, entry, 'bin');
        const stableDirs = fs.readdirSync(binDir).filter(d => d.startsWith('stable-'));
        for (const stable of stableDirs) {
          const nodeBin = path.join(binDir, stable, 'node');
          if (fs.existsSync(nodeBin)) return nodeBin;
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* home not readable */ }
  return null;
}

/**
 * Find the sh binary inside WorkBuddy's bundled PortableGit runtime
 * (~/.workbuddy/binaries/PortableGit/versions/<ver>/, either bin/sh.exe or
 * usr/bin/sh.exe). Windows builds of WorkBuddy ship this MSYS shell, so hook
 * commands are executable there even though /bin/sh does not exist. Memoized
 * — the bundled runtime cannot change mid-process. Returns null when not
 * found.
 */
function resolveWorkbuddyShell(): string | null {
  if (_wbShellCache === undefined) {
    _wbShellCache = null;
    if (process.platform === 'win32') {
      const dir = latestVersionDir(WORKBUDDY_PORTABLE_GIT_DIR);
      if (dir) {
        for (const rel of ['bin', path.join('usr', 'bin')]) {
          const shBin = path.join(dir, rel, 'sh.exe');
          if (fs.existsSync(shBin)) {
            _wbShellCache = shBin;
            break;
          }
        }
      }
    }
  }
  return _wbShellCache;
}

/**
 * The shell CodeBuddy runs hook commands with on Windows.
 *
 * CodeBuddy's hook runner executes a hook's `command` string through
 * `child_process.spawn(command, [], { shell: true })` (genie's
 * HookExecutorImpl), which on Windows goes through %ComSpec% — cmd.exe, a shell
 * the OS always provides — and NOT /bin/sh. Windows builds of the CodeBuddy IDE
 * ship no POSIX shell at all (no sh.exe/bash.exe anywhere in the install tree),
 * so gating the tool on /bin/sh is a false negative there. POSIX builds keep
 * the conservative /bin/sh check. Memoized like its WorkBuddy sibling.
 */
function resolveCodebuddyShell(): string | null {
  if (_cbShellCache === undefined) {
    _cbShellCache = process.platform === 'win32'
      ? (process.env.ComSpec?.trim() || 'cmd.exe')
      : null;
  }
  return _cbShellCache;
}

/**
 * Dirs a bundled git contributes to PATH, in the order they belong there:
 * `<root>/cmd` holds the executable itself and goes first, the msys dirs hold
 * what git shells out to (a credential helper, ssh) and go last. Git-for-
 * Windows layout, i.e. the same for any host that bundles one.
 */
function gitPathDirs(root: string): { first: string[]; last: string[] } {
  return {
    first: [path.join(root, 'cmd')],
    last: [path.join(root, 'usr', 'bin'), path.join(root, 'mingw64', 'bin')],
  };
}

/**
 * Where the GUI hosts keep their bundled git, one resolver per host — the git
 * counterpart of BUNDLED_SHELLS. Each resolver returns that host's version
 * dirs newest first, so a half-extracted latest version falls back to the
 * previous complete one. An array, not a keyed table: nothing selects a
 * host here (PATH is process-global and the CLI does not know which host
 * spawned it), so a key would only invite a per-host lookup that never happens.
 */
const BUNDLED_GIT_RESOLVERS: Array<() => string[]> = [
  () => versionDirsNewestFirst(WORKBUDDY_PORTABLE_GIT_DIR), // workbuddy
];

/**
 * Put the bundled gits on PATH, so bare-name lookups keep working in a process
 * the GUI host created without our environment.
 *
 * Windows is the case that matters: the session-start pull is spawned through
 * the WMI service to escape the host's job object (see hook-dispatch-cli.ts),
 * and a WMI-created process inherits the provider's env, not the caller's — so
 * the PATH that ran `teamai` never reaches the pull. simple-git then fails with
 * `spawn git ENOENT` and the pull silently does nothing, while the postPull
 * script (spawned by absolute path) keeps deploying the stale tree. Bare-name
 * `git` is not one call site: providers, mr-hint and simple-git all spawn it,
 * which is why this is a PATH fix rather than a resolver inside createGit.
 *
 * A machine that already resolves `git` is left alone, helpers included. Else
 * the `<cmd>` dirs go first — exactly what WorkBuddy's own teamai.cmd shim puts
 * on PATH — and the msys dirs are appended, so Windows' own binaries keep
 * winning.
 */
export function ensureBundledRuntimeOnPath(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return;
  if (isOnPath('git', { platform })) {
    log.debug('bundled runtime: git already resolves on PATH; leaving it alone');
    return;
  }
  const roots = BUNDLED_GIT_RESOLVERS
    .map(resolve => resolve().find(root => fs.existsSync(path.join(root, 'cmd', 'git.exe'))))
    .filter((root): root is string => root !== undefined);
  if (roots.length === 0) {
    log.debug('bundled runtime: no bundled git to add to PATH');
    return;
  }
  const entries = pathDirs();
  const seen = new Set(entries);
  const fresh = (dir: string) => !seen.has(dir) && fs.existsSync(dir);
  const dirs = roots.map(gitPathDirs);
  const prepend = dirs.flatMap(d => d.first).filter(fresh);
  const append = dirs.flatMap(d => d.last).filter(fresh);
  if (prepend.length === 0 && append.length === 0) return;
  process.env.PATH = [...prepend, ...entries, ...append].join(path.delimiter);
  log.debug(`bundled runtime: PATH now leads with [${prepend.join('; ')}] and ends with [${append.join('; ')}]`);
}

/**
 * Tools that provide a shell their hook commands can execute with, per tool id.
 * A tool without an entry falls back to the conservative /bin/sh gate.
 */
const BUNDLED_SHELLS: Record<string, () => string | null> = {
  workbuddy: resolveWorkbuddyShell,
  codebuddy: resolveCodebuddyShell,
};

/**
 * Return the shell a tool provides for hook commands, or null when it provides
 * none (the caller should then fall back to the /bin/sh check).
 */
export function bundledShellFor(tool: string): string | null {
  const resolver = BUNDLED_SHELLS[tool];
  return resolver ? resolver() : null;
}
