import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LabelStore } from '../scorers/label-store.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import type { RunMode } from '../launch-context.js';
import { acquireLock, releaseLock } from '../update.js';
import { getDataHome, type ToolId } from '../types.js';
import { skillContext } from '../workflow/drivers/skill/skill-driver.js';
import { inProcessClient, type WorkflowClient } from '../workflow/protocol.js';
import { takeJudgeLease, type JudgeRequest } from '../workflow/scoring.js';
import { AttemptIdSchema, deliveryLockPath, readRun, RunIdSchema, skillStatePath, type RunId } from '../workflow/store.js';
import { Crash, fakeJudge, githubOrigin, skillHarness, untilStopped } from './helpers/skill-harness.js';

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

// The step command appends a learning to its attempt's outcome file, in the data home beside the checkout it runs in.
const CLOSE = `schemaVersion: v1alpha1
name: close
description: Record what the run learned
invoke: allow
steps:
  - id: close
    command: node -e "const [r,a]=process.env.TEAMAI_WORKFLOW_ATTEMPT.split('/');const p=require('path');const d=p.join('..','data','workflows','runs',r,'outcomes');require('fs').mkdirSync(d,{recursive:true});require('fs').appendFileSync(p.join(d,a+'.jsonl'),JSON.stringify({kind:'learning',id:'retry-backoff'})+'\\n')"
`;

const FEATURE = `schemaVersion: v1alpha1
name: feature
description: Build the API and the UI, then integrate them
invoke: allow
steps:
  - id: api
    workspace: new
    prompt: Build the API.
  - id: ui
    needs: []
    workspace: new
    prompt: Build the UI.
  - id: integrate
    needs: [api, ui]
    workspace: new
    prompt: Integrate the API and the UI.
`;

// `polish` continues the branch `write` committed to.
const CHANGE = `schemaVersion: v1alpha1
name: change
description: Write a change, then polish it
invoke: allow
steps:
  - id: work
    workspace: new
    workflow:
      steps:
        - id: write
          prompt: Write the change.
        - id: polish
          needs: [write]
          prompt: Polish the change.
`;

