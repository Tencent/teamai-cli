import fs from 'node:fs';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { WorkflowClient } from '../workflow/protocol.js';
import { readRun, type AttemptId, type RunId } from '../workflow/store.js';
import { skillHarness, untilStopped } from './helpers/skill-harness.js';

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

/** fast-check runs per property: a few in the suite, more by hand (`WORKFLOW_SKILL_MODEL_RUNS=200`). */
const RUNS = Number(process.env.WORKFLOW_SKILL_MODEL_RUNS ?? '8');

const NextBodySchema = z.object({ running: z.array(z.string()) });

type Made = Awaited<ReturnType<typeof skillHarness>>;
type SkillAnswer = Awaited<ReturnType<Made['call']>>;
type Turn = Extract<SkillAnswer, { data: { turn: unknown } }>['data']['turn'];
type DispatchAction = Extract<Turn['actions'][number], { kind: 'dispatch' }>;
type StopAction = Extract<Turn['actions'][number], { kind: 'stop' }>;

interface Real {
  made: Made;
  run: RunId;
  /** Every engine `next` whose `running` was not the attempts the engine had leased, and ones it stopped (invariant 1). */
  drift: string[];
}

/** What the session has seen and done so far. */
interface Model {
  hostPending: boolean;
  done: boolean;
  /** Dispatches the session saw and has not reported, by attempt. */
  open: Map<AttemptId, DispatchAction>;
  acked: Set<AttemptId>;
  /** Stops the session saw and has not reported, by attempt. */
  stopping: Map<AttemptId, StopAction>;
  /** Every attempt the session was asked to stop. */
  stopped: Set<AttemptId>;
  /** Steps the person cancelled. */
  cancelled: Set<string>;
}

function turnOf(answer: SkillAnswer): Turn {
  if (!('data' in answer) || !('turn' in answer.data)) throw new Error(JSON.stringify(answer));
  return answer.data.turn;
}

/** Takes what a foreground turn shows into the model, and checks invariants 3 and 6 on it. */
function sawForeground(model: Model, turn: Turn): void {
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
  if (model.done) return;
  const unacked = [...model.open.keys()].filter((attempt) => !model.acked.has(attempt));
  expect(shown.map((action) => action.attempt).sort()).toEqual(unacked.sort());
  expect(turn.running.filter((entry) => entry.phase === 'offered').map((entry) => entry.attempt).sort()).toEqual(unacked.sort());
}

/** Takes what a poll shows into the model, and checks invariant 5 on it. */
function sawPoll(model: Model, turn: Turn): void {
  expect(turn.actions.filter((action) => action.kind !== 'done')).toEqual([]);
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

/** Makes `call` as the session, and checks invariant 1 on every engine `next` it led to. */
async function called(real: Pick<Real, 'made' | 'drift'>, call: Parameters<Made['call']>[0]): Promise<SkillAnswer> {
  const answer = await real.made.call(call);
  expect(real.drift).toEqual([]);
  return answer;
}

/** Makes `call` twice with the runners held, and checks invariant 9: the second turn is the first apart from events. */
async function twice(real: Real, call: Parameters<Made['call']>[0]): Promise<{ first: Turn; second: Turn }> {
  real.made.hold(true);
  try {
    const first = turnOf(await called(real, call));
    const second = turnOf(await called(real, call));
    expect({ ...second, events: [] }).toEqual({ ...first, events: [] });
    return { first, second };
  } finally {
    real.made.hold(false);
  }
}

class Next implements fc.AsyncCommand<Model, Real> {
  check = (): boolean => true;
  async run(model: Model, real: Real): Promise<void> {
    const { first, second } = await twice(real, { kind: 'next', run: real.run, wait: false });
    expect(second.events).toEqual([]);
    sawForeground(model, first);
  }
  toString = (): string => 'next';
}

class Poll implements fc.AsyncCommand<Model, Real> {
  check = (): boolean => true;
  async run(model: Model, real: Real): Promise<void> {
    sawPoll(model, turnOf(await called(real, { kind: 'next', run: real.run, wait: true })));
  }
  toString = (): string => 'poll';
}

class Sleep implements fc.AsyncCommand<Model, Real> {
  constructor(readonly ms: number) {}
  check = (): boolean => true;
  async run(_model: Model, real: Real): Promise<void> {
    await real.made.context.runners.sleep(this.ms);
    expect(real.drift).toEqual([]);
  }
  toString = (): string => `sleep ${this.ms}`;
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
  constructor(readonly choice: 'h1' | 'h2') {}
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
    const { first, second } = await twice(real, { kind: 'ack', run: real.run, attempt });
    expect(second.events).toEqual([]);
    sawForeground(model, first);
  }
  toString = (): string => `ack #${this.pick}`;
}

class Report implements fc.AsyncCommand<Model, Real> {
  constructor(readonly pick: number, readonly result: 'output' | 'failure' | 'none') {}
  check = (model: Readonly<Model>): boolean => !model.done && model.open.size > 0;
  async run(model: Model, real: Real): Promise<void> {
    const action = [...model.open.values()][this.pick % model.open.size];
    if (action === undefined) throw new Error('no open dispatch');
    if (this.result === 'output') childWrites(action, { kind: 'output', output: `Did ${action.step}.` });
    if (this.result === 'failure') childWrites(action, { kind: 'failure', failure: { code: 'blocked', message: 'The fixture blocks it.' } });
    model.open.delete(action.attempt);
    model.acked.delete(action.attempt);
    const { first, second } = await twice(real, { kind: 'report', run: real.run, attempt: action.attempt, role: 'agent', modelUnavailable: false });
    expect(first.events).toContainEqual(cancelledStep(model, action)
      ? { kind: 'stopped', step: action.step, attempt: action.attempt, why: 'cancelled' }
      : expect.objectContaining({ kind: 'settled', step: action.step, outcome: this.result === 'output' ? 'success' : 'failed' }));
    expect(second.events).toEqual([{ kind: 'repeated', attempt: action.attempt }]);
    sawForeground(model, first);
  }
  toString = (): string => `report #${this.pick} ${this.result}`;
}

