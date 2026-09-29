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
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import crossSpawn from 'cross-spawn';
import { resolveConfigForDir } from './config.js';
import { reportMissingSecrets } from './env-advisories.js';
import { resolveTeamEnv } from './env-resolution.js';
import { memberEnvironmentWithoutScope, type MemberEnvironment } from './member-env.js';
import { describeEntryFailure } from './namespaced-entries.js';
import { envTable } from './resources/env-key.js';
import { declaredSecretKeys } from './resources/secrets.js';
import { getDataHome, type GlobalOptions, type LocalConfig } from './types.js';
import { log, setStderrOnly } from './utils/logger.js';

/** How the command ended. */
export type ExecOutcome =
  | { readonly kind: 'exited'; readonly code: number }
  | { readonly kind: 'signaled'; readonly signal: NodeJS.Signals };

/** Signals sent to teamai alone, which the command gets only if teamai passes them on. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGHUP'];
/**
 * A terminal sends Ctrl-C and Ctrl-\ to its whole foreground process group, so
 * when teamai is in that group the command has them already; passing them on
 * would send a second, which tools such as terraform take as "force quit".
 * teamai then ignores them and waits. Anywhere else (a background job, no
 * terminal) one is sent to teamai alone, and is passed on.
 */
const TERMINAL_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGQUIT'];

/**
 * Whether `ps -o pgid=,tpgid=` says the process is in its terminal's
 * foreground process group. No controlling terminal prints a tpgid of 0
 * (macOS) or -1 (Linux).
 */
export function inTerminalForeground(ps: string): boolean {
  const [pgid, tpgid] = ps.trim().split(/\s+/).map(Number);
  return Number.isInteger(tpgid) && tpgid > 0 && pgid === tpgid;
}

/**
 * Whether a terminal delivers Ctrl-C to the command as well as to teamai.
 * Windows delivers it to every process on the console. Elsewhere, when `ps`
 * cannot say, teamai takes a SIGINT to be its alone: passing on one the
 * command already had is a second Ctrl-C, keeping it leaves the command
 * running.
 */
async function terminalReachesCommand(): Promise<boolean> {
  if (process.platform === 'win32') return true;
  try {
    const { stdout } = await promisify(execFile)('ps', ['-o', 'pgid=,tpgid=', '-p', String(process.pid)]);
    return inTerminalForeground(stdout);
  } catch {
    return false;
  }
}

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
  const env = await commandEnvironment(cwd, options.dryRun);
  if (options.dryRun) {
    log.info(`[dry-run] Would run ${file} with this directory's team env`);
    return { kind: 'exited', code: 0 };
  }
  return run(file, args, env, cwd, await terminalReachesCommand());
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
async function commandEnvironment(cwd: string, dryRun: boolean | undefined): Promise<NodeJS.ProcessEnv> {
  const unreadable: { configPath: string; error: string }[] = [];
  const localConfig = await resolveConfigForDir(cwd, (configPath, error) => { unreadable.push({ configPath, error }); }, { dryRun });
  if (unreadable.length > 0) {
    // The project's config is unknown, so as while its declarations fail, a value a teamai env.sh exported is removed.
    const env = inheritedEnvironment();
    const removed = withoutTeamExports(env, await memberEnvironmentWithoutScope(unreadable.map(({ configPath }) => path.dirname(configPath))));
    log.warn(`${unreadable.map(({ configPath, error }) => `${configPath} could not be read: ${error}.`).join(' ')} No team env `
      + `variables or secrets were applied; the command runs with the inherited environment${exportedClause(removed)}. Fix the `
      + 'file, or run `teamai init` again in this project.');
    return env;
  }
  // No scope delivers team values here, so as above, a value a teamai env.sh exported is removed.
  if (!localConfig) {
    const env = inheritedEnvironment();
    const removed = withoutTeamExports(env, await memberEnvironmentWithoutScope([]));
    log.warn('No teamai config applies to this directory, so no team env variables or secrets were applied; the command '
      + `runs with the inherited environment${exportedClause(removed)}.`);
    return env;
  }
  if (localConfig.repo.kind === 'http') {
    const env = inheritedEnvironment();
    const removed = withoutTeamExports(env, await memberEnvironmentWithoutScope([getDataHome(localConfig)]));
    log.warn('An HTTP team repo delivers no env variables or secrets here, so the command runs with the inherited '
      + `environment${exportedClause(removed)}.`);
    return env;
  }
  return overlayTeamEnv(localConfig);
}

/** A copy of the inherited environment that keeps `__proto__` an own key when the overlay sets it. */
function inheritedEnvironment(): NodeJS.ProcessEnv {
  return envTable(Object.entries(process.env));
}

/**
 * The inherited environment with this scope's variables and secrets. A key the
 * scope declares as a secret gets its resolved value or is removed, so the
 * command never sees a value `teamai env list` doesn't show for this scope:
 * another team's export, or the member's own export when this team's value
 * names another variable. A key that is also an env.yaml variable resolves as
 * a secret. A variable takes the member's value for this team, else the
 * team's, as in MCP; the inherited value never overrides it (#875). While the
 * declarations fail, nothing is overlaid, and every inherited value that is
 * not the member's own (member-env.ts) is removed; so is it while env.yaml
 * fails or the values file cannot be read.
 */
