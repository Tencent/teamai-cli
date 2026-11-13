/**
 * The fleet: a run offers single attempts on `teamai-reports`, and other installs of the same business repository take
 * them with `teamai workflow resume --next --pool <name>`. Each attempt has one record, at
 * `workflows/attempts/<run>/<attempt>.json`, which a write replaces only while origin still holds the write it read, as
 * run handoff does for snapshots. A member pushes the attempt's work only to its own ref, `teamai/attempts/<run>/<attempt>`;
 * only the run's owner moves the workflow's branch.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { OpIdSchema, RuntimeDisplaySchema, type OpId, type RuntimeDisplay } from '@teamai/runtime-protocol';
import { sanitizeGitUrl } from '@teamai/shared/redact';
import { getReportsDir, type LocalConfig } from '../../types.js';
import { gitRoot } from '../../utils/branch-worktree.js';
import { log } from '@teamai/shared/log';
import { writeJsonAtomic } from '../../utils/fs.js';
import { getCurrentVersion } from '../../package-info.js';
import { fetchReportsOriginFile, updateReports, type ReportsChange } from '../../utils/reports-branch.js';
import { JsonValueSchema, parseJson, type JsonValue, isJsonObject } from '@teamai/shared/json';
import { TurnLimitsSchema } from '../requirements.js';
import { TokenUsageSchema } from '../step-state.js';
import type { TokenUsage } from '@teamai/tool-core/stdout';
import { expressionPaths, isIndex, type PathField } from '../expression.js';
import { firstUnfit, RunDefinitionSchema, type HandoffOwner } from '../snapshot.js';
import { attemptDir, AttemptIdSchema, RunIdSchema, type AttemptId, type RunId } from '../store.js';
import { parseTemplate, renderLeaseText, renderStrings, renderText, templatedTexts, templateExpressions, type TemplateContext } from '../template.js';
import { isWorkflowFile, stepWorkflow, type InlineWorkflow, type WorkflowDefinition, type WorkflowFailure, type WorkflowStep } from '../types.js';
import type { ExecAnswer, ExecQuestion } from '@teamai/runtime-protocol/step-runtime';
import { inlineReads, wholeInputs } from '../whole-workflow.js';
import { readRegularFile, writeRegularFile } from '@teamai/shared/regular-file';

/** The pool a fleet offers to when its definition names none, which `resume --next --pool` takes when given no name. */
export const DEFAULT_FLEET_POOL = 'default';

/** Where the records of every offered attempt live on `teamai-reports`. */
const ATTEMPTS_DIR = 'workflows/attempts';

const OwnerSchema = z.object({ id: z.string().min(1), user: z.string() });

/** A full commit id, never a name git would resolve on the reading machine, such as a branch or `stash@{0}`, or read as an option. */
const CommitSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'must be a full commit id');

/**
 * What a member runs, as the owner rendered it: never an argv, a credential value or a path of the owner's machine.
 * `env` is the step's rendered `env`. A command step carries its command; a prompt step its rendered prompt, and the
 * limits its turn ends at, which the member keeps on the tool it picks.
 */
const CommandLeaseSchema = z.object({
  kind: z.literal('command'),
  step: z.string().min(1),
  command: z.string().min(1),
  env: z.record(z.string(), z.string()),
});

const PromptLeaseSchema = z.object({
  kind: z.literal('prompt'),
  step: z.string().min(1),
  prompt: z.string(),
  env: z.record(z.string(), z.string()),
  limits: TurnLimitsSchema.strict().optional(),
});

/**
 * A `workflow:` step leased whole: the inputs its workflow starts with, as the owner rendered them from the step's `with`,
 * which the member renders again from its own copy of the step and the offer's values. The sub-graph is the member's
 * own: the record names none of its steps. `budget` is what the budgets around the step had left when it was offered,
 * past which the member stops its steps, as the owner stops the steps it runs.
 */
const WorkflowLeaseSchema = z.object({
  kind: z.literal('workflow'),
  step: z.string().min(1),
  inputs: JsonValueSchema,
  env: z.record(z.string(), z.string()),
  budget: z.object({ tokens: z.number().int().min(0) }).optional(),
});

/** What a member runs, told apart by `kind`: a command step, a prompt step, or a `workflow:` step whole. */
const FleetLeaseSchema = z.discriminatedUnion('kind', [CommandLeaseSchema, PromptLeaseSchema, WorkflowLeaseSchema]);

export type FleetLease = z.infer<typeof FleetLeaseSchema>;

/** The text of `lease` a member runs, with the field that holds it: its command, or its prompt; none for a whole workflow. */
function leaseText(lease: FleetLease): { field: 'command' | 'prompt'; text: string } | undefined {
  switch (lease.kind) {
    case 'command': return { field: 'command', text: lease.command };
    case 'prompt': return { field: 'prompt', text: lease.prompt };
    case 'workflow': return undefined;
    default: {
      const unhandled: never = lease;

      return unhandled;
    }
  }
}

/**
 * What the step's env reads, which a member renders the env from with its own copy of the step: the inputs it reads, by
 * name, the outputs of the steps it reads, by step id, and the item. Values only: the command and the env's templates
 * come from the team's workflow, never from the record.
 */
const LeaseValuesSchema = z.object({
  inputs: JsonValueSchema.optional(),
  outputs: z.record(z.string(), JsonValueSchema).optional(),
  item: JsonValueSchema.optional(),
});

export type LeaseValues = z.infer<typeof LeaseValuesSchema>;

/**
 * How a member's run of the lease ended: its command's exit code, the JSON its stdout held, and the start of its stderr,
 * as the local loop reports a command (`commandEnd`); the whole stdout stays on the member. `to`: the commit it pushed
 * to the attempt's ref, absent when it pushed none.
 */
const FleetResultSchema = z.object({
  exitCode: z.number().int(),
  outputs: JsonValueSchema.optional(),
  stderr: z.string(),
  to: CommitSchema.optional(),
  /**
   * A prompt step's: the tool the member ran it on, the id of the session it ran there, which the member pushed to the team
   * session archive, its model and tokens, and why it failed, as the member's report said.
   */
  tool: z.string().min(1).optional(),
  session: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  tokens: TokenUsageSchema.optional(),
  failure: z.object({ code: z.string().min(1), message: z.string() }).optional(),
  /** A whole workflow's: the end its nested run reached. */
  end: z.string().min(1).optional(),
});

export type FleetResult = z.infer<typeof FleetResultSchema>;

