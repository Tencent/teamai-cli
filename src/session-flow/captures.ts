/**
 * What a session ran as (#1178), read when it starts, because a later pull changes the checkout it reads. The
 * session-start hook writes one capture per start, before its pull; a label of the session takes its `agent` from them.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AgentObservationSchema, observeCheckout, settleObservation, type AgentObservation } from '../agent-observation.js';
import { getAgentVersion } from '../agent-version.js';
import type { CheckoutRecord } from '../pull.js';
import { deliveredTeamSkills } from '../skill-use.js';
import { getDataHome, type DeliverySelection, type LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { log } from '../utils/logger.js';
import { AgentSession } from './agent-session.js';

export const SessionCaptureSchema = z.object({
  captureId: z.string().uuid(),
  platform: z.string().min(1),
  sessionId: z.string().min(1),
  capturedAt: z.string().datetime(),
  agent: AgentObservationSchema,
  /** The session's own pull delivered a new revision to its checkout, so it may have loaded assets of either. */
  teamChanged: z.literal(true).optional(),
  /** The session's file as its hook named it, so a sweep can tell when the session is gone. */
  sessionFile: z.string().optional(),
  /** The team skills the checkout held as teamai delivered them when the session started and after its own pull (`deliveredTeamSkills`). */
  teamSkills: z.record(z.array(z.string())).optional(),
});
export type SessionCapture = z.infer<typeof SessionCaptureSchema>;

/** The hook payload field the foreground dispatcher hands the background pass the capture it wrote in. */
export const CAPTURE_PAYLOAD_KEY = 'teamai_capture';

