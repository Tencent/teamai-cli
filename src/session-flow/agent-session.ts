/**
 * agent-session.ts -- an agent session, copied from one tool and workspace to another.
 *
 * A copy never overwrites. Before writing, `copy` looks the target up by id across all of the
 * target platform's storage; when it exists, readable or not, the result is `reused` and nothing
 * is written, so turns a member added to the copy survive a retry. A failed write removes only
 * the target this call created, in the target workspace.
 *
 * Adapters stay behind this module. Expected failures are values, never exceptions.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMemberToolRoots } from '../config.js';
import { getTeamaiHomeDir, type LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { ADAPTER_REGISTRY, listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';
import { isSessionPlatform, sessionPlatformFacts } from './adapters/platform-facts.js';
import { sessionPlatformOwner, sessionPlatformsOf } from '../tools.js';
import { ToolUnavailableError, type AgentAdapter, type SessionMeta, type SubagentsRead } from './adapters/base.js';
import { imagePlaceholderText, type ContentBlock, type Message, type Session } from './ir.js';
import { deriveTargetSessionId, legacyTargetSessionIds } from './ids.js';
import { degradeThinkingBlocks, fidelityFromSession, type FidelityReport } from './migrate.js';
import { scrubSession } from './scrub.js';

/**
 * A session in one tool: its platform, its id there, and the workspace to look in. A caller that
 * listed the session passes the `filePath` it listed, so exactly that session is read.
 */
export type AgentSessionRef = { platform: string; sessionId: string; cwd?: string; filePath?: string };

export type AgentSessionFailure =
  | { code: 'no_adapter'; platform: string; reason: 'unknown tool' | 'unsupported on win32'; message: string }
  | { code: 'tool_unavailable'; platform: string; message: string }
  | { code: 'list_failed'; platform: string; message: string }
  | { code: 'not_found'; ref: AgentSessionRef; message: string }
  | { code: 'unreadable'; ref: AgentSessionRef; message: string }
  | { code: 'invalid_workspace'; cwd: string; message: string }
  | { code: 'write_failed'; platform: string; message: string }
  | { code: 'copy_busy'; platform: string; lockPath: string; message: string };

export type AgentSessionCopy =
  | {
      status: 'done';
      /** The target's id: the one just written, or the copy that already existed. */
      sessionId: string;
      /** The target workspace. */
      cwd: string;
      /** True when the target already existed and nothing was written. */
      reused: boolean;
      fidelity: FidelityReport;
      /** Secret-looking values replaced, when `scrub` was set. */
      redactedCount?: number;
      /** Where the copy was written, when the target tool lists it. */
      filePath?: string;
      /** The transcript was written, but the target tool may not list it. */
      notice?: string;
    }
  | { status: 'failed'; failure: AgentSessionFailure };

export type AgentSessionCopyRequest = {
  from: AgentSessionRef;
  /** `cwd` must be an absolute path. It need not exist: a deleted project still gets its copy. */
  to: { platform: string; cwd: string };
  /** Redact secret-looking values before writing. The copy stays on this machine, so off by default. */
  scrub?: boolean;
  /** Where the recorded tool roots come from; a run that copies many sessions passes one `toolRootsLookup()`. */
  toolRootsFor?: ToolRootsLookup;
};

export type AgentSessionFindOptions = {
  /** Redact secret-looking values; on by default. */
  scrub?: boolean;
  /** Where the recorded tool roots come from; a run that reads many sessions passes one `toolRootsLookup()`. */
  toolRootsFor?: ToolRootsLookup;
  /** Also read the agents the session started, into `subagents`; off by default, so the session itself is unchanged. */
  subagents?: boolean;
};

export type { Subagent, SubagentsRead } from './adapters/base.js';

