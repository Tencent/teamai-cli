import { autoDetectInit } from './config.js';
import { setStderrOnly } from './utils/logger.js';
import { leaseNext, parseNextPayload, parseReport, parseResponsePayload, reportAttempt, startRun, withIgnored, type ParsedResponsePayload } from './workflow/engine.js';
import { cancelRun, respondToHitl, retryStep } from './workflow/run-controls.js';
import { localDriver, runLocalDriver } from './workflow/local-driver.js';
import { scopedToolPaths, type LocalConfig, type TeamaiConfig } from './types.js';
import { isRunId, readRun } from './workflow/store.js';
import { headCommit } from './workflow/worktree.js';
import type { WorkflowEnvelope } from './workflow/types.js';

function writeEnvelope(envelope: WorkflowEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  if ('error' in envelope) {
    process.exitCode = 1;
    return;
  }
  const done = envelope.data.done;
  if (done && typeof done === 'object' && ['failed', 'cancelled'].includes(String((done as { outcome?: unknown }).outcome))) {
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

export async function workflowStart(name: string, options: { driver?: string; tools?: string; inputs?: string; autoApprove?: boolean }): Promise<void> {
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
  const base = await headCommit(process.cwd());
  const started = await startRun(config, name, inputs, base ? { base, checkout: process.cwd() } : {});
  if ('error' in started || options.driver !== 'local') {
    writeEnvelope(started);
    return;
  }
  const runId = started.data.run;
  if (typeof runId !== 'string') {
    writeEnvelope({ error: { code: 'run_unreadable', message: 'The new run id was missing' } });
    return;
  }
  writeEnvelope(await runLocalDriver(config, runId, process.cwd(), { tools, toolPaths: scopedToolPaths(teamConfig, config), autoApprove: options.autoApprove }));
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


async function workflowControl(operation: (config: LocalConfig) => Promise<WorkflowEnvelope>): Promise<void> {
  setStderrOnly(true);
  const loaded = await readyConfig();
  if (loaded) writeEnvelope(await operation(loaded.config));
}

/** Records a HITL answer with terminal or declared driver UI provenance. */
export async function workflowRespond(runId: string, step: string, choice: string, options: { note?: string; pass?: string; json?: string }): Promise<void> {
  const pass = options.pass === undefined ? undefined : Number(options.pass);
  if (pass !== undefined && (!/^\d+$/.test(options.pass!) || !Number.isSafeInteger(pass) || pass < 1)) {
    writeEnvelope({ error: { code: 'invalid_pass', message: 'Pass --pass as a positive integer identifying the HITL pass' } });
    return;
  }
  let driverAnswer: ParsedResponsePayload | undefined;
  if (options.json !== undefined) {
    const payload = readJson(options.json, 'Pass --json with a driver object');
    if (!payload.ok) {
      writeEnvelope(payload.envelope);
      return;
    }
    const declared = parseResponsePayload(payload.value);
    if (typeof declared === 'string') {
      writeEnvelope({ error: { code: 'invalid_json', message: declared } });
      return;
    }
    driverAnswer = declared;
  }
  await workflowControl(async (config) => withIgnored(await respondToHitl(config, runId, {
    step, choice, ...(options.note !== undefined ? { note: options.note } : {}), ...(pass !== undefined ? { pass } : {}),
    ...(driverAnswer ? driverAnswer.response
      : { channel: process.stdin.isTTY ? 'tty' : 'cli', agent: !process.stdin.isTTY }),
  }), driverAnswer?.ignored ?? []));
}

/** Retries a step without starting another local driver. */
export async function workflowRetry(runId: string, step: string): Promise<void> {
  await workflowControl((config) => retryStep(config, runId, step));
}

/** Cancels a run or step through the shared control operation. */
export async function workflowCancel(runId: string, step?: string): Promise<void> {
  await workflowControl((config) => cancelRun(config, runId, step));
}

/** Continues a local run in its retained workspace and claims its driver lock. */
export async function workflowResume(runId: string, options: { tools?: string; autoApprove?: boolean }): Promise<void> {
  setStderrOnly(true);
  const loaded = await readyConfig();
  if (!loaded) return;
  if (!isRunId(runId)) {
    writeEnvelope({ error: { code: 'invalid_run', message: 'Run id must look like r followed by 8 or 16 hex digits' } });
    return;
  }
  const tools = parseTools(options.tools);
  if (typeof tools === 'string') {
    writeEnvelope({ error: { code: 'invalid_tools', message: tools } });
    return;
  }
  const stored = await readRun(loaded.config, runId);
  if (typeof stored !== 'object') {
    writeEnvelope(stored === 'missing'
      ? { error: { code: 'run_not_found', message: `Run ${runId} was not found` } }
      : { error: { code: 'run_unreadable', message: `Run ${runId} could not be read` } });
    return;
  }
  const local = localDriver(process.cwd());
  const lease = stored.steps.find((step) => step.status === 'leased' && step.lease.driver.kind === 'local' && step.lease.driver.machine === local.machine);
  const cwd = lease?.status === 'leased' ? lease.lease.driver.workspace
    : stored.driver?.kind === 'local' && stored.driver.machine === local.machine ? stored.driver.workspace : process.cwd();
  writeEnvelope(await runLocalDriver(loaded.config, runId, cwd, { tools, toolPaths: scopedToolPaths(loaded.teamConfig, loaded.config), autoApprove: options.autoApprove }));
}
