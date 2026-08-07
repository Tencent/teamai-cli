import path from 'node:path';
import { requireInit, detectProjectConfig, loadLocalConfigForScope } from './config.js';
import { loadIndex, buildIndex, search, isLegacyIndex } from './utils/search-index.js';
import type { SearchResult } from './utils/search-index.js';
import { readFileSafe, ensureDir, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, SearchIndex, LocalConfig } from './types.js';
import { getTeamaiHome } from './types.js';
import { queryCodeKnowledge } from './code-knowledge-recall.js';
import type { CodeKnowledgeResult, SourceAnchor } from './code-knowledge-recall.js';
import { recordRecallQuality } from './recall-quality.js';
import { deriveSessionId } from './utils/session-id.js';

/** Relevance threshold for codebase graph hits.
 *  These are log-compressed to a bounded [0,10] range (see `queryCodeKnowledge`
 *  result mapping below), so an absolute threshold is stable here — it does not
 *  drift with corpus size, and it is unaffected by the query-length
 *  normalization that applies to learnings scores. */
const CODEBASE_RELEVANCE_THRESHOLD = 4.0;

/** Relevance threshold for learnings/docs hits, expressed as a fraction of the
 *  theoretical single-token-match baseline rather than an absolute score.
 *  Learnings scores are unbounded TF-IDF sums whose magnitude scales with
 *  log(N) as the corpus grows (IDF numerator is the total entry count), so a
 *  hardcoded absolute cutoff silently drifts. Normalizing by the baseline
 *  keeps the decision stable across corpus sizes.
 *
 *  Scores are also divided by sqrt(query token count) in `search` so that they
 *  are comparable across queries of different lengths — these thresholds apply
 *  to that normalized scale. Normalization does not systematically penalize long
 *  queries: a longer query matches more terms, so the numerator grows roughly in
 *  step with the divisor. Measured on a 163-entry corpus, true positives ranged
 *  from 11.2 (a 3-token query) to 63.2 (19 tokens), all well clear of the 7.3
 *  cutoff, while unrelated queries scored 0 — they are excluded by the
 *  title/tag gate in `search` rather than by this threshold.
 *
 *  IMPORTANT: this ratio is only "stricter" for N ≳ 20 (where baseline×1.35 >
 *  4.0). For small corpora (N=1–5) the ratio gives a cutoff of 1.35–3.57, which
 *  is significantly looser than 4.0. That is why LEARNINGS_ABSOLUTE_FLOOR exists:
 *  isRelevantScore uses max(baseline*ratio, floor) so cold-start corpora are
 *  held to the same strict bar as historical code, and the relative threshold
 *  only takes effect once N is large enough (~20+) to push it above the floor. */
const LEARNINGS_RELEVANCE_RATIO = 1.35;

/** Absolute floor for learnings relevance, applied when the corpus is too small
 *  for the relative threshold to be meaningful.
 *
 *  The ratio-based cutoff scales with log(N), so on a cold-start corpus (1-5
 *  entries) it drops well below the historical absolute cutoff of 4.0 — a single
 *  tag match would score ~1.7-3.6 and wrongly pass. Taking max(relative, floor)
 *  keeps the stricter pre-existing behavior until the corpus is large enough
 *  (N >= ~20) for the relative threshold to exceed the floor on its own.
 *
 *  Like the ratio above, this compares against query-length-normalized scores. */
const LEARNINGS_ABSOLUTE_FLOOR = 4.0;

/**
 * Decide whether a top-1 recall result clears the relevance bar.
 *
 * Codebase graph hits use a fixed threshold because their scores are already
 * log-compressed into a bounded range. Learnings hits use
 * `max(baseline * LEARNINGS_RELEVANCE_RATIO, LEARNINGS_ABSOLUTE_FLOOR)`:
 * - On a large corpus (N ≳ 20), the relative threshold exceeds the floor and
 *   provides a corpus-size-stable cutoff.
 * - On a cold-start corpus (N = 1–5), the relative threshold drops well below
 *   4.0, so the floor enforces the same strict bar as historical code and
 *   prevents false positives from single-tag or single-title matches.
 *
 * @param score Top-1 merged result score.
 * @param isCodebaseHit True when the top result came from the codebase graph.
 * @param idfBaseline IDF of a single-occurrence token in the active index;
 *                    pass 1 to fall back to absolute-score behavior.
 * @returns True when the result is relevant enough to surface.
 */
