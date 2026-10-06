/**
 * Which scope a tool's own session belongs to once compaction has dropped the
 * events that would say so (#785): the machine-level session-owners index, its
 * seeding from the snapshots an earlier release left, and the snapshot files it
 * reads for that.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEvents, dataHomeKey, isHumanPromptEntry } from './dashboard-collector.js';
import { readFileSafe, ensureDir, pathExists, readJson } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { RequestCostMetrics, TokenUsage } from './types.js';
import { getDataHome, getTeamaiHomeDir, emptyTokenUsage } from './types.js';
import { projectsRootDir } from './utils/partition.js';
import { parseDailySnapshot, type DailySessionSnapshot } from './session-trends.js';

/** Snapshot of already-reported per-session intervention counts (idempotency basis). */
export type ReportedInterventions = Record<string, { interrupt: number; toolReject: number; correction: number }>;

/** A rollout's reported totals, keyed by a hash of its transcript path (no path is stored). */
export type ReportedSegments = Record<string, {
  prompts: number; tokens: TokenUsage; interrupt?: number; toolReject?: number; correction?: number;
  durationMs?: number; requestDaily?: Record<string, RequestCostMetrics>;
  /** The rollout errored, was interrupted or corrected: its session did not succeed. */
  failed?: boolean;
}>;

/** Snapshot of already-reported per-session prompt counts + token usage (idempotency basis). */
export type ReportedPromptTokens = Record<string, { prompts: number; tokens: TokenUsage; segments?: ReportedSegments }>;


export const REPORTED_SNAPSHOTS = ['interventions', 'prompt-tokens', 'daily-sessions'] as const;
export type ReportedSnapshotName = typeof REPORTED_SNAPSHOTS[number];

/** The machine-level snapshot every scope shared before #786 (evaluated at call time for tests). */
export function sharedSnapshotPath(name: ReportedSnapshotName): string {
  return path.join(getTeamaiHomeDir(), 'dashboard', `reported-${name}.json`);
}

/** The snapshot of the scope whose data home is `dataHome`. */
export function snapshotPathIn(dataHome: string, name: ReportedSnapshotName): string {
  const file = `reported-${name}.json`;
  if (path.resolve(dataHome) !== path.resolve(getTeamaiHomeDir())) return path.join(dataHome, 'dashboard', file);
  return path.join(dataHome, 'dashboard', `user-${file}`);
}

// ─── Session owners ─────────────────────────────────────
//
//  ~/.teamai/dashboard/session-owners.jsonl   {"sessionId":"<tool's own ID>","dataHomeKey":"<key>"} per line
//
//  A tool's own session ID can be resumed anywhere, long after compaction
//  dropped its events, and its Stop carries the whole transcript. So the scope
//  that first reports it records itself here, append-only, and the session
//  stays that scope's. Only the ID and the key, never a path (#666). The first
//  line for an ID wins.
//
//  A release before this file kept per-scope snapshots only, so the file is
//  first written from them: each tool's own ID in any snapshot of a scope is
//  the scope's that holds its greatest total (prompts, then tokens), since a
//  session that release split per event holds only part of it elsewhere. A tie
//  names no owner: that release copied the shared file into every scope. The
//  scopes read are the user scope, every partition, and a project whose data
//  home is in its workspace that a session still in the log leads to. Each
//  report also records the IDs of its own snapshots that have no owner yet,
//  for such a project the log no longer leads to, when they show it reported
//  them: absent from the shared snapshot, or past its total there.
//

function sessionOwnersPath(): string {
  return path.join(getTeamaiHomeDir(), 'dashboard', 'session-owners.jsonl');
}

