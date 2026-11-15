import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listIdeHistoryRoots, readIdeConversation, readIdeConversations } from './ide-history.js';
import { buildWorkspace, defaultInstanceHistory, ideDataIn, instanceHistory, type FixtureConv } from './testing/ide-history.js';

const dirs: string[] = [];
const releasers: ChildProcess[] = [];

afterEach(() => {
  for (const releaser of releasers.splice(0)) releaser.kill();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A FIFO at `file`, which another process opens and closes again and again from three seconds on, so a read that
 * waits on it ends then, rather than never.
 */
function fifoAt(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('mkfifo', [file]);
  releasers.push(spawn('sh', ['-c', 'sleep 3; while :; do exec 3<>"$1"; exec 3>&-; sleep 0.1; done', 'sh', file], { stdio: 'ignore' }));
}

function timed<T>(read: () => T): { value: T; ms: number } {
  const start = Date.now();
  const value = read();

  return { value, ms: Date.now() - start };
}

describe.skipIf(process.platform === 'win32')('CodeBuddy IDE history a step left as something other than files', () => {
  it('reads no conversations at once when a FIFO stands at the history index', () => {
    const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-ide-fifo-'));
    dirs.push(historyDir);
    fifoAt(path.join(historyDir, 'index.json'));

    const read = timed(() => readIdeConversations(historyDir));

    expect(read.value).toEqual([]);
    expect(read.ms).toBeLessThan(1_000);
  });

  it('skips a FIFO left at a conversation index or a message file, at once', () => {
    const convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-ide-fifo-'));
    dirs.push(convDir);
    fifoAt(path.join(convDir, 'index.json'));
    fifoAt(path.join(convDir, 'messages', 'm1.json'));

    const read = timed(() => readIdeConversation(convDir));

    expect(read.value).toEqual([]);
    expect(read.ms).toBeLessThan(1_000);
  });
});

describe('the CodeBuddy IDE history in its data directory', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cbide-'));
    dirs.push(tmpHome);
    vi.stubEnv('TEAMAI_CODEBUDDY_IDE_DATA', ideDataIn(tmpHome));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('listIdeHistoryRoots', () => {
    it('covers both layouts, including the default instance without an instId level', () => {
      fs.mkdirSync(instanceHistory(tmpHome), { recursive: true });
      fs.mkdirSync(defaultInstanceHistory(tmpHome), { recursive: true });

      const roots = listIdeHistoryRoots();
      expect(roots).toContain(instanceHistory(tmpHome));
      expect(roots).toContain(defaultInstanceHistory(tmpHome));
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
      const wsDir = buildWorkspace(instanceHistory(tmpHome), cwd, [conv]);
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
      const wsDir = buildWorkspace(instanceHistory(tmpHome), cwd, [conv]);
      const convDir = path.join(wsDir, conv.id);

      expect(readIdeConversation(convDir, 3)).toHaveLength(3);
    });
  });
});
