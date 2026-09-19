import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────

const mockAutoDetectInit = vi.fn().mockResolvedValue({
  localConfig: { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user' },
  teamConfig: {
    team: 'test',
    sharing: {
      webhooks: {
        enabled: true,
        endpoints: [
          {
            url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
            type: 'feishu',
            events: ['push', 'pull', 'skill-use'],
            timeout: 5000,
            retries: 3,
          },
          {
            url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
            type: 'wecom',
            events: ['push', 'session-start'],
            timeout: 5000,
            retries: 3,
          },
        ],
      },
    },
  },
});

vi.mock('../config.js', () => ({
  autoDetectInit: mockAutoDetectInit,
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  describe('sendWebhook', () => {
    it('should send webhook to matching endpoints', async () => {
      const { sendWebhook } = await import('../webhook.js');

      await sendWebhook('push', {
        tool: 'claude',
        data: { resources: { skills: 1 } },
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://open.feishu.cn/open-apis/bot/v2/hook/test',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'text/plain; charset=utf-8',
          }),
        }),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    it('should not send to non-matching endpoints', async () => {
      const { sendWebhook } = await import('../webhook.js');

      await sendWebhook('session-stop', {
        tool: 'claude',
        data: {},
      });

      // session-stop is not in either endpoint's events list
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip when webhooks are disabled', async () => {
      mockAutoDetectInit.mockResolvedValueOnce({
        localConfig: { repo: { localPath: '/tmp', remote: '' } },
        teamConfig: {
          sharing: {
            webhooks: { enabled: false, endpoints: [] },
          },
        },
      });

      const { sendWebhook } = await import('../webhook.js');

      await sendWebhook('push', {
        tool: 'claude',
        data: {},
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const { sendWebhook } = await import('../webhook.js');

      // Should not throw
      await sendWebhook('push', {
        tool: 'claude',
        data: {},
      });
    });
  });

  describe('loadWebhookConfig', () => {
    it('should return webhook config', async () => {
      const { loadWebhookConfig } = await import('../webhook.js');

      const config = await loadWebhookConfig();

      expect(config.enabled).toBe(true);
      expect(config.endpoints).toHaveLength(2);
      expect(config.endpoints[0].type).toBe('feishu');
      expect(config.endpoints[1].type).toBe('wecom');
    });
  });

  describe('listWebhooks', () => {
    it('should list configured endpoints', async () => {
      const { listWebhooks } = await import('../webhook.js');

      const endpoints = await listWebhooks();

      expect(endpoints).toHaveLength(2);
      expect(endpoints[0].url).toContain('feishu');
      expect(endpoints[0].type).toBe('feishu');
      expect(endpoints[1].type).toBe('wecom');
    });
  });

  describe('testWebhook', () => {
    it('should send test event to all endpoints', async () => {
      const { testWebhook } = await import('../webhook.js');

      await testWebhook();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should send test event to specific endpoint', async () => {
      const { testWebhook } = await import('../webhook.js');

      await testWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/test');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://open.feishu.cn/open-apis/bot/v2/hook/test',
        expect.anything(),
      );
    });
  });
});
