import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  agentFileExtensionForTool,
  reverseFromClaude,
  reverseFromCodex,
  reverseFromOpencode,
  toolExtrasFor,
  type AgentSpec,
  type ToolName,
} from '../resources/agent-format.js';
import { observeLaunch } from '../agent-observation.js';
import { acquireLock, releaseLock } from '../update.js';
import { commandSignalPolicy, exitLike, terminalReachesCommand } from '../env-exec.js';
import { workflowLaunch } from '../launch-context.js';
import { getDataHome, resolveToolBaseDir, type LocalConfig, type TeamaiConfig } from '../types.js';
import { readFileSafe, readJson, writeJsonAtomic } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { interactiveHitlRequired, leaseNext, reportAttempt } from './engine.js';
import { respondToHitl } from './run-controls.js';
import { isRecord } from './expression.js';
import {
  createLocalToolAdapter,
  isLocalWorkflowTool,
  localToolFamily,
  type LocalToolAdapter,
  type LocalToolResult,
  type LocalToolRun,
  type LocalWorkflowTool,
} from './local-tool-adapter.js';
import { driverLockPath, isRunId } from './store.js';
import { stopProcess } from './process-stop.js';
import { chooseStepModel } from './step-model.js';
import type { DriverIdentity, StepHitl, WorkflowEnvelope, WorkflowFailure } from './types.js';
import { isWorkflowError } from './types.js';

/** Local lease identity, stable across restarts in the same workspace. */
export function localDriver(cwd: string): DriverIdentity {
  let machine = 'unknown';
  try {
    machine = os.hostname();
  } catch {
    machine = 'unknown';
  }
  return { kind: 'local', machine, workspace: path.resolve(cwd) };
}

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

/**
 * Starts a leased command. The lease `env` is set over the inherited environment, so values reach the shell only as
 * variables. A detached command leads a process group of its own, so `stop` reaches everything it started; it has no
 * controlling terminal, and a terminal's Ctrl-C does not reach it.
 */
function startCommand(command: string, cwd: string, env: Record<string, string>, detached: boolean): CommandProcess {
  const child = spawn(command, { cwd, shell: true, env: { ...process.env, ...env }, windowsHide: true, detached });
  const exit = new Promise<CommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ exitCode: 1, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
  return { exit, stop: stopProcess(child, exit, detached) };
}

function jsonStdout(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
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
  toolPaths?: TeamaiConfig['toolPaths'];
  adapter?: LocalToolAdapter;
}

interface Lease {
  /** The step path, such as `check.classify` inside a sub-workflow. */
  step: string;
  attempt: string;
  revision: number;
  command?: string;
  env?: Record<string, string>;
  prompt?: string;
  agent?: string;
  model?: string;
  defaultModel?: string;
  /** Whether this lease gives the foreground terminal to its tool. */
  interactive?: true;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === 'string') ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

function resultPath(config: LocalConfig, runId: string, attempt: string): string {
  return path.join(getDataHome(config), 'workflows', 'runs', runId, 'attempts', attempt, 'result.json');
}

function supportedTool(value: string): value is LocalWorkflowTool {
  return isLocalWorkflowTool(value);
}

function ignoredCodexSettings(agent: AgentSpec): string[] {
  const extras = Object.keys(agent.tool_extras?.codex ?? {});
  return agent.tools?.length ? ['tools', ...extras] : extras;
}

function definitionRun(tool: LocalWorkflowTool, name: string, agent: AgentSpec): NonNullable<LocalToolRun['agent']> {
  const settings = localToolFamily(tool) === 'opencode' ? toolExtrasFor(agent, 'opencode') : undefined;
  return { name, instructions: agent.instructions, ...(agent.model ? { model: agent.model } : {}), ...(settings ? { settings } : {}) };
}

function reverseAgent(tool: LocalWorkflowTool, file: string, content: string) {
  const family = localToolFamily(tool);
  if (family === 'claude') return reverseFromClaude(file, content);
  if (family === 'codex') return reverseFromCodex(file, content);
  return reverseFromOpencode(file, content);
}

/** A deployed agent and the file it was read from, which is the key its pull recorded it under. */
async function loadAgent(
  tool: LocalWorkflowTool,
  name: string,
  config: LocalConfig,
  toolPaths: TeamaiConfig['toolPaths'] | undefined,
): Promise<{ spec: AgentSpec; file: string } | null> {
  const agents = toolPaths?.[tool]?.agents;
  if (!agents) return null;
  // The same directory `teamai pull` writes: the tool base for this scope, not the step's cwd.
  const file = path.join(resolveToolBaseDir(tool, config), agents, `${name}${agentFileExtensionForTool(tool as ToolName)}`);
  const content = await readFileSafe(file);
  if (content === null) return null;
  const reversed = reverseAgent(tool, file, content);
  return reversed.ok ? { spec: reversed.spec, file } : null;
}

