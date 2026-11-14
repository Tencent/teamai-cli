import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnCommand } from '@teamai/shared/exec';
import { runHeadless, type HeadlessRun, type HeadlessStarter } from '@teamai/tool-launch/call-launch';
import { recordGroup, stopProcess } from '@teamai/shared/process-group';

/**
 * The port that spawns a headless tool on this machine. A `detached` tool leads its own process group outside Windows,
 * recorded in `group` when given, so it outlives no stop but also gets no Ctrl-C from the terminal: only a run nobody
 * waits on in the foreground detaches.
 */
export function spawnHeadless(input: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; detached: boolean; group?: string }): HeadlessStarter {
  return ({ stdin, onOutput }) => {
    const detached = input.detached && process.platform !== 'win32';
    // A shell sets PWD to the directory it starts in; OpenCode works in PWD, not in its cwd.
    const options: SpawnOptions = { cwd: input.cwd, env: { ...input.env, PWD: input.cwd }, stdio: ['pipe', 'pipe', 'pipe'], detached, windowsHide: true };
    let child: ChildProcess;

    try {
      child = spawnCommand(input.executable, input.args, options);
    } catch (error) {
      // cmd.exe cannot carry these arguments to a batch file: nothing was started.
      return { notStarted: error instanceof Error ? error.message : String(error) };
    }

    if (detached && input.group !== undefined) recordGroup(child, input.group);
    child.stdout?.setEncoding('utf8').on('data', (text: string) => onOutput(text, 'stdout'));
    child.stderr?.setEncoding('utf8').on('data', (text: string) => onOutput(text, 'stderr'));
    const exited = new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code ?? 1)); });
    const stop = stopProcess(child, exited, detached);
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);

    return { exited, stop: async () => { await stop(); } };
  };
}

/** Runs a headless tool spawned on this machine with `stdin` as its input, stopped at `timeoutMs`, its idle limit, or when `signal` aborts. */
export async function runTool(input: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; idleTimeoutMs?: number; detached: boolean; group?: string; signal?: AbortSignal }): Promise<HeadlessRun> {
  return runHeadless({ start: spawnHeadless(input), stdin: input.stdin, timeoutMs: input.timeoutMs, idleTimeoutMs: input.idleTimeoutMs, signal: input.signal });
}
