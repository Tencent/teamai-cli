import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveMembership,
  matchesMembership,
  warnUnknownMembershipIds,
  __resetMembershipWarnings,
} from '../membership.js';
import { log } from '../utils/logger.js';

function repoWith(files: Record<string, string>): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-membership-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(repoDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
  return repoDir;
}

const ROLES_YAML = `version: 1
roles:
  - id: frontend
    resources:
      knowledge: []
      skills: []
  - id: devops
    resources:
      knowledge: []
      skills: []
`;

const PROJECTS_YAML = `version: 1
projects:
  - id: checkout
    resources: {}
  - id: billing
    resources: {}
`;

describe('resolveMembership', () => {
  it('reports both axes as null for a member with no role and no projects (nothing is filtered)', () => {
    expect(resolveMembership({ additionalRoles: [] })).toEqual({ roles: null, projects: null });
  });

  it('treats an empty projects list the same as an absent one', () => {
    expect(resolveMembership({ additionalRoles: [], projects: [] }).projects).toBeNull();
  });

  it('reports the primary role first, additional roles after, deduped', () => {
    expect(resolveMembership({ primaryRole: 'frontend', additionalRoles: ['devops', 'frontend'] }).roles)
      .toEqual(['frontend', 'devops']);
  });

  it('reports the directory projects, deduped', () => {
    expect(resolveMembership({ additionalRoles: [], projects: ['checkout', 'checkout', 'billing'] }).projects)
      .toEqual(['checkout', 'billing']);
  });

  it('resolves the two axes independently', () => {
    expect(resolveMembership({ primaryRole: 'frontend', additionalRoles: [], projects: ['checkout'] }))
      .toEqual({ roles: ['frontend'], projects: ['checkout'] });
  });
});

describe('matchesMembership', () => {
  const member = { roles: ['frontend'], projects: ['checkout'] };

  it('matches everyone when the entry scopes neither axis', () => {
    expect(matchesMembership({}, member)).toBe(true);
    expect(matchesMembership({}, { roles: null, projects: null })).toBe(true);
  });

  // ── roles axis (moved from matchesRoles) ──

  it('matches every member on an axis they have not configured', () => {
    expect(matchesMembership({ roles: ['devops'] }, { roles: null, projects: null })).toBe(true);
    expect(matchesMembership({ projects: ['billing'] }, { roles: null, projects: null })).toBe(true);
  });

  it('matches when any active role is listed', () => {
    expect(matchesMembership({ roles: ['devops', 'data'] }, { roles: ['frontend', 'data'], projects: null })).toBe(true);
    expect(matchesMembership({ roles: ['devops'] }, { roles: ['frontend'], projects: null })).toBe(false);
  });

  it('matches nobody for an empty roles list, like tools: []', () => {
    expect(matchesMembership({ roles: [] }, { roles: ['frontend'], projects: null })).toBe(false);
    expect(matchesMembership({ roles: [] }, { roles: null, projects: null })).toBe(true);
  });

  // ── projects axis (the same rule, independently) ──

  it('matches when any active project is listed', () => {
    expect(matchesMembership({ projects: ['billing', 'checkout'] }, member)).toBe(true);
    expect(matchesMembership({ projects: ['billing'] }, member)).toBe(false);
  });

  it('matches nobody for an empty projects list', () => {
    expect(matchesMembership({ projects: [] }, member)).toBe(false);
    expect(matchesMembership({ projects: [] }, { roles: null, projects: null })).toBe(true);
  });

  // ── the two axes compose as AND ──

  it('requires both axes to match when the entry scopes both', () => {
    expect(matchesMembership({ roles: ['frontend'], projects: ['checkout'] }, member)).toBe(true);
    expect(matchesMembership({ roles: ['frontend'], projects: ['billing'] }, member)).toBe(false);
    expect(matchesMembership({ roles: ['devops'], projects: ['checkout'] }, member)).toBe(false);
    expect(matchesMembership({ roles: ['devops'], projects: ['billing'] }, member)).toBe(false);
  });

  it('intersects a member bound to SEVERAL projects, rather than comparing one active project', () => {
    // The line the issue calls out: `projects:` matches on an intersection, the
    // same way `roles:` does, and not on equality with a single active project.
    const onBoth = { roles: null, projects: ['checkout', 'billing'] };
    expect(matchesMembership({ projects: ['checkout'] }, onBoth)).toBe(true);
    expect(matchesMembership({ projects: ['billing'] }, onBoth)).toBe(true);
    expect(matchesMembership({ projects: ['billing', 'legacy'] }, onBoth)).toBe(true);
    expect(matchesMembership({ projects: ['legacy'] }, onBoth)).toBe(false);
    // Symmetric: neither side is privileged, both may hold several ids.
    expect(matchesMembership({ roles: ['devops', 'data'] }, { roles: ['data', 'pm'], projects: null })).toBe(true);
  });

  it('keeps the axes independent: an unconfigured axis never vetoes a configured one', () => {
    // Member on `checkout` with no role configured: a frontend+checkout entry reaches them.
    expect(matchesMembership({ roles: ['frontend'], projects: ['checkout'] }, { roles: null, projects: ['checkout'] }))
      .toBe(true);
    // ...but a frontend+billing entry does not.
    expect(matchesMembership({ roles: ['frontend'], projects: ['billing'] }, { roles: null, projects: ['checkout'] }))
      .toBe(false);
  });
});

