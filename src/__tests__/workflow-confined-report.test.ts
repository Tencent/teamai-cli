import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { knownSecrets } from '../env-resolution.js';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import type { ConfinedRunReport } from '../workflow/step-state.js';
import { DriverNameSchema } from '../workflow/driver-name.js';
import { readRun, runFilePath, runScratchDir } from '../workflow/store.js';
import type { DriverIdentity, WorkflowEnvelope } from '../workflow/types.js';

const JUDGE = `schemaVersion: v1alpha1
name: judge
description: Answer from one directory.
steps:
  - id: judge
    prompt: Answer from the files there.
    workspace: { confined: evidence }
    output: { answer: string }
`;

const driver: DriverIdentity = { kind: 'external', machine: 'm1', workspace: '/w' };
const LeaseSchema = z.object({ attempt: z.string(), revision: z.number() });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

async function fixture(): Promise<LocalConfig> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-confined-report-')));
  roots.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'workflows', 'judge.yaml'), JUDGE);
  const config: LocalConfig = { repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  await syncScorersThenWorkflows(config);
  return config;
}

/**
 * Starts the judge workflow with its directory confined at `level`, leases its step to a driver that offers `offered`
 * at verified, and reports `confined` as what ran. What the step became.
 */
async function judged(config: LocalConfig, level: 'verified' | 'best-effort', confined: ConfinedRunReport | undefined, options: { edit?: (runFile: string) => void; leasedAgainOn?: string } = {}): Promise<unknown> {
  const run = String(data(await startRun(config, 'judge', {}, { secrets: await knownSecrets(config) })).run);
  fs.mkdirSync(path.join(runScratchDir(config, run), 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(runScratchDir(config, run), 'evidence', 'confined.json'), JSON.stringify({ level }));
  const can = (tool: string) => ({ confined: [{ level: 'verified' as const, access: 'read' as const, tools: [tool] }] });
  let lease = LeaseSchema.parse(data(await leaseNext(config, run, driver, { can: can('claude') })).lease);
  if (options.leasedAgainOn !== undefined) lease = LeaseSchema.parse(data(await leaseNext(config, run, driver, { can: can(options.leasedAgainOn) })).lease);
  options.edit?.(runFilePath(config, run));
  data(await reportAttempt(config, run, { ...lease, outcome: 'success', driver, outputs: { answer: 'yes' }, ...confined && { tool: confined.tool, confined } }));
  const stored = await readRun(config, run);
  return typeof stored === 'object' ? stored.steps.find((step) => step.id === 'judge') : stored;
}

describe('a confined report checked against its lease', () => {
  it('fails the step when the reported tool is not one the lease named', async () => {
    const config = await fixture();

    expect(await judged(config, 'best-effort', { tool: 'codex', isolation: 'verified', access: 'read' })).toMatchObject({
      status: 'failed', failure: { code: 'confined_report_mismatch', message: expect.stringContaining('codex') },
    });
  });

  it('fails the step when the reported isolation is below the lease\'s level, and keeps one that reaches it or more', async () => {
    const config = await fixture();

    expect(await judged(config, 'verified', { tool: 'claude', isolation: 'best-effort', access: 'read' })).toMatchObject({
      status: 'failed', failure: { code: 'confined_report_mismatch', message: expect.stringContaining('best-effort') },
    });
    expect(await judged(config, 'best-effort', { tool: 'claude', isolation: 'verified', access: 'read' })).toMatchObject({ status: 'succeeded' });
  });

  it('fails a success that names no confined run, so nothing shows the step ran confined', async () => {
    const config = await fixture();

    expect(await judged(config, 'best-effort', undefined)).toMatchObject({
      status: 'failed', failure: { code: 'confined_report_mismatch', message: expect.stringContaining('names no confined run') },
    });
  });

  it('does not check a lease granted before its terms were kept', async () => {
    const config = await fixture();
    const unkept = (file: string): void => {
      const run = z.object({ steps: z.array(z.object({ lease: z.object({ confined: z.unknown().optional() }).passthrough().optional() }).passthrough()) }).passthrough().parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      for (const step of run.steps) delete step.lease?.confined;
      fs.writeFileSync(file, JSON.stringify(run));
    };

    expect(await judged(config, 'best-effort', { tool: 'codex', isolation: 'best-effort', access: 'read' }, { edit: unkept })).toMatchObject({ status: 'succeeded' });
  });

  it('checks a report against the terms the lease was last given, when the driver asks for it again with other offers', async () => {
    const config = await fixture();

    expect(await judged(config, 'best-effort', { tool: 'codex', isolation: 'verified', access: 'read' }, { leasedAgainOn: 'codex' })).toMatchObject({ status: 'succeeded' });
  });
});

describe('a run started awaiting a driver', () => {
  it('keeps awaiting it while a driver that asks is given no lease, and no longer once one takes a lease', async () => {
    const config = await fixture();
    const awaits = { driver: DriverNameSchema.parse('acme-sandbox') };
    const run = String(data(await startRun(config, 'judge', {}, { secrets: await knownSecrets(config), awaits })).run);
    fs.mkdirSync(path.join(runScratchDir(config, run), 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(runScratchDir(config, run), 'evidence', 'confined.json'), JSON.stringify({ level: 'best-effort' }));

    expect(data(await leaseNext(config, run, driver, { can: {} }))).not.toHaveProperty('lease');
    expect(await readRun(config, run)).toMatchObject({ awaits });

    expect(data(await leaseNext(config, run, driver, { can: { confined: [{ level: 'verified', access: 'read', tools: ['claude'] }] } }))).toHaveProperty('lease');
    expect(await readRun(config, run)).not.toHaveProperty('awaits');
  });
});