const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/;

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
async function atStart(config: LocalConfig, tool: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const platform = AgentSession.platformForTool(tool);
  const sessionId = payload.session_id;
  const cwd = payload.cwd;
  if (env.TEAMAI_LAUNCHED_BY || payload.source === 'compact') return undefined;
  if (!platform || typeof sessionId !== 'string' || !SEGMENT.test(sessionId) || typeof cwd !== 'string') return undefined;
  try {
    const model = typeof payload.model === 'string' ? { requested: payload.model } : undefined;
    const { gitStateIn } = await import('../dashboard-collector.js');
    const head = gitStateIn(payload);
    const reported = await observeCheckout({ config, tool, cwd, beforeOwnPull: true, ...(head !== undefined ? { head } : {}) });
    const agent = settleObservation({ agent: { ...reported, ...(model ? { model } : {}) }, tool, driver: { kind: 'session' } }, undefined);
    if (!agent) return undefined;
    const file = payload.transcript_path;
    const { teamDelivery } = await import('../pull.js');
    const delivered = (await teamDelivery(config, tool, { beforeOwnPull: true }).catch(() => undefined))?.record?.delivered;
    const capture: SessionCapture = {
      captureId: randomUUID(), platform, sessionId, capturedAt: new Date().toISOString(), agent,
      ...(typeof file === 'string' && path.isAbsolute(file) ? { sessionFile: file } : {}),
      ...(delivered ? { teamSkills: await deliveredTeamSkills(config, cwd, delivered) } : {}),
    };
    await writeCapture(config, capture);
    return capture.captureId;
  } catch (e) {
    log.debug(`session capture: could not capture ${platform} session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** The observation `agent` settles to with `version` as its tool's version. */
function withToolVersion(agent: AgentObservation, version: string): AgentObservation {
  const { tool, model, effort, team, project } = agent;
  return settleObservation({ agent: { tool: { ...tool, version }, model, effort, team, project }, tool: tool.name, driver: { kind: agent.driver } }, undefined) ?? agent;
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
    for (const name of (await fs.readdir(dir)).filter((name) => name.endsWith('.json') && pick(name))) {
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
async function addToolVersion(config: LocalConfig, tool: string, payload: Record<string, unknown>): Promise<void> {
  const platform = AgentSession.platformForTool(tool);
  const { session_id: sessionId, [CAPTURE_PAYLOAD_KEY]: captureId } = payload;
  if (!platform || typeof sessionId !== 'string' || !SEGMENT.test(sessionId) || typeof captureId !== 'string' || !SEGMENT.test(captureId)) return;
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

async function checkoutRecord(config: LocalConfig, tool: string): Promise<CheckoutRecord | undefined> {
  const { teamDelivery } = await import('../pull.js');
  return (await teamDelivery(config, tool).catch(() => undefined))?.record;
}

function deliveryOf(record: CheckoutRecord | undefined): CheckoutDelivery {
  return { rev: record?.rev, selection: record?.selection, children: record?.children };
}

/** What the pull record of the checkout `config`'s pulls deliver into says it holds. */
async function checkoutDelivery(config: LocalConfig, tool: string): Promise<CheckoutDelivery> {
  return deliveryOf(await checkoutRecord(config, tool));
}

/** `capture` with the team skills of `pulled` added to those it holds. */
function withTeamSkills(capture: SessionCapture, pulled: Record<string, string[]>): SessionCapture {
  const teamSkills = { ...capture.teamSkills };
  for (const [name, files] of Object.entries(pulled)) teamSkills[name] = [...new Set([...teamSkills[name] ?? [], ...files])];
  return Object.keys(teamSkills).length > 0 ? { ...capture, teamSkills } : capture;
}

/**
 * After the session's own pull: adds the team skills the checkout then holds as delivered to the capture this start or
 * resume wrote, since the session may load those too from then on, also when that pull restored one at the same
 * revision. A capture before it keeps what it held, so a load before a resume is matched as it was. Marks them when that pull
 * delivered another revision, or the same one for another selection or other workspace children, than the checkout
 * held `before` it.
 */
async function markTeamChanged(config: LocalConfig, tool: string, payload: Record<string, unknown>, before: CheckoutDelivery): Promise<void> {
  const platform = AgentSession.platformForTool(tool);
  const { session_id: sessionId, cwd, [CAPTURE_PAYLOAD_KEY]: captureId } = payload;
  if (!platform || typeof sessionId !== 'string' || !SEGMENT.test(sessionId)) return;
  const record = await checkoutRecord(config, tool);
  const changed = !isDeepStrictEqual(deliveryOf(record), before);
  try {
    const pulled = record?.delivered && typeof cwd === 'string' && typeof captureId === 'string'
      ? await deliveredTeamSkills(config, cwd, record.delivered) : {};
    if (!changed && Object.keys(pulled).length === 0) return;
    await rewrite(config, platform, sessionId, () => true, (capture) => ({
      ...(capture.captureId === captureId ? withTeamSkills(capture, pulled) : capture),
      ...(changed ? { teamChanged: true } : {}),
    }));
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
}

/** Every session captured here, as `sweep` walks them. */
async function list(config: LocalConfig): Promise<CapturedSession[]> {
  const root = path.join(getDataHome(config), 'sessions', 'captures');
  const sessions: CapturedSession[] = [];
  for (const platform of (await fs.readdir(root).catch(() => [])).filter((name) => SEGMENT.test(name)).sort()) {
    for (const sessionId of (await fs.readdir(path.join(root, platform)).catch(() => [])).sort()) {
      const [first, ...rest] = await read(config, platform, sessionId);
      if (first) sessions.push({ platform, sessionId, captures: [first, ...rest] });
    }
  }
  return sessions;
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
 * compares (tool, model, effort, team), with the first capture's project and CLI. A capture marked `teamChanged` leaves
 * out the team, and so the fingerprint, and the captures are then compared without it. Captures that differ, or none,
 * give no agent. `reportedModel` is the one model the session's messages name, if they name one.
 */
function agentOf(captures: readonly SessionCapture[], reportedModel: string | undefined): AgentObservation | undefined {
  const [first, ...rest] = captures;
  if (!first) return undefined;
  const teamChanged = captures.some((capture) => capture.teamChanged);
  const compared = ({ tool, model, effort, team }: AgentObservation) => ({ tool, model, effort, team: teamChanged ? undefined : team });
  if (rest.some((capture) => !isDeepStrictEqual(compared(capture.agent), compared(first.agent)))) return undefined;
  const { tool, model, effort, team, project, teamai, driver } = first.agent;
  const settled = settleObservation({
    agent: { tool, model: { ...model, ...(reportedModel ? { reported: reportedModel } : {}) }, effort, team: teamChanged ? undefined : team, project },
    tool: tool.name,
    driver: { kind: driver },
  }, undefined);
  return settled && { ...settled, teamai };
}

export const SessionCaptures = { atStart, addToolVersion, checkoutDelivery, markTeamChanged, read, list, platformsOf, agentOf, sweep } as const;
