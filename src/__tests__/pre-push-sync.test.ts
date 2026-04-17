import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

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

// Mock getFileContentAtRev since test dirs are not real git repos
const mockGetFileContentAtRev = vi.fn<(repoPath: string, rev: string, filePath: string) => Promise<Buffer | null>>();
vi.mock('../utils/git.js', () => ({
  getFileContentAtRev: (...args: [string, string, string]) => mockGetFileContentAtRev(...args),
  createGit: vi.fn(),
  pullRepo: vi.fn(),
  pushRepoBranch: vi.fn(),
  generateBranchName: vi.fn(),
}));

import { syncTeamUpdatesToLocal } from '../utils/pre-push-sync.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('syncTeamUpdatesToLocal — rules', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pre-push-sync-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));

    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: {
          skills: '.claude/skills',
          rules: '.claude/rules',
          settings: '.claude/settings.json',
          claudemd: '.claude/CLAUDE.md',
        },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };

    mockGetFileContentAtRev.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should sync local rule when team repo updated but user did not edit', async () => {
    // Team repo has new version (v2)
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'v2 content');
    // Local still has old version (v1)
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'v1 content');
    // Old team repo version was also v1
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should now have v2
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('v2 content');
  });

  it('should NOT sync local rule when user edited it', async () => {
    // Team repo has v2
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'v2 content');
    // Local has user's custom edit (differs from both old and new team version)
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'user custom content');
    // Old team repo version was v1
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should still have user's edit
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('user custom content');
  });

  it('should NOT sync when both user and team changed the file', async () => {
    // Team repo has v3
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'v3 team content');
    // Local has v2 (user edit)
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'v2 user content');
    // Old team repo version was v1 (different from local v2)
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should keep v2 (user's edit preserved)
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('v2 user content');
  });

  it('should skip files that are already identical (no-op)', async () => {
    const sameContent = 'identical content';
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), sameContent);
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), sameContent);

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Should not call getFileContentAtRev at all (files are equal, skipped early)
    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();

    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe(sameContent);
  });

  it('should skip sync entirely when lastPullRev is null', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'v2');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'v1');

    await syncTeamUpdatesToLocal(teamConfig, localConfig, null);

    // Local should be unchanged
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('v1');
    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
  });

  it('should skip files that are new in team repo since last pull', async () => {
    // Team repo has a new file
    await fse.writeFile(path.join(repoPath, 'rules', 'new-rule.md'), 'new content');
    // Local does NOT have this file
    // Old team repo also didn't have it
    mockGetFileContentAtRev.mockResolvedValue(null);

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should still not have the file (sync only handles existing files)
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'new-rule.md'))).toBe(false);
  });

  it('should skip local-only files not in team repo', async () => {
    // Local has a file, team repo does not
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'local-only.md'), 'my local rule');

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local file should be untouched
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'local-only.md'), 'utf-8');
    expect(content).toBe('my local rule');
    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
  });

  it('should handle rules in subdirectories (e.g., python/tencent_standard.md)', async () => {
    // Team repo has updated file in subdirectory
    await fse.ensureDir(path.join(repoPath, 'rules', 'python'));
    await fse.writeFile(path.join(repoPath, 'rules', 'python/tencent_standard.md'), 'v2 standard');

    // Local still has old version
    await fse.ensureDir(path.join(homeDir, '.claude/rules', 'python'));
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'python/tencent_standard.md'), 'v1 standard');

    // Old team repo version was v1
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 standard'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should now have v2
    const content = await fse.readFile(
      path.join(homeDir, '.claude/rules', 'python/tencent_standard.md'),
      'utf-8',
    );
    expect(content).toBe('v2 standard');

    // Should have been called with the correct git path
    expect(mockGetFileContentAtRev).toHaveBeenCalledWith(
      repoPath,
      'abc1234',
      'rules/python/tencent_standard.md',
    );
  });

  it('should sync all installed tool directories', async () => {
    // Add a second tool
    await fse.ensureDir(path.join(homeDir, '.workbuddy', 'rules'));
    teamConfig.toolPaths.workbuddy = { skills: '.workbuddy/skills', rules: '.workbuddy/rules' };

    // Team repo has v2
    await fse.writeFile(path.join(repoPath, 'rules', 'shared.md'), 'v2');
    // Both tool dirs have v1
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'shared.md'), 'v1');
    await fse.writeFile(path.join(homeDir, '.workbuddy/rules', 'shared.md'), 'v1');
    // Old team repo was v1
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Both should now have v2
    const claudeContent = await fse.readFile(path.join(homeDir, '.claude/rules', 'shared.md'), 'utf-8');
    const wbContent = await fse.readFile(path.join(homeDir, '.workbuddy/rules', 'shared.md'), 'utf-8');
    expect(claudeContent).toBe('v2');
    expect(wbContent).toBe('v2');
  });

  it('should skip uninstalled tool directories', async () => {
    // Add a tool that is NOT installed (no .codex/ directory)
    teamConfig.toolPaths.codex = { skills: '.codex/skills', rules: '.codex/rules' };
    // Note: .codex/ directory does NOT exist

    // Team repo has v2
    await fse.writeFile(path.join(repoPath, 'rules', 'shared.md'), 'v2');
    // Only claude has v1
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'shared.md'), 'v1');
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Claude should be synced
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'shared.md'), 'utf-8');
    expect(content).toBe('v2');
    // .codex/ should NOT have been created
    expect(await fse.pathExists(path.join(homeDir, '.codex'))).toBe(false);
  });

  it('should not sync built-in rules like teamai-recall', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'teamai-recall.md'), 'v2 recall');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'teamai-recall.md'), 'v1 recall');

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Should not touch teamai-recall — it's excluded
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'teamai-recall.md'), 'utf-8');
    expect(content).toBe('v1 recall');
    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
  });

  it('should skip sync when getFileContentAtRev returns null (rev invalid)', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'v2');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'v1');
    // Simulate invalid/missing rev
    mockGetFileContentAtRev.mockResolvedValue(null);

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'bad-rev');

    // Local should be unchanged (conservative: don't sync if we can't verify)
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('v1');
  });
});

