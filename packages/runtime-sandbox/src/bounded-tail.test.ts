import { describe, expect, it } from 'vitest';
import { boundedEnds, boundedTail } from './bounded-tail.js';

// The tail of a stream a provider keeps while it streams the whole of it (cases from sandcastle's
// tests/noSandboxOutputTail.test.ts, on chunks as a pipe delivers them).

function tailOf(chunks: string[], max?: number): string {
  const tail = boundedTail(max);

  for (const chunk of chunks) tail.push(chunk);

  return tail.text();
}

describe('boundedTail', () => {
  it('is empty when nothing was pushed', () => {
    expect(tailOf([])).toBe('');
  });

  it('keeps every chunk, joined with no separator, while under its budget', () => {
    expect(tailOf(['ab', 'cd', 'ef\n'], 100)).toBe('abcdef\n');
  });

  it('drops the oldest chunks once the output passes its budget', () => {
    expect(tailOf(['aaaa\n', 'bbbb\n', 'cccc\n'], 10)).toBe('bbbb\ncccc\n');
  });

  it('stays within its budget over many chunks, keeping the newest', () => {
    const text = tailOf(Array.from({ length: 10_000 }, (_, index) => `line-${index}\n`), 50);

    expect(text.length).toBeLessThanOrEqual(50);
    expect(text).toMatch(/line-9999\n$/);
  });

  it('keeps only the end of one chunk longer than its budget', () => {
    expect(tailOf(['0123456789ABCDEF'], 10)).toBe('6789ABCDEF');
  });

  it('keeps only the end of an oversized chunk that follows others', () => {
    expect(tailOf(['hello\n', 'X'.repeat(100)], 10)).toBe('X'.repeat(10));
  });

  it('never starts with half a character', () => {
    // Each 😀 is two UTF-16 units; a cut at an odd count would keep the second half alone.
    const text = tailOf(['😀'.repeat(10)], 5);

    expect(text).toBe('😀😀');
    expect(text.codePointAt(0)).toBe(0x1f600);
  });

  it('keeps its whole budget, cutting the oldest chunk it still holds part of', () => {
    expect(tailOf(['aaaaaaaa', 'bbbb'], 10)).toBe('aaaaaabbbb');
  });

  it('keeps the last 64 Ki characters by default', () => {
    expect(tailOf(['y'.repeat(100_000)])).toHaveLength(64 * 1024);
  });
});

describe('the start and the end of a stream', () => {
  const endsOf = (chunks: string[]): string => {
    const ends = boundedEnds({ head: 4, tail: 3 });

    for (const chunk of chunks) ends.push(chunk);

    return ends.text();
  };

  it('keeps a stream no longer than both whole, however its chunks fall', () => {
    expect(endsOf(['ab', 'cdef', 'g'])).toBe('abcdefg');
  });

  it('keeps the start and the end of a longer one, a newline where the middle was', () => {
    expect(endsOf(['abc', 'defgh', 'ijk', 'lm'])).toBe('abcd\nklm');
  });
});