export type AgentSessionFound =
  | {
      status: 'done';
      /** The session as stored, its id taken from what was opened, never from the request. */
      session: Session;
      /** Secret-looking values replaced, when `scrub` was set, the subagents' included. */
      redactedCount?: number;
      /** The agents the session started, when `subagents` was set. */
      subagents?: SubagentsRead;
    }
  | { status: 'failed'; failure: AgentSessionFailure };

/** One message of a session as text, in order: what a search indexes and a scorer reads. */
export type AgentSessionTranscriptEntry = {
  role: Message['role'];
  timestamp?: string;
  /** What the member and the agent wrote, with tool calls and their input; empty when none. */
  text: string;
  /** The tool results the message carries, each truncated; empty when none. */
  toolOutput: string;
};

/** A session a tool lists. Passed to `find` unchanged, it reads exactly this session. */
export type AgentSessionListed = AgentSessionRef &
  Pick<SessionMeta, 'cwd' | 'title' | 'createdAt' | 'updatedAt' | 'messageCount' | 'sizeBytes'>;

export type AgentSessionListQuery = {
  /** The tools to list; every installed tool when omitted. */
  platforms?: string[];
  /** The one workspace to list; every workspace of each tool when omitted. */
  cwd?: string;
  /** ISO 8601. Sessions last updated before it are left out. */
  updatedSince?: string;
  /** Also list the sessions a tool archived and `find` still reads, such as Codex's `archived_sessions/`. */
  archived?: boolean;
};

export type AgentSessionList = {
  /** Newest `updatedAt` first, across tools. */
  sessions: AgentSessionListed[];
  /** One per tool that could not be listed; the other tools' sessions are still returned. */
  failures: AgentSessionFailure[];
};

export type AgentSession = {
  list(query?: AgentSessionListQuery): Promise<AgentSessionList>;
  copy(request: AgentSessionCopyRequest): Promise<AgentSessionCopy>;
  find(ref: AgentSessionRef, options?: AgentSessionFindOptions): Promise<AgentSessionFound>;
  transcript(session: Session): AgentSessionTranscriptEntry[];
  platformForTool(tool: string): string | undefined;
  toolForPlatform(platform: string): string;
};

/**
 * Why TeamAI cannot use `platform` on this machine, or undefined when it can. `write` also
 * refuses a target whose copy would never show here. Every command that names a platform
 * reports this failure, so its message has this one home.
 */
export function noAdapter(
  platform: string,
  use: 'read' | 'write',
  os: NodeJS.Platform = process.platform,
): Extract<AgentSessionFailure, { code: 'no_adapter' }> | undefined {
  const known = listAvailablePlatforms();
  if (!known.includes(platform)) {
    return {
      code: 'no_adapter',
      platform,
      reason: 'unknown tool',
      message: `Unknown platform "${platform}". Known platforms: ${known.join(', ')}.`,
    };
  }
  if (use === 'write' && os === 'win32' && sessionPlatformFacts(platform)?.sqliteRegistrationOnWindows) {
    return {
      code: 'no_adapter',
      platform,
      reason: 'unsupported on win32',
      message:
        `Writing ${platform} sessions is not supported on Windows: ${platform} lists a session only after ` +
        'the sqlite3 CLI registers it, so the copy would never show. Pick another target platform.',
    };
  }
  return undefined;
}

type ToolRoots = LocalConfig['toolRoots'];

/**
 * The member's recorded tool roots as seen from `cwd`: a relocated Claude Code or Codex keeps its
 * sessions there. Read-only, so looking a session up never sets up a project.
 */
export const recordedToolRoots = (cwd: string | undefined): Promise<ToolRoots> =>
  resolveMemberToolRoots(cwd, { selfHeal: false, dryRun: true, suppressMigrationNotice: true });

export type ToolRootsLookup = (cwd: string | undefined) => Promise<ToolRoots>;

