import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// ── Mocks ────────────────────────────────────────────────

const mockGit = {
  pull: vi.fn().mockResolvedValue({ summary: { changes: 0, insertions: 0, deletions: 0 } }),
  addConfig: vi.fn(),
  revparse: vi.fn().mockResolvedValue('abc1234'),
  getRemotes: vi.fn(),
};

vi.mock('simple-git', () => ({
  default: () => mockGit,
}));

const mockPathExists = vi.fn();
const mockWriteFile = vi.fn();
const mockEnsureDir = vi.fn();

vi.mock('fs-extra', () => ({
  default: {
    pathExists: (...args: unknown[]) => mockPathExists(...args),
    readFile: vi.fn(),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    ensureDir: (...args: unknown[]) => mockEnsureDir(...args),
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

const mockCloneRepo = vi.fn();
const mockParseRepoInput = vi.fn().mockReturnValue({
  owner: 'org',
  repo: 'team-repo',
  httpsUrl: 'https://github.com/org/team-repo.git',
});
const mockAuthenticate = vi.fn().mockResolvedValue('testuser');
const mockEnsureInstalled = vi.fn();
const mockIsAuthenticated = vi.fn().mockReturnValue(true);

vi.mock('../providers/index.js', () => ({
  detectProvider: vi.fn().mockReturnValue('github'),
  getProvider: vi.fn().mockReturnValue({
    cloneRepo: (...args: unknown[]) => mockCloneRepo(...args),
    parseRepoInput: (...args: unknown[]) => mockParseRepoInput(...args),
    authenticate: () => mockAuthenticate(),
    ensureInstalled: () => mockEnsureInstalled(),
    isAuthenticated: () => mockIsAuthenticated(),
    getDefaultEmailDomain: vi.fn().mockReturnValue(null),
  }),
}));

const mockSaveLocalConfigForScope = vi.fn();
const mockLoadTeamConfig = vi.fn().mockResolvedValue(null);
const mockLoadProjectDeclaration = vi.fn();
const mockDetectProjectConfig = vi.fn().mockResolvedValue(null);
const mockLoadLocalConfigForScope = vi.fn().mockResolvedValue(null);

vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  loadState: vi.fn(),
  saveState: vi.fn(),
  detectProjectConfig: () => mockDetectProjectConfig(),
  loadProjectDeclaration: (...args: unknown[]) => mockLoadProjectDeclaration(...args),
  loadLocalConfigForScope: (...args: unknown[]) => mockLoadLocalConfigForScope(...args),
  loadTeamConfig: (...args: unknown[]) => mockLoadTeamConfig(...args),
  saveLocalConfigForScope: (...args: unknown[]) => mockSaveLocalConfigForScope(...args),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPullRev: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../hooks.js', () => ({
  reconcileTeamHooksForConfig: vi.fn(),
}));

vi.mock('../utils/claudemd.js', () => ({
  injectClaudeMdSection: vi.fn(),
}));

vi.mock('../resources/index.js', () => ({
  getHandler: vi.fn(),
  RulesHandler: vi.fn(),
  DocsHandler: vi.fn(),
  EnvHandler: vi.fn(),
}));

vi.mock('../resources/base.js', () => ({
  ResourceHandler: vi.fn(),
}));

vi.mock('../utils/tags.js', () => ({
  loadTagsConfig: vi.fn(),
  filterByTags: vi.fn(),
}));

vi.mock('../builtin-skills.js', () => ({
  BUILTIN_SKILL_NAMES: new Set(),
}));

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockRejectedValue(new Error('Roles manifest not found')),
  resolveRoleResourceNamespaces: vi.fn(),
}));

vi.mock('gray-matter', () => ({
  default: vi.fn(),
}));

import { pull } from '../pull.js';
import { log } from '../utils/logger.js';

