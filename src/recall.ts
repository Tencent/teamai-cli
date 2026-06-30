import path from 'node:path';
import YAML from 'yaml';
import { requireInit, detectProjectConfig } from './config.js';
import { loadIndex, buildIndex, search, isLegacyIndex } from './utils/search-index.js';
import type { SearchResult } from './utils/search-index.js';
import { readFileSafe, writeFile, ensureDir, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, UserVotes, SearchIndex, LocalConfig } from './types.js';
import { getTeamaiHome } from './types.js';
import { queryCodeKnowledge } from './code-knowledge-recall.js';
import type { CodeKnowledgeResult } from './code-knowledge-recall.js';

/** Resolve votes dir dynamically (respects HOME changes in tests). */
function getVotesLocalDir(): string {
  return `${process.env.HOME ?? ''}/.teamai/votes`;
}

/** Search result with scope label for merged output. */
interface ScopedSearchResult extends SearchResult {
  scope?: 'user' | 'project';
  /** Base path for learnings files (so AI can read the correct path). */
  learningsBase?: string;
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
    const { entry, score, scope, learningsBase } = results[i];
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
    // Prefer the absolute path captured at index build time when available
    // (Phase 1 entries from docs/rules/skills carry it); otherwise fall back
    // to the legacy ~/.teamai/learnings/<filename> rendering.
    const filePath = entry.path
      ? entry.path
      : learningsBase
        ? `${learningsBase}/${entry.filename}`
        : `~/.teamai/learnings/${entry.filename}`;
    lines.push(`File: ${filePath}`);
    lines.push('');
  }

  lines.push('--- [teamai:recall:end] ---');
  lines.push('');
  lines.push('以上内容来自团队知识库，仅供参考。如需详细信息，请用 Read 工具读取对应文件。');
  return lines.join('\n');
}

/**
 * Auto-upvote: record that the current user found these docs via recall.
 *
 * Idempotent: same user voting for the same doc multiple times has no effect.
 * Writes to both local (~/.teamai/votes/) and team repo (votes/) so the
 * next pull auto-report picks it up.
 */
export async function autoUpvote(
  results: SearchResult[],
  username: string,
  repoPath: string,
): Promise<void> {
  if (results.length === 0) return;

  try {
    // Read existing local votes
    const votesDir = getVotesLocalDir();
    const localVotePath = path.join(votesDir, `${username}.yaml`);
    await ensureDir(votesDir);

    let userVotes: UserVotes = { votes: {} };
    const existingContent = await readFileSafe(localVotePath);
    if (existingContent) {
      try {
        const parsed = YAML.parse(existingContent) as UserVotes | null;
        if (parsed?.votes) {
          userVotes = parsed;
        }
      } catch {
        log.debug('Corrupt local votes file, resetting');
      }
    }

    // Add new votes (idempotent — only add if not already present)
    const now = new Date().toISOString();
    let newVotes = 0;
    for (const result of results) {
      const docId = result.entry.filename.replace(/\.md$/i, '');
      if (!userVotes.votes[docId]) {
        userVotes.votes[docId] = { at: now };
        newVotes++;
      }
    }

    if (newVotes === 0) {
      log.debug('autoUpvote: all docs already voted, skipping write');
      return;
    }

    // Write to local votes dir only — repo copy is handled by
    // reportUsageToTeam() during `teamai pull`, which properly
    // commits the file. Writing directly to the repo leaves
    // uncommitted changes that block `git pull` in `teamai push`.
    const yamlContent = YAML.stringify(userVotes);
    await writeFile(localVotePath, yamlContent);

    log.debug(`autoUpvote: recorded ${newVotes} new vote(s) for ${username}`);
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
 * Searches both user and project scope learnings indexes, merges results,
 * and displays ranked results. Auto-upvotes returned documents.
 */
export async function recall(
  query: string,
  options: GlobalOptions & { depth?: 'route' | 'context' | 'lookup' },
): Promise<void> {
  if (!query || !query.trim()) {
    log.error('Usage: teamai recall <query>');
    log.info('Example: teamai recall "api timeout"');
    return;
  }

  // Collect indexes from both scopes (project first — when both scopes share
  // the same team repo, project wins dedup so results show project-local paths)
  const scopeIndexes: Array<{ index: SearchIndex; scope: 'user' | 'project'; config: LocalConfig; learningsBase: string }> = [];

  // Try project scope first (only when cwd has project-scope config)
  try {
    const projectConfig = await detectProjectConfig();
    if (projectConfig) {
      const result = await loadOrBuildScopeIndex(projectConfig, 'project');
      if (result && result.index.entries.length > 0) {
        scopeIndexes.push({ index: result.index, scope: 'project', config: projectConfig, learningsBase: result.learningsBase });
      }
    }
  } catch {
    log.debug('recall: project scope not available');
  }

  // Try user scope
  try {
    const { localConfig: userConfig } = await requireInit();
    const result = await loadOrBuildScopeIndex(userConfig, 'user');
    if (result && result.index.entries.length > 0) {
      scopeIndexes.push({ index: result.index, scope: 'user', config: userConfig, learningsBase: result.learningsBase });
    }
  } catch {
    log.debug('recall: user scope not available');
  }

  // Resolve teamwiki path from team-repo (prefer project scope, fallback to user scope)
  const wikiConfig = scopeIndexes[0]?.config;
  const wikiRoot = wikiConfig
    ? path.join(wikiConfig.repo.localPath, 'teamwiki')
    : path.join(process.cwd(), '.teamai', 'team-repo', 'teamwiki');
  const hasWiki = await pathExists(wikiRoot);
  if (scopeIndexes.length === 0 && !hasWiki) {
    log.info('No learnings available. Run `teamai pull` first to sync team knowledge.');
    return;
  }

  // Merge: search each scope index, tag results with scope, then combine & sort
  const allResults: ScopedSearchResult[] = [];
  const seenFilenames = new Set<string>();

  for (const { index, scope, learningsBase } of scopeIndexes) {
    const results = search(query, index);
    for (const r of results) {
      // Deduplicate by filename across scopes
      if (!seenFilenames.has(r.entry.filename)) {
        seenFilenames.add(r.entry.filename);
        allResults.push({ ...r, scope, learningsBase });
      }
    }
  }

  // ── Codebase knowledge graph recall ──────────────────────
  try {
    const codeResults = await queryCodeKnowledge(query, { wikiRoot, limit: 3, depth: options.depth });
    // B11: Normalize BM25 scores to 0-10 range before merging with learnings scores
    const maxCodeScore = codeResults.length > 0 ? Math.max(...codeResults.map(r => r.score)) : 1;
    const normalizer = maxCodeScore > 0 ? 10 / maxCodeScore : 1;
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
        },
        score: cr.score * normalizer, // B11: normalized to learnings score scale
        scope: 'project',
        learningsBase: wikiRoot,
      });
    }
  } catch {
    log.warn('recall: 代码图谱检索不可用，可运行 teamai codebase --lint 诊断');
  }

  // Re-sort merged results by score descending, then date descending
  allResults.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.entry.date || '').localeCompare(a.entry.date || '');
  });

  // Limit to top 5
  const topResults = allResults.slice(0, 5);

  if (topResults.length === 0) {
    log.info(`No matching learnings found for "${query}".`);
    return;
  }

  // Output results (STDOUT — AI reads this)
  const output = formatResults(topResults);
  process.stdout.write(output + '\n');

  // Auto-upvote (best-effort, non-blocking for dry-run)
  // 分 scope 写入各自的 repo，确保 vote 归属正确
  if (!options.dryRun) {
    for (const scopeInfo of scopeIndexes) {
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
