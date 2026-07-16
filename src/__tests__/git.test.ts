import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock simple-git before importing
const mockGit = {
  checkoutLocalBranch: vi.fn(),
  add: vi.fn(),
  status: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  checkout: vi.fn(),
  deleteLocalBranch: vi.fn(),
  init: vi.fn(),
  addRemote: vi.fn(),
  addConfig: vi.fn(),
  revparse: vi.fn().mockResolvedValue('main'),
  reset: vi.fn(),
  merge: vi.fn(),
  diff: vi.fn().mockResolvedValue('+some real content change\n'),
};

vi.mock('simple-git', () => ({
  default: () => mockGit,
}));

vi.mock('fs-extra', () => ({
  default: {
    ensureDir: vi.fn(),
  },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
  },
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import { generateBranchName, pushRepoBranch, checkoutMaster, pushRepoDirectly, initRepo, configureGitUser, getHeadRev, resetToCleanMaster, isMetadataOnlyDiff } from '../utils/git.js';
import fse from 'fs-extra';

describe('generateBranchName', () => {
  it('should produce teamai/push/<username>/<timestamp> format', () => {
    const name = generateBranchName('alice');
    expect(name).toMatch(/^teamai\/push\/alice\/\d{8}-\d{6}$/);
  });

  it('should use the correct current date components', () => {
    const before = new Date();
    const name = generateBranchName('bob');
    const after = new Date();

    // Extract the date part
    const match = name.match(/^teamai\/push\/bob\/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
    expect(match).not.toBeNull();

    const year = parseInt(match![1]);
    const month = parseInt(match![2]);
    const day = parseInt(match![3]);

    expect(year).toBe(before.getFullYear());
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(31);
  });
});

describe('pushRepoBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create branch, commit, push, and stay on branch when there are changes', async () => {
    mockGit.status.mockResolvedValue({ staged: ['file.txt'] });

    const result = await pushRepoBranch('/repo', 'commit msg', ['file.txt'], 'teamai/push/test/123');

    expect(result).toBe(true);
    expect(mockGit.checkoutLocalBranch).toHaveBeenCalledWith('teamai/push/test/123');
    expect(mockGit.add).toHaveBeenCalledWith(['file.txt']);
    expect(mockGit.commit).toHaveBeenCalledWith('commit msg');
    expect(mockGit.push).toHaveBeenCalledWith(['-u', 'origin', 'teamai/push/test/123']);
    // Should NOT switch back to master — caller does that after gfMrCreate
    expect(mockGit.checkout).not.toHaveBeenCalled();
  });

  it('should return false and clean up branch when no changes to commit', async () => {
    mockGit.status.mockResolvedValue({ staged: [] });
    // Mock origin/HEAD lookup so default-branch detection resolves to 'master'
    mockGit.revparse.mockImplementation(async (args: any) => {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === '--abbrev-ref' && a[1] === 'origin/HEAD') return 'origin/master';
      return '';
    });

    const result = await pushRepoBranch('/repo', 'msg', ['file.txt'], 'teamai/push/test/456');

    expect(result).toBe(false);
    expect(mockGit.checkout).toHaveBeenCalledWith('master');
    expect(mockGit.deleteLocalBranch).toHaveBeenCalledWith('teamai/push/test/456', true);
    expect(mockGit.commit).not.toHaveBeenCalled();
    expect(mockGit.push).not.toHaveBeenCalled();
  });

  it('should return false and clean up when diff is metadata-only (timestamps)', async () => {
    mockGit.status.mockResolvedValue({ staged: ['codebase.md'] });
    mockGit.diff.mockResolvedValue(
      '-lastUpdated: 2026-07-16T10:00:00.000Z\n+lastUpdated: 2026-07-16T10:05:00.000Z\n',
    );
    mockGit.revparse.mockImplementation(async (args: any) => {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === '--abbrev-ref' && a[1] === 'origin/HEAD') return 'origin/master';
      return '';
    });

    const result = await pushRepoBranch('/repo', 'msg', ['file.txt'], 'teamai/push/test/789');

    expect(result).toBe(false);
    expect(mockGit.diff).toHaveBeenCalledWith(['--cached', '--unified=0']);
    expect(mockGit.checkout).toHaveBeenCalledWith('master');
    expect(mockGit.deleteLocalBranch).toHaveBeenCalledWith('teamai/push/test/789', true);
    expect(mockGit.commit).not.toHaveBeenCalled();
  });
});

