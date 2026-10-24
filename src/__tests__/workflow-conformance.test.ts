import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { runConformanceScenario, type WorkflowClient } from '../workflow/conformance-interpreter.js';
import { workflowConformanceScenarios } from '../workflow/conformance.js';
import { leaseNext, parseNextPayload, parseReport, parseResponsePayload, reportAttempt, startRun, withIgnored } from '../workflow/engine.js';
import { cancelRun, respondToHitl, retryStep } from '../workflow/run-controls.js';
import { pendingRecords } from '../workflow/records.js';
import { readRun } from '../workflow/store.js';
import { knownSecrets } from '../env-resolution.js';

const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow protocol conformance in process', () => {
  for (const scenario of workflowConformanceScenarios) {
    it(scenario.name, async () => {
      for (const [name, value] of Object.entries(scenario.env ?? {})) vi.stubEnv(name, value);
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
        respond: async (runId, step, choice, options) => {
          const parsed = options?.json !== undefined ? parseResponsePayload(options.json) : undefined;
          if (typeof parsed === 'string') return { error: { code: 'invalid_json', message: parsed } };
          return withIgnored(await respondToHitl(config, runId, await knownSecrets(config), { step, choice, note: options?.note, pass: options?.pass,
            ...(parsed ? parsed.response : { channel: 'cli', agent: true }),
          }), parsed?.ignored ?? []);
        },
        retry: async (runId, step) => retryStep(config, runId, await knownSecrets(config), step),
        cancel: async (runId, step) => cancelRun(config, runId, await knownSecrets(config), step),
        start: async (name) => startRun(config, name, {}, { secrets: await knownSecrets(config) }),
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
      await runConformanceScenario(scenario, {
        client,
        readRun: async (runId) => {
          const stored = await readRun(config, runId);
          if (typeof stored !== 'object') throw new Error('run was not stored');
          return stored;
        },
        readEndRecord: async (runId) => (await pendingRecords(config)).find((record) => record.run === runId && record.phase === 'end'),
        // Only Date is faked, so the run lock's retry timers still run.
        advance: async (ms) => {
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(Date.now() + ms);
        },
        expect,
      });
    });
  }
});