export function isRelevantScore(
  score: number,
  isCodebaseHit: boolean,
  idfBaseline: number,
): boolean {
  if (isCodebaseHit) return score >= CODEBASE_RELEVANCE_THRESHOLD;
  const baseline = idfBaseline > 0 ? idfBaseline : 1;
  return score >= Math.max(baseline * LEARNINGS_RELEVANCE_RATIO, LEARNINGS_ABSOLUTE_FLOOR);
}

/**
 * IDF value of a token occurring in exactly one entry of the given index.
 *
 * Mirrors the formula in search-index.ts (`log((N+1)/(df+1)) + 1` with df=1)
 * so learnings thresholds can be expressed relative to corpus size instead of
 * as absolute scores. Returns 1 for legacy indexes lacking a df map, which
 * makes `isRelevantScore` degrade to its previous absolute behavior.
 *
 * When multiple scopes are active, we take the entry count of whichever
 * df-bearing index is largest. This is a deliberately conservative approximation
 * (the resulting threshold is higher) — a more precise approach would carry each
 * index's own baseline through to the per-result scoring, which is left as a
 * known limitation (see P2-5).
 *
 * Legacy indexes (no df map) are excluded from the N computation because their
 * presence would otherwise inflate maxEntries and raise the threshold against
 * results that were actually scored against a small modern index.
 *
 * @returns IDF of a single-occurrence token (>= 1); 1 for legacy indexes without a df map.
 */
export function computeIdfBaseline(indexes: SearchIndex[]): number {
  let maxEntries = 0;
  for (const idx of indexes) {
    if (!idx.df) continue;                    // legacy index: its N is not used for IDF anyway
    if (idx.entries.length > maxEntries) maxEntries = idx.entries.length;
  }
  if (maxEntries === 0) return 1;
  return Math.log((maxEntries + 1) / 2) + 1;
}

/** Resolve votes dir dynamically (respects HOME changes in tests). */
function getVotesLocalDir(): string {
  return `${process.env.HOME ?? ''}/.teamai/votes`;
}

/** Search result with scope label for merged output. */
interface ScopedSearchResult extends SearchResult {
  scope?: 'user' | 'project';
  /** Base path for learnings files (so AI can read the correct path). */
  learningsBase?: string;
  /** Source file anchors from codebase wiki frontmatter (codebase results only). */
  sources?: SourceAnchor[];
  /** Forward-dependency neighbor files from graph (candidate change files). */
  relatedFiles?: string[];
  /** True when this result came from the codebase knowledge graph (bounded score scale). */
  fromCodebase?: boolean;
}

// ─── Recall data flow ────────────────────────────────────
//
//  teamai recall <query>
//      │
//      ├─ loadIndex()
//      │   └─ missing? → buildIndex() first
//      │
//      ├─ search(query, index)
//      │   └─ 0 results? → "No matching learnings found"
//      │
//      ├─ formatResults(results)
//      │   └─ STDOUT (AI-consumable format)
//      │
//      ├─ recordRecallQuality(sessionId, results)
//      │   └─ ~/.teamai/sessions/<sid>-recall-cache.json
//      │      (read by contribute-check's knowledge-gap detection)
//      │
//      └─ autoUpvote(results, username, repoPath)
//          ├─ write ~/.teamai/votes/<user>.yaml (local)
//          └─ copy to <repoPath>/votes/<user>.yaml
//              (pushed on next pull via auto-report)
//

/**
 * Format search results for CLI / AI consumption.
 *
 * Output uses delimiters so AI treats content as reference, not instruction.
 * Each entry includes a scope label (user/project) when source is known and
 * a type tag (skills/learnings/docs/rules) introduced in Phase 1.
 */
