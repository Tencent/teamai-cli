import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseRemoteToRepo, buildHintMessage, getGitRemote } from '../mr-hint.js';
import type { MRSummary } from '../mr-hint.js';

describe('parseRemoteToRepo', () => {
  it('parses TGit HTTPS URL with simple path', () => {
    const result = parseRemoteToRepo('https://git.woa.com/owner/repo.git');
    expect(result).toEqual({ provider: 'tgit', owner: 'owner', repo: 'repo' });
  });

  it('parses TGit HTTPS URL with group path', () => {
    const result = parseRemoteToRepo('https://git.woa.com/group/subgroup/repo.git');
    expect(result).toEqual({ provider: 'tgit', owner: 'group/subgroup', repo: 'repo' });
  });

  it('parses TGit SSH URL', () => {
    const result = parseRemoteToRepo('git@git.woa.com:group/repo.git');
    expect(result).toEqual({ provider: 'tgit', owner: 'group', repo: 'repo' });
  });

  it('parses GitHub HTTPS URL', () => {
    const result = parseRemoteToRepo('https://github.com/myorg/myrepo.git');
    expect(result).toEqual({ provider: 'github', owner: 'myorg', repo: 'myrepo' });
  });

  it('parses GitHub SSH URL', () => {
    const result = parseRemoteToRepo('git@github.com:myorg/myrepo.git');
    expect(result).toEqual({ provider: 'github', owner: 'myorg', repo: 'myrepo' });
  });

  it('parses URL without .git suffix', () => {
    const result = parseRemoteToRepo('https://git.woa.com/owner/repo');
    expect(result).toEqual({ provider: 'tgit', owner: 'owner', repo: 'repo' });
  });

  it('returns null for unrecognized URL', () => {
    expect(parseRemoteToRepo('https://gitlab.com/owner/repo.git')).toBeNull();
    expect(parseRemoteToRepo('')).toBeNull();
    expect(parseRemoteToRepo('not-a-url')).toBeNull();
  });
});

describe('buildHintMessage', () => {
  const sampleMRs: MRSummary[] = [
    {
      id: '42',
      title: 'feat: add new feature',
      url: 'https://git.woa.com/owner/repo/merge_requests/42',
      mergedAt: '2024-06-01T10:00:00Z',
    },
  ];

  it('includes MR title in hint', () => {
    const msg = buildHintMessage(sampleMRs);
    expect(msg).toContain('feat: add new feature');
  });

  it('includes teamai import command', () => {
    const msg = buildHintMessage(sampleMRs);
    expect(msg).toContain('teamai import --from-mr');
    expect(msg).toContain('https://git.woa.com/owner/repo/merge_requests/42');
  });

  it('mentions MR count', () => {
    const msg = buildHintMessage(sampleMRs);
    expect(msg).toContain('1');
  });

  it('includes the [teamai:mr-hint] prefix', () => {
    const msg = buildHintMessage(sampleMRs);
    expect(msg).toContain('[teamai:mr-hint]');
  });

  it('handles multiple MRs', () => {
    const mrs: MRSummary[] = [
      { id: '1', title: 'MR One', url: 'https://git.woa.com/a/b/merge_requests/1', mergedAt: '2024-06-01T00:00:00Z' },
      { id: '2', title: 'MR Two', url: 'https://git.woa.com/a/b/merge_requests/2', mergedAt: '2024-06-02T00:00:00Z' },
    ];
    const msg = buildHintMessage(mrs);
    expect(msg).toContain('2');
    expect(msg).toContain('MR One');
    expect(msg).toContain('MR Two');
  });
});

describe('getGitRemote', () => {
  it('returns null for non-git directory', () => {
    const result = getGitRemote('/tmp');
    expect(result).toBeNull();
  });
});
