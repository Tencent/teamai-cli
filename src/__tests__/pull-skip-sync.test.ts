import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Mock external dependencies
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  createGit: vi.fn(),
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

vi.mock('../roles.js', async () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [
      {
        id: 'hai',
        name: 'HAI R&D',
        description: 'HyperAI resources',
        resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], learnings: ['common', 'hai'], agents: [] },
      },
    ],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(({ manifest, primaryRole, additionalRoles }) => {
    const allRoles = [primaryRole, ...additionalRoles].map((id: string) =>
      manifest.roles.find((role: { id: string }) => role.id === id),
    );
    const dedupe = (values: string[]) => [...new Set(values)];
    return {
      knowledge: dedupe(allRoles.flatMap((role: { resources: { knowledge: string[] } }) => role.resources.knowledge)),
      skills: dedupe(allRoles.flatMap((role: { resources: { skills: string[] } }) => role.resources.skills)),
      learnings: dedupe(allRoles.flatMap((role: { resources: { learnings: string[] } }) => role.resources.learnings)),
      agents: [],
    };
  }),
  // Env delivery resolves the member's role axis (#668), so this partial mock has
  // to carry activeRoleIds and the loader membership.ts reads. Taken from the real
  // module rather than restated, so a change to either cannot drift from its stub.
  activeRoleIds: (await vi.importActual<typeof import('../roles.js')>('../roles.js')).activeRoleIds,
  listRoleIds: (await vi.importActual<typeof import('../roles.js')>('../roles.js')).listRoleIds,
  loadRolesManifestIfPresent: vi.fn().mockResolvedValue(null),
}));

// Isolation: pull() takes a real ~/.teamai/.sync-lock. Parallel vitest workers
// sharing that path race and skip/error, so these tests mock the lock.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull, compileRecallRulesBlock, cleanupInactiveNamespaceSkills } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig, detectProjectConfig, loadStateForScope, saveStateForScope } from '../config.js';
import { getHeadRev, createGit, pullRepo } from '../utils/git.js';
import { log } from '../utils/logger.js';
import {
  TeamaiConfigSchema,
  TEAMAI_RECALL_RULES_START,
  TEAMAI_RECALL_RULES_END,
  TEAMAI_CULTURE_START,
  TEAMAI_CLAUDEMD_START,
} from '../types.js';
import type { TeamaiConfig, LocalConfig, State } from '../types.js';

