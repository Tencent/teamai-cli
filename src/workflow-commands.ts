import path from 'node:path';
import { z } from 'zod';
import { autoDetectInit, loadLocalConfigForScope, loadTeamConfig } from './config.js';
import { resolveWorkflowEnv, type WorkflowEnv } from './env-resolution.js';
import { isLeaseRef } from './scorers/entry.js';
import { log, setStderrOnly } from './utils/logger.js';
import { collectEnvSecrets, redactJson } from './utils/redact.js';
import { parseNextPayload, parseReport, parseResponsePayload, resumableSessions, withIgnored, type ParsedResponsePayload } from './workflow/engine.js';
import { publishRun, resumeRun } from './workflow/handoff.js';
import { callerProvenance, cancelRun, respondProvenance, respondToHitl, retryStep } from './workflow/run-controls.js';
import { runLocalDriver, withDriverLock } from './workflow/drivers/local/local-driver.js';
import { driverIdentity } from './driver-identity.js';
import { getBusinessRoot, getDataHome, type LocalConfig, type TeamaiConfig } from './types.js';
import { AttemptIdSchema, readRun, RunIdSchema } from './workflow/store.js';
import { inProcessClient, resumeRefusal, workflowNotFound, type InvokeCaller, type NextPrepare } from './workflow/protocol.js';
import { parseInputsFlag, parseSkillCall, runSkillCall, sessionDrivesRun, skillContext } from './workflow/drivers/skill/skill-driver.js';
import { loadCachedWorkflow } from './workflow/cache.js';
import { findRunConfig } from './workflow/run-location.js';
import { resolveRunMode } from './launch-context.js';
import { memberTools } from './tool-launch/call.js';
import { agentEvidence, isAttemptRunner, nestedCall, nestedStart, nestedWorkflowError, type Nested } from './workflow/attempt-marker.js';
import type { WorkflowEnvelope, WorkflowFailure } from './workflow/types.js';

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

/**
 * Prints what the local driver answered for a run of `config`, then, once an unattended run is done, drains the run's
 * scope as `teamai score --drain` does unless its unattended publishing and session scoring are both `off`. The run's
 * outcome keeps setting the exit code: what the drain could not do is printed.
 */
async function writeDriven(config: LocalConfig, envelope: WorkflowEnvelope, secrets: Record<string, string>): Promise<void> {
  writeEnvelope(envelope, secrets);
  if ('error' in envelope || !('done' in envelope.data) || resolveRunMode(process.env) !== 'unattended') return;
  const { Drain } = await import('./score-drain.js');
  try {
    if (!await Drain.drainsUnattendedRun(config)) return;
    log.info('Draining before exit (teamai score --drain)');
    Drain.print(await Drain.run([config], { mode: 'unattended' }));
  } catch (error) {
    log.error(`The drain stopped: ${error instanceof Error ? error.message : String(error)}. Run teamai score --drain to finish it.`);
  }
}

/**
 * Answers `nested_workflow` when `nested` says the call comes from inside a workflow attempt or, for a start, from a
 * workflow's place, before anything reads a run; true when it did. A `--driver skill` error carries `next: null`.
 */
function refusedNested(nested: Nested | undefined, skill: boolean): boolean {
  if (nested === undefined) return false;
  (skill ? refuseSkill : refuse)({ error: nestedWorkflowError(nested) });
  return true;
}

/** Prints a refusal found before any driver answers. */
function refuse(envelope: WorkflowEnvelope): void {
  writeEnvelope(envelope, collectEnvSecrets());
}

