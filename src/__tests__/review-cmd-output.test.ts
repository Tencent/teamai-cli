import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Stub chalk so the test sees raw text, not ANSI codes.
vi.mock('chalk', () => ({
  default: {
    yellow: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
  },
}));

import { reviewCmd } from '../review-cmd.js';

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

let tmpDir: string;
let consoleSpy: MockInstance<typeof console.log>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-review-'));
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedReviewItem(item: Record<string, unknown>): void {
  const reviewPath = path.join(tmpDir, '.teamai', 'pending-review.jsonl');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.appendFileSync(reviewPath, JSON.stringify(item) + '\n');
}

describe('review-cmd English output (#836)', () => {
  it('reject prints English, not Chinese', async () => {
    seedReviewItem({
      id: 'test-item',
      ts: new Date().toISOString(),
      kind: 'codebase-section',
      source: 'test',
      target: { file: 'x.md', section: 'a' },
      payload: { content: 'body' },
      risk: 'low',
    });

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await reviewCmd({ idArg: 'test-item', reject: true });
    } finally {
      process.chdir(origCwd);
    }

    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('rejected');
    expect(output).not.toMatch(CJK);
  });

  it('apply-failure reason is English when target.section is missing', async () => {
    seedReviewItem({
      id: 'no-section',
      ts: new Date().toISOString(),
      kind: 'codebase-section',
      source: 'test',
      target: { file: 'x.md' },
      payload: { content: 'body' },
      risk: 'low',
    });

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      expect(await reviewCmd({ idArg: 'no-section', apply: true })).toBe(1);
    } finally {
      process.chdir(origCwd);
    }

    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('apply failed');
    expect(output).toContain('target.section is missing');
    expect(output).not.toMatch(CJK);
  });

  it('returns exit status 1 when single or batch approvals fail and undefined when empty or skipped-only (#2082)', async () => {
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      // Empty batch still succeeds.
      expect(await reviewCmd({ allApply: true })).toBeUndefined();
      expect(await reviewCmd({ allApply: true, json: true })).toBeUndefined();

      // Missing ID in --apply text and JSON modes returns 1; read-only show stays undefined.
      expect(await reviewCmd({ idArg: 'missing', apply: true })).toBe(1);
      expect(await reviewCmd({ idArg: 'missing', apply: true, json: true })).toBe(1);
      expect(await reviewCmd({ idArg: 'missing' })).toBeUndefined();

      // Skipped-only batch (risk above maxRisk) still succeeds.
      seedReviewItem({
        id: 'high-risk-item',
        ts: new Date().toISOString(),
        kind: 'codebase-section',
        source: 'test',
        target: { file: 'missing.md', section: 'glossary' },
        payload: { content: 'body' },
        risk: 'high',
      });
      expect(await reviewCmd({ allApply: true, maxRisk: 'medium' })).toBeUndefined();
      expect(await reviewCmd({ allApply: true, maxRisk: 'medium', json: true })).toBeUndefined();

      // Failing single and batch apply in text and JSON modes return 1.
      expect(await reviewCmd({ idArg: 'high-risk-item', apply: true })).toBe(1);
      expect(await reviewCmd({ idArg: 'high-risk-item', apply: true, json: true })).toBe(1);
      expect(await reviewCmd({ allApply: true, maxRisk: 'high' })).toBe(1);
      expect(await reviewCmd({ allApply: true, maxRisk: 'high', json: true })).toBe(1);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('apply-failure reason is English when payload.content is empty', async () => {
    const targetFile = path.join(tmpDir, 'target.md');
    fs.writeFileSync(targetFile, '## Section\nBody\n');
    seedReviewItem({
      id: 'empty-payload',
      ts: new Date().toISOString(),
      kind: 'codebase-section',
      source: 'test',
      target: { file: targetFile, section: 's' },
      payload: {},
      risk: 'low',
    });

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await reviewCmd({ idArg: 'empty-payload', apply: true });
    } finally {
      process.chdir(origCwd);
    }

    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('apply failed');
    expect(output).toContain('payload.content is empty');
    expect(output).not.toMatch(CJK);
  });
});
