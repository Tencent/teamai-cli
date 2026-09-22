/**
 * The environment git child processes inherit when nobody can answer them.
 *
 * `GIT_TERMINAL_PROMPT=0` alone only closes git's own username/password
 * question on the terminal. Three other doors stay open, and each can park a
 * clone until its 180s timeout with no output (issue #711):
 *
 * - the askpass chain (`GIT_ASKPASS` → `core.askPass` → `SSH_ASKPASS`), which
 *   on a desktop session is a GUI dialog;
 * - `ssh`, which asks for a key passphrase or an unknown host key through
 *   `/dev/tty`, past every git setting;
 * - Git Credential Manager, whose window no git variable reaches.
 *
 * Every provider spawns git with the inherited environment, so assigning these
 * once at startup covers them all.
 */
import { spawnSync } from 'node:child_process';
import { isInteractive } from './prompt.js';

/** The ssh option that turns every question ssh could ask into a failure. */
const BATCH_MODE = '-o BatchMode=yes';

/**
 * Applied only where the caller left the variable unset, so an explicit value
 * always wins.
 */
const NON_INTERACTIVE_GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  // `echo` answers the askpass request with an empty line, so the credential is
  // rejected at once instead of a dialog waiting for a person who is not there.
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never',
};

/**
 * Close every prompt a git child could open, when this run has no one to
 * answer it. A no-op in an interactive run: a person at a terminal should still
 * get their credential helper.
 */
export function applyNonInteractiveGitEnv(): void {
  if (isInteractive()) return;
  for (const [name, value] of Object.entries(NON_INTERACTIVE_GIT_ENV)) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
  // Last, and only when it will be used: unlike the others it costs a
  // `git config` read.
  if (process.env.GIT_SSH_COMMAND === undefined) {
    process.env.GIT_SSH_COMMAND = batchModeSshCommand();
  }
}

/**
 * The ssh invocation git should use, in batch mode.
 *
 * `BatchMode=yes` turns a key passphrase question and an unknown-host
 * confirmation into an immediate failure (a loaded ssh-agent or a bare key is
 * unaffected), and ssh takes it only on its command line — which `git` builds
 * from `GIT_SSH_COMMAND`, or from `core.sshCommand` when that variable is
 * unset. Since the variable *replaces* the configured command rather than
 * extending it, setting it blindly would drop a setup that points git at a
 * custom key, ssh binary or wrapper, and authentication would fail outright
 * (#713 review). So read what is configured and append the flag to it.
 *
 * A command that already speaks about BatchMode is left exactly as it is: the
 * value it chose, `yes` or `no`, is the caller's decision.
 */
function batchModeSshCommand(): string {
  const configured = configuredSshCommand();
  if (!configured) return `ssh ${BATCH_MODE}`;
  if (/BatchMode/i.test(configured)) return configured;
  return `${configured} ${BATCH_MODE}`;
}

/** `core.sshCommand` as git resolves it here (repo config over global), or null. */
function configuredSshCommand(): string | null {
  try {
    const result = spawnSync('git', ['config', '--get', 'core.sshCommand'], {
      encoding: 'utf-8',
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    const value = (result.stdout ?? '').trim();
    return value.length > 0 ? value : null;
  } catch {
    // No git on PATH: then there is no git child to protect either.
    return null;
  }
}
