import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { readRun } from '../workflow/store.js';
import type { DriverIdentity } from '../workflow/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function testConfig(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-reconciliation-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  return {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project',
    additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'),
  };
}

const driver: DriverIdentity = { kind: 'local', machine: 'a', workspace: '/work' };
const LeaseSchema = z.object({ step: z.string(), attempt: z.string(), revision: z.number() });

function random(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const scenarios: Record<string, { files: Record<string, string>; name: string; outputs: (step: string, r: () => number) => unknown }> = {
  nested: {
    name: 'top',
    files: { top: `schemaVersion: v1alpha1
name: top
description: d
ends: { fast: succeeded, slow: failed }
steps:
  - id: plan
    command: echo plan
  - id: inner
    needs: [plan]
    workflow:
      ends: { stop: succeeded, bad: failed }
      outputs: { r: steps.review.outcome, f: steps.fix.outcome }
      steps:
        - id: review
          command: echo review
        - id: fix
          needs: [review]
          command: echo fix
          loop: { back_to: review, max_iterations: 3 }
        - id: guard
          needs: []
          command: echo guard
          end: stop
        - id: bad
          needs: [fix]
          if: steps.fix.outcome == 'failed'
          end: bad
  - id: fast
    needs: []
    command: echo fast
    end: fast
  - id: rec
    needs: [inner]
    if: steps.inner.outcome == 'failed'
    end: slow
  - id: after
    needs: [inner]
    command: echo after
` },
    outputs: () => undefined,
  },
  fan: {
    name: 'fan',
    files: {
      item: `schemaVersion: v1alpha1
name: item
description: d
inputs: { n: number }
ends: { early: succeeded }
steps:
  - id: a
    command: echo a
  - id: e
    needs: [a]
    if: inputs.n > 1
    end: early
  - id: b
    needs: [a]
    command: echo b
`,
      fan: `schemaVersion: v1alpha1
name: fan
description: d
ends: { won: succeeded, broke: failed }
steps:
  - id: plan
    command: echo plan
    output: { items: [number] }
  - id: build
    needs: [plan]
    for_each: { items: steps.plan.outputs.items, max_parallel: 2 }
    workflow: item
    with: { n: "{{ item }}" }
  - id: stop
    needs: [build]
    if: steps.build.outcome == 'failed'
    end: broke
  - id: fast
    needs: []
    command: echo fast
    end: won
  - id: after
    needs: [build]
    command: echo after
`,
    },
    outputs: (step, r) => (step === 'plan' ? { items: Array.from({ length: 1 + Math.floor(r() * 4) }, () => Math.floor(r() * 3)) } : undefined),
  },
  fanafter: {
    name: 'fa',
    files: { fa: `schemaVersion: v1alpha1
name: fa
description: d
ends: { won: succeeded, broke: failed }
steps:
  - id: plan
    command: echo plan
  - id: build
    needs: [plan]
    for_each: { items: steps.plan.outputs.items, max_parallel: 2 }
    command: echo build
  - id: stop
    needs: [build]
    if: steps.build.outcome == 'failed'
    end: broke
  - id: fast
    needs: []
    command: echo fast
    end: won
` },
    outputs: (step, r) => (step === 'plan' ? { items: r() < 0.15 ? 'bad' : [{ id: 'a' }, { id: 'b', after: ['a'] }, { id: 'c' }, { id: 'd', after: ['c', 'b'] }] } : undefined),
  },
  rounds: {
    name: 'rounds',
    files: { rounds: `schemaVersion: v1alpha1
name: rounds
description: d
ends: { out: failed }
steps:
  - id: w
    workflow:
      loop: { max_iterations: 3 }
      ends: { red: failed }
      steps:
        - id: check
          command: echo check
          break: steps.check.outcome == 'success' && steps.check.outputs.ok == true
        - id: red
          needs: [check]
          if: steps.check.outcome == 'failed'
          end: red
        - id: side
          needs: []
          command: echo side
  - id: fast
    needs: []
    command: echo fast
    end: out
  - id: last
    needs: [w]
    command: echo last
` },
    outputs: (step, r) => (step.endsWith('check') ? { ok: r() < 0.3 } : undefined),
  },
  loopwhile: {
    name: 'lw',
    files: { lw: `schemaVersion: v1alpha1
name: lw
description: d
ends: { done: succeeded, stuck: failed, quick: succeeded }
steps:
  - id: implement
    command: echo i
  - id: e2e
    needs: [implement]
    command: echo e2e
  - id: fix
    needs: [e2e]
    if: steps.e2e.outcome == 'failed'
    command: echo fix
    loop: { back_to: e2e, max_iterations: 2 }
  - id: done
    needs: [e2e]
    if: steps.e2e.outcome == 'success'
    end: done
  - id: give-up
    needs: [fix]
    if: steps.fix.outcome == 'failed'
    end: stuck
  - id: quick
    needs: []
    command: echo q
    end: quick
  - id: tail
    needs: [fix]
    command: echo tail
` },
    outputs: () => undefined,
  },
  itemloop: {
    name: 'il',
    files: {
      fixer: `schemaVersion: v1alpha1
name: fixer
description: d
inputs: { n: number }
ends: { gaveup: failed }
steps:
  - id: review
    command: echo review
  - id: fix
    needs: [review]
    if: steps.review.outcome == 'success'
    command: echo fix
    loop: { back_to: review, max_iterations: 2 }
  - id: give
    needs: [fix]
    if: steps.fix.outcome == 'failed'
    end: gaveup
`,
      il: `schemaVersion: v1alpha1
name: il
description: d
ends: { won: succeeded, broke: failed }
steps:
  - id: plan
    command: echo plan
  - id: build
    needs: [plan]
    for_each: { items: steps.plan.outputs.items, max_parallel: 1 }
    workflow: fixer
    with: { n: "{{ item }}" }
  - id: retry
    needs: [build]
    if: steps.build.outcome == 'failed'
    for_each: "filter(steps.build.results, .outcome == 'failed')"
    command: echo retry
  - id: stop
    needs: [retry]
    if: steps.retry.outcome == 'failed'
    end: broke
  - id: fast
    needs: []
    command: echo fast
    end: won
`,
    },
    outputs: (step, r) => (step === 'plan' ? { items: Array.from({ length: 1 + Math.floor(r() * 3) }, () => Math.floor(r() * 3)) } : undefined),
  },
  deep: {
    name: 'deep',
    files: { deep: `schemaVersion: v1alpha1
name: deep
description: d
ends: { top: failed }
steps:
  - id: a
    command: echo a
  - id: outer
    needs: []
    workflow:
      ends: { mid: succeeded }
      steps:
        - id: m
          command: echo m
        - id: inner
          needs: []
          workflow:
            ends: { low: failed }
            steps:
              - id: x
                command: echo x
              - id: y
                needs: []
                command: echo y
              - id: lowend
                needs: [x, y]
                if: steps.x.outcome == 'failed' || steps.y.outcome == 'skipped'
                end: low
              - id: z
                needs: [x]
                command: echo z
        - id: midend
          needs: [m]
          if: steps.m.outcome == 'success'
          end: mid
        - id: after
          needs: [inner]
          command: echo after
  - id: topend
    needs: [a]
    if: steps.a.outcome == 'failed'
    end: top
  - id: tail
    needs: [outer, a]
    command: echo tail
` },
    outputs: () => undefined,
  },
};

async function replay(config: LocalConfig, key: string, seed: number, between: boolean): Promise<unknown[]> {
  const scenario = scenarios[key]!;
  const started = await startRun(config, scenario.name);
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  const nextRandom = random(seed);
  const held = new Map<string, z.infer<typeof LeaseSchema>>();
  /** Every lease handed out and not reported, those a restart dropped included. */
  const unreported = new Set<string>();
  const names = new Map<string, string>();
  const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll(runId, '<run>')
    .replace(/"installId":"[^"]+"/g, '"installId":"<install>"')
    .replace(/a[0-9a-f]{8}/g, (attempt) => names.get(attempt) ?? attempt));
  const trace: unknown[] = [];
  let done = false;
  for (let turn = 0; turn < 120; turn += 1) {
    const restart = held.size > 0 && nextRandom() < 0.3;
    if (restart || held.size === 0 || nextRandom() < 0.4) {
      const next = await leaseNext(config, runId, driver, { running: restart ? [] : [...held.keys()] });
      if ('error' in next) throw new Error(next.error.message);
      // A restarted driver runs nothing, so it holds only the lease handed back to it.
      if (restart) held.clear();
      if (next.data.lease) {
        const lease = LeaseSchema.parse(next.data.lease);
        if (!names.has(lease.attempt)) names.set(lease.attempt, `<${lease.step}#${names.size}>`);
        held.set(lease.attempt, lease);
        unreported.add(lease.attempt);
      }
      trace.push({ [restart ? 'restart' : 'next']: normalize({ ...next.data, cancelled: undefined }) });
      if (next.data.done) {
        done = true;
        break;
      }
      expect(next.data.lease || held.size > 0).toBeTruthy();
    } else {
      const leases = [...held.values()];
      const lease = leases[Math.floor(nextRandom() * leases.length)]!;
      const outcomeRoll = nextRandom();
      const outcome = outcomeRoll < 0.5 ? 'success' : outcomeRoll < 0.85 ? 'failed' : 'released';
      const outputs = scenario.outputs(lease.step, nextRandom);
      const reported = await reportAttempt(config, runId, {
        attempt: lease.attempt, revision: lease.revision, outcome, driver,
        ...(outputs !== undefined ? { outputs } : {}),
      });
      held.delete(lease.attempt);
      unreported.delete(lease.attempt);
      trace.push({ report: names.get(lease.attempt), outcome, response: normalize(reported) });
      // It lists the leases a restart dropped too, so it only applies what the report settled and hands nothing back.
      if (between) await leaseNext(config, runId, driver, { running: [...unreported], canTakeLease: false });
    }
  }
  expect(done).toBe(true);
  const stored = await readRun(config, runId);
  if (typeof stored !== 'object') throw new Error(`run ${stored}`);
  trace.push(normalize({
    steps: stored.steps, archive: stored.archive, revision: stored.revision, status: stored.status,
    end: stored.end, failure: stored.failure, round: stored.round,
    settledAttempts: stored.settledAttempts, cancelledAttempts: stored.cancelledAttempts,
  }));
  return trace;
}

