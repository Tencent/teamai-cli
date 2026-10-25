import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { SyncManager, defaultSyncMeta, encodeRepoIdentity, type PullResult } from '../session-flow/sync.js';
import { registerSessionFlowCommands } from '../session-flow/session-cmd.js';
import type { Session } from '../session-flow/ir.js';

const lock = vi.hoisted(() => ({
  /** When set, the session archive lock reports this path as held by another command. */
  heldBy: '',
}));

vi.mock('../session-flow/sync.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../session-flow/sync.js');
  class MockSyncManager extends actual.SyncManager {
    override commitRebuiltIndexes(indexes: string[]) {
      return lock.heldBy
        ? Promise.resolve({ status: 'busy' as const, lockPath: lock.heldBy })
        : super.commitRebuiltIndexes(indexes);
    }
  }
  return {
    ...actual,
    SyncManager: MockSyncManager,
  };
});

const REPO = 'github.com/acme/app';
const INDEX = `sessions/repos/${encodeRepoIdentity(REPO)}/_index.json`;

let tmp: string;
const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM, home: process.env.HOME };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function useGitConfig(extra = ''): void {
  const file = path.join(tmp, 'gitconfig');
  fs.writeFileSync(file, `[user]\n\tname = tester\n\temail = tester@example.com\n${extra}`);
  process.env.GIT_CONFIG_GLOBAL = file;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
}

async function archive(clone: string, sessionId: string, author: string): Promise<void> {
  const session: Session = {
    sessionId,
    title: `session ${sessionId}`,
    cwd: '/proj/app',
    platform: 'claude-code',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:05:05.000Z',
    messages: [{ role: 'user', content: [{ type: 'text', text: `work on ${sessionId}` }] }],
    metadata: {},
  };
  const meta = defaultSyncMeta(
    { platform: 'claude-code', author, cwd: '/proj/app', sessionId, repoIdentity: REPO, title: session.title },
    session.createdAt,
  );
  const mgr = new SyncManager(clone);
  await mgr.saveSession(session, meta);
  mgr.gitCommit(`sync: ${sessionId}`);
}

function clone(name: string): string {
  const dir = path.join(tmp, name);
  git(tmp, 'clone', '-q', path.join(tmp, 'remote.git'), dir);
  return dir;
}

function sessionIdsOf(indexJson: string): string[] {
  const index = JSON.parse(indexJson) as { sessions: { sessionId: string }[] };
  return index.sessions.map((s) => s.sessionId).sort();
}

function indexedSessionIds(clone: string): string[] {
  return sessionIdsOf(fs.readFileSync(path.join(clone, INDEX), 'utf-8'));
}

/** Pull, and finish a merge stopped on the session indexes the way the session commands do. */
async function pullAndRebuild(clone: string): Promise<PullResult> {
  const mgr = new SyncManager(clone);
  const result = mgr.gitPull();
  if (result.status === 'indexes-conflicted') await mgr.commitRebuiltIndexes(result.indexes);
  return result;
}

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** Runs `teamai session <args>`. */
async function session(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitCalled(Number(code ?? 0));
  });
  process.exitCode = 0;
  let code: number;
  try {
    const program = new Command();
    program.option('--dry-run', 'preview');
    registerSessionFlowCommands(program.command('session'));
    await program.parseAsync(['node', 'teamai', 'session', ...args]);
    code = Number(process.exitCode ?? 0);
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err;
    code = err.code;
  } finally {
    vi.restoreAllMocks();
    process.exitCode = 0;
  }
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function conflictOnNotes(a: string, b: string): void {
  for (const [clone, text] of [[a, 'from a\n'], [b, 'from b\n']]) {
    fs.writeFileSync(path.join(clone, 'notes.md'), text);
    git(clone, 'add', 'notes.md');
    git(clone, 'commit', '-qm', 'notes');
  }
  git(a, 'push', '-q', 'origin', 'main');
}