/** The session relays a stop to its child and reports it, as the guide says. */
class ReportStop implements fc.AsyncCommand<Model, Real> {
  constructor(readonly pick: number) {}
  check = (model: Readonly<Model>): boolean => model.stopping.size > 0;
  async run(model: Model, real: Real): Promise<void> {
    const action = [...model.stopping.values()][this.pick % model.stopping.size];
    if (action === undefined) throw new Error('no open stop');
    model.stopping.delete(action.attempt);
    const { first, second } = await twice(real, { kind: 'report', run: real.run, attempt: action.attempt, role: 'agent', modelUnavailable: false });
    expect(first.events).toContainEqual({ kind: 'stopped', step: action.step, attempt: action.attempt, why: action.why });
    expect(second.events).toEqual([{ kind: 'repeated', attempt: action.attempt }]);
    sawForeground(model, first);
  }
  toString = (): string => `report stop #${this.pick}`;
}

const COMMANDS = [
  fc.constant(new Next()),
  fc.constant(new Poll()),
  // Short sleeps let runners progress; long ones move the clock past `serve`'s timeout.
  fc.oneof(fc.integer({ min: 1, max: 6_000 }), fc.integer({ min: 10_000, max: 40_000 })).map((ms) => new Sleep(ms)),
  fc.tuple(fc.nat(STEPS.length - 1), fc.boolean()).map(([pick, dispatched]) => new Cancel(pick, dispatched)),
  fc.nat(3).map((pick) => new ReportStop(pick)),
  fc.constantFrom<'h1' | 'h2'>('h1', 'h2').map((choice) => new Choose(choice)),
  fc.nat(3).map((pick) => new Ack(pick)),
  fc.tuple(fc.nat(3), fc.constantFrom<'output' | 'failure' | 'none'>('output', 'output', 'failure', 'none')).map(([pick, result]) => new Report(pick, result)),
];

/** Plays a fair session from where the commands left the run, and checks invariant 10: it reaches `done` with nothing open. */
async function driveToDone(model: Model, real: Real): Promise<Turn> {
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
    if (model.open.size > 0) {
      while (model.open.size > 0 && !model.done) await new Report(0, 'output').run(model, real);
      continue;
    }
    sawPoll(model, turnOf(await called(real, { kind: 'next', run: real.run, wait: true })));
  }
  throw new Error('a fair session did not reach done in 40 calls');
}

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('skill driver model', () => {
  it('keeps its invariants over any order of session calls and runner progress, and a fair session reaches done', async () => {
    // Half the sessions answer the host question first, so the commands also land while dispatches are out.
    const answered = fc.option(fc.constantFrom<'h1' | 'h2'>('h1', 'h2'), { nil: undefined });
    await fc.assert(fc.asyncProperty(answered, fc.commands(COMMANDS, { maxCommands: 14 }), async (host, commands) => {
      const drift: string[] = [];
      let config: Made['config'] | undefined;
      const made = await skillHarness({ build: BUILD }, {
        runners: (runners) => ({ ...runners, command: (input) => (input.command === 'sleep 300' ? untilStopped(() => {}) : runners.command(input)) }),
        client: (client): WorkflowClient => ({
          ...client,
          next: async (runId, body, options) => {
            const sent = NextBodySchema.safeParse(body);
            const state = config ? await readRun(config, runId) : 'missing';
            if (sent.success && typeof state === 'object') {
              const leased = state.steps.flatMap((step) => (step.status === 'leased' ? [step.lease.attempt] : [])).sort();
              const running = [...sent.data.running].sort();
              // An attempt the engine stopped stays listed until its runner or the session has given it up.
              const stopped = state.cancelledAttempts ?? [];
              const listed = running.filter((attempt) => !stopped.includes(attempt) || leased.includes(attempt));
              if (JSON.stringify(leased) !== JSON.stringify(listed)) {
                drift.push(`sent ${running.join(',')} while the engine leased ${leased.join(',')}`);
                // Thrown as well, since a call that went on with the wrong list may never return.
                throw new Error(drift.join('; '));
              }
            }
            return client.next(runId, body, options);
          },
        }),
      });
      roots.push(made.root);
      config = made.config;
      const started = turnOf(await called({ made, drift }, { kind: 'start', name: 'build', answers: { parallel: 2, confirmed: false }, inputs: undefined }));
      const model: Model = { hostPending: false, done: false, open: new Map(), acked: new Set(), stopping: new Map(), stopped: new Set(), cancelled: new Set() };
      sawForeground(model, started);
      expect(model.hostPending).toBe(true);
      const real: Real = { made, run: started.run, drift };
      if (host) await new Choose(host).run(model, real);
      await fc.asyncModelRun(() => ({ model, real }), commands);
      const done = await driveToDone(model, real);
      expect(done.actions).toEqual([expect.objectContaining({ kind: 'done' })]);
    }), { numRuns: RUNS });
  }, 600_000);
});