describe('pull skip-sync when repo HEAD unchanged', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let baseTeamConfig: TeamaiConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-skip-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'common'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'hai'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'common'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'hai'));
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

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
      },
    };
    baseTeamConfig = teamConfig;

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
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  it('should skip sync when HEAD rev matches lastPullRev', async () => {
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPullTargets: ['claude'],
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    expect(log.success).toHaveBeenCalledWith(
      expect.stringContaining('Already synced at abc1234, skipping'),
    );
    // State should NOT be re-saved (no sync happened)
    expect(saveStateForScope).not.toHaveBeenCalled();
  });

  it('re-delivers env on the revision fast path so a variable scoped away by an upgrade leaves env.sh', async () => {
    // The machine pulled with a CLI that ignored `roles:` on env variables, so
    // env.sh holds every declared variable and lastPullRev matches HEAD. The
    // repo has not moved; only the CLI has. Hooks and MCP reconcile outside the
    // fast path already; env must not be the one axis a plain `teamai pull`
    // leaves stale until --force.
    await fse.ensureDir(path.join(repoPath, 'env'));
    await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), [
      'variables:',
      '  - key: SHARED_URL',
      '    value: https://shared.example',
      '  - key: DEVOPS_ONLY',
      '    value: devops-secret',
      '    roles: [devops]',
      '',
    ].join('\n'));
    const envShPath = path.join(homeDir, '.teamai', 'env.sh');
    await fse.ensureDir(path.dirname(envShPath));
    await fse.writeFile(envShPath, "export SHARED_URL='https://shared.example'\nexport DEVOPS_ONLY='devops-secret'\n");

    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue(emptyState({
      lastPullRev: 'abc1234',
      lastPullTargets: ['claude'],
    }));

    await pull({});

    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Already synced at abc1234, skipping'));
    const envSh = await fse.readFile(envShPath, 'utf8');
    expect(envSh).toContain("export SHARED_URL='https://shared.example'");
    expect(envSh).not.toContain('DEVOPS_ONLY');
    // Still the fast path: the revision cache is not rewritten.
    expect(saveStateForScope).not.toHaveBeenCalled();
  });

  it('warns when the fast-path env delivery cannot write env.sh', async () => {
    // The one failure that must not be silent: this delivery is what REMOVES a
    // variable the member is no longer scoped to, and it runs after
    // "Already synced" has already printed. A debug-only log would leave the
    // withheld variable exported with nothing on screen to say so.
    await fse.ensureDir(path.join(repoPath, 'env'));
    await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), [
      'variables:',
      '  - key: SHARED_URL',
      '    value: https://shared.example',
      '',
    ].join('\n'));
    const envShPath = path.join(homeDir, '.teamai', 'env.sh');
    // A directory where the file goes: writeFile throws, on every platform and
    // as root, unlike a permission bit.
    await fse.ensureDir(envShPath);

    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue(emptyState({
      lastPullRev: 'abc1234',
      lastPullTargets: ['claude'],
    }));

    await pull({});

    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Already synced at abc1234, skipping'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not refresh env variables'));
    // Names the file that may still be stale, and the way out.
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(envShPath));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('teamai pull --force'));
  });

  it('stops before the revision fast path when role-scoped resources cannot be resolved', async () => {
    await fse.remove(path.join(repoPath, 'skills', 'common'));
    await fse.writeFile(path.join(repoPath, 'skills', 'common'), 'not a directory\n');
    vi.mocked(loadStateForScope).mockResolvedValue(emptyState({
      lastPullRev: 'abc1234',
      lastPullTargets: ['claude'],
    }));

    await pull({});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('ENOTDIR'));
    expect(log.success).not.toHaveBeenCalledWith(
      expect.stringContaining('Already synced at abc1234, skipping'),
    );
  });

  it('should refresh the clone before reading teamai.yaml when it is missing locally', async () => {
    // The clone lacks teamai.yaml until git pull brings it from the remote.
    let pulled = false;
    vi.mocked(pullRepo).mockImplementationOnce(async () => { pulled = true; return 'updated'; });
    vi.mocked(loadTeamConfig).mockImplementation(async () => (pulled ? baseTeamConfig : null));
    vi.mocked(getHeadRev).mockResolvedValue('def5678');

    await pull({ force: true });

    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('teamai.yaml) not found'));
    expect(saveStateForScope).toHaveBeenCalled();
  });

  it('should sync once when a matching legacy state has no target marker', async () => {
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    expect(log.success).not.toHaveBeenCalledWith(
      expect.stringContaining('Already synced'),
    );
    expect(saveStateForScope).toHaveBeenCalled();
    expect(vi.mocked(saveStateForScope).mock.calls[0][0].lastPullTargets).toEqual(['claude']);
  });

  it('should do full sync when HEAD rev differs from lastPullRev', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), '# rule');

    vi.mocked(getHeadRev).mockResolvedValue('def5678');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    // Should have saved state with new rev
    expect(saveStateForScope).toHaveBeenCalled();
    const savedState = vi.mocked(saveStateForScope).mock.calls[0][0];
    expect(savedState.lastPullRev).toBe('def5678');
  });

  it('should do full sync when lastPullRev is null (first pull)', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), '# rule');

    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: null,
      lastPullRev: null,
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    // Should proceed with sync (not skip)
    expect(saveStateForScope).toHaveBeenCalled();
  });

  it('should do full sync when --force is set even if rev matches', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), '# rule');

    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({ force: true });

    // Should proceed with full sync despite matching rev
    expect(saveStateForScope).toHaveBeenCalled();
  });

  it('should not skip sync in dryRun mode even if rev matches', async () => {
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({ dryRun: true });

    // dryRun should show what would happen, not skip
    expect(log.success).not.toHaveBeenCalledWith(
      expect.stringContaining('Already synced'),
    );
  });

  it('should proceed with full sync when getHeadRev fails', async () => {
    vi.mocked(getHeadRev).mockRejectedValue(new Error('not a git repo'));
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    // Should fall through to full sync
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('Rev check failed'),
    );
  });

  it('does not persist the rev when the submodule update failed', async () => {
    vi.mocked(loadTeamConfig).mockResolvedValue({ ...baseTeamConfig, submodules: true });
    vi.mocked(createGit).mockReturnValue({
      submoduleUpdate: vi.fn().mockRejectedValue(new Error('reference is not a tree')),
    } as unknown as ReturnType<typeof createGit>);
    vi.mocked(getHeadRev).mockResolvedValue('def5678');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    // The tree on disk is not a complete snapshot: caching the new rev would
    // let the unchanged-rev fast path suppress the retry forever.
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Submodule update failed'));
    expect(saveStateForScope).toHaveBeenCalled();
    const savedState = vi.mocked(saveStateForScope).mock.calls[0][0];
    expect(savedState.lastPullRev).toBe('abc1234');
  });

  it('persists the rev when the submodule update succeeded', async () => {
    vi.mocked(loadTeamConfig).mockResolvedValue({ ...baseTeamConfig, submodules: true });
    vi.mocked(createGit).mockReturnValue({
      submoduleUpdate: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof createGit>);
    vi.mocked(getHeadRev).mockResolvedValue('def5678');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    const savedState = vi.mocked(saveStateForScope).mock.calls[0][0];
    expect(savedState.lastPullRev).toBe('def5678');
  });

  // A successful `submodule update` can still change the deployed tree while the
  // PARENT revision stays the same: a member who pulled with a CLI that ignored
  // `submodules: true` (unknown yaml key stripped) cached the parent SHA with
  // empty submodule dirs, and upgrading the CLI then fills those dirs without
  // moving HEAD. The unchanged-rev fast path would skip the deploy and leave
  // ~/.claude/skills empty until `pull --force`. See issue #525.
  it('does not skip sync when a successful submodule update changed the tree', async () => {
    vi.mocked(loadTeamConfig).mockResolvedValue({ ...baseTeamConfig, submodules: true });
    // `git submodule status` before the update marks the submodule uninitialized
    // (leading `-`); after it, the submodule is checked out at its pinned SHA.
    const subModule = vi.fn()
      .mockResolvedValueOnce('-abc1234 skills/distributed\n')
      .mockResolvedValueOnce(' abc1234 skills/distributed\n');
    const submoduleUpdate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createGit).mockReturnValue({
      subModule,
      submoduleUpdate,
    } as unknown as ReturnType<typeof createGit>);
    // Parent SHA is unchanged — the pre-fix fast path would skip here.
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPullTargets: ['claude'],
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    expect(log.success).not.toHaveBeenCalledWith(
      expect.stringContaining('Already synced'),
    );
    expect(saveStateForScope).toHaveBeenCalled();
  });

  it('still skips sync when the submodule update changed nothing', async () => {
    vi.mocked(loadTeamConfig).mockResolvedValue({ ...baseTeamConfig, submodules: true });
    // Already initialized and current both before and after the update: the
    // common steady-state case must keep taking the fast path, or every pull in
    // a submodule-using team pays a full re-deploy.
    const subModule = vi.fn()
      .mockResolvedValueOnce(' abc1234 skills/distributed\n')
      .mockResolvedValueOnce(' abc1234 skills/distributed\n');
    vi.mocked(createGit).mockReturnValue({
      subModule,
      submoduleUpdate: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof createGit>);
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPullTargets: ['claude'],
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    expect(log.success).toHaveBeenCalledWith(
      expect.stringContaining('Already synced at abc1234, skipping'),
    );
  });
});

