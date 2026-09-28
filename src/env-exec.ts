/**
 * `teamai env exec -- <command>` (#875): run a CLI such as `gh` or `glab` with
 * this directory's team env. The command inherits teamai's environment,
 * overlaid with the scope's env.yaml variables and its team secrets in the
 * resolution order (resources/secrets.ts). The scope is the one that governs
 * the directory (resolveConfigForDir), so every worktree of a project resolves
 * to that project.
 *
 * Everything teamai prints goes to stderr, so the command's stdout can be
 * piped. No value is written anywhere: the child gets it in its environment
 * only.
 */
import os from 'node:os';
import crossSpawn from 'cross-spawn';
import { resolveConfigForDir } from './config.js';
import { reportMissingSecrets } from './env-advisories.js';
import { resolveTeamEnv } from './env-resolution.js';
import { describeEntryFailure } from './namespaced-entries.js';
import { declaredSecretKeys } from './resources/secrets.js';
import type { GlobalOptions, LocalConfig } from './types.js';
import { log, setStderrOnly } from './utils/logger.js';

/** How the command ended. */
export type ExecOutcome =
  | { readonly kind: 'exited'; readonly code: number }
  | { readonly kind: 'signaled'; readonly signal: NodeJS.Signals };

/** Signals sent to teamai alone, which the command gets only if teamai passes them on. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGHUP'];
/**
 * A terminal sends Ctrl-C and Ctrl-\ to its whole foreground process group, so
 * the command has them already; passing them on would send a second, which
 * tools such as terraform take as "force quit". teamai ignores them and waits.
 */
const TERMINAL_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGQUIT'];

/**
 * Run the command in `words`, what was typed after `exec`: teamai's own
 * options, then `--`, then the command. Without `--`, a flag of the command
 * (`gh pr list --dry-run`) would be read as teamai's, so it is refused.
 */
export async function envExec(words: readonly string[], options: GlobalOptions, cwd = process.cwd()): Promise<ExecOutcome> {
  // Before the scope lookup, which can print (a role migration, for one).
  setStderrOnly(true);
  const separator = words.indexOf('--');
  if (separator === -1 || !words.slice(0, separator).every((word) => word.startsWith('-'))) {
    log.error('Put -- before the command: teamai env exec -- <command>');
    return { kind: 'exited', code: 2 };
  }
  const [file, ...args] = words.slice(separator + 1);
  if (!file) {
    log.error('No command to run. Usage: teamai env exec -- <command> [args...]');
    return { kind: 'exited', code: 2 };
  }
  const env = await commandEnvironment(cwd);
  if (options.dryRun) {
    log.info(`[dry-run] Would run ${file} with this directory's team env`);
    return { kind: 'exited', code: 0 };
  }
  return run(file, args, env, cwd);
}

/**
 * Signals that end the command but not Node: Node ignores SIGPIPE, and SIGUSR1
 * starts its inspector. Re-raising one would leave teamai running.
 */
const SURVIVED_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set(['SIGPIPE', 'SIGUSR1']);

/**
 * Exit the way the command did: its exit code, or the signal that ended it.
 * The shell's 128 + signal number is set first, for a signal teamai survives.
 */
export function exitLike(outcome: ExecOutcome): void {
  switch (outcome.kind) {
    case 'exited':
      process.exitCode = outcome.code;
      return;
    case 'signaled':
      process.exitCode = 128 + os.constants.signals[outcome.signal];
      if (!SURVIVED_SIGNALS.has(outcome.signal)) process.kill(process.pid, outcome.signal);
      return;
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

/** The environment the command runs with, reporting on stderr whatever it leaves out. */
async function commandEnvironment(cwd: string): Promise<NodeJS.ProcessEnv> {
  const unreadable: string[] = [];
  const localConfig = await resolveConfigForDir(cwd, (configPath, error) => { unreadable.push(`${configPath} could not be read: ${error}.`); });
  if (unreadable.length > 0) {
    log.warn(`${unreadable.join(' ')} No team env variables or secrets were applied; the command runs with the inherited `
      + 'environment. Fix the file, or run `teamai init` again in this project.');
    return { ...process.env };
  }
  if (!localConfig) {
    log.warn('No teamai config applies to this directory, so the command runs with the inherited environment and no team '
      + 'env variables or secrets.');
    return { ...process.env };
  }
  if (localConfig.repo.kind === 'http') {
    log.warn('An HTTP team repo delivers no env variables or secrets here, so the command runs with the inherited environment.');
    return { ...process.env };
  }
  return overlayTeamEnv(localConfig);
}

/**
 * The inherited environment with this scope's variables and secrets. A key the
 * scope declares as a secret gets its resolved value or is removed, so the
 * command never sees a value `teamai env list` doesn't show for this scope:
 * another team's export, or the member's own export when this team's value
 * names another variable. A key that is also an env.yaml variable resolves as
 * a secret. A variable takes the member's value for this team, else the
 * team's, as in MCP; the inherited value never overrides it (#875).
 */
async function overlayTeamEnv(localConfig: LocalConfig): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  const teamEnv = await resolveTeamEnv(localConfig);
  const { variables, declarations, variableValues, secrets } = teamEnv;
  if (variables.kind === 'failed') {
    log.warn(`${describeEntryFailure(variables.failure)} The command runs without the team's env variables.`);
  }
  if (declarations.kind === 'failed') {
    log.warn(`${describeEntryFailure(declarations.failure)} The command runs without team secrets.`);
  }
  if (variableValues.kind === 'store-unreadable') {
    log.warn(`${variableValues.reason} The command runs without the team's env variables.`);
  } else {
    for (const [key, variable] of variableValues.values) env[key] = variable.value;
  }
  const secretKeys = declaredSecretKeys(declarations);
  if (!secretKeys || secretKeys.size === 0) return env;

  if (secrets.kind === 'store-unreadable') {
    log.warn(`${secrets.reason} The command runs without team secrets.`);
  }
  for (const key of secretKeys) {
    const secret = secrets.kind === 'resolved' ? secrets.values.get(key) : undefined;
    if (secret) env[key] = secret.value;
    else delete env[key];
  }
  if (secrets.kind === 'resolved') await reportMissingSecrets(localConfig, teamEnv);
  return env;
}

/**
 * Run the command with the terminal's stdio. A signal sent to teamai alone is
 * passed on, one from the terminal is not, and either way teamai waits for
 * the command to end rather than exit first.
 */
function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    // cross-spawn: on Windows, npm installs CLIs as .cmd shims spawn can't start.
    const child = crossSpawn(file, [...args], { cwd, env, stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals): void => { child.kill(signal); };
    const ignore = (): void => {};
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    for (const signal of TERMINAL_SIGNALS) process.on(signal, ignore);
    let settled = false;
    const settle = (outcome: ExecOutcome): void => {
      if (settled) return;
      settled = true;
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
      for (const signal of TERMINAL_SIGNALS) process.off(signal, ignore);
      resolve(outcome);
    };
    child.on('error', (e) => {
      log.error(`Could not run ${file}: ${e.message}`);
      settle({ kind: 'exited', code: 127 });
    });
    child.on('exit', (code, signal) => settle(signal ? { kind: 'signaled', signal } : { kind: 'exited', code: code ?? 1 }));
  });
}
