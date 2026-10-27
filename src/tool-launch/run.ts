import crossSpawn from 'cross-spawn';
import { recordGroup, stopProcess } from './process-stop.js';

export interface ToolRun {
  stdout: string;
  stderr: string;
  code: number;
  /** Whether the run was stopped at `timeoutMs`. */
  timedOut: boolean;
}

/**
 * Runs a headless tool with `stdin` as its input, stopping whatever it started at `timeoutMs`. A `detached` tool
 * leads its own process group outside Windows, recorded in `group` when given, so it outlives no stop but also gets
 * no Ctrl-C from the terminal: only a run nobody waits on in the foreground detaches.
 */
export async function runTool(input: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; detached: boolean; group?: string }): Promise<ToolRun> {
  const detached = input.detached && process.platform !== 'win32';
  const child = crossSpawn(input.executable, input.args, { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'], detached, windowsHide: true });
  if (detached && input.group !== undefined) recordGroup(child, input.group);
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.setEncoding('utf8').on('data', (text: string) => stdout.push(text));
  child.stderr?.setEncoding('utf8').on('data', (text: string) => stderr.push(text));
  const exited = new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code ?? 1)); });
  const stop = stopProcess(child, exited, detached);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void stop(); }, input.timeoutMs);
  child.stdin?.on('error', () => {});
  child.stdin?.end(input.stdin);
  try { const code = await exited; return { stdout: stdout.join(''), stderr: stderr.join(''), code, timedOut }; }
  finally { clearTimeout(timer); }
}
