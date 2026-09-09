import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadProjectsManifest,
  saveProjectsManifest,
  findProject,
  listProjectIds,
  resolveProjectResourceNamespaces,
  resolveActiveLearningsNamespaces,
  mergeNamespaces,
} from '../projects.js';
import type { ProjectsManifest } from '../projects.js';
import type { ResourceNamespaces } from '../roles.js';

function writeManifest(content: string): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-projects-'));
  const manifestDir = path.join(repoDir, 'manifest');
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(path.join(manifestDir, 'projects.yaml'), content, 'utf-8');
  return repoDir;
}

describe('loadProjectsManifest', () => {
  it('returns null when the manifest is absent (projects are optional)', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-noproj-'));
    try {
      expect(await loadProjectsManifest(repoDir)).toBeNull();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('parses a valid manifest with learnings as an active dimension', async () => {
    const repoDir = writeManifest(`
version: 1
projects:
  - id: hai-inference
    name: HAI Inference
    resources:
      knowledge: [hai-inference]
      skills: [hai-inference]
      learnings: [hai-inference]
`);
    try {
      const m = await loadProjectsManifest(repoDir);
      expect(m).not.toBeNull();
      expect(listProjectIds(m!)).toEqual(['hai-inference']);
      expect(findProject(m!, 'hai-inference')?.resources.learnings).toEqual(['hai-inference']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('accepts an empty projects list (unlike roles)', async () => {
    const repoDir = writeManifest(`version: 1\nprojects: []\n`);
    try {
      const m = await loadProjectsManifest(repoDir);
      expect(m!.projects).toEqual([]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('defaults missing resource arrays to empty', async () => {
    const repoDir = writeManifest(`
version: 1
projects:
  - id: billing
    resources:
      skills: [billing]
`);
    try {
      const m = await loadProjectsManifest(repoDir);
      const p = findProject(m!, 'billing')!;
      expect(p.resources.skills).toEqual(['billing']);
      expect(p.resources.knowledge).toEqual([]);
      expect(p.resources.learnings).toEqual([]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate project ids', async () => {
    const repoDir = writeManifest(`
version: 1
projects:
  - id: dup
    resources: { skills: [a] }
  - id: dup
    resources: { skills: [b] }
`);
    try {
      await expect(loadProjectsManifest(repoDir)).rejects.toThrow(/duplicate project id/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown resource types', async () => {
    const repoDir = writeManifest(`
version: 1
projects:
  - id: x
    resources: { bogus: [a] }
`);
    try {
      await expect(loadProjectsManifest(repoDir)).rejects.toThrow(/unknown resource type/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('rejects a project id that is not a safe path segment (traversal guard)', async () => {
    for (const badId of ['../evil', 'a/b', '..', 'x\\y']) {
      const repoDir = writeManifest(`
version: 1
projects:
  - id: "${badId}"
    resources: { skills: [a] }
`);
      try {
        await expect(loadProjectsManifest(repoDir)).rejects.toThrow();
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }
  });

  it('round-trips through save', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-projsave-'));
    try {
      const manifest: ProjectsManifest = {
        version: 1,
        projects: [
          { id: 'a', name: 'A', description: '', resources: { knowledge: ['a'], skills: ['a'], learnings: ['a'] } },
        ],
      };
      await saveProjectsManifest(repoDir, manifest);
      const loaded = await loadProjectsManifest(repoDir);
      expect(loaded).toEqual(manifest);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('resolveProjectResourceNamespaces', () => {
  const manifest: ProjectsManifest = {
    version: 1,
    projects: [
      { id: 'hai', name: '', description: '', resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], learnings: ['hai'] } },
      { id: 'billing', name: '', description: '', resources: { knowledge: ['common', 'billing'], skills: ['billing'], learnings: ['billing'] } },
    ],
  };

  it('resolves a single active project', () => {
    expect(resolveProjectResourceNamespaces({ manifest, activeProjects: ['hai'] })).toEqual({
      knowledge: ['common', 'hai'],
      skills: ['common', 'hai'],
      learnings: ['hai'],
    });
  });

  it('unions and dedupes across multiple active projects', () => {
    expect(resolveProjectResourceNamespaces({ manifest, activeProjects: ['hai', 'billing'] })).toEqual({
      knowledge: ['common', 'hai', 'billing'],
      skills: ['common', 'hai', 'billing'],
      learnings: ['hai', 'billing'],
    });
  });

  it('returns empty sets for no active projects', () => {
    expect(resolveProjectResourceNamespaces({ manifest, activeProjects: [] })).toEqual({
      knowledge: [],
      skills: [],
      learnings: [],
    });
  });

  it('throws on an unknown active project', () => {
    expect(() => resolveProjectResourceNamespaces({ manifest, activeProjects: ['nope'] })).toThrow(/unknown project/i);
  });
});

describe('mergeNamespaces', () => {
  const role: ResourceNamespaces = { knowledge: ['common', 'dev'], skills: ['common', 'dev'], learnings: [] };
  const project = { knowledge: ['common', 'hai'], skills: ['hai'], learnings: ['hai'] };

  it('unions role and project on knowledge/skills and takes learnings from project only', () => {
    expect(mergeNamespaces(role, project)).toEqual({
      knowledge: ['common', 'dev', 'hai'],
      skills: ['common', 'dev', 'hai'],
      learnings: ['hai'],
    });
  });

  it('is a no-op union when project contributes nothing', () => {
    expect(mergeNamespaces(role, { knowledge: [], skills: [], learnings: [] })).toEqual({
      knowledge: ['common', 'dev'],
      skills: ['common', 'dev'],
      learnings: [],
    });
  });
});

describe('resolveActiveLearningsNamespaces', () => {
  it('maps project id to its manifest learnings namespace (id may differ from namespace)', async () => {
    // Regression for PR #426 review P2: contribute must route by the manifest
    // learnings namespace (alpha-notes), NOT the raw project id (alpha).
    const repoDir = writeManifest(`
version: 1
projects:
  - id: alpha
    resources:
      learnings: [alpha-notes]
`);
    try {
      expect(await resolveActiveLearningsNamespaces(repoDir, ['alpha'])).toEqual(['alpha-notes']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns [] with no active project, no manifest, or no learnings namespace', async () => {
    const noManifest = mkdtempSync(path.join(os.tmpdir(), 'teamai-noman-'));
    const noLearnings = writeManifest(`
version: 1
projects:
  - id: beta
    resources:
      skills: [beta]
`);
    try {
      expect(await resolveActiveLearningsNamespaces(noManifest, ['x'])).toEqual([]);
      expect(await resolveActiveLearningsNamespaces(noLearnings, [])).toEqual([]);
      expect(await resolveActiveLearningsNamespaces(noLearnings, ['beta'])).toEqual([]);
    } finally {
      rmSync(noManifest, { recursive: true, force: true });
      rmSync(noLearnings, { recursive: true, force: true });
    }
  });
});
