import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { driverIdentity } from '../../../driver-identity.js';
import { LOCAL_DRIVER } from '../../driver-name.js';
import { commandSignalPolicy, exitLike, stepEnvironment, terminalReachesCommand, withRunningCli } from '../../../env-exec.js';
import { knownSecrets, resolveWorkflowEnv, type WorkflowEnv } from '../../../env-resolution.js';
import { resolveRunMode, type RunMode } from '../../../launch-context.js';
import type { LocalConfig, TeamaiConfig } from '../../../types.js';
import { log, PROGRESS_STREAMS_ENV, streamOfLine, withoutStreamMarks } from '@teamai/shared/log';
import { redact } from '@teamai/shared/redact';
import { openSessionArchive } from '../../../session-flow/archive.js';
import { agentEvidence, commandStepEnv } from '../../attempt-marker.js';
import { continuedConversations, leaseNext, promptTool, type PersonHandoff, type ReportInput, type ToolFor } from '../../engine.js';
import { offeredToPerson, offerToPerson, reconcileTakenCopies } from '../../handoff.js';
import { UsageLimits } from '../../usage-limits.js';
import { LeaseWireSchema } from '../../lease-wire.js';
import { inProcessRuntimeOf, type DecidedCan, type DriverCan, type Missing } from '../../requirements.js';
import { callerProvenance, endRunsPartOf, respondProvenance, respondToHitl, type ResponseInput } from '../../run-controls.js';
import { isRecord } from '../../expression.js';
import { toolsStepRuntime, type StepLauncher } from '@teamai/runtime-tools';
import { failureReport, launchToolFor, promptOfferOf, promptRuntimeOn, runPromptStep, type AskPerson, type StagedLease } from '../../steps/prompt.js';
import { failedCommand, placeView, runtimeCommand, runtimeSetup, runtimeStepEnv, type StartedCommand } from '../../steps/runtime-steps.js';
import { attemptRun, credentialSecrets, HeldPlace, isExecRuntimeTool, readAttemptPlacement, recordInProcessAttempt, attemptRuntimePath, maskAttemptResults, type AttemptRun, type AttemptRuntimeRecord, type RuntimeOrigin } from '../../runtimes/attempt.js';
import { answerCallTool, hostStepRuntime } from '../../runtimes/host.js';
import { writeHeldSteps, type HeldSteps } from '../../runtimes/held.js';
import { closeAfterSweep, endLeftLogins, releaseHeldPlaces, stopLeftInProcess, stopOnRecordedDriver } from '../../runtimes/cancelled.js';
import { loginHolder } from '../../runtimes/login.js';
import { homeEnvOf, toolsLaunchDeps, type EngineOptions, type OpenedDriver } from '../../runtimes/sources.js';
import { newOpId, type ExecAnswer, type ExecQuestion, type StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import { resumeOrPublish, retryCommand } from '../../runtimes/retry-command.js';
import type { RuntimeOffer, SoleDriver } from '../../engine.js';
import { attemptDir, AttemptIdSchema, attemptResultPath, keepAttemptStdout, readRun, RunIdSchema, runScratchDir, updateRun, withRunLock, type AttemptId, type RunId, type RunLock } from '../../store.js';
import { abandonPlace, isSetupCutShort, placeLeaseOf, placeOf, placeRoot, refuseDirtyAdoptedCommand, releaseUnlaunchedPlace, runPlaceSetup, sweepClones } from '../../place/place.js';
import { commandEnd, commandOutputs, managedReport, preparedPlace, StartedRunSchema, unreadablePlace, type StartedRun } from '../../protocol.js';
import { WholeEndSchema } from '../../whole-workflow.js';
import { memberTools } from '../../member-tools.js';
import { stopRecordedGroup } from '@teamai/shared/process-group';
import { startGroupedCommand, type GroupedCommandExit } from '../../shell-command.js';
import { baseToolOf, toolInstancesFor } from '../../../tool-registry.js';
import { launchExecutableOf, LAUNCH_TOOLS, launchTargetOf } from '../../../launch-registry.js';
import { confinedOffers, type ConfinedOffer } from '../../confined-launch.js';
import { AttemptResult } from '../../attempt-result.js';
import { runConfinedStep, runConfinedStepOnRuntime } from '../../confined-step.js';
import type { DriveOptions, DriverIdentity, RunState, StepHitl, WorkflowEnvelope, WorkflowFailure, WorkflowStep } from '../../types.js';
import { isWorkflowError, stepWorkflow, unattendedChoice } from '../../types.js';
import { WORKSPACE_MODES } from '@teamai/runtime-protocol';
import { confinedOf, sharedWorkspace, type SessionRef } from '../../workspace.js';
import { git, headCommit } from '../../worktree.js';

/** The signals that stop teamai, which the driver passes on to what it runs before it exits. */
export const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP'];

/** The longest the driver sleeps at once while it waits for a usage limit to reset, so it reads the run between. */
const USAGE_WAIT_STEP_MS = 60_000;

/** How long the driver waits for a command or prompt before asking the run again; half that while a question is open. */
let pollMs = 2000;

/** Shorten the driver's poll (for testing only). */
export function _setDriverPollMs(ms: number): void {
  pollMs = ms;
}

/**
 * What a leased command came to: it ran, staging failed or its step runtime failed it, or it was stopped or its lease
 * ended before it could start.
 */
type StagedResult = { kind: 'ran'; result: GroupedCommandExit } | { kind: 'unstaged'; failure: WorkflowFailure } | { kind: 'stopped' };


interface StagedCommand {
  exit: Promise<StagedResult>;
  /**
   * Aborts staging and setup, or stops the command once it runs: `cancel` when the run cancelled the step, rather than this
   * driver stopping. Settles once the attempt is over.
   */
  stop(why?: 'cancel'): Promise<StagedResult>;
}

/** Whether a staged lease may start its command or tool: nothing stopped it, and its deadline has not passed. */
function startable(lease: StagedLease, signal: AbortSignal): boolean {
  return !signal.aborted && (lease.expiresAt === undefined || Date.now() < Date.parse(lease.expiresAt));
}

/**
 * Stages a leased command, then starts it, as one attempt, so the driver keeps asking the run what to do while staging
 * and setup run, and a cancel reaches either phase.
 */
function stageThenStart(lease: StagedLease, stage: (signal: AbortSignal) => Promise<WorkflowFailure | undefined>, start: () => StartedCommand): StagedCommand {
  const controller = new AbortController();
  let command: StartedCommand | undefined;

  const exit = (async (): Promise<StagedResult> => {
    const failure = await stage(controller.signal);

    if (!startable(lease, controller.signal)) return { kind: 'stopped' };

    if (failure) return { kind: 'unstaged', failure };
    command = start();
    const ended = await command.exit;

    return 'exitCode' in ended ? { kind: 'ran', result: ended } : { kind: 'unstaged', failure: ended };
  })();

  return { exit, stop: async (why) => {
    controller.abort();
    await (why === 'cancel' && command?.cancel ? command.cancel() : command?.stop());

    return exit;
  } };
}

/** A rendered HITL request and the exact pass and response command presented by the engine. */
export interface LocalHitl extends StepHitl {
  /** The run that owns the question. */
  run: string;
  /** The waiting step's full path. */
  step: string;
  /** The pass the answer will apply to. */
  pass: number;
  /** The engine's literal CLI response template. */
  respond: string;
}

/** A HITL request as the engine's `next` sends it. A `default` that is not text counts as none. */
const HitlRequestSchema = z.object({
  run: z.string(), step: z.string(), pass: z.number(), respond: z.string(), kind: z.enum(['approve', 'choose']), message: z.string(), required: z.boolean(),
  options: z.array(z.string()), default: z.string().optional().catch(undefined),
});

/** What the engine's `next` says the driver waits for. */
/** What a step held for strict isolation misses, as `wait.held` names it. */
const ISOLATION = 'isolation' satisfies Missing;
const HITL = 'hitl' satisfies Missing;

const WaitReplySchema = z.object({
  delivering: z.array(z.unknown()).optional().catch(undefined),
  reason: z.string().optional().catch(undefined),
  held: z.array(z.object({ step: z.string(), reason: z.string(), missing: z.array(z.string()), limitedTool: z.string().optional().catch(undefined) })).optional().catch(undefined),
}).catch({});

/** A step a runtime held back, as a wait names it. */
type WaitHeld = NonNullable<z.infer<typeof WaitReplySchema>['held']>[number];

/** What the driver says once it handed run `runId` to a person at `steps`, and the command that person runs. */
function handedToPerson(runId: string, steps: readonly string[]): WorkflowEnvelope {
  const resume = `teamai workflow resume ${runId} --claim`;
  log.info(offeredToPerson(runId, steps, resume));

  return { data: { handoff: { run: runId, steps: [...steps], resume } } };
}

/**
 * Where a run that relays its gates stops once nothing it started still runs: at gate `hitl`, which the agent session
 * that started the run answers with `respond`, or hands to the person, and then continues with `resume` on `driver`.
 * `isConfirmed`: the person agreed to the run at its start, as an `invoke: ask` workflow needs, so the session's resume
 * carries that yes.
 */
function relayedGate(hitl: LocalHitl, { driver, isConfirmed }: { driver: string; isConfirmed: boolean }): WorkflowEnvelope {
  const { run, step, pass, kind, message, options, required, respond } = hitl;
  const resume = `teamai workflow resume ${run} --driver ${driver}${isConfirmed ? ' --confirmed' : ''}`;
  log.info(`Run ${run} waits at step "${step}" (pass ${pass}): ${message}\nOptions: ${options.join(', ')}. Required: ${required ? 'yes' : 'no'}.\nAnswer: ${respond}\nThen: ${resume}`);

  return { data: { hitl_waiting: { run, step, pass, kind, message, options, required, ...(hitl.default !== undefined && { default: hitl.default }), respond, resume } } };
}

/** Whether every step `next` held from this driver waits for a confined tool here that reaches its level or resolves its model. */
function heldForConfined(held: ReadonlyArray<{ missing: readonly string[] }> | undefined): held is ReadonlyArray<{ reason: string; missing: string[] }> {
  return held !== undefined && held.length > 0 && held.every(({ missing }) => missing.includes('confined') || missing.includes('model'));
}

/** Reads the line typed at the terminal after `prompt`. Aborting `signal` closes it unanswered. */
async function readLine(prompt: string, signal: AbortSignal): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });

  try {
    return await terminal.question(prompt, { signal });
  } finally {
    terminal.close();
  }
}

async function askHitl(hitl: LocalHitl, signal: AbortSignal): Promise<string> {
  process.stderr.write(`Step "${hitl.step}": ${hitl.message}\nOptions: ${hitl.options.join(', ')}\n${hitl.respond}\n`);

  return readLine('Choice, followed by an optional note: ', signal);
}

/** Local tool selection and terminal behavior for one driver invocation. */
export interface LocalDriverOptions {
  /** Overrides auto approval for this run without changing member config; the run remembers it on this install. */
  autoApprove?: boolean;
  /** Declares whether a person can answer HITL requests and work in foreground tools. */
  hitl?: boolean;
  /** Declares this host a sandbox for this run, as `workflows.sandbox` does for every process; the run remembers it on this install. */
  sandbox?: boolean;
  /** The terminal question implementation, injectable for callers without readline. */
  question?: (hitl: LocalHitl, signal: AbortSignal) => Promise<string>;
  tools?: Record<string, string>;
  /** The team's `toolPaths`, as teamai.yaml states them. */
  toolPaths?: TeamaiConfig['toolPaths'];
  /** Runs each prompt step's tool here in place of the `tools` runtime's own launch. */
  adapter?: StepLauncher;
  /** Where the tools a step confined to a directory runs on are looked up: PATH unless given. */
  resolveTool?: (executable: string) => string | null;
  /** Called with the runs each report the engine took answers its settled passes started, which the caller drives. */
  started?: (runs: readonly StartedRun[]) => void;
  /**
   * Shown each line a command step writes to stderr as it writes it, masked, with the stream the command meant it for:
   * what a shortcut of the run shows live.
   */
  progress?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** The runtimes of the driver definition `--driver` names, in its order. Without it, the loop has one: `tools`. */
  runtimes?: DriverRuntimes;
  /**
   * Awaited once a prompt step's place is prepared, before the driver checks whether its tool may start, with the signal
   * that stops the attempt, as on a cancel.
   */
  prepared?: (lease: { step: string; attempt: AttemptId }, signal: AbortSignal) => Promise<void>;
}

