import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeRepoIdentity } from '../session-flow/sync.js';

/**
 * session-cmd 子命令测试（M2 消费端）。
 *
 * 覆盖点：
 * - list --all 的 SOURCE 列；非 --all 保持单项目格式
 * - pull --all 对每个 identity 幂等重建索引
 * - search --all 含 _unattributed 且当前 repo 不被二次加载；非 --all 只搜当前 repo
 * - push --all 忽略 --limit、>5 条确认（可拒绝/可 -y 跳过）、每条打印来源目录
 * - 归档键不变式：运行目录与会话 cwd 是两个项目时，归档到会话 cwd 的 identity
 * - codebuddy-ide 的 md5: 占位 → _unattributed + 英文警告
 * - migrate --push 归档键来自会话原生 cwd
 * - 全部新输出为英文
 */

const mocks = vi.hoisted(() => ({
  /** cwd → git remote url（getRepoIdentity 的 mock 数据） */
  remotes: {} as Record<string, string>,
  /** `git status --porcelain -- sessions/` 的返回值；空串 = 无变更可提交 */
  porcelain: 'M  sessions/changed\n',
  /** 非空时 git commit / git push 抛错，用于验证失败路径 */
  commitError: '',
  pushError: '',
  pullError: '',
  gitCalls: [] as Array<{ args: string[]; cwd?: string }>,
  adaptersByPlatform: {} as Record<string, unknown>,
  /** migrate.js mock 的 preview 返回值（Error 时抛出）；agent-session.js mock 的 copy 返回值 */
  previewResult: null as unknown,
  previewCalls: [] as Array<{ session: unknown; source: string; target: string }>,
  copyResult: null as unknown,
  /** The OS the commands' `noAdapter` checks judge by; this machine's when unset. */
  os: undefined as NodeJS.Platform | undefined,
  /** When set, the session archive lock reports this path as held by another command. */
  heldArchiveLock: '',
  /** readline mock：ask() 等待输入时捕获的 'line' 回调 */
  lineCb: null as ((line: string) => void) | null,
  lineArmed: null as (() => void) | null,
  /** 真实适配器回归用例的假 HOME（适配器存储路径由 os.homedir() 派生） */
  home: '',
}));

// 适配器存储路径全部由 os.homedir() 派生；像 codebuddy-ide-adapter.test.ts 一样
// 整体替换 home 才能用临时目录做 fixture（spy 在 ESM namespace import 下不生效）。
vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & { default?: object };
  const patched: Record<string, unknown> = { ...actual, homedir: () => mocks.home };
  patched.default = { ...actual.default, homedir: () => mocks.home };
  return patched;
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    execFileSync: (cmd: string, args: string[], opts?: { cwd?: string }) => {
      if (cmd !== 'git') throw new Error(`unexpected command: ${cmd}`);
      mocks.gitCalls.push({ args, cwd: opts?.cwd });
      if (args[0] === 'config') return 'tester\n';
      if (args[0] === 'remote') {
        const url = opts?.cwd ? mocks.remotes[opts.cwd] : undefined;
        if (!url) throw new Error('not a git repository');
        return `${url}\n`;
      }
      if (args[0] === 'status') return mocks.porcelain;
      if (args[0] === 'rev-parse') return 'abc123def456\n';
      if (args[0] === 'commit' && mocks.commitError) throw new Error(mocks.commitError);
      if (args[0] === 'push' && mocks.pushError) throw new Error(mocks.pushError);
      if (args.includes('pull') && mocks.pullError) throw new Error(mocks.pullError);
      return ''; // add / commit / push / pull
    },
  };
});

// ask() 走 readline；mock 掉 createInterface，把 'line' 回调暴露给测试，
// 确认类提示（"Push all of the above?"）由测试主动喂答案。
vi.mock('node:readline', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & { default?: unknown };
  const realDefault = (actual.default ?? {}) as Record<string, unknown>;
  return {
    ...actual,
    default: {
      ...realDefault,
      createInterface: () => ({
        on: (event: string, cb: (line: string) => void) => {
          if (event === 'line') {
            mocks.lineCb = cb;
            if (mocks.lineArmed) mocks.lineArmed();
          }
        },
        close: () => {},
      }),
    },
  };
});

vi.mock('../session-flow/adapters/index.js', () => ({
  getAdapter: (platform: string) => {
    const adapter = mocks.adaptersByPlatform[platform];
    if (!adapter) throw new Error(`Unsupported platform: ${platform}`);
    return adapter;
  },
  listAvailablePlatforms: () => Object.keys(mocks.adaptersByPlatform),
  listInstalledPlatforms: () => [],
  // AgentSession looks adapters up here.
  ADAPTER_REGISTRY: new Proxy(
    {},
    {
      get: (_registry, platform) =>
        typeof platform === 'string' && mocks.adaptersByPlatform[platform]
          ? () => mocks.adaptersByPlatform[platform]
          : undefined,
    },
  ),
}));

vi.mock('../session-flow/migrate.js', () => ({
  previewMigration: (session: unknown, source: string, target: string): unknown => {
    mocks.previewCalls.push({ session, source, target });
    return mocks.previewResult;
  },
  resolveTargetCwd: (explicit: string | undefined, sourceCwd: string | undefined) => explicit ?? sourceCwd,
}));

vi.mock('../session-flow/sync.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../session-flow/sync.js');
  return {
    ...actual,
    withSessionIndexLock: (async (repo, fn) =>
      mocks.heldArchiveLock
        ? { status: 'busy', lockPath: mocks.heldArchiveLock }
        : actual.withSessionIndexLock(repo, fn)) as typeof actual.withSessionIndexLock,
  };
});

vi.mock('../session-flow/agent-session.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../session-flow/agent-session.js');
  return {
    ...actual,
    AgentSession: {
      ...actual.AgentSession,
      copy: async (request: unknown): Promise<unknown> =>
        typeof mocks.copyResult === 'function' ? mocks.copyResult(request) : mocks.copyResult,
    },
    noAdapter: (platform: string, use: 'read' | 'write') => actual.noAdapter(platform, use, mocks.os),
  };
});

import { registerSessionFlowCommands } from '../session-flow/session-cmd.js';
import { SyncManager, defaultSyncMeta } from '../session-flow/sync.js';
import type { Session } from '../session-flow/ir.js';
import { ToolUnavailableError, type SessionReadRef } from '../session-flow/adapters/base.js';
import { ClaudeCodeAdapter } from '../session-flow/adapters/claude-code.js';
import { CodeBuddyAdapter } from '../session-flow/adapters/codebuddy.js';
import { CursorAdapter } from '../session-flow/adapters/cursor.js';
import { CodexAdapter } from '../session-flow/adapters/codex.js';

let repoRoot: string;
/** console.log + process.stdout.write 的合并捕获（ask 的提示走 stdout.write） */
let out: string[] = [];
let warned: string[] = [];
/** console.error 的捕获：失败信息（commit/push/门禁）都走这条通道 */
let errored: string[] = [];

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cmd-'));
  mocks.home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cmd-home-'));
  out = [];
  warned = [];
  errored = [];
  mocks.remotes = {};
  mocks.porcelain = 'M  sessions/changed\n';
  mocks.commitError = '';
  mocks.pushError = '';
  mocks.pullError = '';
  process.exitCode = 0;
  mocks.gitCalls.length = 0;
  mocks.adaptersByPlatform = {};
  mocks.previewResult = null;
  mocks.previewCalls.length = 0;
  mocks.copyResult = null;
  mocks.os = undefined;
  mocks.heldArchiveLock = '';
  mocks.lineArmed = null;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warned.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errored.push(a.map(String).join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(mocks.home, { recursive: true, force: true });
  mocks.home = '';
});

async function runSession(...argv: string[]): Promise<void> {
  const program = new Command();
  program.option('--dry-run', 'preview');
  const sessionCmd = program.command('session').description('session commands');
  registerSessionFlowCommands(sessionCmd);
  // from:'node'（默认）会消耗 argv[0]=executable、argv[1]=script path，
  // 之后才是 program 的子命令路径：session <sub> ...
  await program.parseAsync(['node', 'teamai', 'session', ...argv]);
}

