// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

// Mock external dependencies
vi.mock('../codebase-extract.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codebase-extract.js')>()),
  extractCodebase: vi.fn(),
  // The fixtures are outside git, where the slug is the directory's name.
  defaultProjectSlug: vi.fn(async (dir: string) => path.basename(dir)),
  checkoutName: async (dir: string) => path.basename(dir),
}));

vi.mock('../graph-aggregate.js', () => ({
  aggregateGlobalGraph: vi.fn(),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  autoPushTeamRepo: vi.fn(),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn(),
}));

import { defaultProjectSlug, extractCodebase, sourceRepositoryMetadata } from '../codebase-extract.js';
import { aggregateGlobalGraph } from '../graph-aggregate.js';
import { autoPushTeamRepo } from '../utils/git.js';
import { autoDetectInit } from '../config.js';

describe('import --dir', () => {
  let tmpDir: string;
  let projectDir: string;
  let teamRepoDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-dir-test-'));
    projectDir = path.join(tmpDir, 'my-project');
    teamRepoDir = path.join(tmpDir, 'team-repo');

    await fs.ensureDir(projectDir);
    await fs.ensureDir(path.join(teamRepoDir, 'teamwiki'));

    // Create a simple source file
    await fs.writeFile(path.join(projectDir, 'main.py'), '# hello\n');

    vi.clearAllMocks();

    (autoDetectInit as ReturnType<typeof vi.fn>).mockResolvedValue({
      localConfig: {
        repo: { localPath: teamRepoDir, remote: 'https://git.example.com/team/repo.git' },
        scope: 'user',
        username: 'test',
      },
      teamConfig: { team: 'test', repo: 'test/repo' },
    });

    // extractCodebase mock: simulate writing teamwiki output to outputRoot
    (extractCodebase as ReturnType<typeof vi.fn>).mockImplementation(async (opts: { path: string; outputRoot?: string; project?: string }) => {
      const outputBase = opts.outputRoot ?? projectDir;
      const wikiRoot = path.join(outputBase, 'teamwiki');
      const evidenceDir = path.join(wikiRoot, 'evidence', 'code', opts.project ?? 'my-project');
      await fs.ensureDir(evidenceDir);
      await fs.writeFile(path.join(evidenceDir, 'index.md'), '# test\n');
      // The source the real extraction records, by which the next import recognises it.
      await fs.writeJson(path.join(evidenceDir, 'source-manifest.json'), await sourceRepositoryMetadata(opts.path));
      await fs.ensureDir(path.join(wikiRoot, '.indices'));
      await fs.writeFile(path.join(wikiRoot, '.indices', 'graph-index.json'), JSON.stringify({ nodes: [{ slug: 'a' }], edges: [] }));
      return true;
    });

    (aggregateGlobalGraph as ReturnType<typeof vi.fn>).mockResolvedValue({ nodes: 1, edges: 0 });
    (autoPushTeamRepo as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function runImportDir(opts: { dir: string; dryRun?: boolean; output?: string; skipEnrich?: boolean; incremental?: boolean }) {
    const { importCmd } = await import('../import.js');
    await importCmd({ dir: opts.dir, dryRun: opts.dryRun, output: opts.output, skipEnrich: opts.skipEnrich, incremental: opts.incremental });
  }

  it('calls extractCodebase with outputRoot (not source dir) and skipEnrich', { timeout: 60_000 }, async () => {
    await runImportDir({ dir: projectDir, skipEnrich: true });

    expect(extractCodebase).toHaveBeenCalledWith(expect.objectContaining({
      path: projectDir,
      project: 'my-project',
      skipEnrich: true,
      outputRoot: expect.stringContaining('teamai-extract-'),
    }));
  });

  it('copies evidence + graph to team-repo and aggregates', async () => {
    await runImportDir({ dir: projectDir });

    const evidenceDest = path.join(teamRepoDir, 'teamwiki', 'evidence', 'code', 'my-project');
    expect(await fs.pathExists(path.join(evidenceDest, 'index.md'))).toBe(true);
    expect(await fs.pathExists(path.join(evidenceDest, '.indices', 'graph-index.json'))).toBe(true);
    expect(aggregateGlobalGraph).toHaveBeenCalledWith(path.join(teamRepoDir, 'teamwiki'));
    expect(autoPushTeamRepo).toHaveBeenCalled();
  });

  it('names the roles and projects whose resources.wiki still lists the directory-named slug', async () => {
    vi.mocked(defaultProjectSlug).mockResolvedValueOnce('github__acme__my-project');
    await fs.outputFile(path.join(teamRepoDir, 'manifest', 'roles.yaml'),
      'version: 1\nroles:\n  - id: backend\n    resources: { knowledge: [], skills: [], wiki: [my-project] }\n');
    await fs.outputFile(path.join(teamRepoDir, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: shop\n    name: Shop\n    resources: { wiki: [my-project, payments] }\n');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      await runImportDir({ dir: projectDir });
    } finally {
      spy.mockRestore();
    }

    expect(lines.join('\n')).toContain('role backend and project shop list "my-project" under resources.wiki, '
      + 'and this codebase is now teamwiki/evidence/code/github__acme__my-project/. '
      + 'Change those entries to "github__acme__my-project" so it stays scoped to them.');
  });

  it('leaves a resources.wiki entry alone while the directory-named slug still holds another repo\'s evidence', async () => {
    vi.mocked(defaultProjectSlug).mockResolvedValueOnce('github__other__my-project');
    await fs.outputJson(path.join(teamRepoDir, 'teamwiki', 'evidence', 'code', 'my-project', 'source-manifest.json'),
      { repoUrl: 'https://github.com/acme/my-project' });
    await fs.outputFile(path.join(teamRepoDir, 'manifest', 'roles.yaml'),
      'version: 1\nroles:\n  - id: backend\n    resources: { knowledge: [], skills: [], wiki: [my-project] }\n');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      await runImportDir({ dir: projectDir });
    } finally {
      spy.mockRestore();
    }

    expect(await fs.pathExists(path.join(teamRepoDir, 'teamwiki', 'evidence', 'code', 'my-project', 'source-manifest.json'))).toBe(true);
    expect(lines.join('\n')).not.toContain('under resources.wiki');
  });

  it('tells a suffixed checkout without an origin to repoint resources.wiki only while the directory-named copy may be its own', async () => {
    // Evidence a release that recorded no source published for this checkout, scoped to a role.
    const legacy = path.join(teamRepoDir, 'teamwiki', 'evidence', 'code', 'my-project');
    await fs.outputJson(path.join(legacy, 'source-manifest.json'), { project: 'my-project', files: [] });
    await fs.outputFile(path.join(teamRepoDir, 'manifest', 'roles.yaml'),
      'version: 1\nroles:\n  - id: backend\n    resources: { knowledge: [], skills: [], wiki: [my-project] }\n');
    const other = path.join(tmpDir, 'other', 'my-project');
    await fs.outputFile(path.join(other, 'main.py'), '# other\n');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      await runImportDir({ dir: projectDir });
      const own = `my-project-${createHash('sha256').update(await fs.realpath(projectDir)).digest('hex').slice(0, 8)}`;
      expect(lines.join('\n')).toContain('teamwiki/evidence/code/my-project/ holds evidence that names another source, or no source, ');
      expect(lines.join('\n')).toContain(`change any resources.wiki entry that means this checkout from "my-project" to "${own}".`);
      await runImportDir({ dir: other });
      // The older copy was moved over by hand and removed.
      await fs.remove(legacy);
      lines.length = 0;
      await runImportDir({ dir: projectDir });
      await runImportDir({ dir: other });
    } finally {
      spy.mockRestore();
    }

    expect(lines.join('\n')).not.toContain('under resources.wiki');
  });

  it('moves a suffixed checkout\'s own evidence to the remote slug once it gains an origin, and names the stale resources.wiki entry', async () => {
    // Another checkout's evidence, which recorded no source, holds the directory name.
    const evidenceRoot = path.join(teamRepoDir, 'teamwiki', 'evidence', 'code');
    await fs.outputJson(path.join(evidenceRoot, 'my-project', 'source-manifest.json'), { project: 'my-project', files: [] });
    await runImportDir({ dir: projectDir });
    const own = `my-project-${createHash('sha256').update(await fs.realpath(projectDir)).digest('hex').slice(0, 8)}`;
    await fs.outputFile(path.join(evidenceRoot, own, 'docs', 'curated.md'), '# curated\n');
    await fs.outputFile(path.join(teamRepoDir, 'manifest', 'roles.yaml'),
      `version: 1\nroles:\n  - id: backend\n    resources: { knowledge: [], skills: [], wiki: [${own}] }\n`);
    // The checkout gained an origin.
    vi.mocked(defaultProjectSlug).mockResolvedValueOnce('github__acme__my-project');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      await runImportDir({ dir: projectDir });
    } finally {
      spy.mockRestore();
    }

    expect((await fs.readdir(evidenceRoot)).sort()).toEqual(['github__acme__my-project', 'my-project']);
    expect(await fs.readFile(path.join(evidenceRoot, 'github__acme__my-project', 'docs', 'curated.md'), 'utf8')).toBe('# curated\n');
    expect(lines.join('\n')).toContain(`Moved teamwiki/evidence/code/${own}/ to teamwiki/evidence/code/github__acme__my-project/`);
    expect(lines.join('\n')).not.toContain('teamwiki/evidence/code/my-project/ names no repository');
    expect(lines.join('\n')).toContain(`role backend lists "${own}" under resources.wiki, `
      + 'and this codebase is now teamwiki/evidence/code/github__acme__my-project/. '
      + 'Change that entry to "github__acme__my-project" so it stays scoped to it.');
  });

  it('dryRun without a team repo or --output previews the directory slug', async () => {
    vi.mocked(autoDetectInit).mockRejectedValueOnce(new Error('teamai is not initialized. Run `teamai init` first.'));
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      await runImportDir({ dir: projectDir, dryRun: true });
    } finally {
      spy.mockRestore();
    }

    expect(lines.join('\n')).toContain('(project: my-project)');
    expect(extractCodebase).not.toHaveBeenCalled();
  });

  it('dryRun prints the slug the import would publish under, and writes nothing', async () => {
    await runImportDir({ dir: projectDir });
    const other = path.join(tmpDir, 'other', 'my-project');
    await fs.outputFile(path.join(other, 'main.py'), '# other\n');
    vi.clearAllMocks();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      await runImportDir({ dir: other, dryRun: true });
    } finally {
      spy.mockRestore();
    }

    const suffixed = `my-project-${createHash('sha256').update(await fs.realpath(other)).digest('hex').slice(0, 8)}`;
    expect(lines.join('\n')).toContain(`(project: ${suffixed})`);
    expect(await fs.readdir(path.join(teamRepoDir, 'teamwiki', 'evidence', 'code'))).toEqual(['my-project']);
    expect(extractCodebase).not.toHaveBeenCalled();
  });

  it('prints the slug a same-named directory without an origin is published under', async () => {
    await runImportDir({ dir: projectDir });
    const other = path.join(tmpDir, 'other', 'my-project');
    await fs.outputFile(path.join(other, 'main.py'), '# other\n');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      await runImportDir({ dir: other });
    } finally {
      spy.mockRestore();
    }

    const slugs = (await fs.readdir(path.join(teamRepoDir, 'teamwiki', 'evidence', 'code'))).sort();
    expect(slugs).toHaveLength(2);
    const suffixed = slugs.find((slug) => slug !== 'my-project');
    expect(suffixed).toMatch(/^my-project-[0-9a-f]{8}$/);
    expect(lines.join('\n')).toContain(`(project: ${suffixed})`);
    expect(lines.join('\n')).toContain(`Local directory ${suffixed} import complete`);
  });

  it('--output writes to specified dir without touching team-repo', async () => {
    const outputDir = path.join(tmpDir, 'output');
    await fs.ensureDir(outputDir);

    await runImportDir({ dir: projectDir, output: outputDir });

    // Should write to output dir, with its own graph and indexes
    expect(await fs.pathExists(path.join(outputDir, 'teamwiki', 'evidence', 'code', 'my-project', 'index.md'))).toBe(true);
    expect(aggregateGlobalGraph).toHaveBeenCalledWith(path.join(path.resolve(outputDir), 'teamwiki'));
    // Should NOT touch team-repo
    expect(await fs.pathExists(path.join(teamRepoDir, 'teamwiki', 'evidence', 'code', 'my-project'))).toBe(false);
    expect(autoDetectInit).not.toHaveBeenCalled();
    expect(autoPushTeamRepo).not.toHaveBeenCalled();
  });

  it('--incremental keeps the published evidence and pushes nothing when the source is unchanged', async () => {
    await runImportDir({ dir: projectDir });
    const evidence = path.join(teamRepoDir, 'teamwiki', 'evidence', 'code', 'my-project', 'index.md');
    expect(await fs.pathExists(evidence)).toBe(true);
    vi.clearAllMocks();
    (extractCodebase as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    await runImportDir({ dir: projectDir, incremental: true });

    expect(extractCodebase).toHaveBeenCalledWith(expect.objectContaining({ path: projectDir, project: 'my-project' }));
    expect(await fs.pathExists(evidence)).toBe(true);
    expect(aggregateGlobalGraph).not.toHaveBeenCalled();
    expect(autoPushTeamRepo).not.toHaveBeenCalled();
  });

  it('cleans up tmpdir even when extractCodebase throws', async () => {
    // The staging dir this import created: other test files stage concurrently in the same tmpdir.
    let staging: string | undefined;
    (extractCodebase as ReturnType<typeof vi.fn>).mockImplementation(async (opts: { outputRoot?: string }) => {
      staging = opts.outputRoot;
      throw new Error('AI unavailable');
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await runImportDir({ dir: projectDir });
    exitSpy.mockRestore();

    expect(staging).toContain(path.join(os.tmpdir(), 'teamai-extract-'));
    expect(await fs.pathExists(staging!)).toBe(false);
  });

  it('source directory is not polluted with teamwiki/', async () => {
    await runImportDir({ dir: projectDir });

    expect(await fs.pathExists(path.join(projectDir, 'teamwiki'))).toBe(false);
  });

  it('dryRun skips extraction entirely', async () => {
    await runImportDir({ dir: projectDir, dryRun: true });

    expect(extractCodebase).not.toHaveBeenCalled();
    expect(aggregateGlobalGraph).not.toHaveBeenCalled();
    expect(autoPushTeamRepo).not.toHaveBeenCalled();
  });
});
