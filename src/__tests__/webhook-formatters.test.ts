import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatFeishuMessage, formatWecomMessage, formatGenericJson } from '../webhook-formatters.js';
import type { WebhookPayload } from '../types.js';

describe('webhook-formatters', () => {
  const basePayload: WebhookPayload = {
    event: 'push',
    timestamp: '2026-09-19T10:30:00.000Z',
    tool: 'claude',
    username: 'testuser',
    sessionId: 'abc12345-def6-7890',
    cwd: '/home/user/project',
    data: { resources: { skills: 2, rules: 1 } },
  };

  describe('formatFeishuMessage', () => {
    it('should format push event correctly', () => {
      const result = formatFeishuMessage(basePayload) as Record<string, unknown>;

      expect(result.msg_type).toBe('text');
      expect(result.content).toBeDefined();

      const text = (result.content as { text: string }).text;
      expect(text).toContain('TeamAI Notification');
      expect(text).toContain('Event: Push Complete');
      expect(text).toContain('User: testuser');
      expect(text).toContain('Tool: claude');
      expect(text).toContain('Resources: skills: 2, rules: 1');
    });

    it('should format skill-use event correctly', () => {
      const payload: WebhookPayload = {
        ...basePayload,
        event: 'skill-use',
        data: { skillName: 'my-skill' },
      };

      const result = formatFeishuMessage(payload) as Record<string, unknown>;
      const text = (result.content as { text: string }).text;

      expect(text).toContain('Event: Skill Used');
      expect(text).toContain('Skill: my-skill');
    });

    it('should format session-start event correctly', () => {
      const payload: WebhookPayload = {
        ...basePayload,
        event: 'session-start',
        data: { sessionId: 'abc12345' },
      };

      const result = formatFeishuMessage(payload) as Record<string, unknown>;
      const text = (result.content as { text: string }).text;

      expect(text).toContain('Event: Session Started');
      expect(text).toContain('Session: abc12345');
    });

    it('should handle missing optional fields', () => {
      const payload: WebhookPayload = {
        event: 'pull',
        timestamp: '2026-09-19T10:30:00.000Z',
        tool: 'codex',
        data: {},
      };

      const result = formatFeishuMessage(payload) as Record<string, unknown>;
      const text = (result.content as { text: string }).text;

      expect(text).toContain('Event: Pull Complete');
      expect(text).not.toContain('User:');
    });
  });

  describe('formatWecomMessage', () => {
    it('should format push event correctly', () => {
      const result = formatWecomMessage(basePayload) as Record<string, unknown>;

      expect(result.msgtype).toBe('text');
      expect(result.text).toBeDefined();

      const text = (result.text as { content: string }).content;
      expect(text).toContain('TeamAI Notification');
      expect(text).toContain('Event: Push Complete');
      expect(text).toContain('User: testuser');
      expect(text).toContain('Tool: claude');
    });

    it('should format skill-use event correctly', () => {
      const payload: WebhookPayload = {
        ...basePayload,
        event: 'skill-use',
        data: { skillName: 'deploy-skill' },
      };

      const result = formatWecomMessage(payload) as Record<string, unknown>;
      const text = (result.text as { content: string }).content;

      expect(text).toContain('Event: Skill Used');
      expect(text).toContain('Skill: deploy-skill');
    });
  });

  describe('formatGenericJson', () => {
    it('should format all fields correctly', () => {
      const result = formatGenericJson(basePayload) as Record<string, unknown>;

      expect(result.event).toBe('push');
      expect(result.timestamp).toBe('2026-09-19T10:30:00.000Z');
      expect(result.tool).toBe('claude');
      expect(result.username).toBe('testuser');
      expect(result.sessionId).toBe('abc12345-def6-7890');
      expect(result.cwd).toBe('/home/user/project');
      expect(result.data).toEqual({ resources: { skills: 2, rules: 1 } });
    });

    it('should handle missing optional fields', () => {
      const payload: WebhookPayload = {
        event: 'pull',
        timestamp: '2026-09-19T10:30:00.000Z',
        tool: 'codex',
        data: {},
      };

      const result = formatGenericJson(payload) as Record<string, unknown>;

      expect(result.event).toBe('pull');
      expect(result.username).toBeUndefined();
      expect(result.sessionId).toBeUndefined();
    });
  });
});
