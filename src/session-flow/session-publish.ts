/**
 * Sessions published under `sessions.publish` `auto` (#1385): the captured sessions of a run mode once they are
 * finished, and the step sessions of the runs driven here in that mode once they ended, each archived once, scrubbed,
 * on teamai-reports. A data home records each session it archived, and each step session it can never archive from
 * here, so a later pass skips it; a push that failed records nothing, and the next pass tries it again.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { RunMode } from '../launch-context.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { readFileSafe } from '../utils/fs.js';
import { runPasses, type RunPass } from '../workflow/loop.js';
import { privateSteps } from '../workflow/scope.js';
import { settledHere } from '../workflow/judge-work.js';
import { installOwner, readRuns } from '../workflow/store.js';
import type { RunState } from '../workflow/types.js';
import { isIsolated } from '../workflow/workspace.js';
import { AgentSession, recordedToolRoots, sessionKey, type AgentSessionFailure, type ToolRootsLookup } from './agent-session.js';
import { archiveSessions, type ArchiveSessionRef } from './archive.js';
import { SessionWork } from './session-work.js';

/** A session by the platform teamai reads it from, or, when teamai reads no sessions from its tool, by that tool. */
type PublishedKey = { kind: 'platform'; platform: string; sessionId: string } | { kind: 'tool'; tool: string; sessionId: string };

const platformKey = ({ platform, sessionId }: ArchiveSessionRef): PublishedKey => ({ kind: 'platform', platform, sessionId });

/** What a data home did with a session, once: archived it, or skipped it for a reason that will not change here. */
type PublicationRecord = PublishedKey & ({ publishedAt: string } | { skippedAt: string; reason: string });

/** The file that records what this data home did with `key`: its name hashes the platform, or the tool, and the id. */
function recordFile(config: LocalConfig, key: PublishedKey): string {
  const name = createHash('sha256').update(recordName(key)).digest('hex').slice(0, 32);

  return path.join(getDataHome(config), 'sessions', 'published', `${name}.json`);
}

function recordName(key: PublishedKey): string {
  switch (key.kind) {
    case 'platform':
      return sessionKey(key);
    case 'tool':
      return `tool\0${key.tool}\0${key.sessionId}`;
    default: {
      const unhandled: never = key;

      return unhandled;
    }
  }
}

/** Whether this data home archived `key`, or recorded it as one it can never archive from here. */
async function hasRecord(config: LocalConfig, key: PublishedKey): Promise<boolean> {
  return fs.stat(recordFile(config, key)).then(() => true, () => false);
}

/** Whether this data home archived session `ref`. */
const isRecorded = (config: LocalConfig, ref: ArchiveSessionRef): Promise<boolean> => hasRecord(config, platformKey(ref));

const RecordTimeSchema = z.union([z.object({ publishedAt: z.string() }), z.object({ skippedAt: z.string() })]);

/** When this data home last archived session `ref`; Infinity for one it can never archive from here, undefined for none. */
async function archivedAt(config: LocalConfig, ref: ArchiveSessionRef): Promise<number | undefined> {
  const text = await readFileSafe(recordFile(config, platformKey(ref)));

  if (text === null) return undefined;

  try {
    const parsed = RecordTimeSchema.safeParse(JSON.parse(text));

    if (!parsed.success) return undefined;

    return 'publishedAt' in parsed.data ? Date.parse(parsed.data.publishedAt) : Infinity;
  } catch {
    return undefined;
  }
}

/** Records that this data home archived session `ref` at `at`, as a push of it does. */
const recordArchived = (config: LocalConfig, ref: ArchiveSessionRef, at: string): Promise<void> => record(config, { ...platformKey(ref), publishedAt: at });

