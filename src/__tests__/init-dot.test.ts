import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// ── Mocks ────────────────────────────────────────────────

const mockGit = {
  init: vi.fn(),
  addRemote: vi.fn(),
  addConfig: vi.fn(),
  getRemotes: vi.fn(),
};

vi.mock('simple-git', () => ({
  default: () => mockGit,
}));

vi.mock('fs-extra', () => ({
  default: {
    ensureDir: vi.fn(),
    pathExists: vi.fn().mockResolvedValue(false),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
    access: vi.fn(),
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
  spinner: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  }),
}));

// ── normalizeRemoteUrl tests ─────────────────────────────

import { normalizeRemoteUrl, getCwdGitRemoteUrl } from '../utils/git.js';
import fse from 'fs-extra';

describe('normalizeRemoteUrl', () => {
  it('converts SSH to HTTPS', () => {
    expect(normalizeRemoteUrl('git@github.com:org/repo.git')).toBe('https://github.com/org/repo.git');
  });

  it('converts SSH without .git suffix', () => {
    expect(normalizeRemoteUrl('git@github.com:org/repo')).toBe('https://github.com/org/repo.git');
  });

  it('converts TGit SSH', () => {
    expect(normalizeRemoteUrl('git@git.woa.com:team/repo.git')).toBe('https://git.woa.com/team/repo.git');
  });

  it('converts ssh:// URL form', () => {
    expect(normalizeRemoteUrl('ssh://git@github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
  });

  it('converts ssh:// URL without .git suffix', () => {
    expect(normalizeRemoteUrl('ssh://git@github.com/org/repo')).toBe('https://github.com/org/repo.git');
  });

  it('converts ssh:// URL with custom port', () => {
    expect(normalizeRemoteUrl('ssh://git@git.woa.com:2222/team/repo.git')).toBe('https://git.woa.com/team/repo.git');
  });

  it('converts ssh:// URL without user', () => {
    expect(normalizeRemoteUrl('ssh://github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
  });

  it('passes HTTPS through unchanged', () => {
    expect(normalizeRemoteUrl('https://github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
  });

  it('appends .git to HTTPS without suffix', () => {
    expect(normalizeRemoteUrl('https://github.com/org/repo')).toBe('https://github.com/org/repo.git');
  });

  it('trims trailing slash and appends .git', () => {
    expect(normalizeRemoteUrl('https://github.com/org/repo/')).toBe('https://github.com/org/repo.git');
  });

  it('returns null for empty string', () => {
    expect(normalizeRemoteUrl('')).toBeNull();
  });

  it('returns null for unknown format', () => {
    expect(normalizeRemoteUrl('not-a-url')).toBeNull();
  });
});

// ── getCwdGitRemoteUrl tests ─────────────────────────────

describe('getCwdGitRemoteUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fse.access).mockResolvedValue(undefined);
  });

  it('returns origin remote URL', async () => {
    mockGit.getRemotes.mockResolvedValue([
      { name: 'origin', refs: { fetch: 'https://github.com/org/repo.git' } },
    ]);
    const url = await getCwdGitRemoteUrl('/tmp/repo');
    expect(url).toBe('https://github.com/org/repo.git');
  });

  it('prefers origin over other remotes', async () => {
    mockGit.getRemotes.mockResolvedValue([
      { name: 'upstream', refs: { fetch: 'https://github.com/other/repo.git' } },
      { name: 'origin', refs: { fetch: 'https://github.com/org/repo.git' } },
    ]);
    const url = await getCwdGitRemoteUrl('/tmp/repo');
    expect(url).toBe('https://github.com/org/repo.git');
  });

  it('falls back to first remote if no origin', async () => {
    mockGit.getRemotes.mockResolvedValue([
      { name: 'upstream', refs: { fetch: 'https://github.com/other/repo.git' } },
    ]);
    const url = await getCwdGitRemoteUrl('/tmp/repo');
    expect(url).toBe('https://github.com/other/repo.git');
  });

  it('returns null when no remotes exist', async () => {
    mockGit.getRemotes.mockResolvedValue([]);
    const url = await getCwdGitRemoteUrl('/tmp/repo');
    expect(url).toBeNull();
  });

  it('returns null for non-existent path', async () => {
    vi.mocked(fse.access).mockRejectedValue(new Error('ENOENT'));
    const url = await getCwdGitRemoteUrl('/nonexistent');
    expect(url).toBeNull();
  });

  it('normalizes SSH remotes to HTTPS', async () => {
    mockGit.getRemotes.mockResolvedValue([
      { name: 'origin', refs: { fetch: 'git@github.com:org/repo.git' } },
    ]);
    const url = await getCwdGitRemoteUrl('/tmp/repo');
    expect(url).toBe('https://github.com/org/repo.git');
  });
});

// ── resolveDotTarget + resolveInitRepo tests ─────────────

vi.mock('../config.js', () => ({
  saveLocalConfig: vi.fn(),
  saveLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfigForScope: vi.fn().mockResolvedValue(null),
  saveProjectDeclaration: vi.fn(),
  loadProjectDeclaration: vi.fn(),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPullRev: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../hooks.js', () => ({
  reconcileTeamHooksForConfig: vi.fn(),
}));

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockRejectedValue(new Error('Roles manifest not found')),
  describeRoles: vi.fn(),
}));

