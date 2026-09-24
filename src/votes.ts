// -*- coding: utf-8 -*-
import path from 'node:path';

import YAML from 'yaml';

import type { UserVotes, UserVotesV2, VoteEntryV2 } from './types.js';
import { readFileSafe, writeFileAtomic, ensureDir, expandHome } from './utils/fs.js';
import { log } from './utils/logger.js';

/**
 * Run `fn` while holding an exclusive per-file lock, so the read-modify-write in
 * incrementUpvoted is serialized across processes. This matters because the
 * foreground votesSyncHandler and the detached background votesJudgeHandler
 * (issue #723) can both increment the same votes file: without a lock their
 * load→save windows can overlap and one increment would be lost.
 *
 * Reuses the shared acquireLock/releaseLock (update.ts), which records the owner
 * PID and reclaims a stale lock whose owner process is gone — so a crashed
 * detached judge cannot orphan the lock forever. If the lock genuinely cannot be
 * taken within the retry budget (a live peer is mid-write), we SKIP `fn` and log
 * it rather than racing unlocked. Be honest about the consequence: a skipped
 * increment writes NO delta, so it is simply dropped — it does NOT reconcile on
 * the next pull. That is an accepted tradeoff (an upvote is a best-effort
 * statistical signal, and the retry budget makes exhaustion rare) and is far
 * cheaper than the corruption a lost/overlapping write would cause. Returns
 * whether `fn` ran, so callers that care can react. */

/**
 * Result of a locked mutation: whether the lock was held (and `fn` ran) and, when
 * it did, the value `fn` returned. When `acquired` is false the caller MUST treat
 * the mutation as NOT applied (contention/exhaustion) rather than assuming success.
 */
export interface LockedResult<T> {
  acquired: boolean;
  value?: T;
}