export function formatResults(results: ScopedSearchResult[]): string {
  const lines: string[] = [];
  lines.push(`--- [teamai:recall:start] --- (${results.length} result${results.length !== 1 ? 's' : ''})`);
  lines.push('');

  for (let i = 0; i < results.length; i++) {
    const { entry, score, scope, learningsBase, sources, matchedTerms, missingTerms } = results[i];
    const voteStr = entry.votes > 0 ? ` ★${entry.votes}` : '';
    const scopeStr = scope ? ` [${scope}]` : '';
    // Phase 1: prepend a [type] tag so callers can quickly tell which knowledge
    // bucket each hit came from. Falls back to no tag for legacy entries that
    // pre-date the schema bump (these are auto-rebuilt on the next pull).
    const typeTag = entry.type ? `[${entry.type}] ` : '';
    lines.push(`[${i + 1}/${results.length}] ${typeTag}${entry.title}${voteStr}${scopeStr}`);
    lines.push(`Author: ${entry.author || 'unknown'} | Date: ${entry.date || 'unknown'} | Score: ${score.toFixed(1)}`);
    if (entry.tags.length > 0) {
      lines.push(`Tags: ${entry.tags.join(', ')}`);
    }
    // Term coverage lets the caller judge relevance itself: a hit whose every
    // discriminating term is missing is topically adjacent, not an answer.
    // Score alone cannot express this.
    if (missingTerms && missingTerms.length > 0) {
      const matchedStr = matchedTerms && matchedTerms.length > 0 ? matchedTerms.join(', ') : 'none';
      lines.push(`Matched: ${matchedStr} | Missing: ${missingTerms.join(', ')}`);
    }
    const filePath = entry.path
      ? entry.path
      : learningsBase
        ? `${learningsBase}/${entry.filename}`
        : `~/.teamai/learnings/${entry.filename}`;
    lines.push(`File: ${filePath}`);
    if (sources && sources.length > 0) {
      lines.push(`Sources: ${sources.map((s) => s.desc ? `${s.path} (${s.desc})` : s.path).join(', ')}`);
    }
    if (entry.snippet) {
      lines.push(`Snippet: ${entry.snippet}`);
    }
    lines.push('');
  }

  const allRelated = new Set<string>();
  for (const r of results) {
    if (r.relatedFiles) {
      for (const f of r.relatedFiles) {
        allRelated.add(f);
      }
    }
  }
  if (allRelated.size > 0) {
    const capped = [...allRelated].slice(0, 10);
    lines.push('--- Candidate change files ---');
    for (const f of capped) {
      lines.push(`- ${f}`);
    }
    if (allRelated.size > 10) {
      lines.push(`  (${allRelated.size - 10} more omitted)`);
    }
    lines.push('');
  }

  lines.push('--- [teamai:recall:end] ---');
  lines.push('');
  lines.push('以上内容来自团队知识库，仅供参考。如需详细信息，请用 Read 工具读取对应文件。');
  return lines.join('\n');
}

/**
 * Auto-upvote: after a successful search, increment recalled_count for each
 * returned doc using the V2 dual-counter system.
 */
export async function autoUpvote(
  results: SearchResult[],
  username: string,
  _repoPath: string,
): Promise<void> {
  if (results.length === 0) return;

  try {
    const { incrementRecalled } = await import('./votes.js');
    const votesDir = getVotesLocalDir();
    const localVotePath = path.join(votesDir, `${username}.yaml`);
    await ensureDir(votesDir);

    const docIds = results.map((r) => r.entry.filename.replace(/\.md$/i, ''));
    await incrementRecalled(localVotePath, docIds);
    log.debug(`autoUpvote: incremented recalled_count for ${docIds.length} doc(s)`);
  } catch (e) {
    log.error(`autoUpvote failed: ${(e as Error).message}`);
  }
}

/**
 * Load or build a search index for a given scope config.
 *
 * - user scope: learnings 在 pull 时同步到 ~/.teamai/learnings/，索引存 ~/.teamai/search-index.json
 * - project scope: learnings 只存在于 git repo 中（pull 不同步），索引存 <projectRoot>/.teamai/search-index.json
 *
 * 返回索引和 learnings 文件的实际基础路径（供 formatResults 输出正确的 File: 路径）。
 */
