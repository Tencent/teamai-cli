import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { judgeConformanceScenarios } from '../workflow/conformance.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { inProcessClient } from '../workflow/protocol.js';
import { submitJudgeLease } from '../workflow/scoring.js';
import { readRun } from '../workflow/store.js';
import type { LocalConfig } from '../types.js';
import type { WorkflowEnvelope } from '../workflow/types.js';
import { resolveWorkflowEnv } from '../env-resolution.js';

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(envelope.error.message);
  return envelope.data;
}

afterEach(() => { vi.useRealTimers(); });

for (const scenario of judgeConformanceScenarios) {
  it(scenario.name, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-protocol-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-10-22T11:00:00.000Z');
    try {
      const knowledge = path.join(root, 'knowledge');
      await fs.mkdir(path.join(knowledge, 'workflows'), { recursive: true });
      await fs.mkdir(path.join(knowledge, 'scorers'));
      await fs.writeFile(path.join(knowledge, 'workflows', 'judged.yaml'), scenario.yaml);
      for (const [name, text] of Object.entries(scenario.scorers)) await fs.writeFile(path.join(knowledge, 'scorers', `${name}.md`), text);
      const config: LocalConfig = { repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
      await syncWorkflowDefinitions(config);
      const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
      const driver = { kind: 'external', machine: 'm1', workspace: '/w' };
      const runId = String(data(await client.start('judged')).run);
      const work = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await client.next(runId, { driver })).lease);
      data(await client.report(runId, { ...work, driver, outcome: 'success', outputs: { reviewed: true } }));
      data(await client.next(runId, { driver }));
      const judge = { driver: { ...driver, can: { judge: { isolation: 'verified', tools: ['claude'] } } } };
      const revision = async () => z.object({ revision: z.number() }).parse(await readRun(config, runId)).revision;
      let ref = '';
      for (const operation of scenario.operations) {
        switch (operation.kind) {
          case 'take': {
            vi.setSystemTime(operation.at);
            const result = await client.scoreNext({ ...judge, running: operation.running ? [ref] : [] });
            expect(result).toMatchObject(operation.expect);
            ref = z.object({ ref: z.string() }).parse(data(result).lease).ref;
            break;
          }
          case 'renew':
            vi.setSystemTime(operation.at);
            expect(await client.scoreNext({ ...judge, running: [ref], ...(operation.canTakeLease === false ? { canTakeLease: false } : {}) })).toMatchObject(operation.expect);
            break;
          case 'next': {
            const before = await revision();
            expect(await client.next(runId, { driver, running: [ref] })).toMatchObject(operation.expect);
            expect(await revision()).toBe(before);
            break;
          }
          case 'report':
            expect(await client.report(runId, { attempt: ref, revision: 1, driver, outcome: 'success' })).toMatchObject(operation.expect);
            break;
          case 'submit':
            expect(await submitJudgeLease(config, ref, { driver, outcome: 'success', answer: { label: 'good', reasoning: 'done' } }, '2026-10-22T12:46:00.000Z')).toMatchObject(operation.expect);
            break;
          case 'idle':
            vi.setSystemTime(operation.at);
            expect(await client.scoreNext({ ...judge, running: [] })).toMatchObject(operation.expect);
            break;
          default: {
            const unhandled: never = operation;
            throw new Error(String(unhandled));
          }
        }
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
