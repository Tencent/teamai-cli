import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { workflowConformanceScenarios, type WorkflowClient } from '../workflow/conformance.js';
import { leaseNext, parseNextPayload, parseReport, reportAttempt, startRun, withIgnored } from '../workflow/engine.js';
import { readRun } from '../workflow/store.js';
import type { DriverIdentity } from '../workflow/types.js';

const dirs: string[] = [];
const driver: DriverIdentity = { kind: 'local', machine: 'conformance', workspace: '/work' };

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow protocol conformance in process', () => {
  for (const scenario of workflowConformanceScenarios) {
    it(scenario.name, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-conformance-'));
      dirs.push(root);
      const knowledge = path.join(root, 'knowledge');
      fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
      const config: LocalConfig = {
        repo: { localPath: knowledge, remote: 'local', kind: 'self' },
        username: 'tester',
        scope: 'project',
        additionalRoles: [],
        projectRoot: root,
        dataHome: path.join(root, 'data'),
      };
      fs.writeFileSync(path.join(knowledge, 'workflows', `${scenario.workflowName}.yaml`), scenario.yaml);
      for (const [name, yaml] of Object.entries(scenario.workflows ?? {})) {
        fs.writeFileSync(path.join(knowledge, 'workflows', `${name}.yaml`), yaml);
      }
      await syncWorkflowDefinitions(config);
      const client: WorkflowClient = {
        start: (name) => startRun(config, name),
        next: async (runId, body) => {
          const parsed = parseNextPayload(body);
          if (typeof parsed === 'string') return { error: { code: 'invalid_json', message: parsed } };
          const { driver: identity, ...options } = parsed.request;
          return withIgnored(await leaseNext(config, runId, identity, options), parsed.ignored);
        },
        report: async (runId, body) => {
          const parsed = parseReport(body);
          return typeof parsed === 'string'
            ? { error: { code: 'invalid_report', message: parsed } }
            : withIgnored(await reportAttempt(config, runId, parsed.report), parsed.ignored);
        },
      };
      const started = await client.start(scenario.workflowName);
      if ('error' in started) throw new Error(started.error.message);
      const runId = String(started.data.run);
      const leases = new Map<string, { attempt: string; revision: number }>();
      const attemptOf = (name: string): string | undefined => leases.get(name)?.attempt;
      for (const operation of scenario.operations) {
        if (operation.kind === 'next') {
          const envelope = await client.next(runId, {
            driver,
            ...(operation.running ? { running: operation.running.map(attemptOf) } : {}),
            ...(operation.canTakeLease !== undefined ? { canTakeLease: operation.canTakeLease } : {}),
          });
          expect(envelope).toMatchObject(operation.expect);
          if (operation.cancelled) expect('data' in envelope && envelope.data.cancelled).toEqual(operation.cancelled.map(attemptOf));
          for (const field of operation.absent ?? []) expect('data' in envelope ? envelope.data.lease : undefined).not.toHaveProperty(field);
          if ('data' in envelope && envelope.data.lease) {
            leases.set(operation.saveAs, envelope.data.lease as { attempt: string; revision: number });
          }
          continue;
        }
        const lease = operation.lease ? leases.get(operation.lease) : undefined;
        const envelope = await client.report(runId, {
          attempt: operation.attempt ?? lease?.attempt,
          revision: operation.revision ?? lease?.revision,
          driver,
          ...operation.body,
        });
        expect(envelope).toMatchObject(operation.expect);
      }
      const stored = await readRun(config, runId);
      if (typeof stored !== 'object') throw new Error('run was not stored');
      if (scenario.name === 'two-step command success') {
        expect(stored.steps[1]).toMatchObject({
          status: 'succeeded',
          outcome: 'success',
          outputs: { ok: true },
          tool: 'claude',
          model: 'claude-sonnet',
          session: 'session-1',
          tokens: { input: 3, output: 2, cachedInput: 1 },
        });
      } else if (scenario.name === 'output mismatch fails the step') {
        expect(stored.steps[0]).toMatchObject({
          status: 'failed',
          failure: { code: 'invalid_output', message: expect.stringContaining('does not match output') },
        });
      }
    });
  }
});
