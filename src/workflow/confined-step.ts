/**
 * Runs a lease of a step confined to a directory, as a driver that runs it here does, or on a step runtime that answers
 * confined prompts: on the first of its tools that resolves its model, with that directory as the tool's only readable
 * root, no team env, and no session saved.
 */
import { CONFINED_LEVELS, type ConfinedLevel } from '@teamai/tool-core/launch';
import type { ConfinedOffer } from '@teamai/runtime-protocol';
import { confinedEnvNames, isConfinedTool, runConfined, type ConfinedResult, type ConfinedRun } from './confined-launch.js';
import type { ConfinedTool } from '../launch-registry.js';
import type { TokenUsage } from '@teamai/tool-core/stdout';
import { agentFormatOf } from '../tool-registry.js';
import { type LocalConfig } from '../types.js';
import { JsonValueSchema, type JsonValue } from '@teamai/shared/json';
import { observedModel } from '../agent-observation.js';
import { AttemptResult } from './attempt-result.js';
import type { ReportInput } from './engine.js';
import type { ConfinedLease, LeaseWire } from './lease-wire.js';
import { MAX_TIMER_MS } from '@teamai/shared/timer';
import { chooseStepModel, type StepModel } from './step-model.js';
import { attemptDir, attemptResultPath, type RunId } from './store.js';
import type { WorkflowFailure } from './types.js';
import type { ConfinedRunReport } from './step-state.js';
import type { AttemptRun } from './runtimes/attempt.js';
import { type PromptEnd } from '@teamai/runtime-protocol/step-runtime';
import { withRetry } from './runtimes/retry-command.js';
import { readRegularFile } from '@teamai/shared/regular-file';

/** What a driver reports of a confined run, besides the attempt and itself. */
export type ConfinedStepReport = Pick<ReportInput, 'outcome' | 'outputs' | 'tool' | 'model' | 'tokens' | 'cost' | 'durationMs' | 'confined' | 'message' | 'failure'>;

/**
 * How a confined lease ended here: it ran and has a report, or no tool of the lease resolves the step's model on this
 * machine, so the driver hands it back with that reason.
 */
export type ConfinedStepEnd = { kind: 'ran'; report: ConfinedStepReport } | { kind: 'unresolved'; reason: string };

/** What of a confined lease the run reads: its step, prompt, model, deadline and limits, and where it is confined. */
export type ConfinedStepLease = Pick<LeaseWire, 'attempt' | 'step' | 'prompt' | 'model' | 'defaultModel' | 'expiresAt' | 'limits'> & { confined: ConfinedLease };

export interface ConfinedStepInput {
  config: LocalConfig;
  run: RunId;
  lease: ConfinedStepLease;
  signal?: AbortSignal;
  /** What the run masks: the output kept of a tool that failed is masked with it before it is written. */
  secrets: Record<string, string>;
  /** Where the tools' executables are looked up: PATH unless given. */
  resolveTool?: (executable: string) => string | null;
}

/** Who runs a confined tool: which tools it runs, and why it does not run another. */
interface ConfinedRunner<TTool extends string> {
  runs(tool: string): tool is TTool;
  whyNot(tool: string): string;
}

const HOST: ConfinedRunner<ConfinedTool> = { runs: isConfinedTool, whyNot: (tool) => `${tool} is not a tool teamai runs confined.` };

/** The first tool of the lease that `runner` runs and that resolves the step's model, with that model and the alias it came from. */
async function firstResolving<TTool extends string>({ config, lease }: Pick<ConfinedStepInput, 'config' | 'lease'>, runner: ConfinedRunner<TTool>): Promise<{ tool: TTool; model?: StepModel; alias?: string } | { reasons: string[] }> {
  const reasons: string[] = [];

  const asks = lease.model !== undefined || lease.defaultModel !== undefined;

  for (const tool of lease.confined.tools) {
    if (!runner.runs(tool)) {
      reasons.push(runner.whyNot(tool));
      continue;
    }

    if (!asks) return { tool };

    if (agentFormatOf(tool) === undefined) {
      reasons.push(`${tool} takes no model teamai resolves.`);
      continue;
    }

    const chosen = await chooseStepModel({ step: lease.step, tool, model: lease.model, defaultModel: lease.defaultModel, config });

    if (chosen.ok && chosen.model) return 'alias' in chosen && chosen.alias ? { tool, model: chosen.model, alias: chosen.alias } : { tool, model: chosen.model };

    if (chosen.ok) return { tool };
    reasons.push(chosen.failure.message);
  }

  return { reasons };
}

