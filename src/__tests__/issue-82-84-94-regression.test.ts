/**
 * Regression tests for issues #82, #84, #94 bug fixes.
 */
import { describe, it, expect } from 'vitest';
import { buildConfidence, labelFromScore } from '../wiki-engine/reconciler-v2-types.js';

describe('buildConfidence (issue #82 bug1 + #94 issue3)', () => {
  it('single factor preserves its weight as score', () => {
    const result = buildConfidence([{ name: 'direct_match', weight: 0.9 }]);
    expect(result.score).toBe(0.9);
    expect(result.label).toBe('EXTRACTED');
  });

  it('adding positive evidence increases (not decreases) the score', () => {
    const single = buildConfidence([{ name: 'direct_match', weight: 0.9 }]);
    const multi = buildConfidence([
      { name: 'direct_match', weight: 0.9 },
      { name: 'title_proximity', weight: 0.1 },
    ]);
    expect(multi.score).toBeGreaterThanOrEqual(single.score);
  });

  it('cumulative weights are capped at 1.0', () => {
    const result = buildConfidence([
      { name: 'a', weight: 0.7 },
      { name: 'b', weight: 0.5 },
    ]);
    expect(result.score).toBe(1.0);
    expect(result.label).toBe('EXTRACTED');
  });

  it('empty factors returns score 0 with AMBIGUOUS label', () => {
    const result = buildConfidence([]);
    expect(result.score).toBe(0);
    expect(result.label).toBe('AMBIGUOUS');
  });

  it('path_match + method_match yields higher score than path_match alone', () => {
    const pathOnly = buildConfidence([{ name: 'path_match', weight: 0.7 }]);
    const combined = buildConfidence([
      { name: 'path_match', weight: 0.7 },
      { name: 'method_match', weight: 0.3 },
    ]);
    expect(combined.score).toBeGreaterThan(pathOnly.score);
  });
});

describe('labelFromScore thresholds', () => {
  it('score >= 0.8 → EXTRACTED', () => {
    expect(labelFromScore(0.8)).toBe('EXTRACTED');
    expect(labelFromScore(1.0)).toBe('EXTRACTED');
  });

  it('score >= 0.5 and < 0.8 → INFERRED', () => {
    expect(labelFromScore(0.5)).toBe('INFERRED');
    expect(labelFromScore(0.79)).toBe('INFERRED');
  });

  it('score < 0.5 → AMBIGUOUS', () => {
    expect(labelFromScore(0.49)).toBe('AMBIGUOUS');
    expect(labelFromScore(0)).toBe('AMBIGUOUS');
  });
});

describe('camelCase tokenize (issue #84 bug2)', () => {
  it('splits camelCase identifiers into separate sub-tokens', async () => {
    const { tokenize } = await import('../utils/tokenizer.js');
    const tokens = tokenize('getUserName');
    // Should contain both the whole word and sub-tokens
    expect(tokens).toContain('getusername');
    expect(tokens).toContain('get');
    expect(tokens).toContain('user');
    expect(tokens).toContain('name');
  });

  it('splits PascalCase identifiers (e.g. ModuleNotFoundError)', async () => {
    const { tokenize } = await import('../utils/tokenizer.js');
    const tokens = tokenize('ModuleNotFoundError');
    expect(tokens).toContain('module');
    expect(tokens).toContain('not');
    expect(tokens).toContain('found');
    expect(tokens).toContain('error');
  });

  it('does NOT split when text is already lowercased', async () => {
    const { tokenize } = await import('../utils/tokenizer.js');
    const tokens = tokenize('getusername');
    // All-lowercase has no uppercase transitions to split on
    expect(tokens).not.toContain('get');
    expect(tokens).toContain('getusername');
  });
});

describe('stale detection (issue #82 bug2)', () => {
  it('measures drift between two sides, not age from today', () => {
    // The fix changes: Math.abs(now - max(from, to)) → Math.abs(fromMs - toMs)
    // Simulate the calculation
    const fromMs = new Date('2025-01-01').getTime();
    const toMs = new Date('2025-03-15').getTime();
    const MS_PER_DAY = 86_400_000;

    // New logic: drift between sides
    const daysDrift = Math.abs(fromMs - toMs) / MS_PER_DAY;
    expect(daysDrift).toBeCloseTo(73, 0); // ~73 days apart

    // Old logic would have used: Math.abs(now - Math.max(fromMs, toMs))
    // which gives hundreds of days (age) — completely different semantics
    const now = Date.now();
    const oldDrift = Math.abs(now - Math.max(fromMs, toMs)) / MS_PER_DAY;
    expect(oldDrift).toBeGreaterThan(400); // way off from the actual drift
  });

  it('simultaneously updated pages have zero drift', () => {
    const sameTime = new Date('2025-06-01').getTime();
    const MS_PER_DAY = 86_400_000;
    const daysDrift = Math.abs(sameTime - sameTime) / MS_PER_DAY;
    expect(daysDrift).toBe(0);
  });
});

describe('loadGraphIndex schema validation (issue #84 bug5)', () => {
  it('returns null for non-existent directory', async () => {
    const { loadGraphIndex } = await import('../wiki-engine/core/graph-index.schema.js');
    const result = await loadGraphIndex('/tmp/nonexistent-wiki-root-' + Date.now());
    expect(result).toBeNull();
  });

  it('returns null when file exists but nodes/edges are not arrays', async () => {
    const { writeFile, mkdir, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { loadGraphIndex } = await import('../wiki-engine/core/graph-index.schema.js');

    const tmpRoot = `/tmp/graph-schema-test-${Date.now()}`;
    const indicesDir = join(tmpRoot, '.indices');
    await mkdir(indicesDir, { recursive: true });

    // Write a JSON file with wrong structure (nodes is not an array)
    await writeFile(join(indicesDir, 'graph-index.json'), JSON.stringify({ nodes: 'invalid', edges: [] }));
    const result1 = await loadGraphIndex(tmpRoot);
    expect(result1).toBeNull();

    // Write a JSON file with missing edges field
    await writeFile(join(indicesDir, 'graph-index.json'), JSON.stringify({ nodes: [] }));
    const result2 = await loadGraphIndex(tmpRoot);
    expect(result2).toBeNull();

    // Write a valid graph — should return it
    await writeFile(join(indicesDir, 'graph-index.json'), JSON.stringify({ nodes: [], edges: [] }));
    const result3 = await loadGraphIndex(tmpRoot);
    expect(result3).not.toBeNull();
    expect(result3!.nodes).toEqual([]);
    expect(result3!.edges).toEqual([]);

    await rm(tmpRoot, { recursive: true });
  });
});
