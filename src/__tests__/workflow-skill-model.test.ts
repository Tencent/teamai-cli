import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import type { WorkflowClient } from '../workflow/protocol.js';
import type { Runners } from '../workflow/drivers/skill/skill-driver.js';
import { AttemptIdSchema, readRun, skillStatePath, type AttemptId, type RunId } from '../workflow/store.js';
import { Crash, skillHarness, untilStopped } from './helpers/skill-harness.js';

// Two prompt roots in their own worktrees; two command roots and one that runs until its timeout, all three sharing the
// checkout; and a prompt step after the first four. The prompt roots come first, so dispatches are out early.
const BUILD = `schemaVersion: v1alpha1
name: build
description: Build the API and the UI, check, then integrate them
invoke: allow
steps:
  - id: api
    workspace: new
    prompt: Build the API.
  - id: ui
    needs: []
    workspace: new
    prompt: Build the UI.
  - id: lint
    needs: []
    command: node -e "process.exit(0)"
  - id: test
    needs: []
    command: node -e "console.log('Tests 3 passed (3)')"
  - id: integrate
    needs: [api, ui, lint, test]
    workspace: new
    prompt: Integrate the API and the UI.
  - id: serve
    needs: []
    timeout: 30s
    command: sleep 300
`;

const STEPS = ['api', 'ui', 'lint', 'test', 'integrate', 'serve'] as const;

// For a host that starts no child (h4): a prompt step in the checkout, a command beside it, a prompt step in a worktree
// of its own, and a prompt step after the first two.
const INLINE = `schemaVersion: v1alpha1
name: inline
description: Write the notes and lint, change the code, then sum up
invoke: allow
steps:
  - id: notes
    prompt: Write the notes.
  - id: lint
    needs: []
    command: node -e "process.exit(0)"
  - id: change
    needs: []
    workspace: new
    prompt: Change the code.
  - id: summary
    needs: [notes, lint]
    prompt: Sum up.
`;

/** fast-check runs per property: a few in the suite, more by hand (`WORKFLOW_SKILL_MODEL_RUNS=200`). */
const RUNS = Number(process.env.WORKFLOW_SKILL_MODEL_RUNS ?? '8');
/** A run takes 1.5 s on an idle machine and 3 s on a busy one; the property gets 6 s a run, and never less than ten minutes. */
const TIMEOUT_MS = Math.max(600_000, RUNS * 6_000);

const NextBodySchema = z.object({ running: z.array(z.string()) });
const LeaseReplySchema = z.object({ data: z.object({ lease: z.object({ attempt: z.string() }) }) });
const SkillJsonSchema = z.object({ attempts: z.array(z.object({ attempt: z.string() })) });
const CancelledReplySchema = z.object({ data: z.object({ cancelled: z.array(z.string()) }) });
const ReleasedBodySchema = z.object({ attempt: z.string(), outcome: z.literal('released') });

/** The attempts skill.json holds open. */
function openAttempts(config: LocalConfig, run: RunId): string[] {
  const saved = SkillJsonSchema.safeParse(JSON.parse(fs.readFileSync(skillStatePath(config, run), 'utf8')));
  return saved.success ? saved.data.attempts.map((open) => open.attempt) : [];
}

/**
 * The protocol as the model test watches it. Every `next` must list the attempts the engine leased (invariant 1), apart
 * from ones the engine stopped, and leases a crash lost before skill.json was written, which the engine hands back in
 * that same reply. A `released` report gives up only an attempt some `next` reply listed in `cancelled`, or one of a run
 * that ended: the driver never releases an attempt on its own. Once armed, the next `next` or `report`, from the session
 * or a runner, crashes after the engine answered it and before its caller writes anything.
 */