async function loadOrBuildScopeIndex(
  localConfig: LocalConfig,
  scopeLabel: 'user' | 'project',
): Promise<{ index: SearchIndex; learningsBase: string } | null> {
  const teamaiHome = localConfig.scope === 'project' && localConfig.projectRoot
    ? getTeamaiHome('project', localConfig.projectRoot)
    : getTeamaiHome('user');
  const indexPath = path.join(teamaiHome, 'search-index.json');

  // user scope: learnings 已被 pull 同步到 ~/.teamai/learnings/
  // project scope: learnings 只在 repo.localPath/learnings/ 中
  const localLearningsDir = path.join(teamaiHome, 'learnings');
  const repoLearningsDir = path.join(localConfig.repo.localPath, 'learnings');

  // 确定实际 learnings 目录：user scope 优先用本地副本，project scope 只用 repo
  let effectiveLearningsDir: string | null = null;
  if (scopeLabel === 'user' && await pathExists(localLearningsDir)) {
    effectiveLearningsDir = localLearningsDir;
  } else if (await pathExists(repoLearningsDir)) {
    effectiveLearningsDir = repoLearningsDir;
  }

  let index = await loadIndex(indexPath);

  // Auto-rebuild legacy / missing indexes (Phase 1 schema bump): the old
  // index only covered learnings, the new one covers four categories. Same
  // condition triggers rebuild when the file is missing entirely.
  const needsRebuild = !index || isLegacyIndex(index);
  if (needsRebuild && (effectiveLearningsDir || await pathExists(path.join(localConfig.repo.localPath, 'docs')) || await pathExists(path.join(localConfig.repo.localPath, 'rules')) || await pathExists(path.join(localConfig.repo.localPath, 'skills')))) {
    const votesDir = path.join(localConfig.repo.localPath, 'votes');
    const votesExist = await pathExists(votesDir);
    const docsDir = path.join(localConfig.repo.localPath, 'docs');
    const rulesDir = path.join(localConfig.repo.localPath, 'rules');
    const skillsDir = path.join(localConfig.repo.localPath, 'skills');
    const repoCodebaseDir = path.join(localConfig.repo.localPath, 'docs', 'team-codebase');
    const codebaseDir = await pathExists(repoCodebaseDir) ? repoCodebaseDir : undefined;
    try {
      await buildIndex({
        learningsDir: effectiveLearningsDir ?? undefined,
        docsDir: await pathExists(docsDir) ? docsDir : undefined,
        rulesDir: await pathExists(rulesDir) ? rulesDir : undefined,
        skillsDir: await pathExists(skillsDir) ? skillsDir : undefined,
        codebaseDir,
        votesDir: votesExist ? votesDir : undefined,
        indexPath,
      });
      index = await loadIndex(indexPath);
    } catch (e) {
      log.debug(`Index build failed for ${scopeLabel}: ${(e as Error).message}`);
    }
  }

  if (!index) return null;

  // learningsBase: 实际文件所在路径，用于输出给用户/AI 读取
  const learningsBase = effectiveLearningsDir ?? localLearningsDir;
  return { index, learningsBase };
}

/**
 * Handle `teamai recall <query>`.
 *
 * Scope isolation (issue #73) remains the default. A project with
 * `inheritUserScope` enabled searches the project index first, followed by the
 * user index. Displays ranked results and auto-upvotes returned documents.
 */