/**
 * The sha1 of each scenario's traces, seeds 1 to 12, without and then with the extra next. Comparing the two replays
 * catches what an extra next changes; the digest also catches a change to both, such as which lease a restart hands
 * back. After a change that is meant to move leases, take the new digest from the failure.
 */
const TRACE_DIGESTS: Record<string, string> = {
  nested: '6e6fd747678923f5fdd691bf805ecf0d15177a12',
  fan: 'fcca32cd8ca1a8cae21f00591fd3389f69624f6e',
  fanafter: '86faabb77f80db3102854c29e31a9568e0043d50',
  rounds: '3c33dd97dbb4082ab756b08aa1ec872e17f0ed83',
  loopwhile: 'a909c2e9fb540a4e227a33a8d41522da49f67738',
  itemloop: 'f11047ad887b8c0abfed29bb78f8ab8cc26fd94b',
  deep: '892032c5d23025cf4f1ce0606ac2a73535670f51',
};

describe('workflow report reconciliation', () => {
  it.each(Object.keys(scenarios))('keeps %s identical with an extra next between reports, and as it was', async (key) => {
    const config = testConfig();
    for (const [file, body] of Object.entries(scenarios[key]!.files)) {
      fs.writeFileSync(path.join(config.repo.localPath, 'workflows', `${file}.yaml`), body);
    }
    expect((await syncWorkflowDefinitions(config)).invalid).toEqual([]);
    const digest = createHash('sha1');
    for (let seed = 1; seed <= 12; seed += 1) {
      const plain = await replay(config, key, seed, false);
      const extra = await replay(config, key, seed, true);
      expect(plain, `${key}, seed ${seed}`).toEqual(extra);
      digest.update(`${JSON.stringify({ key, seed, between: false, trace: plain })}\n${JSON.stringify({ key, seed, between: true, trace: extra })}\n`);
    }
    expect(digest.digest('hex')).toBe(TRACE_DIGESTS[key]);
  });
});