/** The data homes whose snapshots an earlier release may have written. */
async function knownDataHomes(options: { suppressMigrationNotice?: boolean } = {}): Promise<string[]> {
  const slugs = await fs.promises.readdir(projectsRootDir()).catch(() => []);
  const homes = [getTeamaiHomeDir(), ...[...slugs].sort().map((slug) => path.join(projectsRootDir(), slug))];
  // A project whose data home is in its workspace is under no partition; a
  // session of it still in the log leads to it.
  const { resolveConfigForDir } = await import('./config.js');
  const cwds = new Set((await readEvents()).flatMap((e) => (typeof e.cwd === 'string' ? [e.cwd] : [])));
  for (const cwd of cwds) {
    // A read: the config is loaded, never migrated.
    const config = (await pathExists(cwd)) ? await resolveConfigForDir(cwd, undefined, { dryRun: true, suppressMigrationNotice: options.suppressMigrationNotice }) : null;
    if (config) homes.push(getDataHome(config));
  }
  return [...new Set(homes.map((home) => path.resolve(home)))];
}

/** A snapshot entry's reported prompts and tokens, 0 for what it does not hold. */
export function reportedSize(entry: unknown): { prompts: number; tokens: number } {
  if (!entry || typeof entry !== 'object') return { prompts: 0, tokens: 0 };
  const prompts = 'prompts' in entry && typeof entry.prompts === 'number' ? entry.prompts : 0;
  const tokens = 'tokens' in entry && entry.tokens && typeof entry.tokens === 'object'
    ? Object.values(entry.tokens).reduce((sum: number, n: unknown) => sum + (typeof n === 'number' ? n : 0), 0)
    : 0;
  return { prompts, tokens };
}

/** A scope's three snapshots (the shared ones for no data home), as a file holds them. */
export interface ScopeSnapshots {
  interventions: Record<string, unknown> | null;
  promptTokens: Record<string, unknown> | null;
  daily: Record<string, unknown> | null;
}

export async function readSnapshotsIn(dataHome: string | undefined): Promise<ScopeSnapshots> {
  const read = (name: ReportedSnapshotName) =>
    readJson<Record<string, unknown>>(dataHome === undefined ? sharedSnapshotPath(name) : snapshotPathIn(dataHome, name));
  const [interventions, promptTokens, daily] = await Promise.all(REPORTED_SNAPSHOTS.map(read));
  return { interventions, promptTokens, daily };
}

/** An intervention entry read from a file, zero for what it does not hold. */
export function interventionsEntry(value: unknown): ReportedInterventions[string] {
  const count = (field: 'interrupt' | 'toolReject' | 'correction') =>
    (value && typeof value === 'object' && field in value && typeof Object.entries(value).find(([k]) => k === field)?.[1] === 'number'
      ? Number(Object.entries(value).find(([k]) => k === field)?.[1]) : 0);
  return { interrupt: count('interrupt'), toolReject: count('toolReject'), correction: count('correction') };
}

/** A prompt-token entry read from a file, zero for what it does not hold. */
export function promptTokensEntry(value: unknown): ReportedPromptTokens[string] {
  const tokens = emptyTokenUsage();
  if (value && typeof value === 'object' && 'tokens' in value && value.tokens && typeof value.tokens === 'object') {
    for (const [field, n] of Object.entries(value.tokens)) {
      if (typeof n !== 'number') continue;
      if (field === 'input' || field === 'output' || field === 'cacheRead' || field === 'cacheCreation') tokens[field] = n;
    }
  }
  return { prompts: reportedSize(value).prompts, tokens };
}

/** What a scope's snapshots hold of `id`: prompts, tokens and intervention counts. */
function heldIn(snapshots: ScopeSnapshots, id: string): { prompts: number; tokens: number; interventions: number } {
  const fromTokens = reportedSize(snapshots.promptTokens?.[id]);
  const iv = interventionsEntry(snapshots.interventions?.[id]);
  return {
    prompts: Math.max(fromTokens.prompts, reportedSize(snapshots.daily?.[id]).prompts),
    tokens: fromTokens.tokens,
    interventions: iv.interrupt + iv.toolReject + iv.correction,
  };
}

/**
 * Whether a scope's snapshots show it reported `id`: the shared snapshots hold
 * none of it, or the scope is past their total. An earlier release copied the
 * shared snapshots into every scope it ran in, so a copy shows nothing.
 */
