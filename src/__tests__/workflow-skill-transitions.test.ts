import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowClient } from '../workflow/protocol.js';
import { respondProvenance, respondToHitl } from '../workflow/run-controls.js';
import { AttemptIdSchema, readRun, RunIdSchema, type RunId } from '../workflow/store.js';
import type { Runners } from '../workflow/drivers/skill/skill-driver.js';
// The doc comparison reads the table itself; every behaviour below goes through runSkillCall.
import { TRANSITIONS, type TransitionRow } from '../workflow/drivers/skill/transitions.js';
import { fakeJudge, skillHarness, untilStopped } from './helpers/skill-harness.js';

const CHECK = `schemaVersion: v1alpha1
name: check
description: Lint and test
invoke: allow
steps:
  - id: lint
    command: node -e "process.exit(0)"
  - id: test
    needs: [lint]
    command: node -e "console.log('Tests 42 passed (42)')"
`;

const DRAFT = `schemaVersion: v1alpha1
name: draft
description: Draft the notes with the person
invoke: allow
steps:
  - id: write
    prompt: Write the notes.
    interactive: true
`;

const PAIR = `schemaVersion: v1alpha1
name: pair
description: Write the API and the UI
invoke: allow
steps:
  - id: api
    workspace: new
    prompt: Write the API.
  - id: ui
    needs: []
    workspace: new
    model: claude-haiku-4-5
    prompt: Write the UI.
`;

const SETUP = `schemaVersion: v1alpha1
name: build
description: Build in a set-up workspace
invoke: allow
setup:
  command: test "$\{#SETUP_TOKEN}" = 22
  requires: { env: [SETUP_TOKEN] }
steps:
  - id: build
    workspace: new
    prompt: Build it.
`;

const GATED = `schemaVersion: v1alpha1
name: gated
description: Lint once the person agrees
invoke: ask
steps:
  - id: lint
    command: node -e "process.exit(0)"
`;

const SHIP = `schemaVersion: v1alpha1
name: check
description: Publish, then lint
invoke: allow
steps:
  - id: publish
    requires: { env: [DEPLOY_TOKEN] }
    command: node -e "console.log('token length ' + (process.env.DEPLOY_TOKEN ?? '').length)"
  - id: lint
    needs: [publish]
    command: node -e "console.log('lint sees ' + (process.env.DEPLOY_TOKEN ?? 'no token'))"
`;

const ROOTS = `schemaVersion: v1alpha1
name: check
description: Lint and test
invoke: allow
steps:
  - id: lint
    command: node -e "process.exit(0)"
  - id: test
    needs: []
    command: node -e "process.exit(0)"
`;

// Two commands that run until they are stopped and share the checkout, so one waits behind the other.
const SERVE = `schemaVersion: v1alpha1
name: check
description: Serve the app and watch its files
invoke: allow
steps:
  - id: serve
    command: sleep 300
  - id: watch
    needs: []
    command: sleep 300
`;

const TIMED = `schemaVersion: v1alpha1
name: check
description: Serve the app for half a minute
invoke: allow
steps:
  - id: serve
    timeout: 30s
    command: sleep 300
`;

const REVIEW = `schemaVersion: v1alpha1
name: review
description: Review the change
invoke: allow
steps:
  - id: review
    prompt: Review the change.
    scorers: [review-quality]
`;

const RELEASE = `schemaVersion: v1alpha1
name: release
description: Write the notes, review them, then deploy
invoke: allow
steps:
  - id: notes
    command: node -e "process.exit(0)"
  - id: plan-review
    needs: [notes]
    approve: Approve the release notes?
    command: node -e "process.exit(0)"
  - id: go-live
    needs: [plan-review]
    approve: { message: Deploy to production?, required: true }
    command: node -e "process.exit(0)"
`;

const SCORERS = { 'review-quality': `---
labels:
  - { value: thorough, score: 1, description: Did the work it was asked for }
  - { value: shallow, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 100
---
Judge the review.
` };

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function harness(workflows: Record<string, string>, options: Parameters<typeof skillHarness>[1] = {}) {
  const made = await skillHarness(workflows, options);
  roots.push(made.root);
  return made;
}

async function started(made: Awaited<ReturnType<typeof harness>>) {
  const answer = await made.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined });
  if (!('data' in answer) || !('turn' in answer.data)) throw new Error(JSON.stringify(answer));
  return answer.data.turn;
}

async function turnOf(answer: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>['call']>>) {
  if (!('data' in answer) || !('turn' in answer.data)) throw new Error(JSON.stringify(answer));
  return answer.data.turn;
}

/** Starts `name` and answers the host question with `choice`: the turn of the answer. */
async function chosen(made: Awaited<ReturnType<typeof harness>>, name: string, parallel: number, choice: 'h1' | 'h2' = 'h1') {
  const { run } = await turnOf(await made.call({ kind: 'start', name, answers: { parallel, confirmed: false }, inputs: undefined }));
  return turnOf(await made.call({ kind: 'choose', run, choice }));
}

/** The dispatches of `turn`. */
function dispatches(turn: Awaited<ReturnType<typeof turnOf>>) {
  return turn.actions.flatMap((action) => (action.kind === 'dispatch' ? [action] : []));
}

