import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { loadLocalConfig, refreshRoleAssignment, saveLocalConfig } from '../config.js';
import { activeRoleIds } from '../roles.js';
import { loadRoleAssignments, loadRoleAssignmentsIfPresent, resolveAssignedRoles } from '../role-assignments.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import { log } from '../utils/logger.js';
import type { LocalConfig } from '../types.js';
import { resetWarnOnce } from '../utils/warn-once.js';

/**
 * `manifest/members.yaml` assigns roles as team data (#1186): the member's own
 * config stops deciding them, and holding none is one of the answers.
 */
describe('role assignments from manifest/members.yaml', () => {
  const originalHome = process.env.HOME;
  let home: string;
  let repoDir: string;

  beforeEach(() => {
    resetWarnOnce();
    home = mkdtempSync(path.join(os.tmpdir(), 'teamai-assigned-roles-'));
    process.env.HOME = home;
    repoDir = path.join(home, 'team-repo');
    mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
    mkdirSync(path.join(home, '.teamai'), { recursive: true });
    writeRoles('version: 1\nroles:\n  - id: frontend\n    resources: { knowledge: [], skills: [frontend] }\n  - id: backend\n    resources: { knowledge: [], skills: [backend] }\n  - id: ki\n    resources: { knowledge: [], skills: [ki] }\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeRoles(content: string): void {
    writeFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), content, 'utf-8');
  }

  function writeAssignments(content: string): void {
    writeFileSync(path.join(repoDir, 'manifest', 'members.yaml'), content, 'utf-8');
  }

  function writeConfig(extra = ''): string {
    const configPath = path.join(home, '.teamai', 'config.yaml');
    writeFileSync(
      configPath,
      `repo:\n  localPath: ${repoDir}\n  remote: https://gitlab.com/acme/team.git\nusername: alice\n${extra}`,
      'utf-8',
    );
    return configPath;
  }

  // ── the manifest itself ──

  it('reads the roles a member is assigned, primary first', async () => {
    writeAssignments('version: 1\nmembers:\n  alice: [frontend]\n  bob: [backend, ki]\ndefault: []\n');
    const manifest = await loadRoleAssignments(repoDir);
    expect(resolveAssignedRoles(manifest, 'bob')).toEqual({ roles: ['backend', 'ki'], source: 'assigned' });
  });

  it('gives a member the file does not list the declared default', async () => {
    writeAssignments('version: 1\nmembers:\n  alice: [frontend]\ndefault: [ki]\n');
    const manifest = await loadRoleAssignments(repoDir);
    expect(resolveAssignedRoles(manifest, 'carol')).toEqual({ roles: ['ki'], source: 'default' });
  });

  // An absent `default` must mean "no roles", never "every namespace": the
  // fail-closed half of the feature (#1096).
  it('gives an unlisted member no roles when the file declares no default', async () => {
    writeAssignments('version: 1\nmembers:\n  alice: [frontend]\n');
    const manifest = await loadRoleAssignments(repoDir);
    expect(resolveAssignedRoles(manifest, 'carol')).toEqual({ roles: [], source: 'default' });
  });

  it('is absent, not invalid, when the team assigns no roles', async () => {
    expect(await loadRoleAssignmentsIfPresent(repoDir)).toBeNull();
  });

  it('refuses two member keys that differ only by case', async () => {
    writeAssignments('version: 1\nmembers:\n  alice: [frontend]\n  Alice: [backend]\n');
    await expect(loadRoleAssignments(repoDir)).rejects.toThrow(/differ only by case/);
  });

  // ── the overlay on the member's config ──

  it('overlays the assigned roles on the config, primary first', async () => {
    writeAssignments('version: 1\nmembers:\n  alice: [backend, ki]\n');
    writeConfig();
    const config = await loadLocalConfig();
    expect(config?.primaryRole).toBe('backend');
    expect(config?.additionalRoles).toEqual(['ki']);
    expect(config?.roleAssignment?.source).toBe('assigned');
  });

  it('overrides the role the member set locally', async () => {
    writeAssignments('version: 1\nmembers:\n  alice: [frontend]\n');
    writeConfig('primaryRole: backend\nadditionalRoles: [ki]\n');
    const config = await loadLocalConfig();
    expect(activeRoleIds(config!)).toEqual(['frontend']);
  });

  // The overlay is this run's reading of the team repo. Persisting it would
  // leave a copy behind that outlives the assignment — the stale local role the
  // file exists to prevent.
  it('keeps the local selection in the config file when another command saves', async () => {
    writeAssignments('version: 1\nmembers:\n  alice: [frontend]\n');
    const configPath = writeConfig('primaryRole: backend\nadditionalRoles: [ki]\n');
    const config = await loadLocalConfig();

    await saveLocalConfig({ ...config!, subscribedTags: ['infra'] });

    const written = YAML.parse(readFileSync(configPath, 'utf-8'));
    expect(written.primaryRole).toBe('backend');
    expect(written.additionalRoles).toEqual(['ki']);
    expect(written.subscribedTags).toEqual(['infra']);
    expect(written.roleAssignment).toBeUndefined();
  });

  it('drops the local role from the file when the member has none assigned', async () => {
    writeAssignments('version: 1\nmembers: {}\n');
    const configPath = writeConfig();
    const config = await loadLocalConfig();

    await saveLocalConfig(config!);

    expect(YAML.parse(readFileSync(configPath, 'utf-8')).primaryRole).toBeUndefined();
  });

  // ── fail closed ──

  it('matches no role-scoped entry for a member with no assigned roles', async () => {
    writeAssignments('version: 1\nmembers:\n  bob: [backend]\ndefault: []\n');
    writeConfig();
    const config = await loadLocalConfig();
    // Role-less normally reads as "no role filter" (null). Assigned roles make
    // it "holds none", which matches nothing.
    expect(activeRoleIds(config!)).toEqual([]);
  });

  it('delivers shared resources only to a member with no assigned roles', async () => {
    writeAssignments('version: 1\nmembers:\n  bob: [backend]\ndefault: []\n');
    writeConfig();
    const config = await loadLocalConfig();

    const resolved = await resolveResourceNamespaces(config!);

    // Not null: null is the unfiltered sync this feature exists to close.
    expect(resolved).not.toBeNull();
    expect(resolved?.activeNamespaces.skills).toEqual([]);
  });

  it('holds no roles, loudly, when the assignments file cannot be parsed', async () => {
    writeAssignments('version: 1\nmembers: [alice]\n');
    writeConfig('primaryRole: backend\n');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const config = await loadLocalConfig();

    expect(config?.primaryRole).toBeUndefined();
    expect(activeRoleIds(config!)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('manifest/members.yaml could not be read'));
  });

  it('ignores an assigned role the roles manifest does not declare', async () => {
    writeAssignments('version: 1\nmembers:\n  alice: [frontend, design]\n');
    writeConfig();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const config = await loadLocalConfig();

    expect(config?.primaryRole).toBe('frontend');
    expect(config?.additionalRoles).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('which manifest/roles.yaml does not declare'));
  });

  it('holds no roles when there is no roles manifest to resolve them against', async () => {
    rmSync(path.join(repoDir, 'manifest', 'roles.yaml'));
    writeAssignments('version: 1\nmembers:\n  alice: [frontend]\n');
    writeConfig();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const config = await loadLocalConfig();

    expect(config?.primaryRole).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('manifest/roles.yaml could not be read'));
  });

  // ── refreshed after the team repo moves ──

  it('resolves the assignment again after the team repo changed', async () => {
    writeAssignments('version: 1\nmembers:\n  alice: [frontend]\n');
    writeConfig();
    const config = await loadLocalConfig();
    expect(config?.primaryRole).toBe('frontend');

    // What `pull` does: the config was loaded before the repo was refreshed.
    writeAssignments('version: 1\nmembers:\n  alice: [backend]\n');
    await refreshRoleAssignment(config!);

    expect(config!.primaryRole).toBe('backend');
  });

  // Pull keys `teamEnvs` and `instructions` on config identity, and reconciles
  // hooks, MCP and env on the object its caller holds: a refreshed copy would
  // reach none of them.
  it('refreshes the config in place, keeping its identity', async () => {
    writeAssignments('version: 1\nmembers:\n  alice: [frontend]\n');
    writeConfig();
    const config = (await loadLocalConfig())!;
    const byIdentity = new Map([[config, 'env']]);

    writeAssignments('version: 1\nmembers: {}\ndefault: []\n');
    await refreshRoleAssignment(config);

    expect(byIdentity.get(config)).toBe('env');
    expect(config.primaryRole).toBeUndefined();
    expect(config.roleAssignment?.source).toBe('default');
    // Fail closed through the same object the reconcilers hold.
    expect(activeRoleIds(config)).toEqual([]);
  });

  // What `init` does: it builds the config in memory and hands it to the hook,
  // MCP and env reconciliation before any load can overlay it.
  it('applies the assignment to a config built in memory, as init hands it on', async () => {
    writeAssignments('version: 1\nmembers:\n  alice: [frontend]\n');
    const built: LocalConfig = {
      repo: { localPath: repoDir, remote: 'https://gitlab.com/acme/team.git' },
      username: 'alice',
      additionalRoles: [],
      scope: 'user',
    };

    await refreshRoleAssignment(built);

    expect(activeRoleIds(built)).toEqual(['frontend']);
    expect(built.roleAssignment?.source).toBe('assigned');
  });

  it('hands the roles back to the member when the assignments file goes away', async () => {
    writeAssignments('version: 1\nmembers:\n  alice: [frontend]\n');
    writeConfig('primaryRole: backend\n');
    const config = await loadLocalConfig();
    expect(config?.primaryRole).toBe('frontend');

    rmSync(path.join(repoDir, 'manifest', 'members.yaml'));
    await refreshRoleAssignment(config!);

    expect(config!.primaryRole).toBe('backend');
    expect(config!.roleAssignment).toBeUndefined();
  });

  // A broken roles manifest at load leaves a role-less config unresolved. The
  // pull that fetches the fixed manifest and an assignment must apply it.
  it('drops an unresolved role once the refreshed assignment resolves it', async () => {
    writeRoles('version: 1\nroles: broken\n');
    writeConfig();
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const config = (await loadLocalConfig())!;
    expect(config.roleUnresolved).toBe(true);

    writeRoles('version: 1\nroles:\n  - id: frontend\n    resources: { knowledge: [], skills: [frontend] }\n');
    writeAssignments('version: 1\nmembers:\n  alice: [frontend]\n');
    await refreshRoleAssignment(config);

    expect(config.roleUnresolved).toBeUndefined();
    expect(activeRoleIds(config)).toEqual(['frontend']);
  });

  // The legacy migration writes a `hai` role into a role-less config. A member
  // the team assigned nothing must not acquire one that way.
  it('does not let the legacy role migration write a role the team did not assign', async () => {
    writeRoles('version: 1\nroles:\n  - id: hai\n    resources: { knowledge: [], skills: [hai] }\n');
    writeAssignments('version: 1\nmembers: {}\ndefault: []\n');
    const configPath = writeConfig();

    const config = await loadLocalConfig();

    expect(config?.primaryRole).toBeUndefined();
    expect(YAML.parse(readFileSync(configPath, 'utf-8')).primaryRole).toBeUndefined();
  });
});