describe('checkoutMaster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should checkout the default branch (master when origin/HEAD points there)', async () => {
    mockGit.revparse.mockImplementation(async (args: any) => {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === '--abbrev-ref' && a[1] === 'origin/HEAD') return 'origin/master';
      return '';
    });
    await checkoutMaster('/repo-master');
    expect(mockGit.checkout).toHaveBeenCalledWith('master');
  });

  it('should checkout the default branch (main when origin/HEAD points there)', async () => {
    mockGit.revparse.mockImplementation(async (args: any) => {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === '--abbrev-ref' && a[1] === 'origin/HEAD') return 'origin/main';
      return '';
    });
    await checkoutMaster('/repo-main');
    expect(mockGit.checkout).toHaveBeenCalledWith('main');
  });
});

describe('pushRepoDirectly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should add, commit, and push with upstream when there are staged changes', async () => {
    mockGit.status.mockResolvedValue({ staged: ['file.txt'] });
    mockGit.revparse.mockResolvedValue('main');

    await pushRepoDirectly('/repo', 'direct commit', ['file.txt']);

    expect(mockGit.add).toHaveBeenCalledWith(['file.txt']);
    expect(mockGit.commit).toHaveBeenCalledWith('direct commit');
    expect(mockGit.revparse).toHaveBeenCalledWith(['--abbrev-ref', 'HEAD']);
    expect(mockGit.push).toHaveBeenCalledWith(['-u', 'origin', 'main']);
  });

  it('should skip commit and push when nothing is staged', async () => {
    mockGit.status.mockResolvedValue({ staged: [] });

    await pushRepoDirectly('/repo', 'msg', ['file.txt']);

    expect(mockGit.add).toHaveBeenCalledWith(['file.txt']);
    expect(mockGit.commit).not.toHaveBeenCalled();
    expect(mockGit.push).not.toHaveBeenCalled();
  });
});

describe('initRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create directory, init git repo, and add remote', async () => {
    await initRepo('https://git.woa.com/team/repo.git', '/tmp/test-repo');

    expect(fse.ensureDir).toHaveBeenCalledWith('/tmp/test-repo');
    expect(mockGit.init).toHaveBeenCalled();
    expect(mockGit.addRemote).toHaveBeenCalledWith('origin', 'https://git.woa.com/team/repo.git');
  });
});

describe('configureGitUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should set user.name and user.email with default domain', async () => {
    await configureGitUser('/repo', 'alice', 'Alice', undefined, 'tencent.com');

    expect(mockGit.addConfig).toHaveBeenCalledWith('user.name', 'Alice');
    expect(mockGit.addConfig).toHaveBeenCalledWith('user.email', 'alice@tencent.com');
  });

  it('should fall back to username when displayName is not provided', async () => {
    await configureGitUser('/repo', 'bob', undefined, undefined, 'tencent.com');

    expect(mockGit.addConfig).toHaveBeenCalledWith('user.name', 'bob');
    expect(mockGit.addConfig).toHaveBeenCalledWith('user.email', 'bob@tencent.com');
  });

  it('should use custom email when provided', async () => {
    await configureGitUser('/repo', 'charlie', 'Charlie', 'charlie@custom.com');

    expect(mockGit.addConfig).toHaveBeenCalledWith('user.name', 'Charlie');
    expect(mockGit.addConfig).toHaveBeenCalledWith('user.email', 'charlie@custom.com');
  });
});

describe('getHeadRev', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return the short HEAD commit hash', async () => {
    mockGit.revparse.mockResolvedValue('a1b2c3d');

    const rev = await getHeadRev('/repo');

    expect(rev).toBe('a1b2c3d');
    expect(mockGit.revparse).toHaveBeenCalledWith(['--short', 'HEAD']);
  });
});