function mkSession(o: Partial<Session> = {}): Session {
  return {
    sessionId: 's-1',
    title: 'fix payment',
    cwd: '/proj/beta',
    platform: 'fakeplat',
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

/** 注册一个假适配器（listConversations/readSession 都是 spy），返回 adapter 供断言。 */
function fakeAdapter(sessions: Session[], platform = 'fakeplat') {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const fileOf = (s: Session): string => `/fake/${s.sessionId}.jsonl`;
  const byFile = new Map(sessions.map((s) => [fileOf(s), s]));
  const adapter = {
    platform,
    isReady: () => true,
    listConversations: vi.fn(async () =>
      sessions.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        cwd: s.cwd,
        platform,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
        filePath: fileOf(s),
        sizeBytes: 100,
      })),
    ),
    // Same contract as the real adapters: the listed file wins over the id.
    readSession: vi.fn(async ({ sessionId, filePath }: SessionReadRef) => {
      const s = filePath ? byFile.get(filePath) : byId.get(sessionId);
      if (!s) throw new Error(`session not found: ${filePath ?? sessionId}`);
      return s;
    }),
  };
  mocks.adaptersByPlatform[platform] = adapter;
  return adapter;
}

/** 用真实 SyncManager 落盘一个已归档会话（种子数据）。 */
function seed(identity: string | null, author: string, sessionId: string, title: string, text: string): void {
  const mgr = new SyncManager(repoRoot);
  const session = mkSession({
    sessionId,
    title,
    platform: 'claude-code',
    cwd: '/proj/seed',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  });
  const meta = defaultSyncMeta(
    { platform: 'claude-code', author, cwd: '/proj/seed', sessionId, repoIdentity: identity },
    '2026-01-02T00:00:00.000Z',
  );
  mgr.saveSession(session, meta);
}

const CJK = /[\u4e00-\u9fff]/;

// ─────────────────────────────────────────────────────────────

describe('session list --all', () => {
  it('prints a SOURCE column showing repo identity and _unattributed', async () => {
    seed('github.com/org/alpha', 'alice', 'a-1', 'payment alpha', 'alpha payment retry');
    seed(null, 'bob', 'b-1', 'payment plain', 'plain payment notes');

    await runSession('list', '--all', '--repo-root', repoRoot, '--cwd', '/tmp/nowhere');

    const text = out.join('\n');
    expect(text).toContain('SOURCE');
    expect(text).toContain('github.com/org/alpha');
    expect(text).toContain('_unattributed');
    expect(text).toContain('2 session(s)');
    expect(text).not.toMatch(CJK);
  });

  it('keeps the single-project format without --all', async () => {
    seed('github.com/org/alpha', 'alice', 'a-1', 'payment', 'payment retry');
    mocks.remotes['/run/alpha'] = 'https://github.com/org/alpha.git';

    await runSession('list', '--repo-root', repoRoot, '--cwd', '/run/alpha');

    const text = out.join('\n');
    expect(text).toContain('Sessions for github.com/org/alpha:');
    expect(text).not.toContain('SOURCE');
  });
});

describe('session pull --all', () => {
  it('rebuilds the index of every repo including _unattributed', async () => {
    seed('github.com/org/alpha', 'alice', 'a-1', 'payment', 'payment alpha');
    seed(null, 'bob', 'b-1', 'plain', 'plain notes');

    // 手动清空 alpha 的索引条目，验证 pull --all 会按磁盘内容幂等重建
    const idxPath = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('github.com/org/alpha'), '_index.json');
    fs.writeFileSync(
      idxPath,
      JSON.stringify({ version: 1, repoIdentity: 'github.com/org/alpha', updatedAt: '2026-01-01T00:00:00.000Z', sessions: [] }),
    );

    await runSession('pull', '--all', '--repo-root', repoRoot);

    const text = out.join('\n');
    expect(text).toContain('Pulled and indexed 2 session(s) across 2 repo(s)');
    expect(mocks.gitCalls.some((c) => c.args.includes('pull'))).toBe(true);

    const restored = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
    expect(restored.sessions).toHaveLength(1);
    expect(restored.sessions[0].sessionId).toBe('a-1');
    expect(text).not.toMatch(CJK);
  });
});

describe('session pull', () => {
  it.each([
    ['pull --all', ['--all']],
    ['pull', ['--cwd', '/run/alpha']],
  ])('a second %s leaves _index.json byte-identical', async (_name, args) => {
    seed('github.com/org/alpha', 'alice', 'a-1', 'payment', 'payment alpha');
    seed('github.com/org/alpha', 'bob', 'b-1', 'refunds', 'refund notes');
    mocks.remotes['/run/alpha'] = 'https://github.com/org/alpha.git';
    const idxPath = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('github.com/org/alpha'), '_index.json');

    await runSession('pull', ...args, '--repo-root', repoRoot);
    const first = fs.readFileSync(idxPath, 'utf-8');
    await runSession('pull', ...args, '--repo-root', repoRoot);

    expect(errored).toEqual([]);
    expect(fs.readFileSync(idxPath, 'utf-8')).toBe(first);
  });
});

describe('session pull failure', () => {
  it("prints git's own reason instead of the command line", async () => {
    mocks.pullError = 'Command failed: git pull --no-rebase --ff --no-edit origin main\n'
      + 'hint: You have divergent branches.\nfatal: unable to access the remote: Could not resolve host';
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });

    await expect(runSession('pull', '--all', '--repo-root', repoRoot)).rejects.toThrow('exit 1');

    expect(errored.join('\n')).toContain(
      `Error: git pull failed in ${repoRoot}: fatal: unable to access the remote: Could not resolve host`,
    );
  });
});

describe('session search --all', () => {
  it('searches every repo including _unattributed without double-loading the current one', async () => {
    seed('github.com/org/alpha', 'alice', 'a-1', 'payment alpha', 'alpha payment retry');
    seed('gitlab.company.com/g/beta', 'bob', 'b-1', 'payment beta', 'beta payment retry');
    seed(null, 'carol', 'c-1', 'payment plain', 'plain payment notes');
    mocks.remotes['/run/alpha'] = 'https://github.com/org/alpha.git';

    const loadSpy = vi.spyOn(SyncManager.prototype, 'loadSession');
    await runSession('search', 'payment', '--all', '--repo-root', repoRoot, '--cwd', '/run/alpha');

    const text = out.join('\n');
    expect(text).toContain('3 result(s) found');
    expect(text).toContain('payment-alpha');
    expect(text).toContain('payment-beta');
    expect(text).toContain('payment-plain');
    // 恰好 3 次：当前 repo 不会因为同时也在 --all 清单里被加载两遍
    expect(loadSpy).toHaveBeenCalledTimes(3);
    expect(text).not.toMatch(CJK);
  });

  it('prints a nonzero score for a session that matches only in tool output', async () => {
    seed('github.com/org/alpha', 'alice', 'a-1', 'docs', 'fix the readme');
    new SyncManager(repoRoot).saveSession(
      mkSession({
        sessionId: 'b-1',
        title: 'build',
        platform: 'claude-code',
        cwd: '/proj/seed',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'run the build' }] },
          { role: 'user', content: [{ type: 'tool_result', callId: 't1', content: 'error TS2304: Cannot find name ZZTOP', isError: true }] },
        ],
      }),
      defaultSyncMeta(
        { platform: 'claude-code', author: 'bob', cwd: '/proj/seed', sessionId: 'b-1', repoIdentity: 'github.com/org/alpha' },
        '2026-01-02T00:00:00.000Z',
      ),
    );
    mocks.remotes['/run/alpha'] = 'https://github.com/org/alpha.git';

    await runSession('search', 'ZZTOP', '--repo-root', repoRoot, '--cwd', '/run/alpha');

    const score = /Score: (\S+)/.exec(out.join('\n'))?.[1];
    expect(Number(score)).toBeGreaterThan(0);
  });

  it('scopes search to the current repo without --all', async () => {
    seed('github.com/org/alpha', 'alice', 'a-1', 'payment alpha', 'alpha payment retry');
    seed('gitlab.company.com/g/beta', 'bob', 'b-1', 'payment beta', 'beta payment retry');
    mocks.remotes['/run/alpha'] = 'https://github.com/org/alpha.git';

    const loadSpy = vi.spyOn(SyncManager.prototype, 'loadSession');
    await runSession('search', 'payment', '--repo-root', repoRoot, '--cwd', '/run/alpha');

    expect(out.join('\n')).toContain('1 result(s) found');
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });
});

