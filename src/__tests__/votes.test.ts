// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

import {
  migrateV1ToV2,
  loadUserVotes,
  saveUserVotes,
  incrementRecalled,
  incrementUpvoted,
  mergeDeltas,
  syncVotesToTeam,
  recallFeedback,
  hasPendingVoteDeltas,
  pruneUpvoteLedger,
  creditedDocIdsForSession,
} from '../votes.js';
import type { UserVotes, UserVotesV2 } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-votes-test-'));
  process.env.HOME = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrateV1ToV2', () => {
  it('converts v1 entries to v2 with recalled_count=1', () => {
    const v1: UserVotes = {
      votes: {
        'doc-a': { at: '2026-06-01T00:00:00Z' },
        'doc-b': { at: '2026-06-02T00:00:00Z' },
      },
    };
    const v2 = migrateV1ToV2(v1);

    expect(v2.version).toBe(2);
    expect(v2.votes['doc-a'].recalled_count).toBe(1);
    expect(v2.votes['doc-a'].upvoted_count).toBe(0);
    expect(v2.votes['doc-a'].last_recalled_at).toBe('2026-06-01T00:00:00Z');
    expect(v2.votes['doc-b'].recalled_count).toBe(1);
    expect(v2.deltas).toEqual({});
  });

  it('handles empty v1', () => {
    const v2 = migrateV1ToV2({ votes: {} });
    expect(v2.version).toBe(2);
    expect(Object.keys(v2.votes)).toHaveLength(0);
  });
});

describe('loadUserVotes', () => {
  it('returns empty v2 for non-existent file', async () => {
    const result = await loadUserVotes(path.join(tmpDir, 'nonexistent.yaml'));
    expect(result.version).toBe(2);
    expect(Object.keys(result.votes)).toHaveLength(0);
  });

  it('auto-migrates v1 file on read', async () => {
    const v1: UserVotes = { votes: { 'doc-x': { at: '2026-06-01T00:00:00Z' } } };
    const filePath = path.join(tmpDir, 'user.yaml');
    fs.writeFileSync(filePath, YAML.stringify(v1));

    const result = await loadUserVotes(filePath);
    expect(result.version).toBe(2);
    expect(result.votes['doc-x'].recalled_count).toBe(1);

    // Verify file was rewritten as v2
    const onDisk = YAML.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(onDisk.version).toBe(2);
  });

  it('reads v2 file directly', async () => {
    const v2: UserVotesV2 = {
      version: 2,
      votes: { 'doc-y': { recalled_count: 3, upvoted_count: 1, last_recalled_at: '2026-06-01T00:00:00Z' } },
      deltas: { 'doc-y': { recalled_delta: 1, upvoted_delta: 0 } },
    };
    const filePath = path.join(tmpDir, 'user.yaml');
    fs.writeFileSync(filePath, YAML.stringify(v2));

    const result = await loadUserVotes(filePath);
    expect(result.votes['doc-y'].recalled_count).toBe(3);
    expect(result.deltas['doc-y'].recalled_delta).toBe(1);
  });

  it('recovers from corrupt YAML', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    fs.writeFileSync(filePath, '{{{{ not yaml }}}}');

    const result = await loadUserVotes(filePath);
    expect(result.version).toBe(2);
    expect(Object.keys(result.votes)).toHaveLength(0);
  });
});

describe('hasPendingVoteDeltas', () => {
  it('is false when there is no votes file', async () => {
    expect(await hasPendingVoteDeltas(tmpDir, 'alice')).toBe(false);
  });

  it('is true only when the local file still holds deltas', async () => {
    const filePath = path.join(tmpDir, 'alice.yaml');
    await saveUserVotes(filePath, {
      version: 2,
      votes: { 'doc-a': { recalled_count: 1, upvoted_count: 0, last_recalled_at: '2026-06-01T00:00:00Z' } },
      deltas: { 'doc-a': { recalled_delta: 1, upvoted_delta: 0 } },
    });
    expect(await hasPendingVoteDeltas(tmpDir, 'alice')).toBe(true);

    await saveUserVotes(filePath, {
      version: 2,
      votes: { 'doc-a': { recalled_count: 1, upvoted_count: 0, last_recalled_at: '2026-06-01T00:00:00Z' } },
      deltas: {},
    });
    expect(await hasPendingVoteDeltas(tmpDir, 'alice')).toBe(false);
  });
});

