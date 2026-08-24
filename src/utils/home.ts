import os from 'node:os';

/**
 * Resolve the current user's home directory across supported platforms.
 *
 * `HOME` is normally present on Unix-like systems, while a regular Windows
 * PowerShell session commonly exposes only `USERPROFILE`. `os.homedir()` is
 * the platform-aware fallback, and `os.tmpdir()` is a last resort: `os.homedir()`
 * is documented to return `''` when the home cannot be resolved (e.g. a passwd-less
 * uid or `env -i`), and callers join this onto `.teamai/...`, so an empty result
 * would silently yield a cwd-relative path. Guaranteeing a non-empty absolute path
 * keeps every derived path absolute.
 */
export function getUserHome(): string {
  return process.env.HOME?.trim()
    || process.env.USERPROFILE?.trim()
    || os.homedir()
    || os.tmpdir();
}
