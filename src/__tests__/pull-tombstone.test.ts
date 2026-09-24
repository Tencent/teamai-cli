import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Mock external dependencies
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null }),
  saveStateForScope: vi.fn(),
}));

/** The rev `refreshTeamRepo` resolves for the fake team repo in these tests. */
const { HEAD_REV } = vi.hoisted(() => ({ HEAD_REV: 'rev-unchanged' }));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('Already up to date.'),
  // Needed by the unchanged-rev fast path: without a rev, pull always does a
  // full sync and that branch is unreachable.
  getHeadRev: vi.fn().mockResolvedValue(HEAD_REV),
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
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

import { pull, cleanupInactiveNamespaceSkills } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig, detectProjectConfig, loadStateForScope } from '../config.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [
      {
        id: 'hai',
        name: 'HAI R&D',
        description: 'HyperAI research and development resources',
        resources: {
          knowledge: ['common', 'hai'],
          skills: ['common', 'hai'],
          learnings: ['common', 'hai'],
          agents: [],
        },
      },
      {
        id: 'pm',
        name: 'Product Manager',
        description: 'Product planning and collaboration resources',
        resources: {
          knowledge: ['common', 'pm'],
          skills: ['common', 'pm'],
          learnings: ['common', 'pm'],
          agents: [],
        },
      },
    ],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(({ manifest, primaryRole, additionalRoles }) => {
    const allRoles = [primaryRole, ...additionalRoles].map((id: string) =>
      manifest.roles.find((role: { id: string }) => role.id === id),
    );
    if (allRoles.some((role: unknown) => !role)) {
      throw new Error('Unknown role in config');
    }
    const dedupe = (values: string[]) => [...new Set(values)];
    return {
      knowledge: dedupe(allRoles.flatMap((role: { resources: { knowledge: string[] } }) => role.resources.knowledge)),
      skills: dedupe(allRoles.flatMap((role: { resources: { skills: string[] } }) => role.resources.skills)),
      learnings: dedupe(allRoles.flatMap((role: { resources: { learnings: string[] } }) => role.resources.learnings)),
      agents: [],
    };
  }),
  // The real class: resource-namespaces distinguishes an absent manifest from a
  // malformed one by its type, so the mock has to carry the same identity.
  RolesManifestNotFoundError: class RolesManifestNotFoundError extends Error {},
}));

// Isolation: pull() takes a real ~/.teamai/.sync-lock. Parallel vitest workers
// sharing that path race and skip/error, so these tests mock the lock.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

