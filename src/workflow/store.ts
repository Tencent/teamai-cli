import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { readFileSafe, writeJsonAtomic } from '../utils/fs.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { ArchivedPassSchema, DriverSchema, StepStateSchema } from './step-state.js';
import type { RunState, WorkflowDefinition } from './types.js';

/**
 * Run ids: `r` + 16 hex digits. Records are a team-wide key on the reports
 * branch (#1083), and 8 hex digits reach ~1% collision odds by 10,000 runs —
 * a collision would overwrite another member's record, so new runs get 16.
 * The legacy 8-hex form still resolves for runs created before the switch.
 */
const RUN_ID = /^r[0-9a-f]{8}(?:[0-9a-f]{8})?$/;

export function isRunId(runId: string): boolean {
  return RUN_ID.test(runId);
}

/** A fresh run id: 16 hex digits (see RUN_ID for why not 8). */
export function generateRunId(): string {
  return `r${randomBytes(8).toString('hex')}`;
}

export function runFilePath(config: LocalConfig, runId: string): string {
  return path.join(getDataHome(config), 'workflows', 'runs', `${runId}.json`);
}

export function runLockPath(config: LocalConfig, runId: string): string {
  return path.join(getDataHome(config), 'workflows', 'runs', `${runId}.lock`);
}

export function driverLockPath(config: LocalConfig, runId: string): string {
  return path.join(getDataHome(config), 'workflows', 'runs', runId, 'driver.lock');
}

function isDefinition(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== 'object') return false;
  const definition = value as WorkflowDefinition;
  return definition.schemaVersion === 'v1alpha1'
    && typeof definition.name === 'string'
    && typeof definition.description === 'string'
    && Array.isArray(definition.steps);
}

export function isRunState(value: unknown): value is RunState {
  if (!value || typeof value !== 'object') return false;
  const run = value as RunState;
  return run.schemaVersion === 'v1alpha1'
    && isRunId(run.id)
    && typeof run.name === 'string'
    && typeof run.revision === 'number'
    && (run.status === 'running' || run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled')
    && isDefinition(run.definition)
    && Array.isArray(run.steps)
    && Array.isArray(run.settledAttempts);
}

/** The parts of a run file the step union governs, with what a file written before them reads as. */
const RunProgressSchema = z.object({
  steps: z.array(StepStateSchema),
  cancelledAttempts: z.array(z.string()).default([]),
  archive: z.array(ArchivedPassSchema).default([]),
  round: z.number().int().optional(),
  /** Latest driver that called next, absent in older run files. */
  driver: DriverSchema.optional(),
});

export async function readRun(config: LocalConfig, runId: string): Promise<RunState | 'missing' | 'corrupt'> {
  const raw = await readFileSafe(runFilePath(config, runId));
  if (raw === null) return 'missing';
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRunState(value)) return 'corrupt';
    const progress = RunProgressSchema.safeParse(value);
    return progress.success ? { ...value, ...progress.data } : 'corrupt';
  } catch {
    return 'corrupt';
  }
}

export async function writeRun(config: LocalConfig, run: RunState): Promise<void> {
  await writeJsonAtomic(runFilePath(config, run.id), run);
}
