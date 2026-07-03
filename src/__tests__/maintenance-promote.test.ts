// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import matter from 'gray-matter';

import { findPromotionCandidates, executePromotion } from '../maintenance/promote.js';
import type { UserVotesV2 } from '../types.js';

// Mock AI client to avoid real CLI calls in tests
vi.mock('../utils/ai-client.js', () => ({
  callClaude: vi.fn(async (prompt: string) => {
    if (prompt.includes('Classify')) return 'skills';
    return '---\ntitle: promoted content\ntags: [test]\ndate: 2026-07-03\n---\nPromoted by AI.';
  }),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-promote-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeLearning(dir: string, id: string, opts: { date?: string; title?: string } = {}): void {
  const date = opts.date ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const title = opts.title ?? id;
  const content = matter.stringify('How to do something step-by-step.', { title, date, tags: ['workflow'] });
  fs.writeFileSync(path.join(dir, `${id}.md`), content);
}

function makeHighVotes(votesDir: string, docId: string): void {
  const recentDate = new Date().toISOString();
  // Create votes from 3 users with high upvote ratio (meets MIN_USERS=2, MIN_UPVOTED=5)
  // Need confidence >= 0.90: high base + high recency + high ratio
  for (const user of ['alice', 'bob', 'carol']) {
    const data: UserVotesV2 = {
      version: 2,
      votes: {
        [docId]: { recalled_count: 5, upvoted_count: 4, last_recalled_at: recentDate, last_upvoted_at: recentDate },
      },
      deltas: {},
    };
    fs.writeFileSync(path.join(votesDir, `${user}.yaml`), YAML.stringify(data));
  }
}

describe('findPromotionCandidates', () => {
  it('returns empty when no learnings meet thresholds', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });

    makeLearning(learningsDir, 'low-conf');
    // Only 1 user with low votes
    const data: UserVotesV2 = {
      version: 2,
      votes: { 'low-conf': { recalled_count: 1, upvoted_count: 0, last_recalled_at: new Date().toISOString() } },
      deltas: {},
    };
    fs.writeFileSync(path.join(votesDir, 'jeff.yaml'), YAML.stringify(data));

    const candidates = await findPromotionCandidates(learningsDir, votesDir);
    expect(candidates).toHaveLength(0);
  });

  it('identifies high-confidence learnings from multiple users', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });

    makeLearning(learningsDir, 'great-doc');
    makeHighVotes(votesDir, 'great-doc');

    const candidates = await findPromotionCandidates(learningsDir, votesDir);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].docId).toBe('great-doc');
    expect(candidates[0].suggestedCategory).toBeDefined();
  });

  it('skips already-promoted learnings', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });

    // Create learning with promoted_to marker
    const content = matter.stringify('Content', { title: 'promoted', date: '2026-01-01', promoted_to: 'skills/promoted.md' });
    fs.writeFileSync(path.join(learningsDir, 'promoted.md'), content);
    makeHighVotes(votesDir, 'promoted');

    const candidates = await findPromotionCandidates(learningsDir, votesDir);
    expect(candidates.find((c) => c.docId === 'promoted')).toBeUndefined();
  });

  it('skips learnings younger than 14 days', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });

    // Recent doc (3 days old)
    const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    makeLearning(learningsDir, 'too-new', { date: recentDate });
    makeHighVotes(votesDir, 'too-new');

    const candidates = await findPromotionCandidates(learningsDir, votesDir);
    expect(candidates.find((c) => c.docId === 'too-new')).toBeUndefined();
  });
});

describe('executePromotion', () => {
  it('dry-run does not create files', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    makeLearning(learningsDir, 'candidate');

    const candidate = {
      docId: 'candidate',
      filename: 'candidate.md',
      path: path.join(learningsDir, 'candidate.md'),
      confidence: 0.95,
      upvotedCount: 10,
      userCount: 3,
      title: 'candidate',
      suggestedCategory: 'skills' as const,
    };

    const targetPath = await executePromotion(candidate, tmpDir, { dryRun: true });
    expect(targetPath).toContain('skills/candidate.md');
    expect(fs.existsSync(path.join(tmpDir, 'skills', 'candidate.md'))).toBe(false);
  });

  it('copies file and marks original with promoted_to', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(learningsDir, { recursive: true });
    makeLearning(learningsDir, 'ready');

    const candidate = {
      docId: 'ready',
      filename: 'ready.md',
      path: path.join(learningsDir, 'ready.md'),
      confidence: 0.95,
      upvotedCount: 10,
      userCount: 3,
      title: 'ready',
      suggestedCategory: 'skills' as const,
    };

    await executePromotion(candidate, tmpDir, { category: 'skills' });

    expect(fs.existsSync(path.join(skillsDir, 'ready.md'))).toBe(true);

    // Original should have promoted_to in frontmatter
    const original = fs.readFileSync(path.join(learningsDir, 'ready.md'), 'utf-8');
    const { data } = matter(original);
    expect(data.promoted_to).toBe('skills/ready.md');
  });
});