describe('session push --all', () => {
  function manySessions(n: number): Session[] {
    return Array.from({ length: n }, (_, i) =>
      mkSession({ sessionId: `s-${i}`, title: `task ${i}`, updatedAt: `2026-01-0${(i % 8) + 1}T00:00:00.000Z` }),
    );
  }

  it('ignores --limit and pushes every workspace session', async () => {
    const adapter = fakeAdapter(manySessions(8));
    mocks.remotes['/proj/beta'] = 'https://gitlab.com/team/beta.git';

    await runSession(
      'push', '--source', 'fakeplat', '--all', '-y',
      '--repo-root', repoRoot, '--cwd', '/run/dir', '--limit', '2',
    );

    expect(adapter.readSession).toHaveBeenCalledTimes(8);
    // --all 枚举全部工作区：listConversations 以无参形式调用
    expect(adapter.listConversations).toHaveBeenCalledWith(undefined);

    const dir = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('gitlab.com/team/beta'), 'tester');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(8);

    const text = out.join('\n');
    expect(text).toContain('Pushed 8 session(s) from fakeplat');
    expect(text).toContain('Source: /proj/beta');
    expect(text).not.toMatch(CJK);
  });

  it('asks for confirmation before pushing more than five sessions', async () => {
    const adapter = fakeAdapter(manySessions(6));
    mocks.remotes['/proj/beta'] = 'https://gitlab.com/team/beta.git';
    const prevCi = process.env.CI;
    const prevNonInteractive = process.env.TEAMAI_NONINTERACTIVE;
    delete process.env.CI;
    delete process.env.TEAMAI_NONINTERACTIVE;
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    const armed = new Promise<void>((resolve) => {
      mocks.lineArmed = resolve;
    });
    const parsed = runSession(
      'push', '--source', 'fakeplat', '--all',
      '--repo-root', repoRoot, '--cwd', '/run/dir',
    );
    await armed;
    mocks.lineCb!('n');
    await parsed;
    if (prevCi === undefined) delete process.env.CI;
    else process.env.CI = prevCi;
    if (prevNonInteractive === undefined) delete process.env.TEAMAI_NONINTERACTIVE;
    else process.env.TEAMAI_NONINTERACTIVE = prevNonInteractive;
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;

    const text = out.join('\n');
    expect(text).toContain('About to push 6 session(s) from fakeplat:');
    expect(text).toContain('Push all of the above?');
    expect(text).toContain('Cancelled.');
    // 拒绝后不读取、不落盘任何会话
    expect(adapter.readSession).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repoRoot, 'sessions'))).toBe(false);
  });

  it('refuses a non-interactive push --all over the batch threshold', async () => {
    const adapter = fakeAdapter(manySessions(6));
    await runSession(
      'push', '--source', 'fakeplat', '--all',
      '--repo-root', repoRoot, '--cwd', '/run/dir',
    );
    expect(process.exitCode).toBe(1);
    expect(errored.join('\n')).toContain('Refusing to push 6 session(s) without confirmation.');
    expect(adapter.readSession).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repoRoot, 'sessions'))).toBe(false);
  });

  it('refuses a non-interactive unredacted push unless -y or --scrub is set', async () => {
    const adapter = fakeAdapter([mkSession({ sessionId: 'secret-1' })]);
    await runSession('push', '--source', 'fakeplat', '--repo-root', repoRoot, '--cwd', '/run/dir');
    expect(process.exitCode).toBe(1);
    expect(errored.join('\n')).toContain('Refusing to archive 1 unredacted session(s) without confirmation.');
    expect(adapter.readSession).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repoRoot, 'sessions'))).toBe(false);
  });

  it('skips the confirmation prompt with -y', async () => {
    fakeAdapter(manySessions(6));
    mocks.remotes['/proj/beta'] = 'https://gitlab.com/team/beta.git';

    await runSession(
      'push', '--source', 'fakeplat', '--all', '-y',
      '--repo-root', repoRoot, '--cwd', '/run/dir',
    );

    const text = out.join('\n');
    expect(text).not.toContain('Push all of the above?');
    expect(text).toContain('Pushed 6 session(s) from fakeplat');
  });

  it('reports no changes when nothing new was committed', async () => {
    fakeAdapter([mkSession({ sessionId: 'once-1' })]);
    mocks.remotes['/proj/beta'] = 'https://gitlab.com/team/beta.git';
    mocks.porcelain = ''; // git status --porcelain 无暂存变更 → commit 为 null

    await runSession('push', '--source', 'fakeplat', '--repo-root', repoRoot, '--cwd', '/run/dir', '-y');

    const text = out.join('\n');
    expect(text).toContain('No changes to push');
    // 会话文件本身已写入（commit 检测发生在 saveSession 之后）
    const dir = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('gitlab.com/team/beta'), 'tester');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
    expect(mocks.gitCalls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('reports a failed commit instead of "No changes to push" and exits non-zero', async () => {
    // A commit hook / gpg / missing identity makes git exit non-zero. It used
    // to be swallowed as null, so the archive stayed staged while the command
    // printed a clean-tree message and exited 0.
    fakeAdapter([mkSession({ sessionId: 'fail-1' })]);
    mocks.remotes['/proj/beta'] = 'https://gitlab.com/team/beta.git';
    mocks.commitError = 'Command failed: git commit -m x\nfatal: cannot run hooks/pre-commit: permission denied';

    await runSession('push', '--source', 'fakeplat', '--repo-root', repoRoot, '--cwd', '/run/dir', '-y');

    const text = [...out, ...warned, ...errored].join('\n');
    expect(text).not.toContain('No changes to push');
    expect(text).not.toContain('✓ Pushed');
    expect(text).toContain('Commit failed');
    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero when the remote push fails, after the local commit succeeded', async () => {
    fakeAdapter([mkSession({ sessionId: 'push-fail-1' })]);
    mocks.remotes['/proj/beta'] = 'https://gitlab.com/team/beta.git';
    mocks.pushError = 'Command failed: git push origin\nfatal: The current branch main has no upstream branch.';

    await runSession('push', '--source', 'fakeplat', '--repo-root', repoRoot, '--cwd', '/run/dir', '-y');

    const text = [...out, ...warned, ...errored].join('\n');
    // git's own fatal line, not the contentless first line of the error
    expect(text).toContain('no upstream branch');
    expect(text).toContain('committed locally but not pushed');
    expect(text).not.toContain('✓ Pushed');
    expect(process.exitCode).toBe(1);
  });

  // An older TeamAI reused source ids, so one Claude Code id can live in two workspaces.
  it('archives each listed session when one id lives in two workspaces', async () => {
    const SID = '0190a0b0-c0d0-7e0f-8a0b-0c0d0e0f1a2b';
    for (const [cwd, encoded, text] of [
      ['/proj/alpha', '-proj-alpha', 'work in alpha'],
      ['/proj/beta', '-proj-beta', 'work in beta'],
    ]) {
      const projDir = path.join(mocks.home, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, `${SID}.jsonl`),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
          cwd,
          timestamp: '2026-01-02T00:00:00.000Z',
          uuid: 'u1',
          parentUuid: null,
          isSidechain: false,
        }) + '\n',
      );
    }
    mocks.adaptersByPlatform['claude-code'] = new ClaudeCodeAdapter();
    mocks.remotes['/proj/alpha'] = 'https://github.com/org/alpha.git';
    mocks.remotes['/proj/beta'] = 'https://gitlab.com/team/beta.git';

    await runSession('push', '--source', 'claude-code', '--all', '-y', '--repo-root', repoRoot, '--cwd', '/run/dir');

    const archived = (identity: string): string => {
      const dir = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity(identity), 'tester');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
      return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf-8')).join('');
    };
    expect(archived('github.com/org/alpha')).toContain('work in alpha');
    expect(archived('gitlab.com/team/beta')).toContain('work in beta');
  });
});