describe('incrementRecalled', () => {
  it('creates new entry and records delta', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    await incrementRecalled(filePath, ['doc-a', 'doc-b']);

    const data = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as UserVotesV2;
    expect(data.votes['doc-a'].recalled_count).toBe(1);
    expect(data.votes['doc-b'].recalled_count).toBe(1);
    expect(data.deltas['doc-a'].recalled_delta).toBe(1);
    expect(data.deltas['doc-b'].recalled_delta).toBe(1);
  });

  it('accumulates on repeated calls', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    await incrementRecalled(filePath, ['doc-a']);
    await incrementRecalled(filePath, ['doc-a']);
    await incrementRecalled(filePath, ['doc-a']);

    const data = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as UserVotesV2;
    expect(data.votes['doc-a'].recalled_count).toBe(3);
    expect(data.deltas['doc-a'].recalled_delta).toBe(3);
  });

  it('does nothing for empty docIds', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    await incrementRecalled(filePath, []);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('incrementUpvoted', () => {
  it('increments upvoted_count and records delta', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    await incrementRecalled(filePath, ['doc-a']);
    await incrementUpvoted(filePath, ['doc-a']);

    const data = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as UserVotesV2;
    expect(data.votes['doc-a'].recalled_count).toBe(1);
    expect(data.votes['doc-a'].upvoted_count).toBe(1);
    expect(data.votes['doc-a'].last_upvoted_at).toBeTruthy();
    expect(data.deltas['doc-a'].upvoted_delta).toBe(1);
  });

  it('does not lose increments under concurrent writers (lock)', async () => {
    // Simulates the foreground votesSyncHandler and the detached judge handler
    // incrementing the same votes file at the same time (issue #723).
    const filePath = path.join(tmpDir, 'user.yaml');
    await Promise.all(
      Array.from({ length: 10 }, () => incrementUpvoted(filePath, ['doc-a'])),
    );
    const data = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as UserVotesV2;
    expect(data.votes['doc-a'].upvoted_count).toBe(10);
    expect(data.deltas['doc-a'].upvoted_delta).toBe(10);
  });

  it('returns the credited docs, or [] when nothing new', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    expect(await incrementUpvoted(filePath, ['doc-a', 'doc-b'])).toEqual(['doc-a', 'doc-b']);
  });

  // ── per-session ledger dedup (atomic, in the votes file under the lock) ──

  it('with a sessionId, credits a doc at most once per session', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    // First Stop credits both.
    expect((await incrementUpvoted(filePath, ['doc-a', 'doc-b'], 's1'))!.sort()).toEqual(['doc-a', 'doc-b']);
    // Repeat Stop, same adoption → nothing new.
    expect(await incrementUpvoted(filePath, ['doc-a', 'doc-b'], 's1')).toEqual([]);
    const data = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as UserVotesV2;
    expect(data.votes['doc-a'].upvoted_count).toBe(1);
    expect(data.votes['doc-b'].upvoted_count).toBe(1);
  });

  it('credits only newly-adopted docs on a later turn of the same session', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    expect(await incrementUpvoted(filePath, ['doc-a'], 's2')).toEqual(['doc-a']);
    // Later turn adopts doc-b too; doc-a already credited.
    expect(await incrementUpvoted(filePath, ['doc-a', 'doc-b'], 's2')).toEqual(['doc-b']);
    const data = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as UserVotesV2;
    expect(data.votes['doc-a'].upvoted_count).toBe(1);
    expect(data.votes['doc-b'].upvoted_count).toBe(1);
  });

  it('shares one ledger across foreground + judge so a doc is not double-counted', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    // Judge credits doc-a first (same session id).
    expect(await incrementUpvoted(filePath, ['doc-a'], 's3')).toEqual(['doc-a']);
    // Foreground later sees the agent open doc-a → must NOT count it again.
    expect(await incrementUpvoted(filePath, ['doc-a'], 's3')).toEqual([]);
    const data = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as UserVotesV2;
    expect(data.votes['doc-a'].upvoted_count).toBe(1);
  });

  it('tracks sessions independently', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    expect(await incrementUpvoted(filePath, ['doc-a'], 'sA')).toEqual(['doc-a']);
    // Different session credits it again (its own ledger).
    expect(await incrementUpvoted(filePath, ['doc-a'], 'sB')).toEqual(['doc-a']);
    const data = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as UserVotesV2;
    expect(data.votes['doc-a'].upvoted_count).toBe(2);
  });

  it('tolerates a corrupted ledger entry (non-array docIds) without crashing', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    // Hand-corrupted file: docIds is a string, not an array.
    fs.writeFileSync(filePath, YAML.stringify({
      version: 2, votes: {}, deltas: {},
      upvotedSessions: { bad: { docIds: 'not-an-array', ts: new Date().toISOString() } },
    }));
    // Must not iterate the string per-character; a fresh session credits cleanly.
    const credited = await incrementUpvoted(filePath, ['doc-a'], 'good');
    expect(credited).toEqual(['doc-a']);
    const data = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as UserVotesV2;
    expect(data.votes['doc-a'].upvoted_count).toBe(1);
  });
});

