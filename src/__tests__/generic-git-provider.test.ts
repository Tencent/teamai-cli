import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from 'node:child_process';
import { GenericGitProvider, normalizeGitIdentity } from '../providers/git/index.js';
import { parseGenericGitRepoInput } from '../providers/git/repo-url.js';
import { detectProvider, getProvider } from '../providers/registry.js';

const mockedSpawnSync = spawnSync as Mock;

describe('generic Git provider detection', () => {
  it('detects arbitrary HTTPS and SSH hosts', () => {
    expect(detectProvider('https://code.qschou.com/Enterprise/arb-workflow-kit.git')).toBe('git');
    expect(detectProvider('HTTPS://code.qschou.com/Enterprise/arb-workflow-kit.git')).toBe('git');
    expect(detectProvider('git@code.qschou.com:Enterprise/arb-workflow-kit.git')).toBe('git');
    expect(detectProvider('ssh://git@code.qschou.com/Enterprise/arb-workflow-kit.git')).toBe('git');
  });

  it('keeps known hosts on their dedicated providers', () => {
    expect(detectProvider('https://github.com/org/repo.git')).toBe('github');
    expect(detectProvider('git@git.woa.com:org/repo.git')).toBe('tgit');
    expect(detectProvider('https://cnb.cool/org/repo.git')).toBe('cnb');
  });

  it('returns a registered generic provider', () => {
    expect(getProvider('git')).toBeInstanceOf(GenericGitProvider);
  });
});

describe('parseGenericGitRepoInput', () => {
  it('parses nested HTTPS namespaces and preserves the host', () => {
    expect(parseGenericGitRepoInput(
      'https://code.qschou.com/Enterprise/platform/arb-workflow-kit.git',
    )).toEqual({
      owner: 'Enterprise/platform',
      repo: 'arb-workflow-kit',
      httpsUrl: 'https://code.qschou.com/Enterprise/platform/arb-workflow-kit.git',
      projectId: encodeURIComponent('Enterprise/platform/arb-workflow-kit'),
    });
  });

  it('parses scp-style and ssh:// URLs', () => {
    const scp = parseGenericGitRepoInput(
      'git@code.qschou.com:Enterprise/arb-workflow-kit.git',
    );
    expect(scp.owner).toBe('Enterprise');
    expect(scp.repo).toBe('arb-workflow-kit');
    expect(scp.httpsUrl).toBe('git@code.qschou.com:Enterprise/arb-workflow-kit.git');

    const ssh = parseGenericGitRepoInput(
      'ssh://git@code.qschou.com:2222/Enterprise/arb-workflow-kit',
    );
    expect(ssh.httpsUrl).toBe(
      'ssh://git@code.qschou.com:2222/Enterprise/arb-workflow-kit.git',
    );
  });

  it('rejects bare names and embedded HTTPS credentials', () => {
    expect(() => parseGenericGitRepoInput('Enterprise/arb-workflow-kit')).toThrow(
      /Invalid Git repo URL/,
    );
    expect(() => parseGenericGitRepoInput(
      'https://oauth2:secret@code.qschou.com/Enterprise/arb-workflow-kit.git',
    )).toThrow(/Do not embed credentials/);
  });

  it('rejects scp-style embedded credentials but keeps a real SSH login', () => {
    // A colon in the user field is a credential (e.g. "oauth2:token"), not a login.
    expect(() => parseGenericGitRepoInput(
      'oauth2:secret@code.qschou.com:Enterprise/arb-workflow-kit.git',
    )).toThrow(/Do not embed credentials/);

    // A normal SSH user must still be accepted and preserved verbatim.
    expect(parseGenericGitRepoInput(
      'git@code.qschou.com:Enterprise/arb-workflow-kit.git',
    ).httpsUrl).toBe('git@code.qschou.com:Enterprise/arb-workflow-kit.git');
  });

  it('rejects insecure HTTP and does not echo query-string secrets', () => {
    expect(() => parseGenericGitRepoInput(
      'http://code.qschou.com/Enterprise/arb-workflow-kit.git',
    )).toThrow(/plain HTTP is not supported/);

    let message = '';
    try {
      parseGenericGitRepoInput(
        'https://code.qschou.com/Enterprise/arb-workflow-kit.git?token=secret-value',
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/query strings and fragments are not supported/);
    expect(message).not.toContain('secret-value');
  });
});

describe('generic Git identity', () => {
  it('normalizes display names and path-like values into safe member ids', () => {
    expect(normalizeGitIdentity('Jane Doe')).toBe('Jane-Doe');
    expect(normalizeGitIdentity('../../outside')).toBe('outside');
    expect(normalizeGitIdentity('CON')).toBe('user-CON');
    expect(normalizeGitIdentity('中文用户')).toBeNull();
  });
});

describe('GenericGitProvider transport', () => {
  beforeEach(() => {
    mockedSpawnSync.mockReset();
  });

  it('clones a full remote URL without requiring parseRepoInput first', () => {
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const provider = new GenericGitProvider();

    provider.cloneRepo(
      'git@code.qschou.com:Enterprise/arb-workflow-kit.git',
      '/tmp/team-repo',
    );

    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'git',
      ['clone', '--', 'git@code.qschou.com:Enterprise/arb-workflow-kit.git', '/tmp/team-repo'],
      expect.objectContaining({ timeout: 180_000 }),
    );
  });

  it('checks that git is installed before transport operations', async () => {
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: 'git version 2.50.0\n', stderr: '' });

    await expect(new GenericGitProvider().ensureInstalled()).resolves.toBeUndefined();
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'git',
      ['--version'],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it('reports a clear error when git is unavailable', async () => {
    mockedSpawnSync.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawn git ENOENT'),
    });

    await expect(new GenericGitProvider().ensureInstalled()).rejects.toThrow(
      /git is required.*PATH/,
    );
  });

  it('uses a safe normalized identity for member files and branch names', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: '../../outside\n',
      stderr: '',
    });

    await expect(new GenericGitProvider().authenticate()).resolves.toBe('outside');
  });

  it('surfaces clone failures', () => {
    mockedSpawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'fatal: Authentication failed',
    });
    const provider = new GenericGitProvider();

    expect(() => provider.cloneRepo(
      'https://code.qschou.com/Enterprise/arb-workflow-kit.git',
      '/tmp/team-repo',
    ))
      .toThrow(/git clone failed: fatal: Authentication failed/);
  });

  it('uses the shared URL sanitizer for clone errors', () => {
    mockedSpawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'fatal: https://oauth2:secret@code.qschou.com/Enterprise/repo.git',
    });
    const provider = new GenericGitProvider();

    expect(() => provider.cloneRepo(
      'https://code.qschou.com/Enterprise/repo.git',
      '/tmp/team-repo',
    )).toThrow(
      'git clone failed: fatal: https://***@code.qschou.com/Enterprise/repo.git',
    );
  });

  it('reports unsupported host API operations explicitly', async () => {
    const provider = new GenericGitProvider();
    await expect(provider.createRepo()).rejects.toThrow(/not supported/);
    await expect(provider.createPullRequest({
      repo: 'Enterprise/arb-workflow-kit',
      source: 'feature',
      target: 'main',
      title: 'test',
    })).rejects.toThrow(/not supported/);
  });
});