describe('pull role-aware sync and cleanup', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-tombstone-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'common'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'hai'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'pm'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'common'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'hai'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'pm'));
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));

    vi.stubEnv('HOME', homeDir);

    const teamConfig: TeamaiConfig = {
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
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
        codex: { skills: '.codex/skills', rules: '.codex/rules' },
      },
    };

    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    // No stored rev by default, so every test does a full sync unless it opts
    // into the unchanged-rev fast path. A fresh object per call, like the real
    // loader: pull writes the rev onto what it reads, and a shared object would
    // leak that into the next pull of the same test.
    vi.mocked(loadStateForScope).mockImplementation(
      async () => ({ lastPull: null }) as Awaited<ReturnType<typeof loadStateForScope>>,
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should clean up local rule files that are tombstoned', async () => {
    // Tombstone for "old-rule"
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'old-rule\n');

    // Local residual files
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'old-rule.md'), '# Old');
    await fse.writeFile(path.join(homeDir, '.codex/rules', 'old-rule.md'), '# Old');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'old-rule.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codex/rules', 'old-rule.md'))).toBe(false);
  });

  it('should clean up local skill directories that are tombstoned', async () => {
    // Tombstone for "old-skill"
    await fse.writeFile(path.join(repoPath, 'skills', '.removed'), 'old-skill\n');

    // Local residual directories
    await fse.ensureDir(path.join(homeDir, '.claude/skills/old-skill'));
    await fse.writeFile(path.join(homeDir, '.claude/skills/old-skill/SKILL.md'), '# Old');
    await fse.ensureDir(path.join(homeDir, '.codex/skills/old-skill'));
    await fse.writeFile(path.join(homeDir, '.codex/skills/old-skill/SKILL.md'), '# Old');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/old-skill'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codex/skills/old-skill'))).toBe(false);
  });

  /** Deploys agents to the three tools whose render formats differ (#576). */
  const useAgentToolPaths = (): void => {
    vi.mocked(loadTeamConfig).mockResolvedValue({
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
        claude: { agents: '.claude/agents' },
        codex: { agents: '.codex/agents' },
        kiro: { agents: '.kiro/agents' },
      },
    });
  };

  /** Writes a tombstone for `foo` plus one stale render per tool. */
  const seedTombstonedAgent = async (): Promise<void> => {
    await fse.ensureDir(path.join(repoPath, 'agents'));
    await fse.writeFile(path.join(repoPath, 'agents', '.removed'), 'foo\n');

    for (const [dir, file] of [
      ['.claude/agents', 'foo.md'],
      ['.codex/agents', 'foo.toml'],
      ['.kiro/agents', 'foo.json'],
    ]) {
      await fse.ensureDir(path.join(homeDir, dir));
      await fse.writeFile(path.join(homeDir, dir, file), 'stale');
    }
  };

  const expectAgentRendersGone = async (): Promise<void> => {
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents', 'foo.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codex/agents', 'foo.toml'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.kiro/agents', 'foo.json'))).toBe(false);
  };

  it('should clean up tombstoned agent renders under every native extension', async () => {
    // Regression for #576: the tool-side render extension varies (.md Claude,
    // .toml Codex, .json Kiro), so the tombstone pass must clear all of them.
    useAgentToolPaths();
    await seedTombstonedAgent();

    await pull({});

    await expectAgentRendersGone();
  });

  it('should clean up tombstoned agents even when the repo rev is unchanged', async () => {
    // Regression for #576 on the upgrade path: a machine that pulled the
    // tombstone with the older CLI keeps the copies that CLI could not delete,
    // and its stored rev never moves again, so the fast path must clean too.
    useAgentToolPaths();
    await seedTombstonedAgent();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({
      lastPull: null,
      lastPullRev: HEAD_REV,
      lastPullTargets: ['claude', 'codex', 'kiro'],
    }) as Awaited<ReturnType<typeof loadStateForScope>>);

    await pull({});

    await expectAgentRendersGone();
  });

  it('should not delete files that are NOT tombstoned', async () => {
    // No tombstone files
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'keep-rule.md'), '# Keep');
    await fse.ensureDir(path.join(homeDir, '.claude/skills/keep-skill'));
    await fse.writeFile(path.join(homeDir, '.claude/skills/keep-skill/SKILL.md'), '# Keep');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'keep-rule.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/keep-skill'))).toBe(true);
  });

  it('should skip tombstone cleanup in dryRun mode', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'old-rule\n');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'old-rule.md'), '# Old');

    await pull({ dryRun: true });

    // File should still exist because dryRun skips cleanup
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'old-rule.md'))).toBe(true);
  });

  it('should handle empty tombstone files gracefully', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), '\n\n');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), '# Mine');

    await pull({});

    // Nothing should be deleted
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'my-rule.md'))).toBe(true);
  });

  it('should handle missing tombstone files gracefully', async () => {
    // No .removed file at all
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), '# Mine');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'my-rule.md'))).toBe(true);
  });

  it('pulls only the active skill namespaces for the saved role profile', async () => {
    await fse.ensureDir(path.join(repoPath, 'skills', 'common', 'shared-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'common', 'shared-skill', 'SKILL.md'), '# Shared');
    await fse.ensureDir(path.join(repoPath, 'skills', 'hai', 'hai-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'hai', 'hai-skill', 'SKILL.md'), '# HAI');
    await fse.ensureDir(path.join(repoPath, 'skills', 'pm', 'pm-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'pm', 'pm-skill', 'SKILL.md'), '# PM');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'shared-skill', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'hai-skill', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'pm-skill', 'SKILL.md'))).toBe(false);
  });

  it('only augments role-scoped skills with explicit tag matches', async () => {
    await fse.ensureDir(path.join(repoPath, 'skills', 'hai', 'backend-only'));
    await fse.writeFile(path.join(repoPath, 'skills', 'hai', 'backend-only', 'SKILL.md'), '# Backend');
    await fse.ensureDir(path.join(repoPath, 'skills', 'pm', 'beta-tag-wanted'));
    await fse.writeFile(path.join(repoPath, 'skills', 'pm', 'beta-tag-wanted', 'SKILL.md'), '# Wanted');
    await fse.ensureDir(path.join(repoPath, 'skills', 'pm', 'beta-tag-other'));
    await fse.writeFile(path.join(repoPath, 'skills', 'pm', 'beta-tag-other', 'SKILL.md'), '# Other');
    await fse.ensureDir(path.join(repoPath, 'skills', 'pm', 'frontend-only'));
    await fse.writeFile(path.join(repoPath, 'skills', 'pm', 'frontend-only', 'SKILL.md'), '# Frontend');
    await fse.writeFile(path.join(repoPath, 'tags.yaml'), [
      'skills:',
      '  beta-tag-wanted: [wanted]',
      '  beta-tag-other: [other]',
      '',
    ].join('\n'));

    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
      subscribedTags: ['wanted'],
    });
    const { log } = await import('../utils/logger.js');
    vi.mocked(log.dim).mockClear();

    await pull({ force: true });

    const detailOutput = vi.mocked(log.dim).mock.calls.flat().join('\n');
    expect(detailOutput).toContain('backend-only');
    expect(detailOutput).toContain('beta-tag-wanted');
    expect(detailOutput).not.toContain('beta-tag-other');
    expect(detailOutput).not.toContain('frontend-only');
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'backend-only', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'beta-tag-wanted', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'beta-tag-other'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'frontend-only'))).toBe(false);
  });

  it('removes a cross-role tagged skill after its subscription is cleared', async () => {
    await fse.ensureDir(path.join(repoPath, 'skills', 'pm', 'beta-tag-wanted'));
    await fse.writeFile(path.join(repoPath, 'skills', 'pm', 'beta-tag-wanted', 'SKILL.md'), '# Wanted');
    await fse.writeFile(path.join(repoPath, 'tags.yaml'), [
      'skills:',
      '  beta-tag-wanted: [wanted]',
      '',
    ].join('\n'));
    await fse.ensureDir(path.join(homeDir, '.claude/skills', 'beta-tag-wanted'));
    // Byte-identical to the team-repo source so the data-safety gate allows cleanup.
    await fse.writeFile(path.join(homeDir, '.claude/skills', 'beta-tag-wanted', 'SKILL.md'), '# Wanted');

    await pull({ force: true });

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'beta-tag-wanted'))).toBe(false);
  });

  it('removes stale skills from namespaces that are no longer active (unmodified copy)', async () => {
    // Deployed copy is byte-identical to the team-repo source → safe to delete.
    await fse.ensureDir(path.join(homeDir, '.claude/skills', 'pm-skill'));
    await fse.writeFile(path.join(homeDir, '.claude/skills', 'pm-skill', 'SKILL.md'), '# PM');
    await fse.ensureDir(path.join(repoPath, 'skills', 'pm', 'pm-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'pm', 'pm-skill', 'SKILL.md'), '# PM');
    const teamConfig = vi.mocked(loadTeamConfig).mock.results.at(-1)?.value;
    const localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user' as const,
    };

    await cleanupInactiveNamespaceSkills(
      await teamConfig,
      await localConfig,
      new Set(['shared-skill', 'hai-skill']),
      new Set(['pm-skill']),
      new Map([['pm-skill', path.join(repoPath, 'skills', 'pm', 'pm-skill')]]),
    );

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'pm-skill'))).toBe(false);
  });

  it('KEEPS a stale skill with local edits instead of deleting (data-loss guard, PR #444)', async () => {
    // Deployed copy has a modified SKILL.md + an unpushed file → must NOT delete.
    await fse.ensureDir(path.join(homeDir, '.claude/skills', 'pm-skill'));
    await fse.writeFile(path.join(homeDir, '.claude/skills', 'pm-skill', 'SKILL.md'), '# PM edited locally');
    await fse.writeFile(path.join(homeDir, '.claude/skills', 'pm-skill', 'unpublished.py'), 'print("wip")');
    await fse.ensureDir(path.join(repoPath, 'skills', 'pm', 'pm-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'pm', 'pm-skill', 'SKILL.md'), '# PM');
    const teamConfig = vi.mocked(loadTeamConfig).mock.results.at(-1)?.value;
    const localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser', updatePolicy: 'auto' as const,
      primaryRole: 'hai', additionalRoles: [], resourceProfileVersion: 1, scope: 'user' as const,
    };

    await cleanupInactiveNamespaceSkills(
      await teamConfig, await localConfig,
      new Set(['shared-skill', 'hai-skill']),
      new Set(['pm-skill']),
      new Map([['pm-skill', path.join(repoPath, 'skills', 'pm', 'pm-skill')]]),
    );

    // Skill dir AND the unpushed file survive.
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'pm-skill', 'unpublished.py'))).toBe(true);
    expect(await fse.readFile(path.join(homeDir, '.claude/skills', 'pm-skill', 'SKILL.md'), 'utf-8')).toBe('# PM edited locally');
  });

  it('KEEPS a stale skill when its team-repo source is gone (cannot verify → no delete)', async () => {
    await fse.ensureDir(path.join(homeDir, '.claude/skills', 'orphan-skill'));
    await fse.writeFile(path.join(homeDir, '.claude/skills', 'orphan-skill', 'SKILL.md'), '# orphan');
    const teamConfig = vi.mocked(loadTeamConfig).mock.results.at(-1)?.value;
    const localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser', updatePolicy: 'auto' as const,
      primaryRole: 'hai', additionalRoles: [], resourceProfileVersion: 1, scope: 'user' as const,
    };

    await cleanupInactiveNamespaceSkills(
      await teamConfig, await localConfig,
      new Set(['shared-skill', 'hai-skill']),
      new Set(['orphan-skill']),
      new Map(), // no source recorded
    );

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'orphan-skill'))).toBe(true);
  });

  it('KEEPS a stale skill that contains a local .git dir even if its files match (stash/history guard, PR #444)', async () => {
    // Deployed working tree is byte-identical to source, BUT the skill dir holds a
    // local git repo — its .git may carry stashes / unpushed commits that a file
    // compare (which skips .git) cannot see. Must NOT delete.
    await fse.ensureDir(path.join(homeDir, '.claude/skills', 'vcs-skill'));
    await fse.writeFile(path.join(homeDir, '.claude/skills', 'vcs-skill', 'SKILL.md'), '# VCS');
    await fse.ensureDir(path.join(homeDir, '.claude/skills', 'vcs-skill', '.git'));
    await fse.writeFile(path.join(homeDir, '.claude/skills', 'vcs-skill', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fse.ensureDir(path.join(repoPath, 'skills', 'pm', 'vcs-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'pm', 'vcs-skill', 'SKILL.md'), '# VCS');
    const teamConfig = vi.mocked(loadTeamConfig).mock.results.at(-1)?.value;
    const localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser', updatePolicy: 'auto' as const,
      primaryRole: 'hai', additionalRoles: [], resourceProfileVersion: 1, scope: 'user' as const,
    };

    await cleanupInactiveNamespaceSkills(
      await teamConfig, await localConfig,
      new Set(['shared-skill', 'hai-skill']),
      new Set(['vcs-skill']),
      new Map([['vcs-skill', path.join(repoPath, 'skills', 'pm', 'vcs-skill')]]),
    );

    // Skill dir AND its .git survive.
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'vcs-skill', '.git', 'HEAD'))).toBe(true);
  });

  it('KEEPS a stale skill with a NESTED git repo (scripts/.git), files matching (PR #444)', async () => {
    // The git repo is in a subdirectory, not the skill root. dirContentEqual skips
    // every .git at any depth, so only a recursive VCS scan catches this.
    const sk = path.join(homeDir, '.claude/skills', 'nested-vcs');
    await fse.ensureDir(path.join(sk, 'scripts'));
    await fse.writeFile(path.join(sk, 'SKILL.md'), '# Nested');
    await fse.writeFile(path.join(sk, 'scripts', 'runner.py'), 'print("run")');
    await fse.ensureDir(path.join(sk, 'scripts', '.git'));
    await fse.writeFile(path.join(sk, 'scripts', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    // Source has the same working-tree files (the nested .git is invisible to compare).
    const src = path.join(repoPath, 'skills', 'pm', 'nested-vcs');
    await fse.ensureDir(path.join(src, 'scripts'));
    await fse.writeFile(path.join(src, 'SKILL.md'), '# Nested');
    await fse.writeFile(path.join(src, 'scripts', 'runner.py'), 'print("run")');
    const teamConfig = vi.mocked(loadTeamConfig).mock.results.at(-1)?.value;
    const localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser', updatePolicy: 'auto' as const,
      primaryRole: 'hai', additionalRoles: [], resourceProfileVersion: 1, scope: 'user' as const,
    };

    await cleanupInactiveNamespaceSkills(
      await teamConfig, await localConfig,
      new Set(['shared-skill', 'hai-skill']),
      new Set(['nested-vcs']),
      new Map([['nested-vcs', src]]),
    );

    // Nested .git (and the whole skill) survives.
    expect(await fse.pathExists(path.join(sk, 'scripts', '.git', 'HEAD'))).toBe(true);
  });

  it('gracefully degrades when the roles manifest is absent', async () => {
    const { loadRolesManifest, RolesManifestNotFoundError } = await import('../roles.js');
    vi.mocked(loadRolesManifest).mockRejectedValueOnce(
      new RolesManifestNotFoundError('/repo/manifest/roles.yaml'),
    );

    await pull({});

    const { log } = await import('../utils/logger.js');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Roles manifest not found'));
  });

  it('fails the scope instead of delivering everything when the roles manifest is malformed', async () => {
    // A manifest that exists but does not parse cannot degrade to "no filter":
    // that hands out exactly the namespaces it was written to gate.
    const { loadRolesManifest } = await import('../roles.js');
    vi.mocked(loadRolesManifest).mockRejectedValueOnce(
      new Error("Invalid roles manifest: roles.0.resources.skills.0: resource namespace must be a single path segment"),
    );

    await pull({});

    // pull logs the manifest error and returns before any resource is written,
    // which is what an invalid projects manifest already does.
    const { log } = await import('../utils/logger.js');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Invalid roles manifest'));
  });

  it('aborts pull when the same skill exists in multiple active namespaces', async () => {
    await fse.ensureDir(path.join(repoPath, 'skills', 'common', 'shared-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'common', 'shared-skill', 'SKILL.md'), '# Common');
    await fse.ensureDir(path.join(repoPath, 'skills', 'hai', 'shared-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'hai', 'shared-skill', 'SKILL.md'), '# HAI');

    const teamConfig = await vi.mocked(loadTeamConfig).mock.results.at(-1)?.value;
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
    };
    const { scanRoleAwareSkills } = await import('../pull.js');

    await expect(scanRoleAwareSkills(
      localConfig,
      { knowledge: ['common', 'hai'], skills: ['common', 'hai'], learnings: [], agents: [] },
    )).rejects.toThrow(/Duplicate skill "shared-skill"/);
  });

  it('cleans up stale skills after role change (full pull cycle)', async () => {
    // Setup: create skills in all namespaces. Real team skills carry complete
    // frontmatter, so ensureSkillFrontmatter is idempotent on deploy and the
    // deployed copy compares equal to its source (needed for safe cleanup).
    await fse.ensureDir(path.join(repoPath, 'skills', 'common', 'shared-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'common', 'shared-skill', 'SKILL.md'), '---\nname: shared-skill\ndescription: shared\n---\n# Shared');
    await fse.ensureDir(path.join(repoPath, 'skills', 'hai', 'hai-only'));
    await fse.writeFile(path.join(repoPath, 'skills', 'hai', 'hai-only', 'SKILL.md'), '---\nname: hai-only\ndescription: hai\n---\n# HAI Only');
    await fse.ensureDir(path.join(repoPath, 'skills', 'pm', 'pm-only'));
    await fse.writeFile(path.join(repoPath, 'skills', 'pm', 'pm-only', 'SKILL.md'), '---\nname: pm-only\ndescription: pm\n---\n# PM Only');

    // Step 1: Pull as hai role — should get common + hai skills
    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'shared-skill', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'hai-only', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'pm-only'))).toBe(false);

    // Step 2: Switch to pm role (simulate what `roles set pm` does)
    const pmConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: 'pm',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
    };
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(pmConfig);

    // Step 3: Pull as pm role — should get common + pm, remove hai-only
    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'shared-skill', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'pm-only', 'SKILL.md'))).toBe(true);
    // hai-only should be cleaned up
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'hai-only'))).toBe(false);
  });
});
