import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DRIVER_PROFILES, DRIVERS_UNDER_TEST, JUDGE_PROFILES, runConformanceScenario } from '../workflow/conformance-interpreter.js';
import { workflowConformanceScenarios } from '../workflow/conformance.js';
import { RunIdSchema } from '../workflow/store.js';
import { inProcessConformanceRunner } from './helpers/in-process-conformance.js';
import { fakeJudge, skillHarness } from './helpers/skill-harness.js';

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

/** The driver a body declares, and the run it names, if any. */
const DeclaredSchema = z.object({ driver: z.object({ kind: z.string(), can: z.unknown() }), run: z.string().optional() });

const SCORED = `schemaVersion: v1alpha1
name: review
description: Review the change
invoke: allow
steps:
  - id: review
    prompt: Review the change.
    scorers: [quality]
`;

const QUALITY = `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Missed the work }
passingScore: 0.5
samplingRate: 100
---
Judge the work.
`;

describe('the skill conformance profiles', () => {
  it('declare on next and score --next what the skill driver declares', async () => {
    const nexts: unknown[] = [];
    const scores: unknown[] = [];
    const harness = await skillHarness({ review: SCORED }, {
      scorers: { quality: QUALITY },
      client: (client) => ({
        ...client,
        next: async (run, body, options) => { nexts.push(body); return client.next(run, body, options); },
        scoreNext: async (body) => { scores.push(body); return client.scoreNext(body); },
      }),
    });
    dirs.push(harness.root);
    fakeJudge(harness.root, 'good');
    const started = await harness.call({ kind: 'start', name: 'review', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    const chosen = await harness.call({ kind: 'choose', run, choice: 'h1' });
    if (!('data' in chosen) || !('turn' in chosen.data)) throw new Error(JSON.stringify(chosen));
    const [dispatch] = chosen.data.turn.actions.flatMap((action) => (action.kind === 'dispatch' ? [action] : []));
    if (!dispatch) throw new Error(JSON.stringify(chosen));
    await harness.call({ kind: 'ack', run, attempt: dispatch.attempt });
    const file = /Write `([^`]+result\.json)`/.exec(fs.readFileSync(dispatch.brief, 'utf8'))?.[1];
    if (!file) throw new Error(`${dispatch.brief} names no result file`);
    fs.writeFileSync(file, JSON.stringify({ kind: 'output', output: 'Reviewed the change.' }));
    await harness.call({ kind: 'report', run, attempt: dispatch.attempt, role: 'agent', modelUnavailable: false });
    await harness.call({ kind: 'next', run, wait: false });
    await harness.call({ kind: 'next', run, wait: true });

    const declared = (bodies: unknown[]) => bodies.map((body) => {
      const { driver, run: named } = DeclaredSchema.parse(body);
      return { kind: driver.kind, can: driver.can, run: named };
    });
    const skill = DRIVER_PROFILES.skill;
    expect(nexts.length).toBeGreaterThan(0);
    expect(declared(nexts)).toEqual(nexts.map(() => ({ kind: skill.kind, can: skill.can, run: undefined })));
    const judging = JUDGE_PROFILES.skill;
    expect(scores.length).toBeGreaterThan(0);
    expect(declared(scores)).toEqual(scores.map(() => ({ kind: DRIVER_PROFILES[judging.as].kind, can: { judge: judging.judge }, run: judging.ownRun ? run : undefined })));
  });
});
