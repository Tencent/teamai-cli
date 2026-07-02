import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tokenize, buildIndex, loadIndex, search } from '../utils/search-index.js';

// ─── Test helpers ──────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-search-test-'));
}

function writeLearningDoc(
  dir: string,
  filename: string,
  content: string,
): void {
  fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
}

const DOC_WITH_FRONTMATTER = `---
title: "解决 SGLang API 超时问题"
author: jeff
date: 2026-03-20
tags: [python, sglang, api-timeout]
---

## 背景
在部署 SGLang 推理服务时遇到 API 请求超时。

## 解决方案
增加 retry backoff 配置，调整 timeout 参数到 60 秒。
`;

const DOC_WITHOUT_FRONTMATTER = `# K8s Pod OOM 排查

当 Pod 内存超限被 OOMKilled 时的排查步骤。

1. 检查 kubectl describe pod
2. 查看 container limits
`;

const DOC_EMPTY = '';

// ─── tokenize ─────────────────────────────────────────────

describe('tokenize', () => {
  it('T1: tokenizes mixed Chinese and English text with CJK bigrams', () => {
    const tokens = tokenize('解决SGLang API超时问题');
    // Should contain English words
    expect(tokens).toContain('sglang');
    expect(tokens).toContain('api');
    // Should contain CJK bigrams for compound words
    expect(tokens).toContain('超时');
    expect(tokens).toContain('问题');
    expect(tokens).toContain('解决');
  });

  it('T2: tokenizes pure English correctly', () => {
    const tokens = tokenize('API timeout retry');
    expect(tokens).toContain('api');
    expect(tokens).toContain('timeout');
    expect(tokens).toContain('retry');
  });

  it('T3: returns empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });

  it('handles CJK-only text with bigrams', () => {
    const tokens = tokenize('排查指南');
    expect(tokens).toContain('排查');
    expect(tokens).toContain('指南');
    // Individual chars should also be present
    expect(tokens).toContain('排');
    expect(tokens).toContain('查');
  });

  it('deduplicates tokens', () => {
    const tokens = tokenize('api api api');
    const apiCount = tokens.filter((t) => t === 'api').length;
    expect(apiCount).toBe(1);
  });
});

// ─── buildIndex ───────────────────────────────────────────

describe('buildIndex', () => {
  let tmpDir: string;
  let learningsDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('T4: builds index from docs with frontmatter', async () => {
    writeLearningDoc(learningsDir, 'api-timeout-2026-03-20-abc123.md', DOC_WITH_FRONTMATTER);
    writeLearningDoc(learningsDir, 'k8s-oom-2026-03-15-def456.md', DOC_WITHOUT_FRONTMATTER);
    writeLearningDoc(learningsDir, 'another-2026-03-10-ghi789.md', `---
title: "Docker 网络配置"
author: alice
date: 2026-03-10
tags: [docker, networking]
---

Docker bridge 网络的常见配置方法。
`);

    const elapsed = await buildIndex(learningsDir);
    expect(elapsed).toBeGreaterThanOrEqual(0);

    const index = await loadIndex();
    expect(index).not.toBeNull();
    expect(index!.entries).toHaveLength(3);

    // Check frontmatter parsed correctly
    const apiEntry = index!.entries.find((e) => e.filename.includes('api-timeout'));
    expect(apiEntry).toBeDefined();
    expect(apiEntry!.title).toBe('解决 SGLang API 超时问题');
    expect(apiEntry!.author).toBe('jeff');
    expect(apiEntry!.tags).toEqual(['python', 'sglang', 'api-timeout']);
  });

  it('T5: uses filename fallback when frontmatter is missing', async () => {
    writeLearningDoc(learningsDir, 'k8s-oom-排查-2026-03-15-def456.md', DOC_WITHOUT_FRONTMATTER);

    await buildIndex(learningsDir);
    const index = await loadIndex();
    expect(index).not.toBeNull();

    const entry = index!.entries[0];
    // Title derived from filename (strips date suffix)
    expect(entry.title).toBe('k8s oom 排查');
    expect(entry.tags).toEqual([]);
  });

  it('T6: builds empty index for empty directory', async () => {
    await buildIndex(learningsDir);
    const index = await loadIndex();
    expect(index).not.toBeNull();
    expect(index!.entries).toHaveLength(0);
  });

  it('T7: truncates oversized documents (>50KB)', async () => {
    const bigContent = `---
title: "Big doc"
author: test
date: 2026-03-28
tags: [test]
---

${'x'.repeat(60000)}
`;
    writeLearningDoc(learningsDir, 'big-doc-2026-03-28-aaa111.md', bigContent);

    await buildIndex(learningsDir);
    const index = await loadIndex();
    expect(index).not.toBeNull();
    expect(index!.entries).toHaveLength(1);
    // Entry exists despite truncation
    expect(index!.entries[0].title).toBe('Big doc');
  });

  it('skips empty files', async () => {
    writeLearningDoc(learningsDir, 'empty-2026-03-28-bbb222.md', DOC_EMPTY);

    await buildIndex(learningsDir);
    const index = await loadIndex();
    expect(index).not.toBeNull();
    expect(index!.entries).toHaveLength(0);
  });

  it('skips non-md files', async () => {
    writeLearningDoc(learningsDir, 'readme.txt', 'not a learning doc');
    writeLearningDoc(learningsDir, 'doc-2026-03-28-ccc.md', DOC_WITH_FRONTMATTER);

    await buildIndex(learningsDir);
    const index = await loadIndex();
    expect(index!.entries).toHaveLength(1);
  });
});

// ─── search ────────────────────────────────────────────────

describe('search', () => {
  let tmpDir: string;
  let learningsDir: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    process.env.HOME = tmpDir;

    // Build a test index with multiple docs
    writeLearningDoc(learningsDir, 'api-timeout-2026-03-20-abc.md', DOC_WITH_FRONTMATTER);
    writeLearningDoc(learningsDir, 'k8s-oom-2026-03-15-def.md', `---
title: "K8s Pod OOM 排查指南"
author: alice
date: 2026-03-15
tags: [k8s, oom, troubleshooting]
---

当 Pod 内存超限被 OOMKilled 时的排查步骤。
`);
    writeLearningDoc(learningsDir, 'docker-net-2026-03-10-ghi.md', `---
title: "Docker 网络配置"
author: bob
date: 2026-03-10
tags: [docker, networking]
---

Docker bridge 网络的常见配置方法。
`);

    await buildIndex(learningsDir);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('T8: matches by English keywords', async () => {
    const index = await loadIndex();
    const results = search('api timeout', index!);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.filename).toContain('api-timeout');
  });

  it('T9: matches via CJK bigrams', async () => {
    const index = await loadIndex();
    const results = search('超时', index!);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.filename).toContain('api-timeout');
  });

  it('T10: returns empty for nonexistent query', async () => {
    const index = await loadIndex();
    const results = search('nonexistent keyword xyz', index!);
    expect(results).toHaveLength(0);
  });

  it('returns empty for empty query', async () => {
    const index = await loadIndex();
    const results = search('', index!);
    expect(results).toHaveLength(0);
  });

  it('ranks title matches higher than body matches', async () => {
    const index = await loadIndex();
    // "OOM" is in the title of k8s doc
    const results = search('oom', index!);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.filename).toContain('k8s-oom');
  });

  it('discards results with only body matches (no title/tag hit)', async () => {
    // "部署" appears in the body of api-timeout doc ("部署 SGLang 推理服务")
    // but NOT in any title or tag of the test docs.
    // A body-only match should be filtered out.
    const index = await loadIndex();
    const results = search('部署', index!);
    expect(results).toHaveLength(0);
  });

  it('returns results when query matches tag but not title', async () => {
    const index = await loadIndex();
    // "troubleshooting" is a tag on k8s-oom doc
    const results = search('troubleshooting', index!);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.filename).toContain('k8s-oom');
  });

  it('returns results when query matches title even without tag hit', async () => {
    const index = await loadIndex();
    // "Docker" is in the title of docker-net doc
    const results = search('Docker', index!);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.filename).toContain('docker-net');
  });

  it('respects limit parameter', async () => {
    const index = await loadIndex();
    const results = search('docker k8s api', index!, 1);
    expect(results).toHaveLength(1);
  });
});