describe('pruneUpvoteLedger (bounded even in judge-off config)', () => {
  it('drops stale session entries but keeps fresh ones', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days
    const fresh = new Date().toISOString();
    fs.writeFileSync(filePath, YAML.stringify({
      version: 2, votes: {}, deltas: {},
      upvotedSessions: { stale: { docIds: ['x'], ts: old }, live: { docIds: ['y'], ts: fresh } },
    }));

    await pruneUpvoteLedger(filePath);

    const data = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as unknown as { upvotedSessions: Record<string, unknown> };
    expect(Object.keys(data.upvotedSessions)).toEqual(['live']);
  });

  it('is a no-op (no throw) when there is no ledger', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    fs.writeFileSync(filePath, YAML.stringify({ version: 2, votes: {}, deltas: {} }));
    await expect(pruneUpvoteLedger(filePath)).resolves.toBeUndefined();
  });

  it('measures TTL from firstTs, not the refreshed ts (a long session cannot slide its window forever)', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    const oldStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const freshUpdate = new Date().toISOString();
    // A session that started 2 days ago but was refreshed just now: pruning on
    // the last-updated ts would keep it forever; pruning on firstTs drops it.
    fs.writeFileSync(filePath, YAML.stringify({
      version: 2, votes: {}, deltas: {},
      upvotedSessions: { longlived: { docIds: ['doc-a'], ts: freshUpdate, firstTs: oldStart } },
    }));

    await pruneUpvoteLedger(filePath);

    const data = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as unknown as { upvotedSessions?: Record<string, unknown> };
    expect(data.upvotedSessions ?? {}).toEqual({});
  });

  it('preserves firstTs across turns while refreshing ts (so dedup holds within the window)', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    // Turn 1 credits doc-a; turn 2 credits doc-b in the same session.
    expect(await incrementUpvoted(filePath, ['doc-a'], 'sLong')).toEqual(['doc-a']);
    const after1 = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as unknown as { upvotedSessions: Record<string, { ts: string; firstTs: string }> };
    const firstTs1 = after1.upvotedSessions.sLong.firstTs;
    expect(firstTs1).toBeTruthy();

    await new Promise((r) => setTimeout(r, 5));
    expect(await incrementUpvoted(filePath, ['doc-b'], 'sLong')).toEqual(['doc-b']);
    const after2 = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as unknown as { upvotedSessions: Record<string, { ts: string; firstTs: string }> };
    // firstTs unchanged; the same doc is still deduped.
    expect(after2.upvotedSessions.sLong.firstTs).toBe(firstTs1);
    expect(await incrementUpvoted(filePath, ['doc-a'], 'sLong')).toEqual([]);
  });
});

