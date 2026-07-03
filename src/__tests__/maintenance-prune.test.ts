// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import matter from 'gray-matter';

import { findPruneCandidates, executePrune } from '../maintenance/prune.js';
import type { UserVotesV2 } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-prune-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeLearning(dir: string, id: string, date: string): void {
  const content = matter.stringify('Learning content here.', { title: id, date, tags: ['test'] });
  fs.writeFileSync(path.join(dir, `${id}.md`), content);
}

function makeVotes(dir: string, username: string, votes: Record<string, { recalled_count: number; upvoted_count: number; last_recalled_at: string }>): void {
  const data: UserVotesV2 = { version: 2, votes: {}, deltas: {} };
  for (const [docId, entry] of Object.entries(votes)) {
    data.votes[docId] = { ...entry };
  }
  fs.writeFileSync(path.join(dir, `${username}.yaml`), YAML.stringify(data));
}

describe('findPruneCandidates', () => {
  it('returns empty for docs with no vote data', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });

    makeLearning(learningsDir, 'new-doc', '2026-06-01');

    const candidates = await findPruneCandidates(learningsDir, votesDir);
    expect(candidates).toHaveLength(0);
  });

  it('identifies low-confidence docs', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });

    // Create an old doc with minimal activity -> low confidence
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    makeLearning(learningsDir, 'stale-doc', oldDate);
    makeVotes(votesDir, 'user1', {
      'stale-doc': { recalled_count: 1, upvoted_count: 0, last_recalled_at: oldDate },
    });

    const candidates = await findPruneCandidates(learningsDir, votesDir);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].filename).toBe('stale-doc.md');
  });

  it('respects custom threshold', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });

    makeLearning(learningsDir, 'borderline', '2026-06-01');
    makeVotes(votesDir, 'user1', {
      'borderline': { recalled_count: 3, upvoted_count: 1, last_recalled_at: new Date().toISOString() },
    });

    // With very high threshold, should find it
    const highThreshold = await findPruneCandidates(learningsDir, votesDir, { threshold: 0.99 });
    expect(highThreshold.length).toBeGreaterThan(0);

    // With very low threshold, should not find it
    const lowThreshold = await findPruneCandidates(learningsDir, votesDir, { threshold: 0.01 });
    expect(lowThreshold).toHaveLength(0);
  });

  it('handles missing date gracefully', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });

    // Doc without date
    fs.writeFileSync(path.join(learningsDir, 'nodate.md'), '---\ntitle: no date\n---\nContent');
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    makeVotes(votesDir, 'user1', {
      'nodate': { recalled_count: 1, upvoted_count: 0, last_recalled_at: oldDate },
    });

    const candidates = await findPruneCandidates(learningsDir, votesDir);
    // Should work without crashing; doc may end up in confidence-too-low OR stale branch
    const nodateCandidate = candidates.find((c) => c.filename === 'nodate.md');
    expect(nodateCandidate).toBeDefined();
    // If it hits the stale branch, reason should contain 'no-date'; otherwise 'confidence'
    expect(nodateCandidate!.reason).toMatch(/confidence|no-date/);
  });
});

describe('executePrune', () => {
  it('dry-run does not delete files', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    makeLearning(learningsDir, 'target', '2026-01-01');

    const candidates = [{ filename: 'target.md', path: path.join(learningsDir, 'target.md'), confidence: 0.05, lastActivity: '', reason: 'test' }];
    const result = await executePrune(tmpDir, candidates, { dryRun: true });

    expect(result.archived).toBe(0);
    expect(result.removed).toBe(0);
    expect(fs.existsSync(path.join(learningsDir, 'target.md'))).toBe(true);
  });

  it('archive mode moves files to _archive/', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    makeLearning(learningsDir, 'target', '2026-01-01');

    const candidates = [{ filename: 'target.md', path: path.join(learningsDir, 'target.md'), confidence: 0.05, lastActivity: '', reason: 'test' }];
    const result = await executePrune(tmpDir, candidates, { archive: true });

    expect(result.archived).toBe(1);
    expect(fs.existsSync(path.join(learningsDir, 'target.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'learnings', '_archive', 'target.md'))).toBe(true);
  });
});
