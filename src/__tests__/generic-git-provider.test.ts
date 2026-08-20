import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from 'node:child_process';
import { GenericGitProvider } from '../providers/git/index.js';
import { parseGenericGitRepoInput } from '../providers/git/repo-url.js';
import { detectProvider, getProvider } from '../providers/registry.js';

const mockedSpawnSync = spawnSync as Mock;

describe('generic Git provider detection', () => {
  it('detects arbitrary HTTPS and SSH hosts', () => {
    expect(detectProvider('https://code.qschou.com/Enterprise/arb-workflow-kit.git')).toBe('git');
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
});

describe('GenericGitProvider transport', () => {
  beforeEach(() => {
    mockedSpawnSync.mockReset();
  });

  it('clones the exact parsed remote through system git', () => {
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const provider = new GenericGitProvider();
    provider.parseRepoInput('git@code.qschou.com:Enterprise/arb-workflow-kit.git');

    provider.cloneRepo('Enterprise/arb-workflow-kit', '/tmp/team-repo');

    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'git',
      ['clone', 'git@code.qschou.com:Enterprise/arb-workflow-kit.git', '/tmp/team-repo'],
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  it('surfaces clone failures', () => {
    mockedSpawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'fatal: Authentication failed',
    });
    const provider = new GenericGitProvider();
    provider.parseRepoInput('https://code.qschou.com/Enterprise/arb-workflow-kit.git');

    expect(() => provider.cloneRepo('Enterprise/arb-workflow-kit', '/tmp/team-repo'))
      .toThrow(/git clone failed: fatal: Authentication failed/);
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
