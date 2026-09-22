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
import { isInteractive } from './prompt.js';

/**
 * Applied only where the caller left the variable unset, so an explicit value
 * always wins. `GIT_SSH_COMMAND` is the one with reach beyond a prompt: it
 * takes precedence over `core.sshCommand`, so a run that needs its own ssh
 * invocation sets `GIT_SSH_COMMAND` (with whatever batch flag it wants).
 */
const NON_INTERACTIVE_GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  // `echo` answers the askpass request with an empty line, so the credential is
  // rejected at once instead of a dialog waiting for a person who is not there.
  GIT_ASKPASS: 'echo',
  // BatchMode turns a passphrase question and an unknown-host confirmation into
  // an immediate failure. A loaded ssh-agent or a bare key is unaffected.
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
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
}
