import { autoDetectInit } from './config.js';
import { setStderrOnly } from './utils/logger.js';
import { leaseNext, parseNextPayload, parseReport, reportAttempt, startRun, withIgnored } from './workflow/engine.js';
import { runLocalDriver } from './workflow/local-driver.js';
import { scopedToolPaths, type LocalConfig, type TeamaiConfig } from './types.js';
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

async function loadConfig(): Promise<{ config: LocalConfig; teamConfig: TeamaiConfig } | WorkflowEnvelope> {
  try {
    const { localConfig, teamConfig } = await autoDetectInit();
    return { config: localConfig, teamConfig };
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

async function readyConfig(): Promise<{ config: LocalConfig; teamConfig: TeamaiConfig } | undefined> {
  const loaded = await loadConfig();
  if (!('config' in loaded)) {
    writeEnvelope(loaded);
    return undefined;
  }
  return loaded;
}

function parseTools(value: string | undefined): Record<string, string> | string {
  if (value === undefined) return {};
  const tools: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim();
    const tool = pair.slice(separator + 1).trim();
    if (separator < 1 || name === '' || tool === '') return 'Pass --tools as comma-separated name=tool pairs';
    tools[name] = tool;
  }
  return tools;
}

export async function workflowStart(name: string, options: { driver?: string; tools?: string; inputs?: string }): Promise<void> {
  setStderrOnly(true);
  const loaded = await readyConfig();
  if (!loaded) return;
  const { config, teamConfig } = loaded;
  if (options.driver !== undefined && options.driver !== 'local') {
    writeEnvelope({ error: { code: 'unsupported_driver', message: `Driver "${options.driver}" is not available. Use --driver local.` } });
    return;
  }
  const tools = parseTools(options.tools);
  if (typeof tools === 'string') {
    writeEnvelope({ error: { code: 'invalid_tools', message: tools } });
    return;
  }
  let inputs: unknown = {};
  if (options.inputs !== undefined) {
    try {
      inputs = JSON.parse(options.inputs) as unknown;
    } catch {
      writeEnvelope({ error: { code: 'invalid_json', message: 'Could not parse --inputs as JSON' } });
      return;
    }
  }
  const started = await startRun(config, name, inputs);
  if ('error' in started || options.driver !== 'local') {
    writeEnvelope(started);
    return;
  }
  const runId = started.data.run;
  if (typeof runId !== 'string') {
    writeEnvelope({ error: { code: 'run_unreadable', message: 'The new run id was missing' } });
    return;
  }
  writeEnvelope(await runLocalDriver(config, runId, process.cwd(), { tools, toolPaths: scopedToolPaths(teamConfig, config) }));
}

export async function workflowNext(runId: string, options: { json?: string }): Promise<void> {
  setStderrOnly(true);
  const loaded = await readyConfig();
  if (!loaded) return;
  const { config } = loaded;
  const payload = readJson(options.json, 'Pass --json with a driver object');
  if (!payload.ok) {
    writeEnvelope(payload.envelope);
    return;
  }
  const parsed = parseNextPayload(payload.value);
  if (typeof parsed === 'string') {
    writeEnvelope({ error: { code: 'invalid_json', message: parsed } });
    return;
  }
  const { driver, ...next } = parsed.request;
  writeEnvelope(withIgnored(await leaseNext(config, runId, driver, next), parsed.ignored));
}

export async function workflowReport(runId: string, options: { json?: string }): Promise<void> {
  setStderrOnly(true);
  const loaded = await readyConfig();
  if (!loaded) return;
  const { config } = loaded;
  const payload = readJson(options.json, 'Pass --json with attempt, revision, outcome, and driver');
  if (!payload.ok) {
    writeEnvelope(payload.envelope);
    return;
  }
  const parsed = parseReport(payload.value);
  if (typeof parsed === 'string') {
    writeEnvelope({ error: { code: 'invalid_report', message: parsed } });
    return;
  }
  writeEnvelope(withIgnored(await reportAttempt(config, runId, parsed.report), parsed.ignored));
}