/** A driver definition's runtimes, which the loop offers in turn: each step goes to the first that can take it. */
export interface DriverRuntimes {
  /** The definition's canonical name, recorded with each attempt. */
  driver: string;
  /** The name the member gave it, such as `t3` for `teamai-t3`, which a command this driver prints names. */
  asked: string;
  runtimes: OpenedDriver['runtimes'];
}

/**
 * One runtime the loop offers: `host`, the command slot every definition has, which runs commands on this machine;
 * `tools`, which launches the member's tools in this process; or an external one, such as `fleet`, whose steps go
 * through an `AttemptRun`. Each is reached through the `StepRuntime` interface for its offer and the lifecycle of its
 * attempts' places.
 */
type RuntimeSlot = SlotBase & { kind: 'host' | 'tools' | 'external' };

interface SlotBase {
  use: string;
  runtime: StepRuntime<DriverCan>;
  can: DriverCan;
  /** Its prompt steps go as `prompt`, never as an exec of the tool's argv. */
  launchesAgents: boolean;
  /** A prompt's conversation outlives the prompt in its place, so the place may be held for a later step (`HeldPlace`). */
  keepsConversations?: true;
  engine: EngineOptions;
  /** The values of the credentials the runtime declares, which only its prompts' tools get. */
  credentials: Record<string, string>;
  /** The names of `credentials` found in the member's environment, each only for the tool it signs in. */
  found: readonly string[];
  /** The tools it cannot run now, with the runtime's reason. */
  unavailable?: Record<string, string>;
  /** Its prompts' tools run in another runtime (`use: t3, through: sandbox`). */
  isThrough?: true;
  /** It runs each prompt's tool in the attempt's tool home, as a runtime that execs the tool does. */
  runsOnToolHome?: true;
  /** Where the runtimes it runs on came from, which each attempt on it records. */
  sources?: readonly RuntimeOrigin[];
}

type ReportBody = ReportInput;

/**
 * A lease as this driver runs it. A lease whose workspace alone it cannot read, which reads as a lease without it, is
 * kept, marked, so its step fails instead of running in the active checkout.
 */
const LocalLeaseSchema = LeaseWireSchema.or(z.preprocess((raw) => (isRecord(raw) ? { ...raw, workspace: undefined } : raw), LeaseWireSchema)
  .transform((lease): StagedLease => ({ ...lease, unreadableWorkspace: true })));

/**
 * Gets the lease a place to run under `root`, with the team env resolved for it. `signal` stops setup, which
 * then fails, and the workspace it was preparing is removed. A prompt step's place is prepared for `launches`, the tool
 * `promptReport` launches there, when the lease names none.
 */
async function stageLease(lease: StagedLease, { config, lock, root, env, mode, signal, launches, setUpOn, runsOn, leftRunning }: {
  config: LocalConfig;
  lock: RunLock;
  /** The attempts whose earlier run left a process no stop here confirms ended, which `stopLeftHere` adds to. */
  leftRunning: Set<string>;
  root: string;
  env: WorkflowEnv;
  mode: RunMode;
  signal?: AbortSignal;
  launches?: string;
  /** The attempt's run on its step runtime, which runs setup once the step opens its place there (`runtimeSetup`). */
  setUpOn?: AttemptRun;
  /** The step runtime this driver gives the attempt, by its definition's name; undefined for this host. */
  runsOn?: string;
}): Promise<WorkflowFailure | undefined> {
  if (lease.unreadableWorkspace) return unreadablePlace(lock.run);
  // A lease is handed back to a driver after one of this run was killed: the setup or command that one left running
  // in the attempt's place is stopped before the attempt is staged again.
  const leftHere = await stopLeftHere({ config, run: lock.run, attempt: lease.attempt, step: lease.step, leftRunning });

  if (leftHere) return leftHere;
  // So is what a killed teamai left on a step runtime, which may write into the place by its path: on another runtime,
  // through the driver recorded for it; on this one, its setup here.
  const moved = await stopLeftElsewhere({ config, run: lock.run, attempt: lease.attempt, runsOn, checkout: root });

  if (moved) return moved;
  const leftSetup = (await setUpOn?.stopLeftSetup())?.failure;

  if (leftSetup) return { code: 'runtime_lost', message: leftSetup.message };
  // A setup cut short is given up with the folder it ran in, which the prepare makes again (`preparedPlace`).
  const unclosed = setUpOn && await isSetupCutShort({ config, run: lock.run, attempt: lease.attempt }) ? (await setUpOn.closeForRemadeFolder())?.failure : undefined;

  if (unclosed) return { code: 'runtime_lost', message: unclosed.message };

  if (lease.envScope) {
    const scoped = await stepEnvironment(env, lease.envScope);

    if (!scoped.ok) return scoped.failure;
    lease.processEnv = scoped.env;
  } else {
    lease.processEnv = withRunningCli(process.env);
  }

  const placeLease = placeLeaseOf(lease);

  if (lease.tool === undefined && launches !== undefined) placeLease.tool = launches;
  const prepared = await preparedPlace({ config, lock, root, lease: placeLease });

  if (prepared.kind !== 'prepared') return prepared.failure;
  lease.cwd = prepared.dir;

  if (prepared.prompt !== undefined) lease.prompt = prepared.prompt;

  return setUpOn ? undefined : runPlaceSetup({ config, run: lock.run, attempt: lease.attempt, mode, env, signal });
}

/**
 * Stops what a killed teamai left running in attempt `attempt`'s place here before the attempt runs again. A process
 * no stop confirms ended may still run, its tool on the login the attempt holds: the attempt does not run beside it, and
 * is added to `leftRunning`, whose close stops that process again and keeps the login while it may still run.
 */
async function stopLeftHere({ config, run, attempt, step, leftRunning }: { config: LocalConfig; run: RunId; attempt: StagedLease['attempt']; step: string; leftRunning: Set<string> }): Promise<WorkflowFailure | undefined> {
  const left = await stopRecordedGroup(attemptDir(config, run, attempt));

  if (left.length === 0) return undefined;
  leftRunning.add(attempt);

  return {
    code: 'runtime_lost',
    message: `teamai could not confirm that process ${left.join(', ')}, which an earlier run of attempt ${attempt} of run ${run} left, ended, so the step did not run again beside it. Once that process has ended, run teamai workflow retry ${run} ${step}.`,
  };
}

/**
 * Stops what a killed teamai left of attempt `attempt` open on a step runtime other than `runsOn`, the one this driver
 * gives it (undefined: this host), through the driver recorded for it, as `teamai workflow cancel` does. Once that place
 * is closed, the attempt starts again here: its record of the other runtime goes. Answers why the stop is not confirmed,
 * which keeps the place and the record.
 */
async function stopLeftElsewhere({ config, run, attempt, runsOn, checkout }: { config: LocalConfig; run: RunId; attempt: string; runsOn: string | undefined; checkout: string }): Promise<WorkflowFailure | undefined> {
  const id = AttemptIdSchema.safeParse(attempt);
  const placement = id.success ? await readAttemptPlacement(config, run, id.data) : undefined;

  // One in teamai's process left its process group, which staging stops; it holds no place elsewhere. An unreadable
  // record names no place to stop.
  if (!id.success || placement?.kind !== 'external' || placement.record.phase === 'closed' || placement.record.runtime === runsOn) return undefined;
  const notStopped = await stopOnRecordedDriver(config, run, id.data, { checkout });

  if (notStopped) return notStopped;
  await fs.rm(attemptRuntimePath(config, run, id.data), { force: true });

  return undefined;
}

async function commandReport(config: LocalConfig, lock: RunLock, driver: DriverIdentity, lease: StagedLease, exited: GroupedCommandExit, secrets: Record<string, string>, onStdoutKept?: (file: string) => void): Promise<ReportBody> {
  const result = { ...exited, stderr: withoutStreamMarks(exited.stderr) };
  const end = lease.workflow ? wholeReport(result, lease.step) : commandEnd(result);
  await AttemptResult.write(attemptResultPath(config, lock.run, lease.attempt), end.outputs !== undefined ? { output: end.outputs } : {}, secrets);
  // A whole workflow answers on stdout, which is never text it printed.
  const attempt = AttemptIdSchema.safeParse(lease.attempt);
  const kept = !lease.workflow && end.outputs === undefined && attempt.success ? await keepAttemptStdout(config, { run: lock.run, attempt: attempt.data, stdout: result.stdout, secrets }) : undefined;

  if (kept !== undefined) onStdoutKept?.(kept);

  // What a command says as it runs goes to its stderr, so its stdout stays the step's outputs.
  const progress = result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => masked(line, secrets));
  const body: ReportBody = { attempt: lease.attempt, revision: lease.revision, driver, ...end };

  if (progress.length > 0) body.progress = progress;

  return body;
}

/**
 * How a workflow step leased whole ended, from what its runtime's exec answered on stdout (`WholeEndSchema`): the
 * outcome, end, outputs and failure of the workflow it ran. An exec that answered none, as one stopped early, ends as
 * the command it then was, and one that exited 0 without an answer fails: nothing says the workflow's steps ran.
 */
function wholeReport(result: GroupedCommandExit, step: string): Omit<ReportBody, 'attempt' | 'revision' | 'driver'> {
  const parsed = WholeEndSchema.safeParse(commandOutputs(result.stdout));

  if (!parsed.success && result.exitCode === 0) {
    const message = `Step "${step}" was leased whole, and its runtime's exec exited 0 without saying how the workflow ended, so teamai cannot tell whether its steps ran. Check the runtime's log, then run the workflow again.`;

    return { outcome: 'failed', exitCode: result.exitCode, message, failure: { code: 'runtime_protocol', message } };
  }

  if (!parsed.success) return commandEnd(result);
  const { outcome, end, outputs, failure, tokens } = parsed.data;

  return {
    outcome: outcome === 'succeeded' ? 'success' : 'failed', exitCode: result.exitCode,
    ...(end !== undefined && { end }), ...(outputs !== undefined && { outputs }), ...(failure && { failure, message: failure.message }),
    ...(tokens !== undefined && { tokens }),
  };
}

function masked(line: string, secrets: Record<string, string>): string {
  return redact(line, { envSecrets: secrets, patterns: false });
}

/** Writes that call `show` with each whole line of the chunks given, and with what is left once `end` is called. */
function lineSplitter(show: (line: string) => void) {
  let rest = '';
  const each = (line: string): void => { if (line.trim() !== '') show(line); };

  return {
    write: (chunk: string): void => {
      const lines = `${rest}${chunk}`.split(/\r?\n/);
      rest = lines.pop() ?? '';
      lines.forEach(each);
    },
    end: (): void => { each(rest); rest = ''; },
  };
}

/**
 * Run leased commands, up to `workflows.max_parallel` at once, or with none set one at a time but for the items of a
 * `for_each` that declares `max_parallel`. Each lease and report goes through the same engine operations an external
 * driver calls.
 */
