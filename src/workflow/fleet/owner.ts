/**
 * The owner's side of the `fleet` runtime: a `StepRuntime` whose places are this host's, as `local` makes them, and
 * whose exec of a step's command, or prompt of a prompt step, offers the step on teamai-reports. A member of the pool
 * runs it, a prompt on its own tool, model and login, and pushes its work to the attempt's ref; the owner then
 * fast-forwards the place to that work, and the exec or prompt ends as the member's did. Any other exec of the place,
 * such as the workflow's setup, runs here. The owner need not stay up: an exec goes on
 * without the teamai that sent it (`isExecReconnected`), a restarted one sends the same id again and waits on the
 * record again, and a claim whose member wrote no progress for `stale_after` is given up.
 */
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { CANCEL_FAILED, CanSchema, ISOLATION_LEVELS, RuntimeOptionsSchema, WAKE_COMMAND, WORKSPACE_MODES, type OpId, type OpState, type RuntimeFailure, type RuntimeOptions } from '@teamai/runtime-protocol';
import { sanitizeGitUrl } from '@teamai/shared/redact';
import { safeText } from '../../session-flow/session-cmd-shared.js';
import { getRepoIdentity } from '../../session-flow/sync.js';
import { readableReportsWorktree } from '../../utils/reports-branch.js';
import type { LocalConfig } from '../../types.js';
import { log } from '@teamai/shared/log';
import { durationMs } from '../../utils/duration.js';
import { budgetLeft } from '../limits.js';
import { leaseContext } from '../scope.js';
import { answerQuestion, attemptRef, cancelAttempt, expireClaim, isHeld, fleetFailure, lastGoneWork, leaseEnv, leaseInputs, leasePrompt, leaseValues, markOffered, noteWake, offerAttempt, readAttemptRecord, readOfferedMarker, DEFAULT_FLEET_POOL, type Claimed, type FleetError, type FleetLease, type FleetRecord, type FleetResult, type WakeNote } from './record.js';
import { runDefinition } from '../snapshot.js';
import { AttemptIdSchema, installOwner, readRun, RunIdSchema, type AttemptId, type RunId } from '../store.js';
import { workflowRunBy, type WorkflowFailure } from '../types.js';
import type { WholeEnd } from '../whole-workflow.js';
import type { TokenUsage } from '@teamai/tool-core/stdout';
import { isJsonObject } from '@teamai/shared/json';
import { copyGit, placeEditsOf } from '../place/place.js';
import { git } from '../worktree.js';
import { hostStepRuntime } from '../runtimes/host.js';
import { newOpId, type ExecAnswer, type ExecEnd, type ExecEvents, type ExecQuestion, type PromptEnd, type StepRuntime, type WakeEnd } from '@teamai/runtime-protocol/step-runtime';
import type { DriverCan } from '../requirements.js';
import { LAUNCH_TOOLS } from '../../launch-registry.js';
import { DRIVER_ENV_REACH, DriverEnvSchema, LabelSchema } from '../requirements.js';

/** How often the owner reads the attempt's record while a member runs it. */
const RECORD_POLL_MS = 1_000;

/** The longest an owner waits between two reads of a record that did not change: each such read doubles the wait. */
const RECORD_POLL_MAX_MS = 30_000;

/**
 * How long a cancel keeps trying to reach the attempt's record, from when its first write began: longer than
 * `workflow cancel` holds teamai-reports while it publishes the run. Past it, the cancel ends `cancel_failed`.
 */
export const CANCEL_WRITE_MS = 60_000;

const FleetOptionsSchema = z.object({
  pool: z.string().min(1).default(DEFAULT_FLEET_POOL),
  stale_after: z.string().default('30m').transform((text, ctx) => {
    const ms = durationMs(text);

    if (ms !== undefined) return ms;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a positive duration, such as 90s, 30m or 2h' });

    return z.NEVER;
  }),
  /** `env: member`: a member gives each `requires.env` its value from its own team env, so this install needs none. */
  can: CanSchema.extend({ env: DriverEnvSchema.optional() }).optional(),
  /** What the pool's machines declare in their `workflows.labels`: a step that requires them goes to this entry. */
  labels: z.array(LabelSchema).optional(),
  /** The runtime that launches a member of the pool on another machine for an offer no member claimed, with its options. */
  wake: z.object({ use: z.string().min(1), options: RuntimeOptionsSchema.optional() }).strict().optional(),
}).strict();

/** The options of the `fleet` runtime, as `init` checks a runtime's own: its pool, `stale_after` in milliseconds, `can`, `labels` and `wake`. */
export function parseFleetOptions(options: RuntimeOptions): { ok: true; value: z.infer<typeof FleetOptionsSchema> } | { ok: false; failure: { key: string; message: string } } {
  const parsed = FleetOptionsSchema.safeParse(options);

  if (parsed.success) return { ok: true, value: parsed.data };
  const [issue] = parsed.error.issues;

  return { ok: false, failure: { key: issue?.path.join('.') || 'pool', message: issue?.message ?? 'not valid' } };
}

/** The flags a step may need, which an entry that offers them takes it for. */
const NEEDED_FLAGS = ['hitl', 'network', 'tokens', 'max_turns', 'setup', 'end_turn', 'unattended', 'role'] as const;

/** A fleet entry's `can`, with its `labels`. */
type FleetCan = NonNullable<z.infer<typeof FleetOptionsSchema>['can']> & { labels?: readonly string[] };

/**
 * Whether a fleet entry that offers `earlier` takes every step one that offers `later` could take, so the later one never
 * gets a step. What cannot be ordered, the tools, must be the same.
 */
function coversCan(earlier: FleetCan, later: FleetCan): boolean {
  if ((later.labels ?? []).some((label) => !(earlier.labels ?? []).includes(label))) return false;

  if (NEEDED_FLAGS.some((flag) => later[flag] === true && earlier[flag] !== true)) return false;

  // A runtime runs commands unless it says it does not.
  if (later.exec !== false && earlier.exec === false) return false;

  if (ISOLATION_LEVELS.indexOf(later.isolation ?? 'none') > ISOLATION_LEVELS.indexOf(earlier.isolation ?? 'none')) return false;

  if (DRIVER_ENV_REACH.indexOf(later.env ?? false) > DRIVER_ENV_REACH.indexOf(earlier.env ?? false)) return false;

  // A fleet offers no confined offer (init): an entry's `can.confined` tells two entries apart in nothing.
  return isDeepStrictEqual(earlier.tools, later.tools);
}

/**
 * A warning for each fleet entry of `runtimes`, a driver definition's, that an earlier fleet entry shadows: the first
 * entry whose `can` fits a step takes it, so an entry whose `can` an earlier one covers never gets one. An entry whose
 * options do not parse is left to its own check.
 */
