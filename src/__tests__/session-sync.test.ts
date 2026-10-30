import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SyncManager,
  defaultSyncMeta,
  generateSessionName,
  encodeRepoIdentity,
  decodeRepoIdentity,
  canonicalizeRemote,
  archivedCwd,
  type ArchiveWriteResult,
  withSessionIndexLock,
  withSessionPublicationLock,
} from '../session-flow/sync.js';
import type { Session } from '../session-flow/ir.js';

function written<T>(result: ArchiveWriteResult<T>): T {
  expect(result.status).toBe('written');
  if (result.status === 'busy') throw new Error(`unexpected busy archive: ${result.lockPath}`);
  return result.value;
}

// Keep the named filesystem boundary live so fault injection reaches sync.ts.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => fs.renameSync(...args) };
});

/**
 * SyncManager 跨 repo 能力测试（M2）。
 *
 * 覆盖点：
 * - listAllRepoIdentities：canonical 反查（目录名编码有损，只能从 _index.json 读回）、
 *   损坏/无索引目录跳过、_unattributed 的纳入条件
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

function mkMeta(o: { sessionId?: string; author?: string; repoIdentity?: string | null; title?: string } = {}) {
  return defaultSyncMeta(
    {
      platform: 'claude-code',
      author: o.author ?? 'alice',
      cwd: '/proj/alpha',
      sessionId: o.sessionId ?? 's-1',
      title: o.title,
      // 显式传 null（_unattributed）不能被默认值吞掉
      repoIdentity: o.repoIdentity === undefined ? 'github.com/org/alpha' : o.repoIdentity,
    },
    '2026-01-02T03:04:05.000Z',
  );
}

/** 与 SyncManager.repoDir 相同的编码规则（非白名单字符 → ~XX）。 */
function repoDirOf(identity: string): string {
  return path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity(identity));
}

function writeRepoIndex(identity: string, index: unknown): void {
  fs.mkdirSync(repoDirOf(identity), { recursive: true });
  fs.writeFileSync(path.join(repoDirOf(identity), '_index.json'), JSON.stringify(index));
}

function readRepoIndex(identity: string): { sessions: Array<Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(path.join(repoDirOf(identity), '_index.json'), 'utf-8'));
}

const unattrDir = () => path.join(repoRoot, 'sessions', '_unattributed');

describe('archivedCwd', () => {
  it('stores a git workspace root as dot and keeps its monorepo subdirectory', async () => {
    const workspace = path.join(repoRoot, 'workspace');
    const nested = path.join(workspace, 'packages', 'api');
    fs.mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', ['-C', workspace, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-qm', 'init']);

    await expect(archivedCwd(workspace)).resolves.toBe('.');
    await expect(archivedCwd(nested)).resolves.toBe('packages/api');
  });

  it('uses the configured non-git project root and omits paths with no known boundary', async () => {
    const project = path.join(repoRoot, 'plain-project');
    const nested = path.join(project, 'backend');
    fs.mkdirSync(nested, { recursive: true });

    await expect(archivedCwd(nested, project)).resolves.toBe('backend');
    await expect(archivedCwd(path.join(repoRoot, 'scratch'))).resolves.toBe('');
    await expect(archivedCwd('md5:3f2a')).resolves.toBe('');
  });

  it('keeps a valid child whose name starts with two dots', async () => {
    const project = path.join(repoRoot, 'plain-project');
    const nested = path.join(project, '..cache');
    fs.mkdirSync(nested, { recursive: true });

    await expect(archivedCwd(nested, project)).resolves.toBe('..cache');
    await expect(archivedCwd(path.join(project, '..', 'outside'), project)).resolves.toBe('');
  });

  it('resolves a symlinked cwd against the real workspace root', async () => {
    const project = path.join(repoRoot, 'plain-project');
    const nested = path.join(project, 'packages', 'api');
    const link = path.join(repoRoot, 'workspace-link');
    fs.mkdirSync(nested, { recursive: true });
    try {
      fs.symlinkSync(project, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(archivedCwd(path.join(link, 'packages', 'api'), project)).resolves.toBe('packages/api');
  });

  it('stores the normalized cwd in both saved metadata and a rebuilt index', async () => {
    const workspace = path.join(repoRoot, 'workspace');
    const nested = path.join(workspace, 'packages', 'api');
    fs.mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', ['-C', workspace, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-qm', 'init']);

    const identity = 'github.com/org/alpha';
    const mgr = new SyncManager(repoRoot);
    const saved = written(await mgr.saveSession(
      mkSession({ cwd: nested }),
      defaultSyncMeta({
        platform: 'claude-code', author: 'alice', cwd: nested, sessionId: 'relative-cwd', repoIdentity: identity,
      }, '2026-01-02T03:04:05.000Z'),
    ));
    const entry = mgr.listSessions(identity)[0];
    expect(entry.cwd).toBe('packages/api');
    expect(mgr.loadSession(identity, path.basename(saved, '.jsonl'), 'alice').meta.origin.cwd).toBe('packages/api');

    await mgr.rebuildIndex(identity);
    expect(mgr.listSessions(identity)[0].cwd).toBe('packages/api');
  });
});

