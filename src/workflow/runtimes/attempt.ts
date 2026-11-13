import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { storeDirOf } from '../../session-flow/adapters/index.js';
import { sessionPlatformFacts } from '../../session-flow/adapters/platform-facts.js';
import { AgentSession } from '../../session-flow/agent-session.js';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { homeEnvOf, realHost, toolHomeOf } from '../../tool-home.js';
import { baseToolOf } from '../../tool-registry.js';
import { isRecord } from '../expression.js';
import { log } from '@teamai/shared/log';
import type { LaunchTool } from '../../launch-registry.js';
import { getDataHome, type LocalConfig } from '../../types.js';
import { withFileLock } from '../../update.js';
import { errnoCode, writeJsonAtomic } from '../../utils/fs.js';
import { attemptDir, AttemptIdSchema, attemptResultPath, attemptsDir, isRunHere, RunIdSchema, RUNS_REMOVAL_LOCK_WAIT, runsRemovalLockIn, type AttemptId, type RunId } from '../store.js';
import type { WorkflowFailure } from '../types.js';
import type { SessionRef } from '../workspace.js';
import { redact } from '@teamai/shared/redact';
import { AttemptResult } from '../attempt-result.js';
import { loginFileOf } from './login.js';
import { CANCEL_FAILED, CanSchema, OpIdSchema, RuntimeDisplaySchema, RuntimeFailureSchema, type OpId, type OpState, type PlaceView, type RuntimeDisplay, type RuntimeFailure } from '@teamai/runtime-protocol';
import { isUnansweredFailure, newOpId, type Accepted, type ExecEnd, type ExecEvents, type ExecKind, type ExecRequest, type Lost, type PromptEnd, type PromptRequest, type StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import type { DriverCan } from '../requirements.js';
import { copyRegularTree, readRegularFile } from '@teamai/shared/regular-file';

// ─── An attempt on a step runtime ────────────────────────
//
//  attempts/<attempt>/runtime.json records which runtime an attempt runs on, the operation ids teamai sent it, and,
//  once accepted, the runtime's handle. Each id is written before its request is sent, so a teamai killed between a
//  runtime's reply and its own write sends the same id again (a repeated open returns the same handle) or reattaches
//  and reads the outcome the runtime retained. The attempt's tool home sits beside it, never in the member's home.
//

/** The tools a step runtime that execs can launch: their session store moves with one variable, into the attempt's tool home. */
// oxlint-disable-next-line teamai/tool-facts -- a fixed-id table of what step runtimes decided to run, kept apart from TOOLS on purpose; tools without one home variable (OpenCode, Pi) stay out
export const EXEC_RUNTIME_TOOLS = ['claude', 'codex', 'codebuddy'] as const satisfies readonly LaunchTool[];

/** A runtime's credential values, labelled for masking: each is masked as a team secret is, whatever its name looks like. */
export function credentialSecrets(use: string, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [`${name} (credential of ${use})`, value]));
}

export type ExecRuntimeTool = (typeof EXEC_RUNTIME_TOOLS)[number];

export function isExecRuntimeTool(tool: string): tool is ExecRuntimeTool {
  return EXEC_RUNTIME_TOOLS.some((known) => known === tool);
}

/**
 * Whether `tool`, or the tool an instance extends, keeps its sessions in XDG data (OpenCode): the session home a runtime
 * reports for it is then the directory the tool uses as `XDG_DATA_HOME`, not a tool home.
 */
function keepsSessionsInXdgData(tool: string): boolean {
  const platform = AgentSession.platformForTool(baseToolOf(tool));

  return platform !== undefined && sessionPlatformFacts(platform)?.store.in === 'xdg-data';
}


const PHASES = ['opening', 'ready', 'running', 'collected', 'closed'] as const;

/** A tool's home: the tool, and the directory its sessions are kept under. */
const ToolHomeSchema = z.object({ tool: z.string(), dir: z.string() });

/**
 * Where one runtime an attempt runs on came from: the resource found for it (`t3`, or teamai's `teamai-t3`), its layer,
 * where a person finds it, and its revision, a folder's (`folderRevision`) or the sha256 of a file's content.
 */
const RuntimeOriginSchema = z.object({
  runtime: z.string(), layer: z.enum(['personal', 'team', 'teamai']), location: z.string(), revision: z.string(),
  /** For the sandbox runtime: the sandbox profile it ran, as the runtime is named, its provider, and what its init said it enforces. */
  sandbox: z.object({
    profile: z.string(), layer: z.enum(['personal', 'team', 'teamai']), location: z.string(), revision: z.string(), provider: z.string(),
    enforces: CanSchema.pick({ isolation: true, network: true, tokens: true, max_turns: true }),
  }).optional(),
});

export type RuntimeOrigin = z.infer<typeof RuntimeOriginSchema>;

const AttemptRuntimeRecordSchema = z.object({
  /** The runtime the attempt runs on, as the definition's `use` names it. */
  runtime: z.string(),
  /** The driver definition that chose it. */
  driver: z.string(),
  /** Where each runtime it runs on came from, the inner one first for one through another; none for one teamai builds in. */
  sources: z.array(RuntimeOriginSchema).optional(),
  phase: z.enum(PHASES),
  open: z.object({ op: OpIdSchema, handle: z.string().optional() }),
  exec: z.object({ op: OpIdSchema }).optional(),
  /** The workflow's setup, run as an exec of the place before the step's own. */
  setup: z.object({ op: OpIdSchema }).optional(),
  /**
   * The prompt sent to a runtime that launches agents its own way, and the conversation its lease continues
   * (`PromptLease.continue`), when it names one.
   */
  prompt: z.object({ op: OpIdSchema, continues: z.object({ handle: z.string(), op: OpIdSchema }).optional() }).optional(),
  /**
   * Set once the attempt reported, on a runtime that keeps conversations (`HeldPlace.holdsOn`): the place stays open
   * for the conversation its prompt launched, whose session is `conversation`, since a step that has not settled
   * continues it in `workspace`, the one the attempt's step shares with it. The local driver closes it as soon as none does
   * (`continuedConversations`), at the run's end, on a cancel or a release. A closed record holds none (`closedRecord`).
   */
  heldFor: z.object({ conversation: z.object({ tool: z.string(), id: z.string() }), workspace: z.string() }).optional(),
  /** The attempt's tool home, for a prompt: the tool and its directory. */
  toolHome: ToolHomeSchema.optional(),
  /**
   * The tool home outside the attempt that a runtime launching agents its own way reported its prompt's session in
   * (`finished.session.home`), such as a T3 provider instance's. teamai reads the session there and never copies it.
   */
  sessionHome: ToolHomeSchema.optional(),
  /** What the runtime last showed of the place, at `ready` or at a reattach, for the run's details. */
  display: RuntimeDisplaySchema.optional(),
  /**
   * Why the runtime could not close the place, which may still hold what ran there, for the run's details. Kept on a
   * `closed` place only when the person released it without the runtime's close.
   */
  closeFailed: RuntimeFailureSchema.optional(),
  /**
   * Why the open failed after the runtime accepted the place. A restarted teamai answers it instead of sending the open
   * again, which a runtime through another could answer with less of the place than the first open made.
   */
  openFailed: RuntimeFailureSchema.optional(),
});

