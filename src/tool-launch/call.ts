import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aiToolSettings, detectProjectConfig } from '../config.js';
import { LAUNCHED_BY_ENV, resolveRunMode, RUN_MODE_ENV, type LaunchedBy } from '../launch-context.js';
import { getDataHome, type LocalConfig } from '../types.js';
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
  /** The scope a call runs in: the one a command resolves from its working directory, or none. */
  resolveScope?: () => Promise<LocalConfig | undefined>;
}

/** Where the member names the tool for teamai's AI work, the most specific first. */
export type MemberToolSource = 'TEAMAI_AI_TOOL' | 'ai.tool (project)' | 'ai.tool (machine)';

/** A tool the member names: where, and the setting a message tells them to change. */
export interface MemberTool {
  source: MemberToolSource;
  tool: string;
  setting: string;
}

/**
 * The tools the member names for `scope`, the most specific first: TEAMAI_AI_TOOL, then `ai.tool` in the scope's own
 * config, then in ~/.teamai/config.yaml. AI calls take the first; a workflow step puts its own settings between them.
 */
export async function memberTools(scope: LocalConfig | undefined): Promise<MemberTool[]> {
  const env = process.env.TEAMAI_AI_TOOL;
  return [
    ...(env ? [{ source: 'TEAMAI_AI_TOOL' as const, tool: env, setting: 'TEAMAI_AI_TOOL' }] : []),
    ...(await aiToolSettings(scope)).map(({ level, tool, file }) => ({ source: `ai.tool (${level})` as const, tool, setting: `ai.tool in ${file}` })),
  ];
}

/** The scope of a command run here, as the command resolves it, read without writing anything. */
async function scopeHere(): Promise<LocalConfig | undefined> {
  return await detectProjectConfig(process.cwd(), undefined, { dryRun: true, suppressMigrationNotice: true }) ?? undefined;
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

/** A caller that resolves its tool once per scope and reuses it for every call there. */
export function createToolCaller({ resolveTool = resolveCliPath, resolveScope = scopeHere }: ToolCallerDeps = {}): ToolCaller {
  /** The tool the member names. A member who names a tool means it, so one teamai cannot run fails the call. */
  const named = ({ source, tool: value, setting }: MemberTool): Picked => {
    const env = source === 'TEAMAI_AI_TOOL';
    const tool = LAUNCH_ORDER.find((candidate) => candidate === value);
    if (tool === undefined) {
      throw new CallError('override_invalid', `${setting} is "${value}", which is not a tool teamai launches. Set it to one of: ${LAUNCH_ORDER.join(', ')}. Or ${env ? 'unset' : 'remove'} it.`);
    }
    const executable = resolveTool(executableOf(tool));
    if (executable === null) {
      throw new CallError('override_invalid', `${setting} is "${tool}", which is not on PATH. Install ${tool}, or ${env ? 'unset TEAMAI_AI_TOOL' : 'remove it'} to use the next setting or the first installed tool.`);
    }
    log.debug(`[tool-launch] using ${tool} (${executable}), from ${source}`);
    return { tool, executable };
  };

  const resolve = async (scope: LocalConfig | undefined): Promise<Picked> => {
    const [first] = await memberTools(scope);
    if (first) return named(first);
    for (const tool of LAUNCH_ORDER) {
      const executable = resolveTool(executableOf(tool));
      if (executable !== null) {
        log.debug(`[tool-launch] using ${tool} (${executable}), from LAUNCH_ORDER`);
        return { tool, executable };
      }
    }
    throw new CallError('no_tool', `No AI tool teamai launches is on PATH. Install one of: ${LAUNCH_ORDER.join(', ')}, or set TEAMAI_AI_TOOL to one you have.`);
  };
  // One pick per scope, so a process that works in several projects never takes another project's tool. Only a pick
  // that succeeded is kept, so a long-lived process sees a tool installed or a setting fixed since.
  const picked = new Map<string, Promise<Picked>>();
  const pick = async (): Promise<Picked> => {
    const scope = await resolveScope();
    const key = scope && scope.scope !== 'user' ? getDataHome(scope) : 'machine';
    const cached = picked.get(key);
    if (cached) return cached;
    const picking = resolve(scope).catch((error: unknown) => { picked.delete(key); throw error; });
    picked.set(key, picking);
    return picking;
  };

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
