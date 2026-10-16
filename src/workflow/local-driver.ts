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
import { exitLike } from '../env-exec.js';
import { getDataHome, resolveToolBaseDir, type LocalConfig, type TeamaiConfig } from '../types.js';
import { readFileSafe, writeJsonAtomic } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { AgentSession } from '../session-flow/agent-session.js';
import { leaseNext, reportAttempt } from './engine.js';
import { isRecord } from './expression.js';
import { createLocalToolAdapter, isLocalWorkflowTool, localToolFamily, type LocalToolAdapter, type LocalWorkflowTool } from './local-tool-adapter.js';
import type { DriverIdentity, WorkflowEnvelope, WorkflowFailure } from './types.js';
import { isWorkflowError } from './types.js';
import type { WorkspaceContract } from './workspace.js';
import {
  applyBaseConfig, commitWork, ensureWorktree, headCommit, hooksPath, mergeBranch, pushIfOrigin, removeWorktree, restoreUneditedConfig, worktreePath,
} from './worktree.js';

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
  step?: string;
  attempt: string;
  revision: number;
  command?: string;
  env?: Record<string, string>;
  prompt?: string;
  agent?: string;
  workspace?: WorkspaceContract;
  session?: { tool: string; id: string };
  /** Set once the step has a directory to run in. */
  cwd?: string;
  before?: WorktreeSnapshot;
  /** Branch agent files saved while the base overlay is in place. */
  overlay?: string;
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

