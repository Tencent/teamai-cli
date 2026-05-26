import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isWikiEnabled } from '../types.js';

describe('isWikiEnabled (env var approach)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns true by default', () => {
    delete process.env.TEAMAI_WIKI_DISABLED;
    delete process.env.TEAMAI_WIKI_ENABLED;
    expect(isWikiEnabled()).toBe(true);
  });

  it('returns false when TEAMAI_WIKI_DISABLED=1', () => {
    process.env.TEAMAI_WIKI_DISABLED = '1';
    expect(isWikiEnabled()).toBe(false);
  });

  it('returns false when TEAMAI_WIKI_DISABLED=true', () => {
    process.env.TEAMAI_WIKI_DISABLED = 'true';
    expect(isWikiEnabled()).toBe(false);
  });

  it('returns false when TEAMAI_WIKI_ENABLED=false', () => {
    process.env.TEAMAI_WIKI_ENABLED = 'false';
    expect(isWikiEnabled()).toBe(false);
  });

  it('returns false when TEAMAI_WIKI_ENABLED=0', () => {
    process.env.TEAMAI_WIKI_ENABLED = '0';
    expect(isWikiEnabled()).toBe(false);
  });

  it('returns true when TEAMAI_WIKI_DISABLED is not 1 or true', () => {
    process.env.TEAMAI_WIKI_DISABLED = '0';
    expect(isWikiEnabled()).toBe(true);
  });

  it('returns true when TEAMAI_WIKI_ENABLED=1', () => {
    process.env.TEAMAI_WIKI_ENABLED = '1';
    expect(isWikiEnabled()).toBe(true);
  });
});
