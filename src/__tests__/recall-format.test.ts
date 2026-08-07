/**
 * Unit tests for formatResults — verifies Sources line rendering.
 *
 * formatResults is a pure function: given a ScopedSearchResult[], it returns
 * a formatted string.  No filesystem or network access required.
 */
import { describe, it, expect } from 'vitest';

import { formatResults } from '../recall.js';
import type { SearchIndexEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal fixture factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal SearchIndexEntry with only the fields formatResults uses.
 * Callers override what they need.
 */
function makeEntry(overrides: Partial<SearchIndexEntry> = {}): SearchIndexEntry {
  return {
    filename: 'fixture.md',
    title: 'Fixture Entry',
    author: 'test-author',
    date: '2026-01-01',
    tags: [],
    tokens: [],
    votes: 0,
    type: 'learnings',
    domain: 'technical',
    snippet: 'This is a test snippet.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatResults — Sources line', () => {
  it('带 sources 的结果在 File: 之后、Snippet: 之前输出 Sources 行', () => {
    const output = formatResults([
      {
        entry: makeEntry({ title: 'Code Page', path: '/wiki/evidence/code/proj/foo.md' }),
        score: 7.5,
        scope: 'project',
        sources: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      },
    ]);

    expect(output).toContain('Sources: src/a.ts, src/b.ts');

    const fileIdx = output.indexOf('File:');
    const sourcesIdx = output.indexOf('Sources:');
    const snippetIdx = output.indexOf('Snippet:');

    expect(fileIdx).toBeGreaterThan(-1);
    expect(sourcesIdx).toBeGreaterThan(fileIdx);
    expect(snippetIdx).toBeGreaterThan(sourcesIdx);
  });

  it('sources 为 undefined 时输出不含 Sources: 行', () => {
    const output = formatResults([
      {
        entry: makeEntry({ title: 'No Source Page', path: '/wiki/evidence/code/proj/bar.md' }),
        score: 5.0,
        scope: 'project',
        sources: undefined,
      },
    ]);

    expect(output).not.toContain('Sources:');
  });

  it('普通 learnings 结果（无 sources、有 snippet）输出形态不变', () => {
    const output = formatResults([
      {
        entry: makeEntry({
          title: 'Regular Learning',
          filename: 'regular.md',
          snippet: 'Important lesson learned.',
          type: 'learnings',
        }),
        score: 6.0,
        scope: 'user',
        learningsBase: '/home/user/.teamai/learnings',
      },
    ]);

    expect(output).not.toContain('Sources:');
    expect(output).toContain('Snippet: Important lesson learned.');
  });
});

describe('formatResults — term coverage', () => {
  it('reports matched and missing query terms so the caller can judge relevance', () => {
    const output = formatResults([
      {
        entry: makeEntry({ title: 'Inference service restart', type: 'learnings' }),
        score: 16.2,
        scope: 'user',
        matchedTerms: ['推理服务'],
        missingTerms: ['acme-corp', 'AccountID'],
      },
    ]);

    expect(output).toContain('Matched: 推理服务 | Missing: acme-corp, AccountID');
  });

  it('reports "none" when the hit covers no query term', () => {
    const output = formatResults([
      {
        entry: makeEntry({ title: 'Unrelated', type: 'learnings' }),
        score: 8.0,
        scope: 'user',
        matchedTerms: [],
        missingTerms: ['rotary', 'CP'],
      },
    ]);

    expect(output).toContain('Matched: none | Missing: rotary, CP');
  });

  it('omits the line when every term matched, and for codebase hits without coverage data', () => {
    const allMatched = formatResults([
      {
        entry: makeEntry({ title: 'Full hit', type: 'learnings' }),
        score: 40.1,
        scope: 'user',
        matchedTerms: ['NUMA', 'goosefs'],
        missingTerms: [],
      },
    ]);
    expect(allMatched).not.toContain('Missing:');

    const codebaseHit = formatResults([
      {
        entry: makeEntry({ title: 'Graph page', path: '/wiki/evidence/code/p/x.md' }),
        score: 5.0,
        scope: 'project',
      },
    ]);
    expect(codebaseHit).not.toContain('Missing:');
  });
});
