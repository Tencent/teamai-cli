import { execFile, spawn } from 'node:child_process';


export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}


// `git worktree add` writes a new worktree's entry under `.git/worktrees/` one file at a time and takes no lock, so a
// command that reads every worktree (`fetch`, `branch`, `worktree add`, `worktree list`) dies on an entry it finds half
// written (#1526). Each dies before it changes anything, all but `worktree add -b`, and git finishes the entry within a
// write, so the command runs again. The path is matched, not git's message, which git translates.
const HALF_WRITTEN_WORKTREE = /[\\/]worktrees[\\/][^\\/\r\n]+[\\/]commondir\b/;

// Five seconds: a loaded runner can stall the writer that long. An add that died there leaves the entry half written for good.
const HALF_WRITTEN_RETRY = { forMs: 5_000, everyMs: 50 };


/**
 * Runs git in `cwd`, writing `input` to its stdin, or stopping it once `timeoutMs` passed. Waits out a worktree entry
 * another `git worktree add` in the repository is still writing.
 */
export async function git(cwd: string, args: string[], options?: { input: string } | { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<GitResult> {
  const deadline = Date.now() + HALF_WRITTEN_RETRY.forMs;
  for (;;) {
    const result = await gitOnce(cwd, args, options);
    if (result.code === 0 || !HALF_WRITTEN_WORKTREE.test(result.stderr) || Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, HALF_WRITTEN_RETRY.everyMs));
  }
}


function gitOnce(cwd: string, args: string[], options?: { input: string } | { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<GitResult> {
  if (options === undefined || !('input' in options)) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd, env: { ...process.env, ...options?.env }, windowsHide: true, timeout: options?.timeoutMs }, (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.end(options.input);
  });
}