describe('archive save rollback', () => {
  it.each([false, true].flatMap((existing) => ['index', 'metadata'].map((failure) => ({ existing, failure }))))('restores the previous pair after a $failure rename fails (existing: $existing)', async ({ existing, failure }) => {
    const mgr = new SyncManager(repoRoot);
    if (existing) await mgr.saveSession(mkSession(), mkMeta());
    const before = fs.readdirSync(repoRoot, { recursive: true }).map(String).filter((p) => fs.statSync(path.join(repoRoot, p)).isFile());
    const bytes = new Map(before.map((p) => [p, fs.readFileSync(path.join(repoRoot, p))]));
    const rename = fs.renameSync;
    const fail = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (failure === 'index' ? String(to).endsWith('_index.json') : String(to).endsWith('.meta.json') && String(from).endsWith('.tmp')) {
        throw new Error('injected archive rename failure');
      }
      return rename(from, to);
    });
    try {
      await expect(mgr.saveSession(mkSession({ messages: [{ role: 'user', content: [{ type: 'text', text: 'new transcript' }] }] }), mkMeta()))
        .rejects.toThrow('injected archive rename failure');
    } finally { fail.mockRestore(); }
    const after = fs.readdirSync(repoRoot, { recursive: true }).map(String).filter((p) => fs.statSync(path.join(repoRoot, p)).isFile());
    expect(after.sort()).toEqual(before.sort());
    for (const [p, content] of bytes) expect(fs.readFileSync(path.join(repoRoot, p))).toEqual(content);
    const saved = written(await mgr.saveSession(mkSession(), mkMeta()));
    expect(saved).not.toMatch(/_1\.jsonl$/);
    expect(readRepoIndex('github.com/org/alpha').sessions).toHaveLength(1);
  });
});

it('holds publication ownership through Git work and releases it after failure', async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredFirst = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withSessionPublicationLock(repoRoot, async () => { entered(); await gate; return 'published'; });
  await enteredFirst;
  let ranSecond = false;
  const second = withSessionPublicationLock(repoRoot, async () => { ranSecond = true; return 'second'; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(ranSecond).toBe(false);
  release();
  expect(await first).toEqual({ status: 'done', value: 'published' });
  expect(await second).toEqual({ status: 'done', value: 'second' });
  await expect(withSessionPublicationLock(repoRoot, async () => { throw new Error('push failed'); })).rejects.toThrow('push failed');
  expect(await withSessionPublicationLock(repoRoot, async () => 'retry')).toEqual({ status: 'done', value: 'retry' });
});

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

  it('includes _unattributed when the only author directory starts with an underscore', () => {
    fs.mkdirSync(path.join(unattrDir(), '_bob'), { recursive: true });

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

describe('saveSession dedup (origin sessionId + author)', () => {
  it('updates the existing entry in place instead of creating a _1 duplicate', async () => {
    const mgr = new SyncManager(repoRoot);
    await mgr.saveSession(mkSession({ title: 'fix payment', messages: mkSession().messages }), mkMeta());

    // 同一 sessionId + author 再推（内容有更新）→ 复用原 sessionName 覆盖写
    const second = mkSession({
      title: 'fix payment v2',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'implement payment retry' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'halfway' }] },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
    });
    await mgr.saveSession(second, mkMeta());

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

  it('treats the same sessionId under a different author as a separate session', async () => {
    const mgr = new SyncManager(repoRoot);
    await mgr.saveSession(mkSession({ sessionId: 'shared-1', title: 'shared' }), mkMeta({ sessionId: 'shared-1', author: 'alice' }));
    await mgr.saveSession(mkSession({ sessionId: 'shared-1', title: 'shared' }), mkMeta({ sessionId: 'shared-1', author: 'bob' }));

    const repoDir = repoDirOf('github.com/org/alpha');
    expect(fs.existsSync(path.join(repoDir, 'alice', 'claude-code_shared_20260102.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, 'bob', 'claude-code_shared_20260102.jsonl'))).toBe(true);

    const idx = readRepoIndex('github.com/org/alpha');
    expect(idx.sessions).toHaveLength(2);
    // 两个条目都带 sessionId，去重键按 author 区分
    expect(idx.sessions.every((s) => s.sessionId === 'shared-1')).toBe(true);
    expect(idx.sessions.map((s) => s.author).sort()).toEqual(['alice', 'bob']);
  });

  it('falls back to name-conflict suffixes when the legacy index has no sessionId', async () => {
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
    await mgr.saveSession(mkSession({ sessionId: 'new-1' }), mkMeta({ sessionId: 'new-1' }));

    expect(fs.existsSync(path.join(authorDir, `${base}_1.jsonl`))).toBe(true);
    expect(readRepoIndex('github.com/org/alpha').sessions).toHaveLength(2);
  });

  it('rebuilds a missing index before dedup so a re-push keeps the other sessions', async () => {
    const mgr = new SyncManager(repoRoot);
    await mgr.saveSession(mkSession({ sessionId: 's-1', title: 'fix payment' }), mkMeta({ sessionId: 's-1' }));
    await mgr.saveSession(mkSession({ sessionId: 's-2', title: 'other task' }), mkMeta({ sessionId: 's-2' }));
    fs.unlinkSync(path.join(repoDirOf('github.com/org/alpha'), '_index.json'));

    await mgr.saveSession(mkSession({ sessionId: 's-1', title: 'fix payment v2' }), mkMeta({ sessionId: 's-1' }));

    const authorDir = path.join(repoDirOf('github.com/org/alpha'), 'alice');
    const jsonls = fs.readdirSync(authorDir).filter((f) => f.endsWith('.jsonl'));
    expect(jsonls.some((f) => f.includes('_1'))).toBe(false);
    const sessions = readRepoIndex('github.com/org/alpha').sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.sessionId === 's-1')).toMatchObject({ title: 'fix payment v2' });
    expect(sessions.find((s) => s.sessionId === 's-2')).toBeTruthy();
  });
});

describe('withSessionIndexLock', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sync-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('the public archive save waits for the index lock without a caller wrapper', async () => {
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const held = withSessionIndexLock(repoRoot, async () => { ready(); await gate; });
    await started;
    const saving = new SyncManager(repoRoot).saveSession(mkSession(), mkMeta());
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fs.existsSync(path.join(repoRoot, 'sessions'))).toBe(false);
    } finally { release(); }
    await held;
    await saving;
    expect(readRepoIndex('github.com/org/alpha').sessions).toHaveLength(1);
  });

  it('lands both of two concurrent public saves with the same title and day', async () => {
    const mgr = new SyncManager(repoRoot);
    const [a, b] = await Promise.all([
      mgr.saveSession(mkSession({ sessionId: 's-a' }), mkMeta({ sessionId: 's-a' })),
      mgr.saveSession(mkSession({ sessionId: 's-b' }), mkMeta({ sessionId: 's-b' })),
    ]);
    expect([a, b].map((result) => written(result)).sort()).toEqual([
      expect.stringMatching(/claude-code_fix-payment_20260102\.jsonl$/),
      expect.stringMatching(/claude-code_fix-payment_20260102_1\.jsonl$/),
    ]);
    const sessions = readRepoIndex('github.com/org/alpha').sessions;
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['s-a', 's-b']);
  });

  it('keeps its lock file under the TeamAI home, never inside the team repo', async () => {
    const held = await withSessionIndexLock(repoRoot, async () => ({
      locks: fs.readdirSync(path.join(home, '.teamai', 'locks')),
      repoFiles: fs.readdirSync(repoRoot, { recursive: true }).map(String),
    }));

    expect(held).toEqual({
      status: 'done',
      value: { locks: [expect.stringMatching(/^sessions-[0-9a-f]{16}\.lock$/)], repoFiles: [] },
    });
  });
});