async function seedRemote(): Promise<{ a: string; b: string }> {
  git(tmp, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  const seed = clone('seed');
  await archive(seed, 's0', 'carol');
  git(seed, 'push', '-q', 'origin', 'main');
  return { a: clone('a'), b: clone('b') };
}

async function divergeOnIndex(): Promise<{ a: string; b: string }> {
  const { a, b } = (await seedRemote());
  await archive(a, 'a1', 'alice');
  git(a, 'push', '-q', 'origin', 'main');
  await archive(b, 'b1', 'bob');
  return { a, b };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-pull-')));
  process.env.HOME = path.join(tmp, 'home');
  lock.heldBy = '';
});

afterEach(() => {
  process.env.HOME = savedEnv.home;
  if (savedEnv.home === undefined) delete process.env.HOME;
  process.env.GIT_CONFIG_GLOBAL = savedEnv.global;
  process.env.GIT_CONFIG_NOSYSTEM = savedEnv.nosystem;
  if (savedEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  if (savedEnv.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SyncManager.gitPull', () => {
  it.each([
    ['no pull config', ''],
    ['pull.rebase=false', '[pull]\n\trebase = false\n'],
    ['pull.rebase=true', '[pull]\n\trebase = true\n'],
    ['pull.ff=only', '[pull]\n\tff = only\n'],
  ])('merges a diverged session index and rebuilds it (%s)', async (_label, pullConfig) => {
    useGitConfig(pullConfig);
    const { b } = (await divergeOnIndex());

    const result = (await pullAndRebuild(b));

    expect(result).toEqual({ status: 'indexes-conflicted', indexes: [INDEX] });
    expect(indexedSessionIds(b)).toEqual(['a1', 'b1', 's0']);
    expect(git(b, 'status', '--porcelain')).toBe('');
  });

  it('aborts the merge and names the files when another file conflicts too', async () => {
    useGitConfig();
    const { a, b } = (await divergeOnIndex());
    conflictOnNotes(a, b);
    const headBefore = git(b, 'rev-parse', 'HEAD');

    const result = new SyncManager(b).gitPull();

    expect(result).toEqual({
      status: 'stopped',
      reason: `Pull stopped on conflicts in notes.md and was aborted. Run \`git pull --no-rebase\` in ${b}, resolve and \`git add\` those files, then run \`teamai session pull\` to rebuild the session indexes and finish the merge.`,
    });
    expect(git(b, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(b, 'status', '--porcelain')).toBe('');
  });

  it('points at git commit when only another file conflicts', async () => {
    useGitConfig();
    const { a, b } = (await seedRemote());
    conflictOnNotes(a, b);

    const result = new SyncManager(b).gitPull();

    expect(result).toEqual({
      status: 'stopped',
      reason: `Pull stopped on conflicts in notes.md and was aborted. Run \`git pull --no-rebase\` in ${b}, resolve and \`git add\` those files, run \`git commit\`, then retry.`,
    });
    expect(git(b, 'status', '--porcelain')).toBe('');
  });

  it('finishes a merge an earlier pull left stopped on the index', async () => {
    useGitConfig();
    const { b } = (await divergeOnIndex());
    expect(() => git(b, '-c', 'pull.rebase=false', 'pull', '-q', 'origin', 'main')).toThrow();

    const result = (await pullAndRebuild(b));

    expect(result).toEqual({ status: 'indexes-conflicted', indexes: [INDEX], pending: true });
    expect(indexedSessionIds(b)).toEqual(['a1', 'b1', 's0']);
    expect(git(b, 'status', '--porcelain')).toBe('');
  });

  it('leaves a merge with other conflicts for the user to finish', async () => {
    useGitConfig();
    const { a, b } = (await divergeOnIndex());
    conflictOnNotes(a, b);
    expect(() => git(b, '-c', 'pull.rebase=false', 'pull', '-q', 'origin', 'main')).toThrow();

    const result = new SyncManager(b).gitPull();

    expect(result).toEqual({
      status: 'stopped',
      reason: `A merge is in progress in ${b} with conflicts in notes.md. Resolve and \`git add\` them, or run \`git merge --abort\`, then run \`teamai session pull\`.`,
    });
    expect(git(b, 'status', '--porcelain')).toMatch(/^AA notes\.md$/m);
  });

  it('leaves a merge with only another file in conflict for the user to commit', async () => {
    useGitConfig();
    const { a, b } = (await seedRemote());
    conflictOnNotes(a, b);
    expect(() => git(b, '-c', 'pull.rebase=false', 'pull', '-q', 'origin', 'main')).toThrow();

    const result = new SyncManager(b).gitPull();

    expect(result).toEqual({
      status: 'stopped',
      reason: `A merge is in progress in ${b} with conflicts in notes.md. Resolve and \`git add\` them and run \`git commit\`, or run \`git merge --abort\`, then retry.`,
    });
    expect(git(b, 'status', '--porcelain')).toMatch(/^AA notes\.md$/m);
  });

  it('leaves a merge with nothing unmerged for the user to commit', async () => {
    useGitConfig();
    const { b } = (await divergeOnIndex());
    git(b, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(b, 'notes.md'), 'feature\n');
    git(b, 'add', 'notes.md');
    git(b, 'commit', '-qm', 'feature');
    git(b, 'checkout', '-q', 'main');
    git(b, 'merge', '-q', '--no-commit', '--no-ff', 'feature');
    const headBefore = git(b, 'rev-parse', 'HEAD');

    const result = new SyncManager(b).gitPull();

    expect(result).toEqual({
      status: 'stopped',
      reason: `A merge is in progress in ${b}. Run \`git commit\` or \`git merge --abort\` there, then retry.`,
    });
    expect(git(b, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(() => git(b, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).not.toThrow();
  });

  it('leaves unmerged files from another git operation alone', async () => {
    useGitConfig();
    const { b } = (await divergeOnIndex());
    const index = path.join(b, INDEX);
    const committed = fs.readFileSync(index, 'utf-8');
    fs.writeFileSync(index, committed.replace('"version": 1', '"version": 2'));
    git(b, 'stash', '-q');
    fs.writeFileSync(index, committed.replace('"version": 1', '"version": 3'));
    git(b, 'commit', '-qam', 'local index edit');
    expect(() => git(b, 'stash', 'pop', '-q')).toThrow();
    const headBefore = git(b, 'rev-parse', 'HEAD');

    const result = new SyncManager(b).gitPull();

    expect(result).toEqual({
      status: 'stopped',
      reason: `Unmerged files in ${b} block the pull: ${INDEX}. Finish or abort the git operation that left them, then retry.`,
    });
    expect(git(b, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(b, 'status', '--porcelain')).toMatch(/^UU /m);
  });

  it.each([
    ['merge.autostash', '[merge]\n\tautostash = true\n'],
    ['pull.autostash', '[pull]\n\tautostash = true\n'],
  ])('refuses to merge over local index edits instead of autostashing them (%s)', async (_label, autostashConfig) => {
    useGitConfig(autostashConfig);
    const { b } = (await divergeOnIndex());
    const index = path.join(b, INDEX);
    fs.writeFileSync(index, fs.readFileSync(index, 'utf-8').replace('"version": 1', '"version": 2'));

    expect(() => new SyncManager(b).gitPull()).toThrow(/would be overwritten by merge/);
    expect(git(b, 'stash', 'list')).toBe('');
    expect(git(b, 'diff', '--name-only')).toBe(INDEX);
  });

  // Each side's index as committed: 'kept' leaves its repoIdentity, anything else replaces it (undefined drops it).
  it.each([
    ['ours has none, theirs has it', undefined, 'kept'],
    ['ours is null, theirs has it', null, 'kept'],
    ['ours is empty, theirs has it', '', 'kept'],
    ['ours is not a string, theirs has it', 42, 'kept'],
    ['ours has it, theirs has none', 'kept', undefined],
    ['neither has one, so the directory name decides', undefined, null],
  ])('takes the repo identity from a side that recorded one (%s)', async (_label, ours, theirs) => {
    useGitConfig();
    const { a, b } = (await seedRemote());
    const commitIndex = async (clone: string, sessionId: string, author: string, identity: unknown): Promise<void> => {
      await archive(clone, sessionId, author);
      if (identity === 'kept') return;
      const file = path.join(clone, INDEX);
      const index = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      if (identity === undefined) delete index.repoIdentity;
      else index.repoIdentity = identity;
      fs.writeFileSync(file, JSON.stringify(index, null, 2));
      git(clone, 'commit', '-qam', `edit ${sessionId} index`);
    };
    await commitIndex(a, 'a1', 'alice', theirs);
    git(a, 'push', '-q', 'origin', 'main');
    await commitIndex(b, 'b1', 'bob', ours);

    expect((await pullAndRebuild(b)).status).toBe('indexes-conflicted');

    const index = JSON.parse(fs.readFileSync(path.join(b, INDEX), 'utf-8')) as { repoIdentity: unknown };
    expect(index.repoIdentity).toBe(REPO);
  });

  it('keeps the identity a legacy directory name cannot encode', async () => {
    useGitConfig();
    const identity = 'github.com/acme/my_app';
    const dir = 'sessions/repos/github.com_acme_my_app';
    const writeLegacy = (clone: string, ids: string[]): void => {
      for (const id of ids) {
        const meta = defaultSyncMeta(
          { platform: 'claude-code', author: 'dana', cwd: '/proj/app', sessionId: id, repoIdentity: identity, title: id },
          '2026-01-02T03:04:05.000Z',
        );
        fs.mkdirSync(path.join(clone, dir, 'dana'), { recursive: true });
        fs.writeFileSync(path.join(clone, dir, 'dana', `${id}.meta.json`), JSON.stringify(meta));
        fs.writeFileSync(path.join(clone, dir, 'dana', `${id}.jsonl`), '{}\n');
      }
      const sessions = ids.map((sessionId) => ({ sessionId }));
      fs.writeFileSync(path.join(clone, dir, '_index.json'), JSON.stringify({ version: 1, repoIdentity: identity, sessions }, null, 2));
      git(clone, 'add', '.');
      git(clone, 'commit', '-qm', ids.join(' '));
    };
    git(tmp, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
    const seed = clone('seed');
    writeLegacy(seed, ['s0']);
    git(seed, 'push', '-q', 'origin', 'main');
    const a = clone('a');
    const b = clone('b');
    writeLegacy(a, ['s0', 'a1']);
    git(a, 'push', '-q', 'origin', 'main');
    writeLegacy(b, ['s0', 'b1']);

    const result = (await pullAndRebuild(b));

    expect(result).toEqual({ status: 'indexes-conflicted', indexes: [`${dir}/_index.json`] });
    const index = JSON.parse(fs.readFileSync(path.join(b, dir, '_index.json'), 'utf-8')) as { repoIdentity: string };
    expect(index.repoIdentity).toBe(identity);
  });

  it('refuses to pull while a rebase is stopped', async () => {
    useGitConfig();
    const { b } = (await divergeOnIndex());
    expect(() => git(b, '-c', 'pull.rebase=true', 'pull', '-q', 'origin', 'main')).toThrow();

    const result = new SyncManager(b).gitPull();

    expect(result).toEqual({
      status: 'stopped',
      reason: `A rebase is in progress in ${b}. Run \`git rebase --abort\` there, then retry.`,
    });
  });
});

describe('session pull', () => {
  it('finishes a merge an earlier pull left on the session index, then pulls what the remote got since', async () => {
    useGitConfig();
    const { a, b } = (await divergeOnIndex());
    expect(() => git(b, '-c', 'pull.rebase=false', 'pull', '-q', 'origin', 'main')).toThrow();
    await archive(a, 'a2', 'alice');
    git(a, 'push', '-q', 'origin', 'main');

    const pulled = await session('pull', '--all', '--repo-root', b);

    expect(pulled.code).toBe(0);
    expect(() => git(b, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD')).not.toThrow();
    expect(git(b, 'rev-parse', 'origin/main')).toBe(git(a, 'rev-parse', 'HEAD'));
    expect(sessionIdsOf(git(b, 'show', `HEAD:${INDEX}`))).toEqual(['a1', 'a2', 'b1', 's0']);
    expect(() => git(b, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(git(b, 'status', '--porcelain')).toBe('');
    const merged = fs.readFileSync(path.join(b, INDEX), 'utf-8');
    expect((await session('pull', '--all', '--repo-root', b)).code).toBe(0);
    expect(fs.readFileSync(path.join(b, INDEX), 'utf-8')).toBe(merged);
  });

  it('leaves a merge stopped on the session index for a rerun while another command holds the archive lock', async () => {
    useGitConfig();
    const { b } = (await divergeOnIndex());
    lock.heldBy = path.join(tmp, 'home', '.teamai', 'locks', 'sessions-held.lock');

    const busy = await session('pull', '--all', '--repo-root', b);

    expect(git(b, 'status', '--porcelain')).toContain(`UU ${INDEX}`);
    expect(busy.code).toBe(1);
    expect(busy.stderr).toContain(`another teamai command is writing the session archive in ${b} (lock: ${lock.heldBy}).`);
    expect(busy.stderr).toContain('run `teamai session pull` once it has finished');

    lock.heldBy = '';
    const rerun = await session('pull', '--all', '--repo-root', b);

    expect(rerun.code).toBe(0);
    expect(rerun.stdout).toContain('Merged remote sessions and rebuilt 1 conflicted session index(es)');
    expect(() => git(b, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(sessionIdsOf(git(b, 'show', `HEAD:${INDEX}`))).toEqual(['a1', 'b1', 's0']);
    expect(git(b, 'status', '--porcelain')).toBe('');
  });
});

describe('session push --all', () => {
  it('skips an unreadable session, still merges a diverged index and pushes the rest, and exits 1', async () => {
    useGitConfig();
    const { b } = (await divergeOnIndex());
    const projects = path.join(tmp, 'home', '.claude', 'projects', '-proj-app');
    fs.mkdirSync(projects, { recursive: true });
    const record = (text: string) =>
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        cwd: '/proj/app',
        timestamp: '2026-01-02T00:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: false,
      }) + '\n';
    fs.writeFileSync(path.join(projects, '11111111-1111-4111-8111-111111111111.jsonl'), record('first'));
    fs.writeFileSync(path.join(projects, '22222222-2222-4222-8222-222222222222.jsonl'), '{"truncated\n');
    fs.writeFileSync(path.join(projects, '33333333-3333-4333-8333-333333333333.jsonl'), record('third'));

    const pushed = await session('push', '--source', 'claude-code', '--all', '-y', '--repo-root', b);

    expect(pushed.stderr).toContain('Not archived: The claude-code session 22222222-2222-4222-8222-222222222222');
    expect(pushed.stderr).toContain('1 session(s) could not be read and were not archived.');
    expect(pushed.stdout).toContain('Pushed 2 session(s) from claude-code');
    expect(pushed.code).toBe(1);
    const fresh = clone('fresh');
    expect(indexedSessionIds(fresh)).toEqual(['a1', 'b1', 's0']);
    expect(git(fresh, 'log', '-1', '--format=%s', 'HEAD^1')).toBe('sync: push 2 session(s) from claude-code (all workspaces)');
  });
});

describe('SyncManager.gitPush', () => {
  it('pulls once when the remote moved on and leaves a merge stopped on the index to the caller', async () => {
    useGitConfig();
    const { b } = (await divergeOnIndex());
    const mgr = new SyncManager(b);

    expect(mgr.gitPush()).toEqual({ status: 'indexes-conflicted', indexes: [INDEX] });
    expect(git(b, 'status', '--porcelain')).toContain(`UU ${INDEX}`);

    await mgr.commitRebuiltIndexes([INDEX]);
    expect(mgr.gitPush()).toEqual({ status: 'pushed' });
    expect(indexedSessionIds(clone('fresh'))).toEqual(['a1', 'b1', 's0']);
  });

  it('stops with the pull reason when the retry hits a real conflict', async () => {
    useGitConfig();
    const { a, b } = (await divergeOnIndex());
    conflictOnNotes(a, b);
    const headBefore = git(b, 'rev-parse', 'HEAD');

    expect(() => new SyncManager(b).gitPush()).toThrow(`Pull stopped on conflicts in notes.md and was aborted.`);
    expect(git(b, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(b, 'status', '--porcelain')).toBe('');
  });

  it('rethrows a rejection a pull cannot fix, without merging', async () => {
    useGitConfig();
    git(tmp, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
    const seed = clone('seed');
    await archive(seed, 's0', 'carol');
    git(seed, 'push', '-q', 'origin', 'main');
    const hook = path.join(tmp, 'remote.git', 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await archive(seed, 's1', 'carol');

    expect(() => new SyncManager(seed).gitPush()).toThrow(/pre-receive hook declined/);
    expect(git(seed, 'rev-list', '--merges', 'HEAD')).toBe('');
  });
});
