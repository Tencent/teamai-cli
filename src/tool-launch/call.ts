import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadLocalConfig } from '../config.js';
import { LAUNCHED_BY_ENV, resolveRunMode, RUN_MODE_ENV, type LaunchedBy } from '../launch-context.js';
import { getUserConfigPath, type LocalConfig } from '../types.js';
import { resolveCliPath } from '../utils/cli-path.js';
import { log } from '../utils/logger.js';
import { runTool } from './run.js';
import type { TokenUsage } from './stdout.js';
import { executableOf, LAUNCH_ORDER, launchAdapterOf, type LaunchOrderTool } from './tools.js';

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_CONCURRENCY = 3;

/** An AI call's answer, and the tool that gave it. */
export type CallResult = { text: string; tool: LaunchOrderTool; tokens?: TokenUsage };

export interface CallOptions {
  /** Who in teamai makes the call, which the launched session carries as `LAUNCHED_BY_ENV`. */
  launchedBy: LaunchedBy;
  timeout?: number;
}

export interface ToolCaller {
  callTool(prompt: string, options: CallOptions): Promise<CallResult>;
  /**
   * Runs every call, at most `concurrency` at a time, and returns the parsed answers in input order. When any call or
   * parse fails, it fails after the others finish, with an AggregateError of each failure.
   */
  callToolParallel<T>(tasks: ReadonlyArray<{ prompt: string; parse: (text: string) => T }>, options: CallOptions & { concurrency?: number }): Promise<T[]>;
}

export interface ToolCallerDeps {
  resolveTool?: (command: string) => string | null;
  loadConfig?: () => Promise<LocalConfig | null>;
}

/** Why a call did not answer: no tool to run it, an override that names a tool teamai cannot run, or the tool failed. */
export type CallErrorKind = 'no_tool' | 'override_invalid' | 'call_failed';

export class CallError extends Error {
  constructor(readonly kind: CallErrorKind, message: string) {
    super(message);
    this.name = 'CallError';
  }
}

/** Whether a call failed because the member named a tool teamai cannot run, which a caller's fallback must not hide. */
export function isOverrideInvalid(error: unknown): error is CallError & { kind: 'override_invalid' } {
  return error instanceof CallError && error.kind === 'override_invalid';
}

type Picked = { tool: LaunchOrderTool; executable: string };

/** The environment a call's tool runs in: the member's own, marked as teamai's launch, without an outer launch's checkout. */
function callEnv(launchedBy: LaunchedBy): NodeJS.ProcessEnv {
  const { TEAMAI_LAUNCHED_TOOL: _tool, TEAMAI_LAUNCHED_CHECKOUT: _checkout, ...env } = process.env;
  // Our own session, not the user's: its hooks would print the share-learnings hint into the answer we read.
  return { ...env, TEAMAI_CONTRIBUTE_HINT_DISABLED: '1', [LAUNCHED_BY_ENV]: launchedBy, [RUN_MODE_ENV]: resolveRunMode(process.env) };
}

