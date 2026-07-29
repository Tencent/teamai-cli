import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import { parseLearningDraft } from '../import-mr.js';

describe('parseLearningDraft', () => {
  it('parses well-formed frontmatter', () => {
    const raw = '---\ntitle: "Hello"\ntags: [a, b]\n---\n\n# Body\n';
    const { data, content } = parseLearningDraft(raw);
    expect(data['title']).toBe('Hello');
    expect(data['tags']).toEqual(['a', 'b']);
    expect(content).toContain('# Body');
  });

  it('does not throw on markdown that breaks YAML alias parsing (regression: CI exit 1)', () => {
    // A line starting with '*' is a YAML alias reference and makes js-yaml throw.
    const raw = '---\n\n*说明:本次 MR 是 8 个 GitHub PR 的 squash 同步*\n---\n';
    expect(() => parseLearningDraft(raw)).not.toThrow();
    const { data } = parseLearningDraft(raw);
    expect(data).toEqual({});
  });

  it('strips a wrapping markdown code fence', () => {
    const raw = '```markdown\n---\ntitle: "X"\n---\n\nbody\n```';
    const { data } = parseLearningDraft(raw);
    expect(data['title']).toBe('X');
  });

  it('drops conversational text before the frontmatter', () => {
    const raw = 'Sure, here is the learning:\n\n---\ntitle: "Y"\n---\n\nbody';
    const { data } = parseLearningDraft(raw);
    expect(data['title']).toBe('Y');
  });
});
