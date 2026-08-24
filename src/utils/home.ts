import os from 'node:os';

/**
 * Resolve the current user's home directory across supported platforms.
 *
 * `HOME` is normally present on Unix-like systems, while a regular Windows
 * PowerShell session commonly exposes only `USERPROFILE`. `os.homedir()` is
 * the final platform-aware fallback.
 */
export function getUserHome(): string {
  return process.env.HOME?.trim()
    || process.env.USERPROFILE?.trim()
    || os.homedir();
}