async function overlayTeamEnv(localConfig: LocalConfig): Promise<NodeJS.ProcessEnv> {
  const env = inheritedEnvironment();
  const teamEnv = await resolveTeamEnv(localConfig);
  const { variables, declarations, variableValues, secrets } = teamEnv;
  if (declarations.kind === 'failed') {
    // Any env.yaml key may be a secret the file declares, so no team value is applied (#879 Conflict 14),
    // and one a teamai env.sh exported is a team value, not the member's: it is removed.
    const failures = [variables, declarations].flatMap((entries) => entries.kind === 'failed' ? [describeEntryFailure(entries.failure)] : []);
    const without = exportedClause(withoutTeamExports(env, teamEnv.member));
    log.warn(`${failures.join(' ')} The command runs with the inherited environment, without team env variables or secrets${without}.`);
    return env;
  }
  // Without this team's variables, one a teamai env.sh exported may be another team's: it is removed.
  if (variables.kind === 'failed') {
    const without = exportedClause(withoutTeamExports(env, teamEnv.member));
    log.warn(`${describeEntryFailure(variables.failure)} The command runs without the team's env variables${without}.`);
  }
  if (variableValues.kind === 'store-unreadable') {
    const without = exportedClause(withoutTeamExports(env, teamEnv.member));
    log.warn(`${variableValues.reason} The command runs without the team's env variables${without}.`);
  } else {
    for (const [key, variable] of variableValues.values) setKey(env, key, variable.value);
  }
  const secretKeys = declaredSecretKeys(declarations);
  if (!secretKeys || secretKeys.size === 0) return env;

  if (secrets.kind === 'store-unreadable') {
    log.warn(`${secrets.reason} The command runs without team secrets.`);
  }
  for (const key of secretKeys) {
    const secret = secrets.kind === 'resolved' ? secrets.values.get(key) : undefined;
    if (secret) setKey(env, key, secret.value);
    else removeKey(env, key);
  }
  if (secrets.kind === 'resolved') await reportMissingSecrets(localConfig, teamEnv);
  return env;
}

/** Remove `key` from `env`, in every case on Windows, where environment names are case-insensitive. */
function removeKey(env: NodeJS.ProcessEnv, key: string): void {
  if (process.platform !== 'win32') {
    delete env[key];
    return;
  }
  const name = key.toUpperCase();
  for (const other of Object.keys(env)) if (other.toUpperCase() === name) delete env[other];
}

/** Set `key` in `env`, replacing it in any case on Windows rather than adding a competing name. */
function setKey(env: NodeJS.ProcessEnv, key: string, value: string): void {
  removeKey(env, key);
  env[key] = value;
}

/** Remove from `env` every value that is not the member's own (member-env.ts), and return the keys removed. */
function withoutTeamExports(env: NodeJS.ProcessEnv, member: MemberEnvironment): string[] {
  const removed = Object.keys(env).filter((key) => env[key] !== '' && member(key) === undefined);
  for (const key of removed) delete env[key];
  return removed;
}

/** The warning's clause naming the keys `withoutTeamExports` removed, never their values. */
function exportedClause(removed: readonly string[]): string {
  return removed.length > 0 ? `, and without ${removed.join(', ')}, whose values a teamai env.sh exported` : '';
}

/**
 * Run the command with the terminal's stdio. A signal sent to teamai alone is
 * passed on, one from the terminal is not, and either way teamai waits for
 * the command to end rather than exit first.
 */
function run(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  terminalReachesCommand: boolean,
): Promise<ExecOutcome> {
  const forwarded = terminalReachesCommand ? FORWARDED_SIGNALS : [...FORWARDED_SIGNALS, ...TERMINAL_SIGNALS];
  const ignored = terminalReachesCommand ? TERMINAL_SIGNALS : [];
  return new Promise((resolve) => {
    // cross-spawn: on Windows, npm installs CLIs as .cmd shims spawn can't start.
    const child = crossSpawn(file, [...args], { cwd, env, stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals): void => { child.kill(signal); };
    const ignore = (): void => {};
    for (const signal of forwarded) process.on(signal, forward);
    for (const signal of ignored) process.on(signal, ignore);
    let settled = false;
    const settle = (outcome: ExecOutcome): void => {
      if (settled) return;
      settled = true;
      for (const signal of forwarded) process.off(signal, forward);
      for (const signal of ignored) process.off(signal, ignore);
      resolve(outcome);
    };
    child.on('error', (e) => {
      log.error(`Could not run ${file}: ${e.message}`);
      settle({ kind: 'exited', code: 127 });
    });
    child.on('exit', (code, signal) => settle(signal ? { kind: 'signaled', signal } : { kind: 'exited', code: code ?? 1 }));
  });
}
