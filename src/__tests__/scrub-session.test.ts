/**
 * scrub.test.ts — 迁移脱敏（--scrub）。
 */
import { describe, expect, it } from 'vitest';
import { scrubSession } from '../session-flow/scrub.js';
import type { Session } from '../session-flow/ir.js';

function makeSession(): Session {
  return {
    sessionId: 'cccc1111-dddd-4eee-8fff-000011112222',
    title: '调接口: sk-ABCDEFGH1234567890abcdefghij',
    cwd: '/tmp/proj',
    platform: 'claude-code',
    createdAt: '2026-09-21T10:00:00.000Z',
    updatedAt: '2026-09-21T10:00:06.000Z',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'token 是 sk-ABCDEFGH1234567890abcdefghij' }],
        timestamp: '2026-09-21T10:00:00.000Z',
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的' },
          {
            type: 'tool_call',
            toolName: 'bash',
            callId: 'toolu_1',
            arguments: { command: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop" https://x' },
          },
        ],
        timestamp: '2026-09-21T10:00:05.000Z',
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            callId: 'toolu_1',
            content: 'password=hunter2SecretValue db=postgres://u:pw123456@10.0.0.5:5432/app',
            isError: false,
          },
        ],
        timestamp: '2026-09-21T10:00:06.000Z',
      },
    ],
    metadata: {},
  };
}

describe('scrubSession', () => {
  it('文本 / 工具参数 / 工具结果 / 标题都被脱敏', () => {
    const result = scrubSession(makeSession());
    const dump = JSON.stringify(result.session);

    expect(dump).not.toContain('sk-ABCDEFGH1234567890abcdefghij');
    expect(dump).not.toContain('hunter2SecretValue');
    expect(dump).not.toContain('pw123456');
    expect(dump).toContain('<REDACTED:');
    expect(result.session.title).not.toContain('sk-ABCDEFGH');
    expect(result.redactedCount).toBeGreaterThan(0);
  });

  it('消息结构与条数不变（脱敏只替换值）', () => {
    const before = makeSession();
    const after = scrubSession(before).session;
    expect(after.messages).toHaveLength(before.messages.length);
    expect(after.messages[1].content.map((b) => b.type)).toEqual(
      before.messages[1].content.map((b) => b.type),
    );
    // 工具参数仍是对象，不能退化成字符串
    const call = after.messages[1].content.find((b) => b.type === 'tool_call');
    expect(call).toBeTruthy();
    expect(typeof (call as { arguments: unknown }).arguments).toBe('object');
  });

  it('无敏感内容时原样返回、计数为 0', () => {
    const clean = makeSession();
    clean.title = '普通提问';
    clean.messages = [
      { role: 'user', content: [{ type: 'text', text: '帮我看下这个报错' }], timestamp: clean.createdAt },
    ];
    const result = scrubSession(clean);
    expect(result.redactedCount).toBe(0);
    expect(result.session.messages[0].content[0]).toEqual({ type: 'text', text: '帮我看下这个报错' });
  });
});
