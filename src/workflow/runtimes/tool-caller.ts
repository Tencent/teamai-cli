import { resolveConfigForDir, resolveMemberToolRoots } from '../../config.js';
import { LAUNCHED_BY_ENV, resolveRunMode, RUN_MODE_ENV, type LaunchedBy } from '../../launch-context.js';
import type { LocalConfig } from '../../types.js';
import { resolveCliPath } from '@teamai/shared/cli-path';
import { log } from '@teamai/shared/log';
import { CallError, memberTools, type MemberTool } from '../member-tools.js';
import { addTokens, type TokenUsage } from '@teamai/tool-core/stdout';
import { executableOf, LAUNCH_ORDER, launchAdapterIdOf, launchAdapterOf, launchExecutableOf, toolCommandEnv, type LaunchOrderTool } from '../../launch-registry.js';
import { acceptToolCommand } from '../../tool-instances.js';
import { toolOf } from '../../tool-registry.js';
import { agyGatewayEnv } from '../../models/agy-gateway.js';
import { extractReply } from '@teamai/tool-core/reply';
import { answerLaunch } from '@teamai/runtime-tools/answer';
import { opencodeMajorVersion } from '../../opencode-version.js';
import type { z } from 'zod';
import { withoutOuterSessionMarkers } from '../attempt-marker.js';

const DEFAULT_TIMEOUT_MS = 600_000;

/** An AI call's answer, and the tool that gave it, by the name the member gave it: an instance's own. */
export type CallResult = { text: string; tool: string; tokens?: TokenUsage };

/** A call asked for a value: the last answer, the value it holds or undefined when none held one, and how often it asked. */
export type ReplyResult<T> = CallResult & { reply: T | undefined; asked: number };

export interface CallOptions {
  /** Who in teamai makes the call, which the launched session carries as `LAUNCHED_BY_ENV`. */
  launchedBy: LaunchedBy;
  timeout?: number;
  /** The scope the call acts for, when the caller holds it. Without it, the scope of the working directory. */
  scope?: LocalConfig;
  /** Where the tool runs: the working directory unless given. */
  cwd?: string;
  /** Stops the tool, as its timeout does. */
  signal?: AbortSignal;
  /**
   * Stops a tool that prints nothing for this long, in ms, calling it in a way that prints as it works (Claude's
   * stream-json). A tool whose call prints only once it ends gets no idle limit: it would be stopped while it works.
   */
  idleTimeout?: number;
}

export interface ReplyOptions extends CallOptions {
  /** How many more times to ask, in the same session, when a reply holds no value `schema` accepts. Default 1. */
  retries?: number;
}

export interface ToolCaller {
  callTool(prompt: string, options: CallOptions): Promise<CallResult>;
  /**
   * Asks for a value `schema` accepts, and when the reply holds none, asks again in the same session, up to `retries`
   * times, for a tool whose call can continue its session. A tool that cannot is asked once.
   */
  callForReply<T>(prompt: string, schema: z.ZodType<T>, options: ReplyOptions): Promise<ReplyResult<T>>;
  /** The tool a call for `scope` runs on, by the name a call credits it with; throws the `CallError` a call would. */
  toolFor(scope: LocalConfig | undefined): Promise<string>;
}

const DEFAULT_REPLY_RETRIES = 1;

/** What a tool is told when its reply held no value: what it said, and to reply with the value alone. */
function retryPrompt(previous: string, retriesLeft: number): string {
  return `Your previous reply did not hold a JSON value that matches what was asked.

Retries remaining after this attempt: ${retriesLeft}.

Previous reply:
${previous.trim() || '(empty)'}

Reply with only the corrected JSON value, with no other text. Do not change files or run commands.`;
}

export interface ToolCallerDeps {
  resolveTool?: (command: string) => string | null;
  /** The scope a call runs in: the one a command resolves from its working directory, or none. */
  resolveScope?: () => Promise<LocalConfig | undefined>;
}

/**
 * The scope of a command run here, as the command resolves it, read without writing anything. A scope config here that
 * cannot be read may set the tool, so it fails the call rather than let another level pick one.
 */