function watched(input: { config: () => LocalConfig | undefined; drift: string[] }) {
  let armed = false;
  const lost = new Set<string>();
  const cancelled = new Set<string>();
  const leasedIn = async (run: string): Promise<{ leased: string[]; stopped: string[] } | undefined> => {
    const config = input.config();
    const state = config ? await readRun(config, run) : 'missing';
    if (typeof state !== 'object') return undefined;
    return { leased: state.steps.flatMap((step) => (step.status === 'leased' ? [step.lease.attempt] : [])), stopped: state.cancelledAttempts ?? [] };
  };
  const crash = async (run: string): Promise<void> => {
    if (!armed) return;
    armed = false;
    const config = input.config();
    const engine = await leasedIn(run);
    const kept = config ? openAttempts(config, run as RunId) : [];
    for (const attempt of engine?.leased ?? []) if (!kept.includes(attempt)) lost.add(attempt);
    throw new Crash('injected after the engine answered');
  };
  const drifted = (said: string): never => {
    input.drift.push(said);
    // Thrown as well, since a call that went on with the wrong list may never return.
    throw new Error(input.drift.join('; '));
  };
  return {
    arm: () => { armed = true; },
    disarm: () => { armed = false; },
    client: (client: WorkflowClient): WorkflowClient => ({
      ...client,
      next: async (runId, body, options) => {
        const sent = NextBodySchema.safeParse(body);
        const engine = await leasedIn(runId);
        let unlisted: string[] = [];
        if (sent.success && engine) {
          const { leased, stopped } = engine;
          // An attempt the engine stopped stays listed until its runner or the session has given it up.
          const listed = sent.data.running.filter((attempt) => !stopped.includes(attempt) || leased.includes(attempt));
          unlisted = leased.filter((attempt) => !listed.includes(attempt));
          const gone = listed.filter((attempt) => !leased.includes(attempt));
          if (gone.length > 0 || unlisted.some((attempt) => !lost.has(attempt))) drifted(`sent ${sent.data.running.join(',')} while the engine leased ${leased.join(',')}`);
        }
        const answer = await client.next(runId, body, options);
        for (const attempt of CancelledReplySchema.safeParse(answer).data?.data.cancelled ?? []) cancelled.add(attempt);
        if (unlisted.length > 0) {
          const handed = LeaseReplySchema.safeParse(answer);
          if (!handed.success || !unlisted.includes(handed.data.data.lease.attempt)) drifted(`the engine did not hand back ${unlisted.join(',')}, which a crash lost`);
          else lost.delete(handed.data.data.lease.attempt);
        }
        await crash(runId);
        return answer;
      },
      report: async (runId, body, options) => {
        const released = ReleasedBodySchema.safeParse(body);
        if (released.success && !cancelled.has(released.data.attempt)) {
          const config = input.config();
          const state = config ? await readRun(config, runId) : 'missing';
          if (typeof state !== 'object' || state.status === 'running') drifted(`released ${released.data.attempt}, which no next listed in cancelled, while the run still ran`);
        }
        const answer = await client.report(runId, body, options);
        await crash(runId);
        return answer;
      },
    }),
  };
}

type Made = Awaited<ReturnType<typeof skillHarness>>;
type SkillAnswer = Awaited<ReturnType<Made['call']>>;
type Turn = Extract<SkillAnswer, { data: { turn: unknown } }>['data']['turn'];
type DispatchAction = Extract<Turn['actions'][number], { kind: 'dispatch' }>;
type StopAction = Extract<Turn['actions'][number], { kind: 'stop' }>;
type PlaceAction = Extract<Turn['actions'][number], { kind: 'place' }>;

interface Real {
  made: Made;
  run: RunId;
  /** The session that drives the run. */
  session: string;
  /** How many other sessions have called. */
  sessions: number;
  /** Arms the crash after the next engine `next` or `report`. */
  crash: { arm(): void; disarm(): void };
  /** Every engine `next` whose `running` was not the attempts the engine had leased, and ones it stopped (invariant 1). */
  drift: string[];
  /**
   * The attempts whose `sleep 300` runs, and each attempt that started one while its last still ran (invariant 11: an
   * attempt runs one command at a time, and none outlives the run).
   */
  commands: { live: Set<string>; twice: string[] };
}

/** What the session has seen and done so far. */
interface Model {
  hostPending: boolean;
  done: boolean;
  /** Places the session's last foreground turn asked for, and it has not adopted, by attempt. */
  placing: Map<AttemptId, PlaceAction>;
  /** Dispatches the session saw and has not reported, by attempt. */
  open: Map<AttemptId, DispatchAction>;
  acked: Set<AttemptId>;
  /** Stops the session saw and has not reported, by attempt. */
  stopping: Map<AttemptId, StopAction>;
  /** Every attempt the session was asked to stop. */
  stopped: Set<AttemptId>;
  /** Steps the person cancelled. */
  cancelled: Set<string>;
  /** Events a report settled that the session's next turn must show. */
  unseen: unknown[];
}

function turnOf(answer: SkillAnswer): Turn {
  if (!('data' in answer) || !('turn' in answer.data)) throw new Error(JSON.stringify(answer));
  return answer.data.turn;
}

/** Checks that `events` show every event a report settled since the session's last turn that showed events. */
function sawEvents(model: Model, events: Turn['events']): void {
  for (const expected of model.unseen) expect(events).toContainEqual(expected);
  model.unseen = [];
}

/** Takes what a foreground turn shows into the model, and checks invariants 3 and 6 on it. */
function sawForeground(model: Model, turn: Turn): void {
  sawEvents(model, turn.events);
  model.done = turn.status === 'done';
  model.hostPending = turn.actions.some((action) => action.kind === 'choose');
  const kinds = turn.actions.map((action) => action.kind);
  const stops = turn.actions.flatMap((action) => (action.kind === 'stop' ? [action] : []));
  expect(kinds.slice(0, stops.length)).toEqual(stops.map(() => 'stop'));
  for (const action of stops) {
    model.stopping.set(action.attempt, action);
    model.stopped.add(action.attempt);
    model.open.delete(action.attempt);
    model.acked.delete(action.attempt);
  }
  expect(stops.map((action) => action.attempt).sort()).toEqual([...model.stopping.keys()].sort());
  expect(turn.running.filter((entry) => entry.phase === 'stopping' && entry.report !== undefined).map((entry) => entry.attempt).sort()).toEqual([...model.stopping.keys()].sort());
  const shown = turn.actions.flatMap((action) => (action.kind === 'dispatch' ? [action] : []));
  expect(shown.filter((action) => model.stopped.has(action.attempt))).toEqual([]);
  for (const action of shown) model.open.set(action.attempt, action);
  const places = turn.actions.flatMap((action) => (action.kind === 'place' ? [action] : []));
  expect(places.filter((action) => model.stopped.has(action.attempt))).toEqual([]);
  model.placing = new Map(places.map((action) => [action.attempt, action]));
  if (model.done) return;
  const unacked = [...model.open.keys()].filter((attempt) => !model.acked.has(attempt));
  expect(shown.map((action) => action.attempt).sort()).toEqual(unacked.sort());
  expect(turn.running.filter((entry) => entry.phase === 'offered').map((entry) => entry.attempt).sort()).toEqual(unacked.sort());
}

