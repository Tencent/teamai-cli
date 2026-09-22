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

  // Regression #701: any secret that slips into the outbound payload must be
  // scrubbed before it leaves the machine.
  describe('redaction (#701)', () => {
    it('redacts secret-shaped values from the outbound JSON body', async () => {
      mockAutoDetectInit.mockResolvedValueOnce({
        localConfig: { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user' },
        teamConfig: {
          team: 'test',
          sharing: {
            webhooks: {
              enabled: true,
              endpoints: [
                { url: 'https://example.test/hook', type: 'json', events: ['*'], timeout: 5000, retries: 0 },
              ],
            },
          },
        },
      });

      const { sendWebhook } = await import('../webhook.js');
      await sendWebhook('skill-use', {
        tool: 'claude',
        data: { blob: 'api_key=SYNTHETIC_SECRET_abcdefghij1234' },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = mockFetch.mock.calls[0][1].body as string;
      expect(body).not.toContain('SYNTHETIC_SECRET_abcdefghij1234');
      expect(body).toContain('<REDACTED');
    });
  });

  // Regression #703: a configured secret must reach the request as an
  // X-TeamAI-Signature computed over the exact bytes sent.
  describe('signature (#703)', () => {
    it('signs the outbound body with the configured secret', async () => {
      mockAutoDetectInit.mockResolvedValueOnce({
        localConfig: { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user' },
        teamConfig: {
          team: 'test',
          sharing: {
            webhooks: {
              enabled: true,
              endpoints: [
                {
                  url: 'https://example.test/hook',
                  type: 'json',
                  secret: 'synthetic-signing-key',
                  events: ['*'],
                  timeout: 5000,
                  retries: 0,
                },
              ],
            },
          },
        },
      });

      const { sendWebhook } = await import('../webhook.js');
      await sendWebhook('skill-use', { tool: 'claude', data: { skillName: 'demo' } });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0];
      const header = init.headers['X-TeamAI-Signature'] as string | undefined;
      expect(header).toMatch(/^sha256=/);

      const { createHmac } = await import('node:crypto');
      const expected = createHmac('sha256', 'synthetic-signing-key')
        .update(init.body as string)
        .digest('hex');
      expect(header).toBe(`sha256=${expected}`);
    });
  });
});

// Regression #703: getWebhookSharing dropped `secret` and force-overrode
// timeout/retries, so configured signing/backoff never took effect.
describe('getWebhookSharing (#703)', () => {
  it('preserves secret, timeout, and retries from config', async () => {
    const { getWebhookSharing } = await import('../types.js');
    const config = getWebhookSharing({
      sharing: {
        webhooks: {
          enabled: true,
          endpoints: [
            {
              url: 'https://example.test/hook',
              type: 'json',
              secret: 'synthetic-signing-key',
              events: ['skill-use'],
              timeout: 123,
              retries: 0,
            },
          ],
        },
      },
    });

    expect(config.endpoints).toHaveLength(1);
    const ep = config.endpoints[0];
    expect(ep.secret).toBe('synthetic-signing-key');
    expect(ep.timeout).toBe(123);
    expect(ep.retries).toBe(0);
    expect(ep.events).toEqual(['skill-use']);
  });

  it('applies defaults when optional fields are omitted', async () => {
    const { getWebhookSharing } = await import('../types.js');
    const config = getWebhookSharing({
      sharing: {
        webhooks: {
          enabled: true,
          endpoints: [{ url: 'https://example.test/hook', type: 'json' }],
        },
      },
    });

    const ep = config.endpoints[0];
    expect(ep.secret).toBeUndefined();
    expect(ep.timeout).toBe(5000);
    expect(ep.retries).toBe(3);
    expect(ep.events).toContain('push');
  });
});