describe('autoBootstrapIfNeeded (via pull)', () => {
  const cwd = '/tmp/my-project';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    process.env.HOME = '/home/user';
    mockIsAuthenticated.mockReturnValue(true);
    mockAuthenticate.mockResolvedValue('testuser');
  });

  it('bootstraps when project.yaml exists and config.yaml does not', async () => {
    mockPathExists.mockImplementation((p: string) => {
      if (p.endsWith('project.yaml')) return Promise.resolve(true);
      if (p.endsWith('config.yaml')) return Promise.resolve(false);
      if (p.endsWith('.gitignore')) return Promise.resolve(false);
      if (p.endsWith('team-repo')) return Promise.resolve(false);
      return Promise.resolve(false);
    });

    mockLoadProjectDeclaration.mockResolvedValue({
      repo: 'https://github.com/org/team-repo.git',
      defaultRole: 'dev',
      scope: 'project',
    });

    await pull({ silent: true });

    expect(mockCloneRepo).toHaveBeenCalledWith('org/team-repo', expect.stringContaining('team-repo'));
    expect(mockSaveLocalConfigForScope).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: expect.objectContaining({ remote: 'https://github.com/org/team-repo.git' }),
        username: 'testuser',
        scope: 'project',
        projectRoot: cwd,
      }),
      'project',
      cwd,
    );
    expect(vi.mocked(log.success)).toHaveBeenCalledWith(expect.stringContaining('Bootstrap complete'));
  });

  it('skips bootstrap when config.yaml already exists (idempotent)', async () => {
    mockPathExists.mockImplementation((p: string) => {
      if (p.endsWith('project.yaml')) return Promise.resolve(true);
      if (p.endsWith('config.yaml')) return Promise.resolve(true);
      return Promise.resolve(false);
    });

    await pull({ silent: true });

    expect(mockCloneRepo).not.toHaveBeenCalled();
    expect(mockSaveLocalConfigForScope).not.toHaveBeenCalled();
  });

  it('skips bootstrap when no project.yaml exists', async () => {
    mockPathExists.mockResolvedValue(false);

    await pull({ silent: true });

    expect(mockCloneRepo).not.toHaveBeenCalled();
  });

  it('handles auth failure gracefully', async () => {
    mockPathExists.mockImplementation((p: string) => {
      if (p.endsWith('project.yaml')) return Promise.resolve(true);
      if (p.endsWith('config.yaml')) return Promise.resolve(false);
      return Promise.resolve(false);
    });

    mockLoadProjectDeclaration.mockResolvedValue({
      repo: 'https://github.com/org/team-repo.git',
      scope: 'project',
    });

    mockAuthenticate.mockRejectedValueOnce(new Error('Not logged in'));

    await pull({ silent: true });

    expect(mockCloneRepo).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('Auth failed'));
  });

  it('handles clone failure gracefully', async () => {
    mockPathExists.mockImplementation((p: string) => {
      if (p.endsWith('project.yaml')) return Promise.resolve(true);
      if (p.endsWith('config.yaml')) return Promise.resolve(false);
      if (p.endsWith('team-repo')) return Promise.resolve(false);
      return Promise.resolve(false);
    });

    mockLoadProjectDeclaration.mockResolvedValue({
      repo: 'https://github.com/org/team-repo.git',
      scope: 'project',
    });

    mockCloneRepo.mockImplementation(() => { throw new Error('Network error'); });

    await pull({ silent: true });

    expect(mockSaveLocalConfigForScope).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('Clone failed'));
  });

  it('does not trigger interactive login when not authenticated', async () => {
    mockPathExists.mockImplementation((p: string) => {
      if (p.endsWith('project.yaml')) return Promise.resolve(true);
      if (p.endsWith('config.yaml')) return Promise.resolve(false);
      return Promise.resolve(false);
    });

    mockLoadProjectDeclaration.mockResolvedValue({
      repo: 'https://github.com/org/team-repo.git',
      scope: 'project',
    });

    mockIsAuthenticated.mockReturnValue(false);

    await pull({ silent: true });

    // Must NOT call authenticate() (which could launch `gh auth login --web`
    // and hang the session-start hook) and must NOT clone.
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(mockCloneRepo).not.toHaveBeenCalled();
    expect(mockSaveLocalConfigForScope).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("teamai init ."));
  });

  it('skips bootstrap when cwd is HOME', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/home/user');

    mockPathExists.mockImplementation((p: string) => {
      if (p.endsWith('project.yaml')) return Promise.resolve(true);
      if (p.endsWith('config.yaml')) return Promise.resolve(false);
      return Promise.resolve(false);
    });

    await pull({ silent: true });

    expect(mockCloneRepo).not.toHaveBeenCalled();
  });
});