describe('session push archive key (native cwd, not the run directory)', () => {
  it('archives under the session native cwd identity instead of the run directory', async () => {
    // 运行目录属于 org/other，会话原生 cwd 属于 team/beta：
    // 归档键必须跟会话 cwd 走（Key invariant，设计文档 P3）
    fakeAdapter([mkSession({ sessionId: 'native-1', title: 'native cwd', cwd: '/proj/beta' })]);
    mocks.remotes['/proj/beta'] = 'https://gitlab.com/team/beta.git';
    mocks.remotes['/run/other'] = 'https://github.com/org/other.git';

    await runSession('push', '--source', 'fakeplat', '--repo-root', repoRoot, '--cwd', '/run/other', '-y');

    const betaDir = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('gitlab.com/team/beta'), 'tester');
    expect(fs.readdirSync(betaDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
    expect(fs.existsSync(path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('github.com/org/other')))).toBe(false);

    // 归档键写进 meta，与目录一致
    const metaPath = fs.readdirSync(betaDir).find((f) => f.endsWith('.meta.json'))!;
    const meta = JSON.parse(fs.readFileSync(path.join(betaDir, metaPath), 'utf-8'));
    expect(meta.origin.repoIdentity).toBe('gitlab.com/team/beta');
  });

  it('archives codebuddy-ide md5 placeholders under _unattributed with an English warning', async () => {
    fakeAdapter(
      [mkSession({ sessionId: 'ide-1', title: 'ide scratch', cwd: 'md5:0123456789abcdef0123456789abcdef', platform: 'codebuddy-ide' })],
      'codebuddy-ide',
    );

    await runSession('push', '--source', 'codebuddy-ide', '--repo-root', repoRoot, '--cwd', '/run/other', '-y');

    expect(warned.join('\n')).toContain(
      'native cwd unknowable for codebuddy-ide session, archived under _unattributed',
    );
    const dir = path.join(repoRoot, 'sessions', '_unattributed', 'tester');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
    const metaPath = fs.readdirSync(dir).find((f) => f.endsWith('.meta.json'))!;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, metaPath), 'utf-8'));
    expect(meta.origin.repoIdentity).toBeNull();
  });
});

