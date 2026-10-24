import { autoDetectInit } from './config.js';
import { resolveWorkflowEnv, type WorkflowEnv } from './env-resolution.js';
import { isLeaseRef } from './scorers/entry.js';
import { log, setStderrOnly } from './utils/logger.js';
import { collectEnvSecrets, redactJson } from './utils/redact.js';
import { leaseNext, parseNextPayload, parseReport, parseResponsePayload, reportAttempt, resumableSessions, startRun, withIgnored, type ParsedResponsePayload } from './workflow/engine.js';
import { publishRun, resumeRun } from './workflow/handoff.js';
import { cancelRun, respondToHitl, retryStep } from './workflow/run-controls.js';
import { localDriver, runLocalDriver, withDriverLock } from './workflow/local-driver.js';
import type { LocalConfig, TeamaiConfig } from './types.js';
import { isRunId, readRun } from './workflow/store.js';
import { headCommit } from './workflow/worktree.js';
import type { WorkflowEnvelope } from './workflow/types.js';

/** Prints `envelope` with each of `secrets` masked, and sets the exit code from the envelope as the operation returned it. */
function writeEnvelope(envelope: WorkflowEnvelope, secrets: Record<string, string>): void {
  process.stdout.write(`${JSON.stringify(redactJson(envelope, secrets))}\n`);
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

/**
 * The member's config, and the team env resolved once for the command: the secrets every envelope it prints masks, which
 * the operation offers against and masks its writes with.
 */
async function readyConfig(): Promise<{ config: LocalConfig; teamConfig: TeamaiConfig; env: WorkflowEnv; secrets: Record<string, string> } | undefined> {
  const loaded = await loadConfig();
  if (!('config' in loaded)) {
    writeEnvelope(loaded, collectEnvSecrets());
    return undefined;
  }
  const env = await resolveWorkflowEnv(loaded.config);
  return { ...loaded, env, secrets: env.secrets };
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
  const { config, teamConfig, secrets } = loaded;
  if (options.driver !== undefined && options.driver !== 'local') {
    writeEnvelope({ error: { code: 'unsupported_driver', message: `Driver "${options.driver}" is not available. Use --driver local.` } }, secrets);
    return;
  }
  const tools = parseTools(options.tools);
  if (typeof tools === 'string') {
    writeEnvelope({ error: { code: 'invalid_tools', message: tools } }, secrets);
    return;
  }
  let inputs: unknown = {};
  if (options.inputs !== undefined) {
    try {
      inputs = JSON.parse(options.inputs) as unknown;
    } catch {
      writeEnvelope({ error: { code: 'invalid_json', message: 'Could not parse --inputs as JSON' } }, secrets);
      return;
    }
  }
  const base = await headCommit(process.cwd());
  const started = await startRun(config, name, inputs, { secrets, ...(base ? { base, checkout: process.cwd() } : {}) });
  if ('error' in started || options.driver !== 'local') {
    writeEnvelope(started, secrets);
    return;
  }
  const runId = started.data.run;
  if (typeof runId !== 'string') {
    writeEnvelope({ error: { code: 'run_unreadable', message: 'The new run id was missing' } }, secrets);
    return;
  }
  log.info(`Run ${runId} started. If it stops before it ends, continue it with: teamai workflow resume ${runId}`);
  writeEnvelope(await runLocalDriver(config, runId, process.cwd(), { tools, toolPaths: teamConfig.toolPaths, autoApprove: options.autoApprove }), secrets);
}

export async function workflowNext(runId: string, options: { json?: string }): Promise<void> {
  setStderrOnly(true);
  const loaded = await readyConfig();
  if (!loaded) return;
  const { config, env, secrets } = loaded;
  const payload = readJson(options.json, 'Pass --json with a driver object');
  if (!payload.ok) {
    writeEnvelope(payload.envelope, secrets);
    return;
  }
  const parsed = parseNextPayload(payload.value);
  if (typeof parsed === 'string') {
    writeEnvelope({ error: { code: 'invalid_json', message: parsed } }, secrets);
    return;
  }
  const { driver, ...next } = parsed.request;
  writeEnvelope(withIgnored(await leaseNext(config, runId, driver, { ...next, env }), parsed.ignored), secrets);
}

export async function workflowReport(runId: string, options: { json?: string }): Promise<void> {
  setStderrOnly(true);
  const loaded = await readyConfig();
  if (!loaded) return;
  const { config, secrets } = loaded;
  if (isLeaseRef(runId)) {
    writeEnvelope({ error: { code: 'judge_lease', message: `${runId} is a judge lease, which workflow report does not settle. Submit its answer with: teamai score --lease ${runId} --submit --stdin` } }, secrets);
    return;
  }
  const payload = readJson(options.json, 'Pass --json with attempt, revision, outcome, and driver');
  if (!payload.ok) {
    writeEnvelope(payload.envelope, secrets);
    return;
  }
  const parsed = parseReport(payload.value);
  if (typeof parsed === 'string') {
    writeEnvelope({ error: { code: 'invalid_report', message: parsed } }, secrets);
    return;
  }
  writeEnvelope(withIgnored(await reportAttempt(config, runId, parsed.report, secrets), parsed.ignored), secrets);
}


async function workflowControl(runId: string, operation: (config: LocalConfig, secrets: Record<string, string>) => Promise<WorkflowEnvelope>): Promise<void> {
  setStderrOnly(true);
  const loaded = await readyConfig();
  if (loaded) writeEnvelope(await operation(loaded.config, loaded.secrets), loaded.secrets);
}

/** Records a HITL answer with terminal or declared driver UI provenance. */
export async function workflowRespond(runId: string, step: string, choice: string, options: { note?: string; pass?: string; json?: string }): Promise<void> {
  const pass = options.pass === undefined ? undefined : Number(options.pass);
  if (pass !== undefined && (!/^\d+$/.test(options.pass!) || !Number.isSafeInteger(pass) || pass < 1)) {
    writeEnvelope({ error: { code: 'invalid_pass', message: 'Pass --pass as a positive integer identifying the HITL pass' } }, collectEnvSecrets());
    return;
  }
  let driverAnswer: ParsedResponsePayload | undefined;
  if (options.json !== undefined) {
    const payload = readJson(options.json, 'Pass --json with a driver object');
    if (!payload.ok) {
      writeEnvelope(payload.envelope, collectEnvSecrets());
      return;
    }
    const declared = parseResponsePayload(payload.value);
    if (typeof declared === 'string') {
      writeEnvelope({ error: { code: 'invalid_json', message: declared } }, collectEnvSecrets());
      return;
    }
    driverAnswer = declared;
  }
  await workflowControl(runId, async (config, secrets) => withIgnored(await respondToHitl(config, runId, secrets, {
    step, choice, ...(options.note !== undefined ? { note: options.note } : {}), ...(pass !== undefined ? { pass } : {}),
    ...(driverAnswer ? driverAnswer.response
      : { channel: process.stdin.isTTY ? 'tty' : 'cli', agent: !process.stdin.isTTY }),
  }), driverAnswer?.ignored ?? []));
}

/** Retries a step without starting another local driver. */
export async function workflowRetry(runId: string, step: string): Promise<void> {
  await workflowControl(runId, (config, secrets) => retryStep(config, runId, secrets, step));
}

/** Cancels a run or step through the shared control operation. */
export async function workflowCancel(runId: string, step?: string): Promise<void> {
  await workflowControl(runId, (config, secrets) => cancelRun(config, runId, secrets, step));
}

/** Publishes a run to teamai-reports, with the sessions its unsettled steps continue when asked. */
export async function workflowPublish(runId: string, options: { sessions?: boolean } = {}): Promise<void> {
  setStderrOnly(true);
  const loaded = await readyConfig();
  if (!loaded) return;
  const { secrets } = loaded;
  const published = await publishRun(loaded.config, runId, { checkout: process.cwd(), ...(options.sessions ? { sessions: resumableSessions } : {}) });
  if (published.ok && published.value.skipped) {
    const list = published.value.skipped.map((session) => `${session.tool} session ${session.id}`).join(', ');
    log.warn(`Could not read ${list} on this machine, so they were not archived. Each step that continues them resumes the newest session of its chain that was.`);
  }
  writeEnvelope(published.ok ? { data: { ...published.value } } : { error: published.error }, secrets);
}

export async function workflowResume(runId: string, options: { tools?: string; autoApprove?: boolean; claim?: boolean }): Promise<void> {
  setStderrOnly(true);
  const loaded = await readyConfig();
  if (!loaded) return;
  const { secrets } = loaded;
  if (!isRunId(runId)) {
    writeEnvelope({ error: { code: 'invalid_run', message: 'Run id must look like r followed by 8 or 16 hex digits' } }, secrets);
    return;
  }
  const tools = parseTools(options.tools);
  if (typeof tools === 'string') {
    writeEnvelope({ error: { code: 'invalid_tools', message: tools } }, secrets);
    return;
  }
  // Claimed under the driver lock, so a driver of this run already running here never drives the claimed run.
  writeEnvelope(await withDriverLock(loaded.config, runId, async (drive) => {
    const resumed = await resumeRun(loaded.config, runId, { claim: options.claim === true, checkout: process.cwd() });
    if (!resumed.ok) return { error: resumed.error };
    const stored = await readRun(loaded.config, runId);
    if (typeof stored !== 'object') {
      return stored === 'missing'
        ? { error: { code: 'run_not_found', message: `Run ${runId} was not found` } }
        : { error: { code: 'run_unreadable', message: `Run ${runId} could not be read` } };
    }
    const local = localDriver(process.cwd());
    const lease = stored.steps.find((step) => step.status === 'leased' && step.lease.driver.kind === 'local' && step.lease.driver.machine === local.machine);
    const cwd = lease?.status === 'leased' ? lease.lease.driver.workspace
      : stored.driver?.kind === 'local' && stored.driver.machine === local.machine ? stored.driver.workspace : process.cwd();
    return drive(cwd, { tools, toolPaths: loaded.teamConfig.toolPaths, autoApprove: options.autoApprove });
  }), secrets);
}