/**
 * The format of the attempt records this teamai writes and reads. 2: prompt leases, a prompt's session, whole
 * workflow leases and their gates, and an offer's `left`. A record is must-understand: a reader ignores a field its
 * parse leaves out, one this teamai does not know for the record's state and lease kind, unless the record's `critical`
 * names it, by dotted path from the record's top, an array's elements under the array's own key; then it refuses the
 * record as one a newer teamai wrote. A writer names in `critical` each field that changes what a reader must do, and
 * only a format a reader cannot read at all bumps this. A rewrite keeps the fields its writer does not know as it read
 * them, outside a list's elements. The run's `definition` and a prompt's `limits` stay strict: an unknown key there is
 * another workflow, or a limit nobody would hold the tool to.
 */
const RECORD_VERSION = 2;

/** What any teamai's record says of its format, whatever else it holds. */
const RecordFormatSchema = z.object({ version: z.number(), teamai: z.string().optional().catch(undefined) });

/** What a member's reason for leaving an offer keeps, and how many members' reasons an offer keeps, the newest. */
const LEFT_WHY_MAX = 400;
const LEFT_MAX = 16;

/** The reason an offer gets in place of one that names a path or a value of the member's machine, which its log keeps. */
const UNPUBLISHED_WHY = 'this member lacks what the step needs, and its reason names a path or a value of its machine, so only its own log says it';

/** Why `member` left an offer, which the owner's wait shows. */
const LeftSchema = z.object({ member: OwnerSchema, why: z.string().max(LEFT_WHY_MAX), at: z.string() });

const OfferedSchema = z.object({
  /** The record's format. A teamai that reads a newer one refuses it, naming the teamai that wrote it (`teamai`). */
  version: z.literal(RECORD_VERSION),
  /** The version of the teamai that wrote the record. */
  teamai: z.string().optional(),
  /** The fields, by dotted path, a reader must know to read the record (`RECORD_VERSION`). */
  critical: z.array(z.string().min(1)).optional(),
  run: RunIdSchema,
  attempt: AttemptIdSchema,
  pool: z.string().min(1),
  /** The business repository the attempt runs in, as `getRepoIdentity` names it. */
  repository: z.string().min(1),
  owner: OwnerSchema,
  /** The write that produced this record, which the next write replaces. */
  write: z.string().min(1),
  offeredAt: z.string(),
  /** The commit the attempt starts from, which the owner pushed to the attempt's ref. */
  start: CommitSchema,
  /** How long a claim may go without progress before the owner gives it up, in milliseconds. */
  staleAfterMs: z.number().int().positive(),
  lease: FleetLeaseSchema,
  /** The definitions the run executes, which a member reads from its own team repository and checks the lease against. */
  definition: RunDefinitionSchema.strict(),
  values: LeaseValuesSchema,
  /** Why members that read the offer left it, one entry per member, newest last: the owner's wait shows each once. */
  left: z.array(LeftSchema).max(LEFT_MAX).optional(),
  state: z.literal('offered'),
});

/**
 * A member's claim: `progressAt`, when it last wrote that it still runs the attempt, and `pushed`, the last commit it
 * pushed to the attempt's ref, from which a retry starts once the claim went stale.
 */
const ClaimedSchema = OfferedSchema.extend({ state: z.literal('claimed'), member: OwnerSchema, claimedAt: z.string(), progressAt: z.string(), pushed: CommitSchema });

const FinishedSchema = ClaimedSchema.extend({ state: z.literal('finished'), finishedAt: z.string(), result: FleetResultSchema });

/**
 * A claim the owner gave up once no progress came for `stale_after`, or no answer to its cancel (`cancelAt`): nothing the
 * member writes later counts.
 */
const ExpiredSchema = ClaimedSchema.extend({ state: z.literal('expired'), expiredAt: z.string(), cancelAt: z.string().optional() });

/** An offer the owner took back, before any member claimed it: the step was cancelled. */
const WithdrawnSchema = OfferedSchema.extend({ state: z.literal('withdrawn'), withdrawnAt: z.string() });

/** A gate a whole workflow reached on the member, as the owner's person sees it. */
const QuestionSchema = z.object({
  step: z.string().min(1), kind: z.enum(['approve', 'choose']), message: z.string(), options: z.array(z.string()), required: z.boolean(), default: z.string().optional(),
}) satisfies z.ZodType<ExecQuestion>;

/** The owner's answer: the choice and note its person gave, or why none comes. */
const AnswerSchema = z.union([
  z.object({ choice: z.string().min(1), note: z.string().optional(), refused: z.never().optional() }),
  z.object({ refused: z.string().min(1), choice: z.never().optional() }),
]) satisfies z.ZodType<ExecAnswer>;

/**
 * A claim whose whole workflow waits at a gate: the member asks the owner `question`, and keeps asking in its progress
 * until it reads the answer.
 */
const AskingSchema = ClaimedSchema.extend({ state: z.literal('asking'), question: QuestionSchema });

/** The owner's answer to the question of a claim, which the member takes at its next read; its next progress is a claim again. */
const AnsweredSchema = AskingSchema.extend({ state: z.literal('answered'), answer: AnswerSchema });

/** A claim the owner asked its member to stop, which the member answers with `cancelled` once its step stopped. */
const CancellingSchema = ClaimedSchema.extend({ state: z.literal('cancelling'), cancelAt: z.string() });

/**
 * A cancelled claim: the member stopped its step and pushed its work up to `pushed`, which a retry goes on from, and
 * `tokens`, what its step spent before it stopped, which the budgets around the step count.
 */
const CancelledSchema = CancellingSchema.extend({ state: z.literal('cancelled'), cancelledAt: z.string(), tokens: TokenUsageSchema.optional() });

export const FleetRecordSchema = z.discriminatedUnion('state', [OfferedSchema, ClaimedSchema, AskingSchema, AnsweredSchema, FinishedSchema, ExpiredSchema, WithdrawnSchema, CancellingSchema, CancelledSchema]);

export type FleetRecord = z.infer<typeof FleetRecordSchema>;

export type Offered = Extract<FleetRecord, { state: 'offered' }>;

export type Claimed = Extract<FleetRecord, { state: 'claimed' }>;

export type Cancelling = Extract<FleetRecord, { state: 'cancelling' }>;

/** A claim its member holds: running, asking the owner a gate, or with the owner's answer to read. */
export type HeldAttempt = Extract<FleetRecord, { state: 'claimed' | 'asking' | 'answered' }>;

export type Asking = Extract<FleetRecord, { state: 'asking' }>;

/** Whether `record` is a claim its member holds. */
export function isHeld(record: FleetRecord): record is HeldAttempt {
  return record.state === 'claimed' || record.state === 'asking' || record.state === 'answered';
}