async function scopeHere(): Promise<LocalConfig | undefined> {
  const unreadable: string[] = [];
  const scope = await resolveConfigForDir(process.cwd(), (file, error) => { unreadable.push(`${file} could not be read: ${error}.`); }, { dryRun: true, suppressMigrationNotice: true });

  if (unreadable.length > 0) {
    throw new CallError('override_invalid', `${unreadable.join(' ')} teamai cannot tell which ai.tool applies here, so no AI call runs until that is fixed.`);
  }

  return scope ?? undefined;
}

/** The tool a call runs: its name, an instance's own, the shipped tool whose flags it runs with, and its executable. */
type Picked = { name: string; tool: LaunchOrderTool; executable: string };

/** The tool a call runs, and the environment it runs it in. */
type Prepared = Picked & { env: NodeJS.ProcessEnv };

/**
 * The environment a call's tool runs in: the member's own at the home teamai delivered the tool to, marked as teamai's
 * launch, without an outer launch's checkout or session markers. A recorded home that is gone fails the call, as it
 * skips delivery.
 */
function callEnv({ launchedBy, name, tool, toolRoots }: { launchedBy: LaunchedBy; name: string; tool: LaunchOrderTool; toolRoots: LocalConfig['toolRoots'] }): NodeJS.ProcessEnv {
  const { TEAMAI_LAUNCHED_TOOL: _tool, TEAMAI_LAUNCHED_CHECKOUT: _checkout, ...env } = withoutOuterSessionMarkers(process.env);
  const home = toolCommandEnv(name, { kind: 'delivered', inherited: env, toolRoots });

  if (home.kind === 'home_gone') throw new CallError('home_gone', home.message);
  const gateway = tool === 'agy' ? agyGatewayEnv(env) : undefined;

  // Our own session, not the user's: its hooks would print the share-learnings hint into the answer we read.
  return { ...env, ...home.env, ...gateway, TEAMAI_CONTRIBUTE_HINT_DISABLED: '1', [LAUNCHED_BY_ENV]: launchedBy, [RUN_MODE_ENV]: resolveRunMode(process.env) };
}

