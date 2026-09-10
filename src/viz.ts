// -*- coding: utf-8 -*-
/**
 * TeamAI knowledge base visualization — data loading and aggregation.
 *
 * Resolves filesystem paths, aggregates per-user vote data, builds index entries,
 * and assembles the complete VizData payload used by the HTML renderer.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadIndex, buildIndex } from './utils/search-index.js';
import { loadUserVotes } from './votes.js';
import { detectProjectConfig, loadLocalConfig } from './config.js';
import {
  getTeamaiHomeDir,
  getUserVotesDir,
  getUserSearchIndexPath,
  getUserLearningsDir,
  getKnowledgeDir,
  getReportsDir,
  getDataHome,
  getTeamaiHome,
} from './types.js';
import type { SearchIndexEntry } from './types.js';
import { findPromotionCandidates, type PromotionCandidate } from './maintenance/promote.js';
import { findPruneCandidates, type PruneCandidate } from './maintenance/prune.js';
import { findStaleEntries, type StaleEntry } from './maintenance/quality-update.js';
import { renderReport } from './viz-render.js';

export type { PromotionCandidate, PruneCandidate, StaleEntry };

// ─── Public option / data types ──────────────────────────────────────────────

export interface VizOptions {
  /** Path to a team repo root directory to aggregate instead of local ~/.teamai. */
  repo?: string;
}

/** Aggregated recall and vote metrics for a single knowledge entry. */
export interface EntryMetric {
  docId: string;
  title: string;
  type: 'learnings' | 'docs' | 'rules' | 'skills';
  author: string;
  date: string;
  tags: string[];
  recalledCount: number;
  upvotedCount: number;
  lastRecalledAt: string | null;
}

/** Coverage statistics for a single knowledge type. */
export interface CoverageStat {
  type: string;
  total: number;
  /** Number of entries with recalledCount > 0. */
  covered: number;
  /** covered / total * 100, rounded. 0 when total is 0. */
  coveragePct: number;
}

/** A single monthly recall activity data point for trend charts. */
export interface TrendPoint {
  /** ISO year-month period, e.g. '2026-04'. */
  period: string;
  count: number;
}

/** Contribution statistics per author. */
export interface AuthorStat {
  author: string;
  entries: number;
  totalRecalled: number;
}

/** Maintenance action candidates grouped by category. */
export interface MaintenanceCandidates {
  promote: PromotionCandidate[];
  prune: PruneCandidate[];
  stale: StaleEntry[];
}

/** Where the report's data came from, shown to the reader. */
export interface VizSource {
  /** 'team' = aggregated team repo; 'local' = this machine's personal ~/.teamai. */
  scope: 'team' | 'local';
  /** Human-readable description shown in the report header and dashboard card. */
  label: string;
}

/** Complete data payload for the HTML visualization report. */
export interface VizData {
  generatedAt: string;
  root: string;
  source: VizSource;
  totalEntries: number;
  totalRecalls: number;
  overallCoveragePct: number;
  contributorCount: number;
  coverage: CoverageStat[];
  /** Top 20 entries by recalledCount (only entries with recalledCount > 0). */
  topRecalled: EntryMetric[];
  /** All entries with recalledCount === 0. */
  silent: EntryMetric[];
  /** Monthly recall activity, ascending by period. */
  trend: TrendPoint[];
  /** Top 15 authors by totalRecalled. */
  authors: AuthorStat[];
  maintenance: MaintenanceCandidates;
}

// ─── Internal types ───────────────────────────────────────────────────────────