// `serve` runs until it is stopped; `lint` shares the checkout, so it waits behind it.
const SERVE = `schemaVersion: v1alpha1
name: serve
description: Serve the app, then lint it
invoke: allow
steps:
  - id: serve
    command: sleep 300
  - id: lint
    needs: []
    command: node -e "process.exit(0)"
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

const REVIEW_QUALITY = `---
labels:
  - { value: thorough, score: 1, description: Did the work it was asked for }
  - { value: shallow, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 100
---
Judge the review.
`;

const SESSION_QUALITY = `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 100
sessions: true
---
Judge the session.
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

// `notify` needs a secret in a prompt step, which a session keeps from its agents.
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

// `topic` is an input, which the journal of a run never holds.
const NOTE = `schemaVersion: v1alpha1
name: note
description: Write a note on a topic
invoke: allow
inputs:
  topic: string
steps:
  - id: note
    workspace: new
    prompt: Write a note on {{ inputs.topic }}.
`;

const DEPLOY = `schemaVersion: v1alpha1
name: deploy
description: Deploy to production
invoke: allow
steps:
  - id: go-live
    approve: { message: Deploy to production?, required: true }
    command: node -e "process.exit(0)"
`;

// `read` works in the checkout, which no step may change; `change` writes a copy TeamAI commits.
const SURVEY = `schemaVersion: v1alpha1
name: survey
description: Read the code, and change it in a copy
invoke: allow
steps:
  - id: read
    prompt: Read the code.
  - id: change
    needs: []
    workspace: new
    prompt: Change the code.
`;

// Setup passes only when it gets the run mode the start kept, and the command prints the one it gets.
const MODE = `schemaVersion: v1alpha1
name: mode
description: Show the run mode
invoke: allow
setup:
  command: test "$TEAMAI_MODE" = unattended
steps:
  - id: show
    workspace: new
    command: node -e "console.log('TEAMAI_MODE=' + process.env.TEAMAI_MODE)"
`;

const SHOW = `schemaVersion: v1alpha1
name: show
description: Show the run mode
invoke: allow
steps:
  - id: show
    command: node -e "console.log('TEAMAI_MODE=' + process.env.TEAMAI_MODE)"
`;

type Harness = Awaited<ReturnType<typeof skillHarness>>;

/** Polls `run` until it is done: every event the polls showed. */
async function eventsToDone(harness: Harness, run: RunId): Promise<unknown[]> {
  const events: unknown[] = [];
  for (let poll = 0; poll < 10; poll += 1) {
    const turn = await harness.call({ kind: 'next', run, wait: true });
    if (!('data' in turn) || !('turn' in turn.data)) throw new Error(JSON.stringify(turn));
    events.push(...turn.data.turn.events);
    if (turn.data.turn.status === 'done') return events;
  }
  throw new Error('the run did not reach done in ten polls');
}

/** Starts `review` with the skill driver, has its child review the change and report, and answers the turn that follows. */
async function reviewed(harness: Harness, mode: RunMode = 'attended', options: { judge?: false; host?: 'h1' | 'h4'; tool?: ToolId } = {}): Promise<{ run: RunId; chosen: unknown; turn: unknown }> {
  const { host = 'h1', tool, ...judge } = options;
  const answers = { ...(mode === 'unattended' ? { confirmed: false, hitl: 'auto-approve' as const } : { confirmed: false }), ...judge };
  const started = await harness.call({ kind: 'start', name: 'review', answers, inputs: undefined, ...(tool !== undefined ? { tool } : {}) }, { mode });
  if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
  const run = RunIdSchema.parse(started.data.turn.run);
  const chosen = await harness.call({ kind: 'choose', run, choice: host }, { mode });
  if (!('data' in chosen) || !('turn' in chosen.data)) throw new Error(JSON.stringify(chosen));
  const [dispatch] = chosen.data.turn.actions.flatMap((action) => (action.kind === 'dispatch' ? [action] : []));
  if (!dispatch) throw new Error(JSON.stringify(chosen));
  await harness.call({ kind: 'ack', run, attempt: dispatch.attempt }, { mode });
  const file = /Write `([^`]+result\.json)`/.exec(fs.readFileSync(dispatch.brief, 'utf8'))?.[1];
  if (!file) throw new Error(`${dispatch.brief} names no result file`);
  fs.writeFileSync(file, JSON.stringify({ kind: 'output', output: 'Reviewed the change.' }));
  expect(await harness.call({ kind: 'report', run, attempt: dispatch.attempt, role: 'agent', modelUnavailable: false })).toMatchObject({ data: { runner: { status: 'reported' } } });
  return { run, chosen, turn: await harness.call({ kind: 'next', run, wait: false }, { mode }) };
}

/** A claude on PATH without a verified judge profile, so no confined judge of it runs here. */
function unverifiedClaude(harness: Harness): void {
  const bin = path.join(harness.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nconsole.log('0.0.1 (Claude Code)');\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
}

/** A Claude Code session of the harness's checkout, captured and idle for 7 hours: finished, for session scoring to judge. */
function idleSession(harness: Harness): void {
  const sessionId = '7c1e0000-0000-4000-8000-000000000021';
  const project = path.join(harness.root, 'home', '.claude', 'projects', encodeCwdClaude(harness.work));
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
  fs.writeFileSync(file,
    line({ type: 'user', uuid: 'u1', parentUuid: null, cwd: harness.work, sessionId, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'Add retries to the client' } })
    + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd: harness.work, sessionId, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } }));
  const idleSince = new Date(Date.now() - 7 * 60 * 60 * 1000);
  fs.utimesSync(file, idleSince, idleSince);
  const captures = path.join(harness.config.dataHome ?? '', 'sessions', 'captures', 'claude-code', sessionId);
  fs.mkdirSync(captures, { recursive: true });
  const captureId = '0b6f2a52-5d7e-4c7e-9a43-000000000021';
  fs.writeFileSync(path.join(captures, `${captureId}.json`), JSON.stringify({
    captureId, platform: 'claude-code', sessionId, capturedAt: idleSince.toISOString(), agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, sessionFile: file,
  }));
}

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('the outcomes a step\'s own commands report, under the skill driver (#1387)', () => {
  it('puts what the attempt appended to its outcome file on the pass it settles', async () => {
    const harness = await skillHarness({ close: CLOSE });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'close', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));

    expect(await eventsToDone(harness, started.data.turn.run)).toContainEqual(expect.objectContaining({ kind: 'settled', step: 'close', outcome: 'success' }));
    expect(await readRun(harness.config, started.data.turn.run)).toMatchObject({ steps: [{ id: 'close', outcomes: [{ kind: 'learning', id: 'retry-backoff' }] }] });
  });
});

describe('skill driver', () => {
  it('drives a command-only workflow from start to done, with a poll that returns as each step settles', async () => {
    const harness = await skillHarness({ check: CHECK });
    roots.push(harness.root);

    const described = await harness.call({ kind: 'describe', name: 'check' });
    expect(described).toMatchObject({ data: { describe: {
      workflow: { name: 'check', description: 'Lint and test', invoke: 'allow', inputs: {} },
      ask: { kind: 'start', start: 'teamai workflow start check --driver skill' },
    } } });

    const started = await harness.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const { run } = started.data.turn;
    expect(started.data.turn).toEqual({
      run, status: 'driving', actions: [],
      running: [{ attempt: expect.stringMatching(/^a[0-9a-f]{8}$/), step: 'lint', phase: 'running' }],
      events: [{ kind: 'started', step: 'lint', attempt: expect.stringMatching(/^a[0-9a-f]{8}$/) }],
      // oxlint-disable-next-line unicorn/no-thenable
      then: { kind: 'poll', run: `teamai workflow next ${run} --driver skill --wait` },
    });

    const polled = await harness.call({ kind: 'next', run, wait: true });
    expect(polled).toEqual({ data: { turn: {
      run, status: 'driving', actions: [],
      running: [{ attempt: expect.stringMatching(/^a[0-9a-f]{8}$/), step: 'test', phase: 'preparing' }],
      events: [
        { kind: 'settled', step: 'lint', outcome: 'success', exitCode: 0 },
        { kind: 'started', step: 'test', attempt: expect.stringMatching(/^a[0-9a-f]{8}$/) },
      ],
      // oxlint-disable-next-line unicorn/no-thenable
      then: { kind: 'poll', run: `teamai workflow next ${run} --driver skill --wait` },
    } } });
    const ended = await harness.call({ kind: 'next', run, wait: true });
    expect(ended).toEqual({ data: { turn: {
      run, status: 'done', running: [],
      actions: [{ kind: 'done', outcome: 'succeeded', prs: [] }],
      events: [{ kind: 'settled', step: 'test', outcome: 'success', exitCode: 0, tail: 'Tests 42 passed (42)' }],
    } } });

    // Every command the session ran came whole from a reply: no slot or placeholder was left for it to fill.
    expect(JSON.stringify([described, started, polled, ended])).not.toMatch(/\{inputs\}|\{dir\}|<[a-z]+>/);
  });

  it('gives setup, the command and the pass of an attempt the run mode its start kept, whatever mode a later call has', async () => {
    const harness = await skillHarness({ mode: MODE });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'mode', answers: { confirmed: false, hitl: 'auto-approve' }, inputs: undefined }, { mode: 'unattended' });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    expect(await eventsToDone(harness, started.data.turn.run)).toContainEqual(expect.objectContaining({ kind: 'settled', step: 'show', outcome: 'success', tail: 'TEAMAI_MODE=unattended' }));
    expect(await readRun(harness.config, started.data.turn.run)).toMatchObject({ steps: [{ id: 'show', runMode: 'unattended' }] });
  });

  it('runs a run whose skill state was written before the run mode existed as attended', async () => {
    const harness = await skillHarness({ show: SHOW }, { mode: 'unattended' });
    roots.push(harness.root);
    harness.hold(true);
    const started = await harness.call({ kind: 'start', name: 'show', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const { run } = started.data.turn;
    const file = skillStatePath(harness.config, run);
    const state = z.object({ options: z.record(z.unknown()) }).passthrough().parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    const { mode: _mode, ...options } = state.options;
    fs.writeFileSync(file, JSON.stringify({ ...state, options }));
    harness.hold(false);
    expect(await eventsToDone(harness, run)).toContainEqual(expect.objectContaining({ kind: 'settled', step: 'show', outcome: 'success', tail: 'TEAMAI_MODE=attended' }));
  });

  it('drives a run whose skill state names a tool this teamai does not know, as one a newer teamai wrote', async () => {
    const harness = await skillHarness({ check: CHECK });
    roots.push(harness.root);
    harness.hold(true);
    const started = await harness.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const { run } = started.data.turn;
    const file = skillStatePath(harness.config, run);
    const state = z.object({ orchestrator: z.record(z.unknown()) }).passthrough().parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    fs.writeFileSync(file, JSON.stringify({ ...state, orchestrator: { ...state.orchestrator, tool: 'newer-tool' } }));
    harness.hold(false);
    expect(await harness.call({ kind: 'next', run, wait: false })).toMatchObject({ data: { turn: { run } } });
  });

  it('answers held to a step command that reports its own attempt, and the runner alone reports it', async () => {
    const harness = await skillHarness({ check: CHECK });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const { run, running: [lint] } = started.data.turn;
    if (lint?.phase !== 'running') throw new Error(JSON.stringify(started));

    // A step command inherits its runner's marker, so its own report call reads as the runner's, while that runner
    // still holds the attempt's runner lock.
    expect(await harness.call({ kind: 'report', run, attempt: lint.attempt, role: 'runner' }))
      .toEqual({ data: { runner: { attempt: lint.attempt, status: 'held' } } });

    const settled: string[] = [];
    let actions: unknown;
    for (let poll = 0; poll < 10 && actions === undefined; poll += 1) {
      const turn = await harness.call({ kind: 'next', run, wait: true });
      if (!('data' in turn) || !('turn' in turn.data)) throw new Error(JSON.stringify(turn));
      settled.push(...turn.data.turn.events.flatMap((event) => (event.kind === 'settled' ? [event.step] : [])));
      if (turn.data.turn.status === 'done') actions = turn.data.turn.actions;
    }
    expect(settled).toEqual(['lint', 'test']);
    expect(actions).toEqual([{ kind: 'done', outcome: 'succeeded', prs: [] }]);
  });

  it('answers an error thrown inside a call as one error envelope with its message and nothing to run', async () => {
    const lost = 'The runner of attempt a1 cannot start in /gone, the checkout run r1 started from: it does not exist.';
    const harness = await skillHarness({ check: CHECK }, { runners: (runners) => ({ ...runners, spawn: async () => { throw new Error(lost); } }) });
    roots.push(harness.root);

    expect(await harness.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined })).toEqual({ error: { code: 'skill_call_failed', message: lost, next: null } });
  });

  it('refuses a start from an agent session of a workflow without invoke, and leaves the person nothing but their own terminal', async () => {
    const harness = await skillHarness({ check: CHECK.replace('invoke: allow\n', '') });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined }, { evidence: { kind: 'session', variable: 'CLAUDE_CODE_SESSION_ID' } });
    expect(started).toEqual({ error: {
      code: 'invoke_denied',
      message: 'Workflow "check" has invoke: deny, so no coding agent starts it, with any driver, and this command runs inside an agent session (CLAUDE_CODE_SESSION_ID is set). The person can start it from their own terminal with teamai workflow start check --driver local. To let agents start it, the team sets invoke: allow, or invoke: ask for a start after the person agrees, in workflows/check.yaml.',
      next: null,
    } });
    expect(fs.existsSync(path.join(getDataHome(harness.config), 'workflows', 'runs'))).toBe(false);
  });

  it('refuses a start of a workflow without invoke from a host that sets no agent session variable, since only a coding agent drives --driver skill', async () => {
    const harness = await skillHarness({ check: CHECK.replace('invoke: allow\n', '') });
    roots.push(harness.root);
    // The test env carries no agent session variable, as a host that sets none.
    const { evidence } = await skillContext({ config: harness.config, toolPaths: harness.context.toolPaths, env: harness.context.env, cwd: harness.work, aiTools: [] });
    const message = 'Workflow "check" has invoke: deny, so no coding agent starts it, with any driver, and this command uses --driver skill, which only a coding agent drives. The person can start it from their own terminal with teamai workflow start check --driver local. To let agents start it, the team sets invoke: allow, or invoke: ask for a start after the person agrees, in workflows/check.yaml.';
    expect(await harness.call({ kind: 'describe', name: 'check' }, { evidence })).toMatchObject({ data: { describe: { ask: { kind: 'denied', reason: message } } } });
    expect(await harness.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined }, { evidence }))
      .toEqual({ error: { code: 'invoke_denied', message, next: null } });
    expect(fs.existsSync(path.join(getDataHome(harness.config), 'workflows', 'runs'))).toBe(false);
  });

  it('refuses an unattended agent start of an invoke: ask workflow even with --confirmed, with the reason describe gives', async () => {
    const gated = CHECK.replace('invoke: allow', 'invoke: ask');
    const harness = await skillHarness({ check: gated });
    roots.push(harness.root);
    const session = { evidence: { kind: 'session', variable: 'CLAUDE_CODE_SESSION_ID' }, mode: 'unattended' } as const;
    const described = await harness.call({ kind: 'describe', name: 'check' }, session);
    if (!('data' in described) || !('describe' in described.data) || described.data.describe.ask.kind !== 'denied') throw new Error(JSON.stringify(described));
    const { reason } = described.data.describe.ask;
    expect(await harness.call({ kind: 'start', name: 'check', answers: { confirmed: true }, inputs: undefined }, session))
      .toEqual({ error: { code: 'unattended_denied', message: reason, next: null } });
    // The local driver's start, from the same session, is refused alike.
    expect(await harness.context.client.start('check', { checkout: harness.work, caller: { evidence: session.evidence, confirmed: true, mode: 'unattended' } }))
      .toEqual({ error: { code: 'unattended_denied', message: reason } });
    expect(fs.existsSync(path.join(getDataHome(harness.config), 'workflows', 'runs'))).toBe(false);
    // A person's terminal or a CI job without an agent starts it.
    expect(await harness.context.client.start('check', { checkout: harness.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'unattended' } }))
      .toMatchObject({ data: { run: expect.any(String) } });
  });

  it('refuses a start from inside a workflow attempt, even of a workflow agents may start, and offers no describe to retry it', async () => {
    const harness = await skillHarness({ check: CHECK });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined }, { evidence: { kind: 'attempt', attempt: 'r0123456789abcdef/a0000000a' } });
    expect(started).toEqual({ error: {
      code: 'nested_workflow',
      message: "This process runs inside workflow attempt r0123456789abcdef/a0000000a (TEAMAI_WORKFLOW_ATTEMPT is set), so it cannot start or drive a workflow run. Do the step's own work here; to run another workflow as part of a run, add it to the definition as a workflow step.",
      next: null,
    } });
    expect(fs.existsSync(path.join(getDataHome(harness.config), 'workflows', 'runs'))).toBe(false);
  });

  it('offers two parallel new prompt steps with acks, keeps an unacked one offered, and a poll answers wake', async () => {
    const harness = await skillHarness({ feature: FEATURE });
    roots.push(harness.root);

    const started = await harness.call({ kind: 'start', name: 'feature', answers: { parallel: 2, confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const { run } = started.data.turn;
    const host = started.data.turn.actions.find((action) => action.kind === 'choose' && action.about === 'host');
    if (host?.kind !== 'choose' || host.about !== 'host') throw new Error(JSON.stringify(started));
    expect(host.options.find((option) => option.id === 'h1')?.run).toBe(`teamai workflow next ${run} --driver skill --choice h1`);
    expect(fs.existsSync(host.reference), host.reference).toBe(true);

    const chosen = await harness.call({ kind: 'choose', run, choice: 'h1' });
    if (!('data' in chosen) || !('turn' in chosen.data)) throw new Error(JSON.stringify(chosen));
    const offered = chosen.data.turn.actions.filter((action) => action.kind === 'dispatch');
    expect(offered.map((action) => action.step).sort()).toEqual(['api', 'ui']);
    for (const action of offered) {
      expect(action).toMatchObject({
        offer: `dispatch.${action.attempt}`,
        ack: `teamai workflow next ${run} --driver skill --ack dispatch.${action.attempt}`,
        report: `teamai workflow report ${run} --driver skill --attempt ${action.attempt}`,
        needs: { place: 'workspace', parallel: true },
      });
      expect(fs.existsSync(action.dir), action.dir).toBe(true);
      expect(fs.existsSync(action.brief), action.brief).toBe(true);
    }
    expect(new Set(offered.map((action) => action.dir)).size).toBe(2);

    const polled = await harness.call({ kind: 'next', run, wait: true });
    expect(polled).toEqual({ data: { turn: expect.objectContaining({
      actions: [],
      // oxlint-disable-next-line unicorn/no-thenable
      then: { kind: 'wake', run: `teamai workflow next ${run} --driver skill` },
    }) } });

    const [first, second] = offered;
    if (!first || !second) throw new Error('two dispatches expected');
    const acked = await harness.call({ kind: 'ack', run, attempt: first.attempt });
    if (!('data' in acked) || !('turn' in acked.data)) throw new Error(JSON.stringify(acked));
    expect(acked.data.turn.actions).toEqual([second]);
    const again = await harness.call({ kind: 'next', run, wait: false });
    if (!('data' in again) || !('turn' in again.data)) throw new Error(JSON.stringify(again));
    expect(again.data.turn.actions).toEqual([second]);
    expect(again.data.turn.running.map(({ attempt, phase }) => ({ attempt, phase }))).toEqual(expect.arrayContaining([
      { attempt: first.attempt, phase: 'dispatched' },
      { attempt: second.attempt, phase: 'offered' },
    ]));
  });

  it('a second live session gets orchestrator_active, and --takeover reissues acked dispatches', async () => {
    const harness = await skillHarness({ feature: FEATURE });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'feature', answers: { parallel: 2, confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const { run } = started.data.turn;
    const chosen = await harness.call({ kind: 'choose', run, choice: 'h1' });
    if (!('data' in chosen) || !('turn' in chosen.data)) throw new Error(JSON.stringify(chosen));
    const api = chosen.data.turn.actions.find((action) => action.kind === 'dispatch' && action.step === 'api');
    const ui = chosen.data.turn.actions.find((action) => action.kind === 'dispatch' && action.step === 'ui');
    if (api?.kind !== 'dispatch' || ui?.kind !== 'dispatch') throw new Error(JSON.stringify(chosen));
    await harness.call({ kind: 'ack', run, attempt: api.attempt });

    const takeover = `teamai workflow next ${run} --driver skill --takeover`;
    expect(await harness.call({ kind: 'next', run, wait: false }, { session: 'session-b' }))
      .toEqual({ error: { code: 'orchestrator_active', message: expect.stringContaining('Ask the person'), idleSeconds: expect.any(Number), next: takeover } });

    const taken = await harness.call({ kind: 'takeover', run, confirmed: false }, { session: 'session-b' });
    if (!('data' in taken) || !('turn' in taken.data)) throw new Error(JSON.stringify(taken));
    // The first session was told both steps started, so the person does not hear it again.
    expect(taken.data.turn.events).toEqual([{ kind: 'takeover', from: 'session-a' }]);
    // Both dispatches are offered again, saying the child the first session may have started may still run.
    expect(taken.data.turn.actions).toEqual(expect.arrayContaining([api, ui].map((action) => ({ ...action, reissued: expect.stringContaining(action.title) }))));
    expect(taken.data.turn.actions).toHaveLength(2);
    expect(taken.data.turn.running).toContainEqual({ attempt: api.attempt, step: 'api', phase: 'offered', report: api.report });
    // The first session no longer drives the run.
    expect(await harness.call({ kind: 'next', run, wait: false })).toMatchObject({ error: { code: 'orchestrator_active', next: takeover } });
  });

  it('a child reports from its own session or the orchestrator\'s and gets the runner answer, and the orchestrator\'s next turn shows the step settled', async () => {
    const harness = await skillHarness({ feature: FEATURE });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'feature', answers: { parallel: 2, confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const { run } = started.data.turn;
    const chosen = await harness.call({ kind: 'choose', run, choice: 'h1' });
    if (!('data' in chosen) || !('turn' in chosen.data)) throw new Error(JSON.stringify(chosen));
    const dispatches = chosen.data.turn.actions.flatMap((action) => (action.kind === 'dispatch' ? [action] : []));
    for (const action of dispatches) {
      await harness.call({ kind: 'ack', run, attempt: action.attempt });
      const file = /Write `([^`]+result\.json)`/.exec(fs.readFileSync(action.brief, 'utf8'))?.[1];
      if (!file) throw new Error(`${action.brief} names no result file`);
      fs.writeFileSync(file, JSON.stringify({ kind: 'output', output: `Built ${action.step}.` }));
    }
    const [api, ui] = dispatches;
    if (!api || !ui) throw new Error(JSON.stringify(chosen));

    // An app orchestration tool starts the child in its own session; a native subagent shares the orchestrator's.
    const report = { kind: 'report', run, role: 'agent', modelUnavailable: false } as const;
    expect(await harness.call({ ...report, attempt: api.attempt }, { session: 'child-session' })).toEqual({ data: { runner: { attempt: api.attempt, status: 'reported' } } });
    expect(await harness.call({ ...report, attempt: api.attempt }, { session: 'child-session' })).toEqual({ data: { runner: { attempt: api.attempt, status: 'repeated' } } });
    expect(await harness.call({ ...report, attempt: ui.attempt })).toEqual({ data: { runner: { attempt: ui.attempt, status: 'reported' } } });

    const next = await harness.call({ kind: 'next', run, wait: false });
    if (!('data' in next) || !('turn' in next.data)) throw new Error(JSON.stringify(next));
    expect(next.data.turn.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'settled', step: 'api', outcome: 'success' }),
      expect.objectContaining({ kind: 'settled', step: 'ui', outcome: 'success' }),
    ]));
    expect(next.data.turn.actions.map((action) => action.kind === 'dispatch' && action.step)).toEqual(['integrate']);
  });

  it('journals each call a session makes on a run beside its skill state, and each dispatch once, with no input and nothing in a turn', async () => {
    const harness = await skillHarness({ note: NOTE });
    roots.push(harness.root);
    const answers: unknown[] = [];
    const call = async (...args: Parameters<Harness['call']>): ReturnType<Harness['call']> => {
      const answer = await harness.call(...args);
      answers.push(answer);
      return answer;
    };
    const started = await call({ kind: 'start', name: 'note', answers: { confirmed: false }, inputs: { topic: 'the-input-topic' } });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    const chosen = await call({ kind: 'choose', run, choice: 'h1' });
    if (!('data' in chosen) || !('turn' in chosen.data)) throw new Error(JSON.stringify(chosen));
    const [note] = chosen.data.turn.actions.flatMap((action) => (action.kind === 'dispatch' ? [action] : []));
    if (!note) throw new Error(JSON.stringify(chosen));
    await call({ kind: 'next', run, wait: false });
    await call({ kind: 'next', run, wait: false }, { session: 'session-b' });
    await call({ kind: 'ack', run, attempt: note.attempt });
    const file = /Write `([^`]+result\.json)`/.exec(fs.readFileSync(note.brief, 'utf8'))?.[1];
    if (!file) throw new Error(`${note.brief} names no result file`);
    fs.writeFileSync(file, JSON.stringify({ kind: 'output', output: 'Wrote the note.' }));
    await call({ kind: 'report', run, attempt: note.attempt, role: 'agent', modelUnavailable: false }, { session: 'child-session', cwd: note.dir });

    const journal = fs.readFileSync(path.join(path.dirname(skillStatePath(harness.config, run)), 'journal.jsonl'), 'utf8');
    const at = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);
    expect(journal.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { at, kind: 'call', call: 'start', by: 'orchestrator', inCheckout: true, answer: 'ok' },
      { at, kind: 'call', call: 'choose', by: 'orchestrator', inCheckout: true, choice: 'h1', answer: 'ok' },
      { at, kind: 'asked', action: 'dispatch', attempt: note.attempt, step: 'note' },
      { at, kind: 'call', call: 'next', by: 'orchestrator', inCheckout: true, answer: 'ok' },
      { at, kind: 'call', call: 'next', by: 'session', inCheckout: true, answer: 'orchestrator_active' },
      { at, kind: 'call', call: 'ack', by: 'orchestrator', inCheckout: true, attempt: note.attempt, answer: 'acked' },
      { at, kind: 'call', call: 'report', by: 'session', inCheckout: false, attempt: note.attempt, answer: 'reported' },
    ]);
    expect(journal).not.toContain('the-input-topic');
    expect(JSON.stringify(answers)).not.toContain('journal');
  });

  it('journals a person action once, however many turns show it', async () => {
    const harness = await skillHarness({ deploy: DEPLOY });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'deploy', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    let shown = 0;
    for (let call = 0; call < 10 && shown < 3; call += 1) {
      const turn = await harness.call({ kind: 'next', run, wait: false });
      if (!('data' in turn) || !('turn' in turn.data)) throw new Error(JSON.stringify(turn));
      if (turn.data.turn.actions.some((action) => action.kind === 'person')) shown += 1;
    }
    expect(shown).toBe(3);

    const journal = fs.readFileSync(path.join(path.dirname(skillStatePath(harness.config, run)), 'journal.jsonl'), 'utf8');
    const asked = journal.trim().split('\n').map((line) => JSON.parse(line)).filter((line) => line.kind === 'asked');
    expect(asked).toEqual([{ at: expect.any(String), kind: 'asked', action: 'approval', step: 'go-live', pass: 1 }]);
  });

  it('tells the child of a step that only reads its place to change no file there, and the child of a writer that TeamAI commits its changes', async () => {
    const harness = await skillHarness({ survey: SURVEY });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'survey', answers: { parallel: 2, confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const chosen = await harness.call({ kind: 'choose', run: started.data.turn.run, choice: 'h1' });
    if (!('data' in chosen) || !('turn' in chosen.data)) throw new Error(JSON.stringify(chosen));
    const briefs = Object.fromEntries(chosen.data.turn.actions.flatMap((action) => (action.kind === 'dispatch' ? [[action.step, fs.readFileSync(action.brief, 'utf8')]] : [])));
    expect(Object.keys(briefs).sort()).toEqual(['change', 'read']);
    expect(briefs.read).toContain('Do not change files here');
    expect(briefs.read).not.toContain('commits and pushes');
    expect(briefs.change).toContain('It commits and pushes that directory after you report.');
    expect(briefs.change).not.toContain('Do not change files here');
  });

  it('on h4, where the agent works each step itself, tells it to go on with the run after its report', async () => {
    const harness = await skillHarness({ survey: SURVEY });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'survey', answers: { parallel: 2, confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const chosen = await harness.call({ kind: 'choose', run: started.data.turn.run, choice: 'h4' });
    if (!('data' in chosen) || !('turn' in chosen.data)) throw new Error(JSON.stringify(chosen));
    const [read] = chosen.data.turn.actions.flatMap((action) => (action.kind === 'dispatch' ? [action] : []));
    if (!read) throw new Error(JSON.stringify(chosen));
    const brief = fs.readFileSync(read.brief, 'utf8');
    expect(brief).toContain(`2. Run \`${read.report}\` once, then go on with the run.`);
    expect(brief).not.toContain('Another agent orchestrates the run');
    expect(brief).not.toContain('your last message');
  });

  it('h3 asks the host for a place, adopts it, and a continue step reuses it', async () => {
    const harness = await skillHarness({ change: CHANGE });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'change', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const { run } = started.data.turn;
    const host = started.data.turn.actions.find((action) => action.kind === 'choose' && action.about === 'host');
    if (host?.kind !== 'choose' || host.about !== 'host') throw new Error(JSON.stringify(started));
    expect(host.options.find((option) => option.id === 'h3')?.run).toBe(`teamai workflow next ${run} --driver skill --choice h3`);

    const chosen = await harness.call({ kind: 'choose', run, choice: 'h3' });
    if (!('data' in chosen) || !('turn' in chosen.data)) throw new Error(JSON.stringify(chosen));
    const [place] = chosen.data.turn.actions;
    if (place?.kind !== 'place') throw new Error(JSON.stringify(chosen));
    const start = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: harness.work, encoding: 'utf8' }).trim();
    const adopt = `teamai workflow next ${run} --driver skill --attempt ${place.attempt} --adopt '{dir}'`;
    expect(place).toEqual({
      kind: 'place', attempt: place.attempt, step: 'work.write', name: expect.stringMatching(/^teamai-/), branch: `teamai/${run}/work/p1`, start, adopt,
      reference: expect.stringMatching(/places\.md$/),
    });
    expect(fs.existsSync(place.reference), place.reference).toBe(true);
    expect(chosen.data.turn.running).toEqual([{ attempt: place.attempt, step: 'work.write', phase: 'placing' }]);
    expect(await harness.call({ kind: 'next', run, wait: true })).toEqual({ data: { turn: expect.objectContaining({
      actions: [],
      // oxlint-disable-next-line unicorn/no-thenable
      then: { kind: 'wake', run: `teamai workflow next ${run} --driver skill` },
    }) } });

    // The host makes a place on a branch of its own: it is refused, and the attempt waits for another.
    const hosts = path.join(harness.root, 'hosts');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'host/other', path.join(hosts, 'other'), start], { cwd: harness.work });
    const refused = await harness.call({ kind: 'adopt', run, attempt: place.attempt, dir: path.join(hosts, 'other') });
    if (!('data' in refused) || !('turn' in refused.data)) throw new Error(JSON.stringify(refused));
    expect(refused.data.turn.actions).toEqual([{ ...place, refused: expect.stringContaining(`not on branch teamai/${run}/work/p1`) }]);
    expect(refused.data.turn.running).toEqual([{ attempt: place.attempt, step: 'work.write', phase: 'placing' }]);

    const dir = path.join(hosts, 'place');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', dir, start], { cwd: harness.work });
    const adopted = await harness.call({ kind: 'adopt', run, attempt: place.attempt, dir });
    if (!('data' in adopted) || !('turn' in adopted.data)) throw new Error(JSON.stringify(adopted));
    const [write] = adopted.data.turn.actions;
    if (write?.kind !== 'dispatch') throw new Error(JSON.stringify(adopted));
    expect(write).toMatchObject({ attempt: place.attempt, step: 'work.write', dir, needs: { place: 'workspace' } });

    await harness.call({ kind: 'ack', run, attempt: write.attempt });
    fs.writeFileSync(path.join(dir, 'change.txt'), 'written\n');
    const result = (brief: string): string => {
      const file = /Write `([^`]+result\.json)`/.exec(fs.readFileSync(brief, 'utf8'))?.[1];
      if (!file) throw new Error(`${brief} names no result file`);
      return file;
    };
    fs.writeFileSync(result(write.brief), JSON.stringify({ kind: 'output', output: 'Wrote the change.' }));
    expect(await harness.call({ kind: 'report', run, attempt: write.attempt, role: 'agent', modelUnavailable: false })).toMatchObject({ data: { runner: { status: 'reported' } } });

    // polish continues the branch in the place the host made, and nobody is asked for another.
    const next = await harness.call({ kind: 'next', run, wait: false });
    if (!('data' in next) || !('turn' in next.data)) throw new Error(JSON.stringify(next));
    const [polish] = next.data.turn.actions;
    if (polish?.kind !== 'dispatch') throw new Error(JSON.stringify(next));
    expect(next.data.turn.actions).toHaveLength(1);
    expect(polish).toMatchObject({ step: 'work.polish', dir });

    await harness.call({ kind: 'ack', run, attempt: polish.attempt });
    fs.appendFileSync(path.join(dir, 'change.txt'), 'polished\n');
    fs.writeFileSync(result(polish.brief), JSON.stringify({ kind: 'output', output: 'Polished the change.' }));
    await harness.call({ kind: 'report', run, attempt: polish.attempt, role: 'agent', modelUnavailable: false });
    const done = await harness.call({ kind: 'next', run, wait: false });
    expect(done).toMatchObject({ data: { turn: { status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] } } });
    // TeamAI leaves the place to its host, with both steps committed on the branch.
    expect(fs.readFileSync(path.join(dir, 'change.txt'), 'utf8')).toBe('written\npolished\n');
    expect(execFileSync('git', ['log', '--format=%s', `teamai/${run}/work/p1`], { cwd: dir, encoding: 'utf8' }).trim().split('\n')).toHaveLength(3);
  });

  it('a cancelled command is stopped by its runner and reported released; a cancelled prompt step shows stop until reported', async () => {
    // A prompt step's child is the agent's, so the agent is asked to stop it, until it reports.
    const prompts = await skillHarness({ feature: FEATURE });
    roots.push(prompts.root);
    const started = await prompts.call({ kind: 'start', name: 'feature', answers: { parallel: 2, confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const { run } = started.data.turn;
    const chosen = await prompts.call({ kind: 'choose', run, choice: 'h1' });
    if (!('data' in chosen) || !('turn' in chosen.data)) throw new Error(JSON.stringify(chosen));
    const api = chosen.data.turn.actions.find((action) => action.kind === 'dispatch' && action.step === 'api');
    const ui = chosen.data.turn.actions.find((action) => action.kind === 'dispatch' && action.step === 'ui');
    if (api?.kind !== 'dispatch' || ui?.kind !== 'dispatch') throw new Error(JSON.stringify(chosen));
    await prompts.call({ kind: 'ack', run, attempt: api.attempt });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: api.dir, encoding: 'utf8' });
    fs.writeFileSync(`${api.dir}/api.txt`, 'half done\n');
    expect(await prompts.context.client.cancel(run, 'api')).toMatchObject({ data: { cancelled: { attempts: [api.attempt] } } });

    const stop = { kind: 'stop', attempt: api.attempt, step: 'api', title: api.title, why: 'cancelled', report: api.report };
    for (let call = 0; call < 2; call += 1) {
      const shown = await prompts.call({ kind: 'next', run, wait: false });
      if (!('data' in shown) || !('turn' in shown.data)) throw new Error(JSON.stringify(shown));
      // The stop comes before any dispatch, in every turn until the agent reports.
      expect(shown.data.turn.actions).toEqual([stop, ui]);
      expect(shown.data.turn.running).toContainEqual({ attempt: api.attempt, step: 'api', phase: 'stopping', report: api.report });
    }
    expect(await prompts.call({ kind: 'report', run, attempt: api.attempt, role: 'agent', modelUnavailable: false }))
      .toEqual({ data: { runner: { attempt: api.attempt, status: 'reported' } } });
    const reported = await prompts.call({ kind: 'next', run, wait: false });
    if (!('data' in reported) || !('turn' in reported.data)) throw new Error(JSON.stringify(reported));
    expect(reported.data.turn.events).toContainEqual({ kind: 'stopped', step: 'api', attempt: api.attempt, why: 'cancelled' });
    expect(reported.data.turn.actions).toEqual([ui]);
    // The protocol abandoned the place: what the child left there is not committed.
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: api.dir, encoding: 'utf8' })).toBe(head);
    expect(execFileSync('git', ['status', '--porcelain', '--', 'api.txt'], { cwd: api.dir, encoding: 'utf8' })).toBe('?? api.txt\n');

    // A command's child is its runner's, so the runner stops it at its next check and reports it released.
    const calls: Array<{ next: string[] } | { report: string; outcome: string }> = [];
    const stops: string[] = [];
    const commands = await skillHarness({ serve: SERVE }, {
      client: (client) => ({
        ...client,
        next: async (runId, body, options) => {
          calls.push({ next: z.object({ running: z.array(z.string()) }).parse(body).running });
          return client.next(runId, body, options);
        },
        report: async (runId, body, options) => {
          const { attempt, outcome } = z.object({ attempt: z.string(), outcome: z.string() }).parse(body);
          calls.push({ report: attempt, outcome });
          return client.report(runId, body, options);
        },
      }),
      runners: (runners) => ({
        ...runners,
        command: (input) => (input.command === 'sleep 300' ? untilStopped(() => { stops.push(input.env.TEAMAI_WORKFLOW_ATTEMPT ?? ''); }) : runners.command(input)),
      }),
    });
    roots.push(commands.root);
    const events: unknown[] = [];
    const turnOf = (answer: Awaited<ReturnType<typeof commands.call>>) => {
      if (!('data' in answer) || !('turn' in answer.data)) throw new Error(JSON.stringify(answer));
      events.push(...answer.data.turn.events);
      return answer.data.turn;
    };
    // One at a time, so lint is leased only once serve is given up, and the run is not done before then.
    let turn = turnOf(await commands.call({ kind: 'start', name: 'serve', answers: { parallel: 1, confirmed: false }, inputs: undefined }));
    const served = turn.run;
    const serve = turn.running.find((entry) => entry.step === 'serve');
    if (serve?.phase !== 'running') throw new Error(JSON.stringify(turn));
    await commands.context.client.cancel(served, 'serve');

    for (let poll = 0; poll < 5 && turn.status !== 'done'; poll += 1) turn = turnOf(await commands.call({ kind: 'next', run: served, wait: true }));
    expect(stops).toEqual([`${served}/${serve.attempt}`]);
    expect(events).toContainEqual({ kind: 'stopped', step: 'serve', attempt: serve.attempt, why: 'cancelled' });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'settled', step: 'lint', outcome: 'success' }));
    const released = calls.findIndex((call) => 'report' in call && call.report === serve.attempt);
    expect(calls[released]).toEqual({ report: serve.attempt, outcome: 'released' });
    const later = calls.slice(released).flatMap((call) => ('next' in call ? [call.next] : []));
    expect(later.length).toBeGreaterThan(0);
    for (const running of later) expect(running).not.toContain(serve.attempt);
  });

  it.each([
    // The person cancels the run from their terminal while setup runs.
    { stop: 'the run cancelled', timeout: '', meanwhile: async (client: WorkflowClient, run: RunId) => { await client.cancel(run); }, step: { status: 'cancelled' } },
    // A next past the deadline settles the run: the engine stops the attempt, as a runner's own check would.
    {
      stop: 'whose deadline passed', timeout: '    timeout: 30s\n', step: { status: 'failed', failure: { code: 'timeout' } },
      meanwhile: async (client: WorkflowClient, run: RunId, driver: unknown, advance: (ms: number) => void) => {
        advance(60_000);
        await client.next(run, { driver, canTakeLease: false });
      },
    },
  ])('gives up an attempt $stop while its setup ran, and never starts its command', async ({ timeout, meanwhile, step }) => {
    const commands: string[] = [];
    const reports: string[] = [];
    const harness = await skillHarness({ build: `schemaVersion: v1alpha1
