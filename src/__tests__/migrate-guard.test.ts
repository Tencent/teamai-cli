/**
 * migrate.test.ts — 迁移引擎守卫与保真度统计。
 *
 * 覆盖三类曾静默出错的行为：
 * 1. 目标端未安装时迁移必须失败（此前会照样写目录并报「成功」）
 * 2. 未知工具计为 degraded（此前恒记 preserved → 保真度虚高 100%）
 * 3. 图片块按目标能力分别计 preserved / degraded
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AgentAdapter, SessionMeta } from '../session-flow/adapters/base.js';
import { ADAPTER_REGISTRY, type AdapterFactory } from '../session-flow/adapters/index.js';
import { MigrationEngine, fidelityFromSession } from '../session-flow/migrate.js';
import type { Session } from '../session-flow/ir.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: '11111111-2222-4333-8444-555555555555',
    title: 'test session',
    cwd: '/tmp/test-proj',
    platform: 'claude-code',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:01:00.000Z',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        timestamp: '2026-09-20T00:00:00.000Z',
      },
    ],
    metadata: {},
    ...overrides,
  };
}

/** 永不就绪的 mock 适配器。 */
function notReadyAdapter(): AgentAdapter {
  return {
    platform: 'mock-uninstalled',
    isReady: () => false,
    listConversations: async (): Promise<SessionMeta[]> => [],
    readSession: async () => makeSession(),
    writeSession: async () => 'mock-id',
    deleteSession: async () => {},
  } as unknown as AgentAdapter;
}

/** 全就绪的 mock 适配器，记录 writeSession 收到的会话。 */
function readyAdapter(written: Session[]) {
  return {
    platform: 'mock-ready',
    isReady: () => true,
    listConversations: async (): Promise<SessionMeta[]> => [],
    readSession: async () => makeSession(),
    writeSession: async (s: Session) => {
      written.push(s);
      return 'mock-target-id';
    },
    deleteSession: async () => {},
  } as unknown as AgentAdapter;
}

describe('MigrationEngine — 目标端安装检查', () => {
  const KEY = '__test_uninstalled__';
  let original: AdapterFactory | undefined;

  beforeAll(() => {
    original = ADAPTER_REGISTRY[KEY];
    ADAPTER_REGISTRY[KEY] = () => notReadyAdapter();
  });
  afterAll(() => {
    if (original) ADAPTER_REGISTRY[KEY] = original;
    else delete ADAPTER_REGISTRY[KEY];
  });

  it('目标端未安装 → success=false 且错误信息可读', async () => {
    const engine = new MigrationEngine('claude-code', KEY);
    const result = await engine.migrate('11111111-2222-4333-8444-555555555555', '/tmp');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not installed');
    expect(result.error).toContain(KEY);
  });
});

describe('MigrationEngine — 写入路径', () => {
  const SRC = '__test_src__';
  const KEY = '__test_ready__';
  const originals: Record<string, AdapterFactory | undefined> = {};
  const written: Session[] = [];

  beforeAll(() => {
    originals[SRC] = ADAPTER_REGISTRY[SRC];
    originals[KEY] = ADAPTER_REGISTRY[KEY];
    ADAPTER_REGISTRY[SRC] = () => readyAdapter(written); // readSession 返回固定会话
    ADAPTER_REGISTRY[KEY] = () => readyAdapter(written);
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(originals)) {
      if (v) ADAPTER_REGISTRY[k] = v;
      else delete ADAPTER_REGISTRY[k];
    }
  });

  it('目标端就绪 → 写入成功且 IR 传给 writeSession', async () => {
    written.length = 0;
    const engine = new MigrationEngine(SRC, KEY);
    const result = await engine.migrate('11111111-2222-4333-8444-555555555555', '/tmp');
    expect(result.success).toBe(true);
    expect(result.targetSessionId).toBe('mock-target-id');
    expect(written).toHaveLength(1);
    expect(written[0].messages[0].content[0]).toMatchObject({ type: 'text', text: 'hello' });
  });
});

describe('fidelityFromSession — 真实统计', () => {
  it('未知工具计 degraded，保真度回落', () => {
    const session = makeSession({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_call', toolName: 'totally_unknown_tool', callId: 'c1', arguments: {} },
          ],
          timestamp: '2026-09-20T00:00:30.000Z',
        },
      ],
    });
    const report = fidelityFromSession(session, 'claude-code');
    expect(report.totalBlocks).toBe(2);
    expect(report.degradedBlocks).toBe(1);
    expect(report.warnings.some((w) => w.includes('totally_unknown_tool'))).toBe(true);
    expect(report.score).toBeLessThan(1);
  });

  it('已登记工具计 preserved', () => {
    const session = makeSession({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', toolName: 'bash', callId: 'c2', arguments: {} }],
          timestamp: '2026-09-20T00:00:30.000Z',
        },
      ],
    });
    const report = fidelityFromSession(session, 'claude-code');
    expect(report.preservedBlocks).toBe(1);
    expect(report.score).toBe(1);
  });

  it('图片块：支持图片的目标计 preserved，不支持的计 degraded', () => {
    const session = makeSession({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'aGVsbG8=',
              label: 'shot.png',
            },
          ],
          timestamp: '2026-09-20T00:00:10.000Z',
        },
      ],
    });
    const toCC = fidelityFromSession(session, 'claude-code');
    expect(toCC.preservedBlocks).toBe(1);
    expect(toCC.score).toBe(1);

    const toCodex = fidelityFromSession(session, 'codex');
    expect(toCodex.degradedBlocks).toBe(1);
    expect(toCodex.degradations.some((d) => d.startsWith('image_blocks_degraded_to_placeholder'))).toBe(
      true,
    );
    expect(toCodex.score).toBeLessThan(1);
  });
});
