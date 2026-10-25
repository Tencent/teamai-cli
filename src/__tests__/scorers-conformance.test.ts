import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inProcessConformanceClient, JUDGES_UNDER_TEST, runJudgeConformanceScenario } from '../workflow/conformance-interpreter.js';
import { judgeConformanceScenarios } from '../workflow/conformance/judge.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { inProcessClient } from '../workflow/protocol.js';
import { parseJudgeSubmission, submitJudgeLease } from '../workflow/scoring.js';
import { readRun } from '../workflow/store.js';
import type { LocalConfig } from '../types.js';
import { resolveWorkflowEnv } from '../env-resolution.js';

afterEach(() => { vi.useRealTimers(); });

describe.each(JUDGES_UNDER_TEST)('judge lease conformance in process as %s', (profile) => {
  for (const scenario of judgeConformanceScenarios) {
    it(scenario.name, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-judge-protocol-'));
      try {
        const knowledge = path.join(root, 'knowledge');
        await fs.mkdir(path.join(knowledge, 'workflows'), { recursive: true });
        await fs.mkdir(path.join(knowledge, 'scorers'));
        await fs.writeFile(path.join(knowledge, 'workflows', 'judged.yaml'), scenario.yaml);
        for (const [name, text] of Object.entries(scenario.scorers)) await fs.writeFile(path.join(knowledge, 'scorers', `${name}.md`), text);
        const config: LocalConfig = { repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
        await syncWorkflowDefinitions(config);
        const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
        await runJudgeConformanceScenario(scenario, {
          client: {
            ...client, ...inProcessConformanceClient(client),
            submit: async (ref, body) => {
              const submission = parseJudgeSubmission(body);
              return typeof submission === 'string' ? { error: { code: 'invalid_json', message: submission } } : submitJudgeLease(config, ref, submission);
            },
          },
          readRevision: async (runId) => {
            const stored = await readRun(config, runId);
            if (typeof stored !== 'object') throw new Error('run was not stored');
            return stored.revision;
          },
          setClock: async (at) => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(at);
          },
          expect,
        }, profile);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
  }
});
