import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillHarness } from './helpers/skill-harness.js';

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

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('skill driver', () => {
  it('drives a command-only workflow from start to done with one poll', async () => {
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
      run, status: 'done', running: [],
      actions: [{ kind: 'done', outcome: 'succeeded', prs: [] }],
      events: [
        { kind: 'settled', step: 'lint', outcome: 'success', exitCode: 0 },
        { kind: 'started', step: 'test', attempt: expect.stringMatching(/^a[0-9a-f]{8}$/) },
        { kind: 'settled', step: 'test', outcome: 'success', exitCode: 0, tail: 'Tests 42 passed (42)' },
      ],
    } } });

    // Every command the session ran came whole from a reply: no slot or placeholder was left for it to fill.
    expect(JSON.stringify([described, started, polled])).not.toMatch(/\{inputs\}|\{dir\}|<[a-z]+>/);
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

    const done = await harness.call({ kind: 'next', run, wait: true });
    if (!('data' in done) || !('turn' in done.data)) throw new Error(JSON.stringify(done));
    expect(done.data.turn.events.filter((event) => event.kind === 'settled' && event.step === 'lint')).toHaveLength(1);
    expect(done.data.turn.actions).toEqual([{ kind: 'done', outcome: 'succeeded', prs: [] }]);
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
});
