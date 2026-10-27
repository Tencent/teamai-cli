/** `runs/<run>/skill.json`: what the skill driver keeps of a run between calls. This module is its only reader and writer. */
import fs from 'node:fs/promises';
import { z } from 'zod';
import { DriverSchema } from '../../../driver-identity.js';
import { RunModeSchema } from '../../../launch-context.js';
import { isToolId } from '../../../tools.js';
import type { LocalConfig, ToolId } from '../../../types.js';
import { readFileSafe, writeJsonAtomic } from '../../../utils/fs.js';
import { redactJson } from '../../../utils/redact.js';
import type { HostPlaceRequest, RunVersion } from '../../protocol.js';
import { FailureSchema } from '../../step-state.js';
import { AttemptIdSchema, RunIdSchema, skillStatePath, type RunId, type RunLock } from '../../store.js';
import { HOST_CHOICES } from './host-profiles.js';
import { INVOCATIONS } from './literals.js';
import { HITL_MODES } from './preflight.js';
import type { JudgedBy } from './transitions.js';


/** A report as the runner sends it, kept before it is sent so a crash between the two loses nothing. */
const ReportBodySchema = z.object({
  attempt: AttemptIdSchema,
  revision: z.number().int(),
  /** `released`: the attempt was stopped, so the protocol abandons its place instead of finishing it. */
  outcome: z.enum(['success', 'failed', 'released']),
  driver: DriverSchema,
  exitCode: z.number().int().optional(),
  outputs: z.unknown().optional(),
  message: z.string().optional(),
  failure: FailureSchema.optional(),
});
export type ReportBody = z.infer<typeof ReportBodySchema>;

/**
 * The model a child must run. `definition`: neither the step nor `defaults.model` named one, so the child runs the team
 * agent's own model, or the host's default.
 */
const ModelPickSchema = z.union([
  z.object({ by: z.literal('definition') }),
  z.object({ by: z.enum(['step', 'defaults']), name: z.string(), effort: z.string().optional(), alias: z.string().optional() }),
]);
export type ModelPick = z.infer<typeof ModelPickSchema>;

/**
 * A prompt step's work as a child gets it: the place it works in, its brief, and the agent and model it runs as.
 * `person`: an interactive step, which the agent works itself with the person instead of a child. `isolation`: the step
 * requires a sandbox, which no skill host enforces.
 */
const DispatchSchema = z.object({
  place: z.enum(['workspace', 'checkout']),
  person: z.literal(true).optional(),
  isolation: z.literal('sandbox').optional(),
  dir: z.string(),
  brief: z.string(),
  agent: z.string().optional(),
  model: ModelPickSchema,
});
export type Dispatch = z.infer<typeof DispatchSchema>;

/** Why an attempt is stopped: the person cancelled it, or it passed the deadline its lease carries. */
const STOP_REASONS = ['cancelled', 'timeout'] as const;
export type StopReason = typeof STOP_REASONS[number];

/** The place the host is asked to make for a step: `name` for it, on `branch`, from commit `start`. */
const PlaceAskSchema = z.object({ name: z.string(), branch: z.string(), start: z.string() });
export type PlaceAsk = z.infer<typeof PlaceAskSchema>;

/** Where a runner prepares the place of its attempt when the host makes it. Absent: where TeamAI makes it. */
const HostRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host') }),
  z.object({ kind: z.literal('adopt'), dir: z.string() }),
]) satisfies z.ZodType<HostPlaceRequest>;

const RunVersionSchema: z.ZodType<RunVersion> = z.object({ status: z.enum(['running', 'succeeded', 'failed', 'cancelled']), revision: z.number().int(), receipts: z.number().int(), creating: z.boolean() });
const AttemptBase = { attempt: AttemptIdSchema, step: z.string(), revision: z.number().int(), spawnedAt: z.string(), expiresAt: z.string().optional() };
/**
 * An open attempt: its runner prepares its place or runs its command; it waits for the place another attempt holds;
 * it waits for the agent to adopt a place its host made; its dispatch is offered to the agent, or acked; it is being
 * stopped, by its runner or by the agent that started its child; or it has a report to send.
 */