describe('rebuildIndex', () => {
  it('preserves origin sessionId in rebuilt entries', async () => {
    const mgr = new SyncManager(repoRoot);
    await mgr.saveSession(mkSession(), mkMeta());

    // 索引损坏后重建
    fs.writeFileSync(path.join(repoDirOf('github.com/org/alpha'), '_index.json'), '{ corrupted');

    const count = written(await mgr.rebuildIndex('github.com/org/alpha'));
    expect(count).toBe(1);

    const idx = readRepoIndex('github.com/org/alpha');
    expect(idx.sessions[0]).toMatchObject({ sessionName: 'claude-code_fix-payment_20260102', sessionId: 's-1' });
  });

  it('keeps an author directory whose name starts with an underscore', async () => {
    const mgr = new SyncManager(repoRoot);
    await mgr.saveSession(mkSession(), mkMeta({ author: '_alice' }));
    fs.unlinkSync(path.join(repoDirOf('github.com/org/alpha'), '_index.json'));

    expect(written(await mgr.rebuildIndex('github.com/org/alpha'))).toBe(1);
    expect(readRepoIndex('github.com/org/alpha').sessions[0]).toMatchObject({ author: '_alice', sessionId: 's-1' });
  });

  it('is idempotent across repeated rebuilds', async () => {
    const mgr = new SyncManager(repoRoot);
    await mgr.saveSession(mkSession(), mkMeta());

    expect(written(await mgr.rebuildIndex('github.com/org/alpha'))).toBe(1);
    expect(written(await mgr.rebuildIndex('github.com/org/alpha'))).toBe(1);
    expect(readRepoIndex('github.com/org/alpha').sessions).toHaveLength(1);
  });

  it('keeps the original title and author instead of the sanitized directory name', async () => {
    // The author directory is sanitized (`alice:ci` → `alice_ci`) and the file
    // name is a truncated slug; rebuilding from those destroyed both fields.
    const mgr = new SyncManager(repoRoot);
    await mgr.saveSession(
      mkSession({ title: 'Fix Payment Retry Logic' }),
      mkMeta({ author: 'alice:ci', repoIdentity: 'github.com/org/alpha', title: 'Fix Payment Retry Logic' }),
    );

    fs.writeFileSync(path.join(repoDirOf('github.com/org/alpha'), '_index.json'), '{ corrupted');
    await mgr.rebuildIndex('github.com/org/alpha');

    const entry = readRepoIndex('github.com/org/alpha').sessions[0];
    expect(entry.author).toBe('alice:ci');
    expect(entry.title).toBe('Fix Payment Retry Logic');
  });

  it('rebuilds repos whose index is missing entirely (pull --all repair path)', async () => {
    const mgr = new SyncManager(repoRoot);
    await mgr.saveSession(mkSession(), mkMeta());

    // 删掉索引后，listAllRepoIdentities 反查不到 → 只有按目录重建才能修回来
    fs.unlinkSync(path.join(repoDirOf('github.com/org/alpha'), '_index.json'));
    expect(new SyncManager(repoRoot).listAllRepoIdentities()).toEqual([]);

    const { repos, sessions } = written(await new SyncManager(repoRoot).rebuildAllIndexes());
    expect(repos).toBe(1);
    expect(sessions).toBe(1);
    expect(new SyncManager(repoRoot).listAllRepoIdentities()).toEqual(['github.com/org/alpha']);
  });

  it('repairs a corrupted index instead of overwriting it with the new entry', async () => {
    // A corrupted index used to be read as empty, so the next upsert wrote a
    // one-entry index and every other session of that repo vanished from
    // `list` -- while their files were still on disk.
    const mgr = new SyncManager(repoRoot);
    await mgr.saveSession(
      mkSession({ sessionId: 'first', title: 'first session' }),
      mkMeta({ sessionId: 'first' }),
    );
    fs.writeFileSync(path.join(repoDirOf('github.com/org/alpha'), '_index.json'), '{ broken');

    await mgr.saveSession(
      mkSession({ sessionId: 'second', title: 'second session' }),
      mkMeta({ sessionId: 'second' }),
    );

    const idx = readRepoIndex('github.com/org/alpha');
    expect(idx.sessions.map((s) => s.sessionId).sort()).toEqual(['first', 'second']);
  });

  it('makes a legacy _-folded repository directory readable again', async () => {
    const mgr = new SyncManager(repoRoot);
    await mgr.saveSession(mkSession(), mkMeta());

    // Simulate a directory written by the old '_'-folding encoder.
    const reposDir = path.join(repoRoot, 'sessions', 'repos');
    fs.renameSync(
      path.join(reposDir, encodeRepoIdentity('github.com/org/alpha')),
      path.join(reposDir, 'github.com_org_alpha'),
    );
    fs.unlinkSync(path.join(reposDir, 'github.com_org_alpha', '_index.json'));

    const { repos, sessions } = written(await new SyncManager(repoRoot).rebuildAllIndexes());
    expect(repos).toBe(1);
    expect(sessions).toBe(1);

    // Reads resolve the encoded name, so the directory has to move there --
    // otherwise the rebuilt index is written somewhere nothing ever reads.
    expect(fs.existsSync(path.join(reposDir, 'github.com_org_alpha'))).toBe(false);
    expect(
      fs.existsSync(path.join(reposDir, encodeRepoIdentity('github.com/org/alpha'), '_index.json')),
    ).toBe(true);
    const after = new SyncManager(repoRoot);
    expect(after.listAllRepoIdentities()).toEqual(['github.com/org/alpha']);
    expect(after.listSessions('github.com/org/alpha')).toHaveLength(1);
  });
});

