import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_PROJECTS_SELECTOR, resolveActiveProjects } from '../init.js';

const MANY = `
version: 1
projects:
  - id: backend
    name: Backend
    resources: { knowledge: [backend], skills: [backend], learnings: [backend] }
  - id: frontend
    name: Frontend
    resources: { knowledge: [], skills: [], learnings: [] }
  - id: gateway
    resources: { knowledge: [], skills: [], learnings: [] }
`;

const ONE = `
version: 1
projects:
  - id: solo
    resources: { knowledge: [], skills: [], learnings: [] }
`;

const NONE = `
version: 1
projects: []
`;

const SHADOWING = `
version: 1
projects:
  - id: all
    resources: { knowledge: [], skills: [], learnings: [] }
  - id: backend
    resources: { knowledge: [], skills: [], learnings: [] }
`;

/** A temp team repo; `manifest` is omitted to simulate a repo without projects. */
function makeRepo(manifest?: string): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-init-projects-'));
  if (manifest !== undefined) {
    mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
    writeFileSync(path.join(repoDir, 'manifest', 'projects.yaml'), manifest, 'utf-8');
  }
  return repoDir;
}

async function withRepo<T>(manifest: string | undefined, fn: (repo: string) => Promise<T>): Promise<T> {
  const repo = makeRepo(manifest);
  try {
    return await fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('resolveActiveProjects — unchanged paths', () => {
  it('returns no projects when the flag is absent, manifest or not', async () => {
    await withRepo(undefined, async (repo) => {
      expect(await resolveActiveProjects(repo, undefined)).toEqual({ projects: [] });
    });
    await withRepo(MANY, async (repo) => {
      expect(await resolveActiveProjects(repo, undefined)).toEqual({ projects: [] });
      expect(await resolveActiveProjects(repo, '   ')).toEqual({ projects: [] });
    });
  });

  it('throws when the flag is given but the team repo has no manifest', async () => {
    await withRepo(undefined, async (repo) => {
      await expect(resolveActiveProjects(repo, 'backend')).rejects.toThrow(/no projects manifest/);
      await expect(resolveActiveProjects(repo, ALL_PROJECTS_SELECTOR)).rejects.toThrow(
        /no projects manifest/,
      );
    });
  });

  it('resolves a comma-separated list, trimming each id', async () => {
    await withRepo(MANY, async (repo) => {
      expect(await resolveActiveProjects(repo, ' backend , gateway ')).toEqual({
        projects: ['backend', 'gateway'],
      });
    });
  });

  it('dedupes repeated ids while preserving order', async () => {
    await withRepo(MANY, async (repo) => {
      expect(await resolveActiveProjects(repo, 'gateway,backend,gateway')).toEqual({
        projects: ['gateway', 'backend'],
      });
    });
  });

  it('throws on an unknown id and lists the available ones', async () => {
    await withRepo(MANY, async (repo) => {
      await expect(resolveActiveProjects(repo, 'bakcend')).rejects.toThrow(
        /Unknown project "bakcend"\. Available projects: backend, frontend, gateway/,
      );
    });
  });

  it('is case-sensitive, so a differently-cased id is unknown', async () => {
    await withRepo(MANY, async (repo) => {
      await expect(resolveActiveProjects(repo, 'All')).rejects.toThrow(/Unknown project "All"/);
    });
  });
});

describe('resolveActiveProjects — the "all" selector', () => {
  it('expands to every declared id, in manifest order', async () => {
    await withRepo(MANY, async (repo) => {
      expect(await resolveActiveProjects(repo, ALL_PROJECTS_SELECTOR)).toEqual({
        projects: ['backend', 'frontend', 'gateway'],
      });
    });
  });

  it('is trimmed and comma-split like any other value', async () => {
    await withRepo(MANY, async (repo) => {
      expect(await resolveActiveProjects(repo, ' all ')).toEqual({
        projects: ['backend', 'frontend', 'gateway'],
      });
    });
  });

  it('activates exactly the lone project when the manifest declares one', async () => {
    await withRepo(ONE, async (repo) => {
      expect(await resolveActiveProjects(repo, ALL_PROJECTS_SELECTOR)).toEqual({
        projects: ['solo'],
      });
    });
  });

  it('activates nothing, without throwing, when the manifest declares no projects', async () => {
    await withRepo(NONE, async (repo) => {
      expect(await resolveActiveProjects(repo, ALL_PROJECTS_SELECTOR)).toEqual({ projects: [] });
    });
  });

  it('returns each id once', async () => {
    await withRepo(MANY, async (repo) => {
      const { projects = [] } = await resolveActiveProjects(repo, ALL_PROJECTS_SELECTOR);
      expect(new Set(projects).size).toBe(projects.length);
    });
  });

  it('rejects a list that mixes "all" with explicit ids, whichever order', async () => {
    await withRepo(MANY, async (repo) => {
      await expect(resolveActiveProjects(repo, 'all,backend')).rejects.toThrow(
        /already covers every declared project/,
      );
      await expect(resolveActiveProjects(repo, 'backend,all')).rejects.toThrow(
        /already covers every declared project/,
      );
    });
  });

  it('keeps a project literally named "all" reachable via the expansion', async () => {
    await withRepo(SHADOWING, async (repo) => {
      expect(await resolveActiveProjects(repo, ALL_PROJECTS_SELECTOR)).toEqual({
        projects: ['all', 'backend'],
      });
    });
  });
});
