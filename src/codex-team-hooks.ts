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
import { getTeamHookDispatchCommand, getTeamHookDispatchCommandWindows } from './builtin-hooks.js';
import type { CodexGroupSlot, CodexTrustPolicy } from './hooks.js';
import { CODEX_TOOL_ID, getTeamaiHomeDir } from './types.js';
import { checkoutForProjectAnchor } from './utils/git.js';
import { readJson, readJsonObject, writeJsonAtomic } from './utils/fs.js';
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

/**
 * One project's record: the hooks each checkout registered (`checkouts`), or
 * one set for the whole project (`hooks`, also the shape before checkouts were
 * recorded). An array `checkouts` is an older form: those checkouts share `hooks`.
 */
interface CodexTeamHookRecord {
  hooks?: CodexTeamHook[];
  checkouts?: Record<string, CodexTeamHook[]> | string[];
}

interface CodexTeamHookIndex {
  /** Keyed by stable project identity, or the checkout itself in self mode. */
  projects: Record<string, CodexTeamHookRecord>;
}

/** Each checkout's hooks in `record`, or undefined for a record that holds one set for the whole project. */
function checkoutHooks(record: CodexTeamHookRecord | undefined): Record<string, CodexTeamHook[]> | undefined {
  if (!record?.checkouts) return undefined;
  if (Array.isArray(record.checkouts)) return Object.fromEntries(record.checkouts.map((root) => [root, record.hooks ?? []]));
  return record.checkouts;
}