export function shadowedFleetEntries(runtimes: ReadonlyArray<{ use: string; through?: string; options?: RuntimeOptions }>): string[] {
  const seen: Array<{ pool: string; can: FleetCan }> = [];
  const warnings: string[] = [];

  for (const entry of runtimes) {
    if (entry.use !== 'fleet' || entry.through !== undefined) continue;
    // What teamai takes for itself (`engineOptions`) never reaches the runtime's own check.
    const { max_parallel: _parallel, credentials: _credentials, ...options } = entry.options ?? {};
    const parsed = parseFleetOptions(options);

    if (!parsed.ok) continue;
    const { pool, can: offered = {}, labels } = parsed.value;
    const can = labels ? { ...offered, labels } : offered;
    const earlier = seen.find((one) => coversCan(one.can, can));

    if (earlier) {
      const fix = coversCan(can, earlier.can)
        ? 'The two offer the same, so the first takes every step: remove one, or make them offer different things.'
        : `Put the fleet entry for pool "${pool}", which offers less, before the one for pool "${earlier.pool}".`;

      warnings.push(`The fleet entry for pool "${pool}" never gets a step: the fleet entry for pool "${earlier.pool}" before it offers everything it does, and takes each step first. ${fix}`);
    }

    seen.push({ pool, can });
  }

  return warnings;
}

/** How the owner's wait on an attempt ended: as the member's step did, cancelled, failed, or left out as this teamai stops. */
type Waited =
  | { kind: 'finished'; result: FleetResult }
  | { kind: 'cancelled'; message: string; tokens?: TokenUsage }
  | { kind: 'failed'; failure: WorkflowFailure }
  | { kind: 'left' };

/**
 * Opens the runtime a fleet entry's `options.wake` names, on its own and never through another, as the driver opens its
 * runtimes: `wakes` when its `init` offered `wake`.
 */
export type OpenWake = (entry: { use: string; options: RuntimeOptions }) => Promise<{ ok: true; runtime: StepRuntime<DriverCan>; wakes: boolean } | { ok: false; failure: WorkflowFailure }>;

/** The runtime a fleet entry wakes members through, by the name its entry gave. */
type Waker = { use: string; runtime: StepRuntime<DriverCan>; wake: NonNullable<StepRuntime<DriverCan>['wake']> };

/** The place of an attempt on the fleet: its handle names the run and the attempt, so a restarted teamai reads it again. */
type FleetPlace = { run: RunId; attempt: AttemptId };

function placeHandle({ run, attempt }: FleetPlace): string {
  return `fleet-${run}-${attempt}`;
}

function placeOf(handle: string): FleetPlace | undefined {
  const [, run, attempt] = /^fleet-([^-]+)-([^-]+)$/.exec(handle) ?? [];
  const parsedRun = RunIdSchema.safeParse(run);
  const parsedAttempt = AttemptIdSchema.safeParse(attempt);

  return parsedRun.success && parsedAttempt.success ? { run: parsedRun.data, attempt: parsedAttempt.data } : undefined;
}

/**
 * Whether the record ended with work its member pushed, which only the owner's wait takes into the place: a teamai that
 * did not see the end has not taken it.
 */
function hasWorkToTake(record: FleetRecord): boolean {
  switch (record.state) {
    case 'finished': return record.result.to !== undefined;
    case 'cancelled':
    case 'expired': return record.pushed !== record.start;
    case 'offered':
    case 'claimed':
    case 'asking':
    case 'answered':
    case 'cancelling':
    case 'withdrawn': return false;
    default: {
      const unhandled: never = record;

      return unhandled;
    }
  }
}

/**
 * What a record says of the exec that offered it, to a teamai that did not see it end. An end with work still to take
 * reports `running` while `isTaking`: the same op sent again waits on the record, which takes the work before it ends.
 */
function recordState(op: OpId, record: FleetRecord | 'absent', { isTaking }: { isTaking: boolean }): OpState {
  if (record === 'absent' || (isTaking && hasWorkToTake(record))) return { op, state: 'running' };

  switch (record.state) {
    case 'offered':
    case 'claimed':
    case 'asking':
    case 'answered':
      return { op, state: 'running' };
    // The member was asked to stop, and nothing of the step runs on this machine: the record ends cancelled or expired.
    case 'cancelling':
    case 'withdrawn':
      return { op, state: 'cancelled' };
    // A whole workflow ends with what its steps spent before it stopped, as the live end gives it.
    case 'cancelled':
      return record.lease.kind === 'workflow' && record.tokens ? { op, state: 'cancelled', stdout: cancelledWholeStdout(cancelledMessage(record), record.tokens) } : { op, state: 'cancelled' };
    case 'finished':
      return finishedState(op, record);

    case 'expired':
      return { op, state: 'failed', failure: { code: 'fleet_member_gone', message: `The fleet member ${record.member.user} that took step "${record.lease.step}" stopped writing progress, so the attempt was given up.` } };
    default: {
      const unhandled: never = record;

      return unhandled;
    }
  }
}

/** What a cancelled record says the member did, for the person. */
function cancelledMessage(record: Extract<FleetRecord, { state: 'cancelled' }>): string {
  return `Step "${record.lease.step}" was cancelled, and the fleet member ${record.member.user} that ran it stopped it.${record.pushed === record.start ? '' : ` Its work up to ${record.pushed} is kept.`}`;
}

/** The stdout of a whole workflow step that ended cancelled: what its steps spent before it stopped, which the budgets around the step count. */
function cancelledWholeStdout(message: string, tokens: TokenUsage): string {
  return JSON.stringify({ outcome: 'failed', failure: { code: 'cancelled', message }, tokens } satisfies WholeEnd);
}

/** What a finished record says of the exec that offered it: a command or a whole workflow exited, a prompt finished or failed. */
function finishedState(op: OpId, { lease, result, attempt }: Extract<FleetRecord, { state: 'finished' }>): OpState {
  switch (lease.kind) {
    case 'command': return { op, state: 'exited', code: result.exitCode, stdout: result.outputs === undefined ? '' : JSON.stringify(result.outputs) };
    case 'workflow': return { op, state: 'exited', code: result.exitCode, stdout: JSON.stringify(wholeEnd(result)) };
    case 'prompt': {
      const ended = promptEnded(result, attempt);

      return ended.kind === 'finished' ? { op, state: 'finished', session: ended.session, result: ended.result, ...(ended.usage && { usage: ended.usage }) } : { op, state: 'failed', failure: ended.failure };
    }

    default: {
      const unhandled: never = lease;

      return unhandled;
    }
  }
}

/** How a whole workflow a member finished ended, as the fleet's exec answers it on stdout. */
function wholeEnd(result: FleetResult): WholeEnd {
  const outputs = result.outputs !== undefined && isJsonObject(result.outputs) ? result.outputs : undefined;

  return {
    outcome: result.exitCode === 0 && result.failure === undefined ? 'succeeded' : 'failed',
    ...(result.end !== undefined && { end: result.end }), ...(outputs !== undefined && { outputs }), ...(result.failure && { failure: result.failure }),
    ...(result.tokens !== undefined && { tokens: result.tokens }),
  };
}

/**
 * How a prompt a member finished ends for the owner: with the tool it picked and the result and usage it wrote, or, when
 * it launched no tool, as the failure that stopped it. Its session is the one the member pushed to the team session
 * archive; a member that named none leaves `attempt` in its place, which no later step finds to continue.
 */
