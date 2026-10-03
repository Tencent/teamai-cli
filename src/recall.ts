import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { requireInit, detectProjectConfig, describeUnreadableConfig, loadLocalConfigForScope } from './config.js';
import { loadIndex, buildIndex, indexInMemory, search, isLegacyIndex } from './utils/search-index.js';
import type { BuildIndexOptions, SearchResult } from './utils/search-index.js';
import { ensureDir, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, SearchIndex, LocalConfig, KnowledgeDomain } from './types.js';
import { getProjectSearchIndexPath, getUserSearchIndexPath, getVotesDir } from './types.js';
import { queryCodeKnowledge } from './code-knowledge-recall.js';
import type { SourceAnchor } from './code-knowledge-recall.js';
import { recordRecallQuality } from './recall-quality.js';
import { agentSessionFromEnv, deriveSessionId } from './utils/session-id.js';
import type { EnvAgentSession } from './utils/session-id.js';

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
 * When a caller needs one aggregate baseline across multiple scopes, use the
 * largest domain corpus among the df-bearing indexes. Recall ranking carries
 * each result's domain baseline so unrelated domains cannot distort its threshold.
 *
 * Legacy indexes (no df map) are excluded from the N computation because their
 * presence would otherwise inflate maxEntries and raise the threshold against
 * results that were actually scored against a small modern index.
 *
 * @returns IDF of a single-occurrence token (>= 1); 1 for legacy indexes without a df map.
 */
export function computeIdfBaseline(indexes: SearchIndex[], domain?: KnowledgeDomain): number {
  let maxEntries = 0;
  for (const idx of indexes) {
    if (!idx.df) continue;                    // legacy index: its N is not used for IDF anyway
    if (idx.dfByDomain) {
      const domainSizes: Partial<Record<KnowledgeDomain, number>> = {};
      for (const entry of idx.entries) {
        const entryDomain = entry.domain ?? 'neutral';
        domainSizes[entryDomain] = (domainSizes[entryDomain] ?? 0) + 1;
      }
      const entryCount = domain
        ? domainSizes[domain] ?? 0
        : Math.max(0, ...Object.values(domainSizes));
      if (entryCount > maxEntries) maxEntries = entryCount;
    } else if (idx.entries.length > maxEntries) {
      // v6 and older indexes scored every entry against the global corpus.
      maxEntries = idx.entries.length;
    }
  }
  if (maxEntries === 0) return 1;
  return Math.log((maxEntries + 1) / 2) + 1;
}

/**
 * Put learnings scores on the bounded scale used by codebase graph results.
 * The relevance threshold is the corpus-aware reference point: a learnings
 * hit at that threshold maps to 4, matching the codebase relevance threshold.
 * This prevents corpus growth from changing which source wins the merged sort.
 */
export function normalizeLearningsScoreForRanking(score: number, idfBaseline: number): number {
  if (score <= 0) return 0;
  const baseline = idfBaseline > 0 ? idfBaseline : 1;
  const threshold = Math.max(baseline * LEARNINGS_RELEVANCE_RATIO, LEARNINGS_ABSOLUTE_FLOOR);
  return Math.min(10, Math.max(0, 4 + 2 * Math.log2(score / threshold)));
}

