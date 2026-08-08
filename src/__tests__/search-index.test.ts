import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tokenize, wordSegments, buildIndex, loadIndex, search } from '../utils/search-index.js';
import { computeIdfBaseline, isRelevantScore } from '../recall.js';
import type { SearchIndex } from '../types.js';

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

  it('does not mint bigrams across multi-char word boundaries', () => {
    // Segmenter yields 推理|服务; joining across that boundary would produce
    // "理服", a token matching no real term yet scoring like one.
    const tokens = tokenize('推理服务');
    expect(tokens).toContain('推理');
    expect(tokens).toContain('服务');
    expect(tokens).not.toContain('理服');
  });

  it('still recovers words the segmenter splits into single chars', () => {
    // Segmenter yields 排|查, so the bigram is what makes "排查" searchable.
    expect(tokenize('排查')).toContain('排查');
  });
});

describe('wordSegments', () => {
  it('splits space-free CJK into words a reader would name', () => {
    expect(wordSegments('推理服务崩溃')).toEqual(['推理', '服务', '崩溃']);
  });

  it('keeps compound identifiers whole instead of fragmenting them', () => {
    // tokenize() would yield app/id; reporting terms must not.
    expect(wordSegments('客户AppID错误')).toEqual(['客户', 'AppID', '错误']);
  });

  it('rejoins adjacent single-char CJK segments', () => {
    // Segmenter splits 排查 into 排|查; reporting both would be noise.
    expect(wordSegments('排查')).toEqual(['排查']);
    expect(wordSegments('NUMA 排查')).toEqual(['NUMA', '排查']);
  });

  it('reattaches suffix chars the segmenter peels off CJK words', () => {
    // 错误率 segments as 错误|率; a bare 率 is not a term the caller would
    // recognise, and it would permanently occupy a slot in Missing:.
    expect(wordSegments('错误率')).toEqual(['错误率']);
    expect(wordSegments('中间件')).toEqual(['中间件']);
    expect(wordSegments('使用率 成功率')).toEqual(['使用率', '成功率']);
  });

  it('reattaches only the first char when a word follows the peeled suffix', () => {
    // 中间件排查 segments as 中间|件|排|查. Gluing the whole run onto nothing
    // yielded ['中间', '件排查'] — a corrupted leading word plus a term the
    // caller never typed, and (worse) full coverage against a 中间件 tag.
    expect(wordSegments('中间件排查')).toEqual(['中间件', '排查']);
    expect(wordSegments('连接池耗尽')).toEqual(['连接池', '耗尽']);
  });

  it('joins a run the segmenter gives up on entirely', () => {
    // 限流熔断降级 segments as 限|流|熔|断|降级 — no preceding multi-char word,
    // so the leading run has no suffix to reattach and cannot be split without
    // a dictionary.
    expect(wordSegments('限流熔断降级')).toEqual(['限流熔断', '降级']);
  });

  it('keeps a genuine single-char word separate when whitespace delimits it', () => {
    expect(wordSegments('服务 猫')).toEqual(['服务', '猫']);
    expect(wordSegments('猫')).toEqual(['猫']);
  });

  it('does not join single chars across punctuation', () => {
    expect(wordSegments('中，文')).toEqual(['中', '文']);
  });

  it('returns empty for blank input', () => {
    expect(wordSegments('')).toEqual([]);
    expect(wordSegments('   ')).toEqual([]);
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

  it('collapses duplicate entries so they do not consume two result slots', async () => {
    // Same learning shared twice: identical content, different filename suffix.
    const dup = `---
title: "Duplicate Learning"
author: carol
date: 2026-03-01
tags: [duplicate, oom]
---

Body about oom.
`;
    writeLearningDoc(learningsDir, 'dup-2026-03-01-aaa.md', dup);
    writeLearningDoc(learningsDir, 'dup-2026-03-01-bbb.md', dup);
    await buildIndex(learningsDir);
    const index = await loadIndex();

    const results = search('duplicate', index!);
    const titles = results.map((r) => r.entry.title);
    expect(titles.filter((t) => t === 'Duplicate Learning')).toHaveLength(1);
  });

  it('reports term coverage per query word, not per internal token', async () => {
    const index = await loadIndex();
    // "AppID" tokenizes to app/id; the caller should see the word they typed.
    const results = search('oom AppID', index!);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchedTerms).toContain('oom');
    expect(results[0].missingTerms).toContain('AppID');
  });

  it('does not claim full coverage when a peeled suffix corrupted the words', async () => {
    // Query 中间件排查 against an entry tagged 中间件. Gluing the run gave
    // ['中间', '件排查'], so 中间 matched the tag, nothing was missing, and the
    // Missing: line was omitted — reporting full coverage for a troubleshooting
    // query against a plain overview entry.
    writeLearningDoc(learningsDir, 'mw-2026-03-05-mid.md', `---
title: "中间件概览"
author: dave
date: 2026-03-05
tags: [中间件]
---

Overview of the middleware layer.
`);
    await buildIndex(learningsDir);
    const index = await loadIndex();

    const results = search('中间件排查', index!);
    const mw = results.find((r) => r.entry.title === '中间件概览');
    expect(mw).toBeDefined();
    expect(mw!.matchedTerms).toEqual(['中间件']);
    expect(mw!.missingTerms).toEqual(['排查']);
  });

  it('omits coverage for codebase docs admitted on a body-only match', async () => {
    // team-codebase docs have no tags, so search() lets them match on body
    // alone. Reporting coverage for them would mark every term missing, and the
    // caller is told to treat that as "no coverage" — discarding a valid hit.
    const index: SearchIndex = {
      version: 6,
      entries: [
        {
          filename: 'arch.md',
          title: 'Architecture notes',
          author: 'bob',
          date: '2026-03-01',
          tags: [],
          tokens: ['authentication', 'retry'],
          votes: 0,
          type: 'docs',
          domain: 'technical',
          path: '/repo/docs/team-codebase/arch.md',
        },
      ],
      df: { authentication: 1, retry: 1 },
    } as unknown as SearchIndex;

    const results = search('authentication retry', index);
    expect(results).toHaveLength(1);
    expect(results[0].matchedTerms).toBeUndefined();
    expect(results[0].missingTerms).toBeUndefined();
  });

  it('marks every term missing when a hit only matches on body text', async () => {
    const index = await loadIndex();
    // "troubleshooting" is a tag on k8s-oom, so the entry surfaces; "部署"
    // appears only in another doc's body and belongs to no title or tag.
    const results = search('troubleshooting 部署', index!);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchedTerms).toEqual(['troubleshooting']);
    expect(results[0].missingTerms).toEqual(['部署']);
  });

  it('reports coverage for space-free CJK queries instead of claiming full coverage', async () => {
    const index = await loadIndex();
    // A whitespace split would make this one "word", matched because 排查 hits
    // the k8s-oom title — reporting full coverage while 部署 matched nothing.
    const results = search('排查部署', index!);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchedTerms).toContain('排查');
    expect(results[0].missingTerms).toContain('部署');
  });

  it('keeps normalized scores above the relevance threshold for genuine hits', async () => {
    const index = await loadIndex();
    const baseline = computeIdfBaseline([index!]);
    // Length normalization must not push real hits under the cutoff. A longer
    // query matches more terms, so numerator and divisor grow together — pin
    // that here so a future change to either side cannot silently suppress
    // long queries.
    const short = search('oom', index!);
    const long = search('k8s pod oom 排查指南 内存 超限 troubleshooting', index!);
    expect(short.length).toBeGreaterThan(0);
    expect(long.length).toBeGreaterThan(0);
    expect(isRelevantScore(short[0].score, false, baseline)).toBe(true);
    expect(isRelevantScore(long[0].score, false, baseline)).toBe(true);
  });

  it('normalizes score by query length so scores are comparable across queries', async () => {
    const index = await loadIndex();
    // Same single matching term, but the second query pads it with words that
    // match nothing. Without length normalization the padded query would score
    // identically, letting verbose queries clear an absolute threshold on
    // filler alone.
    const short = search('oom', index!);
    const padded = search('oom zzz qqq vvv', index!);
    expect(short.length).toBeGreaterThan(0);
    expect(padded.length).toBeGreaterThan(0);
    expect(padded[0].entry.filename).toBe(short[0].entry.filename);
    expect(padded[0].score).toBeLessThan(short[0].score);
  });

  it('length normalization does not change ranking within one query', async () => {
    const index = await loadIndex();
    // Normalization is a constant factor per query, so relative order is intact.
    // "troubleshooting" tags k8s-oom; "docker" titles/tags the docker doc.
    const results = search('troubleshooting docker', index!);
    expect(results.length).toBeGreaterThan(1);
    const scores = results.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
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