name: build
description: Build in a set-up workspace
invoke: allow
setup:
  command: node -e "process.exit(0)"
steps:
  - id: build
    workspace: new
${timeout}    command: node -e "require('fs').writeFileSync('built.txt', 'B')"
` }, {
      client: (client) => ({
        ...client,
        setup: async (run, attempt, mode) => {
          const failure = await client.setup(run, attempt, mode);
          await meanwhile(client, run, z.object({ driver: z.unknown() }).parse(JSON.parse(fs.readFileSync(skillStatePath(harness.config, run), 'utf8'))).driver, harness.advance);
          return failure;
        },
        report: async (runId, body, options) => {
          reports.push(z.object({ outcome: z.string() }).parse(body).outcome);
          return client.report(runId, body, options);
        },
      }),
      runners: (runners) => ({ ...runners, command: (input) => { commands.push(input.command); return runners.command(input); } }),
    });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'build', answers: { parallel: 1, confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    const events = await eventsToDone(harness, run);
    expect(commands).toEqual([]);
    expect(reports).toEqual(['released']);
    expect([...started.data.turn.events, ...events]).toContainEqual(expect.objectContaining({ kind: 'stopped', step: 'build' }));
    const stored = await readRun(harness.config, run);
    expect(typeof stored === 'object' && stored.steps.find((item) => item.id === 'build')).toMatchObject(step);
  });

  it('stops the setup a killed runner left running, as it stops a command one left', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-setup-group-'));
    roots.push(scratch);
    const pidFile = path.join(scratch, 'sleep.pid');
    let setup: Promise<unknown> | undefined;
    const harness = await skillHarness({ build: `schemaVersion: v1alpha1
