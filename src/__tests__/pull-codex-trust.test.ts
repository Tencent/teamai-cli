/**
 * The Codex trust step of a pull runs once per scope after BOTH the hooks and
 * the MCP reconcile (#955): a project whose only Codex content is the project
 * MCP servers that pull just wrote (#954) must end that same pull with the
 * main checkout trusted, or Codex never reads its `.codex/config.toml`.
 *
 * Same harness as pull-dry-run-hooks-mcp.test.ts: the order is a property of
 * the orchestration in pull, so that is where it is pinned.
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

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/git.js')>(),
  resolveAnchors: vi.fn().mockResolvedValue(null),
  listWorktrees: vi.fn().mockResolvedValue([]),
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

import { detectProjectConfig, loadLocalConfigForScope, loadTeamConfig } from '../config.js';
import { resolveAnchors, listWorktrees } from '../utils/git.js';
import { pull } from '../pull.js';
import { reconcileMcpForConfig } from '../mcp-reconcile.js';
import { getDataHome, managedMcpManifestKey, managedMcpManifestPath } from '../types.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { readCodexHookTrustForScope } from '../hooks.js';
import { log } from '../utils/logger.js';
import { installFakeCodex, readFakeCodexState, writeFakeCodexOptions } from './helpers/fake-codex.js';

describe('pull trusts the Codex project after writing its MCP servers', () => {
  let tempDir: string;
  let homeDir: string;
  let project: string;
  let fakeBin: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  beforeEach(async () => {
    vi.mocked(resolveAnchors).mockReset().mockResolvedValue(null);
    vi.mocked(listWorktrees).mockReset().mockResolvedValue([]);
    tempDir = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-codex-trust-')));
    homeDir = path.join(tempDir, 'home');
    project = path.join(tempDir, 'project');
    const repoPath = path.join(tempDir, 'team-repo');
    fakeBin = installFakeCodex();
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('PATH', `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`);
    await fse.ensureDir(path.join(homeDir, '.codex'));
    await fse.ensureDir(project);
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'project',
      projectRoot: project,
      primaryRole: 'dev',
      additionalRoles: [],
    } as unknown as LocalConfig;
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'github',
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { codex: { skills: '.codex/skills', settings: '.codex/hooks.json', mcp: '.codex/config.toml' } },
    } as unknown as TeamaiConfig;
    vi.mocked(detectProjectConfig).mockResolvedValue(localConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    // What #954's reconcile records for the Codex project MCP servers it writes.
    vi.mocked(reconcileMcpForConfig).mockImplementation(async (_team, config) => {
      await fse.outputJson(managedMcpManifestPath(getDataHome(config), config.projectRoot), {
        [managedMcpManifestKey('codex', true)]: [{ name: 'demo', hash: 'x' }],
      });
      return { changes: [], wrote: true } as never;
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
    await fse.remove(fakeBin);
  });

  it('a pull that writes Codex project MCP and no team hooks ends with the project trusted', async () => {
    await pull({ force: true });

    expect(reconcileMcpForConfig).toHaveBeenCalled();
    expect(readFakeCodexState(path.join(homeDir, '.codex')).projects[project]).toEqual({ trust_level: 'trusted' });
  });

  it('trusts the built-in hooks when Codex lists them by their Windows command', async () => {
    writeFakeCodexOptions(path.join(homeDir, '.codex'), { windowsCommands: true });

    await pull({ force: true });

    // Without team hooks the built-ins live in the user layer; Codex on Windows lists each by
    // its commandWindows, and the trust step has to recognise them under that name.
    const hooksFile = path.join(homeDir, '.codex', 'hooks.json');
    const state = readFakeCodexState(path.join(homeDir, '.codex'));
    expect(Object.keys(state.hooksState).some((key) => key.startsWith(`${hooksFile}:session_start`))).toBe(true);
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => message).filter((message) => message.includes('Could not trust'))).toEqual([]);
  });
  it('pull from a worktree without .codex trusts the main keys before SessionStart', async () => {
    const worktree = path.join(tempDir, 'worktree');
    await fse.ensureDir(worktree);
    vi.mocked(resolveAnchors).mockImplementation(async (cwd) => ({ workspaceRoot: cwd ?? project, projectAnchor: project, mainCheckout: project }));
    vi.mocked(listWorktrees).mockResolvedValue([project, worktree]);
    localConfig.projectRoot = worktree;
    writeFakeCodexOptions(path.join(homeDir, '.codex'), { projectLayers: { [worktree]: project } });
    vi.mocked(reconcileMcpForConfig).mockResolvedValue({ changes: [], wrote: false } as never);
    await fse.outputFile(path.join(localConfig.repo.localPath, 'hooks', 'hooks.yaml'),
      'hooks:\n  - id: added\n    description: new hook\n    event: PreToolUse\n    command: echo new-team-hook\n');

    await pull({ force: true });

    expect(await fse.pathExists(path.join(worktree, '.codex'))).toBe(false);
    const state = readFakeCodexState(path.join(homeDir, '.codex'));
    expect(Object.keys(state.hooksState).some((key) => key.startsWith(path.join(project, '.codex', 'hooks.json')))).toBe(true);
    expect(state.calls.filter((c) => c.method === 'hooks/list').map((c) => c.params)).toEqual([{ cwds: [project] }]);
    expect(await readCodexHookTrustForScope(teamConfig, localConfig)).toEqual({
      kind: 'listed', notTrusted: [{ file: path.join(project, '.codex', 'hooks.json'), command: 'echo new-team-hook', status: 'not loaded' }],
    });
    await fse.ensureDir(path.join(worktree, '.codex'));
    expect(await readCodexHookTrustForScope(teamConfig, localConfig)).toEqual({ kind: 'listed', notTrusted: [] });
  });

  it('does not ask Codex on a dry run', async () => {
    await pull({ force: true, dryRun: true });
    expect(readFakeCodexState(path.join(homeDir, '.codex')).calls).toEqual([]);
  });

  it.each([false, true])('reports app-server failure only when silent=%s is false', async (silent) => {
    writeFakeCodexOptions(path.join(homeDir, '.codex'), { failMethod: 'hooks/list' });
    await pull({ force: true, silent });
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => message).filter((message) => message.includes('Could not trust'));
    expect(warnings).toHaveLength(silent ? 0 : 1);
    if (!silent) expect(warnings[0]).toContain('hooks/list: fake failure');
  });

  it('keeps an interactive pull quiet when Codex is absent', async () => {
    const empty = path.join(tempDir, 'empty-bin');
    await fse.ensureDir(empty);
    vi.stubEnv('PATH', empty);
    await pull({ force: true });
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => message).filter((message) => /trust.*Codex|Codex.*trust/i.test(message))).toEqual([]);
  });

});