/** Claim `held` as a plain claim, without a question or an answer. */
function claimOf(held: HeldAttempt): Claimed {
  switch (held.state) {
    case 'claimed':
      return held;
    case 'asking': {
      const { question: _question, ...claim } = held;

      return { ...claim, state: 'claimed' };
    }

    case 'answered': {
      const { question: _question, answer: _answer, ...claim } = held;

      return { ...claim, state: 'claimed' };
    }

    default: {
      const unhandled: never = held;

      return unhandled;
    }
  }
}

export type FleetError =
  | { code: 'state_moved'; message: string }
  | { code: 'reports_unreachable' | 'reports_failed' | 'fleet_unpublishable' | 'fleet_record_unreadable' | 'fleet_record_newer'; message: string };

type Written<T> = { ok: true; value: T } | { ok: false; error: FleetError };

/** The prefix of the branches of run `runId`'s fleet attempts, which go with the run's own (`runBranchPrefix`). */
export function attemptBranchPrefix(runId: string): string {
  return `teamai/attempts/${runId}/`;
}

/** The ref a member pushes an attempt's work to, and the owner fetches it from. */
export function attemptRef(run: RunId, attempt: AttemptId): string {
  return `refs/heads/${attemptBranchPrefix(run)}${attempt}`;
}

function recordPath(run: RunId, attempt: AttemptId): string {
  return `${ATTEMPTS_DIR}/${run}/${attempt}.json`;
}

/** `record` as written over `held`, the record it replaces as read, with what this teamai's parse of it (`kept`) left out. */
function recordText(record: FleetRecord, held?: { raw: JsonValue | undefined; kept: FleetRecord }): string {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const written = held === undefined ? undefined : jsonOf(text);

  return written === undefined || held === undefined ? text : `${JSON.stringify(withUnknownFields(held.raw, jsonOf(JSON.stringify(held.kept)), written), null, 2)}\n`;
}

/**
 * `written` with each field `held` holds that `kept`, what this teamai's parse of `held` kept, does not: a field this
 * teamai does not know outlives its write. An array's elements keep only the fields it knows.
 */
function withUnknownFields(held: JsonValue | undefined, kept: JsonValue | undefined, written: JsonValue): JsonValue {
  if (!isJsonObject(held) || !isJsonObject(kept) || !isJsonObject(written)) return written;
  const unknown = Object.entries(held).filter(([key]) => !Object.hasOwn(kept, key) && !Object.hasOwn(written, key));

  return Object.fromEntries([...Object.entries(written).map(([key, value]) => [key, withUnknownFields(held[key], kept[key], value)] as const), ...unknown]);
}

/** Whether `value` holds the field at dotted `path`, an array's elements under the array's own key. */
function holds(value: JsonValue | undefined, [key, ...rest]: readonly string[]): boolean {
  if (key === undefined) return value !== undefined;

  if (Array.isArray(value)) return value.some((element) => holds(element, [key, ...rest]));

  return isJsonObject(value) && Object.hasOwn(value, key) && holds(value[key], rest);
}

/**
 * Why `record` may not leave this machine, naming the field: a value that looks like a secret, among them those of
 * `secrets`, or an absolute path of this machine, which a member cannot use.
 */
function unpublishable(record: FleetRecord, secrets: Record<string, string>): FleetError | undefined {
  // A command or a prompt names the paths it reads and writes, such as /dev/null, wherever it runs: only a secret keeps it here.
  const leased = leaseText(record.lease);
  const inText = leased && firstUnfit(leased.text, secrets);
  const textHit = leased && inText?.unfit.kind === 'secret' ? { at: ['lease', leased.field], unfit: inText.unfit } : undefined;
  const hit = textHit ?? firstUnfit(JsonValueSchema.parse(leased ? { ...record, lease: { ...record.lease, [leased.field]: '' } } : record), secrets);

  return unpublishableAt(record, hit);
}

/** The refusal of attempt `record` that `hit` names, if any: what of the record holds a secret or a path of this machine. */
function unpublishableAt(record: Pick<FleetRecord, 'attempt' | 'run'>, hit: ReturnType<typeof firstUnfit>): FleetError | undefined {
  if (hit === undefined) return undefined;
  const at = hit.at.join('.');
  const what = hit.unfit.kind === 'secret' ? `what looks like a secret (${hit.unfit.label})` : 'an absolute path of this machine';

  return { code: 'fleet_unpublishable', message: `Attempt ${record.attempt} of run ${record.run} was not written to teamai-reports: its "${at}" holds ${what}.` };
}

/**
 * The texts of step `step` a fleet lease renders from values: its `env` and, for a prompt step, its `with`, `prompt` and
 * `model`, as `templatedTexts` names them.
 */
function leasedTexts(step: Pick<WorkflowStep, 'prompt' | 'env' | 'with' | 'model'>): Array<{ what: string; text: string }> {
  return templatedTexts(step).filter(({ what }) => what.startsWith('env.') || what.startsWith('with.') || what === 'prompt' || what === 'model');
}

/** How a message names the text at `what`: `env NAME` for an env entry, as a person writes it. */
function textLabel(what: string): string {
  return what.startsWith('env.') ? `env ${what.slice('env.'.length)}` : what;
}

/**
 * What the texts of step `step` a fleet lease renders read in `context`, the context its lease rendered them in, or why
 * a member could not render them from values: one reads something besides inputs, the item, the run's id and steps'
 * outputs. A read of the step's own `with` is rendered from the `with` texts. For an inline workflow, the inputs its
 * steps read too.
 */
