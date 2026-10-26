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
  const notesUrl = 'https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/7/notes?per_page=100&page=1';
  const emojiUrl = (noteId: number) =>
    `https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/7/notes/${noteId}/award_emoji?per_page=100&page=1`;

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

  it('reads marker notes beyond the first page (newest-first paging)', async () => {
    vi.stubEnv('GITLAB_TOKEN', 'test-token');
    // The learning note is the oldest of many: it lands on page 2, not page 1.
    const page1 = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, body: `chat ${i}` })),
    );
    const page2 = JSON.stringify([{ id: 1, body: '<!-- teamai:ci-extract:learning -->\ncontent' }]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/7/notes?per_page=100&page=1') {
        return new Response(page1, { status: 200, headers: { 'x-next-page': '2' } });
      }
      if (url === 'https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/7/notes?per_page=100&page=2') {
        return new Response(page2, { status: 200 });
      }
      if (url === emojiUrl(1)) return new Response(JSON.stringify([{ name: 'thumbsdown' }]), { status: 200 });
      throw new Error(`unexpected ${url}`);
    }));

    const result = await readRejections('https://gitlab.com/acme/app/-/merge_requests/7');
    expect(result.rejectedIds).toEqual(new Set(['learning']));
    expect(shouldWrite('learning', result, 'gitlab')).toBe(false);
  });

  it('honours a thumbsdown that is beyond the first page of awards', async () => {
    vi.stubEnv('GITLAB_TOKEN', 'test-token');
    const note = JSON.stringify([{ id: 1, body: '<!-- teamai:ci-extract:learning -->\ncontent' }]);
    const awardPage1 = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ name: `emoji_${i}` })));
    const awardPage2 = JSON.stringify([{ name: 'thumbsdown' }]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/notes?')) return new Response(note, { status: 200 });
      if (url.includes('/award_emoji?per_page=100&page=1')) {
        return new Response(awardPage1, { status: 200, headers: { 'x-next-page': '2' } });
      }
      if (url.includes('/award_emoji?per_page=100&page=2')) {
        return new Response(awardPage2, { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }));

    const result = await readRejections('https://gitlab.com/acme/app/-/merge_requests/7');
    expect(result.rejectedIds).toEqual(new Set(['learning']));
    expect(shouldWrite('learning', result, 'gitlab')).toBe(false);
  });

  it('never follows redirects when reading GitLab notes (token must not leak)', async () => {
    vi.stubEnv('GITLAB_TOKEN', 'test-token');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(readRejections('https://gitlab.com/acme/app/-/merge_requests/7'))
      .rejects.toThrow(/redirect/i);

    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe('manual');
    }
  });

  it('fails when the GitLab note list cannot be read', async () => {
    vi.stubEnv('GITLAB_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(readRejections('https://gitlab.com/acme/app/-/merge_requests/7'))
      .rejects.toThrow('GitLab notes request failed (500)');
  });
});