async function loadAgent(
  tool: LocalWorkflowTool,
  name: string,
  config: LocalConfig,
  toolPaths: TeamaiConfig['toolPaths'] | undefined,
): Promise<AgentSpec | null> {
  const agents = toolPaths?.[tool]?.agents;
  if (!agents) return null;
  // The same directory `teamai pull` writes: the tool base for this scope, not the step's cwd.
  const file = path.join(resolveToolBaseDir(tool, config), agents, `${name}${agentFileExtensionForTool(tool as ToolName)}`);
  const content = await readFileSafe(file);
  if (content === null) return null;
  const reversed = reverseAgent(tool, file, content);
  return reversed.ok ? reversed.spec : null;
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

function workspaceOf(value: unknown): WorkspaceContract | undefined {
  if (!isRecord(value) || (value.mode !== 'new' && value.mode !== 'continue') || typeof value.branch !== 'string') return undefined;
  const base = isRecord(value.base) && typeof value.base.commit === 'string' && typeof value.base.ref === 'string'
    ? { ref: value.base.ref, commit: value.base.commit } : undefined;
  const start = isRecord(value.start) && typeof value.start.commit === 'string'
    ? { commit: value.start.commit, ...(typeof value.start.branch === 'string' ? { branch: value.start.branch } : {}) } : undefined;
  if (!base || !start || typeof value.configCommit !== 'string' || !Array.isArray(value.merge)) return undefined;
  const merge = value.merge.flatMap((item) => (
    isRecord(item) && typeof item.branch === 'string' && typeof item.commit === 'string' ? [{ branch: item.branch, commit: item.commit }] : []
  ));
  return { mode: value.mode, base, configCommit: value.configCommit, branch: value.branch, start, merge };
}

function parseLease(raw: unknown): Lease | undefined {
  const rawLease = raw as Record<string, unknown> | undefined;
  if (!rawLease || typeof rawLease.attempt !== 'string' || typeof rawLease.revision !== 'number') return undefined;
  const env = stringMap(rawLease.env);
  const session = isRecord(rawLease.session) && typeof rawLease.session.tool === 'string' && typeof rawLease.session.id === 'string'
    ? { tool: rawLease.session.tool, id: rawLease.session.id } : undefined;
  const lease: Lease = {
    ...(typeof rawLease.step === 'string' ? { step: rawLease.step } : {}),
    attempt: rawLease.attempt,
    revision: rawLease.revision,
    ...(typeof rawLease.command === 'string' ? { command: rawLease.command } : {}),
    ...(env ? { env } : {}),
    ...(typeof rawLease.prompt === 'string' ? { prompt: rawLease.prompt } : {}),
    ...(typeof rawLease.agent === 'string' ? { agent: rawLease.agent } : {}),
    ...(workspaceOf(rawLease.workspace) ? { workspace: workspaceOf(rawLease.workspace) } : {}),
    ...(session ? { session } : {}),
  };
  return (lease.command === undefined) === (lease.prompt === undefined) ? undefined : lease;
}

/** The checkout this lease uses. Read-only steps share the active checkout; a workspace has its own worktree. */
function placeOf(lease: Lease, active: string): string {
  return lease.cwd ?? (lease.workspace ? worktreePath(active, lease.workspace.branch) : active);
}

async function stageLease(active: string, lease: Lease): Promise<WorkflowFailure | undefined> {
  if (!lease.workspace) {
    lease.cwd = active;
    lease.before = await snapshotWorktree(active);
    return undefined;
  }
  const opened = await ensureWorktree(active, lease.workspace.branch, lease.workspace.start.commit);
  if ('error' in opened) return { code: 'workspace_base', message: opened.error };
  lease.cwd = opened.dir;
  let conflict: { branch: string; files: string[] } | undefined;
  const remaining: string[] = [];
  for (const merge of lease.workspace.merge) {
    if (conflict) {
      remaining.push(merge.branch);
      continue;
    }
    const result = await mergeBranch(opened.dir, merge.branch);
    if (result.conflict) conflict = { branch: merge.branch, files: result.files };
  }
  if (conflict && lease.command !== undefined) {
    const files = conflict.files.join(', ');
    return { code: 'merge_conflict', message: `Merge conflict with ${conflict.branch}${files ? `: ${files}` : ''}` };
  }
  if (conflict && lease.prompt !== undefined) {
    const files = conflict.files.join(', ') || 'unmerged files';
    const left = remaining.length > 0 ? ` Remaining branches: ${remaining.join(', ')}.` : '';
    lease.prompt = `${lease.prompt}\n\nMerge conflict with ${conflict.branch} (${files}).${left} Resolve the conflict in the workspace.`;
  }
  const applied = await applyBaseConfig(opened.dir, lease.workspace.configCommit, hooksPath(active));
  if (!applied.ok) return { code: 'base_config', message: applied.message };
  lease.overlay = applied.saved;
  return undefined;
}

async function resumeSession(lease: Lease, tool: LocalWorkflowTool, cwd: string): Promise<string | undefined> {
  const session = lease.session;
  if (!session || !supportedTool(session.tool)) return undefined;
  if (localToolFamily(session.tool) === localToolFamily(tool) && localToolFamily(tool) !== 'opencode') {
    const platform = AgentSession.platformForTool(session.tool);
    if (!platform) return undefined;
    const found = await AgentSession.find({ platform, sessionId: session.id }, { scrub: false });
    return found.status === 'done' ? session.id : undefined;
  }
  const from = AgentSession.platformForTool(session.tool);
  const to = AgentSession.platformForTool(tool);
  if (!from || !to) return undefined;
  const copied = await AgentSession.copy({ from: { platform: from, sessionId: session.id }, to: { platform: to, cwd } });
  if (copied.status !== 'done' || localToolFamily(tool) === 'opencode') return undefined;
  return copied.sessionId;
}

async function finishWorkspace(lease: Lease, push: boolean): Promise<{ changes?: { branch: string; base: string; from: string; to: string; commits: string[] }; failure?: WorkflowFailure }> {
  if (!lease.workspace || !lease.cwd) return {};
  if (lease.overlay) await restoreUneditedConfig(lease.cwd, lease.workspace.configCommit, lease.overlay);
  const committed = await commitWork(lease.cwd, `teamai: ${lease.step ?? lease.attempt}`);
  if ('error' in committed) return { failure: { code: 'push_failed', message: committed.error } };
  const pushed = push ? await pushIfOrigin(lease.cwd, lease.workspace.branch, committed.commits) : 'unchanged';
  const changes = {
    branch: lease.workspace.branch,
    base: lease.workspace.base.commit,
    from: committed.from,
    to: committed.to,
    commits: committed.commits,
  };
  return typeof pushed === 'object' ? { changes, failure: { code: 'push_failed', message: pushed.error } } : { changes };
}

async function commandReport(attemptResultPath: string, driver: DriverIdentity, lease: Lease, result: CommandResult): Promise<ReportBody> {
  const output = jsonStdout(result.stdout);
  await fs.mkdir(path.dirname(attemptResultPath), { recursive: true });
  await writeJsonAtomic(attemptResultPath, output !== undefined ? { output } : {});
  const snippet = result.stderr.trim().slice(0, 400);
  if (result.exitCode === 0 && !lease.workspace && lease.before && lease.cwd) {
    const paths = changedPaths(lease.before, await snapshotWorktree(lease.cwd));
    if (paths.length > 0) {
      const failure = { code: 'read_only_dirty', message: `Read-only command step changed repository paths: ${paths.join(', ')}` };
      return { attempt: lease.attempt, revision: lease.revision, driver, exitCode: 0, ...failureReport(failure) };
    }
  }
  const finished = lease.workspace ? await finishWorkspace(lease, result.exitCode === 0) : {};
  const failed = result.exitCode !== 0 || finished.failure;
  const message = finished.failure?.message
    ?? (result.exitCode !== 0 ? (snippet === '' ? `command exited with status ${result.exitCode}` : `command exited with status ${result.exitCode}: ${snippet}`) : undefined);
  return {
    attempt: lease.attempt,
    revision: lease.revision,
    outcome: failed ? 'failed' : 'success',
    driver,
    ...(output !== undefined ? { outputs: output } : {}),
    exitCode: result.exitCode,
    ...(message ? { message } : {}),
    ...(finished.failure ? { failure: finished.failure } : {}),
    ...(finished.changes ? { changes: finished.changes } : {}),
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
  const agent = lease.agent ? await loadAgent(selected, lease.agent, config, options.toolPaths) : undefined;
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
  const cwd = lease.cwd ?? driver.workspace;
  const before = lease.before ?? await snapshotWorktree(cwd);
  const resume = await resumeSession(lease, selected, cwd);
  let result;
  try {
    result = await adapter.run(selected, {
      prompt: lease.prompt!,
      cwd,
      resultPath: attemptResultPath,
      ...(resume ? { resume } : {}),
      ...(agent ? { agent: { name: lease.agent!, instructions: agent.instructions, ...(agent.model ? { model: agent.model } : {}) } } : {}),
    });
  } catch {
    result = {
      exitCode: 1,
      failure: { code: 'tool_failed', message: `${selected} could not complete the workflow step` },
    };
  }
  const after = await snapshotWorktree(cwd);
  const paths = lease.workspace ? [] : changedPaths(before, after);
  const dirtyFailure = paths.length > 0
    ? { code: 'read_only_dirty', message: `Read-only prompt step changed repository paths: ${paths.join(', ')}` }
    : undefined;
  const finished = lease.workspace && !dirtyFailure ? await finishWorkspace(lease, result.exitCode === 0 && !result.failure) : {};
  const failure = dirtyFailure ?? finished.failure ?? result.failure;
  return {
    attempt: lease.attempt,
    revision: lease.revision,
    driver,
    tool: selected,
    ...(result.model ?? agent?.model ? { model: result.model ?? agent?.model } : {}),
    ...(result.session ? { session: result.session } : {}),
    ...(result.tokens ? { tokens: result.tokens } : {}),
    ...(result.output !== undefined ? { outputs: result.output } : {}),
    exitCode: result.exitCode,
    ...(finished.changes ? { changes: finished.changes } : {}),
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
  // Leases not started yet, in lease order. Steps that share a checkout run one at a time. Distinct worktrees overlap.
  const held: Lease[] = [];
  // Cancelled commands whose process group is not gone yet. They are not sent as running, so `next` does not cancel
  // them again.
  const dying = new Map<string, CommandProcess>();
  const base = await headCommit(cwd);
  const room = (): boolean => inFlight.size + held.length < maxParallel;
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
  const report = async (body: ReportBody, lease?: Lease): Promise<WorkflowEnvelope | undefined> => {
    const answer = await reportAttempt(config, runId, body);
    // Cancelled while it ran: the next `next` lists it in `cancelled`, and the run goes on without it.
    if (isWorkflowError(answer)) return answer.error.code === 'lease_cancelled' ? undefined : answer;
    if (lease?.workspace && 'data' in answer && answer.data.cleanup === true) {
      await removeWorktree(cwd, worktreePath(cwd, lease.workspace.branch));
    }
    reported.add(body.attempt);
    return undefined;
  };
  const failStaged = async (lease: Lease, failure: WorkflowFailure): Promise<WorkflowEnvelope | undefined> => report({
    attempt: lease.attempt, revision: lease.revision, outcome: 'failed', driver, message: failure.message, failure,
  }, lease);
  try {
    for (;;) {
      if (signalled) return { error: { code: 'interrupted', message: `Stopped by ${signalled} after every command it started exited` } };
      const running = [...inFlight.keys(), ...held.map((lease) => lease.attempt)];
      const canTakeLease = room();
      const next = await leaseNext(config, runId, driver, {
        running, canTakeLease, ...(base ? { base } : {}), workspaceModes: ['read-only', 'new', 'continue'],
      });
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
      while (inFlight.size < maxParallel) {
        const busy = new Set([...inFlight.values()].map(({ lease }) => placeOf(lease, cwd)));
        const index = held.findIndex((lease, at) => lease.command !== undefined && !busy.has(placeOf(lease, cwd))
          && !held.slice(0, at).some((earlier) => earlier.prompt !== undefined && placeOf(earlier, cwd) === placeOf(lease, cwd)));
        if (index === -1) break;
        const lease = held.splice(index, 1)[0]!;
        const failure = await stageLease(cwd, lease);
        if (failure) {
          const failed = await failStaged(lease, failure);
          if (failed) return failed;
          continue;
        }
        inFlight.set(lease.attempt, { lease, command: startCommand(lease.command!, lease.cwd ?? cwd, lease.env ?? {}, detached) });
      }
      const busy = new Set([...inFlight.values()].map(({ lease }) => placeOf(lease, cwd)));
      const promptAt = dying.size === 0 ? held.findIndex((lease) => lease.prompt !== undefined && !busy.has(placeOf(lease, cwd))) : -1;
      if (promptAt !== -1 && inFlight.size < maxParallel) {
        const lease = held.splice(promptAt, 1)[0]!;
        const failure = await stageLease(cwd, lease);
        if (failure) {
          const failed = await failStaged(lease, failure);
          if (failed) return failed;
          continue;
        }
        const failed = await report(await promptReport(config, resultPath(config, runId, lease.attempt), driver, lease, tools, adapter, options), lease);
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
      const failed = await report(await commandReport(resultPath(config, runId, exited.attempt), driver, exited.lease, exited.result), exited.lease);
      if (failed) return failed;
    }
  } finally {
    for (const attempt of inFlight.keys()) cancel(attempt);
    await Promise.all([...dying.values()].map((command) => command.stop()));
    if (signalled) exitOn(signalled);
    for (const name of STOP_SIGNALS) process.off(name, onSignal);
  }
}
