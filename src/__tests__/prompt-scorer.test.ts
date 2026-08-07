import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeFetchResponse(body: object, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeHunyuanResponse(content: string): object {
  return {
    choices: [{ message: { content } }],
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('prompt-scorer', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    process.env.HUNYUAN_API_KEY = 'test-key-12345';
    delete process.env.HUNYUAN_BASE_URL;
    delete process.env.HUNYUAN_MODEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  // Dynamic import to pick up env mocks
  async function importScorer() {
    return import('../prompt-scorer.js');
  }

  describe('scorePrompt', () => {
    it('returns parsed score from valid LLM response', async () => {
      const { scorePrompt } = await importScorer();
      const llmJson = '{"overall": 8, "intentClarity": 9, "scopeSpecificity": 7, "contextSufficiency": 8}';
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse(llmJson)),
      );

      const result = await scorePrompt('fix the bug in src/foo.ts');
      expect(result.intentClarity).toBe(9);
      expect(result.scopeSpecificity).toBe(7);
      expect(result.contextSufficiency).toBe(8);
      // overall is recalculated: round(9*0.4 + 7*0.3 + 8*0.3) = round(3.6+2.1+2.4) = 8
      expect(result.overall).toBe(8);
    });

    it('sends correct Authorization header', async () => {
      const { scorePrompt } = await importScorer();
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse('{"overall":5,"intentClarity":5,"scopeSpecificity":5,"contextSufficiency":5}')),
      );

      await scorePrompt('test prompt');
      const callArgs = vi.mocked(fetch).mock.calls[0];
      const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-key-12345');
    });

    it('uses default base URL and model', async () => {
      const { scorePrompt } = await importScorer();
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse('{"overall":5,"intentClarity":5,"scopeSpecificity":5,"contextSufficiency":5}')),
      );

      await scorePrompt('test');
      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).toBe('https://api.hunyuan.cloud.tencent.com/v1/chat/completions');
      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      expect(body.model).toBe('hunyuan-turbos-latest');
    });

    it('truncates prompt to 2000 characters', async () => {
      const { scorePrompt } = await importScorer();
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse('{"overall":5,"intentClarity":5,"scopeSpecificity":5,"contextSufficiency":5}')),
      );

      const longPrompt = 'x'.repeat(5000);
      await scorePrompt(longPrompt);
      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      const userMsg = body.messages[1].content as string;
      // The user content should contain at most 2000 chars of the prompt
      expect(userMsg).not.toContain('x'.repeat(2001));
      expect(userMsg).toContain('x'.repeat(2000));
    });
  });

  describe('ScorerConfigError', () => {
    it('throws when HUNYUAN_API_KEY is not set', async () => {
      delete process.env.HUNYUAN_API_KEY;
      const { scorePrompt, ScorerConfigError } = await importScorer();
      await expect(scorePrompt('test')).rejects.toThrow(ScorerConfigError);
      await expect(scorePrompt('test')).rejects.toThrow('HUNYUAN_API_KEY not configured');
    });

    it('throws when HUNYUAN_BASE_URL is not a tencent domain', async () => {
      process.env.HUNYUAN_BASE_URL = 'https://evil.com/v1';
      const { scorePrompt, ScorerConfigError } = await importScorer();
      await expect(scorePrompt('test')).rejects.toThrow(ScorerConfigError);
      await expect(scorePrompt('test')).rejects.toThrow('must be a *.cloud.tencent.com');
    });

    it('accepts valid tencent cloud URL', async () => {
      process.env.HUNYUAN_BASE_URL = 'https://api.hunyuan.cloud.tencent.com/v1';
      const { scorePrompt } = await importScorer();
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse('{"overall":5,"intentClarity":5,"scopeSpecificity":5,"contextSufficiency":5}')),
      );
      const result = await scorePrompt('test');
      expect(result.overall).toBe(5);
    });
  });

  describe('ScorerServiceError', () => {
    it('throws on non-OK HTTP response', async () => {
      const { scorePrompt, ScorerServiceError } = await importScorer();
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse({ error: 'rate limited' }, 429),
      );
      await expect(scorePrompt('test')).rejects.toThrow(ScorerServiceError);
    });

    it('throws on malformed JSON in LLM response', async () => {
      const { scorePrompt, ScorerServiceError } = await importScorer();
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse('{invalid json}')),
      );
      await expect(scorePrompt('test')).rejects.toThrow(ScorerServiceError);
    });

    it('throws when LLM returns no JSON at all', async () => {
      const { scorePrompt } = await importScorer();
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse('I cannot score this prompt.')),
      );
      await expect(scorePrompt('test')).rejects.toThrow('no JSON found');
    });
  });

  describe('parseScoreResponse (via scorePrompt)', () => {
    it('clamps out-of-range scores to 0-10', async () => {
      const { scorePrompt } = await importScorer();
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse('{"overall":15,"intentClarity":-3,"scopeSpecificity":12,"contextSufficiency":0}')),
      );
      const result = await scorePrompt('test');
      expect(result.intentClarity).toBe(0);
      expect(result.scopeSpecificity).toBe(10);
      expect(result.contextSufficiency).toBe(0);
    });

    it('defaults to 5 for non-numeric values', async () => {
      const { scorePrompt } = await importScorer();
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse('{"overall":5,"intentClarity":"high","scopeSpecificity":"medium","contextSufficiency":7}')),
      );
      const result = await scorePrompt('test');
      expect(result.intentClarity).toBe(5);
      expect(result.scopeSpecificity).toBe(5);
      expect(result.contextSufficiency).toBe(7);
    });

    it('extracts JSON from markdown-wrapped response', async () => {
      const { scorePrompt } = await importScorer();
      const wrappedResponse = 'Here is the score:\n```json\n{"overall":7,"intentClarity":8,"scopeSpecificity":6,"contextSufficiency":7}\n```';
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse(wrappedResponse)),
      );
      const result = await scorePrompt('test');
      expect(result.intentClarity).toBe(8);
      expect(result.scopeSpecificity).toBe(6);
    });

    it('recalculates overall using the weighted formula', async () => {
      const { scorePrompt } = await importScorer();
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse('{"overall":0,"intentClarity":10,"scopeSpecificity":10,"contextSufficiency":10}')),
      );
      const result = await scorePrompt('test');
      // overall = round(10*0.4 + 10*0.3 + 10*0.3) = 10, ignores LLM's "0"
      expect(result.overall).toBe(10);
    });
  });

  describe('lang parameter', () => {
    it('includes Chinese hint when lang is zh', async () => {
      const { scorePrompt } = await importScorer();
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse('{"overall":5,"intentClarity":5,"scopeSpecificity":5,"contextSufficiency":5}')),
      );
      await scorePrompt('修复 bug', 'zh');
      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      expect(body.messages[1].content).toContain('Chinese');
    });

    it('includes English hint when lang is en', async () => {
      const { scorePrompt } = await importScorer();
      vi.mocked(fetch).mockResolvedValueOnce(
        makeFetchResponse(makeHunyuanResponse('{"overall":5,"intentClarity":5,"scopeSpecificity":5,"contextSufficiency":5}')),
      );
      await scorePrompt('fix bug', 'en');
      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      expect(body.messages[1].content).toContain('English');
    });
  });
});