/**
 * Only what the forge merged counts: the file is read from `origin/<default>`
 * as last fetched, not from the clone's working tree, so an agent cannot lift
 * the assignment by editing, deleting or committing to the clone's copy.
 */
describe('role assignments read from the fetched default branch (#1186)', () => {
  let sandbox: string;
  let upstream: string;
  let clone: string;

  const ROLES = 'version: 1\nroles:\n  - id: frontend\n    resources: { knowledge: [], skills: [frontend] }\n  - id: backend\n    resources: { knowledge: [], skills: [backend] }\n';
  const ALICE_FRONTEND = 'version: 1\nmembers:\n  alice: [frontend]\ndefault: []\n';
  const ALICE_BACKEND = 'version: 1\nmembers:\n  alice: [backend]\ndefault: []\n';

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'TeamAI Test', GIT_AUTHOR_EMAIL: 'test@teamai.test',
        GIT_COMMITTER_NAME: 'TeamAI Test', GIT_COMMITTER_EMAIL: 'test@teamai.test',
      },
    });
  }

  function membersFile(repo: string): string {
    return path.join(repo, 'manifest', 'members.yaml');
  }

  beforeEach(() => {
    resetWarnOnce();
    sandbox = mkdtempSync(path.join(os.tmpdir(), 'teamai-assigned-roles-ref-'));
    upstream = path.join(sandbox, 'upstream');
    clone = path.join(sandbox, 'clone');
    mkdirSync(path.join(upstream, 'manifest'), { recursive: true });
    writeFileSync(path.join(upstream, 'manifest', 'roles.yaml'), ROLES, 'utf-8');
    writeFileSync(membersFile(upstream), ALICE_FRONTEND, 'utf-8');
    git(upstream, 'init', '-q', '-b', 'main');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'fixture');
    git(sandbox, 'clone', '-q', upstream, clone);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function rolesOf(repo: string, username: string): Promise<string[]> {
    return resolveAssignedRoles(await loadRoleAssignments(repo), username).roles;
  }

  it('ignores an edit to the clone\'s working tree', async () => {
    writeFileSync(membersFile(clone), ALICE_BACKEND, 'utf-8');
    expect(await rolesOf(clone, 'alice')).toEqual(['frontend']);
  });

  it('ignores a deletion from the clone\'s working tree', async () => {
    rmSync(membersFile(clone));
    expect(await rolesOf(clone, 'alice')).toEqual(['frontend']);
  });

  it('ignores a commit the clone has not pushed', async () => {
    writeFileSync(membersFile(clone), ALICE_BACKEND, 'utf-8');
    git(clone, 'commit', '-qam', 'self-assign');
    expect(await rolesOf(clone, 'alice')).toEqual(['frontend']);
  });

  it('treats a file only the working tree has as absent', async () => {
    git(upstream, 'rm', '-q', 'manifest/members.yaml');
    git(upstream, 'commit', '-qm', 'no assignments');
    git(clone, 'pull', '-q');
    writeFileSync(membersFile(clone), ALICE_BACKEND, 'utf-8');
    expect(await loadRoleAssignmentsIfPresent(clone)).toBeNull();
  });

  it('reads what the last fetch brought, whatever the clone has checked out', async () => {
    writeFileSync(membersFile(upstream), ALICE_BACKEND, 'utf-8');
    git(upstream, 'commit', '-qam', 'reassign alice');
    git(clone, 'fetch', '-q');
    expect(await rolesOf(clone, 'alice')).toEqual(['backend']);
  });

  it('refuses an empty file on the default branch as invalid, not absent', async () => {
    writeFileSync(membersFile(upstream), '', 'utf-8');
    git(upstream, 'commit', '-qam', 'empty');
    git(clone, 'fetch', '-q');
    await expect(loadRoleAssignments(clone)).rejects.toThrow(/is empty/);
  });

  // An HTTP source is materialized files inside whatever directory holds the
  // config — a project checkout, say. Git would answer for that repository.
  it('reads the working tree of an HTTP source, whatever repository it sits in', async () => {
    const http = path.join(clone, 'http-team-repo');
    mkdirSync(path.join(http, 'manifest'), { recursive: true });
    writeFileSync(membersFile(http), ALICE_BACKEND, 'utf-8');
    expect(resolveAssignedRoles(await loadRoleAssignments(http, { kind: 'http' }), 'alice').roles).toEqual(['backend']);
    // The same directory probed as git-backed reads the enclosing clone's branch, where it is absent.
    expect(await loadRoleAssignmentsIfPresent(http)).toBeNull();
  });

  // A repo with no remote has nothing the forge merged to prefer.
  it('reads the working tree where no fetched default branch exists', async () => {
    const local = path.join(sandbox, 'local');
    mkdirSync(path.join(local, 'manifest'), { recursive: true });
    git(local, 'init', '-q', '-b', 'main');
    writeFileSync(membersFile(local), ALICE_BACKEND, 'utf-8');
    expect(await rolesOf(local, 'alice')).toEqual(['backend']);
  });
});
