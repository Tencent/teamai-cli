import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  agentFileExtensionForTool,
  reverseFromClaude,
  reverseFromCodex,
  reverseFromOpencode,
  type AgentSpec,
  type ToolName,
} from '../resources/agent-format.js';
import { observeLaunch } from '../agent-observation.js';
import { exitLike } from '../env-exec.js';
import { workflowLaunch } from '../launch-context.js';
import { getDataHome, resolveToolBaseDir, type LocalConfig, type TeamaiConfig } from '../types.js';
import { readFileSafe, writeJsonAtomic } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { leaseNext, reportAttempt } from './engine.js';
import { isRecord } from './expression.js';
import { createLocalToolAdapter, definitionHandoff, isLocalWorkflowTool, localToolFamily, type LocalToolAdapter, type LocalToolResult, type LocalWorkflowTool } from './local-tool-adapter.js';
import type { DriverIdentity, WorkflowEnvelope, WorkflowFailure } from './types.js';
import { isWorkflowError } from './types.js';

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

const STOP_GRACE_MS = 5000;

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
  /** Whether the signal reached a process: the command, or for a detached command any process left in its group. */
  const signal = (name: NodeJS.Signals | 0): boolean => {
    if (!detached || child.pid === undefined) return name === 0 ? false : child.kill(name);
    try {
      process.kill(-child.pid, name);
      return true;
    } catch {
      // The whole group has already exited.
      return false;
    }
  };
  let stopping: Promise<CommandResult> | undefined;
  const stop = async (): Promise<CommandResult> => {
    if (process.platform === 'win32' && child.pid !== undefined) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      return exit;
    }
    signal('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    const killed = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        signal('SIGKILL');
        resolve();
      }, STOP_GRACE_MS);
    });
    const result = await exit;
    // The shell closing its output does not mean the group is gone: a process it started with its own output can
    // ignore SIGTERM and outlive it. Keep the SIGKILL for as long as any process in the group is left.
    if (signal(0)) await killed;
    else clearTimeout(timer);
    return result;
  };
  return { exit, stop: () => (stopping ??= stop()) };
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

export interface LocalDriverOptions {
  tools?: Record<string, string>;
  toolPaths?: TeamaiConfig['toolPaths'];
  adapter?: LocalToolAdapter;
}

