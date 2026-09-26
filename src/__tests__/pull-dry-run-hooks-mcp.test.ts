/**
 * `pull --dry-run` used to return before the hooks and MCP reconcile stages
 * (`if (options.dryRun) return`), so the warnings those stages raise — an
 * unknown entry id, a per-entry `roles:` key, a hooks.yaml that does not
 * parse — never reached the maintainer who ran the dry run to see exactly
 * them (#822, item 3). A dry run must resolve and warn, then skip the write.
 *
 * MCP already had the capability: `McpReconcileOptions.dryRun` gates every
 * write in mcp-reconcile.ts and `teamai mcp inject --dry-run` uses it, so
 * `reconcileMcpAllScopes` only had to forward it. Hooks had no dry-run path at
 * all, so `reconcileTeamHooksForConfig` gained one.
 *
 * The tests drive `pull()` rather than the reconcile functions, the same way
 * pull-env-shape-warning.test.ts does: the defect was in the orchestration
 * layer, so that is where it has to be pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfigForScope: vi.fn(),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  loadTeamConfig: vi.fn(),
  requireInit: vi.fn(),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(), persist: vi.fn(),
  },
  spinner: vi.fn(() => ({
    fail: vi.fn().mockReturnThis(), info: vi.fn().mockReturnThis(),
    start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [{
      id: 'dev',
      name: 'Dev',
      description: '',
      resources: { knowledge: ['common'], skills: ['common'], learnings: ['common'], agents: [] },
    }],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(() => ({
    knowledge: ['common'], skills: ['common'], learnings: ['common'], agents: [],
  })),
  // The entry resolver asks which roles this member holds, to apply the 0.25.0
  // per-entry `roles:` rule. Without it the mock is incomplete and the
  // resolution throws, which pull swallows into a debug line.
  activeRoleIds: vi.fn(() => ['dev']),
}));

// Isolation: pull() takes a real ~/.teamai/.sync-lock. Parallel vitest workers
// sharing that path race and skip/error, so these tests mock the lock.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

// The end-of-pull checks are exercised in pull-post-checks.test.ts; keep them
// out of the way here so a warning under test is the only thing on the wire.
vi.mock('../doctor.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../doctor.js')>(),
  resolveDoctorContext: vi.fn(),
  buildChecks: vi.fn(),
}));

// Mocked so the dry-run forwarding can be asserted on the arguments. The real
// implementation is covered by mcp-reconcile.test.ts; this file is about the
// wiring in pull. The spread keeps every other export real, so a symbol this
// file does not know about still resolves.
vi.mock('../mcp-reconcile.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../mcp-reconcile.js')>(),
  reconcileMcpForConfig: vi.fn().mockResolvedValue({ changes: [], wrote: false }),
}));

import { detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { acquireLock } from '../update.js';
import { buildChecks, resolveDoctorContext, type DoctorContext } from '../doctor.js';
import { log } from '../utils/logger.js';
import { pull } from '../pull.js';
import { reconcileMcpForConfig } from '../mcp-reconcile.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

const DEPRECATED_ROLES_WARNING = 'per-entry `roles:`';

describe('pull --dry-run reports hooks and MCP entry warnings', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-dry-hooksmcp-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);

    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');

    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      primaryRole: 'dev',
      additionalRoles: [],
    };
    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true },
      },
      toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules', settings: '.claude/settings.json' } },
    };

    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(loadStateForScope).mockResolvedValue({ lastPull: null, lastPullRev: null } as never);

    const ctx: DoctorContext = {
      localConfig,
      teamConfig,
      toolPaths: teamConfig.toolPaths,
      hookToolPaths: teamConfig.toolPaths,
      baseDir: homeDir,
    };
    vi.mocked(resolveDoctorContext).mockResolvedValue(ctx);
    vi.mocked(buildChecks).mockResolvedValue([]);
    // clearAllMocks resets calls, not implementations, so a test that makes the
    // lock contended would otherwise leak into the next one.
    vi.mocked(acquireLock).mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  /** A team hook scoped with the deprecated per-entry `roles:` key. */
  async function writeHooksWithDeprecatedRoles(): Promise<void> {
    await fse.ensureDir(path.join(repoPath, 'hooks'));
    await fse.writeFile(
      path.join(repoPath, 'hooks', 'hooks.yaml'),
      [
        'hooks:',
        '  - id: lint',
        '    description: Lint',
        '    event: PostToolUse',
        '    command: teamai hook-dispatch post-tool-use',
        '    roles: [dev]',
        '',
      ].join('\n'),
    );
  }

  it('warns about the deprecated per-entry `roles:` key on a dry run', async () => {
    await writeHooksWithDeprecatedRoles();

    await pull({ dryRun: true, force: true });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(DEPRECATED_ROLES_WARNING));
    // The debug trail follows the same preview rule: a dry run must not log a
    // reconcile that did not happen.
    const debugLines = vi.mocked(log.debug).mock.calls.map(([m]) => String(m));
    expect(debugLines.some((l) => l.includes('Would apply 1 team hook(s)'))).toBe(true);
    expect(debugLines.some((l) => l.includes('Reconciled'))).toBe(false);
  });

  it('writes no hook settings or manifest on a dry run', async () => {
    await writeHooksWithDeprecatedRoles();

    await pull({ dryRun: true, force: true });

    // The reconcile stage is the only thing that writes these; a dry run must
    // leave them absent even though it resolved and warned.
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'settings.json'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.teamai', 'managed-hooks.json'))).toBe(false);
    expect(saveStateForScope).not.toHaveBeenCalled();
  });

  it('still warns on a real pull, so the dry run reports what would happen', async () => {
    await writeHooksWithDeprecatedRoles();

    await pull({ force: true });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(DEPRECATED_ROLES_WARNING));
    const debugLines = vi.mocked(log.debug).mock.calls.map(([m]) => String(m));
    expect(debugLines.some((l) => l.includes('Reconciled 1 team hook(s)'))).toBe(true);
  });

  it('forwards dryRun to the MCP reconcile so its writes are skipped too', async () => {
    // The MCP entry resolution runs inside reconcileMcpForConfig, which already
    // gates its writes on dryRun; the bug was that pull never passed it.
    await pull({ dryRun: true, force: true });

    expect(reconcileMcpForConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ dryRun: true }),
    );
  });

  it('reports MCP changes on a dry run without claiming they were applied', async () => {
    // A dry run still returns the changes it *would* make — `wrote: false` is the
    // only difference — so pull's summary line must not read as a completed
    // apply. Reporting "Restart your AI tool session to load them" after a run
    // that wrote nothing is the same class of defect as "Applying" was on the
    // hooks side before the preview flag.
    vi.mocked(reconcileMcpForConfig).mockResolvedValueOnce({
      changes: [{ tool: 'claude', server: 'team-server', action: 'added' }],
      wrote: false,
    });

    await pull({ dryRun: true, force: true });

    const lines = vi.mocked(log.info).mock.calls.map(([m]) => String(m));
    expect(lines.some((l) => l.includes('[dry-run]') && l.includes('Would make'))).toBe(true);
    expect(lines.some((l) => l.includes('Restart your AI tool session'))).toBe(false);
  });

  it('keeps the applied wording on a real pull', async () => {
    vi.mocked(reconcileMcpForConfig).mockResolvedValueOnce({
      changes: [{ tool: 'claude', server: 'team-server', action: 'added' }],
      wrote: true,
    });

    await pull({ force: true });

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Restart your AI tool session to load them'));
  });
});
