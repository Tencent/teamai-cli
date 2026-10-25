import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { inProcessConformanceClient, runConformanceScenario } from '../workflow/conformance-interpreter.js';
import { workflowConformanceScenarios } from '../workflow/conformance.js';
import { inProcessClient } from '../workflow/protocol.js';
import { pendingRecords } from '../workflow/records.js';
import { readRun } from '../workflow/store.js';
import { resolveWorkflowEnv } from '../env-resolution.js';

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
      const client = inProcessConformanceClient(inProcessClient({ config, env: await resolveWorkflowEnv(config) }));
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