export async function withVotesLock<T>(
  votePath: string,
  fn: () => Promise<T>,
): Promise<LockedResult<T>> {
  const { acquireLock, releaseLock } = await import('./update.js');
  const lockPath = `${votePath}.lock`;
  const maxAttempts = 25; // ~2.5s total at 100ms
  let held = false;
  for (let i = 0; i < maxAttempts; i++) {
    if (await acquireLock(lockPath)) { held = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!held) {
    log.debug(`withVotesLock: could not acquire votes lock for ${votePath}; mutation NOT applied`);
    return { acquired: false };
  }
  try {
    const value = await fn();
    return { acquired: true, value };
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * The per-session set of doc-ids already upvoted, persisted INSIDE the votes file
 * (so the claim and the increment are one atomic, lock-protected write). Keyed by
 * sessionId; entries are pruned by age so the file does not grow without bound.
 */
interface UpvoteLedger {
  //  - firstTs: when this session first appeared in the ledger. The TTL is
  //    measured from THIS, not from the last credit, so a doc adopted early in a
  //    long/resumed session cannot be re-credited later just because the entry
  //    was refreshed — the entry ages out (and its dedup guarantee ends) a fixed
  //    window after the session started, not perpetually.
  //  - ts: last-updated, kept for observability only.
  [sessionId: string]: { docIds: string[]; ts: string; firstTs: string };
}

const LEDGER_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

function readLedger(data: UserVotesV2): UpvoteLedger {
  const raw = (data as unknown as { upvotedSessions?: unknown }).upvotedSessions;
  if (!raw || typeof raw !== 'object') return {};
  // Shape-validate each entry: a hand-edited/corrupted file must not, for example,
  // let a string `docIds` be iterated per-character. Drop malformed entries.
  const out: UpvoteLedger = {};
  for (const [sid, e] of Object.entries(raw as Record<string, unknown>)) {
    const entry = e as { docIds?: unknown; ts?: unknown; firstTs?: unknown } | null;
    if (entry && Array.isArray(entry.docIds) && typeof entry.ts === 'string') {
      // Back-compat: entries written before firstTs existed fall back to ts.
      const firstTs = typeof entry.firstTs === 'string' ? entry.firstTs : entry.ts;
      out[sid] = {
        docIds: entry.docIds.filter((d): d is string => typeof d === 'string'),
        ts: entry.ts,
        firstTs,
      };
    }
  }
  return out;
}

/** Drop ledger entries whose FIRST-seen time is older than the TTL (or with an
 *  unparseable timestamp). Measuring from firstTs — not the last-updated ts —
 *  keeps the per-session dedup window from sliding forever when a long session
 *  keeps refreshing its entry, so a doc can be credited at most once per session
 *  within the window. Returns true when it removed anything, so callers can
 *  avoid a needless rewrite. */
function pruneLedger(ledger: UpvoteLedger, now: number): boolean {
  let changed = false;
  for (const [sid, e] of Object.entries(ledger)) {
    const t = Date.parse(e?.firstTs ?? e?.ts ?? '');
    if (!Number.isFinite(t) || now - t > LEDGER_TTL_MS) { delete ledger[sid]; changed = true; }
  }
  return changed;
}

/**
 * The doc-ids already credited for `sessionId` in the in-file ledger. Read-only
 * (no lock needed — a stale read only means a candidate is judged one extra time,
 * never a double-count, since incrementUpvoted dedups under the lock). The judge
 * uses this to skip docs the foreground pass already upvoted, so it does not burn
 * a local-CLI call on a candidate that would dedup to nothing (issue #723 review).
 */
export async function creditedDocIdsForSession(votePath: string, sessionId: string): Promise<Set<string>> {
  try {
    // Read WITHOUT loadUserVotes: on a v1 file loadUserVotes performs an
    // unlocked auto-migration write, which could clobber a concurrent locked
    // increment with a stale snapshot (issue #723 review). This read-only helper
    // parses the YAML directly and never writes; the ledger only exists in v2
    // files anyway, so a v1/absent/corrupt file simply yields an empty set.
    const content = await readFileSafe(votePath);
    if (!content) return new Set();
    let parsed: unknown;
    try { parsed = YAML.parse(content); } catch { return new Set(); }
    if (!parsed || typeof parsed !== 'object') return new Set();
    const ledger = readLedger(parsed as UserVotesV2);
    return new Set(ledger[sessionId]?.docIds ?? []);
  } catch {
    return new Set();
  }
}

/**
 * Prune stale entries from the in-file upvote ledger under the lock. Called from
 * the sync path so the ledger is bounded even in the default (judge-off) config
 * where a recall-but-never-adopt session never reaches incrementUpvoted (issue
 * #723 review). Only writes when something was actually pruned.
 */
export async function pruneUpvoteLedger(votePath: string): Promise<void> {
  await withVotesLock(votePath, async () => {
    const data = await loadUserVotes(votePath);
    const ledger = readLedger(data);
    if (Object.keys(ledger).length === 0) return;
    if (!pruneLedger(ledger, Date.now())) return;
    (data as unknown as { upvotedSessions: UpvoteLedger }).upvotedSessions = ledger;
    await saveUserVotes(votePath, data);
  });
}

/**
 * Migrate v1 votes format to v2 dual-counter format.
 */
export function migrateV1ToV2(v1: UserVotes): UserVotesV2 {
  const votes: Record<string, VoteEntryV2> = {};
  for (const [docId, entry] of Object.entries(v1.votes)) {
    votes[docId] = {
      recalled_count: 1,
      upvoted_count: 0,
      last_recalled_at: entry.at,
    };
  }
  return { version: 2, votes, deltas: {} };
}

/**
 * Load user votes from a YAML file, auto-migrating v1 to v2 on first read.
 */
export async function loadUserVotes(votePath: string): Promise<UserVotesV2> {
  const content = await readFileSafe(votePath);
  if (!content) return { version: 2, votes: {}, deltas: {} };

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    return { version: 2, votes: {}, deltas: {} };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { version: 2, votes: {}, deltas: {} };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj['version'] === 2) {
    const v2 = obj as unknown as UserVotesV2;
    if (!v2.deltas) v2.deltas = {};
    return v2;
  }

  if (obj['votes'] !== undefined) {
    const migrated = migrateV1ToV2(obj as unknown as UserVotes);
    await saveUserVotes(votePath, migrated);
    return migrated;
  }

  return { version: 2, votes: {}, deltas: {} };
}

/**
 * Persist user votes to a YAML file.
 *
 * Uses an atomic temp-file + rename write: this file is mutated by BOTH the
 * foreground Stop handler and the detached background judge (a process that can
 * be killed mid-run when the user closes the IDE or the machine sleeps). A torn
 * plain overwrite would leave truncated YAML, and loadUserVotes falls back to an
 * empty object on any parse error — silently wiping every doc's counts, all
 * pending deltas, and the whole upvote ledger. rename(2) within a filesystem is
 * atomic, so a reader always sees either the old or the new complete file.
 */
export async function saveUserVotes(votePath: string, votes: UserVotesV2): Promise<void> {
  await ensureDir(path.dirname(votePath));
  await writeFileAtomic(votePath, YAML.stringify(votes));
}

/**
 * Increment recalled_count for each docId and record the delta. Serialized under
 * the same per-file lock as upvote/sync so it cannot race those writers. Returns
 * false when the lock could not be taken (mutation NOT applied).
 */
export async function incrementRecalled(votePath: string, docIds: string[]): Promise<boolean> {
  if (docIds.length === 0) return true;
  const { acquired } = await withVotesLock(votePath, async () => {
    const data = await loadUserVotes(votePath);
    const now = new Date().toISOString();

    for (const docId of docIds) {
      if (!data.votes[docId]) {
        data.votes[docId] = { recalled_count: 0, upvoted_count: 0, last_recalled_at: '' };
      }
      data.votes[docId].recalled_count++;
      data.votes[docId].last_recalled_at = now;

      if (!data.deltas[docId]) {
        data.deltas[docId] = { recalled_delta: 0, upvoted_delta: 0 };
      }
      data.deltas[docId].recalled_delta++;
    }

    await saveUserVotes(votePath, data);
  });
  return acquired;
}

/**
 * Increment upvoted_count for each docId and record the delta.
 *
 * Concurrency + idempotency are one atomic step. When `sessionId` is provided,
 * the per-session ledger (persisted INSIDE the votes file) is read AND updated
 * under the same lock as the increment, so:
 *   - the foreground handler and the detached judge cannot double-count a doc
 *     (whoever runs first records it in the ledger; the other sees it credited);
 *   - a doc is credited at most once per session even across repeated Stops;
 *   - the claim never precedes a failed write — if the lock is not taken, nothing
 *     is claimed and nothing is credited, so a later Stop retries cleanly.
 *
 * Returns the doc-ids actually credited by THIS call (the ledger-fresh subset),
 * or `null` when the lock could not be acquired (mutation not applied). Without a
 * sessionId every input doc is credited (manual feedback path).
 */
export async function incrementUpvoted(
  votePath: string,
  docIds: string[],
  sessionId?: string,
): Promise<string[] | null> {
  if (docIds.length === 0) return [];
  const { acquired, value } = await withVotesLock(votePath, async () => {
    const data = await loadUserVotes(votePath);
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);

    // Ledger dedup (only when a session is known).
    let toCredit = docIds;
    let ledger: UpvoteLedger | null = null;
    if (sessionId) {
      ledger = readLedger(data);
      const pruned = pruneLedger(ledger, nowMs);
      const seen = new Set(ledger[sessionId]?.docIds ?? []);
      toCredit = docIds.filter((id) => !seen.has(id));
      if (toCredit.length === 0) {
        // Nothing new to credit. Only rewrite if pruning actually changed the
        // ledger, to avoid a needless write on every repeated Stop.
        if (pruned) {
          (data as unknown as { upvotedSessions: UpvoteLedger }).upvotedSessions = ledger;
          await saveUserVotes(votePath, data);
        }
        return [] as string[];
      }
    }

    for (const docId of toCredit) {
      if (!data.votes[docId]) {
        data.votes[docId] = { recalled_count: 0, upvoted_count: 0, last_recalled_at: '' };
      }
      data.votes[docId].upvoted_count++;
      data.votes[docId].last_upvoted_at = now;

      if (!data.deltas[docId]) {
        data.deltas[docId] = { recalled_delta: 0, upvoted_delta: 0 };
      }
      data.deltas[docId].upvoted_delta++;
    }

    if (sessionId && ledger) {
      const existing = ledger[sessionId];
      const prev = new Set(existing?.docIds ?? []);
      for (const id of toCredit) prev.add(id);
      // Preserve firstTs across turns so the TTL measures age from session start.
      ledger[sessionId] = { docIds: [...prev], ts: now, firstTs: existing?.firstTs ?? now };
      (data as unknown as { upvotedSessions: UpvoteLedger }).upvotedSessions = ledger;
    }

    await saveUserVotes(votePath, data);
    return toCredit;
  });
  if (!acquired) return null;
  return value ?? [];
}

/**
 * Merge local deltas into a remote votes snapshot.
 * Returns merged result with empty deltas.
 *
 * Scope note: this is a delta-merge, not a full-snapshot consistency sweep.
 * The zeroed-counter timestamp cleanup below only runs for docs that appear
 * in `local.deltas` — pure-remote docs with no local delta are copied as-is
 * and are NOT re-validated. Callers needing a full consistency pass must run
 * it separately; do not assume mergeDeltas sanitizes the entire result.
 */
export function mergeDeltas(local: UserVotesV2, remote: UserVotesV2): UserVotesV2 {
  const votes: Record<string, VoteEntryV2> = {};

  for (const [docId, entry] of Object.entries(remote.votes)) {
    votes[docId] = { ...entry };
  }

  for (const [docId, delta] of Object.entries(local.deltas)) {
    if (!votes[docId]) {
      votes[docId] = { recalled_count: 0, upvoted_count: 0, last_recalled_at: '' };
    }

    votes[docId].recalled_count = Math.max(0, votes[docId].recalled_count + delta.recalled_delta);
    votes[docId].upvoted_count = Math.max(0, votes[docId].upvoted_count + delta.upvoted_delta);

    const localEntry = local.votes[docId];
    if (localEntry) {
      if (localEntry.last_recalled_at > (votes[docId].last_recalled_at ?? '')) {
        votes[docId].last_recalled_at = localEntry.last_recalled_at;
      }
      if (
        localEntry.last_upvoted_at !== undefined &&
        localEntry.last_upvoted_at > (votes[docId].last_upvoted_at ?? '')
      ) {
        votes[docId].last_upvoted_at = localEntry.last_upvoted_at;
      }
    }

    // Consistency constraint: a zeroed counter must not retain a timestamp.
    if (votes[docId].recalled_count === 0) {
      votes[docId].last_recalled_at = '';
    }
    if (votes[docId].upvoted_count === 0) {
      delete votes[docId].last_upvoted_at;
    }
  }

  return { version: 2, votes, deltas: {} };
}

/** True when the local votes file still has deltas not yet synced to the team repo. */
export async function hasPendingVoteDeltas(localVotesDir: string, username: string): Promise<boolean> {
  const local = await loadUserVotes(path.join(localVotesDir, `${username}.yaml`));
  return Object.keys(local.deltas).length > 0;
}

/**
 * Sync local vote deltas to the team repo votes file for a given user.
 * Returns true if sync was performed, false if deltas were empty.
 */
export async function syncVotesToTeam(
  repoPath: string,
  username: string,
  localVotesDir: string,
): Promise<boolean> {
  const localVotePath = path.join(localVotesDir, `${username}.yaml`);
  const remoteVotePath = path.join(repoPath, 'votes', `${username}.yaml`);

  // The entire snapshot → remote-write → local-clear runs UNDER ONE lock hold.
  // Releasing between snapshot and clear (the earlier design) let a concurrent
  // sync apply the same snapshot twice and re-write the remote; holding the lock
  // across the whole critical section makes the sync atomic w.r.t. other vote
  // writers on this machine. The remote write sits inside the hold too, so a
  // second sync cannot start until this one has cleared its synced deltas.
  const { acquired, value } = await withVotesLock(localVotePath, async () => {
    const local = await loadUserVotes(localVotePath);
    if (Object.keys(local.deltas).length === 0) return false;

    const syncedDeltas = local.deltas;
    const remote = await loadUserVotes(remoteVotePath);
    const merged = mergeDeltas(local, remote);
    await saveUserVotes(remoteVotePath, merged);

    // Clear ONLY the deltas we just synced. A concurrent incrementUpvoted cannot
    // interleave (we hold the lock), but this subtraction is still the correct
    // shape and keeps the local running tally (`local.votes`) intact.
    const remainingDeltas: UserVotesV2['deltas'] = {};
    for (const [docId, delta] of Object.entries(local.deltas)) {
      const synced = syncedDeltas[docId];
      const recalled_delta = delta.recalled_delta - (synced?.recalled_delta ?? 0);
      const upvoted_delta = delta.upvoted_delta - (synced?.upvoted_delta ?? 0);
      if (recalled_delta !== 0 || upvoted_delta !== 0) {
        remainingDeltas[docId] = { recalled_delta, upvoted_delta };
      }
    }
    await saveUserVotes(localVotePath, { ...local, deltas: remainingDeltas });
    return true;
  });

  // Lock not taken → nothing synced; the deltas remain for the next attempt.
  if (!acquired) return false;
  return value ?? false;
}

/**
 * Record manual feedback for a recalled document.
 */
export async function recallFeedback(opts: { positive?: string; negative?: string }): Promise<void> {
  const { resolveConfigForDir, findUnreadableProjectConfig, throwMissingOrInvalid, BROKEN_CONFIG_ADVICE } = await import('./config.js');
  // The votes of the cwd's scope (#787). An unreadable project config falls
  // back to no other scope: the feedback would reach that scope's team.
  const localConfig = await resolveConfigForDir();
  if (!localConfig) {
    const unreadable = await findUnreadableProjectConfig();
    let reason: string;
    if (unreadable) {
      const { firstLine } = await import('./skill-content.js');
      reason = `${firstLine(unreadable)}. ${BROKEN_CONFIG_ADVICE}`;
    } else {
      // No user config, or one that cannot be read: say which.
      const { getUserConfigPath } = await import('./types.js');
      reason = await throwMissingOrInvalid(expandHome(getUserConfigPath()))
        .catch((e: unknown) => e instanceof Error ? e.message : String(e));
    }
    log.error(`No feedback recorded: ${reason}`);
    process.exitCode = 1;
    return;
  }
  const { getVotesDir, getReportsDir } = await import('./types.js');
  const votePath = path.join(getVotesDir(localConfig), `${localConfig.username}.yaml`);

  if (opts.positive) {
    // No sessionId → credit unconditionally. Report honestly: only claim
    // "Upvoted" when the locked write actually landed (null = contention).
    const credited = await incrementUpvoted(votePath, [opts.positive]);
    if (credited === null) {
      log.warn(`Could not record upvote for ${opts.positive}: votes file is busy, try again`);
    } else {
      log.success(`Upvoted: ${opts.positive}`);
    }
    return;
  }

  if (opts.negative) {
    // Serialize under the same per-file lock as upvote/sync so a manual
    // downvote cannot race the detached judge or a sync clearing deltas.
    const { acquired, value } = await withVotesLock(votePath, async () => {
      const data = await loadUserVotes(votePath);
      // The scope's own file starts empty on upgrade (#787), so the upvotes its
      // team already holds count too: that file plus the deltas not yet pushed.
      const team = await loadUserVotes(path.join(getReportsDir(localConfig), 'votes', `${localConfig.username}.yaml`));
      const teamEntry = team.votes[opts.negative!];
      const known = data.votes[opts.negative!] ?? teamEntry;
      if (!known) return 'missing' as const;
      const entry: VoteEntryV2 = {
        ...known,
        upvoted_count: Math.max(
          data.votes[opts.negative!]?.upvoted_count ?? 0,
          (teamEntry?.upvoted_count ?? 0) + (data.deltas[opts.negative!]?.upvoted_delta ?? 0),
        ),
      };
      if (entry.upvoted_count <= 0) return 'none' as const;

      const existingDelta = data.deltas[opts.negative!] ?? { recalled_delta: 0, upvoted_delta: 0 };
      const decrementedCount = entry.upvoted_count - 1;
      const updatedEntry: VoteEntryV2 = { ...entry, upvoted_count: decrementedCount };
      if (decrementedCount === 0) delete updatedEntry.last_upvoted_at;
      const updated: UserVotesV2 = {
        ...data,
        votes: { ...data.votes, [opts.negative!]: updatedEntry },
        deltas: { ...data.deltas, [opts.negative!]: { ...existingDelta, upvoted_delta: existingDelta.upvoted_delta - 1 } },
      };
      await saveUserVotes(votePath, updated);
      return 'ok' as const;
    });
    if (!acquired) {
      log.warn(`Could not record negative signal for ${opts.negative}: votes file is busy, try again`);
    } else if (value === 'missing') {
      log.warn(`Document not found in votes: ${opts.negative}`);
    } else if (value === 'none') {
      log.warn(`No upvotes to decrement for: ${opts.negative}`);
    } else {
      log.success(`Negative signal recorded for: ${opts.negative}`);
    }
    return;
  }

  log.error('Usage: teamai recall feedback --positive <docId> | --negative <docId>');
}