/** `refuse` for a `--driver skill` call, whose every error carries `next`: null, since nothing here names what to run. */
function refuseSkill(envelope: WorkflowEnvelope): void {
  const answer: WorkflowEnvelope | { error: WorkflowFailure & { next: null } } = 'error' in envelope ? { error: { ...envelope.error, next: null } } : envelope;
  writeEnvelope(answer, collectEnvSecrets());
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
 * A command's config, and the team env resolved once for it: the secrets every envelope it prints masks, which the
 * operation offers against and masks its writes with.
 */
interface Ready { config: LocalConfig; teamConfig: TeamaiConfig; env: WorkflowEnv; secrets: Record<string, string> }

/** The member's config as `Ready`, or the failure the caller prints. */
async function readyConfig(): Promise<Ready | WorkflowEnvelope> {
  const loaded = await loadConfig();
  if (!('config' in loaded)) return loaded;
  const env = await resolveWorkflowEnv(loaded.config);
  return { ...loaded, env, secrets: env.secrets };
}

/**
 * `readyConfig`, or the user scope's when this is a project whose cache has no runnable version of `name` and the user
 * scope's has one: the skills a user-scope pull generates show in every directory, so `start` finds what they name.
 */
async function readyStartConfig(name: string): Promise<Ready | WorkflowEnvelope> {
  const loaded = await readyConfig();
  if (!('config' in loaded) || loaded.config.scope !== 'project' || await loadCachedWorkflow(loaded.config, name)) return loaded;
  const user = await loadLocalConfigForScope('user', undefined, { dryRun: true });
  if (!user || !await loadCachedWorkflow(user, name)) return loaded;
  const teamConfig = await loadTeamConfig(user.repo.localPath);
  if (!teamConfig) return loaded;
  const env = await resolveWorkflowEnv(user);
  return { config: user, teamConfig, env, secrets: env.secrets };
}

/** `allowRemote`: a run no config here has is the current config's, as a call that may claim it from teamai-reports needs. */
async function runOwner(runId: string, { allowRemote }: { allowRemote: boolean }): Promise<{ config: LocalConfig; teamConfig: TeamaiConfig } | WorkflowEnvelope> {
  const current = await loadConfig(true);
  const found = await findRunConfig(runId, 'config' in current ? current.config : undefined);
  if (!('config' in found)) {
    if (allowRemote && 'error' in found && found.error.code === 'run_not_found' && 'config' in current) return current;
    return found;
  }
  if ('config' in current && getDataHome(current.config) === getDataHome(found.config) && getBusinessRoot(current.config) === getBusinessRoot(found.config)) return { config: found.config, teamConfig: current.teamConfig };
  const teamConfig = await loadTeamConfig(found.config.repo.localPath);
  if (!teamConfig) return { error: { code: 'not_initialized', message: 'The run owning team configuration cannot be read' } };
  return { config: found.config, teamConfig };
}

/** The config of the team that owns `runId`, whatever the cwd, and that team's env resolved as `readyConfig` does. */
async function readyRunConfig(runId: string, options: { allowRemote: boolean } = { allowRemote: false }): Promise<Ready | WorkflowEnvelope> {
  const owner = await runOwner(runId, options);
  if (!('config' in owner)) return owner;
  const env = await resolveWorkflowEnv(owner.config);
  return { ...owner, env, secrets: env.secrets };
}

/** This process as `invoke` judges it: its agent evidence and run mode, and whether it passed `--confirmed`. */
function invokeCaller(confirmed: boolean | undefined): InvokeCaller {
  return { evidence: agentEvidence(process.env), confirmed: confirmed === true, mode: resolveRunMode(process.env) };
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
  // A resume, or a takeover, readies a run this machine may lack, so the skill driver answers for it.
  const loaded = call.kind === 'describe' || call.kind === 'start' ? await readyStartConfig(call.name)
    : await readyRunConfig(call.run, { allowRemote: call.kind === 'resume' || call.kind === 'takeover' });
  if (!('config' in loaded)) {
    refuseSkill(loaded);
    return;
  }
  const context = await skillContext({
    config: loaded.config, toolPaths: loaded.teamConfig.toolPaths, env: loaded.env, cwd: process.cwd(),
    aiTools: (await memberTools(loaded.config)).map(({ tool }) => tool),
    trace: (row) => log.debug(`[workflow] skill driver took row ${row}`),
  });
  writeEnvelope(await runSkillCall(call, context), loaded.secrets);
}

/** The flags of `workflow start` and `resume` without `--driver skill`. The skill driver's flags are refused, the first given in this order. */
const NonSkillRunOptionsSchema = z.object({
  parallel: z.undefined({ invalid_type_error: '--parallel needs --driver skill' }),
  hitl: z.undefined({ invalid_type_error: '--hitl needs --driver skill' }),
  judge: z.boolean().optional().refine((judged) => judged !== false, '--no-judge needs --driver skill'),
});

/** `judge` is false with `--no-judge`. */
export async function workflowStart(name: string, options: {
  driver?: string; tools?: string; inputs?: string; autoApprove?: boolean; describe?: boolean; parallel?: string; confirmed?: boolean; hitl?: string; judge?: boolean;
}): Promise<void> {
  if (refusedNested(await nestedStart(process.env, process.cwd()), options.driver === 'skill')) return;
  if (options.driver === 'skill') {
    const { driver: _skill, ...rest } = options;
    await workflowSkill({ kind: 'start', name, options: rest });
    return;
  }
  setStderrOnly(true);
  const nonSkill = NonSkillRunOptionsSchema.safeParse(options);
  if (!nonSkill.success) {
    refuseOptions(nonSkill.error);
    return;
  }
  const loaded = await readyStartConfig(name);
  if (!('config' in loaded)) {
    refuse(loaded);
    return;
  }
  const { config, teamConfig, env, secrets } = loaded;
  if (options.describe) {
    const cached = await loadCachedWorkflow(config, name);
    if (!cached) {
      writeEnvelope({ error: workflowNotFound(name) }, secrets);
      return;
    }
    const { description, alias, invoke, inputs } = cached.definition;
    writeEnvelope({ data: { name: cached.definition.name, description, ...(alias ? { alias } : {}), invoke: invoke ?? 'deny', inputs: inputs ?? {} } }, secrets);
    return;
  }
  if (options.driver !== undefined && options.driver !== 'local') {
    writeEnvelope({ error: unsupportedDriver(options.driver) }, secrets);
    return;
  }
  const tools = parseTools(options.tools);
  if (typeof tools === 'string') {
    writeEnvelope({ error: { code: 'invalid_tools', message: tools } }, secrets);
    return;
  }
  const read = options.inputs === undefined ? { inputs: {} } : parseInputsFlag(options.inputs);
  if ('error' in read) {
    writeEnvelope({ error: read.error }, secrets);
    return;
  }
  const { inputs } = read;
  const caller = invokeCaller(options.confirmed);
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
  await writeDriven(config, await runLocalDriver(config, runId, process.cwd(), { tools, toolPaths: teamConfig.toolPaths, autoApprove: options.autoApprove }), secrets);
}

/** Refuses `--driver <kind>` on `command`, which takes only `--driver skill`, naming the kind given. */
function refusedDriverFlag(command: 'next' | 'report'): z.ZodUndefined {
  return z.undefined({ errorMap: (_issue, ctx) => ({ message: `${command} takes --driver skill, not --driver ${String(ctx.data)}` }) });
}

/**
 * The flags of `workflow next` for a driver that sends `--json`: `--prepare`, with `--attempt` for an attempt already
 * leased to it and `--adopt` for the place its host made. The skill driver's flags are refused, the first given in
 * this order.
 */
const JsonNextOptionsSchema = z.object({
  driver: refusedDriverFlag('next'),
  wait: z.boolean().optional().refine((given) => !given, '--wait needs --driver skill'),
  takeover: z.boolean().optional().refine((given) => !given, '--takeover needs --driver skill'),
  confirmed: z.boolean().optional().refine((given) => !given, '--confirmed on next needs --driver skill --takeover'),
  choice: z.undefined({ invalid_type_error: '--choice needs --driver skill' }),
  ack: z.undefined({ invalid_type_error: '--ack needs --driver skill' }),
  json: z.string().optional(),
  prepare: z.boolean().optional(),
  attempt: z.string().optional(),
  adopt: z.string().optional(),
}).superRefine((options, ctx) => {
  if (options.adopt !== undefined && options.attempt === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--adopt needs --attempt, the attempt whose place the host made' });
  else if (options.attempt !== undefined && !options.prepare) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--attempt needs --prepare' });
}).transform((options, ctx): { json?: string; prepare?: NextPrepare } => {
  const json = options.json !== undefined ? { json: options.json } : {};
  if (options.attempt === undefined) return { ...json, ...(options.prepare ? { prepare: true } : {}) };
  const attempt = AttemptIdSchema.safeParse(options.attempt);
  if (!attempt.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `--attempt takes the attempt of a lease, such as a1b2c3d4e; got ${options.attempt}` });
    return z.NEVER;
  }
  return { ...json, prepare: { attempt: attempt.data, ...(options.adopt !== undefined ? { adopt: path.resolve(options.adopt) } : {}) } };
});

