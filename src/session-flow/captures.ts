/**
 * What a session ran as (#1178), read when it starts, because a later pull changes the checkout it reads. The
 * session-start hook writes one capture per start, before its pull; a label of the session takes its `agent` from them.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AgentObservationSchema, CommitStateSchema, observeCheckout, sameHarness, settleObservation, type AgentObservation, type ToolLaunch } from '../agent-observation.js';
import { getAgentVersion } from '../agent-version.js';
import { DefaultFolders } from '../default-folders.js';
import { agreedRunMode, launchedBy, resolveRunMode, RunModeSchema, type RunMode } from '../launch-context.js';
import type { CheckoutRecord } from '../pull.js';
import { DeliveredSkillInfoSchema, deliveredTeamSkills, type DeliveredSkillInfo } from '../skill-use.js';
import { getDataHome, type DeliverySelection, type LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { getHeadState, type HeadState } from '../utils/git.js';
import { log } from '../utils/logger.js';
import { platformForTool, toolForPlatform } from '../tool-registry.js';
import { OptionalString } from '@teamai/tool-core/sessions/fs';
import type { Session } from '@teamai/tool-core/sessions/ir';
import type { SessionSyncMeta } from './sync.js';
import type { HookStdin } from '../hook-dispatch.js';

export const SessionCaptureSchema = z.object({
  captureId: z.string().uuid(),
  platform: z.string().min(1),
  sessionId: z.string().min(1),
  capturedAt: z.string().datetime(),
  /** The run mode the session started in. Absent on captures written before it was recorded. */
  runMode: RunModeSchema.optional(),
  agent: AgentObservationSchema,
  /** The session's own pull delivered a new revision to its checkout, so it may have loaded resources of either. */
  teamChanged: z.literal(true).optional(),
  /** The session's file as its hook named it, so a sweep can tell when the session is gone. */
  sessionFile: z.string().optional(),
  /** The team skills the checkout held as teamai delivered them when the session started and after its own pull (`deliveredTeamSkills`). */
  teamSkills: z.record(z.string(), z.array(z.string())).optional(),
  /**
   * Each delivered team skill's description as its SKILL.md then carried it and its skills namespace (#1469), present
   * (if only as `{}`) once a capture read the delivery record, absent on captures written before #1469.
   */
  teamSkillInfo: z.record(z.string(), DeliveredSkillInfoSchema).optional(),
});

export type SessionCapture = z.infer<typeof SessionCaptureSchema>;

/** The hook payload field the foreground dispatcher hands the background pass the capture it wrote in. */
export const CAPTURE_PAYLOAD_KEY = 'teamai_capture';

/**
 * How long nothing happens in an attended session before it is finished, and judge work: the `idle` of
 * teamai-finished-sessions's params.yaml in `config`.
 */
async function finishedAfter(config: LocalConfig): Promise<{ text: string; ms: number }> {
  return (await DefaultFolders.load({ kind: 'workflows', name: 'teamai-finished-sessions' }, config)).params.idle;
}

/** Nothing happened in an attended session for this long: it is finished, and judge work. */
export const FINISHED_AFTER_MS = 6 * 60 * 60 * 1000;

const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/;

/** The session-start hook payload fields a capture reads: a session id safe as a path segment, and the session's cwd. */
const StartPayloadSchema = z.object({
  session_id: z.string().regex(SEGMENT),
  cwd: z.string(),
  model: OptionalString,
  transcript_path: OptionalString,
});

/** How a session ended, as its last Stop found the checkout. */
const SessionEndSchema = z.object({
  sessionId: z.string().min(1),
  source: z.string().min(1),
  end: CommitStateSchema,
  at: z.string().datetime(),
});

export type SessionEnd = z.infer<typeof SessionEndSchema>;

/** The Stop payload fields an end record reads. */
const StopPayloadSchema = z.object({ session_id: z.string().regex(SEGMENT), cwd: z.string().min(1) });

/** The background pass's payload: its session and the capture the start wrote, both safe as path segments. */
const ToolVersionPayloadSchema = z.object({
  session_id: z.string().regex(SEGMENT),
  [CAPTURE_PAYLOAD_KEY]: z.string().regex(SEGMENT),
});

/** The post-pull payload: its session, and the cwd and capture id when the hook carries them. */
const PulledPayloadSchema = z.object({
  session_id: z.string().regex(SEGMENT),
  cwd: OptionalString,
  [CAPTURE_PAYLOAD_KEY]: OptionalString,
});

