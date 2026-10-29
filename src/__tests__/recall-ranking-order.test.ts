import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// The order of the merged list decides what `--check` sees: it reads the first
// result only. A cross-source penalty must not put an irrelevant hit above a
// relevant one (#1524).

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn(),
  requireInit: vi.fn(),
}));
vi.mock('../code-knowledge-recall.js', () => ({
  queryCodeKnowledge: vi.fn().mockResolvedValue([]),
}));
// The learnings hits come from the index; their scores are what the ordering
// turns on, so they are stated here rather than left to the corpus.
vi.mock('../utils/search-index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/search-index.js')>()),
  search: vi.fn(),
}));

import { recall } from '../recall.js';
import { detectProjectConfig } from '../config.js';
import { queryCodeKnowledge } from '../code-knowledge-recall.js';
import { buildIndex, search } from '../utils/search-index.js';
import { getTeamaiHome, type LocalConfig, type SearchIndex } from '../types.js';

/** A learnings hit, as the index search returns it. */
function learningHit(title: string, score: number): { entry: SearchIndex['entries'][number]; score: number } {
  return {
    entry: {
      filename: `${title.toLowerCase().replace(/\s+/g, '-')}.md`,
      title,
      domain: 'ops',
      tokens: [],
      author: 'tester',
      date: '2026-05-01',
      tags: [],
      votes: 0,
      type: 'learnings',
    },
    score,
  };
}

