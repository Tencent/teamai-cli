import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import type { DriverIdentity } from '../workflow/types.js';
import { knownSecrets } from '../env-resolution.js';

// Settling reads a step instance's scope from its path, so the number of paths parsed counts settle work without a clock.
const counter = vi.hoisted(() => ({ parsed: 0, read: 0, status: 0 }));
vi.mock('../workflow/step-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflow/step-path.js')>();
  return {
    ...actual,
    parseStepPath: (value: string) => {
      counter.parsed += 1;
      return actual.parseStepPath(value);
    },
  };
});

// Every scan over a run's step instances reads each one's path, so the number of `id` reads counts how many it looks at.
// Counting the instances started against `max_parallel` reads only their `status`, which `status` reads count.
// The engine reads a run it changes inside updateRun, so the steps are counted there as well as on a plain read.
vi.mock('../workflow/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflow/store.js')>();
  const counted = <T extends Awaited<ReturnType<typeof actual.readRun>>>(run: T): T => {
    if (typeof run === 'string') return run;
    run.steps = run.steps.map((state) => new Proxy(state, {
      get: (target, key, receiver) => {
        if (key === 'id') counter.read += 1;
        if (key === 'status') counter.status += 1;
        return Reflect.get(target, key, receiver);
      },
    }));
    return run;
  };
  return {
    ...actual,
    readRun: async (...args: Parameters<typeof actual.readRun>) => counted(await actual.readRun(...args)),
    updateRun: (...[config, runId, secrets, change]: Parameters<typeof actual.updateRun>) => actual.updateRun(config, runId, secrets, async (run) => change(counted(run))),
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const driver: DriverIdentity = { kind: 'local', machine: 'a', workspace: '/work' };

const FAN = `schemaVersion: v1alpha1
name: fan
description: An uncapped for_each over an inline workflow.
inputs:
  xs: [number]
steps:
  - id: build
    for_each: inputs.xs
    workflow:
      steps:
        - id: compile
          command: node compile.js
        - id: test
          needs: [compile]
          command: node test.js
  - id: after
    needs: [build]
    command: node after.js
`;

/** The fan workflow with a workflow inside each item's workflow, so starting an item adds instances twice. */
const NESTED_FAN = `schemaVersion: v1alpha1
name: fan
description: An uncapped for_each over an inline workflow that runs another.
inputs:
  xs: [number]
steps:
  - id: build
    for_each: inputs.xs
    workflow:
      steps:
        - id: inner
          workflow:
            steps:
              - id: compile
                command: node compile.js
        - id: test
          needs: [inner]
          command: node test.js
  - id: after
    needs: [build]
    command: node after.js
`;

/** An uncapped for_each whose items each run after the one before them. */
const CHAIN = `schemaVersion: v1alpha1
name: fan
description: An uncapped for_each over a chain of items.
inputs:
  xs: [{ id: string }]
steps:
  - id: build
    for_each: inputs.xs
    command: node build.js
`;

/** A for_each that runs at most two items at a time. */
const CAPPED = `schemaVersion: v1alpha1
name: fan
description: A capped for_each.
inputs:
  xs: [number]
steps:
  - id: build
    for_each: { items: inputs.xs, max_parallel: 2 }
    command: node build.js
`;

/** A run of a fan workflow over `items` items that no `next` has advanced yet. */
async function startFan(items: number, body = FAN, item = (index: number): unknown => index): Promise<{ config: LocalConfig; run: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-settle-cost-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'workflows', 'fan.yaml'), body);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project',
    additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'), usageReportEnabled: false,
  };
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, 'fan', { xs: Array.from({ length: items }, (_, index) => item(index)) }, { secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  return { config, run: String(started.data.run) };
}

/** The paths parsed by the first `next` of a run over `items` items, which starts every item and leases `first`. */
async function firstNextWork(items: number, body: string, first: string): Promise<number> {
  const { config, run } = await startFan(items, body);
  counter.parsed = 0;
  const next = await leaseNext(config, run, driver);
  expect(next).toMatchObject({ data: { lease: { step: first } } });
  return counter.parsed;
}