// Regression: a CLI upgrade that ships a new recall block must reach CLAUDE.md
// even when the repo HEAD is unchanged (the "Already synced" fast-path). Before
// the fix, the fast-path refreshed rules/agents but skipped the CLAUDE.md recall
// block, so the block stayed frozen at the old wording (e.g. MUST vs SHOULD)
// until the user ran `teamai pull --force`.
describe('pull skip-sync refreshes CLAUDE.md recall block (CLI upgrade)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let claudeMdPath: string;

  // A stale recall block, as an older CLI version would have written it.
  const STALE_RECALL_BLOCK = [
    TEAMAI_RECALL_RULES_START,
    '<!-- DO NOT EDIT: This section is auto-managed by teamai -->',
    '',
    '## Team Knowledge Recall (teamai)',
    '',
    '**Before** starting any task, you **MUST** first invoke the `teamai-recall` subagent.',
    TEAMAI_RECALL_RULES_END,
  ].join('\n');

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-refresh-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    claudeMdPath = path.join(homeDir, '.claude', 'CLAUDE.md');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'common'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'common'));
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');
    // Tier-1 tool must have its agents dir present for injection to fire.
    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    // Seed a CLAUDE.md holding the stale (pre-upgrade) recall block.
    await fse.writeFile(claudeMdPath, `# CLAUDE.md\n\n${STALE_RECALL_BLOCK}\n`);

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
        // Tier-1: both agents + claudemd configured → recall block injected.
        claude: { skills: '.claude/skills', rules: '.claude/rules', agents: '.claude/agents', claudemd: '.claude/CLAUDE.md' },
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
      recallEnabled: true,
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234', // matches HEAD → triggers "Already synced" fast-path
      lastPullTargets: ['claude'],
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  it('replaces the stale recall block with the current one on the fast-path', async () => {
    await pull({});

    // Confirm we actually took the fast-path (repo HEAD unchanged).
    expect(log.success).toHaveBeenCalledWith(
      expect.stringContaining('Already synced at abc1234, skipping'),
    );

    const updated = await fse.readFile(claudeMdPath, 'utf8');
    // Stale block gone, current block present — verbatim from the CLI source.
    expect(updated).not.toContain('you **MUST** first invoke the `teamai-recall` subagent');
    expect(updated).toContain(compileRecallRulesBlock());
    // Exactly one managed block (replace, not append).
    expect(updated.split(TEAMAI_RECALL_RULES_START).length - 1).toBe(1);
    expect(updated.split(TEAMAI_RECALL_RULES_END).length - 1).toBe(1);
  });

  it('does not touch CLAUDE.md when recall is disabled for the scope', async () => {
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
      recallEnabled: false,
    } as LocalConfig);

    await pull({});

    const after = await fse.readFile(claudeMdPath, 'utf8');
    // Untouched: the stale block remains exactly as seeded.
    expect(after).toContain('you **MUST** first invoke the `teamai-recall` subagent');
  });

  it('refreshes Copilot recall instructions under a custom COPILOT_HOME', async () => {
    const copilotHome = path.join(tmpDir, 'copilot-home');
    const copilotInstructions = path.join(copilotHome, 'copilot-instructions.md');
    await fse.ensureDir(path.join(copilotHome, 'agents'));
    await fse.writeFile(copilotInstructions, '# Personal instructions\n');
    vi.stubEnv('COPILOT_HOME', copilotHome);

    const teamConfig = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://github.com/example/team.git',
      sharing: { recall: { enabled: true } },
    });
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://github.com/example/team.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
      recallEnabled: true,
      enabledAgents: ['copilot'],
    };
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(loadStateForScope).mockResolvedValue(emptyState({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPullTargets: ['copilot'],
    }));

    await pull({});

    const updated = await fse.readFile(copilotInstructions, 'utf8');
    expect(updated).toContain('# Personal instructions');
    expect(updated).toContain(compileRecallRulesBlock());
  });
});

