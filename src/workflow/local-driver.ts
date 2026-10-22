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
import { detectProjectConfig } from '../config.js';
import { acquireLock, releaseLock } from '../update.js';
import { commandSignalPolicy, exitLike, terminalReachesCommand } from '../env-exec.js';
import { workflowLaunch } from '../launch-context.js';
import { getDataHome, resolveToolBaseDir, type LocalConfig, type TeamaiConfig } from '../types.js';
import { readFileSafe, readJson, writeJsonAtomic } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { AgentSession } from '../session-flow/agent-session.js';
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
import type { StepRead } from './step-state.js';
import type { DriverIdentity, StepHitl, WorkflowEnvelope, WorkflowFailure } from './types.js';
import { isWorkflowError } from './types.js';
import type { WorkspaceContract } from './workspace.js';
import {
  applyBaseConfig, commitWork, ensureWorktree, git, headCommit, hooksPath, keptSentence, type KeptChanges, markReadCopy, mergeBranch, offBranch, pushIfOrigin, putBackCopy, recordConfigOverlay, removeWorktree, reopenConfigConflicts, restoreUneditedConfig, unrestoredCopy, worktreePath,
} from './worktree.js';

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
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
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
  workspace?: WorkspaceContract;
  /** The lease named a workspace this driver cannot read. The step fails instead of running in the active checkout. */
  unreadableWorkspace?: true;
  session?: { tool: string; id: string };
  /** Set once the step has a directory to run in. */
  cwd?: string;
  before?: WorktreeSnapshot;
  found?: string[];
  /** Branch agent files saved while the base overlay is in place. */
  overlay?: string;
  /** HEAD before this step merges or commits, so the reported range includes both. */
  rangeFrom?: string;
  /** Whether this lease gives the foreground terminal to its tool. */
  interactive?: true;
  /** The step set `workspace: read-only`. An interactive prompt is checked only then. */
  readOnly?: true;
  /** Unmerged file contents before the step ran. A file left unchanged is not a resolution. */
  conflicts?: Map<string, string>;
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
  head?: string;
  /** The ref HEAD points to, empty when it is detached, so a switch at the same commit is a change too. */
  branch: string;
}

function gitStatus(workspace: string): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none'], { cwd: workspace, env: process.env }, (error, stdout, stderr) => {
      resolve(error ? { ok: false, text: stderr.trim() } : { ok: true, text: stdout });
    });
  });
}

/** Porcelain records from `git status -z`. A rename's first path is the one in the worktree; the next field is the old path. */
function statusEntries(text: string): { mark: string; relative: string }[] {
  const parts = text.split('\0');
  const entries: { mark: string; relative: string }[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index] ?? '';
    if (item.length < 4) continue;
    const mark = item.slice(0, 2);
    if (mark.includes('R') || mark.includes('C')) index += 1;
    entries.push({ mark, relative: item.slice(3) });
  }
  return entries;
}

async function hashPath(workspace: string, relative: string): Promise<string> {
  const full = path.resolve(workspace, relative);
  try {
    const stats = await fs.lstat(full);
    const bytes = stats.isSymbolicLink() ? await fs.readlink(full) : await fs.readFile(full);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return 'missing';
  }
}

async function stagedEntry(workspace: string, relative: string): Promise<string> {
  const listed = await git(workspace, ['ls-files', '-s', '--', relative]);
  const entries = listed.stdout.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const [mode, blob, stage] = line.split(/\s+/);
    return `${mode}:${blob}:${stage}`;
  });
  return entries.join(',') || 'none';
}

async function worktreeMode(workspace: string, relative: string): Promise<string> {
  try {
    return String((await fs.lstat(path.resolve(workspace, relative))).mode);
  } catch {
    return 'missing';
  }
}

