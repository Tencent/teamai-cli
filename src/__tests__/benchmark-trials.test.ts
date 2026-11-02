import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getDataHome, type LocalConfig } from '../types.js';
import { leaseNext } from '../workflow/engine.js';
import type { DriverCan } from '../workflow/requirements.js';
import { cancelRun } from '../workflow/run-controls.js';
import { runsDir } from '../workflow/store.js';
import { sweepClones } from '../workflow/place/place.js';
import { branchName } from '../workflow/workspace.js';
import type { DriverIdentity } from '../workflow/types.js';
import { benchmarkRunConfig, FIX_SUITE, fixTask, settleBaselines, startBenchmarkRun } from './helpers/benchmark-fixture.js';

const driver: DriverIdentity = { kind: 'external', machine: 'ci', workspace: '/work' };
const can: DriverCan = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, tools: ['claude'], end_turn: true };
const LeaseSchema = z.object({ data: z.object({ lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number(), workspace: z.object({ branch: z.string() }) }) }) });
const dirs: string[] = [];

afterEach(() => {
  // Retried: on Windows another process, such as a virus scanner, can briefly hold a file just written (EBUSY).
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * A run of the one-task check suite whose baseline failed as the task expects, and the lease of its prompt as the engine
 * grants it, before any preparation.
 */
async function leasedPrompt(): Promise<{ config: LocalConfig; runId: string; lease: z.infer<typeof LeaseSchema>['data']['lease'] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-trials-'));
  dirs.push(root);
  const config = benchmarkRunConfig(root);
  const started = await startBenchmarkRun(config, { name: 'fix', suite: FIX_SUITE, tasks: { fix: fixTask('{{startingCommit}}') } });
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  await settleBaselines(config, runId, driver, can);
  return { config, runId, lease: LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease };
}

describe('sweeping clones', () => {
  /**
   * A receipt as preparing the trial's clone writes it before anything under its root exists, and the paths preparation
   * made before the driver died. The receipt is the durable file a later teamai reads, so the test writes it as one.
   */
  function crashedTrial(config: LocalConfig, runId: string, made: readonly string[]): { receipt: string; root: string } {
    const root = path.join(path.dirname(getDataHome(config)), 'clone-root');
    const branch = branchName(runId, 'trials.r1.fix.claude', 1);
    const receipt = path.join(runsDir(config), runId, 'clones', `${createHash('sha256').update(branch).digest('hex').slice(0, 8)}.json`);
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({ v: 1, branch, root, withhold: [], state: { kind: 'preparing' } }));
    for (const dir of made) fs.mkdirSync(path.join(root, dir), { recursive: true });
    return { receipt, root };
  }

  it.each([
    ['before its root existed', []],
    ['after the clone', ['r']],
    ['after the team revision was copied', ['r', 'team.git']],
    ['after the trial team clone', ['r', 'team.git', 'h/.teamai/projects/p/team-repo']],
    ['after the agent files were saved', ['r', 'team.git', 'h/.teamai/projects/p/team-repo', 'saved']],
  ])('removes exactly the root and the receipt of a trial clone whose driver died %s, once its run is cancelled', async (_stage, made) => {
    const { config, runId } = await leasedPrompt();
    const { receipt, root } = crashedTrial(config, runId, made);
    const sibling = path.join(path.dirname(root), 'sibling');
    fs.mkdirSync(sibling);
    await cancelRun(config, runId, {});

    await sweepClones(config);

    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(receipt)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it('keeps the clone of a trial whose prompt is still leased', async () => {
    const { config, runId } = await leasedPrompt();
    const { receipt, root } = crashedTrial(config, runId, ['r']);

    await sweepClones(config, runId);

    expect(fs.existsSync(path.join(root, 'r'))).toBe(true);
    expect(fs.existsSync(receipt)).toBe(true);
  });
});
