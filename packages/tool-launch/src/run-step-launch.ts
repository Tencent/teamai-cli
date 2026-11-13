import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ASSUMED_OPENCODE_MAJOR, type StepLaunch } from '@teamai/tool-core/launch';
import { log } from '@teamai/shared/log';
import { budgeted, stoppedOnUsageLimit, tokenMeter, toolStdout, type TokenUsage, type ToolReport } from '@teamai/tool-core/stdout';
import type { Unmeasured } from '@teamai/tool-core/step-usage';
import { NotRegularFileError, readRegularFile } from '@teamai/shared/regular-file';
import { MAX_TIMER_MS } from '@teamai/shared/timer';

/** The families that run a workflow step: those whose launch adapter has a `step` profile. */
export type StepFamily = 'claude' | 'codebuddy' | 'codex' | 'opencode' | 'agy';

/** Why a step ended without the result it was asked for: a code and a message, as a workflow records it. */
export interface StepFailure {
  code: string;
  message: string;
}

/** The result file a launch writes for a tool that wrote none: what the tool's stdout gave. */
export interface StepResultBody {
  output?: unknown;
  failure?: StepFailure;
}

/** The limit that ended the tool's turn: the first one at which the launch stopped it, or the turn cap Claude ends itself at. */
export type StepStop = 'timeout' | 'budget' | 'max_turns';

/** The tool a step launches: the name its messages use, its family's step profile, and the executable that starts it. */
export interface StepTool {
  readonly name: string;
  readonly family: StepFamily;
  readonly step: StepLaunch;
  readonly executable: string;
}

/** A field of a deployed agent file, as its parser gives it: front matter and TOML also give dates, TOML bigints. */
export type AgentSetting = string | number | bigint | boolean | null | Date | readonly AgentSetting[] | { readonly [key: string]: AgentSetting };

/** What a step asks of its tool. */
export interface StepLaunchInput {
  prompt: string;
  cwd: string;
  resultPath: string;
  /** What the run masks: a result kept from the tool's stdout is masked with it before it is written. */
  secrets: Record<string, string>;
  /**
   * What the result instruction asks the output to be, in words. `undefined`: the prompt already carries the
   * instruction, as a runtime's prompt lease does, and the tool gets it as it is.
   */
  expected: string | undefined;
  /** The definition the step runs as. `settings` are the deployed OpenCode file's other fields, such as `mode` and `variant`. */
  agent?: { name: string; instructions: string; model?: string; settings?: { readonly [key: string]: AgentSetting } };
  /** The model and effort the launch passes. */
  model?: { name: string; effort?: string };
  /** A session id from the same tool, to resume. */
  resume?: string;
  /** The environment the tool runs with; the inherited one when unset. */
  env?: NodeJS.ProcessEnv;
  /** The most agent turns headless Claude may take. Other tools have no such flag. */
  maxTurns?: number;
  /** Launch the tool in its own mode for editing and running commands without asking (`permissions: unattended`). */
  unattended?: true;
  /** The variables that name the workflow launch to the tool's session-start hook. */
  launchEnv?: Record<string, string>;
}

/** The limits the launch stops the tool at. An absent one is no limit. */
export interface StepLimits {
  /** The most tokens the run may bill, counted as a budget counts them: once its stdout states more, it is stopped. */
  budget?: number;
  /** How long the tool may run from its start before it is stopped. */
  timeoutMs?: number;
  /**
   * How long the tool may print nothing before it is stopped. Only a launch known to stream its output takes it: headless
   * Claude, whose `stream-json` prints each message as it comes. A launch that prints only once it ends would always reach
   * the limit, so every other launch has none.
   */
  idleTimeoutMs?: number;
}

/** What the launch needs from the machine it runs for, which this package cannot know. */
export interface StepLaunchHost {
  /** The major version of the OpenCode at `executable`. */
  opencodeMajor(executable: string): Promise<number>;
  /** The variables that point agy at the member's model gateway, which a shell function sets on the member's own shell. */
  agyGatewayEnv(env: NodeJS.ProcessEnv): Record<string, string>;
  /** Writes the result the launch read from the tool's stdout to `resultPath`, masked with `secrets`, when the tool wrote none. */
  writeResult(resultPath: string, result: StepResultBody, secrets: Record<string, string>): Promise<void>;
}

