import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { toolExtrasFor, type AgentSpec } from '../../../resources/agent-format.js';
import { observeLaunch, type Used } from '../../../agent-observation.js';
import { detectProjectConfig } from '../../../config.js';
import { driverIdentity } from '../../../driver-identity.js';
import { commandSignalPolicy, exitLike, stepEnvironment, terminalReachesCommand } from '../../../env-exec.js';
import { knownSecrets, resolveWorkflowEnv, type WorkflowEnv } from '../../../env-resolution.js';
import { resolveRunMode, workflowLaunch, type RunMode } from '../../../launch-context.js';
import type { LocalConfig, TeamaiConfig } from '../../../types.js';
import { readFileSafe, writeFileAtomic, writeJsonAtomic } from '../../../utils/fs.js';
import { log } from '../../../utils/logger.js';
import { redact, redactJson } from '../../../utils/redact.js';
import { AgentSession } from '../../../session-flow/agent-session.js';
import { openSessionArchive, type SessionArchive } from '../../../session-flow/archive.js';
import { deliveredTeamSkills, usedSkills } from '../../../skill-use.js';
import { attemptEnv } from '../../attempt-marker.js';
import { leaseNext, type ReportInput } from '../../engine.js';
import { EnvScopeSchema, LeaseSetupSchema, type DriverCan, type EnvScope, type LeaseSetup } from '../../requirements.js';
import { callerProvenance, respondProvenance, respondToHitl } from '../../run-controls.js';
import { isRecord } from '../../expression.js';
import {
  createLocalToolAdapter,
  type LocalToolAdapter,
  type LocalToolResult,
  type LocalToolRun,
} from './local-tool-adapter.js';
import { attemptDir, AttemptIdSchema, attemptsDir, readRun, RunIdSchema, updateRun, withRunLock, type AttemptId, type RunId, type RunLock } from '../../store.js';
import { abandonPlace, placeOf, placeRoot, preparePlace, runPlaceSetup, type PlaceLease, type StepEnd } from '../../place/place.js';
import { commandOutputs, managedReport } from '../../protocol.js';
import { stopProcess } from '../../../tool-launch/process-stop.js';
import { isLaunchTool, localToolFamily, type LaunchTool } from '../../../tool-launch/tools.js';
import { chooseStepModel, loadDeployedAgent } from '../../step-model.js';
import type { DriverIdentity, StepHitl, WorkflowEnvelope, WorkflowFailure } from '../../types.js';
import { isWorkflowError, WORKSPACE_MODES } from '../../types.js';
import { WorkspaceContractSchema, type LeaseSession, type SessionRef, type WorkspaceContract } from '../../workspace.js';
import { fetchMissingCommits, headCommit, reconcileCopy } from '../../worktree.js';

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CommandProcess {
  /** Settles when the command has exited and closed its output. */
  exit: Promise<CommandResult>;
  /**
   * SIGTERM, then SIGKILL after the grace period. Settles once the command's process group is gone, which can be after
   * `exit` when a process it started outlives it; a second call changes nothing.
   */
  stop(): Promise<CommandResult>;
}

const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP'];

/** How long the driver waits for a command or prompt before asking the run again; half that while a question is open. */
let pollMs = 2000;

/** Shorten the driver's poll (for testing only). */
export function _setDriverPollMs(ms: number): void {
  pollMs = ms;
}

/**
 * Starts a leased command with `env`: the step's environment with the lease `env` set over it, so values reach the
 * shell only as variables. A detached command leads a process group of its own, so `stop` reaches everything it
 * started; it has no controlling terminal, and a terminal's Ctrl-C does not reach it.
 */
function startCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, detached: boolean): CommandProcess {
  const child = spawn(command, { cwd, shell: true, env, windowsHide: true, detached });
  const exit = new Promise<CommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => resolve({ exitCode: 1, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
  return { exit, stop: stopProcess(child, exit, detached) };
}

/** What a leased command came to: it ran, staging failed, or it was stopped or its lease ended before it could start. */
type StagedResult = { kind: 'ran'; result: CommandResult } | { kind: 'unstaged'; failure: WorkflowFailure } | { kind: 'stopped' };

interface StagedCommand {
  exit: Promise<StagedResult>;
  /** Aborts staging and setup, or stops the command once it runs. Settles once the attempt is over; a second call changes nothing. */
  stop(): Promise<unknown>;
}

/** Whether a staged lease may start its command or tool: nothing stopped it, and its deadline has not passed. */
function startable(lease: Lease, signal: AbortSignal): boolean {
  return !signal.aborted && (lease.expiresAt === undefined || Date.now() < Date.parse(lease.expiresAt));
}

/**
 * Stages a leased command, then starts it, as one attempt, so the driver keeps asking the run what to do while staging
 * and setup run, and a cancel reaches either phase.
 */
function stageThenStart(lease: Lease, stage: (signal: AbortSignal) => Promise<WorkflowFailure | undefined>, start: () => CommandProcess): StagedCommand {
  const controller = new AbortController();
  let command: CommandProcess | undefined;
  const exit = (async (): Promise<StagedResult> => {
    const failure = await stage(controller.signal);
    if (!startable(lease, controller.signal)) return { kind: 'stopped' };
    if (failure) return { kind: 'unstaged', failure };
    command = start();
    return { kind: 'ran', result: await command.exit };
  })();
  return { exit, stop: async () => {
    controller.abort();
    await command?.stop();
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

function readHitlRequest(raw: unknown): LocalHitl | undefined {
  if (!isRecord(raw) || typeof raw.run !== 'string' || typeof raw.step !== 'string' || typeof raw.pass !== 'number'
    || (raw.kind !== 'approve' && raw.kind !== 'choose') || typeof raw.message !== 'string' || typeof raw.required !== 'boolean'
    || typeof raw.respond !== 'string' || !Array.isArray(raw.options) || !raw.options.every((option): option is string => typeof option === 'string')) return undefined;
  return { run: raw.run, step: raw.step, pass: raw.pass, respond: raw.respond, kind: raw.kind, message: raw.message, required: raw.required, options: raw.options,
    ...(typeof raw.default === 'string' ? { default: raw.default } : {}) };
}

async function askHitl(hitl: LocalHitl, signal: AbortSignal): Promise<string> {
  process.stderr.write(`Step "${hitl.step}": ${hitl.message}\nOptions: ${hitl.options.join(', ')}\n${hitl.respond}\n`);
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question('Choice, followed by an optional note: ', { signal });
  } finally {
    terminal.close();
  }
}

/** Local tool selection and terminal behavior for one driver invocation. */
export interface LocalDriverOptions {
  /** Overrides auto approval for this process without changing member config. */
  autoApprove?: boolean;
  /** Declares whether a person can answer HITL requests and work in foreground tools. */
  hitl?: boolean;
  /** The terminal question implementation, injectable for callers without readline. */
  question?: (hitl: LocalHitl, signal: AbortSignal) => Promise<string>;
  tools?: Record<string, string>;
  /** The team's `toolPaths`, as teamai.yaml states them. */
  toolPaths?: TeamaiConfig['toolPaths'];
  adapter?: LocalToolAdapter;
}

interface Lease {
  /** The step path, such as `check.classify` inside a sub-workflow. */
  step: string;
  attempt: AttemptId;
  revision: number;
  command?: string;
  env?: Record<string, string>;
  prompt?: string;
  agent?: string;
  model?: string;
  defaultModel?: string;
  workspace?: WorkspaceContract;
  /** The lease named a workspace this driver cannot read. The step fails instead of running in the active checkout. */
  unreadableWorkspace?: true;
  session?: LeaseSession;
  /** The env keys the step gets and the ones kept from it, by name. */
  envScope?: EnvScope;
  /** The most agent turns the prompt's tool may take. */
  maxTurns?: number;
  /** What to run in a workspace this driver creates, before the step. */
  setup?: LeaseSetup;
  /** When the engine cancels the lease. A step staged after it does not start. */
  expiresAt?: string;
  /** The environment the step's command or tool runs with, built from `envScope` when the lease is staged. */
  processEnv?: NodeJS.ProcessEnv;
  /** Set once the step has a directory to run in. */
  cwd?: string;
  /** Whether this lease gives the foreground terminal to its tool. */
  interactive?: true;
  /** The step set `workspace: read-only`. An interactive prompt is checked only then. */
  readOnly?: true;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === 'string') ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

function resultPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'result.json');
}

/**
 * Masks the secret values an attempt's result file holds, so the copy it keeps on disk carries none. A file that is
 * not JSON, such as one a tool stopped writing halfway, is masked as text.
 */
async function maskResultFile(file: string, secrets: Record<string, string>): Promise<void> {
  const text = await readFileSafe(file);
  if (text === null) return;
  let kept: unknown;
  try {
    kept = JSON.parse(text);
  } catch {
    // Text a tool wrote as JSON holds a secret with a quote or a backslash in its escaped form.
    const escaped = Object.fromEntries(Object.entries(secrets).map(([label, value]) => [label, JSON.stringify(value).slice(1, -1)]));
    const masked = redact(redact(text, { envSecrets: escaped, patterns: false }), { envSecrets: secrets, patterns: false });
    if (masked !== text) await writeFileAtomic(file, masked);
    return;
  }
  const masked = redactJson(kept, secrets);
  if (JSON.stringify(masked) !== JSON.stringify(kept)) await writeJsonAtomic(file, masked);
}

/** Masks the result file of every attempt of the run, so one that ended without a report, on a signal too, keeps no secret. */
async function maskAttemptFiles(config: LocalConfig, run: RunId, secrets: Record<string, string>): Promise<void> {
  const listed = await fs.readdir(attemptsDir(config, run)).catch(() => []);
  const attempts = listed.flatMap((name) => {
    const attempt = AttemptIdSchema.safeParse(name);
    return attempt.success ? [attempt.data] : [];
  });
  await Promise.all(attempts.map((attempt) => maskResultFile(resultPath(config, run, attempt), secrets)));
}

function supportedTool(value: string): value is LaunchTool {
  return isLaunchTool(value);
}

function ignoredCodexSettings(agent: AgentSpec): string[] {
  const extras = Object.keys(agent.tool_extras?.codex ?? {});
  return agent.tools?.length ? ['tools', ...extras] : extras;
}

function definitionRun(tool: LaunchTool, name: string, agent: AgentSpec): NonNullable<LocalToolRun['agent']> {
  const settings = localToolFamily(tool) === 'opencode' ? toolExtrasFor(agent, 'opencode') : undefined;
  return { name, instructions: agent.instructions, ...(agent.model ? { model: agent.model } : {}), ...(settings ? { settings } : {}) };
}

function failureReport(failure: WorkflowFailure): { outcome: 'failed'; message: string; failure: WorkflowFailure } {
  return { outcome: 'failed', message: failure.message, failure };
}

type ReportBody = ReportInput;

function parseLease(rawLease: unknown): Lease | undefined {
  if (!isRecord(rawLease) || typeof rawLease.step !== 'string' || typeof rawLease.revision !== 'number') return undefined;
  const attempt = AttemptIdSchema.safeParse(rawLease.attempt);
  if (!attempt.success) return undefined;
  const env = stringMap(rawLease.env);
  const envScope = EnvScopeSchema.safeParse(rawLease.envScope);
  const setup = LeaseSetupSchema.safeParse(rawLease.setup);
  const workspace = WorkspaceContractSchema.safeParse(rawLease.workspace);
  const session = sessionRefOf(rawLease.session);
  const earlier = isRecord(rawLease.session) && Array.isArray(rawLease.session.earlier)
    ? rawLease.session.earlier.map(sessionRefOf).filter((ref) => ref !== undefined) : [];
  const lease: Lease = {
    step: rawLease.step,
    attempt: attempt.data,
    revision: rawLease.revision,
    ...(typeof rawLease.command === 'string' ? { command: rawLease.command } : {}),
    ...(env ? { env } : {}),
    ...(envScope.success ? { envScope: envScope.data } : {}),
    ...(typeof rawLease.maxTurns === 'number' ? { maxTurns: rawLease.maxTurns } : {}),
    ...(setup.success ? { setup: setup.data } : {}),
    ...(typeof rawLease.expiresAt === 'string' ? { expiresAt: rawLease.expiresAt } : {}),
    ...(typeof rawLease.prompt === 'string' ? { prompt: rawLease.prompt } : {}),
    ...(typeof rawLease.agent === 'string' ? { agent: rawLease.agent } : {}),
    ...(typeof rawLease.model === 'string' ? { model: rawLease.model } : {}),
    ...(rawLease.interactive === true ? { interactive: true } : {}),
    ...(rawLease.readOnly === true ? { readOnly: true } : {}),
    ...(typeof rawLease.defaultModel === 'string' ? { defaultModel: rawLease.defaultModel } : {}),
    ...(workspace.success ? { workspace: workspace.data } : rawLease.workspace !== undefined ? { unreadableWorkspace: true } : {}),
    ...(session ? { session: { ...session, ...(earlier.length > 0 ? { earlier } : {}) } } : {}),
  };
  return (lease.command === undefined) === (lease.prompt === undefined) ? undefined : lease;
}

function sessionRefOf(value: unknown): SessionRef | undefined {
  return isRecord(value) && typeof value.tool === 'string' && typeof value.id === 'string' ? { tool: value.tool, id: value.id } : undefined;
}

/** The place fields of `lease`. */
function placeLease(lease: Lease): PlaceLease {
  return {
    attempt: lease.attempt,
    step: lease.step,
    executor: lease.command !== undefined ? 'command' : 'prompt',
    ...(lease.prompt !== undefined ? { prompt: lease.prompt } : {}),
    ...(lease.interactive ? { interactive: true } : {}),
    ...(lease.readOnly ? { readOnly: true } : {}),
    ...(lease.workspace ? { workspace: lease.workspace } : {}),
    ...(lease.setup ? { setup: lease.setup } : {}),
    ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
  };
}

/**
 * Gets the lease a place to run under `root`, with the team env `values` resolved for it. `signal` stops setup, which
 * then fails, and the workspace it was preparing is removed.
 */
async function stageLease(lease: Lease, { config, lock, root, values, mode, signal }: {
  config: LocalConfig;
  lock: RunLock;
  root: string;
  values: ReadonlyMap<string, string>;
  mode: RunMode;
  signal?: AbortSignal;
}): Promise<WorkflowFailure | undefined> {
  if (lease.unreadableWorkspace) {
    return { code: 'workspace_base', message: `Step "${lease.step}" was leased a workspace this teamai cannot read. Update teamai.` };
  }
  if (lease.envScope) {
    const scoped = await stepEnvironment(values, lease.envScope);
    if (!scoped.ok) return scoped.failure;
    lease.processEnv = scoped.env;
  }
  const prepared = await preparePlace({ config, lock, root, lease: placeLease(lease) });
  if (prepared.kind !== 'prepared') return prepared.failure;
  lease.cwd = prepared.dir;
  if (prepared.prompt !== undefined) lease.prompt = prepared.prompt;
  return runPlaceSetup({ config, run: lock.run, attempt: lease.attempt, mode, values, ...(signal ? { signal } : {}) });
}

/**
 * The session the step's tool resumes, and the lease session it continues: the lease's session, else each earlier one it
 * continued, newest first. Each is tried on this machine, then as a copy in this tool, then as a copy of the one the team
 * session archive holds. OpenCode has no flag to resume one, so its step starts a new session.
 */
async function resumeSession(archive: SessionArchive, lease: Lease, tool: LaunchTool, cwd: string): Promise<{ id: string; resumed: SessionRef } | undefined> {
  const to = AgentSession.platformForTool(tool);
  if (!lease.session || !to) return undefined;
  const resumes = localToolFamily(tool) !== 'opencode';
  const misses: string[] = [];
  for (const session of [lease.session, ...(lease.session.earlier ?? [])]) {
    if (!supportedTool(session.tool)) continue;
    const from = AgentSession.platformForTool(session.tool);
    if (!from) continue;
    const resumed = { tool: session.tool, id: session.id };
    if (localToolFamily(session.tool) === localToolFamily(tool) && resumes) {
      const found = await AgentSession.find({ platform: from, sessionId: session.id }, { scrub: false });
      if (found.status === 'done') return { id: session.id, resumed };
      misses.push(found.failure.message);
    } else {
      const copied = await AgentSession.copy({ from: { platform: from, sessionId: session.id }, to: { platform: to, cwd } });
      if (copied.status === 'done') return resumes ? { id: copied.sessionId, resumed } : undefined;
      misses.push(copied.failure.message);
    }
    const restored = await archive.restore({ platform: from, sessionId: session.id }, { platform: to, cwd });
    if (restored.status !== 'fresh') return resumes ? { id: restored.sessionId, resumed } : undefined;
    misses.push(restored.reason);
  }
  if (misses.length > 0) log.warn(`Step "${lease.step}" starts a new ${tool} session: ${misses.join(' ')}`);
  return undefined;
}

async function commandReport(config: LocalConfig, lock: RunLock, driver: DriverIdentity, lease: Lease, result: CommandResult): Promise<ReportBody> {
  const output = commandOutputs(result.stdout);
  const attemptResultPath = resultPath(config, lock.run, lease.attempt);
  await fs.mkdir(path.dirname(attemptResultPath), { recursive: true });
  await writeJsonAtomic(attemptResultPath, output !== undefined ? { output } : {});
  const snippet = result.stderr.trim().slice(0, 400);
  const end: StepEnd = result.exitCode === 0
    ? { outcome: 'success' }
    : { outcome: 'failed', message: snippet === '' ? `command exited with status ${result.exitCode}` : `command exited with status ${result.exitCode}: ${snippet}` };
  return {
    attempt: lease.attempt,
    revision: lease.revision,
    outcome: end.outcome,
    driver,
    ...(output !== undefined ? { outputs: output } : {}),
    exitCode: result.exitCode,
    ...(end.message ? { message: end.message } : {}),
  };
}

/**
 * The team skills the pass's session and its subagents loaded since `launchedAt`, credited by `teamSkills`, what its
 * checkout held as delivered at launch. A load before it, by a pass whose session this one resumes, is that pass's.
 * Undefined when the session cannot be read.
 */
async function usedInSession(tool: LaunchTool, sessionId: string, cwd: string, teamSkills: Record<string, string[]>, launchedAt: number): Promise<Used | undefined> {
  const platform = AgentSession.platformForTool(tool);
  if (!platform) return undefined;
  const found = await AgentSession.find({ platform, sessionId, cwd }, { subagents: true }).catch(() => undefined);
  const atOrAfterLaunch = (timestamp: string | undefined): boolean => timestamp === undefined || !(Date.parse(timestamp) < launchedAt);
  return found?.status === 'done'
    ? { skills: usedSkills(AgentSession.toolForPlatform(platform), found, (timestamp) => atOrAfterLaunch(timestamp) ? teamSkills : {}) }
    : undefined;
}

async function promptReport(
  config: LocalConfig,
  lock: RunLock,
  driver: DriverIdentity,
  lease: Lease,
  tools: Record<string, string>,
  adapter: LocalToolAdapter,
  options: LocalDriverOptions,
  archive: SessionArchive,
  signal: AbortSignal,
  mode: RunMode,
): Promise<ReportBody> {
  const selected = lease.agent && tools[lease.agent] ? tools[lease.agent] : tools.default;
  const giveUp = async (failure: WorkflowFailure, tool?: string): Promise<ReportBody> => {
    const unrestored = await abandonPlace({ config, lock, attempt: lease.attempt });
    const reported = unrestored ? { ...failure, message: `${failure.message.replace(/\.?$/, '.')} ${unrestored}` } : failure;
    return { attempt: lease.attempt, revision: lease.revision, driver, ...(tool ? { tool } : {}), ...failureReport(reported) };
  };
  if (!selected) return giveUp({ code: 'tool_unconfigured', message: 'No local workflow tool is configured for this prompt step' });
  if (!supportedTool(selected)) {
    return giveUp({ code: 'tool_unsupported', message: `The local workflow tool "${selected}" is not supported` }, selected);
  }
  // A worktree has its own pull record, so the tool launched there is observed and bound as that checkout.
  const stepConfig = lease.workspace && lease.cwd ? await detectProjectConfig(lease.cwd) ?? config : config;
  const loaded = lease.agent ? await loadDeployedAgent({ tool: selected, name: lease.agent, config: stepConfig, toolPaths: options.toolPaths }) : undefined;
  const agent = loaded?.spec;
  if (lease.agent && !agent) {
    return giveUp({
      code: 'agent_unavailable',
      message: `Agent "${lease.agent}" is not available for ${selected}. Run teamai pull and try again.`,
    }, selected);
  }
  const chosen = await chooseStepModel({
    step: lease.step, tool: selected, model: lease.model, defaultModel: lease.defaultModel, agent: agent ?? undefined, config: stepConfig,
  });
  if (!chosen.ok) return giveUp(chosen.failure, selected);
  if (agent && localToolFamily(selected) === 'codex') {
    const ignored = ignoredCodexSettings(agent);
    if (ignored.length > 0) {
      log.warn(`Agent "${agent.name}" on ${selected} does not apply ${ignored.join(', ')} from the deployed agent file. codex exec still has a shell. The step is not blocked.`);
    }
  }
  const cwd = lease.cwd ?? driver.workspace;
  const attemptResultPath = resultPath(config, lock.run, lease.attempt);
  const resume = await resumeSession(archive, lease, selected, cwd);
  const definitionModel = chosen.model && chosen.by === 'definition'
    ? { model: chosen.model.name, ...(chosen.model.effort ? { effort: chosen.model.effort } : {}) }
    : {};
  const { teamDelivery } = await import('../../../pull.js');
  const delivery = await teamDelivery(stepConfig, selected).catch(() => undefined);
  const delivered = delivery?.record?.delivered;
  const [observed, launch, teamSkills] = await Promise.all([
    observeLaunch({
      config: stepConfig,
      tool: selected,
      cwd,
      delivery: delivery ?? null,
      ...(lease.agent && loaded ? { definition: { stem: lease.agent, file: loaded.file, ...definitionModel } } : {}),
      ...(chosen.model && chosen.by !== 'definition'
        ? { chosen: { model: chosen.model.name, ...(chosen.model.effort ? { effort: chosen.model.effort } : {}), ...(chosen.alias ? { alias: chosen.alias } : {}) } }
        : {}),
    }),
    workflowLaunch(stepConfig, selected),
    delivered ? deliveredTeamSkills(stepConfig, cwd, delivered).catch(() => undefined) : undefined,
  ]);
  // Only headless Claude has a turn limit; any other launch reports the cap as not enforced.
  const capsTurns = lease.maxTurns !== undefined && !lease.interactive && localToolFamily(selected) === 'claude';
  let result: LocalToolResult;
  const launchedAt = Date.now();
  try {
    if (lease.interactive) log.info(`Step "${lease.step}" opens ${selected} here for interactive work.`);
    const run = lease.interactive ? adapter.runInteractive.bind(adapter) : adapter.run.bind(adapter);
    result = await run(selected, {
      prompt: lease.prompt!,
      cwd,
      resultPath: attemptResultPath,
      env: { ...lease.processEnv ?? process.env, ...attemptEnv(lock.run, lease.attempt, mode) },
      ...(launch ? { launch } : {}),
      ...(resume ? { resume: resume.id } : {}),
      ...(agent ? { agent: definitionRun(selected, lease.agent!, agent) } : {}),
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(capsTurns ? { maxTurns: lease.maxTurns } : {}),
    }, signal);
  } catch {
    result = {
      started: false,
      exitCode: 1,
      failure: { code: 'tool_failed', message: `${selected} could not complete the workflow step` },
    };
  }
  const end: StepEnd = result.exitCode === 0 && !result.failure
    ? { outcome: 'success' }
    : { outcome: 'failed', ...(result.failure ? { message: result.failure.message, failure: result.failure } : {}) };
  const ran = result.started ? result : undefined;
  const used = ran?.session && teamSkills ? await usedInSession(selected, ran.session, cwd, teamSkills, launchedAt) : undefined;
  return {
    attempt: lease.attempt,
    revision: lease.revision,
    driver,
    tool: selected,
    ...(ran?.model ? { model: ran.model } : {}),
    ...(ran?.session ? { session: ran.session } : {}),
    ...(ran && resume ? { resumed: resume.resumed } : {}),
    ...(ran?.tokens ? { tokens: ran.tokens } : {}),
    ...(ran?.output !== undefined ? { outputs: ran.output } : {}),
    // How the definition was handed over is known only once the launch resolved its tool: OpenCode's depends on its major.
    ...(ran ? { agent: ran.applied ? { ...observed, definition: { applied: ran.applied } } : observed } : {}),
    ...(used ? { used } : {}),
    ...(lease.maxTurns !== undefined && !capsTurns ? { unenforced: ['max_turns' as const] } : {}),
    exitCode: result.exitCode,
    ...(end.failure ? failureReport(end.failure) : { outcome: end.outcome, ...(end.message ? { message: end.message } : {}) }),
  };
}

/**
 * Run leased commands, up to `workflows.max_parallel` at once. Each lease and
 * report goes through the same engine operations an external driver calls.
 */
export async function runLocalDriver(
  config: LocalConfig,
  runId: string,
  cwd: string,
  options: LocalDriverOptions = {},
): Promise<WorkflowEnvelope> {
  return withDriverLock(config, runId, (drive) => drive(cwd, options));
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

/**
 * Once after this machine took run `runId` over, before its first lease: brings the local branch of each copy the run
 * recorded a commit for to that commit, fetched the way a lease fetches what it lacks. A settled run waits for a retry
 * to reopen it, since it leases nothing before that.
 */
async function reconcileTakenCopies(config: LocalConfig, runId: string, active: string): Promise<WorkflowFailure | undefined> {
  const run = await readRun(config, runId);
  if (typeof run !== 'object' || !run.publication?.reconcileCopies || run.status !== 'running') return undefined;
  const recorded = Object.entries(run.copies ?? {}).flatMap(([branch, copy]) => (copy.commit === undefined ? [] : [{ branch, commit: copy.commit }]));
  const fetched = await fetchMissingCommits(active, { run: runId, commits: recorded.map((copy) => copy.commit) });
  if (fetched.missing.length > 0) {
    const named = recorded.filter((copy) => fetched.missing.includes(copy.commit)).map((copy) => `commit ${copy.commit} from branch ${copy.branch}`);
    const said = fetched.fetchError ? ` Git said: ${fetched.fetchError}.` : '';
    return { code: 'workspace_base', message: `Run ${runId} records ${named.join(', ')}, which this checkout does not have, even after fetching the run's branches from origin.${said} Push each branch to origin from the machine that has its commit, then resume the run.` };
  }
  for (const { branch, commit } of recorded) {
    const refused = await reconcileCopy(active, branch, commit);
    if (refused) return { code: 'branch_diverged', message: refused.error };
  }
  await updateRun(config, runId, await knownSecrets(config), async (local) => {
    if (local === 'missing' || !local.publication?.reconcileCopies) return { value: undefined };
    const { reconcileCopies: _done, ...publication } = local.publication;
    return { value: undefined, write: { ...local, publication } };
  });
  return undefined;
}

/** Adds to `seen` each value of `secrets` it lacks, under a label of its own when its name already holds another value. */
function rememberSecrets(seen: Record<string, string>, secrets: Record<string, string>): Record<string, string> {
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
 * It cannot deny a step the network, and keeps it from the member's machine only on a host the member marks `sandbox`.
 * It gives each command and tool only the env keys its lease provides, and runs setup in each workspace it creates.
 */
function localCan(config: LocalConfig, hitl: boolean): Required<DriverCan> {
  return { hitl, workspace: [...WORKSPACE_MODES], network: false, isolation: config.workflows?.sandbox ? 'sandbox' : 'none', env: true, tokens: true, max_turns: true, setup: true };
}

async function driveRun(config: LocalConfig, lock: RunLock, cwd: string, options: LocalDriverOptions): Promise<WorkflowEnvelope> {
  const runId = lock.run;
  const started = await readRun(config, runId);
  // Places go under the checkout the run started from, wherever in it the driver runs.
  const root = await placeRoot({ cwd, checkout: typeof started === 'object' ? started.checkout : undefined });
  const unreconciled = await reconcileTakenCopies(config, runId, root);
  if (unreconciled) return { error: unreconciled };
  const canHitl = options.hitl ?? (process.stdin.isTTY === true && process.stderr.isTTY === true);
  // Resolved once per drive, so a resume where a person attends runs attended whatever mode the run started in.
  const mode = resolveRunMode(process.env);
  const can = localCan(config, canHitl);
  const driver = driverIdentity('local', cwd);
  const tools = { ...config.workflows?.tools, ...options.tools };
  const adapter = options.adapter ?? createLocalToolAdapter();
  const archive = openSessionArchive(config);
  const maxParallel = config.workflows?.max_parallel ?? 1;
  // One command at a time keeps the terminal: Ctrl-C reaches it, and it can prompt on /dev/tty. Parallel commands get
  // process groups of their own, which `stop` and the signal handlers below can end as a whole.
  const detached = maxParallel > 1 && process.platform !== 'win32';
  const reported = new Set<string>();
  const inFlight = new Map<string, { lease: Lease; command: StagedCommand }>();
  // Leases not started yet, in lease order. Steps that share a checkout run one at a time. Distinct worktrees overlap.
  const held: Lease[] = [];
  // Cancelled commands whose process group is not gone yet. They are not sent as running, so `next` does not cancel
  // them again. They still take a slot, and a new attempt of their step waits until they are gone, so a retried step
  // never runs beside its cancelled attempt.
  const dying = new Map<string, { step: string; lease: Lease; command: StagedCommand }>();
  const base = await headCommit(root);
  // A prompt that was stopped before its tool started has nothing to report.
  let prompt: { lease: Lease; controller: AbortController; exit: Promise<ReportBody | undefined> } | undefined;
  let question: { hitl: LocalHitl; controller: AbortController; exit: Promise<{ kind: 'question'; line?: string }> } | undefined;
  // A headless prompt takes a slot as a command does, so a step in another checkout starts beside it. An interactive one has the terminal.
  const busy = (): number => inFlight.size + dying.size + (prompt ? 1 : 0);
  const room = (): boolean => !prompt?.lease.interactive && busy() + held.length < maxParallel && !held.some((lease) => lease.prompt !== undefined);
  const cancel = (attempt: string): void => {
    if (prompt?.lease.attempt === attempt) prompt.controller.abort();
    const index = held.findIndex((lease) => lease.attempt === attempt);
    if (index !== -1) held.splice(index, 1);
    const running = inFlight.get(attempt);
    if (!running) return;
    inFlight.delete(attempt);
    dying.set(attempt, { step: running.lease.step, lease: running.lease, command: running.command });
    void running.command.stop();
  };
  let interactiveIgnores: readonly NodeJS.Signals[] = [];
  let signalled: NodeJS.Signals | undefined;
  let wake = (): void => {};
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
    if (prompt?.lease.interactive && interactiveIgnores.includes(signal)) return;
    if (inFlight.size === 0 && dying.size === 0 && !prompt) return exitOn(signal);
    signalled ??= signal;
    prompt?.controller.abort(signal);
    wake();
  };
  if (maxParallel > 1) handle(STOP_SIGNALS);
  // The team env, resolved once per turn of the loop: the leases it hands out, their env, and what it masks agree. It
  // masks every value the drive has seen, so a value that changed while an attempt ran stays masked in what it reports.
  let env: WorkflowEnv | undefined;
  const seen: Record<string, string> = {};
  const report = async (body: ReportBody, lease: Lease): Promise<WorkflowEnvelope | undefined> => {
    const secrets = env?.secrets ?? await knownSecrets(config);
    await maskResultFile(resultPath(config, runId, lease.attempt), secrets);
    const answer = await managedReport({ config, runId, report: body, secrets, lock });
    // Cancelled while it ran: the next `next` lists it in `cancelled`, and the run goes on without it.
    if (isWorkflowError(answer)) return answer.error.code === 'lease_cancelled' ? undefined : answer;
    reported.add(body.attempt);
    return undefined;
  };
  const unstaged = (lease: Lease, failure: WorkflowFailure): ReportBody => ({ attempt: lease.attempt, revision: lease.revision, driver, ...failureReport(failure) });
  try {
    for (;;) {
      if (signalled) return { error: { code: 'interrupted', message: `Stopped by ${signalled} after every command it started exited` } };
      const running = [...inFlight.keys(), ...held.map((lease) => lease.attempt), ...(prompt ? [prompt.lease.attempt] : [])];
      const canTakeLease = room();
      const resolved = await resolveWorkflowEnv(config);
      const turn = { ...resolved, secrets: rememberSecrets(seen, resolved.secrets) };
      env = turn;
      const next = await leaseNext(config, runId, driver, {
        running, canTakeLease, can, autoApprove: options.autoApprove, ...(base ? { base } : {}), env: turn,
      });
      if (signalled) continue;
      if (isWorkflowError(next)) return next;
      for (const attempt of Array.isArray(next.data.cancelled) ? next.data.cancelled as string[] : []) cancel(attempt);
      if ('done' in next.data) {
        question?.controller.abort();
        if (prompt) {
          const lease = prompt.lease;
          prompt.controller.abort();
          const body = await prompt.exit;
          const failed = body && await report(body, lease);
          prompt = undefined;
          if (failed) return failed;
        }
        return next;
      }
      const hitl = readHitlRequest(next.data.hitl);
      const nextLease = 'lease' in next.data ? parseLease(next.data.lease) : undefined;
      if (question && (nextLease?.step === question.hitl.step
        || (!nextLease && (hitl?.step !== question.hitl.step || hitl?.pass !== question.hitl.pass)))) {
        question.controller.abort();
        await question.exit;
        question = undefined;
      }
      if ('lease' in next.data) {
        const lease = nextLease;
        if (!lease) return { error: { code: 'run_unreadable', message: `Run ${runId} returned a lease the local driver cannot run` } };
        if (reported.has(lease.attempt)) {
          return { error: { code: 'driver_stuck', message: `Attempt ${lease.attempt} was leased again before it could be reported` } };
        }
        held.push(lease);
      }
      const placesBusy = (): Set<string> => new Set([
        ...[...inFlight.values()].map(({ lease }) => placeOf(lease, root)),
        ...[...dying.values()].map(({ lease }) => placeOf(lease, root)),
        ...(prompt ? [placeOf(prompt.lease, root)] : []),
      ]);
      for (let index = 0; !prompt?.lease.interactive && busy() < maxParallel;) {
        const lease = held[index];
        const command = lease?.command;
        if (lease === undefined || command === undefined) break;
        if ([...dying.values()].some((stopping) => stopping.step === lease.step)
          || placesBusy().has(placeOf(lease, root))
          || held.slice(0, index).some((earlier) => earlier.prompt !== undefined && placeOf(earlier, root) === placeOf(lease, root))) {
          index += 1;
          continue;
        }
        held.splice(index, 1);
        // Setup runs in its own process group, out of the terminal's reach, so the driver handles every stop signal until
        // the command starts. An attached command already has the signals its terminal sends to the whole group; a second
        // would force-quit some tools.
        const forwarded = maxParallel === 1 ? commandSignalPolicy(await terminalReachesCommand()).forwarded : undefined;
        if (forwarded) handle(STOP_SIGNALS);
        inFlight.set(lease.attempt, { lease, command: stageThenStart(
          lease,
          (signal) => stageLease(lease, { config, lock, root, values: turn.values, mode, signal }),
          () => {
            if (forwarded) handle(forwarded);
            return startCommand(command, lease.cwd ?? root, { ...lease.processEnv ?? process.env, ...lease.env, ...attemptEnv(runId, lease.attempt, mode) }, detached);
          },
        ) });
      }
      if (!prompt && busy() < maxParallel) {
        const promptAt = held.findIndex((lease) => lease.prompt !== undefined
          && !placesBusy().has(placeOf(lease, root))
          && ![...dying.values()].some((stopping) => stopping.step === lease.step)
          && (!lease.interactive || (inFlight.size === 0 && dying.size === 0)));
        if (promptAt !== -1) {
          const lease = held.splice(promptAt, 1)[0]!;
          if (lease.interactive && question) {
            question.controller.abort();
            await question.exit;
            question = undefined;
          }
          // Setup runs out of the terminal's reach, so the tool's signals are left to it only once it starts.
          interactiveIgnores = [];
          const ignored = lease.interactive ? commandSignalPolicy(await terminalReachesCommand()).ignored : [];
          const controller = new AbortController();
          if (maxParallel === 1) handle(STOP_SIGNALS);
          prompt = { lease, controller, exit: (async () => {
            const failure = await stageLease(lease, { config, lock, root, values: turn.values, mode, signal: controller.signal });
            if (!startable(lease, controller.signal)) {
              await abandonPlace({ config, lock, attempt: lease.attempt });
              return undefined;
            }
            if (failure) return unstaged(lease, failure);
            interactiveIgnores = ignored;
            return promptReport(config, lock, driver, lease, tools, adapter, options, archive, controller.signal, mode);
          })() };
        }
      }
      if (canHitl && hitl && !question && !prompt?.lease.interactive) {
        const controller = new AbortController();
        question = { hitl, controller, exit: (options.question ?? askHitl)(hitl, controller.signal)
          .then((line) => ({ kind: 'question' as const, line }), () => ({ kind: 'question' as const })) };
      }
      if ('lease' in next.data && room()) continue;
      if (inFlight.size === 0 && dying.size === 0 && !prompt && !question) {
        const wait = isRecord(next.data.wait) ? next.data.wait : {};
        // Another process of this machine delivers a step this run waits for; it settles without this driver.
        if (Array.isArray(wait.delivering) && wait.delivering.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }
        // A wait for a call that could not take a lease says nothing about what is left; ask again with room.
        if (!canTakeLease) continue;
        return { error: { code: 'busy', message: typeof wait.reason === 'string' ? wait.reason : 'the next step is not available' } };
      }
      let timer: NodeJS.Timeout | undefined;
      const exited = await Promise.race([
        ...[...inFlight.values()].map(({ lease, command }) => command.exit.then((result) => ({ kind: 'command' as const, attempt: lease.attempt, lease, result }))),
        ...[...dying].map(([attempt, { command }]) => command.stop().then(() => ({ kind: 'stopped' as const, attempt }))),
        ...(prompt ? [prompt.exit.then((body) => ({ kind: 'prompt' as const, body }))] : []),
        ...(question ? [question.exit] : []),
        new Promise<undefined>((resolve) => {
          wake = () => resolve(undefined);
          timer = setTimeout(wake, question ? pollMs / 2 : pollMs);
        }),
      ]);
      clearTimeout(timer);
      if (!exited) continue;
      if (exited.kind === 'question') {
        const hitl = question!.hitl;
        question = undefined;
        if (exited.line === undefined) return { error: { code: 'interrupted', message: 'The HITL question closed without an answer. Continue with teamai workflow resume.' } };
        const [choice = '', ...words] = exited.line.trim().split(/\s+/);
        const provenance = respondProvenance({ kind: 'terminal', caller: callerProvenance(process.env, { isTTY: true }) });
        const answer = await respondToHitl(config, runId, turn.secrets, { step: hitl.step, pass: hitl.pass, choice, ...(words.length > 0 ? { note: words.join(' ') } : {}), provenance });
        if (isWorkflowError(answer)) {
          // agent_in_path: the driver runs inside an agent session; it keeps waiting for the person's answer from elsewhere.
          if (!['repeated_response', 'stale_response', 'invalid_choice', 'not_waiting', 'run_settled', 'agent_in_path'].includes(answer.error.code)) return answer;
          log.warn(answer.error.message);
        }
        continue;
      }
      if (exited.kind === 'prompt') {
        const ended = prompt;
        prompt = undefined;
        if (maxParallel === 1) handle([]);
        const failed = exited.body && ended && await report(exited.body, ended.lease);
        if (failed) return failed;
        continue;
      }
      if (exited.kind === 'stopped') {
        const stopping = dying.get(exited.attempt);
        dying.delete(exited.attempt);
        if (maxParallel === 1) handle([]);
        if (stopping) await abandonPlace({ config, lock, attempt: stopping.lease.attempt });
        continue;
      }
      inFlight.delete(exited.attempt);
      if (maxParallel === 1) handle([]);
      const staged = exited.result;
      if (staged.kind === 'stopped') {
        // Its lease ended while it was staged: the engine stops it, and the driver leaves the copy as it found it.
        await abandonPlace({ config, lock, attempt: exited.lease.attempt });
        continue;
      }
      const body = staged.kind === 'unstaged'
        ? unstaged(exited.lease, staged.failure)
        : await commandReport(config, lock, driver, exited.lease, staged.result);
      const failed = await report(body, exited.lease);
      if (failed) return failed;
    }
  } finally {
    // The sweep runs even when stopping what still runs throws, so no attempt's result file keeps a secret.
    try {
      question?.controller.abort();
      prompt?.controller.abort(signalled);
      if (prompt) await prompt.exit;
      for (const attempt of inFlight.keys()) cancel(attempt);
      await Promise.all([...dying.values()].map(async ({ lease, command }) => {
        await command.stop();
        await abandonPlace({ config, lock, attempt: lease.attempt });
      }));
    } finally {
      await maskAttemptFiles(config, runId, env?.secrets ?? await knownSecrets(config));
    }
    await archive.close();
    if (signalled) exitOn(signalled);
    handle([]);
  }
}
