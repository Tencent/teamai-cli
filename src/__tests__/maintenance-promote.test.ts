// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import matter from 'gray-matter';

import { chooseCategory, findPromotionCandidates, markPromoted, writePromotion } from '../maintenance/promote.js';
import type { UserVotesV2 } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-promote-test-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeLearning(dir: string, id: string, opts: { date?: string; title?: string; body?: string } = {}): void {
  const date = opts.date ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const title = opts.title ?? id;
  const content = matter.stringify(opts.body ?? 'How to do something step-by-step.', { title, date, tags: ['workflow'] });
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
  it.each([
    ['unquoted recent date', '2026-11-06', false],
    ['quoted recent date', '"2026-11-06"', false],
    ['unquoted timestamp under 14 days', '2026-10-24T12:00:00.001Z', false],
    ['quoted timestamp under 14 days', '"2026-10-24T12:00:00.001Z"', false],
    ['unquoted timestamp exactly 14 days old', '2026-10-24T12:00:00.000Z', true],
    ['quoted timestamp exactly 14 days old', '"2026-10-24T12:00:00.000Z"', true],
    ['unquoted older date', '2026-10-01', true],
  ])('enforces the minimum age with %s', async (_name, date, eligible) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T12:00:00.000Z'));
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });
    fs.writeFileSync(path.join(learningsDir, 'dated.md'), `---\ntitle: dated\ndate: ${date}\n---\nLearning content.\n`);
    makeHighVotes(votesDir, 'dated');

    const candidates = await findPromotionCandidates([learningsDir], votesDir);

    expect(candidates.map((candidate) => candidate.docId)).toEqual(eligible ? ['dated'] : []);
  });

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
  });

  it('never promotes a learning whose votes carry a count that is not a number', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });
    makeLearning(learningsDir, 'half-adopted');
    const recent = new Date().toISOString();

    // Six upvotes of fifteen recalls from three people: enough upvotes and people, far from enough confidence.
    for (const user of ['alice', 'bob', 'carol']) {
      fs.writeFileSync(path.join(votesDir, `${user}.yaml`), `version: 2\ndeltas: {}\nvotes:\n  half-adopted:\n    recalled_count: 5\n    upvoted_count: 2\n    judge_upvoted_count: .nan\n    judged_count: .nan\n    last_recalled_at: ${recent}\n    last_upvoted_at: ${recent}\n`);
    }

    expect(await findPromotionCandidates([learningsDir], votesDir, undefined)).toEqual([]);
  });

  it('suggests the category the learning\'s keywords point to', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });
    makeLearning(learningsDir, 'pin-versions', { body: 'Always pin dependency versions; never float them. A team convention.' });
    makeHighVotes(votesDir, 'pin-versions');

    const candidates = await findPromotionCandidates([learningsDir], votesDir, undefined);

    expect(candidates.map((c) => [c.docId, c.suggestedCategory])).toEqual([['pin-versions', 'rules']]);
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

const ready = (learningsDir: string) => ({ docId: 'ready', filename: 'ready.md', path: path.join(learningsDir, 'ready.md') });

