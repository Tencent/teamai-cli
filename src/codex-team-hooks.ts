/**
 * Codex team hooks that run from a dispatcher (#915).
 *
 * When a project's `.codex/hooks.json` holds entries teamai does not own (the
 * team tracks it, or the member added their own; always in self mode, whose
 * committed file holds the built-ins), teamai does not write the team's Codex
 * hooks into it. Pull records them here, per project, in a machine-wide index
 * (`~/.teamai/codex-team-hooks.json`), and `~/.codex/hooks.json` gets one
 * dispatcher entry per event any recorded project has hooks for:
 * `teamai hook-dispatch <E> --tool codex --team-hooks`. At run time the
 * dispatcher finds the project from the hook's `cwd` and runs that project's
 * hooks for the event, the way Codex would have run them from the file.
 *
 * The entries name no project, so Codex's trust in them stays valid as
 * checkouts come and go; only a change of an event's largest timeout changes
 * one.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getTeamHookDispatchCommand } from './builtin-hooks.js';
import { CODEX_TOOL_ID, getTeamaiHomeDir } from './types.js';
import { ensureDir, readJson, readJsonObject, writeJson, writeJsonAtomic } from './utils/fs.js';
import { log, setStderrOnly } from './utils/logger.js';

/** One team hook a project runs through the dispatcher, as pull resolved it. */
export interface CodexTeamHook {
  id: string;
  event: string;
  matcher?: string;
  command: string;
  /** Seconds; Codex's default for the event when absent. */
  timeout?: number;
}

interface CodexTeamHookIndex {
  /** Keyed by project: the main checkout (realpath), or the checkout itself in self mode. */
  projects: Record<string, { hooks: CodexTeamHook[] }>;
}

/** Codex's own default hook timeout, in seconds: 600, except 1 for SessionEnd. */
function defaultTimeout(event: string): number {
  return event === 'SessionEnd' ? 1 : 600;
}

/** Events a dispatcher entry can name in its command: Codex's event names are plain words. */
const DISPATCHABLE_EVENT = /^[A-Za-z]+$/;

const DISPATCHER_COMMAND = /\bteamai hook-dispatch [A-Za-z]+ --tool codex --team-hooks\b/;

/** Whether a Codex hook command is a team-hook dispatcher entry's. */
export function isCodexTeamHookDispatcher(command: string): boolean {
  return DISPATCHER_COMMAND.test(command);
}

/** The index of the projects whose Codex team hooks run from the dispatcher. */
export function codexTeamHookIndexPath(): string {
  return path.join(getTeamaiHomeDir(), 'codex-team-hooks.json');
}

async function readIndex(): Promise<CodexTeamHookIndex> {
  const data = await readJson<CodexTeamHookIndex>(codexTeamHookIndexPath());
  return data && typeof data === 'object' && data.projects && typeof data.projects === 'object'
    ? data : { projects: {} };
}

/** Whether `project`'s team hooks run from the dispatcher now. */
export async function runsFromCodexDispatcher(project: string): Promise<boolean> {
  return (await dispatchedCodexHooks(project)) !== undefined;
}

/** The team hooks the dispatcher runs for `project`, if it runs them. */
export async function dispatchedCodexHooks(project: string): Promise<CodexTeamHook[] | undefined> {
  return (await readIndex()).projects[project]?.hooks;
}

/**
 * Record `project`'s team hooks for the dispatcher, or stop dispatching for it
 * (`null`). Projects whose directory is gone are dropped on the way. False when
 * another process held the index for too long: nothing changed.
 */