function sessionDir(config: LocalConfig, platform: string, sessionId: string): string {
  return path.join(getDataHome(config), 'sessions', 'captures', platform, sessionId);
}

async function writeCapture(config: LocalConfig, capture: SessionCapture): Promise<void> {
  const dir = sessionDir(config, capture.platform, capture.sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${capture.captureId}.json`);
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

/**
 * At a session's start, before its pull: what the checkout delivers it. Returns the capture's id. A compaction writes
 * none, and neither does a session teamai launched: a workflow step is scored as a step, and a judge never. A capture
 * that fails is logged at debug level, so it never fails the hook.
 */
async function atStart(config: LocalConfig, tool: string, payload: HookStdin, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const platform = platformForTool(tool);

  if (launchedBy(env) || payload.source === 'compact') return undefined;
  const fields = StartPayloadSchema.safeParse(payload);

  if (!platform || !fields.success) return undefined;
  const { session_id: sessionId, cwd, model: requested, transcript_path: file } = fields.data;

  try {
    const model = requested === undefined ? undefined : { requested };
    const { gitStateIn } = await import('../dashboard-collector.js');
    const head = gitStateIn(payload);
    const { teamDelivery } = await import('../pull.js');
    const delivery = await teamDelivery(config, tool, { beforeOwnPull: true }).catch(() => null);
    const launch: ToolLaunch = { config, tool, cwd, beforeOwnPull: true, delivery };

    if (head !== undefined) launch.head = head;
    const reported = await observeCheckout(launch);
    const agent = settleObservation({ agent: model ? { ...reported, model } : { ...reported }, tool, driver: { kind: 'session' } }, undefined);

    if (!agent) return undefined;
    const record = delivery?.record;

    const capture: SessionCapture = {
      captureId: randomUUID(), platform, sessionId, capturedAt: new Date().toISOString(), runMode: resolveRunMode(env), agent,
    };

    if (file !== undefined && path.isAbsolute(file)) capture.sessionFile = file;

    if (record?.delivered) {
      const delivered = await deliveredTeamSkills(config, cwd, record.delivered, record.rev);
      capture.teamSkills = delivered.teamSkills;
      capture.teamSkillInfo = delivered.teamSkillInfo;
    }

    await writeCapture(config, capture);

    return capture.captureId;
  } catch (e) {
    log.debug(`session capture: could not capture ${platform} session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);

    return undefined;
  }
}

/** The file in a session's capture directory holding its end record. Captures end in `.json`; it does not. */
const END_FILE = 'end';

/** How long a Stop waits for `git status` before it leaves the end record as it was. */
const END_GIT_TIMEOUT_MS = 2_000;

/** The commit `cwd` has checked out and whether tracked files are modified, or null when git fails, finds none, or passes the cap. */
async function headWithin(cwd: string, ms: number): Promise<HeadState | null> {
  const abort = AbortSignal.timeout(ms);
  // A git killed at the cap is still waited for while a child of it holds the pipe, so the cap ends the wait itself.
  const capped = new Promise<null>((resolve) => abort.addEventListener('abort', () => resolve(null), { once: true }));

  return Promise.race([getHeadState(cwd, abort).catch(() => null), capped]);
}

/**
 * At each Stop of a captured session: how its checkout ends, beside its captures, so the last Stop wins and a sweep
 * removes it with them. A session with no capture gets none, and a Stop whose git fails or times out leaves the record
 * as it was. Written to a file of its own, then renamed, so a reader never sees half of it.
 */