function promptEnded(result: FleetResult, attempt: AttemptId): Extract<PromptEnd, { kind: 'finished' | 'failed' }> {
  if (result.tool === undefined) return { kind: 'failed', failure: result.failure ?? { code: 'tool_failed', message: result.stderr || 'The fleet member launched no tool for the prompt step.' } };

  return {
    kind: 'finished', session: { tool: result.tool, id: result.session ?? attempt },
    result: { ...(result.outputs !== undefined && { output: result.outputs }), ...(result.failure && { failure: result.failure }) },
    ...(result.tokens && { usage: result.tokens }),
  };
}

/**
 * The `fleet` runtime of this install: each step's command or prompt it takes is offered to the members of its pool. `masks`
 * holds the values an offer may not carry, which the drive adds to as it resolves the team's secrets. `openWake` opens
 * the runtime an entry's `options.wake` names: without it, an entry that sets one fails `init`.
 */
export function fleetStepRuntime({ config, masks, openWake }: { config: LocalConfig; masks: Record<string, string>; openWake?: OpenWake }): StepRuntime<DriverCan> {
  const local = hostStepRuntime({ config });

  // The same place on `local`, which runs every exec that is not the step's command: opened there, so the process group
  // of each exec it runs is recorded in the attempt's directory, where a restarted teamai's stop finds it.
  const localHandle = async ({ run, attempt }: FleetPlace): Promise<{ handle: string } | { failure: RuntimeFailure }> => {
    const opened = await local.open({ op: newOpId(), run, attempt, credentials: {} }, async () => undefined);

    return opened.kind === 'ready' ? { handle: opened.handle } : { failure: opened.failure };
  };

  const disposing = new AbortController();
  // The wait of each exec this teamai sent, by its id, so a repeated id reconnects to it and a cancel reaches it.
  const waits = new Map<OpId, { place: FleetPlace; cancel: AbortController; end: Promise<Waited>; isWhole: boolean }>();
  // The exec of each place a restarted teamai read, so a cancel of it with no wait here reaches its record.
  const seen = new Map<OpId, FleetPlace>();
  // The execs of `seen` a cancel reached: the work their members pushed is not taken, so their record's end is theirs.
  const cancelled = new Set<OpId>();
  let settings: { pool: string; staleAfterMs: number; root: string; waker?: Waker } | undefined;

  // A whole workflow's exec answers how its nested run ended on stdout (`WholeEndSchema`).
  const ended = (waited: Waited, events: ExecEvents, isWhole = false): ExecEnd => {
    switch (waited.kind) {
      case 'finished': {
        const { result } = waited;

        if (result.stderr !== '') events.onOutput?.('stderr', result.stderr);

        if (isWhole) return { kind: 'exited', code: result.exitCode, stdout: JSON.stringify(wholeEnd(result)) };

        return { kind: 'exited', code: result.exitCode, stdout: result.outputs === undefined ? '' : JSON.stringify(result.outputs) };
      }

      case 'cancelled':
        events.onOutput?.('stderr', waited.message);

        // What a whole workflow's steps spent before it stopped, which the budgets around the step count.
        return isWhole && waited.tokens ? { kind: 'cancelled', stdout: cancelledWholeStdout(waited.message, waited.tokens) } : { kind: 'cancelled' };
      case 'failed':
        return { kind: 'failed', failure: waited.failure, isStepOutcome: true };
      // Only a disposed runtime ends a wait this way, once its teamai no longer reads the exec.
      case 'left':
        return { kind: 'failed', failure: { code: 'runtime_interrupted', message: 'teamai stopped while the step waited on a fleet member; the attempt stays out for a later teamai workflow resume.' } };
      default: {
        const unhandled: never = waited;

        return unhandled;
      }
    }
  };

  const promptEnd = (waited: Waited, attempt: AttemptId): PromptEnd => {
    if (waited.kind === 'finished') return promptEnded(waited.result, attempt);
    const end = ended(waited, {});

    return end.kind === 'exited' ? { kind: 'failed', failure: { code: 'runtime_protocol', message: 'The fleet ended a prompt as a command.' } } : end;
  };

  /** Offers step `lease` of `place` from the place `dir` under id `op`, and waits for the member that takes it. */
  const offerLease = async ({ place, lease, dir, op, ask }: { place: FleetPlace; lease: FleetLease; dir: string; op: OpId; ask?: ExecEvents['ask'] }, onAccepted: () => void): Promise<Waited> => {
    if (!settings) return { kind: 'failed', failure: { code: 'runtime_protocol', message: 'The fleet runtime was not initialized.' } };
    const cancel = new AbortController();
    const end = offerAndWait({ config, ...place, ...settings, lease, dir, secrets: masks, op, ask }, { cancel: cancel.signal, leave: disposing.signal });
    waits.set(op, { place, cancel, end, isWhole: lease.kind === 'workflow' });
    onAccepted();

    try {
      return await end;
    } finally {
      waits.delete(op);
    }
  };

  return {
    name: 'fleet',
    isExecReconnected: true,
    isToolPickedThere: true,

    async init({ options, mode, checkout }) {
      const parsed = parseFleetOptions(options);

      if (!parsed.ok) return { ok: false, failure: { code: 'bad_option', ...parsed.failure } };
      // No person sits at a member's tool, whatever the entry promises, so no interactive step goes to the fleet. Nor does
      // a confined one: its directory lives under this machine's $TEAMAI_RUN_DIR, which no commit a member fetches
      // carries, so the fleet answers no confined prompt and, like a runtime that says so, offers no `confined`.
      const { pool, stale_after: staleAfterMs, can: { hitl: _hitl, confined: _unreachable, ...can } = {}, labels, wake } = parsed.value;
      // Opened only to stop and close what it ran, it offers nothing, so it wakes no one.
      const waking = wake === undefined || mode === 'recover' ? undefined : await openWaker(wake, openWake);

      if (waking !== undefined && 'failure' in waking) return { ok: false, failure: waking.failure };
      settings = { pool, staleAfterMs, root: checkout ?? process.cwd(), ...(waking && { waker: waking.waker }) };

      // A step's place is this host's, so the fleet offers the workspaces this machine does. A member runs a prompt on a
      // tool of its own, so the fleet takes a prompt step on any tool unless its entry names the tools its pool has. A
      // member drives a whole workflow's steps itself, so the fleet takes a workflow step whole when its steps fit. The
      // member launches each prompt's agent on its own tool (`launchesAgents`), so the local driver keeps the fleet's tools
      // rather than the ones a tool home holds.
      return { ok: true, can: { ...can, tools: can.tools ?? [...LAUNCH_TOOLS], remote: true, workspace: [...WORKSPACE_MODES], workflow: true, ...(labels && { labels }) }, launchesAgents: true };
    },

    async open(request, onAccepted) {
      const handle = placeHandle({ run: RunIdSchema.parse(request.run), attempt: AttemptIdSchema.parse(request.attempt) });
      await onAccepted(handle);

      return { kind: 'ready', handle };
    },

    async exec(request, events, kind) {
      const place = placeOf(request.handle);

      if (!place || !settings) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `The fleet runtime has no place ${request.handle}${settings ? '' : ', or was not initialized'}.` } };
      const accepted = (): void => events.onAccepted?.({});

      const live = waits.get(request.op);

      if (live) {
        accepted();

        return ended(await live.end, events, live.isWhole);
      }

      // Setup, or any exec besides the step's command or a whole workflow, runs in the place on this host.
      if (kind !== 'command' && kind !== 'workflow') {
        const here = await localHandle(place);

        return 'failure' in here ? { kind: 'failed', failure: here.failure } : local.exec({ ...request, handle: here.handle }, events, kind);
      }

      const leased = await leasedStep(config, place);

      if ('error' in leased) return { kind: 'failed', failure: { code: leased.isFatal ? 'run_unreadable' : 'runtime_protocol', message: leased.error } };
      const isWhole = leased.kind === 'workflow';

      if (leased.kind !== kind) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Attempt ${place.attempt} of run ${place.run} leases no ${kind === 'workflow' ? 'whole workflow' : 'command step'}.` } };

      return ended(await offerLease({ place, lease: leased, dir: request.cwd, op: request.op, ask: events.ask }, accepted), events, isWhole);
    },

    // The member picks the tool, model and login and renders the prompt itself: what the request names of them is this
    // host's, and is not sent.
    async prompt(request, events) {
      const place = placeOf(request.handle);

      if (!place || !settings) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `The fleet runtime has no place ${request.handle}${settings ? '' : ', or was not initialized'}.` } };
      const accepted = (): void => events.onAccepted?.({});
      const live = waits.get(request.op);

      if (live) {
        accepted();

        return promptEnd(await live.end, place.attempt);
      }

      const leased = await leasedStep(config, place);

      if ('error' in leased) return { kind: 'failed', failure: { code: leased.isFatal ? 'run_unreadable' : 'runtime_protocol', message: leased.error } };

      if (leased.kind !== 'prompt') return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Attempt ${place.attempt} of run ${place.run} leases no prompt step.` } };

      return promptEnd(await offerLease({ place, lease: leased, dir: request.cwd, op: request.op }, accepted), place.attempt);
    },

    async cancel(op) {
      const live = waits.get(op);

      if (live) {
        live.cancel.abort();
        await live.end;

        return;
      }

      const place = seen.get(op);

      if (!place) {
        await local.cancel(op);

        return;
      }

      // A teamai before this one offered it: only the attempt's record reaches its member.
      const asked = await cancelFleetAttempt(config, place.run, place.attempt);

      if (asked.ok) {
        cancelled.add(op);
        log.info(asked.message);
      } else log.warn(asked.message);
    },

    // The place is this host's, which the wait already gave the member's work.
    async collect() {
      return { ok: true };
    },

    async reattach(handle) {
      const place = placeOf(handle);

      if (!place) return { kind: 'gone' };
      const offered = await offeredExec(config, place);

      if (offered === undefined) return { kind: 'alive', ops: [] };
      seen.set(offered, place);
      const read = await readAttemptRecord(config, place.run, place.attempt);

      if (!read.ok) return { kind: 'failed', failure: { code: read.error.code, message: read.error.message } };

      return { kind: 'alive', ops: [recordState(offered, read.value, { isTaking: !cancelled.has(offered) })] };
    },

    async close(handle) {
      const place = placeOf(handle);

      const here = place && await localHandle(place);

      return here === undefined || 'failure' in here ? { ok: true } : local.close(here.handle);
    },

    async dispose() {
      disposing.abort();
      await Promise.all([...waits.values()].map(async (wait) => wait.end));
      await Promise.all([local.dispose(), settings?.waker?.runtime.dispose()]);
    },
  };
}

