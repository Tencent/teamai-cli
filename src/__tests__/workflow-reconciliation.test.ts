import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { readRun } from '../workflow/store.js';
import type { DriverIdentity } from '../workflow/types.js';
import { knownSecrets } from '../env-resolution.js';

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
  const started = await startRun(config, scenario.name, {}, { secrets: await knownSecrets(config) });
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

const SEEDS = Array.from({ length: 12 }, (_, index) => index + 1);

/**
 * The sha1 of each scenario's traces per seed (1 to 12), without and then with the extra next. Comparing the two
 * replays catches what an extra next changes; the digest also catches a change to both, such as which lease a restart
 * hands back. After a change that is meant to move leases, take the new digests from the failures.
 */
const TRACE_DIGESTS: Record<string, string[]> = {
  nested: [
    '34406ca79186c93a9c28b4515db6a979cf1f3fb9',
    '514a7c724e8308870ee4d6ae026a5e0467108a8d',
    'da0c0a77844179cf507ba2a81d0521427bdcc7db',
    '622ec5964ab1ab579fcff1dbb32aa401d60d1788',
    '00588e86251572b9fb974aaf6b07cd72db64af29',
    '19a17c92c68d65cafb2406868c52dec52a5154dd',
    '4bae4d1594e35a7263593a063545ab9c6c7dc3c0',
    'dc3dd3738cba61d86d18ebf21a50a81ffa5056f1',
    '9eddefe361868c08240d3096bb60695d0d6143db',
    '2f308e6099d81b2121db1dbe342904e65265a5ec',
    '274dbaafdd29829f1aa5f49b58ed5e7090d60ac2',
    'ca9a942502d923781c67ae7d75c821a82831ebf0',
  ],
  fan: [
    '0fadb030f3aa5ddb257611331e51bfef19b04a9f',
    '449ffa5ed3c29190c4288a1288d976e4dde23566',
    'f43def34ea25e9fe264d4448d0f32dc610942c63',
    '0f3c9a9287ca29dffccbef81495f1a5b047807fc',
    '09026ed7dd42f2d17d945b754f37fb849e239650',
    '065e2510e3242cb606b7b2457d768582fc4a4657',
    '545ad4808c00d896fc1354b1791da10abd553902',
    '04f0a3edcd0354e96555d0523fa3015f0de9a6b6',
    'de97b0c940577a147638cad548bcbec55021b8bd',
    '89aabe410d7daa1f27bb87341a219ede93bce179',
    'd1b256e75cd3f25f2ba15037d9ed26e2dd62b29a',
    'c9815579690408bc01857b05e2f7a986e2ee8058',
  ],
  fanafter: [
    'af75d043df1519990e9094250e8895af0b58551d',
    'c748e8d4e00558036a9ffadc68e82742407d9055',
    'c396e259b6e4bb11243bef309ecfd1902b8b2c21',
    '4c92ef5cac594e4862c29b511c3640dab93e8d56',
    '928b2bbfbe559f3816b97fa230cf554caff47865',
    'dc82857aaf5697f3fcfdbe1d30edad214227ba69',
    '61854b2bfb390ffb19f03bfe489e4913cf734912',
    '9527c1f9439ebe6a1583c0a26313162fa09b43da',
    '84bf8fa8bc48de1dc3c7bc433e59924870a1be69',
    'c808b6b71a85c08415bc5078b9721ce7a913bf12',
    'd34a937722bc408844bc1a8f906ce25a00f9c80b',
    '8f75ffab0b73c87376be75192f88bd09d187d1ef',
  ],
  rounds: [
    'c135fdba73370d6254cbc3b705471759d54fa7bc',
    '0b840a3368e63e839ebd69bb06812bcbc3568240',
    'c8b38f3144d6d5ea38b0c59f494d08c4003bbb41',
    '4524666627e192b9aa6e72d104974e9fed724139',
    'ce51c5882c8eff27df37499c3f7ae7421ea51e28',
    '1a935bad63babad32c661c466217a0bd23a27c70',
    '2d52166d681953ccb97053b8a15c0682d170a7d0',
    'cd3f63725859f81a5bbbb450ce88430eb7462381',
    '015f01a52f39536098d5c8baa62e0d1eb1979dba',
    '761a99d8c86d0beeab9a9d65cb211dd8f8362a2c',
    '96791b3a9780e7872c0a0ad3739655e9003fb419',
    'f64b2f50d4c2b4bf250ca740c27518a20aa4a596',
  ],
  loopwhile: [
    '3951782a4de4fba59b4666145a0d63fe8b8ee498',
    'd436b06b275c4f3043e795051559907dfdd95f38',
    '02c8b665e7914fad6aa7a87ded2f076af0177c75',
    '20ec8b326a04862684d21fb7c6721ddacba756de',
    '357608349ea041b1c76188f01cb246d5be5cf0e9',
    '25812a189c76051b3185ac99b9f7b132a3210d1f',
    'ed333d9e1b0c7b477843b5d225261e4de0a67f38',
    'c0eacadf6dddbc71e9910d0887c48ec2d4d04b26',
    '2f40983addc82ec3d5e9e7531803d0e52da710e7',
    'd5a01ffb77f3e43669eacd70d195dfe7d2cfe022',
    '469ca90633c2d4d2f5cbba49680df1603133efe2',
    '1916845788d9357d7d80ce901c3f9b1f25890106',
  ],
  itemloop: [
    '63719e4fff45396ab3a51d45ac9d590ba418fd93',
    '88c20c704e432b2af6143a007e40bad1f53ded55',
    '2e6e02d84b865219aa77d51b20116f1e444b03ea',
    'd524019f86685127766e5902520b954e478846c8',
    '7f74abdf9429bdb4c36ccf82e70d9446f46a3a05',
    'b6303a430a2dd8559051392319d6efc1b749bc81',
    '41e7de52a35443b03680c957c96cdc830847283d',
    '90e8b2caa7518dfa71f2c8c8755da390d5e9f204',
    'c1e7e3111a308eae9a7df4caaa3f2d88f0182d74',
    '5621f0c08a81f46470512aa7bb367999180d1162',
    '344b64be6f91790c14fb8e88e6b7e374c716c298',
    '1f27c92a8caafc0f80ed12eff22e3d4b404f15cd',
  ],
  deep: [
    'fffca6cac651a4ab908712f6d097bfd56e1a5346',
    'c257c04fa2beeed86ff67f89b94588ba02d9d79a',
    'a1ddac4cd07c4ada7b08f9090bbd1e8e18a4df52',
    '0152f968d1e394fd0518110eefe05fa82f321fe7',
    '033df85424e84c139f5ec622e8abd98e9c42633a',
    '047a39ec0c0e336d14d5bd3df10d133ab3f3c2e3',
    '0e2df8c71acb83acf4efbcd6977b16559d3782a9',
    '8881ed66946e0fe20d345eb45a9194ac01252cbc',
    'e96681f935883d58624334fc7a663236deeee0c6',
    '1d89347bd9662ec6742bdfb71d71c33a0922dc30',
    '787a244cf88318d0538b3972dd38cc189d6e0621',
    'd8693db2b6dd605d8741e30dfe610f61167a25c9',
  ],
};

/** A team whose workflows are scenario `key`'s, synced as teamai pull syncs them. */
async function scenarioConfig(key: string): Promise<LocalConfig> {
  const config = testConfig();
  for (const [file, body] of Object.entries(scenarios[key]!.files)) {
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', `${file}.yaml`), body);
  }
  expect((await syncScorersThenWorkflows(config)).invalid).toEqual([]);
  return config;
}

// One test per scenario and seed, so each replays two runs within its timeout, however loaded the machine is.
describe.each(Object.keys(scenarios))('workflow report reconciliation of %s', (key) => {
  it.each(SEEDS)('keeps seed %i identical with an extra next between reports, and as it was', async (seed) => {
    const config = await scenarioConfig(key);
    const plain = await replay(config, key, seed, false);
    const extra = await replay(config, key, seed, true);
    expect(plain, `${key}, seed ${seed}`).toEqual(extra);
    const digest = createHash('sha1')
      .update(`${JSON.stringify({ key, seed, between: false, trace: plain })}\n${JSON.stringify({ key, seed, between: true, trace: extra })}\n`)
      .digest('hex');
    expect(digest).toBe(TRACE_DIGESTS[key]?.[seed - 1]);
  });
});
