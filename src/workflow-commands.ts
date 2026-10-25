import path from 'node:path';
import { autoDetectInit, loadTeamConfig } from './config.js';
import { resolveWorkflowEnv, type WorkflowEnv } from './env-resolution.js';
import { isLeaseRef } from './scorers/entry.js';
import { log, setStderrOnly } from './utils/logger.js';
import { collectEnvSecrets, redactJson } from './utils/redact.js';
import { parseNextPayload, parseReport, parseResponsePayload, resumableSessions, withIgnored, type ParsedResponsePayload } from './workflow/engine.js';
import { publishRun, resumeRun } from './workflow/handoff.js';
import { callerProvenance, cancelRun, respondProvenance, respondToHitl, retryStep } from './workflow/run-controls.js';
import { runLocalDriver, withDriverLock } from './workflow/drivers/local/local-driver.js';
import { driverIdentity } from './driver-identity.js';
import { getBusinessRoot, getDataHome, scopedToolPaths, type LocalConfig, type TeamaiConfig } from './types.js';
import { AttemptIdSchema, isRunId, readRun } from './workflow/store.js';
import { inProcessClient, type NextPrepare } from './workflow/protocol.js';
import { parseSkillCall, runSkillCall, skillContext } from './workflow/drivers/skill/skill-driver.js';
import { loadCachedWorkflow } from './workflow/cache.js';
import { findRunConfig } from './workflow/run-location.js';
import { agentEvidence } from './workflow/attempt-marker.js';
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