/**
 * Takes what a poll shows into the model, and checks invariant 5 on it. A poll that shows events shows every one the
 * session has not seen: it returns once a step settled or stopped, or the run ended.
 */
function sawPoll(model: Model, turn: Turn): void {
  expect(turn.actions.filter((action) => action.kind !== 'done')).toEqual([]);
  if (turn.then === undefined || turn.events.length > 0) sawEvents(model, turn.events);
  model.done = turn.status === 'done';
}

/** Plays the child of `action`: it writes `result` where its brief says. */
function childWrites(action: DispatchAction, result: unknown): void {
  const file = /Write `([^`]+result\.json)`/.exec(fs.readFileSync(action.brief, 'utf8'))?.[1];
  if (!file) throw new Error(`the brief ${action.brief} names no result file`);
  fs.writeFileSync(file, JSON.stringify(result));
}

/** Whether the step of `action` was cancelled, so its report gives it up instead of settling it. */
function cancelledStep(model: Model, action: DispatchAction): boolean {
  return model.cancelled.has(action.step);
}

/** Makes `call` as the session, or as `session`, and checks invariants 1 and 11 on every engine `next` and command it led to. */
async function called(real: Pick<Real, 'made' | 'drift' | 'session' | 'commands'>, call: Parameters<Made['call']>[0], session = real.session): Promise<SkillAnswer> {
  const answer = await real.made.call(call, { session });
  expect(real.drift).toEqual([]);
  expect(real.commands.twice).toEqual([]);
  return answer;
}

/**
 * Makes `call` twice with the runners held, and checks invariant 9: the second turn is the first apart from events, and
 * shows none the first showed. The clock still moves, so the second may show what happened since, such as a restart.
 */
async function twice(real: Real, call: Parameters<Made['call']>[0]): Promise<{ first: Turn; second: Turn }> {
  real.made.hold(true);
  try {
    const first = turnOf(await called(real, call));
    const second = turnOf(await called(real, call));
    expect({ ...second, events: [] }).toEqual({ ...first, events: [] });
    expect(second.events.filter((event) => first.events.some((shown) => isDeepStrictEqual(shown, event)))).toEqual([]);
    return { first, second };
  } finally {
    real.made.hold(false);
  }
}

class Next implements fc.AsyncCommand<Model, Real> {
  check = (): boolean => true;
  async run(model: Model, real: Real): Promise<void> {
    const { first } = await twice(real, { kind: 'next', run: real.run, wait: false });
    sawForeground(model, first);
  }
  toString = (): string => 'next';
}

/** The session polls. A step that settled or stopped since its last turn makes the poll return at its first tick. */
async function polled(model: Model, real: Real): Promise<void> {
  const news = model.unseen.length > 0;
  const from = real.made.context.now().getTime();
  const turn = turnOf(await called(real, { kind: 'next', run: real.run, wait: true }));
  if (news) expect(real.made.context.now().getTime() - from, 'a poll slept while a settled or stopped step waited to be shown').toBe(0);
  sawPoll(model, turn);
}

class Poll implements fc.AsyncCommand<Model, Real> {
  check = (): boolean => true;
  async run(model: Model, real: Real): Promise<void> {
    await polled(model, real);
  }
  toString = (): string => 'poll';
}

class Sleep implements fc.AsyncCommand<Model, Real> {
  constructor(readonly ms: number) {}
  check = (): boolean => true;
  async run(_model: Model, real: Real): Promise<void> {
    await real.made.context.runners.sleep(this.ms);
    expect(real.drift).toEqual([]);
    expect(real.commands.twice).toEqual([]);
  }
  toString = (): string => `sleep ${this.ms}`;
}

/**
 * The session's context was compacted, so it lost its turns, and it runs `next` (invariant 6): the turn shows every
 * dispatch it has not acked, and `running` lists each acked one with the `report` the session runs for a child that
 * ended without reporting.
 */
class Compact implements fc.AsyncCommand<Model, Real> {
  check = (model: Readonly<Model>): boolean => !model.done && model.acked.size > 0;
  async run(model: Model, real: Real): Promise<void> {
    const turn = turnOf(await called(real, { kind: 'next', run: real.run, wait: false }));
    sawForeground(model, turn);
    if (model.done) return;
    const dispatched = turn.running.filter((entry) => entry.phase === 'dispatched');
    expect(dispatched.map((entry) => entry.attempt).sort()).toEqual([...model.acked].sort());
    for (const entry of dispatched) expect(entry.report).toBe(`teamai workflow report ${real.run} --driver skill --attempt ${entry.attempt}`);
  }
  toString = (): string => 'compact, then next';
}

/** The session runs `next` again before the first returned: the second waits for the run lock, and both get one turn. */
class TwoCallers implements fc.AsyncCommand<Model, Real> {
  check = (model: Readonly<Model>): boolean => !model.done;
  async run(model: Model, real: Real): Promise<void> {
    // Held, so only the calls move the run; their sleeps still move the clock the lock's wait is measured on.
    real.made.hold(true);
    try {
      const call = { kind: 'next', run: real.run, wait: false } as const;
      const [first, second] = (await Promise.all([called(real, call), called(real, call)])).map(turnOf);
      if (!first || !second) throw new Error('two calls gave fewer than two turns');
      expect({ ...second, events: [] }).toEqual({ ...first, events: [] });
      // Whichever took the lock first shows the events.
      sawForeground(model, { ...first, events: [...first.events, ...second.events] });
    } finally {
      real.made.hold(false);
    }
  }
  toString = (): string => 'two nexts at once';
}

/**
 * Another coding session calls `next` (invariant 7). It is refused with the takeover literal and how long the owner has
 * been idle, even when the owner made no call for minutes, and it runs that literal when the person agrees. A takeover
 * reissues every dispatch the old session was given, and refuses the old session from then on.
 */
class NewSession implements fc.AsyncCommand<Model, Real> {
  constructor(readonly how: 'refused' | 'takeover' | 'quiet') {}
  check = (model: Readonly<Model>): boolean => !model.done;
  async run(model: Model, real: Real): Promise<void> {
    real.sessions += 1;
    const session = `session-${real.sessions}`;
    const previous = real.session;
    const next = { kind: 'next', run: real.run, wait: false } as const;
    let idle = 0;
    if (this.how === 'quiet') {
      idle = 201;
      await real.made.context.runners.sleep(idle * 1000);
    } else {
      sawForeground(model, turnOf(await called(real, next)));
      if (model.done) return;
    }
    const refused = await called(real, next, session);
    expect(refused).toEqual({ error: expect.objectContaining({ code: 'orchestrator_active', next: `teamai workflow next ${real.run} --driver skill --takeover` }) });
    expect('error' in refused ? refused.error.idleSeconds : undefined).toBeGreaterThanOrEqual(idle);
    if (this.how === 'refused') return;
    const given = new Set(model.open.keys());
    const turn = turnOf(await called(real, { kind: 'takeover', run: real.run, confirmed: false }, session));
    expect(turn.events).toContainEqual({ kind: 'takeover', from: previous });
    real.session = session;
    model.acked.clear();
    sawForeground(model, turn);
    for (const action of turn.actions) if (action.kind === 'dispatch' && given.has(action.attempt)) expect(action.reissued).toEqual(expect.any(String));
    if (model.done) return;
    expect(await called(real, next, previous)).toMatchObject({ error: { code: 'orchestrator_active' } });
  }
  toString = (): string => `new session, ${this.how}`;
}

/** Kills the runner of an open attempt where it waits, as `kill -9` kills it, at the next sleep. Whether one was alive. */
async function killRunner(real: Real, pick: number): Promise<boolean> {
  const attempts: string[] = [];
  for (const attempt of openAttempts(real.made.config, real.run)) {
    if (await real.made.context.runners.alive(real.run, AttemptIdSchema.parse(attempt))) attempts.push(attempt);
  }
  const attempt = attempts[pick % Math.max(attempts.length, 1)];
  const killed = attempt !== undefined && real.made.crashRunner(real.run, attempt);
  await real.made.context.runners.sleep(1);
  expect(real.drift).toEqual([]);
  expect(real.commands.twice).toEqual([]);
  return killed;
}

class RunnerCrash implements fc.AsyncCommand<Model, Real> {
  constructor(readonly pick: number) {}
  check = (model: Readonly<Model>): boolean => !model.done;
  async run(_model: Model, real: Real): Promise<void> {
    await killRunner(real, this.pick);
  }
  toString = (): string => `kill runner #${this.pick}`;
}

