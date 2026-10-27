import { resolveRunMode, RUN_MODE_ENV, type LaunchedBy } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { resolveCliPath } from '../utils/cli-path.js';
import { log } from '../utils/logger.js';
import { runTool } from './run.js';
import type { TokenUsage } from './stdout.js';
import { LAUNCH_ORDER, launchAdapterOf, type LaunchOrderTool } from './tools.js';

const DEFAULT_TIMEOUT_MS = 600_000;

/** An AI call's answer, and the tool that gave it. */
export type CallResult = { text: string; tool: LaunchOrderTool; tokens?: TokenUsage };

export interface CallOptions {
  /** Who in teamai makes the call, which the launched session carries as `TEAMAI_LAUNCHED_BY`. */
  launchedBy: LaunchedBy;
  timeout?: number;
}

export interface ToolCaller {
  callTool(prompt: string, options: CallOptions): Promise<CallResult>;
}

export interface ToolCallerDeps {
  resolveTool?: (command: string) => string | null;
  loadConfig?: () => Promise<LocalConfig | null>;
}

type Picked = { tool: LaunchOrderTool; executable: string };

/** The environment a call's tool runs in: the member's own, marked as teamai's launch, without an outer launch's checkout. */
function callEnv(launchedBy: LaunchedBy): NodeJS.ProcessEnv {
  const { TEAMAI_LAUNCHED_TOOL: _tool, TEAMAI_LAUNCHED_CHECKOUT: _checkout, ...env } = process.env;
  // Our own session, not the user's: its hooks would print the share-learnings hint into the answer we read.
  return { ...env, TEAMAI_CONTRIBUTE_HINT_DISABLED: '1', TEAMAI_LAUNCHED_BY: launchedBy, [RUN_MODE_ENV]: resolveRunMode(process.env) };
}

/** A caller that resolves its tool once and reuses it for every call. */
export function createToolCaller({ resolveTool = resolveCliPath }: ToolCallerDeps = {}): ToolCaller {
  let picked: Picked | undefined;
  const pick = (): Picked => {
    if (picked) return picked;
    for (const tool of LAUNCH_ORDER) {
      const executable = resolveTool(tool);
      if (executable !== null) {
        picked = { tool, executable };
        log.debug(`[tool-launch] using ${tool} (${executable}), from LAUNCH_ORDER`);
        return picked;
      }
    }
    throw new Error(`No AI tool teamai launches is on PATH. Install one of: ${LAUNCH_ORDER.join(', ')}, or set TEAMAI_AI_TOOL to one you have.`);
  };

  return {
    async callTool(prompt, { launchedBy, timeout = DEFAULT_TIMEOUT_MS }) {
      const { tool, executable } = pick();
      const { call } = launchAdapterOf(tool);
      log.debug(`[tool-launch] ${launchedBy} → ${tool}, timeout=${Math.round(timeout / 1000)}s`);
      const run = await runTool({ executable, args: [...call.args], cwd: process.cwd(), env: callEnv(launchedBy), stdin: prompt, timeoutMs: timeout });
      if (run.timedOut) throw new Error(`AI call timed out after ${Math.round(timeout / 1000)}s (tool: ${tool})`);
      const reading = call.read(run.stdout);
      if (run.code !== 0 || !reading.ok) {
        const reason = (reading.ok ? undefined : reading.message) || run.stderr.trim() || run.stdout.trim() || `exit code ${run.code}`;
        throw new Error(`AI call failed (tool: ${tool}): ${reason}`);
      }
      return { text: reading.text, tool, ...(reading.tokens ? { tokens: reading.tokens } : {}) };
    },
  };
}

export const { callTool } = createToolCaller();