describe('syncTeamUpdatesToLocal — skills', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pre-push-sync-skills-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: {
          skills: '.claude/skills',
          rules: '.claude/rules',
          settings: '.claude/settings.json',
          claudemd: '.claude/CLAUDE.md',
        },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };

    mockGetFileContentAtRev.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should sync skill dir when team repo updated but user did not edit', async () => {
    // Team repo: flat skill with SKILL.md v2
    const teamSkillDir = path.join(repoPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), 'v2 skill');

    // Local: same skill with v1
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), 'v1 skill');

    // Old team repo version was v1
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 skill'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should now have v2
    const content = await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8');
    expect(content).toBe('v2 skill');
  });

  it('should NOT sync skill dir when user edited any file', async () => {
    // Team repo: skill with SKILL.md v2
    const teamSkillDir = path.join(repoPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), 'v2 skill');

    // Local: user edited SKILL.md
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), 'user modified skill');

    // Old team repo version was v1 (different from local user edit)
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 skill'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should keep user's edit
    const content = await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8');
    expect(content).toBe('user modified skill');
  });

  it('should handle namespaced skills', async () => {
    // Team repo: namespaced skill ns/my-skill
    const teamSkillDir = path.join(repoPath, 'skills', 'ns', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), 'v2 namespaced');

    // Local: same skill (local dirs are flat, not namespaced)
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), 'v1 namespaced');

    // Old team repo version was v1
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 namespaced'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should now have v2
    const content = await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8');
    expect(content).toBe('v2 namespaced');
  });

  it('should skip skill dirs that are already identical', async () => {
    const sameContent = 'identical skill content';
    const teamSkillDir = path.join(repoPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), sameContent);

    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), sameContent);

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
  });

  it('should skip skills that only exist locally (not in team repo)', async () => {
    const localSkillDir = path.join(homeDir, '.claude/skills', 'local-only');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), 'local skill');

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Should not touch local-only skills
    const content = await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8');
    expect(content).toBe('local skill');
    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
  });
});
