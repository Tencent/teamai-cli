/**
 * Scorer namespaces resolve the way prompts do: a scorers/<dir>/ that any role
 * or project lists under `resources.scorers` is a namespace, active only for the
 * members who select it. The scorer cache (src/scorers/cache.ts) reads this
 * shape.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import type { LocalConfig } from '../types.js';

function repoWith(roles: string, projects: string): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-ns-scorers-'));
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

describe('resolveResourceNamespaces: scorers namespaces', () => {
  const NO_SCORER_ROLE = 'version: 1\nroles:\n  - id: other\n    resources: { knowledge: [], skills: [] }\n';
  const PROJECTS = 'version: 1\nprojects:\n'
    + '  - id: svc-a\n    name: Svc A\n    resources: { scorers: [svc-a] }\n'
    + '  - id: svc-b\n    name: Svc B\n    resources: { scorers: [svc-b] }\n';

  it('withholds a declared scorers namespace no active role or project selects', async () => {
    const repoDir = repoWith(NO_SCORER_ROLE, PROJECTS);
    try {
      const resolved = await resolveResourceNamespaces(localConfig(repoDir, { projects: ['svc-a'] }));
      expect(resolved?.inactiveScorersNamespaces).toEqual(['svc-b']);
      expect(resolved?.activeNamespaces.scorers).toEqual(['svc-a']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('activates a scorers namespace a role declares for the member who holds it', async () => {
    const roles = 'version: 1\nroles:\n  - id: ops\n    resources: { knowledge: [], skills: [], scorers: [ops-eval] }\n';
    const repoDir = repoWith(roles, 'version: 1\nprojects: []\n');
    try {
      const resolved = await resolveResourceNamespaces(localConfig(repoDir, { primaryRole: 'ops', projects: [] }));
      expect(resolved?.activeNamespaces.scorers).toEqual(['ops-eval']);
      expect(resolved?.inactiveScorersNamespaces).toEqual([]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
