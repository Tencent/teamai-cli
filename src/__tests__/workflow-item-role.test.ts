/**
 * A role per `for_each` item: `role: "{{ item.role }}"` is rendered for each item as its lease is offered, and that
 * item's copy runs with the role it gives.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { knownSecrets } from '../env-resolution.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { readRun } from '../workflow/store.js';
import type { DriverCan } from '../workflow/requirements.js';
import type { DriverIdentity } from '../workflow/types.js';

const dirs: string[] = [];
const driver: DriverIdentity = { kind: 'local', machine: 'a', workspace: '/work' };
const CAN: DriverCan = { workspace: ['read-only', 'new', 'continue'], role: true };
const BASE = { ref: 'main', commit: 'a'.repeat(40) };

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const REVIEW_PARTS = `schemaVersion: v1alpha1
name: review
description: Review each part of the change as the role that knows it.
inputs:
  parts: [{ path: string, role: string }]
steps:
  - id: review
    for_each: inputs.parts
    role: "{{ item.role }}"
    workspace: new
    prompt: Review the change to {{ item.path }}.
`;

/** A run of `yaml`, the workflow `review`, in a team that declares roles frontend and review. */
async function started(yaml: string, inputs: unknown): Promise<{ config: LocalConfig; runId: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-item-role-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(knowledge, 'manifest'));
  fs.writeFileSync(path.join(knowledge, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: frontend\n    resources: { knowledge: [], skills: [frontend] }\n  - id: review\n    resources: { knowledge: [], skills: [review] }\n');
  fs.writeFileSync(path.join(knowledge, 'workflows', 'review.yaml'), yaml);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'),
  };
  await syncWorkflowDefinitions(config);
  const run = await startRun(config, 'review', inputs, { secrets: await knownSecrets(config), base: BASE });
  if ('error' in run) throw new Error(run.error.message);
  return { config, runId: String(run.data.run) };
}

const LeaseSchema = z.object({ data: z.object({ lease: z.object({
  step: z.string(), attempt: z.string(), revision: z.number(), role: z.string().optional(),
  workspace: z.object({ branch: z.string() }).optional(), session: z.object({ id: z.string() }).optional(),
}) }) });

/**
 * Leases every step `next` offers until the run is done, reporting each a success with a session of its own, the
 * outputs `outputs` lists for its step's next pass, and, with `records`, the role teamai delivered into its copy, as
 * the local driver records it. Answers each lease's step, role and resumed session, in lease order.
 */
async function runAll(config: LocalConfig, runId: string, outputs: Record<string, unknown[]> = {}, records = true): Promise<Array<{ step: string; role?: string; resumes?: string }>> {
  const leased: Array<{ step: string; role?: string; resumes?: string }> = [];
  for (let at = 0; at < 20; at += 1) {
    const offered = LeaseSchema.safeParse(await leaseNext(config, runId, driver, { can: CAN, prepare: true }));
    if (!offered.success) return leased;
    const { lease } = offered.data.data;
    leased.push({ step: lease.step, ...(lease.role !== undefined ? { role: lease.role } : {}), ...(lease.session ? { resumes: lease.session.id } : {}) });
    const team = { revision: 'b'.repeat(40), localChanges: false, selection: { scope: 'project' as const, additionalRoles: [], ...(lease.role !== undefined ? { stepRole: lease.role } : {}) } };
    const output = outputs[lease.step]?.shift();
    await reportAttempt(config, runId, {
      attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, tool: 'claude', session: `session-${at}`, ...(records ? { agent: { team } } : {}),
      ...(output !== undefined ? { outputs: output } : {}),
      ...(lease.workspace ? { changes: { branch: lease.workspace.branch, base: BASE.commit, from: BASE.commit, to: BASE.commit, commits: [] } } : {}),
    });
  }
  throw new Error(`run ${runId} did not end in 20 leases`);
}

/** The failures of the steps of run `runId` that failed, by step. */
async function failures(config: LocalConfig, runId: string): Promise<Record<string, unknown>> {
  const run = await readRun(config, runId);
  if (typeof run !== 'object') throw new Error(`run ${run}`);
  return Object.fromEntries(run.steps.flatMap((step) => (step.status === 'failed' ? [[step.id, step.failure]] : [])));
}

const PARTS = { parts: [{ path: 'web/', role: 'frontend' }, { path: 'api/', role: 'review' }] };

