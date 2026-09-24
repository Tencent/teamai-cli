import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import type { LocalConfig } from '../types.js';

function repoWith(roles: string, projects: string): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-ns-case-'));
  mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
  writeFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), roles, 'utf-8');
  writeFileSync(path.join(repoDir, 'manifest', 'projects.yaml'), projects, 'utf-8');
  return repoDir;
}

function localConfig(repoDir: string, overrides: Partial<LocalConfig> = {}): LocalConfig {
  return {
    repo: { localPath: repoDir, remote: 'https://github.com/acme/team.git' },
    username: 'e2e',
    primaryRole: 'fe',
    projects: ['p'],
    ...overrides,
  } as LocalConfig;
}

describe('resolveResourceNamespaces: roles.yaml and projects.yaml share one directory per resource type', () => {
  const ROLES = 'version: 1\nroles:\n  - id: fe\n    resources: { knowledge: [], skills: [frontend] }\n';

  it('rejects a project namespace that aliases a role namespace by case', async () => {
    const repoDir = repoWith(ROLES, 'version: 1\nprojects:\n  - id: p\n    name: P\n    resources: { skills: [Frontend] }\n');
    try {
      await expect(resolveResourceNamespaces(localConfig(repoDir))).rejects.toThrow(
        /skills namespaces "frontend" \(role fe\) and "Frontend" \(project p\) differ only by case/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('rejects it for a member with no role too: the collision is in the repo, not in who pulls', async () => {
    const repoDir = repoWith(ROLES, 'version: 1\nprojects:\n  - id: p\n    name: P\n    resources: { skills: [Frontend] }\n');
    try {
      await expect(resolveResourceNamespaces(localConfig(repoDir, { primaryRole: undefined }))).rejects.toThrow(
        /skills namespaces "frontend" \(role fe\) and "Frontend" \(project p\) differ only by case/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('rejects a project namespace that aliases a role namespace only under Unicode case folding', async () => {
    const repoDir = repoWith(
      'version: 1\nroles:\n  - id: fe\n    resources: { knowledge: [], skills: [ΟΔΟΣ] }\n',
      'version: 1\nprojects:\n  - id: p\n    name: P\n    resources: { skills: [οδοσ] }\n',
    );
    try {
      await expect(resolveResourceNamespaces(localConfig(repoDir))).rejects.toThrow(
        'skills namespaces "ΟΔΟΣ" (role fe) and "οδοσ" (project p) differ only by case',
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // A role-less config is migrated to a manifest-declared `hai` role when the
  // manifest parses, so a broken one does gate this member: it must fail the
  // pull rather than let it fall through to an unfiltered sync.
  it('fails the pull of a member with no role, no project and no projects.yaml when roles.yaml does not parse', async () => {
    const repoDir = repoWith("version: 1\nroles:\n  - id: hai\n    resources: { knowledge: [], skills: ['../../evil'] }\n", '');
    rmSync(path.join(repoDir, 'manifest', 'projects.yaml'));
    try {
      await expect(
        resolveResourceNamespaces(localConfig(repoDir, { primaryRole: undefined, projects: [] })),
      ).rejects.toThrow(/Invalid roles manifest/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps the unfiltered sync for that member when roles.yaml is absent', async () => {
    const repoDir = repoWith('', '');
    rmSync(path.join(repoDir, 'manifest', 'roles.yaml'));
    rmSync(path.join(repoDir, 'manifest', 'projects.yaml'));
    try {
      await expect(
        resolveResourceNamespaces(localConfig(repoDir, { primaryRole: undefined, projects: [] })),
      ).resolves.toBeNull();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('a member with no role and no roles.yaml still resolves project namespaces', async () => {
    const repoDir = repoWith('', 'version: 1\nprojects:\n  - id: p\n    name: P\n    resources: { skills: [p-only] }\n');
    rmSync(path.join(repoDir, 'manifest', 'roles.yaml'));
    try {
      const resolved = await resolveResourceNamespaces(localConfig(repoDir, { primaryRole: undefined }));
      expect(resolved?.activeNamespaces.skills).toEqual(['p-only']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('accepts the same spelling shared by a role and a project', async () => {
    const repoDir = repoWith(ROLES, 'version: 1\nprojects:\n  - id: p\n    name: P\n    resources: { skills: [frontend, p-only] }\n');
    try {
      const resolved = await resolveResourceNamespaces(localConfig(repoDir));
      expect(resolved?.activeNamespaces.skills).toEqual(expect.arrayContaining(['frontend', 'p-only']));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