export type AttemptRuntimeRecord = z.infer<typeof AttemptRuntimeRecordSchema>;

/** Where attempt `attempt` of run `run` records its runtime (`AttemptRuntimeRecord`). */
export function attemptRuntimePath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return attemptRuntimeFile(attemptDir(config, run, attempt));
}

/** The runtime record of the attempt whose directory is `dir`. */
export function attemptRuntimeFile(dir: string): string {
  return path.join(dir, 'runtime.json');
}

/**
 * The record of an attempt that runs in teamai's own process, on the host slot or `tools`, in the file an external
 * runtime's attempt records itself in. It is written before the attempt starts, so a restart tells an attempt that ran
 * here from one whose record is gone.
 */
const InProcessAttemptRecordSchema = z.object({
  /** The in-process runtime, as the definition's `use` names it. */
  runtime: z.string(),
  driver: z.string(),
  inProcess: z.literal(true),
  /**
   * The tool home a prompt's tool ran with when the step's environment named one, as a member's `CODEX_HOME` outside
   * HOME does, which teamai does not record as the tool's root: its session is read there.
   */
  sessionHome: ToolHomeSchema.optional(),
}).strict();

/** What `runtime.json` holds: an attempt in teamai's process, or one on an external step runtime. */
const AttemptRecordSchema = z.union([InProcessAttemptRecordSchema, AttemptRuntimeRecordSchema]);

/**
 * Where an attempt ran, by its record: on an external runtime, in teamai's process, nowhere this teamai recorded, or
 * unknown, from a record that is there but cannot be read (`why`).
 */
export type AttemptPlacement =
  | { kind: 'external'; record: AttemptRuntimeRecord }
  | { kind: 'in_process'; runtime: string; sessionHome?: z.infer<typeof ToolHomeSchema> }
  | { kind: 'unrecorded' }
  | { kind: 'unreadable'; why: string };

/** Records that attempt `attempt` of run `run` runs in teamai's process, on `runtime` of driver `driver`. */
export async function recordInProcessAttempt(config: LocalConfig, run: RunId, attempt: AttemptId, { runtime, driver }: { runtime: string; driver: string }): Promise<void> {
  await writeJsonAtomic(attemptRuntimePath(config, run, attempt), { runtime, driver, inProcess: true } satisfies z.infer<typeof InProcessAttemptRecordSchema>);
}

/**
 * Records `home`, the tool home the prompt of in-process attempt `attempt` of run `run` runs its tool with, in the
 * attempt's record, before the tool starts, so its session is read there. An attempt without an in-process record did
 * not start in this process, and its session is read where it was before.
 */
export async function recordInProcessSessionHome(config: LocalConfig, run: RunId, attempt: AttemptId, home: z.infer<typeof ToolHomeSchema>): Promise<void> {
  const read = await readAttemptRecord(config, run, attempt);

  if (read.kind === 'unreadable') log.warn(`The runtime record of attempt ${attempt} cannot be read (${read.why}), so teamai looks for its session in the tool's own home.`);

  if (read.kind === 'recorded' && 'inProcess' in read.record) {
    await writeJsonAtomic(attemptRuntimePath(config, run, attempt), { ...read.record, sessionHome: home } satisfies z.infer<typeof InProcessAttemptRecordSchema>);
  }
}

/** The record of attempt `attempt` of run `run`. */
function readAttemptRecord(config: LocalConfig, run: RunId, attempt: AttemptId) {
  return readAttemptRecordAt(attemptRuntimePath(config, run, attempt));
}

/** The attempt record in `file`, an attempt's `runtime.json`: the one reader of that file. */
async function readAttemptRecordAt(file: string): Promise<{ kind: 'recorded'; record: z.infer<typeof AttemptRecordSchema> } | { kind: 'unrecorded' } | { kind: 'unreadable'; why: string }> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readRegularFile(file, 'utf8'));
  } catch (error) {
    return errnoCode(error) === 'ENOENT' ? { kind: 'unrecorded' } : { kind: 'unreadable', why: error instanceof Error ? error.message : String(error) };
  }

  const record = AttemptRecordSchema.safeParse(parsed);

  return record.success ? { kind: 'recorded', record: record.data } : { kind: 'unreadable', why: 'it is not a runtime record this teamai knows' };
}

