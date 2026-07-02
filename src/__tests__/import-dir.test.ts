// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

// Mock external dependencies
vi.mock('../codebase-extract.js', () => ({
  extractCodebase: vi.fn(),
}));

vi.mock('../graph-aggregate.js', () => ({
  aggregateGlobalGraph: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  autoPushTeamRepo: vi.fn(),
}));

vi.mock('../config.js', () => ({
  autoDetectInit: vi.fn(),
}));

import { extractCodebase } from '../codebase-extract.js';
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
    (extractCodebase as ReturnType<typeof vi.fn>).mockImplementation(async (opts: { outputRoot?: string; project?: string }) => {
      const outputBase = opts.outputRoot ?? projectDir;
      const wikiRoot = path.join(outputBase, 'teamwiki');
      const evidenceDir = path.join(wikiRoot, 'evidence', 'code', opts.project ?? 'my-project');
      await fs.ensureDir(evidenceDir);
      await fs.writeFile(path.join(evidenceDir, 'index.md'), '# test\n');
      await fs.ensureDir(path.join(wikiRoot, '.indices'));
      await fs.writeFile(path.join(wikiRoot, '.indices', 'graph-index.json'), JSON.stringify({ nodes: [{ slug: 'a' }], edges: [] }));
    });

    (aggregateGlobalGraph as ReturnType<typeof vi.fn>).mockResolvedValue({ nodes: 1, edges: 0 });
    (autoPushTeamRepo as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function runImportDir(opts: { dir: string; dryRun?: boolean; output?: string; skipEnrich?: boolean }) {
    const { importCmd } = await import('../import.js');
    await importCmd({ dir: opts.dir, dryRun: opts.dryRun, output: opts.output, skipEnrich: opts.skipEnrich });
  }

  it('calls extractCodebase with outputRoot (not source dir) and skipEnrich', async () => {
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

  it('--output writes to specified dir without touching team-repo', async () => {
    const outputDir = path.join(tmpDir, 'output');
    await fs.ensureDir(outputDir);

    await runImportDir({ dir: projectDir, output: outputDir });

    // Should write to output dir
    expect(await fs.pathExists(path.join(outputDir, 'teamwiki', 'evidence', 'code', 'my-project', 'index.md'))).toBe(true);
    // Should NOT touch team-repo
    expect(await fs.pathExists(path.join(teamRepoDir, 'teamwiki', 'evidence', 'code', 'my-project'))).toBe(false);
    // Should NOT call push or aggregate
    expect(aggregateGlobalGraph).not.toHaveBeenCalled();
    expect(autoPushTeamRepo).not.toHaveBeenCalled();
  });

  it('cleans up tmpdir even when extractCodebase throws', async () => {
    (extractCodebase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('AI unavailable'));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await runImportDir({ dir: projectDir });
    exitSpy.mockRestore();

    // Verify no teamai-extract- tmpdir leaked
    const tmpFiles = await fs.readdir(os.tmpdir());
    const leaked = tmpFiles.filter(f => f.startsWith('teamai-extract-'));
    expect(leaked).toHaveLength(0);
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
