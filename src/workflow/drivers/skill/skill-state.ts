/** `runs/<run>/skill.json`: what the skill driver keeps of a run between calls. This module is its only reader and writer. */
import fs from 'node:fs/promises';
import { z } from 'zod';
import { DriverSchema } from '../../../driver-identity.js';
import { RunModeSchema } from '../../../launch-context.js';
import { toolOf } from '../../../tool-registry.js';
import type { LocalConfig } from '../../../types.js';
import { writeJsonAtomic } from '../../../utils/fs.js';
import { redactJson } from '@teamai/shared/redact';
import type { SessionHostPlaceRequest, RunVersion } from '../../protocol.js';
import { ConfinedRunReportSchema, FailureSchema, TokenUsageSchema } from '../../step-state.js';
import { AttemptIdSchema, RunIdSchema, skillStatePath, type RunId, type RunLock } from '../../store.js';
import { KeptLimitSchema } from '../../usage-limits.js';
import { SESSION_HOST_CHOICES } from './session-host-profiles.js';
import { INVOCATIONS } from './literals.js';
import { HITL_MODES } from './preflight.js';
import type { JudgedBy } from './transitions.js';
import { readRegularFile } from '@teamai/shared/regular-file';


/** A report as the runner sends it, kept before it is sent so a crash between the two loses nothing. */
const ReportBodySchema = z.object({
  attempt: AttemptIdSchema,
  revision: z.number().int(),
  /** `released`: the attempt was stopped, so the protocol abandons its place instead of finishing it. */
  outcome: z.enum(['success', 'failed', 'released']),
  /** A released attempt whose child ran, so its place keeps the child's work. */
  launched: z.literal(true).optional(),
  driver: DriverSchema,
  exitCode: z.number().int().optional(),
  outputs: z.unknown().optional(),
  message: z.string().optional(),
  failure: FailureSchema.optional(),
  /**
   * What a confined run measured: its tool, model, tokens, time and cost, and the run itself, for a run the runner
   * started; its tool and the run, for one a child of the session worked, with that session.
   */
  tool: z.string().optional(),
  session: z.string().optional(),
  /** The session the attempt went on in, when the session that reported is the one its lease continues. */
  resumed: z.object({ tool: z.string(), id: z.string() }).optional(),
  model: z.string().optional(),
  tokens: TokenUsageSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  cost: ConfinedRunReportSchema.shape.usage.unwrap().shape.cost,
  confined: ConfinedRunReportSchema.optional(),
});

export type ReportBody = z.infer<typeof ReportBodySchema>;

/**
 * The model a child must run. `definition`: neither the step nor `defaults.model` named one, so the child runs the team
 * agent's own model, or the session host's default.
 */
const ModelPickSchema = z.union([
  z.object({ by: z.literal('definition') }),
  z.object({ by: z.enum(['step', 'defaults']), name: z.string(), effort: z.string().optional(), alias: z.string().optional() }),
]);

export type ModelPick = z.infer<typeof ModelPickSchema>;

/**
 * A prompt step's work as a child gets it: the place it works in, its brief, and the agent and model it runs as.
 * `person`: an interactive step, which the agent works itself with the person instead of a child. `isolation`: the step
 * requires a sandbox, which no session host enforces.
 */
const DispatchSchema = z.object({
  place: z.enum(['workspace', 'checkout']),
  person: z.literal(true).optional(),
  isolation: z.literal('sandbox').optional(),
  /** The step is confined to `dir`: a fresh child that reads that directory and its brief, and nothing more, works it. */
  confined: z.literal(true).optional(),
  /** The tool the child runs in, the session's when it was dispatched. A dispatch kept before it was recorded has none. */
  tool: z.string().optional(),
  dir: z.string(),
  brief: z.string(),
  agent: z.string().optional(),
  model: ModelPickSchema,
  /** The child of an earlier step whose conversation this step goes on in: the session host sends it the brief when it can reach it. */
  continues: z.object({ title: z.string() }).optional(),
  /** The orchestrating session works the step itself: on a session host that starts no child, or an interactive step. */
  bySession: z.literal(true).optional(),
  /** The session the lease continues, which a report from that same session records as resumed. */
  resumes: z.object({ tool: z.string(), id: z.string() }).optional(),
});

export type Dispatch = z.infer<typeof DispatchSchema>;

/**
 * The name a child runs under, valid as an agent or teammate name (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`): `<step>-<attempt>`,
 * each other character of the step path mapped to `-`, the step cut so the whole fits 64 characters.
 */
export function childTitle(step: string, attempt: string): string {
  const suffix = `-${attempt}`;

  return `${step.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64 - suffix.length)}${suffix}`;
}

/** Why an attempt is stopped: the person cancelled it, or it passed the deadline its lease carries. */
const STOP_REASONS = ['cancelled', 'timeout'] as const;

export type StopReason = typeof STOP_REASONS[number];

/** The place the session host is asked to make for a step: `name` for it, on `branch`, from commit `start`. */
const PlaceAskSchema = z.object({ name: z.string(), branch: z.string(), start: z.string() });

