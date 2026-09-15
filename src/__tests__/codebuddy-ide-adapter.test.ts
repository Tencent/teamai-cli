import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * IDE 存储路径是 `os.homedir()` 派生的，必须整体换掉 home 才能用 fixture。
 * `vi.spyOn(os, 'homedir')` 在这里不生效——测试文件是 default import，
 * 被测模块是 namespace import，两者在 ESM 下不是同一个对象，spy 打在测试侧。
 * 因此改用模块级 mock，同时覆盖命名导出与 default。
 */
const mocks = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as unknown as Record<string, unknown> & { default?: object };
  const patched: Record<string, unknown> = { ...actual, homedir: () => mocks.home };
  patched.default = { ...(actual.default ?? {}), homedir: () => mocks.home };
  return patched;
});

import {
  listIdeHistoryRoots,
  readIdeConversation,
} from '../session-flow/ide-history.js';
import { CodeBuddyIdeAdapter } from '../session-flow/adapters/codebuddy-ide.js';

/**
 * CodeBuddy IDE 适配器测试。
 *
 * IDE 与 CLI 是两套独立存储，IDE 侧有几个容易踩空的点，这里逐条钉住：
 * - history 根有两种布局（default 实例少一层 instId）
 * - 工作区目录名是 md5(cwd)，过滤时不能把工作区目录当 history 根传下去
 * - 会话 id 是 32 位 hex，读写删必须映射成同一个 id
 */

let tmpHome: string;

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

function userDataBase(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data');
}

/** 常规实例：<extId>/CodeBuddyIDE/<instId>/history */
function historyRootA(home: string): string {
  return path.join(userDataBase(home), 'ext-a', 'CodeBuddyIDE', 'ext-a', 'history');
}

/** default 实例：<extId>/CodeBuddyIDE/history（少一层 instId） */
function historyRootB(home: string): string {
  return path.join(userDataBase(home), 'ext-b', 'CodeBuddyIDE', 'history');
}

function writeMsg(msgDir: string, id: string, role: string, content: unknown[], createdAt: string): void {
  fs.mkdirSync(msgDir, { recursive: true });
  fs.writeFileSync(
    path.join(msgDir, `${id}.json`),
    JSON.stringify(
      {
        role,
        message: JSON.stringify({ role, content }),
        id,
        extra: JSON.stringify({ modelName: 'custom-local:test-model' }),
        createdAt,
      },
      null,
      2,
    ),
  );
}

interface FixtureConv {
  id: string;
  name?: string;
  messages: Array<{ id: string; role: string; content: unknown[] }>;
}

/** 在某个 history 根下建一个工作区及其会话。 */
function buildWorkspace(
  historyRoot: string,
  cwd: string,
  convs: FixtureConv[],
): string {
  const wsDir = path.join(historyRoot, md5(cwd));
  fs.mkdirSync(wsDir, { recursive: true });

  const index = {
    conversations: convs.map((c) => ({
      id: c.id,
      type: 'craft',
      name: c.name ?? '',
      createdAt: '2026-09-01T10:00:00.000Z',
      lastMessageAt: '2026-09-01T11:00:00.000Z',
    })),
    current: convs[0]?.id,
  };
  fs.writeFileSync(path.join(wsDir, 'index.json'), JSON.stringify(index, null, 2));

  for (const c of convs) {
    const convDir = path.join(wsDir, c.id);
    const msgDir = path.join(convDir, 'messages');
    fs.mkdirSync(msgDir, { recursive: true });
    // 顺序故意与文件名字典序相反，验证顺序来自 index.json 而非文件名
    fs.writeFileSync(
      path.join(convDir, 'index.json'),
      JSON.stringify({ messages: c.messages.map((m) => ({ id: m.id, role: m.role, isComplete: true })), requests: [] }, null, 2),
    );
    c.messages.forEach((m, i) => {
      writeMsg(msgDir, m.id, m.role, m.content, new Date(Date.UTC(2026, 8, 1, 10, i)).toISOString());
    });
  }

  return wsDir;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cbide-'));
  mocks.home = tmpHome;
});

