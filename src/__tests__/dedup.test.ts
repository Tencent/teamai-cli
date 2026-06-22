import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractKeywords, overlapRatio, findSupersededLearnings } from '../utils/dedup.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dedup-test-'));
}

function formatDatePrefix(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

// ─── extractKeywords ───────────────────────────────────────────────────────

describe('extractKeywords', () => {
  it('提取英文关键词，过滤停用词', () => {
    const keywords = extractKeywords('The quick brown fox');
    expect(keywords.has('quick')).toBe(true);
    expect(keywords.has('brown')).toBe(true);
    expect(keywords.has('fox')).toBe(true);
    expect(keywords.has('the')).toBe(false);
  });

  it('提取 CJK 关键词，过滤 CJK 停用词', () => {
    const keywords = extractKeywords('优化性能问题的解决方案');
    // '的' 是 CJK 停用词，不应出现
    expect(keywords.has('的')).toBe(false);
    // 其余非停用词单字应出现
    expect(keywords.has('优')).toBe(true);
    expect(keywords.has('化')).toBe(true);
    expect(keywords.has('性')).toBe(true);
    expect(keywords.has('能')).toBe(true);
  });

  it('过滤长度 < 2 的英文词（单字母）', () => {
    const keywords = extractKeywords('a b c do run');
    expect(keywords.has('a')).toBe(false);
    expect(keywords.has('b')).toBe(false);
    expect(keywords.has('c')).toBe(false);
    // 'do' 是停用词，'run' 应出现
    expect(keywords.has('run')).toBe(true);
  });
});

// ─── overlapRatio ──────────────────────────────────────────────────────────

describe('overlapRatio', () => {
  it('完全相同集合返回 1.0', () => {
    const setA = new Set(['a', 'b', 'c']);
    const setB = new Set(['a', 'b', 'c']);
    expect(overlapRatio(setA, setB)).toBe(1.0);
  });

  it('完全不同集合返回 0.0', () => {
    const setA = new Set(['a', 'b']);
    const setB = new Set(['c', 'd']);
    expect(overlapRatio(setA, setB)).toBe(0.0);
  });

  it('部分重叠：{a,b,c} 和 {b,c,d} 返回 0.5', () => {
    const setA = new Set(['a', 'b', 'c']);
    const setB = new Set(['b', 'c', 'd']);
    // 交集 {b,c}=2，并集 {a,b,c,d}=4，Jaccard=0.5
    expect(overlapRatio(setA, setB)).toBe(0.5);
  });

  it('空集合返回 0', () => {
    const empty = new Set<string>();
    const nonEmpty = new Set(['a', 'b']);
    expect(overlapRatio(empty, nonEmpty)).toBe(0);
    expect(overlapRatio(nonEmpty, empty)).toBe(0);
    expect(overlapRatio(empty, empty)).toBe(0);
  });
});

// ─── findSupersededLearnings ───────────────────────────────────────────────

describe('findSupersededLearnings', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('正常：14 天内文件关键词高度重叠，应返回该文件且 overlap ≥ 0.6', async () => {
    const prefix = formatDatePrefix(3); // 3 天前
    const filename = `${prefix}-optimize-performance.md`;
    const content = `---
title: "optimize performance solution"
---
optimize performance solution issue resolve method
`;
    fs.writeFileSync(path.join(tmpDir, filename), content, 'utf-8');

    const draftKeywords = new Set(['optimize', 'performance', 'solution', 'issue', 'resolve']);
    const results = await findSupersededLearnings(draftKeywords, tmpDir, 14);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filename).toBe(filename);
    expect(results[0].overlap).toBeGreaterThanOrEqual(0.6);
  });

  it('超出 14 天的文件不应返回', async () => {
    const prefix = formatDatePrefix(20); // 20 天前
    const filename = `${prefix}-old-learning.md`;
    const content = `---
title: "old learning"
---
optimize performance solution issue resolve method
`;
    fs.writeFileSync(path.join(tmpDir, filename), content, 'utf-8');

    const draftKeywords = new Set(['optimize', 'performance', 'solution', 'issue', 'resolve']);
    const results = await findSupersededLearnings(draftKeywords, tmpDir, 14);

    expect(results).toHaveLength(0);
  });

  it('目录不存在时返回空数组', async () => {
    const nonExistentDir = path.join(tmpDir, 'not-exist');
    const draftKeywords = new Set(['optimize', 'performance']);
    const results = await findSupersededLearnings(draftKeywords, nonExistentDir, 14);

    expect(results).toEqual([]);
  });

  it('低重叠（< 0.6）的文件不应返回', async () => {
    const prefix = formatDatePrefix(1); // 1 天前
    const filename = `${prefix}-unrelated.md`;
    const content = `---
title: "unrelated topic"
---
kubernetes docker container deployment cluster
`;
    fs.writeFileSync(path.join(tmpDir, filename), content, 'utf-8');

    const draftKeywords = new Set(['python', 'pandas', 'dataframe', 'numpy', 'csv']);
    const results = await findSupersededLearnings(draftKeywords, tmpDir, 14);

    expect(results).toHaveLength(0);
  });
});