describe('the order of the merged recall list', () => {
  let tmpDir: string;
  let projectRoot: string;
  let projectConfig: LocalConfig;
  let writeSpy: { mockRestore: () => void };
  let captured: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-order-'));
    projectRoot = path.join(tmpDir, 'proj');
    await fse.ensureDir(projectRoot);
    await fse.ensureDir(path.join(tmpDir, 'home'));
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));

    const projectRepo = path.join(projectRoot, '.teamai', 'team-repo');
    const projectLearnings = path.join(projectRepo, 'learnings');
    await fse.ensureDir(projectLearnings);
    await fse.writeFile(
      path.join(projectLearnings, 'ops-note-2026-05-01-ccc.md'),
      ['---', 'title: "Ops Note"', 'author: tester', 'date: 2026-05-01', 'tags: [ops]', '---', '', 'An ops note.', ''].join('\n'),
    );
    await fse.ensureDir(getTeamaiHome('project', projectRoot));
    await buildIndex({
      learningsDir: projectLearnings,
      indexPath: path.join(getTeamaiHome('project', projectRoot), 'search-index.json'),
    });

    projectConfig = {
      repo: { localPath: projectRepo, remote: 'https://git.woa.com/test/proj.git' },
      username: 'orderscope',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
    };

    captured = '';
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      captured += chunk.toString();
      return true;
    }) as never);
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  it('keeps a relevant codebase hit above an irrelevant learnings hit, so --check still reports it', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    // A codebase hit just above its bar (4.0) and a learnings hit just below
    // its own (4.0): the penalized score would put the learnings hit first.
    vi.mocked(queryCodeKnowledge).mockResolvedValueOnce([{
      page: 'evidence/code/demo/docs/deploy.md',
      title: 'Deploy Guide',
      score: 4,
      snippet: 'The graph page matches the query.',
      kind: 'codebase',
    }]);
    vi.mocked(search).mockReturnValue([learningHit('Unrelated Ops Note', 3.9)]);

    await recall('deployment timeout retry', { check: true });

    expect(captured).toMatch(/^RELEVANT score=4\.6/);
    expect(captured).toContain('title="Deploy Guide"');
  });

  it('ranks an explicit learnings match above a saturated codebase hit', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    // A graph score of 31 saturates the shared 0-10 scale, so the hand-written
    // page that matched the query terms has to win on the penalty alone.
    vi.mocked(queryCodeKnowledge).mockResolvedValueOnce([{
      page: 'evidence/code/demo/docs/module-overview.md',
      title: 'Module Overview',
      score: 31,
      snippet: 'The generated module overview matches the query.',
      kind: 'codebase',
    }]);
    vi.mocked(search).mockReturnValue([learningHit('Deployment Timeout Retry', 64)]);

    await recall('deployment timeout retry', { dryRun: true });

    const learningPosition = captured.indexOf('[learnings] Deployment Timeout Retry');
    const codePosition = captured.indexOf('[docs] Module Overview');
    expect(learningPosition).toBeGreaterThanOrEqual(0);
    expect(codePosition).toBeGreaterThanOrEqual(0);
    expect(learningPosition).toBeLessThan(codePosition);
  });

  it('keeps at most two pages of one codebase above a relevant learnings hit', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    // Three pages of ONE codebase all saturate at 8.0 on the merged scale
    // (graph score >= 31), so they would fill the top 3 at the same rank and
    // push the learnings page that matched the query terms to #4.
    vi.mocked(queryCodeKnowledge).mockResolvedValueOnce([
      { page: 'evidence/code/demo/docs/a-overview.md', title: 'A Overview', score: 63, snippet: 'a', kind: 'codebase' },
      { page: 'evidence/code/demo/docs/b-architecture.md', title: 'B Architecture', score: 52, snippet: 'b', kind: 'codebase' },
      { page: 'evidence/code/demo/docs/c-module.md', title: 'C Module', score: 47, snippet: 'c', kind: 'codebase' },
    ]);
    // Normalizes to 7.7 — relevant, but below a saturated code hit (8.0).
    vi.mocked(search).mockReturnValue([learningHit('Deployment Timeout Retry', 14.4)]);

    await recall('deployment timeout retry', { dryRun: true });

    const learningPosition = captured.indexOf('[learnings] Deployment Timeout Retry');
    const demotedPosition = captured.indexOf('[docs] C Module');
    expect(learningPosition).toBeGreaterThanOrEqual(0);
    expect(demotedPosition).toBeGreaterThanOrEqual(0);
    expect(learningPosition).toBeLessThan(demotedPosition);
    // The first two pages of the codebase keep their place.
    expect(captured.indexOf('[docs] A Overview')).toBeLessThan(learningPosition);
    expect(captured.indexOf('[docs] B Architecture')).toBeLessThan(learningPosition);
  });

  it('ranks the codebase page that names the module in the query above a higher-scoring one', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(queryCodeKnowledge).mockResolvedValueOnce([
      { page: 'evidence/code/other/overview.md', title: 'Other Overview', score: 30, snippet: 'o', kind: 'codebase' },
      { page: 'evidence/code/smart-sale-service/overview.md', title: 'Service Overview', score: 22, snippet: 's', kind: 'codebase' },
    ]);
    vi.mocked(search).mockReturnValue([]);

    await recall('smart-sale-service 有多少个接口？', { dryRun: true });

    const named = captured.indexOf('[docs] Service Overview');
    const other = captured.indexOf('[docs] Other Overview');
    expect(named).toBeGreaterThanOrEqual(0);
    expect(other).toBeGreaterThanOrEqual(0);
    expect(named).toBeLessThan(other);
  });

  it('does not let three codebase pages shut out a relevant learnings page', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(queryCodeKnowledge).mockResolvedValueOnce([
      { page: 'evidence/code/alpha/overview.md', title: 'Alpha Overview', score: 40, snippet: 'a', kind: 'codebase' },
      { page: 'evidence/code/beta/overview.md', title: 'Beta Overview', score: 39, snippet: 'b', kind: 'codebase' },
      { page: 'evidence/code/gamma/overview.md', title: 'Gamma Overview', score: 38, snippet: 'g', kind: 'codebase' },
    ]);
    vi.mocked(search).mockReturnValue([learningHit('Deployment Timeout Retry', 14.4)]);

    await recall('deployment timeout retry', { dryRun: true });

    const learningPosition = captured.indexOf('[learnings] Deployment Timeout Retry');
    const thirdCode = captured.indexOf('[docs] Gamma Overview');
    expect(learningPosition).toBeGreaterThanOrEqual(0);
    expect(thirdCode).toBeGreaterThanOrEqual(0);
    expect(learningPosition).toBeLessThan(thirdCode);
    expect(captured.indexOf('[docs] Alpha Overview')).toBeLessThan(learningPosition);
  });
});