name: build
description: Build in a set-up workspace
invoke: allow
setup:
  command: 'sleep 300 & echo $! > ${pidFile}; wait'
steps:
  - id: build
    workspace: new
    command: node -e "process.exit(0)"
` }, {
      // The runner is killed once setup started, and setup runs on in its own process group, which no sleep of the session waits for.
      client: (client) => ({ ...client, setup: async (run, attempt, mode) => {
        setup = inProcessClient({ config: harness.config, env: harness.context.env }).setup(run, attempt, mode);
        for (let wait = 0; wait < 100 && !fs.existsSync(pidFile); wait += 1) await new Promise((resolve) => { setTimeout(resolve, 50); });
        throw new Crash('killed during setup');
      } }),
    });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'build', answers: { parallel: 1, confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    const attempt = AttemptIdSchema.parse(started.data.turn.running[0]?.attempt);
    await harness.context.runners.sleep(1_000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = (): boolean => { try { return process.kill(pid, 0); } catch { return false; } };
    expect(alive()).toBe(true);

    const { runners } = await skillContext({ config: harness.config, toolPaths: harness.context.toolPaths, env: harness.context.env, cwd: harness.work, aiTools: [] });
    await runners.stopLeft(run, attempt);
    expect(alive()).toBe(false);
    expect(await setup).toMatchObject({ code: 'setup_failed' });
  });

  it('stops a setup that never ends once the run is cancelled, and never starts its command', async () => {
    const commands: string[] = [];
    const reports: string[] = [];
    let stopped = false;
    const harness = await skillHarness({ build: `schemaVersion: v1alpha1