/** The flags of `workflow report` for a driver that sends `--json`. The skill driver's flags are refused. */
const JsonReportOptionsSchema = z.object({
  driver: refusedDriverFlag('report'),
  attempt: z.undefined({ invalid_type_error: '--attempt needs --driver skill' }),
  modelUnavailable: z.boolean().optional().refine((given) => !given, '--model-unavailable needs --driver skill'),
  json: z.string().optional(),
});

/** The refusal of a `--driver` that is neither `local` nor `skill`. */
function unsupportedDriver(driver: string): WorkflowFailure {
  return { code: 'unsupported_driver', message: `Driver "${driver}" is not available. Use --driver local or --driver skill.` };
}

/** Answers the first issue of a `--json` driver's flags, as `invalid_arguments`. */
function refuseOptions(error: z.ZodError): void {
  writeEnvelope({ error: { code: 'invalid_arguments', message: error.issues[0]?.message ?? 'invalid options' } }, collectEnvSecrets());
}

export async function workflowNext(runId: string, options: {
  json?: string; prepare?: boolean; attempt?: string; adopt?: string; driver?: string; wait?: boolean; takeover?: boolean; confirmed?: boolean; choice?: string; ack?: string;
}): Promise<void> {
  const { driver: kind, ...rest } = options;
  if (refusedNested(nestedCall(process.env), kind === 'skill')) return;
  if (kind === 'skill') {
    await workflowSkill({ kind: 'next', run: runId, options: rest });
    return;
  }
  setStderrOnly(true);
  const parsedOptions = JsonNextOptionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    refuseOptions(parsedOptions.error);
    return;
  }
  const { prepare } = parsedOptions.data;
  const payload = readJson(parsedOptions.data.json, 'Pass --json with a driver object');
  if (!payload.ok) {
    writeEnvelope(payload.envelope, collectEnvSecrets());
    return;
  }
  const parsed = parseNextPayload(payload.value);
  if (typeof parsed === 'string') {
    writeEnvelope({ error: { code: 'invalid_json', message: parsed } }, collectEnvSecrets());
    return;
  }
  const loaded = await readyRunConfig(runId, { allowRemote: parsed.request.claim === true });
  if (!('config' in loaded)) {
    refuse(loaded);
    return;
  }
  const { config, env, secrets } = loaded;
  const run = RunIdSchema.safeParse(runId);
  // A claim continues the run as a resume does, so it makes the resume's check first.
  if (parsed.request.claim === true && run.success && !await sessionDrivesRun(config, run.data)) {
    const caller = invokeCaller(false);
    const refused = await resumeRefusal(config, run.data, caller, { published: true, act: 'claim' });
    if (refused) {
      writeEnvelope({ error: refused }, secrets);
      return;
    }
  }
  writeEnvelope(await inProcessClient({ config, env }).next(runId, payload.value, prepare ? { prepare } : undefined), secrets);
}

