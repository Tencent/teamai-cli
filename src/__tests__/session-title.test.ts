import { describe, expect, it } from 'vitest';
import { cleanTitleText, fallbackTitle, isInjectedText } from '../session-flow/title.js';

describe('session title cleaning', () => {
  it('detects platform-injected message heads', () => {
    expect(isInjectedText('<system-reminder data-role="command-caveat">Caveat: ...')).toBe(true);
    expect(isInjectedText('<memories>long injected context</memories>')).toBe(true);
    expect(isInjectedText('<command-name>/teamai</command-name>')).toBe(true);
    expect(isInjectedText('怎么把会话迁移到 claude？')).toBe(false);
  });

  it('strips injected wrapper tags and keeps human text', () => {
    expect(cleanTitleText('<system-reminder>x</system-reminder> 怎么迁移会话')).toBe('怎么迁移会话');
  });

  it('truncates long titles', () => {
    expect(cleanTitleText('a'.repeat(200))).toHaveLength(60);
  });

  it('returns empty for text that cannot be fully stripped', () => {
    // 半截标签剥不干净（残留尖括号），宁可返回空让调用方退回 Session <id>
    expect(cleanTitleText('text <b unclosed')).toBe('');
    expect(cleanTitleText('')).toBe('');
  });

  it('flags an unterminated injected head even though tag-stripping would leave plain text', () => {
    // 整条是不是注入由 isInjectedText 先判断；cleanTitleText 只负责剥标签
    expect(isInjectedText('<system-reminder>unterminated caveat')).toBe(true);
  });

  it('falls back to a short id-based title', () => {
    expect(fallbackTitle('1fc6ec8d-3b68-4a03-8a82-950a736eee72')).toBe('Session 1fc6ec8d');
  });
});