/** Where attempt `attempt` of run `run` ran, by its record. */
export function readAttemptPlacement(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<AttemptPlacement> {
  return readAttemptPlacementAt(attemptRuntimePath(config, run, attempt));
}

/** Where the attempt whose record is `file`, an attempt's `runtime.json`, ran. */
export async function readAttemptPlacementAt(file: string): Promise<AttemptPlacement> {
  const read = await readAttemptRecordAt(file);

  if (read.kind !== 'recorded') return read;

  if ('inProcess' in read.record) {
    const { runtime, sessionHome } = read.record;

    return { kind: 'in_process', runtime, ...(sessionHome && { sessionHome }) };
  }

  return { kind: 'external', record: read.record };
}

/** Whether `placement` is a place an external step runtime still keeps open: one a cancel closes, and one nothing should leave. */
export function isPlaceLeftOpen(placement: AttemptPlacement): placement is Extract<AttemptPlacement, { kind: 'external' }> {
  return placement.kind === 'external' && placement.record.phase !== 'closed';
}

/** The record of attempt `attempt` of run `run` when it holds a place on an external step runtime; undefined for any other placement. */
async function externalRecord(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<AttemptRuntimeRecord | undefined> {
  const placement = await readAttemptPlacement(config, run, attempt);

  return placement.kind === 'external' ? placement.record : undefined;
}

/**
 * Whether `record` holds a setup that may still run: sent, its work not brought back yet (a setup that ended is
 * collected before the place is ready), and no step exec or prompt sent after it.
 */
function isSetupLeftRunning(record: AttemptRuntimeRecord): boolean {
  return record.setup !== undefined && record.phase === 'running' && record.exec === undefined && record.prompt === undefined;
}

/**
 * Records the place of attempt `attempt` as no longer teamai's to close, without its runtime's close, once the person
 * checked that nothing of it still runs. Why the runtime could not close it stays in the record.
 */
export async function releaseAttemptRuntime(config: LocalConfig, run: RunId, attempt: AttemptId, record: AttemptRuntimeRecord): Promise<void> {
  await writeJsonAtomic(attemptRuntimePath(config, run, attempt), closedRecord(record));
}

/** `record` closed: a closed place holds no conversation open, so it drops `heldFor` with its phase. */
function closedRecord({ heldFor: _released, ...record }: AttemptRuntimeRecord): AttemptRuntimeRecord {
  return { ...record, phase: 'closed' };
}

/** Masks the result file of every attempt of `run` with `secrets`, so one that ended without a report, on a signal or a killed driver too, keeps no secret. */
export async function maskAttemptResults(config: LocalConfig, run: RunId, secrets: Record<string, string>): Promise<void> {
  const names = await fs.readdir(attemptsDir(config, run)).catch((): string[] => []);

  const attempts = names.flatMap((name) => {
    const attempt = AttemptIdSchema.safeParse(name);

    return attempt.success ? [attempt.data] : [];
  });

  await Promise.all(attempts.map((attempt) => AttemptResult.mask(attemptResultPath(config, run, attempt), secrets)));
}

/** The tool home of `tool` for attempt `attempt`: under the attempt directory, beside its record. */
export function attemptToolHome(config: LocalConfig, run: RunId, attempt: AttemptId, tool: string): string {
  return path.join(attemptDir(config, run, attempt), 'tool-home', tool);
}

/**
 * Where the sessions of attempt `attempt` of run `run` are: the store in the tool home its record names, or undefined
 * when it ran in the member's own home. Every lookup of a run step's session passes it on (`AgentSessionRef.storeDir`).
 */
export async function attemptSessionStore(config: LocalConfig, run: string, attempt: string | undefined): Promise<string | undefined> {
  const runId = RunIdSchema.safeParse(run);
  const attemptId = AttemptIdSchema.safeParse(attempt);

  if (!runId.success || !attemptId.success) return undefined;
  const placement = await readAttemptPlacement(config, runId.data, attemptId.data);
  const home = placement.kind === 'external' ? placement.record.toolHome ?? placement.record.sessionHome : placement.kind === 'in_process' ? placement.sessionHome : undefined;
  // An instance, as a runtime that launches agents its own way records it, is read as the tool it extends.
  const platform = home && (isExecRuntimeTool(baseToolOf(home.tool)) || keepsSessionsInXdgData(home.tool)) ? AgentSession.platformForTool(home.tool) : undefined;
  const store = home && platform ? storeDirOf(platform, { kind: 'tool-home', dir: home.dir }) : '';

  return store === '' ? undefined : store;
}

/**
 * The attempt of run `run` whose tool home holds session `session` of its tool, with that home's store, or undefined
 * when no attempt that ran on a step runtime holds it (the session is then in the member's own store, if anywhere).
 * `isOwn` says the home is the attempt's own, under its directory, rather than one a runtime reported outside it.
 */
export async function attemptHoldingSession(config: LocalConfig, run: string, session: { tool: string; id: string }): Promise<{ attempt: AttemptId; home: string; isOwn: boolean; storeDir: string } | undefined> {
  const runId = RunIdSchema.safeParse(run);
  const platform = AgentSession.platformForTool(session.tool);

  if (!runId.success || !platform) return undefined;
  const names = await fs.readdir(attemptsDir(config, runId.data)).catch(() => []);

  for (const name of names.sort()) {
    const attempt = AttemptIdSchema.safeParse(name);
    const record = attempt.success ? await externalRecord(config, runId.data, attempt.data) : undefined;
    const home = record?.toolHome ?? record?.sessionHome;

    // A runtime that execs the tool records the home under the tool an instance extends; its session names the instance.
    if (!attempt.success || home === undefined || baseToolOf(home.tool) !== baseToolOf(session.tool)) continue;
    const storeDir = storeDirOf(platform, { kind: 'tool-home', dir: home.dir });

    if (storeDir === '') continue;
    const found = await AgentSession.find({ platform, sessionId: session.id, storeDir }, { scrub: false });

    if (found.status === 'done') return { attempt: attempt.data, home: home.dir, isOwn: record?.toolHome !== undefined, storeDir };
  }

  return undefined;
}

// ─── A place held open for a conversation ───────────────
//
//  A prompt on a runtime that keeps conversations (its init answered `conversations`) launches a conversation (a T3
//  thread, a Paseo agent) in its attempt's place. Once the attempt reported, the place is held open (`heldFor`) while a step that has not settled
//  continues that conversation in the workspace the attempt's step worked in, so that step's prompt is a new turn of it
//  (`PromptLease.continue`). A step with a place of its own, such as a top-level step, starts a new conversation, so no
//  place is held for it. The record is the one owner of that state:
//
//    reported ──hold (a later step continues its conversation, in its workspace)──▶ held ──release (none does, run end, cancel)──▶ closed
//        └──────────────────────────── any other report ──────────────────────────────────────────────────────▶ closed
//
//  A held place takes no room under `max_parallel`. Its exits are the driver's close after a report, at the run's end
//  and on a handoff, and `teamai workflow cancel` / `--release`, which close every place whose record is not closed.
//

/**
 * Whether a place on `slot` may be held for a conversation: on a runtime entry that launches agents its own way and whose
 * init said a prompt's conversation outlives the prompt in its place (`conversations`), as T3's and Paseo's do. One that launches a tool per prompt keeps
 * nothing to continue, so none of its places is held. A place through another runtime is never held, as it would keep
 * the step's credentials past the step.
 */
function holdsOn(slot: { kind: 'host' | 'tools' | 'external'; launchesAgents: boolean; keepsConversations?: true; isThrough?: true } | undefined): boolean {
  return slot?.kind === 'external' && slot.launchesAgents && slot.keepsConversations === true && slot.isThrough !== true;
}

/** A held place: the attempt and its record, whose `heldFor` names the conversation. */
type Held = { attempt: AttemptId; record: AttemptRuntimeRecord & { heldFor: NonNullable<AttemptRuntimeRecord['heldFor']> } };

const isSameSession = (one: SessionRef, other: SessionRef): boolean => one.tool === other.tool && one.id === other.id;

/** A conversation a step that has not settled goes on in, and the workspace it goes on in. */
type Continued = SessionRef & { workspace: string };

const continuesIn = (continued: readonly Continued[], conversation: SessionRef, workspace: string): boolean =>
  continued.some((session) => isSameSession(session, conversation) && session.workspace === workspace);

/** The places of run `run` held open for a conversation. */
async function heldIn(config: LocalConfig, run: RunId): Promise<Held[]> {
  const names = await fs.readdir(attemptsDir(config, run)).catch((): string[] => []);
  const held: Held[] = [];

  for (const name of names.sort()) {
    const attempt = AttemptIdSchema.safeParse(name);
    const record = attempt.success ? await externalRecord(config, run, attempt.data) : undefined;

    if (attempt.success && record?.heldFor) held.push({ attempt: attempt.data, record: { ...record, heldFor: record.heldFor } });
  }

  return held;
}

/**
 * The conversation a prompt continues: the place of an earlier attempt of run `run`, held on runtime `runtime` of driver
 * `driver` in `workspace` (the one the prompt's step shares with the steps beside it) for the first of `sessions` (the
 * lease's session, then each earlier one), with the op of the prompt that launched it. Undefined when no held place
 * holds one, and for a step with no shared workspace, which goes on in none, as `hold` holds none for it.
 */
async function conversationOf({ config, run, runtime, driver, sessions, workspace }: { config: LocalConfig; run: RunId; runtime: string; driver: string; sessions: readonly SessionRef[]; workspace: string | undefined }): Promise<{ handle: string; op: OpId; session: SessionRef } | undefined> {
  if (workspace === undefined) return undefined;
  const held = await heldIn(config, run);

  for (const session of sessions) {
    const found = held.find(({ record }) => record.runtime === runtime && record.driver === driver && record.heldFor.workspace === workspace && isSameSession(record.heldFor.conversation, session));
    const handle = found?.record.open.handle;
    const op = found?.record.prompt?.op;

    if (handle !== undefined && op !== undefined) return { handle, op, session: { tool: session.tool, id: session.id } };
  }

  return undefined;
}

/**
 * Holds the place of attempt `attempt`, which reported `report`, open for the conversation its prompt launched, when
 * `continued` (the conversations the steps that have not settled continue) names it in `workspace`, the one the
 * attempt's step shares with the steps beside it. A step with no shared workspace holds none. A prompt the runtime took
 * as a turn of an earlier attempt's conversation launched none: that attempt's place holds it. Answers whether it is held.
 */
async function hold({ config, run, attempt, report, continued, workspace }: { config: LocalConfig; run: RunId; attempt: AttemptId; report: { tool?: string; session?: string; resumed?: SessionRef }; continued: readonly Continued[]; workspace: string | undefined }): Promise<boolean> {
  const record = await externalRecord(config, run, attempt);

  if (workspace === undefined || !record?.prompt || record.phase === 'closed' || !report.tool || !report.session || (record.prompt.continues && report.resumed)) return false;
  const conversation = { tool: report.tool, id: report.session };

  if (!continuesIn(continued, conversation, workspace)) return false;
  await writeJsonAtomic(attemptRuntimePath(config, run, attempt), { ...record, heldFor: { conversation, workspace } });

  return true;
}

/** The held places of run `run` to close: those whose conversation `continued` no longer names in their workspace, or, without it, every one. */
async function toRelease(config: LocalConfig, run: RunId, continued?: readonly Continued[]): Promise<Held[]> {
  const held = await heldIn(config, run);

  return continued === undefined ? held : held.filter(({ record }) => !continuesIn(continued, record.heldFor.conversation, record.heldFor.workspace));
}

/** The places held open for a conversation a later step continues (`heldFor`), and the moves between their states. */
export const HeldPlace = { conversationOf, hold, holdsOn, toRelease } as const;

const isCopied = (stats: Stats): boolean => stats.isFile() || stats.isDirectory() || stats.isSymbolicLink();

/**
 * The session a prompt on a step runtime resumes: the first of `sessions` (the lease's, then each earlier one it
 * continued) that an earlier attempt of run `run` kept in its tool home for `tool`. That home is copied into the home of
 * `attempt`, where the tool resumes it. Undefined when no earlier attempt holds one, and the tool starts a new session.
 */
export async function seedToolHome({ config, run, attempt, tool, sessions }: { config: LocalConfig; run: RunId; attempt: AttemptId; tool: string; sessions: SessionRef[] }): Promise<SessionRef | undefined> {
  for (const session of sessions.filter((candidate) => candidate.tool === tool)) {
    const holding = await attemptHoldingSession(config, run, session);

    // A home outside the attempt is the runtime's, such as the member's own instance home: it is never copied whole.
    if (holding === undefined || !holding.isOwn) continue;

    // A home this attempt already has, from before a restart, keeps what its tool wrote there. The login stays behind:
    // only the lock that holds it may copy it, so a step on a runtime that holds no login never gets one.
    const login = loginFileOf(tool);
    const kept = login === undefined ? undefined : path.join(holding.home, login);

    // Only files, directories and links are copied: a FIFO or socket the earlier step left there is no part of its session.
    if (holding.attempt !== attempt) await copyRegularTree(holding.home, attemptToolHome(config, run, attempt, tool), { existing: 'keep', filter: async (source) => source !== kept && isCopied(await fs.lstat(source)) });

    return session;
  }

  return undefined;
}

/**
 * The member's own model choices for each tool, which an attempt's tool home starts with: the settings file under the
 * tool's home, and the keys of it that choose the model. No other key is copied: never an `env`, a credential, a hook,
 * a permission rule or an MCP server.
 */
const MODEL_CHOICES: Record<ExecRuntimeTool, { file: string; format: 'json' | 'toml'; keys: readonly string[] } | undefined> = {
  claude: { file: 'settings.json', format: 'json', keys: ['model', 'effortLevel', 'modelSettings'] },
  codex: { file: 'config.toml', format: 'toml', keys: ['model', 'model_reasoning_effort'] },
  // Not decided yet: a CodeBuddy attempt home starts with none of the member's settings.
  codebuddy: undefined,
};

/**
 * Starts the tool home `dir` of an attempt on `tool` with the member's model choices, read from `memberHome`, the
 * member's own home of that tool. A home that already has the settings file, from a predecessor or a restart, keeps it.
 * A step's own `model` still wins, as the launch names it.
 */
export async function seedMemberModel({ tool, dir, memberHome }: { tool: ExecRuntimeTool; dir: string; memberHome: string }): Promise<void> {
  const choices = MODEL_CHOICES[tool];

  if (choices === undefined) return;
  const target = path.join(dir, choices.file);

  if (await fs.access(target).then(() => true, () => false)) return;
  const text = await readRegularFile(path.join(memberHome, choices.file), 'utf8').catch(() => undefined);

  if (text === undefined) return;
  let parsed: unknown;

  try {
    parsed = choices.format === 'json' ? JSON.parse(text) : parseToml(text);
  } catch (error) {
    log.warn(`Could not read your ${tool} model choices from ${path.join(memberHome, choices.file)} (${error instanceof Error ? error.message : String(error)}), so the step's ${tool} starts with its own defaults.`);

    return;
  }

  if (!isRecord(parsed)) return;
  const picked = Object.fromEntries(choices.keys.flatMap((key) => (parsed[key] === undefined ? [] : [[key, parsed[key]]])));

  if (Object.keys(picked).length === 0) return;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(target, choices.format === 'json' ? `${JSON.stringify(picked, null, 2)}\n` : stringifyToml(picked), { flag: 'wx' });
}

/** The variable `tool`'s session store follows, set to its home in the attempt, or undefined for a tool no exec runtime runs. */
export function toolHomeVariable(tool: string): string | undefined {
  return isExecRuntimeTool(tool) ? homeEnvOf(tool) : undefined;
}

/**
 * What a restart found of an exec it had sent: the outcome, or that it was still running and is now stopped; or, on a
 * runtime whose execs go on without teamai, that this teamai stopped and left the exec running there.
 */
export type AttemptExecEnd = ExecEnd | { kind: 'interrupted' } | { kind: 'left' };

/**
 * One attempt on a step runtime: it opens the place, runs one exec, and finishes with collect and close, each under an
 * id persisted in the attempt's record before it is sent. Built again after a restart, it reopens on the same handle and
 * reads the outcome of the exec it had sent instead of running it again.
 */
export interface AttemptRun {
  /**
   * Opens the place, with what of the host it gets, or with nothing for a confined prompt's place. `toolHome` is the
   * tool home a prompt's tool keeps its session in, recorded for every later lookup; `credentials` are the values its
   * tool gets, sent and never recorded; `tool` is the tool its prompt runs, which the runtime is told; `unset`, for an
   * entry through another runtime, the names its prompt goes without, which the outer keeps from the tool.
   */
  open(view: PlaceView | undefined, place?: { tool?: string; toolHome?: z.infer<typeof ToolHomeSchema>; credentials?: Record<string, string>; unset?: string[] }): Promise<{ ok: true; handle: string } | { ok: false; failure: WorkflowFailure }>;
  /** Runs the step's `command`, or a prompt step's `tool`, as the attempt's one exec. */
  exec(request: Omit<ExecRequest, 'op' | 'handle'>, events: ExecEvents, kind: Exclude<ExecKind, 'setup'>): Promise<AttemptExecEnd>;
  /**
   * Runs the workflow's setup as an exec of the open place, recorded apart from the step's exec, under a new id. A setup
   * a teamai before this one left is stopped before its place is prepared again (`stopLeftSetup`), and here again for a
   * caller that did not.
   */
  setup(request: Omit<ExecRequest, 'op' | 'handle'>, events: ExecEvents): Promise<AttemptExecEnd>;
  /**
   * Stops the setup a killed teamai left running, before the place it ran in is prepared again: on a runtime that
   * mounts the host's folders, it would go on writing into the new one. Ends `lost` when the stop is not confirmed, so
   * the place is kept; undefined once it is, or when no setup was left.
   */
  stopLeftSetup(): Promise<Lost | undefined>;
  /**
   * Closes the place on the runtime once its setup is stopped, when the prepare makes the place's folder again: a
   * runtime that mounted the old folder (a container) cannot reach the new one, so the next open makes a new place.
   * Ends `lost` when the runtime does not confirm the close, so the place is kept; undefined once it does, or when no
   * place is open there.
   */
  closeForRemadeFolder(): Promise<Lost | undefined>;
  /**
   * Sends the prompt step to a runtime that launches agents its own way. Built again after a restart, it reads the
   * outcome the runtime kept, or reconnects to the prompt still running by sending the same id again.
   */
  prompt(request: Omit<PromptRequest, 'op' | 'handle'>, events: { onAccepted?: (accepted: Accepted) => void }): Promise<PromptEnd>;
  /** Stops the exec or prompt running now, with every process it started. */
  cancel(): Promise<void>;
  /**
   * This teamai stops: an exec on a runtime whose execs go on without it (`StepRuntime.isExecReconnected`) is left
   * running there and ends `left`, for a later teamai to reconnect to; any other is cancelled. An operation the run
   * already asked to `cancel` is not left: the stop waits for that cancel.
   */
  stop(): Promise<void>;
  /**
   * Brings the place's work back to the host, after success and after failure, before teamai reads the result or commits.
   * After an exec or prompt that ended `lost` it brings nothing back, since what ran there may still write the place.
   */
  collect(): Promise<WorkflowFailure | undefined>;
  /**
   * Closes the handle once the attempt's report is recorded, so a teamai killed before that still reattaches. A runtime
   * that cannot, or no longer answers, leaves the place open: its failure is recorded on the attempt and returned. So
   * does an exec or prompt that ended `lost`, whose work may still run there: the place is not closed under it.
   * `release` tells the runtime the person let the attempt go (`StepRuntime.close`).
   */
  close(how?: { release: true }): Promise<WorkflowFailure | undefined>;
  /**
   * Stops the exec or prompt a killed teamai left running, for a run cancelled without a live driver, and waits until
   * the runtime no longer reports it running. Answers why the stop is not confirmed, in the runtime's own words when it
   * gave them, or undefined once it is.
   */
  stopLeftOperation(): Promise<RuntimeFailure | undefined>;
}

/** How long a restarted teamai waits for an exec it found running to stop. */
const STOP_WAIT_MS = 15_000;

function runtimeFailure(runtime: string, message: string): WorkflowFailure {
  return { code: 'runtime_failed', message: `Step runtime "${runtime}" ${message}` };
}

/**
 * Whether `state` may still run: `running`, or `failed` with `cancel_failed`, a stop the runtime could not confirm,
 * which a later cancel tries again. Any other `failed` is the operation's end, whatever cancel came before it.
 */
function isUnstopped(state: OpState | undefined): boolean {
  return state?.state === 'running' || (state?.state === 'failed' && isStopRefused(state.failure));
}

/** Whether an operation that ended `failed` with `failure` may still run: the runtime could not confirm its stop. */
function isStopRefused(failure: RuntimeFailure): boolean {
  return failure.code === CANCEL_FAILED;
}

/**
 * `deadline` is the lease's expiry, the latest time the attempt's limits allow, which its `open` tells the runtime and
 * which bounds what runs in the place; undefined when the attempt has no such limit, or only stops what a teamai before
 * it left.
 */
export function attemptRun({ runtime, ...input }: { config: LocalConfig; run: RunId; attempt: AttemptId; runtime: StepRuntime<DriverCan>; driver: string; sources?: readonly RuntimeOrigin[]; deadline?: string }): AttemptRun {
  return attemptThrough({ ...input, sends: attemptSends(runtime) });
}

/** A step runtime with what sends an operation taken out: an attempt sends only through `AttemptSends`. */
type RuntimeWithoutSends = Omit<StepRuntime<DriverCan>, 'exec' | 'prompt'>;

/** How a send reads a stop that found nothing running: whether the operation may already run on the runtime. */
interface SendAfterStop {
  /**
   * The op is one a teamai before this one sent and the runtime may run now: sending it again reconnects to it, so it
   * is sent, and gets the stop once it is. An op that cannot be running there is not sent after a stop.
   */
  reconnects: boolean;
  /** Settles once what the operation's events show is recorded; the send waits for it before it ends. */
  kept: () => Promise<void>;
}

export type AttemptSends = ReturnType<typeof attemptSends>;

/**
 * The one way an attempt sends an operation to its runtime. It owns how the step was stopped and what runs now, so a
 * stop that found nothing running is read by every send: one sent after it is not sent, or, when it reconnects to one
 * already running there, is passed the stop once it is sent. `runtime` is the rest of the step runtime, with no send.
 */
function attemptSends(full: StepRuntime<DriverCan>) {
  // How the step was stopped while nothing it sent was running.
  let stopped: 'stop' | 'cancel' | undefined;
  let running: { op: OpId } | undefined;
  // Ends the exec running now as `left`, while one that its runtime goes on with runs.
  let leave: (() => void) | undefined;
  // The cancel the run asked of the operation running now: a stop after it waits for it, since leaving would drop it.
  let cancelling: { op: OpId; landed: Promise<void> } | undefined;

  /**
   * Sends `op` through `send`, unless a stop came first and it cannot already run there. An exec its runtime goes on
   * with (`isLeavable`) is left on a stop, `send` racing what it sends against `leaving`; anything else is cancelled.
   */
  const through = async <TEnd extends AttemptExecEnd | PromptEnd>(op: OpId, send: (leaving: Promise<{ kind: 'left' }>) => Promise<TEnd>, { reconnects, kept }: SendAfterStop, isLeavable: boolean): Promise<TEnd | { kind: 'cancelled' }> => {
    if (stopped && !reconnects) return { kind: 'cancelled' };

    running = { op };

    const leaving = isLeavable && stopped === 'stop' ? Promise.resolve({ kind: 'left' } as const)
      : new Promise<{ kind: 'left' }>((resolve) => { leave = isLeavable ? () => resolve({ kind: 'left' }) : undefined; });

    const sent = send(leaving);
    const passedOn = stopped === 'cancel' || (stopped === 'stop' && !isLeavable) ? full.cancel(op) : undefined;

    if (passedOn) cancelling = { op, landed: passedOn };
    const [end] = await Promise.all([sent, passedOn]);
    leave = undefined;
    await kept();
    running = undefined;

    return end;
  };

  const runtime: RuntimeWithoutSends = full;

  return {
    runtime,
    exec: (request: ExecRequest, events: ExecEvents, kind: ExecKind, after: SendAfterStop) => through(request.op, (leaving) => Promise.race([full.exec(request, events, kind), leaving]), after, kind !== 'setup' && full.isExecReconnected === true),
    prompt: (request: PromptRequest, events: { onAccepted?: (accepted: Accepted) => void; onDisplay?: (display: RuntimeDisplay) => void }, after: SendAfterStop) => through(request.op, () => full.prompt(request, events), after, false),

    async stop(): Promise<void> {
      stopped ??= 'stop';

      if (running && cancelling?.op === running.op) return cancelling.landed;

      if (leave) {
        leave();

        return;
      }

      if (running) await full.cancel(running.op);
    },

    async cancel(): Promise<void> {
      stopped = 'cancel';

      if (!running) return;
      cancelling = { op: running.op, landed: full.cancel(running.op) };
      await cancelling.landed;
    },
  };
}

function attemptThrough({ config, run, attempt, sends, driver, sources, deadline }: { config: LocalConfig; run: RunId; attempt: AttemptId; sends: AttemptSends; driver: string; sources?: readonly RuntimeOrigin[]; deadline?: string }): AttemptRun {
  const { runtime } = sends;
  const file = attemptRuntimePath(config, run, attempt);
  let record: AttemptRuntimeRecord | undefined;
  // An exec ended `left` goes on on its runtime: its place stays open, for a later teamai to reconnect to or cancel.
  let isLeft = false;
  // Why an exec or prompt of this attempt may still run, once one ended `lost`: its place is not closed under it.
  let mayRun: RuntimeFailure | undefined;
  // The credentials the place was opened with, in memory only, so what the runtime says of the place is kept masked.
  let openedWith: Record<string, string> = {};

  const save = async (next: AttemptRuntimeRecord): Promise<void> => {
    record = next;
    await writeJsonAtomic(file, next);
  };

  const current = async (): Promise<AttemptRuntimeRecord | undefined> => (record ??= await externalRecord(config, run, attempt));

  /** Keeps what the runtime showed now; one that showed nothing keeps what it showed before. */
  const shown = async (display: RuntimeDisplay | undefined): Promise<void> => {
    const now = await current();

    if (now && display) await save({ ...now, display });
  };

  /**
   * Tells `events` of an operation's acceptance and of each display the runtime gives apart from it, and keeps each
   * display, with the acceptance or apart from it, for the run's details. `kept` settles once those are written, and the
   * operation's end waits for it.
   */
  const accepting = ({ onAccepted, onDisplay }: Pick<ExecEvents, 'onAccepted' | 'onDisplay'>) => {
    let kept: Promise<void> = Promise.resolve();

    return {
      onAccepted: (accepted: Accepted): void => {
        if (accepted.display) kept = kept.then(() => shown(accepted.display));
        onAccepted?.(accepted);
      },
      onDisplay: (display: RuntimeDisplay): void => {
        kept = kept.then(() => shown(display));
        onDisplay?.(display);
      },
      kept: () => kept,
    };
  };

  /**
   * Stops an operation a teamai before this one left running, and waits until the runtime no longer reports it running.
   * Answers why the stop is not confirmed, or undefined once it is: the runtime could not be asked, it reports the
   * operation `cancel_failed` (its failure says what to do), or it still reports it running after the wait.
   */
  const stopLeftRunning = async (handle: string, op: OpId): Promise<RuntimeFailure | undefined> => {
    await runtime.cancel(op);
    const waitUntil = Date.now() + STOP_WAIT_MS;

    for (let left = STOP_WAIT_MS; left > 0; left = waitUntil - Date.now()) {
      // A reattach sent just before the wait ends does not extend it.
      let timer: NodeJS.Timeout | undefined;
      const seen = await Promise.race([runtime.reattach(handle), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), left); })]);
      clearTimeout(timer);

      if (seen === undefined) break;

      if (seen.kind === 'failed') return seen.failure;

      if (seen.kind === 'gone') return undefined;
      const state = seen.ops.find((retained) => retained.op === op);

      if (!isUnstopped(state)) return undefined;

      if (state?.state === 'failed') return state.failure;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, waitUntil - Date.now())));
    }

    return { code: 'runtime_unanswered', message: `Step runtime "${runtime.name}" still reported operation ${op} of attempt ${attempt} running ${STOP_WAIT_MS / 1000} s after teamai asked it to cancel it.` };
  };

  /**
   * Records the home outside the attempt a finished prompt's session lives in: the one its runtime reported, else, as
   * protocol 1 reads an omitted home, the default home under $HOME of the tool it ran as (for a tool that keeps its
   * sessions in XDG data, `~/.local/share`; for an instance, its own directory), whatever moved the member's own.
   */
  const keptIn = async (end: PromptEnd): Promise<PromptEnd> => {
    const now = await current();

    if (end.kind !== 'finished' || !now) return end;
    const { tool } = end.session;
    const host = realHost();

    const root = toolHomeOf(tool, host)?.root;

    const home = end.session.home
      ?? (keepsSessionsInXdgData(tool) ? host.path.join(host.home, '.local', 'share') : root !== undefined ? host.path.join(host.home, ...root.split('/')) : undefined);

    if (home !== undefined) await save({ ...now, sessionHome: { tool, dir: home } });

    return end;
  };

  /** Ends an exec or prompt as `lost`, which keeps its place open: what it started may still run there. */
  const lostFor = (failure: RuntimeFailure): Lost => {
    mayRun = failure;

    return { kind: 'lost', failure };
  };

  /**
   * Why this runtime leaves alone the place `left` names on another runtime: what ran there was not stopped
   * (`stopOnRecordedDriver`), so neither its work nor its place is this runtime's to bring back or close.
   */
  const placeElsewhere = (left: AttemptRuntimeRecord): WorkflowFailure | undefined => (left.runtime === runtime.name ? undefined
    : runtimeFailure(runtime.name, `left the place of attempt ${attempt} on step runtime "${left.runtime}" of driver "${left.driver}" open, since what ran there may still run. Resume the run with --driver ${left.driver}.`));

  /** The setup a teamai before this one left, which the runtime could not stop, may still run in its place. */
  const leftSetupNotStopped = (notStopped: RuntimeFailure): Lost => lostFor({ code: notStopped.code, message: `Step runtime "${runtime.name}" could not stop the setup of attempt ${attempt} that a teamai before this one left running, so it may still run there: ${notStopped.message}` });

  /** `failure` with the values of the credentials the place was opened with masked, for what teamai records or prints. */
  const masked = (failure: RuntimeFailure): RuntimeFailure => ({ ...failure, message: redact(failure.message, { envSecrets: credentialSecrets(runtime.name, openedWith), patterns: false }) });

  /** How an exec or prompt sent now ended, as the attempt takes it: one whose stop the runtime refused may still run. */
  const ended = <TEnd extends ExecEnd | PromptEnd>(end: TEnd): TEnd | Lost => {
    if (end.kind === 'lost' || (end.kind === 'failed' && isStopRefused(end.failure))) return lostFor(end.failure);

    return end;
  };

  return {
    async open(view, { tool, toolHome: home, credentials = {}, unset } = {}) {
      openedWith = credentials;
      const found = await current();
      // A place closed on another runtime, or an open the runtime refused before it made a place, holds nothing of this
      // one: the attempt starts again here.
      const before = found && !(found.phase === 'closed' && (found.runtime !== runtime.name || found.open.handle === undefined)) ? found : undefined;

      // A record of another runtime is one whose place there is still open: what ran there was not stopped
      // (`stopOnRecordedDriver`), so the attempt does not move while it may still run.
      if (before && before.runtime !== runtime.name && before.phase !== 'closed') {
        return { ok: false, failure: runtimeFailure(runtime.name, `cannot continue attempt ${attempt}, whose place on step runtime "${before.runtime}" of driver "${before.driver}" is still open, so what ran there may still run. Resume the run with --driver ${before.driver}.`) };
      }

      if (before?.openFailed && before.phase !== 'closed') return { ok: false, failure: runtimeFailure(runtime.name, `could not open attempt ${attempt} (${before.openFailed.code}): ${before.openFailed.message}`) };
      const op = before?.open.op ?? newOpId();
      const toolHome = home ?? before?.toolHome;
      const opening: AttemptRuntimeRecord = { runtime: runtime.name, driver, phase: before?.phase ?? 'opening', open: { op } };
      const from = sources ?? before?.sources;

      if (from) opening.sources = [...from];

      if (before?.open.handle) opening.open.handle = before.open.handle;

      if (before?.exec) opening.exec = before.exec;

      if (before?.setup) opening.setup = before.setup;

      if (before?.prompt) opening.prompt = before.prompt;

      if (toolHome) opening.toolHome = toolHome;

      if (before?.sessionHome) opening.sessionHome = before.sessionHome;

      if (before?.display) opening.display = before.display;

      if (before?.closeFailed) opening.closeFailed = before.closeFailed;
      const lock = runsRemovalLockIn(getDataHome(config));
      const wasRunRecorded = await isRunHere(config, run);

      // An uninstall holds this lock from its check that no place is open until it has removed the runs, so a run it
      // removed meanwhile is gone once this takes it, and a place recorded there would have no run to close it. A data
      // home it removed whole is not made again: only a run never recorded before needs it made.
      const recorded = await withFileLock(lock, RUNS_REMOVAL_LOCK_WAIT, async () => {
        if (wasRunRecorded && !await isRunHere(config, run)) return false;
        await save(opening);

        return true;
      }, { createParent: !wasRunRecorded });

      if (recorded.held ? !recorded.value : recorded.isDirectoryGone) return { ok: false, failure: runtimeFailure(runtime.name, `could not open attempt ${attempt}: its run was removed while it waited on ${lock}, as an uninstall of this scope removes the runs, so it opens no place that nothing would close.`) };

      if (!recorded.held) return { ok: false, failure: runtimeFailure(runtime.name, `could not open attempt ${attempt}: ${lock} stays taken, as an uninstall of this scope holds it while it removes the runs. Run the step again once the uninstall ends.`) };

      // A place opened again keeps the handle it recorded until it is ready: one made in steps (a runtime through
      // another) is accepted first with part of its handle, which must not replace the whole one if the rest fails.
      const opened = await runtime.open({ op, run, attempt, credentials, ...(tool !== undefined && { tool }), ...(deadline !== undefined && { deadline }), ...(view && { view }), ...(unset && { unset }) }, async (handle) => {
        const now = await current();

        if (now) await save({ ...now, open: { op, handle: before?.open.handle ?? handle }, phase: now.phase === 'opening' ? 'ready' : now.phase });
      });

      if (opened.kind !== 'ready') {
        const now = await current();

        if (now?.open.handle !== undefined) await save({ ...now, openFailed: opened.failure });
        // The runtime answered the first open of this op with a failure before it accepted a place, so it holds none.
        // One that did not answer, or an op a killed teamai sent before, may hold a place no handle names: the record
        // stays open, so a close says so.
        else if (now && !before && !isUnansweredFailure(opened.failure)) await save(closedRecord(now));

        return { ok: false, failure: runtimeFailure(runtime.name, `could not open attempt ${attempt} (${opened.failure.code}): ${opened.failure.message}`) };
      }

      const ready = await current();

      if (ready && ready.open.handle !== opened.handle) await save({ ...ready, open: { op, handle: opened.handle } });
      await shown(opened.display);

      return { ok: true, handle: opened.handle };
    },

    async exec(request, events, kind) {
      const before = await current();
      const handle = before?.open.handle;

      if (!before || handle === undefined) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Attempt ${attempt} has no open place to exec in.` } };

      // A runtime whose execs go on without teamai is sent the same id again, which reconnects to the exec.
      if (before.exec && !runtime.isExecReconnected) {
        const sent = before.exec;
        const found = await runtime.reattach(handle);

        // The exec may still run: the runtime that could tell is not answering.
        if (found.kind === 'failed') return lostFor(found.failure);

        if (found.kind === 'gone') return { kind: 'failed', failure: { code: 'runtime_gone', message: `The runtime no longer knows the place of attempt ${attempt}.` } };
        await shown(found.display);
        const state = found.ops.find((retained) => retained.op === sent.op);

        // The runtime accepted it before the restart.
        if (state !== undefined) events.onAccepted?.({});

        if (isUnstopped(state)) {
          const notStopped = await stopLeftRunning(handle, sent.op);

          if (!notStopped) return { kind: 'interrupted' };

          return lostFor({ code: notStopped.code, message: `Step runtime "${runtime.name}" could not stop the exec of attempt ${attempt} that a teamai before this one left running, so it may still run there: ${notStopped.message}` });
        }

        if (state?.state === 'exited') return { kind: 'exited', code: state.code, stdout: state.stdout };

        if (state?.state === 'cancelled') return { kind: 'cancelled', ...(state.stdout !== undefined && { stdout: state.stdout }) };

        if (state?.state === 'failed') return { kind: 'failed', failure: state.failure };

        // The request never reached the runtime: it is sent now, under the id that was persisted for it.
      }

      const exec = before.exec ?? { op: newOpId() };
      await save({ ...before, exec, phase: 'running' });
      const reconnects = before.exec !== undefined && runtime.isExecReconnected === true;

      // A tool sent anew, even under an id a teamai before this one recorded, writes its own result: one an earlier run
      // of it left is not this run's. One it reconnects to, or found ended above, is.
      if (kind === 'tool' && !reconnects) await AttemptResult.removeLeft(attemptResultPath(config, run, attempt));
      const acceptance = accepting(events);
      const end = await sends.exec({ op: exec.op, handle, ...request }, { ...events, onAccepted: acceptance.onAccepted, onDisplay: acceptance.onDisplay }, kind, { reconnects, kept: acceptance.kept });
      isLeft = end.kind === 'left';

      return end.kind === 'left' ? end : ended(end);
    },

    async setup(request, events) {
      const before = await current();
      const handle = before?.open.handle;

      if (!before || handle === undefined) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Attempt ${attempt} has no open place to run setup in.` } };

      // Stopped before its place was prepared again (`stopLeftSetup`); stopped here too for a caller that did not, late as that is.
      if (before.setup) {
        const notStopped = await stopLeftRunning(handle, before.setup.op);

        if (notStopped) return leftSetupNotStopped(notStopped);
      }

      const setup = { op: newOpId() };
      await save({ ...before, setup, phase: 'running' });
      const acceptance = accepting(events);
      const end = await sends.exec({ op: setup.op, handle, ...request }, { ...events, onAccepted: acceptance.onAccepted, onDisplay: acceptance.onDisplay }, 'setup', { reconnects: false, kept: acceptance.kept });

      return end.kind === 'left' ? end : ended(end);
    },

    async prompt(request, events) {
      const before = await current();
      const handle = before?.open.handle;

      if (!before || handle === undefined) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Attempt ${attempt} has no open place to prompt in.` } };

      if (before.prompt) {
        const found = await runtime.reattach(handle);

        // The prompt may still run: the runtime that could tell is not answering.
        if (found.kind === 'failed') return lostFor(found.failure);

        if (found.kind === 'gone') return { kind: 'failed', failure: { code: 'runtime_gone', message: `The runtime no longer knows the place of attempt ${attempt}.` } };
        await shown(found.display);
        const sent = before.prompt;
        const state = found.ops.find((retained) => retained.op === sent.op);

        // The runtime accepted it before the restart; one still running is accepted again when it is resent.
        if (state !== undefined && state.state !== 'running') events.onAccepted?.({});

        // A stop that a cancel before the restart could not confirm is tried again: it is not how the prompt ended.
        if (state?.state === 'failed' && isUnstopped(state)) {
          const notStopped = await stopLeftRunning(handle, sent.op);

          if (!notStopped) return { kind: 'cancelled' };

          return lostFor({ code: notStopped.code, message: `Step runtime "${runtime.name}" could not stop the prompt of attempt ${attempt} that a teamai before this one asked it to cancel, so it may still run there: ${notStopped.message}` });
        }

        if (state?.state === 'finished') {
          const end: PromptEnd = { kind: 'finished', session: state.session, result: state.result };

          if (state.usage) end.usage = state.usage;
          else if (state.unmeasured) end.unmeasured = state.unmeasured;

          if (state.model) end.model = state.model;

          if (state.cost) end.cost = state.cost;

          if (state.confined) end.confined = state.confined;

          if (state.resumed === true) end.resumed = true;

          if (state.stopped) end.stopped = state.stopped;

          return keptIn(end);
        }

        if (state?.state === 'cancelled') return { kind: 'cancelled' };

        if (state?.state === 'failed') return { kind: 'failed', failure: state.failure };

        if (state?.state === 'exited') return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Step runtime "${runtime.name}" reported the prompt of attempt ${attempt} as an exec that exited.` } };

        // Still running, or never received: the same id reconnects to it, or sends it now.
      }

      const { continue: continues } = request.lease;
      const sent = before.prompt ?? { op: newOpId(), ...(continues && { continues }) };

      if (before.prompt === undefined) await save({ ...before, prompt: sent, phase: 'running' });

      const acceptance = accepting(events);
      const end = await sends.prompt({ op: sent.op, handle, ...request }, { onAccepted: acceptance.onAccepted, onDisplay: acceptance.onDisplay }, { reconnects: before.prompt !== undefined, kept: acceptance.kept });

      return ended(await keptIn(end));
    },

    stop: sends.stop,
    cancel: sends.cancel,

    async collect() {
      const before = await current();
      const handle = before?.open.handle;

      if (!before || handle === undefined) return undefined;
      const elsewhere = placeElsewhere(before);

      if (elsewhere) return elsewhere;

      // Nothing is brought back while what ran there may still write the place.
      if (mayRun) return runtimeFailure(runtime.name, `left the work of attempt ${attempt} in its place, since what ran there may still run (${mayRun.code}): ${masked(mayRun).message}`);
      const collected = await runtime.collect(handle);

      if (!collected.ok) return runtimeFailure(runtime.name, `could not bring the work of attempt ${attempt} back (${collected.failure.code}): ${collected.failure.message}. Nothing it changed in the place was committed.`);
      await save({ ...before, phase: 'collected' });

      return undefined;
    },

    async close(how) {
      const before = await current();

      if (!before || before.phase === 'closed' || isLeft) return undefined;
      const handle = before.open.handle;

      // An open sent whose handle teamai never recorded, as when teamai or the runtime stopped in between: the runtime
      // may have made a place that no request teamai can send names, so it is not said to be closed.
      if (handle === undefined) {
        return runtimeFailure(runtime.name, `may hold a place for attempt ${attempt} that teamai cannot close: teamai asked for the place (${before.open.op}) and never recorded its handle, since teamai or the runtime stopped in between. Close it in ${runtime.name} yourself if it is there.`);
      }

      const elsewhere = placeElsewhere(before);

      if (elsewhere) return elsewhere;

      if (mayRun) {
        const failure = masked(mayRun);
        await save({ ...before, closeFailed: failure });

        return runtimeFailure(runtime.name, `kept the place of attempt ${attempt} open, since what ran there may still run (${failure.code}): ${failure.message}`);
      }

      const closed = await runtime.close(handle, how);

      if (!closed.ok) {
        const failure = masked(closed.failure);
        await save({ ...before, closeFailed: failure });

        return runtimeFailure(runtime.name, `could not close the place of attempt ${attempt}, so what ran there may still run (${failure.code}): ${failure.message}`);
      }

      const { closeFailed: _earlier, ...kept } = before;
      await save(closedRecord(kept));

      return undefined;
    },

    async stopLeftSetup() {
      const before = await current();
      const handle = before?.open.handle;

      // One left on another runtime was stopped through the driver recorded for it before this attempt reached here.
      if (!before?.setup || !isSetupLeftRunning(before) || before.runtime !== runtime.name || handle === undefined) return undefined;
      const notStopped = await stopLeftRunning(handle, before.setup.op);

      return notStopped && leftSetupNotStopped(notStopped);
    },

    async closeForRemadeFolder() {
      const before = await current();
      const handle = before?.open.handle;

      if (!before || before.phase === 'closed' || before.runtime !== runtime.name || handle === undefined) return undefined;
      const closed = await runtime.close(handle);

      if (!closed.ok) {
        const failure = masked(closed.failure);
        await save({ ...before, closeFailed: failure });

        return lostFor({ code: failure.code, message: `Step runtime "${runtime.name}" could not close the place of attempt ${attempt}, whose folder teamai makes again after the setup a teamai before this one cut short, so the step cannot run in it: ${failure.message}` });
      }

      // With no handle, the next open makes a new place on the folder made again rather than the one closed.
      const { closeFailed: _earlier, ...kept } = before;
      await save({ ...closedRecord(kept), open: { op: before.open.op } });

      return undefined;
    },

    async stopLeftOperation() {
      const before = await current();
      const handle = before?.open.handle;
      const left = before?.exec ?? before?.prompt ?? before?.setup;

      if (!left || handle === undefined) return undefined;
      const seen = await runtime.reattach(handle);

      if (seen.kind === 'failed') return seen.failure;

      // An operation that ended before this cancel needs no stop; closing its place confirms nothing of it still runs.
      if (seen.kind === 'gone' || !isUnstopped(seen.ops.find((retained) => retained.op === left.op))) return undefined;

      return stopLeftRunning(handle, left.op);
    },
  };
}