export async function workflowReport(runId: string, options: { json?: string; driver?: string; attempt?: string; modelUnavailable?: boolean }): Promise<void> {
  const { driver: kind, ...rest } = options;
  // A runner of the skill driver carries the marker of the attempt it reports.
  const runner = kind === 'skill' && options.attempt !== undefined && isAttemptRunner(process.env, runId, options.attempt);
  if (!runner && refusedNested(nestedCall(process.env), kind === 'skill')) return;
  if (kind === 'skill') {
    await workflowSkill({ kind: 'report', run: runId, options: rest });
    return;
  }
  setStderrOnly(true);
  const parsedOptions = JsonReportOptionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    refuseOptions(parsedOptions.error);
    return;
  }
  if (isLeaseRef(runId)) {
    writeEnvelope({ error: { code: 'judge_lease', message: `${runId} is a judge lease, which workflow report does not settle. Submit its answer with: teamai score --lease ${runId} --submit --stdin` } }, collectEnvSecrets());
    return;
  }
  const payload = readJson(parsedOptions.data.json, 'Pass --json with attempt, revision, outcome, and driver');
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
  if (!('config' in loaded)) {
    refuse(loaded);
    return;
  }
  const { config, env, secrets } = loaded;
  writeEnvelope(await inProcessClient({ config, env }).report(runId, payload.value), secrets);
}


