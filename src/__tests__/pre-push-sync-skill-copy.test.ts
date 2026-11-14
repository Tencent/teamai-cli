/**
 * #823 item 5: a skill copy the pre-push sync cannot finish must leave the
 * local skill as it was. A half-written copy mixes files from two revisions,
 * matches no base, and the next push lists the skill as modified.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

const mockGetFileContentAtRev = vi.fn<(repoPath: string, rev: string, filePath: string) => Promise<Buffer | null>>();
vi.mock('../utils/git.js', () => ({
  getFileContentAtRev: (...args: [string, string, string]) => mockGetFileContentAtRev(...args),
  getFileContentWhenAdded: vi.fn().mockResolvedValue(null),
}));

// A copy that writes the first file of the source and then fails, as a full
// disk or a permission error partway through would.
vi.mock('../utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fs.js')>();
  return {
    ...actual,
    copyDir: async (src: string, dest: string): Promise<void> => {
      const [first] = (await actual.listFilesRecursive(src)).sort();
      if (first !== undefined) await actual.copyFile(path.join(src, first), path.join(dest, first));
      throw new Error('ENOSPC: no space left on device');
    },
  };
});

import { syncTeamUpdatesToLocal } from '../utils/pre-push-sync.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('syncTeamUpdatesToLocal — a skill copy that fails partway', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pre-push-sync-copy-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
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
      toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
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

  it('leaves the whole previous version in place, and nothing beside it', async () => {
    const teamSkillDir = path.join(repoPath, 'skills', 'my-skill');
    await fse.outputFile(path.join(teamSkillDir, 'SKILL.md'), 'v2 skill');
    await fse.outputFile(path.join(teamSkillDir, 'notes.md'), 'v2 notes');
    const skillsDir = path.join(homeDir, '.claude', 'skills');
    const localSkillDir = path.join(skillsDir, 'my-skill');
    await fse.outputFile(path.join(localSkillDir, 'SKILL.md'), 'v1 skill');
    await fse.outputFile(path.join(localSkillDir, 'notes.md'), 'v1 notes');
    mockGetFileContentAtRev.mockImplementation(async (_repo, _rev, file) => (
      Buffer.from(file.endsWith('SKILL.md') ? 'v1 skill' : 'v1 notes')
    ));

    await expect(syncTeamUpdatesToLocal(teamConfig, localConfig, 'rev1')).rejects.toThrow('ENOSPC');

    expect(await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8')).toBe('v1 skill');
    expect(await fse.readFile(path.join(localSkillDir, 'notes.md'), 'utf-8')).toBe('v1 notes');
    expect(await fse.readdir(skillsDir)).toEqual(['my-skill']);
  });
});