/** The person cancels a step from another shell: one the session dispatched when `dispatched` is set and it has one. */
class Cancel implements fc.AsyncCommand<Model, Real> {
  constructor(readonly pick: number, readonly dispatched: boolean) {}
  check = (model: Readonly<Model>): boolean => !model.done;
  async run(model: Model, real: Real): Promise<void> {
    const open = [...model.open.values()].map((action) => action.step);
    const step = this.dispatched && open.length > 0 ? open[this.pick % open.length] : STEPS[this.pick % STEPS.length];
    if (step === undefined) throw new Error('no step to cancel');
    const answer = await real.made.context.client.cancel(real.run, step);
    if ('data' in answer) model.cancelled.add(step);
    expect(real.drift).toEqual([]);
  }
  toString = (): string => `cancel #${this.pick}${this.dispatched ? ' dispatched' : ''}`;
}

class Choose implements fc.AsyncCommand<Model, Real> {
  constructor(readonly choice: 'h1' | 'h2' | 'h3') {}
  check = (model: Readonly<Model>): boolean => !model.done;
  async run(model: Model, real: Real): Promise<void> {
    const answer = await called(real, { kind: 'choose', run: real.run, choice: this.choice });
    if (!model.hostPending) {
      expect(answer).toMatchObject({ error: { code: 'unknown_choice' } });
      return;
    }
    sawForeground(model, turnOf(answer));
  }
  toString = (): string => `choose ${this.choice}`;
}

