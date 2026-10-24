import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { judgeLeaseConformanceScenario as scenario } from '../workflow/conformance.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { nextJudgeLease, submitJudgeLease } from '../workflow/scoring.js';
import type { LocalConfig } from '../types.js';
import type { WorkflowEnvelope } from '../workflow/types.js';
import { knownSecrets } from '../env-resolution.js';

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(envelope.error.message);
  return envelope.data;
}

it(scenario.name, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-protocol-'));
  try {
    const knowledge = path.join(root, 'knowledge');
    await fs.mkdir(path.join(knowledge, 'workflows'), { recursive: true });
    await fs.mkdir(path.join(knowledge, 'scorers'));
    await fs.writeFile(path.join(knowledge, 'workflows', 'judged.yaml'), scenario.yaml);
    await fs.writeFile(path.join(knowledge, 'scorers', 'quality.md'), scenario.scorer);
    const config: LocalConfig = { repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
    await syncWorkflowDefinitions(config);
    const driver = { kind: 'external', machine: 'm1', workspace: '/w' };
    const runId = String(data(await startRun(config, 'judged', {}, { secrets: await knownSecrets(config) })).run);
    const work = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, runId, driver)).lease);
    data(await reportAttempt(config, runId, { ...work, driver, outcome: 'success', outputs: { reviewed: true } }));
    data(await leaseNext(config, runId, driver));
    const request = { driver, judge: { isolation: 'verified', tools: ['claude'] }, running: [] } satisfies Parameters<typeof nextJudgeLease>[1];
    let ref = '';
    for (const operation of scenario.operations) {
      switch (operation.kind) {
        case 'take': {
          const result = await nextJudgeLease(config, request, operation.at);
          expect(result).toMatchObject(operation.expect);
          const lease = z.object({ ref: z.string() }).parse(data(result).lease);
          if (ref) expect(lease.ref).toBe(ref);
          ref = lease.ref;
          break;
        }
        case 'renew':
          expect(await nextJudgeLease(config, { ...request, running: [ref] }, operation.at)).toMatchObject(operation.expect);
          break;
        case 'report':
          expect(await reportAttempt(config, runId, { attempt: ref, revision: 1, driver, outcome: 'success' })).toMatchObject(operation.expect);
          break;
        case 'submit':
          expect(await submitJudgeLease(config, ref, { driver, outcome: 'success', answer: { label: 'good', reasoning: 'done' } }, '2026-10-22T12:46:00.000Z')).toMatchObject(operation.expect);
          break;
        case 'idle':
          expect(await nextJudgeLease(config, request, operation.at)).toMatchObject(operation.expect);
          break;
        default: {
          const unhandled: never = operation;
          throw new Error(String(unhandled));
        }
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