/** `recordedToolRoots` for one run: each workspace is resolved once, however many of its sessions are read. */
export function toolRootsLookup(): ToolRootsLookup {
  const byCwd = new Map<string | undefined, Promise<ToolRoots>>();
  return (cwd) => {
    let roots = byCwd.get(cwd);
    if (!roots) {
      roots = recordedToolRoots(cwd);
      byCwd.set(cwd, roots);
    }
    return roots;
  };
}

function adapterFor(platform: string, use: 'read' | 'write', toolRoots: ToolRoots): AgentAdapter | AgentSessionFailure {
  return noAdapter(platform, use) ?? ADAPTER_REGISTRY[platform](toolRoots);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const failed = (failure: AgentSessionFailure): AgentSessionCopy => ({ status: 'failed', failure });

async function readSource(source: AgentAdapter, ref: AgentSessionRef): Promise<Session | AgentSessionFailure> {
  try {
    return await source.readSession({ sessionId: ref.sessionId, projectPath: ref.cwd, filePath: ref.filePath });
  } catch (e) {
    if (e instanceof ToolUnavailableError) return { code: 'tool_unavailable', platform: ref.platform, message: e.message };
    const where = ref.filePath ? ` at ${ref.filePath}` : ref.cwd ? ` in ${ref.cwd}` : '';
    let exists: boolean;
    try {
      exists = ref.filePath ? fs.existsSync(ref.filePath) : Boolean(await source.existingSessionId(ref.sessionId, ref.cwd));
    } catch (probe) {
      // The tool could not tell whether the session exists.
      if (probe instanceof ToolUnavailableError) return { code: 'tool_unavailable', platform: ref.platform, message: probe.message };
      throw probe;
    }
    if (!exists) {
      return { code: 'not_found', ref, message: `No ${ref.platform} session ${ref.sessionId}${where}.` };
    }
    return {
      code: 'unreadable',
      ref,
      message: `The ${ref.platform} session ${ref.sessionId}${where} could not be read: ${messageOf(e)}`,
    };
  }
}

/**
 * The id of the copy of `sourceSessionId` that already exists in the target, or undefined.
 * `targetId` is the id `deriveTargetSessionId` gives the copy; it names the workspace, so it is
 * looked up anywhere on the platform. Ids an older TeamAI used did not name the workspace, so
 * they count only in `cwd`: a copy under one elsewhere is another workspace's.
 */
async function existingCopyId(
  target: AgentAdapter,
  copy: { targetId: string; cwd: string; sourcePlatform: string; targetPlatform: string; sourceSessionId: string },
): Promise<string | undefined> {
  const derived = await target.existingSessionId(copy.targetId);
  if (derived) return derived;
  for (const id of legacyTargetSessionIds(copy)) {
    const found = await target.existingSessionId(id, copy.cwd);
    if (found) return found;
  }
  return undefined;
}

export type CopyWrite =
  | {
      status: 'done';
      /** The target's id: the one just written, or the copy that already existed. */
      sessionId: string;
      /** True when the target already existed and nothing was written. */
      reused: boolean;
    }
  | {
      status: 'failed';
      failure: Extract<AgentSessionFailure, { code: 'invalid_workspace' | 'tool_unavailable' | 'write_failed' | 'copy_busy' }>;
    };

// A copy holds its lock for one existence check and one write (an OpenCode import, a sqlite3
// registration). Ten seconds covers that without leaving a command stuck.
const COPY_LOCK_ATTEMPTS = 100;
const COPY_LOCK_RETRY_MS = 100;

/**
 * Write `session`, read from `sourcePlatform`, into `target` in the workspace `cwd`, once. The
 * target id is derived; when a copy already exists, nothing is written and the result is
 * `reused`. A write that throws is rolled back: only the derived id, only in `cwd`, since the
 * target did not exist a moment ago. Every path that writes a session into a tool goes through here.
 *
 * The check, the write and the rollback run under a lock on this one target copy, keyed by the
 * target platform and the derived id (which names the workspace), so a second command copying
 * the same session there at once waits and then reuses the first copy instead of replacing it or
 * rolling it back. The lock lives under `~/.teamai/locks/`, like the session index lock.
 */
export async function writeCopyOnce(
  target: AgentAdapter,
  { session, sourcePlatform, cwd }: { session: Session; sourcePlatform: string; cwd: string },
): Promise<CopyWrite> {
  const targetPlatform = target.platform;
  let targetId: string;
  try {
    targetId = deriveTargetSessionId({
      targetPlatform,
      targetCwd: cwd,
      sourceSessionId: session.sessionId,
      sourceCreatedAt: session.createdAt,
    });
  } catch (e) {
    return { status: 'failed', failure: { code: 'invalid_workspace', cwd, message: messageOf(e) } };
  }

  const key = createHash('sha256').update(`${targetPlatform}\0${targetId}`).digest('hex').slice(0, 16);
  const lockPath = path.join(getTeamaiHomeDir(), 'locks', `session-copy-${key}.lock`);
  for (let attempt = 1; !(await acquireLock(lockPath)); attempt++) {
    if (attempt === COPY_LOCK_ATTEMPTS) {
      const message =
        `Another teamai command is writing this session into ${targetPlatform} in ${cwd} (lock ${lockPath}). ` +
        'Run this command again when it finishes.';
      return { status: 'failed', failure: { code: 'copy_busy', platform: targetPlatform, lockPath, message } };
    }
    await new Promise((resolve) => setTimeout(resolve, COPY_LOCK_RETRY_MS));
  }
  try {
    return await writeUnlessCopied(target, { session, sourcePlatform, cwd, targetId });
  } finally {
    await releaseLock(lockPath);
  }
}

/** `writeCopyOnce` past the id and the lock: the check, the write, and its rollback. */
async function writeUnlessCopied(
  target: AgentAdapter,
  { session, sourcePlatform, cwd, targetId }: { session: Session; sourcePlatform: string; cwd: string; targetId: string },
): Promise<CopyWrite> {
  const targetPlatform = target.platform;
  let existing: string | undefined;
  try {
    existing = await existingCopyId(target, { targetId, cwd, sourcePlatform, targetPlatform, sourceSessionId: session.sessionId });
  } catch (e) {
    // The target tool could not tell whether the copy exists, so writing could overwrite it.
    if (e instanceof ToolUnavailableError) {
      return { status: 'failed', failure: { code: 'tool_unavailable', platform: targetPlatform, message: e.message } };
    }
    throw e;
  }
  if (existing) return { status: 'done', sessionId: existing, reused: true };

  try {
    return { status: 'done', sessionId: await target.writeSession(session, cwd), reused: false };
  } catch (e) {
    let message = `Writing the ${targetPlatform} copy failed: ${messageOf(e)}`;
    try {
      await target.deleteSession(targetId, cwd);
    } catch (cleanup) {
      message += `. Removing the partial copy ${targetId} also failed: ${messageOf(cleanup)}`;
    }
    return { status: 'failed', failure: { code: 'write_failed', platform: targetPlatform, message } };
  }
}

/** Best-effort: the file the target tool lists for the copy. */
async function listedFilePath(target: AgentAdapter, sessionId: string, cwd: string): Promise<string | undefined> {
  try {
    return (await target.listConversations(cwd)).find((meta) => meta.sessionId === sessionId)?.filePath;
  } catch {
    return undefined;
  }
}

async function listPlatform(platform: string, cwd: string | undefined, toolRoots: ToolRoots, archived: boolean): Promise<AgentSessionList> {
  const adapter = adapterFor(platform, 'read', toolRoots);
  if ('code' in adapter) return { sessions: [], failures: [adapter] };
  if (!adapter.isReady()) {
    const message = `${platform} is not installed or its session storage directory was not found.`;
    return { sessions: [], failures: [{ code: 'tool_unavailable', platform, message }] };
  }
  let metas: SessionMeta[];
  try {
    metas = await (archived ? adapter.listConversations(cwd, { archived }) : adapter.listConversations(cwd));
  } catch (e) {
    const message = messageOf(e);
    if (e instanceof ToolUnavailableError) return { sessions: [], failures: [{ code: 'tool_unavailable', platform, message }] };
    return { sessions: [], failures: [{ code: 'list_failed', platform, message: `Listing ${platform} sessions failed: ${message}` }] };
  }
  const sessions = metas.map((meta): AgentSessionListed => ({
    platform,
    sessionId: meta.sessionId,
    cwd: meta.cwd,
    ...(meta.filePath ? { filePath: meta.filePath } : {}),
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.messageCount === undefined ? {} : { messageCount: meta.messageCount }),
    ...(meta.sizeBytes === undefined ? {} : { sizeBytes: meta.sizeBytes }),
  }));
  return { sessions, failures: [] };
}

