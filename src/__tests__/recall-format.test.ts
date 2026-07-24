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
        sources: ['src/a.ts', 'src/b.ts'],
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