interface Lease {
  attempt: string;
  revision: number;
  command?: string;
  env?: Record<string, string>;
  prompt?: string;
  agent?: string;
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
  if (!rawLease || typeof rawLease.attempt !== 'string' || typeof rawLease.revision !== 'number') return undefined;
  const env = stringMap(rawLease.env);
  const lease: Lease = {
    attempt: rawLease.attempt,
    revision: rawLease.revision,
    ...(typeof rawLease.command === 'string' ? { command: rawLease.command } : {}),
    ...(env ? { env } : {}),
    ...(typeof rawLease.prompt === 'string' ? { prompt: rawLease.prompt } : {}),
    ...(typeof rawLease.agent === 'string' ? { agent: rawLease.agent } : {}),
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
  if (agent && localToolFamily(selected) === 'codex') {
    const ignored = ignoredCodexSettings(agent);
    if (ignored.length > 0) {
      log.warn(`Agent "${agent.name}" on ${selected} does not apply ${ignored.join(', ')} from the deployed agent file. codex exec still has a shell. The step is not blocked.`);
    }
  }
  const [observed, launch] = await Promise.all([
    observeLaunch({
      config,
      tool: selected,
      cwd: driver.workspace,
      ...(lease.agent && loaded ? { definition: { stem: lease.agent, file: loaded.file, ...definitionHandoff(selected, loaded.spec) } } : {}),
    }),
    workflowLaunch(config, selected),
  ]);
  const before = await snapshotWorktree(driver.workspace);
  let result: LocalToolResult;
  try {
    result = await adapter.run(selected, {
      prompt: lease.prompt!,
      cwd: driver.workspace,
      resultPath: attemptResultPath,
      ...(launch ? { launch } : {}),
      ...(agent ? { agent: { name: lease.agent!, instructions: agent.instructions, ...(agent.model ? { model: agent.model } : {}) } } : {}),
    });
  } catch {
    result = {
      started: false,
      exitCode: 1,
      failure: { code: 'tool_failed', message: `${selected} could not complete the workflow step` },
    };
  }
  const after = await snapshotWorktree(driver.workspace);
  const paths = changedPaths(before, after);
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
    ...(ran ? { agent: observed } : {}),
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
  // them again.
  const dying = new Map<string, CommandProcess>();
  const room = (): boolean => inFlight.size + held.length < maxParallel && !held.some((lease) => lease.prompt !== undefined);
  const cancel = (attempt: string): void => {
    const index = held.findIndex((lease) => lease.attempt === attempt);
    if (index !== -1) held.splice(index, 1);
    const running = inFlight.get(attempt);
    if (!running) return;
    inFlight.delete(attempt);
    dying.set(attempt, running.command);
    void running.command.stop();
  };
  let signalled: NodeJS.Signals | undefined;
  let wake = (): void => {};
  const exitOn = (signal: NodeJS.Signals): void => {
    for (const name of STOP_SIGNALS) process.off(name, onSignal);
    exitLike({ kind: 'signaled', signal });
  };
  // Parallel commands do not get the terminal's Ctrl-C, so the driver stops them all before it exits the way the
  // signal would. With none running, as during a prompt, the signal ends teamai at once, as it would without a handler.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (inFlight.size === 0 && dying.size === 0) return exitOn(signal);
    signalled ??= signal;
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
      const running = [...inFlight.keys(), ...held.map((lease) => lease.attempt)];
      const canTakeLease = room();
      const next = await leaseNext(config, runId, driver, { running, canTakeLease });
      if (signalled) continue;
      if (isWorkflowError(next)) return next;
      for (const attempt of Array.isArray(next.data.cancelled) ? next.data.cancelled as string[] : []) cancel(attempt);
      if ('done' in next.data) return next;
      if ('lease' in next.data) {
        const lease = parseLease(next.data.lease);
        if (!lease) return { error: { code: 'run_unreadable', message: `Run ${runId} returned a lease the local driver cannot run` } };
        if (reported.has(lease.attempt)) {
          return { error: { code: 'driver_stuck', message: `Attempt ${lease.attempt} was leased again before it could be reported` } };
        }
        held.push(lease);
      }
      while (held[0]?.command !== undefined && inFlight.size < maxParallel) {
        const lease = held.shift()!;
        inFlight.set(lease.attempt, { lease, command: startCommand(lease.command!, driver.workspace, lease.env ?? {}, detached) });
      }
      if (held[0]?.prompt !== undefined && inFlight.size === 0 && dying.size === 0) {
        const lease = held.shift()!;
        const failed = await report(await promptReport(config, resultPath(config, runId, lease.attempt), driver, lease, tools, adapter, options));
        if (failed) return failed;
        continue;
      }
      if ('lease' in next.data && room()) continue;
      if (inFlight.size === 0 && dying.size === 0) {
        // A wait for a call that could not take a lease says nothing about what is left; ask again with room.
        if (!canTakeLease) continue;
        const reason = typeof (next.data.wait as { reason?: unknown }).reason === 'string'
          ? (next.data.wait as { reason: string }).reason
          : 'the next step is not available';
        return { error: { code: 'busy', message: reason } };
      }
      const exited = await Promise.race([
        ...[...inFlight.values()].map(({ lease, command }) => command.exit.then((result) => ({ attempt: lease.attempt, lease, result }))),
        ...[...dying].map(([attempt, command]) => command.stop().then(() => ({ attempt }))),
        new Promise<undefined>((resolve) => { wake = () => resolve(undefined); }),
      ]);
      if (!exited) continue;
      if (!('lease' in exited)) {
        dying.delete(exited.attempt);
        continue;
      }
      inFlight.delete(exited.attempt);
      const failed = await report(await commandReport(resultPath(config, runId, exited.attempt), driver, exited.lease, exited.result));
      if (failed) return failed;
    }
  } finally {
    for (const attempt of inFlight.keys()) cancel(attempt);
    await Promise.all([...dying.values()].map((command) => command.stop()));
    if (signalled) exitOn(signalled);
    for (const name of STOP_SIGNALS) process.off(name, onSignal);
  }
}