export function leaseValues(step: Pick<WorkflowStep, 'id' | 'prompt' | 'env' | 'with' | 'model' | 'workflow'>, context: TemplateContext): { values: LeaseValues } | { error: string } {
  const given = JsonValueSchema.safeParse(context.inputs ?? {});
  const item = JsonValueSchema.safeParse(context.item);
  let inputs: JsonValue | undefined;
  let itemValues: JsonValue | undefined;
  const outputs: Record<string, JsonValue> = {};

  for (const { what, text } of leasedTexts(step)) {
    const parsed = parseTemplate(text, Object.hasOwn(context, 'item'));

    if (!parsed.ok) return { error: `Step "${step.id}" ${textLabel(what)} does not parse: ${parsed.errors[0]?.message ?? ''}` };

    for (const read of templateExpressions(parsed.template).flatMap(expressionPaths)) {
      if (read.root === 'steps' && read.field !== 'outputs') {
        return { error: `Step "${step.id}" ${textLabel(what)} reads steps.${read.step}.${read.field}, which a fleet member cannot render: on the fleet a step's env, with, prompt and model read only inputs, item, run.id and steps' outputs.` };
      }

      if (read.root === 'inputs' && given.success) inputs = withPath(inputs, given.data, read.fields);

      if (read.root === 'steps') {
        const stepOutputs = JsonValueSchema.safeParse(context.steps[read.step]?.outputs);
        const picked = stepOutputs.success ? withPath(outputs[read.step], stepOutputs.data, read.fields) : undefined;

        if (picked !== undefined) outputs[read.step] = picked;
      }

      // A text that reads the item renders against one, even when the field it reads is missing.
      if (read.root === 'item' && item.success) itemValues = withPath(itemValues, item.data, read.fields) ?? {};
    }
  }

  // The steps of an inline workflow read the inputs around it, which its nested run starts with.
  const runs = stepWorkflow(step);
  const inner = runs?.kind === 'inline' && given.success ? inlineReads(runs.workflow).flatMap(({ paths }) => paths) : [];

  for (const read of inner) if (read.root === 'inputs' && given.success) inputs = withPath(inputs, given.data, read.fields);

  return {
    values: {
      ...(inputs !== undefined && { inputs }),
      ...(Object.keys(outputs).length > 0 && { outputs }),
      ...(itemValues !== undefined && { item: itemValues }),
    },
  };
}

/**
 * `picked` with what `from` holds at `fields` added, so a record carries only what the env reads: a path that reads an
 * array element carries the whole array, and a path that reads nothing there adds nothing. A whole value is added as
 * `from` itself, which a later, longer path then finds already there.
 */
function withPath(picked: JsonValue | undefined, from: JsonValue, fields: PathField[]): JsonValue | undefined {
  const [field, ...rest] = fields;

  if (field === undefined || isIndex(field) || picked === from) return from;

  if (!isJsonObject(from) || !Object.hasOwn(from, field)) return picked;

  const value = from[field];

  if (value === undefined) return picked;

  const into = picked !== undefined && isJsonObject(picked) ? picked : {};
  const inner = withPath(into[field], value, rest);

  return inner === undefined ? into : { ...into, [field]: inner };
}

/** The context step texts render in from `values`, as its owner's lease rendered them from the run. */
function valuesContext(values: LeaseValues, run: RunId): TemplateContext {
  return {
    inputs: values.inputs ?? {},
    steps: Object.fromEntries(Object.entries(values.outputs ?? {}).map(([id, outputs]) => [id, { outputs }])),
    run: { id: run },
    ...(Object.hasOwn(values, 'item') && { item: values.item }),
  };
}

/** The env of step `step` in run `run`, rendered from `values` as its owner's lease rendered it from the run. */
export function leaseEnv(step: Pick<WorkflowStep, 'id' | 'env'>, values: LeaseValues, run: RunId): { env: Record<string, string> } | { error: string } {
  const context = valuesContext(values, run);
  const env: Record<string, string> = {};

  for (const [name, text] of Object.entries(step.env ?? {})) {
    const parsed = parseTemplate(text, Object.hasOwn(context, 'item'));

    if (!parsed.ok) return { error: `env ${name} does not parse: ${parsed.errors[0]?.message ?? ''}` };
    env[name] = renderText(parsed.template, context);
  }

  return { env };
}

/**
 * The prompt of prompt step `step` in run `run`, and its model when a template names it, rendered from `values` after
 * its `with`, as the engine renders a lease's. A model that renders empty is kept empty: it asks for the tool's default.
 */
export function leasePrompt(step: Pick<WorkflowStep, 'id' | 'prompt' | 'with' | 'model'>, values: LeaseValues, run: RunId): { prompt: string; model?: string } | { error: string } {
  if (step.prompt === undefined) return { error: `step "${step.id}" is no prompt step` };
  const context = valuesContext(values, run);

  if (step.with !== undefined) {
    const rendered = renderStrings(step.with, context);

    if (!rendered.ok) return { error: `with ${rendered.error.source}: ${rendered.error.message}` };
    context.with = rendered.value;
  }

  const prompt = renderLeaseText(context, step, { what: 'prompt', text: step.prompt });

  if (prompt instanceof Object) return { error: prompt.message };

  if (step.model === undefined || step.model instanceof Object) return { prompt };
  const model = renderLeaseText(context, step, { what: 'model', text: step.model });

  if (model instanceof Object) return { error: model.message };

  return { prompt, model };
}

/**
 * The inputs workflow `child` starts with when step `step` of run `run` runs it whole, rendered from `values` as its
 * owner's lease rendered them from the run. An inline workflow takes no `with`: it reads the inputs around it, of which
 * it starts with what `step` and the steps of `step`'s own copy of it read, picked from `values` as the owner picked them.
 */
export function leaseInputs(step: Pick<WorkflowStep, 'id' | 'prompt' | 'env' | 'with' | 'model' | 'workflow'>, child: WorkflowDefinition | InlineWorkflow, values: LeaseValues, run: RunId): { inputs: JsonValue } | { error: string } {
  if (!isWorkflowFile(child)) {
    const read = leaseValues(step, valuesContext(values, run));

    return 'error' in read ? read : { inputs: read.values.inputs ?? {} };
  }

  return wholeInputs(step, child, valuesContext(values, run));
}

/** Offers `lease` of attempt `attempt` to pool `pool`, once its start commit is on the attempt's ref. */
export async function offerAttempt(config: LocalConfig, input: {
  run: RunId; attempt: AttemptId; pool: string; repository: string; owner: HandoffOwner; start: string; staleAfterMs: number; lease: FleetLease;
  definition: Offered['definition']; values: LeaseValues; secrets: Record<string, string>;
}): Promise<Written<Offered>> {
  const { secrets, ...fields } = input;
  const record: Offered = { version: RECORD_VERSION, teamai: getCurrentVersion(), ...fields, write: randomUUID(), offeredAt: new Date().toISOString(), state: 'offered' };
  const unfit = unpublishable(record, secrets);

  if (unfit) return { ok: false, error: unfit };
  // An attempt is offered once: a record already there is the one an earlier drive of this attempt wrote.
  const written = await writeRecord(config, record, { replaces: undefined, message: `[teamai] Offer attempt ${record.attempt} of run ${record.run}` });

  return written.ok ? { ok: true, value: record } : written;
}

/**
 * Replaces offer `offered` with this install's claim; another member's claim first answers `state_moved`. The claim is
 * noted in this install's data home before it is written, so a restarted member finishes only claims it wrote.
 */
