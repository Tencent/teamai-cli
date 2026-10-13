import { autoDetectInit } from './config.js';
import { setStderrOnly } from './utils/logger.js';
import { leaseNext, parseDriverPayload, parseReport, reportAttempt, startRun } from './workflow/engine.js';
import { runLocalDriver } from './workflow/local-driver.js';
import type { LocalConfig } from './types.js';
import type { WorkflowEnvelope } from './workflow/types.js';

function writeEnvelope(envelope: WorkflowEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  if ('error' in envelope) {
    process.exitCode = 1;
    return;
  }
  const done = envelope.data.done;
  if (done && typeof done === 'object' && (done as { outcome?: unknown }).outcome === 'failed') {
    process.exitCode = 1;
  }
}

async function loadConfig(): Promise<{ config: LocalConfig } | WorkflowEnvelope> {
  try {
    const { localConfig } = await autoDetectInit();
    return { config: localConfig };
  } catch (error) {
    return {
      error: {
        code: 'not_initialized',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

type JsonRead =
  | { ok: true; value: unknown }
  | { ok: false; envelope: WorkflowEnvelope };

function readJson(payload: string | undefined, missing: string): JsonRead {
  if (payload === undefined || payload.trim() === '') {
    return { ok: false, envelope: { error: { code: 'invalid_json', message: missing } } };
  }
  try {
    return { ok: true, value: JSON.parse(payload) as unknown };
  } catch {
    return { ok: false, envelope: { error: { code: 'invalid_json', message: 'Could not parse --json payload' } } };
  }
}

async function readyConfig(): Promise<LocalConfig | undefined> {
  const loaded = await loadConfig();
  if (!('config' in loaded)) {
    writeEnvelope(loaded);
    return undefined;
  }
  return loaded.config;
}

export async function workflowStart(name: string, options: { driver?: string }): Promise<void> {
  setStderrOnly(true);
  const config = await readyConfig();
  if (!config) return;
  if (options.driver !== undefined && options.driver !== 'local') {
    writeEnvelope({ error: { code: 'unsupported_driver', message: `Driver "${options.driver}" is not available. Use --driver local.` } });
    return;
  }
  const started = await startRun(config, name);
  if ('error' in started || options.driver !== 'local') {
    writeEnvelope(started);
    return;
  }
  const runId = started.data.run;
  if (typeof runId !== 'string') {
    writeEnvelope({ error: { code: 'run_unreadable', message: 'The new run id was missing' } });
    return;
  }
  writeEnvelope(await runLocalDriver(config, runId, process.cwd()));
}

export async function workflowNext(runId: string, options: { json?: string }): Promise<void> {
  setStderrOnly(true);
  const config = await readyConfig();
  if (!config) return;
  const payload = readJson(options.json, 'Pass --json with a driver object');
  if (!payload.ok) {
    writeEnvelope(payload.envelope);
    return;
  }
  const driver = parseDriverPayload(payload.value);
  if (typeof driver === 'string') {
    writeEnvelope({ error: { code: 'invalid_json', message: driver } });
    return;
  }
  writeEnvelope(await leaseNext(config, runId, driver));
}

export async function workflowReport(runId: string, options: { json?: string }): Promise<void> {
  setStderrOnly(true);
  const config = await readyConfig();
  if (!config) return;
  const payload = readJson(options.json, 'Pass --json with attempt, revision, outcome, and driver');
  if (!payload.ok) {
    writeEnvelope(payload.envelope);
    return;
  }
  const report = parseReport(payload.value);
  if (typeof report === 'string') {
    writeEnvelope({ error: { code: 'invalid_report', message: report } });
    return;
  }
  writeEnvelope(await reportAttempt(config, runId, report));
}