afterEach(() => {
  mocks.home = '';
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('listIdeHistoryRoots', () => {
  it('covers both layouts, including the default instance without an instId level', () => {
    fs.mkdirSync(historyRootA(tmpHome), { recursive: true });
    fs.mkdirSync(historyRootB(tmpHome), { recursive: true });

    const roots = listIdeHistoryRoots();
    expect(roots).toContain(historyRootA(tmpHome));
    expect(roots).toContain(historyRootB(tmpHome));
  });

  it('returns empty when CodeBuddy IDE has never been launched', () => {
    expect(listIdeHistoryRoots()).toEqual([]);
  });
});

describe('readIdeConversation', () => {
  it('follows the message order from index.json, not filename order', () => {
    const cwd = '/tmp/project-a';
    const conv: FixtureConv = {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      name: 'order test',
      messages: [
        { id: 'zzz', role: 'user', content: [{ type: 'text', text: 'first' }] },
        { id: 'aaa', role: 'assistant', content: [{ type: 'text', text: 'second' }] },
      ],
    };
    const wsDir = buildWorkspace(historyRootA(tmpHome), cwd, [conv]);
    const convDir = path.join(wsDir, conv.id);

    const messages = readIdeConversation(convDir);
    expect(messages.map((m) => m.content[0]?.text)).toEqual(['first', 'second']);
  });

  it('stops at the limit so listing does not read whole conversations', () => {
    const cwd = '/tmp/project-a';
    const conv: FixtureConv = {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2',
      name: 'limit test',
      messages: Array.from({ length: 10 }, (_, i) => ({
        id: `m${i}`,
        role: 'user',
        content: [{ type: 'text', text: `msg-${i}` }],
      })),
    };
    const wsDir = buildWorkspace(historyRootA(tmpHome), cwd, [conv]);
    const convDir = path.join(wsDir, conv.id);

    expect(readIdeConversation(convDir, 3)).toHaveLength(3);
  });
});

describe('CodeBuddyIdeAdapter', () => {
  const cwdA = '/tmp/ws-a';
  const cwdB = '/tmp/ws-b';

  function seed(): void {
    buildWorkspace(historyRootA(tmpHome), cwdA, [
      {
        id: '33333333333333333333333333333333',
        name: '项目 A 的会话',
        messages: [
          { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }] },
          {
            id: 'a1',
            role: 'assistant',
            content: [
              { type: 'reasoning', text: '想一下' },
              { type: 'text', text: '收到' },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', args: { p: '/x' } },
            ],
          },
          {
            id: 't1',
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'c1',
                toolName: 'read_file',
                result: { status: 'success', success: true, result: { type: 'text_result', content: 'ok' } },
              },
            ],
          },
        ],
      },
    ]);
    buildWorkspace(historyRootB(tmpHome), cwdB, [
      {
        id: '22222222222222222222222222222222',
        name: '',
        messages: [
          {
            id: 'u2',
            role: 'user',
            content: [{ type: 'text', text: '<system-reminder>ignore me</system-reminder>' }],
          },
        ],
      },
    ]);
  }

  it('filters by workspace hash instead of treating the workspace dir as a history root', async () => {
    seed();
    const adapter = new CodeBuddyIdeAdapter();

    const scoped = await adapter.listConversations(cwdA);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].title).toBe('项目 A 的会话');
    expect(scoped[0].cwd).toBe(cwdA);
    expect(scoped[0].messageCount).toBe(3);

    const all = await adapter.listConversations();
    expect(all).toHaveLength(2);
  });

  it('marks the workspace as unknown when no cwd is supplied', async () => {
    seed();
    const adapter = new CodeBuddyIdeAdapter();
    const [meta] = await adapter.listConversations();
    expect(meta.cwd).toMatch(/^md5:[0-9a-f]{32}$/);
  });

  it('falls back to a session id title when the first message is injected context', async () => {
    seed();
    const adapter = new CodeBuddyIdeAdapter();
    const session = await adapter.readSession('22222222222222222222222222222222');
    expect(session.title).toBe('Session 22222222');
  });

  it('converts IDE blocks into IR, folding tool results into a user message', async () => {
    seed();
    const adapter = new CodeBuddyIdeAdapter();
    const session = await adapter.readSession('33333333333333333333333333333333', cwdA);

    expect(session.platform).toBe('codebuddy-ide');
    expect(session.cwd).toBe(cwdA);
    expect(session.messages).toHaveLength(3);

    const assistant = session.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_call']);
    expect(assistant.content[1]).toMatchObject({ type: 'text', text: '收到' });
    expect(assistant.content[2]).toMatchObject({ type: 'tool_call', toolName: 'read_file', callId: 'c1' });

    const toolMsg = session.messages[2];
    expect(toolMsg.role).toBe('user');
    expect(toolMsg.content[0]).toMatchObject({ type: 'tool_result', callId: 'c1', content: 'ok', isError: false });
    expect(session.metadata?.model).toBe('test-model');
  });

  it('reuses the 32-hex conversation id across write, read, and delete', async () => {
    seed();
    const adapter = new CodeBuddyIdeAdapter();
    const targetCwd = path.join(tmpHome, 'ws-target');
    fs.mkdirSync(targetCwd, { recursive: true });

    const source = await adapter.readSession('33333333333333333333333333333333', cwdA);
    const writtenId = await adapter.writeSession({ ...source, title: 'round trip' }, targetCwd);
    expect(writtenId).toBe('33333333333333333333333333333333');

    const back = await adapter.readSession(writtenId, targetCwd);
    expect(back.title).toBe('round trip');
    expect(back.messages).toHaveLength(source.messages.length);

    expect(await adapter.deleteSession(writtenId, targetCwd)).toBe(true);

    // 写入时两个 IDE 实例都写了，删除要两个都清掉
    const targetWsDirs = listIdeHistoryRoots().map((r) => path.join(r, md5(targetCwd)));
    expect(targetWsDirs.length).toBeGreaterThan(0);
    for (const wsDir of targetWsDirs) {
      expect(fs.existsSync(path.join(wsDir, writtenId))).toBe(false);
    }

    // 同名会话在别的工作区另有副本，按 cwd 限定删除不能连带误删
    expect(fs.existsSync(path.join(historyRootA(tmpHome), md5(cwdA), writtenId))).toBe(true);
  });

  it('refuses to write when the target cwd is not an absolute path', async () => {
    seed();
    const adapter = new CodeBuddyIdeAdapter();
    const source = await adapter.readSession('33333333333333333333333333333333', cwdA);

    await expect(adapter.writeSession({ ...source, cwd: 'md5:abc' })).rejects.toThrow(/absolute working directory/);
  });

  it('does not relabel the workspace when the global fallback finds the session elsewhere', async () => {
    seed();
    const adapter = new CodeBuddyIdeAdapter();

    // 会话在 cwdA 工作区，但用另一个 projectPath 读取 → 全局兜底命中。
    // cwd 必须标 md5 占位（真实工作区不可逆），绝不能冒充传入路径，
    // 否则下游按 session.cwd 派生的归档键会跟着错。
    const session = await adapter.readSession('33333333333333333333333333333333', '/tmp/other-project');
    expect(session.cwd).toBe(`md5:${md5(cwdA)}`);

    // 对照：projectPath 与会话所在工作区一致时，cwd 就是该路径
    const direct = await adapter.readSession('33333333333333333333333333333333', cwdA);
    expect(direct.cwd).toBe(cwdA);
  });
});
