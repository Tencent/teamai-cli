import path from 'node:path';
import { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';
import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import type { StepTokenFormat } from '@teamai/tool-core/step-usage';
import { HOST_PROCESSES } from '@teamai/shared/exec';
import { getUserHome } from '@teamai/shared/home';
import type { SessionHost } from '@teamai/tool-core/sessions/platform';
import type { AgentAdapter, SessionMeta } from '@teamai/tool-core/sessions/base';
import { canList, FsFailureSchema, isPermissionDenied } from '@teamai/shared/fs-failure';

// ─── The tool session a T3 thread ran ───
//
//  T3's MCP does not name the session its provider started, so the runtime finds it where the tool keeps it: the
//  transcript the thread's tool wrote for the step's worktree since the thread was launched, in the tool home the
//  thread's provider instance runs it in (`instanceToolHome`). The tokens a step billed are read from that transcript.
//  The stores are spelled here because a runtime package
//  cannot read the tool registry (src/tool-registry.ts) and may not import a tool family; they move to tool-core's
//  session-store lookup once it exists.
//

/**
 * The T3 provider drivers this runtime runs, each with the teamai tool it is, its name in T3, its tool's home under a
 * user's home, the folder of a tool home its sessions are in and their store there, and the format its transcript
 * records tokens in. The variables that move that home are the ones teamai names in init (`Session.homeEnv`).
 */
export const DRIVERS = {
  claudeAgent: {
    tool: 'claude', label: 'Claude', home: '.claude', store: 'projects', sessions: (toolHome: string) => new ClaudeCodeAdapter('claude-code', path.join(toolHome, 'projects')),
    tokens: 'claude-jsonl',
  },
  codex: {
    tool: 'codex', label: 'Codex', home: '.codex', store: 'sessions', sessions: (toolHome: string, host: SessionHost) => new CodexAdapter('codex', path.join(toolHome, 'sessions'), host),
    tokens: 'codex-rollout',
  },
} as const satisfies Record<string, {
  tool: string; label: string; home: string; store: string; sessions(toolHome: string, host: SessionHost): AgentAdapter; tokens: StepTokenFormat;
}>;

export type Driver = keyof typeof DRIVERS;

export type ToolId = (typeof DRIVERS)[Driver]['tool'];

function isDriver(name: string): name is Driver {
  return Object.hasOwn(DRIVERS, name);
}

/** The T3 drivers this runtime runs, in the order it offers their tools. */
export const DRIVER_NAMES: readonly Driver[] = Object.keys(DRIVERS).filter(isDriver);

/** The T3 driver of `tool`, when this runtime runs it. */
export function driverOf(tool: string): Driver | undefined {
  return DRIVER_NAMES.find((driver) => DRIVERS[driver].tool === tool);
}

/** The teamai tool T3's `driver` is, when this runtime runs it. */
export function toolOf(driver: string): ToolId | undefined {
  return isDriver(driver) ? DRIVERS[driver].tool : undefined;
}

/** How much earlier than the launch a record the thread's work left (a transcript, a delegated task) may be stamped and still be its. */
export const CLOCK_SLACK_MS = 5_000;

/** Whether teamai can list the folder `driver` keeps its sessions in under `toolHome`, or will once the tool makes it. */
export function canListStore(driver: Driver, toolHome: string): boolean {
  return canList(path.join(toolHome, DRIVERS[driver].store));
}

/** Whether `toolHome` is the home teamai reads `driver`'s sessions in when a session names none: the tool's, in this HOME. */
export function isDefaultToolHome(driver: Driver, toolHome: string): boolean {
  return path.resolve(toolHome) === path.join(getUserHome(), DRIVERS[driver].home);
}

/** A session a step's tool kept: its id, and the transcript it is in when the store names one. */
export type KeptSession = { id: string; transcript?: string };

/**
 * What the lookup of a step's session found: the session; none; folders of the tool's store teamai has no permission to
 * list, as ones the tool can write and teamai cannot read, which may hold it; or why the lookup failed otherwise.
 */
export type SessionLookup =
  | { kind: 'found'; session: KeptSession }
  | { kind: 'none' }
  | { kind: 'unlistable'; folders: [string, ...string[]] }
  | { kind: 'failed'; why: string };

/**
 * The first session the tool of `driver` started in `cwd` at or after `since`, in `toolHome`, other than `other`. A task
 * the thread delegates may start a later session in the same folder; that one is not the step's. `other` is a session the
 * thread cannot have, such as that of an earlier thread in the folder whose conversation the step did not go on in, which
 * may have started within the clock's slack.
 */
export async function sessionSince({ driver, toolHome, cwd, since, other }: { driver: Driver; toolHome: string; cwd: string; since: number; other?: string }): Promise<SessionLookup> {
  let sessions: SessionMeta[];
  const skipped: string[] = [];

  // The runtime only reads sessions, and only writing one runs a tool's CLI, so each tool is its own command here and no
  // tool's command starts in a home.
  const host: SessionHost = {
    processes: HOST_PROCESSES, executablesOf: (tool) => [tool], skippedFolder: (folder) => skipped.push(folder),
    homeEnvAt: (tool, dir) => { throw new Error(`The T3 runtime only reads ${tool} sessions, so it starts no ${tool} command in ${dir}.`); },
  };

  try {
    sessions = await DRIVERS[driver].sessions(toolHome, host).listConversations(cwd);
  } catch (error) {
    const failure = FsFailureSchema.safeParse(error);

    if (failure.success && isPermissionDenied(failure.data)) return { kind: 'unlistable', folders: [failure.data.path ?? toolHome] };

    return { kind: 'failed', why: failure.success ? `reading ${failure.data.path ?? toolHome} failed (${failure.data.message})` : String(error instanceof Error ? error.message : error) };
  }

  const started = sessions.filter((session) => session.sessionId !== other && Date.parse(session.createdAt) >= since - CLOCK_SLACK_MS);
  const first = started.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];

  if (first) return { kind: 'found', session: { id: first.sessionId, ...(first.filePath !== undefined && { transcript: first.filePath }) } };
  const [folder, ...more] = skipped;

  // A folder teamai skipped may be the one that holds the session, as the day folder another user's tool made today.
  return folder === undefined ? { kind: 'none' } : { kind: 'unlistable', folders: [folder, ...more] };
}
