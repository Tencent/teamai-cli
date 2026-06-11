import { describe, it, expect } from 'vitest';
import { sanitizeGitUrl } from '../clone.js';

describe('sanitizeGitUrl', () => {
  it('masks token in https URL', () => {
    const url = 'https://x-access-token:ghp_secret123@github.com/org/repo.git';
    expect(sanitizeGitUrl(url)).toBe('https://***@github.com/org/repo.git');
  });

  it('masks basic auth credentials in https URL', () => {
    const url = 'https://user:password@example.com/repo.git';
    expect(sanitizeGitUrl(url)).toBe('https://***@example.com/repo.git');
  });

  it('leaves clean https URL unchanged', () => {
    const url = 'https://github.com/org/repo.git';
    expect(sanitizeGitUrl(url)).toBe(url);
  });

  it('leaves SSH URL unchanged', () => {
    const url = 'git@github.com:org/repo.git';
    expect(sanitizeGitUrl(url)).toBe(url);
  });

  it('masks token embedded in an error message string', () => {
    const msg = 'git clone failed: https://x-access-token:abc123@github.com/repo error';
    expect(sanitizeGitUrl(msg)).toBe('git clone failed: https://***@github.com/repo error');
  });

  it('masks multiple occurrences', () => {
    const msg = 'https://tok1@a.com and https://tok2@b.com';
    expect(sanitizeGitUrl(msg)).toBe('https://***@a.com and https://***@b.com');
  });
});