describe('creditedDocIdsForSession (#6: read-only, no v1 migration write)', () => {
  it('reads the session ledger from a v2 file', async () => {
    const filePath = path.join(tmpDir, 'user.yaml');
    await incrementUpvoted(filePath, ['doc-a', 'doc-b'], 'sX');
    const got = await creditedDocIdsForSession(filePath, 'sX');
    expect([...got].sort()).toEqual(['doc-a', 'doc-b']);
  });

  it('does NOT migrate/rewrite a v1 file (no unlocked write that could clobber a concurrent increment)', async () => {
    const filePath = path.join(tmpDir, 'legacy.yaml');
    // A v1 votes file (no version:2). loadUserVotes would migrate+save this;
    // creditedDocIdsForSession must not.
    const v1 = 'votes:\n  doc-a:\n    at: "2026-01-01T00:00:00Z"\n';
    fs.writeFileSync(filePath, v1);
    const before = fs.readFileSync(filePath, 'utf-8');
    const got = await creditedDocIdsForSession(filePath, 'sX');
    expect([...got]).toEqual([]); // v1 has no ledger
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before); // untouched
  });

  it('returns empty for a missing or corrupt file without throwing', async () => {
    expect([...await creditedDocIdsForSession(path.join(tmpDir, 'nope.yaml'), 's')]).toEqual([]);
    const bad = path.join(tmpDir, 'bad.yaml');
    fs.writeFileSync(bad, ': : not yaml : :');
    expect([...await creditedDocIdsForSession(bad, 's')]).toEqual([]);
  });
});

describe('mergeDeltas', () => {
  it('applies local deltas onto remote snapshot', () => {
    const local: UserVotesV2 = {
      version: 2,
      votes: { 'doc-a': { recalled_count: 5, upvoted_count: 2, last_recalled_at: '2026-06-10T00:00:00Z' } },
      deltas: { 'doc-a': { recalled_delta: 3, upvoted_delta: 1 } },
    };
    const remote: UserVotesV2 = {
      version: 2,
      votes: { 'doc-a': { recalled_count: 2, upvoted_count: 1, last_recalled_at: '2026-06-05T00:00:00Z' } },
      deltas: {},
    };

    const merged = mergeDeltas(local, remote);
    expect(merged.votes['doc-a'].recalled_count).toBe(5); // 2 + 3
    expect(merged.votes['doc-a'].upvoted_count).toBe(2); // 1 + 1
    expect(merged.votes['doc-a'].last_recalled_at).toBe('2026-06-10T00:00:00Z');
    expect(merged.deltas).toEqual({});
  });

  it('handles new docs in local that are not in remote', () => {
    const local: UserVotesV2 = {
      version: 2,
      votes: { 'new-doc': { recalled_count: 1, upvoted_count: 0, last_recalled_at: '2026-06-10T00:00:00Z' } },
      deltas: { 'new-doc': { recalled_delta: 1, upvoted_delta: 0 } },
    };
    const remote: UserVotesV2 = { version: 2, votes: {}, deltas: {} };

    const merged = mergeDeltas(local, remote);
    expect(merged.votes['new-doc'].recalled_count).toBe(1);
  });

  it('floors negative deltas to zero (prevents negative counts)', () => {
    const local: UserVotesV2 = {
      version: 2,
      votes: { 'doc-a': { recalled_count: 0, upvoted_count: 0, last_recalled_at: '2026-06-10T00:00:00Z' } },
      deltas: { 'doc-a': { recalled_delta: 0, upvoted_delta: -1 } },
    };
    const remote: UserVotesV2 = {
      version: 2,
      votes: { 'doc-a': { recalled_count: 1, upvoted_count: 0, last_recalled_at: '2026-06-05T00:00:00Z' } },
      deltas: {},
    };

    const merged = mergeDeltas(local, remote);
    expect(merged.votes['doc-a'].upvoted_count).toBe(0);
    expect(merged.votes['doc-a'].recalled_count).toBe(1);
  });

  it('does not keep last_upvoted_at when upvoted_count is 0', () => {
    const local: UserVotesV2 = {
      version: 2,
      votes: {
        'doc-bug': {
          recalled_count: 1,
          upvoted_count: 0,
          last_recalled_at: '2026-09-15T00:00:00Z',
          last_upvoted_at: '2026-09-15T00:00:00Z',
        },
      },
      deltas: { 'doc-bug': { recalled_delta: 1, upvoted_delta: 0 } },
    };
    const remote: UserVotesV2 = {
      version: 2,
      votes: {
        'doc-bug': { recalled_count: 0, upvoted_count: 0, last_recalled_at: '' },
      },
      deltas: {},
    };

    const merged = mergeDeltas(local, remote);
    expect(merged.votes['doc-bug'].upvoted_count).toBe(0);
    expect(merged.votes['doc-bug'].last_upvoted_at).toBeUndefined();
  });

  it('does not keep last_recalled_at when recalled_count is 0', () => {
    const local: UserVotesV2 = {
      version: 2,
      votes: {
        'doc-bug': {
          recalled_count: 0,
          upvoted_count: 0,
          last_recalled_at: '2026-09-15T00:00:00Z',
        },
      },
      deltas: { 'doc-bug': { recalled_delta: -1, upvoted_delta: 0 } },
    };
    const remote: UserVotesV2 = {
      version: 2,
      votes: {
        'doc-bug': { recalled_count: 1, upvoted_count: 0, last_recalled_at: '2026-09-05T00:00:00Z' },
      },
      deltas: {},
    };

    const merged = mergeDeltas(local, remote);
    expect(merged.votes['doc-bug'].recalled_count).toBe(0);
    expect(merged.votes['doc-bug'].last_recalled_at).toBe('');
  });

  it('preserves timestamps when counts stay positive (regression)', () => {
    const local: UserVotesV2 = {
      version: 2,
      votes: {
        'doc-a': {
          recalled_count: 5,
          upvoted_count: 2,
          last_recalled_at: '2026-06-10T00:00:00Z',
          last_upvoted_at: '2026-06-10T00:00:00Z',
        },
      },
      deltas: { 'doc-a': { recalled_delta: 3, upvoted_delta: 1 } },
    };
    const remote: UserVotesV2 = {
      version: 2,
      votes: {
        'doc-a': {
          recalled_count: 2,
          upvoted_count: 1,
          last_recalled_at: '2026-06-05T00:00:00Z',
          last_upvoted_at: '2026-06-04T00:00:00Z',
        },
      },
      deltas: {},
    };

    const merged = mergeDeltas(local, remote);
    expect(merged.votes['doc-a'].recalled_count).toBe(5);
    expect(merged.votes['doc-a'].upvoted_count).toBe(2);
    expect(merged.votes['doc-a'].last_recalled_at).toBe('2026-06-10T00:00:00Z');
    expect(merged.votes['doc-a'].last_upvoted_at).toBe('2026-06-10T00:00:00Z');
  });
});