async function snapshotWorktree(workspace: string, depth = 0): Promise<WorktreeSnapshot> {
  const status = await gitStatus(workspace);
  const head = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = (await git(workspace, ['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim();
  if (!status.ok) return { ok: false, files: new Map(), ...(head ? { head } : {}), branch };
  const files = new Map<string, string>();
  for (const { mark, relative } of statusEntries(status.text)) {
    if (files.has(relative)) continue;
    const staged = await stagedEntry(workspace, relative);
    const mode = await worktreeMode(workspace, relative);
    const gitlink = staged.split(',').some((entry) => entry.startsWith('160000:'));
    const body = gitlink && depth < 3
      ? await submoduleSnapshot(path.resolve(workspace, relative), depth)
      : await hashPath(workspace, relative);
    files.set(relative, `${mark}:${staged}:${mode}:${body}`);
  }
  return { ok: true, files, ...(head ? { head } : {}), branch };
}

async function submoduleSnapshot(dir: string, depth: number): Promise<string> {
  const snap = await snapshotWorktree(dir, depth + 1);
  const files = [...snap.files.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`).join('\n');
  return `${snap.ok ? 'ok' : 'unreadable'}:${snap.head ?? ''}:${files}`;
}

function changedPaths(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
  const files = !after.ok
    ? []
    : !before.ok
      ? (after.files.size === 0 ? [] : [...after.files.keys()])
      : [...new Set([...before.files.keys(), ...after.files.keys()])].filter((name) => before.files.get(name) !== after.files.get(name));
  if ((before.head && after.head && before.head !== after.head) || before.branch !== after.branch) files.push('HEAD');
  return files;
}

function failureReport(failure: WorkflowFailure): { outcome: 'failed'; message: string; failure: WorkflowFailure } {
  return { outcome: 'failed', message: failure.message, failure };
}

type ReportBody = Parameters<typeof reportAttempt>[2];

function workspaceOf(value: unknown): WorkspaceContract | undefined {
  if (!isRecord(value) || (value.mode !== 'new' && value.mode !== 'continue' && value.mode !== 'read-only') || typeof value.branch !== 'string') return undefined;
  const base = isRecord(value.base) && typeof value.base.commit === 'string' && (value.base.ref === undefined || typeof value.base.ref === 'string')
    ? { ...(typeof value.base.ref === 'string' ? { ref: value.base.ref } : {}), commit: value.base.commit } : undefined;
  const start = isRecord(value.start) && typeof value.start.commit === 'string'
    ? { commit: value.start.commit, ...(typeof value.start.branch === 'string' ? { branch: value.start.branch } : {}) } : undefined;
  if (!base || !start || typeof value.configCommit !== 'string' || !Array.isArray(value.merge)) return undefined;
  if (value.mode === 'read-only') {
    return value.merge.length === 0 ? { mode: value.mode, base, configCommit: value.configCommit, branch: value.branch, start, merge: [] } : undefined;
  }
  const merge = value.merge.flatMap((item) => (
    isRecord(item) && typeof item.branch === 'string' && typeof item.commit === 'string' ? [{ branch: item.branch, commit: item.commit }] : []
  ));
  return { mode: value.mode, base, configCommit: value.configCommit, branch: value.branch, start, merge };
}

function parseLease(raw: unknown): Lease | undefined {
  const rawLease = raw as Record<string, unknown> | undefined;
  if (!rawLease || typeof rawLease.step !== 'string' || typeof rawLease.attempt !== 'string' || typeof rawLease.revision !== 'number') return undefined;
  const env = stringMap(rawLease.env);
  const workspace = workspaceOf(rawLease.workspace);
  const session = isRecord(rawLease.session) && typeof rawLease.session.tool === 'string' && typeof rawLease.session.id === 'string'
    ? { tool: rawLease.session.tool, id: rawLease.session.id } : undefined;
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
    ...(rawLease.readOnly === true ? { readOnly: true } : {}),
    ...(typeof rawLease.defaultModel === 'string' ? { defaultModel: rawLease.defaultModel } : {}),
    ...(workspace ? { workspace } : rawLease.workspace !== undefined ? { unreadableWorkspace: true } : {}),
    ...(session ? { session } : {}),
  };
  return (lease.command === undefined) === (lease.prompt === undefined) ? undefined : lease;
}

/** The checkout this lease uses. A step without a workspace shares the active checkout; a workspace has its own worktree. */
function placeOf(lease: Lease, active: string): string {
  return lease.cwd ?? (lease.workspace ? worktreePath(active, lease.workspace.branch) : active);
}

async function stageLease(lease: Lease, { active, runId }: { active: string; runId: string }): Promise<WorkflowFailure | undefined> {
  if (lease.unreadableWorkspace) {
    return { code: 'workspace_base', message: `Step "${lease.step}" was leased a workspace this teamai cannot read. Update teamai.` };
  }
  if (!lease.workspace) {
    lease.cwd = active;
    lease.before = await snapshotWorktree(active);
    return undefined;
  }
  const blocked = await unrestoredCopy(worktreePath(active, lease.workspace.branch));
  if (blocked?.state === 'unreadable') {
    return { code: 'workspace_base', message: `Workspace ${blocked.dir} has a marker teamai cannot read: ${blocked.marker}. Put ${blocked.dir} back on ${lease.workspace.branch} as the step found it, delete ${blocked.marker}, then retry this step with teamai workflow retry ${runId} ${lease.step}.` };
  }
  if (blocked) {
    const { branch, commit, step, reason } = blocked.marker;
    return { code: 'workspace_base', message: `Step "${step}" read workspace ${blocked.dir} and it was not put back (${reason}). It is still not back: ${blocked.left}. Put ${blocked.dir} back on ${branch} at ${commit} as the step found it, then retry this step with teamai workflow retry ${runId} ${lease.step}.` };
  }
  const opened = await ensureWorktree(active, lease.workspace.branch, lease.workspace.start.commit);
  if ('error' in opened) return { code: 'workspace_base', message: opened.error };
  lease.cwd = opened.dir;
  if (lease.workspace.mode === 'read-only') {
    const marked = await markReadCopy(opened.dir, { branch: lease.workspace.branch, step: lease.step });
    if ('error' in marked) return { code: 'workspace_base', message: `Step "${lease.step}" cannot mark workspace ${opened.dir} as in use by a reader: ${marked.error}` };
    lease.found = marked.found;
  }
  lease.rangeFrom = (await headCommit(opened.dir))?.commit;
  let conflict: { branch: string; files: string[] } | undefined;
  const remaining: string[] = [];
  for (const merge of lease.workspace.merge) {
    if (conflict) {
      remaining.push(merge.branch);
      continue;
    }
    const result = await mergeBranch(opened.dir, merge.commit);
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
  await deliverTeamAssets(opened.dir);
  await recordConfigOverlay(opened.dir, applied.saved);
  lease.overlay = applied.saved;
  if (lease.workspace.mode === 'read-only') {
    // Taken over the base overlay, so only what the step itself changes differs from it.
    lease.before = await snapshotWorktree(opened.dir);
    if (lease.before.ok && lease.before.head) return undefined;
    await restoreLeaseOverlay(lease);
    return { code: 'workspace_base', message: `Step "${lease.step}" could not read workspace ${lease.workspace.branch}` };
  }
  await reopenConfigConflicts(opened.dir, applied.saved);
  lease.conflicts = await rememberedConflicts(opened.dir);
  return undefined;
}

/**
 * Gives a workflow worktree the skills, rules, agents and MCP a new worktree of
 * this checkout gets. The delivery happens after the base agent files are restored
 * and before their overlay is recorded, so the delivered files are not the step's edits.
 */
async function deliverTeamAssets(dir: string): Promise<void> {
  const exitCode = process.exitCode;
  try {
    const { createProjectToolRoots } = await import('../project-agent-root.js');
    await createProjectToolRoots({ cwd: dir });
    const { pull } = await import('../pull.js');
    await pull({ silent: true, inline: true, gitHook: 'post-checkout', prepareCheckout: true, cwd: dir });
  } finally {
    process.exitCode = exitCode;
  }
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

async function conflictsPath(dir: string): Promise<string> {
  const printed = (await git(dir, ['rev-parse', '--git-path', 'teamai-conflicts.json'])).stdout.trim();
  return path.resolve(dir, printed);
}

/** Keeps the paths that were conflicted when the merge started until a resolution is validated. A prompt commit can clear MERGE_HEAD before that. */
async function rememberedConflicts(dir: string): Promise<Map<string, string>> {
  const current = await conflictContents(dir);
  const file = await conflictsPath(dir);
  let saved = new Map<string, string>();
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, string>;
    if (parsed && typeof parsed === 'object') saved = new Map(Object.entries(parsed).filter((entry) => typeof entry[1] === 'string'));
  } catch {
    saved = new Map();
  }
  const merged = new Map(saved);
  for (const [relative, text] of current) merged.set(relative, text);
  if (merged.size > 0) await fs.writeFile(file, JSON.stringify(Object.fromEntries(merged)));
  return merged;
}

async function clearRememberedConflicts(dir: string): Promise<void> {
  await fs.rm(await conflictsPath(dir), { force: true });
}

async function unmergedPaths(dir: string): Promise<string[]> {
  const unmerged = await git(dir, ['diff', '-z', '--name-only', '--diff-filter=U']);
  return unmerged.stdout.split('\0').filter((file) => file !== '');
}

async function conflictContents(dir: string): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const file of await unmergedPaths(dir)) {
    try {
      contents.set(file, await fs.readFile(path.join(dir, file), 'utf8'));
    } catch {
      contents.set(file, '');
    }
  }
  return contents;
}

async function unresolvedConflicts(dir: string, before: Map<string, string> | undefined): Promise<string[]> {
  const textOf = async (file: string): Promise<string> => {
    try {
      return await fs.readFile(path.join(dir, file), 'utf8');
    } catch {
      return '';
    }
  };
  const listed = async (): Promise<string[]> => unmergedPaths(dir);
  for (const file of await listed()) {
    const text = await textOf(file);
    if (text.includes('<<<<<<<') || before?.get(file) === text) continue;
    await git(dir, ['add', '--', file]);
  }
  const open = new Set(await listed());
  // `git add` removes a path from the unmerged list even when conflict markers are still in the file.
  if (before) {
    for (const file of before.keys()) {
      if ((await textOf(file)).includes('<<<<<<<')) open.add(file);
    }
  }
  return [...open];
}

async function restoreLeaseOverlay(lease: Lease): Promise<void> {
  if (!lease.overlay || !lease.cwd || !lease.workspace) return;
  await restoreUneditedConfig(lease.cwd, lease.workspace.configCommit, lease.overlay);
  lease.overlay = undefined;
}

/** How a reader left its copy. `kept` holds what the step changed; an unrestored copy lacks it when keeping failed. */
type ReadCopy = { read: StepRead } & (
  | { state: 'untouched' }
  | { state: 'restored'; changed: string[]; kept: KeptChanges }
  | { state: 'unrestored'; changed: string[]; reason: string; dir: string; kept?: KeptChanges }
);

/**
 * Leaves a read-only copy as the step found it: the base agent files go back, and a copy the step changed is reset to
 * the commit it read, so a later step there does not commit the change. What the step changed is kept on a ref first.
 * Undefined for any other lease.
 */
async function leaveReadCopy(lease: Lease): Promise<ReadCopy | undefined> {
  const { cwd, before, found, workspace } = lease;
  if (!cwd || !before?.head || !found || workspace?.mode !== 'read-only') return undefined;
  const changed = changedPaths(before, await snapshotWorktree(cwd));
  // A detach or a switch to another branch at the same commit changes no file, but a later step would commit off the branch.
  // The full ref: --short prints heads/<branch> when a tag has the same name.
  const onBranch = (await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim() === `refs/heads/${workspace.branch}`;
  if (!onBranch && !changed.includes('HEAD')) changed.push('HEAD');
  await restoreLeaseOverlay(lease);
  const read = { branch: workspace.branch, base: workspace.base.commit, commit: before.head };
  const put = await putBackCopy({ dir: cwd, branch: read.branch, commit: read.commit, found, changed, attempt: lease.attempt, step: lease.step });
  return put.state === 'unrestored' ? { read, changed, dir: cwd, ...put } : put.state === 'restored' ? { read, changed, ...put } : { read, ...put };
}

/** A reader that changed its copy fails. `changed` is the step's own sentence naming the paths. */
function readCopyFailure(left: Exclude<ReadCopy, { state: 'untouched' }>, changed: string): WorkflowFailure {
  const { branch, commit } = left.read;
  switch (left.state) {
    case 'restored':
      return { code: 'read_only_dirty', message: `${changed} Workspace ${branch} was put back at ${commit}. ${keptSentence(left.kept)}` };
    case 'unrestored':
      return {
        code: 'workspace_base',
        message: left.kept
          ? `${changed} Workspace ${branch} could NOT be put back at ${commit}: ${left.reason}. ${keptSentence(left.kept)} Later steps there fail until ${left.dir} is back on ${branch} at ${commit} as the step found it.`
          : `${changed} Workspace ${branch} could NOT be put back at ${commit}: ${left.reason}. Its changes were NOT saved and are still in ${left.dir}. Copy them out before you put ${left.dir} back on ${branch} at ${commit} as the step found it. Later steps there fail until it is.`,
      };
    default: {
      const unhandled: never = left;
      return unhandled;
    }
  }
}

async function finishWorkspace(lease: Lease, push: boolean): Promise<{ changes?: { branch: string; base: string; from: string; to: string; commits: string[] }; failure?: WorkflowFailure }> {
  if (!lease.workspace || lease.workspace.mode === 'read-only' || !lease.cwd) return {};
  if (lease.overlay) await restoreUneditedConfig(lease.cwd, lease.workspace.configCommit, lease.overlay);
  lease.overlay = undefined;
  // A commit on whatever HEAD the step left would be reported and pushed as the leased branch, which would lack it.
  const on = await offBranch(lease.cwd, lease.workspace.branch);
  if (on) return { failure: { code: 'workspace_base', message: `Step "${lease.step}" left workspace ${lease.cwd} ${on}, not on branch ${lease.workspace.branch}, so nothing was committed or pushed. Check out ${lease.workspace.branch} in ${lease.cwd} with the changes to keep, then retry the step.` } };
  const open = await unresolvedConflicts(lease.cwd, lease.conflicts);
  if (open.length > 0) return { failure: { code: 'merge_conflict', message: `Unresolved merge conflict: ${open.join(', ')}` } };
  const committed = await commitWork(lease.cwd, `teamai: ${lease.step}`, lease.rangeFrom);
  if ('error' in committed) return { failure: { code: 'push_failed', message: committed.error } };
  await clearRememberedConflicts(lease.cwd);
  const pushed = push ? await pushIfOrigin(lease.cwd, lease.workspace.branch, committed.commits) : 'unchanged';
  const changes = {
    branch: lease.workspace.branch,
    base: lease.workspace.base.commit,
    from: committed.from,
    to: committed.to,
    commits: committed.commits,
  };
  if (typeof pushed !== 'object') return { changes };
  return { changes, failure: { code: 'push_failed', message: `Step "${lease.step}" committed on ${lease.workspace.branch} in ${lease.cwd}, but pushing it to origin failed. The commits stay on ${lease.workspace.branch}. Fix what blocked the push, then push ${lease.workspace.branch} from ${lease.cwd} or retry the step. Git said: ${pushed.error}` } };
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
  const left = await leaveReadCopy(lease);
  const touched = left?.state === 'untouched' ? undefined : left;
  const exited = result.exitCode === 0
    ? undefined
    : snippet === '' ? `command exited with status ${result.exitCode}` : `command exited with status ${result.exitCode}: ${snippet}`;
  // A failing command keeps its own failure, and still says where the changes it made went.
  const copy = touched && readCopyFailure(touched, `${exited ? `${exited}. ` : ''}Read-only command step changed repository paths: ${touched.changed.join(', ')}.`);
  const dirty = copy && (!exited || copy.code === 'workspace_base') ? copy : undefined;
  const finished = lease.workspace && !left ? await finishWorkspace(lease, result.exitCode === 0) : {};
  const failure = dirty ?? finished.failure;
  const failed = result.exitCode !== 0 || failure;
  const message = failure?.message ?? copy?.message ?? exited;
  return {
    attempt: lease.attempt,
    revision: lease.revision,
    outcome: failed ? 'failed' : 'success',
    driver,
    ...(output !== undefined ? { outputs: output } : {}),
    exitCode: result.exitCode,
    ...(message ? { message } : {}),
    ...(failure ? { failure } : {}),
    ...(finished.changes ? { changes: finished.changes } : {}),
    ...(left ? { read: left.read } : {}),
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
  const giveUp = async (failure: WorkflowFailure, tool?: string): Promise<ReportBody> => {
    if (lease.overlay && lease.cwd && lease.workspace) {
      await restoreUneditedConfig(lease.cwd, lease.workspace.configCommit, lease.overlay);
      lease.overlay = undefined;
    }
    return { attempt: lease.attempt, revision: lease.revision, driver, ...(tool ? { tool } : {}), ...failureReport(failure) };
  };
  if (!selected) return giveUp({ code: 'tool_unconfigured', message: 'No local workflow tool is configured for this prompt step' });
  if (!supportedTool(selected)) {
    return giveUp({ code: 'tool_unsupported', message: `The local workflow tool "${selected}" is not supported` }, selected);
  }
  // A worktree has its own pull record, so the tool launched there is observed and bound as that checkout.
  const stepConfig = lease.workspace && lease.cwd ? await detectProjectConfig(lease.cwd) ?? config : config;
  const loaded = lease.agent ? await loadAgent(selected, lease.agent, stepConfig, options.toolPaths) : undefined;
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
  const before = lease.interactive && !lease.readOnly ? undefined : (lease.before ?? await snapshotWorktree(cwd));
  const resume = await resumeSession(lease, selected, cwd);
  const definitionModel = chosen.model && chosen.by === 'definition'
    ? { model: chosen.model.name, ...(chosen.model.effort ? { effort: chosen.model.effort } : {}) }
    : {};
  const [observed, launch] = await Promise.all([
    observeLaunch({
      config: stepConfig,
      tool: selected,
      cwd,
      ...(lease.agent && loaded ? { definition: { stem: lease.agent, file: loaded.file, ...definitionModel } } : {}),
      ...(chosen.model && chosen.by !== 'definition'
        ? { chosen: { model: chosen.model.name, ...(chosen.model.effort ? { effort: chosen.model.effort } : {}), ...(chosen.alias ? { alias: chosen.alias } : {}) } }
        : {}),
    }),
    workflowLaunch(stepConfig, selected),
  ]);
  let result: LocalToolResult;
  try {
    if (lease.interactive) log.info(`Step "${lease.step}" opens ${selected} here for interactive work.`);
    const run = lease.interactive ? adapter.runInteractive.bind(adapter) : adapter.run.bind(adapter);
    result = await run(selected, {
      prompt: lease.prompt!,
      cwd,
      resultPath: attemptResultPath,
      ...(launch ? { launch } : {}),
      ...(resume ? { resume } : {}),
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
  const left = await leaveReadCopy(lease);
  const touched = left?.state === 'untouched' ? undefined : left;
  const paths = !left && before && !lease.workspace ? changedPaths(before, await snapshotWorktree(cwd)) : [];
  const dirtyFailure = touched
    ? readCopyFailure(touched, `Read-only prompt step changed repository paths: ${touched.changed.join(', ')}.`)
    : paths.length === 0 ? undefined : { code: 'read_only_dirty', message: `Read-only prompt step changed repository paths: ${paths.join(', ')}` };
  const finished = lease.workspace && !left && !dirtyFailure ? await finishWorkspace(lease, result.exitCode === 0 && !result.failure) : {};
  const failure = dirtyFailure ?? finished.failure ?? result.failure;
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
    ...(finished.changes ? { changes: finished.changes } : {}),
    ...(left ? { read: left.read } : {}),
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
  // Leases not started yet, in lease order. Steps that share a checkout run one at a time. Distinct worktrees overlap.
  const held: Lease[] = [];
  // Cancelled commands whose process group is not gone yet. They are not sent as running, so `next` does not cancel
  // them again. They still take a slot, and a new attempt of their step waits until they are gone, so a retried step
  // never runs beside its cancelled attempt.
  const dying = new Map<string, { step: string; lease: Lease; command: CommandProcess }>();
  const base = await headCommit(cwd);
  let prompt: { lease: Lease; controller: AbortController; exit: Promise<ReportBody> } | undefined;
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
      const running = [...inFlight.keys(), ...held.map((lease) => lease.attempt), ...(prompt ? [prompt.lease.attempt] : [])];
      const canTakeLease = room();
      const next = await leaseNext(config, runId, driver, {
        running, canTakeLease, hitl: canHitl, autoApprove: options.autoApprove,
        ...(base ? { base } : {}), workspaceModes: ['read-only', 'new', 'continue'],
      });
      if (signalled) continue;
      if (isWorkflowError(next)) return next;
      for (const attempt of Array.isArray(next.data.cancelled) ? next.data.cancelled as string[] : []) cancel(attempt);
      if ('done' in next.data) {
        question?.controller.abort();
        if (prompt) {
          const lease = prompt.lease;
          prompt.controller.abort();
          const failed = await report(await prompt.exit, lease);
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
        ...[...inFlight.values()].map(({ lease }) => placeOf(lease, cwd)),
        ...[...dying.values()].map(({ lease }) => placeOf(lease, cwd)),
        ...(prompt ? [placeOf(prompt.lease, cwd)] : []),
      ]);
      for (let index = 0; !prompt?.lease.interactive && held[index]?.command !== undefined && busy() < maxParallel;) {
        const lease = held[index]!;
        if ([...dying.values()].some((stopping) => stopping.step === lease.step)
          || placesBusy().has(placeOf(lease, cwd))
          || held.slice(0, index).some((earlier) => earlier.prompt !== undefined && placeOf(earlier, cwd) === placeOf(lease, cwd))) {
          index += 1;
          continue;
        }
        held.splice(index, 1);
        const failure = await stageLease(lease, { active: cwd, runId });
        if (failure) {
          const failed = await failStaged(lease, failure);
          if (failed) return failed;
          continue;
        }
        inFlight.set(lease.attempt, { lease, command: startCommand(lease.command!, lease.cwd ?? cwd, lease.env ?? {}, detached) });
      }
      if (!prompt && busy() < maxParallel) {
        const promptAt = held.findIndex((lease) => lease.prompt !== undefined
          && !placesBusy().has(placeOf(lease, cwd))
          && ![...dying.values()].some((stopping) => stopping.step === lease.step)
          && (!lease.interactive || (inFlight.size === 0 && dying.size === 0)));
        if (promptAt !== -1) {
          const lease = held.splice(promptAt, 1)[0]!;
          if (lease.interactive && !canHitl) {
            const failed = await report({ attempt: lease.attempt, revision: lease.revision, driver,
              ...failureReport(interactiveHitlRequired(runId, lease.step)) }, lease);
            if (failed) return failed;
            continue;
          }
          const failure = await stageLease(lease, { active: cwd, runId });
          if (failure) {
            const failed = await failStaged(lease, failure);
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
        const lease = prompt?.lease;
        prompt = undefined;
        if (maxParallel === 1) for (const name of STOP_SIGNALS) process.off(name, onSignal);
        const failed = await report(exited.body, lease);
        if (failed) return failed;
        continue;
      }
      if (exited.kind === 'stopped') {
        const stopping = dying.get(exited.attempt);
        dying.delete(exited.attempt);
        if (stopping) await (stopping.lease.workspace?.mode === 'read-only' ? leaveReadCopy(stopping.lease) : restoreLeaseOverlay(stopping.lease));
        continue;
      }
      inFlight.delete(exited.attempt);
      const failed = await report(await commandReport(resultPath(config, runId, exited.attempt), driver, exited.lease, exited.result), exited.lease);
      if (failed) return failed;
    }
  } finally {
    question?.controller.abort();
    prompt?.controller.abort(signalled);
    if (prompt) await prompt.exit;
    for (const attempt of inFlight.keys()) cancel(attempt);
    await Promise.all([...dying.values()].map(async ({ lease, command }) => {
      await command.stop();
      await (lease.workspace?.mode === 'read-only' ? leaveReadCopy(lease) : restoreLeaseOverlay(lease));
    }));
    if (signalled) exitOn(signalled);
    for (const name of STOP_SIGNALS) process.off(name, onSignal);
  }
}
