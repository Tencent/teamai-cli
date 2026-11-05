import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeInstallConfig } from './helpers/install-config.js';

// Real-git test (#808): the publish-mr step of `import --from-mr` queues its
// learning and publishes it through the learnings checkout, which in self mode
// lives in the partition and does not exist until something creates it. Only
// config detection is faked, and the draft the extract step kept is a file; the
// queue, the checkout and the publish are the real code.

const testRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-mr-808-')));
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

/** contribute's name for the learning: <title-slug>-<date>-<random>.md. */
const IMPORTED = /^learnings\/mr-note-\d{4}-\d{2}-\d{2}-[a-z0-9]+\.md$/;
const URL = 'https://github.com/o/r/pull/1';

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

const { ImportFromMr } = await import('../import-from-mr.js');
const { learningsBranch } = await import('../utils/learnings-branch.js');
const { pendingLearningsDir } = await import('../utils/pending-learnings.js');

/** The extract step's result for the MR: its draft, or a failure. No repo URL, so no teamwiki update follows. */
function extracted(outcome: 'success' | 'failed'): string {
  const file = path.join(testRoot, 'draft.md');
  fs.writeFileSync(file, '# Learning imported from an MR\n');
  const outputs = outcome === 'success' ? { title: 'mr-note', file, tags: [], overlaps: [], repo_url: '' } : {};

  return JSON.stringify([{ item: URL, outcome, outputs }]);
}

/** publish-mr as the step runs it on this install's team repo, or into `drafts`. */
function publish(flags: { outcome?: 'success' | 'failed'; reviewed?: string; drafts?: string } = {}) {
  return ImportFromMr.publish({
    extracted: extracted(flags.outcome ?? 'success'),
    reviewed: flags.reviewed ?? '',
    target: flags.drafts ?? localConfig.repo.localPath,
    drafts: flags.drafts === undefined ? 'false' : 'true',
  });
}

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

describe('import --from-mr\'s publish-mr in self mode (#808)', () => {
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

    const { published } = await publish();

    // Queued in the partition, not in the checkout, and drained once published.
    expect(pendingLearningsDir(localConfig)).toBe(path.join(dataHome, 'pending-learnings'));
    expect(published.map((file) => path.dirname(file))).toEqual([pendingLearningsDir(localConfig)]);
    expect(publishedLearnings().filter((file) => IMPORTED.test(file))).toHaveLength(1);
    expect(fs.readdirSync(pendingLearningsDir(localConfig))).toEqual([]);
  });

  it('leaves the learnings checkout alone when the learning goes to --output', async () => {
    await publish({ drafts: path.join(testRoot, 'drafts') });

    expect(fs.existsSync(path.join(learningsBranch.dir(localConfig), '.git'))).toBe(false);
  });

  it('publishes no teamai-learnings branch when the extraction fails', async () => {
    await publish({ outcome: 'failed' });

    expect(publishedLearningsBranch()).toBe('');
  });

  it('publishes no teamai-learnings branch when no learning is accepted', async () => {
    await publish({ reviewed: JSON.stringify([{ item: { item: URL }, outputs: { choice: 'skip', note: null } }]) });

    expect(publishedLearningsBranch()).toBe('');
  });
});
