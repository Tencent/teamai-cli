import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { extractMarkerId, readRejections, shouldWrite } from '../ci/read-rejections.js';
import type { RejectionResult } from '../ci/read-rejections.js';

describe('extractMarkerId', () => {
  it('extracts the learning marker', () => {
    expect(extractMarkerId('<!-- teamai:ci-extract:learning -->\nsome content')).toBe('learning');
  });

  it('extracts a suggestion marker', () => {
    expect(extractMarkerId('<!-- teamai:ci-extract:suggestion:1 -->\ncontent')).toBe('suggestion:1');
  });

  it('extracts the suggestion:2 marker', () => {
    expect(extractMarkerId('<!-- teamai:ci-extract:suggestion:2 -->')).toBe('suggestion:2');
  });

  it('returns null without a marker', () => {
    expect(extractMarkerId('普通 comment 内容')).toBeNull();
  });

  it('does not match other teamai markers', () => {
    expect(extractMarkerId('<!-- teamai:ci-extract -->')).toBeNull();
  });
});

describe('shouldWrite', () => {
  const rejections: RejectionResult = {
    rejectedIds: new Set(['suggestion:2']),
    approvedIds: new Set(['learning', 'suggestion:1']),
    allIds: new Set(['learning', 'suggestion:1', 'suggestion:2']),
  };

  describe('GitHub (written by default, 👎 = reject)', () => {
    it('not in rejectedIds → written', () => {
      expect(shouldWrite('learning', rejections, 'github')).toBe(true);
      expect(shouldWrite('suggestion:1', rejections, 'github')).toBe(true);
    });

    it('in rejectedIds → not written', () => {
      expect(shouldWrite('suggestion:2', rejections, 'github')).toBe(false);
    });

    it('unknown id (in no set) → written (default)', () => {
      expect(shouldWrite('suggestion:99', rejections, 'github')).toBe(true);
    });
  });

  describe('TGit (written by default, 🚫 emoji = reject)', () => {
    it('not in rejectedIds → written', () => {
      expect(shouldWrite('learning', rejections, 'tgit')).toBe(true);
      expect(shouldWrite('suggestion:1', rejections, 'tgit')).toBe(true);
    });

    it('in rejectedIds → not written', () => {
      expect(shouldWrite('suggestion:2', rejections, 'tgit')).toBe(false);
    });

    it('unknown id (in no set) → written (default)', () => {
      expect(shouldWrite('suggestion:99', rejections, 'tgit')).toBe(true);
    });
  });
});

describe('readRejections API failures', () => {
  beforeEach(() => {
    vi.stubEnv('GITLAB_URL', 'https://gitlab.com');
  });
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

describe('GitLab (written by default, 👎 thumbsdown = reject)', () => {
  beforeEach(() => {
    vi.stubEnv('GITLAB_URL', 'https://gitlab.com');
  });
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

  it('marks a thumbsdown award as reject and approves by default without an emoji', async () => {
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

  it('counts a skin-tone thumbsdown as a reject', async () => {
    vi.stubEnv('GITLAB_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === notesUrl) return new Response(notes, { status: 200 });
      if (url === emojiUrl(1)) return new Response(JSON.stringify([{ name: 'thumbsdown_tone2' }]), { status: 200 });
      if (url === emojiUrl(2)) return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`unexpected ${url}`);
    }));

    const result = await readRejections('https://gitlab.com/acme/app/-/merge_requests/7');
    expect(result.rejectedIds).toEqual(new Set(['learning']));
    expect(result.approvedIds).toEqual(new Set(['suggestion:1']));
    expect(shouldWrite('learning', result, 'gitlab')).toBe(false);
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

  it.each(['notes', 'awards'])('still refuses incomplete %s when rejection data exceeds the page limit', async (endpoint) => {
    vi.stubEnv('GITLAB_TOKEN', 'test-token');
    const fetchMock = vi.fn(async (url: string) => {
      const isNotes = url.includes('/notes?');
      const page = Number(new URL(url).searchParams.get('page'));
      const body = isNotes && page === 1
        ? [{ id: 1, body: '<!-- teamai:ci-extract:learning -->\ncontent' }] : [];
      // Finding a marker does not finish a rejection check: older notes or
      // later awards may still contain a veto.
      return new Response(JSON.stringify(body), {
        headers: isNotes && endpoint === 'awards' ? {} : { 'x-next-page': String(page + 1) },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(readRejections('https://gitlab.com/acme/app/-/merge_requests/7'))
      .rejects.toThrow('has more than 20 pages');
    expect(fetchMock).toHaveBeenCalledTimes(endpoint === 'notes' ? 20 : 21);
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
