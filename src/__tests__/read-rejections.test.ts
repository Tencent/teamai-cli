import { afterEach, describe, it, expect, vi } from 'vitest';
import { extractMarkerId, readRejections, shouldWrite } from '../ci/read-rejections.js';
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

describe('readRejections API failures', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('fails when the GitHub comment list cannot be read', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(readRejections('https://github.com/acme/app/pull/7'))
      .rejects.toThrow('GitHub comments request failed (500)');
  });

  it('fails when GitHub reactions cannot be read', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 42, body: '<!-- teamai:ci-extract:learning -->' },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 })));

    await expect(readRejections('https://github.com/acme/app/pull/7'))
      .rejects.toThrow('GitHub reactions request failed for comment 42 (403)');
  });

  it('fails when the TGit note list cannot be read', async () => {
    vi.stubEnv('TGIT_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 42, iid: 7 }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 })));

    await expect(readRejections('https://git.woa.com/acme/app/merge_requests/7'))
      .rejects.toThrow('TGit notes request failed (500)');
  });
});

describe('GitLab (默认写入，👎 thumbsdown = reject)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const notes = JSON.stringify([
    { id: 1, body: '<!-- teamai:ci-extract:learning -->\ncontent' },
    { id: 2, body: '<!-- teamai:ci-extract:suggestion:1 -->\ncontent' },
  ]);
  const notesUrl = 'https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/7/notes?per_page=100';
  const emojiUrl = (noteId: number) =>
    `https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/7/notes/${noteId}/award_emoji?per_page=100`;

  it('thumbsdown award 标记为 reject，无 emoji 默认 approve', async () => {
    vi.stubEnv('GITLAB_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === notesUrl) return new Response(notes, { status: 200 });
      if (url === emojiUrl(1)) return new Response(JSON.stringify([{ name: 'thumbsdown' }]), { status: 200 });
      if (url === emojiUrl(2)) return new Response(JSON.stringify([{ name: 'thumbsup' }]), { status: 200 });
      throw new Error(`unexpected ${url}`);
    }));

    const result = await readRejections('https://gitlab.com/acme/app/-/merge_requests/7');
    expect(result.rejectedIds).toEqual(new Set(['learning']));
    expect(result.approvedIds).toEqual(new Set(['suggestion:1']));
    expect(shouldWrite('learning', result, 'gitlab')).toBe(false);
    expect(shouldWrite('suggestion:1', result, 'gitlab')).toBe(true);
  });

  it('fails when the GitLab note list cannot be read', async () => {
    vi.stubEnv('GITLAB_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(readRejections('https://gitlab.com/acme/app/-/merge_requests/7'))
      .rejects.toThrow('GitLab notes request failed (500)');
  });
});
