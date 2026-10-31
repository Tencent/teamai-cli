import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { autoDetectInit, loadTeamConfig, machineWorkflowAllowProblem } from './config.js';
import { resolveWorkflowEnv, type WorkflowEnv } from './env-resolution.js';
import { isLeaseRef } from './scorers/entry.js';
import { log, setStderrOnly } from './utils/logger.js';
import { collectEnvSecrets, redact, redactJson } from './utils/redact.js';
import { parseNextPayload, parseReport, parseResponsePayload, resumableSessions, retryCommand, withIgnored, type ParsedResponsePayload } from './workflow/engine.js';
import { claimOffered, publishRun, resumeRun } from './workflow/handoff.js';
import { PublishedRuns, type Lack, type PublishedRun, type ResumableRun, type Taker } from './workflow-published-runs.js';
import { safeText } from './session-flow/session-cmd-shared.js';
import type { HandoffOwner } from './workflow/snapshot.js';
import { getRepoIdentity } from './session-flow/sync.js';
import { readableReportsWorktree } from './utils/reports-branch.js';
import { callerProvenance, cancelRun, respondProvenance, respondToHitl, restartCommand, retryStep } from './workflow/run-controls.js';
import { isIsolated } from './workflow/workspace.js';
import { localStrictCan, personAnswers, runLocalDriver, withDriverLock } from './workflow/drivers/local/local-driver.js';
import { driverIdentity } from './driver-identity.js';
import { getBusinessRoot, getDataHome, usesBranchWorktree, type LocalConfig, type TeamaiConfig } from './types.js';
import { AttemptIdSchema, installOwner, readRun, RunIdSchema, runsDir } from './workflow/store.js';
import { inProcessClient, resumeRefusal, workflowNotFound, type InvokeCaller, type NextPrepare } from './workflow/protocol.js';
import { parseInputsFlag, parseSkillCall, parseSkillResume, runSkillCall, sessionDrivesRun, skillContext } from './workflow/drivers/skill/skill-driver.js';
import { loadCachedWorkflow, namespaceConflictOf, resolveStart } from './workflow/cache.js';
import { durationMs } from './workflow/parse.js';
import { findRunConfig } from './workflow/run-location.js';
import { resolveRunMode } from './launch-context.js';
import { memberTools } from './tool-launch/call.js';
import { agentEvidence, isAttemptRunner, nestedCall, nestedStart, nestedWorkflowError, type Nested } from './workflow/attempt-marker.js';
import { planBenchmark, planStep, tryBenchmarkTask } from './benchmark/start.js';
import { reportBenchmark } from './benchmark/report.js';
import { regressionOf, type Regression } from './benchmark/history.js';
import { benchmarkRecordFile, BenchmarkRunRecordSchema } from './benchmark/result.js';
import { runCheckStep } from './benchmark/trial.js';
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
 * Prints what the local driver answered for a run of `config`, with why each step of a failed run failed, then, once an unattended run is done, drains the run's
 * scope as `teamai score --drain` does unless its unattended publishing and session scoring are both `off`. The run's
 * outcome keeps setting the exit code: what the drain could not do is printed.
 */
async function writeDriven(config: LocalConfig, envelope: WorkflowEnvelope, secrets: Record<string, string>): Promise<void> {
  writeEnvelope(envelope, secrets);
  if ('error' in envelope || !('done' in envelope.data)) return;
  await explainFailedSteps(config, envelope.data.done, secrets);
  if (resolveRunMode(process.env) !== 'unattended') return;
  const { Drain } = await import('./score-drain.js');
  try {
    if (!await Drain.drainsUnattendedRun(config)) return;
    log.info('Draining before exit (teamai score --drain)');
    Drain.print(await Drain.run([config], { mode: 'unattended' }));
  } catch (error) {
    log.error(`The drain stopped: ${error instanceof Error ? error.message : String(error)}. Run teamai score --drain to finish it.`);
  }
}