export async function runLocalDriver(
  config: LocalConfig,
  runId: string,
  cwd: string,
  options: LocalDriverOptions = {},
): Promise<WorkflowEnvelope> {
  return withDriverLock(config, runId, (driveLocked) => driveLocked(cwd, options));
}

/**
 * Runs `body` holding this machine's driver lock of run `runId`, or answers `driver_running` without running it. `body`
 * drives the run through `drive`, so whatever it changes first, such as a claim, no other local driver of the run sees.
 */
export async function withDriverLock(
  config: LocalConfig,
  runId: string,
  body: (drive: (cwd: string, options: LocalDriverOptions) => Promise<WorkflowEnvelope>) => Promise<WorkflowEnvelope>,
): Promise<WorkflowEnvelope> {
  const run = RunIdSchema.safeParse(runId);

  if (!run.success) return { error: { code: 'invalid_run', message: 'Run id must look like r followed by 8 or 16 hex digits' } };

  return withRunLock(config, run.data, (lock) => body((cwd, options) => driveRun(config, lock, cwd, options)), { waitMs: 0 });
}

/** Adds to `seen` each value of `secrets` it lacks, under a label of its own when its name already holds another value. */
function rememberSecrets(seen: Record<string, string>, secrets: Record<string, string>) {
  const known = new Set(Object.values(seen));

  for (const [key, value] of Object.entries(secrets)) {
    if (known.has(value)) continue;
    let label = key;

    for (let count = 2; label in seen; count += 1) label = `${key} (value ${count})`;
    seen[label] = value;
    known.add(value);
  }

  return { ...seen };
}

/**
 * What this driver declares on every `next`. Every key is set, so a new capability does not compile until it is decided.
 * It runs setup in each workspace it creates. `tools` are the tools it launches a prompt step on, named or picked. It
 * ends a prompt's turn at the limits its lease carries. It runs an unattended prompt in its tool's unattended mode, and
 * fails one whose tool has none.
 */
function localCan({ strict, hitl, tools, confined }: { strict: StrictCan; hitl: boolean; tools: string[]; confined: ConfinedOffer[] }): DecidedCan {
  return { hitl, exec: true, workspace: [...WORKSPACE_MODES], ...strict, tokens: true, max_turns: true, setup: true, tools, end_turn: true, unattended: true, role: true, confined };
}

type StrictCan = Required<Pick<DecidedCan, 'network' | 'isolation' | 'env'>>;

/**
 * What this driver gives the strict requirements of a run on this machine, which a local start checks before the run
 * exists. It cannot deny a step the network, keeps it from the member's machine only on a host the member marks
 * `sandbox`, in config or with `--sandbox`, and gives each command and tool only the env keys its lease provides.
 */
export function localStrictCan(config: LocalConfig, options: Pick<LocalDriverOptions, 'sandbox'>): StrictCan {
  return { network: false, isolation: isSandbox(config, options) ? 'sandbox' : 'none', env: true };
}

/** Whether the command that starts the tool `name` names is on PATH here. */
function onPath(name: string): boolean {
  const target = launchTargetOf(name);

  return target !== undefined && launchExecutableOf(target) !== null;
}

/**
 * The tools the run's steps launch on: `named`, those its steps name, undefined when a `from` step may bring a workflow
 * that names any; and `picked`, those `toolFor` picks for its prompt steps that name none, with the pick for a step that
 * names no agent when a `from` step may bring one. Looking a tool up can start login shells, so the driver looks up only
 * the named ones.
 */
function runTools(run: Pick<RunState, 'definition' | 'workflows'>, toolFor: ToolFor) {
  const named = new Set<string>();
  const picked = new Set<string>();
  let bringsSteps = false;

  const visit = (steps: readonly WorkflowStep[]): void => {
    for (const step of steps) {
      const tool = promptTool(step, toolFor);

      if (step.tool !== undefined) named.add(step.tool);
      else if (tool !== undefined) picked.add(tool);
      const child = stepWorkflow(step);

      if (child?.kind === 'from') bringsSteps = true;

      if (child?.kind === 'inline') visit(child.workflow.steps);
    }
  };

  for (const definition of [run.definition, ...Object.values(run.workflows ?? {})]) visit(definition.steps);
  const unnamed = bringsSteps ? toolFor({}) : undefined;

  if (unnamed !== undefined) picked.add(unnamed);

  return { named: bringsSteps ? undefined : named, picked };
}

/**
 * Whether a step of `run` may be confined to a directory: one is, or a `from` step may bring a workflow with one. Probing
 * the confined tools runs each, so the driver probes them only then.
 */
function mayConfine(run: Pick<RunState, 'definition' | 'workflows'>): boolean {
  const confines = (steps: readonly WorkflowStep[]): boolean => steps.some((step) => {
    const child = stepWorkflow(step);

    return confinedOf(step) !== undefined || child?.kind === 'from' || (child?.kind === 'inline' && confines(child.workflow.steps));
  });

  return [run.definition, ...Object.values(run.workflows ?? {})].some((definition) => confines(definition.steps));
}

/**
 * Whether two items of `run` may run at once with no `workflows.max_parallel`: a `for_each` it has now declares
 * `max_parallel` above 1, or a template of it. A workflow a `from` step admits later is read when the run is driven
 * again, so such a run keeps the terminal, one step at a time, until then.
 */
function mayRunItemsBeside(run: Pick<RunState, 'definition' | 'workflows' | 'admitted'>): boolean {
  const beside = (steps: readonly WorkflowStep[]): boolean => steps.some((step) => {
    const max = step.forEach?.maxParallel;
    const child = stepWorkflow(step);

    return (max !== undefined && (max instanceof Object || max > 1)) || (child?.kind === 'inline' && beside(child.workflow.steps));
  });

  const definitions = [run.definition, ...Object.values(run.workflows ?? {}), ...Object.values(run.admitted ?? {}).map(({ definition }) => definition)];

  return definitions.some((definition) => beside(definition.steps));
}

function isSandbox(config: LocalConfig, options: Pick<LocalDriverOptions, 'sandbox'>): boolean {
  return options.sandbox === true || config.workflows?.sandbox === true;
}

/**
 * Whether a person answers the HITL requests the local driver puts to them in run mode `mode`: an attended run at a
 * terminal. A terminal alone is not a person: an unattended run under a pseudo-terminal asks nobody.
 */
export function personAnswers(mode: RunMode): boolean {
  return mode === 'attended' && Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
}

/**
 * The flags a drive runs with: those `given`, over the ones the run `remembered` from this install's last drive, a
 * `--tools` name at a time. A flag left out keeps what the run remembers. The driver definition is the one this drive
 * runs on, which `workflow resume` reopens when it names none; `local`, whichever teamai-local it opened, records none.
 */
function drivenWith(given: Pick<LocalDriverOptions, 'tools' | 'autoApprove' | 'sandbox' | 'runtimes'>, remembered: DriveOptions | undefined): DriveOptions {
  const driven: DriveOptions = {};
  const tools = { ...remembered?.tools, ...given.tools };

  if (Object.keys(tools).length > 0) driven.tools = tools;
  // Kept off as well as on: an off overrides the member's workflows.auto_approve, as the flag does.
  const autoApprove = given.autoApprove ?? remembered?.autoApprove;

  if (autoApprove !== undefined) driven.autoApprove = autoApprove;

  if (given.sandbox ?? remembered?.sandbox) driven.sandbox = true;

  if (given.runtimes && given.runtimes.asked !== LOCAL_DRIVER) driven.driver = given.runtimes.driver;

  return driven;
}

/**
 * `given` over what run `run` remembers, which the run then remembers for the next drive, so a resume without flags
 * drives the run as this one does. Answers the error when the run file could not be written.
 */
async function rememberDrive(config: LocalConfig, run: RunState, given: LocalDriverOptions): Promise<LocalDriverOptions | { error: WorkflowFailure }> {
  const driven = drivenWith(given, run.driveOptions);
  // Neither given nor remembered, auto-approve stays unset, so the member's workflows.auto_approve decides.
  const options = { ...given, tools: driven.tools ?? {}, autoApprove: driven.autoApprove, sandbox: driven.sandbox === true };

  if (JSON.stringify(driven) === JSON.stringify(run.driveOptions ?? {})) return options;

  const written = await updateRun(config, run.id, await knownSecrets(config), async (stored) => ({
    value: undefined,
    write: stored === 'missing' ? undefined : { ...stored, driveOptions: driven },
  }));

  if (written.status === 'busy') return { error: { code: 'busy', message: `Run ${run.id} is locked by another process, so it was not driven. Resume it again: teamai workflow resume ${run.id}` } };

  if (written.status === 'corrupt') return { error: { code: 'run_unreadable', message: `Run ${run.id} could not be read` } };

  return options;
}