describe('session migrate interactive picker', () => {
  /**
   * 预先把答案排进 ask() 的队列。
   *
   * readline 接口一个模块只建一次，所以 'line' 回调是复用的：答案可以直接
   * 灌进去，ask() 会按序消费（ask 还没调到时先进 lineQueue）。
   */
  function feedAnswers(answers: string[]): void {
    const push = () => {
      for (const a of answers) mocks.lineCb?.(a);
    };
    if (mocks.lineCb) {
      push();
      return;
    }
    mocks.lineArmed = push; // 等第一次 createInterface
  }

  it('pages with n and migrates a session from the second page', async () => {
    // 12 sessions: the picker shows 10, the 11th is reachable only after paging.
    const sessions = Array.from({ length: 12 }, (_, i) =>
      mkSession({
        sessionId: `s-${String(i).padStart(2, '0')}`,
        title: `task ${i}`,
        updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    // Newest first, so [11] is the 11th in the list = sessions[1].
    const expected = sessions[1].sessionId;
    fakeAdapter(sessions, 'fakeplat');
    mocks.adaptersByPlatform['tgtplat'] = {
      platform: 'tgtplat',
      listConversations: vi.fn(async () => []),
      readSession: vi.fn(async () => sessions[0]),
    };
    mocks.previewResult = {
      sourcePlatform: 'fakeplat',
      targetPlatform: 'tgtplat',
      sessionTitle: 'task 1',
      sessionId: expected,
      cwd: '/run/dir',
      messageCount: 1,
      fidelity: { score: 1, mode: 1, preservedBlocks: 1, totalBlocks: 1, degradedBlocks: 0, degradations: [], warnings: [] },
    };
    mocks.copyResult = {
      status: 'done',
      sessionId: 'tgt-1',
      cwd: '/run/dir',
      reused: false,
      filePath: '/tmp/tgt.jsonl',
      fidelity: { score: 1 },
    };
    feedAnswers(['n', '11']);
    await runSession('migrate', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir');

    // The picker is on page 2 by the time the number is entered, and the
    // selected id is the 11th newest -- unreachable before paging existed.
    expect(out.join('\n')).toContain('page 2/2');
    expect(mocks.previewCalls).toContainEqual({ session: sessions[1], source: 'fakeplat', target: 'tgtplat' });
  });

  it('cancels on an empty answer instead of paging forever', async () => {
    fakeAdapter([mkSession({ sessionId: 's-1' })], 'fakeplat');
    mocks.adaptersByPlatform['tgtplat'] = {
      platform: 'tgtplat',
      listConversations: vi.fn(async () => []),
      readSession: vi.fn(async () => mkSession()),
    };

    // EOF (piped input) reads as an empty answer: the picker must stop instead
    // of paging forever.
    feedAnswers(['']);
    await runSession('migrate', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir');

    expect(out.join('\n')).toContain('Cancelled.');
  });
});

describe('session migrate --push archive key', () => {
  it('archives under the target session native cwd identity', async () => {
    mocks.previewResult = {
      sourcePlatform: 'fakeplat',
      targetPlatform: 'fakeplat2',
      sessionTitle: 'migrate me',
      sessionId: 'src-1',
      cwd: '/run/dir',
      messageCount: 2,
      fidelity: { score: 1, mode: 1, preservedBlocks: 2, totalBlocks: 2, degradedBlocks: 0, degradations: [], warnings: [] },
    };
    mocks.copyResult = {
      status: 'done',
      sessionId: 'tgt-1',
      cwd: '/run/dir',
      reused: false,
      filePath: '/tmp/tgt.jsonl',
      fidelity: { score: 0.9 },
    };

    fakeAdapter([mkSession({ sessionId: 'src-1', title: 'migrate me', cwd: '/run/dir' })], 'fakeplat');
    const targetSession = mkSession({ sessionId: 'tgt-1', title: 'migrated', cwd: '/proj/target', platform: 'fakeplat2' });
    mocks.adaptersByPlatform['fakeplat2'] = {
      platform: 'fakeplat2',
      listConversations: vi.fn(async () => []),
      readSession: vi.fn(async () => targetSession),
    };
    mocks.remotes['/proj/target'] = 'https://github.com/org/target.git';

    await runSession(
      'migrate', 'src-1', '-s', 'fakeplat', '-t', 'fakeplat2',
      '--push', '-y', '--repo-root', repoRoot, '--cwd', '/run/dir',
    );

    const dir = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('github.com/org/target'), 'tester');
    const metaFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
    expect(metaFiles).toHaveLength(1);

    const meta = JSON.parse(fs.readFileSync(path.join(dir, metaFiles[0]), 'utf-8'));
    // 归档键来自目标会话的原生 cwd，而非 migrate 的运行目录 /run/dir
    expect(meta.origin.repoIdentity).toBe('github.com/org/target');
    expect(meta.migration.sourcePlatform).toBe('fakeplat');
    expect(meta.migration.fidelityScore).toBe(0.9);

    const text = out.join('\n');
    expect(text).toContain('Pushed 1 session(s) to team repo');
    expect(text).not.toMatch(CJK);
  });

  it('drops local image paths when migrate --push --scrub archives the target', async () => {
    const imagePath = '/Users/alice/secret-shot.png';
    mocks.previewResult = {
      sourcePlatform: 'fakeplat',
      targetPlatform: 'fakeplat2',
      sessionTitle: 'migrate me',
      sessionId: 'src-1',
      cwd: '/run/dir',
      messageCount: 1,
      fidelity: { score: 1, mode: 1, preservedBlocks: 1, totalBlocks: 1, degradedBlocks: 0, degradations: [], warnings: [] },
    };
    mocks.copyResult = { status: 'done', sessionId: 'tgt-1', cwd: '/run/dir', reused: false, fidelity: { score: 1 } };
    fakeAdapter([mkSession({ sessionId: 'src-1', cwd: '/run/dir' })], 'fakeplat');
    const targetSession = mkSession({
      sessionId: 'tgt-1',
      title: 'migrated',
      cwd: '/proj/target',
      platform: 'fakeplat2',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', mimeType: 'image/png', filePath: imagePath }],
        },
      ],
    });
    mocks.adaptersByPlatform['fakeplat2'] = {
      platform: 'fakeplat2',
      listConversations: vi.fn(async () => []),
      readSession: vi.fn(async () => targetSession),
    };
    mocks.remotes['/proj/target'] = 'https://github.com/org/target.git';

    await runSession(
      'migrate', 'src-1', '-s', 'fakeplat', '-t', 'fakeplat2',
      '--push', '--scrub', '--repo-root', repoRoot, '--cwd', '/run/dir',
    );

    const dir = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('github.com/org/target'), 'tester');
    const jsonl = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
    const body = fs.readFileSync(path.join(dir, jsonl), 'utf-8');
    expect(body).not.toContain(imagePath);
    expect(body).toContain('[image:');
  });

  it('does not archive migrate --push without --scrub or -y when nobody can confirm', async () => {
    mocks.previewResult = {
      sourcePlatform: 'fakeplat',
      targetPlatform: 'fakeplat2',
      sessionTitle: 'migrate me',
      sessionId: 'src-1',
      cwd: '/run/dir',
      messageCount: 2,
      fidelity: { score: 1, mode: 1, preservedBlocks: 2, totalBlocks: 2, degradedBlocks: 0, degradations: [], warnings: [] },
    };
    mocks.copyResult = { status: 'done', sessionId: 'tgt-1', cwd: '/run/dir', reused: false, fidelity: { score: 1 } };
    fakeAdapter([mkSession({ sessionId: 'src-1' })], 'fakeplat');
    mocks.adaptersByPlatform['fakeplat2'] = {
      platform: 'fakeplat2',
      listConversations: vi.fn(async () => []),
      readSession: vi.fn(async () => mkSession({ sessionId: 'tgt-1' })),
    };

    await runSession(
      'migrate', 'src-1', '-s', 'fakeplat', '-t', 'fakeplat2',
      '--push', '--repo-root', repoRoot, '--cwd', '/run/dir',
    );

    expect(process.exitCode).toBe(1);
    expect(errored.join('\n')).toContain('migrated locally, not archived');
    expect(fs.existsSync(path.join(repoRoot, 'sessions'))).toBe(false);
    expect(out.join('\n')).toContain('Migration successful');
  });

  it('prints a registration warning and still reports the migration as written', async () => {
    mocks.previewResult = {
      sourcePlatform: 'fakeplat',
      targetPlatform: 'tgtplat',
      sessionTitle: 'task',
      sessionId: 's-1',
      cwd: '/run/dir',
      messageCount: 1,
      fidelity: { score: 1, mode: 1, preservedBlocks: 1, totalBlocks: 1, degradedBlocks: 0, degradations: [], warnings: [] },
    };
    mocks.copyResult = {
      status: 'done',
      sessionId: 'tgt-1',
      cwd: '/run/dir',
      reused: false,
      notice: 'Cursor session list registration failed (transcript written, session may be invisible in Cursor): state db not found',
      fidelity: { score: 1 },
    };
    fakeAdapter([mkSession()], 'fakeplat');
    mocks.adaptersByPlatform['tgtplat'] = {
      platform: 'tgtplat',
      listConversations: vi.fn(async () => []),
      readSession: vi.fn(async () => mkSession()),
    };

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir');

    const text = [...out, ...errored].join('\n');
    expect(text).toContain('Migration successful');
    expect(text).toContain('transcript written, session may be invisible');
    expect(process.exitCode).not.toBe(1);
  });
});

describe('session migrate of a session already migrated', () => {
  const preview = {
    sourcePlatform: 'fakeplat',
    targetPlatform: 'tgtplat',
    sessionTitle: 'task',
    sessionId: 's-1',
    cwd: '/run/dir',
    messageCount: 1,
    fidelity: { score: 1, mode: 1, preservedBlocks: 1, totalBlocks: 1, degradedBlocks: 0, degradations: [], warnings: [] },
  };

  // The copy itself is mocked; the target only has to be a platform the CLI knows.
  beforeEach(() => {
    mocks.adaptersByPlatform['tgtplat'] = { platform: 'tgtplat' };
  });

  it('reports the existing copy, how to refresh it, and succeeds', async () => {
    mocks.previewResult = preview;
    mocks.copyResult = { status: 'done', sessionId: 'tgt-1', cwd: '/run/dir', reused: true, fidelity: { score: 1 } };
    fakeAdapter([mkSession()], 'fakeplat');

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir');

    const text = out.join('\n');
    expect(text).toContain('already migrated as tgt-1, nothing written');
    expect(text).toContain('teamai session rollback tgt-1 --platform tgtplat --cwd "/run/dir"');
    expect(text).toContain('0 session(s) migrated, 1 already migrated.');
    expect(text).not.toContain('Migration successful');
    expect(process.exitCode).not.toBe(1);
  });

  it('prints the failure and exits 1 when the copy fails', async () => {
    mocks.previewResult = preview;
    mocks.copyResult = {
      status: 'failed',
      failure: { code: 'invalid_workspace', cwd: 'rel/ws', message: 'Target workspace "rel/ws" is not an absolute path' },
    };
    fakeAdapter([mkSession()], 'fakeplat');

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--target-cwd', 'rel/ws');

    expect(errored.join('\n')).toContain('Migration failed: Target workspace "rel/ws" is not an absolute path');
    expect(process.exitCode).toBe(1);
  });
});

describe('a batch over sessions when one session cannot be read', () => {
  // Three sessions, the middle one unreadable: every batch names it, finishes the other two, and exits 1.
  const ids = ['ok-1', 'bad-2', 'ok-3'];
  const fidelity = { score: 1, mode: 1, preservedBlocks: 1, totalBlocks: 1, degradedBlocks: 0, degradations: [], warnings: [] };
  let copied: string[] = [];

  /** An adapter listing every session in `sessionIds` whose `readSession` throws on `unreadable`. */
  function adapterWith(platform: string, sessionIds: string[], unreadable: string) {
    const adapter = fakeAdapter(
      sessionIds.map((sessionId, i) =>
        mkSession({ sessionId, platform, title: `task ${sessionId}`, updatedAt: `2026-01-0${9 - i}T00:00:00.000Z` }),
      ),
      platform,
    );
    const read = adapter.readSession.getMockImplementation()!;
    adapter.readSession.mockImplementation(async (ref: SessionReadRef) => {
      if (ref.sessionId === unreadable) throw new Error('Unexpected end of JSON input');
      return read(ref);
    });
    // A read by id alone asks whether the session exists, to tell unreadable from missing.
    Object.assign(adapter, { existingSessionId: async (id: string) => (sessionIds.includes(id) ? id : undefined) });
  }

  /** The source session ids archived in the team repo. */
  function archivedIds(): string[] {
    const sessionsDir = path.join(repoRoot, 'sessions');
    if (!fs.existsSync(sessionsDir)) return [];
    return (fs.readdirSync(sessionsDir, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8')).origin.sessionId as string)
      .sort();
  }

  beforeEach(() => {
    copied = [];
    mocks.remotes['/proj/beta'] = 'https://gitlab.com/team/beta.git';
    mocks.previewResult = {
      sourcePlatform: 'fakeplat',
      targetPlatform: 'tgtplat',
      sessionTitle: 'task',
      sessionId: 'x',
      cwd: '/proj/beta',
      messageCount: 2,
      fidelity,
    };
    mocks.copyResult = (request: { from: { sessionId: string } }) => {
      copied.push(request.from.sessionId);
      return { status: 'done', sessionId: `tgt-${request.from.sessionId}`, cwd: '/proj/beta', reused: false, fidelity };
    };
  });

  const cases: Array<{
    name: string;
    setup: () => void;
    argv: string[];
    /** What the run did to the healthy sessions. */
    done: () => string[];
    expected: string[];
    summary: string;
  }> = [
    {
      name: 'migrate --all copies the others',
      setup: () => {
        adapterWith('fakeplat', ids, 'bad-2');
        mocks.adaptersByPlatform['tgtplat'] = { platform: 'tgtplat' };
      },
      argv: ['migrate', '-s', 'fakeplat', '-t', 'tgtplat', '--all', '-y', '--cwd', '/proj/beta'],
      done: () => copied.sort(),
      expected: ['ok-1', 'ok-3'],
      summary: '2 session(s) migrated, 1 failed.',
    },
    {
      name: 'migrate --all --dry-run previews the others',
      setup: () => {
        adapterWith('fakeplat', ids, 'bad-2');
        mocks.adaptersByPlatform['tgtplat'] = { platform: 'tgtplat' };
      },
      argv: ['migrate', '-s', 'fakeplat', '-t', 'tgtplat', '--all', '-y', '--cwd', '/proj/beta', '--dry-run'],
      done: () => out.flatMap((line) => line.match(/not migrated: (\S+?)\.\.\./)?.slice(1) ?? []).sort(),
      expected: ['ok-1', 'ok-3'],
      summary: '2 session(s) would be migrated, 1 failed (--dry-run, no changes made).',
    },
    {
      name: 'migrate --all --push archives the copies it can read back',
      setup: () => {
        adapterWith('fakeplat', ids, '');
        adapterWith('tgtplat', ids.map((id) => `tgt-${id}`), 'tgt-bad-2');
      },
      argv: ['migrate', '-s', 'fakeplat', '-t', 'tgtplat', '--all', '--push', '-y', '--repo-root', '<repo>', '--cwd', '/proj/beta'],
      done: archivedIds,
      expected: ['tgt-ok-1', 'tgt-ok-3'],
      summary: 'Pushed 2 session(s) to team repo',
    },
    {
      name: 'push --all archives the others',
      setup: () => adapterWith('fakeplat', ids, 'bad-2'),
      argv: ['push', '--source', 'fakeplat', '--all', '-y', '--repo-root', '<repo>', '--cwd', '/run/dir'],
      done: archivedIds,
      expected: ['ok-1', 'ok-3'],
      summary: 'Pushed 2 session(s) from fakeplat',
    },
  ];

  it.each(cases)('$name, names the failed one, and exits 1', async ({ setup, argv, done, expected, summary }) => {
    setup();
    // repoRoot is created per test, after the table is built.
    await runSession(...argv.map((a) => (a === '<repo>' ? repoRoot : a)));

    expect(done()).toEqual(expected);
    expect(errored.join('\n')).toMatch(/bad-2/);
    expect(out.join('\n')).toContain(summary);
    expect(process.exitCode).toBe(1);
  });
});

describe('session migrate --json', () => {
  const fidelity = { score: 1, mode: 1, preservedBlocks: 1, totalBlocks: 1, degradedBlocks: 0, degradations: [], warnings: [] };
  const preview = {
    sourcePlatform: 'fakeplat',
    targetPlatform: 'tgtplat',
    sessionTitle: 'task',
    sessionId: 's-1',
    cwd: '/run/dir',
    messageCount: 1,
    fidelity,
  };

  /** stdout must hold exactly one JSON line: the envelope. */
  function envelope(): { data?: Record<string, unknown>; error?: { code: string; message: string } } {
    const lines = out.join('').split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]);
  }

  beforeEach(() => {
    mocks.previewResult = preview;
    fakeAdapter([mkSession()], 'fakeplat');
    mocks.adaptersByPlatform['tgtplat'] = {
      platform: 'tgtplat',
      listConversations: vi.fn(async () => []),
      readSession: vi.fn(async () => mkSession({ sessionId: 'tgt-1' })),
    };
  });

  it('prints the copy as one data envelope and nothing else on stdout', async () => {
    mocks.copyResult = { status: 'done', sessionId: 'tgt-1', cwd: '/run/dir', reused: false, fidelity };

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--json');

    expect(envelope()).toEqual({ data: { sessionId: 'tgt-1', cwd: '/run/dir', reused: false, fidelity } });
    expect(process.exitCode).not.toBe(1);
  });

  it('reports an existing copy as reused', async () => {
    mocks.copyResult = { status: 'done', sessionId: 'tgt-1', cwd: '/run/dir', reused: true, fidelity };

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--json');

    expect(envelope()).toEqual({ data: { sessionId: 'tgt-1', cwd: '/run/dir', reused: true, fidelity } });
    expect(process.exitCode).not.toBe(1);
  });

  it('prints a failed copy as an error envelope with its code and exits 1', async () => {
    const message = 'Target platform "tgtplat" is not installed or its storage directory was not found.';
    mocks.copyResult = { status: 'failed', failure: { code: 'tool_unavailable', platform: 'tgtplat', message } };

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--json');

    expect(envelope()).toEqual({ error: { code: 'tool_unavailable', message } });
    expect(process.exitCode).toBe(1);
  });

  // OpenCode lists its sessions through its CLI, so a missing CLI fails the listing itself.
  it('names a source whose CLI cannot run tool_unavailable', async () => {
    const message = 'The opencode CLI was not found on PATH. Install OpenCode 2 or later.';
    mocks.adaptersByPlatform['fakeplat'] = {
      platform: 'fakeplat',
      isReady: () => true,
      listConversations: vi.fn(async () => {
        throw new ToolUnavailableError(message);
      }),
    };

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--json');

    expect(envelope()).toEqual({ error: { code: 'tool_unavailable', message } });
    expect(process.exitCode).toBe(1);
  });

  it('names a source that could not be listed list_failed', async () => {
    mocks.adaptersByPlatform['fakeplat'] = {
      platform: 'fakeplat',
      isReady: () => true,
      listConversations: vi.fn(async () => {
        throw new Error('EACCES: permission denied');
      }),
    };

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--json');

    expect(envelope()).toEqual({
      error: { code: 'list_failed', message: 'Listing fakeplat sessions failed: EACCES: permission denied' },
    });
    expect(process.exitCode).toBe(1);
  });

  it('names an unknown source platform no_adapter', async () => {
    await runSession('migrate', 's-1', '-s', 'nope', '-t', 'tgtplat', '--cwd', '/run/dir', '--json');

    const { error } = envelope();
    expect(error?.code).toBe('no_adapter');
    expect(error?.message).toContain('Unknown platform "nope"');
    expect(process.exitCode).toBe(1);
  });

  it('names a session missing from the workspace not_found, with the id and the workspace searched', async () => {
    await runSession('migrate', 'gone-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--json');

    expect(envelope()).toEqual({ error: { code: 'not_found', message: 'No fakeplat session gone-1 in /run/dir.' } });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ['the target platform', ['s-1', '-s', 'fakeplat'], '-t'],
    ['the session', ['-s', 'fakeplat', '-t', 'tgtplat'], 'session id'],
    ['consent to archive unredacted', ['s-1', '-s', 'fakeplat', '-t', 'tgtplat', '--push', '--repo-root', '/nowhere'], '-y'],
  ])('refuses to prompt for %s and says which flag answers it', async (_what, args, flag) => {
    // An interactive terminal: without --json each of these would ask.
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.stubEnv('CI', '');
    vi.stubEnv('TEAMAI_NONINTERACTIVE', '');
    try {
      await runSession('migrate', ...args, '--cwd', '/run/dir', '--json');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: wasTTY, configurable: true });
      vi.unstubAllEnvs();
    }

    const { error } = envelope();
    expect(error?.code).toBe('prompt_refused');
    expect(error?.message).toContain(flag);
    expect(process.exitCode).toBe(1);
  });

  it('archives with --push -y and still prints only the envelope', async () => {
    mocks.copyResult = { status: 'done', sessionId: 'tgt-1', cwd: '/run/dir', reused: false, fidelity };

    await runSession(
      'migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--push', '-y', '--repo-root', repoRoot, '--json',
    );

    expect(envelope()).toEqual({ data: { sessionId: 'tgt-1', cwd: '/run/dir', reused: false, fidelity } });
    expect(fs.existsSync(path.join(repoRoot, 'sessions'))).toBe(true);
    expect(process.exitCode).not.toBe(1);
  });

  it('prints a held archive lock as a busy error that names the local copy', async () => {
    mocks.copyResult = { status: 'done', sessionId: 'tgt-1', cwd: '/run/dir', reused: false, fidelity };
    mocks.heldArchiveLock = '/home/.teamai/locks/sessions-x.lock';

    await runSession(
      'migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--push', '-y', '--repo-root', repoRoot, '--json',
    );

    const { error } = envelope();
    expect(error?.code).toBe('busy');
    expect(error?.message).toContain('/home/.teamai/locks/sessions-x.lock');
    expect(error?.message).toContain('tgt-1');
    expect(process.exitCode).toBe(1);
  });

  it('prints a failed remote push as archive_failed that names the local copy and commit', async () => {
    mocks.copyResult = { status: 'done', sessionId: 'tgt-1', cwd: '/run/dir', reused: false, fidelity };
    mocks.pushError = 'Command failed: git push origin\nfatal: no upstream';

    await runSession(
      'migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--push', '-y', '--repo-root', repoRoot, '--json',
    );

    const { error } = envelope();
    expect(error?.code).toBe('archive_failed');
    expect(error?.message).toContain('Copied as tgt-1 in /run/dir');
    expect(error?.message).toContain('abc123de');
    expect(process.exitCode).toBe(1);
  });

  it('prints a --dry-run preview as data and writes nothing', async () => {
    mocks.copyResult = { status: 'failed', failure: { code: 'write_failed', platform: 'tgtplat', message: 'must not copy' } };

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--json', '--dry-run');

    expect(envelope()).toEqual({ data: { dryRun: true, fidelity } });
    expect(process.exitCode).not.toBe(1);
  });

  it('names a source that exists but cannot be parsed unreadable', async () => {
    const listed = path.join(mocks.home, 's-1.jsonl');
    fs.writeFileSync(listed, '{"truncated');
    const adapter = fakeAdapter([mkSession()], 'fakeplat');
    adapter.listConversations.mockImplementation(async () => [
      { sessionId: 's-1', title: 'task', cwd: '/run/dir', platform: 'fakeplat', createdAt: '', updatedAt: '', messageCount: 1, filePath: listed, sizeBytes: 11 },
    ]);
    adapter.readSession.mockRejectedValue(new Error('bad record on line 3'));

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--json');

    const { error } = envelope();
    expect(error?.code).toBe('unreadable');
    expect(error?.message).toContain('bad record on line 3');
    expect(process.exitCode).toBe(1);
  });

  it('names a Claude Code session whose first lines do not parse unreadable, not not_found', async () => {
    const sid = '11111111-2222-3333-4444-555555555555';
    const projDir = path.join(mocks.home, '.claude', 'projects', '-run-dir');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), '{"truncated\nnot json either\n');
    mocks.adaptersByPlatform['claude-code'] = new ClaudeCodeAdapter();

    await runSession('migrate', sid, '-s', 'claude-code', '-t', 'tgtplat', '--cwd', '/run/dir', '--json');

    const { error } = envelope();
    expect(error?.code).toBe('unreadable');
    expect(error?.message).toContain(sid);
    expect(process.exitCode).toBe(1);
  });

  // Cursor and WorkBuddy list a copy only once the sqlite3 CLI registers it, and Windows ships none.
  it.each(['cursor', 'workbuddy'])('refuses %s as a target on Windows once, before listing anything', async (platform) => {
    mocks.adaptersByPlatform[platform] = { platform };
    mocks.os = 'win32';

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', platform, '--cwd', '/run/dir', '--json');

    const { error } = envelope();
    expect(error?.code).toBe('no_adapter');
    expect(error?.message).toContain(`Writing ${platform} sessions is not supported on Windows`);
    expect((mocks.adaptersByPlatform['fakeplat'] as ReturnType<typeof fakeAdapter>).listConversations).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('names an id prefix that matches several sessions ambiguous_id', async () => {
    fakeAdapter([mkSession({ sessionId: 's-1a' }), mkSession({ sessionId: 's-1b' })], 'fakeplat');

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--cwd', '/run/dir', '--json');

    const { error } = envelope();
    expect(error?.code).toBe('ambiguous_id');
    expect(error?.message).toContain('matches 2 sessions');
    expect(process.exitCode).toBe(1);
  });

  it('refuses --all, which would migrate more than the one session an envelope reports', async () => {
    mocks.copyResult = { status: 'done', sessionId: 'tgt-1', cwd: '/run/dir', reused: false, fidelity };

    await runSession('migrate', 's-1', '-s', 'fakeplat', '-t', 'tgtplat', '--all', '-y', '--cwd', '/run/dir', '--json');

    const { error } = envelope();
    expect(error?.code).toBe('unsupported_option');
    expect(error?.message).toContain('--all');
    expect(process.exitCode).toBe(1);
  });
});

