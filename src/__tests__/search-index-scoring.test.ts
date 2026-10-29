import { describe, it, expect } from 'vitest';
import { search, TITLE_LENGTH_SCALE } from '../utils/search-index.js';
import type { SearchIndex, SearchIndexEntry } from '../types.js';

// Scoring behavior that the hard-set measurements depend on:
// question phrasing must not score, and a long hub title must not buy the same
// title match at full weight as a short topic title.

function entry(over: Partial<SearchIndexEntry> & { filename: string; title: string }): SearchIndexEntry {
  return {
    author: 'tester',
    date: '2026-05-01',
    tags: [],
    tokens: [],
    votes: 0,
    type: 'docs',
    domain: 'technical',
    path: `/kb/docs/${over.filename}`,
    ...over,
  };
}

function index(entries: SearchIndexEntry[]): SearchIndex {
  const dfByDomain: Record<string, Record<string, number>> = {};
  for (const e of entries) {
    const domain = e.domain ?? 'neutral';
    dfByDomain[domain] ??= {};
    for (const t of new Set(e.tokens)) dfByDomain[domain][t] = (dfByDomain[domain][t] ?? 0) + 1;
  }
  return { version: 7, builtAt: '2026-05-01T00:00:00Z', elapsedMs: 0, entries, dfByDomain };
}

describe('search scoring', () => {
  const deployment = entry({
    filename: 'deploy.md',
    title: '部署手册',
    tokens: ['title:部署', '部署', 'tag:部署', '发布'],
  });

  it('drops question words, so they neither add results nor change the score', () => {
    const idx = index([deployment]);
    const plain = search('部署', idx, 5);
    const withFiller = search('部署 为什么 应该 可以', idx, 5);
    expect(plain).toHaveLength(1);
    expect(withFiller).toHaveLength(1);
    expect(withFiller[0].entry.filename).toBe('deploy.md');
    expect(withFiller[0].score).toBeCloseTo(plain[0].score, 10);
  });

  it('returns nothing when the query is only question words', () => {
    const idx = index([deployment]);
    expect(search('为什么 应该 可以', idx, 5)).toEqual([]);
  });

  it('normalizes the title field by length: a short topic title outranks a long hub title', () => {
    const short = entry({ filename: 'short.md', title: '订单事件', tokens: ['title:订单', '订单', '订单事件'] });
    const hub = entry({
      filename: 'hub.md',
      title: '订单排查手册：查不到、查得慢、数据不一致（L4 runbook）',
      tokens: ['title:订单', '订单', '订单排查'],
    });
    const results = search('订单', index([hub, short]), 5);
    expect(results.map((r) => r.entry.filename)).toEqual(['short.md', 'hub.md']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('divides the title score by sqrt(title length / TITLE_LENGTH_SCALE)', () => {
    const title = '订单排查手册：查不到、查得慢、数据不一致（L4 runbook）';
    // Only the title token matches, so the score is the title contribution
    // alone and the ratio of the two scores is the ratio of the divisors.
    const long = entry({ filename: 'long.md', title, tokens: ['title:订单'] });
    const short = entry({ filename: 'short.md', title: '订单', tokens: ['title:订单'] });
    const results = search('订单', index([long, short]), 5);
    const longResult = results.find((r) => r.entry.filename === 'long.md')!;
    const shortResult = results.find((r) => r.entry.filename === 'short.md')!;
    const longFactor = Math.sqrt(Math.max(1, title.length / TITLE_LENGTH_SCALE));
    const shortFactor = Math.sqrt(Math.max(1, '订单'.length / TITLE_LENGTH_SCALE));
    // The long title's contribution is divided by a larger factor, so it scores
    // lower by exactly that ratio.
    expect(longResult.score / shortResult.score).toBeCloseTo(shortFactor / longFactor, 6);
  });
});