/** What a launched tool process ended with: its exit code and complete stdout, or why it ended without one. */
export type ToolClosed = { exitCode: number; stdout: string; error?: NodeJS.ErrnoException } | { failure: StepFailure };

/** One launched tool process, as the launch watches it. */
export interface ToolProcess {
  closed: Promise<ToolClosed>;
  /** Whether the process started: it spawned, or its runtime accepted it. */
  started(): boolean;
  /**
   * Stops the process and everything it started; a signal from the person is forwarded to an interactive one. It may be
   * called at any time, before the process started, again, or after it ended, and it settles and never rejects: a stop
   * that failed ends `closed` with a failure, which the launch takes as a stop it could not confirm (`stopUnconfirmed`).
   * `toolLauncherConformance` checks it.
   */
  stop(signal?: NodeJS.Signals): Promise<void>;
}

/**
 * The port a launch starts its tool's process through: a spawn on this machine, or a step runtime's `exec`. `onStart`
 * is called once the process started, after any place and setup before it; `onStdout` gets each decoded chunk. An
 * adapter never calls `onStdout` before it returns, so the launch holds the process before a limit stops it. Every
 * adapter passes `toolLauncherConformance` (`@teamai/tool-launch/testing`): only `toolLauncher` makes one, and the
 * lint rule `teamai/launcher-conformance` keeps its calls in the adapters that suite runs on.
 */
export type ToolLauncher = ToolStart & { readonly [conformantLauncher]: true };

type ToolStart = (launch: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; interactive: boolean; onStart: () => void; onStdout: (text: string) => void }) => ToolProcess;

declare const conformantLauncher: unique symbol;

/** Makes `start` a `ToolLauncher`. Production code calls it only in an adapter `toolLauncherConformance` runs on. */
export function toolLauncher(start: ToolStart): ToolLauncher {
  // SAFETY: the brand is type-only, and this is the one place that adds it; the lint rule keeps its calls in adapters.
  return start as ToolLauncher;
}

/**
 * What a launch gave. `started` is whether the tool's process started, so a pass that launched nothing records no
 * observation of a launch.
 */
export type StepLaunchResult =
  | {
    started: true;
    exitCode: number;
    /** How the launch handed over the definition, when it ran one. */
    applied?: 'main' | 'prompt';
    output?: unknown;
    model?: string;
    session?: string;
    tokens?: TokenUsage;
    /** Without `tokens`, from a runtime that offers them: why it read none for the run. */
    unmeasured?: Unmeasured;
    /** What the tool said the run cost, as it said it. */
    cost?: ToolReport['cost'];
    /**
     * The limit that ended the run: the first one at which the launch stopped the tool, its timeout or its budget, or
     * the turn cap, at which headless Claude ends itself with `error_max_turns`.
     */
    stoppedBy?: StepStop;
    /** A stop was sent and its process group may still run, so what it held, such as a git lock, may still be held. */
    stopUnconfirmed?: true;
    /** The run was asked to resume a session, and its runtime started a new one instead. */
    startedFresh?: true;
    failure?: StepFailure;
  }
  | { started: false; exitCode: number; failure: StepFailure };

type ResultFile = ToolReport & { failure?: StepFailure };

/** Why a step whose signal stopped it before its tool started has no result: it was cancelled, not failed. */
function stoppedBeforeStart(name: string): StepFailure {
  return { code: 'cancelled', message: `The step was stopped before ${name} started.` };
}

/** The step's prompt, and the instruction to write the result file. */
function resultInstruction(input: Pick<StepLaunchInput, 'resultPath' | 'expected'>, prompt: string): string {
  if (input.expected === undefined) return prompt;

  return `${prompt}\n\nWrite the workflow result as JSON to ${input.resultPath}. `
    + `Use this shape: {"output":...}, where output is ${input.expected}. `
    + 'Leave failure out unless the step failed; then add "failure":{"code":"...","message":"..."}.';
}

/**
 * The whole prompt a step's tool gets: with `inPrompt`, the agent definition's instructions first, for a launch with no
 * flag to pass them; the step's prompt; and the instruction to write the result file.
 */