class Ack implements fc.AsyncCommand<Model, Real> {
  constructor(readonly pick: number) {}
  check = (model: Readonly<Model>): boolean => !model.done && model.open.size > 0;
  async run(model: Model, real: Real): Promise<void> {
    const action = [...model.open.values()][this.pick % model.open.size];
    if (action === undefined) throw new Error('no open dispatch');
    const { attempt } = action;
    model.acked.add(attempt);
    if (cancelledStep(model, action)) {
      // The ack may come before or after a tick took the cancel, so it is acked and then shown as a stop, or refused.
      const answer = await called(real, { kind: 'ack', run: real.run, attempt });
      if ('error' in answer) expect(answer.error.code).toBe('unknown_offer');
      else sawForeground(model, turnOf(answer));
      return;
    }
    const { first } = await twice(real, { kind: 'ack', run: real.run, attempt });
    sawForeground(model, first);
  }
  toString = (): string => `ack #${this.pick}`;
}

/** The host makes a worktree of the checkout at the start a place asks for, as a host that makes places does (h3). */
function madePlace(real: Real, place: PlaceAction): string {
  const dir = path.join(fs.mkdtempSync(path.join(real.made.root, 'place-')), 'tree');
  execFileSync('git', ['worktree', 'add', '-q', '--detach', dir, place.start], { cwd: real.made.work, stdio: 'ignore' });
  return dir;
}

/** The session adopts a place its host made for an attempt that asked for one. */
class Adopt implements fc.AsyncCommand<Model, Real> {
  constructor(readonly pick: number) {}
  check = (model: Readonly<Model>): boolean => !model.done && model.placing.size > 0;
  async run(model: Model, real: Real): Promise<void> {
    const place = [...model.placing.values()][this.pick % model.placing.size];
    if (place === undefined) throw new Error('no place asked for');
    model.placing.delete(place.attempt);
    const answer = await called(real, { kind: 'adopt', run: real.run, attempt: place.attempt, dir: madePlace(real, place) });
    // A cancel, a deadline or the run's end may have dropped the attempt since the session's last foreground turn.
    if ('error' in answer) expect(answer.error.code).toBe('unknown_attempt');
    else sawForeground(model, turnOf(answer));
  }
  toString = (): string => `adopt #${this.pick}`;
}

/**
 * Reports `attempt` as `session` twice, and checks the runner answers: `reported`, then `repeated`. The answer is not a
 * turn, so the session's next turn must show `event`.
 */
async function reportTwice(model: Model, real: Real, input: { attempt: AttemptId; session: string; event: unknown }): Promise<void> {
  const call = { kind: 'report', run: real.run, attempt: input.attempt, role: 'agent', modelUnavailable: false } as const;
  expect(await called(real, call, input.session)).toEqual({ data: { runner: { attempt: input.attempt, status: 'reported' } } });
  expect(await called(real, call, input.session)).toEqual({ data: { runner: { attempt: input.attempt, status: 'repeated' } } });
  model.unseen.push(input.event);
}

/** The child of a dispatch reports, from the session's own session (a native subagent) or its own (an app's child task). */
class Report implements fc.AsyncCommand<Model, Real> {
  constructor(readonly pick: number, readonly result: 'output' | 'failure' | 'none', readonly own: boolean) {}
  check = (model: Readonly<Model>): boolean => !model.done && model.open.size > 0;
  async run(model: Model, real: Real): Promise<void> {
    const action = [...model.open.values()][this.pick % model.open.size];
    if (action === undefined) throw new Error('no open dispatch');
    if (this.result === 'output') childWrites(action, { kind: 'output', output: `Did ${action.step}.` });
    if (this.result === 'failure') childWrites(action, { kind: 'failure', failure: { code: 'blocked', message: 'The fixture blocks it.' } });
    model.open.delete(action.attempt);
    model.acked.delete(action.attempt);
    await reportTwice(model, real, {
      attempt: action.attempt,
      session: this.own ? `child-${action.attempt}` : real.session,
      event: cancelledStep(model, action)
        ? { kind: 'stopped', step: action.step, attempt: action.attempt, why: 'cancelled' }
        : expect.objectContaining({ kind: 'settled', step: action.step, outcome: this.result === 'output' ? 'success' : 'failed' }),
    });
  }
  toString = (): string => `report #${this.pick} ${this.result}${this.own ? ' from its own session' : ''}`;
}

/** The session relays a stop to its child and reports it, as the guide says. */
class ReportStop implements fc.AsyncCommand<Model, Real> {
  constructor(readonly pick: number) {}
  check = (model: Readonly<Model>): boolean => model.stopping.size > 0;
  async run(model: Model, real: Real): Promise<void> {
    const action = [...model.stopping.values()][this.pick % model.stopping.size];
    if (action === undefined) throw new Error('no open stop');
    model.stopping.delete(action.attempt);
    await reportTwice(model, real, { attempt: action.attempt, session: real.session, event: { kind: 'stopped', step: action.step, attempt: action.attempt, why: action.why } });
  }
  toString = (): string => `report stop #${this.pick}`;
}

