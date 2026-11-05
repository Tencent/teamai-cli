/**
 * `teamai import --from-mr` reads the MR's review threads (#1187): the prompt
 * gets them in a section of their own, with the MR author and reviewers
 * marked, replied threads first, and a long thread shortened rather than the
 * section cut off. teamai's own comments are left out.
 */
import { describe, expect, it } from 'vitest';

import { formatMrThreads } from '../import-mr.js';
import { formatComment } from '../ci/mr-comment.js';
import { pruneThreads } from '../providers/mr-threads.js';
import type { MRThread } from '../types.js';

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

  it('drops the comment ci extract-mr posted under a custom --comment-marker, which it signs as every comment', () => {
    const threads = pruneThreads([
      { notes: [{ author: 'ci', body: formatComment({ title: 'Retry uploads', content: 'Retry on 5xx.' }, undefined, '<!-- learning-bot -->') }] },
      remark,
    ]);
    expect(threads).toEqual([remark]);
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