async function driveRun(config: LocalConfig, lock: RunLock, cwd: string, given: LocalDriverOptions): Promise<WorkflowEnvelope> {
  const runId = lock.run;
  const started = await readRun(config, runId);
  // Places go under the checkout the run started from, wherever in it the driver runs.
  const isStarted = started !== 'missing' && started !== 'corrupt';
  const drive = isStarted ? await rememberDrive(config, started, given) : given;

  if ('error' in drive) return drive;
  const options = drive;
  const root = await placeRoot({ cwd, checkout: isStarted ? started.checkout : undefined });
  const unreconciled = await reconcileTakenCopies(config, runId, root);

  if (unreconciled) return { error: unreconciled };
  // Resolved once per drive, so a resume where a person attends runs attended whatever mode the run started in.
  const mode = resolveRunMode(process.env);
  const canHitl = options.hitl ?? personAnswers(mode);
  const members = await memberTools(config);

  // The tool a prompt step that names none launches on, which a runtime must offer as it must a named one: an
  // instance by its own name, since a runtime that offers the tool it extends does not run it. Offered to a runtime
  // that reports the default of the app it drives, that default comes before the member's own.
  const toolForOn = (runtimeDefault: string | undefined): ToolFor => (step) => {
    const choice = launchToolFor(step, config, options.tools ?? {}, members, runtimeDefault);

    return choice.ok ? choice.target.name : undefined;
  };

  // The pick with no runtime's default: the member's own tools here.
  const toolForHere = toolForOn(undefined);

  // It launches a step that names its tool on the tools this machine has: those the run's steps name, or every one when a
  // step's output may bring a workflow later. It is the run's only driver, so a step whose tool it cannot launch fails
  // rather than waits. A tool it picks for a step that names none, and that no step names, it offers without looking it
  // up, as it always launched it: launching it says if it is missing.
  const { named, picked } = isStarted ? runTools(started, toolForHere) : { named: undefined, picked: new Set<string>() };
  const found = [...LAUNCH_TOOLS, ...toolInstancesFor('use').flatMap(({ kind, name }) => kind === 'instance' ? [name] : [])].filter((tool) => (named === undefined || named.has(tool)) && onPath(tool));
  const pickedUnlooked = [...picked].filter((tool) => !found.some((launched) => launched === tool) && !(named?.has(tool) ?? false));
  const tools = [...found, ...pickedUnlooked];
  const defined: DriverRuntimes = options.runtimes ?? { driver: 'local', asked: 'local', runtimes: [{ kind: 'tools', use: 'tools', engine: { logins: [] } }] };
  const lookup = options.resolveTool ? { resolveTool: options.resolveTool } : {};
  const confined = isStarted && mayConfine(started) ? await confinedOffers(lookup) : [];
  const hostRuntime = hostStepRuntime({ config, can: localCan({ strict: localStrictCan(config, options), hitl: canHitl, tools, confined }) });
  const hostReady = await hostRuntime.init({ options: {}, mode, homeEnv: homeEnvOf([]) });

  if (!hostReady.ok) return { error: { code: 'runtime_failed', message: hostReady.failure.message } };

  // An external runtime is offered with what it said it can. One that execs the tool launches only the tools it can give
  // a home, and the instances of them it lists; one that launches agents its own way gives each its own. It keeps
  // `can.confined` only when its init said it answers confined prompts (the stdio reader drops it otherwise).
  // A runtime that runs a tool without permission prompts outside a sandbox proves no isolation: its steps' is none.
  const unproven = (can: DriverCan): boolean => (can.fullAccess?.length ?? 0) > 0 && can.isolation !== 'sandbox';

  // What this machine declares it has that teamai does not model: a step's requires.labels runs here only with each.
  const hostLabels = config.workflows?.labels;
  const hostCan: DriverCan = hostLabels ? { ...hostReady.can, labels: hostLabels } : hostReady.can;

  // `tools` launches the member's tools for prompt steps and runs no command; the host runtime runs those in this process.
  const toolsRuntime = toolsStepRuntime<DriverCan>({ can: hostCan, launch: toolsLaunchDeps(), ...(options.adapter && { launcher: options.adapter }) });
  const toolsReady = await toolsRuntime.init({ options: {}, mode, homeEnv: homeEnvOf([]) });

  if (!toolsReady.ok) return { error: { code: 'runtime_failed', message: toolsReady.failure.message } };

  const toSlot = (entry: OpenedDriver['runtimes'][number]): RuntimeSlot => {
    switch (entry.kind) {
      case 'tools':
        return { kind: 'tools', use: entry.use, runtime: toolsRuntime, can: toolsReady.can, launchesAgents: false, engine: entry.engine, credentials: {}, found: [] };
      case 'external':
        return {
          kind: 'external', use: entry.use, runtime: entry.runtime, launchesAgents: entry.launchesAgents, engine: entry.engine, credentials: entry.credentials, found: entry.found,
          ...(entry.unavailable && { unavailable: entry.unavailable }), ...(entry.isThrough && { isThrough: true }), ...(entry.keepsConversations && { keepsConversations: true }), ...(entry.runsOnToolHome && { runsOnToolHome: true }), ...(entry.sources && { sources: entry.sources }),
          can: {
            // One that runs its tool on the attempt's tool home, as one that execs it does, runs only the tools a tool home holds.
            ...entry.can, tools: entry.launchesAgents && entry.runsOnToolHome !== true ? entry.can.tools : (entry.can.tools ?? []).filter((tool) => isExecRuntimeTool(baseToolOf(tool))), remote: true,
            ...(unproven(entry.can) && { isolation: 'none' as const }),
          },
        };
      default: {
        const unhandled: never = entry;

        return unhandled;
      }
    }
  };

  for (const entry of defined.runtimes) {
    if (entry.kind === 'external' && unproven(entry.can)) {
      log.warn(`Runtime ${entry.use} of driver ${defined.driver} runs steps in full access on this machine, as ${entry.optionsFrom} sets: they run without asking for permission, an unattended run approves the runtime's own full-access sign-in where it asks for one, and teamai cannot prove any isolation. Their isolation is recorded as none.`);
    }
  }

  // The definition's `tools` is the slot in this process, which offers what this machine does, as `local` did: its
  // commands run on the host runtime, and its prompt steps' tools launch on `tools`, so a run takes its steps in the
  // order it always did. A definition with none has the host command slot last, which takes no prompt step but answer
  // steps. While another runtime runs commands, the slot here takes only the command steps of teamai's own workflows,
  // so a team's command never runs here in place of that runtime. With no runtime of the definition open, as on the
  // built-in `host`, the slot runs alone and calls no AI tool, so it takes no answer step either.
  const definedSlots = defined.runtimes.map(toSlot);
  const inProcess = definedSlots.find((slot) => slot.kind === 'tools');
  const isHostAlone = definedSlots.length === 0;

  const hostSlot: RuntimeSlot = inProcess ?? {
    kind: 'host', use: 'host', runtime: hostRuntime, can: { ...hostCan, prompt: false, ...(isHostAlone && { answer: false as const }), tools: [], confined: [] }, launchesAgents: false, engine: { logins: [] }, credentials: {}, found: [],
  };

  const runsCommands = definedSlots.some((slot) => slot.kind === 'external' && slot.can.exec !== false);
  const host = runsCommands ? { ...hostSlot, can: { ...hostSlot.can, commands: 'pinned' as const } } : hostSlot;
  const ordered = inProcess ? definedSlots.map((slot) => (slot === inProcess ? host : slot)) : [...definedSlots, host];
  const [firstSlot = host, ...otherSlots] = ordered;
  const slots: [RuntimeSlot, ...RuntimeSlot[]] = [firstSlot, ...otherSlots];
  const offerOf = (slot: RuntimeSlot): RuntimeOffer => ({ runtime: slot.use, can: slot.can, ...(slot.kind !== 'external' && { inProcess: true }), ...(slot.unavailable && { unavailable: slot.unavailable }) });
  const sole: SoleDriver = { driver: defined.driver, offers: [offerOf(slots[0]), ...otherSlots.map(offerOf)] };
  // Started or resumed from an agent session, with no terminal here, on a runtime a person reaches through its app, or
  // on the host slot alone, which the session started in the background: a gate is relayed to that session rather than
  // decided, and the loop stops at it once nothing it started still runs.
  const relay = !canHitl && mode === 'attended' && agentEvidence(process.env).kind !== 'none' && (isHostAlone || slots.some((slot) => slot.can.hitl === true));
  const driver = driverIdentity('local', cwd);
  // The runtime each open attempt runs on, and the handle of its place, until its report is recorded or its place abandoned.
  const slotOf = new Map<string, RuntimeSlot>();
  const attemptRuns = new Map<string, AttemptRun>();
  const leftRunning = new Set<string>();
  // The place of each attempt on a runtime in this process, by the runtime that opened it.
  const localHandles = new Map<string, { runtime: StepRuntime<DriverCan>; handle: string }>();

  const runOf = (lease: StagedLease): AttemptRun | undefined => {
    const slot = slotOf.get(lease.attempt);

    if (slot?.kind !== 'external') return undefined;
    const known = attemptRuns.get(lease.attempt);

    if (known) return known;
    // The lease's expiry is the latest the attempt may run on its runtime. A turn limit ends the turn instead, and the
    // driver keeps it itself, so it gives no deadline.
    const created = attemptRun({ config, run: runId, attempt: lease.attempt, runtime: slot.runtime, driver: defined.driver, ...(slot.sources && { sources: slot.sources }), ...(lease.expiresAt !== undefined && { deadline: lease.expiresAt }) });
    attemptRuns.set(lease.attempt, created);

    return created;
  };

  /** The external step runtime the lease's attempt is bound to, by its definition's name; undefined on this host. */
  const externalOf = (lease: StagedLease): string | undefined => {
    const slot = slotOf.get(lease.attempt);

    return slot?.kind === 'external' ? slot.use : undefined;
  };

  // Each runtime before the one a step lands on that cannot run its tool now, once per drive, by runtime and tool.
  const fellPast = new Set<string>();

  /** Says once, with that runtime's reason, that a prompt step passed a runtime that lists its tool as unavailable. */
  const sayFellPast = (lease: StagedLease, slot: RuntimeSlot): void => {
    if (lease.prompt === undefined || lease.answer || lease.confined) return;
    const choice = launchToolFor({ agent: lease.agent, tool: lease.tool }, config, options.tools ?? {}, members, slot.can.default_tool);
    const tool = choice.ok ? choice.target.name : undefined;

    for (const earlier of slots.slice(0, slots.indexOf(slot))) {
      const reason = tool === undefined ? undefined : earlier.unavailable?.[tool];
      const key = `${earlier.use}\u0000${tool ?? ''}`;

      if (reason === undefined || fellPast.has(key)) continue;
      fellPast.add(key);
      log.warn(`Runtime ${earlier.use} of driver ${defined.driver} cannot run ${tool} now, so steps on ${tool} run on runtime ${slot.use}: ${earlier.use}: ${reason}`);
    }
  };

  /** Binds a lease to the runtime it was offered on. An attempt in this process has its place opened at once: it is the host's. */
  const bind = async (lease: StagedLease, slot: RuntimeSlot): Promise<void> => {
    slotOf.set(lease.attempt, slot);
    sayFellPast(lease, slot);

    if (slot.kind === 'external') return;
    const attempt = AttemptIdSchema.safeParse(lease.attempt);

    // Named for what runs, as the step's record is.
    const runtime = inProcessRuntimeOf({ isPrompt: lease.prompt !== undefined, isAnswer: lease.answer === true });
    // What a killed teamai left of the attempt on another runtime is stopped first, by that runtime's record, which this
    // record would replace. A stop not confirmed keeps that record, and staging the lease fails the step on it.
    const leftElsewhere = attempt.success ? await stopLeftElsewhere({ config, run: runId, attempt: lease.attempt, runsOn: undefined, checkout: root }) : undefined;

    if (attempt.success && leftElsewhere === undefined) await recordInProcessAttempt(config, runId, attempt.data, { runtime, driver: defined.driver });
    const view = { worktree: lease.cwd ?? root, readonly: [], result: path.dirname(attemptResultPath(config, runId, lease.attempt)), runDir: runScratchDir(config, runId), toolHome: {} };
    const opened = await slot.runtime.open({ op: newOpId(), run: runId, attempt: lease.attempt, view, credentials: {} }, async () => {});

    if (opened.kind === 'ready') localHandles.set(lease.attempt, { runtime: slot.runtime, handle: opened.handle });
  };

  // The handle of the last place each external runtime closed for this run, which it is sent again once teamai removed
  // a clone or a team folder, so it sees the folder gone at a close, the verb it cleans up at.
  const lastClosed = new Map<RuntimeSlot, string>();

  const closeRun = async (attempt: AttemptId): Promise<void> => {
    // A run its command step's process started and drove is part of the attempt, and ends with it.
    await endRunsPartOf(config, { run: runId, attempt });
    const closing = attemptRuns.get(attempt);
    const handle = localHandles.get(attempt);
    const slot = slotOf.get(attempt);
    const placement = slot?.kind === 'external' ? await readAttemptPlacement(config, runId, attempt) : undefined;
    const closingHandle = placement?.kind === 'external' ? placement.record.open.handle : undefined;
    attemptRuns.delete(attempt);
    localHandles.delete(attempt);
    slotOf.delete(attempt);
    const notClosed = await closing?.close();

    if (slot && closingHandle !== undefined && !notClosed) lastClosed.set(slot, closingHandle);

    if (handle !== undefined) await handle.runtime.close(handle.handle);

    // A closed attempt holds no login, whatever stopped it before its write-back. One whose place stays open may
    // still run its tool, so it keeps the login until a person stops that tool.
    if (notClosed) log.warn(notClosed.message);

    // One that did not run again beside what its earlier run left here keeps its login while that may still use it,
    // whatever runtime it was to run on.
    if (leftRunning.has(attempt)) {
      await stopLeftInProcess(config, runId, attempt);

      return;
    }

    // One in teamai's process left its tool home under the attempt, which a killed judge refreshed its login in.
    if (slot?.kind !== 'external') return endLeftLogins(config, runId, attempt);

    if (!notClosed) {
      const record = placement?.kind === 'external' ? placement.record : undefined;

      return endLeftLogins(config, runId, attempt, { toolHome: record?.toolHome, isCollected: record?.phase === 'collected' });
    }

    for (const tool of slot.engine.logins) {
      const holder = await loginHolder(tool);

      if (holder?.run === runId && holder.attempt === attempt) {
        log.warn(`The ${tool} login teamai keeps stays held by attempt ${attempt} of run ${runId}, whose tool may still run. Stop that tool on its step runtime; once run ${runId} has ended, run teamai workflow cancel ${runId} --release ${attempt}, which lets the attempt go and ends its login.`);
      }
    }
  };

  /** Whether `slot` may open another attempt under its own `max_parallel`. */
  const slotHasRoom = (slot: RuntimeSlot): boolean => slot.engine.maxParallel === undefined
    || [...slotOf.values()].filter((bound) => bound === slot).length < slot.engine.maxParallel;

  // A restarted loop hands each attempt it left open back to the runtime it ran on, one at a time, by its record: an
  // external one to the runtime the record names, one in teamai's process to the slot here. An attempt with no record
  // started nowhere, as each kind is recorded before it starts, so it goes to the first slot, as a new lease would.
  const reconnecting: Array<{ attempt: string; slot: RuntimeSlot }> = [];

  if (isStarted) {
    for (const step of started.steps) {
      if (step.status !== 'leased') continue;
      const attempt = AttemptIdSchema.safeParse(step.lease.attempt);
      const placement = attempt.success ? await readAttemptPlacement(config, runId, attempt.data) : { kind: 'unrecorded' as const };
      let slot: RuntimeSlot;

      switch (placement.kind) {
        case 'external': {
          const { runtime } = placement.record;
          slot = slots.find((candidate) => candidate.kind === 'external' && candidate.use === runtime) ?? slots.find((candidate) => candidate.kind === 'external') ?? slots[0];
          break;
        }

        case 'in_process':
          // One slot runs in teamai's process: the definition's tools, else the host's.
          slot = slots.find((candidate) => candidate.kind !== 'external') ?? slots[0];
          break;
        case 'unrecorded':
          slot = slots[0];
          break;
        case 'unreadable':
          // Nothing says it ran here, and an external runtime may still run it: that runtime's reattach finds out.
          log.warn(`The runtime record of attempt ${step.lease.attempt} cannot be read (${placement.why}), so teamai asks the first external runtime of this driver whether it still runs it.`);
          slot = slots.find((candidate) => candidate.kind === 'external') ?? slots[0];
          break;
        default: {
          const unhandled: never = placement;

          return unhandled;
        }
      }

      reconnecting.push({ attempt: step.lease.attempt, slot });
    }
  }

  /** The workspace step `step` shares with the steps beside it, where it may go on in an earlier step's conversation. */
  const workspaceOf = async (step: string): Promise<string | undefined> => {
    const state = await readRun(config, runId);

    return state !== 'missing' && state !== 'corrupt' ? sharedWorkspace(state, step) : undefined;
  };

  /**
   * The conversations the steps of the run that have not settled go on in, each with its workspace, and the workspace
   * step `step` shares with the steps beside it, where a later one may go on in its conversation.
   */
  const continuedAround = async (step: string): Promise<{ continued: ReturnType<typeof continuedConversations>; workspace: string | undefined }> => {
    const state = await readRun(config, runId);

    return state !== 'missing' && state !== 'corrupt' ? { continued: continuedConversations(state), workspace: sharedWorkspace(state, step) } : { continued: [], workspace: undefined };
  };

  /** This driver's runtime of a held place's record, which closes it with no second open of the driver. */
  const live = (record: AttemptRuntimeRecord): StepRuntime<DriverCan> | undefined => {
    const slot = record.driver === defined.driver ? slots.find((candidate) => candidate.kind === 'external' && candidate.use === record.runtime) : undefined;

    return slot?.kind === 'external' ? slot.runtime : undefined;
  };

  /** Closes the places held for a conversation that `continued` no longer names, or, without it, every one. */
  const releaseHeld = async (continued?: ReturnType<typeof continuedConversations>): Promise<void> => {
    for (const kept of await releaseHeldPlaces(config, runId, { checkout: root, continued, live })) log.warn(kept.message);
  };

  /** Offers the run to a person, closing with this driver's runtimes the places it holds, or says, as a clause, why it did not. */
  const offerHere = async (): Promise<string | undefined> => await offerToPerson(config, runId, { checkout: root, live });

  const abandon = async (attempt: AttemptId): Promise<void> => {
    await abandonPlace({ config, lock, attempt });
    await closeRun(attempt);
  };

  // A lease stopped before its tool started: a place that went on in work an earlier attempt kept keeps it for the next.
  const giveBackUnlaunched = async (attempt: AttemptId): Promise<void> => {
    await releaseUnlaunchedPlace({ config, lock, attempt });
    await closeRun(attempt);
  };

  // An attempt of this machine the run stopped while no driver ran it, as one whose lease a killed teamai held past its
  // timeout, may have left its tool running and its login held.
  const stopLeftByKilledDrivers = async (): Promise<void> => {
    const state = await readRun(config, runId);

    if (state === 'missing' || state === 'corrupt') return;

    for (const { attempt, driver: by } of state.stoppedAttempts ?? []) {
      const left = AttemptIdSchema.safeParse(attempt);

      if (by.kind !== 'local' || by.machine !== driver.machine || !left.success || attemptRuns.has(left.data)) continue;
      await stopLeftInProcess(config, runId, left.data);
      await endRunsPartOf(config, { run: runId, attempt: left.data });
    }
  };

  // A driver killed before cleanup, of this run or any other, left clones behind. The runtimes that ran in them, which
  // that driver can no longer tell, hear of it at a close.
  await closeAfterSweep(config, await sweepClones(config));
  const adapter = toolsRuntime.launcher;
  const archive = openSessionArchive(config);
  // With no workflows.max_parallel the driver runs one step at a time, except the items of a for_each that declares
  // max_parallel, which `next` leases beside each other (`isOneAtATime`); a run that may have them runs in parallel.
  const isOneAtATime = config.workflows?.max_parallel === undefined;
  const maxParallel = config.workflows?.max_parallel ?? (isStarted && mayRunItemsBeside(started) ? Number.POSITIVE_INFINITY : 1);
  const isParallel = maxParallel > 1;
  const reported = new Set<string>();
  const inFlight = new Map<string, { lease: StagedLease; command: StagedCommand }>();
  // Leases not started yet, in lease order. Steps that share a checkout run one at a time. Distinct worktrees overlap.
  const held: StagedLease[] = [];
  // Cancelled commands whose process group is not gone yet. They are not sent as running, so `next` does not cancel
  // them again. They still take a slot, and a new attempt of their step waits until they are gone, so a retried step
  // never runs beside its cancelled attempt.
  const dying = new Map<string, { step: string; lease: StagedLease; command: StagedCommand }>();
  const base = await headCommit(root);
  // Outside a git work tree no snapshot can check an answer, so an answer there holds no place and waits for nothing.
  const checked = (await git(root, ['rev-parse', '--is-inside-work-tree'])).code === 0;
  const placeOfLease = (lease: StagedLease): string => (lease.answer && !checked ? lease.attempt : placeOf(lease, root));
  // The prompts that run, by attempt. A prompt that was stopped before its tool started has nothing to report.
  const prompts = new Map<string, { lease: StagedLease; controller: AbortController; startedAt: number; exit: Promise<ReportBody | undefined> }>();
  let question: { hitl: LocalHitl; controller: AbortController; exit: Promise<{ kind: 'question'; hitl: LocalHitl; line?: string }> } | undefined;
  // A headless prompt takes a slot as a command does, so a step in another checkout starts beside it. An interactive one has the terminal.
  const busy = (): number => inFlight.size + dying.size + prompts.size;
  const interactiveRuns = (): boolean => [...prompts.values()].some(({ lease }) => lease.interactive);
  const room = (): boolean => !interactiveRuns() && busy() + held.length < maxParallel && !held.some((lease) => lease.prompt !== undefined);

  /** Stops `attempt`'s step: `cancel` when the run cancelled it, rather than this driver stopping. */
  const cancel = (attempt: string, why?: 'cancel'): void => {
    prompts.get(attempt)?.controller.abort();
    const index = held.findIndex((lease) => lease.attempt === attempt);

    if (index !== -1) held.splice(index, 1);
    const running = inFlight.get(attempt);

    if (!running) return;
    inFlight.delete(attempt);
    dying.set(attempt, { step: running.lease.step, lease: running.lease, command: running.command });
    void running.command.stop(why);
  };

  let wake = (): void => {};

  // A line typed at the terminal reaches every reader open on it, so one question is open at a time. A prompt step's
  // question closes the HITL question, which stays closed until no step asks and is then asked again, and steps ask
  // one after another. A step stopped while it waits for its turn asks nothing.
  let stepAsks = 0;
  let stepTurns: Promise<unknown> = Promise.resolve();
  // Ctrl-C or Ctrl-D closed a step's question: the person stops the run, as at the HITL question, and resume goes on.
  let isStoppedByPerson = false;

  const stopByPerson = (): void => {
    isStoppedByPerson = true;

    for (const { controller } of prompts.values()) controller.abort();
    wake();
  };

  const askPerson: AskPerson | undefined = personAnswers(mode) ? async (text, signal) => {
    stepAsks += 1;
    const before = stepTurns;

    // A listener added to an aborted signal never fires, and a step may be stopped before it asks.
    const stopped = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });

    const turn = (async () => {
      await Promise.race([before, stopped]);

      if (signal.aborted) return undefined;

      if (question) {
        const open = question;
        question = undefined;
        open.controller.abort();
        await open.exit;
      }

      return readLine(text, signal).catch(() => {
        if (!signal.aborted) stopByPerson();

        return undefined;
      });
    })();

    stepTurns = Promise.allSettled([before, turn]);

    try {
      return await turn;
    } finally {
      stepAsks -= 1;
      wake();
    }
  } : undefined;

  const isAutoApproved = options.autoApprove ?? config.workflows?.auto_approve === true;

  // A gate a whole workflow reached on a fleet member: the person here answers it, as a gate of this run. With nobody
  // here, it is answered as this driver answers its own gates then: an optional approval by auto-approve, else skipped,
  // an optional choice by its default under auto-approve, and any other not at all, which fails the member's run.
  const askGate = async (gate: ExecQuestion, signal: AbortSignal): Promise<ExecAnswer> => {
    if (askPerson) {
      const line = await askPerson(`Step "${gate.step}" of a workflow a fleet member runs: ${gate.message}\nOptions: ${gate.options.join(', ')}\nChoice, followed by an optional note: `, signal);

      if (line === undefined) return { refused: `The question of step "${gate.step}" closed without an answer.` };
      const [choice = '', ...words] = line.trim().split(/\s+/);

      return words.length > 0 ? { choice, note: words.join(' ') } : { choice };
    }

    // Without a person, as the engine answers a gate for a driver without HITL.
    const choice = unattendedChoice(gate, { autoApprove: isAutoApproved });

    if (choice !== undefined) return { choice };

    return { refused: `Step "${gate.step}" of a workflow a fleet member runs needs a person's answer, and nobody answers where the run is driven. Retry the step, then resume the run from a terminal in an attended run (TEAMAI_MODE=attended, or neither TEAMAI_MODE nor CI set).` };
  };

  let interactiveIgnores: readonly NodeJS.Signals[] = [];
  let signalled: NodeJS.Signals | undefined;
  let handled: readonly NodeJS.Signals[] = [];

  const handle = (signals: readonly NodeJS.Signals[]): void => {
    for (const name of handled) process.off(name, onSignal);
    handled = signals;

    for (const name of handled) process.on(name, onSignal);
  };

  const exitOn = (signal: NodeJS.Signals): void => {
    handle([]);
    exitLike({ kind: 'signaled', signal });
  };

  // Parallel commands and detached prompt tools do not get the terminal's Ctrl-C, and no command gets a signal sent to
  // teamai alone, so the driver stops them before it exits the way the signal would. An interactive tool that the
  // terminal's signals reach handles them itself. With nothing running, the signal ends teamai at once, as it would
  // without a handler.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interactiveRuns() && interactiveIgnores.includes(signal)) return;

    if (busy() === 0) return exitOn(signal);
    signalled ??= signal;

    for (const { controller } of prompts.values()) controller.abort(signal);
    wake();
  };

  if (isParallel) handle(STOP_SIGNALS);
  // The team env, resolved once per turn of the loop: the leases it hands out, their env, and what it masks agree. It
  // masks every value the drive has seen, so a value that changed while an attempt ran stays masked in what it reports.
  let env: WorkflowEnv | undefined;
  const seen: Record<string, string> = {};
  // Nobody answers here, so the driver offers the run to a person; once it could not, the steps only a person can take fail.
  // A run goes to a person only when no runtime of the driver asks one.
  let handoff: PersonHandoff | undefined = slots.some((slot) => slot.can.hitl === true) ? undefined : { kind: 'offers' };
  // The usage limits this drive met. Every runtime of the driver launches a tool with the member's sign-in, so a limit met
  // here holds the tool on each of them, and on the fleet until the wait passes its cap. A fleet member signs in with its
  // own: a limit it met holds the tool on the fleet only.
  const limits = UsageLimits.open();
  // The reset the driver last said it waits for, so it says each once.
  let waitSaid: string | undefined;
  // The tool an answer step's call runs on, looked up at each turn while a usage limit holds, so `next` holds the step too.
  let answerToolNow: string | undefined;

  /**
   * The tool or instance a prompt lease launches, as `next` names it: the account a usage limit holds. An answer step's call
   * runs on the tool `ai.tool` names, which `next` is told while a limit holds.
   */
  const launchedTool = (lease: StagedLease): string | undefined => (lease.answer === true
    ? answerToolNow
    : lease.prompt === undefined || lease.confined
      ? undefined
      : lease.tool ?? toolForOn(slotOf.get(lease.attempt)?.can.default_tool)({ agent: lease.agent, tool: lease.tool }));

  /** The tools held on `slot` now. */
  const limitedOn = (slot: RuntimeSlot | undefined): Record<string, string> => (slot?.use === 'fleet' ? limits.heldOnFleet(Date.now()) : limits.held(Date.now()));

  const releasedReport = (lease: StagedLease): ReportBody => ({ attempt: lease.attempt, revision: lease.revision, driver, outcome: 'released' });

  /**
   * A prompt that stopped on its tool's usage limit is handed back rather than failed, and the tool is held until the
   * limit resets; the step runs again then. Any other end of a prompt says the tool's limit is over; a lease handed back
   * before its tool started says nothing of it.
   */
  const afterUsage = (body: ReportBody, { lease, startedAt }: { lease: StagedLease; startedAt: number }): ReportBody => {
    // An answer step's call says which tool it ran on.
    const tool = lease.answer === true ? body.tool : launchedTool(lease);
    const on = slotOf.get(lease.attempt)?.use === 'fleet' ? 'fleet' : 'here';

    if (tool === undefined || body.outcome === 'released') return body;

    if (body.failure?.code !== 'usage_limited') {
      limits.ran(tool, startedAt, on);

      return body;
    }

    // The step does not fail, so the retry a failed step's message ends with does not apply.
    const said = body.failure.message.replace(` Then run: ${retryCommand({ run: runId, step: lease.step })}`, '').replace(/\.?\s*$/u, '');
    limits.hit({ tool, message: said, now: Date.now(), on });
    log.warn(on === 'fleet'
      ? `Step "${lease.step}" stopped on a fleet member: ${said}. teamai offers no more steps on ${tool} to the fleet until its limit resets; a runtime here may run the step meanwhile.`
      : `Step "${lease.step}" stopped: ${said}. teamai launches no more steps on ${tool} until its limit resets, then runs the step again.`);

    return { ...releasedReport(lease), launched: true, ...(body.tokens && { tokens: body.tokens }) };
  };

  // A runtime's credential values are masked like the team's secrets, whatever their names look like, each entry's own
  // even when two entries of one runtime give a credential the same name.
  const maskedCredentials: Record<string, string> = {};

  for (const slot of slots) rememberSecrets(maskedCredentials, credentialSecrets(slot.use, slot.credentials));
  const maskedValues = async (): Promise<Record<string, string>> => ({ ...env?.secrets ?? await knownSecrets(config), ...maskedCredentials });

  const report = async (body: ReportBody, lease: StagedLease, changed?: readonly string[]): Promise<WorkflowEnvelope | undefined> => {
    const secrets = await maskedValues();
    await AttemptResult.mask(attemptResultPath(config, runId, lease.attempt), secrets);

    // The leases still waiting to start keep their whole timeout through this report too.
    const sent: ReportBody = { ...body, queued: held.map((waiting) => waiting.attempt) };

    const answer = changed === undefined
      ? await managedReport({ config, runId, report: sent, secrets, lock })
      : await managedReport({ config, runId, report: sent, secrets, lock, changed });

    // Cancelled while it ran: the next `next` lists it in `cancelled`, and the run goes on without it.
    if (isWorkflowError(answer) && answer.error.code !== 'lease_cancelled') return answer;
    // Its handle is closed only once the report is recorded, so a teamai killed before then reattaches to it. A prompt
    // on a runtime that keeps conversations (`HeldPlace.holdsOn`), not through another, keeps its place held for the
    // conversation it launched while a step that has not settled continues it in the same workspace, outside any room
    // under max_parallel; and each held place no such step continues any more is closed.
    const slot = slotOf.get(lease.attempt);
    const mayHold = !isWorkflowError(answer) && lease.prompt !== undefined && !lease.answer && !lease.confined && HeldPlace.holdsOn(slot);
    const { continued, workspace } = await continuedAround(lease.step);

    if (mayHold && await HeldPlace.hold({ config, run: runId, attempt: lease.attempt, report: body, continued, workspace })) {
      slotOf.delete(lease.attempt);
      attemptRuns.delete(lease.attempt);
    } else {
      await closeRun(lease.attempt);
    }

    await releaseHeld(continued);

    if (isWorkflowError(answer)) return undefined;
    reported.add(body.attempt);
    options.started?.(StartedRunSchema.array().catch([]).parse(answer.data.started));

    return undefined;
  };

  /**
   * Ends attempt `lease`, which the run stopped, once its command `ended`. A whole workflow answers what its steps spent
   * before it stopped: the report the run refuses still counts that against the budgets around the step, and leaves the
   * place as abandoning it does. Any other attempt is abandoned.
   */
  const endStopped = async (lease: StagedLease, ended: StagedResult): Promise<WorkflowEnvelope | undefined> => {
    const spent = lease.workflow && ended.kind === 'ran' ? await commandReport(config, lock, driver, lease, ended.result, await maskedValues()) : undefined;

    if (spent?.tokens !== undefined) return report(spent, lease);
    await abandon(lease.attempt);

    return undefined;
  };

  const unstaged = (lease: StagedLease, failure: WorkflowFailure): ReportBody => ({ attempt: lease.attempt, revision: lease.revision, driver, ...failureReport(failure) });

  /**
   * Whether a staged prompt lease launches its tool: `launch`; `given-back` once it was stopped (its place given back,
   * nothing to report); or `ends` with its staging failure, or released while another step's usage limit holds its tool,
   * which it may have hit while this one's workspace was prepared.
   */
  const beforeLaunch = async (lease: StagedLease, { signal, failure, slot }: { signal: AbortSignal; failure: WorkflowFailure | undefined; slot: RuntimeSlot | undefined }): Promise<{ kind: 'launch' } | { kind: 'given-back' } | { kind: 'ends'; report: ReportBody }> => {
    await options.prepared?.({ step: lease.step, attempt: lease.attempt }, signal);

    if (!startable(lease, signal)) {
      await giveBackUnlaunched(lease.attempt);

      return { kind: 'given-back' };
    }

    if (failure) return { kind: 'ends', report: unstaged(lease, failure) };
    const tool = launchedTool(lease);

    return tool !== undefined && limitedOn(slot)[tool] !== undefined ? { kind: 'ends', report: releasedReport(lease) } : { kind: 'launch' };
  };

  // Why a confined step this driver was leased has no tool here that resolves its model. It hands that lease back and
  // takes no other, so it does not lease the step again in this process.
  let handedBack: string | undefined;

  try {
    for (;;) {
      if (signalled) return { error: { code: 'interrupted', message: `Stopped by ${signalled} after every command it started exited` } };

      if (isStoppedByPerson) return { error: { code: 'interrupted', message: 'A step\'s question closed without an answer. Continue with teamai workflow resume.' } };
      const running = [...inFlight.keys(), ...held.map((lease) => lease.attempt), ...prompts.keys()];
      const canTakeLease = room() && handedBack === undefined;
      const resolved = await resolveWorkflowEnv(config);
      const turn = { ...resolved, secrets: rememberSecrets(seen, resolved.secrets) };
      env = turn;
      answerToolNow = Object.keys(limits.held(Date.now())).length > 0 ? await answerCallTool({ config, ...lookup }) : undefined;

      // A runtime's notice is masked as the step's output is, with the team's secrets too.
      for (const entry of defined.runtimes) if (entry.kind === 'external') rememberSecrets(entry.masks, turn.secrets);

      const ask = (slot: RuntimeSlot, take: boolean, listed: string[]): Promise<WorkflowEnvelope> => leaseNext(config, runId, driver, {
        drivesUnder: lock, running: listed, queued: held.map((lease) => lease.attempt), canTakeLease: take, can: slot.can, autoApprove: options.autoApprove, runMode: mode, handoff, relay, base, env: turn, alone: { ...sole, offering: slot.use }, prepare: true, isOneAtATime, toolFor: toolForOn(slot.can.default_tool),
        limitedTools: limitedOn(slot), ...(answerToolNow !== undefined && { answerTool: answerToolNow }),
      });

      // Each runtime with room is offered in turn, in definition order, until one takes a lease: a wait is final only
      // once every one was offered. An attempt left open by a loop before this one goes back to its own runtime first.
      // `heldByAll`: what every runtime offered held back, so a step one of them holds for a person is seen whichever answered last.
      const offered = await (async (): Promise<{ next: WorkflowEnvelope; slot: RuntimeSlot; held?: true; heldByAll?: WaitHeld[] }> => {
        for (let reconnect = reconnecting.shift(); reconnect; reconnect = reconnecting.shift()) {
          const next = await ask(reconnect.slot, false, [...running, ...reconnecting.map((other) => other.attempt)]);

          if (isWorkflowError(next) || !('wait' in next.data)) return { next, slot: reconnect.slot };
        }

        const withRoom = canTakeLease ? slots.filter(slotHasRoom) : [];
        let last: { next: WorkflowEnvelope; slot: RuntimeSlot } | undefined;
        const holds: HeldSteps['runtimes'] = [];
        const heldByAll: WaitHeld[] = [];

        for (const slot of withRoom) {
          last = { next: await ask(slot, true, running), slot };

          if (isWorkflowError(last.next) || !('wait' in last.next.data)) return last;
          const heldBySlot = WaitReplySchema.parse(last.next.data.wait).held ?? [];
          heldByAll.push(...heldBySlot);
          holds.push({ runtime: slot.use, held: heldBySlot.map(({ step, reason }) => ({ step, reason })) });
        }

        // Every runtime with room was offered and held its steps back: the run's details say why.
        if (last) {
          await writeHeldSteps(config, runId, { driver: sole.driver, runtimes: holds });
          // A wait that holds a step says nothing of a gate, which only a `next` that takes no lease answers.
          const asker = holds.some((hold) => hold.held.length > 0) ? slots.find((slot) => slot.can.hitl === true) : undefined;

          if (asker) {
            const gate = await ask(asker, false, running);

            if (isWorkflowError(gate) || 'hitl' in gate.data) return { next: gate, slot: asker, held: true };
          }
        }

        return last ? { ...last, heldByAll } : { next: await ask(slots[0], false, running), slot: slots[0] };
      })();

      const { next } = offered;

      if (signalled || isStoppedByPerson) continue;

      // A clone whose steps all settled is not needed any more.
      if ((await sweepClones(config, runId)).length > 0) {
        for (const [slot, closedHandle] of lastClosed) {
          if (slot.kind !== 'external') continue;
          const again = await slot.runtime.close(closedHandle);

          if (!again.ok) log.debug(`Runtime ${slot.use} did not close ${closedHandle} again after teamai removed a clone: ${masked(again.failure.message, await maskedValues())}`);
        }

        lastClosed.clear();
      }

      if (isWorkflowError(next)) return next;

      const cancelled = z.array(z.string()).safeParse(next.data.cancelled);
      const deadlines = z.record(z.string(), z.string()).safeParse(next.data.deadlines);

      // A lease waiting to start keeps the deadline its restarted clock gives it.
      for (const [index, lease] of held.entries()) {
        const deadline = deadlines.success ? deadlines.data[lease.attempt] : undefined;

        if (deadline !== undefined) held[index] = { ...lease, expiresAt: deadline };
      }

      for (const attempt of cancelled.success ? cancelled.data : []) cancel(attempt, 'cancel');

      // A step taken, or the run ended: nothing is held back any more. A gate asked beside a held step leaves it held.
      if (!('wait' in next.data) && !offered.held) await writeHeldSteps(config, runId, { driver: sole.driver, runtimes: [] });

      if ('done' in next.data) {
        await releaseHeld();
        question?.controller.abort();

        for (const { controller } of prompts.values()) controller.abort();

        for (const [attempt, { lease, exit }] of prompts) {
          const body = await exit;
          const failed = body && await report(body, lease);
          prompts.delete(attempt);

          if (failed) return failed;
        }

        // A whole workflow the run stopped is waited on too, for what its steps spent; any other command is left to stop below.
        for (const [attempt, { lease, command }] of dying) {
          if (!lease.workflow) continue;
          const failed = await endStopped(lease, await command.exit);
          dying.delete(attempt);

          if (failed) return failed;
        }

        return next;
      }

      const hitlRequest = HitlRequestSchema.safeParse(next.data.hitl);
      const hitl: LocalHitl | undefined = hitlRequest.success ? hitlRequest.data : undefined;
      const leased = LocalLeaseSchema.safeParse(next.data.lease);
      const nextLease = 'lease' in next.data && leased.success ? leased.data : undefined;

      if (question && (nextLease?.step === question.hitl.step
        || (!nextLease && (hitl?.step !== question.hitl.step || hitl?.pass !== question.hitl.pass)))) {
        question.controller.abort();
        await question.exit;
        question = undefined;
      }

      if ('lease' in next.data) {
        if (!nextLease) return { error: { code: 'run_unreadable', message: `Run ${runId} returned a lease the local driver cannot run` } };

        if (reported.has(nextLease.attempt)) {
          return { error: { code: 'driver_stuck', message: `Attempt ${nextLease.attempt} was leased again before it could be reported` } };
        }

        // A confined step runs in its directory, never in a checkout another attempt holds.
        const taken = nextLease.confined ? { ...nextLease, cwd: nextLease.confined.dir } : nextLease;
        await bind(taken, offered.slot);
        held.push(taken);
      }

      // A prompt leased before its tool hit a usage limit is handed back unlaunched: the step waits for the reset.
      for (const lease of held.filter((waiting) => {
        const tool = launchedTool(waiting);

        return tool !== undefined && limitedOn(slotOf.get(waiting.attempt))[tool] !== undefined;
      })) {
        held.splice(held.indexOf(lease), 1);
        const failed = await report(releasedReport(lease), lease);

        if (failed) return failed;
      }

      const placesBusy = (): Set<string> => new Set([
        ...[...inFlight.values()].map(({ lease }) => placeOfLease(lease)),
        ...[...dying.values()].map(({ lease }) => placeOfLease(lease)),
        ...[...prompts.values()].map(({ lease }) => placeOfLease(lease)),
      ]);

      for (let index = 0; !interactiveRuns() && busy() < maxParallel;) {
        const lease = held[index];
        // A workflow leased whole runs as one exec of the runtime it was leased on, which reads it from the run.
        const command = lease?.command ?? (lease?.workflow ? '' : undefined);

        if (lease === undefined || command === undefined) break;

        if ([...dying.values()].some((stopping) => stopping.step === lease.step)
          || placesBusy().has(placeOfLease(lease))
          || held.slice(0, index).some((earlier) => earlier.prompt !== undefined && placeOfLease(earlier) === placeOfLease(lease))) {
          index += 1;
          continue;
        }

        held.splice(index, 1);
        // Setup runs in its own process group, out of the terminal's reach, so the driver handles every stop signal until
        // the command starts. An attached command already has the signals its terminal sends to the whole group; a second
        // would force-quit some tools.
        const reachesCommand = !isParallel && await terminalReachesCommand();
        const forwarded = isParallel ? undefined : commandSignalPolicy(reachesCommand).forwarded;
        // One command at a time keeps the terminal teamai has: Ctrl-C reaches it, and it can prompt on /dev/tty. Any other
        // command gets a process group of its own, which `stop` and the signal handlers below end as a whole, and which a
        // later driver stops whole once this one is gone, children its shell left included.
        const detached = !reachesCommand && process.platform !== 'win32';

        if (forwarded) handle(STOP_SIGNALS);
        inFlight.set(lease.attempt, { lease, command: stageThenStart(
          lease,
          async (signal) => {
            const staged = await stageLease(lease, { config, lock, root, env: turn, mode, signal, setUpOn: runOf(lease), runsOn: externalOf(lease), leftRunning });

            return staged ?? refuseDirtyAdoptedCommand({ config, run: lock.run, attempt: lease.attempt });
          },
          () => {
            if (forwarded) handle(forwarded);

            const stepRun = runOf(lease);

            if (stepRun) {
              // An adopted place is checked again once setup ran there.
              const setUp = async (signal: AbortSignal | undefined): Promise<WorkflowFailure | undefined> => (await runPlaceSetup({ config, run: runId, attempt: lease.attempt, mode, env: turn, signal, on: runtimeSetup(stepRun) }))
                ?? refuseDirtyAdoptedCommand({ config, run: runId, attempt: lease.attempt });

              return runtimeCommand({
                run: stepRun, command, kind: lease.workflow ? 'workflow' : 'command', view: () => placeView(config, runId, lease, lease.cwd ?? root), setUp,
                ...(lease.workflow && { ask: askGate }),
                ...runtimeStepEnv(lease, lease.processEnv ?? {}, { config, run: runId, mode }),
              });
            }

            if (lease.workflow) return failedCommand({ code: 'runtime_protocol', message: `Step "${lease.step}" was leased whole on a runtime that runs no whole workflow.` });

            // The lease `env` is set over the step's environment, so its values reach the shell only as variables.
            const input: Parameters<typeof startGroupedCommand>[0] = {
              command, cwd: lease.cwd ?? root, env: { ...lease.processEnv ?? process.env, ...lease.env, ...commandStepEnv(config, runId, lease.attempt, mode), [PROGRESS_STREAMS_ENV]: '1' }, detached, group: attemptDir(config, runId, lease.attempt),
            };

            const { progress } = options;

            if (!progress) return startGroupedCommand(input);

            const shown = lineSplitter((line) => {
              const { stream, text } = streamOfLine(line);
              progress(masked(text, turn.secrets), stream);
            });

            const grouped = startGroupedCommand({ ...input, onStderr: shown.write });

            return { ...grouped, exit: grouped.exit.finally(shown.end) };
          },
        ) });
      }

      // Prompts in places no other attempt holds start beside each other, in lease order, while a slot is free. An
      // interactive one starts only once nothing else runs.
      while (!interactiveRuns() && busy() < maxParallel) {
        const promptAt = held.findIndex((lease) => lease.prompt !== undefined
          && !placesBusy().has(placeOfLease(lease))
          && ![...dying.values()].some((stopping) => stopping.step === lease.step)
          && (!lease.interactive || busy() === 0));

        const [lease] = promptAt === -1 ? [] : held.splice(promptAt, 1);

        if (lease === undefined) break;

        if (lease.interactive && question) {
          question.controller.abort();
          await question.exit;
          question = undefined;
        }

        // Setup runs out of the terminal's reach, so the tool's signals are left to it only once it starts.
        interactiveIgnores = [];
        // An interactive step on a runtime that launches agents its own way is not in this terminal.
        const ignored = lease.interactive && slotOf.get(lease.attempt)?.launchesAgents !== true ? commandSignalPolicy(await terminalReachesCommand()).ignored : [];
        const controller = new AbortController();

        if (!isParallel) handle(STOP_SIGNALS);
        prompts.set(lease.attempt, { lease, controller, startedAt: Date.now(), exit: (async () => {
          const { confined: place, prompt } = lease;

          if (lease.answer && prompt !== undefined) {
            const failure = await stageLease(lease, { config, lock, root, env: turn, mode, signal: controller.signal, runsOn: externalOf(lease), leftRunning });
            const before = await beforeLaunch(lease, { signal: controller.signal, failure, slot: slotOf.get(lease.attempt) });

            if (before.kind !== 'launch') return before.kind === 'ends' ? before.report : undefined;
            const answered = await hostRuntime.answer({ config, prompt, output: lease.output, cwd: lease.cwd ?? root, expiresAt: lease.expiresAt, signal: controller.signal, ...lookup });

            // Cancelled while it answered: the engine settles the step, and the reply is not wanted.
            return controller.signal.aborted ? undefined : { attempt: lease.attempt, revision: lease.revision, driver, ...answered };
          }

          if (place) {
            const slot = slotOf.get(lease.attempt);
            const onRuntime = runOf(lease);

            const leftHere = onRuntime ? undefined : await stopLeftHere({ config, run: runId, attempt: lease.attempt, step: lease.step, leftRunning });
            const moved = leftHere ?? await stopLeftElsewhere({ config, run: runId, attempt: lease.attempt, runsOn: externalOf(lease), checkout: root });

            if (!startable(lease, controller.signal)) return undefined;

            if (moved) return unstaged(lease, moved);
            const confinedLease = { ...lease, confined: place };

            const ended = onRuntime && slot
              ? await runConfinedStepOnRuntime({ config, run: runId, lease: confinedLease, signal: controller.signal, runtime: slot.use, attemptRun: onRuntime, offers: slot.can.confined ?? [], credentials: slot.credentials, secrets: await maskedValues() })
              : await runConfinedStep({ config, run: runId, lease: confinedLease, signal: controller.signal, secrets: await maskedValues(), ...lookup });

            const id = { attempt: lease.attempt, revision: lease.revision, driver };

            if (ended.kind === 'ran') return { ...id, ...ended.report };
            handedBack = ended.reason;

            return { ...id, outcome: 'released' };
          }

          // A role copy is checked and delivered for the tool the step launches, so another tool the member enables does not refuse it.
          const slot = slotOf.get(lease.attempt);
          const launch = lease.role !== undefined ? launchToolFor({ agent: lease.agent, tool: lease.tool }, config, options.tools ?? {}, await memberTools(config), slot?.can.default_tool) : undefined;
          const failure = await stageLease(lease, { config, lock, root, env: turn, mode, signal: controller.signal, launches: launch?.ok ? launch.target.name : undefined, setUpOn: runOf(lease), runsOn: externalOf(lease), leftRunning });

          const before = await beforeLaunch(lease, { signal: controller.signal, failure, slot });

          if (before.kind !== 'launch') return before.kind === 'ends' ? before.report : undefined;
          interactiveIgnores = ignored;

          const stepRun = runOf(lease);

          return runPromptStep({
            config, lock, driver, lease, adapter, tools: options.tools, toolPaths: options.toolPaths, archive, signal: controller.signal, mode, staged: launch,
            secrets: { ...turn.secrets, ...maskedCredentials }, askPerson,
            onRuntime: stepRun && slot && promptRuntimeOn({
              run: stepRun, offered: promptOfferOf(slot), teamEnv: turn,
              ...(HeldPlace.holdsOn(slot) && {
                conversationHeld: async (sessions: readonly SessionRef[]) => HeldPlace.conversationOf({ config, run: runId, runtime: slot.use, driver: defined.driver, sessions, workspace: await workspaceOf(lease.step) }),
              }),
            }),
          });
        })() });
      }

      if (canHitl && hitl && !question && !interactiveRuns() && stepAsks === 0) {
        const controller = new AbortController();
        question = { hitl, controller, exit: (options.question ?? askHitl)(hitl, controller.signal)
          .then((line) => ({ kind: 'question' as const, hitl, line }), () => ({ kind: 'question' as const, hitl })) };
      }

      if ('lease' in next.data && room()) continue;

      if (relay && hitl && busy() === 0 && held.length === 0) return relayedGate(hitl, { driver: defined.asked, isConfirmed: isStarted && started.definition.invoke === 'ask' });

      if (busy() === 0 && !question) {
        const wait = WaitReplySchema.parse(next.data.wait);

        // Another process of this machine delivers a step this run waits for; it settles without this driver.
        if (Array.isArray(wait.delivering) && wait.delivering.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }

        // A wait for a call that could not take a lease says nothing about what is left; ask again with room. A driver
        // that handed back a confined lease never has room again, so it stops on that.
        if (!canTakeLease && handedBack === undefined) continue;

        const confinedWait = handedBack ?? (heldForConfined(wait.held) ? wait.held.map((item) => item.reason.replace(/\.$/u, '')).join('; ') : undefined);

        if (confinedWait !== undefined) {
          return { error: { code: 'confined_pending', message: `Run ${runId} waits for a confined tool: ${confinedWait.replace(/\.$/u, '')}. Make one available here, then run teamai workflow resume ${runId}, or drive the run with a driver that offers one.` } };
        }

        // Nobody answers here, so the run goes to a person: offered on teamai-reports, its local state kept.
        // A step any runtime holds back only a person can take goes to one, when no runtime of the driver asks.
        const people = handoff?.kind === 'offers' ? [...new Set((offered.heldByAll ?? wait.held ?? []).filter(({ missing }) => missing.includes(HITL)).map(({ step }) => step))] : [];

        if (people.length > 0) {
          const unoffered = await offerHere();

          if (unoffered === undefined) return handedToPerson(runId, people);

          handoff = { kind: 'unoffered', reason: unoffered };
          continue;
        }

        // Only usage limits hold the steps left: wait for the reset, ask the person who attends, or move on.
        const limitHolds = (offered.heldByAll ?? wait.held ?? []).flatMap(({ step, limitedTool }) => (limitedTool === undefined ? [] : [{ step, limitedTool }]));
        const idle = limitHolds.length > 0 ? limits.whenIdle(Date.now(), [...new Set(limitHolds.map(({ limitedTool }) => limitedTool))], { attended: askPerson !== undefined }) : undefined;
        const heldBy = (tool: string): string[] => [...new Set(limitHolds.flatMap(({ step, limitedTool }) => (limitedTool === tool ? [step] : [])))];

        // The run is offered on teamai-reports, as for a step only a person can take, with the steps `tool`'s limit holds.
        const offerOnLimit = async ({ tool, offeredSaid, unofferedSaid }: { tool: string; offeredSaid: (resume: string) => string; unofferedSaid: (reason: string) => string }): Promise<WorkflowEnvelope> => {
          const unoffered = await offerHere();

          if (unoffered !== undefined) return { error: { code: 'usage_limited', message: unofferedSaid(unoffered) } };
          const resume = `teamai workflow resume ${runId} --claim`;
          log.info(offeredSaid(resume));

          return { data: { handoff: { run: runId, steps: heldBy(tool), resume } } };
        };

        if (idle?.kind === 'ask' && askPerson) {
          const line = await askPerson(`${idle.reason}. Wait here until it resets, or offer run ${runId} to another machine on teamai-reports? [wait/offer] `, new AbortController().signal);

          if (line === undefined) {
            return { error: { code: 'interrupted', message: `The question on the usage limit closed without an answer. Once the limit resets, continue run ${runId} ${resumeOrPublish(runId)}` } };
          }

          const answer = line.trim().toLowerCase();

          if (answer === 'offer' || answer === 'o') {
            return offerOnLimit({
              tool: idle.tool,
              offeredSaid: (resume) => `Run ${runId} is offered on teamai-reports, as you chose: another machine continues it with ${resume}. To continue it here once the limit resets: teamai workflow resume ${runId}`,
              unofferedSaid: (reason) => `Run ${runId} could not be offered on teamai-reports: ${reason}. Once the limit resets, continue it ${resumeOrPublish(runId)}`,
            });
          }

          // An empty line waits, as the question's first choice; anything else asks again.
          if (answer === '' || answer === 'wait' || answer === 'w') limits.choseWait(idle.tool);
          continue;
        }

        if (idle?.kind === 'wait') {
          if (waitSaid !== idle.reason) {
            waitSaid = idle.reason;
            log.info(`Run ${runId} waits: ${idle.reason}. Then it runs the steps that limit holds. To go on elsewhere instead, stop it (Ctrl-C) and run: teamai workflow publish ${runId}`);
          }

          await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(idle.until - Date.now(), USAGE_WAIT_STEP_MS))));
          continue;
        }

        // Past the wait, or for a reset after it, the run moves on: it is offered on teamai-reports, as for a person.
        if (idle?.kind === 'past_cap') {
          const quoted = heldBy(idle.tool).map((step) => `"${step}"`);

          return offerOnLimit({
            tool: idle.tool,
            offeredSaid: (resume) => `${quoted.length > 1 ? `Steps ${quoted.join(', ')} wait` : `Step ${quoted.join(', ')} waits`}: ${idle.reason}. So run ${runId} is offered on teamai-reports: another machine continues it with ${resume}. To continue it here once the limit resets: teamai workflow resume ${runId}`,
            unofferedSaid: (reason) => `Run ${runId} waits: ${idle.reason}, and it could not be offered on teamai-reports: ${reason}. Once the limit resets, continue it ${resumeOrPublish(runId)}`,
          });
        }

        // What the member can change comes first: a step the policy holds on one runtime is held on every runtime that
        // has its workspace, so the policy is named whichever runtime was offered last. Only a negotiated policy hold
        // puts policy first in `missing`; a runtime that defers the step on its workspace puts that first.
        const policy = (offered.heldByAll ?? []).find(({ missing }) => missing[0]?.startsWith('policy.'));
        const reason = policy?.reason ?? wait.reason ?? 'the next step is not available';
        // A run claimed from another machine does not bring its --sandbox along: say which flag declares it here.
        const needsSandbox = !isSandbox(config, options) && wait.held?.some(({ missing }) => missing.includes(ISOLATION)) === true;

        return { error: { code: 'busy', message: needsSandbox
          ? `${reason}. If this machine is a disposable host, such as a CI runner or a container, declare it a sandbox: teamai workflow resume ${runId} --sandbox, or workflows.sandbox: true in config`
          : reason } };
      }

      let timer: NodeJS.Timeout | undefined;

      const exited = await Promise.race([
        ...[...inFlight.values()].map(({ lease, command }) => command.exit.then((result) => ({ kind: 'command' as const, attempt: lease.attempt, lease, result }))),
        // cancel() already stopped each one, with why: another stop here would turn a fleet cancel into a driver stop.
        ...[...dying].map(([attempt, { command }]) => command.exit.then((result) => ({ kind: 'stopped' as const, attempt, result }))),
        ...[...prompts].map(([attempt, { exit }]) => exit.then((body) => ({ kind: 'prompt' as const, attempt, body }))),
        ...(question ? [question.exit] : []),
        new Promise<undefined>((resolve) => {
          wake = () => resolve(undefined);
          timer = setTimeout(wake, question ? pollMs / 2 : pollMs);
        }),
      ]);

      clearTimeout(timer);

      // What ended after the person stopped the run is not reported: the cleanup below stops the rest, and resume reruns it.
      if (!exited || isStoppedByPerson) continue;

      if (exited.kind === 'question') {
        // A step's question closed it, and took it from the driver: it is asked again once no step asks.
        const closedByStep = question === undefined;
        const questionHitl = exited.hitl;
        question = undefined;

        if (exited.line === undefined) {
          if (closedByStep) continue;

          return { error: { code: 'interrupted', message: 'The HITL question closed without an answer. Continue with teamai workflow resume.' } };
        }

        const [choice = '', ...words] = exited.line.trim().split(/\s+/);
        const provenance = respondProvenance({ kind: 'terminal', caller: callerProvenance(process.env, { isTTY: true }) });
        const response: ResponseInput = { step: questionHitl.step, pass: questionHitl.pass, choice, provenance, queued: { driver, attempts: held.map((lease) => lease.attempt) } };

        if (words.length > 0) response.note = words.join(' ');
        const answer = await respondToHitl(config, runId, turn.secrets, response);

        if (isWorkflowError(answer)) {
          // agent_in_path: the driver runs inside an agent session; it keeps waiting for the person's answer from elsewhere.
          if (!['repeated_response', 'stale_response', 'invalid_choice', 'not_waiting', 'run_settled', 'agent_in_path'].includes(answer.error.code)) return answer;
          log.warn(answer.error.message);
        }

        continue;
      }

      if (exited.kind === 'prompt') {
        const ended = prompts.get(exited.attempt);
        prompts.delete(exited.attempt);

        if (!isParallel) handle([]);
        const failed = exited.body && ended && await report(afterUsage(exited.body, ended), ended.lease);

        if (failed) return failed;
        continue;
      }

      if (exited.kind === 'stopped') {
        const stopping = dying.get(exited.attempt);
        dying.delete(exited.attempt);

        if (!isParallel) handle([]);

        const failed = stopping && await endStopped(stopping.lease, exited.result);

        if (failed) return failed;
        continue;
      }

      inFlight.delete(exited.attempt);

      if (!isParallel) handle([]);
      const staged = exited.result;

      if (staged.kind === 'stopped') {
        // Its lease ended while it was staged: the engine stops it, and the driver leaves the copy as it found it.
        await giveBackUnlaunched(exited.lease.attempt);
        continue;
      }

      const body = staged.kind === 'unstaged'
        ? unstaged(exited.lease, staged.failure)
        : await commandReport(config, lock, driver, exited.lease, staged.result, turn.secrets, options.progress ? undefined : (file) => {
          log.info(`Step "${exited.lease.step}" printed text on stdout, which is not its outputs: its last lines are in ${file}.`);
        });

      // The command did not start. An empty list keeps a host file written after adopt out of the commit.
      const failed = await report(body, exited.lease, staged.kind === 'unstaged' ? [] : undefined);

      if (failed) return failed;
    }
  } finally {
    // The sweep runs even when stopping what still runs throws, so no attempt's result file keeps a secret.
    try {
      question?.controller.abort();

      for (const { controller } of prompts.values()) controller.abort(signalled);
      await Promise.all([...prompts.values()].map(({ exit }) => exit));

      for (const attempt of inFlight.keys()) cancel(attempt);
      await Promise.all([...dying.values()].map(async ({ lease, command }) => {
        await command.stop();
        await abandon(lease.attempt);
      }));
    } finally {
      await stopLeftByKilledDrivers();
      await maskAttemptResults(config, runId, await maskedValues());
    }

    await archive.close();

    if (signalled) exitOn(signalled);
    handle([]);
  }
}
