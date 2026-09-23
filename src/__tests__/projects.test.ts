import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs';
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

describe('loadProjectsManifest rejects namespaces that alias each other by case', () => {
  it('across projects, for the same resource type', async () => {
    const repoDir = writeManifest(`
version: 1
projects:
  - id: a
    name: A
    resources: { skills: [hai-inference] }
  - id: b
    name: B
    resources: { skills: [HAI-Inference] }
`);
    try {
      await expect(loadProjectsManifest(repoDir)).rejects.toThrow(
        /Invalid projects manifest: skills namespaces "hai-inference" \(project a\) and "HAI-Inference" \(project b\) differ only by case/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

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
      expect(p.resources.agents).toEqual([]);
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

  // Root reads a mode-000 file, and Windows has no POSIX mode bits.
  const cannotRevokeRead = process.platform === 'win32' || process.getuid?.() === 0;
  it.skipIf(cannotRevokeRead)('throws when the manifest exists but cannot be read, rather than reporting no projects', async () => {
    const repoDir = writeManifest('version: 1\nprojects:\n  - id: checkout\n    resources: { skills: [checkout] }\n');
    const manifestPath = path.join(repoDir, 'manifest', 'projects.yaml');
    chmodSync(manifestPath, 0o000);
    try {
      await expect(loadProjectsManifest(repoDir)).rejects.toThrow(/EACCES|permission denied/i);
    } finally {
      chmodSync(manifestPath, 0o644);
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

  it('rejects a resource namespace that is not a safe path segment (traversal guard)', async () => {
    // A namespace becomes a directory component (skills/<ns>/, agents/<ns>/) just
    // as a project id does, so the boundary has to guard both.
    for (const type of ['knowledge', 'skills', 'learnings', 'agents']) {
      // '\u0009' (C0), '\u007f' (DEL) and '\u0085' (C1) stand for the three control
      // ranges the message promises to reject.
      // Win32 strips trailing spaces and periods, so '.. ', '.. .' and '...' all
      // arrive as '..'; they have to fall with the literal ones.
      for (const badNamespace of [
        '../../evil', 'a/b', '..', '.', 'x\\y', 'C:evil',
        'a\u0009b', 'a\u007fb', 'a\u0085b',
        '.. ', '.. .', '...', '. ', '  ',
        // Win32 strips the trailing character here too, so each of these is
        // `frontend` on that filesystem — another namespace's directory.
        'frontend.', 'frontend ', 'frontend..',
        // Windows opens a device for these in any directory, with or without an
        // extension, so they cannot name the directory the manifest means.
        'CON', 'con', 'NUL', 'aux', 'COM1', 'lpt9', 'CON.txt',
        // The console handles are devices too, extension or not.
        'CONIN$', 'conout$', 'CONOUT$.txt',
        // Windows reads the superscript forms as device numbers too.
        'COM\u00b9', 'LPT\u00b3',
      ]) {
        const repoDir = writeManifest(`
version: 1
projects:
  - id: x
    resources: { ${type}: ['${badNamespace}'] }
`);
        try {
          await expect(loadProjectsManifest(repoDir)).rejects.toThrow(/single path segment/i);
        } finally {
          rmSync(repoDir, { recursive: true, force: true });
        }
      }
    }
  });

  it('keeps accepting namespaces that differ from the project id', async () => {
    const repoDir = writeManifest(`
version: 1
projects:
  - id: alpha
    resources: { learnings: [alpha-notes], skills: [alpha.v2, alpha_shared] }
`);
    try {
      const manifest = await loadProjectsManifest(repoDir);
      expect(manifest?.projects[0].resources.learnings).toEqual(['alpha-notes']);
      expect(manifest?.projects[0].resources.skills).toEqual(['alpha.v2', 'alpha_shared']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('leaves the project id rule exactly where it was', async () => {
    // The namespace guard tightened; the id did not. '...' is a working POSIX
    // directory name that the id rule has always accepted, so a manifest using
    // it must keep parsing.
    const repoDir = writeManifest(`
version: 1
projects:
  - id: '...'
    resources: { skills: [alpha] }
`);
    try {
      const manifest = await loadProjectsManifest(repoDir);
      expect(manifest?.projects[0].id).toBe('...');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps a name that merely starts like a device name, and the unreserved COM0/LPT0', async () => {
    const repoDir = writeManifest(`
version: 1
projects:
  - id: alpha
    resources: { skills: [console, connect, community, complex, nullable, COM0, LPT0] }
`);
    try {
      const manifest = await loadProjectsManifest(repoDir);
      // COM0 and LPT0 are ordinary names: Windows reserves COM1-COM9 and
      // LPT1-LPT9 only, so rejecting them would cost compatibility for nothing.
      expect(manifest?.projects[0].resources.skills).toEqual([
        'console', 'connect', 'community', 'complex', 'nullable', 'COM0', 'LPT0',
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('treats a dangling manifest/ directory link as broken too', async () => {
    // Both readFile and lstat on the file give ENOENT when the DIRECTORY is the
    // dangling link, so the whole path has to be walked before absence is
    // believed — otherwise the team looks unpartitioned and filtering falls open.
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-projdirlink-'));
    try {
      symlinkSync(path.join(repoDir, 'nowhere'), path.join(repoDir, 'manifest'));
      await expect(loadProjectsManifest(repoDir)).rejects.toThrow(/symbolic link with no target/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('treats a symlink with no target as broken, not as an absent manifest', async () => {
    // A dangling link fails to read with ENOENT exactly as a missing file does,
    // and "missing" is the one answer that lets a caller drop its filtering.
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-projlink-'));
    try {
      mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
      symlinkSync(
        path.join(repoDir, 'manifest', 'nowhere.yaml'),
        path.join(repoDir, 'manifest', 'projects.yaml'),
      );
      await expect(loadProjectsManifest(repoDir)).rejects.toThrow(/symbolic link with no target/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('treats an empty manifest as broken, not as an absent one', async () => {
    // `readFileSafe` returned null for an empty or unreadable file just as it did
    // for a missing one, and a null manifest means "this team has no projects" —
    // i.e. no project filtering at all. Only ENOENT may mean that.
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-projempty-'));
    try {
      mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
      writeFileSync(path.join(repoDir, 'manifest', 'projects.yaml'), '   \n');
      await expect(loadProjectsManifest(repoDir)).rejects.toThrow(/is empty/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns null only when the manifest file is absent', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-projnone-'));
    try {
      expect(await loadProjectsManifest(repoDir)).toBeNull();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('names the offending entry instead of dumping a raw ZodError', async () => {
    const repoDir = writeManifest(`
version: 1
projects:
  - id: alpha
    resources: { skills: [good, '../evil'] }
`);
    try {
      await expect(loadProjectsManifest(repoDir)).rejects.toThrow(
        /^Invalid projects manifest: projects\.0\.resources\.skills\.1: resource namespace must be a single path segment/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('accepts a namespace that is an unusual but traversal-free directory name', async () => {
    // The guard is about escaping the parent directory, not about spelling: a
    // namespace a filesystem accepts as one directory keeps parsing, so a team
    // whose namespaces are non-ASCII or hold a space is not forced to rename.
    const repoDir = writeManifest(`
version: 1
projects:
  - id: alpha
    resources:
      skills: ["\u7814\u53d1", "team frontend", "team@frontend", "..notes"]
`);
    try {
      const manifest = await loadProjectsManifest(repoDir);
      expect(manifest?.projects[0].resources.skills).toEqual([
        '\u7814\u53d1',
        'team frontend',
        'team@frontend',
        '..notes',
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('round-trips through save', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-projsave-'));
    try {
      const manifest: ProjectsManifest = {
        version: 1,
        projects: [
          { id: 'a', name: 'A', description: '', resources: { knowledge: ['a'], skills: ['a'], learnings: ['a'], agents: [] } },
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
      { id: 'hai', name: '', description: '', resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], learnings: ['hai'], agents: [] } },
      { id: 'billing', name: '', description: '', resources: { knowledge: ['common', 'billing'], skills: ['billing'], learnings: ['billing'], agents: [] } },
    ],
  };

  it('resolves a single active project', () => {
    expect(resolveProjectResourceNamespaces({ manifest, activeProjects: ['hai'] })).toEqual({
      knowledge: ['common', 'hai'],
      skills: ['common', 'hai'],
      learnings: ['hai'],
      agents: [],
    });
  });

  it('unions and dedupes across multiple active projects', () => {
    expect(resolveProjectResourceNamespaces({ manifest, activeProjects: ['hai', 'billing'] })).toEqual({
      knowledge: ['common', 'hai', 'billing'],
      skills: ['common', 'hai', 'billing'],
      learnings: ['hai', 'billing'],
      agents: [],
    });
  });

  it('returns empty sets for no active projects', () => {
    expect(resolveProjectResourceNamespaces({ manifest, activeProjects: [] })).toEqual({
      knowledge: [],
      skills: [],
      learnings: [],
      agents: [],
    });
  });

  it('throws on an unknown active project', () => {
    expect(() => resolveProjectResourceNamespaces({ manifest, activeProjects: ['nope'] })).toThrow(/unknown project/i);
  });
});

describe('mergeNamespaces', () => {
  const role: ResourceNamespaces = { knowledge: ['common', 'dev'], skills: ['common', 'dev'], learnings: [], agents: [] };
  const project = { knowledge: ['common', 'hai'], skills: ['hai'], learnings: ['hai'], agents: [] };

  it('unions role and project on knowledge/skills and takes learnings from project only', () => {
    expect(mergeNamespaces(role, project)).toEqual({
      knowledge: ['common', 'dev', 'hai'],
      skills: ['common', 'dev', 'hai'],
      learnings: ['hai'],
      agents: [],
    });
  });

  it('is a no-op union when project contributes nothing', () => {
    expect(mergeNamespaces(role, { knowledge: [], skills: [], learnings: [], agents: [] })).toEqual({
      knowledge: ['common', 'dev'],
      skills: ['common', 'dev'],
      learnings: [],
      agents: [],
    });
  });

  it('unions the agents axis from roles and projects', () => {
    const roleWithAgents: ResourceNamespaces = { knowledge: [], skills: [], learnings: [], agents: ['common', 'frontend'] };
    expect(mergeNamespaces(roleWithAgents, { knowledge: [], skills: [], learnings: [], agents: ['frontend', 'billing'] }).agents)
      .toEqual(['common', 'frontend', 'billing']);
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