// ─── loadIndex ─────────────────────────────────────────────

describe('loadIndex', () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    fs.mkdirSync(path.join(tmpDir, '.teamai'), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('T11: returns null for corrupt index JSON', async () => {
    const indexPath = path.join(tmpDir, '.teamai', 'search-index.json');
    fs.writeFileSync(indexPath, '{ invalid json !!!', 'utf-8');

    const index = await loadIndex();
    expect(index).toBeNull();
  });

  it('returns null when index file does not exist', async () => {
    const index = await loadIndex();
    expect(index).toBeNull();
  });
});

// ─── vote aggregation in buildIndex ─────────────────────────

describe('buildIndex with votes', () => {
  let tmpDir: string;
  let learningsDir: string;
  let votesDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    learningsDir = path.join(tmpDir, 'learnings');
    votesDir = path.join(tmpDir, 'votes');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.mkdirSync(votesDir, { recursive: true });
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('aggregates votes from per-user YAML files', async () => {
    writeLearningDoc(learningsDir, 'api-timeout-2026-03-20-abc.md', DOC_WITH_FRONTMATTER);

    // Two users voted for the same doc
    fs.writeFileSync(
      path.join(votesDir, 'jeff.yaml'),
      'votes:\n  api-timeout-2026-03-20-abc:\n    at: "2026-03-20T10:00:00Z"\n',
    );
    fs.writeFileSync(
      path.join(votesDir, 'alice.yaml'),
      'votes:\n  api-timeout-2026-03-20-abc:\n    at: "2026-03-20T11:00:00Z"\n',
    );

    await buildIndex(learningsDir, votesDir);
    const index = await loadIndex();
    expect(index).not.toBeNull();

    const entry = index!.entries[0];
    expect(entry.votes).toBe(2);
  });
});