describe('session migrate on Windows', () => {
  it.each(['cursor', 'workbuddy'])('refuses %s as a target once, before any preview', async (platform) => {
    const source = fakeAdapter([mkSession(), mkSession({ sessionId: 's-2' })], 'fakeplat');
    mocks.adaptersByPlatform[platform] = { platform };
    mocks.os = 'win32';

    await runSession('migrate', '-s', 'fakeplat', '-t', platform, '--all', '-y', '--cwd', '/run/dir');

    const refusals = errored.filter((line) => line.includes(`Writing ${platform} sessions is not supported on Windows`));
    expect(refusals).toHaveLength(1);
    expect(out.join('\n')).not.toContain('Migration Preview');
    expect(source.listConversations).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('session resume of a session already restored', () => {
  it('writes nothing the second time and keeps a turn added to the restored copy', async () => {
    const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(mocks.home, 'ws-')));
    mocks.remotes[ws] = 'https://github.com/org/alpha.git';
    const session = mkSession({ sessionId: '0b6f3c1e-5a2d-4c8e-9f10-7a1b2c3d4e5f', cwd: ws, platform: 'codex' });
    new SyncManager(repoRoot).saveSession(
      session,
      defaultSyncMeta(
        {
          platform: 'codex',
          author: 'tester',
          cwd: ws,
          sessionId: session.sessionId,
          repoIdentity: 'github.com/org/alpha',
          title: session.title,
        },
        session.createdAt,
      ),
    );
    const indexPath = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('github.com/org/alpha'), '_index.json');
    const name = (JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as { sessions: Array<{ sessionName: string }> })
      .sessions[0].sessionName;
    mocks.adaptersByPlatform['claude-code'] = new ClaudeCodeAdapter();
    const resume = () => runSession('resume', name, '--platform', 'claude-code', '--repo-root', repoRoot, '--cwd', ws);

    await resume();
    const projects = path.join(mocks.home, '.claude', 'projects');
    const [transcript] = (fs.readdirSync(projects, { recursive: true }) as string[]).filter((f) => f.endsWith('.jsonl'));
    const restoredId = path.basename(transcript, '.jsonl');
    fs.appendFileSync(path.join(projects, transcript), JSON.stringify({ type: 'user', message: { content: 'later turn' } }) + '\n');
    const before = fs.readFileSync(path.join(projects, transcript), 'utf-8');
    out = [];

    await resume();

    expect(out.join('\n')).toContain(`Session already restored as ${restoredId}, nothing written.`);
    expect(fs.readFileSync(path.join(projects, transcript), 'utf-8')).toBe(before);
    expect(process.exitCode).not.toBe(1);
  });
});

describe('session resume of a restore whose write failed', () => {
  it('leaves nothing behind, and a retry restores the session', async () => {
    const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(mocks.home, 'ws-')));
    mocks.remotes[ws] = 'https://github.com/org/alpha.git';
    const session = mkSession({ sessionId: '0b6f3c1e-5a2d-4c8e-9f10-7a1b2c3d4e5f', cwd: ws, platform: 'codex' });
    new SyncManager(repoRoot).saveSession(
      session,
      defaultSyncMeta(
        {
          platform: 'codex',
          author: 'tester',
          cwd: ws,
          sessionId: session.sessionId,
          repoIdentity: 'github.com/org/alpha',
          title: session.title,
        },
        session.createdAt,
      ),
    );
    const indexPath = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('github.com/org/alpha'), '_index.json');
    const name = (JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as { sessions: Array<{ sessionName: string }> })
      .sessions[0].sessionName;
    mocks.adaptersByPlatform['claude-code'] = new ClaudeCodeAdapter();
    const projects = path.join(mocks.home, '.claude', 'projects');
    const transcripts = () =>
      fs.existsSync(projects) ? (fs.readdirSync(projects, { recursive: true }) as string[]).filter((f) => f.endsWith('.jsonl')) : [];
    const resume = () => runSession('resume', name, '--platform', 'claude-code', '--repo-root', repoRoot, '--cwd', ws);
    // The transcript lands, then the write fails, the way a crash after a partial write looks.
    const write = ClaudeCodeAdapter.prototype.writeSession;
    const spy = vi.spyOn(ClaudeCodeAdapter.prototype, 'writeSession').mockImplementation(async function (
      this: ClaudeCodeAdapter,
      ...args
    ) {
      await write.apply(this, args);
      throw new Error('disk full');
    });

    await resume();
    spy.mockRestore();

    expect(errored.join('\n')).toContain('disk full');
    expect(process.exitCode).toBe(1);
    expect(transcripts()).toEqual([]);

    process.exitCode = 0;
    await resume();

    expect(out.join('\n')).toContain('Session restored to claude-code');
    expect(transcripts()).toHaveLength(1);
    expect(process.exitCode).not.toBe(1);
  });
});

