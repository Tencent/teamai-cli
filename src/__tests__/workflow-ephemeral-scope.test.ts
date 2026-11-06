import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { autoDetectInit, loadLocalConfig, NotInitializedError, requireInit } from '../config.js';
import { resolveWorkflowEnv } from '../env-resolution.js';
import { getDataHome } from '../types.js';
import { EphemeralScope } from '../workflow/ephemeral-scope.js';
import { inProcessClient } from '../workflow/protocol.js';
import { RunIdSchema } from '../workflow/store.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function checkout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-ephemeral-checkout-')); dirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });

  return dir;
}

const LeaseSchema = z.object({ step: z.string(), env: z.record(z.string(), z.string()) }).passthrough();

const driver = { kind: 'ide', machine: 'test', workspace: '/work', can: { hitl: false, workspace: ['read-only', 'new', 'continue'] } };

describe('a run with no teamai init', () => {
  it('gives every process of its steps the config built for the run, which a process in any directory loads, until the run removes it', async () => {
    const work = checkout();
    const scope = await EphemeralScope.open(work);
    const client = inProcessClient({ config: scope.config, env: await resolveWorkflowEnv(scope.config) });
    const inputs = { wiki_root: path.join(work, 'wiki'), project: 'widget', max_modules: 0, concurrency: 1 };

    const started = await client.start('teamai-codebase-deep-enrich', { inputs, checkout: work, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' }, startedBy: 'person' });
    if (!('data' in started)) throw new Error(JSON.stringify(started));
    const next = await client.next(RunIdSchema.parse(started.data.run), { driver });
    if (!('data' in next) || !('lease' in next.data)) throw new Error(JSON.stringify(next));
    const lease = LeaseSchema.parse(next.data.lease);

    const file = scope.config.ephemeralConfig;
    expect(file).toBeDefined();
    expect(lease).toMatchObject({ step: 'plan', env: { TEAMAI_EPHEMERAL_CONFIG: file } });
    expect(lease.env.TEAMAI_RUN_DIR?.startsWith(getDataHome(scope.config))).toBe(true);

    vi.stubEnv('TEAMAI_EPHEMERAL_CONFIG', lease.env.TEAMAI_EPHEMERAL_CONFIG);
    const elsewhere = checkout();
    const loaded = await autoDetectInit(elsewhere, { dryRun: true, selfHeal: false, children: false });
    expect(getDataHome(loaded.localConfig)).toBe(getDataHome(scope.config));
    expect(loaded.localConfig.ephemeralConfig).toBe(file);

    await scope.close();

    await expect(autoDetectInit(elsewhere, { dryRun: true, selfHeal: false, children: false })).rejects.toBeInstanceOf(NotInitializedError);
    expect(fs.existsSync(path.join(os.homedir(), '.teamai', 'workflows'))).toBe(false);
  });

  it('gives a process of its steps that loads the member config directly the run\'s config too', async () => {
    const scope = await EphemeralScope.open(checkout());
    const file = scope.config.ephemeralConfig;
    expect(file).toBeDefined();
    vi.stubEnv('TEAMAI_EPHEMERAL_CONFIG', file);

    try {
      const { localConfig, teamConfig } = await requireInit({ dryRun: true });
      expect(localConfig.ephemeralConfig).toBe(file);
      expect(getDataHome(localConfig)).toBe(getDataHome(scope.config));
      expect(teamConfig.team).toBe(scope.teamConfig.team);
      expect((await loadLocalConfig({ dryRun: true }))?.ephemeralConfig).toBe(file);
    } finally {
      await scope.close();
    }
  });
});
