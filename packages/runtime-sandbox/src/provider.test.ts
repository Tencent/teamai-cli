import { describe, expect, it } from 'vitest';
import { handleOf, journalOfSandboxName, journalSandboxName, placeKeyOfHandle, placeOfJournalSandbox } from './provider.js';

describe('placeKeyOfHandle', () => {
  it.each([
    { run: 'r0123abcd', attempt: 'a0123abcd' },
    { run: 'r0123abcd4567ef89', attempt: 'affffffff' },
  ])('finds the place of the handle teamai made for run $run, attempt $attempt', (key) => {
    expect(placeKeyOfHandle(handleOf(key))).toEqual(key);
  });

  it.each([
    'my-sandbox',
    'teamai-r0123abcd',
    'teamai-r0123abcd-a0123abcd-proxy',
    'teamai-r0123abcd-a0123abcd-net',
    'teamai-0123456789abcdef-r0123abcd-a0123abcd',
    'other-r0123abcd-a0123abcd',
    'teamai-r0123ABCD-a0123abcd',
    'teamai-r0123abc-a0123abcd',
  ])('finds no place in %s, a name handleOf did not make', (name) => {
    expect(placeKeyOfHandle(name)).toBeUndefined();
  });
});

describe('a sandbox name with its journal, as sbx and Vercel give', () => {
  const key = { run: 'r0123abcd', attempt: 'a0123abcd' };

  it("gives the journal of an attempt's sandbox and of a warm template's scratch one, and the place of the first only", () => {
    expect(journalSandboxName('0123456789abcdef', key)).toBe('teamai-0123456789abcdef-r0123abcd-a0123abcd');
    expect(placeOfJournalSandbox('teamai-0123456789abcdef-r0123abcd-a0123abcd')).toEqual({ owner: '0123456789abcdef', key });
    expect(journalOfSandboxName('teamai-0123456789abcdef-warm-42-c0ffee')).toBe('0123456789abcdef');
    expect(placeOfJournalSandbox('teamai-0123456789abcdef-warm-42-c0ffee')).toBeUndefined();
  });

  it.each(['my-sandbox', 'teamai-r0123abcd-a0123abcd', 'teamai-0123456789ABCDEF-r0123abcd-a0123abcd', 'teamai-0123456789abcdef-r0123abcd-a0123abcd-x'])('names no attempt in %s', (name) => {
    expect(placeOfJournalSandbox(name)).toBeUndefined();
  });
});