/**
 * A crash after the engine answered a `next` or a `report`, before skill.json is written: in the session's call, or in
 * a runner its call lets go on. The session's call either answers `skill_call_failed`, and the session lost that turn,
 * or returns.
 */
class CrashAfterEngine implements fc.AsyncCommand<Model, Real> {
  constructor(readonly call: 'next' | 'poll' | 'report', readonly pick: number) {}
  check = (model: Readonly<Model>): boolean => !model.done;
  async run(model: Model, real: Real): Promise<void> {
    const action = [...model.open.values()][this.pick % Math.max(model.open.size, 1)];
    real.crash.arm();
    try {
      if (this.call === 'report' && action) {
        // The child's report crashed or went through: either way its part is over, and its result is with TeamAI.
        model.open.delete(action.attempt);
        model.acked.delete(action.attempt);
        model.unseen.push(cancelledStep(model, action)
          ? { kind: 'stopped', step: action.step, attempt: action.attempt, why: 'cancelled' }
          : expect.objectContaining({ kind: 'settled', step: action.step, outcome: 'failed' }));
        await called(real, { kind: 'report', run: real.run, attempt: action.attempt, role: 'agent', modelUnavailable: false });
      } else {
        const answer = await called(real, { kind: 'next', run: real.run, wait: this.call === 'poll' });
        const lost = 'error' in answer && answer.error.code === 'skill_call_failed';
        if (!lost) (this.call === 'poll' ? sawPoll : sawForeground)(model, turnOf(answer));
      }
    } finally {
      real.crash.disarm();
    }
  }
  toString = (): string => `crash after the engine, in ${this.call}`;
}

const COMMANDS = [
  fc.constant(new Next()),
  fc.constant(new Poll()),
  // Short sleeps let runners progress; long ones move the clock past `serve`'s timeout.
  fc.oneof(fc.integer({ min: 1, max: 6_000 }), fc.integer({ min: 10_000, max: 40_000 })).map((ms) => new Sleep(ms)),
  fc.tuple(fc.nat(STEPS.length - 1), fc.boolean()).map(([pick, dispatched]) => new Cancel(pick, dispatched)),
  fc.nat(3).map((pick) => new ReportStop(pick)),
  fc.constantFrom<'h1' | 'h2' | 'h3'>('h1', 'h2', 'h3').map((choice) => new Choose(choice)),
  fc.nat(3).map((pick) => new Adopt(pick)),
  fc.nat(3).map((pick) => new Ack(pick)),
  fc.tuple(fc.nat(3), fc.constantFrom<'output' | 'failure' | 'none'>('output', 'output', 'failure', 'none'), fc.boolean()).map(([pick, result, own]) => new Report(pick, result, own)),
  fc.tuple(fc.constantFrom<'next' | 'poll' | 'report'>('next', 'poll', 'report'), fc.nat(3)).map(([call, pick]) => new CrashAfterEngine(call, pick)),
  fc.constant(new Compact()),
  fc.constant(new TwoCallers()),
  fc.constantFrom<'refused' | 'takeover' | 'quiet'>('refused', 'takeover', 'quiet').map((how) => new NewSession(how)),
  fc.nat(5).map((pick) => new RunnerCrash(pick)),
];

/**
 * Plays a fair session from where the commands left the run, and checks invariant 10: it reaches `done` with nothing
 * open. It acks each dispatch, is compacted once while children work, and has one runner killed while it runs.
 */