/** A caller that resolves its tool once per scope and reuses it for every call there. */
export function createToolCaller({ resolveTool = resolveCliPath, resolveScope = scopeHere }: ToolCallerDeps = {}): ToolCaller {
  /**
   * The tool the member names, or an instance of one, run as a workflow step runs it. A member who names a tool means
   * it, so one teamai cannot run fails the call, and so does a team instance's command no one accepted here: a call
   * asks no one.
   */
  const named = async ({ source, tool: value, setting }: MemberTool): Promise<Picked> => {
    const env = source === 'TEAMAI_AI_TOOL';
    const resolved = toolOf(value);
    const tool = LAUNCH_ORDER.find((candidate) => candidate === resolved?.base);

    if (resolved === undefined || tool === undefined) {
      throw new CallError('override_invalid', `${setting} is "${value}", which is not a tool teamai launches. Set it to one of: ${LAUNCH_ORDER.join(', ')}. Or ${env ? 'unset' : 'remove'} it.`);
    }

    const { instance } = resolved;
    const command = instance?.command;
    const executable = command === undefined ? resolveTool(executableOf(tool)) : launchExecutableOf({ tool, instance });

    if (executable === null) {
      throw new CallError('override_invalid', `${setting} is "${value}", which is not on PATH. Install ${command ?? tool}, or ${env ? 'unset TEAMAI_AI_TOOL' : 'remove it'} to use the next setting or the first installed tool.`);
    }

    if (instance !== undefined) {
      const accepted = await acceptToolCommand(instance, { ask: undefined });

      if (!accepted.ok) throw new CallError(accepted.code, accepted.message);
    }

    log.debug(`[tool-launch] using ${value} (${executable}), from ${source}`);

    return { name: value, tool, executable };
  };

  const resolve = async (first: MemberTool | undefined): Promise<Picked> => {
    if (first) return named(first);

    for (const tool of LAUNCH_ORDER) {
      const executable = resolveTool(executableOf(tool));

      if (executable !== null) {
        log.debug(`[tool-launch] using ${tool} (${executable}), from LAUNCH_ORDER`);

        return { name: tool, tool, executable };
      }
    }

    throw new CallError('no_tool', `No AI tool teamai launches is on PATH. Install one of: ${LAUNCH_ORDER.join(', ')}, or set TEAMAI_AI_TOOL to one you have.`);
  };

  // One pick per tool the member names, so a process that works in several projects never takes another project's
  // tool, and sees a setting changed since. Only a pick that succeeded is kept, so a long-lived process sees a tool
  // installed or a setting fixed since.
  const picked = new Map<string, Promise<Picked>>();

  const pick = async (scope: LocalConfig | undefined): Promise<Picked> => {
    const [first] = await memberTools(scope);
    const key = first?.tool ?? '';
    const cached = picked.get(key);

    if (cached) return cached;
    const picking = resolve(first).catch((cause: unknown) => { picked.delete(key); throw cause; });
    picked.set(key, picking);

    return picking;
  };

  /** The tool a call runs, picked in the scope it acts for, and its environment at the home teamai delivered that tool to. */
  const prepare = async ({ launchedBy, scope, cwd = process.cwd() }: CallOptions): Promise<Prepared> => {
    const here = scope ?? await resolveScope();
    const chosen = await pick(here);

    return { ...chosen, env: callEnv({ launchedBy, name: chosen.name, tool: chosen.tool, toolRoots: here?.toolRoots ?? await resolveMemberToolRoots(cwd) }) };
  };

  /** One run of the picked tool: its answer, and the session it ran in when the tool reported one. */
  const callOnce = async ({ name, tool, executable, env }: Prepared, prompt: string, { launchedBy, timeout = DEFAULT_TIMEOUT_MS, cwd = process.cwd(), signal, idleTimeout }: CallOptions, session?: string): Promise<CallResult & { session?: string }> => {
    log.debug(`[tool-launch] ${launchedBy} → ${name}, timeout=${Math.round(timeout / 1000)}s${session ? `, resuming ${session}` : ''}`);

    const end = await answerLaunch({
      tool: { name, family: launchAdapterIdOf(tool), call: launchAdapterOf(tool).call, executable },
      prompt, session, timeoutMs: timeout, idleTimeoutMs: idleTimeout, signal, cwd, env, host: { opencodeMajor: opencodeMajorVersion },
    });

    // A call teamai stopped at its limit names no tool: the tool gave no answer of its own.
    if (end.kind === 'stopped') throw new CallError('call_failed', end.message);

    if (end.kind === 'failed') throw new CallError(end.code, end.message, name);
    const result: CallResult & { session?: string } = { text: end.text, tool: name };

    if (end.tokens) result.tokens = end.tokens;

    if (end.session !== undefined) result.session = end.session;

    return result;
  };

  const callTool: ToolCaller['callTool'] = async (prompt, options) => {
    const { session: _session, ...result } = await callOnce(await prepare(options), prompt, options);

    return result;
  };

  const callForReply: ToolCaller['callForReply'] = async (prompt, schema, { retries = DEFAULT_REPLY_RETRIES, ...options }) => {
    const chosen = await prepare(options);
    // A tool whose call cannot continue its session is asked once: a fresh session would redo the work.
    const cap = 'resume' in launchAdapterOf(chosen.tool).call ? retries : 0;
    // Asking again spends the time the call was given, not a fresh timeout each time.
    const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT_MS);
    let answer = await callOnce(chosen, prompt, options);
    let reply = extractReply(answer.text, schema);
    let asked = 1;
    let tokens = answer.tokens;

    for (; reply === undefined && answer.session !== undefined && asked <= cap && Date.now() < deadline; asked++) {
      log.debug(`[tool-launch] ${chosen.name} replied with no value the call accepts; asking again (${asked} of ${cap})`);

      try {
        answer = await callOnce(chosen, retryPrompt(answer.text, cap - asked), { ...options, timeout: Math.max(1, deadline - Date.now()) }, answer.session);
      } catch (cause) {
        // The answer already given stays the result: the caller reports it held no value.
        if (!(cause instanceof CallError)) throw cause;
        log.debug(`[tool-launch] asking ${chosen.name} again failed: ${cause.message}`);
        asked++;
        break;
      }

      reply = extractReply(answer.text, schema);

      if (answer.tokens) tokens = addTokens(tokens, answer.tokens);
    }

    const { session: _session, ...last } = answer;
    const result = { ...last, reply, asked };

    if (tokens) result.tokens = tokens;

    return result;
  };

  return { callTool, callForReply, toolFor: async (scope) => (await pick(scope ?? await resolveScope())).name };
}