export async function recall(
  query: string,
  options: GlobalOptions & { depth?: 'route' | 'context' | 'lookup'; check?: boolean },
): Promise<void> {
  const emitCheckVerdict = (score: number, isCodebaseHit = false, baseline = 1, topResult?: ScopedSearchResult): void => {
    const rounded = Math.round(score * 10) / 10;
    const verdict = isRelevantScore(score, isCodebaseHit, baseline) ? 'RELEVANT' : 'NOT_RELEVANT';
    let line = `${verdict} score=${rounded.toFixed(1)}`;
    // Emit the cutoff too: a bare score is uninterpretable by the caller.
    const cutoff = isCodebaseHit
      ? CODEBASE_RELEVANCE_THRESHOLD
      : Math.max((baseline > 0 ? baseline : 1) * LEARNINGS_RELEVANCE_RATIO, LEARNINGS_ABSOLUTE_FLOOR);
    line += ` threshold=${(Math.round(cutoff * 10) / 10).toFixed(1)}`;
    if (verdict === 'RELEVANT' && topResult) {
      line += ` title="${topResult.entry.title}"`;
      // Term coverage: RELEVANT means "worth reading files", not "covers your
      // subject". Missing terms let the caller make that second call itself.
      if (topResult.matchedTerms && topResult.matchedTerms.length > 0) {
        line += ` matched=${topResult.matchedTerms.join(',')}`;
      }
      if (topResult.missingTerms && topResult.missingTerms.length > 0) {
        line += ` missing=${topResult.missingTerms.join(',')}`;
      }
      if (topResult.sources && topResult.sources.length > 0) {
        const srcStr = topResult.sources.map((s) => s.desc ? `${s.path}(${s.desc})` : s.path).join(',');
        line += ` sources=${srcStr}`;
      }
    }
    process.stdout.write(`${line}\n`);
  };

  if (!query || !query.trim()) {
    if (options.check) {
      emitCheckVerdict(0);
      return;
    }
    log.error('Usage: teamai recall <query>');
    log.info('Example: teamai recall "api timeout"');
    return;
  }

  const VALID_DEPTHS = new Set(['route', 'context', 'lookup']);
  if (options.depth && !VALID_DEPTHS.has(options.depth)) {
    log.warn(`Invalid --depth "${options.depth}", falling back to "context". Valid: route, context, lookup`);
    options.depth = 'context';
  }

  // Scope isolation (issue #73) remains the default. Projects may explicitly
  // opt into searching the user index after the project index.
  const scopeIndexes: Array<{ index: SearchIndex; scope: 'user' | 'project'; config: LocalConfig; learningsBase: string }> = [];

  let projectConfig: LocalConfig | null = null;
  try {
    projectConfig = await detectProjectConfig();
  } catch {
    log.debug('recall: project scope detection failed');
  }

  if (projectConfig) {
    // Project mode: project scope first.
    try {
      const result = await loadOrBuildScopeIndex(projectConfig, 'project');
      if (result && result.index.entries.length > 0) {
        scopeIndexes.push({ index: result.index, scope: 'project', config: projectConfig, learningsBase: result.learningsBase });
      }
    } catch {
      log.debug('recall: project scope not available');
    }

    if (projectConfig.inheritUserScope === true) {
      try {
        const userConfig = await loadLocalConfigForScope('user');
        if (userConfig) {
          const result = await loadOrBuildScopeIndex(userConfig, 'user');
          if (result && result.index.entries.length > 0) {
            scopeIndexes.push({ index: result.index, scope: 'user', config: userConfig, learningsBase: result.learningsBase });
          }
        }
      } catch {
        log.debug('recall: inherited user scope not available');
      }
    }
  } else {
    // User mode: user scope only.
    try {
      const { localConfig: userConfig } = await requireInit();
      const result = await loadOrBuildScopeIndex(userConfig, 'user');
      if (result && result.index.entries.length > 0) {
        scopeIndexes.push({ index: result.index, scope: 'user', config: userConfig, learningsBase: result.learningsBase });
      }
    } catch {
      log.debug('recall: user scope not available');
    }
  }

  // Codebase knowledge stays bound to the active project even when its search
  // index is empty and only an inherited user index is available.
  const wikiConfig = projectConfig ?? scopeIndexes[0]?.config;
  const wikiRoot = wikiConfig
    ? path.join(wikiConfig.repo.localPath, 'teamwiki')
    : path.join(process.cwd(), '.teamai', 'team-repo', 'teamwiki');
  const hasWiki = await pathExists(wikiRoot);
  if (scopeIndexes.length === 0 && !hasWiki) {
    if (options.check) {
      emitCheckVerdict(0);
      return;
    }
    log.info('No learnings available. Run `teamai pull` first to sync team knowledge.');
    return;
  }

  // Merge: search each scope index, tag results with scope, then combine & sort
  const allResults: ScopedSearchResult[] = [];
  const seenEntries = new Set<string>();
  const projectEntryKeys = new Set(
    scopeIndexes
      .filter(({ scope }) => scope === 'project')
      .flatMap(({ index }) => index.entries.map((entry) => `${entry.type}:${entry.filename}`)),
  );

  const idfBaseline = computeIdfBaseline(scopeIndexes.map((s) => s.index));

  for (const { index, scope, learningsBase } of scopeIndexes) {
    const results = search(query, index);
    for (const r of results) {
      // A project entry shadows the same logical user entry even when the
      // project version does not match this particular query. This prevents a
      // stale inherited copy from leaking through after a project override.
      const entryKey = `${r.entry.type}:${r.entry.filename}`;
      if (scope === 'user' && projectEntryKeys.has(entryKey)) continue;
      if (!seenEntries.has(entryKey)) {
        seenEntries.add(entryKey);
        allResults.push({ ...r, scope, learningsBase });
      }
    }
  }

  // ── Codebase knowledge graph recall ──────────────────────
  try {
    const codeResults = await queryCodeKnowledge(query, { wikiRoot, limit: 3, depth: options.depth });
    // B11 fix: log-dampening instead of min-max normalization
    // Codebase BM25 scores (0-50+) mapped to learnings scale (0-10) via log curve
    for (const cr of codeResults) {
      allResults.push({
        entry: {
          filename: cr.page,
          title: cr.title,
          author: '',
          date: '',
          tags: [],
          tokens: [],
          votes: 0,
          type: 'docs' as const,
          domain: 'technical' as const,
          path: path.join(wikiRoot, cr.page),
          snippet: cr.snippet,
        },
        score: Math.min(10, Math.log2(cr.score + 1) * 2),
        scope: projectConfig ? 'project' : 'user',
        learningsBase: wikiRoot,
        sources: cr.sources,
        relatedFiles: cr.relatedFiles,
        fromCodebase: true,
      });
    }
  } catch {
    log.warn('recall: code graph retrieval unavailable, run teamai codebase --lint to diagnose');
  }

  // Re-sort merged results by score descending, then date descending
  // TODO(cross-scale): learnings scores are unbounded TF-IDF sums that grow with
  // log(N), while codebase scores are log-compressed into [0,10]. Sorting them
  // directly compares different scales — as the corpus grows, learnings hits
  // increasingly crowd out codebase hits regardless of true relevance. Fixing
  // this properly means normalizing learnings scores against the IDF baseline
  // before the merge (related to the per-domain IDF work).
  allResults.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.entry.date || '').localeCompare(a.entry.date || '');
  });

  if (options.check) {
    const top = allResults.length > 0 ? allResults[0] : undefined;
    emitCheckVerdict(top?.score ?? 0, top?.fromCodebase ?? false, idfBaseline, top);
    return;
  }

  // Limit to top 5
  const topResults = allResults.slice(0, 5);

  // Record quality signal for contribute-check's knowledge-gap detection.
  // Best-effort and independent of dry-run/verbosity — misses matter too.
  if (process.env.TEAMAI_RECALL_DISABLED !== '1') {
    recordRecallQuality(deriveSessionId({}), topResults);
  }

  if (topResults.length === 0) {
    log.info(`No matching learnings found for "${query}".`);
    return;
  }

  // Output results (STDOUT — AI reads this)
  const output = formatResults(topResults);
  process.stdout.write(output + '\n');

  // Auto-upvote (best-effort, non-blocking for dry-run). Vote deltas currently
  // share one HOME-level store, so layered project mode records only active
  // project results. Inherited user hits remain read-only to avoid attributing
  // their votes to the project team during the next report.
  if (!options.dryRun) {
    const voteScopes = projectConfig
      ? scopeIndexes.filter((scopeInfo) => scopeInfo.scope === 'project')
      : scopeIndexes;
    for (const scopeInfo of voteScopes) {
      const scopeResults = topResults.filter(r => r.scope === scopeInfo.scope);
      if (scopeResults.length > 0) {
        try {
          await autoUpvote(scopeResults, scopeInfo.config.username, scopeInfo.config.repo.localPath);
        } catch (e) {
          log.error(`autoUpvote skipped for ${scopeInfo.scope}: ${(e as Error).message}`);
        }
      }
    }
  }
}
