/**
 * Wiki codebase slugs scoped by role/project (#912), the same declared-vs-active
 * rule `inactiveDocsNamespaces` already applies to `docs/<dir>/`: a slug ANY role
 * or project lists under `resources.wiki` reaches only members who have it
 * active; an undeclared slug stays shared (unfiltered, as before this feature).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import type { LocalConfig } from '../types.js';

function repoWith(roles: string, projects: string): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-ns-wiki-'));
  mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
  writeFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), roles, 'utf-8');
  writeFileSync(path.join(repoDir, 'manifest', 'projects.yaml'), projects, 'utf-8');
  return repoDir;
}

function localConfig(repoDir: string, overrides: Partial<LocalConfig> = {}): LocalConfig {
  return {
    repo: { localPath: repoDir, remote: 'https://github.com/acme/team.git' },
    username: 'e2e',
    additionalRoles: [],
    ...overrides,
  } as LocalConfig;
}

describe('resolveResourceNamespaces: inactiveWikiNamespaces', () => {
  const NO_WIKI_ROLE = 'version: 1\nroles:\n  - id: other\n    resources: { knowledge: [], skills: [] }\n';
  const PROJECTS = 'version: 1\nprojects:\n'
    + '  - id: svc-a\n    name: Svc A\n    resources: { wiki: [svc-a, payments] }\n'
    + '  - id: svc-b\n    name: Svc B\n    resources: { wiki: [svc-b, payments] }\n';

  it('withholds a declared slug no active role or project selects', async () => {
    const repoDir = repoWith(NO_WIKI_ROLE, PROJECTS);
    try {
      const resolved = await resolveResourceNamespaces(localConfig(repoDir, { projects: ['svc-a'] }));
      expect(resolved?.inactiveWikiNamespaces.sort()).toEqual(['svc-b']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not withhold a slug a member\'s active project selects, even when another project also declares it', async () => {
    const repoDir = repoWith(NO_WIKI_ROLE, PROJECTS);
    try {
      const resolved = await resolveResourceNamespaces(localConfig(repoDir, { projects: ['svc-a'] }));
      expect(resolved?.inactiveWikiNamespaces).not.toContain('payments');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('withholds every declared slug for a member with no active project', async () => {
    const repoDir = repoWith(NO_WIKI_ROLE, PROJECTS);
    try {
      const resolved = await resolveResourceNamespaces(localConfig(repoDir, { projects: [] }));
      expect(resolved?.inactiveWikiNamespaces.sort()).toEqual(['payments', 'svc-a', 'svc-b']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('leaves an undeclared slug alone: resolution returns null with no role, no projects and no manifest', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-ns-wiki-none-'));
    try {
      const resolved = await resolveResourceNamespaces(localConfig(repoDir, { projects: [] }));
      expect(resolved).toBeNull();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('treats a role-declared wiki namespace as declared for a member who does not hold that role', async () => {
    const roles = 'version: 1\nroles:\n'
      + '  - id: fe\n    resources: { knowledge: [], skills: [], wiki: [frontend-infra] }\n'
      + '  - id: other\n    resources: { knowledge: [], skills: [] }\n';
    const repoDir = repoWith(roles, 'version: 1\nprojects: []\n');
    try {
      const resolved = await resolveResourceNamespaces(localConfig(repoDir, { primaryRole: 'other', projects: [] }));
      expect(resolved?.inactiveWikiNamespaces).toEqual(['frontend-infra']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
