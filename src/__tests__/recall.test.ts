import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { autoUpvote } from '../recall.js';
import { buildIndex, loadIndex, search } from '../utils/search-index.js';
import type { SearchResult } from '../utils/search-index.js';
import type { SearchIndex, UserVotesV2 } from '../types.js';

// ─── Test helpers ──────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-test-'));
}

function writeLearningDoc(dir: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
}

const DOC_API = `---
title: "解决 SGLang API 超时问题"
author: jeff
date: 2026-03-20
tags: [python, sglang, api-timeout]
---

增加 retry backoff 配置。
`;

const DOC_K8S = `---
title: "K8s Pod OOM 排查指南"
author: alice
date: 2026-03-15
tags: [k8s, oom, troubleshooting]
---

检查 kubectl describe pod。
`;

// ─── autoUpvote ────────────────────────────────────────────

describe('autoUpvote', () => {
  let tmpDir: string;
  let repoPath: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    repoPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repoPath, 'votes'), { recursive: true });
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeResult(filename: string): SearchResult {
    return {
      entry: {
        filename,
        title: 'Test',
        author: 'test',
        date: '2026-03-28',
        tags: [],
        tokens: [],
        votes: 0,
        type: 'learnings',
      },
      score: 5,
    };
  }

  it('T12: creates new vote entry on first upvote (V2 format)', async () => {
    const results = [makeResult('api-timeout-2026-03-20-abc.md')];
    await autoUpvote(results, 'jeff', repoPath);

    // Check local votes file
    const localPath = path.join(tmpDir, '.teamai', 'votes', 'jeff.yaml');
    expect(fs.existsSync(localPath)).toBe(true);

    const content = fs.readFileSync(localPath, 'utf-8');
    const parsed = YAML.parse(content) as UserVotesV2;
    expect(parsed.version).toBe(2);
    expect(parsed.votes['api-timeout-2026-03-20-abc']).toBeDefined();
    expect(parsed.votes['api-timeout-2026-03-20-abc'].recalled_count).toBe(1);
    expect(parsed.votes['api-timeout-2026-03-20-abc'].last_recalled_at).toBeTruthy();

    // Repo votes dir should NOT have the file — votes are only written
    // to the repo by reportUsageToTeam() during `teamai pull`.
    const repoVotePath = path.join(repoPath, 'votes', 'jeff.yaml');
    expect(fs.existsSync(repoVotePath)).toBe(false);
  });

  it('T13: increments recalled_count on each call (V2 is cumulative)', async () => {
    const results = [makeResult('api-timeout-2026-03-20-abc.md')];

    // First vote
    await autoUpvote(results, 'jeff', repoPath);
    const localPath = path.join(tmpDir, '.teamai', 'votes', 'jeff.yaml');
    const firstContent = fs.readFileSync(localPath, 'utf-8');
    const firstParsed = YAML.parse(firstContent) as UserVotesV2;
    expect(firstParsed.votes['api-timeout-2026-03-20-abc'].recalled_count).toBe(1);

    // Second vote (same doc) — should increment
    await autoUpvote(results, 'jeff', repoPath);
    const secondContent = fs.readFileSync(localPath, 'utf-8');
    const secondParsed = YAML.parse(secondContent) as UserVotesV2;
    expect(secondParsed.votes['api-timeout-2026-03-20-abc'].recalled_count).toBe(2);
  });

  it('accumulates votes for different docs', async () => {
    await autoUpvote([makeResult('doc-a.md')], 'jeff', repoPath);
    await autoUpvote([makeResult('doc-b.md')], 'jeff', repoPath);

    const localPath = path.join(tmpDir, '.teamai', 'votes', 'jeff.yaml');
    const content = fs.readFileSync(localPath, 'utf-8');
    const parsed = YAML.parse(content) as UserVotesV2;
    expect(Object.keys(parsed.votes)).toHaveLength(2);
    expect(parsed.votes['doc-a']).toBeDefined();
    expect(parsed.votes['doc-b']).toBeDefined();
  });

  it('handles empty results gracefully', async () => {
    await autoUpvote([], 'jeff', repoPath);
    const localPath = path.join(tmpDir, '.teamai', 'votes', 'jeff.yaml');
    expect(fs.existsSync(localPath)).toBe(false);
  });

  it('recovers from corrupt local votes file', async () => {
    const localDir = path.join(tmpDir, '.teamai', 'votes');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'jeff.yaml'), '{ corrupt yaml !!!', 'utf-8');

    const results = [makeResult('new-doc.md')];
    await autoUpvote(results, 'jeff', repoPath);

    const content = fs.readFileSync(path.join(localDir, 'jeff.yaml'), 'utf-8');
    const parsed = YAML.parse(content) as UserVotesV2;
    expect(parsed.version).toBe(2);
    expect(parsed.votes['new-doc']).toBeDefined();
    expect(parsed.votes['new-doc'].recalled_count).toBe(1);
  });
});

// ─── recall integration (search + format) ──────────────────

describe('recall integration', () => {
  let tmpDir: string;
  let learningsDir: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    process.env.HOME = tmpDir;

    writeLearningDoc(learningsDir, 'api-timeout-2026-03-20-abc.md', DOC_API);
    writeLearningDoc(learningsDir, 'k8s-oom-2026-03-15-def.md', DOC_K8S);
    await buildIndex(learningsDir);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('T14: recall finds results and ranks them', async () => {
    const index = await loadIndex();
    expect(index).not.toBeNull();

    const results = search('api timeout', index!);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.title).toContain('API');
  });

  it('T15: empty query returns no results', async () => {
    const index = await loadIndex();
    const results = search('', index!);
    expect(results).toHaveLength(0);
  });

  it('T16: votes boost ranking', async () => {
    // Build index with votes for k8s doc
    const votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(votesDir, { recursive: true });
    fs.writeFileSync(
      path.join(votesDir, 'user1.yaml'),
      'votes:\n  k8s-oom-2026-03-15-def:\n    at: "2026-03-28T10:00:00Z"\n',
    );
    fs.writeFileSync(
      path.join(votesDir, 'user2.yaml'),
      'votes:\n  k8s-oom-2026-03-15-def:\n    at: "2026-03-28T11:00:00Z"\n',
    );
    fs.writeFileSync(
      path.join(votesDir, 'user3.yaml'),
      'votes:\n  k8s-oom-2026-03-15-def:\n    at: "2026-03-28T12:00:00Z"\n',
    );

    await buildIndex(learningsDir, votesDir);
    const index = await loadIndex();
    const k8sEntry = index!.entries.find((e) => e.filename.includes('k8s'));
    expect(k8sEntry!.votes).toBe(3);
  });

  it('T17: pull sync → recall end-to-end flow', async () => {
    // Simulate: docs exist, index built, search works
    const index = await loadIndex();
    expect(index).not.toBeNull();
    expect(index!.entries.length).toBe(2);

    // Search for Chinese bigram
    const results = search('排查', index!);
    expect(results.length).toBeGreaterThan(0);
    // K8s doc has "排查" in title
    expect(results[0].entry.title).toContain('排查');
  });
});
