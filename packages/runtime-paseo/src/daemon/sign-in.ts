import { execFile } from 'node:child_process';
import path from 'node:path';
import { spawnCommand } from '@teamai/shared/exec';
import { signalChild, signalGroup } from '@teamai/shared/process-group';
import { z } from 'zod';

// ─── A tool's sign-in on the daemon's host ───────────────
//
//  How the runtime tells that a tool can run on the daemon's host: Claude's diagnostic names its home, and Codex answers
//  `codex login status`, which the runtime asks on a daemon on this machine only.
//

/** The config directory `claude auth status` reports in Claude's diagnostic, when it reports an absolute one. */
export function claudeHomeIn(diagnostic: string): string | undefined {
  const quoted = /"configDirectory":\s*("(?:[^"\\]|\\.)*")/.exec(diagnostic)?.[1];

  if (quoted === undefined) return undefined;

  try {
    const home = z.string().safeParse(JSON.parse(quoted));

    return home.success && path.isAbsolute(home.data) ? home.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a tool's sign-in check found: why the daemon cannot run it, or that it can, with the tool home it keeps its
 * sessions in when Paseo reports it (Claude's `configDirectory`).
 */
export type SignIn = { canRun: false; problem: string } | { canRun: true; home?: string };


/** How long `codex login status` may take, as Paseo gives `claude auth status` in Claude's diagnostic. */
const SIGN_IN_CHECK_TIMEOUT_MS = 5_000;

/**
 * The tool home a tool or team instance runs in on the daemon's host, when it is not the tool's own: the one its Paseo
 * provider's env sets, else a team instance's own. `shown` is how a sign-in step names it.
 */
export interface RunsIn {
  /** The variables that point the command at `dir`: a team instance's `homeEnv`, else the one its provider's env sets. */
  variables: readonly string[];
  dir: string;
  shown: string;
}

/** How a person signs a tool in on the daemon's host, such as `codex login`: for a team instance, its own command in its own home. */
export function signInStep({ runsIn, command, login }: { runsIn: RunsIn | undefined; command: string; login: string }): string {
  return `${runsIn ? runsIn.variables.map((variable) => `${variable}=${runsIn.shown} `).join('') : ''}${command} ${login}`;
}

/**
 * `<codex> login status`, killed whole when it does not answer in time: an npm `codex` is a shim that starts the native
 * binary, and killing the shim alone leaves that running. On POSIX it runs in a process group of its own; on Windows,
 * where spawnCommand runs a `.cmd` through cmd.exe, taskkill ends the tree under the process it started.
 */
export function codexLoginStatus(codex: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; answer: string }> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const child = spawnCommand(codex, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows, windowsHide: true, ...(env && { env }) });
    let answer = '';

    const timer = setTimeout(() => {
      const { pid } = child;

      try {
        // A taskkill that cannot run leaves the process teamai started to be killed on its own, as on POSIX.
        if (pid !== undefined && isWindows) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (error) => { if (error) signalChild(child, 'SIGKILL'); });
        else if (pid !== undefined && signalGroup(pid, 'SIGKILL') !== 'sent') signalChild(child, 'SIGKILL');
      } catch {
        signalChild(child, 'SIGKILL');
      }

      reject(new Error(`no answer in ${SIGN_IN_CHECK_TIMEOUT_MS} ms`));
    }, SIGN_IN_CHECK_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8').on('data', (text: string) => { answer += text; });
    child.stderr?.setEncoding('utf8').on('data', (text: string) => { answer += text; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, answer });
    });
  });
}

/**
 * Whether teamai may run the Codex the daemon resolves, as the member. It must be an absolute path, since a relative one
 * would resolve on teamai's PATH rather than the daemon's, to a file named `codex`, or on Windows to the binary
 * `codex.exe` or npm's `codex.cmd`, in any case; for a team instance, named as the command its provider runs.
 */
export function isCodexExecutable(resolved: string, platform: NodeJS.Platform = process.platform, name = 'codex'): boolean {
  if (platform === 'win32') {
    const base = path.win32.basename(resolved).toLowerCase();

    return path.win32.isAbsolute(resolved) && (base === `${name.toLowerCase()}.exe` || base === `${name.toLowerCase()}.cmd`);
  }

  return path.posix.isAbsolute(resolved) && path.posix.basename(resolved) === name;
}