/**
 * The step leased with attempt `attempt` as the fleet offers it: its command, or the prompt and the limits it was
 * granted, with its env, as a member renders them from the offer's values. Or why there is none: `isFatal` when the run
 * cannot be read at all.
 */
async function leasedStep(config: LocalConfig, { run, attempt }: FleetPlace): Promise<FleetLease | { error: string; isFatal: boolean }> {
  const state = await readRun(config, run);

  if (state === 'missing' || state === 'corrupt') return { error: `Run ${run} is ${state} here, so its step was not offered to the fleet.`, isFatal: true };
  const step = state.steps.find((item) => item.status === 'leased' && item.lease.attempt === attempt);
  const leased = step?.status === 'leased' ? leaseContext(state, step.id) : undefined;

  if (!step || step.status !== 'leased' || !leased || (leased.step.command === undefined && leased.step.workflow === undefined && (leased.step.prompt === undefined || leased.step.answer !== undefined))) {
    return { error: `Attempt ${attempt} of run ${run} leases no command, prompt or workflow step.`, isFatal: false };
  }

  const values = leaseValues(leased.step, leased.context);

  if ('error' in values) return { error: values.error, isFatal: true };

  if (leased.step.workflow !== undefined) {
    const child = workflowRunBy(state, leased.step, '');

    if (child === undefined) return { error: `Run ${run} step "${step.id}" runs a workflow this run did not keep.`, isFatal: true };
    const inputs = leaseInputs(leased.step, child, values.values, run);

    if ('error' in inputs) return { error: `Step "${step.id}" ${inputs.error}`, isFatal: true };
    const tokens = budgetLeft(state, step.id);

    return { kind: 'workflow', step: step.id, inputs: inputs.inputs, env: {}, ...(tokens !== undefined && { budget: { tokens } }) };
  }

  const env = leaseEnv(leased.step, values.values, run);

  if ('error' in env) return { error: env.error, isFatal: true };

  if (leased.step.command !== undefined) return { kind: 'command', step: step.id, command: leased.step.command, env: env.env };
  const texts = leasePrompt(leased.step, values.values, run);

  if ('error' in texts) return { error: texts.error, isFatal: true };
  const { limits } = step.lease;

  return { kind: 'prompt', step: step.id, prompt: texts.prompt, env: env.env, ...(limits !== undefined && { limits }) };
}

/** The id of the exec that offered the attempt at `place` from this install, recorded with its pool. */
async function offeredExec(config: LocalConfig, place: FleetPlace): Promise<OpId | undefined> {
  return (await readOfferedMarker(config, place.run, place.attempt))?.op;
}

type WaitInput = {
  config: LocalConfig; run: RunId; attempt: AttemptId; pool: string; staleAfterMs: number; lease: FleetLease; root: string; dir: string;
  secrets: Record<string, string>; op: OpId;
  /** Wakes a member of the pool for the offer while no member claimed it. */
  waker?: Waker;
  /** Asks this driver's person a gate the member's whole workflow reached. Absent: nobody answers here. */
  ask?: ExecEvents['ask'];
};

/**
 * Offers step `lease` of attempt `attempt` to pool `pool`, from the place `dir`, a copy of checkout `root`, unless
 * an earlier drive offered it, and settles once a member finished it, with the result it wrote, after the place took the
 * commits the member pushed. `secrets` are the
 * values the offer may not carry. `cancel`: the run cancelled the step, which the owner writes into the record and waits
 * for the member to answer. `leave`: this teamai stops, and the attempt stays out for a later `workflow resume <run>`.
 */
async function offerAndWait(input: WaitInput, signals: { cancel: AbortSignal; leave: AbortSignal }): Promise<Waited> {
  const wake = input.waker && wakeOnOffer({ config: input.config, run: input.run, attempt: input.attempt, root: input.root, waker: input.waker });

  try {
    return await waitOnOffer(input, signals, wake);
  } finally {
    await wake?.stop();
  }
}