/**
 * The sessions of the tools named, or of every installed tool. Tools are listed concurrently and
 * each failure is that tool's alone.
 */
async function list({ platforms, cwd, updatedSince, archived = false }: AgentSessionListQuery = {}): Promise<AgentSessionList> {
  const toolRoots = await recordedToolRoots(cwd);
  const listed = await Promise.all(
    (platforms ?? listInstalledPlatforms(toolRoots)).map((platform) => listPlatform(platform, cwd, toolRoots, archived)),
  );
  const since = updatedSince === undefined ? undefined : Date.parse(updatedSince);
  const sessions = listed
    .flatMap((one) => one.sessions)
    .filter((session) => since === undefined || Date.parse(session.updatedAt) >= since);
  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { sessions, failures: listed.flatMap((one) => one.failures) };
}

/**
 * Read one session. Redacted unless `scrub` is false: a new caller, such as a scorer, gets
 * redacted text without having to remember to ask for it.
 */
async function find(
  ref: AgentSessionRef,
  { scrub = true, toolRootsFor = recordedToolRoots, subagents = false }: AgentSessionFindOptions = {},
): Promise<AgentSessionFound> {
  const source = adapterFor(ref.platform, 'read', await toolRootsFor(ref.cwd));
  if ('code' in source) return { status: 'failed', failure: source };
  const session = await readSource(source, ref);
  if ('code' in session) return { status: 'failed', failure: session };
  const agents = subagents ? { subagents: await readSubagents(source, session, ref) } : {};
  if (!scrub) return { status: 'done', session, ...agents };
  const scrubbed = scrubSession(session);
  if (agents.subagents?.status !== 'read') return { status: 'done', session: scrubbed.session, redactedCount: scrubbed.redactedCount, ...agents };
  const read = agents.subagents.agents.map((agent) => ({ agent, scrubbed: scrubSession(agent.session) }));
  return {
    status: 'done',
    session: scrubbed.session,
    redactedCount: read.reduce((count, item) => count + item.scrubbed.redactedCount, scrubbed.redactedCount),
    subagents: { status: 'read', agents: read.map(({ agent, scrubbed: own }) => ({ ...agent, session: own.session })) },
  };
}