/** The hooks `record` runs for `checkout`: its own when checkouts are recorded, else the project's. */
function hooksFor(record: CodexTeamHookRecord | undefined, checkout: string | undefined): CodexTeamHook[] | undefined {
  const perCheckout = checkoutHooks(record);
  if (!perCheckout) return record?.hooks;
  if (checkout) return Object.hasOwn(perCheckout, checkout) ? perCheckout[checkout] : undefined;
  const all = Object.values(perCheckout);
  return all.length ? all.flat() : undefined;
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

/** Every key the index holds a record under. */
export async function codexDispatcherProjects(): Promise<string[]> {
  return Object.keys((await readIndex()).projects);
}

/** The hooks each checkout of `project` registered; undefined for a record that holds one set for the whole project. */
export async function codexDispatcherCheckouts(project: string): Promise<Record<string, CodexTeamHook[]> | undefined> {
  return checkoutHooks((await readIndex()).projects[project]);
}

/** Whether `project`'s team hooks run from the dispatcher now. */
export async function runsFromCodexDispatcher(project: string, checkout?: string): Promise<boolean> {
  return (await dispatchedCodexHooks(project, checkout)) !== undefined;
}

/** The team hooks the dispatcher runs for `project` (from `checkout`, or any of its checkouts), if it runs them. */
export async function dispatchedCodexHooks(project: string, checkout?: string): Promise<CodexTeamHook[] | undefined> {
  return hooksFor((await readIndex()).projects[project], checkout);
}

/**
 * Record `project`'s team hooks for the dispatcher, or stop dispatching for it
 * (`null`): for `checkout` alone when given, leaving the other checkouts' hooks
 * as they registered them, else for the whole project. Projects and checkouts
 * whose directory is gone are dropped on the way. False when another process
 * held the index for too long: nothing changed.
 */
export async function setCodexDispatcherHooks(project: string, hooks: CodexTeamHook[] | null, checkout?: string): Promise<boolean> {
  const file = codexTeamHookIndexPath();
  // Nothing to change: no lock, no write (the common case, a project whose hooks stay in its file).
  const seen = (await readIndex()).projects[project];
  const seenCheckouts = checkoutHooks(seen);
  if (hooks === null ? seen === undefined || (checkout && seenCheckouts && !Object.hasOwn(seenCheckouts, checkout))
    : checkout ? !Array.isArray(seen?.checkouts) && JSON.stringify(seenCheckouts?.[checkout]) === JSON.stringify(hooks)
      : !seenCheckouts && JSON.stringify(seen?.hooks) === JSON.stringify(hooks)) return true;
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
    if (checkout) {
      const previous = index.projects[project];
      // A record without checkouts described the original main checkout's shared
      // file: the one the identity recovers, or the identity when it is a
      // checkout itself (self mode). A Git directory is none; each real
      // checkout's next pull registers its own hooks.
      const original = previous?.hooks
        ? await checkoutForProjectAnchor(project) ?? (fs.existsSync(path.join(project, '.git')) ? project : undefined)
        : undefined;
      const registered = checkoutHooks(previous) ?? (original && previous?.hooks ? { [original]: previous.hooks } : {});
      const checkouts = Object.fromEntries(Object.entries(registered).filter(([root]) => root !== checkout && fs.existsSync(root)));
      if (hooks) checkouts[checkout] = hooks;
      if (Object.keys(checkouts).length) index.projects[project] = { checkouts };
      else delete index.projects[project];
    } else if (hooks) index.projects[project] = { hooks };
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

/**
 * Make the Codex hook file `hooksFile` (`~/.codex/hooks.json`) hold exactly one
 * dispatcher entry for each event a recorded project has team hooks for, with
 * the largest of their timeouts, and none for any other event. An entry is
 * rewritten where it is and a new one appended, so only a removed entry moves
 * the groups after it (#1250). Writes only on change.
 */
export async function reconcileCodexDispatchers(hooksFile: string, codexTrust: CodexTrustPolicy): Promise<void> {
  const timeouts = new Map<string, number>();
  for (const [root, record] of Object.entries((await readIndex()).projects)) {
    // A project or checkout that is gone needs no entry; the index drops it on its next write.
    if (!fs.existsSync(root)) continue;
    const perCheckout = checkoutHooks(record);
    const hooks = perCheckout
      ? Object.entries(perCheckout).filter(([checkout]) => fs.existsSync(checkout)).flatMap(([, defs]) => defs)
      : record.hooks ?? [];
    for (const hook of hooks) {
      if (!DISPATCHABLE_EVENT.test(hook.event)) continue;
      const timeout = hook.timeout ?? defaultTimeout(hook.event);
      timeouts.set(hook.event, Math.max(timeouts.get(hook.event) ?? 0, timeout));
    }
  }
  if (timeouts.size === 0 && (await readJsonObject(hooksFile)).kind === 'missing') return;
  const { editCodexHookFile } = await import('./hooks.js');
  const isDispatcher = (group: { hooks?: Array<{ command?: string }> }) => isCodexTeamHookDispatcher(group?.hooks?.[0]?.command ?? '');
  const written = await editCodexHookFile(hooksFile, CODEX_TOOL_ID, (all) => Object.fromEntries(
    [...new Set([...Object.keys(all), ...timeouts.keys()])].map((event) => {
      const existing = all[event] ?? [];
      const timeout = timeouts.get(event);
      const wanted: CodexGroupSlot | undefined = timeout === undefined ? undefined
        : {
          write: {
            hooks: [{
              type: 'command',
              command: getTeamHookDispatchCommand(event, CODEX_TOOL_ID),
              // The Windows form drops the bash wrapper cmd.exe cannot resolve
              // (#1215); the block contract passes through natively (#1209). On
              // `command` the entry keeps the POSIX form on every platform, like
              // the built-in entries (#1074).
              commandWindows: getTeamHookDispatchCommandWindows(event, CODEX_TOOL_ID),
              timeout,
            }],
          },
        };
      const at = existing.findIndex(isDispatcher);
      const slots = existing.flatMap((group, index): CodexGroupSlot[] =>
        !isDispatcher(group) ? [{ keep: index }] : index === at && wanted ? [wanted] : []);
      if (wanted && at < 0) slots.push(wanted);
      return [event, slots.length === 0 && existing.length > 0 ? null : slots];
    })), codexTrust);
  if (written) log.debug(`Updated the Codex team-hook dispatchers in ${hooksFile}`);
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
  const { codexTeamHookCheckout, codexTeamHookProject } = await import('./hooks.js');
  const project = localConfig ? await codexTeamHookProject(localConfig) : null;
  const record = project ? projects[project] : undefined;
  // A record with checkouts runs only the hooks the resolved checkout registered; an unresolved checkout runs none.
  const checkout = localConfig && checkoutHooks(record) ? await codexTeamHookCheckout(localConfig) : undefined;
  const hooks = (checkout === null ? [] : hooksFor(record, checkout ?? undefined) ?? []).filter((hook) => hook.event === event && matches(hook, payload));
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