export async function claimAttempt(config: LocalConfig, offered: Offered, member: HandoffOwner): Promise<Written<Claimed>> {
  const now = new Date().toISOString();
  const claim: Claimed = { ...offered, write: randomUUID(), state: 'claimed', member, claimedAt: now, progressAt: now, pushed: offered.start };
  const marker = claimedMarker(config, offered.run, offered.attempt);
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await writeRegularFile(marker, `${JSON.stringify({ write: claim.write })}\n`);
  const written = await writeRecord(config, claim, { replaces: offered.write, message: `[teamai] Claim attempt ${offered.attempt} of run ${offered.run}` });

  if (!written.ok && written.error.code === 'state_moved') await fs.rm(marker, { force: true });

  return written.ok ? { ok: true, value: claim } : written;
}

/**
 * Says on offer `offered` why `member` leaves it, so the owner's wait shows it: `why` cut to what the record keeps, one
 * entry per member, newest last, and no new member once 16 are listed. A reason that names a path or a value of this
 * machine is said as `UNPUBLISHED_WHY`. An offer that holds the same reason already is not written again. The write
 * replaces the offer's write id, so it lands only over that offer, and answers state_moved once the offer changed.
 */
export async function leaveOffer(config: LocalConfig, offered: Offered, { member, why, secrets }: { member: HandoffOwner; why: string; secrets: Record<string, string> }): Promise<Written<void>> {
  const listed = offered.left ?? [];
  const leftWith = (reason: string): Offered => ({ ...offered, write: randomUUID(), left: [...listed.filter((entry) => entry.member.id !== member.id), { member, why: reason, at: new Date().toISOString() }].slice(-LEFT_MAX) });
  const kept = why.length <= LEFT_WHY_MAX ? why : `${why.slice(0, LEFT_WHY_MAX - 1)}…`;
  // A reason names what this machine lacks, which may hold one of its paths or values: the offer says only that it does.
  const said = unpublishable(leftWith(kept), secrets) ? UNPUBLISHED_WHY : kept;

  if (listed.some((entry) => entry.member.id === member.id && entry.why === said)) return { ok: true, value: undefined };

  // A full list takes no new member: each would push out another, which would write itself back at its next take.
  if (listed.length >= LEFT_MAX && !listed.some((entry) => entry.member.id === member.id)) return { ok: true, value: undefined };
  const record = leftWith(said);
  const unfit = unpublishable(record, secrets);

  if (unfit) return { ok: false, error: unfit };

  return writeRecord(config, record, { replaces: offered.write, message: `[teamai] Leave attempt ${offered.attempt} of run ${offered.run}` });
}

/**
 * Writes that the member of claim `held` still runs it, and has pushed `pushed` to the attempt's ref: asking the owner
 * `question` while its whole workflow waits at that gate.
 */
export async function recordProgress(config: LocalConfig, held: HeldAttempt, pushed: string, asked?: { question: ExecQuestion; secrets: Record<string, string> }): Promise<Written<HeldAttempt>> {
  const claim: Claimed = { ...claimOf(held), write: randomUUID(), progressAt: new Date().toISOString(), pushed };
  const progressed: HeldAttempt = asked === undefined ? claim : { ...claim, state: 'asking', question: asked.question };
  // A gate's message is rendered from the run, so it is checked as a finished result is before it is published.
  const unfit = asked && unpublishable(progressed, asked.secrets);

  if (unfit) return { ok: false, error: unfit };
  const written = await writeRecord(config, progressed, { replaces: held.write, message: `[teamai] Progress of attempt ${held.attempt} of run ${held.run}` });

  return written.ok ? { ok: true, value: progressed } : written;
}

/**
 * Gives up claim `claimed`, whose member wrote no progress for longer than the pool allows, or did not answer the cancel
 * of it in that time.
 */
export async function expireClaim(config: LocalConfig, claimed: HeldAttempt | Cancelling): Promise<Written<Extract<FleetRecord, { state: 'expired' }>>> {
  const expired: Extract<FleetRecord, { state: 'expired' }> = { ...(claimed.state === 'cancelling' ? claimed : claimOf(claimed)), write: randomUUID(), state: 'expired', expiredAt: new Date().toISOString() };
  const written = await writeRecord(config, expired, { replaces: claimed.write, message: `[teamai] Expire attempt ${claimed.attempt} of run ${claimed.run}` });

  return written.ok ? { ok: true, value: expired } : written;
}

/**
 * Cancels attempt `record` through its record: an offer no member claimed is withdrawn, and a claim becomes `cancelling`,
 * which its member answers once it stopped the step. Another write first answers `state_moved`. While another write on
 * this install holds teamai-reports, such as `workflow cancel` publishing the run, the cancel waits for it until
 * `wait.until` (epoch ms), or `wait.signal` aborts.
 */
export async function cancelAttempt(config: LocalConfig, record: Offered | HeldAttempt, wait?: LockWait): Promise<Written<Extract<FleetRecord, { state: 'withdrawn' | 'cancelling' }>>> {
  const now = new Date().toISOString();
  const cancel: Extract<FleetRecord, { state: 'withdrawn' | 'cancelling' }> = record.state === 'offered' ? { ...record, write: randomUUID(), state: 'withdrawn', withdrawnAt: now } : { ...claimOf(record), write: randomUUID(), state: 'cancelling', cancelAt: now };
  const written = await writeRecord(config, cancel, { replaces: record.write, message: `[teamai] Cancel attempt ${record.attempt} of run ${record.run}`, ...(wait && { wait }) });

  return written.ok ? { ok: true, value: cancel } : written;
}

/**
 * Writes the owner's answer `answer` to the question of claim `asking`; a progress of its member that landed first answers
 * `state_moved`. The answer, the person's note among it, is checked against `secrets` as a run is before it is published.
 */
export async function answerQuestion(config: LocalConfig, asking: Asking, answer: ExecAnswer, secrets: Record<string, string>): Promise<Written<Extract<FleetRecord, { state: 'answered' }>>> {
  const answered: Extract<FleetRecord, { state: 'answered' }> = { ...asking, write: randomUUID(), state: 'answered', answer };
  // Only the answer is the owner's to check: the rest of the record is what the member wrote, which its own check passed.
  const unfit = unpublishableAt(answered, firstUnfit(JsonValueSchema.parse({ answer }), secrets));

  if (unfit) return { ok: false, error: unfit };
  const written = await writeRecord(config, answered, { replaces: asking.write, message: `[teamai] Answer attempt ${asking.attempt} of run ${asking.run}` });

  return written.ok ? { ok: true, value: answered } : written;
}