describe('warnUnknownMembershipIds', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetMembershipWarnings();
    warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('stays silent when no entry scopes either axis', async () => {
    const repo = repoWith({ 'manifest/roles.yaml': ROLES_YAML, 'manifest/projects.yaml': PROJECTS_YAML });
    await warnUnknownMembershipIds(repo, 'hooks.yaml', [{ kind: 'hook', name: 'fmt' }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent for ids both manifests define', async () => {
    const repo = repoWith({ 'manifest/roles.yaml': ROLES_YAML, 'manifest/projects.yaml': PROJECTS_YAML });
    await warnUnknownMembershipIds(repo, 'mcp.yaml', [
      { kind: 'server', name: 'db', roles: ['devops'], projects: ['checkout'] },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('names an unknown role id and lists the valid ones', async () => {
    const repo = repoWith({ 'manifest/roles.yaml': ROLES_YAML, 'manifest/projects.yaml': PROJECTS_YAML });
    await warnUnknownMembershipIds(repo, 'hooks.yaml', [{ kind: 'hook', name: 'fmt', roles: ['frontnd'] }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('unknown role id "frontnd"');
    expect(warn.mock.calls[0][0]).toContain('hooks.yaml hook "fmt"');
    expect(warn.mock.calls[0][0]).toContain('frontend, devops');
  });

  it('names an unknown project id and lists the valid ones', async () => {
    const repo = repoWith({ 'manifest/roles.yaml': ROLES_YAML, 'manifest/projects.yaml': PROJECTS_YAML });
    await warnUnknownMembershipIds(repo, 'mcp.yaml', [{ kind: 'server', name: 'db', projects: ['chekout'] }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('unknown project id "chekout"');
    expect(warn.mock.calls[0][0]).toContain('mcp.yaml server "db"');
    expect(warn.mock.calls[0][0]).toContain('checkout, billing');
  });

  it('warns once per file and id, however many entries repeat it', async () => {
    const repo = repoWith({ 'manifest/roles.yaml': ROLES_YAML, 'manifest/projects.yaml': PROJECTS_YAML });
    await warnUnknownMembershipIds(repo, 'hooks.yaml', [
      { kind: 'hook', name: 'a', projects: ['nope'] },
      { kind: 'hook', name: 'b', projects: ['nope'] },
    ]);
    await warnUnknownMembershipIds(repo, 'hooks.yaml', [{ kind: 'hook', name: 'c', projects: ['nope'] }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports that project ids cannot be checked when no projects manifest exists', async () => {
    const repo = repoWith({ 'manifest/roles.yaml': ROLES_YAML });
    await warnUnknownMembershipIds(repo, 'mcp.yaml', [
      { kind: 'server', name: 'db', projects: ['checkout'] },
      { kind: 'server', name: 'cache', projects: ['billing'] },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('manifest/projects.yaml');
    expect(message).toContain('cannot be checked');
    expect(message).toContain('bound to no project');
    expect(message).toContain('2');
    // Not the typo wording: there is no valid-id list to print.
    expect(message).not.toContain('unknown project id');
  });

  it('reports the same for a projects manifest that defines zero projects', async () => {
    const repo = repoWith({
      'manifest/roles.yaml': ROLES_YAML,
      'manifest/projects.yaml': 'version: 1\nprojects: []\n',
    });
    await warnUnknownMembershipIds(repo, 'mcp.yaml', [{ kind: 'server', name: 'db', projects: ['checkout'] }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('cannot be checked');
  });

  it('reports why a projects manifest did not load, instead of claiming there are none', async () => {
    // loadProjectsManifest returns null ONLY when the file is absent; it throws
    // for bad YAML, bad shape, a duplicate id or an unsafe namespace. Collapsing
    // the two would tell a maintainer with a broken manifest to "define the
    // projects there", and throw away the only message naming the real fault.
    const repo = repoWith({
      'manifest/roles.yaml': ROLES_YAML,
      'manifest/projects.yaml': 'version: 1\nprojects:\n  - id: dup\n    resources: {}\n  - id: dup\n    resources: {}\n',
    });
    await warnUnknownMembershipIds(repo, 'mcp.yaml', [{ kind: 'server', name: 'db', projects: ['checkout'] }]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('cannot be checked');
    expect(message).toContain('duplicate project id "dup"');
    expect(message).not.toContain('defines no projects');
  });

  it('reports why a roles manifest did not load, but stays silent when there simply is none', async () => {
    const broken = repoWith({ 'manifest/roles.yaml': 'version: 1\nroles: []\n' });
    await warnUnknownMembershipIds(broken, 'hooks.yaml', [{ kind: 'hook', name: 'fmt', roles: ['frontend'] }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('manifest/roles.yaml could not be read');

    warn.mockClear();
    __resetMembershipWarnings();
    const absent = repoWith({ 'manifest/projects.yaml': PROJECTS_YAML });
    await warnUnknownMembershipIds(absent, 'hooks.yaml', [{ kind: 'hook', name: 'fmt', roles: ['frontend'] }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent about roles when the team has no roles manifest at all', async () => {
    const repo = repoWith({ 'manifest/projects.yaml': PROJECTS_YAML });
    await warnUnknownMembershipIds(repo, 'hooks.yaml', [{ kind: 'hook', name: 'fmt', roles: ['frontend'] }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('checks both axes of the same entry', async () => {
    const repo = repoWith({ 'manifest/roles.yaml': ROLES_YAML, 'manifest/projects.yaml': PROJECTS_YAML });
    await warnUnknownMembershipIds(repo, 'hooks.yaml', [
      { kind: 'hook', name: 'fmt', roles: ['nope-role'], projects: ['nope-project'] },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
