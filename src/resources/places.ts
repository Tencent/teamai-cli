import { realpath } from 'node:fs/promises';
import { locate, writable, writesOf, type Install } from '../locate.js';
import { realHost, toolHome, type Host } from '../tool-home.js';
import { isToolId, skillsFollowSession } from '../tools.js';
import type { State } from '../types.js';
import { samePath } from '../utils/agent-path.js';
import { log } from '../utils/logger.js';

type CheckoutRecord = NonNullable<State['lastPullByWorkspace']>[string];

/** Per resource, where each tool took it at the last full pull of a checkout (`lastPullByWorkspace[key].places`). */
export type PlacesRecord = NonNullable<CheckoutRecord['places']>;

/** The resources whose places a pull records. MCP's old place is in its ownership manifest instead. */
export type PlacedResource = keyof PlacesRecord;

/** Tool → the absolute places teamai writes a resource to, for each tool whose write gates are met. */
export type Places = NonNullable<PlacesRecord[PlacedResource]>;

/** Tool → its home, for each tool whose skills follow the session. */
export type SessionToolHomes = NonNullable<CheckoutRecord['sessionToolHomes']>;

/**
 * The resources pull records now, each with the line that names a place a
 * tool left. A resource joins once every writer of it goes through `locate`,
 * or the record would name a place pull still writes.
 */
const RECORDED = ['skills', 'rules', 'blocks', 'agents'] as const satisfies readonly PlacedResource[];

type Recorded = (typeof RECORDED)[number];

const LEFT_LINE: { readonly [R in Recorded]: (left: LeftPlace, scopeLabel: string) => string } = {
  skills: ({ tool, place, currentPlace }, scopeLabel) =>
    `[${scopeLabel}] ${tool} takes skills from ${currentPlace} now, so teamai no longer updates its copies in ${place}. Delete them once no tool reads that directory.`,
  rules: ({ tool, place, currentPlace }, scopeLabel) =>
    `[${scopeLabel}] ${tool} takes the team rules from ${currentPlace} now, so teamai no longer updates them in ${place}. Delete them there once no tool reads it.`,
  blocks: ({ tool, place, currentPlace }, scopeLabel) =>
    `[${scopeLabel}] ${tool} takes the instruction blocks from ${currentPlace} now, so teamai no longer updates them in ${place}. Delete them there once no tool reads it.`,
  agents: ({ tool, place, currentPlace }, scopeLabel) =>
    `[${scopeLabel}] ${tool} takes agents from ${currentPlace} now, so teamai no longer updates its copies in ${place}. Delete them once no tool reads that directory.`,
};

/** The places a checkout record names: an earlier release's `skillDirs` reads as `places.skills`. */
export function placesRecordOf(record: Pick<CheckoutRecord, 'places' | 'skillDirs'> | undefined): PlacesRecord | undefined {
  if (record?.places !== undefined) return record.places;
  return record?.skillDirs === undefined ? undefined : { skills: record.skillDirs };
}

/** Where every tool of `install` whose write gates are met takes each recorded resource now, session-following tools included. */
export async function placesOf(install: Install, host: Host = realHost()): Promise<PlacesRecord> {
  const record: PlacesRecord = {};
  for (const resource of RECORDED) {
    const located = await Promise.all(Object.keys(install.toolPaths).sort()
      .map(async (tool) => ({ tool, where: await locate(tool, resource, install, host) })));
    const places: Record<string, string[]> = {};
    for (const { tool, where } of located) if (writable(where) !== null) places[tool] = writesOf(where).map((place) => place.path);
    record[resource] = places;
  }
  return record;
}

export function sessionToolHomesOf(current: PlacesRecord, host: Host = realHost()): SessionToolHomes {
  const tools = new Set(Object.values(current).flatMap((places) => Object.keys(places)));
  return Object.fromEntries([...tools].sort().filter(isToolId).filter(skillsFollowSession).map((tool) => [tool, toolHome(tool, host)]));
}

/**
 * Whether the tools take every recorded resource where the last full pull
 * recorded writing it. A tool whose skills follow the session is compared by
 * its home, as each session may name another place under it.
 */
export async function placesUnmoved(
  recorded: { readonly places: PlacesRecord; readonly sessionToolHomes?: SessionToolHomes },
  current: PlacesRecord,
  host: Host = realHost(),
): Promise<boolean> {
  const asPlaces = (homes: SessionToolHomes): Places => Object.fromEntries(Object.entries(homes).map(([tool, dir]) => [tool, [dir]]));
  for (const resource of RECORDED) {
    const before = recorded.places[resource];
    if (before === undefined || !await samePlaces(before, withoutSessionTools(current[resource] ?? {}, skillsFollowSession))) return false;
  }
  return samePlaces(asPlaces(recorded.sessionToolHomes ?? {}), asPlaces(sessionToolHomesOf(current, host)));
}

function withoutSessionTools(places: Places, followsSession: (tool: string) => boolean): Places {
  return Object.fromEntries(Object.entries(places).filter(([tool]) => !followsSession(tool)));
}