/** A caller that resolves its tool once and reuses it for every call. */
export function createToolCaller({ resolveTool = resolveCliPath, loadConfig = loadLocalConfig }: ToolCallerDeps = {}): ToolCaller {
  /** The tool an override names. A member who names a tool means it, so one teamai cannot run fails the call. */
  const named = (source: 'TEAMAI_AI_TOOL' | 'ai.tool', value: string): Picked => {
    const tool = LAUNCH_ORDER.find((candidate) => candidate === value);
    if (tool === undefined) {
      throw new CallError('override_invalid', source === 'TEAMAI_AI_TOOL'
        ? `TEAMAI_AI_TOOL is "${value}", which is not a tool teamai launches. Set it to one of: ${LAUNCH_ORDER.join(', ')}. Or unset it.`
        : `ai.tool in ${getUserConfigPath()} is "${value}", which is not a tool teamai launches. Set it to one of: ${LAUNCH_ORDER.join(', ')}. Or remove it.`);
    }
    const executable = resolveTool(executableOf(tool));
    if (executable === null) {
      throw new CallError('override_invalid', source === 'TEAMAI_AI_TOOL'
        ? `TEAMAI_AI_TOOL is "${tool}", which is not on PATH. Install ${tool}, or unset TEAMAI_AI_TOOL to use the first installed tool.`
        : `ai.tool in ${getUserConfigPath()} is "${tool}", which is not on PATH. Install ${tool}, or remove ai.tool to use the first installed tool.`);
    }
    log.debug(`[tool-launch] using ${tool} (${executable}), from ${source}`);
    return { tool, executable };
  };

  const resolve = async (): Promise<Picked> => {
    if (process.env.TEAMAI_AI_TOOL) return named('TEAMAI_AI_TOOL', process.env.TEAMAI_AI_TOOL);
    const configured = (await loadConfig())?.ai?.tool;
    if (configured) return named('ai.tool', configured);
    for (const tool of LAUNCH_ORDER) {
      const executable = resolveTool(executableOf(tool));
      if (executable !== null) {
        log.debug(`[tool-launch] using ${tool} (${executable}), from LAUNCH_ORDER`);
        return { tool, executable };
      }
    }
    throw new CallError('no_tool', `No AI tool teamai launches is on PATH. Install one of: ${LAUNCH_ORDER.join(', ')}, or set TEAMAI_AI_TOOL to one you have.`);
  };
  let picked: Promise<Picked> | undefined;
  const pick = (): Promise<Picked> => picked ??= resolve();

  const callTool: ToolCaller['callTool'] = async (prompt, { launchedBy, timeout = DEFAULT_TIMEOUT_MS }) => {
      const { tool, executable } = await pick();
      const { call } = launchAdapterOf(tool);
      log.debug(`[tool-launch] ${launchedBy} → ${tool}, timeout=${Math.round(timeout / 1000)}s`);
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-call-'));
      try {
        const lastMessageFile = path.join(scratch, 'last-message.txt');
        const promptFile = path.join(scratch, 'prompt.md');
        if (call.prompt === 'file') await fs.writeFile(promptFile, prompt);
        const args = call.args({ prompt, promptFile, lastMessageFile });
        const run = await runTool({ executable, args, cwd: process.cwd(), env: callEnv(launchedBy), stdin: call.prompt === 'stdin' ? prompt : '', timeoutMs: timeout, detached: false });
        if (run.timedOut) throw new CallError('call_failed', `AI call timed out after ${Math.round(timeout / 1000)}s (tool: ${tool})`);
        const lastMessage = await fs.readFile(lastMessageFile, 'utf8').catch(() => undefined);
        const reading = call.read({ stdout: run.stdout, lastMessage });
        if (run.code !== 0 || !reading.ok) {
          const reason = (reading.ok ? undefined : reading.message) || run.stderr.trim() || run.stdout.trim() || `exit code ${run.code}`;
          throw new CallError('call_failed', `AI call failed (tool: ${tool}): ${reason}`);
        }
        return { text: reading.text, tool, ...(reading.tokens ? { tokens: reading.tokens } : {}) };
      } finally {
        await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 });
      }
  };

  async function callToolParallel<T>(tasks: ReadonlyArray<{ prompt: string; parse: (text: string) => T }>, { concurrency = DEFAULT_CONCURRENCY, ...options }: CallOptions & { concurrency?: number }): Promise<T[]> {
    // A batch has one tool, so a tool that cannot be picked fails the batch once rather than once per task.
    await pick();
    const settled: ({ ok: true; value: T } | { ok: false; reason: unknown })[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let index = next++; index < tasks.length; index = next++) {
        const task = tasks[index];
        try { settled[index] = { ok: true, value: task.parse((await callTool(task.prompt, options)).text) }; }
        catch (reason) { settled[index] = { ok: false, reason }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    const errors = settled.flatMap((outcome) => outcome.ok ? [] : [outcome.reason]);
    if (errors.length > 0) throw new AggregateError(errors, `${errors.length} AI task(s) failed`);
    return settled.flatMap((outcome) => outcome.ok ? [outcome.value] : []);
  }

  return { callTool, callToolParallel };
}

export const { callTool, callToolParallel } = createToolCaller();