function emptyState(overrides: Partial<State> = {}): State {
  return {
    lastPull: null,
    lastPullRev: null,
    lastPush: null,
    pushedRules: [],
    pushedSkills: [],
    pushedEnvVars: [],
    pendingPushes: [],
    lastUpdateCheck: null,
    availableUpdate: null,
    ...overrides,
  };
}

describe('enabledAgents whitelist on pull inject, skip-sync, and cleanup (#510)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  const skillBody = '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n';

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-whitelist-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'common', 'team-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'common', 'team-skill', 'SKILL.md'), skillBody);
    await fse.ensureDir(path.join(repoPath, 'learnings', 'common'));
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');
    await fse.writeFile(
      path.join(repoPath, 'culture.md'),
      '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n',
    );
    await fse.ensureDir(path.join(repoPath, 'claudemd', 'common'));
    await fse.writeFile(path.join(repoPath, 'claudemd', 'common', 'note.md'), 'Shared team instructions.\n');
    await fse.writeFile(path.join(repoPath, 'claudemd', 'shared.md'), 'Root-level shared instructions.\n');

    vi.stubEnv('HOME', homeDir);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  it('does not inject culture, shared instructions, or recall into an out-of-whitelist tool', async () => {
    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.codebuddy', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.codebuddy', 'rules'));
    await fse.writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), '# Claude\n');
    await fse.writeFile(path.join(homeDir, '.codebuddy', 'CODEBUDDY.md'), '# User notes\n');

    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
        recall: { enabled: true },
      },
      toolPaths: {
        claude: {
          skills: '.claude/skills',
          rules: '.claude/rules',
          agents: '.claude/agents',
          claudemd: '.claude/CLAUDE.md',
        },
        codebuddy: {
          skills: '.codebuddy/skills',
          rules: '.codebuddy/rules',
          agents: '.codebuddy/agents',
          claudemd: '.codebuddy/CODEBUDDY.md',
        },
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
      recallEnabled: true,
      enabledAgents: ['claude'],
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(loadStateForScope).mockResolvedValue(emptyState());

    await pull({});

    const claudeMd = await fse.readFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(TEAMAI_CULTURE_START);
    expect(claudeMd).toContain(TEAMAI_CLAUDEMD_START);
    expect(claudeMd).toContain('Root-level shared instructions.');
    expect(claudeMd).toContain(TEAMAI_RECALL_RULES_START);

    const codebuddyMd = await fse.readFile(path.join(homeDir, '.codebuddy', 'CODEBUDDY.md'), 'utf8');
    expect(codebuddyMd).toBe('# User notes\n');
    expect(codebuddyMd).not.toContain(TEAMAI_CULTURE_START);
    expect(codebuddyMd).not.toContain(TEAMAI_CLAUDEMD_START);
    expect(codebuddyMd).not.toContain(TEAMAI_RECALL_RULES_START);
  });

  it.each(['user', 'project'] as const)(
    'delivers idempotent Copilot instructions in %s scope without replacing user content or settings',
    async (scope) => {
      const copilotHome = path.join(tmpDir, 'copilot-home');
      const projectRoot = path.join(tmpDir, 'project');
      const instructionPath = scope === 'user'
        ? path.join(copilotHome, 'copilot-instructions.md')
        : path.join(projectRoot, '.github', 'copilot-instructions.md');
      const settingsPath = path.join(copilotHome, 'settings.json');
      const docsPath = scope === 'user'
        ? path.join(homeDir, '.teamai', 'docs', 'copilot-context.md')
        : path.join(projectRoot, '.teamai', 'docs', 'copilot-context.md');
      const envPath = scope === 'user'
        ? path.join(homeDir, '.teamai', 'env.sh')
        : path.join(projectRoot, '.teamai', 'env.sh');
      const userInstructions = '# Personal Copilot instructions\n\nKeep this text.\n';
      const userSettings = '{"theme":"dark"}\n';
      const sharedDoc = '# Copilot team context\n';
      const sharedEnvValue = 'copilot-scope-ready';

      vi.stubEnv('COPILOT_HOME', copilotHome);
      await fse.ensureDir(copilotHome);
      await fse.ensureDir(path.join(projectRoot, '.github'));
      await fse.ensureDir(path.join(repoPath, 'docs'));
      await fse.ensureDir(path.join(repoPath, 'env'));
      await fse.writeFile(instructionPath, userInstructions);
      await fse.writeFile(settingsPath, userSettings);
      await fse.writeFile(path.join(repoPath, 'docs', 'copilot-context.md'), sharedDoc);
      await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), [
        'variables:',
        '  - key: TEAMAI_COPILOT_SCOPE',
        `    value: ${sharedEnvValue}`,
        '',
      ].join('\n'));

      const teamConfig = TeamaiConfigSchema.parse({
        team: 'test',
        repo: 'https://github.com/example/team.git',
      });
      const localConfig: LocalConfig = {
        repo: { localPath: repoPath, remote: 'https://github.com/example/team.git' },
        username: 'testuser',
        updatePolicy: 'auto',
        primaryRole: 'hai',
        additionalRoles: [],
        resourceProfileVersion: 1,
        scope,
        projectRoot: scope === 'project' ? projectRoot : undefined,
        enabledAgents: ['copilot'],
      };

      vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
      vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
      vi.mocked(loadStateForScope).mockResolvedValue(emptyState());

      await pull({ force: true, silent: true });
      const first = await fse.readFile(instructionPath, 'utf8');
      await pull({ force: true, silent: true });
      const second = await fse.readFile(instructionPath, 'utf8');

      expect(first).toContain(userInstructions.trim());
      expect(first).toContain(TEAMAI_CULTURE_START);
      expect(first).toContain(TEAMAI_CLAUDEMD_START);
      expect(second).toBe(first);
      expect(second.split(TEAMAI_CULTURE_START)).toHaveLength(2);
      expect(second.split(TEAMAI_CLAUDEMD_START)).toHaveLength(2);
      expect(await fse.readFile(settingsPath, 'utf8')).toBe(userSettings);
      expect(await fse.readFile(docsPath, 'utf8')).toBe(sharedDoc);
      expect(await fse.readFile(envPath, 'utf8')).toContain(`export TEAMAI_COPILOT_SCOPE='${sharedEnvValue}'`);

      await fse.remove(path.join(repoPath, 'culture.md'));
      await fse.ensureDir(path.join(repoPath, 'culture.md'));
      await pull({ force: true, silent: true });

      const afterCultureReadFailure = await fse.readFile(instructionPath, 'utf8');
      expect(afterCultureReadFailure).toContain(TEAMAI_CULTURE_START);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to read team culture'));

      await fse.remove(path.join(repoPath, 'culture.md'));
      await fse.writeFile(path.join(repoPath, 'culture.md'), '\n');
      await pull({ force: true, silent: true });

      const afterInvalidCulture = await fse.readFile(instructionPath, 'utf8');
      expect(afterInvalidCulture).toContain(TEAMAI_CULTURE_START);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('empty or invalid'));

      await fse.remove(path.join(repoPath, 'culture.md'));
      await fse.remove(path.join(repoPath, 'claudemd'));
      await pull({ force: true, silent: true });

      const revoked = await fse.readFile(instructionPath, 'utf8');
      expect(revoked).toContain(userInstructions.trim());
      expect(revoked).not.toContain(TEAMAI_CULTURE_START);
      expect(revoked).not.toContain(TEAMAI_CLAUDEMD_START);
      expect(await fse.readFile(settingsPath, 'utf8')).toBe(userSettings);
    },
  );

  it('delivers new Copilot instructions after a CLI upgrade when the repo revision is unchanged', async () => {
    const copilotHome = path.join(tmpDir, 'copilot-home');
    const instructionPath = path.join(copilotHome, 'copilot-instructions.md');
    const userInstructions = '# Personal Copilot instructions\n\nKeep this text.\n';
    vi.stubEnv('COPILOT_HOME', copilotHome);
    await fse.ensureDir(copilotHome);
    await fse.writeFile(instructionPath, userInstructions);

    const teamConfig = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://github.com/example/team.git',
    });
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://github.com/example/team.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
      enabledAgents: ['copilot'],
    };
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(loadStateForScope).mockResolvedValue(emptyState({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPullTargets: ['copilot'],
    }));

    await pull({ silent: true });

    expect(log.success).toHaveBeenCalledWith(
      expect.stringContaining('Already synced at abc1234, skipping'),
    );
    const updated = await fse.readFile(instructionPath, 'utf8');
    expect(updated).toContain(userInstructions.trim());
    expect(updated).toContain(TEAMAI_CULTURE_START);
    expect(updated).toContain(TEAMAI_CLAUDEMD_START);
  });

  it('warns without replacing an unwritable Copilot instruction target', async () => {
    const copilotHome = path.join(tmpDir, 'copilot-home');
    const instructionPath = path.join(copilotHome, 'copilot-instructions.md');
    vi.stubEnv('COPILOT_HOME', copilotHome);
    await fse.ensureDir(instructionPath);

    const teamConfig = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://github.com/example/team.git',
    });
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://github.com/example/team.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
      enabledAgents: ['copilot'],
    };
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(loadStateForScope).mockResolvedValue(emptyState({
      lastPullRev: 'abc1234',
      lastPullTargets: ['copilot'],
    }));

    await pull({ silent: true });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to inject culture into copilot'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to inject shared instructions into copilot'));
    expect((await fse.stat(instructionPath)).isDirectory()).toBe(true);
  });

  it('keeps the pull fast path available when shared-instruction discovery fails', async () => {
    await fse.remove(path.join(repoPath, 'claudemd'));
    await fse.writeFile(path.join(repoPath, 'claudemd'), 'not a directory\n');
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://github.com/example/team.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
      enabledAgents: ['copilot'],
    };
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://github.com/example/team.git',
    }));
    vi.mocked(loadStateForScope).mockResolvedValue(emptyState({
      lastPullRev: 'abc1234',
      lastPullTargets: ['copilot'],
    }));

    await pull({ silent: true });

    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('Shared instructions sync skipped: ENOTDIR'));
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Already synced at abc1234, skipping'));
  });

  it('records only whitelist-eligible tools in lastPullTargets', async () => {
    await fse.ensureDir(path.join(homeDir, '.workbuddy'));
    await fse.ensureDir(path.join(homeDir, '.claude'));

    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        workbuddy: { skills: '.workbuddy/skills' },
        claude: { skills: '.claude/skills' },
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
      enabledAgents: ['workbuddy'],
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(loadStateForScope).mockResolvedValue(emptyState());

    await pull({});

    expect(vi.mocked(saveStateForScope).mock.calls[0][0].lastPullTargets).toEqual(['workbuddy']);
    expect(await fse.pathExists(path.join(homeDir, '.workbuddy/skills/team-skill/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/team-skill'))).toBe(false);
  });

  it('does not skip when a previously installed tool is added to the whitelist', async () => {
    await fse.ensureDir(path.join(homeDir, '.workbuddy'));
    await fse.ensureDir(path.join(homeDir, '.claude'));

    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        workbuddy: { skills: '.workbuddy/skills' },
        claude: { skills: '.claude/skills' },
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
      enabledAgents: ['workbuddy'],
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(loadStateForScope).mockResolvedValue(emptyState());

    await pull({});
    expect(vi.mocked(saveStateForScope).mock.calls[0][0].lastPullTargets).toEqual(['workbuddy']);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/team-skill'))).toBe(false);

    vi.mocked(log.success).mockClear();
    vi.mocked(saveStateForScope).mockClear();
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      ...localConfig,
      enabledAgents: ['workbuddy', 'claude'],
    });
    vi.mocked(loadStateForScope).mockResolvedValue(emptyState({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPullTargets: ['workbuddy'],
    }));

    await pull({});

    expect(log.success).not.toHaveBeenCalledWith(
      expect.stringContaining('Already synced'),
    );
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/team-skill/SKILL.md'))).toBe(true);
  });

  it('skip-sync still deploys builtins only to the whitelist', async () => {
    await fse.ensureDir(path.join(homeDir, '.workbuddy'));
    await fse.ensureDir(path.join(homeDir, '.hermes'));

    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        workbuddy: { skills: '.workbuddy/skills' },
        hermes: { skills: '.hermes/skills' },
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
      enabledAgents: ['workbuddy'],
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(loadStateForScope).mockResolvedValue(emptyState({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPullTargets: ['workbuddy'],
    }));

    await pull({});

    expect(log.success).toHaveBeenCalledWith(
      expect.stringContaining('Already synced at abc1234, skipping'),
    );
    expect(await fse.pathExists(path.join(homeDir, '.workbuddy/skills/team-wiki-codebase/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.hermes/skills/team-wiki-codebase'))).toBe(false);
  });

  it('does not delete leftover copies on out-of-whitelist tools', async () => {
    const leftover = path.join(homeDir, '.hermes', 'skills', 'stale-skill');
    const workbuddyCopy = path.join(homeDir, '.workbuddy', 'skills', 'stale-skill');
    const source = path.join(repoPath, 'skills', 'common', 'stale-skill');
    await fse.ensureDir(leftover);
    await fse.ensureDir(workbuddyCopy);
    await fse.ensureDir(source);
    await fse.writeFile(path.join(source, 'SKILL.md'), '---\nname: stale-skill\ndescription: stale\n---\n# Stale\n');
    await fse.copy(source, leftover, { overwrite: true });
    await fse.copy(source, workbuddyCopy, { overwrite: true });

    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        workbuddy: { skills: '.workbuddy/skills' },
        hermes: { skills: '.hermes/skills' },
      },
    };
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
      enabledAgents: ['workbuddy'],
    };

    await cleanupInactiveNamespaceSkills(
      teamConfig,
      localConfig,
      new Set(),
      new Set(['stale-skill']),
      new Map([['stale-skill', source]]),
    );

    expect(await fse.pathExists(leftover)).toBe(true);
    expect(await fse.pathExists(workbuddyCopy)).toBe(false);
  });
});