/** The reply schema the lease names, read again here, or why it can no longer be read. */
async function replySchema(step: string, file: string): Promise<{ ok: true; schema: JsonValue } | { ok: false; failure: WorkflowFailure }> {
  try {
    const parsed = JsonValueSchema.safeParse(JSON.parse(await readRegularFile(file, 'utf8')));

    if (parsed.success) return { ok: true, schema: parsed.data };
  } catch {
    // Reported below as the file the step cannot read.
  }

  return { ok: false, failure: { code: 'confined_invalid', message: `Step "${step}" replies by the JSON Schema in ${file}, which is no longer a JSON file. Write it again in the step that writes the directory, then retry the step.` } };
}

/** The tokens a confined run spent, as a step's report counts them. */
function tokensOf(usage: ConfinedRun['usage']): TokenUsage | undefined {
  if (usage?.inputTokens === undefined && usage?.outputTokens === undefined) return undefined;
  const tokens: TokenUsage = {};

  if (usage.inputTokens !== undefined) tokens.input = usage.inputTokens;

  if (usage.outputTokens !== undefined) tokens.output = usage.outputTokens;

  return tokens;
}

/** What a run spent, as a report carries it. */
function spentOf(usage: ConfinedRun['usage']): Pick<ConfinedStepReport, 'tokens' | 'cost'> {
  const tokens = tokensOf(usage);
  const spent: Pick<ConfinedStepReport, 'tokens' | 'cost'> = {};

  if (tokens) spent.tokens = tokens;

  if (usage?.cost) spent.cost = usage.cost;

  return spent;
}

/** How long the run may take: what is left of the lease's deadline, and of its turn's timeout, the sooner of them. */
function timeoutOf(lease: ConfinedStepLease): number {
  const left = lease.expiresAt === undefined ? MAX_TIMER_MS : Date.parse(lease.expiresAt) - Date.now();

  return Math.max(1, Math.min(MAX_TIMER_MS, left, lease.limits?.timeoutMs ?? MAX_TIMER_MS));
}

/**
 * Runs `lease` confined to its directory. Its reply is the step's outputs, which the engine checks against the step's
 * `output`. A failed run keeps the tool's output in the attempt's result file, which the message names.
 */
export async function runConfinedStep(input: ConfinedStepInput): Promise<ConfinedStepEnd> {
  const { config, run, lease, signal, resolveTool, secrets } = input;
  const found = await firstResolving(input, HOST);

  if ('reasons' in found) {
    return { kind: 'unresolved', reason: `Step "${lease.step}" runs confined on ${lease.confined.tools.join(', ')}, and none of them resolves its model here. ${found.reasons.join(' ')}` };
  }

  const schema = lease.confined.schema === undefined ? undefined : await replySchema(lease.step, lease.confined.schema);

  if (schema && !schema.ok) return { kind: 'ran', report: { outcome: 'failed', tool: found.tool, message: schema.failure.message, failure: schema.failure } };
  const startedAt = Date.now();

  const result = await runConfined({
    tool: found.tool, model: found.model, dir: lease.confined.dir, prompt: lease.prompt ?? '', schema: schema?.schema, level: lease.confined.level,
    timeoutMs: timeoutOf(lease), group: attemptDir(config, run, lease.attempt), attempt: { run, attempt: lease.attempt }, signal,
  }, resolveTool ? { resolveTool } : {});

  const durationMs = Date.now() - startedAt;

  if (!result.ok) return { kind: 'ran', report: await failedReport({ file: attemptResultPath(config, run, lease.attempt), tool: found.tool, durationMs, result, secrets, retry: { run, step: lease.step } }) };

  // The tool reports the model it ran, never the alias the step asked for, which a label of the run names.
  const confined = found.alias ? { ...result.run, model: { ...result.run.model, alias: found.alias } } : result.run;

  return { kind: 'ran', report: ranReport({ run: confined, reply: result.reply, durationMs }) };
}

/**
 * The report of a run that failed. The tool's output, when it gave any, is kept in `file`, which the message names, with
 * `secrets` masked: a tool's error can repeat a credential it was given. A failure a retry fixes ends with the command
 * that runs the step again.
 */