async function loadConfig(readOnly = false): Promise<{ config: LocalConfig; teamConfig: TeamaiConfig } | WorkflowEnvelope> {
  try {
    const { localConfig, teamConfig } = await autoDetectInit(undefined, readOnly ? { dryRun: true, selfHeal: false, suppressMigrationNotice: true } : {});
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

async function runOwner(runId: string, allowRemote: boolean): Promise<{ config: LocalConfig; teamConfig: TeamaiConfig } | undefined> {
  const current = await loadConfig(true);
  const found = await findRunConfig(runId, 'config' in current ? current.config : undefined);
  if (!('config' in found)) {
    if (allowRemote && 'error' in found && found.error.code === 'run_not_found' && 'config' in current) return current;
    writeEnvelope(found, collectEnvSecrets()); return undefined;
  }
  if ('config' in current && getDataHome(current.config) === getDataHome(found.config) && getBusinessRoot(current.config) === getBusinessRoot(found.config)) return { config: found.config, teamConfig: current.teamConfig };
  const teamConfig = await loadTeamConfig(found.config.repo.localPath);
  if (!teamConfig) { writeEnvelope({ error: { code: 'not_initialized', message: 'The run owning team configuration cannot be read' } }, collectEnvSecrets()); return undefined; }
  return { config: found.config, teamConfig };
}

/** The config of the team that owns `runId`, whatever the cwd, and that team's env resolved as `readyConfig` does. */
async function readyRunConfig(runId: string, allowRemote = false): Promise<{ config: LocalConfig; teamConfig: TeamaiConfig; env: WorkflowEnv; secrets: Record<string, string> } | undefined> {
  const owner = await runOwner(runId, allowRemote);
  if (!owner) return undefined;
  const env = await resolveWorkflowEnv(owner.config);
  return { ...owner, env, secrets: env.secrets };
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

/** Runs a `--driver skill` call: the skill driver answers with a describe reply, a turn, or an error naming what to run. */
async function workflowSkill(raw: Parameters<typeof parseSkillCall>[0]): Promise<void> {
  setStderrOnly(true);
  const call = parseSkillCall(raw, process.env);
  if ('error' in call) {
    writeEnvelope(call, collectEnvSecrets());
    return;
  }
  const loaded = call.kind === 'next' || call.kind === 'report' || call.kind === 'respond' ? await readyRunConfig(call.run) : await readyConfig();
  if (!loaded) return;
  const context = await skillContext({ config: loaded.config, env: loaded.env, cwd: process.cwd(), trace: (row) => log.debug(`[workflow] skill driver took row ${row}`) });
  writeEnvelope(await runSkillCall(call, context), loaded.secrets);
}

/** `judge` is false with `--no-judge`. */
export async function workflowStart(name: string, options: {
  driver?: string; tools?: string; inputs?: string; autoApprove?: boolean; describe?: boolean; parallel?: string; confirmed?: boolean; hitl?: string; judge?: boolean;
}): Promise<void> {
  if (options.driver === 'skill') {
    const { driver: _skill, ...rest } = options;
    await workflowSkill({ kind: 'start', name, options: rest });
    return;
  }
  setStderrOnly(true);
  if (options.parallel !== undefined || options.hitl !== undefined || options.judge === false) {
    writeEnvelope({ error: { code: 'invalid_arguments', message: '--parallel, --hitl and --no-judge need --driver skill' } }, collectEnvSecrets());
    return;
  }
  const loaded = await readyConfig();
  if (!loaded) return;
  const { config, teamConfig, env, secrets } = loaded;
  if (options.describe) {
    const cached = await loadCachedWorkflow(config, name);
    if (!cached) writeEnvelope({ error: { code: 'workflow_not_found', message: `Workflow or alias ${name} has no unambiguous runnable version` } }, secrets);
    else { const { name, description, alias, invoke, inputs } = cached.definition; writeEnvelope({ data: { name, description, ...(alias ? { alias } : {}), invoke: invoke ?? 'deny', inputs: inputs ?? {} } }, secrets); }
    return;
  }
  if (options.driver !== undefined && options.driver !== 'local') {
    writeEnvelope({ error: { code: 'unsupported_driver', message: `Driver "${options.driver}" is not available. Use --driver local or --driver skill.` } }, secrets);
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
  const caller = { evidence: agentEvidence(process.env), confirmed: options.confirmed === true };
  const started = await inProcessClient({ config, env }).start(name, { inputs, checkout: process.cwd(), caller });
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

export async function workflowNext(runId: string, options: {
  json?: string; prepare?: boolean; attempt?: string; adopt?: string; driver?: string; wait?: boolean; takeover?: boolean; choice?: string; ack?: string;
}): Promise<void> {
  const { driver: kind, ...rest } = options;
  if (kind === 'skill') {
    await workflowSkill({ kind: 'next', run: runId, options: rest });
    return;
  }
  setStderrOnly(true);
  const skillOnly = options.wait ? '--wait needs --driver skill'
    : options.takeover ? '--takeover needs --driver skill'
      : options.choice !== undefined ? '--choice needs --driver skill'
        : options.ack !== undefined ? '--ack needs --driver skill' : undefined;
  const prepareOnly = options.adopt !== undefined && options.attempt === undefined ? '--adopt needs --attempt, the attempt whose place the host made'
    : options.attempt !== undefined && !options.prepare ? '--attempt needs --prepare' : undefined;
  const refused = kind !== undefined ? `next takes --driver skill, not --driver ${kind}` : skillOnly ?? prepareOnly;
  if (refused !== undefined) {
    writeEnvelope({ error: { code: 'invalid_arguments', message: refused } }, collectEnvSecrets());
    return;
  }
  const attempt = options.attempt === undefined ? undefined : AttemptIdSchema.safeParse(options.attempt);
  if (attempt && !attempt.success) {
    writeEnvelope({ error: { code: 'invalid_arguments', message: `--attempt takes the attempt of a lease, such as a1b2c3d4e; got ${options.attempt}` } }, collectEnvSecrets());
    return;
  }
  const prepare: NextPrepare | undefined = attempt
    ? { attempt: attempt.data, ...(options.adopt !== undefined ? { adopt: path.resolve(options.adopt) } : {}) }
    : options.prepare ? true : undefined;
  const payload = readJson(options.json, 'Pass --json with a driver object');
  if (!payload.ok) {
    writeEnvelope(payload.envelope, collectEnvSecrets());
    return;
  }
  const parsed = parseNextPayload(payload.value);
  if (typeof parsed === 'string') {
    writeEnvelope({ error: { code: 'invalid_json', message: parsed } }, collectEnvSecrets());
    return;
  }
  const loaded = await readyRunConfig(runId, parsed.request.claim === true);
  if (!loaded) return;
  const { config, env, secrets } = loaded;
  writeEnvelope(await inProcessClient({ config, env }).next(runId, payload.value, prepare ? { prepare } : undefined), secrets);
}

export async function workflowReport(runId: string, options: { json?: string; driver?: string; attempt?: string; modelUnavailable?: boolean }): Promise<void> {
  const { driver: kind, ...rest } = options;
  if (kind === 'skill') {
    await workflowSkill({ kind: 'report', run: runId, options: rest });
    return;
  }
  setStderrOnly(true);
  const skillOnly = options.attempt !== undefined ? '--attempt needs --driver skill'
    : options.modelUnavailable ? '--model-unavailable needs --driver skill' : undefined;
  const refused = kind !== undefined ? `report takes --driver skill, not --driver ${kind}` : skillOnly;
  if (refused !== undefined) {
    writeEnvelope({ error: { code: 'invalid_arguments', message: refused } }, collectEnvSecrets());
    return;
  }
  if (isLeaseRef(runId)) {
    writeEnvelope({ error: { code: 'judge_lease', message: `${runId} is a judge lease, which workflow report does not settle. Submit its answer with: teamai score --lease ${runId} --submit --stdin` } }, collectEnvSecrets());
    return;
  }
  const payload = readJson(options.json, 'Pass --json with attempt, revision, outcome, and driver');
  if (!payload.ok) {
    writeEnvelope(payload.envelope, collectEnvSecrets());
    return;
  }
  const parsed = parseReport(payload.value);
  if (typeof parsed === 'string') {
    writeEnvelope({ error: { code: 'invalid_report', message: parsed } }, collectEnvSecrets());
    return;
  }
  const loaded = await readyRunConfig(runId);
  if (!loaded) return;
  const { config, env, secrets } = loaded;
  writeEnvelope(await inProcessClient({ config, env }).report(runId, payload.value), secrets);
}


async function workflowControl(runId: string, operation: (config: LocalConfig, secrets: Record<string, string>) => Promise<WorkflowEnvelope>): Promise<void> {
  setStderrOnly(true);
  const loaded = await readyRunConfig(runId);
  if (loaded) writeEnvelope(await operation(loaded.config, loaded.secrets), loaded.secrets);
}

/**
 * Records a HITL answer with the provenance decided from this process and the driver UI `--json` declares. With
 * `--driver skill`, the skill driver records the agent's answer to an optional gate.
 */
export async function workflowRespond(runId: string, step: string, choice: string, options: { note?: string; pass?: string; json?: string; driver?: string }): Promise<void> {
  const { driver: kind, ...rest } = options;
  if (kind === 'skill') {
    await workflowSkill({ kind: 'respond', run: runId, step, choice, options: rest });
    return;
  }
  if (kind !== undefined) {
    setStderrOnly(true);
    writeEnvelope({ error: { code: 'invalid_arguments', message: `respond takes --driver skill, not --driver ${kind}` } }, collectEnvSecrets());
    return;
  }
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
  const caller = callerProvenance(process.env, process.stdin);
  const provenance = respondProvenance(driverAnswer ? { kind: 'driver-json', driver: driverAnswer.driver, caller } : { kind: 'terminal', caller });
  await workflowControl(runId, async (config, secrets) => withIgnored(await respondToHitl(config, runId, secrets, {
    step, choice, ...(options.note !== undefined ? { note: options.note } : {}), ...(pass !== undefined ? { pass } : {}), provenance,
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
  const loaded = await readyRunConfig(runId, true);
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
    const local = driverIdentity('local', process.cwd());
    const lease = stored.steps.find((step) => step.status === 'leased' && step.lease.driver.kind === 'local' && step.lease.driver.machine === local.machine);
    const cwd = lease?.status === 'leased' ? lease.lease.driver.workspace
      : stored.driver?.kind === 'local' && stored.driver.machine === local.machine ? stored.driver.workspace : process.cwd();
    return drive(cwd, { tools, toolPaths: scopedToolPaths(loaded.teamConfig, loaded.config), autoApprove: options.autoApprove });
  }), secrets);
}