async function atStop(config: LocalConfig, tool: string, payload: HookStdin): Promise<void> {
  const platform = platformForTool(tool);
  const fields = StopPayloadSchema.safeParse(payload);

  if (!platform || !fields.success) return;
  const { session_id: sessionId, cwd } = fields.data;
  const dir = sessionDir(config, platform, sessionId);

  if (!(await fs.stat(dir).catch(() => undefined))) return;
  const { gitStateAtStopIn } = await import('../dashboard-collector.js');
  const handed = gitStateAtStopIn(payload);
  const head = handed === undefined ? await headWithin(cwd, END_GIT_TIMEOUT_MS) : handed;

  if (!head) {
    log.debug(`session capture: ${cwd} gave no git state at this Stop, so ${platform} session ${sessionId} keeps its end record`);

    return;
  }

  const record: SessionEnd = { sessionId, source: platform, end: { commit: head.head, dirty: head.dirty }, at: new Date().toISOString() };
  const file = path.join(dir, END_FILE);
  const written = `${file}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(written, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await fs.rename(written, file);
  } catch (e) {
    await fs.rm(written, { force: true });
    log.debug(`session capture: could not record how ${platform} session ${sessionId} ended: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The end record of one session, or undefined when it has none or it does not parse. */
async function endOf(config: LocalConfig, platform: string, sessionId: string): Promise<SessionEnd | undefined> {
  const text = await fs.readFile(path.join(sessionDir(config, platform, sessionId), END_FILE), 'utf8').catch(() => undefined);

  if (text === undefined) return undefined;

  try {
    return SessionEndSchema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

/** The observation `agent` settles to with `version` as its tool's version, keeping the definition it ran as. */
function withToolVersion(agent: AgentObservation, version: string): AgentObservation {
  const { definition, tool, model, effort, team, project } = agent;

  return settleObservation({ agent: { definition, tool: { ...tool, version }, model, effort, team, project }, tool: tool.name, driver: { kind: agent.driver } }, definition?.name) ?? agent;
}

const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 100;

/**
 * Rewrites with `change` each capture of one session that `pick` names, under the session's lock, so two hook processes
 * of the session never lose each other's change.
 */
async function rewrite(config: LocalConfig, platform: string, sessionId: string, pick: (file: string) => boolean, change: (capture: SessionCapture) => SessionCapture): Promise<void> {
  const dir = sessionDir(config, platform, sessionId);

  if (!(await fs.stat(dir).catch(() => undefined))) return;
  const lock = path.join(dir, 'rewrite.lock');

  for (let attempt = 1; !(await acquireLock(lock)); attempt++) {
    if (attempt === LOCK_ATTEMPTS) throw new Error(`another teamai process holds ${lock}`);
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }

  try {
    for (const name of (await fs.readdir(dir)).filter((fileName) => fileName.endsWith('.json') && pick(fileName))) {
      const file = path.join(dir, name);
      const parsed = SessionCaptureSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));

      if (!parsed.success) continue;
      await fs.writeFile(`${file}.tmp`, `${JSON.stringify(change(parsed.data), null, 2)}\n`, { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    }
  } finally {
    await releaseLock(lock);
  }
}

/** In the hook's background pass: adds the tool's version, which the start leaves out so it never waits on it. */
async function addToolVersion(config: LocalConfig, tool: string, payload: HookStdin): Promise<void> {
  const platform = platformForTool(tool);
  const fields = ToolVersionPayloadSchema.safeParse(payload);

  if (!platform || !fields.success) return;
  const { session_id: sessionId, [CAPTURE_PAYLOAD_KEY]: captureId } = fields.data;
  const version = await getAgentVersion(tool);

  if (!version) return;

  try {
    await rewrite(config, platform, sessionId, (file) => file === `${captureId}.json`, (capture) => ({ ...capture, agent: withToolVersion(capture.agent, version) }));
  } catch (e) {
    log.debug(`session capture: could not add the ${tool} version to ${platform} session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** What a checkout's pull record says the checkout holds. */
type CheckoutDelivery = { rev?: string; selection?: DeliverySelection; children?: string };

async function checkoutRecord(config: LocalConfig): Promise<CheckoutRecord | undefined> {
  const { deliveringCheckoutRecord } = await import('../pull.js');

  return deliveringCheckoutRecord(config).catch(() => undefined);
}

function deliveryOf(record: CheckoutRecord | undefined): CheckoutDelivery {
  return { rev: record?.rev, selection: record?.selection, children: record?.children };
}

/** What the pull record of the checkout `config`'s pulls deliver into says it holds. */
async function checkoutDelivery(config: LocalConfig): Promise<CheckoutDelivery> {
  return deliveryOf(await checkoutRecord(config));
}

/** `capture` with the team skills of `pulled` added to those it holds. */
function withTeamSkills(capture: SessionCapture, pulled: Record<string, string[]>): SessionCapture {
  const teamSkills = { ...capture.teamSkills };

  for (const [name, files] of Object.entries(pulled)) teamSkills[name] = [...new Set([...teamSkills[name] ?? [], ...files])];

  return Object.keys(teamSkills).length > 0 ? { ...capture, teamSkills } : capture;
}

/** `capture` with the descriptions of the skills `pulled` added for names it does not already hold, so a later pull leaves them (#1469). */
function withTeamSkillInfo(capture: SessionCapture, pulled: Record<string, DeliveredSkillInfo>): SessionCapture {
  const teamSkillInfo = { ...capture.teamSkillInfo };

  for (const [name, info] of Object.entries(pulled)) if (!(name in teamSkillInfo)) teamSkillInfo[name] = info;

  return { ...capture, teamSkillInfo };
}

/**
 * After the session's own pull: adds the team skills the checkout then holds as delivered to the capture this start or
 * resume wrote, since the session may load those too from then on, also when that pull restored one at the same
 * revision. A capture before it keeps what it held, so a load before a resume is matched as it was. Marks them when that pull
 * delivered another revision, or the same one for another selection or other workspace children, than the checkout
 * held `before` it.
 */
async function markTeamChanged(config: LocalConfig, tool: string, payload: HookStdin, before: CheckoutDelivery): Promise<void> {
  const platform = platformForTool(tool);
  const fields = PulledPayloadSchema.safeParse(payload);

  if (!platform || !fields.success) return;
  const { session_id: sessionId, cwd, [CAPTURE_PAYLOAD_KEY]: captureId } = fields.data;
  const record = await checkoutRecord(config);
  const changed = !isDeepStrictEqual(deliveryOf(record), before);

  try {
    const pulled = record?.delivered && cwd !== undefined && captureId !== undefined
      ? await deliveredTeamSkills(config, cwd, record.delivered, record.rev) : undefined;

    if (!changed && !pulled) return;
    await rewrite(config, platform, sessionId, () => true, (capture) => {
      const next = capture.captureId === captureId && pulled
        ? withTeamSkillInfo(withTeamSkills(capture, pulled.teamSkills), pulled.teamSkillInfo) : capture;

      return changed ? { ...next, teamChanged: true } : { ...next };
    });
  } catch (e) {
    log.debug(`session capture: could not record what the pull of ${platform} session ${sessionId} delivered: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The captures of one session, oldest first. A file that does not parse as one is left out. */
async function read(config: LocalConfig, platform: string, sessionId: string): Promise<SessionCapture[]> {
  if (!SEGMENT.test(platform) || !SEGMENT.test(sessionId)) return [];
  const dir = sessionDir(config, platform, sessionId);
  const files = await fs.readdir(dir).catch(() => []);
  const captures: SessionCapture[] = [];

  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const text = await fs.readFile(path.join(dir, file), 'utf8');

    try {
      const parsed = SessionCaptureSchema.safeParse(JSON.parse(text));

      if (parsed.success) captures.push(parsed.data);
    } catch {
      continue;
    }
  }

  return captures.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

const SWEEP_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the captures of each session whose file is gone, once every capture of it is a day old: a tool may write the
 * file only after the session starts. A session with a capture that names no file keeps its captures.
 */
async function sweep(config: LocalConfig): Promise<void> {
  const root = path.join(getDataHome(config), 'sessions', 'captures');
  const now = Date.now();

  const gone = async ({ sessionFile, capturedAt }: SessionCapture): Promise<boolean> =>
    sessionFile !== undefined && now - Date.parse(capturedAt) > SWEEP_AFTER_MS && !(await fs.stat(sessionFile).catch(() => undefined));

  for (const platform of await fs.readdir(root).catch(() => [])) {
    for (const sessionId of await fs.readdir(path.join(root, platform)).catch(() => [])) {
      const captures = await read(config, platform, sessionId);

      if (captures.length > 0 && (await Promise.all(captures.map(gone))).every(Boolean)) {
        await fs.rm(sessionDir(config, platform, sessionId), { recursive: true, force: true });
      }
    }
  }
}

/** One session captured here, with its captures, oldest first. */
export interface CapturedSession {
  platform: string;
  sessionId: string;
  captures: readonly [SessionCapture, ...SessionCapture[]];
  /** Whether a drain reached it (#1385): an unattended session is finished from then on. */
  drained: boolean;
  /** How it ended, as its last Stop recorded; absent before its first Stop, and for sessions that ended before teamai recorded it. */
  end?: SessionEnd;
}

/** The file in a session's capture directory that says a drain reached it. Captures end in `.json`; it does not. */
const DRAINED_FILE = 'drained';

/** Every session captured here, as `sweep` walks them. */
async function list(config: LocalConfig): Promise<CapturedSession[]> {
  const root = path.join(getDataHome(config), 'sessions', 'captures');
  const sessions: CapturedSession[] = [];

  for (const platform of (await fs.readdir(root).catch(() => [])).filter((name) => SEGMENT.test(name)).sort()) {
    for (const sessionId of (await fs.readdir(path.join(root, platform)).catch(() => [])).sort()) {
      const [first, ...rest] = await read(config, platform, sessionId);

      if (!first) continue;
      const drained = await fs.stat(path.join(sessionDir(config, platform, sessionId), DRAINED_FILE)).then(() => true, () => false);
      const captured: CapturedSession = { platform, sessionId, captures: [first, ...rest], drained };
      const end = await endOf(config, platform, sessionId);

      if (end) captured.end = end;
      sessions.push(captured);
    }
  }

  return sessions;
}

/**
 * Records that a drain reached `captured`, at `now`. Written once: a session stays drained, and a drain that finds it
 * marked by another leaves it. Only that the file exists counts, so a partly written one counts too.
 */
async function markDrained(config: LocalConfig, captured: Pick<CapturedSession, 'platform' | 'sessionId'>, now: string): Promise<void> {
  const file = path.join(sessionDir(config, captured.platform, captured.sessionId), DRAINED_FILE);

  try {
    await fs.writeFile(file, `${now}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}

/** The platforms whose sessions named `sessionId` were captured here. */
async function platformsOf(config: LocalConfig, sessionId: string): Promise<string[]> {
  if (!SEGMENT.test(sessionId)) return [];
  const root = path.join(getDataHome(config), 'sessions', 'captures');
  const platforms = await fs.readdir(root).catch(() => []);
  const held = await Promise.all(platforms.map(async (platform) => (await read(config, platform, sessionId)).length > 0));

  return platforms.filter((_, index) => held[index]);
}

/**
 * The agent a label of the session carries: the observation every capture holds, compared by the parts a fingerprint
 * compares (definition, tool, model, effort, team), with the first capture's project and CLI. A capture marked
 * `teamChanged` leaves out the team, and so the fingerprint, and the captures are then compared without it. Captures that differ, or none,
 * give no agent. `reportedModel` is the one model the session's messages name, if they name one.
 */
function agentOf(captures: readonly SessionCapture[], reportedModel: string | undefined): AgentObservation | undefined {
  const [first, ...rest] = captures;

  if (!first) return undefined;
  const teamChanged = captures.some((capture) => capture.teamChanged);

  if (rest.some((capture) => !sameHarness(capture.agent, first.agent, { comparesTeam: !teamChanged }))) return undefined;
  const { definition, tool, model, effort, team, project, teamai, driver } = first.agent;

  const settled = settleObservation({
    agent: { definition, tool, model: reportedModel ? { ...model, reported: reportedModel } : { ...model }, effort, team: teamChanged ? undefined : team, project },
    tool: tool.name,
    driver: { kind: driver },
  }, definition?.name);

  return settled && { ...settled, teamai };
}

/** The one model the messages of `session` name, if they name one: the `reportedModel` of `agentOf`. */
function reportedModelOf(session: Session): string | undefined {
  const models = new Set(session.messages.flatMap((message) => message.metadata?.model ?? []));
  const [model] = models.size === 1 ? models : [];

  return model;
}

/**
 * What the archive of `session` of `platform` records from this machine, read in the data home of the scope its hooks
 * resolved from its directory, else of `fallback`: what it ran as (`agentOf` its captures, as a label of it takes it),
 * absent when they disagree, and the commits it started and ended on. Neither without a capture.
 */
async function archivedFacts(platform: string, session: Session, fallback: LocalConfig | undefined): Promise<Pick<SessionSyncMeta, 'agent' | 'commits'>> {
  const { resolveHookConfig } = await import('../dashboard-collector.js');
  const scope = session.cwd ? await resolveHookConfig({ cwd: session.cwd, session_id: session.sessionId }, toolForPlatform(platform)) : null;
  const config = scope ?? fallback;

  if (!config) return {};
  const captures = await read(config, platform, session.sessionId);
  const [first] = captures;

  if (!first) return {};
  const facts: Pick<SessionSyncMeta, 'agent' | 'commits'> = { commits: {} };
  const agent = agentOf(captures, reportedModelOf(session));
  const end = await endOf(config, platform, session.sessionId);

  if (agent) facts.agent = agent;

  if (first.agent.project) facts.commits = { ...facts.commits, start: first.agent.project };

  if (end) facts.commits = { ...facts.commits, end: end.end };

  return facts;
}

/** The run mode every capture of a session recorded, or undefined when they differ or one recorded none. */
function runModeOf(captures: readonly SessionCapture[]): RunMode | undefined {
  return agreedRunMode(captures.map((capture) => capture.runMode));
}

export const SessionCaptures = { finishedAfter, atStart, atStop, addToolVersion, checkoutDelivery, markTeamChanged, read, list, markDrained, platformsOf, agentOf, archivedFacts, reportedModelOf, runModeOf, sweep } as const;