describe('session pull (gitPull + rebuildIndex) on a team checkout', () => {
  const identity = 'github.com/org/alpha';
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  function initCheckout(dir: string, name: string): void {
    git(dir, 'config', 'user.name', name);
    git(dir, 'config', 'user.email', `${name}@example.com`);
  }

  async function pushSession(checkout: string, sessionId: string, title: string): Promise<void> {
    const mgr = new SyncManager(checkout);
    await mgr.saveSession(mkSession({ sessionId, title }), mkMeta({ sessionId, title }));
    expect(mgr.gitCommit(`push ${title}`).status).toBe('committed');
    mgr.gitPush();
  }

  async function pull(checkout: string): Promise<void> {
    const mgr = new SyncManager(checkout);
    mgr.gitPull();
    await mgr.rebuildIndex(identity);
  }

  it('leaves the checkout clean when nothing changed, so the next index change merges', async () => {
    const remote = path.join(repoRoot, 'team.git');
    git(repoRoot, 'init', '-q', '--bare', '-b', 'main', remote);
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    git(alice, 'remote', 'add', 'origin', remote);
    await pushSession(alice, 's-1', 'fix payment');
    const bob = path.join(repoRoot, 'bob');
    git(repoRoot, 'clone', '-q', remote, bob);
    initCheckout(bob, 'bob');

    await pull(bob);
    await pull(bob);
    expect(git(bob, 'status', '--porcelain')).toBe('');

    await pushSession(alice, 's-2', 'add refunds');
    await pull(bob);
    expect(git(bob, 'status', '--porcelain')).toBe('');
    expect(new SyncManager(bob).listSessions(identity).map((s) => s.sessionId).sort()).toEqual(['s-1', 's-2']);
  });

  it('moves a %-escaped repository directory to its current name in the next push', async () => {
    const remote = path.join(repoRoot, 'team.git');
    git(repoRoot, 'init', '-q', '--bare', '-b', 'main', remote);
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    git(alice, 'remote', 'add', 'origin', remote);
    await pushSession(alice, 's-1', 'fix payment');
    // The archive as the previous encoder named it.
    git(alice, 'mv', `sessions/repos/${encodeRepoIdentity(identity)}`, 'sessions/repos/github.com%2Forg%2Falpha');
    git(alice, 'commit', '-qm', 'previous layout');
    git(alice, 'push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(alice, 'sessions', 'repos', 'github.com%2Forg%2Falpha', 'notes.txt'), 'local only\n');

    await pushSession(alice, 's-2', 'add refunds');

    const pushed = git(remote, 'ls-tree', '-r', '--name-only', 'main', 'sessions/repos').split('\n');
    expect(pushed.filter((p) => p.includes('%') || p.endsWith('notes.txt'))).toEqual([]);
    expect(git(alice, 'status', '--porcelain')).toBe(`?? sessions/repos/${encodeRepoIdentity(identity)}/notes.txt`);
    expect(new SyncManager(alice).listSessions(identity).map((s) => s.sessionId).sort()).toEqual(['s-1', 's-2']);
  });

  it('undoes a move whose commit is rejected, and moves the archive on a later push, leaving unrelated files out', async () => {
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    const first = new SyncManager(alice);
    await first.saveSession(mkSession(), mkMeta());
    expect(first.gitCommit('push').status).toBe('committed');
    git(alice, 'mv', `sessions/repos/${encodeRepoIdentity(identity)}`, 'sessions/repos/github.com%2Forg%2Falpha');
    git(alice, 'commit', '-qm', 'previous layout');
    fs.writeFileSync(path.join(alice, 'sessions', 'repos', 'github.com%2Forg%2Falpha', 'notes.txt'), 'local only\n');
    const hook = path.join(alice, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const before = git(alice, 'rev-parse', 'HEAD');

    const rejected = new SyncManager(alice);
    await rejected.saveSession(mkSession({ sessionId: 's-2', title: 'add refunds' }), mkMeta({ sessionId: 's-2' }));
    expect(rejected.gitCommit('push').status).toBe('failed');
    expect(git(alice, 'rev-parse', 'HEAD')).toBe(before);
    expect(fs.existsSync(repoDirOf(identity).replace(repoRoot, alice))).toBe(false);
    fs.rmSync(hook);
    for (const sessionId of ['s-2', 's-3']) {
      const mgr = new SyncManager(alice);
      await mgr.saveSession(mkSession({ sessionId, title: `session ${sessionId}` }), mkMeta({ sessionId }));
      expect(mgr.gitCommit('push').status).toBe('committed');
    }

    const committed = git(alice, 'ls-tree', '-r', '--name-only', 'HEAD', 'sessions/repos').split('\n');
    expect(committed.filter((p) => p.includes('%') || p.endsWith('notes.txt'))).toEqual([]);
    expect(committed.filter((p) => p.endsWith('.jsonl'))).toHaveLength(3);
    expect(git(alice, 'status', '--porcelain')).toBe(`?? sessions/repos/${encodeRepoIdentity(identity)}/notes.txt`);
  });

  it('folds sessions an older CLI pushed under the %-escaped name after the move into the current directory, once each', async () => {
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    const first = new SyncManager(alice);
    await first.saveSession(mkSession(), mkMeta());
    expect(first.gitCommit('push').status).toBe('committed');
    // An older CLI pushes, under the %XX name next to the moved directory: s-1 again after its title changed,
    // s-3, and s-4, whose title and date give it the file name s-1 has in the current directory.
    const older = path.join(repoRoot, 'older');
    const olderMgr = new SyncManager(older);
    await olderMgr.saveSession(mkSession({ title: 'fix payment retries' }), mkMeta());
    await olderMgr.saveSession(mkSession({ sessionId: 's-3', title: 'add invoices' }), mkMeta({ sessionId: 's-3' }));
    await olderMgr.saveSession(mkSession({ sessionId: 's-4' }), mkMeta({ sessionId: 's-4' }));
    fs.cpSync(
      path.join(older, 'sessions', 'repos', encodeRepoIdentity(identity)),
      path.join(alice, 'sessions', 'repos', 'github.com%2Forg%2Falpha'),
      { recursive: true },
    );
    git(alice, 'add', '-A');
    git(alice, 'commit', '-qm', 'older CLI push');

    const mgr = new SyncManager(alice);
    await mgr.saveSession(mkSession({ sessionId: 's-2', title: 'add refunds' }), mkMeta({ sessionId: 's-2' }));
    expect(mgr.gitCommit('push').status).toBe('committed');

    const committed = git(alice, 'ls-tree', '-r', '--name-only', 'HEAD', 'sessions/repos').split('\n');
    expect(committed.filter((p) => p.includes('%'))).toEqual([]);
    expect(committed.filter((p) => p.endsWith('.jsonl'))).toHaveLength(4);
    expect(git(alice, 'status', '--porcelain')).toBe('');
    expect(new SyncManager(alice).listSessions(identity).map((s) => s.sessionId).sort()).toEqual(['s-1', 's-2', 's-3', 's-4']);
  });

  it('restores the percent-escaped directory when a rejected fold had only untracked files under the current name', async () => {
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    const first = new SyncManager(alice);
    await first.saveSession(mkSession(), mkMeta());
    expect(first.gitCommit('push').status).toBe('committed');
    git(alice, 'mv', `sessions/repos/${encodeRepoIdentity(identity)}`, 'sessions/repos/github.com%2Forg%2Falpha');
    git(alice, 'commit', '-qm', 'previous layout');
    const current = repoDirOf(identity).replace(repoRoot, alice);
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, 'notes.txt'), 'local only\n');
    const session = 'sessions/repos/github.com%2Forg%2Falpha/alice/claude-code_fix-payment_20260102.jsonl';
    const original = git(alice, 'show', `HEAD:${session}`);
    fs.writeFileSync(path.join(alice, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const rejected = new SyncManager(alice);
    await rejected.saveSession(mkSession({ sessionId: 's-2', title: 'add refunds' }), mkMeta({ sessionId: 's-2' }));
    expect(rejected.gitCommit('push').status).toBe('failed');

    expect(fs.readFileSync(path.join(alice, session), 'utf-8').trim()).toBe(original);
  });

  it('keeps a session under the percent-escaped name when the current name holds it only as untracked files', async () => {
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    const first = new SyncManager(alice);
    await first.saveSession(mkSession({ sessionId: 's-2', title: 'add refunds' }), mkMeta({ sessionId: 's-2' }));
    expect(first.gitCommit('push').status).toBe('committed');
    // With no committed index under the current name, its repair reads the local-only copy below as held.
    git(alice, 'rm', '-q', `sessions/repos/${encodeRepoIdentity(identity)}/_index.json`);
    git(alice, 'commit', '-qm', 'lose the index');
    // An older CLI pushed s-1 under the %XX name; a local-only copy of it sits under the current name.
    const older = path.join(repoRoot, 'older');
    await new SyncManager(older).saveSession(mkSession(), mkMeta());
    const olderDir = path.join(older, 'sessions', 'repos', encodeRepoIdentity(identity));
    fs.cpSync(olderDir, path.join(alice, 'sessions', 'repos', 'github.com%2Forg%2Falpha'), { recursive: true });
    git(alice, 'add', '-A');
    git(alice, 'commit', '-qm', 'older CLI push');
    fs.cpSync(path.join(olderDir, 'alice'), path.join(repoDirOf(identity).replace(repoRoot, alice), 'alice'), { recursive: true });

    const mgr = new SyncManager(alice);
    await mgr.saveSession(mkSession({ sessionId: 's-3', title: 'add invoices' }), mkMeta({ sessionId: 's-3' }));
    expect(mgr.gitCommit('push').status).toBe('committed');

    const committed = git(alice, 'ls-tree', '-r', '--name-only', 'HEAD', 'sessions/repos').split('\n');
    expect(committed.filter((p) => p.includes('/claude-code_fix-payment_20260102') && p.endsWith('.jsonl'))).toHaveLength(1);
  });

  it('folds a session held under the current name once, even when that directory has no index', async () => {
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    const first = new SyncManager(alice);
    await first.saveSession(mkSession(), mkMeta());
    expect(first.gitCommit('push').status).toBe('committed');
    git(alice, 'rm', '-q', `sessions/repos/${encodeRepoIdentity(identity)}/_index.json`);
    git(alice, 'commit', '-qm', 'lose the index');
    // An older CLI pushes s-1 again, later, under the %XX name.
    const older = path.join(repoRoot, 'older');
    await new SyncManager(older).saveSession(mkSession(), mkMeta());
    const percentDir = path.join(alice, 'sessions', 'repos', 'github.com%2Forg%2Falpha');
    fs.cpSync(path.join(older, 'sessions', 'repos', encodeRepoIdentity(identity)), percentDir, { recursive: true });
    git(alice, 'add', '-A');
    git(alice, 'commit', '-qm', 'older CLI push');

    const mgr = new SyncManager(alice);
    await mgr.saveSession(mkSession({ sessionId: 's-2', title: 'add refunds' }), mkMeta({ sessionId: 's-2' }));
    expect(mgr.gitCommit('push').status).toBe('committed');

    const committed = git(alice, 'ls-tree', '-r', '--name-only', 'HEAD', 'sessions/repos').split('\n');
    expect(committed.filter((p) => p.endsWith('.jsonl'))).toHaveLength(2);
    expect(mgr.listSessions(identity).map((s) => s.sessionId).sort()).toEqual(['s-1', 's-2']);
  });

  it('undoes a fold whose commit is rejected while a push updates a held session, and folds on a later push', async () => {
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    const first = new SyncManager(alice);
    await first.saveSession(mkSession(), mkMeta());
    expect(first.gitCommit('push').status).toBe('committed');
    // An older CLI pushes s-4 under the %XX name; its file name is the one s-1 has in the current directory.
    const older = path.join(repoRoot, 'older');
    await new SyncManager(older).saveSession(mkSession({ sessionId: 's-4' }), mkMeta({ sessionId: 's-4' }));
    fs.cpSync(
      path.join(older, 'sessions', 'repos', encodeRepoIdentity(identity)),
      path.join(alice, 'sessions', 'repos', 'github.com%2Forg%2Falpha'),
      { recursive: true },
    );
    git(alice, 'add', '-A');
    git(alice, 'commit', '-qm', 'older CLI push');
    const hook = path.join(alice, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const before = git(alice, 'rev-parse', 'HEAD');
    const updated = mkSession({
      messages: [...mkSession().messages, { role: 'user', content: [{ type: 'text', text: 'and refunds' }] }],
    });

    const rejected = new SyncManager(alice);
    await rejected.saveSession(updated, mkMeta());
    expect(rejected.gitCommit('push').status).toBe('failed');
    expect(git(alice, 'rev-parse', 'HEAD')).toBe(before);
    expect(fs.readdirSync(path.join(repoDirOf(identity).replace(repoRoot, alice), 'alice')).filter((f) => f.endsWith('_1.jsonl'))).toEqual([]);
    fs.rmSync(hook);
    for (const [session, sessionId] of [[updated, 's-1'], [mkSession({ sessionId: 's-3', title: 'add invoices' }), 's-3']] as const) {
      const mgr = new SyncManager(alice);
      await mgr.saveSession(session, mkMeta({ sessionId }));
      expect(mgr.gitCommit('push').status).toBe('committed');
    }

    const committed = git(alice, 'ls-tree', '-r', '--name-only', 'HEAD', 'sessions/repos').split('\n');
    expect(committed.filter((p) => p.includes('%'))).toEqual([]);
    expect(committed.filter((p) => p.endsWith('.jsonl'))).toHaveLength(3);
    expect(git(alice, 'status', '--porcelain')).toBe('');
    expect(new SyncManager(alice).listSessions(identity).map((s) => s.sessionId).sort()).toEqual(['s-1', 's-3', 's-4']);
  });

  it('publishes none of the edits staged under both repository directory names', async () => {
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    const first = new SyncManager(alice);
    await first.saveSession(mkSession(), mkMeta());
    expect(first.gitCommit('push').status).toBe('committed');
    const older = path.join(repoRoot, 'older');
    await new SyncManager(older).saveSession(mkSession({ sessionId: 's-3', title: 'add invoices' }), mkMeta({ sessionId: 's-3' }));
    fs.cpSync(
      path.join(older, 'sessions', 'repos', encodeRepoIdentity(identity)),
      path.join(alice, 'sessions', 'repos', 'github.com%2Forg%2Falpha'),
      { recursive: true },
    );
    git(alice, 'add', '-A');
    git(alice, 'commit', '-qm', 'older CLI push');
    const edited = [
      `sessions/repos/${encodeRepoIdentity(identity)}/alice/claude-code_fix-payment_20260102.jsonl`,
      'sessions/repos/github.com%2Forg%2Falpha/alice/claude-code_add-invoices_20260102.jsonl',
    ];
    for (const file of edited) {
      fs.appendFileSync(path.join(alice, file), 'local edit\n');
      git(alice, 'add', file);
    }
    const originals = edited.map((file) => git(alice, 'show', `HEAD:${file}`));

    const mgr = new SyncManager(alice);
    await mgr.saveSession(mkSession({ sessionId: 's-2', title: 'add refunds' }), mkMeta({ sessionId: 's-2' }));
    expect(mgr.gitCommit('push').status).toBe('committed');

    expect(edited.map((file) => git(alice, 'show', `HEAD:${file}`))).toEqual(originals);
  });

  it('publishes neither a staged deletion under the percent-escaped name nor a staged edit under the current one', async () => {
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    const first = new SyncManager(alice);
    await first.saveSession(mkSession(), mkMeta());
    expect(first.gitCommit('push').status).toBe('committed');
    const older = path.join(repoRoot, 'older');
    await new SyncManager(older).saveSession(mkSession({ sessionId: 's-3', title: 'add invoices' }), mkMeta({ sessionId: 's-3' }));
    fs.cpSync(
      path.join(older, 'sessions', 'repos', encodeRepoIdentity(identity)),
      path.join(alice, 'sessions', 'repos', 'github.com%2Forg%2Falpha'),
      { recursive: true },
    );
    git(alice, 'add', '-A');
    git(alice, 'commit', '-qm', 'older CLI push');
    const deleted = 'sessions/repos/github.com%2Forg%2Falpha/alice/claude-code_add-invoices_20260102.jsonl';
    const edited = `sessions/repos/${encodeRepoIdentity(identity)}/alice/claude-code_fix-payment_20260102.jsonl`;
    const originals = [deleted, edited].map((file) => git(alice, 'show', `HEAD:${file}`));
    git(alice, 'rm', '-q', deleted);
    fs.appendFileSync(path.join(alice, edited), 'local edit\n');
    git(alice, 'add', edited);

    const mgr = new SyncManager(alice);
    await mgr.saveSession(mkSession({ sessionId: 's-2', title: 'add refunds' }), mkMeta({ sessionId: 's-2' }));
    expect(mgr.gitCommit('push').status).toBe('committed');

    expect([deleted, edited].map((file) => git(alice, 'show', `HEAD:${file}`))).toEqual(originals);
  });

  it('publishes no edit made between a rejected move and the next push', async () => {
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    const first = new SyncManager(alice);
    await first.saveSession(mkSession(), mkMeta());
    expect(first.gitCommit('push').status).toBe('committed');
    git(alice, 'mv', `sessions/repos/${encodeRepoIdentity(identity)}`, 'sessions/repos/github.com%2Forg%2Falpha');
    git(alice, 'commit', '-qm', 'previous layout');
    const original = git(alice, 'show', 'HEAD:sessions/repos/github.com%2Forg%2Falpha/alice/claude-code_fix-payment_20260102.jsonl');
    const hook = path.join(alice, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const rejected = new SyncManager(alice);
    await rejected.saveSession(mkSession({ sessionId: 's-2', title: 'add refunds' }), mkMeta({ sessionId: 's-2' }));
    expect(rejected.gitCommit('push').status).toBe('failed');
    fs.rmSync(hook);
    // The rejected move was undone, so the session is back under the old name.
    fs.appendFileSync(path.join(alice, 'sessions/repos/github.com%2Forg%2Falpha/alice/claude-code_fix-payment_20260102.jsonl'), 'local edit\n');

    const retry = new SyncManager(alice);
    await retry.saveSession(mkSession({ sessionId: 's-3', title: 'add invoices' }), mkMeta({ sessionId: 's-3' }));
    expect(retry.gitCommit('push').status).toBe('committed');

    const committed = git(alice, 'ls-tree', '-r', '--name-only', 'HEAD', 'sessions/repos').split('\n');
    const copies = committed.filter((p) => p.endsWith('claude-code_fix-payment_20260102.jsonl'));
    expect(copies.map((file) => git(alice, 'show', `HEAD:${file}`))).toEqual([original]);
  });

  it('leaves sessions an older CLI pushed under the percent-escaped name in place while the current directory holds local edits', async () => {
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    const first = new SyncManager(alice);
    await first.saveSession(mkSession(), mkMeta());
    expect(first.gitCommit('push').status).toBe('committed');
    // An older CLI pushes s-1 again, later, under the %XX name.
    const older = path.join(repoRoot, 'older');
    await new SyncManager(older).saveSession(mkSession(), mkMeta());
    const percentDir = path.join(alice, 'sessions', 'repos', 'github.com%2Forg%2Falpha');
    fs.cpSync(path.join(older, 'sessions', 'repos', encodeRepoIdentity(identity)), percentDir, { recursive: true });
    const olderMeta = path.join(percentDir, 'alice', 'claude-code_fix-payment_20260102.meta.json');
    const meta = JSON.parse(fs.readFileSync(olderMeta, 'utf-8')) as { sync: { pushedAt: string } };
    meta.sync.pushedAt = '2099-01-01T00:00:00.000Z';
    fs.writeFileSync(olderMeta, JSON.stringify(meta));
    git(alice, 'add', '-A');
    git(alice, 'commit', '-qm', 'older CLI push');
    const edited = path.join(repoDirOf(identity).replace(repoRoot, alice), 'alice', 'claude-code_fix-payment_20260102.jsonl');
    fs.appendFileSync(edited, 'local edit\n');

    const mgr = new SyncManager(alice);
    await mgr.saveSession(mkSession({ sessionId: 's-2', title: 'add refunds' }), mkMeta({ sessionId: 's-2' }));
    expect(mgr.gitCommit('push').status).toBe('committed');

    expect(fs.readFileSync(edited, 'utf-8')).toContain('local edit');
    const committed = git(alice, 'ls-tree', '-r', '--name-only', 'HEAD', 'sessions/repos').split('\n');
    expect(committed.filter((p) => p.includes('%'))).toHaveLength(3);
  });

  it.each([
    { change: 'an unstaged edit', apply: (checkout: string, file: string) => fs.appendFileSync(path.join(checkout, file), 'local edit\n') },
    {
      change: 'a staged edit',
      apply: (checkout: string, file: string) => {
        fs.appendFileSync(path.join(checkout, file), 'local edit\n');
        git(checkout, 'add', file);
      },
    },
    { change: 'an unstaged deletion', apply: (checkout: string, file: string) => fs.rmSync(path.join(checkout, file)) },
    { change: 'a staged deletion', apply: (checkout: string, file: string) => git(checkout, 'rm', '-q', file) },
    {
      change: 'the whole directory deleted',
      apply: (checkout: string, file: string) => fs.rmSync(path.join(checkout, path.dirname(path.dirname(file))), { recursive: true }),
    },
  ])('publishes none of $change under a percent-escaped repository directory', async ({ apply }) => {
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    const first = new SyncManager(alice);
    await first.saveSession(mkSession(), mkMeta());
    expect(first.gitCommit('push').status).toBe('committed');
    git(alice, 'mv', `sessions/repos/${encodeRepoIdentity(identity)}`, 'sessions/repos/github.com%2Forg%2Falpha');
    git(alice, 'commit', '-qm', 'previous layout');
    const edited = 'sessions/repos/github.com%2Forg%2Falpha/alice/claude-code_fix-payment_20260102.jsonl';
    const original = git(alice, 'show', `HEAD:${edited}`);
    apply(alice, edited);

    const mgr = new SyncManager(alice);
    await mgr.saveSession(mkSession({ sessionId: 's-2', title: 'add refunds' }), mkMeta({ sessionId: 's-2' }));
    expect(mgr.gitCommit('push').status).toBe('committed');

    expect(git(alice, 'show', `HEAD:${edited}`)).toBe(original);
    expect(git(alice, 'diff', '--name-only', 'HEAD').split('\n')).toContain(edited);
  });

  it('leaves a %-escaped repository directory for the next push to move when rebuilding every index', async () => {
    const alice = path.join(repoRoot, 'alice');
    git(repoRoot, 'init', '-q', '-b', 'main', alice);
    initCheckout(alice, 'alice');
    const mgr = new SyncManager(alice);
    await mgr.saveSession(mkSession(), mkMeta());
    expect(mgr.gitCommit('push').status).toBe('committed');
    git(alice, 'mv', `sessions/repos/${encodeRepoIdentity(identity)}`, 'sessions/repos/github.com%2Forg%2Falpha');
    git(alice, 'commit', '-qm', 'previous layout');

    written(await new SyncManager(alice).rebuildAllIndexes());

    expect(git(alice, 'status', '--porcelain')).toBe('');
    expect(new SyncManager(alice).listSessions(identity).map((s) => s.sessionId)).toEqual(['s-1']);
  });
});

describe('canonicalizeRemote', () => {
  it('strips credentials embedded in the remote URL', () => {
    // Tokens live in remotes on CI checkouts; publishing them into the
    // archive index would leak them to the whole team.
    expect(canonicalizeRemote('https://oauth2:TOKEN@github.com/org/repo.git')).toBe('github.com/org/repo');
    expect(canonicalizeRemote('https://user:pass@gitlab.company.com/g/repo.git')).toBe('gitlab.company.com/g/repo');
    // A password containing '/' defeats the "no slash before @" shape, and the
    // secret used to survive into meta, _index.json and the SOURCE column.
    expect(canonicalizeRemote('https://user:pw/slash@github.com/org/repo.git')).toBe('github.com/org/repo');
  });

  it('leaves a legitimate @ in the path alone', () => {
    expect(canonicalizeRemote('https://github.com/org/@scope/pkg.git')).toBe('github.com/org/@scope/pkg');
    expect(canonicalizeRemote('git@github.com:org/repo.git')).toBe('github.com/org/repo');
  });

  it('normalizes https, scp and ssh remote forms to the same identity', () => {
    expect(canonicalizeRemote('https://github.com/org/repo.git')).toBe('github.com/org/repo');
    expect(canonicalizeRemote('git@github.com:org/repo.git')).toBe('github.com/org/repo');
    expect(canonicalizeRemote('ssh://git@github.com/org/repo.git')).toBe('github.com/org/repo');
  });
});

describe('encodeRepoIdentity', () => {
  it('is injective: distinct identities never share a directory', () => {
    const ids = ['github.com/org/a/b', 'github.com/org/a_b', 'github.com/org/a:b'];
    const encoded = ids.map(encodeRepoIdentity);
    expect(new Set(encoded).size).toBe(ids.length);
  });

  it('leaves no % in the name, which GitHub and GitLab URL-decode back into a separator', () => {
    expect(encodeRepoIdentity('github.com/org/repo')).not.toContain('%');
  });

  it('round-trips through decodeRepoIdentity', () => {
    for (const id of ['github.com/org/repo', 'gitlab.company.com/g/a_b', 'github.com/org/a~b', 'github.com/org/中']) {
      expect(decodeRepoIdentity(encodeRepoIdentity(id))).toBe(id);
    }
    expect(decodeRepoIdentity('github.com%2Forg%2Fa~41')).toBe('github.com/org/a~41');
  });
});