describe('resetToCleanMaster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Build an argument-aware revparse mock.
   * - origin/HEAD → returns the configured `originHead` (e.g. 'origin/master')
   * - --abbrev-ref HEAD → returns the configured `currentBranch`
   * - other revparse calls → resolve with empty string
   */
  function mockRevparse(originHead: string, currentBranch: string) {
    mockGit.revparse.mockImplementation(async (args: any) => {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === '--abbrev-ref' && a[1] === 'origin/HEAD') return originHead;
      if (a[0] === '--abbrev-ref' && a[1] === 'HEAD') return currentBranch;
      return '';
    });
  }

  it('should do nothing when repo is clean and on master', async () => {
    mockGit.status.mockResolvedValue({
      modified: [],
      not_added: [],
      created: [],
      conflicted: [],
    });
    mockRevparse('origin/master', 'master');

    await resetToCleanMaster(mockGit as any);

    expect(mockGit.reset).not.toHaveBeenCalled();
    expect(mockGit.checkout).not.toHaveBeenCalled();
  });

  it('should reset --hard when conflicted files exist (no MERGE_HEAD)', async () => {
    mockGit.status.mockResolvedValue({
      modified: [],
      not_added: [],
      created: [],
      conflicted: ['votes/jeffyxu.yaml'],
    });
    mockRevparse('origin/master', 'master');

    await resetToCleanMaster(mockGit as any);

    expect(mockGit.reset).toHaveBeenCalledWith(['--hard', 'HEAD']);
    expect(mockGit.checkout).not.toHaveBeenCalled();
  });

  it('should reset --hard when modified files exist', async () => {
    mockGit.status.mockResolvedValue({
      modified: ['some-file.txt'],
      not_added: [],
      created: [],
      conflicted: [],
    });
    mockRevparse('origin/master', 'master');

    await resetToCleanMaster(mockGit as any);

    expect(mockGit.reset).toHaveBeenCalledWith(['--hard', 'HEAD']);
  });

  it('should checkout master when stuck on a stale push branch', async () => {
    mockGit.status.mockResolvedValue({
      modified: [],
      not_added: [],
      created: [],
      conflicted: [],
    });
    mockRevparse('origin/master', 'teamai/push/jeffyxu/20260411-225746');

    await resetToCleanMaster(mockGit as any);

    expect(mockGit.checkout).toHaveBeenCalledWith('master');
  });

  it('should reset and checkout master when both dirty and on wrong branch', async () => {
    mockGit.status.mockResolvedValue({
      modified: [],
      not_added: [],
      created: ['new-file.txt'],
      conflicted: ['votes/user.yaml'],
    });
    mockRevparse('origin/master', 'teamai/push/user/20260411-123456');

    await resetToCleanMaster(mockGit as any);

    expect(mockGit.reset).toHaveBeenCalledWith(['--hard', 'HEAD']);
    expect(mockGit.checkout).toHaveBeenCalledWith('master');
  });

  it('should checkout main when default branch is main', async () => {
    mockGit.status.mockResolvedValue({
      modified: [],
      not_added: [],
      created: [],
      conflicted: [],
    });
    mockRevparse('origin/main', 'feature/foo');

    await resetToCleanMaster(mockGit as any);

    expect(mockGit.checkout).toHaveBeenCalledWith('main');
  });
});

describe('isMetadataOnlyDiff', () => {
  it('should return true for empty diff', () => {
    expect(isMetadataOnlyDiff('')).toBe(true);
    expect(isMetadataOnlyDiff('  \n  ')).toBe(true);
  });

  it('should return true for timestamp-only changes', () => {
    const diff = [
      '--- a/teamwiki/source-manifest.json',
      '+++ b/teamwiki/source-manifest.json',
      '-  "lastScan": "2026-07-16T10:00:00.000Z",',
      '+  "lastScan": "2026-07-16T10:05:00.000Z",',
    ].join('\n');
    expect(isMetadataOnlyDiff(diff)).toBe(true);
  });

  it('should return true for mixed metadata patterns', () => {
    const diff = [
      '-lastUpdated: 2026-07-16T10:00:00.000Z',
      '+lastUpdated: 2026-07-16T10:05:00.000Z',
      '-  "lastScan": "2026-07-16T10:00:00.000Z",',
      '+  "lastScan": "2026-07-16T10:05:00.000Z",',
      '-syncedAt: 2026-07-16T10:00:00.000Z',
      '+syncedAt: 2026-07-16T10:05:00.000Z',
    ].join('\n');
    expect(isMetadataOnlyDiff(diff)).toBe(true);
  });

  it('should return false when real content changes are present', () => {
    const diff = [
      '-lastUpdated: 2026-07-16T10:00:00.000Z',
      '+lastUpdated: 2026-07-16T10:05:00.000Z',
      '-## Old Section',
      '+## New Section with real changes',
    ].join('\n');
    expect(isMetadataOnlyDiff(diff)).toBe(false);
  });

  it('should return false for purely content changes', () => {
    const diff = '+export function newFeature() { return 42; }\n';
    expect(isMetadataOnlyDiff(diff)).toBe(false);
  });

  it('should ignore diff header lines (--- and +++)', () => {
    const diff = [
      '--- a/file.md',
      '+++ b/file.md',
      '-lastUpdated: old',
      '+lastUpdated: new',
    ].join('\n');
    expect(isMetadataOnlyDiff(diff)).toBe(true);
  });
});
