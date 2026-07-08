import os from 'node:os';

/**
 * Resolve the user's home directory in a way that survives WorkBuddy's bundled
 * bash on Windows.
 *
 * WorkBuddy invokes hooks via `bash -lc "..."`, and that bash injects a
 * Unix-style HOME (e.g. /home/xxx) that does NOT match the native Windows
 * profile (C:\Users\xxx) where teamai's config and debug.log live. Trusting HOME
 * there makes the CLI look in the wrong directory — config loads fail (the
 * binding hint silently no-ops) and hook debug.log lands somewhere invisible.
 *
 * On Windows we therefore prefer USERPROFILE / os.homedir() (native Node reads
 * the real profile via the OS, ignoring the bash-injected HOME). On other
 * platforms we keep HOME first to preserve existing behavior and test isolation
 * (tests set process.env.HOME to a temp dir).
 *
 * This module intentionally has no internal dependencies so it can be imported
 * from foundational utilities like the logger without risking a cycle.
 */
export function resolveHomeDir(): string {
  if (process.platform === 'win32') {
    return process.env.USERPROFILE || os.homedir() || process.env.HOME || '';
  }
  return process.env.HOME || os.homedir() || '';
}
