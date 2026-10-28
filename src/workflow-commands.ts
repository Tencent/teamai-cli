import path from 'node:path';
import { z } from 'zod';
import { autoDetectInit, loadLocalConfigForScope, loadTeamConfig, machineWorkflowAllowProblem } from './config.js';
import { resolveWorkflowEnv, type WorkflowEnv } from './env-resolution.js';
import { isLeaseRef } from './scorers/entry.js';
import { log, setStderrOnly } from './utils/logger.js';
import { collectEnvSecrets, redactJson } from './utils/redact.js';
import { parseNextPayload, parseReport, parseResponsePayload, resumableSessions, withIgnored, type ParsedResponsePayload } from './workflow/engine.js';
import { claimOffered, publishRun, resumeRun } from './workflow/handoff.js';
import { PublishedRuns, type PublishedRun, type ResumableRun, type Taker } from './workflow-published-runs.js';
import { safeText } from './session-flow/session-cmd-shared.js';
import type { HandoffOwner } from './workflow/snapshot.js';
import { getRepoIdentity } from './session-flow/sync.js';
import { readableReportsWorktree } from './utils/reports-branch.js';
import { callerProvenance, cancelRun, respondProvenance, respondToHitl, retryStep } from './workflow/run-controls.js';
import { personAnswers, runLocalDriver, withDriverLock } from './workflow/drivers/local/local-driver.js';
import { driverIdentity } from './driver-identity.js';
import { getBusinessRoot, getDataHome, usesBranchWorktree, type LocalConfig, type TeamaiConfig } from './types.js';
import { AttemptIdSchema, installOwner, readRun, RunIdSchema } from './workflow/store.js';
import { inProcessClient, resumeRefusal, workflowNotFound, type InvokeCaller, type NextPrepare } from './workflow/protocol.js';
import { parseInputsFlag, parseSkillCall, parseSkillResume, runSkillCall, sessionDrivesRun, skillContext } from './workflow/drivers/skill/skill-driver.js';
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

/**
 * The refusal of every workflow command while this machine's `workflows.allow` cannot be used: skipping a restriction
 * would lift it. Undefined when it can.
 */
async function allowRefusal(): Promise<WorkflowEnvelope | undefined> {
  const problem = await machineWorkflowAllowProblem();
  return problem ? { error: { code: 'not_initialized', message: problem } } : undefined;
}

/** The member's config as `Ready`, or the failure the caller prints. */
async function readyConfig(): Promise<Ready | WorkflowEnvelope> {
  const refusal = await allowRefusal();
  if (refusal) return refusal;
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
  const refusal = await allowRefusal();
  if (refusal) return refusal;
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
  const { envelope, secrets } = await skillAnswer(raw);
  writeEnvelope(envelope, secrets);
}

