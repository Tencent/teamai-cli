import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { skillHarness, untilStopped } from './helpers/skill-harness.js';

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

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
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

  it('offers two parallel new prompt steps with acks, keeps an unacked one offered, and a poll answers wake', async () => {
    const harness = await skillHarness({ feature: FEATURE });
    roots.push(harness.root);

    const started = await harness.call({ kind: 'start', name: 'feature', answers: { parallel: 2, confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const { run } = started.data.turn;
    const host = started.data.turn.actions.find((action) => action.kind === 'choose');
    if (host?.kind !== 'choose') throw new Error(JSON.stringify(started));
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

    const taken = await harness.call({ kind: 'takeover', run }, { session: 'session-b' });
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
});