/**
 * Whether `a` and `b` are one place: the same path (`samePath`) once each is
 * resolved through its links. A place that does not exist yet is compared as
 * written. Every comparison of the places a pull recorded goes through here:
 * the pull's fast path, the places the tools left, and doctor.
 */
export async function samePlace(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([realOrSelf(a), realOrSelf(b)]);
  return samePath(ra, rb);
}

async function realOrSelf(place: string): Promise<string> {
  try {
    return await realpath(place);
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return place;
    throw e;
  }
}

/** Whether `place` is one of `places` (`samePlace`). */
export async function amongPlaces(place: string, places: readonly string[]): Promise<boolean> {
  for (const other of places) if (await samePlace(place, other)) return true;
  return false;
}

/** Whether two answers name the same places for the same tools (`samePlace`). */
export async function samePlaces(recorded: Places, current: Places): Promise<boolean> {
  const tools = Object.keys(current);
  if (Object.keys(recorded).length !== tools.length) return false;
  for (const tool of tools) {
    const before = recorded[tool];
    if (before === undefined) return false;
    const after = current[tool];
    for (const place of before) if (!await amongPlaces(place, after)) return false;
    for (const place of after) if (!await amongPlaces(place, before)) return false;
  }
  return true;
}

/** A place `tool` took a resource from at the last full pull and no tool takes it from now; `currentPlace` is where `tool` takes it now. */
export type LeftPlace = { readonly place: string; readonly tool: string; readonly currentPlace: string };

/**
 * What a full pull records for one resource, and which places the tools
 * left, decided over every tool at once. `incomplete` names the tools that
 * did not take every item this pull: they keep their previous places on
 * record, so the next pull syncs them in full again. A place is left when its
 * tool takes the resource elsewhere now, and no tool takes it from there now
 * or keeps it on record. Places are compared by `samePlace`.
 */
export async function settlePlaces({ previous, current, incomplete, followsSession }: {
  readonly previous: Places | undefined;
  readonly current: Places;
  readonly incomplete: ReadonlySet<string>;
  readonly followsSession: (tool: string) => boolean;
}): Promise<{ readonly record: Places; readonly left: readonly LeftPlace[] }> {
  const before: Places = previous ?? {};
  const next: Record<string, string[]> = {};
  for (const [tool, places] of Object.entries(current)) {
    const earlier: string[] = [];
    if (incomplete.has(tool)) for (const place of before[tool] ?? []) if (!await amongPlaces(place, places)) earlier.push(place);
    next[tool] = [...earlier, ...places];
  }
  const live = [...Object.values(current).flat(), ...[...incomplete].flatMap((tool) => before[tool] ?? [])];
  const left: LeftPlace[] = [];
  for (const [tool, places] of Object.entries(before)) {
    const currentPlaces = current[tool];
    if (currentPlaces === undefined || incomplete.has(tool) || followsSession(tool)) continue;
    for (const place of places) {
      if (!await amongPlaces(place, [...live, ...left.map((other) => other.place)])) left.push({ place, tool, currentPlace: currentPlaces[0] });
    }
  }
  return { record: withoutSessionTools(next, followsSession), left };
}

/**
 * Name each place the tools left (`settlePlaces`), per recorded resource, and
 * return what to record: the `places`, and the `sessionToolHomes` of each
 * session-following tool that took every item. An incomplete one keeps the
 * home recorded before.
 *
 * teamai's copies in a left place stay: another shell, another checkout or a
 * tool teamai does not manage may still read it, and no pull can rule that
 * out. The member deletes them.
 */
export async function recordPlaces({ previous, current, incomplete, scopeLabel, host = realHost() }: {
  readonly previous: Pick<CheckoutRecord, 'places' | 'skillDirs' | 'sessionToolHomes'> | undefined;
  readonly current: PlacesRecord;
  readonly incomplete: { readonly [R in Recorded]: ReadonlySet<string> };
  readonly scopeLabel: string;
  readonly host?: Host;
}): Promise<{ readonly places: PlacesRecord; readonly sessionToolHomes: SessionToolHomes }> {
  const before = placesRecordOf(previous);
  const places: PlacesRecord = { ...before };
  for (const resource of RECORDED) {
    const now = current[resource];
    if (now === undefined) continue;
    const { record, left } = await settlePlaces({ previous: before?.[resource], current: now, incomplete: incomplete[resource], followsSession: skillsFollowSession });
    for (const place of left) log.info(LEFT_LINE[resource](place, scopeLabel));
    places[resource] = record;
  }
  const held = new Set(RECORDED.flatMap((resource) => [...incomplete[resource]]));
  const sessionToolHomes: SessionToolHomes = {};
  for (const [tool, home] of Object.entries(sessionToolHomesOf(current, host))) {
    sessionToolHomes[tool] = held.has(tool) ? (previous?.sessionToolHomes?.[tool] ?? home) : home;
  }
  return { places, sessionToolHomes };
}