describe('session resume on Windows', () => {
  it.each(['cursor', 'workbuddy'])('refuses to restore into %s, which would never show the copy', async (platform) => {
    mocks.remotes['/run/dir'] = 'https://github.com/org/alpha.git';
    const session = mkSession({ cwd: '/run/dir', platform: 'claude-code' });
    new SyncManager(repoRoot).saveSession(
      session,
      defaultSyncMeta(
        {
          platform: 'claude-code',
          author: 'tester',
          cwd: '/run/dir',
          sessionId: session.sessionId,
          repoIdentity: 'github.com/org/alpha',
          title: session.title,
        },
        session.createdAt,
      ),
    );
    const indexPath = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('github.com/org/alpha'), '_index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as { sessions: Array<{ sessionName: string }> };
    const writeSession = vi.fn(async () => 'should-not-write');
    const existingSessionId = vi.fn(async () => undefined);
    mocks.adaptersByPlatform[platform] = { platform, writeSession, existingSessionId, consumeWriteNotice: () => undefined };
    mocks.os = 'win32';

    await runSession(
      'resume', index.sessions[0].sessionName,
      '--platform', platform, '--repo-root', repoRoot, '--cwd', '/run/dir',
    );

    expect(errored.join('\n')).toContain(`Writing ${platform} sessions is not supported on Windows`);
    expect(writeSession).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('session resume --dry-run', () => {
  it('strips terminal control sequences from the archived title', async () => {
    const title = 'pay\u001b[31mment\u001b[0m';
    mocks.remotes['/run/dir'] = 'https://github.com/org/alpha.git';
    const session = mkSession({ title, cwd: '/run/dir', platform: 'claude-code' });
    new SyncManager(repoRoot).saveSession(
      session,
      defaultSyncMeta(
        {
          platform: 'claude-code',
          author: 'tester',
          cwd: '/run/dir',
          sessionId: session.sessionId,
          repoIdentity: 'github.com/org/alpha',
          title,
        },
        session.createdAt,
      ),
    );
    const indexPath = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('github.com/org/alpha'), '_index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as { sessions: Array<{ sessionName: string }> };
    const writeSession = vi.fn(async () => 'should-not-write');
    mocks.adaptersByPlatform['claude-code'] = { platform: 'claude-code', writeSession };

    await runSession(
      'resume', index.sessions[0].sessionName,
      '--platform', 'claude-code', '--repo-root', repoRoot, '--cwd', '/run/dir', '--dry-run',
    );

    const text = out.join('\n');
    expect(text).toContain('Dry-run: would restore');
    expect(text).toContain('[31mment');
    expect(text).not.toContain('\u001b');
    expect(writeSession).not.toHaveBeenCalled();
  });
});

describe('session rollback', () => {
  it('refuses a session id that is not a single path segment', async () => {
    const outside = path.join(repoRoot, 'outside.jsonl');
    fs.writeFileSync(outside, '{}\n');
    const storage = path.join(repoRoot, 'store');
    fs.mkdirSync(storage);
    const adapter = new ClaudeCodeAdapter('claude-code', storage);
    await expect(adapter.deleteSession('../../outside', path.join(repoRoot, 'proj'))).rejects.toThrow(
      /single path segment/,
    );
    expect(fs.existsSync(outside)).toBe(true);

    await runSession('rollback', '../../outside', '--platform', 'claude-code');
    expect(process.exitCode).toBe(1);
    expect(errored.join('\n')).toContain('single path segment');
    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe('claude-code readSession: message order', () => {
  it('keeps turn order when the chain runs through system and attachment lines', async () => {
    const SID = '11111111-2222-4333-8444-555555555555';
    const projDir = path.join(mocks.home, '.claude', 'projects', '-work-app');
    fs.mkdirSync(projDir, { recursive: true });
    const rec = (uuid: string, parentUuid: string | null, extra: Record<string, unknown>) => ({
      parentUuid, isSidechain: false, uuid, cwd: '/work/app', sessionId: SID, timestamp: '2026-10-01T10:00:00.000Z', ...extra,
    });
    const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
    const asst = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    const lines = [
      rec('u1', null, user('Q1')),
      rec('a1', 'u1', asst('A1')),
      rec('s1', 'a1', { type: 'system', subtype: 'turn_duration', durationMs: 1200 }),
      rec('u2', 's1', user('Q2')),
      rec('a2', 'u2', asst('A2')),
      rec('t1', 'a2', { type: 'attachment', attachment: { type: 'todo_reminder', content: [] } }),
      rec('u3', 't1', user('Q3')),
      rec('a3', 'u3', asst('A3')),
    ];
    fs.writeFileSync(path.join(projDir, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const session = await new ClaudeCodeAdapter().readSession({ sessionId: SID });
    const order = session.messages.map((m) => (m.content[0] as { text: string }).text);
    expect(order).toEqual(['Q1', 'A1', 'Q2', 'A2', 'Q3', 'A3']);
  });
});

describe('adapters: native cwd recovery from JSONL records', () => {
  // 带空格的路径：目录名编码有损（空格与 / 无法区分），记录里的 cwd 才是真相。
  // 归档键（repoIdentity）依赖 readSession 返回记录 cwd 而非解码目录名。
  const NATIVE = '/Users/x/my project';
  const SID = '11111111-2222-3333-4444-555555555555';

  it('claude-code readSession prefers the record cwd over the lossy directory name', async () => {
    const projDir = path.join(mocks.home, '.claude', 'projects', '-Users-x-my-project');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, `${SID}.jsonl`),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        cwd: NATIVE,
        timestamp: '2026-01-02T00:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: false,
      }) + '\n',
    );

    const session = await new ClaudeCodeAdapter().readSession({ sessionId: SID });
    expect(session.cwd).toBe(NATIVE);
  });

  it('codebuddy readSession prefers the record cwd over the identity-decoded directory name', async () => {
    const projDir = path.join(mocks.home, '.codebuddy', 'projects', 'Users-x-my-project');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, `${SID}.jsonl`),
      JSON.stringify({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
        cwd: NATIVE,
        timestamp: 1767000000000,
        id: 'm1',
        parentId: null,
        sessionId: SID,
      }) + '\n',
    );

    const session = await new CodeBuddyAdapter().readSession({ sessionId: SID });
    expect(session.cwd).toBe(NATIVE);
  });

  it('cursor readSession prefers the record cwd over the lossy directory name', async () => {
    const transcriptDir = path.join(
      mocks.home, '.cursor', 'projects', 'Users-x-my-project', 'agent-transcripts', SID,
    );
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(transcriptDir, `${SID}.jsonl`),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'hi' }] },
        cwd: NATIVE,
      }) + '\n',
    );

    const session = await new CursorAdapter().readSession({ sessionId: SID });
    expect(session.cwd).toBe(NATIVE);
  });
});

describe('codex readSession: freeform tool calls', () => {
  it('keeps the apply_patch input of a custom_tool_call', async () => {
    const SID = '019e0000-1111-7222-8333-444444444444';
    const dir = path.join(mocks.home, '.codex', 'sessions', '2026', '10', '01');
    fs.mkdirSync(dir, { recursive: true });
    const patch = '*** Begin Patch\n*** Update File: src/main.ts\n@@\n-a\n+b\n*** End Patch\n';
    const lines = [
      { type: 'session_meta', payload: { id: SID, timestamp: '2026-10-01T10:00:00.000Z', cwd: '/work/app' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'edit it' }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: patch } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_1', output: 'Success.' } },
    ];
    fs.writeFileSync(
      path.join(dir, `rollout-2026-10-01T10-00-00-${SID}.jsonl`),
      lines.map((l) => JSON.stringify({ timestamp: '2026-10-01T10:00:00.000Z', ...l })).join('\n') + '\n',
    );

    const session = await new CodexAdapter().readSession({ sessionId: SID });
    const call = session.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_call');
    expect(call).toMatchObject({ type: 'tool_call', toolName: 'edit_file', callId: 'call_1', arguments: { input: patch } });
  });
});