/** `offerAndWait`, which shows `wake` each record it reads. */
async function waitOnOffer(input: WaitInput, { cancel, leave }: { cancel: AbortSignal; leave: AbortSignal }, wake: WakeOnOffer | undefined): Promise<Waited> {
  const { config, run, attempt, lease, root, dir, secrets, op, ask } = input;
  const { step } = lease;
  const failed = (failure: WorkflowFailure): Waited => ({ kind: 'failed', failure });
  const ref = attemptRef(run, attempt);
  const earlier = await readAttemptRecord(config, run, attempt);

  if (!earlier.ok) return failed(fleetFailure(earlier.error));
  // An attempt offered before waits on the pool and stale_after its offer named, and one this exec noted but a killed
  // teamai never wrote is offered as noted, whatever fleet entry reached it now.
  const noted = earlier.value === 'absent' ? await readOfferedMarker(config, run, attempt) : undefined;
  const { pool, staleAfterMs } = earlier.value !== 'absent' ? earlier.value : noted?.op === op ? { pool: noted.pool, staleAfterMs: noted.staleAfterMs ?? input.staleAfterMs } : input;

  if (earlier.value === 'absent') {
    const repository = getRepoIdentity(root);

    if (repository === null) return failed({ code: 'origin_unavailable', message: `${root} has no origin, so no fleet member can take step "${step}". Add origin, or run the step on another runtime.` });
    // A member renders the step itself from the run's definitions and these values; the lease it is checked against.
    const state = await readRun(config, run);
    const leased = state === 'missing' || state === 'corrupt' ? undefined : leaseContext(state, step);

    if (state === 'missing' || state === 'corrupt' || leased === undefined) return failed({ code: 'run_unreadable', message: `Run ${run} has no definition for step "${step}" here, so it was not offered to the fleet.` });
    const values = leaseValues(leased.step, leased.context);

    if ('error' in values) return failed({ code: 'invalid_template', message: values.error });
    const resumed = await goOnFromGoneWork({ config, run, root, dir, step });

    if (resumed) return failed(resumed);
    const started = await startOf({ config, run, attempt, root, dir, step });

    if ('code' in started) return failed(started);
    const { start } = started;
    // The checkout's own git pushes: the copy shares its objects, and a step may have written the copy's config.
    const pushed = await git(root, ['push', '--quiet', 'origin', `${start}:${ref}`]);

    if (pushed.code !== 0) return failed({ code: 'push_failed', message: `Step "${step}" could not push its start commit to ${ref} on origin, so no fleet member can take it: ${pushed.stderr.trim()}` });
    await markOffered(config, run, attempt, pool, { op, staleAfterMs });
    // A member reads the step's labels from its own copy of the workflow, so the record carries none.
    const offered = await offerAttempt(config, { run, attempt, pool, repository, owner: await installOwner(config), start, staleAfterMs, lease, definition: runDefinition(state), values: values.values, secrets });

    if (!offered.ok) return failed(fleetFailure(offered.error));
  }

  // Staleness counts on this machine's clock, from when it last saw the record change: a member's clock may be off. A
  // cancel goes through the record, and waits for the member's answer as long as for its progress.
  let lastSeen: { write: string; at: number } | undefined;

  // The cancel `cancel` asks for, once this wait saw it: when it saw it, on this machine's clock; then when the first
  // cancel write began, a write that did not land being tried again until CANCEL_WRITE_MS after it; then the cancel that
  // landed over a member's claim, which the member answers. A withdraw that landed ends the wait.
  let cancelling:
    | { readonly kind: 'seen'; readonly at: number }
    | { readonly kind: 'trying'; readonly since: number }
    | { readonly kind: 'landed'; readonly record: Extract<FleetRecord, { state: 'cancelling' }> }
    | undefined;

  // The gate the member asks, put to this driver's person once: `answer` once the person answered.
  let asked: Asked | undefined;
  // Each reason a member gave on the offer for leaving it, shown once, by member and reason.
  const shownLeft = new Set<string>();
  // A record that does not change is read less often, down to a third of stale_after, so a staleness is seen in time.
  const slowestPollMs = Math.min(RECORD_POLL_MAX_MS, Math.max(RECORD_POLL_MS, Math.floor(staleAfterMs / 3)));
  let pollMs = RECORD_POLL_MS;
  const withdrawn: Waited = { kind: 'cancelled', message: `Step "${step}" was cancelled before a member of fleet pool ${pool} took it.` };

  for (;;) {
    if (leave.aborted) return { kind: 'left' };
    const read = await readAttemptRecord(config, run, attempt);

    if (read.ok) await wake?.seen(read.value);

    if (!read.ok && (read.error.code === 'fleet_record_unreadable' || read.error.code === 'fleet_record_newer')) return failed(fleetFailure(read.error));
    const record = read.ok && read.value !== 'absent' ? read.value : undefined;

    if (record?.state === 'finished') {
      const { result } = record;
      const taken = result.to === undefined ? undefined : await takeWork({ config, run, root, dir, ref, to: result.to, step });

      if (taken) return failed(taken);

      return { kind: 'finished', result };
    }

    if (record?.state === 'expired') return failed(await gone(record, { config, run, root, dir, ref, staleAfterMs }));

    if (record?.state === 'withdrawn') return withdrawn;

    if (record?.state === 'cancelled') {
      const taken = record.pushed === record.start ? undefined : await takeWork({ config, run, root, dir, ref, to: record.pushed, step });

      if (taken) return failed(taken);

      return { kind: 'cancelled', message: cancelledMessage(record), ...(record.tokens && { tokens: record.tokens }) };
    }

    for (const { member, why } of record?.state === 'offered' ? record.left ?? [] : []) {
      const key = `${member.id}\u0000${why}`;

      if (shownLeft.has(key)) continue;
      shownLeft.add(key);
      // Both come from another machine's write.
      log.warn(`Fleet member ${safeText(member.user)} left step "${step}" of run ${run} for another member of pool ${pool}: ${safeText(why)}. The step waits for a member that can run it; to stop waiting, run teamai workflow cancel ${run}.`);
    }

    if (record !== undefined && record.write !== lastSeen?.write) {
      lastSeen = { write: record.write, at: Date.now() };
      pollMs = RECORD_POLL_MS;
    }

    // A question closes once a read shows the record no longer asks it: the member read the answer, or the claim ended.
    // A read that failed shows nothing, and the person's answer, given or on its way, is kept for the next.
    if (asked !== undefined && read.ok && (record === undefined || (record.state !== 'asking' && record.state !== 'answered') || JSON.stringify(record.question) !== asked.question)) {
      asked.closed.abort();
      asked = undefined;
    }

    if (record?.state === 'asking' && asked === undefined) asked = askPerson(record.question, ask, { step, member: record.member.user });

    // The answer goes over what the record holds now, which still asks it: the member's progress may have landed meanwhile.
    if (record?.state === 'asking' && asked?.answer !== undefined) {
      const written = await answerQuestion(config, record, asked.answer, secrets);

      // Once written, the answer is spent: the member asking the same again, as when its run did not take the answer,
      // asks the person again.
      if (written.ok) {
        asked = undefined;
        continue;
      }

      const { error } = written;

      switch (error.code) {
        // The member's progress landed first: the answer goes over the record read next.
        case 'state_moved':
          continue;
        // teamai-reports was busy or out of reach: the answer is kept and written at the next poll, while the member waits.
        case 'reports_failed':
        case 'reports_unreachable':
          break;
        // The person's note holds a secret or a local path, which teamai-reports must not: the person answers again.
        case 'fleet_unpublishable':
          log.warn(`${error.message} Answer the question of step "${step}" again, with no secret or local path in the note.`);
          asked.closed.abort();
          asked = undefined;
          continue;
        case 'fleet_record_unreadable':
        case 'fleet_record_newer':
          return failed(fleetFailure(error));
        default: {
          const unhandled: never = error;

          return unhandled;
        }
      }
    }

    if ((record !== undefined && (isHeld(record) || record.state === 'cancelling')) && lastSeen !== undefined && Date.now() - lastSeen.at > staleAfterMs) {
      const expired = await expireClaim(config, record);

      // The member wrote meanwhile: it is still there.
      if (expired.ok) return failed(await gone(expired.value, { config, run, root, dir, ref, staleAfterMs }));

      if (expired.error.code !== 'state_moved') return failed(fleetFailure(expired.error));
      continue;
    }

    // A cancel that landed waits for its member's answer as long as for its progress: past stale_after with no read of
    // the record, whether the member stopped is not known, so the wait ends and keeps the place for `workflow cancel`.
    if (cancelling?.kind === 'landed' && record === undefined && lastSeen !== undefined && Date.now() - lastSeen.at > staleAfterMs) {
      const stopAsked = `Step "${step}" was cancelled: its member ${safeText(cancelling.record.member.user)} was asked to stop it, and the record of attempt ${attempt}`;

      return failed({
        code: CANCEL_FAILED,
        message: read.ok
          ? `${stopAsked} is no longer on teamai-reports, so whether the member stopped is not known. The attempt's place and records are kept. Run teamai workflow cancel ${run} again once its member stopped.`
          : `${stopAsked} on teamai-reports could not be read for ${staleAfterMs / 1_000} s since, so whether the member stopped is not known. ${cancelWriteCause(read.error)} The attempt's place and records are kept. Once origin can be read, run teamai workflow cancel ${run} again.`,
      });
    }

    if (cancel.aborted && cancelling?.kind !== 'landed') {
      const pending = cancelling ?? { kind: 'seen', at: Date.now() };
      cancelling = pending;

      // A read that failed shows nothing: the cancel is written once a read shows the record again, for as long as a
      // member's answer is waited on, so the offer does not stay out for a member to take.
      if (record === undefined) {
        if (read.ok) return failed({ code: 'runtime_interrupted', message: `Step "${step}" was cancelled, and its attempt has no record on fleet pool ${pool}, so no member was asked to stop it.` });

        // A cancel write already tried keeps its deadline, and only it, while origin cannot be read: the place stays kept.
        if (pending.kind === 'trying') {
          if (Date.now() >= pending.since + CANCEL_WRITE_MS) return failed(cancelNotWritten({ step, run, attempt, pool }, read.error));
        } else if (Date.now() - pending.at > staleAfterMs) {
          // A member may still take the offer, so the place stays kept for the next `workflow cancel`, as at the deadline.
          return failed({ code: CANCEL_FAILED, message: `Step "${step}" was cancelled, and the record of its attempt on fleet pool ${pool} could not be read for ${staleAfterMs / 1_000} s, so no member was asked to stop it, and a member may still take its offer. ${cancelWriteCause(read.error)} The attempt's place and records are kept. Run teamai workflow cancel ${run} again.` });
        }
      } else if (record.state === 'offered' || isHeld(record)) {
        const since = pending.kind === 'trying' ? pending.since : Date.now();
        cancelling = { kind: 'trying', since };
        const until = since + CANCEL_WRITE_MS;
        // A publish of this install holding teamai-reports, as `workflow cancel` does, is waited for.
        const written = await cancelAttempt(config, record, { until, signal: leave });

        if (written.ok) {
          // A withdraw is final: no member takes an offer once it landed, so the cancel ends at the write.
          if (written.value.state === 'withdrawn') return withdrawn;
          cancelling = { kind: 'landed', record: written.value };
          lastSeen = { write: written.value.write, at: Date.now() };
          continue;
        }

        const { error } = written;

        switch (error.code) {
          // Another write landed first, such as the member's progress, or teamai-reports was held or out of reach: the
          // cancel is written over what is read next, or at the next poll, so the offer does not stay out for a member
          // to take, until the deadline. Past it, the member is not known to have been asked to stop.
          case 'state_moved':
          case 'reports_failed':
          case 'reports_unreachable':
            if (Date.now() >= until && !leave.aborted) return failed(cancelNotWritten({ step, run, attempt, pool }, error));

            if (error.code === 'state_moved') continue;
            break;
          case 'fleet_unpublishable':
          case 'fleet_record_unreadable':
          case 'fleet_record_newer': return failed(fleetFailure(error));
          default: {
            const unhandled: never = error;

            return unhandled;
          }
        }
      }
    }

    // An answer kept from a failed write waits for the next poll, not for the person.
    const woken = AbortSignal.any([cancel, leave, ...(asked !== undefined && asked.answer === undefined ? [asked.answered.signal] : [])]);

    // A cancel write that is due is tried again at the shortest poll, so its deadline is kept.
    if (cancelling?.kind === 'trying' && record?.state !== 'cancelling') pollMs = RECORD_POLL_MS;
    await sleep(pollMs, undefined, cancel.aborted ? { signal: leave } : { signal: woken }).catch(() => undefined);
    pollMs = Math.min(pollMs * 2, slowestPollMs);
  }
}

