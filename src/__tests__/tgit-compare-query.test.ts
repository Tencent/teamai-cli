import { describe, expect, it } from 'vitest';

import { tgitCompareQuery } from '../ci/mr-comment.js';

/**
 * Git allows branch names with URL-significant characters. The TGit compare
 * endpoint must receive them encoded, otherwise `from`/`to` are truncated by
 * `&` (extra param), `#` (fragment) or misread `+`/`%`.
 */
describe('tgitCompareQuery', () => {
  it('encodes a plain branch pair', () => {
    expect(tgitCompareQuery('main', 'feature/x')).toBe('from=main&to=feature%2Fx');
  });

  it('keeps an ampersand inside the branch value, not as a separator', () => {
    const query = tgitCompareQuery('main', 'feature/cache&db');
    const params = new URLSearchParams(query);

    expect(params.get('from')).toBe('main');
    expect(params.get('to')).toBe('feature/cache&db');
  });

  it('keeps a hash inside the branch value', () => {
    const query = tgitCompareQuery('release#1', 'bug#123');
    const params = new URLSearchParams(query);

    expect(params.get('from')).toBe('release#1');
    expect(params.get('to')).toBe('bug#123');
  });

  it('round-trips plus and percent signs', () => {
    const query = tgitCompareQuery('main', 'feature/100%+done');

    expect(new URLSearchParams(query).get('to')).toBe('feature/100%+done');
  });
});