interface WorktreeSnapshot {
  ok: boolean;
  files: Map<string, string>;
}

function gitStatus(workspace: string): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workspace, env: process.env }, (error, stdout, stderr) => {
      resolve(error ? { ok: false, text: stderr.trim() } : { ok: true, text: stdout });
    });
  });
}

function porcelainPath(line: string): string {
  const body = line.length > 3 ? line.slice(3) : line;
  const renamed = body.split(' -> ').at(-1) ?? body;
  return renamed.trim().replaceAll(/^"|"$/g, '');
}

async function hashPath(workspace: string, relative: string): Promise<string> {
  try {
    const content = await fs.readFile(path.resolve(workspace, relative));
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return 'missing';
  }
}

async function snapshotWorktree(workspace: string): Promise<WorktreeSnapshot> {
  const status = await gitStatus(workspace);
  if (!status.ok) return { ok: false, files: new Map() };
  const files = new Map<string, string>();
  for (const line of status.text.split('\n')) {
    if (!line.trim()) continue;
    const relative = porcelainPath(line.replace(/\r$/, ''));
    if (!relative || files.has(relative)) continue;
    files.set(relative, await hashPath(workspace, relative));
  }
  return { ok: true, files };
}

function changedPaths(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
  if (!after.ok) return [];
  if (!before.ok) return after.files.size === 0 ? [] : [...after.files.keys()];
  const names = new Set([...before.files.keys(), ...after.files.keys()]);
  return [...names].filter((name) => before.files.get(name) !== after.files.get(name));
}

function failureReport(failure: WorkflowFailure): { outcome: 'failed'; message: string; failure: WorkflowFailure } {
  return { outcome: 'failed', message: failure.message, failure };
}

type ReportBody = Parameters<typeof reportAttempt>[2];

function parseLease(raw: unknown): Lease | undefined {
  const rawLease = raw as Record<string, unknown> | undefined;
  if (!rawLease || typeof rawLease.step !== 'string' || typeof rawLease.attempt !== 'string' || typeof rawLease.revision !== 'number') return undefined;
  const env = stringMap(rawLease.env);
  const lease: Lease = {
    step: rawLease.step,
    attempt: rawLease.attempt,
    revision: rawLease.revision,
    ...(typeof rawLease.command === 'string' ? { command: rawLease.command } : {}),
    ...(env ? { env } : {}),
    ...(typeof rawLease.prompt === 'string' ? { prompt: rawLease.prompt } : {}),
    ...(typeof rawLease.agent === 'string' ? { agent: rawLease.agent } : {}),
    ...(typeof rawLease.model === 'string' ? { model: rawLease.model } : {}),
    ...(rawLease.interactive === true ? { interactive: true } : {}),
    ...(typeof rawLease.defaultModel === 'string' ? { defaultModel: rawLease.defaultModel } : {}),
  };
  return (lease.command === undefined) === (lease.prompt === undefined) ? undefined : lease;
}

async function commandReport(attemptResultPath: string, driver: DriverIdentity, lease: Lease, result: CommandResult): Promise<ReportBody> {
  const output = jsonStdout(result.stdout);
  await fs.mkdir(path.dirname(attemptResultPath), { recursive: true });
  await writeJsonAtomic(attemptResultPath, output !== undefined ? { output } : {});
  const snippet = result.stderr.trim().slice(0, 400);
  return {
    attempt: lease.attempt,
    revision: lease.revision,
    outcome: result.exitCode === 0 ? 'success' : 'failed',
    driver,
    ...(output !== undefined ? { outputs: output } : {}),
    exitCode: result.exitCode,
    ...(result.exitCode !== 0
      ? { message: snippet === '' ? `command exited with status ${result.exitCode}` : `command exited with status ${result.exitCode}: ${snippet}` }
      : {}),
  };
}

