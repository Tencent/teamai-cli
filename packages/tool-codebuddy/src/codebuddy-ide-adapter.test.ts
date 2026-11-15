import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  patched.default = { ...actual.default, homedir: () => mocks.home };
  return patched;
});

import { CodeBuddyIdeAdapter } from './codebuddy-ide-adapter.js';
import { buildWorkspace, defaultInstanceHistory, ideDataIn, instanceHistory, md5, workspaceFolderOf } from './testing/ide-history.js';

/**
 * CodeBuddy IDE 适配器测试。
 *
 * IDE 与 CLI 是两套独立存储，IDE 侧有几个容易踩空的点，这里逐条钉住：
 * - history 根有两种布局（default 实例少一层 instId）
 * - 工作区目录名是 md5(cwd)，过滤时不能把工作区目录当 history 根传下去
 * - 会话 id 是 32 位 hex，读写删必须映射成同一个 id
 */

let tmpHome: string;
let previousIdeData: string | undefined;

function useIdeData(home: string): void {
  mocks.home = home;
  previousIdeData = process.env.TEAMAI_CODEBUDDY_IDE_DATA;
  process.env.TEAMAI_CODEBUDDY_IDE_DATA = ideDataIn(home);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cbide-'));
  useIdeData(tmpHome);
});

afterEach(() => {
  mocks.home = '';
  if (previousIdeData === undefined) delete process.env.TEAMAI_CODEBUDDY_IDE_DATA;
  else process.env.TEAMAI_CODEBUDDY_IDE_DATA = previousIdeData;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('CodeBuddyIdeAdapter', () => {
  const cwdA = '/tmp/ws-a';
  const cwdB = '/tmp/ws-b';

  function seed(): void {
    buildWorkspace(instanceHistory(tmpHome), cwdA, [
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
    buildWorkspace(defaultInstanceHistory(tmpHome), cwdB, [
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
    const session = await adapter.readSession({ sessionId: '22222222222222222222222222222222' });
    expect(session.title).toBe('Session 22222222');
  });

  it('converts IDE blocks into IR, folding tool results into a user message', async () => {
    seed();
    const adapter = new CodeBuddyIdeAdapter();
    const session = await adapter.readSession({ sessionId: '33333333333333333333333333333333', projectPath: cwdA });

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

  it('writes a new conversation id and leaves the source session in place', async () => {
    seed();
    const adapter = new CodeBuddyIdeAdapter();
    const targetCwd = path.join(tmpHome, 'ws-target');
    fs.mkdirSync(targetCwd, { recursive: true });
    const sourceId = '33333333333333333333333333333333';

    const source = await adapter.readSession({ sessionId: sourceId, projectPath: cwdA });
    const writtenId = await adapter.writeSession({ ...source, title: 'round trip' }, targetCwd);
    expect(writtenId).toMatch(/^[0-9a-f]{32}$/);
    expect(writtenId).not.toBe(sourceId);

    const back = await adapter.readSession({ sessionId: writtenId, projectPath: targetCwd });
    expect(back.title).toBe('round trip');
    expect(back.messages).toHaveLength(source.messages.length);

    const again = await adapter.writeSession({ ...source, title: 'round trip' }, targetCwd);
    expect(again).toBe(writtenId);

    const replaced = await adapter.writeSession({ ...source, title: 'should not clobber' }, cwdA);
    expect(replaced).not.toBe(sourceId);
    const still = await adapter.readSession({ sessionId: sourceId, projectPath: cwdA });
    expect(still.title).not.toBe('should not clobber');

    // 写入时两个 IDE 实例都写了，删除要两个都清掉
    const targetWsDirs = [instanceHistory(tmpHome), defaultInstanceHistory(tmpHome)].map((r) => path.join(r, workspaceFolderOf(targetCwd)));
    expect(targetWsDirs.map((wsDir) => fs.existsSync(path.join(wsDir, writtenId)))).toEqual([true, true]);

    expect(await adapter.deleteSession(writtenId, targetCwd)).toBe(true);

    for (const wsDir of targetWsDirs) {
      expect(fs.existsSync(path.join(wsDir, writtenId))).toBe(false);
    }

    // 同名会话在别的工作区另有副本，按 cwd 限定删除不能连带误删
    expect(fs.existsSync(path.join(instanceHistory(tmpHome), md5(cwdA), sourceId))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('replaces a history index that is a link with the index it writes, and leaves the linked file alone', async () => {
    seed();
    const adapter = new CodeBuddyIdeAdapter();
    const targetCwd = path.join(tmpHome, 'ws-linked');
    fs.mkdirSync(targetCwd, { recursive: true });
    const wsDir = path.join(instanceHistory(tmpHome), workspaceFolderOf(targetCwd));
    const linked = path.join(tmpHome, 'dotfiles-index.json');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(linked, JSON.stringify({ conversations: [] }));
    fs.symlinkSync(linked, path.join(wsDir, 'index.json'));

    const source = await adapter.readSession({ sessionId: '33333333333333333333333333333333', projectPath: cwdA });
    const writtenId = await adapter.writeSession({ ...source, title: 'linked' }, targetCwd);

    expect(fs.lstatSync(path.join(wsDir, 'index.json')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(wsDir, 'index.json'), 'utf-8')).toContain(writtenId);
    expect(JSON.parse(fs.readFileSync(linked, 'utf-8'))).toEqual({ conversations: [] });
  });

  it('refuses to write when the target cwd is not an absolute path', async () => {
    seed();
    const adapter = new CodeBuddyIdeAdapter();
    const source = await adapter.readSession({ sessionId: '33333333333333333333333333333333', projectPath: cwdA });

    await expect(adapter.writeSession({ ...source, cwd: 'md5:abc' })).rejects.toThrow(/absolute working directory/);
  });

  it('does not relabel the workspace when the global fallback finds the session elsewhere', async () => {
    seed();
    const adapter = new CodeBuddyIdeAdapter();

    // 会话在 cwdA 工作区，但用另一个 projectPath 读取 → 全局兜底命中。
    // cwd 必须标 md5 占位（真实工作区不可逆），绝不能冒充传入路径，
    // 否则下游按 session.cwd 派生的归档键会跟着错。
    const session = await adapter.readSession({ sessionId: '33333333333333333333333333333333', projectPath: '/tmp/other-project' });
    expect(session.cwd).toBe(`md5:${md5(cwdA)}`);

    // 对照：projectPath 与会话所在工作区一致时，cwd 就是该路径
    const direct = await adapter.readSession({ sessionId: '33333333333333333333333333333333', projectPath: cwdA });
    expect(direct.cwd).toBe(cwdA);
  });
});