export async function setCodexDispatcherHooks(project: string, hooks: CodexTeamHook[] | null): Promise<boolean> {
  const file = codexTeamHookIndexPath();
  // Nothing to change: no lock, no write (the common case, a project whose hooks stay in its file).
  const seen = (await readIndex()).projects[project];
  if (hooks === null ? seen === undefined : JSON.stringify(seen?.hooks) === JSON.stringify(hooks)) return true;
  const lock = `${file}.lock`;
  const { acquireLock, releaseLock } = await import('./update.js');
  const deadline = Date.now() + 3_000;
  while (!await acquireLock(lock)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    const index = await readIndex();
    const before = JSON.stringify(index);
    if (hooks) index.projects[project] = { hooks };
    else delete index.projects[project];
    for (const root of Object.keys(index.projects)) {
      if (!fs.existsSync(root)) delete index.projects[root];
    }
    if (JSON.stringify(index) !== before) {
      if (Object.keys(index.projects).length === 0) await fs.promises.rm(file, { force: true });
      else await writeJsonAtomic(file, index);
    }
    return true;
  } finally {
    await releaseLock(lock);
  }
}

interface CodexHookGroup { matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }

/**
 * Make the Codex hook file `hooksFile` (`~/.codex/hooks.json`) hold exactly one
 * dispatcher entry for each event a recorded project has team hooks for, with
 * the largest of their timeouts, and none for any other event. The entries sit
 * before teamai's built-ins, where the built-in pass leaves them, so neither
 * pass moves what the other wrote. Writes only on change.
 */
export async function reconcileCodexDispatchers(hooksFile: string): Promise<void> {
  const timeouts = new Map<string, number>();
  for (const [root, { hooks }] of Object.entries((await readIndex()).projects)) {
    // A project that is gone needs no entry; the index drops it on its next write.
    if (!fs.existsSync(root)) continue;
    for (const hook of hooks) {
      if (!DISPATCHABLE_EVENT.test(hook.event)) continue;
      const timeout = hook.timeout ?? defaultTimeout(hook.event);
      timeouts.set(hook.event, Math.max(timeouts.get(hook.event) ?? 0, timeout));
    }
  }
  if (timeouts.size === 0 && (await readJsonObject(hooksFile)).kind === 'missing') return;
  // One that does not parse is left byte-identical, as every hook writer leaves it (#993).
  const { readHookFile } = await import('./hooks.js');
  const doc = await readHookFile<{ hooks?: Record<string, CodexHookGroup[]> }>(hooksFile, {});
  const all = doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {};
  const isDispatcher = (group: CodexHookGroup) => isCodexTeamHookDispatcher(group?.hooks?.[0]?.command ?? '');
  let changed = false;
  for (const event of new Set([...Object.keys(all), ...timeouts.keys()])) {
    const existing = Array.isArray(all[event]) ? all[event] : [];
    const rest = existing.filter((group) => !isDispatcher(group));
    const timeout = timeouts.get(event);
    const wanted: CodexHookGroup[] = timeout === undefined ? []
      : [{ hooks: [{ type: 'command', command: getTeamHookDispatchCommand(event, CODEX_TOOL_ID), timeout }] }];
    const builtin = rest.findIndex((group) => (group?.hooks?.[0]?.command ?? '').includes('teamai hook-dispatch'));
    const at = builtin < 0 ? rest.length : builtin;
    const next = [...rest.slice(0, at), ...wanted, ...rest.slice(at)];
    if (JSON.stringify(next) === JSON.stringify(existing)) continue;
    changed = true;
    if (next.length === 0 && existing.every(isDispatcher)) delete all[event];
    else all[event] = next;
  }
  if (!changed) return;
  doc.hooks = all;
  await ensureDir(path.dirname(hooksFile));
  await writeJson(hooksFile, doc);
  log.debug(`Updated the Codex team-hook dispatchers in ${hooksFile}`);
}

/** The payload field Codex tests an event's matcher against; events without one ignore it. */
const MATCHED_FIELD: Record<string, string> = {
  PreToolUse: 'tool_name',
  PostToolUse: 'tool_name',
  PermissionRequest: 'tool_name',
  SessionStart: 'source',
  SessionEnd: 'reason',
  PreCompact: 'trigger',
  PostCompact: 'trigger',
  SubagentStart: 'agent_type',
  SubagentStop: 'agent_type',
};

