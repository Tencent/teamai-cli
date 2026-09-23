import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

let tmp: string;
let mode: 'self-empty' | 'http' = 'self-empty';
const realHome = process.env.HOME;

function config() {
  if (mode === 'http') {
    return {
      repo: { localPath: path.join(tmp, 'team-repo'), remote: 'https://example.com/api', kind: 'http' as const },
      username: 'alice',
      scope: 'user' as const,
      additionalRoles: [],
    };
  }
  const business = path.join(tmp, 'product');
  return {
    repo: {
      localPath: path.join(business, '.teamai'),
      remote: path.join(tmp, 'origin.git'),
      kind: 'self' as const,
      businessRepoRoot: business,
    },
    username: 'alice',
    scope: 'project' as const,
    projectRoot: business,
    additionalRoles: [],
  };
}

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(async () => ({ localConfig: config() })),
  detectProjectConfig: vi.fn(async () => null),
  loadLocalConfigForScope: vi.fn(async () => config()),
  loadTeamConfig: vi.fn(async () => null),
}));

const { contribute } = await import('../contribute.js');
const { listPendingLearnings } = await import('../utils/pending-learnings.js');

function note(text: string): string {
  const p = path.join(tmp, `note-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(p, text);
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-edge-modes-'));
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  process.env.HOME = realHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Two configurations that have no learnings branch to write to. Neither may
 * crash, and neither may lose the contribution.
 */
describe('contributing where the learnings branch cannot exist', () => {
  it('keeps the note when the single-repo business repo has no commits yet', async () => {
    mode = 'self-empty';
    const business = path.join(tmp, 'product');
    fs.mkdirSync(path.join(business, '.teamai'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: business });

    await expect(
      contribute({ scope: 'project', title: 'no commits yet', file: note('# knowledge') }),
    ).resolves.toBeUndefined();

    // Either published into the branch worktree or kept in the queue; what it
    // must never do is drop the note.
    const wt = path.join(business, '.teamai', 'learnings-wt', 'learnings');
    const inWorktree = fs.existsSync(wt) ? fs.readdirSync(wt) : [];
    const queued = await listPendingLearnings(config());
    expect([...queued, ...inWorktree].some((f) => f.startsWith('no-commits-yet-'))).toBe(true);
  });

  it('refuses on an HTTP backend, before any of this touches it', async () => {
    mode = 'http';
    fs.mkdirSync(path.join(tmp, 'team-repo'), { recursive: true });

    // Unchanged behaviour: an HTTP team repo is read-only for contribute, and
    // the guard fires before any learnings path is resolved.
    await expect(
      contribute({ scope: 'user', title: 'http backend', file: note('# knowledge') }),
    ).rejects.toThrow(/read-only HTTP/);

    expect(await listPendingLearnings(config())).toEqual([]);
  });
});