/** The failure a cancel ends with when it could not be written into the attempt's record by the deadline, for `error`. */
function cancelNotWritten({ step, run, attempt, pool }: Pick<WaitInput, 'run' | 'attempt' | 'pool'> & { step: string }, error: FleetError): WorkflowFailure {
  return {
    code: CANCEL_FAILED,
    message: `Step "${step}" was cancelled, and its cancel could not be written to the record of attempt ${attempt} on teamai-reports for ${CANCEL_WRITE_MS / 1_000} s, so a member of fleet pool ${pool} may still take or run it. ${cancelWriteCause(error)} The attempt's place and records are kept. Run teamai workflow cancel ${run} again.`,
  };
}

/** Why the last write of a cancel did not land, for the person, whose next step the cancel's message gives instead. */
function cancelWriteCause(error: FleetError): string {
  return error.code === 'state_moved' ? 'Another write, such as the member\'s progress, landed on the record first.' : error.message.replace(/ Try again\.$/, '');
}

/**
 * The runtime `wake` names, opened through `openWake`, or why the entry fails: it cannot be opened here, or its `init`
 * offers no wake, which would leave every offer unwoken.
 */
async function openWaker(wake: { use: string; options?: RuntimeOptions | undefined }, openWake: OpenWake | undefined): Promise<{ waker: Waker } | { failure: { code: 'bad_option'; key: string; message: string } }> {
  const refused = (message: string) => ({ failure: { code: 'bad_option' as const, key: 'wake', message } });

  if (wake.use === 'fleet') return refused('fleet wakes no fleet member: name a runtime that does, such as t3');

  if (openWake === undefined) return refused(`this teamai cannot open runtime "${wake.use}" to wake fleet members`);
  const opened = await openWake({ use: wake.use, options: wake.options ?? {} });

  if (!opened.ok) return refused(`runtime "${wake.use}" did not open: ${opened.failure.message}`);

  const wakes = opened.runtime.wake?.bind(opened.runtime);

  if (!opened.wakes || wakes === undefined) {
    await opened.runtime.dispose();

    return refused(`runtime "${wake.use}" wakes no fleet member: its init does not offer wake. Remove options.wake, or name a runtime that wakes members`);
  }

  return { waker: { use: wake.use, runtime: opened.runtime, wake: wakes } };
}

