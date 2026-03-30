import path from 'node:path';
import YAML from 'yaml';
import { requireInit } from './config.js';
import { loadIndex, buildIndex, search } from './utils/search-index.js';
import type { SearchResult } from './utils/search-index.js';
import { readFileSafe, writeFile, ensureDir, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, UserVotes } from './types.js';
import { LEARNINGS_LOCAL_DIR } from './types.js';

/** Resolve votes dir dynamically (respects HOME changes in tests). */
function getVotesLocalDir(): string {
  return `${process.env.HOME ?? ''}/.teamai/votes`;
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
 */
function formatResults(results: SearchResult[]): string {
  const lines: string[] = [];
  lines.push(`--- [teamai:recall:start] --- (${results.length} result${results.length !== 1 ? 's' : ''})`);
  lines.push('');

  for (let i = 0; i < results.length; i++) {
    const { entry, score } = results[i];
    const voteStr = entry.votes > 0 ? ` ★${entry.votes}` : '';
    lines.push(`[${i + 1}/${results.length}] ${entry.title}${voteStr}`);
    lines.push(`Author: ${entry.author || 'unknown'} | Date: ${entry.date || 'unknown'} | Score: ${score.toFixed(1)}`);
    if (entry.tags.length > 0) {
      lines.push(`Tags: ${entry.tags.join(', ')}`);
    }
    lines.push(`File: ~/.teamai/learnings/${entry.filename}`);
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

    // Write to local votes dir
    const yamlContent = YAML.stringify(userVotes);
    await writeFile(localVotePath, yamlContent);

    // Also copy to team repo votes dir (will be pushed on next pull)
    const repoVotesDir = path.join(repoPath, 'votes');
    await ensureDir(repoVotesDir);
    await writeFile(path.join(repoVotesDir, `${username}.yaml`), yamlContent);

    log.debug(`autoUpvote: recorded ${newVotes} new vote(s) for ${username}`);
  } catch (e) {
    log.error(`autoUpvote failed: ${(e as Error).message}`);
  }
}

/**
 * Handle `teamai recall <query>`.
 *
 * Searches the local learnings index and displays ranked results.
 * Auto-upvotes returned documents for the knowledge flywheel.
 */
export async function recall(
  query: string,
  options: GlobalOptions,
): Promise<void> {
  if (!query || !query.trim()) {
    log.error('Usage: teamai recall <query>');
    log.info('Example: teamai recall "api timeout"');
    return;
  }

  // Load or build index
  let index = await loadIndex();
  if (!index) {
    log.info('No search index found, building...');
    try {
      const { localConfig } = await requireInit();
      const learningsDir = path.join(localConfig.repo.localPath, 'learnings');
      if (await pathExists(learningsDir)) {
        const votesDir = path.join(localConfig.repo.localPath, 'votes');
        const votesExist = await pathExists(votesDir);
        await buildIndex(
          LEARNINGS_LOCAL_DIR,
          votesExist ? votesDir : undefined,
        );
        index = await loadIndex();
      }
    } catch (e) {
      log.error(`Index build failed: ${(e as Error).message}`);
    }

    if (!index) {
      log.info('No learnings available. Run `teamai pull` first to sync team knowledge.');
      return;
    }
  }

  if (index.entries.length === 0) {
    log.info('Knowledge base is empty. Share your experience with `/teamai-share-learnings` first!');
    return;
  }

  // Search
  const results = search(query, index);

  if (results.length === 0) {
    log.info(`No matching learnings found for "${query}".`);
    return;
  }

  // Output results (STDOUT — AI reads this)
  const output = formatResults(results);
  process.stdout.write(output + '\n');

  // Auto-upvote (best-effort, non-blocking for dry-run)
  if (!options.dryRun) {
    try {
      const { localConfig } = await requireInit();
      await autoUpvote(results, localConfig.username, localConfig.repo.localPath);
    } catch (e) {
      log.error(`autoUpvote skipped: ${(e as Error).message}`);
    }
  }
}