const AttemptStateSchema = z.discriminatedUnion('phase', [
  z.object({ ...AttemptBase, phase: z.literal('preparing'), request: HostRequestSchema.optional() }),
  z.object({ ...AttemptBase, phase: z.literal('queued'), behind: AttemptIdSchema, request: HostRequestSchema.optional() }),
  /** `refused`: why the place the agent adopted last was not prepared. */
  z.object({ ...AttemptBase, phase: z.literal('placing'), ask: PlaceAskSchema, refused: z.string().optional() }),
  z.object({ ...AttemptBase, phase: z.literal('running') }),
  /** `reissued`: an earlier session was shown this dispatch, and a child it started may still run. */
  z.object({ ...AttemptBase, phase: z.literal('offered'), dispatch: DispatchSchema, reissued: z.literal(true).optional() }),
  z.object({ ...AttemptBase, phase: z.literal('dispatched'), dispatch: DispatchSchema }),
  z.object({ ...AttemptBase, phase: z.literal('stopping'), by: z.enum(['runner', 'agent']), why: z.enum(STOP_REASONS) }),
  /** `stopped`: the report gives up an attempt stopped for this reason. */
  z.object({ ...AttemptBase, phase: z.literal('reporting'), body: ReportBodySchema, tail: z.string().optional(), stopped: z.enum(STOP_REASONS).optional() }),
]);
export type AttemptState = z.infer<typeof AttemptStateSchema>;

/** The judge running now: lease `ref`, its runner keyed by the attempt in that ref, on the pass of `step` that `scorers` judge. */
const JudgeSchema = z.object({ ref: z.string(), attempt: AttemptIdSchema, step: z.string(), scorers: z.array(z.string()), spawnedAt: z.string() });
export type Judge = z.infer<typeof JudgeSchema>;

const TurnEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started'), step: z.string(), attempt: AttemptIdSchema }),
  z.object({ kind: z.literal('restarted'), step: z.string(), attempt: AttemptIdSchema }),
  /** This session took the run over from session `from`, when that one was known. */
  z.object({ kind: z.literal('takeover'), from: z.string().optional() }),
  /** The engine cancelled the attempt's lease, or its deadline passed, so its report was not recorded. */
  z.object({ kind: z.literal('stopped'), step: z.string(), attempt: AttemptIdSchema, why: z.enum(STOP_REASONS) }),
  /** The judge of lease `ref` started on the pass of `step` that `scorers` judge. */
  z.object({ kind: z.literal('judging'), step: z.string(), scorers: z.array(z.string()), ref: z.string() }),
  z.object({ kind: z.literal('judged'), step: z.string(), scorer: z.string(), label: z.string() }),
  /** This driver judges no more of the run, for `failure`; the open judge lease lapses back to the queue. */
  z.object({ kind: z.literal('judging-off'), failure: FailureSchema }),
  /** The agent's answer to an optional gate, as the engine recorded it. */
  z.object({ kind: z.literal('answered'), step: z.string(), choice: z.string(), channel: z.string(), agent: z.boolean() }),
  z.object({
    kind: z.literal('settled'),
    step: z.string(),
    outcome: z.enum(['success', 'failed', 'released']),
    exitCode: z.number().int().optional(),
    failure: FailureSchema.optional(),
    /** The end of the step's masked output. */
    tail: z.string().optional(),
  }),
]);
export type TurnEvent = z.infer<typeof TurnEventSchema>;

const GateBase = {
  step: z.string(),
  pass: z.number().int(),
  kind: z.enum(['approve', 'choose']),
  message: z.string(),
  options: z.array(z.string()),
  default: z.string().optional(),
  /** The `seq` it was journalled at, so a poll wakes a session that was not shown it yet. */
  seq: z.number().int(),
};
/**
 * The gate the engine asks about now. Only the person answers a required one; `decide` says who answers an optional
 * one: the agent, after asking the person (`person`), or with its own best recommendation (`agent`).
 */
const GateSchema = z.discriminatedUnion('required', [
  z.object({ ...GateBase, required: z.literal(true) }),
  z.object({ ...GateBase, required: z.literal(false), decide: z.enum(['person', 'agent']) }),
]);
export type Gate = z.infer<typeof GateSchema>;

