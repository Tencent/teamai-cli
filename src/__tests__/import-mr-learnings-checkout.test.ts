import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeInstallConfig } from './helpers/install-config.js';

// Real-git test (#808): `import --from-mr` queues its learning and publishes it
// through the learnings checkout, which in self mode lives in the partition and
// does not exist until something creates it. Only config detection and the MR
// extraction (network + AI) are faked; the queue, the checkout and the publish
// are the real code.

const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-mr-808-')));
const businessRoot = path.join(testRoot, 'business');
const remote = path.join(testRoot, 'remote.git');
const dataHome = path.join(testRoot, 'partition');

const localConfig = {
  repo: { localPath: path.join(businessRoot, '.teamai'), kind: 'self' as const, businessRepoRoot: businessRoot, remote },
  username: 'test',
  updatePolicy: 'auto' as const,
  additionalRoles: [],
  scope: 'project' as const,
  projectRoot: businessRoot,
  dataHome,
};

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn(async () => ({ localConfig, teamConfig: { team: 't', repo: remote } })),
}));

const IMPORTED = 'mr-note-2026-01-01-aaaaaa.md';

vi.mock('../import-mr.js', () => ({
  importFromMR: vi.fn(async (opts: { queueLearning?: (filename: string, content: string) => Promise<string> }) => {
    const content = '# Learning imported from an MR\n';
    const learningFile = opts.queueLearning ? await opts.queueLearning(IMPORTED, content) : undefined;
    // No repo URL: the command skips the wiki and push steps.
    return { learning: { title: 'mr-note', content }, repoUrl: '', learningFile };
  }),
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  setSilent: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

const { importCmd } = await import('../import.js');
const { learningsBranch } = await import('../utils/learnings-branch.js');
const { pendingLearningsDir } = await import('../utils/pending-learnings.js');
const { importFromMR } = await import('../import-mr.js');

/** Files origin has on teamai-learnings. */
function publishedLearnings(): string[] {
  return execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'teamai-learnings'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** Branch heads origin has for teamai-learnings: empty when none was published. */
function publishedLearningsBranch(): string {
  return execFileSync('git', ['ls-remote', '--heads', remote, 'teamai-learnings'], { encoding: 'utf8' }).trim();
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.co', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.co' },
  });
}

describe('import --from-mr in self mode (#808)', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(businessRoot, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(businessRoot, '.teamai', '.gitignore'), 'learnings-wt/\n');
    git(['init', '-q', '--bare', remote], testRoot);
    git(['init', '-q', '-b', 'main'], businessRoot);
    // The learnings checkout commits in-process, with the repo's identity:
    // a CI runner has no global one.
    git(['config', 'user.email', 't@t.co'], businessRoot);
    git(['config', 'user.name', 't'], businessRoot);
    git(['add', '-A'], businessRoot);
    git(['commit', '-q', '-m', 'init'], businessRoot);
    git(['remote', 'add', 'origin', remote], businessRoot);
    git(['push', '-q', '-u', 'origin', 'main'], businessRoot);
    writeInstallConfig(localConfig);
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('publishes the imported learning when the learnings checkout did not exist yet', async () => {
    expect(fs.existsSync(learningsBranch.dir(localConfig))).toBe(false);

    await importCmd({ fromMr: 'https://github.com/o/r/pull/1' });

    // Queued in the partition, not in the checkout, and drained once published.
    expect(pendingLearningsDir(localConfig)).toBe(path.join(dataHome, 'pending-learnings'));
    expect(publishedLearnings()).toContain(`learnings/${IMPORTED}`);
    expect(fs.existsSync(path.join(pendingLearningsDir(localConfig), IMPORTED))).toBe(false);
  });

  it('leaves the learnings checkout alone when the learning goes to --output', async () => {
    await importCmd({ fromMr: 'https://github.com/o/r/pull/1', output: path.join(testRoot, 'drafts') });

    expect(fs.existsSync(path.join(learningsBranch.dir(localConfig), '.git'))).toBe(false);
  });

  it('publishes no teamai-learnings branch when the extraction fails', async () => {
    vi.mocked(importFromMR).mockRejectedValueOnce(new Error('MR fetch failed'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    try {
      await expect(importCmd({ fromMr: 'https://github.com/o/r/pull/1' })).rejects.toThrow('process.exit(1)');
    } finally {
      exit.mockRestore();
    }

    expect(publishedLearningsBranch()).toBe('');
  });

  it('publishes no teamai-learnings branch when no learning is accepted', async () => {
    vi.mocked(importFromMR).mockResolvedValueOnce({ learning: undefined, repoUrl: '' });

    await importCmd({ fromMr: 'https://github.com/o/r/pull/1' });

    expect(publishedLearningsBranch()).toBe('');
  });
});
