import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Real-git integration test for contributeSelf's local-cache mirroring (#472).
// Lives in its own file for the same reason as git-commit-paths.test.ts: other
// suites mock simple-git/config globally.

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-contribute-self-'));
const originalHome = process.env.HOME;
process.env.HOME = path.join(testRoot, 'home');

const businessRoot = path.join(testRoot, 'business');
const remote = path.join(testRoot, 'remote.git');
const localPath = path.join(businessRoot, '.teamai');

const localConfig = {
  repo: { localPath, kind: 'self' as const, businessRepoRoot: businessRoot, remote },
  username: 'test',
  updatePolicy: 'auto' as const,
  additionalRoles: [],
  scope: 'project' as const,
};

vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(localConfig),
  loadLocalConfigForScope: vi.fn().mockResolvedValue(localConfig),
  loadTeamConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

const { contribute } = await import('../contribute.js');
const { getUserLearningsDir } = await import('../types.js');

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('contributeSelf — machine-local learnings cache (issue #472)', () => {
  beforeEach(async () => {
    // afterEach restores HOME, so every case must re-enter the isolated fixture.
    process.env.HOME = path.join(testRoot, 'home');
    fs.rmSync(businessRoot, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(getUserLearningsDir(), { recursive: true, force: true });

    fs.mkdirSync(businessRoot, { recursive: true });
    git(['init', '--bare', remote], testRoot);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
    git(['init', '-q', '-b', 'main'], businessRoot);
    git(['config', 'user.email', 't@t.co'], businessRoot);
    git(['config', 'user.name', 't'], businessRoot);
    fs.mkdirSync(localPath, { recursive: true });
    fs.writeFileSync(path.join(localPath, '.gitkeep'), '');
    git(['add', '.'], businessRoot);
    git(['commit', '-qm', 'init'], businessRoot);
    git(['remote', 'add', 'origin', remote], businessRoot);
    git(['push', '-u', 'origin', 'main'], businessRoot);

    // Pre-existing cache content this contribution must never touch: another
    // project's shared root learning, plus a namespace directory unrelated to
    // this project's own (empty) namespace set.
    fs.mkdirSync(getUserLearningsDir(), { recursive: true });
    fs.writeFileSync(path.join(getUserLearningsDir(), 'other-team.md'), '# other team knowledge');
    fs.mkdirSync(path.join(getUserLearningsDir(), 'other-namespace'), { recursive: true });
    fs.writeFileSync(path.join(getUserLearningsDir(), 'other-namespace', 'note.md'), '# unrelated namespace');
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function cacheFiles(): string[] {
    return fs.readdirSync(getUserLearningsDir()).sort();
  }

  function noteFile(text: string): string {
    const notePath = path.join(testRoot, `note-${Math.random().toString(36).slice(2)}.md`);
    fs.writeFileSync(notePath, text);
    return notePath;
  }

  it('adds a new contribution without deleting unrelated cache entries', async () => {
    await contribute({ scope: 'project', title: 'first-pending', file: noteFile('first unique knowledge') });

    expect(fs.existsSync(path.join(getUserLearningsDir(), 'other-team.md'))).toBe(true);
    expect(fs.existsSync(path.join(getUserLearningsDir(), 'other-namespace', 'note.md'))).toBe(true);
    expect(cacheFiles().some((f) => f.startsWith('first-pending-'))).toBe(true);
  });

  it('keeps an earlier still-unmerged contribution recallable after a second one', async () => {
    await contribute({ scope: 'project', title: 'first-pending', file: noteFile('first unique knowledge') });
    const firstFile = cacheFiles().find((f) => f.startsWith('first-pending-'));
    expect(firstFile).toBeDefined();

    await contribute({ scope: 'project', title: 'second-pending', file: noteFile('second unique knowledge') });
    const afterSecond = cacheFiles();

    expect(afterSecond).toContain(firstFile);
    expect(afterSecond.some((f) => f.startsWith('second-pending-'))).toBe(true);
    expect(afterSecond).toContain('other-team.md');
  });
});
