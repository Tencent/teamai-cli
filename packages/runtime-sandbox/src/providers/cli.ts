import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Can, InitInstance, PlaceView, RuntimeFailure } from '@teamai/runtime-protocol';
import { boundedTail, STDERR_CHARS } from '../bounded-tail.js';
import { signalChild } from '@teamai/shared/process-group';

// ─── What every bind-mount provider shares: its CLI, and the place view as mounts ───
//
//  docker, podman and sbx are each one CLI the runtime runs once per step of its work, found on teamai's PATH, and each
//  mounts the place view at its host paths with the access the view gives each path.
//

/**
 * The workspaces a bind-mount sandbox runs a step in. teamai prepares each on the host, a clone or the team repo's
 * included, and gives its path and its git paths in the place view, which a bind mount keeps at the same paths.
 */
export const WORKSPACES: Can['workspace'] = ['read-only', 'new', 'continue', 'clone', 'team'];

/**
 * The tools a step runtime can launch, as `can.tools` lists those a sandbox holds: teamai's EXEC_RUNTIME_TOOLS, and
 * OpenCode, which only an app's runtime launches here, through `teamai-sandbox-opencode`.
 */
// oxlint-disable-next-line teamai/tool-facts -- by their executables; a runtime package cannot read teamai's tool registry
export const LAUNCHABLE = ['claude', 'codex', 'codebuddy', 'opencode'] as const;

/**
 * The `/bin/sh -c` arguments that print each of `commands` a sandbox holds, one per line. The commands go in as
 * arguments, never into the script, since an instance's comes from a config file.
 */
export function heldProbe(commands: readonly string[]): string[] {
  return ['-c', 'for t in "$@"; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; exit 0', 'sh', ...commands];
}

/** The instances' commands, to look for in a sandbox beside the tools it may hold. */
export function commandsOf(instances: ReadonlyArray<Pick<InitInstance, 'command'>>): string[] {
  return instances.flatMap(({ command }) => (command === undefined ? [] : [command]));
}

/** How the CLI ran: to its end, not at all, or past the time it was given, after which it was killed. */
export type Ran = { kind: 'ran'; code: number; stdout: string; stderr: string } | { kind: 'unstartable' | 'timed_out'; message: string };

export interface Cli {
  /** The CLI's path as teamai's PATH found it, or its bare name when none did. */
  executable: string;
  /**
   * Runs the CLI once with `args`, on `env` (teamai's own environment unless given), streaming its output. It answers
   * the last 64 Ki characters of stdout, or, for a listing (`isListing`), the whole answer its caller parses; stderr,
   * its last 8000 characters. With `timeoutMs`, a CLI still running that long after it started is killed and answers
   * `timed_out`.
   */
  run(args: string[], options?: { env?: NodeJS.ProcessEnv; onOutput?: (stream: 'stdout' | 'stderr', data: string) => void; timeoutMs?: number; isListing?: boolean }): Promise<Ran>;
  /** What the CLI said when it could not do something: its last stderr line, or why it could not start. */
  why(ran: Ran): string;
}


/**
 * The CLI `name` as teamai's PATH finds it. spawn looks a bare name up on the env it is given, and an exec's env may
 * carry the PATH the step wants inside the sandbox, so the path is resolved once, on teamai's.
 */
export function cliOf({ name, env, notInstalled }: { name: string; env: NodeJS.ProcessEnv; notInstalled: string }): Cli {
  const executable = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '').map((dir) => path.join(dir, name)).find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);

      return true;
    } catch {
      return false;
    }
  }) ?? name;

  return {
    executable,
    run: (args, { env: runEnv = env, onOutput, timeoutMs, isListing = false } = {}) => new Promise((resolve) => {
      const child = spawn(executable, args, { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });

      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        signalChild(child, 'SIGKILL');
        resolve({ kind: 'timed_out', message: `\`${name} ${args[0]}\` did not answer within ${timeoutMs / 1000} s` });
      }, timeoutMs);

      // A step's exec or a warm image's prepare may print without end: only a listing keeps its whole answer to parse.
      const stdout = isListing ? boundedTail(Number.POSITIVE_INFINITY) : boundedTail();
      const stderr = boundedTail(STDERR_CHARS);
      child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout.push(data); onOutput?.('stdout', data); });
      child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr.push(data); onOutput?.('stderr', data); });
      // A CLI that cannot start never closes: ENOENT is a missing CLI, anything else (EACCES) is named as it is.
      child.on('error', (error) => resolve({ kind: 'unstartable', message: 'code' in error && error.code === 'ENOENT' ? notInstalled : `${name} could not be started: ${error.message}` }));
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ kind: 'ran', code: code ?? (signal === 'SIGKILL' ? 137 : 143), stdout: stdout.text(), stderr: stderr.text() });
      });
    }),
    why: (ran) => (ran.kind === 'ran' ? ran.stderr.trim().split('\n').at(-1) ?? '' : ran.message),
  };
}

/**
 * How an exec client whose signals stop at the client (`docker exec`, `podman exec`, `sbx exec`) runs `argv` so a
 * signal still reaches it: through a shell that keeps the process's pid in a file of the sandbox's own, then becomes
 * it; and the command that signals that pid, the signal's name last. `exec` is the client's own argv up to the
 * sandbox's id; the pid file's name is random hex, so neither line takes anything from the step.
 */
export function signalled({ exec, argv }: { exec: readonly string[]; argv: readonly string[] }) {
  const pidFile = `/tmp/teamai-tool-${crypto.randomBytes(8).toString('hex')}.pid`;

  return {
    argv: [...exec, '/bin/sh', '-c', `echo $$ > ${pidFile}; exec "$@"`, 'sh', ...argv],
    signal: [...exec, '/bin/sh', '-c', `kill -s "$1" "$(cat ${pidFile})"`, 'sh'],
  };
}

/** `env` without the names it leaves unset, as a whole environment another process is given over a socket. */
export function definedOnly(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])));
}

/** One path of the place view and the access the sandbox gets to it. */
export interface Mount {
  at: string;
  mode: 'rw' | 'ro';
}

/**
 * Every path of `view`, each at its host path: the worktree, the result directory, the run directory and the tool
 * homes read-write, the git paths read-only. A writable path the CLI would create is created here first, so the member
 * owns it, not root. A path with ":" or "," is refused: neither `-v` nor sbx's `PATH:ro` can carry it.
 */
export function mountsOf(name: string, view: PlaceView): { ok: true; mounts: Mount[] } | { ok: false; failure: RuntimeFailure } {
  const writable = [view.worktree, view.result, view.runDir, ...Object.values(view.toolHome)];
  const mounts: Mount[] = [...writable.map((at) => ({ at, mode: 'rw' as const })), ...view.readonly.map((at) => ({ at, mode: 'ro' as const }))];
  const refused = mounts.map(({ at }) => unmountable(name, at)).find((failure) => failure !== undefined);

  if (refused) return { ok: false, failure: refused };

  for (const { at, mode } of mounts) if (mode === 'rw') fs.mkdirSync(at, { recursive: true });

  return { ok: true, mounts };
}

/** Why `name` cannot mount `at`, when a mount argument cannot carry it. */
export function unmountable(name: string, at: string): RuntimeFailure | undefined {
  return /[:,]/.test(at) ? { code: 'sandbox_failed', message: `${name} cannot mount ${at}: a path with ":" or "," cannot be mounted. Move the checkout to a path without them.` } : undefined;
}
