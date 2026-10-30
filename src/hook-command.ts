/**
 * Run one team hook command the way a Claude-format host runs it: through a
 * shell (Git Bash on Windows, where the team's POSIX commands and project
 * gates need it), in the session's directory, the payload on stdin, bounded
 * by its timeout, its exact exit status kept.
 */

import { spawn } from 'node:child_process';
import { findGitBashWindows } from './bundled-runtime.js';

/** What one hook command did. */
export interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run `command` in `cwd` with `stdin`, stopped with what it started after `timeout` seconds. */
export function runHookCommand(command: string, opts: { cwd: string | undefined; timeout: number; stdin: string }): Promise<HookRun> {
  return new Promise((resolve) => {
    const group = process.platform !== 'win32';
    const gitBash = process.platform === 'win32' ? findGitBashWindows() : null;
    const shell = process.platform === 'win32' ? (gitBash ?? true) : true;
    const spawnArgs = process.platform === 'win32' && gitBash ? ['-lc', command] : [];
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timeoutTriggered = false;
    const finish = (code: number | null, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
      });
    };
    const child = spawn(shell === true ? command : shell, spawnArgs, {
      ...(shell === true ? { shell: true } : {}),
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group, so a timeout stops the shell and what it started.
      detached: group,
    });
    const kill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The child already exited.
      }
    };
    const timer = setTimeout(() => {
      timeoutTriggered = true;
      if (process.platform === 'win32' && child.pid) {
        // Killing Git Bash alone leaves its foreground children alive. Wait for
        // taskkill's /T tree termination before returning a timeout to the host.
        try {
          const taskkill = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          taskkill.once('error', () => { kill(); finish(null, true); });
          taskkill.once('close', () => finish(null, true));
        } catch {
          kill();
          finish(null, true);
        }
      } else {
        try {
          if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
          else kill();
        } catch {
          // The child already exited.
        }
        finish(null, true);
      }
    }, opts.timeout * 1_000);
    child.stdout?.on('data', (chunk: Buffer | string) => { stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    child.on('error', (error) => { stderrChunks.push(Buffer.from(error.message)); finish(null, timeoutTriggered); });
    child.on('close', (code) => { if (!timeoutTriggered) finish(code); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.stdin);
  });
}
