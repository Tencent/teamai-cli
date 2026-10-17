/**
 * `teamai import --from-mr` reads the MR's review threads (#1187): the prompt
 * gets them in a section of their own, with the MR author and reviewers
 * marked, replied threads first, a long thread shortened rather than the
 * section cut off, and the model told that a resolved thread's decision
 * outweighs the diff. With `language: en` the learning is written in English.
 */
import { describe, expect, it } from 'vitest';

import { extractMRLearningPrompt, formatMrThreads } from '../import-mr.js';
import { pruneThreads } from '../providers/mr-threads.js';
import type { MRData, MRThread } from '../types.js';

const mr: MRData = {
  title: 'Retry uploads',
  description: 'Retries S3 uploads.',
  author: 'alice',
  commits: [{ hash: 'abc12345', message: 'retry upload' }],
  diff: 'diff --git a/up.ts b/up.ts\n+retry(3)\n',
  url: 'https://gitlab.example.com/g/r/-/merge_requests/7',
};

const replied: MRThread = {
  file: 'src/up.ts',
  line: 42,
  resolved: true,
  notes: [
    { author: 'bob', body: 'Three retries hide a dead bucket. Fail fast on 403.' },
    { author: 'alice', body: 'Agreed, 403 now raises at once; retries only on 5xx.' },
  ],
};
const remark: MRThread = { notes: [{ author: 'carol', body: 'LGTM' }] };

describe('pruneThreads', () => {
  it('drops teamai CI comments and blank notes, and a thread left empty', () => {
    const threads = pruneThreads([
      { notes: [{ author: 'ci', body: '<!-- teamai:ci-extract -->\n## TeamAI 知识提炼' }] },
      { notes: [{ author: 'ci', body: '<!-- teamai:ci-extract:codebase-graph -->' }, { author: 'bob', body: '  ' }] },
      remark,
    ]);
    expect(threads).toEqual([remark]);
  });

  it('drops comments posted with a custom --comment-marker as well', () => {
    const threads = pruneThreads([
      { notes: [{ author: 'ci', body: '<!-- learning-bot -->\n## TeamAI 知识提炼' }] },
      { notes: [{ author: 'ci', body: '<!-- teamai:ci-extract -->' }] },
      remark,
    ], '<!-- learning-bot -->');
    expect(threads).toEqual([remark]);
    // Without the marker the custom comment is an ordinary note.
    expect(pruneThreads([{ notes: [{ author: 'ci', body: '<!-- learning-bot -->' }] }])).toHaveLength(1);
  });
});

describe('formatMrThreads', () => {
  it('puts replied threads before single remarks and marks the MR author', () => {
    const text = formatMrThreads([remark, replied], 'alice');
    expect(text.indexOf('src/up.ts:42')).toBeLessThan(text.indexOf('LGTM'));
    expect(text).toContain('src/up.ts:42 (resolved)');
    expect(text).toContain('[reviewer bob] Three retries hide a dead bucket.');
    expect(text).toContain('[author alice] Agreed, 403 now raises at once;');
    expect(text).toContain('[reviewer carol] LGTM');
  });

  it('labels an unresolved thread and one without a resolution state', () => {
    const text = formatMrThreads([{ ...replied, resolved: false }, { ...replied, resolved: undefined, file: undefined }], 'alice');
    expect(text).toContain('src/up.ts:42 (unresolved)');
    expect(text).toMatch(/^### Thread 2\n/m);
  });

  it('shortens a long thread to its first and last notes instead of cutting the section', () => {
    const long: MRThread = {
      notes: Array.from({ length: 12 }, (_, i) => ({ author: i % 2 ? 'alice' : 'bob', body: `note ${i} ${'x'.repeat(300)}` })),
    };
    const text = formatMrThreads([long], 'alice', 6000);
    expect(text).toContain('note 0');
    expect(text).toContain('note 11');
    expect(text).not.toContain('note 5');
    expect(text).toContain('(10 notes omitted)');
    expect(text.length).toBeLessThan(2000);
  });

  it('stops at the budget and says how many threads it left out', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...replied, line: i }));
    const text = formatMrThreads(many, 'alice', 500);
    expect(text).toContain('### Thread 1');
    expect(text).not.toContain('### Thread 8');
    expect(text).toMatch(/\d+ more threads? omitted/);
    expect(text.length).toBeLessThanOrEqual(600);
  });
});

describe('extractMRLearningPrompt', () => {
  it('has no thread section when the MR has no threads', () => {
    const prompt = extractMRLearningPrompt({ ...mr, discussions: [] });
    expect(prompt).not.toContain('Review threads');
    expect(prompt).toContain('用中文撰写');
  });

  it('adds the threads with the instruction that a resolved decision outweighs the diff', () => {
    const prompt = extractMRLearningPrompt({ ...mr, discussions: [remark, replied] });
    expect(prompt).toContain('Review threads');
    expect(prompt).toContain('[author alice]');
    expect(prompt).toMatch(/resolved 的 thread 里的决定比复述 diff 更重要/);
    // The threads do not push the diff out.
    expect(prompt).toContain('+retry(3)');
    expect(extractMRLearningPrompt({ ...mr, discussions: [replied] }, 'en'))
      .toMatch(/decision reached in a resolved thread outweighs a restatement of the diff/);
  });

  it('writes the learning in English when the team language is en, with English headings', () => {
    const prompt = extractMRLearningPrompt({ ...mr, discussions: [replied] }, 'en');
    expect(prompt).toContain('Write in English');
    expect(prompt).toContain('## Background');
    expect(prompt).not.toContain('用中文撰写');
    expect(prompt).toContain(`source_mr: "${mr.url}"`);
  });

  it('keeps the Chinese prompt for zh and when the language is not set', () => {
    for (const language of ['zh', undefined] as const) {
      const prompt = extractMRLearningPrompt(mr, language);
      expect(prompt).toContain('用中文撰写');
      expect(prompt).toContain('## 背景');
    }
  });
});