/** The step instances looked at per `next` and `report` while one driver runs every step of a run over `items` items. */
async function wholeRunWork(items: number): Promise<number> {
  const { config, run } = await startFan(items);
  counter.read = 0;
  let calls = 0;
  for (;;) {
    const next = await leaseNext(config, run, driver);
    calls += 1;
    const lease = 'data' in next ? next.data.lease as { attempt: string; revision: number } | undefined : undefined;
    if (!lease) {
      expect(next).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      break;
    }
    const report = await reportAttempt(config, run, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver });
    expect(report).toMatchObject({ data: { accepted: true } });
    calls += 1;
  }
  // A lease and a report for each item's two steps and for `after`, then the `next` that answers done.
  expect(calls).toBe(2 * (2 * items + 1) + 1);
  return counter.read / calls;
}

/**
 * The step instances looked at by the `next` that skips a chain of `items` items behind the failed item at its head.
 * Forward, each item runs after the one before it; in reverse, after the one after it.
 */
async function skippedChainWork(items: number, order: 'forward' | 'reverse'): Promise<number> {
  const head = order === 'forward' ? 0 : items - 1;
  const { config, run } = await startFan(items, CHAIN, (index) => (index === head
    ? { id: `i${index}` }
    : { id: `i${index}`, after: [`i${order === 'forward' ? index - 1 : index + 1}`] }));
  const first = await leaseNext(config, run, driver);
  const lease = 'data' in first ? first.data.lease as { step: string; attempt: string; revision: number } : undefined;
  expect(lease?.step).toBe(`build[${head}]`);
  await reportAttempt(config, run, { attempt: lease!.attempt, revision: lease!.revision, outcome: 'failed', driver });
  counter.read = 0;
  expect(await leaseNext(config, run, driver)).toMatchObject({ data: { done: { outcome: 'failed' } } });
  return counter.read;
}

/** The step instance statuses read by a `next` of a capped for_each over `items` items while both its leases run. */
async function cappedWork(items: number): Promise<number> {
  const { config, run } = await startFan(items, CAPPED);
  const running: string[] = [];
  for (const step of ['build[0]', 'build[1]']) {
    const next = await leaseNext(config, run, driver, { running });
    const lease = 'data' in next ? next.data.lease as { step: string; attempt: string } : undefined;
    expect(lease?.step).toBe(step);
    running.push(lease!.attempt);
  }
  counter.status = 0;
  expect(await leaseNext(config, run, driver, { running })).toMatchObject({ data: { wait: { reason: 'build[0] is leased' } } });
  return counter.status;
}

describe('settle cost', () => {
  it.each([
    ['an inline workflow', FAN, 'build[0].compile'],
    ['an inline workflow that runs another', NESTED_FAN, 'build[0].inner.compile'],
  ])('starts every item of an uncapped for_each over %s with work linear in the item count', async (_case, body, first) => {
    const small = await firstNextWork(100, body, first);
    const large = await firstNextWork(200, body, first);
    expect(small).toBeGreaterThan(100);
    // Linear work doubles with the items; quadratic work grows about four times.
    expect(large / small).toBeLessThan(3);
  });

  // The quadratic form runs several times longer, so this test has its own timeout and fails on its ratio, not on time.
  it('runs an uncapped for_each to the end with work per call linear in the item count', async () => {
    const small = await wholeRunWork(100);
    const large = await wholeRunWork(200);
    expect(small).toBeGreaterThan(100);
    // Each call settles every running item; a scan of all instances per item makes that quadratic.
    expect(large / small).toBeLessThan(3);
  }, 60_000);

  it.each(['forward', 'reverse'] as const)('skips a %s chain of items behind a failed item with work linear in the item count', async (order) => {
    const small = await skippedChainWork(100, order);
    const large = await skippedChainWork(200, order);
    expect(small).toBeGreaterThan(100);
    // Each skip makes the next item skippable; scanning every item again after each skip makes that quadratic.
    expect(large / small).toBeLessThan(3);
  });

  it('waits on a full max_parallel with work linear in the item count', async () => {
    const small = await cappedWork(100);
    const large = await cappedWork(200);
    expect(small).toBeGreaterThan(100);
    // Counting the started items again for each waiting item makes that quadratic.
    expect(large / small).toBeLessThan(3);
  });
});