/** Answers the cancel of claim `cancelling`: its member stopped the step, whose work up to `pushed` is on the attempt's ref. */
export async function answerCancel(config: LocalConfig, cancelling: Cancelling, pushed: string, tokens?: TokenUsage): Promise<Written<Extract<FleetRecord, { state: 'cancelled' }>>> {
  const cancelled: Extract<FleetRecord, { state: 'cancelled' }> = { ...cancelling, write: randomUUID(), state: 'cancelled', cancelledAt: new Date().toISOString(), pushed, ...(tokens && { tokens }) };
  const written = await writeRecord(config, cancelled, { replaces: cancelling.write, message: `[teamai] Cancelled attempt ${cancelling.attempt} of run ${cancelling.run}` });

  return written.ok ? { ok: true, value: cancelled } : written;
}

/**
 * Writes how claim `claimed` ended. A stderr snippet that may not leave this machine, such as a tool's warning that
 * names its cwd, is left out and the result stands; any other field that may not fails the attempt instead, naming the
 * field, so the owner does not wait on it.
 */
export async function finishAttempt(config: LocalConfig, claimed: HeldAttempt, result: FleetResult, secrets: Record<string, string>): Promise<Written<FleetRecord>> {
  const finished: FleetRecord = { ...claimOf(claimed), write: randomUUID(), state: 'finished', finishedAt: new Date().toISOString(), result };

  // A tool's failure message is as free as stderr, so it goes too, keeping its code.
  const quiet: FleetRecord = {
    ...finished,
    result: { ...result, stderr: 'Its stderr is not shown here: it names a path of the member\'s machine or a secret.', ...(result.failure && { failure: { code: result.failure.code, message: 'Its message is not shown here: it names a path of the member\'s machine or a secret.' } }) },
  };

  const fit = [finished, quiet].find((candidate) => unpublishable(candidate, secrets) === undefined);
  const record: FleetRecord = fit ?? { ...finished, result: { exitCode: 1, stderr: unpublishable(quiet, secrets)?.message ?? '' } };
  const written = await writeRecord(config, record, { replaces: claimed.write, message: `[teamai] Finish attempt ${claimed.attempt} of run ${claimed.run}` });

  return written.ok ? { ok: true, value: record } : written;
}

/** The record of attempt `attempt` as origin holds it now, or `absent`. */
export async function readAttemptRecord(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<Written<FleetRecord | 'absent'>> {
  // The team clone, which every install has: its reports checkout may not exist yet.
  const read = await fetchReportsOriginFile(gitRoot(config), recordPath(run, attempt));

  switch (read.status) {
    case 'absent':
      return { ok: true, value: 'absent' };
    case 'unreachable':
      return { ok: false, error: { code: 'reports_unreachable', message: `teamai-reports could not be read (${sanitizeGitUrl(read.reason)}).` } };
    case 'refused':
      return { ok: false, error: { code: 'reports_unreachable', message: read.message } };
    case 'found':
      return parseRecord(read.text, run, attempt);
    default: {
      const unhandled: never = read;

      return unhandled;
    }
  }
}

/** Whether record text `text` says it is in a format of another teamai's, older or newer than this one's. */
function isOtherFormat(text: string): boolean {
  const format = RecordFormatSchema.safeParse(jsonOf(text));

  return format.success && format.data.version !== RECORD_VERSION;
}

function parseRecord(text: string, run: string, attempt: string): Written<FleetRecord> {
  const raw = jsonOf(text);
  const format = RecordFormatSchema.safeParse(raw);

  // A newer teamai's format may mean anything here: it is never read as this one's.
  if (format.success && format.data.version > RECORD_VERSION) {
    const by = format.data.teamai;

    return { ok: false, error: { code: 'fleet_record_newer', message: `The record of attempt ${attempt} of run ${run} on teamai-reports was written by teamai ${by ?? 'newer than this one'}, in a format this teamai cannot read. Upgrade teamai${by === undefined ? '' : ` to ${by} or later`}.` } };
  }

  if (format.success && format.data.version < RECORD_VERSION) {
    return { ok: false, error: { code: 'fleet_record_unreadable', message: `The record of attempt ${attempt} of run ${run} on teamai-reports was written by teamai ${format.data.teamai ?? 'older than this one'}, in an older format this teamai does not read. Upgrade the teamai ${format.data.teamai === undefined ? '' : `${format.data.teamai} `}that wrote it, on the owner's or a member's machine.` } };
  }

  const parsed = FleetRecordSchema.safeParse(raw);

  if (!parsed.success || parsed.data.run !== run || parsed.data.attempt !== attempt) {
    return { ok: false, error: { code: 'fleet_record_unreadable', message: `The record of attempt ${attempt} of run ${run} on teamai-reports cannot be read.` } };
  }

  // A field the parse left out is one this teamai does not know, though another state or lease kind may hold it.
  const kept = jsonOf(JSON.stringify(parsed.data));
  const unknownFields = (parsed.data.critical ?? []).filter((field) => holds(raw, field.split('.')) && !holds(kept, field.split('.')));

  if (unknownFields.length > 0) {
    const by = parsed.data.teamai;

    return { ok: false, error: { code: 'fleet_record_newer', message: `The record of attempt ${attempt} of run ${run} on teamai-reports was written by teamai ${by ?? 'newer than this one'}, and needs ${unknownFields.map((field) => `"${field}"`).join(', ')}, which this teamai does not know. Upgrade teamai${by === undefined ? '' : ` to ${by} or later`}.` } };
  }

  return { ok: true, value: parsed.data };
}

/**
 * The records of run `run`, or of every run, as this machine's copy of `teamai-reports` holds them: refresh it first. A
 * record that does not parse, or names another run or attempt than its path, is left out, and one of another format
 * is warned about: list once per pass, so each is warned about once.
 */
export async function listRecords(config: LocalConfig, run?: RunId): Promise<FleetRecord[]> {
  const root = path.join(getReportsDir(config), ATTEMPTS_DIR);
  const runs = run === undefined ? (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).flatMap((entry) => (entry.isDirectory() ? [entry.name] : [])) : [run];
  const records: FleetRecord[] = [];

  for (const name of runs) {
    const files = await fs.readdir(path.join(root, name)).catch(() => []);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const text = await readRegularFile(path.join(root, name, file), 'utf8').catch(() => '');
      const parsed = parseRecord(text, name, file.slice(0, -'.json'.length));

      if (parsed.ok) records.push(parsed.value);
      // Another teamai's format, or a field it needs, is worth saying: one of the two installs is to upgrade.
      else if (parsed.error.code === 'fleet_record_newer' || isOtherFormat(text)) log.warn(`Skipped an attempt: ${parsed.error.message}`);
    }
  }

  return records;
}

