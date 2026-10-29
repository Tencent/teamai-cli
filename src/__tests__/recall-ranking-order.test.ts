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
      { page: 'evidence/code/other/overview.md', title: 'Other Overview', score: 23.5, snippet: 'o', kind: 'codebase' },
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

  it('keeps a relevant code page in the five shown when no relevant learnings hit exists', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(queryCodeKnowledge).mockResolvedValueOnce([
      { page: 'evidence/code/shop/docs/architecture.md', title: 'Shop architecture', score: 40, snippet: 'a', kind: 'codebase' },
      { page: 'evidence/code/shop/overview.md', title: 'Shop overview', score: 39, snippet: 'o', kind: 'codebase' },
      { page: 'evidence/code/shop/docs/payment.md', title: 'Shop payment', score: 38, snippet: 'p', kind: 'codebase' },
    ]);
    // All below the relevance bar: the third shop page must not drop behind them.
    vi.mocked(search).mockReturnValue([
      learningHit('Ledger misc note three', 3.1),
      learningHit('Ledger misc note four', 3.1),
      learningHit('Ledger misc note five', 3.1),
    ]);

    await recall('ledger receipts', { dryRun: true });

    const payment = captured.indexOf('[docs] Shop payment');
    const note = captured.indexOf('[learnings] Ledger misc note three');
    expect(payment).toBeGreaterThanOrEqual(0);
    expect(note).toBeGreaterThanOrEqual(0);
    expect(payment).toBeLessThan(note);
  });

  it('never lifts the extra codebase page above its own better-ranked pages', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(queryCodeKnowledge).mockResolvedValueOnce([
      { page: 'evidence/code/shop/docs/a.md', title: 'Shop A', score: 40, snippet: 'a', kind: 'codebase' },
      { page: 'evidence/code/shop/docs/b.md', title: 'Shop B', score: 39, snippet: 'b', kind: 'codebase' },
      { page: 'evidence/code/shop/docs/c.md', title: 'Shop C', score: 30, snippet: 'c', kind: 'codebase' },
    ]);
    // A relevant learnings hit above all code hits: the cap must not pull C up
    // above A and B to sit right after the runbook.
    vi.mocked(search).mockReturnValue([learningHit('Gateway Runbook', 90)]);

    await recall('gateway charges', { dryRun: true });

    const a = captured.indexOf('[docs] Shop A');
    const b = captured.indexOf('[docs] Shop B');
    const c = captured.indexOf('[docs] Shop C');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('keeps a learnings hit that leads the named module by more than the tie-break band', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(queryCodeKnowledge).mockResolvedValueOnce([
      { page: 'evidence/code/other/overview.md', title: 'Other Overview', score: 22.5, snippet: 'o', kind: 'codebase' },
      { page: 'evidence/code/smart-sale-service/overview.md', title: 'Sale Overview', score: 22, snippet: 's', kind: 'codebase' },
    ]);
    // 7.91 vs the named page's 7.24 + 0.5: ahead of the tie-break band.
    vi.mocked(search).mockReturnValue([learningHit('Gateway Runbook', 15.5)]);

    await recall('smart-sale-service gateway', { dryRun: true });

    const learningsPosition = captured.indexOf('[learnings] Gateway Runbook');
    const namedPosition = captured.indexOf('[docs] Sale Overview');
    const otherPosition = captured.indexOf('[docs] Other Overview');
    expect(learningsPosition).toBeGreaterThanOrEqual(0);
    expect(namedPosition).toBeGreaterThanOrEqual(0);
    // The named page may pass the other code page, never the learnings hit.
    expect(learningsPosition).toBeLessThan(namedPosition);
    expect(namedPosition).toBeLessThan(otherPosition);
  });

  it('does not treat a codebase whose name extends the query identifier as the same module', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(queryCodeKnowledge).mockResolvedValueOnce([
      { page: 'evidence/code/gitlab__znkf__smart-sale-service-api/overview.md', title: 'smart-sale-service-api overview', score: 40, snippet: 'a', kind: 'codebase' },
      { page: 'evidence/code/gitlab__znkf__smart-sale-service/overview.md', title: 'smart-sale-service overview', score: 28, snippet: 's', kind: 'codebase' },
    ]);
    vi.mocked(search).mockReturnValue([]);

    await recall('smart-sale-service HTTP interfaces endpoints routes', { dryRun: true });

    const exact = captured.indexOf('[docs] smart-sale-service overview');
    const sibling = captured.indexOf('[docs] smart-sale-service-api overview');
    expect(exact).toBeGreaterThanOrEqual(0);
    expect(sibling).toBeGreaterThanOrEqual(0);
    expect(exact).toBeLessThan(sibling);
  });

  it('orders a learnings hit that falls between two code pages by score, whatever the input order', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(queryCodeKnowledge).mockResolvedValueOnce([
      { page: 'evidence/code/smart-sale-service/overview.md', title: 'Sale Overview', score: 22, snippet: 's', kind: 'codebase' },
      { page: 'evidence/code/other/overview.md', title: 'Other Overview', score: 40, snippet: 'o', kind: 'codebase' },
    ]);
    // 8.0 (code) > 7.8 (learnings) > 7.24 + 0.5 bonus (named page).
    vi.mocked(search).mockReturnValue([learningHit('Gateway Runbook', 14.9)]);

    await recall('smart-sale-service gateway', { dryRun: true });

    const other = captured.indexOf('[docs] Other Overview');
    const learnings = captured.indexOf('[learnings] Gateway Runbook');
    const named = captured.indexOf('[docs] Sale Overview');
    expect(other).toBeGreaterThanOrEqual(0);
    expect(learnings).toBeGreaterThan(other);
    expect(named).toBeGreaterThan(learnings);
  });

  it('does not treat an ordinary word in the query as a module name', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(queryCodeKnowledge).mockResolvedValueOnce([
      { page: 'evidence/code/other/overview.md', title: 'Other Overview', score: 30, snippet: 'o', kind: 'codebase' },
      { page: 'evidence/code/smart-sale-service/overview.md', title: 'Sale Overview', score: 22, snippet: 's', kind: 'codebase' },
    ]);
    vi.mocked(search).mockReturnValue([]);

    // "service" and "interfaces" are plain words, not identifiers.
    await recall('service HTTP interfaces endpoints routes', { dryRun: true });

    const other = captured.indexOf('[docs] Other Overview');
    const sale = captured.indexOf('[docs] Sale Overview');
    expect(other).toBeGreaterThanOrEqual(0);
    expect(sale).toBeGreaterThanOrEqual(0);
    expect(other).toBeLessThan(sale);
  });
});