const FailedDoneSchema = z.object({ run: z.string(), outcome: z.literal('failed') });

/**
 * On stderr, why each step of a failed run failed and the commands that retry it, since the `done` envelope carries
 * only the outcome. A person who ran the local driver otherwise finds the reason only in the run file.
 */
async function explainFailedSteps(config: LocalConfig, done: unknown, secrets: Record<string, string>): Promise<void> {
  const failed = FailedDoneSchema.safeParse(done);
  if (!failed.success) return;
  const { run: runId } = failed.data;
  const run = await readRun(config, runId);
  if (typeof run === 'string') return;
  const failedIds = run.steps.filter((step) => step.status === 'failed').map((step) => step.id);
  const isolated = isIsolated(run);
  // A fan-out or workflow step fails, with no failure of its own, when a step under it fails: name that step instead.
  const failedUnder = (id: string): boolean => failedIds.some((other) => other.startsWith(`${id}.`) || other.startsWith(`${id}[`));
  for (const step of run.steps) {
    if (step.status !== 'failed' || (!step.failure && failedUnder(step.id))) continue;
    const why = step.failure ? ` with ${step.failure.code}: ${step.failure.message}` : step.message ? `: ${step.message}` : '';
    log.error(redact(`Step "${step.id}" failed${why}`, { envSecrets: secrets, patterns: false }));
    if (!isolated) log.info(`Retry it with ${retryCommand(runId, step.id)}, then continue the run with teamai workflow resume ${runId}`);
  }
  // An isolated run refuses a retry: what it admitted or measured would change.
  if (isolated) log.info(`Run ${runId} is isolated, so its steps do not run again. Start a new run: ${restartCommand(run)}`);
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
    // oxlint-disable-next-line teamai/config-load-options -- the read-only branch suppresses migration; mutating workflow calls retain normal migration
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

/** `readyConfig`, or the user scope's when a start of `name` runs there, as {@link resolveStart} decides. */
async function readyStartConfig(name: string): Promise<Ready | WorkflowEnvelope> {
  const loaded = await readyConfig();
  if (!('config' in loaded)) return loaded;
  const { config } = await resolveStart(loaded.config, name);
  if (config === loaded.config) return loaded;
  const teamConfig = await loadTeamConfig(config.repo.localPath);
  if (!teamConfig) return loaded;
  const env = await resolveWorkflowEnv(config);
  return { config, teamConfig, env, secrets: env.secrets };
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

const TIMEOUT_MESSAGE = '--timeout must be a positive duration, such as 500ms, 30s, 10m, or 2h';

/** The flags of `workflow start` and `resume` without `--driver skill`. The skill driver's flags are refused, the first given in this order. */
const NonSkillRunOptionsSchema = z.object({
  timeout: z.string().transform((text, ctx) => durationMs(text) ?? (ctx.addIssue({ code: z.ZodIssueCode.custom, message: TIMEOUT_MESSAGE }), z.NEVER)).optional(),
  parallel: z.undefined({ error: '--parallel needs --driver skill' }).optional(),
  hitl: z.undefined({ error: '--hitl needs --driver skill' }).optional(),
  judge: z.boolean().optional().refine((judged) => judged !== false, '--no-judge needs --driver skill'),
});

type StartOptions = {
  driver?: string; tools?: string; inputs?: string; autoApprove?: boolean; describe?: boolean; parallel?: string; confirmed?: boolean; hitl?: string; judge?: boolean;
  sandbox?: boolean; timeout?: string;
};

/** `judge` is false with `--no-judge`. */
export async function workflowStart(name: string, options: StartOptions): Promise<void> {
  await startWorkflow(name, options);
}

/** `workflow start`, answering what the local driver ended a run it drove with; undefined for every other answer, which it printed. */
async function startWorkflow(name: string, options: StartOptions): Promise<WorkflowEnvelope | undefined> {
  if (refusedNested(await nestedStart(process.env, process.cwd()), options.driver === 'skill')) return undefined;
  if (options.driver === 'skill') {
    const { driver: _skill, timeout, ...rest } = options;
    const timeoutMs = timeout === undefined ? undefined : durationMs(timeout);
    if (timeout !== undefined && timeoutMs === undefined) {
      refuseSkill({ error: { code: 'invalid_arguments', message: TIMEOUT_MESSAGE } });
      return;
    }
    await workflowSkill({ kind: 'start', name, options: rest, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    return;
  }
  setStderrOnly(true);
  const nonSkill = NonSkillRunOptionsSchema.safeParse(options);
  if (!nonSkill.success) {
    refuseOptions(nonSkill.error);
    return;
  }
  const { timeout } = nonSkill.data;
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
    writeEnvelope({ data: { name: cached.definition.name, description, ...(alias ? { alias } : {}), source: cached.source, invoke: invoke ?? 'deny', inputs: inputs ?? {} } }, secrets);
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
  const alone = options.driver === 'local' ? { alone: localStrictCan(config, options) } : {};
  const started = await inProcessClient({ config, env }).start(name, { inputs, checkout: process.cwd(), caller, ...alone, ...(timeout !== undefined ? { timeout } : {}) });
  if ('error' in started || options.driver !== 'local') {
    writeEnvelope(started, secrets);
    return;
  }
  const runId = started.data.run;
  if (typeof runId !== 'string') {
    writeEnvelope({ error: { code: 'run_unreadable', message: 'The new run id was missing' } }, secrets);
    return;
  }
  log.info(`Run ${runId} started. If it stops before it ends, continue it with: teamai workflow resume ${runId}${options.sandbox ? ' --sandbox' : ''}`);
  const driven = await runLocalDriver(config, runId, process.cwd(), { tools, toolPaths: teamConfig.toolPaths, autoApprove: options.autoApprove, sandbox: options.sandbox });
  await writeDriven(config, driven, secrets);
  return driven;
}

/** Aborts on the first SIGINT or SIGTERM, so `teamai benchmark try` stops the setup or check it runs. A second one ends the process. */
function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => controller.abort(name));
  return controller.signal;
}

/** Refuses `--driver <kind>` on `command`, which takes only `--driver skill`, naming the kind given. */
function refusedDriverFlag(command: 'next' | 'report'): z.ZodOptional<z.ZodUndefined> {
  return z.undefined({ error: (issue) => `${command} takes --driver skill, not --driver ${String(issue.input)}` }).optional();
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
  choice: z.undefined({ error: '--choice needs --driver skill' }).optional(),
  ack: z.undefined({ error: '--ack needs --driver skill' }).optional(),
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
  attempt: z.undefined({ error: '--attempt needs --driver skill' }).optional(),
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
  driver?: string; tools?: string; autoApprove?: boolean; claim?: boolean; confirmed?: boolean; parallel?: string; hitl?: string; judge?: boolean; next?: boolean; sandbox?: boolean;
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
    return drive(cwd, { tools, toolPaths: loaded.teamConfig.toolPaths, autoApprove: options.autoApprove, sandbox: options.sandbox });
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
  if (options.next) await takeNext(loaded, taker, options);
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
 * runs it skipped. Says why it left each run of this repository it skipped. The local driver runs prompt steps on the
 * taker's `tools`.
 */
async function takeNext(loaded: Ready, taker: Taker, options: ResumeOptions): Promise<void> {
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
  const candidates = PublishedRuns.candidates(runs, { repository, hasPerson: taker.hasPerson, self: self.id });
  for (const run of others) if (run.repository === repository && !candidates.includes(run)) saidLeft(run);
  let moved = 0;
  for (const run of candidates) {
    const taken = taker.driver === 'skill'
      ? await skillAnswer({ kind: 'resume', run: run.run, options: { ...withoutDriver(options), next: true } })
      : { envelope: await driveOffered(loaded, run, { tools: taker.tools, autoApprove: options.autoApprove, sandbox: options.sandbox }), secrets };
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
async function driveOffered({ config, teamConfig }: Ready, run: PublishedRun, options: { tools: Record<string, string>; autoApprove?: boolean; sandbox?: boolean }): Promise<WorkflowEnvelope> {
  return withDriverLock(config, run.run, async (drive) => {
    const claimed = await claimOffered(config, run.run, { checkout: process.cwd() });
    if (!claimed.ok) return { error: claimed.error };
    saidClaimed(run);
    return drive(process.cwd(), { tools: options.tools, toolPaths: teamConfig.toolPaths, autoApprove: options.autoApprove, sandbox: options.sandbox });
  });
}

function saidClaimed(run: PublishedRun): void {
  log.success(`Claimed ${run.run} (${run.workflow}) from ${safeText(run.owner.user)}`);
}

/** Says why `--next` left offered run `run`: what this machine lacks, which someone should fix, else who it is left for. */
function saidLeft({ run, workflow, offer }: PublishedRun): void {
  if (!offer) return;
  if (offer.refusal) log.info(safeText(`Left ${run} (${workflow}) offered: ${offer.refusal.message}`));
  else if (offer.lacks.length > 0) log.warn(safeText(`Left ${run} (${workflow}) offered: ${lacksText(offer.lacks)}`));
  else log.info(safeText(`Left ${run} (${workflow}) offered for a person: ${offer.needs.join('; ')}`));
}

/** Each lack with what gives it, as `workflow resume` lists them and `--next` says them. */
function lacksText(lacks: readonly Lack[]): string {
  return lacks.map((lack) => `${lack.reason}: ${lack.fix}`).join('; ');
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
      const take = offer.needs.length > 0 ? `a person runs teamai workflow resume ${run} --claim` : 'teamai workflow resume --next';
      // What this machine lacks comes first: nobody here can finish the run, a person included, until it is fixed.
      if (offer.lacks.length > 0) return [run, workflow, 'cannot run here', ownerText(owner), `offered on teamai-reports, ${[lacksText(offer.lacks), ...offer.needs].join('; ')}; then ${take}`];
      if (offer.needs.length > 0) return [run, workflow, 'needs a person', ownerText(owner), `offered on teamai-reports, ${offer.needs.join('; ')}: ${take}`];
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

/**
 * `teamai benchmark check --baseline|--trial`, the command of a benchmark run's baseline and trial check steps: prints
 * `{"result":"passed"|"failed"|"could_not_run"}`, the step's output, and exits 0 once the check ran, whatever it said.
 * Exits 1, naming why on stderr, when the check could not be set up. A stop signal stops the check first.
 */
export async function benchmarkCheck(options: { baseline?: boolean; trial?: boolean }): Promise<void> {
  setStderrOnly(true);
  if (options.baseline === options.trial) {
    log.error('Pass exactly one of --baseline and --trial: the check of a task\'s baseline, or of a trial.');
    process.exitCode = 1;
    return;
  }
  const stop = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => stop.abort(signal);
  for (const signal of CHECK_STOP_SIGNALS) process.on(signal, onSignal);
  try {
    const checked = await runCheckStep({ mode: options.baseline ? 'baseline' : 'trial', env: process.env, cwd: process.cwd(), signal: stop.signal });
    if ('failure' in checked) {
      log.error(`${checked.failure.code}: ${checked.failure.message}`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ result: checked.result })}\n`);
  } finally {
    for (const signal of CHECK_STOP_SIGNALS) process.off(signal, onSignal);
  }
}

const CHECK_STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** A benchmark verb that runs as a step: what it prints on stdout, or why it failed, on stderr with exit 1. */
function writeStepOutput(answer: { failure: WorkflowFailure } | { output: unknown }): void {
  if ('failure' in answer) {
    log.error(`${answer.failure.code}: ${answer.failure.message}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(answer.output)}\n`);
}

/** `teamai benchmark plan <suite>`: the step that plans a benchmark run. */
export async function benchmarkPlan(suite: string, options: { aliases?: string }): Promise<void> {
  setStderrOnly(true);
  const aliases = options.aliases ?? 'team';
  if (aliases !== 'team' && aliases !== 'member') {
    writeStepOutput({ failure: { code: 'invalid_arguments', message: `--aliases takes team, the team's models/aliases.yaml, or member, your ~/.teamai/models/aliases.yaml over the team's; got ${aliases}.` } });
    return;
  }
  const planned = await planStep(suite, process.env, { memberAliases: aliases === 'member' });
  writeStepOutput('failure' in planned ? planned : { output: planned.planned });
}

/** `teamai benchmark report`: the `finally` step that reports a benchmark run. */
export async function benchmarkReport(): Promise<void> {
  setStderrOnly(true);
  const reported = await reportBenchmark(process.env, collectEnvSecrets());
  writeStepOutput('failure' in reported ? reported : { output: reported.report });
}

const BenchmarkDoneSchema = z.object({
  run: z.string().optional(),
  outputs: z.object({ text: z.string() }).partial().passthrough().optional(),
  finally: z.array(z.object({ id: z.string() }).passthrough()).optional(),
}).passthrough();

/**
 * `teamai benchmark run <suite>`: plans the suite once without a run, so a suite that cannot run leaves none, then
 * starts the workflow `teamai-benchmark`, the team's or teamai's default, with the suite as its input and the suite's timeout as
 * the run's, on the local driver unless `--driver` names another. Exits as `workflow start` does for the run's outcome,
 * and also 1 when a `finally` step, the report, failed or was cancelled, or with `failOnRegression` when an arm dropped
 * against the newest earlier comparable record on teamai-reports. A record still pending never changes it.
 */
export async function benchmarkRun(suite: string, options: { driver?: string; sandbox?: boolean; memberAliases?: boolean; failOnRegression?: boolean }): Promise<void> {
  setStderrOnly(true);
  const loaded = await readyStartConfig(BENCHMARK_WORKFLOW);
  if (!('config' in loaded)) {
    refuse(loaded);
    return;
  }
  const { config, secrets } = loaded;
  const memberAliases = options.memberAliases === true;
  // The plan step decides unattended trials from the step that runs its plan; refusals do not depend on it.
  const preflight = await planBenchmark(config, suite, { checkout: process.cwd(), memberAliases, unattended: false });
  if ('refused' in preflight) {
    writeEnvelope(preflight.refused, secrets);
    return;
  }
  const workflow = await loadCachedWorkflow(config, BENCHMARK_WORKFLOW);
  if (!workflow) {
    const conflict = await namespaceConflictOf(config, BENCHMARK_WORKFLOW);
    writeEnvelope({ error: conflict === undefined ? workflowNotFound(BENCHMARK_WORKFLOW) : { code: 'workflow_namespace_conflict', message: conflict } }, secrets);
    return;
  }
  if (workflow.source === 'team') {
    if (workflow.definition.inputs?.suite === undefined) {
      writeEnvelope({ error: { code: 'invalid_inputs', message: `The team's ${workflow.relativePath} replaces teamai's benchmark workflow and takes no input suite, so teamai benchmark run cannot give it the suite. Add inputs: { suite: string } to it, or remove it to run teamai's default.` } }, secrets);
      return;
    }
    if (memberAliases && workflow.definition.inputs?.aliases === undefined) {
      writeEnvelope({ error: { code: 'invalid_inputs', message: `The team's ${workflow.relativePath} replaces teamai's benchmark workflow and takes no input aliases, so teamai benchmark run cannot give it --member-aliases. Add aliases: string to its inputs and pass it to teamai benchmark plan --aliases, or run without --member-aliases.` } }, secrets);
      return;
    }
    log.info(`Running the team's ${workflow.relativePath}, which replaces teamai's benchmark workflow.`);
  }
  // A team workflow without input aliases plans with the team's aliases, as teamai benchmark plan does without --aliases.
  const aliases = workflow.definition.inputs?.aliases === undefined ? {} : { aliases: memberAliases ? 'member' : 'team' };
  const done = await startWorkflow(BENCHMARK_WORKFLOW, {
    driver: options.driver ?? 'local', inputs: JSON.stringify({ suite, ...aliases }), timeout: `${preflight.timeoutMs}ms`, ...(options.sandbox ? { sandbox: true } : {}),
  });
  const ended = done && 'data' in done ? BenchmarkDoneSchema.safeParse(done.data.done) : undefined;
  if (!ended?.success) return;
  if (ended.data.outputs?.text !== undefined) process.stderr.write(`${ended.data.outputs.text}\n`);
  // The report is a finally step: one that failed or was cancelled is listed, and the results it owed are missing.
  if ((ended.data.finally ?? []).length > 0) process.exitCode = 1;
  if (options.failOnRegression && ended.data.run !== undefined) await failOnRegression(config, ended.data.run);
}

/**
 * `--fail-on-regression`: run `runId`'s record, from its run directory so a record pending publication counts, against
 * the published records Compare reads, and exit 1 when an arm dropped. A run whose report wrote no record is left to the
 * report's own exit.
 */
async function failOnRegression(config: LocalConfig, runId: string): Promise<void> {
  const text = await fs.readFile(benchmarkRecordFile(runsDir(config), runId), 'utf8').catch(() => undefined);
  const record = text === undefined ? undefined : BenchmarkRunRecordSchema.safeParse(JSON.parse(text));
  if (!record?.success) return;
  const { publishedBenchmarkRuns } = await import('./dashboard/benchmarks.js');
  const current = { run: record.data.run, source: 'local' as const, startedAt: record.data.startedAt, outcome: record.data.outcome, benchmark: record.data };
  const regression = regressionOf(current, await publishedBenchmarkRuns(config, { refresh: true }));
  for (const line of regressionLines(regression, record.data.suite.name)) process.stderr.write(`${line}\n`);
  if (regression.kind === 'dropped') process.exitCode = 1;
}

function regressionLines(regression: Regression, suite: string): string[] {
  const points = (fraction: number): number => Math.round(fraction * 100);
  switch (regression.kind) {
    case 'no_comparable':
      return [`No earlier succeeded run of suite ${suite} ran the same tasks on the same arms on teamai-reports: recording is off, or nothing comparable has been published yet. --fail-on-regression has nothing to compare with.`];
    case 'held':
      return [`No arm's pass rate dropped by more than chance against run ${regression.against}.`];
    case 'dropped':
      return regression.arms.map(({ arm, pairs, rates, difference }) => `Arm "${arm}" passed ${rates.to.passed}/${pairs} paired trials, against ${rates.from.passed}/${pairs} in run ${regression.against}: a drop of ${points(-difference.value)} points, with a 95% interval of ${points(difference.low)} to ${points(difference.high)} points.`);
    default: {
      const unhandled: never = regression;
      return unhandled;
    }
  }
}

/** `teamai benchmark try <task-file>`: whether a task's check tells its fix from no change. Needs no init and no run. */
export async function benchmarkTry(file: string): Promise<void> {
  setStderrOnly(true);
  writeEnvelope(await tryBenchmarkTask(file, { checkout: process.cwd(), signal: interruptSignal(), progress: (line) => log.info(line) }), collectEnvSecrets());
}

/** The workflow `teamai benchmark run` starts: teamai's default, or the team's file of the same name. */
const BENCHMARK_WORKFLOW = 'teamai-benchmark';