name: build
description: Build in a set-up workspace
invoke: allow
setup:
  command: node -e "process.exit(0)"
steps:
  - id: build
    workspace: new
    command: node -e "process.exit(0)"
` }, {
      client: (client) => ({
        ...client,
        // A setup that never ends on its own, as one waiting on a service does: only its signal stops it.
        setup: (_run, _attempt, _mode, signal) => new Promise((resolve) => {
          signal?.addEventListener('abort', () => { stopped = true; resolve({ code: 'setup_failed', message: 'Setup was stopped.' }); }, { once: true });
        }),
        report: async (runId, body, options) => {
          reports.push(z.object({ outcome: z.string() }).parse(body).outcome);
          return client.report(runId, body, options);
        },
      }),
      runners: (runners) => ({ ...runners, command: (input) => { commands.push(input.command); return runners.command(input); } }),
    });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'build', answers: { parallel: 1, confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    await harness.context.runners.sleep(1_000);
    expect(stopped).toBe(false);

    await harness.context.client.cancel(run);
    await eventsToDone(harness, run);
    expect(stopped).toBe(true);
    expect(commands).toEqual([]);
    expect(reports).toEqual(['released']);
    const stored = await readRun(harness.config, run);
    expect(typeof stored === 'object' && stored.steps.find((item) => item.id === 'build')).toMatchObject({ status: 'cancelled' });
  });

  it('a scored step settles with judging open, and the poll returns judged', async () => {
    const harness = await skillHarness({ review: REVIEW }, { scorers: { 'review-quality': REVIEW_QUALITY } });
    roots.push(harness.root);
    fakeJudge(harness.root, 'thorough');
    const { run, turn: done } = await reviewed(harness);
    expect(done).toMatchObject({ data: { turn: {
      status: 'done',
      events: [{ kind: 'settled', step: 'review', outcome: 'success' }, { kind: 'judging', step: 'review', scorers: ['review-quality'], ref: expect.stringMatching(/^s[0-9a-f]+\/a[0-9a-f]{8}$/) }],
      actions: [{ kind: 'done', outcome: 'succeeded', prs: [], judging: { step: 'review', scorers: ['review-quality'] } }],
      // oxlint-disable-next-line unicorn/no-thenable
      then: { kind: 'poll', run: `teamai workflow next ${run} --driver skill --wait` },
    } } });

    const judged = await harness.call({ kind: 'next', run, wait: true });
    if (!('data' in judged) || !('turn' in judged.data)) throw new Error(JSON.stringify(judged));
    expect(judged.data.turn).toEqual({
      run, status: 'done', running: [],
      events: [{ kind: 'judged', step: 'review', scorer: 'review-quality', label: 'thorough' }],
      actions: [{ kind: 'done', outcome: 'succeeded', prs: [] }],
    });
  });

  it('an unattended run judges here as describe\'s start keeps judging on, and asks nothing while done carries judging', async () => {
    const harness = await skillHarness({ review: REVIEW }, { scorers: { 'review-quality': REVIEW_QUALITY } });
    roots.push(harness.root);
    fakeJudge(harness.root, 'thorough');
    expect(await harness.call({ kind: 'describe', name: 'review' }, { mode: 'unattended' })).toMatchObject({ data: { describe: {
      judging: { kind: 'here', tool: 'claude' }, ask: { kind: 'start', start: 'teamai workflow start review --driver skill --auto-approve' },
    } } });
    const { run, turn: done } = await reviewed(harness, 'unattended');
    expect(done).toMatchObject({ data: { turn: {
      status: 'done',
      actions: [{ kind: 'done', outcome: 'succeeded', judging: { step: 'review', scorers: ['review-quality'] } }],
      // oxlint-disable-next-line unicorn/no-thenable
      then: { kind: 'poll', run: `teamai workflow next ${run} --driver skill --wait` },
    } } });
    const judged = await harness.call({ kind: 'next', run, wait: true }, { mode: 'unattended' });
    expect(judged).toMatchObject({ data: { turn: { status: 'done', events: [{ kind: 'judged', step: 'review', label: 'thorough' }], actions: [{ kind: 'done', outcome: 'succeeded' }] } } });
    expect(judged).not.toHaveProperty(['data', 'turn', 'then']);
    for (const turn of [done, judged]) expect(JSON.stringify(turn)).not.toMatch(/"kind":"(choose|person)"/);
  });

  it('an unattended run its session judges reaches done without waiting, and done names the score --next that leases the pass to it', async () => {
    const harness = await skillHarness({ review: REVIEW }, { scorers: { 'review-quality': REVIEW_QUALITY } });
    roots.push(harness.root);
    unverifiedClaude(harness);
    expect(await harness.call({ kind: 'describe', name: 'review' }, { mode: 'unattended' })).toMatchObject({ data: { describe: {
      judging: { kind: 'session', tool: 'claude' }, ask: { kind: 'start' },
    } } });
    const { run, turn: done } = await reviewed(harness, 'unattended');
    expect(done).not.toHaveProperty(['data', 'turn', 'then']);
    const [action] = z.object({ data: z.object({ turn: z.object({ actions: z.array(z.object({ kind: z.literal('done'), outcome: z.string(), score: z.string() })) }) }) }).parse(done).data.turn.actions;
    expect(action).toMatchObject({ outcome: 'succeeded', score: expect.stringMatching(/^teamai score --next --json '\{.*\}'$/) });
    const payload: unknown = JSON.parse(action?.score.slice(action.score.indexOf("'") + 1, -1) ?? '');
    expect(payload).toEqual({ run, driver: { kind: 'skill', machine: expect.any(String), workspace: harness.work, can: { judge: { isolation: 'best-effort', access: 'read', tools: ['claude'] } } }, running: [] });
    expect(await harness.context.client.scoreNext(payload)).toMatchObject({ data: { lease: { subject: { runId: run, step: 'review' }, judge: { tool: 'claude', isolation: 'best-effort' } } } });
  });

  it('names a Pi session pi from PI_SESSION_ID, though teamai renders no agents for Pi, so describe judges its scored steps by the session', async () => {
    const harness = await skillHarness({ review: REVIEW }, { scorers: { 'review-quality': REVIEW_QUALITY } });
    roots.push(harness.root);
    vi.stubEnv('PI_SESSION_ID', 'pi-session-1');
    const { tool } = await skillContext({ config: harness.config, toolPaths: harness.context.toolPaths, env: harness.context.env, cwd: harness.work, aiTools: [] });
    expect(tool).toBe('pi');
    expect(await harness.call({ kind: 'describe', name: 'review' }, { tool })).toMatchObject({ data: { describe: { judging: { kind: 'session', tool: 'pi' } } } });
  });

  it('describe tells a session whose host names no tool how to name it, as nobody judges its run here until it does', async () => {
    const harness = await skillHarness({ review: REVIEW }, { scorers: { 'review-quality': REVIEW_QUALITY }, tool: null });
    roots.push(harness.root);
    expect(await harness.call({ kind: 'describe', name: 'review' })).toMatchObject({ data: { describe: {
      judging: { kind: 'elsewhere', reason: 'This coding session names no tool.' },
      ask: { kind: 'tool', describe: "teamai workflow start --describe review --driver skill --tools default='{tool}'" },
    } } });
  });

  it('describe tells a session whose host names no tool to name it, when the workflow has prompt steps and nothing scored', async () => {
    const harness = await skillHarness({ review: REVIEW.replace('    scorers: [review-quality]', '    model: claude-opus-4-1') }, { tool: null });
    roots.push(harness.root);
    expect(await harness.call({ kind: 'describe', name: 'review' })).toMatchObject({ data: { describe: { judging: { kind: 'none' }, ask: {
      kind: 'tool', describe: "teamai workflow start --describe review --driver skill --tools default='{tool}'",
    } } } });
  });

  it('gives a session whose host names no tool a resume of a run it does not drive with a {tool} slot to fill', async () => {
    const harness = await skillHarness({ check: CHECK }, { tool: null });
    roots.push(harness.root);
    const other = await harness.context.client.start('check', { checkout: harness.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
    if (!('data' in other) || typeof other.data.run !== 'string') throw new Error(JSON.stringify(other));
    const run = RunIdSchema.parse(other.data.run);
    expect(await harness.call({ kind: 'next', run, wait: false })).toMatchObject({ error: { code: 'not_skill_run', next: `teamai workflow resume ${run} --driver skill --tools default='{tool}'` } });
  });

  it('refuses a start that needs a tool this session does not name, pointing at the describe that asks for it', async () => {
    const harness = await skillHarness({ review: REVIEW, check: CHECK }, { scorers: { 'review-quality': REVIEW_QUALITY }, tool: null });
    roots.push(harness.root);
    expect(await harness.call({ kind: 'start', name: 'review', answers: { confirmed: false }, inputs: undefined })).toEqual({ error: {
      code: 'confirm_needed',
      message: 'Start review from its describe reply: it needs --tools default=<tool>, the tool this coding session works in. Run the describe literal.',
      next: 'teamai workflow start --describe review --driver skill',
    } });
    // A run of commands alone needs no tool, and neither does a scored step that pins no model, once judging is off.
    expect(await harness.call({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined })).toMatchObject({ data: { turn: { status: 'driving' } } });
    expect(await harness.call({ kind: 'start', name: 'review', answers: { confirmed: false, judge: false }, inputs: undefined })).toMatchObject({ data: { turn: { status: 'driving' } } });
  });

  it('a step that needs a model fails once a session whose host names no tool takes the run over, and says how to name it', async () => {
    const harness = await skillHarness({ review: REVIEW.replace('    prompt: Review the change.', '    prompt: Review the change.\n    model: claude-opus-4-1') }, { tool: null });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'review', answers: { confirmed: false }, inputs: undefined, tool: 'claude' });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    expect(await harness.call({ kind: 'takeover', run, confirmed: false }, { session: undefined })).toMatchObject({ data: { turn: { run } } });
    expect(await harness.call({ kind: 'choose', run, choice: 'h1' }, { session: undefined })).toMatchObject({ data: { turn: { events: expect.arrayContaining([{
      kind: 'settled', step: 'review', outcome: 'failed', failure: { code: 'model_unavailable', message: 'Step "review" needs model claude-opus-4-1, and this coding session names no tool to resolve it for: start or resume the workflow with --tools default=<tool>, the tool it works in.' },
    }]) } } });
  });

  it('a resume that names the tool gives it back to a run a session with no tool took over, and its steps then resolve their model for it', async () => {
    const harness = await skillHarness({ review: REVIEW.replace('    prompt: Review the change.', '    prompt: Review the change.\n    model: claude-opus-4-1') }, { tool: null });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'review', answers: { confirmed: false }, inputs: undefined, tool: 'claude' });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    expect(await harness.call({ kind: 'takeover', run, confirmed: false }, { session: undefined })).toMatchObject({ data: { turn: { run } } });
    expect(await harness.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {}, tool: 'claude' }, { session: undefined })).toMatchObject({ data: { turn: { run } } });
    expect(await harness.call({ kind: 'choose', run, choice: 'h1' }, { session: undefined })).toMatchObject({ data: { turn: { actions: [{ kind: 'dispatch', model: { by: 'step', name: 'claude-opus-4-1' } }] } } });
  });

  it('a session that comes to own a run its starter left unowned works in its own tool, which the steps it prepares resolve their model for', async () => {
    const harness = await skillHarness({ review: REVIEW.replace('    prompt: Review the change.', '    prompt: Review the change.\n    model: claude-opus-4-1') }, { tool: null });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'review', answers: { confirmed: false }, inputs: undefined, tool: 'pi' }, { session: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    expect(await harness.call({ kind: 'choose', run, choice: 'h1' }, { session: 'session-b', tool: 'claude' }))
      .toMatchObject({ data: { turn: { actions: [{ kind: 'dispatch', model: { by: 'step', name: 'claude-opus-4-1' } }] } } });
  });

  it('a resume that names a tool replaces the one the run had, so a session that moved to another tool works in its own', async () => {
    const harness = await skillHarness({ review: REVIEW.replace('    prompt: Review the change.', '    prompt: Review the change.\n    model: claude-opus-4-1') }, { tool: null });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'review', answers: { confirmed: false }, inputs: undefined, tool: 'pi' }, { session: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    expect(await harness.call({ kind: 'resume', run, claim: false, confirmed: false, answers: {}, tool: 'claude' }, { session: undefined })).toMatchObject({ data: { turn: { run } } });
    expect(await harness.call({ kind: 'choose', run, choice: 'h1' }, { session: undefined }))
      .toMatchObject({ data: { turn: { actions: [{ kind: 'dispatch', model: { by: 'step', name: 'claude-opus-4-1' } }] } } });
  });

  it('a takeover hands the run to the new session\'s tool, which the steps it prepares resolve their model for', async () => {
    const harness = await skillHarness({ review: REVIEW.replace('    prompt: Review the change.', '    prompt: Review the change.\n    model: claude-opus-4-1') });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'review', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    expect(await harness.call({ kind: 'takeover', run, confirmed: false }, { session: 'session-b', tool: 'pi' })).toMatchObject({ data: { turn: { events: [{ kind: 'takeover', from: 'session-a' }] } } });
    expect(await harness.call({ kind: 'choose', run, choice: 'h1' }, { session: 'session-b', tool: 'pi' })).toMatchObject({ data: { turn: { events: expect.arrayContaining([{
      kind: 'settled', step: 'review', outcome: 'failed', failure: { code: 'model_unavailable', message: 'Step "review" needs model claude-opus-4-1, and teamai resolves no model for pi, the coding session\'s tool.' },
    }]) } } });
  });

  it('keeps a declared tool in every start command describe offers, and in the describe command a refused start prints', async () => {
    const harness = await skillHarness({ review: REVIEW.replace('invoke: allow', 'invoke: ask'), check: CHECK }, { scorers: { 'review-quality': REVIEW_QUALITY }, tool: null });
    roots.push(harness.root);
    unverifiedClaude(harness);
    expect(await harness.call({ kind: 'describe', name: 'check', tool: 'claude' }, { mode: 'unattended' }))
      .toMatchObject({ data: { describe: { ask: { kind: 'start', start: 'teamai workflow start check --driver skill --tools default=claude --auto-approve' } } } });
    expect(await harness.call({ kind: 'describe', name: 'check', tool: 'claude' })).toMatchObject({ data: { describe: { ask: { kind: 'start', start: 'teamai workflow start check --driver skill --tools default=claude' } } } });
    const starts = JSON.stringify(await harness.call({ kind: 'describe', name: 'review', tool: 'claude' })).match(/teamai workflow start review --driver skill[^"]*/g) ?? [];
    expect(starts).not.toHaveLength(0);
    for (const start of starts) expect(start).toMatch(/^teamai workflow start review --driver skill --tools default=claude /);
    expect(await harness.call({ kind: 'start', name: 'review', answers: { confirmed: false }, inputs: undefined, tool: 'claude' }))
      .toMatchObject({ error: { code: 'confirm_needed', next: 'teamai workflow start --describe review --driver skill --tools default=claude' } });
  });

  it('a session whose host names no tool names it with --tools: its runner resolves the step\'s model for that tool, and done leases the judging to it', async () => {
    const harness = await skillHarness({ review: REVIEW.replace('    prompt: Review the change.', '    prompt: Review the change.\n    model: claude-opus-4-1') }, { scorers: { 'review-quality': REVIEW_QUALITY }, tool: null });
    roots.push(harness.root);
    unverifiedClaude(harness);
    const { chosen, turn: done } = await reviewed(harness, 'attended', { tool: 'claude' });
    expect(chosen).toMatchObject({ data: { turn: { actions: [{ kind: 'dispatch', model: { by: 'step', name: 'claude-opus-4-1' } }] } } });
    expect(done).toMatchObject({ data: { turn: { status: 'done', actions: [{ kind: 'done', outcome: 'succeeded', score: expect.stringContaining('"tools":["claude"]') }] } } });
  });

  it('a session that takes a run over judges it with its own tool', async () => {
    const harness = await skillHarness({ review: REVIEW }, { scorers: { 'review-quality': REVIEW_QUALITY } });
    roots.push(harness.root);
    unverifiedClaude(harness);
    const { run } = await reviewed(harness);
    expect(await harness.call({ kind: 'takeover', run, confirmed: false }, { session: 'session-b', tool: 'pi' }))
      .toMatchObject({ data: { turn: { status: 'done', actions: [{ kind: 'done', score: expect.stringContaining('"tools":["pi"]') }] } } });
  });

  it('a session whose host has no child agent does not judge its run: choosing h4 turns judging off, and done names no score --next', async () => {
    const harness = await skillHarness({ review: REVIEW }, { scorers: { 'review-quality': REVIEW_QUALITY } });
    roots.push(harness.root);
    unverifiedClaude(harness);
    const { chosen, turn: done } = await reviewed(harness, 'attended', { host: 'h4' });
    expect(chosen).toMatchObject({ data: { turn: { events: expect.arrayContaining([{ kind: 'judging-off', failure: { code: 'no_child_agent', message: expect.any(String) } }]) } } });
    expect(done).toMatchObject({ data: { turn: { status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] } } });
    expect(done).not.toHaveProperty(['data', 'turn', 'actions', 0, 'score']);
  });

  it('a run of commands alone that its session judges asks the host question for its judging alone: h4 turns judging off, and its steps still run in a new worktree', async () => {
    const build = 'schemaVersion: v1alpha1\nname: build\ndescription: Build\ninvoke: allow\nsteps:\n  - id: edit\n    workspace: new\n    command: node -e "require(\'fs\').writeFileSync(\'built.txt\', \'1\')"\n';
    const gated = 'schemaVersion: v1alpha1\nname: gated\ndescription: Build, scored\ninvoke: allow\nsteps:\n  - id: built\n    workflow: build\n    scorers: [review-quality]\n';
    const harness = await skillHarness({ build, gated }, { scorers: { 'review-quality': REVIEW_QUALITY }, tool: 'pi' });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'gated', answers: { confirmed: false }, inputs: undefined });
    expect(started).toMatchObject({ data: { turn: { actions: [{ kind: 'choose', about: 'host' }] } } });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    expect(await harness.call({ kind: 'choose', run, choice: 'h4' })).toMatchObject({ data: { turn: { events: expect.arrayContaining([{ kind: 'judging-off', failure: { code: 'no_child_agent', message: expect.any(String) } }]) } } });
    await eventsToDone(harness, run);
  });

  it('a run started without judging reaches done without the score --next of the session\'s own judge', async () => {
    const harness = await skillHarness({ review: REVIEW }, { scorers: { 'review-quality': REVIEW_QUALITY } });
    roots.push(harness.root);
    unverifiedClaude(harness);
    const { turn: done } = await reviewed(harness, 'attended', { judge: false });
    expect(done).toMatchObject({ data: { turn: { status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] } } });
    expect(done).not.toHaveProperty(['data', 'turn', 'actions', 0, 'score']);
  });

  it('a skill run judges only its own passes: never a finished session, never another run\'s pass', async () => {
    const leases: unknown[] = [];
    const harness = await skillHarness({ review: REVIEW }, {
      scorers: { 'review-quality': REVIEW_QUALITY, 'session-quality': SESSION_QUALITY }, scoring: { sessions: true },
      client: (client) => ({ ...client, scoreNext: async (body) => {
        const answer = await client.scoreNext(body);
        if ('data' in answer && answer.data.lease !== undefined) leases.push(answer.data.lease);
        return answer;
      } }),
    });
    roots.push(harness.root);
    fakeJudge(harness.root, 'thorough');
    idleSession(harness);
    // An older run whose pass another driver settled: it is open for judging, and a driver of any run would take it first.
    const external = { kind: 'external', machine: 'm2', workspace: '/w' };
    const engine = inProcessClient({ config: harness.config, env: harness.context.env });
    const started = await engine.start('review', { caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
    const other = 'data' in started ? String(started.data.run) : '';
    const next = await engine.next(other, { driver: external });
    const work = z.object({ attempt: z.string(), revision: z.number() }).parse('data' in next ? next.data.lease : undefined);
    expect(await engine.report(other, { ...work, driver: external, outcome: 'success', outputs: 'Reviewed.' })).toMatchObject({ data: {} });

    const { run } = await reviewed(harness);
    expect(await harness.call({ kind: 'next', run, wait: true })).toMatchObject({ data: { turn: { events: [{ kind: 'judged', step: 'review' }] } } });
    // A tick after its own pass is judged: a driver that took any judge work would take the other run's pass now.
    await harness.call({ kind: 'next', run, wait: false });

    expect(leases).toEqual([expect.objectContaining({ source: 'workflow', subject: { runId: run, step: 'review', pass: 1 } })]);
    const judge = { isolation: 'verified', tools: ['claude'] } satisfies JudgeRequest['judge'];
    const now = new Date().toISOString();
    expect(await takeJudgeLease(harness.config, { driver: external, judge, running: [], run: other }, now)).toMatchObject({ kind: 'lease', lease: { subject: { runId: other } } });
    expect(await takeJudgeLease(harness.config, { driver: external, judge, running: [], only: 'session' }, now)).toMatchObject({ kind: 'lease', lease: { source: 'session' } });
  });

  it('declares what its session tool\'s judge can do, so the judge lease and the label record that it only reads', async () => {
    const leases: unknown[] = [];
    const harness = await skillHarness({ review: REVIEW }, {
      scorers: { 'review-quality': REVIEW_QUALITY },
      client: (client) => ({ ...client, scoreNext: async (body) => {
        const answer = await client.scoreNext(body);
        if ('data' in answer && answer.data.lease !== undefined) leases.push(answer.data.lease);
        return answer;
      } }),
    });
    roots.push(harness.root);
    fakeJudge(harness.root, 'thorough');
    const { run } = await reviewed(harness);
    expect(await harness.call({ kind: 'next', run, wait: true })).toMatchObject({ data: { turn: { events: [{ kind: 'judged', step: 'review' }] } } });

    expect(leases).toEqual([expect.objectContaining({ judge: expect.objectContaining({ tool: 'claude', access: 'read' }) })]);
    expect(await LabelStore.local(harness.config)).toEqual([expect.objectContaining({ judge: expect.objectContaining({ tool: 'claude', access: 'read' }) })]);
  });

  it('a deliver: pr step shows waiting delivering, and the poll returns done with the PR', async () => {
    const harness = await skillHarness({ implement: IMPLEMENT });
    roots.push(harness.root);
    githubOrigin(harness);
    const started = await harness.call({ kind: 'start', name: 'implement', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const { run } = started.data.turn;
    const delivering = { reason: 'implement is delivering', delivering: ['implement'] };

    // Another process of this machine delivers the step, so this driver's next leaves the delivery to it.
    const held = deliveryLockPath(harness.config, run);
    expect(await acquireLock(held)).toBe(true);
    try {
      const settled = await harness.call({ kind: 'next', run, wait: true });
      expect(settled).toMatchObject({ data: { turn: {
        status: 'driving', actions: [], running: [], waiting: delivering,
        events: [{ kind: 'settled', step: 'implement', outcome: 'success', exitCode: 0 }],
        // oxlint-disable-next-line unicorn/no-thenable
        then: { kind: 'poll', run: `teamai workflow next ${run} --driver skill --wait` },
      } } });
      expect(await harness.call({ kind: 'next', run, wait: false })).toMatchObject({ data: { turn: { status: 'driving', actions: [], waiting: delivering } } });
    } finally {
      await releaseLock(held);
    }

    const done = await harness.call({ kind: 'next', run, wait: true });
    expect(done).toEqual({ data: { turn: {
      run, status: 'done', running: [], events: [],
      actions: [{ kind: 'done', outcome: 'succeeded', prs: ['https://github.com/fixture/app/pull/1'] }],
    } } });
  });

  it('hands a run whose only step left is held for this driver to the person, with the resume literal, and ends the loop', async () => {
    vi.stubEnv('SLACK_TOKEN', 'slack-value-1304');
    const harness = await skillHarness({ publish: PUBLISH });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'publish', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const { run } = started.data.turn;
    await harness.call({ kind: 'choose', run, choice: 'h1' });

    let woke = false;
    for (let poll = 0; poll < 5 && !woke; poll += 1) {
      const polled = await harness.call({ kind: 'next', run, wait: true });
      if (!('data' in polled) || !('turn' in polled.data)) throw new Error(JSON.stringify(polled));
      woke = polled.data.turn.then?.kind === 'wake';
    }
    expect(woke).toBe(true);

    const handoff = await harness.call({ kind: 'next', run, wait: false });
    const held = [{ step: 'notify', missing: ['env'] }];
    const reason = 'step "notify" needs env, which this driver does not declare';
    expect(handoff).toEqual({ data: { turn: {
      run, status: 'driving', running: [], events: expect.arrayContaining([{ kind: 'settled', step: 'build', outcome: 'success', exitCode: 0 }]),
      actions: [{
        kind: 'person', why: 'handoff', held,
        message: `Run ${run} waits on steps this coding session cannot run: ${reason}. Nothing else of the run is open.`,
        say: `This session can take the run no further. To continue it with the local driver, run this command in your own terminal, from ${harness.work}.`,
        run: [`teamai workflow resume ${run} --tools default=claude`],
      }],
      waiting: { reason, held },
    } } });
  });

  it('points at the skill resume and the person\'s resume for a run it does not drive, and at the person\'s for one whose state it cannot read', async () => {
    const harness = await skillHarness({ check: CHECK });
    roots.push(harness.root);
    const other = await harness.context.client.start('check', { checkout: harness.work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
    if (!('data' in other) || typeof other.data.run !== 'string') throw new Error(JSON.stringify(other));
    const run = RunIdSchema.parse(other.data.run);
    expect(await harness.call({ kind: 'next', run, wait: false })).toEqual({ error: {
      code: 'not_skill_run',
      message: `Run ${run} is not driven by the skill driver on this machine. Ask the person whether to continue it from this session, and run the command in next only when they agree: it takes the run over from the machine that last drove it. The person can instead continue it in a terminal with teamai workflow resume ${run} --tools default=claude.`,
      next: `teamai workflow resume ${run} --driver skill`,
    } });

    fs.writeFileSync(skillStatePath(harness.config, run), '{');
    expect(await harness.call({ kind: 'next', run, wait: false })).toEqual({ error: {
      code: 'run_unreadable',
      message: expect.stringMatching(new RegExp(`^The skill driver's state of run ${run} cannot be read \\(.+\\)\\. The person can continue the run in a terminal with teamai workflow resume ${run} --tools default=claude\\.$`)),
      next: null,
    } });
  });
});

describe('detached runners', () => {
  it('refuse to start a runner in a checkout that is gone, saying what to do', async () => {
    const harness = await skillHarness({ check: CHECK });
    roots.push(harness.root);
    const checkout = path.join(harness.root, 'removed');
    const run = RunIdSchema.parse('r0123456789abcdef');
    const { runners } = await skillContext({ config: harness.config, toolPaths: harness.context.toolPaths, env: harness.context.env, cwd: harness.work, aiTools: [] });
    const spawned = runners.spawn({ run, attempt: AttemptIdSchema.parse('a00000000'), checkout, mode: 'attended' });
    await expect(spawned).rejects.toThrow(`The runner of attempt a00000000 cannot start in ${checkout}, the checkout run ${run} started from: it does not exist. Restore that checkout at that path, then run the same call again, or end the run with teamai workflow cancel ${run}.`);
  });
});
