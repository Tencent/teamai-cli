import { callLaunch, type CallEnd, type CallLaunchHost, type CallTool } from '@teamai/tool-launch/call-launch';
import { spawnHeadless } from './headless.js';

/**
 * The answer launch: one run of the member's tool on its `call` profile, headless on this machine in `cwd` with `env`,
 * which an answer step on the host slot takes. It continues `session` when given, and ends at `timeoutMs`, at
 * `idleTimeoutMs` of silence, or when `signal` aborts.
 */
export function answerLaunch({ tool, prompt, session, timeoutMs, idleTimeoutMs, signal, cwd, env, host }: {
  tool: CallTool;
  prompt: string;
  session?: string | undefined;
  timeoutMs: number;
  idleTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
  host: CallLaunchHost;
}): Promise<CallEnd> {
  return callLaunch({ tool, prompt, session, timeoutMs, idleTimeoutMs, signal, host, start: (args) => spawnHeadless({ executable: tool.executable, args, cwd, env, detached: false }) });
}
