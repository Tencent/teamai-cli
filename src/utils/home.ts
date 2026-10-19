import os from 'node:os';
import path from 'node:path';

/**
 * Rewrite a Git Bash / MSYS home into the native form Windows path handling
 * expects.
 *
 * MSYS sets `HOME` to a POSIX-style path (`/c/Users/alice`, or
 * `/cygdrive/c/Users/alice`). Node's `path` is native on Windows, so joining
 * that string onto `.teamai/...` targets a drive-root path (`\c\Users\alice`)
 * rather than `C:\Users\alice` — credentials, the repo cache and the
 * path-safety allowlist would all land somewhere the user never looks. The
 * conversion only fires on a single-letter root, so a genuine POSIX home
 * (`/home/alice`) is left alone even if `HOME` is set to one on Windows.
 */
export function normalizeHomePath(home: string): string {
  if (process.platform !== 'win32') return home;
  const match = /^\/(?:cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/.exec(home);
  if (!match) return home;
  const rest = (match[2] ?? '').replace(/\//g, '\\');
  return `${match[1].toUpperCase()}:${rest ? `\\${rest}` : '\\'}`;
}

/**
 * Resolve the current user's home directory across supported platforms.
 *
 * `HOME` is normally present on Unix-like systems, while a regular Windows
 * PowerShell session commonly exposes only `USERPROFILE`. `os.homedir()` is the
 * platform-aware fallback. The result is normalised with
 * {@link normalizeHomePath} so a Git Bash `HOME` is usable by native `path`.
 *
 * If none of these resolves (os.homedir() is documented to return '' for a
 * passwd-less uid or under `env -i`), we throw rather than fall back to a
 * shared/relative directory. Callers join this onto `.teamai/...` to write
 * credentials and to resolve executables, so a shared location like os.tmpdir()
 * would be a code-execution / credential-exposure vector, and an empty string
 * would silently produce a cwd-relative path. Failing loudly is the safe choice —
 * on any real machine at least one of the three is always set.
 */
export function getUserHome(): string {
  const home = process.env.HOME?.trim()
    || process.env.USERPROFILE?.trim()
    || os.homedir();
  if (!home) {
    throw new Error(
      'Unable to determine the user home directory: none of HOME, USERPROFILE, ' +
      'or os.homedir() is available. Set HOME explicitly before running teamai.',
    );
  }
  return normalizeHomePath(home);
}

/**
 * The home directory releases before this change resolved `~` to, when it
 * differs from {@link getUserHome}.
 *
 * `~/.netrc` used to be read from `os.homedir()`. A user whose `HOME` points
 * somewhere else already has credentials in that location, so readers fall back
 * to it instead of silently logging them out on upgrade. Returns null when the
 * two agree (the common case) or when the platform home is unavailable.
 */
export function legacyUserHome(): string | null {
  let platformHome: string;
  try {
    platformHome = os.homedir();
  } catch {
    return null;
  }
  if (!platformHome) return null;
  let current: string;
  try {
    current = getUserHome();
  } catch {
    return null;
  }
  return path.resolve(platformHome) === path.resolve(current)
    ? null
    : platformHome;
}

/**
 * Expand ~ to the platform user home directory in paths.
 */
export function expandHome(p: string): string {
  // path.join converts ~/ to ~\ on Windows before manifest readers expand it.
  if (p.startsWith('~/') || p === '~' || (process.platform === 'win32' && p.startsWith('~\\'))) {
    return path.join(getUserHome(), p.slice(1));
  }
  return p;
}