// ─── codebase-index.md 跳过与权重 boost ──────────────────────

describe('codebase-index skip and weight boost', () => {
  let tmpDir: string;
  let docsDir: string;
  const originalHome = process.env.HOME;

  const CODEBASE_FULL_CONTENT = `---
title: "Codebase Full Document"
tags: [codebase, architecture]
---

## Overview
This is the full codebase documentation with all details.
`;

  const CODEBASE_INDEX_CONTENT = `---
title: "Codebase Index"
tags: [codebase, architecture]
---

## Overview
This is the codebase index with chapter summaries.
`;

  const NORMAL_DOC_CONTENT = `---
title: "Normal Architecture Doc"
tags: [codebase, architecture]
---

## Overview
This is a normal documentation file about architecture.
`;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips codebase.md when codebase-index.md exists in same directory', async () => {
    fs.writeFileSync(path.join(docsDir, 'codebase.md'), CODEBASE_FULL_CONTENT);
    fs.writeFileSync(path.join(docsDir, 'codebase-index.md'), CODEBASE_INDEX_CONTENT);

    await buildIndex({ docsDir });
    const index = await loadIndex();
    expect(index).not.toBeNull();

    const filenames = index!.entries.map((e) => e.filename);
    expect(filenames).not.toContain('codebase.md');
    expect(filenames).toContain('codebase-index.md');
  });

  it('includes codebase.md when codebase-index.md does not exist', async () => {
    fs.writeFileSync(path.join(docsDir, 'codebase.md'), CODEBASE_FULL_CONTENT);

    await buildIndex({ docsDir });
    const index = await loadIndex();
    expect(index).not.toBeNull();

    const filenames = index!.entries.map((e) => e.filename);
    expect(filenames).toContain('codebase.md');
  });

  it('codebase-index.md scores higher than a normal docs file with same query', async () => {
    fs.writeFileSync(path.join(docsDir, 'codebase-index.md'), CODEBASE_INDEX_CONTENT);
    fs.writeFileSync(path.join(docsDir, 'normal-doc.md'), NORMAL_DOC_CONTENT);

    await buildIndex({ docsDir });
    const index = await loadIndex();
    expect(index).not.toBeNull();

    const results = search('codebase architecture', index!, 10);
    const indexEntry = results.find((r) => r.entry.filename === 'codebase-index.md');
    const normalEntry = results.find((r) => r.entry.filename === 'normal-doc.md');

    expect(indexEntry).toBeDefined();
    expect(normalEntry).toBeDefined();
    expect(indexEntry!.score).toBeGreaterThan(normalEntry!.score);
  });
});