async function driveToDone(model: Model, real: Real): Promise<Turn> {
  let compacted = false;
  let killed = false;
  for (let call = 0; call < 40; call += 1) {
    const turn = turnOf(await called(real, { kind: 'next', run: real.run, wait: false }));
    sawForeground(model, turn);
    if (turn.then === undefined) return turn;
    if (model.hostPending) {
      await new Choose('h1').run(model, real);
      continue;
    }
    if (model.stopping.size > 0) {
      while (model.stopping.size > 0) await new ReportStop(0).run(model, real);
      continue;
    }
    if (model.placing.size > 0) {
      for (let left = model.placing.size; left > 0 && model.placing.size > 0; left -= 1) await new Adopt(0).run(model, real);
      continue;
    }
    if (model.open.size > 0) {
      const attempts = [...model.open.keys()];
      for (const [pick, attempt] of attempts.entries()) if (!model.acked.has(attempt)) await new Ack(pick).run(model, real);
      const compact = new Compact();
      if (!compacted && compact.check(model)) {
        await compact.run(model, real);
        compacted = true;
      }
      // Every other child runs in a session of its own, as an app's child tasks do.
      for (let child = 0; model.open.size > 0 && !model.done; child += 1) await new Report(0, 'output', child % 2 === 1).run(model, real);
      continue;
    }
    killed ||= await killRunner(real, call);
    await polled(model, real);
  }
  throw new Error('a fair session did not reach done in 40 calls');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * One session over the BUILD run: it starts the run, answers the host question with `host` first if given, plays `steps`,
 * and a fair session then reaches done with no command left running.
 */
async function sessionRun(host: 'h1' | 'h2' | 'h3' | undefined, steps: Iterable<fc.AsyncCommand<Model, Real>>): Promise<void> {
  const drift: string[] = [];
  let config: Made['config'] | undefined;
  const protocol = watched({ config: () => config, drift });
  const commands: Real['commands'] = { live: new Set(), twice: [] };
  const sleeping = (input: Parameters<Runners['command']>[0]) => {
    if (commands.live.has(input.attempt)) commands.twice.push(input.attempt);
    commands.live.add(input.attempt);
    return untilStopped(() => { commands.live.delete(input.attempt); });
  };
  const made = await skillHarness({ build: BUILD }, {
    runners: (runners) => ({ ...runners, command: (input) => (input.command === 'sleep 300' ? sleeping(input) : runners.command(input)) }),
    client: protocol.client,
  });
  config = made.config;
  // Each run's repositories go when it ends, so hundreds of runs do not pile them up.
  try {
    const started = turnOf(await called({ made, drift, session: 'session-a', commands }, { kind: 'start', name: 'build', answers: { parallel: 2, confirmed: false }, inputs: undefined }));
    const model: Model = { hostPending: false, done: false, placing: new Map(), open: new Map(), acked: new Set(), stopping: new Map(), stopped: new Set(), cancelled: new Set(), unseen: [] };
    sawForeground(model, started);
    expect(model.hostPending).toBe(true);
    const real: Real = { made, run: started.run, session: 'session-a', sessions: 0, drift, crash: protocol, commands };
    if (host) await new Choose(host).run(model, real);
    await fc.asyncModelRun(() => ({ model, real }), steps);
    const done = await driveToDone(model, real);
    expect(done.actions).toEqual([expect.objectContaining({ kind: 'done' })]);
    // No command outlives the run.
    expect([...commands.live]).toEqual([]);
  } finally {
    fs.rmSync(made.root, { recursive: true, force: true });
  }
}

describe('skill driver model', () => {
  it('keeps its invariants over any order of session calls and runner progress, and a fair session reaches done', async () => {
    // Half the sessions answer the host question first, so the commands also land while dispatches are out.
    const answered = fc.option(fc.constantFrom<'h1' | 'h2' | 'h3'>('h1', 'h2', 'h3'), { nil: undefined });
    await fc.assert(fc.asyncProperty(answered, fc.commands(COMMANDS, { maxCommands: 14 }), sessionRun), { numRuns: RUNS });
  }, TIMEOUT_MS);

  // Seeds 2095630968 and 1588576158 of the property above: a cancel of an attempt that waits for its place frees a slot
  // in the reply to a `next` that could take no lease, so the same call must ask again, or the next call leases into it.
  it('leases into the slot a cancel frees in the same call, so a second next with the runners held shows the same turn', async () => {
    await sessionRun('h3', [new Cancel(0, false), new Next()]);
  }, TIMEOUT_MS);

  // The property above answers h3 first in about a quarter of its runs, so a few runs can miss a host that makes places.
  it('keeps them, and a fair session reaches done, on a host that makes its own places (h3)', async () => {
    await fc.assert(fc.asyncProperty(fc.constant('h3' as const), fc.commands(COMMANDS, { maxCommands: 14 }), sessionRun), { numRuns: RUNS });
  }, TIMEOUT_MS);

  // Seed 1258969508 of the property below: the poll leases lint, the person cancels it, and its runner dies before it
  // takes its lock. Inside the spawn grace the first next keeps the runner and stops lint by it, so the second, with
  // nothing moved, must keep it too, and not give lint up as a runner gone.
  it('gives a runner that died before its lock the spawn grace once its attempt is cancelled, so two nexts at once show one turn', async () => {
    await inlineRun([new Report(0, 'output', false), new Poll(), new Cancel(2, false), new RunnerCrash(0), new TwoCallers()]);
  }, TIMEOUT_MS);

  it('on a host that starts no child, declares only read-only workspaces, works one attempt at a time, and leaves the worktree step to the person', async () => {
    const commands = [
      fc.constant(new Next()),
      fc.constant(new Poll()),
      fc.integer({ min: 1, max: 6_000 }).map((ms) => new Sleep(ms)),
      fc.tuple(fc.nat(STEPS.length - 1), fc.boolean()).map(([pick, dispatched]) => new Cancel(pick, dispatched)),
      fc.nat(3).map((pick) => new ReportStop(pick)),
      fc.nat(3).map((pick) => new Ack(pick)),
      fc.tuple(fc.nat(3), fc.constantFrom<'output' | 'failure' | 'none'>('output', 'output', 'failure', 'none'), fc.boolean()).map(([pick, result, own]) => new Report(pick, result, own)),
      fc.tuple(fc.constantFrom<'next' | 'poll' | 'report'>('next', 'poll', 'report'), fc.nat(3)).map(([call, pick]) => new CrashAfterEngine(call, pick)),
      fc.constant(new Compact()),
      fc.constant(new TwoCallers()),
      fc.constantFrom<'refused' | 'takeover' | 'quiet'>('refused', 'takeover', 'quiet').map((how) => new NewSession(how)),
      fc.nat(5).map((pick) => new RunnerCrash(pick)),
    ];
    await fc.assert(fc.asyncProperty(fc.commands(commands, { maxCommands: 14 }), inlineRun), { numRuns: RUNS });
  }, TIMEOUT_MS);
});

/**
 * One session over the INLINE run on h4: it starts the run, answers the host question with h4, plays `steps`, and a
 * fair session then works every step it can and is left with the handoff of the worktree step.
 */
async function inlineRun(steps: Iterable<fc.AsyncCommand<Model, Real>>): Promise<void> {
  const drift: string[] = [];
  let config: Made['config'] | undefined;
  const protocol = watched({ config: () => config, drift });
  const declared = inlineWatched({ config: () => config, drift });
  const commandsRun: Real['commands'] = { live: new Set(), twice: [] };
  const made = await skillHarness({ inline: INLINE }, { client: (client) => declared(protocol.client(client)) });
  config = made.config;
  try {
    const started = turnOf(await called({ made, drift, session: 'session-a', commands: commandsRun }, { kind: 'start', name: 'inline', answers: { parallel: 2, confirmed: false }, inputs: undefined }));
    const model: Model = { hostPending: false, done: false, placing: new Map(), open: new Map(), acked: new Set(), stopping: new Map(), stopped: new Set(), cancelled: new Set(), unseen: [] };
    sawForeground(model, started);
    const real: Real = { made, run: started.run, session: 'session-a', sessions: 0, drift, crash: protocol, commands: commandsRun };
    sawForeground(model, turnOf(await called(real, { kind: 'choose', run: real.run, choice: 'h4' })));
    await fc.asyncModelRun(() => ({ model, real }), steps);
    const held = await driveInline(model, real);
    expect(held.waiting?.reason).toContain('step "change" needs workspace new, which this driver does not provide');
    // The person continues the run with the local driver; the agent only shows the literal.
    expect(held.actions).toEqual([expect.objectContaining({ kind: 'person', why: 'handoff', held: [expect.objectContaining({ step: 'change' })], run: [`teamai workflow resume ${real.run} --tools default=claude`] })]);
    expect(held.then).toBeUndefined();
    const run = await readRun(made.config, real.run);
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'change')?.status).toBe('pending');
  } finally {
    fs.rmSync(made.root, { recursive: true, force: true });
  }
}