/** Search result with scope label for merged output. */
interface ScopedSearchResult extends SearchResult {
  scope?: 'user' | 'project';
  /** IDF baseline of the index that produced this result. */
  idfBaseline?: number;
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
//      │   └─ 0 results? → "No matching learnings found … run=<id>"
//      │
//      ├─ formatResults(results)
//      │   └─ STDOUT (AI-consumable format)
//      │
//      ├─ recordRecallQuality(sessionId, results)
//      │   └─ ~/.teamai/sessions/<sid>-recall-cache.json
//      │      (read by contribute-check's knowledge-gap detection)
//      │
//      ├─ recordRun(activeConfig, results, session, caller)
//      │   └─ <dataHome>/dashboard/recall.jsonl, run id printed on the start line
//      │      (joined to the session's reads at Stop, recall-adoption.ts)
//      │
//      └─ autoUpvote(results, config)
//          └─ write getVotesDir(config)/<user>.yaml (local, per scope)
//              (pushed by that scope's next report)
//

/**
 * Format search results for CLI / AI consumption.
 *
 * Output uses delimiters so AI treats content as reference, not instruction.
 * Each entry includes a scope label (user/project) when source is known and
 * a type tag (skills/learnings/docs/rules) introduced in Phase 1.
 */
/**
 * The path a reader can actually open.
 *
 * The index stores the absolute path a file had when it was indexed, and a
 * worktree that is removed and rebuilt leaves that pointing nowhere. Whoever
 * reads this output, an agent most of the time, would be handed a path that
 * does not exist, so fall back to the same file under the current learnings
 * root before giving up.
 */
function resolveReadablePath(
  indexedPath: string | undefined,
  filename: string,
  learningsBase?: string,
): string {
  if (indexedPath && existsSync(indexedPath)) return indexedPath;
  const underBase = learningsBase ? path.join(learningsBase, filename) : null;
  if (underBase && existsSync(underBase)) return underBase;
  // learnings-root ok: a display-only hint when nothing on disk matches
  return indexedPath ?? underBase ?? path.join('~', '.teamai', 'learnings', filename);
}

/** The `File:` path printed for a result. */
function printedPath(result: ScopedSearchResult): string {
  return resolveReadablePath(result.entry.path, result.entry.filename, result.learningsBase);
}

/** The id a result's votes are kept under: its index filename, not the file's basename. */
function voteKey(result: SearchResult): string {
  return result.entry.filename.replace(/\.md$/i, '');
}

/**
 * `runId`, when the run was recorded, follows the result count on the start
 * line. Older CLIs find the region by the prefix before it (#884).
 */
export function formatResults(results: ScopedSearchResult[], runId?: string): string {
  const lines: string[] = [];
  lines.push(`--- [teamai:recall:start] --- (${results.length} result${results.length !== 1 ? 's' : ''})${runId ? ` run=${runId}` : ''}`);
  lines.push('');

  for (let i = 0; i < results.length; i++) {
    const { entry, score, scope, sources, matchedTerms, missingTerms } = results[i];
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
    lines.push(`File: ${printedPath(results[i])}`);
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
  lines.push('The above comes from the team knowledge base and is for reference only. Use the Read tool to open the listed files for details.');
  return lines.join('\n');
}

/**
 * Auto-upvote: after a successful search, increment recalled_count for each
 * returned doc using the V2 dual-counter system.
 */
export async function autoUpvote(
  results: SearchResult[],
  config: LocalConfig,
): Promise<void> {
  if (results.length === 0) return;

  try {
    const { incrementRecalled } = await import('./votes.js');
    const votesDir = getVotesDir(config);
    const localVotePath = path.join(votesDir, `${config.username}.yaml`);
    await ensureDir(votesDir);

    const docIds = results.map(voteKey);
    // Best-effort: a contended lock (rare) simply skips this recall bump. Log
    // honestly per the actual outcome — the previous message claimed success
    // even when the locked write was skipped (issue #723 review).
    const applied = await incrementRecalled(localVotePath, docIds);
    if (applied) {
      log.debug(`autoUpvote: incremented recalled_count for ${docIds.length} doc(s)`);
    } else {
      log.debug(`autoUpvote: skipped recalled_count bump for ${docIds.length} doc(s) (votes file busy)`);
    }
  } catch (e) {
    log.error(`autoUpvote failed: ${(e as Error).message}`);
  }
}

/**
 * Append this run to the active scope's recall log: the session the agent's
 * environment names (its agent family, and whether it was the only
 * candidate), the `--caller` that ran it and each returned doc as
 * printed, never the query. While a project is active an inherited user-scope
 * doc is not eligible: it stays read-only, as for recalled_count. Returns the
 * run id, or undefined when the line could not be written, so no id is printed
 * that nothing can join.
 */
async function recordRun(
  config: LocalConfig,
  results: ScopedSearchResult[],
  session: EnvAgentSession,
  caller: string | undefined,
  projectActive: boolean,
): Promise<string | undefined> {
  const { appendRecallLine, recallLogPath } = await import('./recall-log.js');
  const run = randomUUID();
  try {
    await appendRecallLine(config, {
      kind: 'run',
      ts: new Date().toISOString(),
      run,
      session: session.id ?? null,
      ...(session.agent ? { agent: session.agent } : {}),
      via: session.id ? 'env' : 'none',
      unambiguous: session.unambiguous,
      ...(caller ? { caller } : {}),
      docs: results.map((r) => {
        const scope = r.scope ?? config.scope;
        return {
          key: voteKey(r),
          type: r.entry.type,
          scope,
          path: printedPath(r),
          score: Math.round(r.score * 10) / 10,
          eligible: !(projectActive && scope === 'user'),
        };
      }),
    });
    return run;
  } catch (e) {
    log.warn(`Recall could not record this run in ${recallLogPath(config)}: ${(e as Error).message}. `
      + 'Docs opened after it will not be upvoted.');
    return undefined;
  }
}

/**
 * Load or build a search index for a given scope config.
 *
 * - user scope: learnings 在 pull 时同步到 ~/.teamai/learnings/，索引存 ~/.teamai/search-index.json
 * - project scope: learnings live only in the git repo (pull does not mirror them); the index is at getProjectSearchIndexPath
 *
 * 返回索引和 learnings 文件的实际基础路径（供 formatResults 输出正确的 File: 路径）。
 * `build-failed` when there was nothing to load and the build failed, which it
 * has already said. With `dryRun`, a rebuild is searched in memory, not saved.
 */
async function loadOrBuildScopeIndex(
  localConfig: LocalConfig,
  scopeLabel: 'user' | 'project',
  dryRun = false,
): Promise<{ index: SearchIndex; learningsBase: string } | 'build-failed' | null> {
  // Route the project branch through getProjectSearchIndexPath (partition-aware,
  // per checkout in self mode), but preserve the historical fallback to ~/.teamai
  // when a project scope config lacks projectRoot: getDataHome → getTeamaiHome throws in that
  // case, and here the exception surfaces as a misleading "No learnings
  // available". A ~/.teamai/config.yaml with scope:project but no projectRoot is
  // permitted by LocalConfigSchema and not backfilled by loadLocalConfig.
  const indexPath = localConfig.scope === 'project' && localConfig.projectRoot
    ? getProjectSearchIndexPath(localConfig)
    : getUserSearchIndexPath();

  // Learnings come from several roots: what is queued but not published yet,
  // what is on the learnings branch, the machine-local mirror, and the corpus
  // the team wrote before the split. Picking one of them, as this used to,
  // silently returned less.
  const { pendingLearningsDir } = await import('./utils/pending-learnings.js');
  const { learningsRoots } = await import('./utils/learnings-roots.js');
  const roots = learningsRoots(localConfig);
  const indexLearningsDirs = [pendingLearningsDir(localConfig), ...roots.read];

  // The first root that exists is where `File:` paths point when an index entry
  // predates absolute paths.
  let effectiveLearningsDir: string | null = null;
  for (const dir of indexLearningsDirs) {
    if (await pathExists(dir)) { effectiveLearningsDir = dir; break; }
  }

  let index = await loadIndex(indexPath);

  // Auto-rebuild legacy / missing indexes (Phase 1 schema bump): the old
  // index only covered learnings, the new one covers four categories. Same
  // condition triggers rebuild when the file is missing entirely.
  const needsRebuild = !index || isLegacyIndex(index);
  if (needsRebuild && (effectiveLearningsDir || await pathExists(path.join(localConfig.repo.localPath, 'docs')) || await pathExists(path.join(localConfig.repo.localPath, 'rules')) || await pathExists(path.join(localConfig.repo.localPath, 'skills')))) {
    // Votes live on the teamai-reports orphan branch for non-HTTP repos;
    // getReportsDir points at the worktree (sibling of the clone in git-kind).
    // If it isn't materialized yet, votesExist is false and vote-weighted
    // ranking is simply skipped (graceful degradation — leftover default-branch
    // votes/ are not used).
    // Not another repository's reports checkout (#808).
    const { indexableVotesDir } = await import('./utils/reports-branch.js');
    const votesDir = await indexableVotesDir(localConfig);
    const votesExist = votesDir !== undefined && await pathExists(votesDir);
    const docsDir = path.join(localConfig.repo.localPath, 'docs');
    const rulesDir = path.join(localConfig.repo.localPath, 'rules');
    const repoCodebaseDir = path.join(localConfig.repo.localPath, 'docs', 'team-codebase');
    const hasLegacyCodebase = await pathExists(repoCodebaseDir);
    if (hasLegacyCodebase) {
      log.warn(`Legacy 'docs/team-codebase' is no longer indexed. Migrate to 'teamwiki/' for code-knowledge recall.`);
    }
    // Same namespaces pull indexes by. Omitting them, as this used to, dropped
    // every project-private learning from a recall-triggered rebuild.
    // A manifest that cannot be read leaves out what depends on it, never the
    // learnings, and recall says so once: the index it builds is saved (#823).
    const { resolveActiveLearningsNamespaces } = await import('./projects.js');
    const { deliveredIndexSources } = await import('./resources/desired.js');
    // Empty lists, not undefined: undefined would index the whole trees.
    const nothingDelivered: Pick<BuildIndexOptions, 'docFiles' | 'ruleFiles' | 'skills'> = {
      docFiles: [], ruleFiles: [], skills: { kind: 'dirs', dirs: [] },
    };
    const projects = localConfig.projects ?? [];
    let learningsNamespaces: string[] = [];
    let delivered: Pick<BuildIndexOptions, 'docFiles' | 'ruleFiles' | 'skills'> | undefined;
    try {
      learningsNamespaces = await resolveActiveLearningsNamespaces(localConfig.repo.localPath, projects);
    } catch (e) {
      // The shared root only: every namespace would expose other projects' learnings.
      // What pull delivers reads the same file, so it is left out in the same warning.
      log.warn(`Recall indexed the shared learnings only: ${e instanceof Error ? e.message : String(e)}. `
        + `The learnings of ${projects.length === 1 ? 'project' : 'projects'} ${projects.join(', ')}, and docs, rules and skills, `
        + 'stay out of recall until manifest/projects.yaml is fixed and `teamai pull` rebuilds the index; `teamai doctor` shows the problem.');
      delivered = nothingDelivered;
    }
    try {
      delivered ??= await deliveredIndexSources(localConfig);
    } catch (e) {
      log.warn(`Recall indexed learnings only: ${e instanceof Error ? e.message : String(e)}. `
        + 'Docs, rules and skills stay out of recall until the team manifest is fixed and `teamai pull` rebuilds the index; '
        + '`teamai doctor` shows the problem.');
      delivered = nothingDelivered;
    }
    // With no skills to keep (no index, or an older one), a collision would index none quietly.
    if (delivered.skills?.kind === 'keep-indexed' && !index?.entries.some((entry) => entry.type === 'skills')) {
      log.warn(`Skills stay out of recall: ${delivered.skills.reason}. Fix the collision and run \`teamai pull\`.`);
    }

    // Smaller by design: an older index kept by the shrink guard would serve what the warning left out.
    const partial = delivered === nothingDelivered;
    try {
      // Without another repository's learnings checkout, if one sits where
      // this project's would (#808). The probe runs only here, when an index
      // is built, never on a plain recall.
      const { indexableLearningsRoots } = await import('./utils/learnings-roots.js');
      const buildOptions: BuildIndexOptions = {
        learningsDirs: [pendingLearningsDir(localConfig), ...await indexableLearningsRoots(localConfig)],
        learningsNamespaces,
        docsDir: await pathExists(docsDir) ? docsDir : undefined,
        rulesDir: await pathExists(rulesDir) ? rulesDir : undefined,
        // The docs and skills pull delivers here, not the whole trees (#707).
        ...delivered,
        codebaseDir: undefined, // codebase now served by teamwiki/ graph engine
        votesDir: votesExist ? votesDir : undefined,
        indexPath,
        partial,
      };
      if (dryRun) {
        index = await indexInMemory(buildOptions);
      } else {
        await buildIndex(buildOptions);
        index = await loadIndex(indexPath);
      }
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      if (partial && index) {
        // The index on disk predates the broken manifest and holds what the warning above left out.
        log.warn(`Recall could not build the ${scopeLabel} search index: ${cause}. `
          + `Recall skips the older index at ${indexPath}, which would return what the manifest error leaves out. `
          + 'Resolve that error, fix the manifest, and run `teamai pull` to rebuild it.');
        return 'build-failed';
      }
      log.warn(`Recall could not build the ${scopeLabel} search index: ${cause}`);
      if (!index) return 'build-failed';
    }
  }

  if (!index) return null;

  // learningsBase: 实际文件所在路径，用于输出给用户/AI 读取
  const learningsBase = effectiveLearningsDir ?? roots.write;
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
  options: GlobalOptions & {
    depth?: 'route' | 'context' | 'lookup';
    check?: boolean;
    /** Internal: `teamai-recall` when the recall subagent runs it, stored on the run. */
    caller?: string;
  },
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

  const noQuery = !query || !query.trim();
  if (noQuery && !options.check) {
    log.error('Usage: teamai recall <query>');
    log.info('Example: teamai recall "api timeout"');
    return;
  }

  let projectConfig: LocalConfig | null = null;
  const unreadable: string[] = [];
  // A detection that throws still searches what loads next, but its votes must
  // not reach that scope's team (#787).
  let projectUnreadable = false;
  try {
    // The flag reaches detection: a bare load migrates the legacy role config
    // in place, which would write under --dry-run (#850).
    projectConfig = await detectProjectConfig(undefined, (configPath, error) => { unreadable.push(`${configPath}: ${error}`); }, { dryRun: options.dryRun });
  } catch (e) {
    // A cwd that no longer exists holds no project: user scope, as in
    // resolveConfigForDir.
    const gone = typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';
    if (!gone) projectUnreadable = true;
    log.debug('recall: project scope detection failed');
  }
  // Detection skips a project config it cannot read and answers with what
  // loads next — a legacy `.teamai/` that may name another team, or the user
  // scope — so recall would search and record for a team this project may not
  // belong to (#796). An empty result or NOT_RELEVANT would tell the agent the
  // team has no knowledge, so refuse instead: the rule `pull` follows (#784).
  const [problem] = unreadable;
  if (problem !== undefined) {
    log.error(`Nothing was searched: ${describeUnreadableConfig(problem)}`);
    process.exitCode = 1;
    return;
  }

  if (noQuery) {
    emitCheckVerdict(0);
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
  // A failed build has named its cause; "no learnings" would misdirect to pull.
  let indexBuildFailed = false;

  if (projectConfig) {
    // Project mode: project scope first.
    try {
      const result = await loadOrBuildScopeIndex(projectConfig, 'project', options.dryRun);
      if (result === 'build-failed') indexBuildFailed = true;
      else if (result && result.index.entries.length > 0) {
        scopeIndexes.push({ index: result.index, scope: 'project', config: projectConfig, learningsBase: result.learningsBase });
      }
    } catch (e) {
      log.debug(`recall: project scope not available: ${(e as Error).message}`);
    }

    if (projectConfig.inheritUserScope === true) {
      try {
        const userConfig = await loadLocalConfigForScope('user', undefined, { dryRun: options.dryRun });
        if (userConfig) {
          const result = await loadOrBuildScopeIndex(userConfig, 'user', options.dryRun);
          if (result === 'build-failed') indexBuildFailed = true;
          else if (result && result.index.entries.length > 0) {
            scopeIndexes.push({ index: result.index, scope: 'user', config: userConfig, learningsBase: result.learningsBase });
          }
        }
      } catch (e) {
        log.debug(`recall: inherited user scope not available: ${(e as Error).message}`);
      }
    }
  } else {
    // User mode: user scope only.
    try {
      const { localConfig: userConfig } = await requireInit({ dryRun: options.dryRun });
      const result = await loadOrBuildScopeIndex(userConfig, 'user', options.dryRun);
      if (result === 'build-failed') indexBuildFailed = true;
      else if (result && result.index.entries.length > 0) {
        scopeIndexes.push({ index: result.index, scope: 'user', config: userConfig, learningsBase: result.learningsBase });
      }
    } catch (e) {
      log.debug(`recall: user scope not available: ${(e as Error).message}`);
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
    if (!indexBuildFailed) log.info('No learnings available. Run `teamai pull` first to sync team knowledge.');
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
    // Keep every candidate until domain-specific scores are normalized below.
    const results = search(query, index, index.entries.length);
    for (const r of results) {
      // A project entry shadows the same logical user entry even when the
      // project version does not match this particular query. This prevents a
      // stale inherited copy from leaking through after a project override.
      const entryKey = `${r.entry.type}:${r.entry.filename}`;
      if (scope === 'user' && projectEntryKeys.has(entryKey)) continue;
      if (!seenEntries.has(entryKey)) {
        seenEntries.add(entryKey);
        allResults.push({
          ...r,
          scope,
          learningsBase,
          idfBaseline: computeIdfBaseline([index], r.entry.domain ?? 'neutral'),
        });
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

  // Re-sort merged results by normalized score descending, then date descending.
  // Keep each result's original score for --check, quality tracking, and output.
  const rankingScore = (result: ScopedSearchResult): number => result.fromCodebase
    ? result.score
    : normalizeLearningsScoreForRanking(result.score, result.idfBaseline ?? idfBaseline);
  allResults.sort((a, b) => {
    const scoreDelta = rankingScore(b) - rankingScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    return (b.entry.date || '').localeCompare(a.entry.date || '');
  });

  if (options.check) {
    const top = allResults.length > 0 ? allResults[0] : undefined;
    emitCheckVerdict(top?.score ?? 0, top?.fromCodebase ?? false, top?.idfBaseline ?? idfBaseline, top);
    return;
  }

  // Limit to top 5
  const topResults = allResults.slice(0, 5);

  // Record quality signal for contribute-check's knowledge-gap detection,
  // misses included. The run, a miss included, goes to the active scope's
  // recall log, where the hooks join it to the docs the session then opens
  // (#884). Neither under --dry-run (#900); the log not where votes must not
  // reach the team (#787).
  let runId: string | undefined;
  if (process.env.TEAMAI_RECALL_DISABLED !== '1' && !options.dryRun) {
    const session = await agentSessionFromEnv();
    recordRecallQuality(session.id ?? deriveSessionId({}), topResults);
    const activeConfig = projectConfig ?? scopeIndexes[0]?.config;
    if (activeConfig && !projectUnreadable) {
      runId = await recordRun(activeConfig, topResults, session, options.caller, projectConfig !== null);
    }
  }

  if (topResults.length === 0) {
    // The run id lets the hook claim a run with no hits too (#884).
    log.info(`No matching learnings found for "${query}".${runId ? ` run=${runId}` : ''}`);
    return;
  }

  // Output results (STDOUT — AI reads this)
  const output = formatResults(topResults, runId);
  process.stdout.write(output + '\n');

  // Auto-upvote (best-effort, non-blocking for dry-run). Each scope keeps its
  // own votes (#787); layered project mode records only active project results,
  // since the session belongs to the project. Inherited user hits remain
  // read-only.
  if (!options.dryRun && !projectUnreadable) {
    const voteScopes = projectConfig
      ? scopeIndexes.filter((scopeInfo) => scopeInfo.scope === 'project')
      : scopeIndexes;
    for (const scopeInfo of voteScopes) {
      const scopeResults = topResults.filter(r => r.scope === scopeInfo.scope);
      if (scopeResults.length > 0) {
        try {
          await autoUpvote(scopeResults, scopeInfo.config);
        } catch (e) {
          log.error(`autoUpvote skipped for ${scopeInfo.scope}: ${(e as Error).message}`);
        }
      }
    }
  }
}
