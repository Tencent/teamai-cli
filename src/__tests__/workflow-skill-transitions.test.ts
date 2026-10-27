import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { driverIdentity } from '../driver-identity.js';
import { resolveWorkflowEnv } from '../env-resolution.js';
import { publishRun } from '../workflow/handoff.js';
import { recordGroup } from '../tool-launch/process-stop.js';
import { reportsBranch } from '../utils/reports-branch.js';
import { inProcessClient, type WorkflowClient } from '../workflow/protocol.js';
import type { LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { WORKSPACE_MODES } from '../workflow/types.js';
import { runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { respondProvenance, respondToHitl } from '../workflow/run-controls.js';
import { attemptDir, AttemptIdSchema, deliveryLockPath, readRun, RunIdSchema, runsDir, skillStatePath, updateRun, type RunId } from '../workflow/store.js';
import { DeliveryReceiptSchema } from '../workflow/delivery-schema.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import type { Runners } from '../workflow/drivers/skill/skill-driver.js';
// The doc comparison reads the table itself; every behaviour below goes through runSkillCall.
import { TRANSITIONS, type TransitionRow } from '../workflow/drivers/skill/transitions.js';
import { fakeJudge, githubOrigin, sharedTeam, skillHarness, untilStopped } from './helpers/skill-harness.js';

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

// A prompt step its workflow wants sandboxed, which no skill host enforces.
const BOXED = `schemaVersion: v1alpha1
name: boxed
description: Try the untrusted script
invoke: allow
steps:
  - id: try
    requires: { isolation: sandbox }
    prompt: Run the script and say what it did.
`;

// DRAFT, with the person reading only.
const DRAFT_READ = DRAFT.replace('name: draft', 'name: draft-read').replace('    interactive: true\n', '    interactive: true\n    workspace: read-only\n');

const RELEASE_DOCS = `schemaVersion: v1alpha1
name: release-docs
description: Draft the release notes, then sign them
invoke: allow
steps:
  - id: docs
    workspace: new
    workflow:
      steps:
        - id: draft
          prompt: Draft the release notes.
        - id: sign
          needs: [draft]
          prompt: Sign the notes.
          requires: { env: [SIGNING_KEY] }
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

const REVIEWED = `schemaVersion: v1alpha1
name: reviewed
description: Review the change with the team's reviewers
invoke: allow
defaults:
  model: claude-haiku-4-5
steps:
  - id: plain
    workspace: new
    agent: plain-reviewer
    prompt: Review the change.
  - id: pinned
    needs: []
    workspace: new
    agent: pinned-reviewer
    prompt: Review it again.
`;

const SITE = `schemaVersion: v1alpha1
name: site
description: Plan the settings page
invoke: allow
steps:
  - id: site
    workflow:
      steps:
        - id: settings-page-with-every-tab-the-person-asked-for-in-the-ticket
          prompt: Plan the settings page.
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

const WRITE = `schemaVersion: v1alpha1
name: write
description: Write a change
invoke: allow
steps:
  - id: write
    workspace: new
    prompt: Write the change.
`;

const INLINE = `schemaVersion: v1alpha1
name: inline
description: Write the notes, then change the code
invoke: allow
steps:
  - id: notes
    prompt: Write the notes.
  - id: change
    needs: [notes]
    workspace: new
    prompt: Change the code.
`;

// Two copies that each add shared.txt, then a step that merges both and resolves what conflicts.
const JOIN = `schemaVersion: v1alpha1
name: join
description: Write both sides, then join them
invoke: allow
steps:
  - id: left
    workspace: new
    prompt: Write the left side.
  - id: right
    needs: []
    workspace: new
    prompt: Write the right side.
  - id: join
    needs: [left, right]
    workspace: new
    prompt: Join both sides.
`;

const GATED = `schemaVersion: v1alpha1
name: gated
description: Lint once the person agrees
invoke: ask
steps:
  - id: lint
    command: node -e "process.exit(0)"
`;

const LOCKED = `schemaVersion: v1alpha1
name: locked
description: Lint, only from the person's own terminal
invoke: deny
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

// The input reaches the command only through its env: a value a shell would expand stays plain text.
const GREET = `schemaVersion: v1alpha1
name: check
description: Greet someone
invoke: allow
inputs: { who: string }
steps:
  - id: greet
    env: { NAME: "{{ inputs.who }}" }
    command: node -e "console.log(process.env.NAME)"
`;

// Passes once the file RETRY_FLAG names exists, outside the checkout the step only reads.
const FLAGGED = `schemaVersion: v1alpha1
name: check
description: Check the flag
invoke: allow
steps:
  - id: flag
    command: node -e "require('fs').existsSync(process.env.RETRY_FLAG) || process.exit(1)"
`;

const DIRTY = `schemaVersion: v1alpha1
name: check
description: Write the notes into the checkout
invoke: allow
steps:
  - id: notes
    command: node -e "require('fs').writeFileSync('NOTES.txt', 'notes')"
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

const IMPLEMENT = `schemaVersion: v1alpha1
name: implement
description: Implement the change and open a pull request for it
invoke: allow
steps:
  - id: implement
    workspace: new
    command: node -e "require('fs').writeFileSync('work.txt', 'W')"
    deliver: pr
`;

const PUBLISH = `schemaVersion: v1alpha1
name: publish
description: Build the package, then tell the team
invoke: allow
steps:
  - id: build
    command: node -e "process.exit(0)"
  - id: notify
    needs: [build]
    requires: { env: [SLACK_TOKEN] }
    prompt: Tell the team the package is out.
`;

// An approval, then a step this driver is held from: answering the approval leaves only that step.
const SHIP_AFTER = `schemaVersion: v1alpha1
name: ship
description: Ship once the person agrees, then tell the team
invoke: allow
steps:
  - id: go
    approve: { message: Ship it?, required: true }
  - id: notify
    needs: [go]
    requires: { env: [SLACK_TOKEN] }
    prompt: Tell the team the package is out.
`;

const SHIP_OPTIONAL = SHIP_AFTER.replace('approve: { message: Ship it?, required: true }', 'approve: Ship it?');

// Only an optional approval: an unattended run answers it as --auto-approve does.
const APPROVED = `schemaVersion: v1alpha1
name: approved
description: Lint once it is approved
invoke: allow
steps:
  - id: lint
    approve: Lint now?
    command: node -e "process.exit(0)"
`;

// An approval beside a step this driver is held from: the engine answers the held step first.
const SHIP_BESIDE = SHIP_AFTER.replace('needs: [go]', 'needs: []');

// CI builds, and leaves the API and the UI, which a coding session writes, to whoever continues the run.
const HANDED = `schemaVersion: v1alpha1
name: handed
description: Build, then write the API and the UI
steps:
  - id: build
    command: node -e "process.exit(0)"
  - id: api
    needs: [build]
    workspace: new
    prompt: Write the API.
  - id: ui
    needs: [build]
    workspace: new
    prompt: Write the UI.
`;

// A step after RELEASE's required approval, and one after HANDED's UI.
const ANNOUNCE = `  - id: announce
    needs: [go-live]
    command: node -e "process.exit(0)"
`;
const GO_LIVE_AFTER_UI = `  - id: go-live
    needs: [ui]
    approve: { message: Deploy to production?, required: true }
    command: node -e "process.exit(0)"
`;

// HANDED with invoke: allow and a required approval between the build and the prompt steps.
const HANDED_GATED = HANDED.replace('description: Build, then write the API and the UI', 'description: Build, then write the API and the UI\ninvoke: allow')
  .replace('  - id: api\n    needs: [build]', '  - id: go-live\n    needs: [build]\n    approve: { message: Go live?, required: true }\n    command: node -e "process.exit(0)"\n  - id: api\n    needs: [go-live]')
  .replace('  - id: ui\n    needs: [build]', '  - id: ui\n    needs: [go-live]');

// A review whose required approval sits in a workflow that never runs.
const SKIPPED_REVIEW = `schemaVersion: v1alpha1
name: skipping
description: Ship, with a review that is switched off
invoke: allow
steps:
  - id: prep
    command: node -e "process.exit(0)"
  - id: review
    needs: [prep]
    if: steps.prep.outcome == 'failed'
    workflow:
      steps:
        - id: sign-off
          approve: { message: Sign off?, required: true }
          command: node -e "process.exit(0)"
  - id: ship
    needs: [prep]
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

/** The evidence of a process an agent session runs. */
const AGENT = { kind: 'session', variable: 'CLAUDE_CODE_SESSION_ID' } as const;

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

/**
 * Starts `name` on `install` from its checkout, as a CI job does, leases its first step to that machine's local driver,
 * and publishes the run with the lease in flight: the run, and the attempt of that lease.
 */
async function publishedMidStep(install: { config: LocalConfig; checkout: string }, name: string) {
  const client = inProcessClient({ config: install.config, env: await resolveWorkflowEnv(install.config) });
  const started = await client.start(name, { checkout: install.checkout, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
  if (!('data' in started) || typeof started.data.run !== 'string') throw new Error(JSON.stringify(started));
  const run = RunIdSchema.parse(started.data.run);
  const leased = await client.next(run, { driver: { kind: 'local', machine: 'ci', workspace: install.checkout, can: { workspace: [...WORKSPACE_MODES] } } });
  const attempt = 'data' in leased && typeof leased.data.lease === 'object' && leased.data.lease !== null && 'attempt' in leased.data.lease ? String(leased.data.lease.attempt) : '';
  expect(attempt, JSON.stringify(leased)).not.toBe('');
  expect(await publishRun(install.config, run, { checkout: install.checkout })).toMatchObject({ ok: true, value: { inFlight: [{ attempt }] } });
  return { run, attempt };
}

/** Polls `run`, running a foreground next when a poll wakes, until a turn carries a dispatch: that turn. */
async function dispatchTurn(made: Awaited<ReturnType<typeof harness>>, run: RunId) {
  for (let poll = 0; poll < 10; poll += 1) {
    let turn = await turnOf(await made.call({ kind: 'next', run, wait: true }));
    if (turn.then?.kind === 'wake') turn = await turnOf(await made.call({ kind: 'next', run, wait: false }));
    if (dispatches(turn).length > 0) return turn;
  }
  throw new Error('no dispatch came up in ten polls');
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
        text: '- Only you can answer the approval at go-live, from your own terminal or teamai dashboard.\n- Optional approval at plan-review: before `node -e "process.exit(0)"`.\n- The recommended start lets this session\'s agent answer optional approvals and say why; "answer optional approvals automatically" answers each approval yes.\nHow should it run?',
        options: [
          { label: 'Recommended: you decide optional approvals', start: 'teamai workflow start release --driver skill --hitl recommend' },
          { label: 'Same, but ask me at optional approvals', start: 'teamai workflow start release --driver skill --hitl person' },
          { label: 'Same, but answer optional approvals automatically', start: 'teamai workflow start release --driver skill --auto-approve' },
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
    name: 'an approval the person answered from their terminal leaves the turn once only a held step is left, required or optional, and the agent\'s late answer to it too',
    rows: ['D10', 'D11', 'D14', 'D27', 'H5', 'H1'],
    run: async () => {
      vi.stubEnv('SLACK_TOKEN', 'slack-value-1304');
      const person = respondProvenance({ kind: 'terminal', caller: { tty: true, evidence: { kind: 'none' } } });
      const required = await harness({ ship: SHIP_AFTER });
      const asked = await chosen(required, 'ship', 1);
      expect(asked.actions).toEqual([expect.objectContaining({ kind: 'person', why: 'approval', step: 'go' })]);
      expect(await respondToHitl(required.config, asked.run, required.context.env.secrets, { step: 'go', choice: 'yes', pass: 1, provenance: person })).not.toHaveProperty('error');
      const handed = await turnOf(await required.call({ kind: 'next', run: asked.run, wait: false }));
      expect(handed.actions).toEqual([expect.objectContaining({ kind: 'person', why: 'handoff', message: expect.stringMatching(/Nothing else of the run is open\.$/) })]);

      const optional = await harness({ ship: SHIP_OPTIONAL });
      const { run } = await turnOf(await optional.call({ kind: 'start', name: 'ship', answers: { confirmed: false, hitl: 'person' }, inputs: undefined }));
      expect((await turnOf(await optional.call({ kind: 'choose', run, choice: 'h1' }))).actions).toEqual([expect.objectContaining({ kind: 'choose', about: 'gate', step: 'go' })]);
      expect(await respondToHitl(optional.config, run, optional.context.env.secrets, { step: 'go', choice: 'yes', pass: 1, provenance: person })).not.toHaveProperty('error');
      const late = await turnOf(await optional.call({ kind: 'respond', run, step: 'go', choice: 'yes', pass: 1 }));
      expect(late.actions).toEqual([expect.objectContaining({ kind: 'person', why: 'handoff' })]);
      return [...required.rows, ...optional.rows];
    },
  },
  {
    name: 'a required approval beside a held step still reaches the person, beside the handoff, which no longer says nothing else is open',
    rows: ['D14', 'D27', 'D10'],
    run: async () => {
      vi.stubEnv('SLACK_TOKEN', 'slack-value-1304');
      const made = await harness({ ship: SHIP_BESIDE });
      const turn = await chosen(made, 'ship', 1);
      expect(turn.actions).toEqual([
        expect.objectContaining({ kind: 'person', why: 'approval', step: 'go', run: [`teamai workflow respond ${turn.run} go yes --pass 1`, `teamai workflow respond ${turn.run} go no --pass 1`] }),
        expect.objectContaining({ kind: 'person', why: 'handoff', held: [{ step: 'notify', missing: ['env'] }], message: expect.not.stringContaining('Nothing else') }),
      ]);
      return made.rows;
    },
  },
  {
    name: 'a step whose pull request another process is opening keeps the run waiting, and done carries the pull request',
    rows: ['D13'],
    run: async () => {
      const made = await harness({ implement: IMPLEMENT });
      githubOrigin(made);
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'implement', answers: { confirmed: false }, inputs: undefined }));
      const held = deliveryLockPath(made.config, run);
      expect(await acquireLock(held)).toBe(true);
      try {
        expect(await turnOf(await made.call({ kind: 'next', run, wait: true }))).toMatchObject({ waiting: { reason: 'implement is delivering', delivering: ['implement'] } });
      } finally {
        await releaseLock(held);
      }
      expect((await polledToDone(made, run)).actions).toEqual([{ kind: 'done', outcome: 'succeeded', prs: ['https://github.com/fixture/app/pull/1'] }]);
      return made.rows;
    },
  },
  {
    name: 'a run whose only step left is held for this driver wakes the poll, and the next turn hands it to the person with the resume literal and no then',
    rows: ['D14', 'D26'],
    run: async () => {
      vi.stubEnv('SLACK_TOKEN', 'slack-value-1304');
      const made = await harness({ publish: PUBLISH });
      const { run } = await chosen(made, 'publish', 1);
      let polled = await turnOf(await made.call({ kind: 'next', run, wait: true }));
      for (let poll = 0; poll < 5 && polled.then?.kind !== 'wake'; poll += 1) polled = await turnOf(await made.call({ kind: 'next', run, wait: true }));
      expect(polled.actions).toEqual([]);
      expect(polled.then).toEqual({ kind: 'wake', run: `teamai workflow next ${run} --driver skill` });
      const turn = await turnOf(await made.call({ kind: 'next', run, wait: false }));
      expect(turn.actions).toEqual([expect.objectContaining({ kind: 'person', why: 'handoff', held: [{ step: 'notify', missing: ['env'] }], run: [`teamai workflow resume ${run} --tools default=claude`] })]);
      expect(turn).not.toHaveProperty('then');
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
    name: 'a step env value reaches the command as its env, never as command text',
    rows: ['D6', 'C1'],
    run: async () => {
      const commands: Array<{ command: string; name: string | undefined }> = [];
      const made = await harness({ check: GREET }, { runners: (runners) => ({ ...runners, command: (input) => { commands.push({ command: input.command, name: input.env.NAME }); return runners.command(input); } }) });
      const who = '$(echo pwned) Ada';
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: { who } }));
      const done = await polledToDone(made, run);
      expect(done.events).toContainEqual(expect.objectContaining({ kind: 'settled', step: 'greet', outcome: 'success', tail: who }));
      expect(commands).toEqual([{ command: 'node -e "console.log(process.env.NAME)"', name: who }]);
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
    name: 'a run that failed and was retried is driven again: the next call leases the retried step instead of showing the old end',
    rows: ['X5', 'X6', 'D6'],
    run: async () => {
      const made = await harness({ check: FLAGGED });
      const flag = path.join(made.root, 'flag');
      vi.stubEnv('RETRY_FLAG', flag);
      const { run } = await started(made);
      expect((await polledToDone(made, run)).actions).toEqual([expect.objectContaining({ kind: 'done', outcome: 'failed' })]);
      fs.writeFileSync(flag, 'set');
      expect(await made.context.client.retry(run, 'flag')).toMatchObject({ data: { run: { status: 'running' } } });
      const retried = await turnOf(await made.call({ kind: 'next', run, wait: false }));
      expect(retried).toMatchObject({ status: 'driving', events: [{ kind: 'started', step: 'flag' }] });
      expect((await polledToDone(made, run)).actions).toEqual([{ kind: 'done', outcome: 'succeeded', prs: [] }]);
      return made.rows;
    },
  },
  {
    name: 'a run that failed, was retried and was finished by another driver shows the end that driver reached, not the one this driver saw',
    rows: ['X5', 'X6', 'D16'],
    run: async () => {
      const made = await harness({ check: FLAGGED });
      const flag = path.join(made.root, 'flag');
      vi.stubEnv('RETRY_FLAG', flag);
      const { run } = await started(made);
      expect((await polledToDone(made, run)).actions).toEqual([expect.objectContaining({ kind: 'done', outcome: 'failed' })]);
      fs.writeFileSync(flag, 'set');
      expect(await made.context.client.retry(run, 'flag')).toMatchObject({ data: { run: { status: 'running' } } });
      expect(await runLocalDriver(made.config, run, made.work)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(await turnOf(await made.call({ kind: 'next', run, wait: false }))).toMatchObject({ status: 'done', actions: [{ kind: 'done', outcome: 'succeeded', prs: [] }] });
      return made.rows;
    },
  },
  {
    name: 'a done run asks the engine again only once its run file changed, so no tick republishes an end already out',
    rows: ['X7'],
    run: async () => {
      let asked = 0;
      const made = await harness({ check: CHECK }, { client: (client) => ({ ...client, next: async (...args) => { asked += 1; return client.next(...args); } }) });
      const { run } = await started(made);
      expect((await polledToDone(made, run)).actions).toEqual([expect.objectContaining({ kind: 'done', outcome: 'succeeded' })]);
      const before = asked;
      for (let call = 0; call < 3; call += 1) expect(await turnOf(await made.call({ kind: 'next', run, wait: false }))).toMatchObject({ status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] });
      expect(asked).toBe(before);
      return made.rows;
    },
  },
  {
    name: 'a retry that lands while the engine answers done is still driven: the kept end never takes the retried run\'s version',
    rows: ['D16', 'X5', 'X6', 'D6'],
    run: async () => {
      let flag = '';
      let retried = false;
      const made = await harness({ check: FLAGGED }, { client: (client) => ({ ...client, next: async (...args) => {
        const answer = await client.next(...args);
        if (!retried && JSON.stringify(answer).includes('"done"')) {
          retried = true;
          fs.writeFileSync(flag, 'set');
          await client.retry(args[0], 'flag');
        }
        return answer;
      } }) });
      flag = path.join(made.root, 'flag');
      vi.stubEnv('RETRY_FLAG', flag);
      const { run } = await started(made);
      expect((await polledToDone(made, run)).actions).toEqual([expect.objectContaining({ kind: 'done', outcome: 'failed' })]);
      expect(await turnOf(await made.call({ kind: 'next', run, wait: false }))).toMatchObject({ status: 'driving', events: [{ kind: 'started', step: 'flag' }] });
      expect((await polledToDone(made, run)).actions).toEqual([{ kind: 'done', outcome: 'succeeded', prs: [] }]);
      return made.rows;
    },
  },
  {
    name: 'a done run whose end failed to reach teamai-reports asks the engine again on each tick, which publishes it, until it is out',
    rows: ['D16', 'X5', 'X6', 'X7'],
    run: async () => {
      let offline = true;
      let asked = 0;
      const made = await harness({ check: CHECK }, { client: (client) => ({ ...client, next: async (...args) => {
        const answer = await client.next(...args);
        if (!('data' in answer) || typeof answer.data !== 'object' || answer.data === null || !('done' in answer.data)) return answer;
        asked += 1;
        const { done } = answer.data;
        return offline && typeof done === 'object' ? { data: { ...answer.data, done: { ...done, notPublished: { code: 'publish_failed', message: 'offline' } } } } : answer;
      } }) });
      const { run } = await started(made);
      expect((await polledToDone(made, run)).actions).toEqual([expect.objectContaining({ kind: 'done', outcome: 'succeeded' })]);
      const offlineAsks = asked;
      await made.call({ kind: 'next', run, wait: false });
      expect(asked).toBe(offlineAsks + 1);
      offline = false;
      await made.call({ kind: 'next', run, wait: false });
      const out = asked;
      for (let call = 0; call < 2; call += 1) expect(await turnOf(await made.call({ kind: 'next', run, wait: false }))).toMatchObject({ status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] });
      expect(asked).toBe(out);
      return made.rows;
    },
  },
  {
    name: 'a done run asks the engine again once a pull request receipt reaches its run file, and lists that pull request',
    rows: ['X5', 'X6', 'D16'],
    run: async () => {
      const made = await harness({ check: CHECK });
      const { run } = await started(made);
      expect((await polledToDone(made, run)).actions).toEqual([expect.objectContaining({ kind: 'done', outcome: 'succeeded', prs: [] })]);
      const receipt = DeliveryReceiptSchema.parse({ url: 'https://github.com/acme/app/pull/7', branch: 'teamai/check', base: 'main', step: 'greet', pass: 1 });
      await updateRun(made.config, run, {}, async (loaded) => (typeof loaded === 'object' ? { value: undefined, write: { ...loaded, deliveries: [receipt] } } : { value: undefined }));
      expect(await turnOf(await made.call({ kind: 'next', run, wait: false }))).toMatchObject({ status: 'done', actions: [{ kind: 'done', outcome: 'succeeded', prs: ['https://github.com/acme/app/pull/7'] }] });
      return made.rows;
    },
  },
  {
    name: 'a command that exits 0 but writes into the checkout it only reads settles failed with the engine\'s failure',
    rows: ['P7'],
    run: async () => {
      const made = await harness({ check: DIRTY });
      const { run } = await started(made);
      const done = await polledToDone(made, run);
      expect(done.events).toContainEqual(expect.objectContaining({
        kind: 'settled', step: 'notes', outcome: 'failed', exitCode: 0, failure: expect.objectContaining({ code: 'read_only_dirty' }),
      }));
      return made.rows;
    },
  },
  {
    name: 'describe tells the person a delivering workflow cannot start from a detached HEAD, and a start the engine refuses points at describe only when another answer fixes it',
    rows: ['R16', 'R10'],
    run: async () => {
      const made = await harness({ implement: IMPLEMENT });
      expect(await made.call({ kind: 'start', name: 'implement', answers: { confirmed: false }, inputs: { extra: 1 } }))
        .toMatchObject({ error: { code: 'invalid_inputs', next: 'teamai workflow start --describe implement --driver skill' } });
      execFileSync('git', ['checkout', '-q', '--detach'], { cwd: made.work });
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: made.work, encoding: 'utf8' }).trim();
      const reason = `Step "implement" delivers a pull request, but the run would start from a detached HEAD at ${commit}, so no branch is there for the pull request to target. Check out a named branch, then start the run again.`;
      expect(await made.call({ kind: 'describe', name: 'implement' })).toMatchObject({ data: { describe: { ask: { kind: 'denied', reason } } } });
      expect(await made.call({ kind: 'start', name: 'implement', answers: { confirmed: false }, inputs: undefined })).toEqual({ error: { code: 'no_base_branch', message: reason, next: null } });
      return made.rows;
    },
  },
  {
    name: 'the local start literal names the session tool only on a machine that names no default prompt tool, for a tool the local driver launches',
    rows: ['R2', 'R8'],
    run: async () => {
      const made = await harness({ 'release-docs': RELEASE_DOCS });
      const describe = { kind: 'describe', name: 'release-docs' } as const;
      const named = { ...made.config, workflows: { tools: { default: 'codex' } } };
      expect(await made.call(describe, { config: named })).toMatchObject({ data: { describe: { ask: { start: 'teamai workflow start release-docs --driver local' } } } });
      expect(await made.call(describe, { tool: 'cursor' })).toMatchObject({ data: { describe: { ask: { start: 'teamai workflow start release-docs --driver local' } } } });
      expect(await made.call({ kind: 'start', name: 'release-docs', answers: { confirmed: false }, inputs: undefined })).toMatchObject({ error: {
        code: 'needs_local_driver', message: expect.stringContaining('Ask the person to run teamai workflow start release-docs --driver local --tools default=claude in their own terminal.'),
      } });
      return made.rows;
    },
  },
  {
    name: 'a workflow whose held step works in the copy of a step this driver takes is routed to the local driver',
    rows: ['R2', 'R8'],
    run: async () => {
      const made = await harness({ 'release-docs': RELEASE_DOCS });
      expect(await made.call({ kind: 'describe', name: 'release-docs' })).toMatchObject({ data: { describe: { ask: { kind: 'local', start: 'teamai workflow start release-docs --driver local --tools default=claude' } } } });
      expect(await made.call({ kind: 'start', name: 'release-docs', answers: { confirmed: false }, inputs: undefined })).toMatchObject({ error: { code: 'needs_local_driver', next: null } });
      return made.rows;
    },
  },
  {
    name: 'an agent session asking about an invoke: deny workflow is told why, with nothing to run',
    rows: ['R1'],
    run: async () => {
      const made = await harness({ locked: LOCKED }, { evidence: { kind: 'session', variable: 'CLAUDE_CODE_SESSION_ID' } });
      const answer = await made.call({ kind: 'describe', name: 'locked' });
      expect(answer).toMatchObject({ data: { describe: { ask: {
        kind: 'denied', reason: expect.stringContaining('Workflow "locked" has invoke: deny, so no coding agent starts it, with any driver, and this command runs inside an agent session (CLAUDE_CODE_SESSION_ID is set). The person can start it from their own terminal'),
      } } } });
      expect(answer).not.toMatchObject({ data: { describe: { ask: { start: expect.anything() } } } });
      return made.rows;
    },
  },
  {
    name: 'an unattended describe asks nothing: it denies a workflow that needs a person, and answers the recommended start under --auto-approve, which runs to done',
    rows: ['R17', 'R18', 'R10'],
    run: async () => {
      const made = await harness({ release: RELEASE, check: CHECK }, { mode: 'unattended' });
      expect(await made.call({ kind: 'describe', name: 'release' })).toMatchObject({ data: { describe: { ask: {
        kind: 'denied', reason: expect.stringContaining('only a person can answer the approval at go-live'),
      } } } });
      expect(await made.call({ kind: 'describe', name: 'check' })).toMatchObject({ data: { describe: { ask: { kind: 'start', start: 'teamai workflow start check --driver skill --auto-approve' } } } });
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'check', answers: { confirmed: false, hitl: 'auto-approve' }, inputs: undefined }));
      expect(await polledToDone(made, run)).toMatchObject({ status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] });
      return made.rows;
    },
  },
  {
    name: 'an unattended describe of a workflow the local driver must run denies it, saying why, with nothing to run',
    rows: ['R23'],
    run: async () => {
      const made = await harness({ 'release-docs': RELEASE_DOCS }, { mode: 'unattended' });
      const answer = await made.call({ kind: 'describe', name: 'release-docs' });
      expect(answer).toMatchObject({ data: { describe: { ask: { kind: 'denied', reason: expect.stringContaining('so the local driver runs the whole of release-docs.') } } } });
      expect(answer).not.toMatchObject({ data: { describe: { ask: { start: expect.anything() } } } });
      return made.rows;
    },
  },
  {
    name: 'an unattended run on a host that starts no child hands a step that needs a worktree to the person, and the turn ends the loop',
    rows: ['R13', 'D14'],
    run: async () => {
      const made = await harness({ inline: INLINE }, { mode: 'unattended' });
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'inline', answers: { confirmed: false, hitl: 'auto-approve' }, inputs: undefined }));
      const [notes] = dispatches(await turnOf(await made.call({ kind: 'choose', run, choice: 'h4' })));
      if (!notes) throw new Error('no dispatch of notes');
      await made.call({ kind: 'ack', run, attempt: notes.attempt });
      childWrites(notes.brief, { kind: 'output', output: 'Wrote the notes.' });
      await made.call({ kind: 'report', run, attempt: notes.attempt, role: 'agent', modelUnavailable: false });
      const handed = await turnOf(await made.call({ kind: 'next', run, wait: false }));
      expect(handed.actions).toEqual([expect.objectContaining({ kind: 'person', why: 'handoff', held: [{ step: 'change', missing: ['workspace.new'] }] })]);
      expect(handed.then).toBeUndefined();
      return made.rows;
    },
  },
  {
    name: 'an interactive step is offered for the agent to work with the person, here, one at a time',
    rows: ['D7', 'C2'],
    run: async () => {
      const made = await harness({ draft: DRAFT });
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'draft', answers: { confirmed: false }, inputs: undefined }));
      const [dispatch] = dispatches(await turnOf(await made.call({ kind: 'choose', run, choice: 'h1' })));
      expect(dispatch).toMatchObject({ step: 'write', needs: { place: 'checkout', parallel: false, person: true }, dir: made.work });
      expect(fs.readFileSync(dispatch?.brief ?? '', 'utf8')).toContain('with the person');
      return made.rows;
    },
  },
  {
    name: 'the brief of an interactive step in the checkout keeps what the person changes, and one that only reads forbids changes',
    rows: ['D7'],
    run: async () => {
      const made = await harness({ draft: DRAFT, 'draft-read': DRAFT_READ });
      const briefOf = async (name: string): Promise<string> => {
        const { run } = await turnOf(await made.call({ kind: 'start', name, answers: { confirmed: false }, inputs: undefined }));
        const [dispatch] = dispatches(await turnOf(await made.call({ kind: 'choose', run, choice: 'h1' })));
        return fs.readFileSync(dispatch?.brief ?? '', 'utf8');
      };
      const kept = await briefOf('draft');
      expect(kept).toContain('What you change stays there; TeamAI commits nothing.');
      expect(kept).not.toContain('Do not change files here');
      expect(await briefOf('draft-read')).toContain('Do not change files here');
      return made.rows;
    },
  },
  {
    name: 'a dispatch of a step that requires a sandbox says so in its needs',
    rows: ['C2'],
    run: async () => {
      const made = await harness({ boxed: BOXED });
      const boxed = await turnOf(await made.call({ kind: 'start', name: 'boxed', answers: { confirmed: false }, inputs: undefined }));
      const [dispatch] = dispatches(await turnOf(await made.call({ kind: 'choose', run: boxed.run, choice: 'h1' })));
      expect(dispatch?.needs).toEqual({ place: 'checkout', parallel: false, person: false, isolation: 'sandbox' });
      return made.rows;
    },
  },
  {
    name: 'an invoke: ask workflow asks first, and a start without the answer is refused',
    rows: ['R3', 'R9'],
    run: async () => {
      const made = await harness({ gated: GATED });
      expect(await made.call({ kind: 'describe', name: 'gated' })).toMatchObject({ data: { describe: { ask: {
        kind: 'ask', question: { text: '- The team asks that you agree before it starts.\nStart it?', options: [{ label: 'Yes, start it', start: 'teamai workflow start gated --driver skill --confirmed' }] },
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
      const other = await made.context.client.start('check', { checkout: made.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
      if (!('data' in other) || typeof other.data.run !== 'string') throw new Error(JSON.stringify(other));
      expect(await made.call({ kind: 'next', run: RunIdSchema.parse(other.data.run), wait: false })).toMatchObject({ error: { code: 'not_skill_run', next: `teamai workflow resume ${other.data.run} --driver skill` } });
      return made.rows;
    },
  },
  {
    name: 'a resume or takeover that would drive a run here from a session that names no tool the run needs answers tool_needed, whose next fills the tool',
    rows: ['R28', 'R19'],
    run: async () => {
      const made = await harness({ review: REVIEW }, { scorers: SCORERS, tool: null });
      const other = await made.context.client.start('review', { checkout: made.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
      if (!('data' in other) || typeof other.data.run !== 'string') throw new Error(JSON.stringify(other));
      const run = RunIdSchema.parse(other.data.run);
      const refused = { error: {
        code: 'tool_needed', message: `Run ${run} needs the tool this coding session works in, for the models of its steps or its judging, and it names none.`,
        next: `teamai workflow resume ${run} --driver skill --tools default='{tool}'`,
      } };
      expect(await made.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {} })).toEqual(refused);
      expect(await made.call({ kind: 'takeover', run, confirmed: false })).toEqual(refused);
      // The next keeps the options of the resume it refuses.
      expect(await made.call({ kind: 'resume', run, claim: false, confirmed: true, answers: { parallel: 2, hitl: 'auto-approve' } })).toMatchObject({ error: {
        code: 'tool_needed', next: `teamai workflow resume ${run} --driver skill --tools default='{tool}' --parallel 2 --auto-approve --confirmed`,
      } });
      expect(await turnOf(await made.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {}, tool: 'claude' }))).toMatchObject({ run, actions: [{ kind: 'choose', about: 'host' }] });
      return made.rows;
    },
  },
  {
    name: 'a claim refused for the tool the run needs drops the skill.json kept here, so the resume that names the tool drives the claimed run anew',
    rows: ['R28', 'R19'],
    run: async () => {
      const team = sharedTeam({ handed: HANDED.replace('    prompt: Write the API.', '    prompt: Write the API.\n    model: sonnet') });
      const ci = await team.install('ci');
      // CI drives the run with the skill driver, so it keeps a skill.json, and publishes it.
      const first = await harness({}, { install: ci, tool: 'claude' });
      const { run } = await turnOf(await first.call({ kind: 'start', name: 'handed', answers: { confirmed: false, parallel: 1 }, inputs: undefined }));
      await first.call({ kind: 'choose', run, choice: 'h1' });
      for (let poll = 0; poll < 3; poll += 1) await first.call({ kind: 'next', run, wait: true });
      expect(await publishRun(ci.config, run, { checkout: ci.checkout })).toMatchObject({ ok: true });
      // A member takes it over and publishes it.
      const member = await team.install('member');
      await turnOf(await (await harness({}, { install: member, tool: 'claude' })).call({ kind: 'resume', run, claim: false, confirmed: false, answers: {} }));
      expect(await publishRun(member.config, run, { checkout: member.checkout })).toMatchObject({ ok: true });
      // Back on CI, a session that names no tool claims it back.
      const back = await harness({}, { install: ci, tool: null });
      expect(await back.call({ kind: 'resume', run, claim: true, confirmed: false, answers: { parallel: 2 } }))
        .toMatchObject({ error: { code: 'tool_needed', next: `teamai workflow resume ${run} --driver skill --tools default='{tool}' --parallel 2` } });
      expect(await turnOf(await back.call({ kind: 'resume', run, claim: false, confirmed: false, answers: { parallel: 2 }, tool: 'claude' })))
        .toMatchObject({ run, actions: [{ kind: 'choose', about: 'host' }] });
      return back.rows;
    },
  },
  {
    name: 'a session resumes a run another machine published mid-step: it claims it, keeps the options and mode of the resume, and drives it to done',
    rows: ['R19'],
    run: async () => {
      const team = sharedTeam({ handed: HANDED });
      const ci = await team.install('ci');
      const { run, attempt } = await publishedMidStep(ci, 'handed');
      const modes: string[] = [];
      const made = await harness({}, { install: await team.install('member'), mode: 'unattended', runners: (runners) => ({ ...runners, spawn: async (job) => { modes.push(job.mode); await runners.spawn(job); } }) });
      // The definition the run carries says invoke: deny, so an agent session gets nothing of it, and nothing is claimed.
      const reports = reportsBranch.dir(made.config);
      const reportsCache = (): string[] => (fs.existsSync(reports) ? fs.readdirSync(reports, { recursive: true, encoding: 'utf8' }).sort() : []);
      const cached = reportsCache();
      expect(await made.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {} }, { evidence: AGENT }))
        .toMatchObject({ error: { code: 'invoke_denied', next: null } });
      expect(await readRun(made.config, run)).toBe('missing');
      const runs = runsDir(made.config);
      expect(fs.existsSync(runs) ? fs.readdirSync(runs).filter((entry) => entry.startsWith(run)) : []).toEqual([]);
      expect(reportsCache()).toEqual(cached);
      const resumed = await turnOf(await made.call({ kind: 'resume', run, claim: false, confirmed: false, answers: { parallel: 2 } }));
      expect(resumed).toMatchObject({ run, status: 'driving', actions: [{ kind: 'choose', about: 'host' }] });
      expect(await publishRun(ci.config, run, { checkout: ci.checkout })).toMatchObject({ ok: false, error: { code: 'not_owner' } });
      const built = await turnOf(await made.call({ kind: 'choose', run, choice: 'h1' }));
      expect(built.events).toContainEqual({ kind: 'started', step: 'build', attempt: expect.not.stringMatching(attempt) });
      const turn = await dispatchTurn(made, run);
      const [api, ui] = dispatches(turn);
      expect([api?.step, ui?.step, api?.needs.parallel, ui?.needs.parallel]).toEqual(['api', 'ui', true, true]);
      for (const dispatch of [api, ui]) {
        if (!dispatch) continue;
        await made.call({ kind: 'ack', run, attempt: dispatch.attempt });
        childWrites(dispatch.brief, { kind: 'output', output: `Wrote ${dispatch.step}.` });
        await made.call({ kind: 'report', run, attempt: dispatch.attempt, role: 'agent', modelUnavailable: false });
      }
      expect(await polledToDone(made, run)).toMatchObject({ status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] });
      expect(new Set(modes)).toEqual(new Set(['unattended']));
      return made.rows;
    },
  },
  {
    name: 'a resume or a takeover follows the invoke of the run\'s own definition, as a start does: an agent session needs allow, or ask and the person\'s yes in an attended run',
    rows: ['R22', 'R19'],
    run: async () => {
      const made = await harness({ locked: LOCKED, gated: GATED, check: CHECK });
      const runOf = async (name: string): Promise<RunId> => {
        const started = await made.context.client.start(name, { checkout: made.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
        if (!('data' in started)) throw new Error(JSON.stringify(started));
        return RunIdSchema.parse(started.data.run);
      };
      const locked = await runOf('locked');
      expect(await made.call({ kind: 'resume', run: locked, claim: false, confirmed: true, answers: {} }, { evidence: AGENT })).toEqual({ error: {
        code: 'invoke_denied', message: expect.stringContaining('Workflow "locked" has invoke: deny, so no coding agent continues it, with any driver, and this command runs inside an agent session (CLAUDE_CODE_SESSION_ID is set).'), next: null,
      } });
      expect(await made.call({ kind: 'takeover', run: locked, confirmed: false }, { evidence: AGENT })).toMatchObject({ error: { code: 'invoke_denied', next: null } });
      expect(fs.existsSync(skillStatePath(made.config, locked))).toBe(false);
      const gated = await runOf('gated');
      expect(await made.call({ kind: 'resume', run: gated, claim: false, confirmed: false, answers: { parallel: 2 } }, { evidence: AGENT })).toEqual({ error: {
        code: 'confirm_needed', message: expect.stringContaining('Ask the person whether to continue gated'), next: `teamai workflow resume ${gated} --driver skill --parallel 2 --confirmed`,
      } });
      expect(await made.call({ kind: 'takeover', run: gated, confirmed: false }, { evidence: AGENT }))
        .toMatchObject({ error: { code: 'confirm_needed', next: `teamai workflow next ${gated} --driver skill --takeover --confirmed` } });
      expect(await made.call({ kind: 'resume', run: gated, claim: false, confirmed: true, answers: {} }, { evidence: AGENT, mode: 'unattended' }))
        .toMatchObject({ error: { code: 'unattended_denied', next: null } });
      expect(fs.existsSync(skillStatePath(made.config, gated))).toBe(false);
      expect(await turnOf(await made.call({ kind: 'resume', run: gated, claim: false, confirmed: true, answers: {} }, { evidence: AGENT }))).toMatchObject({ run: gated });
      expect(await turnOf(await made.call({ kind: 'takeover', run: await runOf('check'), confirmed: false }, { evidence: AGENT }))).toMatchObject({ status: expect.any(String) });
      // Only a coding agent drives --driver skill, so a host that sets no agent variable is refused alike.
      expect(await made.call({ kind: 'takeover', run: locked, confirmed: false }, { evidence: { kind: 'skill-driver' } }))
        .toMatchObject({ error: { code: 'invoke_denied', message: expect.stringContaining('this command uses --driver skill'), next: null } });
      return made.rows;
    },
  },
  {
    name: 'an unattended resume or takeover decides as describe does: a run that needs a person is refused, and any other runs with its optional gates auto-approved',
    rows: ['R24', 'R19'],
    run: async () => {
      const made = await harness({ release: RELEASE, approved: APPROVED }, { mode: 'unattended' });
      const runOf = async (name: string): Promise<RunId> => {
        const created = await made.context.client.start(name, { checkout: made.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
        if (!('data' in created)) throw new Error(JSON.stringify(created));
        return RunIdSchema.parse(created.data.run);
      };
      const release = await runOf('release');
      expect(await made.call({ kind: 'resume', run: release, claim: false, confirmed: false, answers: {} })).toEqual({ error: {
        code: 'unattended_denied',
        message: 'Workflow release needs a person, and this run is unattended (TEAMAI_MODE or CI says so): only a person can answer the approval at go-live. Continue it from a session a person attends, or set TEAMAI_MODE=attended where one does.',
        next: null,
      } });
      expect(await made.call({ kind: 'takeover', run: release, confirmed: false })).toMatchObject({ error: { code: 'unattended_denied', next: null } });
      expect(fs.existsSync(skillStatePath(made.config, release))).toBe(false);
      const approved = await runOf('approved');
      expect(await turnOf(await made.call({ kind: 'resume', run: approved, claim: false, confirmed: false, answers: {} }))).toMatchObject({ run: approved, actions: [] });
      expect(JSON.parse(fs.readFileSync(skillStatePath(made.config, approved), 'utf8'))).toMatchObject({ options: { hitl: 'auto-approve', mode: 'unattended' } });
      expect(await polledToDone(made, approved)).toMatchObject({ actions: [{ kind: 'done', outcome: 'succeeded' }] });
      return made.rows;
    },
  },
  ...([
    { announce: ANNOUNCE, rows: ['R19'], name: 'an unattended resume counts only the steps left: a run whose required approval already ran continues with its optional gates auto-approved' },
    { announce: `${ANNOUNCE}    loop: { back_to: go-live, max_iterations: 2 }\n`, rows: ['R24'], name: 'an unattended resume still counts a required approval that ran when a loop can run it again' },
  ] as const).map(({ announce, rows, name }) => ({
    name,
    rows: [...rows],
    run: async () => {
      const made = await harness({ released: RELEASE.replace('name: release', 'name: released') + announce }, { mode: 'unattended' });
      const { client, env } = made.context;
      const created = await client.start('released', { checkout: made.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
      if (!('data' in created)) throw new Error(JSON.stringify(created));
      const run = RunIdSchema.parse(created.data.run);
      // CI's local driver runs the run up to announce; the person answers both approvals from their terminal.
      const driver = { kind: 'local', machine: 'ci', workspace: made.work, can: { hitl: true, workspace: [...WORKSPACE_MODES] } };
      const person = respondProvenance({ kind: 'terminal', caller: { tty: true, evidence: { kind: 'none' } } });
      for (let turn = 0; turn < 12; turn += 1) {
        const answer = await client.next(run, { driver });
        if (!('data' in answer)) throw new Error(JSON.stringify(answer));
        const { hitl, lease } = z.object({ hitl: z.object({ step: z.string(), pass: z.number() }).optional(), lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number() }).optional() }).parse(answer.data);
        if (hitl) {
          expect(await respondToHitl(made.config, run, env.secrets, { step: hitl.step, choice: 'yes', pass: hitl.pass, provenance: person })).not.toHaveProperty('error');
          continue;
        }
        if (!lease) throw new Error(JSON.stringify(answer));
        const outcome = lease.step === 'announce' ? 'released' : 'success';
        expect(await client.report(run, { attempt: lease.attempt, revision: lease.revision, outcome, driver })).not.toHaveProperty('error');
        if (outcome === 'released') break;
      }
      expect(await readRun(made.config, run)).toMatchObject({ status: 'running', steps: expect.arrayContaining([expect.objectContaining({ id: 'go-live', status: 'succeeded' })]) });
      const resumed = await made.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {} });
      if (rows[0] === 'R24') {
        expect(resumed).toMatchObject({ error: { code: 'unattended_denied', message: expect.stringContaining('the approval at go-live'), next: null } });
        return made.rows;
      }
      expect(await turnOf(resumed)).toMatchObject({ run });
      expect(JSON.parse(fs.readFileSync(skillStatePath(made.config, run), 'utf8'))).toMatchObject({ options: { hitl: 'auto-approve', mode: 'unattended' } });
      return made.rows;
    },
  })),
  {
    name: 'an unattended takeover of a run a person attends gives its kept options no person: the optional gate is auto-approved',
    rows: ['R26'],
    run: async () => {
      const made = await harness({ approved: APPROVED });
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'approved', answers: { confirmed: false, hitl: 'person' }, inputs: undefined }));
      const options = (): unknown => JSON.parse(fs.readFileSync(skillStatePath(made.config, run), 'utf8')).options;
      expect(options()).toMatchObject({ hitl: 'person', mode: 'attended' });
      expect(await turnOf(await made.call({ kind: 'takeover', run, confirmed: false }, { mode: 'unattended', session: 'session-b' }))).toMatchObject({ run });
      expect(options()).toMatchObject({ hitl: 'auto-approve', mode: 'unattended' });
      for (let poll = 0; poll < 10; poll += 1) {
        const turn = await turnOf(await made.call({ kind: 'next', run, wait: true }, { mode: 'unattended', session: 'session-b' }));
        if (turn.status === 'done') {
          expect(turn).toMatchObject({ actions: [{ kind: 'done', outcome: 'succeeded' }] });
          return made.rows;
        }
      }
      throw new Error('the run did not reach done in ten polls');
    },
  },
  {
    name: 'an unattended start of a workflow that needs a person is refused as describe denies it, and no run is created',
    rows: ['R25'],
    run: async () => {
      const made = await harness({ release: RELEASE }, { mode: 'unattended' });
      expect(await made.call({ kind: 'start', name: 'release', answers: { confirmed: false, hitl: 'auto-approve' }, inputs: undefined })).toEqual({ error: {
        code: 'unattended_denied',
        message: 'Workflow release needs a person, and this run is unattended (TEAMAI_MODE or CI says so): only a person can answer the approval at go-live. Start it from a session a person attends, or set TEAMAI_MODE=attended where one does.',
        next: null,
      } });
      const runs = runsDir(made.config);
      expect(fs.existsSync(runs) ? fs.readdirSync(runs) : []).toEqual([]);
      return made.rows;
    },
  },
  {
    name: 'an unattended takeover of a run a session drives is refused when the steps left need a person, and that session stays its orchestrator',
    rows: ['R24'],
    run: async () => {
      const made = await harness({ release: RELEASE });
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'release', answers: { confirmed: false, hitl: 'person' }, inputs: undefined }));
      const owner = (): unknown => JSON.parse(fs.readFileSync(skillStatePath(made.config, run), 'utf8')).orchestrator;
      const before = owner();
      expect(await made.call({ kind: 'takeover', run, confirmed: false }, { mode: 'unattended', session: 'session-b' })).toMatchObject({ error: { code: 'unattended_denied', next: null } });
      expect(owner()).toEqual(before);
      return made.rows;
    },
  },
  {
    name: 'an unattended resume --claim decides from the published run the claim installs, not this machine\'s older copy',
    rows: ['R19'],
    run: async () => {
      const team = sharedTeam({ handed: HANDED_GATED });
      const ci = await team.install('ci');
      const { run } = await publishedMidStep(ci, 'handed');
      // A member's session claims the run, the person answers go-live, and the member publishes it with api and ui left.
      const member = await harness({}, { install: await team.install('member') });
      await turnOf(await member.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {} }));
      await member.call({ kind: 'choose', run, choice: 'h1' });
      const person = respondProvenance({ kind: 'terminal', caller: { tty: true, evidence: { kind: 'none' } } });
      const goLive = async (): Promise<string | undefined> => {
        const read = await readRun(member.config, run);
        return typeof read === 'object' ? read.steps.find((step) => step.id === 'go-live')?.status : undefined;
      };
      for (let poll = 0; poll < 10 && await goLive() !== 'succeeded'; poll += 1) {
        await respondToHitl(member.config, run, member.context.env.secrets, { step: 'go-live', choice: 'yes', pass: 1, provenance: person });
        await member.call({ kind: 'next', run, wait: true });
      }
      expect(await publishRun(member.config, run, { checkout: member.work })).toMatchObject({ ok: true });
      // CI's own copy still has go-live ahead; the published run does not.
      const back = await harness({}, { install: ci, mode: 'unattended' });
      expect(await turnOf(await back.call({ kind: 'resume', run, claim: true, confirmed: false, answers: {} }))).toMatchObject({ run });
      return back.rows;
    },
  },
  {
    name: 'an unattended resume does not count a required approval inside a workflow the run skipped',
    rows: ['R19'],
    run: async () => {
      const made = await harness({ skipping: SKIPPED_REVIEW }, { mode: 'unattended' });
      const { client } = made.context;
      const created = await client.start('skipping', { checkout: made.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
      if (!('data' in created)) throw new Error(JSON.stringify(created));
      const run = RunIdSchema.parse(created.data.run);
      // CI's local driver runs `prep` and gives `ship` back, so the run waits with `review` skipped and its approval never asked.
      const driver = { kind: 'local', machine: 'ci', workspace: made.work, can: { hitl: true, workspace: [...WORKSPACE_MODES] } };
      for (const [step, outcome] of [['prep', 'success'], ['ship', 'released']] as const) {
        const answer = await client.next(run, { driver });
        const { lease } = z.object({ lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number() }) }).parse('data' in answer ? answer.data : answer);
        expect(lease.step).toBe(step);
        expect(await client.report(run, { attempt: lease.attempt, revision: lease.revision, outcome, driver })).not.toHaveProperty('error');
      }
      expect(await readRun(made.config, run)).toMatchObject({ status: 'running', steps: expect.arrayContaining([expect.objectContaining({ id: 'review', status: 'skipped' })]) });
      expect(await turnOf(await made.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {} }))).toMatchObject({ run });
      return made.rows;
    },
  },
  {
    name: 'an unattended resume of a published run that needs a person is refused before the claim: the install that published it still owns it',
    rows: ['R24'],
    run: async () => {
      const team = sharedTeam({ 'gated-handed': HANDED.replace('name: handed', 'name: gated-handed\ninvoke: allow') + GO_LIVE_AFTER_UI });
      const ci = await team.install('ci');
      const { run } = await publishedMidStep(ci, 'gated-handed');
      const made = await harness({}, { install: await team.install('member'), mode: 'unattended' });
      expect(await made.call({ kind: 'resume', run, claim: true, confirmed: false, answers: {} })).toMatchObject({ error: { code: 'unattended_denied', next: null } });
      expect(await readRun(made.config, run)).toBe('missing');
      expect(await publishRun(ci.config, run, { checkout: ci.checkout })).toMatchObject({ ok: true });
      return made.rows;
    },
  },
  {
    name: 'the session that drives a run is not checked again, and another session\'s takeover of it needs the person\'s yes for an invoke: ask workflow',
    rows: ['S4', 'R22'],
    run: async () => {
      const made = await harness({ gated: GATED });
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'gated', answers: { confirmed: true }, inputs: undefined }, { evidence: AGENT }));
      expect(await turnOf(await made.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {} }, { evidence: AGENT }))).toMatchObject({ run });
      expect(await turnOf(await made.call({ kind: 'takeover', run, confirmed: false }, { evidence: AGENT }))).toMatchObject({ run });
      expect(await made.call({ kind: 'takeover', run, confirmed: false }, { evidence: AGENT, session: 'session-b' }))
        .toMatchObject({ error: { code: 'confirm_needed', next: `teamai workflow next ${run} --driver skill --takeover --confirmed` } });
      const taken = await turnOf(await made.call({ kind: 'takeover', run, confirmed: true }, { evidence: AGENT, session: 'session-b' }));
      expect(taken.events).toContainEqual({ kind: 'takeover', from: 'session-a' });
      return made.rows;
    },
  },
  {
    name: 'a resume or a takeover of a run whose local driver on this machine stopped mid-step gives that step to this session, and the run reaches done',
    rows: ['R19'],
    run: async () => {
      const made = await harness({ check: CHECK });
      // What the killed local driver left: its command, still running in a process group of its own, recorded where its attempt keeps it.
      const stopped = async (): Promise<{ run: RunId; left: Promise<NodeJS.Signals | null> }> => {
        const started = await made.context.client.start('check', { checkout: made.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
        if (!('data' in started)) throw new Error(JSON.stringify(started));
        const run = RunIdSchema.parse(started.data.run);
        const leased = await made.context.client.next(run, { driver: { ...driverIdentity('local', made.work), can: { workspace: [...WORKSPACE_MODES] } } });
        const { attempt } = z.object({ data: z.object({ lease: z.object({ step: z.literal('lint'), attempt: AttemptIdSchema }) }) }).parse(leased).data.lease;
        const dir = attemptDir(made.config, run, attempt);
        fs.mkdirSync(dir, { recursive: true });
        const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
        onTestFinished(() => { child.kill('SIGKILL'); });
        const left = new Promise<NodeJS.Signals | null>((resolve) => child.on('exit', (_code, signal) => resolve(signal)));
        recordGroup(child, dir);
        return { run, left };
      };
      const stillRunning = (left: Promise<NodeJS.Signals | null>): Promise<unknown> => Promise.race([left, new Promise((resolve) => { setTimeout(() => resolve('still running'), 2000); })]);
      const resumed = await stopped();
      await turnOf(await made.call({ kind: 'resume', run: resumed.run, claim: false, confirmed: false, answers: {} }));
      expect(await stillRunning(resumed.left)).toBe('SIGTERM');
      expect(await polledToDone(made, resumed.run)).toMatchObject({ status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] });
      const taken = await stopped();
      await turnOf(await made.call({ kind: 'takeover', run: taken.run, confirmed: false }));
      expect(await stillRunning(taken.left)).toBe('SIGTERM');
      expect(await polledToDone(made, taken.run)).toMatchObject({ status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] });
      // A step of that driver cancelled before the resume holds no lease any more, yet its command is stopped as well.
      const cancelled = await stopped();
      expect(await made.context.client.cancel(cancelled.run, 'lint')).toMatchObject({ data: {} });
      await made.call({ kind: 'resume', run: cancelled.run, claim: false, confirmed: false, answers: {} });
      expect(await stillRunning(cancelled.left)).toBe('SIGTERM');
      return made.rows;
    },
  },
  {
    name: 'a resume of a run another install owns now is refused with the --claim literal for the person, and the claim takes it back',
    rows: ['R20', 'R19'],
    run: async () => {
      const team = sharedTeam({ handed: HANDED });
      const ci = await team.install('ci');
      const { run } = await publishedMidStep(ci, 'handed');
      const member = await harness({}, { install: await team.install('member') });
      await turnOf(await member.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {} }));
      const back = await harness({}, { install: ci });
      expect(await back.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {} })).toEqual({
        error: { code: 'not_owner', message: expect.stringContaining(`Run ${run} is owned by member`), next: `teamai workflow resume ${run} --driver skill --claim` },
      });
      expect(await back.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {}, tool: 'claude' }))
        .toMatchObject({ error: { code: 'not_owner', next: `teamai workflow resume ${run} --driver skill --tools default=claude --claim` } });
      expect(await turnOf(await back.call({ kind: 'resume', run, claim: true, confirmed: false, answers: {} }))).toMatchObject({ run, status: 'driving', actions: [{ kind: 'choose', about: 'host' }] });
      return [...member.rows, ...back.rows];
    },
  },
  {
    name: 'a takeover with no skill state here drives a run this machine holds, and for a run it lacks names the --claim literal for the person',
    rows: ['R19', 'R20'],
    run: async () => {
      const made = await harness({ check: CHECK });
      const lacking = RunIdSchema.parse('r0123456789abcdef');
      expect(await made.call({ kind: 'takeover', run: lacking, confirmed: false })).toEqual({
        error: { code: 'run_not_found', message: expect.any(String), next: `teamai workflow resume ${lacking} --driver skill --claim` },
      });
      const other = await made.context.client.start('check', { checkout: made.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
      if (!('data' in other) || typeof other.data.run !== 'string') throw new Error(JSON.stringify(other));
      const run = RunIdSchema.parse(other.data.run);
      expect(await turnOf(await made.call({ kind: 'takeover', run, confirmed: false }))).toMatchObject({ run, status: 'driving' });
      expect(await polledToDone(made, run)).toMatchObject({ status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] });
      return made.rows;
    },
  },
  {
    name: 'a resume of a run neither this machine nor teamai-reports holds relays the refusal, with nothing to run',
    rows: ['R21'],
    run: async () => {
      const team = sharedTeam({ handed: HANDED });
      const made = await harness({}, { install: await team.install('member') });
      expect(await made.call({ kind: 'resume', run: RunIdSchema.parse('r0123456789abcdef'), claim: false, confirmed: false, answers: {} })).toMatchObject({ error: { code: 'run_not_published', next: null } });
      return made.rows;
    },
  },
  {
    name: 'a resumed run with a local route is handed to the person\'s local resume',
    rows: ['R8'],
    run: async () => {
      const team = sharedTeam({ 'release-docs': RELEASE_DOCS });
      const ci = await team.install('ci');
      const { run } = await publishedMidStep(ci, 'release-docs');
      const made = await harness({}, { install: await team.install('member') });
      expect(await made.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {} })).toEqual({
        error: { code: 'needs_local_driver', message: expect.stringContaining(`Ask the person to run teamai workflow resume ${run} --tools default=claude in their own terminal.`), next: null },
      });
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
      expect((await turnOf(await made.call({ kind: 'takeover', run, confirmed: false }, { session: 'session-b' }))).events).toContainEqual({ kind: 'takeover', from: 'session-a' });
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
      const busy = { take: async () => ({ kind: 'busy' as const, error: { code: 'driver_running' as const, message: 'held' } }) };
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
    name: 'a lease this teamai cannot read answers run_unreadable, which an update of teamai fixes',
    rows: ['D17'],
    run: async () => {
      const made = await harness({ check: CHECK }, { client: scriptedOnce(() => ({ next: async () => ({ data: { lease: { attempt: 'a0000000a', step: 'check' } } }) })) });
      const answer = await made.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined });
      expect(answer).toMatchObject({ error: { code: 'run_unreadable', message: expect.stringMatching(/^Run r[0-9a-f]+ leased a step this teamai cannot read\. Update teamai\.$/) } });
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
    name: 'an attempt whose runner is gone while it stops is given up by the first tick past the spawn grace, which stops the command it left',
    rows: ['C11'],
    run: async () => {
      let gone = false;
      const stops: string[] = [];
      const made = await harness({ check: SERVE }, { runners: (runners) => ({ ...sleepFaked(stops)(runners), alive: async (run, attempt) => !gone && runners.alive(run, attempt) }) });
      const { turn: { run }, running } = await serving(made);
      await made.context.client.cancel(run, running.step);
      const stopping = { attempt: running.attempt, step: running.step, phase: 'stopping' };
      expect((await turnOf(await made.call({ kind: 'next', run, wait: false }))).running).toContainEqual(stopping);
      gone = true;
      // Within the 5 s a runner gets to take its lock, a free lock may be a runner not yet started.
      expect((await turnOf(await made.call({ kind: 'next', run, wait: false }))).running).toContainEqual(stopping);
      made.hold(true);
      await made.context.runners.sleep(6_000);
      made.hold(false);
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
    name: 'defaults.model fills the model of a team agent whose definition sets none, and leaves a definition that sets one alone',
    rows: ['C2'],
    run: async () => {
      const made = await harness({ reviewed: REVIEWED });
      const agents = path.join(made.work, '.claude', 'agents');
      fs.mkdirSync(agents, { recursive: true });
      fs.writeFileSync(path.join(agents, 'plain-reviewer.md'), '---\nname: plain-reviewer\ndescription: Reviews changes.\n---\nFollow the review checklist.\n');
      fs.writeFileSync(path.join(agents, 'pinned-reviewer.md'), '---\nname: pinned-reviewer\ndescription: Reviews changes.\nmodel: claude-opus-4-1\n---\nFollow the review checklist.\n');
      const turn = await chosen(made, 'reviewed', 2);
      const models = Object.fromEntries(dispatches(turn).map((action) => [action.step, action.model]));
      expect(models).toEqual({ plain: { by: 'defaults', name: 'claude-haiku-4-5' }, pinned: { by: 'definition' } });
      return made.rows;
    },
  },
  {
    name: 'a dispatch is titled with a name every host accepts for a child, even for a long step path with dots',
    rows: ['D7', 'C2'],
    run: async () => {
      const made = await harness({ site: SITE });
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'site', answers: { confirmed: false }, inputs: undefined }));
      const [dispatch] = dispatches(await turnOf(await made.call({ kind: 'choose', run, choice: 'h1' })));
      if (!dispatch) throw new Error('site was not dispatched');
      expect(dispatch.title).toBe(`site-settings-page-with-every-tab-the-person-asked-for-${dispatch.attempt}`);
      expect(dispatch.title).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
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
    name: 'on a host that makes places, a step that commits to a branch asks for one; a refused place is asked for again, an adopted one is dispatched, and an adopt for an attempt that waits for none is refused',
    rows: ['D8', 'C5', 'C6', 'K4', 'K5'],
    run: async () => {
      const made = await harness({ write: WRITE });
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'write', answers: { confirmed: false }, inputs: undefined }));
      const turn = await turnOf(await made.call({ kind: 'choose', run, choice: 'h3' }));
      const [place] = turn.actions;
      if (place?.kind !== 'place') throw new Error(JSON.stringify(turn));
      const dir = path.join(made.root, 'hosts', 'place');
      execFileSync('git', ['worktree', 'add', '-q', '--detach', dir, place.start], { cwd: made.work });
      fs.writeFileSync(path.join(dir, 'stray.txt'), 'stray\n');
      const refused = await turnOf(await made.call({ kind: 'adopt', run, attempt: place.attempt, dir }));
      expect(refused.actions).toEqual([{ ...place, refused: expect.stringContaining('has changes the step would commit (?? stray.txt)') }]);
      fs.rmSync(path.join(dir, 'stray.txt'));
      const adopted = await turnOf(await made.call({ kind: 'adopt', run, attempt: place.attempt, dir }));
      expect(adopted.actions).toEqual([expect.objectContaining({ kind: 'dispatch', attempt: place.attempt, dir })]);
      expect(await made.call({ kind: 'adopt', run, attempt: place.attempt, dir })).toEqual({ error: {
        code: 'unknown_attempt', message: `Attempt ${place.attempt} of run ${run} is offered and waits for no place, so nothing was adopted. Run the next literal to see the run.`,
        next: `teamai workflow next ${run} --driver skill`,
      } });
      return made.rows;
    },
  },
  {
    name: 'on a host that starts no child, a step in the checkout is the session\'s to work in the foreground, and a step that needs a worktree is held',
    rows: ['R13', 'D1', 'D7', 'C2', 'K1', 'P5'],
    run: async () => {
      const made = await harness({ inline: INLINE });
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'inline', answers: { confirmed: false }, inputs: undefined }));
      const turn = await turnOf(await made.call({ kind: 'choose', run, choice: 'h4' }));
      const [notes] = dispatches(turn);
      expect(notes).toEqual(expect.objectContaining({ step: 'notes', dir: made.work, needs: { place: 'checkout', parallel: false, person: false } }));
      if (!notes) throw new Error(JSON.stringify(turn));
      await made.call({ kind: 'ack', run, attempt: notes.attempt });
      childWrites(notes.brief, { kind: 'output', output: 'Wrote the notes.' });
      expect(await made.call({ kind: 'report', run, attempt: notes.attempt, role: 'agent', modelUnavailable: false })).toEqual({ data: { runner: { attempt: notes.attempt, status: 'reported' } } });
      const held = await turnOf(await made.call({ kind: 'next', run, wait: false }));
      expect(dispatches(held)).toEqual([]);
      expect(held.running).toEqual([]);
      expect(held.waiting?.reason).toContain('step "change" needs workspace new, which this driver does not provide');
      return made.rows;
    },
  },
  {
    name: 'a step the person cancels while it waits for a place is dropped, and its place action goes',
    rows: ['D2'],
    run: async () => {
      const made = await harness({ write: WRITE });
      const { run } = await turnOf(await made.call({ kind: 'start', name: 'write', answers: { confirmed: false }, inputs: undefined }));
      const [place] = (await turnOf(await made.call({ kind: 'choose', run, choice: 'h3' }))).actions;
      if (place?.kind !== 'place') throw new Error(JSON.stringify(place));
      await made.context.client.cancel(run, 'write');
      const after = await turnOf(await made.call({ kind: 'next', run, wait: false }));
      expect(after.events).toContainEqual({ kind: 'stopped', step: 'write', attempt: place.attempt, why: 'cancelled' });
      expect(after.actions.filter((action) => action.kind === 'place')).toEqual([]);
      expect(after.running).toEqual([]);
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
    name: 'a prompt step whose merge conflicts is told so in its brief, which names the files to resolve',
    rows: ['D7', 'C2'],
    run: async () => {
      const made = await harness({ join: JOIN });
      const turn = await chosen(made, 'join', 2);
      for (const side of dispatches(turn)) {
        await made.call({ kind: 'ack', run: turn.run, attempt: side.attempt });
        fs.writeFileSync(path.join(side.dir, 'shared.txt'), `${side.step}\n`);
        childWrites(side.brief, { kind: 'output', output: `Wrote the ${side.step} side.` });
        expect(await made.call({ kind: 'report', run: turn.run, attempt: side.attempt, role: 'agent', modelUnavailable: false })).toEqual({ data: { runner: { attempt: side.attempt, status: 'reported' } } });
      }
      let joined = await turnOf(await made.call({ kind: 'next', run: turn.run, wait: false }));
      for (let poll = 0; poll < 5 && dispatches(joined).length === 0; poll += 1) {
        joined = await turnOf(await made.call({ kind: 'next', run: turn.run, wait: joined.then?.kind === 'poll' }));
      }
      const [join] = dispatches(joined);
      if (join?.step !== 'join') throw new Error(JSON.stringify(joined));
      const brief = fs.readFileSync(join.brief, 'utf8');
      expect(brief).toContain('Join both sides.\n\nMerge conflict with teamai/');
      expect(brief).toContain('(shared.txt). Resolve the conflict in the workspace.');
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
    name: 'a session that resumes a run it judges itself gets the score --next on done, and none with --no-judge',
    rows: ['R19'],
    run: async () => {
      const made = await harness({ review: REVIEW }, { scorers: SCORERS });
      const resumedToDone = async (answers: { judge?: false }) => {
        const created = await made.context.client.start('review', { checkout: made.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
        if (!('data' in created)) throw new Error(JSON.stringify(created));
        const run = RunIdSchema.parse(created.data.run);
        await turnOf(await made.call({ kind: 'resume', run, claim: false, confirmed: false, answers }, { tool: 'copilot' }));
        const [dispatch] = dispatches(await turnOf(await made.call({ kind: 'choose', run, choice: 'h1' })));
        if (!dispatch) throw new Error(`no dispatch for ${run}`);
        await made.call({ kind: 'ack', run, attempt: dispatch.attempt });
        childWrites(dispatch.brief, { kind: 'output', output: 'Reviewed the change.' });
        await made.call({ kind: 'report', run, attempt: dispatch.attempt, role: 'agent', modelUnavailable: false });
        return { run, turn: await turnOf(await made.call({ kind: 'next', run, wait: false })) };
      };
      const judged = await resumedToDone({});
      expect(judged.turn.actions).toEqual([{ kind: 'done', outcome: 'succeeded', prs: [], score: expect.stringContaining(`teamai score --next --json '{"run":"${judged.run}",`) }]);
      expect(judged.turn.actions[0]).toHaveProperty('score', expect.stringContaining('"can":{"judge":{"isolation":"best-effort","access":"read","tools":["copilot"]}}'));
      expect((await resumedToDone({ judge: false })).turn.actions).toEqual([{ kind: 'done', outcome: 'succeeded', prs: [] }]);
      return made.rows;
    },
  },
  {
    name: 'a resume decides session judging from the scorers its run pinned, not from a later pull',
    rows: ['R19'],
    run: async () => {
      const made = await harness({ review: REVIEW }, { scorers: SCORERS });
      const created = await made.context.client.start('review', { checkout: made.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
      if (!('data' in created)) throw new Error(JSON.stringify(created));
      const run = RunIdSchema.parse(created.data.run);
      // The team now asks for verified isolation; the run keeps the best-effort scorer it pinned.
      fs.writeFileSync(path.join(made.config.repo.localPath, 'scorers', 'review-quality.md'), SCORERS['review-quality'].replace('samplingRate: 100', 'samplingRate: 100\nisolation: verified'));
      await syncScorerDefinitions(made.config);
      await turnOf(await made.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {} }, { tool: 'copilot' }));
      const [dispatch] = dispatches(await turnOf(await made.call({ kind: 'choose', run, choice: 'h1' })));
      if (!dispatch) throw new Error(`no dispatch for ${run}`);
      await made.call({ kind: 'ack', run, attempt: dispatch.attempt });
      childWrites(dispatch.brief, { kind: 'output', output: 'Reviewed the change.' });
      await made.call({ kind: 'report', run, attempt: dispatch.attempt, role: 'agent', modelUnavailable: false });
      expect((await turnOf(await made.call({ kind: 'next', run, wait: false }))).actions).toEqual([{ kind: 'done', outcome: 'succeeded', prs: [], score: expect.stringContaining(`"run":"${run}"`) }]);
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
        text: '- claude judges review here, with one confined judge call per pass.\nHow should it run?',
        options: [{ label: 'Recommended: with judging', start: 'teamai workflow start review --driver skill' }, { label: 'Same, but without judging', start: 'teamai workflow start review --driver skill --no-judge' }],
      } } } } });
      expect(await reviewed(made, { judge: false })).toEqual(expect.objectContaining({ status: 'done', actions: [{ kind: 'done', outcome: 'succeeded', prs: [] }], events: [expect.objectContaining({ kind: 'settled' })] }));
      expect(made.rows).not.toContain('J1');
      return made.rows;
    },
  },
  {
    name: 'describe asks a session whose host names no tool for it, with a describe whose {tool} slot it fills, when the run needs a tool',
    rows: ['R27', 'R3', 'R4'],
    run: async () => {
      const plain = REVIEW.replace('    scorers: [review-quality]\n', '');
      const defaulted = plain.replace('name: review', 'name: defaulted').replace('steps:', 'defaults:\n  model: claude-opus-4-1\nsteps:');
      const made = await harness({ review: REVIEW, check: CHECK, plain: plain.replace('name: review', 'name: plain'), defaulted }, { scorers: SCORERS, tool: null });
      for (const mode of ['attended', 'unattended'] as const) {
        expect(await made.call({ kind: 'describe', name: 'review' }, { mode })).toMatchObject({ data: { describe: { ask: {
          kind: 'tool', reason: 'This coding session names no tool, which the run needs for the models of its steps or its judging.',
          describe: "teamai workflow start --describe review --driver skill --tools default='{tool}'", tools: expect.arrayContaining(['claude', 'omp', 'qoder']),
        } } } });
      }
      expect(await made.call({ kind: 'describe', name: 'review', tool: 'claude' })).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: {
        options: [{ label: 'Recommended: with judging', start: 'teamai workflow start review --driver skill --tools default=claude' }, { label: 'Same, but without judging', start: 'teamai workflow start review --driver skill --tools default=claude --no-judge' }],
      } } } } });
      // A model the workflow's defaults pin needs the tool too.
      expect(await made.call({ kind: 'describe', name: 'defaulted' })).toMatchObject({ data: { describe: { ask: { kind: 'tool' } } } });
      // A run of commands alone needs no tool, and neither does a prompt step that pins no model and is not judged.
      expect(await made.call({ kind: 'describe', name: 'check' })).toMatchObject({ data: { describe: { ask: { kind: 'start', start: 'teamai workflow start check --driver skill' } } } });
      expect(await made.call({ kind: 'describe', name: 'plain' })).toMatchObject({ data: { describe: { ask: { kind: 'start', start: 'teamai workflow start plain --driver skill' } } } });
      return made.rows;
    },
  },
  {
    name: 'judging by the session, when its tool has no confined judge here, is asked about too, and judging nobody here can do is not',
    rows: ['R3', 'R4'],
    run: async () => {
      const made = await harness({ review: REVIEW }, { scorers: SCORERS });
      expect(await made.call({ kind: 'describe', name: 'review' }, { tool: 'copilot' })).toMatchObject({ data: { describe: { judging: { kind: 'session' }, ask: { kind: 'ask', question: {
        text: '- review is judged by this session in a subagent once the run is done, at best-effort isolation. The coding session\'s tool, copilot, has no confined judge teamai runs.\nHow should it run?',
        options: [{ label: 'Recommended: with judging', start: 'teamai workflow start review --driver skill' }, { label: 'Same, but without judging', start: 'teamai workflow start review --driver skill --no-judge' }],
      } } } } });
      // A scorer that asks for verified isolation leaves its work to another driver.
      const verified = await harness({ review: REVIEW }, { scorers: { 'review-quality': SCORERS['review-quality'].replace('samplingRate: 100', 'samplingRate: 100\nisolation: verified') } });
      expect(await verified.call({ kind: 'describe', name: 'review' }, { tool: 'copilot' })).toMatchObject({ data: { describe: { judging: { kind: 'elsewhere' }, ask: {
        kind: 'start', say: '- review is not judged on this machine. The coding session\'s tool, copilot, has no confined judge teamai runs, and review-quality asks for verified isolation.',
        start: 'teamai workflow start review --driver skill',
      } } } });
      // A project whose teamai data is still inside its repository, where scoring is off.
      const member = await sharedTeam({ review: REVIEW }).install('legacy');
      const config: LocalConfig = { ...member.config, scope: 'project', projectRoot: member.checkout, dataHome: path.join(member.checkout, '.teamai') };
      await syncWorkflowDefinitions(config);
      const legacy = await harness({ review: REVIEW }, { install: { config, checkout: member.checkout } });
      expect(await legacy.call({ kind: 'describe', name: 'review' }, { tool: 'cursor' })).toMatchObject({ data: { describe: { judging: { kind: 'elsewhere' }, ask: {
        kind: 'start', say: expect.stringMatching(/^- review is not judged on this machine\. Scoring is off for this project/), start: 'teamai workflow start review --driver skill',
      } } } });
      return [...made.rows, ...verified.rows, ...legacy.rows];
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