describe('syncVotesToTeam', () => {
  it('merges local deltas into remote and clears local deltas', async () => {
    const localDir = path.join(tmpDir, 'local-votes');
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(localDir, { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'votes'), { recursive: true });

    // Local has 2 recalled + 1 upvoted with deltas
    const local: UserVotesV2 = {
      version: 2,
      votes: { 'doc-a': { recalled_count: 2, upvoted_count: 1, last_recalled_at: '2026-06-10T00:00:00Z', last_upvoted_at: '2026-06-10T00:00:00Z' } },
      deltas: { 'doc-a': { recalled_delta: 2, upvoted_delta: 1 } },
    };
    fs.writeFileSync(path.join(localDir, 'jeff.yaml'), YAML.stringify(local));

    const synced = await syncVotesToTeam(repoDir, 'jeff', localDir);
    expect(synced).toBe(true);

    // Remote should now have merged values
    const remoteContent = YAML.parse(fs.readFileSync(path.join(repoDir, 'votes', 'jeff.yaml'), 'utf-8'));
    expect(remoteContent.votes['doc-a'].recalled_count).toBe(2);

    // Local deltas should be cleared
    const localAfter = YAML.parse(fs.readFileSync(path.join(localDir, 'jeff.yaml'), 'utf-8'));
    expect(localAfter.deltas).toEqual({});
  });

  it('returns false when no deltas to sync', async () => {
    const localDir = path.join(tmpDir, 'local-votes');
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(localDir, { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'votes'), { recursive: true });

    const local: UserVotesV2 = {
      version: 2,
      votes: { 'doc-a': { recalled_count: 1, upvoted_count: 0, last_recalled_at: '2026-06-01T00:00:00Z' } },
      deltas: {},
    };
    fs.writeFileSync(path.join(localDir, 'jeff.yaml'), YAML.stringify(local));

    const synced = await syncVotesToTeam(repoDir, 'jeff', localDir);
    expect(synced).toBe(false);
  });

  // Issue #723 review: sync must clear ONLY the deltas it synced. A delta added
  // after the sync snapshot (e.g. the detached judge upvoting) must survive to
  // the next sync instead of being erased by a blind `deltas: {}`.
  it('preserves a delta added after the synced set, syncing it on the next pass', async () => {
    const localDir = path.join(tmpDir, 'local-votes');
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(localDir, { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'votes'), { recursive: true });

    const localPath = path.join(localDir, 'jeff.yaml');
    const remotePath = path.join(repoDir, 'votes', 'jeff.yaml');

    // First increment + sync credits doc-a to remote and clears its delta.
    await incrementUpvoted(localPath, ['doc-a']);
    expect(await syncVotesToTeam(repoDir, 'jeff', localDir)).toBe(true);
    expect(YAML.parse(fs.readFileSync(localPath, 'utf-8')).deltas).toEqual({});
    expect(YAML.parse(fs.readFileSync(remotePath, 'utf-8')).votes['doc-a'].upvoted_count).toBe(1);

    // A later increment (doc-b) arrives; syncing again must add doc-b to remote
    // WITHOUT losing doc-a's already-synced count.
    await incrementUpvoted(localPath, ['doc-b']);
    expect(await syncVotesToTeam(repoDir, 'jeff', localDir)).toBe(true);
    const remote = YAML.parse(fs.readFileSync(remotePath, 'utf-8'));
    expect(remote.votes['doc-a'].upvoted_count).toBe(1);
    expect(remote.votes['doc-b'].upvoted_count).toBe(1);
    expect(YAML.parse(fs.readFileSync(localPath, 'utf-8')).deltas).toEqual({});
  });
});

