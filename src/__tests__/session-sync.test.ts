import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncManager, defaultSyncMeta, generateSessionName } from '../session-flow/sync.js';
import type { Session } from '../session-flow/ir.js';

/**
 * SyncManager 跨 repo 能力测试（M2）。
 *
 * 覆盖点：
 * - listAllRepoIdentities：canonical 反查（目录名编码有损，只能从 _index.json 读回）、
 *   损坏/无索引目录跳过、_unattributed 的纳入条件
 * - listSessionsAcrossRepos：跨 repo 合并、author 过滤、旧索引条目的 repoIdentity 回填
 * - saveSession 去重（P8）：sessionId+author 命中 → 原地更新，无 `_1` 副本；
 *   旧索引无 sessionId → 退化为名冲突路径
 * - rebuildIndex：幂等重建且保留 origin.sessionId
 */

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sync-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

function mkSession(o: Partial<Session> = {}): Session {
  return {
    sessionId: 's-1',
    title: 'fix payment',
    cwd: '/proj/alpha',
    platform: 'claude-code',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:05:05.000Z',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'implement payment retry' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ],
    metadata: {},
    ...o,
  };
}

function mkMeta(o: { sessionId?: string; author?: string; repoIdentity?: string | null } = {}) {
  return defaultSyncMeta(
    {
      platform: 'claude-code',
      author: o.author ?? 'alice',
      cwd: '/proj/alpha',
      sessionId: o.sessionId ?? 's-1',
      // 显式传 null（_unattributed）不能被默认值吞掉
      repoIdentity: o.repoIdentity === undefined ? 'github.com/org/alpha' : o.repoIdentity,
    },
    '2026-01-02T03:04:05.000Z',
  );
}

/** 与 SyncManager.repoDir 相同的编码规则（/ → _，保留字母数字和 . -）。 */
function repoDirOf(identity: string): string {
  return path.join(repoRoot, 'sessions', 'repos', identity.replace(/[^a-zA-Z0-9.-]/g, '_'));
}

function writeRepoIndex(identity: string, index: unknown): void {
  fs.mkdirSync(repoDirOf(identity), { recursive: true });
  fs.writeFileSync(path.join(repoDirOf(identity), '_index.json'), JSON.stringify(index));
}

function readRepoIndex(identity: string): { sessions: Array<Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(path.join(repoDirOf(identity), '_index.json'), 'utf-8'));
}

const unattrDir = () => path.join(repoRoot, 'sessions', '_unattributed');

describe('listAllRepoIdentities', () => {
  it('reverse-maps canonical identities from each repo _index.json', () => {
    // 目录名是编码后的（github.com_org_alpha），canonical 原文只能从索引反查
    writeRepoIndex('github.com/org/alpha', { version: 1, repoIdentity: 'github.com/org/alpha', updatedAt: '2026-01-01T00:00:00.000Z', sessions: [] });
    writeRepoIndex('gitlab.company.com/g/beta', { version: 1, repoIdentity: 'gitlab.company.com/g/beta', updatedAt: '2026-01-01T00:00:00.000Z', sessions: [] });

    const mgr = new SyncManager(repoRoot);
    expect(mgr.listAllRepoIdentities().sort()).toEqual(
      expect.arrayContaining(['github.com/org/alpha', 'gitlab.company.com/g/beta']),
    );
  });

  it('skips repos with corrupted or missing _index.json', () => {
    writeRepoIndex('github.com/org/alpha', { version: 1, repoIdentity: 'github.com/org/alpha', updatedAt: '2026-01-01T00:00:00.000Z', sessions: [] });
    // 损坏索引
    const corrupted = repoDirOf('gitlab.company.com/g/beta');
    fs.mkdirSync(corrupted, { recursive: true });
    fs.writeFileSync(path.join(corrupted, '_index.json'), '{ not valid json');
    // 无索引
    fs.mkdirSync(repoDirOf('example.com/no-index'), { recursive: true });

    const mgr = new SyncManager(repoRoot);
    expect(mgr.listAllRepoIdentities()).toEqual(['github.com/org/alpha']);
  });

  it('includes _unattributed when its _index.json exists', () => {
    writeRepoIndex('github.com/org/alpha', { version: 1, repoIdentity: 'github.com/org/alpha', updatedAt: '2026-01-01T00:00:00.000Z', sessions: [] });
    fs.mkdirSync(unattrDir(), { recursive: true });
    fs.writeFileSync(
      path.join(unattrDir(), '_index.json'),
      JSON.stringify({ version: 1, repoIdentity: null, updatedAt: '2026-01-01T00:00:00.000Z', sessions: [] }),
    );

    expect(new SyncManager(repoRoot).listAllRepoIdentities()).toEqual(
      expect.arrayContaining(['github.com/org/alpha', null]),
    );
  });

  it('includes _unattributed when it has session content but no index', () => {
    fs.mkdirSync(path.join(unattrDir(), 'bob'), { recursive: true });

    expect(new SyncManager(repoRoot).listAllRepoIdentities()).toEqual([null]);
  });

  it('excludes an empty _unattributed directory', () => {
    writeRepoIndex('github.com/org/alpha', { version: 1, repoIdentity: 'github.com/org/alpha', updatedAt: '2026-01-01T00:00:00.000Z', sessions: [] });
    fs.mkdirSync(unattrDir(), { recursive: true });

    expect(new SyncManager(repoRoot).listAllRepoIdentities()).toEqual(['github.com/org/alpha']);
  });

  it('returns an empty list for an empty team repo', () => {
    expect(new SyncManager(repoRoot).listAllRepoIdentities()).toEqual([]);
  });
});