/** Resolved filesystem paths used internally by the viz pipeline. */
interface VizPaths {
  root: string;
  /** Root under which docs/rules/skills live (may differ from the reports root in self mode). */
  knowledgeRoot: string;
  votesDir: string;
  learningsDir: string;
  statsDir: string;
  indexPath: string | undefined;
  source: VizSource;
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the data root and derivative directories for the viz pipeline.
 *
 * Precedence: explicit `--repo` flag → project-scope config → user config → ~/.teamai fallback.
 * `config.repo.kind` is 'git' | 'http' | 'self'. In self mode, votes/stats live in the reports
 * worktree (ensureReportsWorktree), while learnings remain in the local ~/.teamai tree.
 */
export async function resolveVizRoot(opts: VizOptions): Promise<VizPaths> {
  // Explicit --repo: everything lives under the given repo; no shared index
  // exists for an ad-hoc path, so loadEntries builds a temporary one from it.
  if (opts.repo) {
    const root = path.resolve(opts.repo);
    return {
      root,
      knowledgeRoot: root,
      votesDir: path.join(root, 'votes'),
      learningsDir: path.join(root, 'learnings'),
      statsDir: path.join(root, 'stats'),
      indexPath: undefined,
      source: { scope: 'team', label: 'Team repo · aggregated across the team' },
    };
  }

  const config = await detectProjectConfig() ?? await loadLocalConfig();

  if (config?.repo?.localPath) {
    const { usesReportsBranch } = await import('./types.js');
    if (usesReportsBranch(config)) {
      const { ensureReportsWorktree } = await import('./utils/reports-branch.js');
      await ensureReportsWorktree(config);
    }
    const knowledgeRoot = getKnowledgeDir(config);
    const reportsRoot = getReportsDir(config);
    const useProjectScope = config.scope === 'project' && Boolean(config.projectRoot);
    // Project branch routes through getDataHome (P1-2 partition-aware); the
    // else branch preserves the original fallback to ~/.teamai for historical
    // configs that are project-scoped but lack projectRoot (getDataHome would
    // otherwise throw via getTeamaiHome and fail the dashboard report).
    const teamaiHome = useProjectScope ? getDataHome(config) : getTeamaiHome('user');
    const learningsDir = useProjectScope
      ? path.join(knowledgeRoot, 'learnings')
      : getUserLearningsDir();
    const source: VizSource = config.repo.kind === 'self'
      ? { scope: 'local', label: 'Personal repo · your recalls only' }
      : { scope: 'team', label: 'Team repo · aggregated across the team' };
    return {
      root: knowledgeRoot,
      knowledgeRoot,
      votesDir: path.join(reportsRoot, 'votes'),
      learningsDir,
      statsDir: path.join(reportsRoot, 'stats'),
      indexPath: path.join(teamaiHome, 'search-index.json'),
      source,
    };
  }

  // Pure local / no team repo configured: fall back to ~/.teamai.
  const teamaiHome = getTeamaiHomeDir();
  return {
    root: teamaiHome,
    knowledgeRoot: teamaiHome,
    votesDir: getUserVotesDir(),
    learningsDir: getUserLearningsDir(),
    statsDir: path.join(teamaiHome, 'stats'),
    indexPath: getUserSearchIndexPath(),
    source: { scope: 'local', label: 'Local ~/.teamai · your recalls only' },
  };
}

// ─── Vote aggregation ─────────────────────────────────────────────────────────

/**
 * Aggregate vote data across all per-user YAML files in the given directory.
 *
 * Returns a map from docId to cumulative recalled/upvoted counts and the latest
 * recall ISO timestamp across all users, plus the count of users who have at least
 * one recalled_count > 0 entry. Returns empty results when the directory is absent.
 */
export async function aggregateTeamVotes(votesDir: string): Promise<{
  byDoc: Record<string, { recalledCount: number; upvotedCount: number; lastRecalledAt: string | null }>;
  activeContributors: number;
}> {
  let files: string[];
  try {
    const entries = await fs.readdir(votesDir);
    files = entries.filter((f) => f.endsWith('.yaml'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`Failed to read votes directory ${votesDir}: ${(err as Error).message}`);
    }
    return { byDoc: {}, activeContributors: 0 };
  }

  const byDoc: Record<string, { recalledCount: number; upvotedCount: number; lastRecalledAt: string | null }> =
    {};
  let activeContributors = 0;

  for (const file of files) {
    const fullPath = path.join(votesDir, file);
    const userVotes = await loadUserVotes(fullPath);
    let userHasRecall = false;
    for (const [docId, entry] of Object.entries(userVotes.votes)) {
      if (!byDoc[docId]) {
        byDoc[docId] = { recalledCount: 0, upvotedCount: 0, lastRecalledAt: null };
      }
      byDoc[docId].recalledCount += entry.recalled_count;
      byDoc[docId].upvotedCount += entry.upvoted_count;
      const ts = entry.last_recalled_at;
      if (ts && (!byDoc[docId].lastRecalledAt || ts > byDoc[docId].lastRecalledAt!)) {
        byDoc[docId].lastRecalledAt = ts;
      }
      if (entry.recalled_count > 0) userHasRecall = true;
    }
    if (userHasRecall) activeContributors++;
  }

  return { byDoc, activeContributors };
}

// ─── Index loading ────────────────────────────────────────────────────────────

/** Load search index entries, falling back to a fresh buildIndex call when absent. */
async function loadEntries(paths: VizPaths): Promise<SearchIndexEntry[]> {
  // Only read a prebuilt index when we have an explicit path for it. Passing
  // undefined to loadIndex would silently fall back to the global user index,
  // which can misrepresent an explicit --repo corpus.
  let index = paths.indexPath ? await loadIndex(paths.indexPath) : null;
  if (!index || index.entries.length === 0) {
    // Build into a unique throwaway path. A fixed shared temp file would let a
    // previous run's larger index trip buildIndex's "new index too small" guard,
    // leaving this run reading a stale corpus from a different repo.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-viz-'));
    const tmpIndexPath = path.join(tmpDir, 'index.json');
    try {
      await buildIndex({
        learningsDir: paths.learningsDir,
        docsDir: path.join(paths.knowledgeRoot, 'docs'),
        rulesDir: path.join(paths.knowledgeRoot, 'rules'),
        skillsDir: path.join(paths.knowledgeRoot, 'skills'),
        votesDir: paths.votesDir,
        indexPath: tmpIndexPath,
      });
      index = await loadIndex(tmpIndexPath);
    } catch (err) {
      console.warn(`Warning: could not build search index: ${(err as Error).message}`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return index?.entries ?? [];
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

/** Compute per-type and overall coverage statistics from the full metrics array. */
function buildCoverage(
  metrics: EntryMetric[],
): { coverage: CoverageStat[]; overallCoveragePct: number } {
  const byType = new Map<string, { total: number; covered: number }>();
  for (const m of metrics) {
    const cur = byType.get(m.type) ?? { total: 0, covered: 0 };
    cur.total++;
    if (m.recalledCount > 0) cur.covered++;
    byType.set(m.type, cur);
  }
  const coverage: CoverageStat[] = Array.from(byType.entries()).map(([type, { total, covered }]) => ({
    type,
    total,
    covered,
    coveragePct: total > 0 ? Math.round((covered / total) * 100) : 0,
  }));
  const total = metrics.length;
  const covered = metrics.filter((m) => m.recalledCount > 0).length;
  const overallCoveragePct = total > 0 ? Math.round((covered / total) * 100) : 0;
  return { coverage, overallCoveragePct };
}

/** Build monthly last-recall trend data points, sorted ascending by period. */
function buildTrend(metrics: EntryMetric[]): TrendPoint[] {
  const buckets = new Map<string, number>();
  for (const m of metrics) {
    if (!m.lastRecalledAt) continue;
    const period = m.lastRecalledAt.substring(0, 7);
    buckets.set(period, (buckets.get(period) ?? 0) + 1);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, count]) => ({ period, count }));
}

/** Aggregate per-author entry and recall totals, returning the top 15 by total recalls. */
function buildAuthors(metrics: EntryMetric[]): AuthorStat[] {
  const map = new Map<string, { entries: number; totalRecalled: number }>();
  for (const m of metrics) {
    const author = m.author || 'unknown';
    const cur = map.get(author) ?? { entries: 0, totalRecalled: 0 };
    cur.entries++;
    cur.totalRecalled += m.recalledCount;
    map.set(author, cur);
  }
  return Array.from(map.entries())
    .map(([author, stats]) => ({ author, ...stats }))
    .sort((a, b) => b.totalRecalled - a.totalRecalled)
    .slice(0, 15);
}

// ─── Core build function ──────────────────────────────────────────────────────

/**
 * Build the complete visualization data payload from resolved paths.
 *
 * @param paths - Resolved filesystem paths from resolveVizRoot.
 */
export async function buildVizData(paths: VizPaths): Promise<VizData> {
  const [entries, { byDoc: votesAgg, activeContributors: contributorCount }] = await Promise.all([
    loadEntries(paths),
    aggregateTeamVotes(paths.votesDir),
  ]);

  const metrics: EntryMetric[] = entries.map((entry) => {
    const docId = entry.filename.replace(/\.md$/i, '');
    const voteData = votesAgg[docId];
    return {
      docId,
      title: entry.title,
      type: entry.type,
      author: entry.author,
      date: entry.date,
      tags: entry.tags,
      recalledCount: voteData?.recalledCount ?? 0,
      upvotedCount: voteData?.upvotedCount ?? 0,
      lastRecalledAt: voteData?.lastRecalledAt ?? null,
    };
  });

  const { coverage, overallCoveragePct } = buildCoverage(metrics);
  const totalRecalls = metrics.reduce((sum, m) => sum + m.recalledCount, 0);
  const topRecalled = metrics
    .filter((m) => m.recalledCount > 0)
    .sort((a, b) => b.recalledCount - a.recalledCount)
    .slice(0, 20);
  const silent = metrics.filter((m) => m.recalledCount === 0);
  const trend = buildTrend(metrics);
  const authors = buildAuthors(metrics);

  const [promote, prune, stale] = await Promise.all([
    findPromotionCandidates(paths.learningsDir, paths.votesDir).catch((err: Error) => {
      console.warn(`Warning: could not load promotion candidates: ${err.message}`);
      return [] as PromotionCandidate[];
    }),
    findPruneCandidates(paths.learningsDir, paths.votesDir).catch((err: Error) => {
      console.warn(`Warning: could not load prune candidates: ${err.message}`);
      return [] as PruneCandidate[];
    }),
    findStaleEntries(paths.votesDir, {
      docs: path.join(paths.knowledgeRoot, 'docs'),
      rules: path.join(paths.knowledgeRoot, 'rules'),
      skills: path.join(paths.knowledgeRoot, 'skills'),
    }).catch((err: Error) => {
      console.warn(`Warning: could not load stale entries: ${err.message}`);
      return [] as StaleEntry[];
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    root: paths.root,
    source: paths.source,
    totalEntries: metrics.length,
    totalRecalls,
    overallCoveragePct,
    contributorCount,
    coverage,
    topRecalled,
    silent,
    trend,
    authors,
    maintenance: { promote, prune, stale },
  };
}

// ─── Service entry point ──────────────────────────────────────────────────────

/**
 * Build the knowledge-base health report as a standalone HTML string.
 *
 * Resolves data paths, aggregates VizData, and renders the report. Performs
 * no file I/O — the caller (the dashboard `/kb-report` route) streams the
 * returned HTML directly to the response.
 */
export async function generateReportHtml(opts: VizOptions = {}): Promise<string> {
  const paths = await resolveVizRoot(opts);
  const data = await buildVizData(paths);
  return renderReport(data);
}

/** Compact knowledge-base summary for the dashboard preview card. */
export interface VizSummary {
  totalEntries: number;
  overallCoveragePct: number;
  coverage: Array<{ type: string; coveragePct: number }>;
  source: VizSource;
}

/**
 * Build a compact knowledge-base summary for the dashboard preview card.
 *
 * Runs the same aggregation as the full report but returns only the headline
 * coverage figures the card needs, keeping the response payload small.
 */
export async function getVizSummary(opts: VizOptions = {}): Promise<VizSummary> {
  const paths = await resolveVizRoot(opts);
  const data = await buildVizData(paths);
  return {
    totalEntries: data.totalEntries,
    overallCoveragePct: data.overallCoveragePct,
    coverage: (data.coverage ?? []).map((stat) => ({ type: stat.type, coveragePct: stat.coveragePct })),
    source: data.source,
  };
}