export function stepPrompt(input: Pick<StepLaunchInput, 'prompt' | 'resultPath' | 'expected' | 'agent'>, { inPrompt }: { inPrompt: boolean }): string {
  return resultInstruction(input, inPrompt && input.agent?.instructions ? `${input.agent.instructions}\n\n${input.prompt}` : input.prompt);
}

/** Whether the step's agent definition goes in the prompt, as the family's step profile says (`agentInPrompt`). */
function promptHandoff(tool: StepTool, input: StepLaunchInput, opencodeMajor: number): boolean {
  return tool.step.agentInPrompt?.({ opencodeMajor, isSubagent: input.agent?.settings?.['mode'] === 'subagent' }) ?? false;
}

/** The argv that launches the step, which the tool's family builds. */
function stepArgv(tool: StepTool, input: StepLaunchInput, { opencodeMajor, interactive, streamsUsage }: { opencodeMajor: number; interactive: boolean; streamsUsage: boolean }): string[] {
  const inPrompt = promptHandoff(tool, input, opencodeMajor);

  return tool.step.args({
    prompt: stepPrompt(input, { inPrompt }),
    resultDir: path.dirname(input.resultPath),
    resume: input.resume,
    maxTurns: input.maxTurns,
    model: input.model?.name,
    effort: input.model?.effort,
    agent: input.agent && { name: input.agent.name, model: input.agent.model, inPrompt },
    unattended: input.unattended,
    streamsUsage,
  }, { interactive, opencodeMajor });
}

/** The result file a tool writes: its output, when it wrote one, and a failure with a code and a message. A null failure is none. */
const ResultFileSchema = z.object({
  output: z.unknown().optional(),
  failure: z.object({ code: z.string(), message: z.string() }).nullish().transform((failure) => failure ?? undefined),
});

/** The result file a tool wrote, none when it wrote no valid one, or what it left there instead of a file, which is never read. */
type ResultRead = { kind: 'read'; result: ResultFile | null } | { kind: 'not_a_file'; error: NotRegularFileError };

async function readResultFile(resultPath: string): Promise<ResultRead> {
  try {
    const result = ResultFileSchema.safeParse(JSON.parse(await readRegularFile(resultPath, 'utf8')));

    return { kind: 'read', result: result.success ? result.data : null };
  } catch (error) {
    return error instanceof NotRegularFileError ? { kind: 'not_a_file', error } : { kind: 'read', result: null };
  }
}

/**
 * Removes the result file an earlier process of the attempt left, such as the tool of a killed driver that wrote one as
 * it was stopped, so it is never taken for this tool's result. Anything but a regular file stays, and the read refuses it.
 */
async function removeLeftResult(resultPath: string): Promise<void> {
  const left = await fs.lstat(resultPath).catch(() => undefined);

  if (left?.isFile()) await fs.rm(resultPath, { force: true });
}

/** A failure message a tool wrote, without the step's prompt or the agent's instructions it may quote. */
export function withoutPrompt(message: string, input: { prompt: string; agent?: { instructions: string } }): string {
  let kept = message;

  for (const secret of [input.prompt, input.agent?.instructions]) {
    if (secret) kept = kept.replaceAll(secret, '[prompt omitted]');
  }

  return kept;
}

/** Whether what the tool printed says it stopped on its usage limit: by the kind of its error, else, for one with no kind, by its text. */
function isUsageLimit(printed: ToolReport | null): printed is ToolReport & { error: string } {
  return printed?.error !== undefined && stoppedOnUsageLimit(printed, printed.error);
}

/** A spent usage limit, with the tool's own words, which name the reset when the tool gives it. */
function usageLimited(tool: string, error: string, input: StepLaunchInput): StepFailure {
  return { code: 'usage_limited', message: `${tool} hit its usage limit: ${withoutPrompt(error, input)}` };
}

function redactFailure(result: ResultFile, input: StepLaunchInput): void {
  if (result.failure) result.failure.message = withoutPrompt(result.failure.message, input);
}

async function persistFallback(host: StepLaunchHost, input: StepLaunchInput, result: ResultFile): Promise<void> {
  const artifact: StepResultBody = {};

  if ('output' in result) artifact.output = result.output;

  if (result.failure) artifact.failure = result.failure;
  await host.writeResult(input.resultPath, artifact, input.secrets);
}