describe('listSessionsAcrossRepos', () => {
  it('merges sessions from every repo and _unattributed', () => {
    const mgr = new SyncManager(repoRoot);
    mgr.saveSession(mkSession({ sessionId: 'a-1', title: 'alpha task' }), mkMeta({ sessionId: 'a-1', repoIdentity: 'github.com/org/alpha' }));
    mgr.saveSession(mkSession({ sessionId: 'b-1', title: 'beta task' }), mkMeta({ sessionId: 'b-1', author: 'bob', repoIdentity: 'gitlab.company.com/g/beta' }));
    mgr.saveSession(mkSession({ sessionId: 'c-1', title: 'plain task' }), mkMeta({ sessionId: 'c-1', author: 'carol', repoIdentity: null }));

    const all = mgr.listSessionsAcrossRepos();
    expect(all.map((s) => s.sessionId).sort()).toEqual(['a-1', 'b-1', 'c-1']);
    // 每个条目都带 repoIdentity，标识来源 repo（null → _unattributed）
    expect(all.find((s) => s.sessionId === 'a-1')?.repoIdentity).toBe('github.com/org/alpha');
    expect(all.find((s) => s.sessionId === 'b-1')?.repoIdentity).toBe('gitlab.company.com/g/beta');
    expect(all.find((s) => s.sessionId === 'c-1')?.repoIdentity).toBeNull();
  });

  it('filters by author across repos', () => {
    const mgr = new SyncManager(repoRoot);
    mgr.saveSession(mkSession({ sessionId: 'a-1', title: 'alpha alice' }), mkMeta({ sessionId: 'a-1', author: 'alice', repoIdentity: 'github.com/org/alpha' }));
    mgr.saveSession(mkSession({ sessionId: 'b-1', title: 'beta bob' }), mkMeta({ sessionId: 'b-1', author: 'bob', repoIdentity: 'gitlab.company.com/g/beta' }));
    mgr.saveSession(mkSession({ sessionId: 'c-1', title: 'plain alice' }), mkMeta({ sessionId: 'c-1', author: 'alice', repoIdentity: null }));

    const byAlice = mgr.listSessionsAcrossRepos('alice');
    expect(byAlice.map((s) => s.sessionId).sort()).toEqual(['a-1', 'c-1']);
  });

  it('backfills repoIdentity for legacy index entries that lack it', () => {
    // 旧格式索引条目没有 repoIdentity 字段 → 用所在 repo 的 identity 回填，
    // 展示层（list --all 的 SOURCE 列）依赖它
    writeRepoIndex('github.com/org/alpha', {
      version: 1,
      repoIdentity: 'github.com/org/alpha',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sessions: [
        { sessionName: 'old_x', author: 'alice', platform: 'claude-code', title: 'x', cwd: '/p', messageCount: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active' },
      ],
    });
    fs.mkdirSync(unattrDir(), { recursive: true });
    fs.writeFileSync(
      path.join(unattrDir(), '_index.json'),
      JSON.stringify({ version: 1, repoIdentity: null, updatedAt: '2026-01-01T00:00:00.000Z', sessions: [
        { sessionName: 'old_y', author: 'bob', platform: 'codex', title: 'y', cwd: '/q', messageCount: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active' },
      ] }),
    );

    const all = new SyncManager(repoRoot).listSessionsAcrossRepos();
    expect(all.find((s) => s.sessionName === 'old_x')?.repoIdentity).toBe('github.com/org/alpha');
    expect(all.find((s) => s.sessionName === 'old_y')?.repoIdentity).toBeNull();
  });
});

describe('saveSession dedup (origin sessionId + author)', () => {
  it('updates the existing entry in place instead of creating a _1 duplicate', () => {
    const mgr = new SyncManager(repoRoot);
    mgr.saveSession(mkSession({ title: 'fix payment', messages: mkSession().messages }), mkMeta());

    // 同一 sessionId + author 再推（内容有更新）→ 复用原 sessionName 覆盖写
    const second = mkSession({
      title: 'fix payment v2',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'implement payment retry' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'halfway' }] },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
    });
    mgr.saveSession(second, mkMeta());

    const authorDir = path.join(repoDirOf('github.com/org/alpha'), 'alice');
    const jsonls = fs.readdirSync(authorDir).filter((f) => f.endsWith('.jsonl'));
    expect(jsonls).toEqual(['claude-code_fix-payment_20260102.jsonl']); // 无 _1 副本

    const idx = readRepoIndex('github.com/org/alpha');
    expect(idx.sessions).toHaveLength(1);
    expect(idx.sessions[0]).toMatchObject({
      title: 'fix payment v2',
      sessionId: 's-1',
      messageCount: 3,
    });
  });

  it('treats the same sessionId under a different author as a separate session', () => {
    const mgr = new SyncManager(repoRoot);
    mgr.saveSession(mkSession({ sessionId: 'shared-1', title: 'shared' }), mkMeta({ sessionId: 'shared-1', author: 'alice' }));
    mgr.saveSession(mkSession({ sessionId: 'shared-1', title: 'shared' }), mkMeta({ sessionId: 'shared-1', author: 'bob' }));

    const repoDir = repoDirOf('github.com/org/alpha');
    expect(fs.existsSync(path.join(repoDir, 'alice', 'claude-code_shared_20260102.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, 'bob', 'claude-code_shared_20260102.jsonl'))).toBe(true);

    const idx = readRepoIndex('github.com/org/alpha');
    expect(idx.sessions).toHaveLength(2);
    // 两个条目都带 sessionId，去重键按 author 区分
    expect(idx.sessions.every((s) => s.sessionId === 'shared-1')).toBe(true);
    expect(idx.sessions.map((s) => s.author).sort()).toEqual(['alice', 'bob']);
  });

  it('falls back to name-conflict suffixes when the legacy index has no sessionId', () => {
    // 旧索引条目没有 sessionId → 按 sessionId 查重查不到 → 走旧的
    // resolveNameConflict 路径，生成 _1 副本（兼容旧行为）
    const base = generateSessionName('claude-code', 'fix payment', '2026-01-02T03:04:05.000Z');
    const authorDir = path.join(repoDirOf('github.com/org/alpha'), 'alice');
    fs.mkdirSync(authorDir, { recursive: true });
    fs.writeFileSync(path.join(authorDir, `${base}.jsonl`), '{"role":"user"}\n');
    writeRepoIndex('github.com/org/alpha', {
      version: 1,
      repoIdentity: 'github.com/org/alpha',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sessions: [
        { sessionName: base, author: 'alice', platform: 'claude-code', title: 'fix payment', cwd: '/p', messageCount: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active' },
      ],
    });

    const mgr = new SyncManager(repoRoot);
    mgr.saveSession(mkSession({ sessionId: 'new-1' }), mkMeta({ sessionId: 'new-1' }));

    expect(fs.existsSync(path.join(authorDir, `${base}_1.jsonl`))).toBe(true);
    expect(readRepoIndex('github.com/org/alpha').sessions).toHaveLength(2);
  });
});

describe('rebuildIndex', () => {
  it('preserves origin sessionId in rebuilt entries', () => {
    const mgr = new SyncManager(repoRoot);
    mgr.saveSession(mkSession(), mkMeta());

    // 索引损坏后重建
    fs.writeFileSync(path.join(repoDirOf('github.com/org/alpha'), '_index.json'), '{ corrupted');

    const count = mgr.rebuildIndex('github.com/org/alpha');
    expect(count).toBe(1);

    const idx = readRepoIndex('github.com/org/alpha');
    expect(idx.sessions[0]).toMatchObject({ sessionName: 'claude-code_fix-payment_20260102', sessionId: 's-1' });
  });

  it('is idempotent across repeated rebuilds', () => {
    const mgr = new SyncManager(repoRoot);
    mgr.saveSession(mkSession(), mkMeta());

    expect(mgr.rebuildIndex('github.com/org/alpha')).toBe(1);
    expect(mgr.rebuildIndex('github.com/org/alpha')).toBe(1);
    expect(readRepoIndex('github.com/org/alpha').sessions).toHaveLength(1);
  });
});
