/**
 * The environment git child processes inherit when nobody can answer them.
 *
 * `GIT_TERMINAL_PROMPT=0` alone only closes git's own username/password
 * question on the terminal. Two other doors stay open, and each can park a
 * clone until its 180s timeout with no output (issue #711):
 *
 * - the askpass chain (`GIT_ASKPASS` → `core.askPass` → `SSH_ASKPASS`), which
 *   on a desktop session is a GUI dialog;
 * - Git Credential Manager, whose window no git variable reaches.
 *
 * Every provider spawns git with the inherited environment, so assigning these
 * once at startup covers them all. Each names a *prompt*, never an identity or
 * a transport, so one value is right for every repository the run touches.
 *
 * `ssh` is deliberately not covered here. Its batch flag can only be reached
 * through `GIT_SSH_COMMAND`, which overrides `core.sshCommand` for every later
 * git operation — so a process-wide value would push the launch directory's
 * key or wrapper onto the managed team repo, or suppress the key that repo
 * configured for itself (#713 review). A run that needs ssh to fail fast sets
 * `core.sshCommand` on the repository, or exports `GIT_SSH_COMMAND` itself.
 */
import { isInteractive } from './prompt.js';

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
 * Close the prompts a git child could open, when this run has no one to answer
 * them. A no-op in an interactive run: a person at a terminal should still get
 * their credential helper.
 */
export function applyNonInteractiveGitEnv(): void {
  if (isInteractive()) return;
  for (const [name, value] of Object.entries(NON_INTERACTIVE_GIT_ENV)) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
}
