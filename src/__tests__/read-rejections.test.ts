import { describe, it, expect } from 'vitest';
import { extractMarkerId, shouldWrite } from '../ci/read-rejections.js';
import type { RejectionResult } from '../ci/read-rejections.js';

describe('extractMarkerId', () => {
  it('提取 learning marker', () => {
    expect(extractMarkerId('<!-- teamai:ci-extract:learning -->\nsome content')).toBe('learning');
  });

  it('提取 suggestion marker', () => {
    expect(extractMarkerId('<!-- teamai:ci-extract:suggestion:1 -->\ncontent')).toBe('suggestion:1');
  });

  it('提取 suggestion:2 marker', () => {
    expect(extractMarkerId('<!-- teamai:ci-extract:suggestion:2 -->')).toBe('suggestion:2');
  });

  it('无 marker 返回 null', () => {
    expect(extractMarkerId('普通 comment 内容')).toBeNull();
  });

  it('其他 teamai marker 不匹配', () => {
    expect(extractMarkerId('<!-- teamai:ci-extract -->')).toBeNull();
  });
});

describe('shouldWrite', () => {
  const rejections: RejectionResult = {
    rejectedIds: new Set(['suggestion:2']),
    approvedIds: new Set(['learning', 'suggestion:1']),
    allIds: new Set(['learning', 'suggestion:1', 'suggestion:2']),
  };

  describe('GitHub (默认写入，👎 = reject)', () => {
    it('不在 rejectedIds 中 → 写入', () => {
      expect(shouldWrite('learning', rejections, 'github')).toBe(true);
      expect(shouldWrite('suggestion:1', rejections, 'github')).toBe(true);
    });

    it('在 rejectedIds 中 → 不写入', () => {
      expect(shouldWrite('suggestion:2', rejections, 'github')).toBe(false);
    });

    it('未知 id（不在任何集合中）→ 写入（默认）', () => {
      expect(shouldWrite('suggestion:99', rejections, 'github')).toBe(true);
    });
  });

  describe('TGit (默认写入，🚫 emoji = reject)', () => {
    it('不在 rejectedIds 中 → 写入', () => {
      expect(shouldWrite('learning', rejections, 'tgit')).toBe(true);
      expect(shouldWrite('suggestion:1', rejections, 'tgit')).toBe(true);
    });

    it('在 rejectedIds 中 → 不写入', () => {
      expect(shouldWrite('suggestion:2', rejections, 'tgit')).toBe(false);
    });

    it('未知 id（不在任何集合中）→ 写入（默认）', () => {
      expect(shouldWrite('suggestion:99', rejections, 'tgit')).toBe(true);
    });
  });
});