export function showsReported(own: ScopeSnapshots, shared: ScopeSnapshots, id: string): boolean {
  const inShared = [shared.interventions, shared.promptTokens, shared.daily].some((snapshot) =>
    !!snapshot && typeof snapshot === 'object' && Object.hasOwn(snapshot, id));
  if (!inShared) return true;
  const a = heldIn(own, id);
  const b = heldIn(shared, id);
  return a.prompts !== b.prompts ? a.prompts > b.prompts
    : a.tokens !== b.tokens ? a.tokens > b.tokens : a.interventions > b.interventions;
}

/** What several scopes had reported of one session, credited to its owner (numbers only). */
export interface OwnerCredit {
  interventions: ReportedInterventions[string];
  promptTokens: ReportedPromptTokens[string];
  daily?: DailySessionSnapshot;
  /** Each part's scope key, reported prompts, and whether it ended in a Stop, for {@link creditedPrompts}. */
  parts?: CreditPart[];
}

interface CreditPart { key: string; prompts: number; stop: boolean }

/**
 * The credit for a session an earlier release split across scopes per event,
 * from their snapshots alone (its events are gone). A part whose daily entry
 * shows it ended in a Stop carries the transcript's cumulative total, so the
 * greatest such part counts once; a part with no Stop counted its own prompts,
 * so those add. Interruptions, rejections and tokens, from Stops, take the
 * greatest; corrections, counted per prompt, add. A part without a Stop that came before another's Stop is
 * credited twice: that undercounts, once, but never sends a prompt again,
 * unless the session's transcript can place it (see {@link creditedPrompts}).
 */
function creditOf(held: Array<{ key: string; snapshots: ScopeSnapshots }>, id: string): OwnerCredit {
  const parts = held.map((part) => part.snapshots);
  const stops = parts.filter((part) => parseDailySnapshot(part.daily?.[id]) !== undefined);
  const loose = parts.filter((part) => !stops.includes(part));
  const prompts = Math.max(0, ...stops.map((part) => heldIn(part, id).prompts))
    + loose.reduce((sum, part) => sum + heldIn(part, id).prompts, 0);
  const tokens = emptyTokenUsage();
  const interventions = { interrupt: 0, toolReject: 0, correction: 0 };
  for (const part of parts) {
    const entry = promptTokensEntry(part.promptTokens?.[id]);
    for (const field of ['input', 'output', 'cacheRead', 'cacheCreation'] as const) {
      tokens[field] = Math.max(tokens[field], entry.tokens[field]);
    }
    // Interruptions and rejections come from Stops, cumulative; corrections
    // are counted per prompt in each part's own events.
    const iv = interventionsEntry(part.interventions?.[id]);
    interventions.interrupt = Math.max(interventions.interrupt, iv.interrupt);
    interventions.toolReject = Math.max(interventions.toolReject, iv.toolReject);
    interventions.correction += iv.correction;
  }
  const days = stops.flatMap((part) => {
    const day = parseDailySnapshot(part.daily?.[id]);
    return day ? [day] : [];
  });
  const latest = days.reduce<DailySessionSnapshot | undefined>((a, b) => (!a || b.prompts > a.prompts ? b : a), undefined);
  return {
    interventions,
    promptTokens: { prompts, tokens },
    parts: held.map((part) => ({
      key: part.key, prompts: heldIn(part.snapshots, id).prompts, stop: stops.includes(part.snapshots),
    })),
    ...(latest ? { daily: { ...latest, prompts, durationMs: days.reduce((sum, day) => sum + day.durationMs, 0) } } : {}),
  };
}

/**
 * The owners the per-scope snapshots of an earlier release imply, as the file's
 * first lines: for each tool's own ID, the scope whose snapshots show it reported
 * it with the greatest total, and, when several did, the credit of their parts.
 * A tie names no owner.
 */