async function readSubagents(source: AgentAdapter, session: Session, ref: AgentSessionRef): Promise<SubagentsRead> {
  try {
    return await source.readSubagents(session, { sessionId: ref.sessionId, projectPath: ref.cwd, filePath: ref.filePath });
  } catch (e) {
    return { status: 'unread', reason: messageOf(e) };
  }
}

async function copy({ from, to, scrub = false, toolRootsFor = recordedToolRoots }: AgentSessionCopyRequest): Promise<AgentSessionCopy> {
  const source = adapterFor(from.platform, 'read', await toolRootsFor(from.cwd));
  if ('code' in source) return failed(source);
  const targetToolRoots = await toolRootsFor(to.cwd);
  const target = adapterFor(to.platform, 'write', targetToolRoots);
  if ('code' in target) return failed(target);
  if (!target.isReady()) {
    return failed({
      code: 'tool_unavailable',
      platform: to.platform,
      message:
        `Target platform "${to.platform}" is not installed or its storage directory was not found. ` +
        `Install the client first, or pick another target (available: ${listInstalledPlatforms(targetToolRoots).join(', ') || 'none'}).`,
    });
  }

  const session = await readSource(source, from);
  if ('code' in session) return failed(session);

  // Scrub before measuring, measure before degrading: the report counts exactly what is lost or
  // degraded on the way into the target, the same numbers the --dry-run preview shows.
  // A local copy keeps image file paths, so the target can still open the file.
  const scrubbed = scrub ? scrubSession(session, { dropImagePaths: false }) : null;
  const base = scrubbed ? scrubbed.session : session;
  const fidelity = fidelityFromSession(base, to.platform);
  const redacted = scrubbed ? { redactedCount: scrubbed.redactedCount } : {};

  const write = await writeCopyOnce(target, {
    session: degradeThinkingBlocks(base, to.platform),
    sourcePlatform: from.platform,
    cwd: to.cwd,
  });
  if (write.status === 'failed') return failed(write.failure);
  if (write.reused) return { status: 'done', sessionId: write.sessionId, cwd: to.cwd, reused: true, fidelity, ...redacted };
  const notice = target.consumeWriteNotice();
  const filePath = await listedFilePath(target, write.sessionId, to.cwd);
  return {
    status: 'done',
    sessionId: write.sessionId,
    cwd: to.cwd,
    reused: false,
    fidelity,
    ...redacted,
    ...(filePath ? { filePath } : {}),
    ...(notice ? { notice } : {}),
  };
}

