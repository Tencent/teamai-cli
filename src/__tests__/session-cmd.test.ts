import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  gitCalls: [] as Array<{ args: string[]; cwd?: string }>,
  adaptersByPlatform: {} as Record<string, unknown>,
  /** migrate.js mock 的 preview/migrate 返回值 */
  previewResult: null as unknown,
  migrateResult: null as unknown,
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
  patched.default = { ...(actual.default ?? {}), homedir: () => mocks.home };
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
}));

vi.mock('../session-flow/migrate.js', () => ({
  MigrationEngine: class {
    constructor(
      public readonly source: string,
      public readonly target: string,
    ) {}
    async preview(): Promise<unknown> {
      return mocks.previewResult;
    }
    async migrate(): Promise<unknown> {
      return mocks.migrateResult;
    }
  },
}));

import { registerSessionFlowCommands } from '../session-flow/session-cmd.js';
import { SyncManager, defaultSyncMeta } from '../session-flow/sync.js';
import type { Session } from '../session-flow/ir.js';
import { ClaudeCodeAdapter } from '../session-flow/adapters/claude-code.js';
import { CodeBuddyAdapter } from '../session-flow/adapters/codebuddy.js';
import { CursorAdapter } from '../session-flow/adapters/cursor.js';

let repoRoot: string;
/** console.log + process.stdout.write 的合并捕获（ask 的提示走 stdout.write） */
let out: string[] = [];
let warned: string[] = [];

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cmd-'));
  mocks.home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cmd-home-'));
  out = [];
  warned = [];
  mocks.remotes = {};
  mocks.porcelain = 'M  sessions/changed\n';
  mocks.gitCalls.length = 0;
  mocks.adaptersByPlatform = {};
  mocks.previewResult = null;
  mocks.migrateResult = null;
  mocks.lineArmed = null;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warned.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
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
  const adapter = {
    platform,
    listConversations: vi.fn(async () =>
      sessions.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        cwd: s.cwd,
        platform,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
        filePath: '/tmp/x',
        sizeBytes: 100,
      })),
    ),
    readSession: vi.fn(async (id: string) => {
      const s = byId.get(id);
      if (!s) throw new Error(`session not found: ${id}`);
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
    const idxPath = path.join(repoRoot, 'sessions', 'repos', 'github.com_org_alpha', '_index.json');
    fs.writeFileSync(
      idxPath,
      JSON.stringify({ version: 1, repoIdentity: 'github.com/org/alpha', updatedAt: '2026-01-01T00:00:00.000Z', sessions: [] }),
    );

    await runSession('pull', '--all', '--repo-root', repoRoot);

    const text = out.join('\n');
    expect(text).toContain('Pulled and indexed 2 session(s) across 2 repo(s)');
    expect(mocks.gitCalls.some((c) => c.args[0] === 'pull')).toBe(true);

    const restored = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
    expect(restored.sessions).toHaveLength(1);
    expect(restored.sessions[0].sessionId).toBe('a-1');
    expect(text).not.toMatch(CJK);
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
    expect(adapter.listConversations).toHaveBeenCalledWith();

    const dir = path.join(repoRoot, 'sessions', 'repos', 'gitlab.com_team_beta', 'tester');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(8);

    const text = out.join('\n');
    expect(text).toContain('Pushed 8 session(s) from fakeplat');
    expect(text).toContain('Source: /proj/beta');
    expect(text).not.toMatch(CJK);
  });

  it('asks for confirmation before pushing more than five sessions', async () => {
    const adapter = fakeAdapter(manySessions(6));
    mocks.remotes['/proj/beta'] = 'https://gitlab.com/team/beta.git';

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

    const text = out.join('\n');
    expect(text).toContain('About to push 6 session(s) from fakeplat:');
    expect(text).toContain('Push all of the above?');
    expect(text).toContain('Cancelled.');
    // 拒绝后不读取、不落盘任何会话
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

    await runSession('push', '--source', 'fakeplat', '--repo-root', repoRoot, '--cwd', '/run/dir');

    const text = out.join('\n');
    expect(text).toContain('No changes to push');
    // 会话文件本身已写入（commit 检测发生在 saveSession 之后）
    const dir = path.join(repoRoot, 'sessions', 'repos', 'gitlab.com_team_beta', 'tester');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
    expect(mocks.gitCalls.some((c) => c.args[0] === 'push')).toBe(false);
  });
});

describe('session push archive key (native cwd, not the run directory)', () => {
  it('archives under the session native cwd identity instead of the run directory', async () => {
    // 运行目录属于 org/other，会话原生 cwd 属于 team/beta：
    // 归档键必须跟会话 cwd 走（Key invariant，设计文档 P3）
    fakeAdapter([mkSession({ sessionId: 'native-1', title: 'native cwd', cwd: '/proj/beta' })]);
    mocks.remotes['/proj/beta'] = 'https://gitlab.com/team/beta.git';
    mocks.remotes['/run/other'] = 'https://github.com/org/other.git';

    await runSession('push', '--source', 'fakeplat', '--repo-root', repoRoot, '--cwd', '/run/other');

    const betaDir = path.join(repoRoot, 'sessions', 'repos', 'gitlab.com_team_beta', 'tester');
    expect(fs.readdirSync(betaDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
    expect(fs.existsSync(path.join(repoRoot, 'sessions', 'repos', 'github.com_org_other'))).toBe(false);

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

    await runSession('push', '--source', 'codebuddy-ide', '--repo-root', repoRoot, '--cwd', '/run/other');

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
    mocks.migrateResult = {
      success: true,
      targetSessionId: 'tgt-1',
      targetFilePath: '/tmp/tgt.jsonl',
      preview: { fidelity: { score: 0.9 } },
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
      '--push', '--repo-root', repoRoot, '--cwd', '/run/dir',
    );

    const dir = path.join(repoRoot, 'sessions', 'repos', 'github.com_org_target', 'tester');
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

    const session = await new ClaudeCodeAdapter().readSession(SID);
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

    const session = await new CodeBuddyAdapter().readSession(SID);
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

    const session = await new CursorAdapter().readSession(SID);
    expect(session.cwd).toBe(NATIVE);
  });
});