/** Whether `hook`'s matcher selects this payload: a regex over the whole value, `*` or none for all. */
function matches(hook: CodexTeamHook, payload: Record<string, unknown>): boolean {
  const matcher = hook.matcher;
  const field = MATCHED_FIELD[hook.event];
  if (!matcher || matcher === '*' || !field) return true;
  const value = payload[field];
  if (typeof value !== 'string') return false;
  // Codex lets `Edit` and `Write` select apply_patch, which still reports itself by name.
  const values = value === 'apply_patch' ? [value, 'Edit', 'Write'] : [value];
  let regex: RegExp | null = null;
  try {
    regex = new RegExp(`^(?:${matcher})$`);
  } catch {
    // Not a regex: compare literally.
  }
  return values.some((v) => (regex ? regex.test(v) : v === matcher));
}

interface HookRun { hook: CodexTeamHook; code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Run one team hook as Codex would: through a shell, in `cwd`, the payload on stdin, bounded by its timeout. */
function runHook(hook: CodexTeamHook, payload: string, cwd: string | undefined): Promise<HookRun> {
  return new Promise((resolve) => {
    const group = process.platform !== 'win32';
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ hook, code, stdout, stderr, timedOut });
    };
    const child = spawn(hook.command, {
      shell: true,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group, so a timeout stops the shell and what it started.
      detached: group,
    });
    const timer = setTimeout(() => {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(null, true);
    }, (hook.timeout ?? defaultTimeout(hook.event)) * 1000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (e) => { stderr += e.message; finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => {});
    child.stdin?.end(payload);
  });
}

/**
 * `teamai hook-dispatch <event> --tool codex --team-hooks`: run the team hooks
 * of the project the payload's `cwd` belongs to for `event`, all at once, as
 * Codex runs matching hooks. Returns the exit status: 2 when a hook asked to
 * block (its stderr is passed on), else 0 with the hooks' stdout, merged the
 * way the built-in dispatcher merges handler outputs. Returns 0 at once when no
 * project runs team hooks from here.
 */
export async function runCodexDispatcher(event: string): Promise<number> {
  // STDOUT carries only the hooks' output to Codex.
  setStderrOnly(true);
  const { projects } = await readIndex();
  if (Object.keys(projects).length === 0) return 0;
  const { readStdin, parseStdin } = await import('./hook-dispatch-cli.js');
  const raw = await readStdin();
  const payload = parseStdin(raw, event);
  const cwd = typeof payload.cwd === 'string' && fs.existsSync(payload.cwd) ? payload.cwd : undefined;
  const { resolveHookConfig } = await import('./dashboard-collector.js');
  const localConfig = await resolveHookConfig(payload, CODEX_TOOL_ID);
  const { codexTeamHookProject } = await import('./hooks.js');
  const project = localConfig ? await codexTeamHookProject(localConfig) : null;
  const hooks = (project ? projects[project]?.hooks ?? [] : []).filter((hook) => hook.event === event && matches(hook, payload));
  if (hooks.length === 0) return 0;

  const runs = await Promise.all(hooks.map((hook) => runHook(hook, raw, cwd)));
  for (const run of runs) {
    if (run.timedOut) process.stderr.write(`teamai: team hook ${run.hook.id} timed out after ${run.hook.timeout ?? defaultTimeout(event)}s\n`);
    else if (run.code !== 0 && run.stderr) process.stderr.write(run.stderr);
  }
  if (runs.some((run) => run.code === 2)) return 2;
  const { mergeHookOutputs } = await import('./hook-dispatch.js');
  const output = mergeHookOutputs(runs.filter((run) => run.code === 0 && run.stdout.trim()).map((run) => run.stdout));
  if (output) await new Promise<void>((resolve) => process.stdout.write(output, () => resolve()));
  return 0;
}