const CanBodySchema = z.object({ driver: z.object({ can: z.object({ hitl: z.boolean(), workspace: z.array(z.string()), env: z.string() }) }) });
const LeaseStepSchema = z.object({ data: z.object({ lease: z.object({ step: z.string(), workspace: z.unknown().optional() }) }) });

/**
 * The protocol as the h4 model watches it: every engine `next` declares HITL, commands' env and only read-only
 * workspaces; no lease is for a step in a worktree; and the engine leases one attempt at a time.
 */
function inlineWatched(input: { config: () => LocalConfig | undefined; drift: string[] }) {
  return (client: WorkflowClient): WorkflowClient => ({
    ...client,
    next: async (runId, body, options) => {
      const sent = CanBodySchema.safeParse(body);
      if (!sent.success || !isDeepStrictEqual(sent.data.driver.can, { hitl: true, workspace: ['read-only'], env: 'commands' })) {
        input.drift.push(`declared ${JSON.stringify(body)} on h4`);
      }
      const answer = await client.next(runId, body, options);
      const leased = LeaseStepSchema.safeParse(answer);
      if (leased.success && leased.data.data.lease.workspace !== undefined) input.drift.push(`leased ${leased.data.data.lease.step}, a step in a worktree, on h4`);
      const config = input.config();
      const state = config ? await readRun(config, runId) : 'missing';
      const open = typeof state === 'object' ? state.steps.filter((step) => step.status === 'leased').map((step) => step.id) : [];
      if (open.length > 1) input.drift.push(`leased ${open.join(', ')} at once on h4`);
      return answer;
    },
  });
}

/**
 * Plays a fair session on h4 from where the commands left the run: it works each dispatch itself in the checkout, one
 * at a time, until nothing is open and the run waits for the worktree step alone. That turn.
 */
async function driveInline(model: Model, real: Real): Promise<Turn> {
  for (let call = 0; call < 40; call += 1) {
    const turn = turnOf(await called(real, { kind: 'next', run: real.run, wait: false }));
    sawForeground(model, turn);
    if (model.stopping.size > 0) {
      while (model.stopping.size > 0) await new ReportStop(0).run(model, real);
      continue;
    }
    for (const action of model.open.values()) expect(action).toEqual(expect.objectContaining({ dir: real.made.work, needs: { place: 'checkout', parallel: false, person: false } }));
    expect(model.open.size).toBeLessThanOrEqual(1);
    if (model.open.size > 0) {
      for (const [pick, attempt] of [...model.open.keys()].entries()) if (!model.acked.has(attempt)) await new Ack(pick).run(model, real);
      await new Report(0, 'output', false).run(model, real);
      continue;
    }
    if (turn.running.length === 0 && turn.waiting?.reason.includes('step "change"')) return turn;
    await polled(model, real);
  }
  throw new Error('a fair session on h4 did not reach the worktree step in 40 calls');
}