export type PlaceAsk = z.infer<typeof PlaceAskSchema>;

/** Where a runner prepares the place of its attempt when the session host makes it. Absent: where TeamAI makes it. */
const SessionHostRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host') }),
  z.object({ kind: z.literal('adopt'), dir: z.string() }),
]) satisfies z.ZodType<SessionHostPlaceRequest>;

const RunVersionSchema: z.ZodType<RunVersion> = z.object({ status: z.enum(['running', 'succeeded', 'failed', 'cancelled']), revision: z.number().int(), receipts: z.number().int(), creating: z.boolean(), branch: z.string().optional() });

/** `restarts`: how many times C10 started the attempt's runner again after it was gone; absent before the first. */
const AttemptBase = { attempt: AttemptIdSchema, step: z.string(), revision: z.number().int(), spawnedAt: z.string(), expiresAt: z.string().optional(), restarts: z.number().int().positive().optional() };

/**
 * An open attempt: its runner prepares its place or runs its command; it waits for the place another attempt holds;
 * it waits for the agent to adopt a place its session host made; its dispatch is offered to the agent, or acked; it is being
 * stopped, by its runner or by the agent that started its child; or it has a report to send.
 */
const AttemptStateSchema = z.discriminatedUnion('phase', [
  // runs: D28 leased the step to this machine's confined tool, so its runner runs it and offers it to no child.
  z.object({ ...AttemptBase, phase: z.literal('preparing'), request: SessionHostRequestSchema.optional(), runs: z.literal('here').optional() }),
  z.object({ ...AttemptBase, phase: z.literal('queued'), behind: AttemptIdSchema, request: SessionHostRequestSchema.optional() }),
  /** `refused`: why the place the agent adopted last was not prepared. */
  z.object({ ...AttemptBase, phase: z.literal('placing'), ask: PlaceAskSchema, refused: z.string().optional() }),
  z.object({ ...AttemptBase, phase: z.literal('running'), runs: z.literal('here').optional() }),
  /** `reissued`: an earlier session was shown this dispatch, and a child it started may still run. */
  z.object({ ...AttemptBase, phase: z.literal('offered'), dispatch: DispatchSchema, reissued: z.literal(true).optional() }),
  z.object({ ...AttemptBase, phase: z.literal('dispatched'), dispatch: DispatchSchema }),
  /** `child`: the title of the child the agent stops, when it is an earlier step's child this attempt went on in. */
  z.object({ ...AttemptBase, phase: z.literal('stopping'), by: z.enum(['runner', 'agent']), why: z.enum(STOP_REASONS), child: z.string().optional() }),
  /** `stopped`: the report gives up an attempt stopped for this reason. */
  /**
   * `changed`: paths the child result reported, kept so a report sent again still names them. Absent on a report stored
   * before that, and on a command or a setup failure that commits the tree.
   */
  z.object({ ...AttemptBase, phase: z.literal('reporting'), body: ReportBodySchema, tail: z.string().optional(), stopped: z.enum(STOP_REASONS).optional(), changed: z.array(z.string()).optional() }),
]);

export type AttemptState = z.infer<typeof AttemptStateSchema>;

const TurnEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started'), step: z.string(), attempt: AttemptIdSchema }),
  z.object({ kind: z.literal('restarted'), step: z.string(), attempt: AttemptIdSchema }),
  /** This session took the run over from session `from`, when that one was known. */
  z.object({ kind: z.literal('takeover'), from: z.string().optional() }),
  /** The engine cancelled the attempt's lease, or its deadline passed, so its report was not recorded. */
  z.object({ kind: z.literal('stopped'), step: z.string(), attempt: AttemptIdSchema, why: z.enum(STOP_REASONS) }),
  /** The judging of the pass of `step` that `scorers` judge started: run `run`, which scores the pass. */
  z.object({ kind: z.literal('judging'), step: z.string(), scorers: z.array(z.string()), run: RunIdSchema }),
  /** `scorer` labelled the pass of `step` with `label`, or gave it none for `code`, with `label` empty. */
  z.object({ kind: z.literal('judged'), step: z.string(), scorer: z.string(), label: z.string(), code: z.string().optional() }),
  /** This driver judges no more of the run, for `failure`; its open judge steps stay for another driver. */
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
   * The session host of the run, the coding session that drives it with the app it runs in: the key `host` names the
   * session host, and a stored skill state keeps that spelling. `none`: the run has no prompt step. `pending`: the agent has not answered the
   * session host question yet; a run without a prompt step (`hasPromptStep` false) asks it only for its judge, and a state from
   * before it was kept had one. `places: 'host'`: the session host makes the places.
   */
  host: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('pending'), hasPromptStep: z.boolean().default(true) }),
    z.object({ kind: z.literal('chosen'), id: z.enum(SESSION_HOST_CHOICES), children: z.enum(['parallel', 'serial']), places: z.enum(['teamai', 'host']) }),
  ]),
  gate: GateSchema.optional(),
  /**
   * The session that drives the run, when its session host names one, and when it last called. `tool`: the tool that
   * session works in, which `--tools default=<tool>` names or its session host does, so a runner resolves its children's models for it;
   * dropped when this teamai knows no such tool.
   */
  orchestrator: z.object({ session: z.string().optional(), tool: z.string().refine((tool) => toolOf(tool) !== undefined).optional().catch(undefined), lastCallAt: z.string() }),
  attempts: z.array(AttemptStateSchema),
  /**
   * Present while this driver judges the run's scored steps with the confined judge of `tool`, which the background
   * runner starts, at `level`: `verified`, or `best-effort` on a session host that starts no child agent. A state from before
   * the level was kept judged at `verified`.
   */
  judging: z.object({ tool: z.string(), level: ConfinedRunReportSchema.shape.isolation.default('verified') }).optional(),
  /**
   * Present when the session itself judges the run's scored steps once the run is done, as no verified judge of `tool`,
   * the session's tool at the start, is here. The session judges with the run's tool, `orchestrator.tool`, else `tool`.
   */
  sessionJudge: z.object({ tool: z.string() }).optional(),
  /**
   * The runs the passes of this run started, as its `next` and report answers listed them (`started`), which this driver
   * drives as their own runs until each ends, while it judges here or the session does: the pass of `step` that `scorers` judge.
   */
  scoring: z.array(z.object({ run: RunIdSchema, step: z.string(), scorers: z.array(z.string()) })).default([]),
  /** The run whose pass this run scores, which drives it: its turns lead back to that run. */
  scores: RunIdSchema.optional(),
  /** The sequence number of the last event. */
  seq: z.number().int(),
  events: z.array(z.object({ seq: z.number().int(), event: TurnEventSchema })),
  /** The last event each session was shown, by session. */
  seen: z.record(z.string(), z.number().int()),
  /** The attempts the engine settled or stopped: a report that comes for one again is P1. */
  settled: z.array(AttemptIdSchema),
  /** The usage limits the run's tools hit, which hold their steps until each resets, as the local driver's book holds them. */
  usage: z.array(KeptLimitSchema).default([]),
  /**
   * `prs`: the pull requests the run's deliveries opened, as the engine's `done` listed them, and `outputs` the run's
   * declared outputs, as its `done` gave them. `branch`: the branch the run left its changes on, from the run file read
   * as the end came. `version`: what the run file said when the end was kept, so a tick asks the engine again only once
   * it moved.
   */
  done: z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled']), failure: FailureSchema.optional(), prs: z.array(z.string()), outputs: z.record(z.string(), z.json()).optional(), branch: z.string().optional(), version: RunVersionSchema.optional() }).optional(),
});

export type SkillState = z.infer<typeof SkillStateSchema>;

/** The session host of a run before the agent answers the session host question, as R10 or R19 starts it. */
export type UnansweredSessionHost = Exclude<SkillState['host'], { kind: 'chosen' }>;

/**
 * The state of a run this driver starts to drive for `session`, working in `tool`, from `at` on: nothing open and nothing
 * shown yet, and `judge`, who judges its scored steps on this machine, when anyone does.
 */
export function newSkillState(input: {
  run: RunId; driver: SkillState['driver']; invocation: SkillState['invocation']; options: SkillState['options']; sessionHost: UnansweredSessionHost; session: string | undefined; tool: string | undefined; at: string; judge?: JudgedBy;
}): SkillState {
  const { run, driver, invocation, options, sessionHost, session, tool, at, judge } = input;

  const orchestrator: SkillState['orchestrator'] = { lastCallAt: at };

  if (session !== undefined) orchestrator.session = session;

  if (tool !== undefined) orchestrator.tool = tool;

  return {
    version: 1, run, driver, invocation, options, host: sessionHost, orchestrator,
    attempts: [], ...judgingState(judge), scoring: [], seq: 0, events: [], seen: {}, settled: [], usage: [],
  };
}

/**
 * The skill state of `run`, which scores a pass of `scored`'s run, as the first tick that drives it makes it: that run's
 * identity, invocation, options, session host, session and judging, with nothing open yet.
 */
export function scoringSkillState(scored: SkillState, run: RunId, at: string): SkillState {
  const { driver, invocation, options, host, orchestrator, judging, sessionJudge } = scored;

  const state: SkillState = {
    version: 1, run, driver, invocation, options, host, orchestrator: { ...orchestrator, lastCallAt: at }, attempts: [], scoring: [], scores: scored.run, seq: 0, events: [], seen: {}, settled: [], usage: [],
  };

  if (judging) state.judging = { tool: judging.tool, level: judging.level };

  if (sessionJudge) state.sessionJudge = sessionJudge;

  return state;
}

/** The skill state field of who judges the run on this machine: `judging` for the confined judge, `sessionJudge` for the session. */
function judgingState(judge: JudgedBy | undefined): Pick<SkillState, 'judging' | 'sessionJudge'> {
  if (judge === undefined) return {};

  switch (judge.kind) {
    case 'here':
      return { judging: { tool: judge.tool, level: 'verified' } };
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
  const raw = await readRegularFile(skillStatePath(config, run), 'utf8').catch(() => null);

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