/** An attempt out on a fleet: offered, claimed (asking or answered too), or claimed and asked to stop. */
export type OpenAttempt = Extract<FleetRecord, { state: 'offered' | 'claimed' | 'asking' | 'answered' | 'cancelling' }>;

/** The attempts out for business repository `repository`, oldest offer first, as `workflow resume` lists them. */
export async function listOpenAttempts(config: LocalConfig, repository: string): Promise<OpenAttempt[]> {
  const open = (await listRecords(config)).flatMap((record) => (record.repository === repository && (record.state === 'offered' || isHeld(record) || record.state === 'cancelling') ? [record] : []));

  return open.sort((left, right) => left.offeredAt.localeCompare(right.offeredAt));
}

/** The attempts among `records` (listRecords) offered to pool `pool` for business repository `repository`, oldest offer first. */
export function offersAmong(records: FleetRecord[], { pool, repository }: { pool: string; repository: string }): Offered[] {
  const offers = records.flatMap((record) => (record.state === 'offered' && record.pool === pool && record.repository === repository ? [record] : []));

  return offers.sort((left, right) => left.offeredAt.localeCompare(right.offeredAt));
}

type Gone = Extract<FleetRecord, { state: 'expired' | 'cancelling' | 'cancelled' }>;

/** When the owner gave the claim of `record` up or cancelled it, by the owner's clock: a member's may be off. */
function goneAt(record: Gone): string {
  switch (record.state) {
    case 'expired': return record.expiredAt;
    case 'cancelling': return record.cancelAt;
    case 'cancelled': return record.cancelAt;
    default: {
      const unhandled: never = record;

      return unhandled;
    }
  }
}

/**
 * The last attempt of step `step` of run `run` that this install offered and whose claim it gave up or cancelled after
 * its member pushed work, as this machine's copy of `teamai-reports` holds it: refresh it first. A retry of the step
 * goes on from that work. A cancel its member never answered counts with the work it pushed before: a member that
 * answers later changes nothing.
 */
export async function lastGoneWork(config: LocalConfig, { run, step }: { run: RunId; step: string }): Promise<{ attempt: AttemptId; pushed: string } | undefined> {
  let last: Gone | undefined;

  for (const record of await listRecords(config, run)) {
    if (record.state !== 'expired' && record.state !== 'cancelling' && record.state !== 'cancelled') continue;

    if (record.lease.step !== step || record.pushed === record.start) continue;

    // Only an attempt this install offered: anyone who can write teamai-reports can write a record, naming any owner.
    if (await offeredPool(config, run, record.attempt) === undefined) continue;

    if (last === undefined || goneAt(record) > goneAt(last)) last = record;
  }

  return last && { attempt: last.attempt, pushed: last.pushed };
}

/** A record a member's claim wrote: claimed, finished, given up, cancelling or cancelled. */
export type MemberRecord = Exclude<FleetRecord, Offered | Extract<FleetRecord, { state: 'withdrawn' }>>;

/**
 * The records among `records` (listRecords) of claims this install wrote as member `member` for business repository
 * `repository`, oldest claim first. A member that starts stops what its earlier runs of these left, and finishes the
 * claims it still holds before it takes a new offer. A record that names this member for a claim it never wrote here is
 * not its own: anyone who can write teamai-reports can write one.
 */
export async function memberRecordsAmong(config: LocalConfig, records: FleetRecord[], { member, repository }: { member: HandoffOwner; repository: string }): Promise<MemberRecord[]> {
  const named: MemberRecord[] = [];

  for (const record of records) {
    if (record.state === 'offered' || record.state === 'withdrawn') continue;

    if (record.member.id === member.id && record.repository === repository && await isClaimedHere(config, record.run, record.attempt)) named.push(record);
  }

  return named.sort((left, right) => left.claimedAt.localeCompare(right.claimedAt));
}

/** How long a write that waits for this install's teamai-reports lock may wait: until `until` (epoch ms), or `signal`. */
export type LockWait = { until: number; signal?: AbortSignal };

/** How often a write that waits for this install's teamai-reports lock tries to take it. */
const LOCK_RETRY_MS = 250;

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/**
 * Writes `record` while origin still holds the write `replaces`, or no record when `replaces` is undefined. A write in
 * between answers `state_moved`, as does one that landed while this write could not tell. With `wait`, a write that
 * finds another write of this install holding teamai-reports tries again until `wait` ends, instead of at once failing.
 */
async function writeRecord(config: LocalConfig, record: FleetRecord, { replaces, message, wait }: { replaces: string | undefined; message: string; wait?: LockWait }): Promise<Written<void>> {
  const rel = recordPath(record.run, record.attempt);
  const moved: FleetError = { code: 'state_moved', message: `Attempt ${record.attempt} of run ${record.run} changed on teamai-reports meanwhile, so this write did not land.` };

  const update = () => updateReports(config, async (worktree, context): Promise<ReportsChange<Written<void>>> => {
    const read = await fetchReportsOriginFile(worktree, rel, context);

    if (read.status === 'unreachable') return { value: { ok: false, error: { code: 'reports_unreachable', message: `teamai-reports could not be read (${sanitizeGitUrl(read.reason)}).` } }, write: null };

    if (read.status === 'refused') return { value: { ok: false, error: { code: 'reports_unreachable', message: read.message } }, write: null };
    const held = read.status === 'found' ? parseRecord(read.text, record.run, record.attempt) : undefined;

    if (held && !held.ok) return { value: held, write: null };

    if ((held?.value.write) !== replaces) return { value: { ok: false, error: moved }, write: null };
    await fs.mkdir(path.join(worktree, path.dirname(rel)), { recursive: true });
    await writeRegularFile(path.join(worktree, rel), recordText({ ...record, teamai: getCurrentVersion() }, read.status === 'found' && held?.ok ? { raw: jsonOf(read.text), kept: held.value } : undefined));

    return { value: { ok: true, value: undefined }, write: { files: [rel], message } };
  });

  let result = await update();

  // Busy: the write did not run, so it is tried again as it was.
  if (wait !== undefined) {
    while (result.status === 'busy' && Date.now() < wait.until && !isAborted(wait.signal)) {
      await sleep(Math.min(LOCK_RETRY_MS, wait.until - Date.now()), undefined, wait.signal && { signal: wait.signal }).catch(() => undefined);

      if (isAborted(wait.signal)) break;
      result = await update();
    }
  }

  if (result.value && !result.value.ok) return result.value;

  if (result.status === 'published' || result.status === 'already-present') return { ok: true, value: undefined };

  // Still held at the end of its wait: the write never ran, so a record moved meanwhile is not why it did not land.
  if (result.status === 'busy' && wait !== undefined) return { ok: false, error: heldError(record) };

  // The write may still have landed, or another one first, as when two members race for an offer: origin decides.
  const now = await readAttemptRecord(config, record.run, record.attempt);

  if (now.ok && now.value !== 'absent' && now.value.write === record.write) return { ok: true, value: undefined };

  if (now.ok && (now.value === 'absent' ? undefined : now.value.write) !== replaces) return { ok: false, error: moved };

  if (result.status === 'busy') return { ok: false, error: heldError(record) };

  return { ok: false, error: { code: 'reports_failed', message: `Attempt ${record.attempt} of run ${record.run} could not be written to teamai-reports (${sanitizeGitUrl(result.reason)}). Try again.` } };
}