describe('recallFeedback', () => {
  beforeEach(() => {
    vi.doMock('../config.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../config.js')>()),
      resolveConfigForDir: () => Promise.resolve({ username: 'testuser', scope: 'user', repo: { localPath: tmpDir } }),
    }));
  });

  afterEach(() => {
    vi.doUnmock('../config.js');
  });

  it('positive increments upvoted_count', async () => {
    const votesDir = path.join(tmpDir, '.teamai', 'user-votes');
    fs.mkdirSync(votesDir, { recursive: true });
    await incrementRecalled(path.join(votesDir, 'testuser.yaml'), ['doc-a']);

    await recallFeedback({ positive: 'doc-a' });

    const content = fs.readFileSync(path.join(votesDir, 'testuser.yaml'), 'utf-8');
    const parsed = YAML.parse(content) as UserVotesV2;
    expect(parsed.votes['doc-a'].upvoted_count).toBe(1);
  });

  it('negative decrements upvoted_count (floor at 0)', async () => {
    const votesDir = path.join(tmpDir, '.teamai', 'user-votes');
    fs.mkdirSync(votesDir, { recursive: true });
    await incrementRecalled(path.join(votesDir, 'testuser.yaml'), ['doc-b']);

    await recallFeedback({ negative: 'doc-b' });

    const content = fs.readFileSync(path.join(votesDir, 'testuser.yaml'), 'utf-8');
    const parsed = YAML.parse(content) as UserVotesV2;
    expect(parsed.votes['doc-b'].upvoted_count).toBe(0);
  });

  it('negative on missing doc warns without crashing', async () => {
    const votesDir = path.join(tmpDir, '.teamai', 'user-votes');
    fs.mkdirSync(votesDir, { recursive: true });

    // Should not throw
    await expect(recallFeedback({ negative: 'nonexistent' })).resolves.not.toThrow();
  });

  it('negative deletes last_upvoted_at when upvoted_count reaches 0', async () => {
    const votesDir = path.join(tmpDir, '.teamai', 'user-votes');
    fs.mkdirSync(votesDir, { recursive: true });
    const votePath = path.join(votesDir, 'testuser.yaml');

    // Set up: recalled_count=1, upvoted_count=1 with last_upvoted_at populated
    await incrementRecalled(votePath, ['doc-zero']);
    await incrementUpvoted(votePath, ['doc-zero']);

    const before = await loadUserVotes(votePath);
    expect(before.votes['doc-zero'].upvoted_count).toBe(1);
    expect(before.votes['doc-zero'].last_upvoted_at).toBeTruthy();

    await recallFeedback({ negative: 'doc-zero' });

    const after = YAML.parse(fs.readFileSync(votePath, 'utf-8')) as UserVotesV2;
    expect(after.votes['doc-zero'].upvoted_count).toBe(0);
    expect(after.votes['doc-zero'].last_upvoted_at).toBeUndefined();
  });
});
