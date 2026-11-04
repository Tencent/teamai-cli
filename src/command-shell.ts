import { findGitBashWindows } from './bundled-runtime.js';
import { log } from './utils/logger.js';

let gitBash: string | null | undefined;

/**
 * The shell a team's commands run in: workflow `command` steps, checks and place setup, which are written for a POSIX
 * shell (`"$NAME"` reads a step's `env`). On Windows that is Git Bash, found by its install path so a `bash` on PATH
 * that is WSL's launcher is never used. Without Git Bash, the platform shell (cmd.exe), with a warning, since
 * `"$NAME"` stays literal there.
 */
export function commandShell(env: NodeJS.ProcessEnv) {
  if (process.platform !== 'win32') return { shell: true, env };

  if (gitBash === undefined) {
    gitBash = findGitBashWindows();

    if (gitBash === null) log.warn('Git Bash was not found, so workflow commands run in cmd.exe, where "$NAME" is not expanded. Install Git for Windows to run them as written.');
  }

  // Git's file:// transport needs MSYS path conversion in the shell it starts.
  return { shell: gitBash ?? true, env };
}