async function failedReport(input: { file: string; tool: ConfinedTool; durationMs: number; result: Extract<ConfinedResult, { ok: false }>; secrets: Record<string, string>; retry: { run: string; step: string } }): Promise<ConfinedStepReport> {
  const { file, tool, durationMs, result, secrets, retry } = input;

  if (result.raw !== undefined) await AttemptResult.write(file, { raw: result.raw }, secrets);
  const saved = result.raw === undefined ? '' : ` The tool's output is in ${file}.`;
  const failure = { code: result.code, message: withRetry({ code: result.code, message: `${result.message}${saved}` }, retry) };

  return { outcome: 'failed', tool, durationMs, message: failure.message, failure, ...spentOf(result.usage) };
}

/** The report of a run that replied: the reply as outputs, with what the run measured. */
function ranReport({ run, reply, durationMs }: { run: ConfinedRun; reply: JsonValue; durationMs: number }): ConfinedStepReport {
  const report: ConfinedStepReport = { outcome: 'success', tool: run.tool, outputs: reply, durationMs, confined: run, ...spentOf(run.usage) };
  const model = run.model?.reported ?? run.model?.requested;

  if (model !== undefined) report.model = model;

  return report;
}

/** Whether `level` reaches `floor`: `verified` reaches both levels, `best-effort` only itself. */
function reaches(level: ConfinedLevel, floor: ConfinedLevel): boolean {
  return CONFINED_LEVELS.indexOf(level) >= CONFINED_LEVELS.indexOf(floor);
}

export interface RuntimeConfinedInput extends Omit<ConfinedStepInput, 'resolveTool'> {
  /** The step runtime the attempt runs on, by its definition's name, and the attempt's run there. */
  runtime: string;
  attemptRun: AttemptRun;
  /** The runtime's `can.confined`, which the lease's tools come from. */
  offers: readonly ConfinedOffer[];
  /** The credentials the definition gives the runtime's tools, of which the prompt's tool gets those it reads. */
  credentials: Record<string, string>;
}

/**
 * Runs `lease` on a step runtime that answers confined prompts: in a place opened with no view of the host, as one
 * `prompt` confined to the lease's directory, with no team env, and only the credentials its tool's confined profile
 * reads: a credential no profile names goes to no judge. The reply is the step's outputs, and the level and
 * access the runtime says it kept are the run's; a runtime that kept less than the lease's level fails the step.
 */
export async function runConfinedStepOnRuntime(input: RuntimeConfinedInput): Promise<ConfinedStepEnd> {
  const { config, run, lease, signal, runtime, attemptRun, offers, credentials } = input;
  const offered = (tool: string): ConfinedOffer | undefined => offers.find((offer) => offer.tools.includes(tool) && reaches(offer.level, lease.confined.level));
  const found = await firstResolving(input, { runs: (tool): tool is string => offered(tool) !== undefined, whyNot: (tool) => `step runtime "${runtime}" offers no confined ${tool} at ${lease.confined.level}.` });

  if ('reasons' in found) {
    return { kind: 'unresolved', reason: `Step "${lease.step}" runs confined on ${lease.confined.tools.join(', ')}, and none of them resolves its model on step runtime "${runtime}". ${found.reasons.join(' ')}` };
  }

  const { tool, model, alias } = found;
  const schema = lease.confined.schema === undefined ? undefined : await replySchema(lease.step, lease.confined.schema);

  if (schema && !schema.ok) return { kind: 'ran', report: { outcome: 'failed', tool, message: schema.failure.message, failure: schema.failure } };
  const access = offered(tool)?.access ?? 'full';
  const reads = confinedEnvNames(tool);
  const given = Object.fromEntries(Object.entries(credentials).filter(([name]) => reads.includes(name)));
  const startedAt = Date.now();
  const opened = await attemptRun.open(undefined, { tool, credentials: given });

  if (!opened.ok) return { kind: 'ran', report: { outcome: 'failed', tool, message: opened.failure.message, failure: opened.failure } };
  // A stop while the place opened, or before the prompt is sent, ends it unsent.
  let stopped = false;

  const stop = (): void => {
    stopped = true;
    void attemptRun.cancel();
  };

  const timer = setTimeout(stop, timeoutOf(lease));
  signal?.addEventListener('abort', stop, { once: true });

  if (signal?.aborted) stop();

  // Stopped while the place opened: no operation runs there yet, so the prompt is not sent at all.
  const end: PromptEnd = stopped ? { kind: 'cancelled' } : await attemptRun.prompt({
    lease: {
      step: lease.step, tool, prompt: lease.prompt ?? '', result: attemptResultPath(config, run, lease.attempt), permissions: 'approval-required', interactive: false,
      ...(model && { model: model.effort ? { name: model.name, effort: model.effort } : { name: model.name } }),
    },
    env: {}, unset: [], credentials: given, cwd: lease.confined.dir,
    confined: { dir: lease.confined.dir, level: lease.confined.level, access, ...(schema && { schema: schema.schema }) },
  }, {
    onAccepted: () => {
      if (stopped) void attemptRun.cancel();
    },
  });

  clearTimeout(timer);
  signal?.removeEventListener('abort', stop);

  return { kind: 'ran', report: runtimeConfinedReport({ runtime, tool, model, alias, level: lease.confined.level, end, durationMs: Date.now() - startedAt, retry: { run, step: lease.step } }) };
}

