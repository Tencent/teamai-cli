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

import { generateBranchName, pushRepoBranch, checkoutMaster, pushRepoDirectly, initRepo, configureGitUser } from '../utils/git.js';
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

    const result = await pushRepoBranch('/repo', 'msg', ['file.txt'], 'teamai/push/test/456');

    expect(result).toBe(false);
    expect(mockGit.checkout).toHaveBeenCalledWith('master');
    expect(mockGit.deleteLocalBranch).toHaveBeenCalledWith('teamai/push/test/456', true);
    expect(mockGit.commit).not.toHaveBeenCalled();
    expect(mockGit.push).not.toHaveBeenCalled();
  });
});

describe('checkoutMaster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should checkout master branch', async () => {
    await checkoutMaster('/repo');
    expect(mockGit.checkout).toHaveBeenCalledWith('master');
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
    await configureGitUser('/repo', 'alice', 'Alice');

    expect(mockGit.addConfig).toHaveBeenCalledWith('user.name', 'Alice');
    expect(mockGit.addConfig).toHaveBeenCalledWith('user.email', 'alice@tencent.com');
  });

  it('should fall back to username when displayName is not provided', async () => {
    await configureGitUser('/repo', 'bob');

    expect(mockGit.addConfig).toHaveBeenCalledWith('user.name', 'bob');
    expect(mockGit.addConfig).toHaveBeenCalledWith('user.email', 'bob@tencent.com');
  });

  it('should use custom email when provided', async () => {
    await configureGitUser('/repo', 'charlie', 'Charlie', 'charlie@custom.com');

    expect(mockGit.addConfig).toHaveBeenCalledWith('user.name', 'Charlie');
    expect(mockGit.addConfig).toHaveBeenCalledWith('user.email', 'charlie@custom.com');
  });
});