async function ownersFromSnapshots(options: { suppressMigrationNotice?: boolean } = {}): Promise<string> {
  const shared = await readSnapshotsIn(undefined);
  const parts = new Map<string, Array<{ key: string; snapshots: ScopeSnapshots }>>();
  for (const dataHome of await knownDataHomes(options)) {
    const snapshots = await readSnapshotsIn(dataHome);
    const ids = new Set([snapshots.interventions, snapshots.promptTokens, snapshots.daily].flatMap((snapshot) =>
      (snapshot && typeof snapshot === 'object' ? Object.keys(snapshot) : [])));
    const key = await dataHomeKey(dataHome);
    for (const sessionId of ids) {
      if (sessionId.startsWith('pid-') || !showsReported(snapshots, shared, sessionId)) continue;
      parts.set(sessionId, [...(parts.get(sessionId) ?? []), { key, snapshots }]);
    }
  }
  const lines: string[] = [];
  for (const [sessionId, held] of parts) {
    const size = (part: { snapshots: ScopeSnapshots }) => heldIn(part.snapshots, sessionId);
    const best = held.reduce((a, b) => {
      const x = size(a);
      const y = size(b);
      return y.prompts > x.prompts || (y.prompts === x.prompts && y.tokens > x.tokens) ? b : a;
    });
    const tied = held.some((part) => part.key !== best.key
      && size(part).prompts === size(best).prompts && size(part).tokens === size(best).tokens);
    if (tied) continue;
    const credit = held.length > 1 ? creditOf(held, sessionId) : undefined;
    lines.push(JSON.stringify({ sessionId, dataHomeKey: best.key, ...(credit ? { credit } : {}) }));
  }
  return lines.map((line) => `${line}\n`).join('');
}

/** The credits the file's first line for each ID carries (see {@link creditOf}). */
export async function readOwnerCredits(): Promise<Map<string, OwnerCredit>> {
  const credits = new Map<string, OwnerCredit>();
  const seen = new Set<string>();
  for (const line of ((await readFileSafe(sessionOwnersPath())) ?? '').split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || !('sessionId' in parsed) || typeof parsed.sessionId !== 'string') continue;
    if (seen.has(parsed.sessionId)) continue;
    seen.add(parsed.sessionId);
    if (!('credit' in parsed) || !parsed.credit || typeof parsed.credit !== 'object') continue;
    const credit = parsed.credit;
    const daily = 'daily' in credit ? parseDailySnapshot(credit.daily) : undefined;
    const parts: CreditPart[] = [];
    if ('parts' in credit && Array.isArray(credit.parts)) {
      for (const part of credit.parts) {
        if (!part || typeof part !== 'object' || !('key' in part) || typeof part.key !== 'string') continue;
        parts.push({ key: part.key, prompts: reportedSize(part).prompts, stop: 'stop' in part && part.stop === true });
      }
    }
    credits.set(parsed.sessionId, {
      interventions: interventionsEntry('interventions' in credit ? credit.interventions : undefined),
      promptTokens: promptTokensEntry('promptTokens' in credit ? credit.promptTokens : undefined),
      ...(daily ? { daily } : {}),
      ...(parts.length > 0 ? { parts } : {}),
    });
  }
  return credits;
}

/**
 * The owner of each tool's own session ID, the file seeded first when missing.
 * With `dryRun`, a missing file is not written: the seed is read in memory.
 */
export async function readSessionOwners(options: { dryRun?: boolean; suppressMigrationNotice?: boolean } = {}): Promise<Map<string, string>> {
  if (!(await pathExists(sessionOwnersPath()))) {
    if (options.dryRun) return parseSessionOwners(await ownersFromSnapshots(options));
    try {
      await ensureDir(path.dirname(sessionOwnersPath()));
      // Exclusive: a report in another scope may be writing it too.
      await fs.promises.writeFile(sessionOwnersPath(), await ownersFromSnapshots(options), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') log.debug(`Could not seed session owners: ${(e as Error).message}`);
    }
  }
  return parseSessionOwners(await readFileSafe(sessionOwnersPath()));
}

function parseSessionOwners(content: string | null): Map<string, string> {
  const owners = new Map<string, string>();
  for (const line of (content ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && 'sessionId' in parsed && 'dataHomeKey' in parsed
        && typeof parsed.sessionId === 'string' && typeof parsed.dataHomeKey === 'string'
        && !owners.has(parsed.sessionId)) owners.set(parsed.sessionId, parsed.dataHomeKey);
    } catch {
      // A torn or hand-edited line records no owner.
    }
  }
  return owners;
}