function heldError(record: FleetRecord): FleetError {
  return { code: 'reports_failed', message: `Attempt ${record.attempt} of run ${record.run} could not be written to teamai-reports (another write held teamai-reports). Try again.` };
}

/** `attempts/<attempt>/fleet.json` in this install's data home: the pool the owner offered the attempt to. */
function offeredMarker(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'fleet.json');
}

/**
 * Notes, before the offer is written, that attempt `attempt` goes to pool `pool` from the exec `offer.op`, with
 * `offer.staleAfterMs`, so a restarted owner offers it as it was going to and waits on it again, and a cancel with no
 * live driver reaches it.
 */
export async function markOffered(config: LocalConfig, run: RunId, attempt: AttemptId, pool: string, offer?: { op: OpId; staleAfterMs: number }): Promise<void> {
  const file = offeredMarker(config, run, attempt);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeRegularFile(file, `${JSON.stringify({ pool, ...offer })}\n`);
}

/** `attempts/<attempt>/fleet-claim.json` in this install's data home: this install claimed the attempt as a member. */
function claimedMarker(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'fleet-claim.json');
}

/** Whether this install wrote a claim of attempt `attempt`. */
async function isClaimedHere(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<boolean> {
  return fs.access(claimedMarker(config, run, attempt)).then(() => true, () => false);
}

function foldersNote(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'fleet-folders.json');
}

/** Notes the stored workflow folders `held`'s step reads, before they are written, so a sweep keeps them while it runs. */
export async function noteHeldFolders(config: LocalConfig, held: HeldAttempt, sourceHashes: readonly string[]): Promise<void> {
  if (sourceHashes.length > 0) await writeJsonAtomic(foldersNote(config, held.run, held.attempt), [...sourceHashes]);
}

const FoldersNoteSchema = z.array(z.string());

/**
 * The stored workflow folders the steps this install holds read: no run record here names a command or prompt step a
 * member takes, and its team's workflows may have moved on since it took it. Read from this install's teamai-reports
 * checkout as it stands, which holds every write of its own. A note it cannot read answers why, so no folder goes.
 */
export async function heldFolders(config: LocalConfig): Promise<{ ok: true; folders: string[] } | { ok: false; why: string }> {
  const held = (await listRecords(config)).filter((record) => isHeld(record) || record.state === 'cancelling');
  const folders: string[] = [];

  for (const record of held) {
    if (!await isClaimedHere(config, record.run, record.attempt)) continue;
    const note = foldersNote(config, record.run, record.attempt);
    let text: string;

    try {
      text = await readRegularFile(note, 'utf8');
    } catch (error) {
      // A claim whose step reads no folder notes none.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;

      return { ok: false, why: `${note} could not be read (${error instanceof Error ? error.message : String(error)})` };
    }

    let parsed: string[] | undefined;

    try {
      parsed = FoldersNoteSchema.safeParse(parseJson(text)).data;
    } catch {
      parsed = undefined;
    }

    if (parsed === undefined) return { ok: false, why: `${note} is not a list of folders` };
    folders.push(...parsed);
  }

  return { ok: true, folders };
}

/**
 * The wake an owner sent for an offer: its op, noted before it is sent, so a restarted owner sends none again; and once
 * the runtime launched a member, where, with what it shows of it.
 */
const WakeNoteSchema = z.object({ op: OpIdSchema, where: z.string().optional(), display: RuntimeDisplaySchema.optional() }).strict();

export type WakeNote = z.infer<typeof WakeNoteSchema>;

const OfferedMarkerSchema = z.object({ pool: z.string().min(1), op: OpIdSchema.optional(), staleAfterMs: z.number().int().positive().optional(), wake: WakeNoteSchema.optional() });

/**
 * Notes on the offer of attempt `attempt` the wake its owner sent: `wake.op` before it sends it, then where it launched a
 * member. An attempt this install did not offer gets none.
 */
export async function noteWake(config: LocalConfig, run: RunId, attempt: AttemptId, wake: WakeNote): Promise<void> {
  const marker = await readOfferedMarker(config, run, attempt);

  if (marker === undefined) return;
  // Whole or not at all: a marker cut short would read as no offer, and its wake as never sent.
  await writeJsonAtomic(offeredMarker(config, run, attempt), { ...marker, wake }, { compact: true });
}

/** The member a wake launched for an offer, as the attempt listing names it: what the runtime shows of it, else where; undefined when none was woken. */
export function woken(marker: z.infer<typeof OfferedMarkerSchema> | undefined): string | undefined {
  const display: RuntimeDisplay | undefined = marker?.wake?.display;

  if (display) return display.url === undefined ? display.label : `${display.label} (${display.url})`;

  return marker?.wake?.where;
}

/** What this install noted when it offered attempt `attempt`: its pool, the exec that offered it, its stale_after and its wake; undefined when it offered it to none. */
export async function readOfferedMarker(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<z.infer<typeof OfferedMarkerSchema> | undefined> {
  const text = await readRegularFile(offeredMarker(config, run, attempt), 'utf8').catch(() => undefined);
  const parsed = text === undefined ? undefined : OfferedMarkerSchema.safeParse(jsonOf(text));

  return parsed?.success ? parsed.data : undefined;
}

/** The pool this install offered attempt `attempt` to, or undefined when it offered it to none. */
export async function offeredPool(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<string | undefined> {
  return (await readOfferedMarker(config, run, attempt))?.pool;
}

/** `text` as JSON, or undefined when it does not parse. */
function jsonOf(text: string): JsonValue | undefined {
  try {
    return parseJson(text);
  } catch {
    return undefined;
  }
}

/** A fleet error as the workflow failure a step or a command answers with. */
export function fleetFailure(error: FleetError): WorkflowFailure {
  return { code: error.code, message: error.message };
}