describe('writePromotion', () => {
  it('writes nothing in a dry run, not even the category directory (#900)', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    makeLearning(learningsDir, 'ready');

    const { relativePath } = await writePromotion(ready(learningsDir), tmpDir, { category: 'skills', dryRun: true });

    expect(relativePath).toBe('skills/ready/SKILL.md');
    expect(fs.existsSync(path.join(tmpDir, 'skills'))).toBe(false);
  });

  it('writes the rewritten content, as a skill named after the learning', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    makeLearning(learningsDir, 'ready');

    const { targetPath } = await writePromotion(ready(learningsDir), tmpDir, { category: 'skills', content: '---\ntitle: Ready\n---\nRewritten for the team.\n' });

    expect(targetPath).toBe(path.join(tmpDir, 'skills', 'ready', 'SKILL.md'));
    const written = matter(fs.readFileSync(targetPath, 'utf-8'));
    expect(written.data.name).toBe('ready');
    expect(written.content).toContain('Rewritten for the team.');
  });

  it('writes the learning as written when there is no rewritten content', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    makeLearning(learningsDir, 'ready');

    const { targetPath } = await writePromotion(ready(learningsDir), tmpDir, { category: 'docs' });

    expect(targetPath).toBe(path.join(tmpDir, 'docs', 'ready.md'));
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe(fs.readFileSync(path.join(learningsDir, 'ready.md'), 'utf-8'));
  });

  it('keeps the namespace of a namespaced learning, whatever its path separator', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(path.join(learningsDir, 'k8s'), { recursive: true });
    const absPath = path.join(learningsDir, 'k8s', 'helm-values.md');
    fs.writeFileSync(absPath, matter.stringify('Step by step procedure', { title: 'helm-values', date: '2026-01-01' }));

    const { targetPath } = await writePromotion({ docId: 'k8s/helm-values', filename: path.join('k8s', 'helm-values.md'), path: absPath }, tmpDir, { category: 'skills' });

    expect(targetPath).toBe(path.join(tmpDir, 'skills', 'k8s', 'helm-values', 'SKILL.md'));
    expect(fs.existsSync(targetPath)).toBe(true);
  });

  it('overwrites nothing', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    makeLearning(learningsDir, 'ready');
    fs.mkdirSync(path.join(tmpDir, 'docs'));
    fs.writeFileSync(path.join(tmpDir, 'docs', 'ready.md'), 'the team\'s own\n');

    await expect(writePromotion(ready(learningsDir), tmpDir, { category: 'docs' })).rejects.toThrow('Promotion target already exists: docs/ready.md. Nothing was overwritten.');
    expect(fs.readFileSync(path.join(tmpDir, 'docs', 'ready.md'), 'utf-8')).toBe('the team\'s own\n');
  });
});

describe('markPromoted', () => {
  it('marks the learning with promoted_to, where it lives when that is the write root', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    makeLearning(learningsDir, 'ready');

    const marked = await markPromoted(ready(learningsDir), 'skills/ready/SKILL.md', learningsDir);

    expect(marked).toBe(path.join(learningsDir, 'ready.md'));
    expect(matter(fs.readFileSync(marked, 'utf-8')).data.promoted_to).toBe('skills/ready/SKILL.md');
  });

  it('marks a learning of a root nothing pushes in the write root, so the mark is kept', async () => {
    const readOnlyDir = path.join(tmpDir, 'delivered');
    const writeDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(readOnlyDir, { recursive: true });
    makeLearning(readOnlyDir, 'ready');

    const marked = await markPromoted(ready(readOnlyDir), 'docs/ready.md', writeDir);

    expect(marked).toBe(path.join(writeDir, 'ready.md'));
    expect(matter(fs.readFileSync(marked, 'utf-8')).data.promoted_to).toBe('docs/ready.md');
    expect(fs.readFileSync(path.join(readOnlyDir, 'ready.md'), 'utf-8')).not.toContain('promoted_to');
  });
});

describe('chooseCategory', () => {
  it('takes the category the person gave, else the AI\'s with its reason, else the keywords\' suggestion', () => {
    expect(chooseCategory({ given: 'docs', chosen: 'rules', reason: 'It states a constraint.', suggested: 'skills' })).toEqual({ category: 'docs', reason: 'Chosen with --category.' });
    expect(chooseCategory({ given: '', chosen: 'rules', reason: 'It states a constraint.', suggested: 'skills' })).toEqual({ category: 'rules', reason: 'It states a constraint.' });
    expect(chooseCategory({ given: '', chosen: '', reason: '', suggested: 'skills' })).toEqual({ category: 'skills', reason: 'Suggested by the learning\'s keywords, since the AI could not choose.' });
  });

  it('refuses a category that is not skills, rules or docs', () => {
    expect(() => chooseCategory({ given: 'wiki', chosen: '', reason: '', suggested: 'skills' })).toThrow('Invalid promotion category "wiki". Use skills, rules, or docs.');
  });
});
