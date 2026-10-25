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
});
