// -*- coding: utf-8 -*-
/**
 * End-to-end data flow verification for the Phase 3 + Phase 4 pipeline.
 *
 * Simulates: recall → incrementRecalled → Stop hook transcript parse →
 * incrementUpvoted → syncVotesToTeam → buildIndex (confidence + hotness) →
 * search (cold penalty applied)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import matter from 'gray-matter';

import { incrementRecalled, incrementUpvoted, syncVotesToTeam, loadUserVotes } from '../votes.js';
import { parseTranscriptForVotes } from '../transcript-parser.js';
import { buildIndex, loadIndex, search } from '../utils/search-index.js';
import { computeAllConfidence, writeBackConfidence } from '../maintenance/confidence.js';
import { annotateHotness, HOT_THRESHOLD } from '../maintenance/hot-cold.js';
import { findPruneCandidates } from '../maintenance/prune.js';
import type { UserVotesV2 } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-e2e-votes-'));
  process.env.HOME = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Phase 3+4 end-to-end data flow', () => {

  it('full pipeline: recall → vote → sync → confidence → hotness → search ranking', async () => {
    // ─── Setup: create learnings and team repo structure ───
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    const repoVotesDir = path.join(tmpDir, 'repo', 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });
    fs.mkdirSync(repoVotesDir, { recursive: true });

    // Create two learnings: one active (will be recalled + upvoted), one stale
    const activeLearning = matter.stringify(
      'Use retry backoff with exponential delay for transient API errors.',
      { title: 'API retry pattern', tags: ['api', 'timeout'], date: '2026-06-01' },
    );
    const staleLearning = matter.stringify(
      'Some outdated advice that nobody finds useful anymore.',
      { title: 'Outdated pattern', tags: ['api'], date: '2025-01-01' },
    );
    fs.writeFileSync(path.join(learningsDir, 'api-retry.md'), activeLearning);
    fs.writeFileSync(path.join(learningsDir, 'outdated-pattern.md'), staleLearning);

    // ─── Step 1: Simulate recall (autoUpvote → incrementRecalled) ───
    const localVotePath = path.join(votesDir, 'jeff.yaml');
    await incrementRecalled(localVotePath, ['api-retry', 'outdated-pattern']);
    await incrementRecalled(localVotePath, ['api-retry']); // recalled again
    await incrementRecalled(localVotePath, ['api-retry']); // and again

    // Verify: api-retry recalled 3x, outdated-pattern 1x
    const afterRecall = await loadUserVotes(localVotePath);
    expect(afterRecall.votes['api-retry'].recalled_count).toBe(3);
    expect(afterRecall.votes['outdated-pattern'].recalled_count).toBe(1);
    expect(afterRecall.deltas['api-retry'].recalled_delta).toBe(3);

    // ─── Step 2: Simulate Stop hook (transcript parse → incrementUpvoted) ───
    // Create a fake transcript with referenced-doc-ids
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const transcriptEntry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: 'Here is the solution.\n\n<!-- teamai:referenced-doc-ids: [api-retry] -->',
        }],
      },
    };
    fs.writeFileSync(transcriptPath, JSON.stringify(transcriptEntry) + '\n');

    const voteData = await parseTranscriptForVotes(transcriptPath);
    expect(voteData.referencedDocIds).toContain('api-retry');
    expect(voteData.referencedDocIds).not.toContain('outdated-pattern');

    await incrementUpvoted(localVotePath, voteData.referencedDocIds);

    // Verify: api-retry now has upvoted_count=1
    const afterUpvote = await loadUserVotes(localVotePath);
    expect(afterUpvote.votes['api-retry'].upvoted_count).toBe(1);
    expect(afterUpvote.votes['outdated-pattern'].upvoted_count).toBe(0);

    // ─── Step 3: Sync to team repo ───
    const synced = await syncVotesToTeam(path.join(tmpDir, 'repo'), 'jeff', votesDir);
    expect(synced).toBe(true);

    // Verify: repo has merged data, local deltas cleared
    const repoVotes = await loadUserVotes(path.join(repoVotesDir, 'jeff.yaml'));
    expect(repoVotes.votes['api-retry'].recalled_count).toBe(3);
    expect(repoVotes.votes['api-retry'].upvoted_count).toBe(1);

    const localAfterSync = await loadUserVotes(localVotePath);
    expect(Object.keys(localAfterSync.deltas)).toHaveLength(0);

    // ─── Step 4: Compute confidence ───
    const confidenceMap = await computeAllConfidence(repoVotesDir);
    const apiRetryConf = confidenceMap.get('api-retry')!;
    const outdatedConf = confidenceMap.get('outdated-pattern')!;

    // api-retry: recalled=3, upvoted=1, recent → higher confidence
    // outdated-pattern: recalled=1, upvoted=0, old → lower confidence
    expect(apiRetryConf).toBeGreaterThan(outdatedConf);
    expect(apiRetryConf).toBeGreaterThan(0.3);

    // ─── Step 5: Build index with hotness annotation ───
    const indexPath = path.join(tmpDir, 'search-index.json');
    await buildIndex({ learningsDir, votesDir: repoVotesDir, indexPath });

    const index = await loadIndex(indexPath);
    expect(index).not.toBeNull();
    expect(index!.entries.length).toBe(2);

    const apiEntry = index!.entries.find(e => e.filename === 'api-retry.md')!;
    const outdatedEntry = index!.entries.find(e => e.filename === 'outdated-pattern.md')!;

    // Confidence is annotated
    expect(apiEntry.confidence).toBeDefined();
    expect(outdatedEntry.confidence).toBeDefined();

    // Hotness is annotated
    expect(apiEntry.hotness).toBeDefined();
    expect(outdatedEntry.hotness).toBeDefined();

    // ─── Step 6: Search verifies cold penalty ───
    const results = search('api', index!);
    expect(results.length).toBe(2);

    // api-retry should rank higher (more votes + higher hotness)
    expect(results[0].entry.filename).toBe('api-retry.md');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('confidence writeback updates frontmatter', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });

    const content = matter.stringify('Content here.', { title: 'test-doc', date: '2026-06-01', tags: ['test'] });
    fs.writeFileSync(path.join(learningsDir, 'test-doc.md'), content);

    // Add votes
    const v2: UserVotesV2 = {
      version: 2,
      votes: { 'test-doc': { recalled_count: 5, upvoted_count: 3, last_recalled_at: new Date().toISOString(), last_upvoted_at: new Date().toISOString() } },
      deltas: {},
    };
    fs.writeFileSync(path.join(votesDir, 'user1.yaml'), YAML.stringify(v2));

    const map = await computeAllConfidence(votesDir);
    const updated = await writeBackConfidence(learningsDir, map);
    expect(updated).toBe(1);

    // Verify frontmatter has confidence
    const afterContent = fs.readFileSync(path.join(learningsDir, 'test-doc.md'), 'utf-8');
    const { data } = matter(afterContent);
    expect(data.confidence).toBeDefined();
    expect(data.confidence).toBeGreaterThan(0);
  });

  it('prune skips docs with no vote data (new docs protected)', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });

    // New doc with no vote data
    const content = matter.stringify('Brand new learning.', { title: 'new-doc', date: '2026-07-01', tags: ['test'] });
    fs.writeFileSync(path.join(learningsDir, 'new-doc.md'), content);

    const candidates = await findPruneCandidates(learningsDir, votesDir);
    expect(candidates).toHaveLength(0);
  });
});