async function workflowControl(runId: string, operation: (config: LocalConfig, secrets: Record<string, string>) => Promise<WorkflowEnvelope>): Promise<void> {
  setStderrOnly(true);
  if (refusedNested(nestedCall(process.env), false)) return;
  const loaded = await readyRunConfig(runId);
  if (!('config' in loaded)) {
    refuse(loaded);
    return;
  }
  writeEnvelope(await operation(loaded.config, loaded.secrets), loaded.secrets);
}

/**
 * Records a HITL answer with the provenance decided from this process and the driver UI `--json` declares. With
 * `--driver skill`, the skill driver records the agent's answer to an optional gate.
 */
export async function workflowRespond(runId: string, step: string, choice: string, options: { note?: string; pass?: string; json?: string; driver?: string }): Promise<void> {
  const { driver: kind, ...rest } = options;
  if (refusedNested(nestedCall(process.env), kind === 'skill')) return;
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
  if (refusedNested(nestedCall(process.env), false)) return;
  const loaded = await readyRunConfig(runId);
  if (!('config' in loaded)) {
    refuse(loaded);
    return;
  }
  const { secrets } = loaded;
  const published = await publishRun(loaded.config, runId, { checkout: process.cwd(), ...(options.sessions ? { sessions: resumableSessions } : {}) });
  if (published.ok && published.value.skipped) {
    const list = published.value.skipped.map((session) => `${session.tool} session ${session.id}`).join(', ');
    log.warn(`Could not read ${list} on this machine, so they were not archived. Each step that continues them resumes the newest session of its chain that was.`);
  }
  writeEnvelope(published.ok ? { data: { ...published.value } } : { error: published.error }, secrets);
}

/** `judge` is false with `--no-judge`. */
export async function workflowResume(runId: string, options: {
  driver?: string; tools?: string; autoApprove?: boolean; claim?: boolean; confirmed?: boolean; parallel?: string; hitl?: string; judge?: boolean;
}): Promise<void> {
  if (refusedNested(nestedCall(process.env), options.driver === 'skill')) return;
  if (options.driver === 'skill') {
    const { driver: _skill, ...rest } = options;
    await workflowSkill({ kind: 'resume', run: runId, options: rest });
    return;
  }
  setStderrOnly(true);
  const nonSkill = NonSkillRunOptionsSchema.safeParse(options);
  if (!nonSkill.success) {
    refuseOptions(nonSkill.error);
    return;
  }
  if (options.driver !== undefined && options.driver !== 'local') {
    writeEnvelope({ error: unsupportedDriver(options.driver) }, collectEnvSecrets());
    return;
  }
  const loaded = await readyRunConfig(runId, { allowRemote: true });
  if (!('config' in loaded)) {
    refuse(loaded);
    return;
  }
  const { secrets } = loaded;
  const run = RunIdSchema.safeParse(runId);
  if (!run.success) {
    writeEnvelope({ error: { code: 'invalid_run', message: 'Run id must look like r followed by 8 or 16 hex digits' } }, secrets);
    return;
  }
  const tools = parseTools(options.tools);
  if (typeof tools === 'string') {
    writeEnvelope({ error: { code: 'invalid_tools', message: tools } }, secrets);
    return;
  }
  const caller = invokeCaller(options.confirmed);
  const refused = await sessionDrivesRun(loaded.config, run.data) ? undefined : await resumeRefusal(loaded.config, run.data, caller, { published: true });
  if (refused) {
    writeEnvelope({ error: refused }, secrets);
    return;
  }
  // Claimed under the driver lock, so a driver of this run already running here never drives the claimed run.
  await writeDriven(loaded.config, await withDriverLock(loaded.config, runId, async (drive) => {
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
    return drive(cwd, { tools, toolPaths: loaded.teamConfig.toolPaths, autoApprove: options.autoApprove });
  }), secrets);
}