function combineResults(fileResult: ResultFile | null, reported: ToolReport | null): ResultFile | null {
  if (!fileResult && !reported) return null;
  const result: ResultFile = {};

  if (fileResult && 'output' in fileResult) result.output = fileResult.output;
  else if (reported && 'output' in reported) result.output = reported.output;

  if (fileResult?.failure) result.failure = fileResult.failure;

  if (reported?.model) result.model = reported.model;

  if (reported?.session) result.session = reported.session;

  if (reported?.tokens) result.tokens = reported.tokens;

  if (reported?.cost) result.cost = reported.cost;

  return result;
}

/**
 * Runs one workflow step on `tool`, whatever starts its process: it builds the argv with the family's `step.args`, meters
 * the budget from stdout and stops the tool at its limits through `start`, reads the result file, and parses stdout for
 * the session, tokens and cost. It never starts a process itself. `canReattach` says `start` may attach to the tool an
 * earlier launch of the attempt began, whose result file is then this launch's. A `signal` that stops it before the tool
 * started, already aborted or while a runtime sets up, ends it `cancelled`.
 */
export async function runStepLaunch({ tool, input, start, canReattach = false, limits = {}, signal, interactive, host }: {
  tool: StepTool;
  input: StepLaunchInput;
  start: ToolLauncher;
  canReattach?: boolean;
  limits?: StepLimits;
  signal?: AbortSignal | undefined;
  interactive: boolean;
  host: StepLaunchHost;
}): Promise<StepLaunchResult> {
  const name = tool.name;

  if (input.unattended && tool.step.unattended === 'none') {
    return {
      started: false,
      exitCode: 1,
      failure: { code: 'tool_unavailable', message: `The step sets permissions: unattended, and ${name} has no unattended mode teamai knows. Run the step on a tool that has one, or remove permissions from the step.` },
    };
  }

  const opencode = tool.family === 'opencode';
  // Headless, the version also decides whether OpenCode runs on its own server rather than its background service.
  const opencodeMajor = opencode && (!interactive || input.agent || input.model?.effort) ? await host.opencodeMajor(tool.executable) : ASSUMED_OPENCODE_MAJOR;

  if (opencode && input.agent) {
    const { name: agent, model, settings = {} } = input.agent;
    const viaPrompt = promptHandoff(tool, input, opencodeMajor);

    // OpenCode 1 applies an agent's variant to a launch on the agent's own model that passes none.
    if (opencodeMajor < 2 && !viaPrompt && settings['variant'] !== undefined && input.model && input.model.name === model && input.model.effort === undefined) {
      return {
        started: false,
        exitCode: 1,
        failure: {
          code: 'model_unavailable',
          message: `Agent "${agent}" runs on its own model "${model}" with no effort, and ${name} 1 applies the agent's variant "${String(settings['variant'])}" `
            + `to that model. Remove model from the step to run at that variant, or set it to an alias with an effort for ${name}.`,
        },
      };
    }

    // The variant goes on argv with a model, the definition's or the step's.
    const dropped = Object.keys(settings).filter((key) => key !== 'mode' && (key !== 'variant' || !input.model));

    if (viaPrompt && dropped.length > 0) {
      log.warn(`Agent "${agent}" runs on ${name} 1 from the prompt, since opencode run does not start a subagent there, so it does not apply `
        + `${dropped.join(', ')} from the deployed agent file. The step is not blocked.`);
    } else if (opencodeMajor >= 2 && settings['variant'] !== undefined && !input.model) {
      log.warn(`Agent "${agent}" sets a variant with no model, and ${name} 2 takes a variant only with a model, so it does not apply variant `
        + 'from the deployed agent file. The step is not blocked.');
    }
  }

  const { budget, timeoutMs, idleTimeoutMs } = limits;
  const args = stepArgv(tool, input, { opencodeMajor, interactive, streamsUsage: budget !== undefined });
  const applied = input.agent ? { applied: promptHandoff(tool, input, opencodeMajor) ? 'prompt' as const : 'main' as const } : {};
  const meter = budget !== undefined ? tokenMeter(tool.family) : undefined;
  let metered: TokenUsage | undefined;
  // The first reason a stop was sent, so a limit crossed while the tool shuts down does not replace it.
  let stopCause: 'timeout' | 'budget' | 'idle' | 'aborted' | undefined;
  let partial = '';
  const env: NodeJS.ProcessEnv = { ...input.env ?? process.env };

  // A model switch hands agy its gateway through a shell function, and this launch runs no shell.
  if (tool.family === 'agy') Object.assign(env, host.agyGatewayEnv(input.env ?? process.env));

  if (input.launchEnv) Object.assign(env, input.launchEnv);
  env.TEAMAI_WORKFLOW_RESULT = input.resultPath;

  // The idle limit starts with the tool, and each chunk it prints restarts it, so a tool that streams lives and a
  // silent one is stopped.
  const idleMs = !interactive && tool.family === 'claude' && idleTimeoutMs !== undefined && idleTimeoutMs <= MAX_TIMER_MS ? idleTimeoutMs : undefined;
  let idleTimer: NodeJS.Timeout | undefined;

  const active = (): void => {
    if (idleMs === undefined) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stopAt('idle'), idleMs);
  };

  const onStdout = (text: string): void => {
    active();

    if (!meter || budget === undefined) return;
    // A long line arrives over many chunks: only the chunk that ends it is split.
    const end = text.lastIndexOf('\n');

    if (end === -1) {
      partial += text;

      return;
    }

    const lines = `${partial}${text.slice(0, end)}`.split('\n');
    partial = text.slice(end + 1);

    for (const line of lines) metered = meter(line);

    if (budgeted(metered) > budget) stopAt('budget');
  };

  // The timeout counts from the tool's start, as the idle limit does: a place and setup a runtime makes first take none of it.
  let timer: NodeJS.Timeout | undefined;

  const started = (): void => {
    if (timeoutMs !== undefined && timeoutMs <= MAX_TIMER_MS) timer ??= setTimeout(() => stopAt('timeout'), timeoutMs);
    active();
  };

  // A step stopped before its launch opens no place and starts nothing.
  if (signal?.aborted) return { started: false, exitCode: 1, failure: stoppedBeforeStart(name) };

  if (!canReattach) await removeLeftResult(input.resultPath);
  const processRun = start({ executable: tool.executable, args, cwd: input.cwd, env, interactive, onStart: started, onStdout });

  let isStopUnconfirmed = false;

  // Every stop goes through here. The port's `stop` never rejects by its contract, which nothing enforces at run time:
  // one that rejects anyway is reported rather than left to end teamai as an unhandled rejection.
  const stopTool = async (forwarded?: NodeJS.Signals): Promise<void> => {
    try {
      await processRun.stop(forwarded);
    } catch (error) {
      isStopUnconfirmed = true;
      log.warn(`teamai could not confirm that ${name} stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  function stopAt(limit: 'timeout' | 'budget' | 'idle'): void {
    stopCause ??= limit;
    void stopTool();
  }

  const abort = (): void => {
    const reason: unknown = signal?.reason;
    const forwarded = reason === 'SIGINT' || reason === 'SIGQUIT' || reason === 'SIGTERM' || reason === 'SIGHUP' ? reason : undefined;
    stopCause ??= 'aborted';
    void stopTool(interactive ? forwarded : undefined);
  };

  signal?.addEventListener('abort', abort, { once: true });

  if (signal?.aborted) abort();
  let completed: ToolClosed;

  // A port whose end rejects leaves no limit armed to stop, later, whatever then runs where the tool ran.
  try {
    completed = await processRun.closed;
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', abort);
  }

  if (stopCause !== undefined) await stopTool();

  // A port says a stop it could not make by ending the run with a failure (a sandbox's `stopFailed`, a runtime's lost
  // exec), never by rejecting: after a stop, any failure may leave the tool running.
  if (stopCause !== undefined && 'failure' in completed) isStopUnconfirmed = true;
  const settled = isStopUnconfirmed ? { ...applied, stopUnconfirmed: true as const } : applied;

  if (stopCause === 'idle' && idleMs !== undefined) {
    return {
      started: processRun.started(), exitCode: 'exitCode' in completed ? completed.exitCode : 1, ...settled,
      failure: { code: 'tool_failed', message: `${name} printed nothing for ${idleMs / 1000}s, longer than its idle limit (workflows.idle_timeout). Raise the limit if this tool works silently for longer.` },
    };
  }

  const stopped = stopCause === 'aborted' || stopCause === 'idle' ? undefined : stopCause;

  if ('failure' in completed) return { started: processRun.started(), exitCode: 1, ...settled, failure: completed.failure };

  if (!processRun.started() || completed.error?.code === 'ENOENT') {
    return {
      started: false,
      exitCode: completed.exitCode,
      failure: completed.error?.code === 'ENOENT'
        // The command it ran, which an instance of the tool may share: not the tool's name.
        ? { code: 'tool_unavailable', message: `The ${path.basename(tool.executable)} executable is not available on PATH` }
        // Stopped while its runtime opened the place or set it up: a cancel, not a launch that failed.
        : stopCause === 'aborted' ? stoppedBeforeStart(name) : { code: 'tool_failed', message: `${name} could not be started` },
    };
  }

  if (completed.error) {
    const failed: StepLaunchResult = { started: true, exitCode: completed.exitCode, ...settled };

    if (stopped) failed.stoppedBy = stopped;
    failed.failure = { code: 'tool_failed', message: `${name} could not be started` };

    return failed;
  }

  const read = await readResultFile(input.resultPath);
  const fileResult = read.kind === 'read' ? read.result : null;
  const printed = toolStdout(tool.family, completed.stdout);
  // Only a tool stopped at a limit may end before its result: one that ended there on its own wrote none.
  const stated = printed?.unfinished && !stopped ? null : printed;
  // A tool stopped mid-run, such as Claude before its final result, states no total: what the meter counted stands in.
  const reported = metered && !stated?.tokens ? { ...stated, tokens: metered } : stated;
  const result = combineResults(fileResult, reported) ?? (interactive ? {} : null);
  const stoppedBy: StepStop | undefined = stopped ?? (stated?.reachedMaxTurns ? 'max_turns' : undefined);
  const ended = stoppedBy ? { stoppedBy } : {};

  if (read.kind === 'not_a_file') {
    return { started: true, exitCode: completed.exitCode, ...settled, ...ended, failure: { code: 'tool_failed', message: `${name} left ${read.error.kind} at its result path, ${input.resultPath}, not a regular file, so teamai did not read it` } };
  }

  // OpenCode 1.x exits 0 on a provider's error, a spent limit among them, and writes no result.
  if (!fileResult && isUsageLimit(printed)) return { started: true, exitCode: completed.exitCode, ...settled, ...ended, failure: usageLimited(name, printed.error, input) };

  if (!fileResult && completed.exitCode === 0 && printed?.error !== undefined && opencode) {
    return { started: true, exitCode: 0, ...settled, ...ended, failure: { code: 'tool_failed', message: `${name} ended on an error: ${withoutPrompt(printed.error, input)}` } };
  }

  if (!result) {
    return {
      started: true,
      exitCode: completed.exitCode,
      ...settled,
      ...ended,
      failure: { code: 'tool_failed', message: `${name} did not write a valid workflow result` },
    };
  }

  redactFailure(result, input);

  // The tool's own reason, such as a provider's 401, says what the status cannot. It may echo a credential, so it is
  // never written here: only the result the driver reports carries it, which the driver masks before keeping it.
  let told: StepFailure | undefined;

  if (completed.exitCode !== 0 && !result.failure) {
    result.failure = { code: 'tool_failed', message: `${name} exited with status ${completed.exitCode}` };

    if (isUsageLimit(printed)) {
      result.failure = { code: 'usage_limited', message: `${name} hit its usage limit` };
      told = usageLimited(name, printed.error, input);
    } else if (printed?.error !== undefined) {
      told = { ...result.failure, message: `${result.failure.message}: ${withoutPrompt(printed.error, input)}` };
    }
  }

  if (!fileResult) await persistFallback(host, input, result);

  return { started: true, exitCode: completed.exitCode, ...settled, ...ended, ...result, ...(told && { failure: told }) };
}
