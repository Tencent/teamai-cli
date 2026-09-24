/**
 * migrate-image-and-cursor-id.test.ts — 迁移路径上的两个细节。
 *
 * 1. 本地→本地迁移（含 --scrub）时，只有 filePath、没有内联 data 的图片块要
 *    被读出来嵌入目标端；只有来自团队归档的会话才不许读本地文件。
 * 2. Cursor 的 composerId 派生要认同一个工作区的两种拼写（/tmp 与 /private/tmp）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ home: '' }));

// 适配器存储路径由 os.homedir() 派生，整体替换 home 才能用临时目录做 fixture。
vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & { default?: object };
  const patched: Record<string, unknown> = { ...actual, homedir: () => mocks.home };
  patched.default = { ...(actual.default ?? {}), homedir: () => mocks.home };
  return patched;
});

import { ClaudeCodeAdapter } from '../session-flow/adapters/claude-code.js';
import { CursorAdapter } from '../session-flow/adapters/cursor.js';
import type { Session } from '../session-flow/ir.js';

function mkSession(imageFilePath: string): Session {
  return {
    sessionId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    title: 'image migration',
    cwd: '/proj/alpha',
    platform: 'codebuddy-ide',
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:05.000Z',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', mimeType: 'image/png', filePath: imageFilePath, label: 'pic.png' },
        ],
      },
    ],
    metadata: {},
  };
}

/** 迁移后按 id 在目标工作区里找回落盘文件。 */
async function findWritten(
  adapter: ClaudeCodeAdapter,
  cwd: string,
  id: string,
): Promise<string> {
  const metas = await adapter.listConversations(cwd);
  const found = metas.find((m) => m.sessionId === id);
  if (!found?.filePath) throw new Error(`session ${id} not listed in ${cwd}`);
  return found.filePath;
}

beforeEach(() => {
  mocks.home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-img-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(mocks.home, { recursive: true, force: true });
  mocks.home = '';
});

describe('migrating an image that only has a local filePath', () => {
  it('embeds the file into claude-code instead of dropping the block', async () => {
    const pic = path.join(mocks.home, 'pic.png');
    fs.writeFileSync(pic, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const expected = fs.readFileSync(pic).toString('base64');

    fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
    const target = new ClaudeCodeAdapter();
    const cwd = path.join(mocks.home, 'work');

    const id = await target.writeSession(mkSession(pic), cwd);
    const text = fs.readFileSync(await findWritten(target, cwd, id), 'utf-8');
    expect(text).toContain(expected);
  });

  it('does not read the file for a session restored from the archive', async () => {
    const pic = path.join(mocks.home, 'secret.png');
    fs.writeFileSync(pic, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
    const secret = fs.readFileSync(pic).toString('base64');

    fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
    const session = mkSession(pic);
    session.metadata = { untrusted: true };

    const target = new ClaudeCodeAdapter();
    const cwd = path.join(mocks.home, 'work');
    const id = await target.writeSession(session, cwd);
    const text = fs.readFileSync(await findWritten(target, cwd, id), 'utf-8');
    expect(text).not.toContain(secret);
  });
});

describe('cursor composerId derivation', () => {
  it('gives one id to the two spellings of one workspace', async () => {
    fs.mkdirSync(path.join(mocks.home, '.cursor', 'projects'), { recursive: true });
    const adapter = new CursorAdapter();
    const real = path.join(fs.realpathSync(os.tmpdir()), 'teamai-cursor-cwd');
    fs.mkdirSync(real, { recursive: true });
    // /tmp is a symlink to /private/tmp on macOS: the unresolved spelling is
    // what a user types, the resolved one is what Cursor itself writes.
    const typed = path.join(os.tmpdir(), 'teamai-cursor-cwd');

    const [idTyped, idReal] = await Promise.all([
      adapter.writeSession(mkSession('/nope.png'), typed),
      adapter.writeSession(mkSession('/nope.png'), real),
    ]);
    expect(idTyped).toBe(idReal);
  });
});
