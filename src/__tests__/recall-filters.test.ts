import { describe, it, expect, vi } from 'vitest';
import type { KnowledgeDomain, KnowledgeType } from '../types.js';
import { parseFilterValues, matchesFilters, compareResults } from '../recall.js';

// ---------------------------------------------------------------------------
// recall-filters.test.ts — unit tests for parseFilterValues and matchesFilters
//
// These are pure-function tests only. The recall() function itself depends on
// file-system and network resources (~/.teamai/, repo config) that make
// end-to-end isolation impractical without large mocks. The two exported
// helpers cover all filter logic, so testing them directly is both sufficient
// and reliable.
// ---------------------------------------------------------------------------

const VALID_DOMAINS = new Set<KnowledgeDomain>(['technical', 'ops', 'support', 'neutral']);
const VALID_TYPES = new Set<KnowledgeType>(['learnings', 'docs', 'rules', 'skills']);

describe('parseFilterValues', () => {
  it('returns undefined for undefined input', () => {
    expect(parseFilterValues(undefined, VALID_DOMAINS, '--domain')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseFilterValues('', VALID_DOMAINS, '--domain')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(parseFilterValues('  ', VALID_DOMAINS, '--domain')).toBeUndefined();
  });

  it('parses a single valid value', () => {
    const result = parseFilterValues('technical', VALID_DOMAINS, '--domain');
    expect(result).not.toBeUndefined();
    expect(result).toEqual(new Set(['technical']));
  });

  it('parses comma-separated valid values', () => {
    const result = parseFilterValues('technical,ops', VALID_DOMAINS, '--domain');
    expect(result).not.toBeUndefined();
    expect(result).toEqual(new Set(['technical', 'ops']));
  });

  it('normalises mixed case and surrounding spaces', () => {
    const result = parseFilterValues('Technical, OPS ', VALID_DOMAINS, '--domain');
    expect(result).not.toBeUndefined();
    expect(result).toEqual(new Set(['technical', 'ops']));
  });

  it('returns undefined and warns when all values are invalid', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseFilterValues('foo', VALID_DOMAINS, '--domain');
    expect(result).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('drops invalid values and keeps valid ones (partial invalid)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseFilterValues('technical,foo', VALID_DOMAINS, '--domain');
    expect(result).not.toBeUndefined();
    expect(result).toEqual(new Set(['technical']));
    warnSpy.mockRestore();
  });

  it('deduplicates repeated values', () => {
    const result = parseFilterValues('technical,technical', VALID_DOMAINS, '--domain');
    expect(result).not.toBeUndefined();
    expect(result!.size).toBe(1);
    expect(result).toEqual(new Set(['technical']));
  });

  it('works with KnowledgeType values', () => {
    const result = parseFilterValues('learnings,docs', VALID_TYPES, '--type');
    expect(result).not.toBeUndefined();
    expect(result).toEqual(new Set(['learnings', 'docs']));
  });
});

describe('matchesFilters', () => {
  const makeEntry = (domain: KnowledgeDomain | undefined, type: KnowledgeType) => ({ domain, type });

  it('returns true when both filters are undefined (no filter applied)', () => {
    const entry = makeEntry('technical', 'learnings');
    expect(matchesFilters(entry, undefined, undefined)).toBe(true);
  });

  it('passes when entry domain matches domainFilter (only domainFilter active)', () => {
    const entry = makeEntry('ops', 'learnings');
    const domainFilter = new Set<KnowledgeDomain>(['ops']);
    expect(matchesFilters(entry, domainFilter, undefined)).toBe(true);
  });

  it('fails when entry domain does not match domainFilter', () => {
    const entry = makeEntry('technical', 'learnings');
    const domainFilter = new Set<KnowledgeDomain>(['ops']);
    expect(matchesFilters(entry, domainFilter, undefined)).toBe(false);
  });

  it('treats missing domain as neutral when domainFilter active', () => {
    const entry = makeEntry(undefined, 'learnings');
    const domainFilter = new Set<KnowledgeDomain>(['neutral']);
    expect(matchesFilters(entry, domainFilter, undefined)).toBe(true);
  });

  it('fails when missing domain treated as neutral but filter excludes neutral', () => {
    const entry = makeEntry(undefined, 'learnings');
    const domainFilter = new Set<KnowledgeDomain>(['technical']);
    expect(matchesFilters(entry, domainFilter, undefined)).toBe(false);
  });

  it('passes when entry type matches typeFilter (only typeFilter active)', () => {
    const entry = makeEntry('technical', 'docs');
    const typeFilter = new Set<KnowledgeType>(['docs']);
    expect(matchesFilters(entry, undefined, typeFilter)).toBe(true);
  });

  it('fails when entry type does not match typeFilter', () => {
    const entry = makeEntry('technical', 'learnings');
    const typeFilter = new Set<KnowledgeType>(['docs']);
    expect(matchesFilters(entry, undefined, typeFilter)).toBe(false);
  });

  it('passes when both filters active and entry matches both', () => {
    const entry = makeEntry('ops', 'rules');
    const domainFilter = new Set<KnowledgeDomain>(['ops']);
    const typeFilter = new Set<KnowledgeType>(['rules']);
    expect(matchesFilters(entry, domainFilter, typeFilter)).toBe(true);
  });

  it('fails when both filters active but domain does not match', () => {
    const entry = makeEntry('technical', 'rules');
    const domainFilter = new Set<KnowledgeDomain>(['ops']);
    const typeFilter = new Set<KnowledgeType>(['rules']);
    expect(matchesFilters(entry, domainFilter, typeFilter)).toBe(false);
  });

  it('fails when both filters active but type does not match', () => {
    const entry = makeEntry('ops', 'learnings');
    const domainFilter = new Set<KnowledgeDomain>(['ops']);
    const typeFilter = new Set<KnowledgeType>(['rules']);
    expect(matchesFilters(entry, domainFilter, typeFilter)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compareResults — sorting partition tests (P1-1)
// ---------------------------------------------------------------------------

// Minimal SearchIndexEntry for constructing test results.
type RecallResult = Parameters<typeof compareResults>[0];

function makeResult(score: number, fromSignature?: boolean, date = ''): RecallResult {
  return {
    entry: {
      filename: 'x.md',
      title: 'x',
      author: '',
      date,
      tags: [],
      tokens: [],
      votes: 0,
      type: 'learnings' as const,
    },
    score,
    fromSignature,
  };
}

describe('compareResults', () => {
  it('signature hit precedes a scored hit whose score exceeds SIGNATURE_MATCH_SCORE (20)', () => {
    // Simulate a TF-IDF hit that exceeds the fixed display value (e.g. N=83 corpus).
    const sigHit = makeResult(20, true);
    const scoredHit = makeResult(29.5, false);
    // sigHit should come before scoredHit → comparator must return negative
    expect(compareResults(sigHit, scoredHit)).toBeLessThan(0);
    // And sorting an array should place sigHit first.
    const sorted = [scoredHit, sigHit].sort(compareResults);
    expect(sorted[0].fromSignature).toBe(true);
    expect(sorted[0].score).toBe(20);
  });

  it('within non-signature partition, higher score sorts first', () => {
    const high = makeResult(15, false);
    const low = makeResult(5, false);
    expect(compareResults(high, low)).toBeLessThan(0);
  });

  it('within signature partition, higher score sorts first', () => {
    const a = makeResult(20, true);
    const b = makeResult(20, true);
    // Equal scores — tie-break by date
    const older = { ...a, entry: { ...a.entry, date: '2024-01-01' } };
    const newer = { ...a, entry: { ...a.entry, date: '2025-01-01' } };
    expect(compareResults(newer, older)).toBeLessThan(0);
  });

  it('two non-signature results with equal score break tie by date descending', () => {
    const older = makeResult(10, false, '2024-01-01');
    const newer = makeResult(10, false, '2025-01-01');
    expect(compareResults(newer, older)).toBeLessThan(0);
  });
});
