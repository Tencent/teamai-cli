/**
 * The wiring of `sharing.namespaceMerge`: the mode is read from the team's real
 * teamai.yaml and passed to mergeNamespaces. These tests write teamai.yaml on
 * disk (not a mode literal), so dropping the read or the third mergeNamespaces
 * argument — which would silently fall back to union — fails here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import type { LocalConfig } from '../types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ROLES = `version: 1
roles:
  - id: dev
    resources: { knowledge: [svc-a, svc-b], skills: [svc-a, svc-b], learnings: [review-notes] }
`;
const PROJECTS = `version: 1
projects:
  - id: svc-a
    resources: { knowledge: [svc-a], skills: [svc-a], learnings: [svc-a-notes] }
  - id: svc-b
    resources: { knowledge: [svc-b], skills: [svc-b] }
`;

/** A team repo whose teamai.yaml is `yaml` (omit it entirely when undefined). */
function teamRepo(yaml?: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-merge-mode-'));
  dirs.push(repo);
  fs.mkdirSync(path.join(repo, 'manifest'));
  fs.writeFileSync(path.join(repo, 'manifest', 'roles.yaml'), ROLES);
  fs.writeFileSync(path.join(repo, 'manifest', 'projects.yaml'), PROJECTS);
  if (yaml !== undefined) fs.writeFileSync(path.join(repo, 'teamai.yaml'), yaml);
  return repo;
}

function memberOf(repo: string, overrides: Partial<LocalConfig> = {}): LocalConfig {
  return { repo: { localPath: repo, remote: 'https://github.com/acme/team.git' }, username: 'member', scope: 'project', primaryRole: 'dev', additionalRoles: [], projects: ['svc-a'], ...overrides };
}

const sharing = (mode: string) => `team: t\nsharing:\n  namespaceMerge: ${mode}\n`;

describe('sharing.namespaceMerge wiring', () => {
  it('intersect scopes the directory to the project within the role ceiling', async () => {
    const resolved = await resolveResourceNamespaces(memberOf(teamRepo(sharing('intersect'))));

    expect(resolved?.activeNamespaces).toMatchObject({
      knowledge: ['svc-a'],
      skills: ['svc-a'],
      // learnings stays the role+project union, as under union.
      learnings: ['review-notes', 'svc-a-notes'],
    });
  });

  it('union (explicit) keeps both role namespaces', async () => {
    const resolved = await resolveResourceNamespaces(memberOf(teamRepo(sharing('union'))));

    expect(resolved?.activeNamespaces).toMatchObject({ knowledge: ['svc-a', 'svc-b'], skills: ['svc-a', 'svc-b'] });
  });

  it('defaults to union when teamai.yaml is absent', async () => {
    const resolved = await resolveResourceNamespaces(memberOf(teamRepo()));

    expect(resolved?.activeNamespaces).toMatchObject({ knowledge: ['svc-a', 'svc-b'], skills: ['svc-a', 'svc-b'] });
  });

  it('defaults to union when the key is absent', async () => {
    const resolved = await resolveResourceNamespaces(memberOf(teamRepo('team: t\nsharing:\n  docs:\n    localDir: ./d\n')));

    expect(resolved?.activeNamespaces).toMatchObject({ skills: ['svc-a', 'svc-b'] });
  });

  it('falls back to union on malformed YAML rather than failing the pull', async () => {
    const resolved = await resolveResourceNamespaces(memberOf(teamRepo('sharing: [unclosed\n  :::')));

    expect(resolved?.activeNamespaces).toMatchObject({ skills: ['svc-a', 'svc-b'] });
  });

  it('falls back to union on an invalid enum value', async () => {
    const resolved = await resolveResourceNamespaces(memberOf(teamRepo(sharing('sideways'))));

    expect(resolved?.activeNamespaces).toMatchObject({ skills: ['svc-a', 'svc-b'] });
  });

  it('intersect with no active project keeps the role namespaces', async () => {
    const resolved = await resolveResourceNamespaces(memberOf(teamRepo(sharing('intersect')), { projects: [] }));

    expect(resolved?.activeNamespaces).toMatchObject({ knowledge: ['svc-a', 'svc-b'], skills: ['svc-a', 'svc-b'] });
  });
});
