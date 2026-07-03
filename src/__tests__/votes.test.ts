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
});

describe('recallFeedback', () => {
  beforeEach(() => {
    vi.doMock('../config.js', () => ({
      requireInit: () => Promise.resolve({
        localConfig: { username: 'testuser', repo: { localPath: tmpDir } },
      }),
    }));
  });

  afterEach(() => {
    vi.doUnmock('../config.js');
  });

  it('positive increments upvoted_count', async () => {
    const votesDir = path.join(tmpDir, '.teamai', 'votes');
    fs.mkdirSync(votesDir, { recursive: true });
    await incrementRecalled(path.join(votesDir, 'testuser.yaml'), ['doc-a']);

    await recallFeedback({ positive: 'doc-a' });

    const content = fs.readFileSync(path.join(votesDir, 'testuser.yaml'), 'utf-8');
    const parsed = YAML.parse(content) as UserVotesV2;
    expect(parsed.votes['doc-a'].upvoted_count).toBe(1);
  });

  it('negative decrements upvoted_count (floor at 0)', async () => {
    const votesDir = path.join(tmpDir, '.teamai', 'votes');
    fs.mkdirSync(votesDir, { recursive: true });
    await incrementRecalled(path.join(votesDir, 'testuser.yaml'), ['doc-b']);

    await recallFeedback({ negative: 'doc-b' });

    const content = fs.readFileSync(path.join(votesDir, 'testuser.yaml'), 'utf-8');
    const parsed = YAML.parse(content) as UserVotesV2;
    expect(parsed.votes['doc-b'].upvoted_count).toBe(0);
  });

  it('negative on missing doc warns without crashing', async () => {
    const votesDir = path.join(tmpDir, '.teamai', 'votes');
    fs.mkdirSync(votesDir, { recursive: true });

    // Should not throw
    await expect(recallFeedback({ negative: 'nonexistent' })).resolves.not.toThrow();
  });
});
