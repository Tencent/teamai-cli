// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import matter from 'gray-matter';

import { findPromotionCandidates, executePromotion } from '../maintenance/promote.js';
import { CallError, callTool } from '../tool-launch/call.js';
import type { UserVotesV2 } from '../types.js';

vi.mock('../tool-launch/call.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../tool-launch/call.js')>(),
  callTool: vi.fn(async (prompt: string) => ({
    tool: 'claude',
    text: prompt.includes('Classify') ? 'skills' : '---\ntitle: promoted content\ntags: [test]\ndate: 2026-07-03\n---\nPromoted by AI.',
  })),
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
    const filePath = path.join(votesDir, `${user}.yaml`);
    let data: UserVotesV2 = { version: 2, votes: {}, deltas: {} };
    if (fs.existsSync(filePath)) {
      try { data = YAML.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
    }
    data.votes[docId] = { recalled_count: 5, upvoted_count: 4, last_recalled_at: recentDate, last_upvoted_at: recentDate };
    fs.writeFileSync(filePath, YAML.stringify(data));
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

    const candidates = await findPromotionCandidates([learningsDir], votesDir, undefined);
    expect(candidates).toHaveLength(0);
  });

  it('identifies high-confidence learnings from multiple users', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });

    makeLearning(learningsDir, 'great-doc');
    makeHighVotes(votesDir, 'great-doc');

    const candidates = await findPromotionCandidates([learningsDir], votesDir, undefined);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].docId).toBe('great-doc');
    expect(candidates[0].suggestedCategory).toBe('skills');
    expect(callTool).toHaveBeenCalledWith(expect.stringContaining('Classify'), expect.objectContaining({ launchedBy: 'recall-promote' }));
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

    const candidates = await findPromotionCandidates([learningsDir], votesDir, undefined);
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

    const candidates = await findPromotionCandidates([learningsDir], votesDir, undefined);
    expect(candidates.find((c) => c.docId === 'too-new')).toBeUndefined();
  });
  it('finds namespaced learnings when active namespaces are provided', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(path.join(learningsDir, 'k8s'), { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });

    makeLearning(learningsDir, 'root-doc');
    makeHighVotes(votesDir, 'root-doc');

    const nsLearningPath = path.join(learningsDir, 'k8s', 'helm-values.md');
    const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    fs.writeFileSync(nsLearningPath, matter.stringify('Helm details', { title: 'helm-values', date }));
    makeHighVotes(votesDir, path.join('k8s', 'helm-values'));

    // Without namespaces: only root-doc
    const rootOnly = await findPromotionCandidates([learningsDir], votesDir);
    expect(rootOnly.map((c) => c.docId)).toEqual(['root-doc']);

    // With namespaces: both root-doc and namespaced learning
    const withNs = await findPromotionCandidates([learningsDir], votesDir, { namespaces: ['k8s'] });
    expect(withNs.map((c) => c.docId).sort()).toEqual([path.join('k8s', 'helm-values'), 'root-doc'].sort());
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

    const { targetPath, marked } = await executePromotion(candidate, tmpDir, { dryRun: true });
    expect(targetPath).toContain(path.join('skills', 'candidate', 'SKILL.md'));
    expect(marked).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'skills', 'candidate', 'SKILL.md'))).toBe(false);
    // Not even the category directory: a preview creates nothing (#900).
    expect(fs.existsSync(path.join(tmpDir, 'skills'))).toBe(false);
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

    const { marked } = await executePromotion(candidate, tmpDir, { category: 'skills' });
    expect(marked).toBe(path.join(learningsDir, 'ready.md'));

    expect(fs.existsSync(path.join(skillsDir, 'ready', 'SKILL.md'))).toBe(true);

    // Original should have promoted_to in frontmatter
    const original = fs.readFileSync(path.join(learningsDir, 'ready.md'), 'utf-8');
    const { data } = matter(original);
    expect(data.promoted_to).toBe('skills/ready/SKILL.md');
    expect(fs.readFileSync(path.join(skillsDir, 'ready', 'SKILL.md'), 'utf-8')).toContain('Promoted by AI.');
    expect(callTool).toHaveBeenCalledWith(expect.stringContaining('promoting a team learning'), expect.objectContaining({ launchedBy: 'recall-promote' }));
  });
  it('promotes a namespaced learning keeping the namespace in target path', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(path.join(learningsDir, 'k8s'), { recursive: true });

    const nsFile = path.join('k8s', 'helm-values.md');
    const absPath = path.join(learningsDir, nsFile);
    fs.writeFileSync(absPath, matter.stringify('Step by step procedure', { title: 'helm-values', date: '2026-01-01' }));

    const candidate = {
      docId: path.join('k8s', 'helm-values'),
      filename: nsFile,
      path: absPath,
      confidence: 0.95,
      upvotedCount: 10,
      userCount: 3,
      title: 'helm-values',
      suggestedCategory: 'skills' as const,
    };

    const { targetPath, marked } = await executePromotion(candidate, tmpDir, { category: 'skills' });
    expect(marked).toBe(absPath);
    expect(targetPath).toBe(path.join(tmpDir, 'skills', 'k8s', 'helm-values', 'SKILL.md'));
    expect(fs.existsSync(path.join(skillsDir, 'k8s', 'helm-values', 'SKILL.md'))).toBe(true);

    const original = fs.readFileSync(absPath, 'utf-8');
    const { data } = matter(original);
    expect(data.promoted_to).toBe('skills/k8s/helm-values/SKILL.md');
  });

  it('normalizes path separators in candidate filename when promoting', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(path.join(learningsDir, 'k8s'), { recursive: true });

    const absPath = path.join(learningsDir, 'k8s', 'helm-values.md');
    fs.writeFileSync(absPath, matter.stringify('Step by step procedure', { title: 'helm-values', date: '2026-01-01' }));

    const candidate = {
      docId: 'k8s/helm-values',
      filename: path.join('k8s', 'helm-values.md'),
      path: absPath,
      confidence: 0.95,
      upvotedCount: 10,
      userCount: 3,
      title: 'helm-values',
      suggestedCategory: 'skills' as const,
    };

    const { targetPath } = await executePromotion(candidate, tmpDir, { category: 'skills' });
    expect(targetPath).toBe(path.join(tmpDir, 'skills', 'k8s', 'helm-values', 'SKILL.md'));
    expect(fs.existsSync(path.join(skillsDir, 'k8s', 'helm-values', 'SKILL.md'))).toBe(true);

    const original = fs.readFileSync(absPath, 'utf-8');
    const { data } = matter(original);
    expect(data.promoted_to).toBe('skills/k8s/helm-values/SKILL.md');
  });

  it('fails, writing nothing, when the member names an AI tool teamai cannot run', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    makeLearning(learningsDir, 'ready');
    vi.mocked(callTool).mockRejectedValueOnce(new CallError('override_invalid', 'TEAMAI_AI_TOOL is "gemini", which is not a tool teamai launches.'));
    const candidate = { docId: 'ready', filename: 'ready.md', path: path.join(learningsDir, 'ready.md'), confidence: 0.95, upvotedCount: 10, userCount: 3, title: 'ready', suggestedCategory: 'skills' as const };

    await expect(executePromotion(candidate, tmpDir, { category: 'skills' })).rejects.toThrow('TEAMAI_AI_TOOL is "gemini"');
    expect(fs.existsSync(path.join(tmpDir, 'skills'))).toBe(false);
  });
});