/** What the skill driver answers `raw` with, and the secrets its envelope masks. */
async function skillAnswer(raw: Parameters<typeof parseSkillCall>[0]): Promise<{ envelope: WorkflowEnvelope; secrets: Record<string, string> }> {
  const call = parseSkillCall(raw, process.env);
  if ('error' in call) return { envelope: call, secrets: collectEnvSecrets() };
  // A resume, or a takeover, readies a run this machine may lack, so the skill driver answers for it.
  const loaded = call.kind === 'describe' || call.kind === 'start' ? await readyStartConfig(call.name)
    : await readyRunConfig(call.run, { allowRemote: call.kind === 'resume' || call.kind === 'takeover' });
  if (!('config' in loaded)) {
    // Every `--driver skill` error carries `next`: null, since nothing here names what to run.
    const refused: WorkflowEnvelope | { error: WorkflowFailure & { next: null } } = 'error' in loaded ? { error: { ...loaded.error, next: null } } : loaded;
    return { envelope: refused, secrets: collectEnvSecrets() };
  }
  const context = await skillContext({
    config: loaded.config, toolPaths: loaded.teamConfig.toolPaths, env: loaded.env, cwd: process.cwd(),
    aiTools: (await memberTools(loaded.config)).map(({ tool }) => tool),
    trace: (row) => log.debug(`[workflow] skill driver took row ${row}`),
  });
  return { envelope: await runSkillCall(call, context), secrets: loaded.secrets };
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

type ResumeOptions = {
  driver?: string; tools?: string; autoApprove?: boolean; claim?: boolean; confirmed?: boolean; parallel?: string; hitl?: string; judge?: boolean; next?: boolean;
};

/**
 * `judge` is false with `--no-judge`. Without a run id, lists the runs this checkout can resume, or with `--next` takes
 * the oldest one teamai-reports offers.
 */
export async function workflowResume(runId: string | undefined, options: ResumeOptions): Promise<void> {
  if (refusedNested(nestedCall(process.env), options.driver === 'skill')) return;
  if (options.next || runId === undefined) {
    await resumeOffered(runId, options);
    return;
  }
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

/** `workflow resume` without a run id: lists the runs this checkout can resume, or with `--next` takes the oldest offered one. */
async function resumeOffered(runId: string | undefined, options: ResumeOptions): Promise<void> {
  setStderrOnly(true);
  const isSkill = options.driver === 'skill';
  const answer = isSkill ? refuseSkill : refuse;
  const refusal = resumeOfferedRefusal(runId, options);
  if (refusal) {
    answer({ error: refusal });
    return;
  }
  const nonSkill = isSkill ? undefined : NonSkillRunOptionsSchema.safeParse(options);
  if (nonSkill && !nonSkill.success) {
    refuseOptions(nonSkill.error);
    return;
  }
  // Checked before any run is picked, so a command line that could take no run fails even while none is offered.
  const skillResume = isSkill && options.next ? parseSkillResume({ ...withoutDriver(options), next: true }, process.env) : undefined;
  if (skillResume && 'error' in skillResume) {
    refuse(skillResume);
    return;
  }
  const tools = isSkill ? {} : parseTools(options.tools);
  if (typeof tools === 'string') {
    answer({ error: { code: 'invalid_tools', message: tools } });
    return;
  }
  const loaded = await readyConfig();
  if (!('config' in loaded)) {
    answer(loaded);
    return;
  }
  const evidence = agentEvidence(process.env);
  // `--driver skill` counts as an agent's, as it does for a start.
  const caller: InvokeCaller = { ...invokeCaller(options.confirmed), ...(isSkill && evidence.kind === 'none' ? { evidence: { kind: 'skill-driver' } } : {}) };
  // The skill driver's session asks the person; the local driver asks at this terminal, which a cron job has not.
  const taker: Taker = isSkill ? { caller, driver: 'skill', hasPerson: caller.mode === 'attended' } : { caller, driver: 'local', tools, hasPerson: personAnswers(caller.mode) };
  if (options.next) await takeNext(loaded, taker, options, tools);
  else await listResumable(loaded, taker);
}

/** Why `workflow resume` without a run id refuses its command line, before it reads anything. */
function resumeOfferedRefusal(runId: string | undefined, options: ResumeOptions): WorkflowFailure | undefined {
  if (runId !== undefined) {
    return { code: 'invalid_arguments', message: `--next takes the oldest run teamai-reports offers, so it takes no run id. To continue run ${runId}: teamai workflow resume ${runId}` };
  }
  if (options.claim) {
    return options.next
      ? { code: 'invalid_arguments', message: '--next claims the run it takes, so it takes no --claim' }
      : { code: 'invalid_arguments', message: '--claim takes over the run you name: teamai workflow resume <run> --claim' };
  }
  if (options.driver !== undefined && options.driver !== 'local' && options.driver !== 'skill') return unsupportedDriver(options.driver);
  return undefined;
}

/**
 * Claims and drives the oldest run teamai-reports offers that `taker` can finish in this checkout's business
 * repository, trying the next one when another runner claimed it first, or answers `idle` with the count of offered
 * runs it skipped. The local driver runs prompt steps on `tools`.
 */
async function takeNext(loaded: Ready, taker: Taker, options: ResumeOptions, tools: Record<string, string>): Promise<void> {
  const { config, secrets } = loaded;
  const isSkill = taker.driver === 'skill';
  const answer = isSkill ? refuseSkill : refuse;
  const repository = getRepoIdentity(process.cwd()) ?? undefined;
  const unready = !usesBranchWorktree(config)
    ? { code: 'unsupported_repo', message: 'workflow resume --next takes the runs teamai-reports offers, and an http team repo has no teamai-reports.' }
    : repository === undefined
      ? { code: 'origin_unavailable', message: `${process.cwd()} has no origin, so resume --next cannot tell which business repository's runs to take. Run it in a checkout of the business repository.` }
      : await refreshedReports(config);
  if (unready) {
    answer({ error: unready });
    return;
  }
  const [runs, self] = await Promise.all([PublishedRuns.list(config, { taker, env: loaded.env }), installOwner(config)]);
  const others = runs.filter((run) => run.offer !== undefined && run.owner.id !== self.id);
  let moved = 0;
  for (const run of PublishedRuns.candidates(runs, { repository, hasPerson: taker.hasPerson, self: self.id })) {
    const taken = isSkill
      ? await skillAnswer({ kind: 'resume', run: run.run, options: { ...withoutDriver(options), next: true } })
      : { envelope: await driveOffered(loaded, run, { tools, autoApprove: options.autoApprove }), secrets };
    if ('error' in taken.envelope && taken.envelope.error.code === 'state_moved') {
      moved += 1;
      continue;
    }
    if (isSkill) {
      if (!('error' in taken.envelope)) saidClaimed(run);
      writeEnvelope(taken.envelope, taken.secrets);
    } else {
      await writeDriven(config, taken.envelope, secrets);
    }
    return;
  }
  writeEnvelope({ data: { idle: { offered: others.length - moved } } }, secrets);
}

function withoutDriver(options: ResumeOptions): Omit<ResumeOptions, 'driver' | 'next'> {
  const { driver: _driver, next: _next, ...rest } = options;
  return rest;
}

/** Claims offered run `run` under this machine's driver lock, as `resume <run>` does, and drives it with the local driver. */
async function driveOffered({ config, teamConfig }: Ready, run: PublishedRun, options: { tools: Record<string, string>; autoApprove?: boolean }): Promise<WorkflowEnvelope> {
  return withDriverLock(config, run.run, async (drive) => {
    const claimed = await claimOffered(config, run.run, { checkout: process.cwd() });
    if (!claimed.ok) return { error: claimed.error };
    saidClaimed(run);
    return drive(process.cwd(), { tools: options.tools, toolPaths: teamConfig.toolPaths, autoApprove: options.autoApprove });
  });
}

function saidClaimed(run: PublishedRun): void {
  log.success(`Claimed ${run.run} (${run.workflow}) from ${safeText(run.owner.user)}`);
}

/** Fetches teamai-reports into this machine's reports checkout, as `teamai pull` does, or says why it could not. */
async function refreshedReports(config: LocalConfig): Promise<WorkflowFailure | undefined> {
  try {
    await readableReportsWorktree(config);
    return undefined;
  } catch (error) {
    return { code: 'reports_unreachable', message: `teamai-reports could not be read from the team repo's origin (${error instanceof Error ? error.message : String(error)}). Check the connection and try again.` };
  }
}

/**
 * Prints the runs this checkout can resume, a row each, in the order `PublishedRuns.resumable` gives them. Fetches
 * teamai-reports as `teamai pull` does, and lists from the last fetch when it cannot.
 */
async function listResumable({ config, env }: Ready, taker: Taker): Promise<void> {
  const unread = usesBranchWorktree(config) ? await refreshedReports(config) : undefined;
  if (unread) log.warn(`${unread.message} Listing the runs this machine last saw there.`);
  const repository = getRepoIdentity(process.cwd()) ?? undefined;
  const runs = await PublishedRuns.resumable(config, { taker, env, repository });
  if (runs.length === 0) {
    process.stdout.write(`No runs to resume here: this machine has no running run, and teamai-reports offers none for ${repository ?? 'a checkout without an origin'}.\n`);
    return;
  }
  process.stdout.write(table([['RUN', 'WORKFLOW', 'STATUS', 'OWNER', 'WHERE'], ...runs.map(resumableRow)]));
}

function ownerText(owner: HandoffOwner): string {
  return `${owner.user} (install ${owner.id.slice(0, 8)}…)`;
}

/** A run `workflow resume` lists, as a row: what resumes it here, or why a person resumes it instead. */
function resumableRow(resumable: ResumableRun): string[] {
  switch (resumable.kind) {
    case 'offered': {
      const { run, workflow, owner, offer } = resumable.published;
      if (offer.refusal) return [run, workflow, offer.refusal.code === 'needs_local_driver' ? 'needs the local driver' : offer.refusal.code, ownerText(owner), `offered on teamai-reports: ${offer.refusal.message}`];
      // Another install's run: `--claim` takes it over whether or not this machine still holds an earlier copy of it.
      if (offer.needs.length > 0) return [run, workflow, 'needs a person', ownerText(owner), `offered on teamai-reports, ${offer.needs.join('; ')}: a person runs teamai workflow resume ${run} --claim`];
      if (offer.lacks.length > 0) {
        const lacks = offer.lacks.map((lack) => `${lack.reason}: ${lack.fix}`).join('; ');
        return [run, workflow, 'cannot run here', ownerText(owner), `offered on teamai-reports, ${lacks}; then teamai workflow resume --next`];
      }
      return [run, workflow, 'running', ownerText(owner), 'offered on teamai-reports: teamai workflow resume --next'];
    }
    case 'here': {
      const { run, isOffered } = resumable;
      return [run.id, run.name, 'running', 'this install', `local${isOffered ? ', offered on teamai-reports' : ''}: teamai workflow resume ${run.id}`];
    }
    case 'claimed': {
      const { run, owner, ownedAt } = resumable;
      return [run.id, run.name, 'claimed', ownerText(owner), `claimed on teamai-reports since ${ownedAt}: teamai workflow resume ${run.id} --claim takes it back`];
    }
    case 'ended': {
      const { run, owner, status } = resumable;
      return [run.id, run.name, status, ownerText(owner), `ended on teamai-reports: teamai workflow resume ${run.id} --claim brings how it ended here`];
    }
    default: {
      const unhandled: never = resumable;
      return unhandled;
    }
  }
}

/**
 * `rows` as columns padded to their widest cell, two spaces apart, the last left unpadded. Every cell is printed
 * without control characters, since a teammate's snapshot supplies names and messages.
 */
function table(rows: string[][]): string {
  const cells = rows.map((row) => row.map(safeText));
  const widths = cells[0]?.map((_, column) => Math.max(...cells.map((row) => row[column]?.length ?? 0))) ?? [];
  return cells.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join('  ')).join('\n').concat('\n');
}