/** The IDs of a scope's snapshots that show it reported them (see {@link showsReported}). */
export async function reportedBeyondShared(
  promptTokens: Record<string, unknown>,
  interventions: Record<string, unknown>,
  daily: Record<string, unknown>,
): Promise<string[]> {
  const shared = await readSnapshotsIn(undefined);
  const own: ScopeSnapshots = { interventions, promptTokens, daily };
  const ids = new Set([...Object.keys(promptTokens), ...Object.keys(interventions), ...Object.keys(daily)]);
  return [...ids].filter((id) => showsReported(own, shared, id));
}

/** Records `key` as the owner of the tool-own session IDs among `sessionIds` that have none yet. */
export async function recordSessionOwners(sessionIds: Iterable<string>, key: string): Promise<void> {
  const owners = await readSessionOwners();
  const ids = new Set([...sessionIds].filter((id) => !id.startsWith('pid-') && !owners.has(id)));
  if (ids.size === 0) return;
  try {
    await ensureDir(path.dirname(sessionOwnersPath()));
    await fs.promises.appendFile(sessionOwnersPath(),
      [...ids].map((sessionId) => JSON.stringify({ sessionId, dataHomeKey: key })).join('\n') + '\n');
  } catch (e) {
    log.debug(`Could not record session owners: ${(e as Error).message}`);
  }
}


/**
 * The prompts a credit covers, placed by the session's transcript, which keeps
 * every prompt in order with the directory it was typed in (Claude). A part
 * that ended in a Stop counted the transcript's first prompts, cumulatively,
 * so the greatest such part covers that many; a part with no Stop counted its
 * own scope's first prompts, which add only where they come after those.
 * Undefined when the credit mixes no such parts, or no transcript places them.
 */
export async function creditedPrompts(credit: OwnerCredit, transcripts: string[]): Promise<number | undefined> {
  const parts = credit.parts ?? [];
  const stopped = parts.filter((part) => part.stop);
  const loose = parts.filter((part) => !part.stop);
  if (stopped.length === 0 || loose.length === 0) return undefined;
  const covered = Math.max(...stopped.map((part) => part.prompts));
  const { resolveConfigForDir } = await import('./config.js');
  const keys = new Map<string, Promise<string | undefined>>();
  const keyOf = (cwd: string) => {
    let key = keys.get(cwd);
    if (!key) {
      key = pathExists(cwd).then(async (exists) => {
        const config = exists ? await resolveConfigForDir(cwd, undefined, { dryRun: true }) : null;
        return config ? dataHomeKey(getDataHome(config)) : undefined;
      });
      keys.set(cwd, key);
    }
    return key;
  };
  for (const transcript of [...transcripts].reverse()) {
    const content = await readFileSafe(transcript);
    if (content === null) continue;
    const prompts: string[] = [];
    for (const line of content.split('\n')) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isHumanPromptEntry(entry) || !entry || typeof entry !== 'object' || !('cwd' in entry)) continue;
      if (typeof entry.cwd === 'string') prompts.push(entry.cwd);
    }
    if (prompts.length < covered) continue;
    const scopes = await Promise.all(prompts.map(keyOf));
    let total = covered;
    for (const part of loose) {
      const own = scopes.flatMap((key, i) => (key === part.key ? [i] : [])).slice(0, part.prompts);
      if (own.length < part.prompts) return undefined;
      total += own.filter((i) => i >= covered).length;
    }
    return total;
  }
  return undefined;
}