/** Plays the child of `brief`: it writes `result` where the brief says. */
function childWrites(brief: string, result: unknown): void {
  const file = /Write `([^`]+result\.json)`/.exec(fs.readFileSync(brief, 'utf8'))?.[1];
  if (!file) throw new Error(`the brief ${brief} names no result file`);
  fs.writeFileSync(file, JSON.stringify(result));
}

/** Polls until the run is done: its last turn, with every event the polls showed on the way. */
async function polledToDone(made: Awaited<ReturnType<typeof harness>>, run: RunId) {
  const events: Awaited<ReturnType<typeof turnOf>>['events'] = [];
  for (let poll = 0; poll < 10; poll += 1) {
    const turn = await turnOf(await made.call({ kind: 'next', run, wait: true }));
    events.push(...turn.events);
    if (turn.status === 'done') return { ...turn, events };
  }
  throw new Error('the run did not reach done in ten polls');
}

/** Starts REVIEW with `answers` and has its child review and report: the turn of the `next` after, in which the run is done. */
async function reviewed(made: Awaited<ReturnType<typeof harness>>, answers: { judge?: false } = {}) {
  const { run } = await turnOf(await made.call({ kind: 'start', name: 'review', answers: { confirmed: false, ...answers }, inputs: undefined }));
  const turn = await turnOf(await made.call({ kind: 'choose', run, choice: 'h1' }));
  const [dispatch] = dispatches(turn);
  if (!dispatch) throw new Error(JSON.stringify(turn));
  await made.call({ kind: 'ack', run: turn.run, attempt: dispatch.attempt });
  childWrites(dispatch.brief, { kind: 'output', output: 'Reviewed the change.' });
  await made.call({ kind: 'report', run: turn.run, attempt: dispatch.attempt, role: 'agent', modelUnavailable: false });
  return turnOf(await made.call({ kind: 'next', run: turn.run, wait: false }));
}

/** Starts RELEASE with `hitl`, then polls until a turn carries a gate's action: that turn. */
async function gated(made: Awaited<ReturnType<typeof harness>>, hitl: 'person' | 'recommend' | 'auto-approve') {
  const { run } = await turnOf(await made.call({ kind: 'start', name: 'release', answers: { confirmed: false, hitl }, inputs: undefined }));
  return gateTurn(made, run);
}

/** Polls `run` until a turn carries a gate's action, running a foreground next when a poll wakes: that turn. */
async function gateTurn(made: Awaited<ReturnType<typeof harness>>, run: RunId) {
  for (let poll = 0; poll < 10; poll += 1) {
    let turn = await turnOf(await made.call({ kind: 'next', run, wait: true }));
    if (turn.then?.kind === 'wake') turn = await turnOf(await made.call({ kind: 'next', run, wait: false }));
    if (turn.actions.some((action) => action.kind === 'person' || (action.kind === 'choose' && action.about === 'gate'))) return turn;
  }
  throw new Error('no gate came up in ten polls');
}

/** The runners with `sleep 300` faked: it runs until it is stopped, and `stops` gets the attempt of each stop. */
function sleepFaked(stops: string[]) {
  return (runners: Runners): Runners => ({
    ...runners,
    command: (input) => (input.command === 'sleep 300' ? untilStopped(() => { stops.push(input.env.TEAMAI_WORKFLOW_ATTEMPT ?? ''); }) : runners.command(input)),
  });
}

/** Starts SERVE: the turn, and its attempt that runs and the one that waits behind it. */
async function serving(made: Awaited<ReturnType<typeof harness>>) {
  const turn = await turnOf(await made.call({ kind: 'start', name: 'check', answers: { parallel: 2, confirmed: false }, inputs: undefined }));
  const running = turn.running.find((entry) => entry.phase === 'running');
  const queued = turn.running.find((entry) => entry.phase === 'queued');
  if (!running || !queued) throw new Error(JSON.stringify(turn));
  return { turn, running, queued };
}

/** The protocol with its first `next`, `report` or `prepare` answered by `script` instead. */
function scriptedOnce(script: (client: WorkflowClient) => Partial<Pick<WorkflowClient, 'next' | 'report' | 'prepare'>>) {
  return (client: WorkflowClient): WorkflowClient => {
    const first = script(client);
    let used = false;
    const once = <A extends unknown[], R>(scripted: ((...args: A) => R) | undefined, real: (...args: A) => R) => (...args: A): R => {
      if (!scripted || used) return real(...args);
      used = true;
      return scripted(...args);
    };
    return {
      ...client,
      next: once(first.next, (run, body) => client.next(run, body)),
      report: once(first.report, (run, body, options) => client.report(run, body, options)),
      prepare: once(first.prepare, (lock, lease) => client.prepare(lock, lease)),
    };
  };
}

/**
 * One case per group of rows. Each runs real calls through `runSkillCall` and asserts the rows it names were taken;
 * the last case checks the cases cover every row of `TRANSITIONS`.
 */
const CASES: Array<{ name: string; rows: string[]; run: () => Promise<string[]> }> = [
  {
    name: 'an optional gate of a run whose person said "you decide" is the agent\'s to answer, and its answer is recorded as an agent\'s',
    rows: ['R3', 'R9', 'D12', 'H2'],
    run: async () => {
      const made = await harness({ release: RELEASE });
      expect(await made.call({ kind: 'describe', name: 'release' })).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: {
        text: 'Only you can answer the approval at go-live, from your own terminal or teamai dashboard. Optional approvals: plan-review. How should optional approvals be answered?',
        options: [
          { label: 'Ask me at optional approvals', start: 'teamai workflow start release --driver skill --hitl person' },
          { label: 'You decide optional approvals', start: 'teamai workflow start release --driver skill --hitl recommend' },
          { label: 'Answer optional approvals automatically', start: 'teamai workflow start release --driver skill --auto-approve' },
        ],
      } } } } });
      expect(await made.call({ kind: 'start', name: 'release', answers: { confirmed: false }, inputs: undefined }))
        .toMatchObject({ error: { code: 'confirm_needed', message: expect.stringContaining('--hitl or --auto-approve') } });
      const turn = await gated(made, 'recommend');
      expect(turn.actions).toEqual([{
        kind: 'choose', about: 'gate', decide: 'agent', step: 'plan-review', pass: 1, question: 'Approve the release notes?',
        options: [
          { choice: 'yes', run: `teamai workflow respond ${turn.run} plan-review yes --pass 1 --driver skill` },
          { choice: 'no', run: `teamai workflow respond ${turn.run} plan-review no --pass 1 --driver skill` },
        ],
      }]);
      const answered = await turnOf(await made.call({ kind: 'respond', run: turn.run, step: 'plan-review', choice: 'yes', pass: 1 }));
      expect(answered.events).toContainEqual({ kind: 'answered', step: 'plan-review', choice: 'yes', channel: 'driver', agent: true });
      expect(await readRun(made.config, turn.run)).toMatchObject({ steps: expect.arrayContaining([
        expect.objectContaining({ id: 'plan-review', answer: expect.objectContaining({ choice: 'yes', channel: 'driver', agent: true, driver: expect.objectContaining({ kind: 'skill' }) }) }),
      ]) });
      return made.rows;
    },
  },
  {
    name: 'under auto-approve the engine answers the optional approval, and the required one waits for the person: the agent\'s answer is refused, the person\'s from their terminal clears it',
    rows: ['D10', 'H3', 'H5'],
    run: async () => {
      const made = await harness({ release: RELEASE });
      const turn = await gated(made, 'auto-approve');
      const { run } = turn;
      expect(turn.actions).toEqual([{
        kind: 'person', why: 'approval', step: 'go-live', pass: 1, message: 'Deploy to production?',
        say: 'Only you can answer this approval. Run one of these commands in your own terminal, or answer it in teamai dashboard.',
        run: [`teamai workflow respond ${run} go-live yes --pass 1`, `teamai workflow respond ${run} go-live no --pass 1`],
      }]);
      expect(turn.waiting).toEqual({ reason: 'go-live waits for the person\'s answer' });
      expect(await readRun(made.config, run)).toMatchObject({ steps: expect.arrayContaining([
        expect.objectContaining({ id: 'plan-review', answer: expect.objectContaining({ choice: 'yes', channel: 'auto_approve', agent: false }) }),
      ]) });
      expect(await made.call({ kind: 'respond', run, step: 'go-live', choice: 'yes', pass: 1 }))
        .toEqual({ error: expect.objectContaining({ code: 'agent_in_path', next: `teamai workflow next ${run} --driver skill --wait` }) });
      const person = respondProvenance({ kind: 'terminal', caller: { tty: true, evidence: { kind: 'none' } } });
      expect(await respondToHitl(made.config, run, made.context.env.secrets, { step: 'go-live', choice: 'yes', pass: 1, provenance: person })).not.toHaveProperty('error');
      const after = await turnOf(await made.call({ kind: 'next', run, wait: false }));
      expect(after.actions.filter((action) => action.kind === 'person')).toEqual([]);
      expect((await polledToDone(made, run)).actions).toContainEqual(expect.objectContaining({ kind: 'done', outcome: 'succeeded' }));
      return made.rows;
    },
  },
  {
    name: 'an optional gate of a run whose person said "ask me" is the agent\'s to put to the person; a choice it does not offer is refused, and an answer given twice changes nothing',
    rows: ['D11', 'H4', 'H1'],
    run: async () => {
      const made = await harness({ release: RELEASE });
      const turn = await gated(made, 'person');
      const { run } = turn;
      expect(turn.actions).toEqual([expect.objectContaining({ kind: 'choose', about: 'gate', decide: 'person', step: 'plan-review', pass: 1 })]);
      expect(await made.call({ kind: 'respond', run, step: 'plan-review', choice: 'maybe', pass: 1 }))
        .toEqual({ error: expect.objectContaining({ code: 'invalid_choice', next: `teamai workflow next ${run} --driver skill` }) });
      await turnOf(await made.call({ kind: 'respond', run, step: 'plan-review', choice: 'yes', pass: 1 }));
      const again = await turnOf(await made.call({ kind: 'respond', run, step: 'plan-review', choice: 'yes', pass: 1 }));
      expect(again.actions.filter((action) => action.kind === 'choose')).toEqual([]);
      return made.rows;
    },
  },
  {
    name: 'a command that requires env gets its key, and a step that does not require it runs without it',
    rows: ['D6', 'C1'],
    run: async () => {
      vi.stubEnv('DEPLOY_TOKEN', 'deploy-value-1304');
      const made = await harness({ check: SHIP });
      const tails: Record<string, string | undefined> = {};
      const { run } = await started(made);
      for (let poll = 0; poll < 10 && !('lint' in tails); poll += 1) {
        const answer = await made.call({ kind: 'next', run, wait: true });
        if (!('data' in answer) || !('turn' in answer.data)) throw new Error(JSON.stringify(answer));
        for (const event of answer.data.turn.events) if (event.kind === 'settled') tails[event.step] = event.tail;
      }
      expect(tails).toEqual({ publish: 'token length 17', lint: 'lint sees no token' });
      return made.rows;
    },
  },
  {
    name: 'a command-only run, from describe to done and a next after it',
    rows: ['R4', 'R10', 'S1', 'S5', 'D1', 'D6', 'D15', 'D16', 'D18', 'D20', 'D21', 'D23', 'C1', 'C8', 'P7', 'X2'],
    run: async () => {
      const made = await harness({ check: CHECK });
      expect(await made.call({ kind: 'describe', name: 'check' })).toMatchObject({ data: { describe: { ask: { kind: 'start' } } } });
      const { run } = await started(made);
      await polledToDone(made, run);
      const after = await made.call({ kind: 'next', run, wait: false });
      expect(after).toMatchObject({ data: { turn: { status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] } } });
      expect(JSON.stringify(after)).not.toContain('"then"');
      return made.rows;
    },
  },
  {
    name: 'a workflow with an interactive step is routed to the local driver',
    rows: ['R2', 'R8'],
    run: async () => {
      const made = await harness({ draft: DRAFT });
      expect(await made.call({ kind: 'describe', name: 'draft' })).toMatchObject({ data: { describe: { ask: { kind: 'local', start: 'teamai workflow start draft --driver local' } } } });
      expect(await made.call({ kind: 'start', name: 'draft', answers: { confirmed: false }, inputs: undefined })).toMatchObject({ error: { code: 'needs_local_driver', next: null } });
      return made.rows;
    },
  },
  {
    name: 'an invoke: ask workflow asks first, and a start without the answer is refused',
    rows: ['R3', 'R9'],
    run: async () => {
      const made = await harness({ gated: GATED });
      expect(await made.call({ kind: 'describe', name: 'gated' })).toMatchObject({ data: { describe: { ask: {
        kind: 'ask', question: { text: 'The team asks that you agree before it starts. Start it?', options: [{ label: 'Start it', start: 'teamai workflow start gated --driver skill --confirmed' }] },
      } } } });
      expect(await made.call({ kind: 'start', name: 'gated', answers: { confirmed: false }, inputs: undefined }))
        .toMatchObject({ error: { code: 'confirm_needed', next: 'teamai workflow start --describe gated --driver skill' } });
      return made.rows;
    },
  },
  {
    name: 'a run the skill driver did not start answers not_skill_run',
    rows: ['R11'],
    run: async () => {
      const made = await harness({ check: CHECK });
      const other = await made.context.client.start('check', { checkout: made.work });
      if (!('data' in other) || typeof other.data.run !== 'string') throw new Error(JSON.stringify(other));
      expect(await made.call({ kind: 'next', run: RunIdSchema.parse(other.data.run), wait: false })).toMatchObject({ error: { code: 'not_skill_run', next: null } });
      return made.rows;
    },
  },
  {
    name: 'a second session is refused with how long the owner has been idle, however long that is, and --takeover takes over at once',
    rows: ['S2', 'S4'],
    run: async () => {
      const made = await harness({ check: SERVE }, { runners: sleepFaked([]) });
      const { turn: { run } } = await serving(made);
      /** The seconds the refusal of a call from `session` says the owner has been idle, in its message and as a field. */
      const idle = async (session?: string): Promise<number> => {
        const answer = await made.call({ kind: 'next', run, wait: false }, session === undefined ? {} : { session });
        expect(answer).toEqual({ error: { code: 'orchestrator_active', message: expect.any(String), idleSeconds: expect.any(Number), next: `teamai workflow next ${run} --driver skill --takeover` } });
        const { message, idleSeconds } = 'error' in answer && 'idleSeconds' in answer.error ? answer.error : { message: '', idleSeconds: -1 };
        expect(message).toContain(`which last called ${idleSeconds} s ago`);
        return idleSeconds ?? -1;
      };
      const first = await idle('session-b');
      made.hold(true);
      // An owner quiet for an hour may be in a long talk with the person: only the person decides it is gone.
      await made.context.runners.sleep(3_600_000);
      expect(await idle('session-b')).toBe(first + 3600);
      expect((await turnOf(await made.call({ kind: 'takeover', run }, { session: 'session-b' }))).events).toContainEqual({ kind: 'takeover', from: 'session-a' });
      expect(await idle()).toBe(0);
      made.hold(false);
      return made.rows;
    },
  },
  {
    name: 'a busy run lock answers driver_running with the same literal',
    rows: ['D19'],
    run: async () => {
      const made = await harness({ check: CHECK });
      const { run } = await started(made);
      const busy = { take: async () => ({ error: { code: 'driver_running' as const, message: 'held' } }) };
      expect(await made.call({ kind: 'next', run, wait: false }, { locks: busy }))
        .toMatchObject({ error: { code: 'driver_running', next: `teamai workflow next ${run} --driver skill` } });
      return made.rows;
    },
  },
  {
    name: 'an engine error on next is relayed with the next literal',
    rows: ['D17'],
    run: async () => {
      const made = await harness({ check: CHECK }, { client: scriptedOnce(() => ({ next: async () => ({ error: { code: 'lease_conflict', message: 'scripted' } }) })) });
      const answer = await made.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined });
      expect(answer).toMatchObject({ error: { code: 'lease_conflict', message: 'scripted', next: expect.stringMatching(/^teamai workflow next r[0-9a-f]+ --driver skill$/) } });
      return made.rows;
    },
  },
  {
    name: 'a runner that never took its lock is started again',
    rows: ['C10'],
    run: async () => {
      let dropped = false;
      const dropFirst = (runners: Runners): Runners => ({
        ...runners,
        spawn: async (job) => { if (dropped) return runners.spawn(job); dropped = true; },
      });
      const made = await harness({ check: CHECK }, { runners: dropFirst });
      const { run } = await started(made);
      const done = await polledToDone(made, run);
      expect(done.actions).toMatchObject([{ kind: 'done', outcome: 'succeeded' }]);
      return made.rows;
    },
  },
  {
    name: 'a runner killed while its command runs: the next tick stops the command it left, then starts the step again',
    rows: ['C10'],
    run: async () => {
      const log: string[] = [];
      const logged = (runners: Runners): Runners => ({
        ...runners,
        command: (input) => {
          if (input.command !== 'sleep 300') return runners.command(input);
          log.push(`start ${input.attempt}`);
          return untilStopped(() => { log.push(`stop ${input.attempt}`); });
        },
      });
      const made = await harness({ check: SERVE }, { runners: logged });
      const { turn: { run }, running } = await serving(made);
      expect(log).toEqual([`start ${running.attempt}`]);
      expect(made.crashRunner(run, running.attempt)).toBe(true);
      // Longer than the 5 s a runner gets to take its lock, so the next tick starts it again.
      await made.context.runners.sleep(6_000);
      const restarted = await turnOf(await made.call({ kind: 'next', run, wait: false }));
      expect(restarted.events).toContainEqual({ kind: 'restarted', step: running.step, attempt: running.attempt });
      // The new runner prepares the place and starts the command again, a lock at a time.
      for (let turn = 0; turn < 5 && log.length < 3; turn += 1) await made.context.runners.sleep(1_000);
      expect(log).toEqual([`start ${running.attempt}`, `stop ${running.attempt}`, `start ${running.attempt}`]);
      return made.rows;
    },
  },
  {
    name: 'a place that fails to prepare is reported failed',
    rows: ['C7'],
    run: async () => {
      const made = await harness({ check: CHECK }, { client: scriptedOnce(() => ({ prepare: async () => ({ kind: 'failed', failure: { code: 'workspace_base', message: 'scripted' } }) })) });
      const { run } = await started(made);
      const done = await polledToDone(made, run);
      expect(done.actions).toMatchObject([{ kind: 'done', outcome: 'failed' }]);
      return made.rows;
    },
  },
  {
    name: 'an agent report is refused: an unknown attempt, and one its runner reports',
    rows: ['P2', 'P3'],
    run: async () => {
      const made = await harness({ check: CHECK });
      const turn = await started(made);
      const open = turn.running[0];
      if (!open) throw new Error('no attempt running');
      expect(await made.call({ kind: 'report', run: turn.run, attempt: AttemptIdSchema.parse('a00000000'), role: 'agent', modelUnavailable: false })).toMatchObject({ error: { code: 'unknown_attempt', next: `teamai workflow next ${turn.run} --driver skill` } });
      expect(await made.call({ kind: 'report', run: turn.run, attempt: open.attempt, role: 'agent', modelUnavailable: false })).toMatchObject({ error: { code: 'not_dispatched', next: `teamai workflow next ${turn.run} --driver skill` } });
      return made.rows;
    },
  },
  {
    name: 'repeated_report settles the attempt',
    rows: ['P8'],
    run: async () => {
      const made = await harness({ check: CHECK }, { client: scriptedOnce((client) => ({ report: async (run, body, options) => {
        await client.report(run, body, options);
        return { error: { code: 'repeated_report', message: 'scripted' } };
      } })) });
      const { run } = await started(made);
      await polledToDone(made, run);
      return made.rows;
    },
  },
  {
    name: 'a report of a lease cancelled meanwhile drops the attempt and shows it stopped',
    rows: ['P9'],
    run: async () => {
      // A second root keeps the run open, so its turns show what the runner of the cancelled lease does.
      const made = await harness({ check: ROOTS });
      const answer = await made.call({ kind: 'start', name: 'check', answers: { parallel: 1, confirmed: false }, inputs: undefined });
      if (!('data' in answer) || !('turn' in answer.data)) throw new Error(JSON.stringify(answer));
      const { run, running: [lint] } = answer.data.turn;
      if (lint?.step !== 'lint') throw new Error(JSON.stringify(answer));
      expect(await made.context.client.cancel(run, 'lint')).toMatchObject({ data: { cancelled: { attempts: [lint.attempt] } } });
      const done = await polledToDone(made, run);
      expect(done.events).toContainEqual({ kind: 'stopped', step: 'lint', attempt: lint.attempt, why: 'cancelled' });
      expect(done.events.filter((event) => event.kind === 'settled').map((event) => event.step)).toEqual(['test']);
      expect(done.running).toEqual([]);
      return made.rows;
    },
  },
  {
    name: 'a cancelled command is stopped by its runner at its next check, and a cancelled one waiting behind it is dropped',
    rows: ['D2', 'D3', 'D5', 'C9', 'P9'],
    run: async () => {
      const stops: string[] = [];
      const made = await harness({ check: SERVE }, { runners: sleepFaked(stops) });
      const { turn: { run }, running, queued } = await serving(made);
      await made.context.client.cancel(run, running.step);
      for (let call = 0; call < 2; call += 1) {
        expect((await turnOf(await made.call({ kind: 'next', run, wait: false }))).running).toContainEqual({ attempt: running.attempt, step: running.step, phase: 'stopping' });
      }
      expect(stops).toEqual([]);
      await made.context.client.cancel(run, queued.step);
      const events: unknown[] = [];
      for (let poll = 0; poll < 5 && events.length < 2; poll += 1) {
        events.push(...(await turnOf(await made.call({ kind: 'next', run, wait: true }))).events.filter((event) => event.kind === 'stopped'));
      }
      expect(events).toEqual(expect.arrayContaining([
        { kind: 'stopped', step: queued.step, attempt: queued.attempt, why: 'cancelled' },
        { kind: 'stopped', step: running.step, attempt: running.attempt, why: 'cancelled' },
      ]));
      expect(stops).toEqual([`${run}/${running.attempt}`]);
      return made.rows;
    },
  },
  {
    name: 'a command past its timeout is stopped by its runner at its deadline',
    rows: ['D3', 'C9', 'P9'],
    run: async () => {
      const stops: string[] = [];
      const made = await harness({ check: TIMED }, { runners: sleepFaked(stops) });
      const { run, running: [serve] } = await started(made);
      if (serve?.phase !== 'running') throw new Error(`serve is ${serve?.phase}`);
      const done = await polledToDone(made, run);
      expect(done.events).toContainEqual({ kind: 'stopped', step: 'serve', attempt: serve.attempt, why: 'timeout' });
      expect(done.actions).toMatchObject([{ kind: 'done', outcome: 'failed' }]);
      const engine = await readRun(made.config, run);
      expect(typeof engine === 'object' && engine.steps.find((step) => step.id === 'serve')).toMatchObject({ status: 'failed', failure: { code: 'timeout' } });
      expect(stops).toEqual([`${run}/${serve.attempt}`]);
      return made.rows;
    },
  },
  {
    name: 'an attempt whose runner is gone while it stops is given up by the next tick, which stops the command it left',
    rows: ['C11'],
    run: async () => {
      let gone = false;
      const stops: string[] = [];
      const made = await harness({ check: SERVE }, { runners: (runners) => ({ ...sleepFaked(stops)(runners), alive: async (run, attempt) => !gone && runners.alive(run, attempt) }) });
      const { turn: { run }, running } = await serving(made);
      await made.context.client.cancel(run, running.step);
      expect((await turnOf(await made.call({ kind: 'next', run, wait: false }))).running).toContainEqual({ attempt: running.attempt, step: running.step, phase: 'stopping' });
      gone = true;
      expect((await turnOf(await made.call({ kind: 'next', run, wait: false }))).events).toContainEqual({ kind: 'stopped', step: running.step, attempt: running.attempt, why: 'cancelled' });
      expect(stops).toEqual([`${run}/${running.attempt}`]);
      return made.rows;
    },
  },
  {
    name: 'a run cancelled while children work: each turn asks the agent to stop them, a poll wakes for that, and their reports give them up',
    rows: ['D4', 'D22', 'X4', 'P6', 'X2'],
    run: async () => {
      const made = await harness({ pair: PAIR });
      const turn = await chosen(made, 'pair', 2);
      const { run } = turn;
      const [first] = dispatches(turn);
      if (!first) throw new Error(JSON.stringify(turn));
      await made.call({ kind: 'ack', run, attempt: first.attempt });
      await made.context.client.cancel(run);
      const cancelled = await turnOf(await made.call({ kind: 'next', run, wait: false }));
      const stops = cancelled.actions.flatMap((action) => (action.kind === 'stop' ? [action] : []));
      expect(cancelled.actions.map((action) => action.kind)).toEqual(['stop', 'stop', 'done']);
      expect(stops.map(({ step, why }) => ({ step, why })).sort((a, b) => a.step.localeCompare(b.step))).toEqual([{ step: 'api', why: 'cancelled' }, { step: 'ui', why: 'cancelled' }]);
      expect(cancelled.then).toEqual({ kind: 'poll', run: `teamai workflow next ${run} --driver skill --wait` });
      const woken = await turnOf(await made.call({ kind: 'next', run, wait: true }));
      expect([woken.actions, woken.then]).toEqual([[], { kind: 'wake', run: `teamai workflow next ${run} --driver skill` }]);
      expect((await turnOf(await made.call({ kind: 'next', run, wait: false }))).actions).toEqual(cancelled.actions);
      for (const stop of stops) {
        expect(await made.call({ kind: 'report', run, attempt: stop.attempt, role: 'agent', modelUnavailable: false })).toEqual({ data: { runner: { attempt: stop.attempt, status: 'reported' } } });
      }
      const last = await turnOf(await made.call({ kind: 'next', run, wait: false }));
      expect(last.events).toEqual(stops.map(({ step, attempt }) => ({ kind: 'stopped', step, attempt, why: 'cancelled' })));
      expect(last.actions.map((action) => action.kind)).toEqual(['done']);
      expect(last).not.toHaveProperty('then');
      await made.call({ kind: 'next', run, wait: false });
      return made.rows;
    },
  },
  {
    name: 'a child in its own session reports without a session check, and its report refused once is sent when it runs the literal again',
    rows: ['S6', 'P5', 'P10', 'P11', 'P7'],
    run: async () => {
      const made = await harness({ pair: PAIR }, { client: scriptedOnce(() => ({ report: async () => ({ error: { code: 'protocol_unavailable', message: 'scripted' } }) })) });
      const turn = await chosen(made, 'pair', 2);
      const [first] = dispatches(turn);
      if (!first) throw new Error(JSON.stringify(turn));
      childWrites(first.brief, { kind: 'output', output: 'Done.' });
      const report = { kind: 'report', run: turn.run, attempt: first.attempt, role: 'agent', modelUnavailable: false } as const;
      expect(await made.call(report, { session: 'child-session' })).toEqual({ error: { code: 'protocol_unavailable', message: 'scripted', next: first.report } });
      expect(await made.call(report, { session: 'child-session' })).toEqual({ data: { runner: { attempt: first.attempt, status: 'reported' } } });
      expect((await turnOf(await made.call({ kind: 'next', run: turn.run, wait: false }))).events).toContainEqual(expect.objectContaining({ kind: 'settled', step: first.step, outcome: 'success' }));
      return made.rows;
    },
  },
  {
    name: 'a refused report is kept and sent again by the next tick',
    rows: ['P10', 'P11'],
    run: async () => {
      const made = await harness({ check: CHECK }, { client: scriptedOnce(() => ({ report: async () => ({ error: { code: 'protocol_unavailable', message: 'scripted' } }) })) });
      const { run } = await started(made);
      const done = await polledToDone(made, run);
      expect(done.actions).toMatchObject([{ kind: 'done', outcome: 'succeeded' }]);
      return made.rows;
    },
  },
  {
    name: 'two prompt steps: the host question, dispatches, a wake, acks, reports from result.json, and a repeated report',
    rows: ['R12', 'R13', 'D7', 'C2', 'D22', 'K1', 'K2', 'P5', 'P1'],
    run: async () => {
      const made = await harness({ pair: PAIR });
      const turn = await chosen(made, 'pair', 2);
      const { run } = turn;
      // Each runner offers its step when it is ready, so the dispatches come in either order.
      const api = dispatches(turn).find((action) => action.step === 'api');
      const ui = dispatches(turn).find((action) => action.step === 'ui');
      if (!api || !ui) throw new Error(JSON.stringify(turn));
      expect(ui.model).toEqual({ by: 'step', name: 'claude-haiku-4-5' });
      const woken = await turnOf(await made.call({ kind: 'next', run, wait: true }));
      expect([woken.actions, woken.then]).toEqual([[], { kind: 'wake', run: `teamai workflow next ${run} --driver skill` }]);
      await made.call({ kind: 'ack', run, attempt: api.attempt });
      expect(dispatches(await turnOf(await made.call({ kind: 'ack', run, attempt: api.attempt })))).toEqual([ui]);
      childWrites(api.brief, { kind: 'output', output: 'Wrote the API.' });
      const report = { kind: 'report', run, attempt: api.attempt, role: 'agent', modelUnavailable: false } as const;
      expect(await made.call(report)).toEqual({ data: { runner: { attempt: api.attempt, status: 'reported' } } });
      expect(await made.call(report)).toEqual({ data: { runner: { attempt: api.attempt, status: 'repeated' } } });
      expect((await turnOf(await made.call({ kind: 'next', run, wait: false }))).events).toContainEqual(expect.objectContaining({ kind: 'settled', step: 'api', outcome: 'success' }));
      return made.rows;
    },
  },
  {
    name: 'a poll returns once a child in its own session settles its step, with the events and no action, and the next turn does not show them again',
    rows: ['D25'],
    run: async () => {
      const made = await harness({ pair: PAIR });
      const turn = await chosen(made, 'pair', 2);
      const { run } = turn;
      for (const action of dispatches(turn)) await made.call({ kind: 'ack', run, attempt: action.attempt });
      const api = dispatches(turn).find((action) => action.step === 'api');
      if (!api) throw new Error(JSON.stringify(turn));
      childWrites(api.brief, { kind: 'output', output: 'Wrote the API.' });
      expect(await made.call({ kind: 'report', run, attempt: api.attempt, role: 'agent', modelUnavailable: false }, { session: 'child-session' }))
        .toEqual({ data: { runner: { attempt: api.attempt, status: 'reported' } } });
      const polled = await turnOf(await made.call({ kind: 'next', run, wait: true }));
      expect(polled).toMatchObject({ status: 'driving', actions: [], events: [{ kind: 'settled', step: 'api', outcome: 'success' }] });
      expect(polled.then).toEqual({ kind: 'poll', run: `teamai workflow next ${run} --driver skill --wait` });
      expect((await turnOf(await made.call({ kind: 'next', run, wait: false }))).events).toEqual([]);
      return made.rows;
    },
  },
  {
    name: 'the host question first: an ack or a report waits for it, and a second answer is refused',
    rows: ['R14', 'R15', 'K3'],
    run: async () => {
      const made = await harness({ pair: PAIR });
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'pair', answers: { parallel: 2, confirmed: false }, inputs: undefined }));
      const attempt = AttemptIdSchema.parse('a00000000');
      expect(await made.call({ kind: 'ack', run, attempt })).toMatchObject({ error: { code: 'choice_pending', next: `teamai workflow next ${run} --driver skill` } });
      expect(await made.call({ kind: 'report', run, attempt, role: 'agent', modelUnavailable: false })).toMatchObject({ error: { code: 'choice_pending' } });
      await made.call({ kind: 'choose', run, choice: 'h2' });
      expect(await made.call({ kind: 'choose', run, choice: 'h1' })).toMatchObject({ error: { code: 'unknown_choice', next: `teamai workflow next ${run} --driver skill` } });
      expect(await made.call({ kind: 'ack', run, attempt })).toMatchObject({ error: { code: 'unknown_offer', next: `teamai workflow next ${run} --driver skill` } });
      return made.rows;
    },
  },
  {
    name: 'a model the host cannot run fails the step: an alias with no model for the tool, and a model the agent reports unavailable',
    rows: ['C3', 'P4'],
    run: async () => {
      const aliased = await harness({ pair: PAIR.replace('model: claude-haiku-4-5', 'model: fast') });
      const turn = await chosen(aliased, 'pair', 2);
      // `fast` names no model for claude, so ui fails before a child starts, and api is offered alone.
      expect(turn.events).toContainEqual(expect.objectContaining({ kind: 'settled', step: 'ui', outcome: 'failed', failure: expect.objectContaining({ code: 'model_unavailable' }) }));
      expect(dispatches(turn).map((action) => action.step)).toEqual(['api']);
      const pinned = await harness({ pair: PAIR });
      const offered = await chosen(pinned, 'pair', 2);
      const ui = dispatches(offered).find((action) => action.step === 'ui');
      if (!ui?.unavailable) throw new Error(JSON.stringify(offered));
      expect(await pinned.call({ kind: 'report', run: offered.run, attempt: ui.attempt, role: 'agent', modelUnavailable: true })).toEqual({ data: { runner: { attempt: ui.attempt, status: 'reported' } } });
      const reported = await turnOf(await pinned.call({ kind: 'next', run: offered.run, wait: false }));
      expect(reported.events).toContainEqual(expect.objectContaining({ kind: 'settled', step: 'ui', outcome: 'failed', failure: expect.objectContaining({ code: 'model_unavailable' }) }));
      return [...aliased.rows, ...pinned.rows];
    },
  },
  {
    name: 'two steps in the checkout take turns: the second waits behind the first, and runs once it settled',
    rows: ['C4', 'D9'],
    run: async () => {
      const made = await harness({ check: ROOTS });
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'check', answers: { parallel: 2, confirmed: false }, inputs: undefined }));
      const done = await polledToDone(made, run);
      expect(done.actions).toMatchObject([{ kind: 'done', outcome: 'succeeded' }]);
      return made.rows;
    },
  },
  {
    name: 'a prompt step in a new workspace is offered once its setup ran with the env it requires, and its brief has no env value',
    rows: ['C2'],
    run: async () => {
      vi.stubEnv('SETUP_TOKEN', 'setup-token-value-1304');
      const made = await harness({ build: SETUP });
      const turn = await chosen(made, 'build', 1);
      const [build] = dispatches(turn);
      if (!build) throw new Error(JSON.stringify(turn));
      expect(fs.readFileSync(build.brief, 'utf8')).not.toContain('setup-token-value-1304');
      return made.rows;
    },
  },
  {
    name: 'a setup that fails settles the step with its own failure',
    rows: ['C7'],
    run: async () => {
      vi.stubEnv('SETUP_TOKEN', 'setup-token-value-1304');
      const made = await harness({ build: SETUP.replace('= 22', '= 0') });
      const turn = await chosen(made, 'build', 1);
      const done = turn.status === 'done' ? turn : await polledToDone(made, turn.run);
      expect(done.actions).toMatchObject([{ kind: 'done', outcome: 'failed' }]);
      expect([...turn.events, ...done.events]).toContainEqual(expect.objectContaining({ kind: 'settled', step: 'build', failure: expect.objectContaining({ code: 'setup_failed' }) }));
      return made.rows;
    },
  },
  {
    name: 'a poll with nothing to show ends at its bound with the same poll',
    rows: ['D24'],
    run: async () => {
      const held = (runners: Runners): Runners => ({ ...runners, spawn: async () => {}, alive: async () => true });
      const made = await harness({ check: CHECK }, { runners: held });
      const { run } = await started(made);
      expect(await made.call({ kind: 'next', run, wait: true })).toEqual({ data: { turn: expect.objectContaining({
        status: 'driving', actions: [], events: [],
        // oxlint-disable-next-line unicorn/no-thenable
        then: { kind: 'poll', run: `teamai workflow next ${run} --driver skill --wait` },
      }) } });
      return made.rows;
    },
  },
  {
    name: 'judging here is asked about first, with each option again without judging, and a start without it judges nothing',
    rows: ['R3', 'R10'],
    run: async () => {
      const made = await harness({ review: REVIEW }, { scorers: SCORERS });
      fakeJudge(made.root, 'thorough');
      expect(await made.call({ kind: 'describe', name: 'review' })).toMatchObject({ data: { describe: { judging: { kind: 'here', tool: 'claude' }, ask: { kind: 'ask', question: {
        text: 'claude judges review here, with one confined judge call per pass. Start it?',
        options: [{ label: 'Start it', start: 'teamai workflow start review --driver skill' }, { label: 'Start it, without judging', start: 'teamai workflow start review --driver skill --no-judge' }],
      } } } } });
      expect(await reviewed(made, { judge: false })).toEqual(expect.objectContaining({ status: 'done', actions: [{ kind: 'done', outcome: 'succeeded', prs: [] }], events: [expect.objectContaining({ kind: 'settled' })] }));
      expect(made.rows).not.toContain('J1');
      return made.rows;
    },
  },
  {
    name: 'a scored pass is judged once the run is done, and next shows the judge until it answers',
    rows: ['J1', 'J2', 'X1', 'J3'],
    run: async () => {
      const made = await harness({ review: REVIEW }, { scorers: SCORERS });
      fakeJudge(made.root, 'thorough');
      const done = await reviewed(made);
      expect(done.events).toContainEqual(expect.objectContaining({ kind: 'judging', step: 'review', scorers: ['review-quality'] }));
      expect(await turnOf(await made.call({ kind: 'next', run: done.run, wait: false }))).toMatchObject({
        status: 'done', actions: [{ kind: 'done', judging: { step: 'review', scorers: ['review-quality'] } }],
        // oxlint-disable-next-line unicorn/no-thenable
        then: { kind: 'poll' },
      });
      expect((await turnOf(await made.call({ kind: 'next', run: done.run, wait: true }))).events).toEqual([{ kind: 'judged', step: 'review', scorer: 'review-quality', label: 'thorough' }]);
      return made.rows;
    },
  },
  {
    name: 'a judge that fails turns judging off, and the run asks for no more polls',
    rows: ['J4'],
    run: async () => {
      const made = await harness({ review: REVIEW }, { scorers: SCORERS });
      fakeJudge(made.root, 'thorough', 1);
      const done = await reviewed(made);
      const polled = await turnOf(await made.call({ kind: 'next', run: done.run, wait: true }));
      expect(polled).toEqual({ run: done.run, status: 'done', running: [], actions: [{ kind: 'done', outcome: 'succeeded', prs: [] }],
        events: [{ kind: 'judging-off', failure: { code: 'judge_failed', message: expect.stringContaining('claude exited with code 1') } }] });
      return made.rows;
    },
  },
  {
    name: 'a judge whose runner died turns judging off once the grace passed',
    rows: ['J5'],
    run: async () => {
      // The first runner is the review step's; the judge's never starts, as one killed at once.
      let spawns = 0;
      const made = await harness({ review: REVIEW }, { scorers: SCORERS, runners: (runners) => ({ ...runners, spawn: async (job) => { spawns += 1; if (spawns === 1) await runners.spawn(job); } }) });
      fakeJudge(made.root, 'thorough');
      const done = await reviewed(made);
      expect((await turnOf(await made.call({ kind: 'next', run: done.run, wait: true }))).events).toEqual([{ kind: 'judging-off', failure: { code: 'judge_runner_gone', message: expect.stringContaining('step review') } }]);
      return made.rows;
    },
  },
  {
    name: 'score --next refusing the judge turns judging off',
    rows: ['J6'],
    run: async () => {
      const refusal = { code: 'scoring_settings_invalid', message: 'scoring.isolation in config.yaml is not a known level.' };
      const made = await harness({ review: REVIEW }, { scorers: SCORERS, client: (client) => ({ ...client, scoreNext: async () => ({ error: refusal }) }) });
      fakeJudge(made.root, 'thorough');
      expect((await chosen(made, 'review', 1)).events).toContainEqual({ kind: 'judging-off', failure: refusal });
      return made.rows;
    },
  },
];

const COLUMNS = ['id', 'state', 'input', 'guard', 'effects', 'next', 'action'] as const;

function render(row: TransitionRow): string {
  return `| ${COLUMNS.map((column) => row[column]).join(' | ')} |`.replace(/ {2}\|/g, ' |');
}

/** Every table row under `## The skill driver` in the engine notes. */
function documentedRows(): TransitionRow[] {
  const doc = fs.readFileSync(path.join(import.meta.dirname, '../../docs/dev/workflow-engine.md'), 'utf8');
  const section = doc.split(/^## /m).find((part) => part.startsWith('The skill driver\n'));
  if (!section) throw new Error('docs/dev/workflow-engine.md has no "## The skill driver" section');
  return section.split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Row |'))
    .map((line) => {
      const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
      if (cells.length !== COLUMNS.length) throw new Error(`A skill driver row has ${cells.length} cells, not ${COLUMNS.length}: ${line}`);
      const [id = '', state = '', input = '', guard = '', effects = '', next = '', action = ''] = cells;
      return { id, state, input, guard, effects, next, action };
    });
}

describe('skill driver transitions', () => {
  it('documents every row of TRANSITIONS, cell by cell, and no other', () => {
    const documented = documentedRows().map(render);
    const coded = TRANSITIONS.map(render);
    expect(new Set(documented).size, 'a row is documented twice').toBe(documented.length);
    expect([...documented].sort(), `Paste these rows under ## The skill driver in docs/dev/workflow-engine.md:\n${coded.join('\n')}`).toEqual([...coded].sort());
  });

  for (const { name, rows, run } of CASES) {
    it(`takes ${rows.join(', ')}: ${name}`, async () => {
      const taken = new Set(await run());
      expect(rows.filter((row) => !taken.has(row))).toEqual([]);
    });
  }

  it('has a case for every row', () => {
    const covered = new Set(CASES.flatMap(({ rows }) => rows));
    expect(TRANSITIONS.map(({ id }) => id).filter((id) => !covered.has(id))).toEqual([]);
    expect([...covered].filter((id) => !TRANSITIONS.some((row) => row.id === id))).toEqual([]);
  });
});