const SkillStateSchema = z.object({
  version: z.literal(1),
  run: RunIdSchema,
  /** The identity every `next` and report sends: kind `skill`, this machine, the checkout the run started from. */
  driver: DriverSchema,
  invocation: z.enum(INVOCATIONS),
  /** `mode`: the run mode its start resolved, which every process of its attempts gets; a state from before it was kept is attended. */
  options: z.object({ parallel: z.number().int().min(1), hitl: z.enum(HITL_MODES), mode: RunModeSchema.default('attended') }),
  /**
   * `none`: the run has no prompt step. `pending`: the agent has not answered the host question yet; a run without a
   * prompt step (`hasPromptStep` false) asks it only for its judge, and a state from before it was kept had one.
   */
  host: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('pending'), hasPromptStep: z.boolean().default(true) }),
    z.object({ kind: z.literal('chosen'), id: z.enum(HOST_CHOICES), children: z.enum(['parallel', 'serial']), places: z.enum(['teamai', 'host']) }),
  ]),
  gate: GateSchema.optional(),
  /**
   * The session that drives the run, when its host names one, and when it last called. `tool`: the tool that session
   * works in, which `--tools default=<tool>` names or its host does, so a runner resolves its children's models for it;
   * dropped when this teamai knows no such tool.
   */
  orchestrator: z.object({ session: z.string().optional(), tool: z.custom<ToolId>((tool) => typeof tool === 'string' && isToolId(tool)).optional().catch(undefined), lastCallAt: z.string() }),
  attempts: z.array(AttemptStateSchema),
  /** Present while this driver judges the run's scored steps with the confined judge of `tool`. `open`: the judge running now. */
  judging: z.object({ tool: z.string(), open: JudgeSchema.optional() }).optional(),
  /**
   * Present when the session itself judges the run's scored steps once the run is done, as no verified judge of `tool`,
   * the session's tool at the start, is here. The session judges with the run's tool, `orchestrator.tool`, else `tool`.
   */
  sessionJudge: z.object({ tool: z.string() }).optional(),
  /** The sequence number of the last event. */
  seq: z.number().int(),
  events: z.array(z.object({ seq: z.number().int(), event: TurnEventSchema })),
  /** The last event each session was shown, by session. */
  seen: z.record(z.string(), z.number().int()),
  /** The attempts the engine settled or stopped: a report that comes for one again is P1. */
  settled: z.array(AttemptIdSchema),
  /**
   * `prs`: the pull requests the run's deliveries opened, as the engine's `done` listed them. `version`: what the run
   * file said when the end was kept, so a tick asks the engine again only once it moved.
   */
  done: z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled']), failure: FailureSchema.optional(), prs: z.array(z.string()), version: RunVersionSchema.optional() }).optional(),
});
export type SkillState = z.infer<typeof SkillStateSchema>;

/** The host of a run before the agent answers the host question, as R10 or R19 starts it. */
export type UnansweredHost = Exclude<SkillState['host'], { kind: 'chosen' }>;

/**
 * The state of a run this driver starts to drive for `session`, working in `tool`, from `at` on: nothing open and nothing
 * shown yet, and `judge`, who judges its scored steps on this machine, when anyone does.
 */
export function newSkillState(input: {
  run: RunId; driver: SkillState['driver']; invocation: SkillState['invocation']; options: SkillState['options']; host: UnansweredHost; session: string | undefined; tool: ToolId | undefined; at: string; judge?: JudgedBy;
}): SkillState {
  const { run, driver, invocation, options, host, session, tool, at, judge } = input;
  return {
    version: 1, run, driver, invocation, options, host,
    orchestrator: { ...(session !== undefined ? { session } : {}), ...(tool !== undefined ? { tool } : {}), lastCallAt: at },
    attempts: [], ...judgingState(judge), seq: 0, events: [], seen: {}, settled: [],
  };
}

/** The skill state field of who judges the run on this machine: `judging` for the confined judge, `sessionJudge` for the session. */
function judgingState(judge: JudgedBy | undefined): Pick<SkillState, 'judging' | 'sessionJudge'> {
  if (judge === undefined) return {};
  switch (judge.kind) {
    case 'here':
      return { judging: { tool: judge.tool } };
    case 'session':
      return { sessionJudge: { tool: judge.tool } };
    default: {
      const unhandled: never = judge;
      return unhandled;
    }
  }
}

/** Whether `session` is the one that drives the run of `state`: it passed the run's `invoke` check when it started or took the run. */
export function drivesRun(state: SkillState | undefined, session: string | undefined): boolean {
  return state !== undefined && session !== undefined && state.orchestrator.session === session;
}

export async function readSkillState(config: LocalConfig, run: RunId): Promise<{ kind: 'found'; state: SkillState } | { kind: 'missing' } | { kind: 'unreadable'; reason: string }> {
  const raw = await readFileSafe(skillStatePath(config, run));
  if (raw === null) return { kind: 'missing' };
  try {
    const parsed = SkillStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { kind: 'found', state: parsed.data } : { kind: 'unreadable', reason: parsed.error.issues[0]?.message ?? 'invalid' };
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Saves `state`, masked with `secrets`. Only a holder of the run lock writes it. */
export async function writeSkillState(config: LocalConfig, lock: RunLock, state: SkillState, secrets: Record<string, string>): Promise<void> {
  await writeJsonAtomic(skillStatePath(config, lock.run), redactJson(state, secrets));
}

/** Removes the skill state of the run, so no session drives it from here. Only a holder of the run lock removes it. */
export async function removeSkillState(config: LocalConfig, lock: RunLock): Promise<void> {
  await fs.rm(skillStatePath(config, lock.run), { force: true });
}