describe('a role per for_each item', () => {
  it('leases each item with the role its item gives', async () => {
    const { config, runId } = await started(REVIEW_PARTS, PARTS);

    const leased = await runAll(config, runId);

    expect(leased).toEqual([{ step: 'review[0]', role: 'frontend' }, { step: 'review[1]', role: 'review' }]);
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.status).toBe('succeeded');
  });

  it('fails a step continuing an item\'s copy with a role other than the one its item gave, at its lease', async () => {
    const { config, runId } = await started(`schemaVersion: v1alpha1
name: review
description: Review each part as the role that knows it, then sum it up as a reviewer.
inputs:
  parts: [{ path: string, role: string }]
steps:
  - id: review
    for_each: inputs.parts
    role: "{{ item.role }}"
    workspace: new
    workflow:
      steps:
        - id: look
          prompt: Review the change to {{ item.path }}.
        - id: sum
          needs: [look]
          role: review
          workspace: continue
          prompt: Sum up the review.
`, PARTS);

    const leased = await runAll(config, runId);

    expect(leased.toSorted((left, right) => left.step.localeCompare(right.step))).toEqual([
      { step: 'review[0].look', role: 'frontend' }, { step: 'review[1].look', role: 'review' }, { step: 'review[1].sum', role: 'review' },
    ]);
    expect(await failures(config, runId)).toMatchObject({ 'review[0].sum': {
      code: 'role_unavailable',
      message: 'step "review[0].sum" has role review but continues the copy step "review[0]" opened with role frontend, which every step there runs with; remove role from step "review[0].sum", or set it on step "review[0]"',
    } });
  });

  it('fails a step resuming the session of a step that ran with the role its item gave, when that is another, at its lease', async () => {
    const { config, runId } = await started(`schemaVersion: v1alpha1
name: review
description: Review each part as the role that knows it, then sum it up as a reviewer in the same session.
inputs:
  parts: [{ path: string, role: string }]
steps:
  - id: review
    for_each: inputs.parts
    workflow:
      steps:
        - id: look
          role: "{{ item.role }}"
          workspace: new
          prompt: Review the change to {{ item.path }}.
        - id: sum
          needs: [look]
          role: review
          workspace: new
          session: { from: look }
          prompt: Sum up the review.
`, PARTS);

    const leased = await runAll(config, runId);

    expect(leased.toSorted((left, right) => left.step.localeCompare(right.step))).toEqual([
      { step: 'review[0].look', role: 'frontend' }, { step: 'review[1].look', role: 'review' }, { step: 'review[1].sum', role: 'review', resumes: expect.any(String) },
    ]);
    expect(await failures(config, runId)).toMatchObject({ 'review[0].sum': {
      code: 'bad_session',
      message: 'step "review[0].sum" resumes "look", which ran with role frontend, while step "review[0].sum" runs with role review; a session goes on only with the knowledge it started with, so run both steps with one role, or start a new session',
    } });
  });

  describe('session: continue on an item that a loop runs again for the parts of a new plan', () => {
    const REPLANNED = `schemaVersion: v1alpha1
name: review
description: Review each part the plan names as the role it names, in one session per item, then plan again once.
steps:
  - id: plan
    command: node plan.js
    output: { parts: [{ path: string, role: string }] }
  - id: review
    needs: [plan]
    for_each: steps.plan.outputs.parts
    role: "{{ item.role }}"
    workspace: new
    session: continue
    prompt: Review the change to {{ item.path }}.
  - id: again
    needs: [review]
    command: node again.js
    loop: { back_to: plan, while: "length(steps.plan.passes) < 2", max_iterations: 2 }
`;

    it('fails the item at its lease when its new role is not the one its session ran with', async () => {
      const { config, runId } = await started(REPLANNED, {});

      const leased = await runAll(config, runId, { plan: [{ parts: [{ path: 'web/', role: 'frontend' }] }, { parts: [{ path: 'web/', role: 'review' }] }] });

      expect(leased.filter((lease) => lease.step.startsWith('review'))).toEqual([{ step: 'review[0]', role: 'frontend' }]);
      expect(await failures(config, runId)).toMatchObject({ 'review[0]': {
        code: 'bad_session',
        message: 'step "review[0]" resumes its session from pass 1, which ran with role frontend, while step "review[0]" runs with role review now; a session goes on only with the knowledge it started with, so run its passes with one role, or start a new session',
      } });
    });

    it('resumes the session when the item runs with the role it ran with', async () => {
      const { config, runId } = await started(REPLANNED, {});

      const leased = await runAll(config, runId, { plan: [{ parts: [{ path: 'web/', role: 'frontend' }] }, { parts: [{ path: 'web/', role: 'frontend' }] }] });

      expect(leased.filter((lease) => lease.step.startsWith('review'))).toEqual([
        { step: 'review[0]', role: 'frontend' }, { step: 'review[0]', role: 'frontend', resumes: expect.any(String) },
      ]);
      expect(await failures(config, runId)).toEqual({});
    });

    it('fails the item at its lease when the pass its session ran in recorded no role, as nothing shows the role it had', async () => {
      const { config, runId } = await started(REPLANNED, {});

      await runAll(config, runId, { plan: [{ parts: [{ path: 'web/', role: 'frontend' }] }, { parts: [{ path: 'web/', role: 'frontend' }] }] }, false);

      expect(await failures(config, runId)).toMatchObject({ 'review[0]': {
        code: 'bad_session',
        message: 'step "review[0]" resumes its session from pass 1, whose record names no role it ran with, while step "review[0]" runs with role frontend now; a session goes on only with the knowledge it started with, so start a new session',
      } });
    });
  });

  it('fails an item whose role template gives no role id before any lease, and says which item and what to do', async () => {
    const { config, runId } = await started(REVIEW_PARTS.replace('role: string }', 'role: number }'), { parts: [{ path: 'web/', role: 7 }] });

    const next = await leaseNext(config, runId, driver, { can: CAN, prepare: true });

    expect(next).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'review[0]')).toMatchObject({ status: 'failed', failure: {
      code: 'role_unavailable',
      message: 'step "review[0]" role {{ item.role }} gives a number, not the id of a role in manifest/roles.yaml, so teamai cannot tell which role\'s knowledge its copy gets; give each item a role id, such as review, then start the run again',
    } });
  });
});