/**
 * A tool result keeps this many characters. Whole file reads and build logs would otherwise
 * dominate the transcript: the length search normalizes by, and the prompt a scorer reads.
 */
const TOOL_RESULT_MAX_CHARS = 2_000;

function truncated(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)} [truncated ${text.length - TOOL_RESULT_MAX_CHARS} chars]`;
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'thinking':
      return `[thinking] ${block.text}`;
    case 'tool_call':
      return `[tool_call] ${block.toolName} ${JSON.stringify(block.arguments)}`;
    case 'tool_result':
      return `[tool_result${block.isError ? ' error' : ''}] ${truncated(block.content)}`;
    case 'image':
      return imagePlaceholderText(block);
    default: {
      const unhandled: never = block;
      return unhandled;
    }
  }
}

/**
 * One entry per message, so a match or a judgement cites the message it came from. Tool calls
 * carry their input as JSON in `text`; tool results, which arrive as user messages, sit apart in
 * `toolOutput`, so they never read as something the member typed and search can weigh them less.
 * Redaction is the caller's: pass a redacted session.
 */
function transcript(session: Session): AgentSessionTranscriptEntry[] {
  return session.messages.map((message) => ({
    role: message.role,
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    text: message.content.filter((block) => block.type !== 'tool_result').map(blockText).join('\n'),
    toolOutput: message.content.filter((block) => block.type === 'tool_result').map(blockText).join('\n'),
  }));
}

/**
 * The session platform a tool (a workflow step's `tool`) reads and writes: the first of its
 * `TOOLS` entry's `sessions`, or a platform named directly. Undefined when it has none.
 */
function platformForTool(tool: string): string | undefined {
  return sessionPlatformsOf(tool)[0] ?? (isSessionPlatform(tool) ? tool : undefined);
}

/** The tool whose sessions `platform` holds, the reverse of `platformForTool`. */
function toolForPlatform(platform: string): string {
  return sessionPlatformOwner(platform) ?? sessionPlatformFacts(platform)?.tool ?? platform;
}

export const AgentSession = { list, copy, find, transcript, platformForTool, toolForPlatform } as const satisfies AgentSession;
