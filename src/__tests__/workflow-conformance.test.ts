import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRIVERS_UNDER_TEST, runConformanceScenario } from '../workflow/conformance-interpreter.js';
import { workflowConformanceScenarios } from '../workflow/conformance.js';
import { inProcessConformanceRunner } from './helpers/in-process-conformance.js';

const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.each(DRIVERS_UNDER_TEST)('workflow protocol conformance in process as %s', (profile) => {
  for (const scenario of workflowConformanceScenarios) {
    it(scenario.name, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-conformance-'));
      dirs.push(root);
      const { runner } = await inProcessConformanceRunner(scenario, root);
      await runConformanceScenario(scenario, { ...runner, expect }, profile);
    });
  }
});