import { resolveDotTarget, resolveInitRepo } from '../init.js';

describe('resolveDotTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fse.access).mockResolvedValue(undefined);
  });

  it('resolves to git remote URL', async () => {
    mockGit.getRemotes.mockResolvedValue([
      { name: 'origin', refs: { fetch: 'https://github.com/org/repo.git' } },
    ]);
    const url = await resolveDotTarget('/tmp/repo');
    expect(url).toBe('https://github.com/org/repo.git');
  });

  it('throws when no git remote is found', async () => {
    mockGit.getRemotes.mockResolvedValue([]);
    await expect(resolveDotTarget('/tmp/repo')).rejects.toThrow('No git remote found');
  });
});

describe('resolveInitRepo', () => {
  it('returns positional when only positional is given', () => {
    expect(resolveInitRepo('org/repo', undefined)).toBe('org/repo');
  });

  it('returns flag when only flag is given', () => {
    expect(resolveInitRepo(undefined, 'org/repo')).toBe('org/repo');
  });

  it('returns value when both match', () => {
    expect(resolveInitRepo('org/repo', 'org/repo')).toBe('org/repo');
  });

  it('throws on conflict', () => {
    expect(() => resolveInitRepo('org/a', 'org/b')).toThrow('Conflicting');
  });

  it('uses resolvedDotUrl when provided', () => {
    expect(resolveInitRepo('.', undefined, 'https://github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
  });

  it('throws when resolvedDotUrl conflicts with --repo', () => {
    expect(() => resolveInitRepo('.', 'org/other', 'https://github.com/org/repo.git')).toThrow('Conflicting');
  });
});

// ── ProjectDeclaration schema tests ──────────────────────

import { ProjectDeclarationSchema, getProjectDeclarationPath } from '../types.js';

describe('ProjectDeclarationSchema', () => {
  it('parses valid declaration', () => {
    const result = ProjectDeclarationSchema.parse({
      repo: 'https://github.com/org/repo.git',
      defaultRole: 'dev',
      scope: 'project',
    });
    expect(result.repo).toBe('https://github.com/org/repo.git');
    expect(result.defaultRole).toBe('dev');
    expect(result.scope).toBe('project');
  });

  it('defaults scope to project', () => {
    const result = ProjectDeclarationSchema.parse({
      repo: 'https://github.com/org/repo.git',
    });
    expect(result.scope).toBe('project');
  });

  it('allows optional defaultRole', () => {
    const result = ProjectDeclarationSchema.parse({
      repo: 'https://github.com/org/repo.git',
    });
    expect(result.defaultRole).toBeUndefined();
  });

  it('rejects scope other than project', () => {
    expect(() => ProjectDeclarationSchema.parse({
      repo: 'https://github.com/org/repo.git',
      scope: 'user',
    })).toThrow();
  });

  it('rejects empty repo', () => {
    expect(() => ProjectDeclarationSchema.parse({ repo: '' })).toThrow();
  });

  it('rejects missing repo', () => {
    expect(() => ProjectDeclarationSchema.parse({})).toThrow();
  });
});

describe('getProjectDeclarationPath', () => {
  it('returns correct path', () => {
    expect(getProjectDeclarationPath('/my/project')).toBe(
      path.join('/my/project', '.teamai', 'project.yaml'),
    );
  });
});
