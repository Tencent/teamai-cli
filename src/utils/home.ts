import os from 'node:os';

/**
 * Resolve the current user's home directory across supported platforms.
 *
 * `HOME` is normally present on Unix-like systems, while a regular Windows
 * PowerShell session commonly exposes only `USERPROFILE`. `os.homedir()` is the
 * platform-aware fallback.
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
  return home;
}