async function promptReport(
  config: LocalConfig,
  attemptResultPath: string,
  driver: DriverIdentity,
  lease: Lease,
  tools: Record<string, string>,
  adapter: LocalToolAdapter,
  options: LocalDriverOptions,
  signal: AbortSignal,
): Promise<ReportBody> {
  const selected = lease.agent && tools[lease.agent] ? tools[lease.agent] : tools.default;
  if (!selected) {
    const failure = { code: 'tool_unconfigured', message: 'No local workflow tool is configured for this prompt step' };
    return { attempt: lease.attempt, revision: lease.revision, driver, ...failureReport(failure) };
  }
  if (!supportedTool(selected)) {
    const failure = { code: 'tool_unsupported', message: `The local workflow tool "${selected}" is not supported` };
    return { attempt: lease.attempt, revision: lease.revision, driver, tool: selected, ...failureReport(failure) };
  }
  const loaded = lease.agent ? await loadAgent(selected, lease.agent, config, options.toolPaths) : undefined;
  const agent = loaded?.spec;
  if (lease.agent && !agent) {
    const failure = {
      code: 'agent_unavailable',
      message: `Agent "${lease.agent}" is not available for ${selected}. Run teamai pull and try again.`,
    };
    return { attempt: lease.attempt, revision: lease.revision, driver, tool: selected, ...failureReport(failure) };
  }
  const chosen = await chooseStepModel({
    step: lease.step, tool: selected, model: lease.model, defaultModel: lease.defaultModel, agent: agent ?? undefined, config,
  });
  if (!chosen.ok) return { attempt: lease.attempt, revision: lease.revision, driver, tool: selected, ...failureReport(chosen.failure) };
  if (agent && localToolFamily(selected) === 'codex') {
    const ignored = ignoredCodexSettings(agent);
    if (ignored.length > 0) {
      log.warn(`Agent "${agent.name}" on ${selected} does not apply ${ignored.join(', ')} from the deployed agent file. codex exec still has a shell. The step is not blocked.`);
    }
  }
  const definitionModel = chosen.model && chosen.by === 'definition'
    ? { model: chosen.model.name, ...(chosen.model.effort ? { effort: chosen.model.effort } : {}) }
    : {};
  const [observed, launch] = await Promise.all([
    observeLaunch({
      config,
      tool: selected,
      cwd: driver.workspace,
      ...(lease.agent && loaded ? { definition: { stem: lease.agent, file: loaded.file, ...definitionModel } } : {}),
      ...(chosen.model && chosen.by !== 'definition'
        ? { chosen: { model: chosen.model.name, ...(chosen.model.effort ? { effort: chosen.model.effort } : {}), ...(chosen.alias ? { alias: chosen.alias } : {}) } }
        : {}),
    }),
    workflowLaunch(config, selected),
  ]);
  const before = !lease.interactive ? await snapshotWorktree(driver.workspace) : undefined;
  let result: LocalToolResult;
  try {
    if (lease.interactive) log.info(`Step "${lease.step}" opens ${selected} here for interactive work.`);
    const run = lease.interactive ? adapter.runInteractive.bind(adapter) : adapter.run.bind(adapter);
    result = await run(selected, {
      prompt: lease.prompt!,
      cwd: driver.workspace,
      resultPath: attemptResultPath,
      ...(launch ? { launch } : {}),
      ...(agent ? { agent: definitionRun(selected, lease.agent!, agent) } : {}),
      ...(chosen.model ? { model: chosen.model } : {}),
    }, signal);
  } catch {
    result = {
      started: false,
      exitCode: 1,
      failure: { code: 'tool_failed', message: `${selected} could not complete the workflow step` },
    };
  }
  const paths = before ? changedPaths(before, await snapshotWorktree(driver.workspace)) : [];
  const dirtyFailure = paths.length > 0
    ? { code: 'read_only_dirty', message: `Read-only prompt step changed repository paths: ${paths.join(', ')}` }
    : undefined;
  const failure = dirtyFailure ?? result.failure;
  const ran = result.started ? result : undefined;
  return {
    attempt: lease.attempt,
    revision: lease.revision,
    driver,
    tool: selected,
    ...(ran?.model ? { model: ran.model } : {}),
    ...(ran?.session ? { session: ran.session } : {}),
    ...(ran?.tokens ? { tokens: ran.tokens } : {}),
    ...(ran?.output !== undefined ? { outputs: ran.output } : {}),
    // How the definition was handed over is known only once the launch resolved its tool: OpenCode's depends on its major.
    ...(ran ? { agent: ran.applied ? { ...observed, definition: { applied: ran.applied } } : observed } : {}),
    exitCode: result.exitCode,
    ...(failure ? failureReport(failure) : { outcome: result.exitCode === 0 ? 'success' : 'failed' }),
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
  if (!isRunId(runId)) return { error: { code: 'invalid_run', message: 'Run id must look like r followed by 8 or 16 hex digits' } };
  const lock = driverLockPath(config, runId);
  if (!await acquireLock(lock)) {
    const owner = await readJson(lock);
    return { error: { code: 'driver_running', message: isRecord(owner) && typeof owner.pid === 'number'
      ? `Run ${runId} is already driven by process ${owner.pid} on this machine. Stop that driver, or wait for it.`
      : `Run ${runId} has a local driver lock whose process id is unknown. Stop that driver, or inspect its driver.lock file.` } };
  }
  try {
    return await driveRun(config, runId, cwd, options);
  } finally {
    await releaseLock(lock);
  }
}

async function driveRun(config: LocalConfig, runId: string, cwd: string, options: LocalDriverOptions): Promise<WorkflowEnvelope> {
  const canHitl = options.hitl ?? (process.stdin.isTTY === true && process.stderr.isTTY === true);
  const driver = localDriver(cwd);
  const tools = { ...config.workflows?.tools, ...options.tools };
  const adapter = options.adapter ?? createLocalToolAdapter();
  const maxParallel = config.workflows?.max_parallel ?? 1;
  // One command at a time keeps the terminal: Ctrl-C reaches it, and it can prompt on /dev/tty. Parallel commands get
  // process groups of their own, which `stop` and the signal handlers below can end as a whole.
  const detached = maxParallel > 1 && process.platform !== 'win32';
  const reported = new Set<string>();
  const inFlight = new Map<string, { lease: Lease; command: CommandProcess }>();
  // Leases not started yet, in lease order. A prompt starts only when no command runs, because its read-only check
  // compares the whole worktree before and after it.
  const held: Lease[] = [];
  // Cancelled commands whose process group is not gone yet. They are not sent as running, so `next` does not cancel
  // them again. They still take a slot, and a new attempt of their step waits until they are gone, so a retried step
  // never runs beside its cancelled attempt.
  const dying = new Map<string, { step: string; command: CommandProcess }>();
  let prompt: { lease: Lease; controller: AbortController; exit: Promise<ReportBody> } | undefined;
  let question: { hitl: LocalHitl; controller: AbortController; exit: Promise<{ kind: 'question'; line?: string }> } | undefined;
  const room = (): boolean => !prompt && inFlight.size + dying.size + held.length < maxParallel && !held.some((lease) => lease.prompt !== undefined);
  const cancel = (attempt: string): void => {
    if (prompt?.lease.attempt === attempt) prompt.controller.abort();
    const index = held.findIndex((lease) => lease.attempt === attempt);
    if (index !== -1) held.splice(index, 1);
    const running = inFlight.get(attempt);
    if (!running) return;
    inFlight.delete(attempt);
    dying.set(attempt, { step: running.lease.step, command: running.command });
    void running.command.stop();
  };
  let interactiveIgnores: readonly NodeJS.Signals[] = [];
  let signalled: NodeJS.Signals | undefined;
  let wake = (): void => {};
  const exitOn = (signal: NodeJS.Signals): void => {
    for (const name of STOP_SIGNALS) process.off(name, onSignal);
    exitLike({ kind: 'signaled', signal });
  };
  // Parallel commands and detached prompt tools do not get the terminal's Ctrl-C, so the driver stops them before it
  // exits the way the signal would. An interactive tool that the terminal's signals reach handles them itself. With
  // nothing running, the signal ends teamai at once, as it would without a handler.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (prompt?.lease.interactive && interactiveIgnores.includes(signal)) return;
    if (inFlight.size === 0 && dying.size === 0 && !prompt) return exitOn(signal);
    signalled ??= signal;
    prompt?.controller.abort(signal);
    wake();
  };
  if (maxParallel > 1) for (const name of STOP_SIGNALS) process.on(name, onSignal);
  const report = async (body: ReportBody): Promise<WorkflowEnvelope | undefined> => {
    const answer = await reportAttempt(config, runId, body);
    // Cancelled while it ran: the next `next` lists it in `cancelled`, and the run goes on without it.
    if (isWorkflowError(answer)) return answer.error.code === 'lease_cancelled' ? undefined : answer;
    reported.add(body.attempt);
    return undefined;
  };
  try {
    for (;;) {
      if (signalled) return { error: { code: 'interrupted', message: `Stopped by ${signalled} after every command it started exited` } };
      const running = [...inFlight.keys(), ...held.map((lease) => lease.attempt), ...(prompt ? [prompt.lease.attempt] : [])];
      const canTakeLease = room();
      const next = await leaseNext(config, runId, driver, { running, canTakeLease, hitl: canHitl, autoApprove: options.autoApprove });
      if (signalled) continue;
      if (isWorkflowError(next)) return next;
      for (const attempt of Array.isArray(next.data.cancelled) ? next.data.cancelled as string[] : []) cancel(attempt);
      if ('done' in next.data) {
        question?.controller.abort();
        if (prompt) {
          prompt.controller.abort();
          const failed = await report(await prompt.exit);
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
      for (let index = 0; held[index]?.command !== undefined && inFlight.size + dying.size < maxParallel;) {
        const lease = held[index]!;
        if ([...dying.values()].some((stopping) => stopping.step === lease.step)) {
          index += 1;
          continue;
        }
        held.splice(index, 1);
        inFlight.set(lease.attempt, { lease, command: startCommand(lease.command!, driver.workspace, lease.env ?? {}, detached) });
      }
      if (!prompt && held[0]?.prompt !== undefined && inFlight.size === 0 && dying.size === 0) {
        const lease = held.shift()!;
        if (lease.interactive && !canHitl) {
          const failed = await report({ attempt: lease.attempt, revision: lease.revision, driver,
            ...failureReport(interactiveHitlRequired(runId, lease.step)) });
          if (failed) return failed;
          continue;
        }
        if (lease.interactive) {
          if (question) {
            question.controller.abort();
            await question.exit;
            question = undefined;
          }
          interactiveIgnores = commandSignalPolicy(await terminalReachesCommand()).ignored;
        }
        const controller = new AbortController();
        if (maxParallel === 1) for (const name of STOP_SIGNALS) process.on(name, onSignal);
        prompt = { lease, controller, exit: promptReport(config, resultPath(config, runId, lease.attempt), driver, lease, tools, adapter, options, controller.signal) };
      }
      if (canHitl && hitl && !question && !prompt?.lease.interactive) {
        const controller = new AbortController();
        question = { hitl, controller, exit: (options.question ?? askHitl)(hitl, controller.signal)
          .then((line) => ({ kind: 'question' as const, line }), () => ({ kind: 'question' as const })) };
      }
      if ('lease' in next.data && room()) continue;
      if (inFlight.size === 0 && dying.size === 0 && !prompt && !question) {
        // A wait for a call that could not take a lease says nothing about what is left; ask again with room.
        if (!canTakeLease) continue;
        const reason = typeof (next.data.wait as { reason?: unknown }).reason === 'string'
          ? (next.data.wait as { reason: string }).reason
          : 'the next step is not available';
        return { error: { code: 'busy', message: reason } };
      }
      let timer: NodeJS.Timeout | undefined;
      const exited = await Promise.race([
        ...[...inFlight.values()].map(({ lease, command }) => command.exit.then((result) => ({ kind: 'command' as const, attempt: lease.attempt, lease, result }))),
        ...[...dying].map(([attempt, { command }]) => command.stop().then(() => ({ kind: 'stopped' as const, attempt }))),
        ...(prompt ? [prompt.exit.then((body) => ({ kind: 'prompt' as const, body }))] : []),
        ...(question ? [question.exit] : []),
        new Promise<undefined>((resolve) => {
          wake = () => resolve(undefined);
          timer = setTimeout(wake, question ? 1000 : 2000);
        }),
      ]);
      clearTimeout(timer);
      if (!exited) continue;
      if (exited.kind === 'question') {
        const hitl = question!.hitl;
        question = undefined;
        if (exited.line === undefined) return { error: { code: 'interrupted', message: 'The HITL question closed without an answer. Continue with teamai workflow resume.' } };
        const [choice = '', ...words] = exited.line.trim().split(/\s+/);
        const answer = await respondToHitl(config, runId, { step: hitl.step, pass: hitl.pass, choice, ...(words.length > 0 ? { note: words.join(' ') } : {}), channel: 'tty', agent: false });
        if (isWorkflowError(answer)) {
          if (!['repeated_response', 'stale_response', 'invalid_choice', 'not_waiting', 'run_settled'].includes(answer.error.code)) return answer;
          log.warn(answer.error.message);
        }
        continue;
      }
      if (exited.kind === 'prompt') {
        prompt = undefined;
        if (maxParallel === 1) for (const name of STOP_SIGNALS) process.off(name, onSignal);
        const failed = await report(exited.body);
        if (failed) return failed;
        continue;
      }
      if (exited.kind === 'stopped') {
        dying.delete(exited.attempt);
        continue;
      }
      inFlight.delete(exited.attempt);
      const failed = await report(await commandReport(resultPath(config, runId, exited.attempt), driver, exited.lease, exited.result));
      if (failed) return failed;
    }
  } finally {
    question?.controller.abort();
    prompt?.controller.abort(signalled);
    if (prompt) await prompt.exit;
    for (const attempt of inFlight.keys()) cancel(attempt);
    await Promise.all([...dying.values()].map(({ command }) => command.stop()));
    if (signalled) exitOn(signalled);
    for (const name of STOP_SIGNALS) process.off(name, onSignal);
  }
}