/**
 * The command that takes one attempt of `pool`. A woken member's first message starts with exactly this: the rule that
 * lets a woken agent run it without asking matches that prefix.
 */
const takeCommand = (pool: string): string => `${WAKE_COMMAND} --next --pool ${pool}`;

/** The wake of one offer: shown each record the owner reads, and stopped once the owner stops waiting. */
type WakeOnOffer = { seen(record: FleetRecord | 'absent'): Promise<void>; stop(): Promise<void> };

/**
 * Wakes a member of the offer's pool through `waker` once, the first time the owner reads the attempt offered and no
 * member's claim on it: the op is noted on the offer before it is sent, so a restarted owner that finds it there sends
 * none again. Where the member was launched is noted there too, for the attempt listing. A wake that fails is said once,
 * and the offer waits for a member someone starts. A wake still on its way when the offer is no longer offered, or the
 * owner stops waiting, is cancelled.
 */
function wakeOnOffer({ config, run, attempt, root, waker }: { config: LocalConfig; run: RunId; attempt: AttemptId; root: string; waker: Waker }): WakeOnOffer {
  let sent: { op: OpId; settled: Promise<void>; isSettled: boolean } | undefined;
  let isDone = false;

  const settle = async (end: WakeEnd, { pool, step, repository }: { pool: string; step: string; repository: string }): Promise<void> => {
    const take = `${takeCommand(pool)}, in a checkout of ${repository}`;

    switch (end.kind) {
      case 'woken': {
        if (sent) await noteWake(config, run, attempt, { op: sent.op, where: end.where, ...(end.display && { display: end.display }) });
        log.info(`Fleet pool ${pool}: ${waker.use} woke a member on ${end.where} for step "${step}" of run ${run}.`);

        return;
      }

      case 'failed':
      case 'lost':
        // The owner stopped it: the offer was taken, or the wait ended, whether the runtime confirmed the cancel or not.
        if (isDone || (end.kind === 'failed' && end.failure.code === 'cancelled')) return;
        log.warn(`Fleet pool ${pool} could not wake a member for step "${step}" of run ${run} through ${waker.use} (${end.failure.code}): ${end.failure.message} The step waits for a member someone starts: ${take}.`);

        return;
      default: {
        const unhandled: never = end;

        return unhandled;
      }
    }
  };

  return {
    async seen(record) {
      if (isDone || record === 'absent' || record.state !== 'offered') {
        if (record !== 'absent') await this.stop();

        return;
      }

      if (sent) return;
      // Sent before, by this owner or one a restart replaced.
      const noted = (await readOfferedMarker(config, run, attempt))?.wake;

      if (noted) {
        isDone = true;

        return;
      }

      const { pool, lease: { step } } = record;

      const unsent = (why: string): void => {
        isDone = true;
        log.warn(`Fleet pool ${pool} could not wake a member for step "${step}" of run ${run} through ${waker.use}: ${why} The step waits for a member someone starts: ${takeCommand(pool)}, in a checkout of the business repository.`);
      };

      // The URL as configured, which the machine woken knows the repository by: no insteadOf rewrites it into one of this machine's.
      const origin = await git(root, ['config', '--get', 'remote.origin.url']);
      const repository = origin.code === 0 ? sanitizeGitUrl(origin.stdout.trim()) : '';

      if (repository === '') return unsent(`${root} names no origin to tell the member which repository to work in.`);

      const op = newOpId();
      const note: WakeNote = { op };

      try {
        await noteWake(config, run, attempt, note);
      } catch (error) {
        return unsent(`teamai could not note the wake before sending it, so it sent none: ${error instanceof Error ? error.message : String(error)}`);
      }

      // The command first and alone on its line, then where to run it and to end.
      const message = `${takeCommand(pool)}\n\nRun that command once, as written, in a checkout of ${repository}. It needs no skill or file read first: run it before anything else, then end, whether it ran a step or found nothing to claim.`;
      const end = waker.wake({ op, pool, repository, message, title: `teamai: step ${step} of run ${run}, fleet pool ${pool}` }, {});

      const current = { op, settled: Promise.resolve(), isSettled: false };

      current.settled = (async () => {
        const ended = await end;

        current.isSettled = true;

        try {
          await settle(ended, { pool, step, repository });
        } catch (error) {
          log.warn(`Fleet pool ${pool}: the wake through ${waker.use} for step "${step}" of run ${run} ended, but teamai could not note it: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
      sent = current;
    },
    async stop() {
      isDone = true;

      if (!sent || sent.isSettled) return;
      await waker.runtime.cancel(sent.op);
      await sent.settled;
    },
  };
}

/** A gate put to this driver's person: the question as the record holds it, closed once the record no longer asks it, and the answer once given. */
type Asked = { question: string; closed: AbortController; answered: AbortController; answer?: ExecAnswer };

/**
 * Puts `question`, a gate the whole workflow of step `step` reached on fleet member `member`, to this driver's person
 * through `ask`, until the answer is a choice the gate offers or none comes. Without `ask`, nobody answers here.
 */
function askPerson(question: ExecQuestion, ask: ExecEvents['ask'], { step, member }: { step: string; member: string }): Asked {
  const closed = new AbortController();
  const answered = new AbortController();
  const asked: Asked = { question: JSON.stringify(question), closed, answered };
  const nobody = `Step "${question.step}" of the workflow step "${step}", on fleet member ${member}, needs an answer, and nobody answers it where the run is driven. Resume the run from a terminal where a person answers, in an attended run.`;

  void (async () => {
    for (;;) {
      const answer = ask === undefined ? { refused: nobody } : await ask(question, closed.signal).catch(() => ({ refused: `The driver where the run is driven could not ask its person step "${question.step}".` }));

      if (closed.signal.aborted) return;

      if ('choice' in answer && !question.options.includes(answer.choice)) {
        log.warn(`"${answer.choice}" is not a choice of step "${question.step}": answer one of ${question.options.join(', ')}.`);
        continue;
      }

      asked.answer = answer;
      answered.abort();

      return;
    }
  })();

  return asked;
}

/**
 * Takes into place `dir` the work a member of an earlier attempt of `step` pushed before its claim was given up, so a
 * retry goes on from it.
 */
async function goOnFromGoneWork({ config, run, root, dir, step }: { config: LocalConfig; run: RunId; root: string; dir: string; step: string }): Promise<WorkflowFailure | undefined> {
  try {
    await readableReportsWorktree(config);
  } catch (error) {
    return { code: 'reports_unreachable', message: `teamai-reports could not be read, so step "${step}" was not offered to the fleet: ${error instanceof Error ? error.message : String(error)}` };
  }

  const earlier = await lastGoneWork(config, { run, step });

  if (earlier === undefined) return undefined;
  const ref = attemptRef(run, earlier.attempt);
  const fetched = await git(root, ['fetch', '--quiet', 'origin', ref]);

  if (fetched.code !== 0) return { code: 'fetch_failed', message: `Step "${step}" goes on from the work attempt ${earlier.attempt} pushed to ${ref}, which could not be fetched: ${fetched.stderr.trim()}` };
  // A step ran in the copy before, so its config may name programs.
  const merged = await (await copyGit(config, { run, root }))(dir, ['merge', '--no-edit', '--quiet', earlier.pushed]);

  if (merged.code !== 0) return { code: 'workspace_base', message: `Step "${step}" goes on from the work attempt ${earlier.attempt} pushed (${earlier.pushed}), which its place could not take: ${merged.stderr.trim()}` };

  return undefined;
}

/**
 * The commit a member starts step `step` from: HEAD of place `dir`, with what the place holds uncommitted, such as the
 * work of an earlier attempt it kept on a usage limit, committed over it as a member commits its own work, so the member
 * finds the place as the step would here. What teamai delivered there, such as the team's skills, stays out: the member
 * delivers its own. The place moves to that commit, which the member's work then fast-forwards.
 */
async function startOf(input: { config: LocalConfig; run: RunId; attempt: AttemptId; root: string; dir: string; step: string }): Promise<{ start: string } | WorkflowFailure> {
  const { config, run, root, dir, step } = input;

  // A step with no workspace runs in the checkout, whose files are the person's.
  if (dir !== root) {
    const edits = await placeEditsOf(input);

    if ('error' in edits) return { code: 'workspace_base', message: `Step "${step}" could not list what its place ${dir} holds uncommitted, so no fleet member can start from it: ${edits.error}` };

    if (edits.paths.length > 0) {
      // A step ran in the copy before, so its config may name programs.
      const placeGit = await copyGit(config, { run, root });
      const added = await placeGit(dir, ['--literal-pathspecs', 'add', '-A', '--', ...edits.paths]);

      // Older Git applies diff.ignoreSubmodules to commit's staged-change check too, which would drop a moved gitlink.
      const committed = added.code === 0
        ? await placeGit(dir, ['--literal-pathspecs', '-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost', '-c', 'diff.ignoreSubmodules=none', 'commit', '--quiet', '--no-verify', '-m', `Work step "${step}" left uncommitted in its place`, '--', ...edits.paths])
        : added;

      if (committed.code !== 0) return { code: 'workspace_base', message: `Step "${step}" could not commit what its place ${dir} holds uncommitted, so no fleet member can start from it: ${committed.stderr.trim()}` };
    }
  }

  return { start: (await git(dir, ['rev-parse', '--verify', 'HEAD'])).stdout.trim() };
}

/** Fails a claim given up as stale, once the place took the last commit its member pushed, which a retry goes on from. */
async function gone(claim: Pick<Claimed, 'member' | 'progressAt' | 'pushed' | 'start' | 'lease'> & { cancelAt?: string }, place: PlaceOf & { staleAfterMs: number }): Promise<WorkflowFailure> {
  const { member, progressAt, pushed, start, lease, cancelAt } = claim;
  const { staleAfterMs } = place;
  const taken = pushed === start ? undefined : await takeWork({ ...place, to: pushed, step: lease.step });
  const kept = pushed === start ? 'It pushed no work.' : `Its work up to ${pushed} is kept, and a retry goes on from it.`;
  const silent = cancelAt === undefined ? `wrote no progress since ${progressAt}` : `did not answer the cancel written at ${cancelAt}`;
  const message = `The fleet member ${member.user} that took step "${lease.step}" ${silent}, longer than ${staleAfterMs / 1_000} s, so the attempt was given up. ${kept}`;

  return taken ? { ...taken, message: `${message} ${taken.message}` } : { code: 'fleet_member_gone', message };
}

/** The owner's place of an attempt: `dir`, a copy of checkout `root` for run `run`, and the attempt's ref. */
type PlaceOf = { config: LocalConfig; run: RunId; root: string; dir: string; ref: string };

/** Fast-forwards place `dir` to `to`, a commit a member pushed to `ref`. */
async function takeWork({ config, run, root, dir, ref, to, step }: PlaceOf & { to: string; step: string }): Promise<WorkflowFailure | undefined> {
  // A step with no workspace runs in the checkout, whose branch only the person moves.
  if (dir === root) return { code: 'read_only_dirty', message: `Step "${step}" has no workspace, and the fleet member that ran it changed files (${to} on ${ref}), which teamai does not take into ${root}. Give the step a workspace, such as workspace: new, to keep its work.` };
  const fetched = await git(root, ['fetch', '--quiet', 'origin', ref]);

  if (fetched.code !== 0) return { code: 'fetch_failed', message: `Step "${step}" ran on a fleet member, and its work could not be fetched from ${ref}: ${fetched.stderr.trim()}` };
  // A step ran in the copy before, so its config may name programs.
  const merged = await (await copyGit(config, { run, root }))(dir, ['merge', '--ff-only', '--quiet', to]);

  if (merged.code !== 0) return { code: 'workspace_base', message: `Step "${step}" ran on a fleet member, and its place could not take the member's commit ${to}: ${merged.stderr.trim()}` };

  return undefined;
}

/**
 * Cancels attempt `attempt` of run `run` through its record, for `teamai workflow cancel` with no live driver of the run:
 * an offer is withdrawn, and a claim's member is asked to stop, which it answers at its next read of the record. Answers
 * what it did, for the person. The cancel waits for another write of this install that holds teamai-reports, and is
 * written again over another write that lands first, until CANCEL_WRITE_MS after it began.
 */
export async function cancelFleetAttempt(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<{ ok: boolean; message: string }> {
  const until = Date.now() + CANCEL_WRITE_MS;

  for (;;) {
    const read = await readAttemptRecord(config, run, attempt);

    if (!read.ok) return { ok: false, message: `Attempt ${attempt} of run ${run} is out on the fleet, and its record could not be read, so its member was not asked to stop: ${read.error.message} Run teamai workflow cancel ${run} again.` };
    const record = read.value;

    if (record === 'absent' || (record.state !== 'offered' && !isHeld(record))) return { ok: true, message: `Attempt ${attempt} of run ${run} was out on the fleet, and its record already says it is ${record === 'absent' ? 'not offered' : record.state}.` };
    const cancel = await cancelAttempt(config, record, { until });

    if (cancel.ok) {
      return { ok: true, message: record.state === 'offered'
        ? `Withdrew attempt ${attempt} of run ${run}, which no fleet member had taken.`
        : `Asked the fleet member ${record.member.user} that runs attempt ${attempt} of run ${run} to stop it: it stops the step at its next read of the attempt's record and pushes its work, which a retry goes on from.` };
    }

    const { error } = cancel;

    if (error.code === 'state_moved' && Date.now() < until) continue;

    return { ok: false, message: `Attempt ${attempt} of run ${run} is out on the fleet, and its cancel could not be written: ${cancelWriteCause(error)} Run teamai workflow cancel ${run} again.` };
  }
}
