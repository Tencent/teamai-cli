/**
 * Runs a lease of a step confined to a directory, as a driver that runs it here does: on the first of its tools that
 * resolves its model, with that directory as the tool's only readable root, no team env, and no session saved.
 */
import fs from 'node:fs/promises';
import { isConfinedTool, runConfined, type ConfinedRun } from '../tool-launch/confined.js';
import type { ConfinedTool } from '../tool-launch/tools.js';
import type { TokenUsage } from '../tool-launch/stdout.js';
import { isAgentToolId } from '../tools.js';
import { JsonValueSchema, type JsonValue, type LocalConfig } from '../types.js';
import { writeJsonAtomic } from '../utils/fs.js';
import type { ReportInput } from './engine.js';
import type { ConfinedLease, LeaseWire } from './lease-wire.js';
import { MAX_TIMER_DELAY } from './shell-command.js';
import { chooseStepModel, type StepModel } from './step-model.js';
import { attemptDir, attemptResultPath, type RunId } from './store.js';
import type { WorkflowFailure } from './types.js';

/** What a driver reports of a confined run, besides the attempt and itself. */
export type ConfinedStepReport = Pick<ReportInput, 'outcome' | 'outputs' | 'tool' | 'model' | 'tokens' | 'cost' | 'durationMs' | 'confined' | 'message' | 'failure'>;

/**
 * How a confined lease ended here: it ran and has a report, or no tool of the lease resolves the step's model on this
 * machine, so the driver hands it back with that reason.
 */
export type ConfinedStepEnd = { kind: 'ran'; report: ConfinedStepReport } | { kind: 'unresolved'; reason: string };

export interface ConfinedStepInput {
  config: LocalConfig;
  run: RunId;
  lease: LeaseWire & { attempt: ReportInput['attempt']; confined: ConfinedLease };
  signal?: AbortSignal;
  /** Where the tools' executables are looked up: PATH unless given. */
  resolveTool?: (executable: string) => string | null;
}

/** The first tool of the lease that teamai runs confined and that resolves the step's model, with that model. */
async function firstResolving({ config, lease }: Pick<ConfinedStepInput, 'config' | 'lease'>): Promise<{ tool: ConfinedTool; model?: StepModel } | { reasons: string[] }> {
  const reasons: string[] = [];

  const asks = lease.model !== undefined || lease.defaultModel !== undefined;

  for (const tool of lease.confined.tools) {
    if (!isConfinedTool(tool)) {
      reasons.push(`${tool} is not a tool teamai runs confined.`);
      continue;
    }

    if (!asks) return { tool };

    if (!isAgentToolId(tool)) {
      reasons.push(`${tool} takes no model teamai resolves.`);
      continue;
    }

    const chosen = await chooseStepModel({ step: lease.step, tool, model: lease.model, defaultModel: lease.defaultModel, config });

    if (chosen.ok) return chosen.model ? { tool, model: chosen.model } : { tool };
    reasons.push(chosen.failure.message);
  }

  return { reasons };
}

/** The reply schema the lease names, read again here, or why it can no longer be read. */
async function replySchema(step: string, file: string): Promise<{ ok: true; schema: JsonValue } | { ok: false; failure: WorkflowFailure }> {
  try {
    const parsed = JsonValueSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));

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
function timeoutOf(lease: LeaseWire): number {
  const left = lease.expiresAt === undefined ? MAX_TIMER_DELAY : Date.parse(lease.expiresAt) - Date.now();

  return Math.max(1, Math.min(MAX_TIMER_DELAY, left, lease.limits?.timeoutMs ?? MAX_TIMER_DELAY));
}

/**
 * Runs `lease` confined to its directory. Its reply is the step's outputs, which the engine checks against the step's
 * `output`. A failed run keeps the tool's output in the attempt's result file, which the message names.
 */
export async function runConfinedStep(input: ConfinedStepInput): Promise<ConfinedStepEnd> {
  const { config, run, lease, signal, resolveTool } = input;
  const found = await firstResolving(input);

  if ('reasons' in found) {
    return { kind: 'unresolved', reason: `Step "${lease.step}" runs confined on ${lease.confined.tools.join(', ')}, and none of them resolves its model here. ${found.reasons.join(' ')}` };
  }

  const schema = lease.confined.schema === undefined ? undefined : await replySchema(lease.step, lease.confined.schema);

  if (schema && !schema.ok) return { kind: 'ran', report: { outcome: 'failed', tool: found.tool, message: schema.failure.message, failure: schema.failure } };
  const startedAt = Date.now();

  const result = await runConfined({
    tool: found.tool, model: found.model, dir: lease.confined.dir, prompt: lease.prompt ?? '', schema: schema?.schema, level: lease.confined.level,
    timeoutMs: timeoutOf(lease), group: attemptDir(config, run, lease.attempt), signal,
  }, resolveTool ? { resolveTool } : {});

  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    const file = attemptResultPath(config, run, lease.attempt);
    const saved = result.raw === undefined ? '' : ` The tool's output is in ${file}.`;

    if (result.raw !== undefined) await writeJsonAtomic(file, { raw: result.raw });
    const failure = { code: result.code, message: `${result.message}${saved}` };

    return { kind: 'ran', report: { outcome: 'failed', tool: found.tool, durationMs, message: failure.message, failure, ...spentOf(result.usage) } };
  }

  const ran = result.run;
  const report: ConfinedStepReport = { outcome: 'success', tool: ran.tool, outputs: result.reply, durationMs, confined: ran, ...spentOf(ran.usage) };
  const model = ran.model?.reported ?? ran.model?.requested;

  if (model !== undefined) report.model = model;

  return { kind: 'ran', report };
}