/** The report of a confined prompt a step runtime ended. */
function runtimeConfinedReport(input: { runtime: string; tool: string; model: StepModel | undefined; alias?: string; level: ConfinedLevel; end: PromptEnd; durationMs: number; retry: { run: string; step: string } }): ConfinedStepReport {
  const { runtime, tool, model, alias, level, end, durationMs, retry } = input;
  const failed = (failure: WorkflowFailure): ConfinedStepReport => ({ outcome: 'failed', tool, durationMs, message: failure.message, failure });
  // The tool's or the runtime's failure: a usage limit stays one, naming the retry; any other fails the confined prompt.
  const failedWith = ({ code, message }: { code: string; message: string }): ConfinedStepReport => failed({ code: code === 'usage_limited' ? 'usage_limited' : 'confined_failed', message: withRetry({ code, message }, retry) });

  switch (end.kind) {
    case 'finished': {
      if (end.session.tool !== tool) return failed({ code: 'runtime_failed', message: `Step runtime "${runtime}" finished the confined ${tool} prompt with a session of ${end.session.tool}.` });
      const kept = end.confined;

      if (kept === undefined) return failed({ code: 'runtime_failed', message: `Step runtime "${runtime}" finished a confined prompt without saying what it kept.` });

      if (!reaches(kept.level, level)) {
        return failed({ code: 'confined_failed', message: `Step runtime "${runtime}" kept the confined prompt at ${kept.level}, below the ${level} its directory asks for.` });
      }

      if (end.result.failure) return failedWith({ code: end.result.failure.code, message: `${tool} could not answer on step runtime "${runtime}" (${end.result.failure.code}): ${end.result.failure.message}` });
      const outputs = JsonValueSchema.safeParse(end.result.output);

      if (!outputs.success) return failed({ code: 'confined_reply_invalid', message: `${tool} on step runtime "${runtime}" replied with no JSON value.` });
      const usage = (end.usage || end.cost) && { ...(end.usage && { inputTokens: end.usage.input, outputTokens: end.usage.output }), ...(end.cost && { cost: end.cost }) };
      const observed = observedModel({ requested: model?.name, reported: end.model, alias });
      const ran: ConfinedRunReport = { tool, isolation: kept.level, access: kept.access, ...(usage && { usage }), ...(observed && { model: observed }) };

      return { outcome: 'success', tool, outputs: outputs.data, durationMs, confined: ran, ...spentOf(usage), ...(model && { model: model.name }) };
    }

    case 'cancelled':
      return failed({ code: 'confined_failed', message: `The confined ${tool} prompt on step runtime "${runtime}" was stopped before it replied.` });
    case 'failed':
      return failedWith({ code: end.failure.code, message: `Step runtime "${runtime}" could not run the confined ${tool} prompt (${end.failure.code}): ${end.failure.message}` });
    case 'lost':
      return failed({ code: 'runtime_lost', message: `Step runtime "${runtime}" stopped answering while it ran the confined ${tool} prompt, which may still run there: ${end.failure.message}` });
    default: {
      const unhandled: never = end;

      return unhandled;
    }
  }
}