async function record(config: LocalConfig, entry: PublicationRecord): Promise<void> {
  const file = recordFile(config, entry);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

/** What one publish pass did with the step sessions of one run. */
export interface StepSessionsPublished {
  run: string;
  archived: number;
  /** The passes whose session cannot be archived from here, and why. Each is recorded, so no later pass lists it again. */
  skipped: Array<{ step: string; pass: number; reason: string }>;
  unpublished?: { sessions: number; reason: string };
}

/** Why step session `key` cannot be read here: teamai reads no sessions of its tool, or its platform failed to read it. */
type ReadFailure = { kind: 'tool'; tool: string } | { kind: 'platform'; platform: string; failure: AgentSessionFailure };

/** What keeps this machine from reading step session `key`, or undefined when it reads it. */
async function readFailure(key: PublishedKey, toolRootsFor: ToolRootsLookup): Promise<ReadFailure | undefined> {
  switch (key.kind) {
    case 'tool':
      return { kind: 'tool', tool: key.tool };
    case 'platform': {
      const found = await AgentSession.find({ platform: key.platform, sessionId: key.sessionId }, { scrub: false, toolRootsFor });

      return found.status === 'done' ? undefined : { kind: 'platform', platform: key.platform, failure: found.failure };
    }

    default: {
      const unhandled: never = key;

      return unhandled;
    }
  }
}

/** `failure`, as the reason a run's unreadable sessions share lists it. */
function failureText(failure: AgentSessionFailure): string {
  switch (failure.code) {
    case 'not_found':
      return 'not found';
    case 'unreadable':
      return 'unreadable';
    case 'no_adapter':
      return 'teamai has no reader for them here';
    case 'tool_unavailable':
      return 'the tool is not installed here';
    case 'list_failed':
      return 'listing them failed';
    case 'invalid_workspace':
      return 'their workspace is gone';
    case 'write_failed':
      return 'a write failed';
    case 'copy_busy':
      return 'another teamai process held them';
    default: {
      const unhandled: never = failure;

      return unhandled;
    }
  }
}

/**
 * Why the step sessions of one run that `failures` keep from being read here are never archived from this machine: one
 * reason for the whole run, never per session or per tool, so the drain says them in one line per run.
 */
function skippedReason(failures: readonly ReadFailure[]): string {
  const causes = new Map<string, Set<string>>();

  for (const failure of failures) {
    const [source, cause] = failure.kind === 'tool' ? [failure.tool, 'teamai reads no sessions from it'] : [failure.platform, failureText(failure.failure)];
    causes.set(source, (causes.get(source) ?? new Set()).add(cause));
  }

  const [only, ...others] = causes;

  if (only !== undefined && others.length === 0) {
    const [source, said] = only;

    if (failures[0]?.kind === 'tool') return `teamai reads no sessions from ${source}`;

    return failures.length > 1
      ? `${source} could not read these sessions here (${[...said].join(', ')}), so they stay unarchived`
      : `${source} could not read this session here (${[...said].join(', ')}), so it stays unarchived`;
  }

  return `these sessions could not be read here (${[...causes].map(([source, said]) => `${source}: ${[...said].join(', ')}`).join('; ')}), so they stay unarchived`;
}

type UnrecordedPass = { pass: RunPass; key: PublishedKey };

/**
 * Each run of this data home that ended in `mode` (a run with no mode counts as attended), with the step sessions a
 * publish pass has yet to archive or skip: of each pass settled here that names its tool and session, the session,
 * unless this data home recorded it already.
 */
async function unrecordedSteps(config: LocalConfig, mode: RunMode): Promise<Array<{ run: RunState; passes: UnrecordedPass[] }>> {
  // An isolated run stays on the machine that started it, and so do its steps' sessions.
  const ended = (await readRuns(config)).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).filter((run) => run.status !== 'running' && !isIsolated(run) && (run.runMode ?? 'attended') === mode);

  if (ended.length === 0) return [];
  const install = (await installOwner(config)).id;
  const runs: Array<{ run: RunState; passes: UnrecordedPass[] }> = [];

  for (const run of ended) {
    const passes: UnrecordedPass[] = [];
    // A private workflow's steps stay on this machine, and so do their sessions.
    const isPrivate = privateSteps(run);

    for (const pass of runPasses(run)) {
      if (pass.tool === undefined || pass.session === undefined || !settledHere(run, pass, install) || isPrivate(pass.step)) continue;
      const platform = AgentSession.platformForTool(pass.tool);
      const key: PublishedKey = platform ? { kind: 'platform', platform, sessionId: pass.session } : { kind: 'tool', tool: pass.tool, sessionId: pass.session };

      if (!await hasRecord(config, key)) passes.push({ pass, key });
    }

    runs.push({ run, passes });
  }

  return runs;
}

/** How many step sessions of the runs that ended in `mode` the next publish pass in that mode archives or skips. */
async function waitingSteps(config: LocalConfig, mode: RunMode): Promise<number> {
  return (await unrecordedSteps(config, mode)).reduce((sum, { passes }) => sum + passes.length, 0);
}

/**
 * Archives the step sessions of each run of this data home that ended in `mode` and that it has not recorded yet. A
 * session this machine cannot read is recorded as skipped, and the readable ones of its run are still archived. One
 * push per run, filed under the repository of the checkout the run started in.
 */
async function steps(config: LocalConfig, mode: RunMode, now: string): Promise<StepSessionsPublished[]> {
  const published: StepSessionsPublished[] = [];

  for (const { run, passes } of await unrecordedSteps(config, mode)) {
    const checkout = run.checkout ?? SessionWork.scopeCwd(config);
    const toolRoots = recordedToolRoots(checkout);
    const refs = new Map<string, ArchiveSessionRef>();
    const unread: Array<UnrecordedPass & { failure: ReadFailure }> = [];

    for (const { pass, key } of passes) {
      const failure = await readFailure(key, () => toolRoots);

      if (failure !== undefined) unread.push({ pass, key, failure });
      else if (key.kind === 'platform') refs.set(sessionKey(key), { platform: key.platform, sessionId: key.sessionId });
    }

    const reason = skippedReason(unread.map(({ failure }) => failure));
    const skipped: StepSessionsPublished['skipped'] = [];

    for (const { pass, key } of unread) {
      skipped.push({ step: pass.step, pass: pass.pass, reason });
      await record(config, { ...key, skippedAt: now, reason });
    }

    if (refs.size === 0) {
      if (skipped.length > 0) published.push({ run: run.id, archived: 0, skipped });
      continue;
    }

    const delivered = await archiveSessions(config, [...refs.values()].map((ref) => [ref]), { run: run.id, checkout });

    if (delivered.status === 'failed') {
      published.push({ run: run.id, archived: 0, skipped, unpublished: { sessions: refs.size, reason: delivered.message } });
      continue;
    }

    for (const ref of delivered.archived) await record(config, { ...platformKey(ref), publishedAt: now });
    published.push({ run: run.id, archived: delivered.archived.length, skipped });
  }

  return published;
}

export const SessionPublish = { steps, waitingSteps, isRecorded, archivedAt, recordArchived } as const;
