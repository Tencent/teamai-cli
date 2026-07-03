// -*- coding: utf-8 -*-
import path from 'node:path';

import YAML from 'yaml';

import type { UserVotes, UserVotesV2, VoteEntryV2 } from './types.js';
import { readFileSafe, writeFile, ensureDir } from './utils/fs.js';
import { log } from './utils/logger.js';

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
 */
export async function saveUserVotes(votePath: string, votes: UserVotesV2): Promise<void> {
  await ensureDir(path.dirname(votePath));
  await writeFile(votePath, YAML.stringify(votes));
}

/**
 * Increment recalled_count for each docId and record the delta.
 */
export async function incrementRecalled(votePath: string, docIds: string[]): Promise<void> {
  if (docIds.length === 0) return;
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
}

/**
 * Increment upvoted_count for each docId and record the delta.
 */
export async function incrementUpvoted(votePath: string, docIds: string[]): Promise<void> {
  if (docIds.length === 0) return;
  const data = await loadUserVotes(votePath);
  const now = new Date().toISOString();

  for (const docId of docIds) {
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

  await saveUserVotes(votePath, data);
}

/**
 * Merge local deltas into a remote votes snapshot.
 * Returns merged result with empty deltas.
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
  }

  return { version: 2, votes, deltas: {} };
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

  const local = await loadUserVotes(localVotePath);

  if (Object.keys(local.deltas).length === 0) {
    return false;
  }

  const remote = await loadUserVotes(remoteVotePath);
  const merged = mergeDeltas(local, remote);

  await saveUserVotes(remoteVotePath, merged);
  await saveUserVotes(localVotePath, { ...local, votes: merged.votes, deltas: {} });

  return true;
}

/**
 * Record manual feedback for a recalled document.
 */
export async function recallFeedback(opts: { positive?: string; negative?: string }): Promise<void> {
  const { requireInit } = await import('./config.js');
  const { localConfig } = await requireInit();
  const { username } = localConfig;
  const { VOTES_LOCAL_DIR } = await import('./types.js');
  const votePath = path.join(VOTES_LOCAL_DIR, `${username}.yaml`);

  if (opts.positive) {
    await incrementUpvoted(votePath, [opts.positive]);
    log.success(`Upvoted: ${opts.positive}`);
    return;
  }

  if (opts.negative) {
    const data = await loadUserVotes(votePath);
    if (!data.votes[opts.negative]) {
      log.warn(`Document not found in votes: ${opts.negative}`);
      return;
    }
    const entry = data.votes[opts.negative];
    if (entry.upvoted_count <= 0) {
      log.warn(`No upvotes to decrement for: ${opts.negative}`);
      return;
    }
    const existingDelta = data.deltas[opts.negative] ?? { recalled_delta: 0, upvoted_delta: 0 };
    const updated: UserVotesV2 = {
      ...data,
      votes: {
        ...data.votes,
        [opts.negative]: { ...entry, upvoted_count: entry.upvoted_count - 1 },
      },
      deltas: {
        ...data.deltas,
        [opts.negative]: { ...existingDelta, upvoted_delta: existingDelta.upvoted_delta - 1 },
      },
    };
    await saveUserVotes(votePath, updated);
    log.success(`Negative signal recorded for: ${opts.negative}`);
    return;
  }

  log.error('Usage: teamai recall feedback --positive <docId> | --negative <docId>');
}
