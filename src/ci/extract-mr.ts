// -*- coding: utf-8 -*-
/**
 * CI MR knowledge extraction orchestration.
 *
 * Reuses the importFromMR AI extraction and, depending on mode:
 * - comment: posts or updates the MR comment idempotently
 * - write: writes the learning and codebase suggestions to the team repo
 * - both: does both
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { importFromMR } from '../import-mr.js';
// applyCodebaseSuggestions removed: codebase updates now handled by teamwiki/ graph engine
import { appendPendingReview } from '../review-store.js';
import { getDefaultBranch, pushRepoDirectly } from '../utils/git.js';
import { log } from '../utils/logger.js';
import type { LearningDraft, CodebaseSuggestion } from '../types.js';
import { postOrUpdateMrComment, postIndividualComments, postCodebaseGraphComment, parseMrUrl } from './mr-comment.js';
import { readRejections, shouldWrite } from './read-rejections.js';
import { tgitFetch } from '../providers/tgit/rest-auth.js';

// ─── Types ────────────────────────────────────────────────

export interface CiExtractMrOptions {
  url: string;
  mode: 'comment' | 'write' | 'both';
  teamRepo?: string;
  commentMarker?: string;
  writeMode?: 'direct' | 'pending-review';
  output?: string;
  dryRun?: boolean;
  individualComments?: boolean;
  /** Read the MR's review threads into the extraction; `--no-discussions` sets false (#1187) */
  discussions?: boolean;
}

// ─── Git user setup ───────────────────────────────────────

/**
 * Sets git user.name and user.email automatically.
 *
 * Looks up the user behind the current token through the provider API:
 * - GitHub: GITHUB_TOKEN → GET /user
 * - GitLab: GITLAB_TOKEN → GET /api/v4/user
 * - TGit: TGIT_TOKEN → GET /api/v3/user
 */
async function configureGitUser(repoPath: string, provider: 'github' | 'tgit' | 'gitlab'): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  let name = 'teamai-ci';
  let email = 'teamai-ci@noreply';

  try {
    if (provider === 'github') {
      const token = process.env['GITHUB_TOKEN'];
      if (token) {
        const resp = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'teamai-cli' },
          signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          const user = (await resp.json()) as { login: string; email: string | null };
          name = user.login;
          email = user.email ?? `${user.login}@users.noreply.github.com`;
        }
      }
    } else if (provider === 'gitlab') {
      const { gitlabWhoami } = await import('../providers/gitlab/gitlab-api.js');
      const username = await gitlabWhoami();
      if (username) {
        name = username;
        email = `${username}@users.noreply.gitlab`;
      }
    } else {
      // tgitFetch throws when no TGit credential is available; the outer
      // catch below logs and falls back to the default git user.
      const resp = await tgitFetch('/user', { signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        const user = (await resp.json()) as { username: string; email: string };
        name = user.username;
        email = user.email;
      }
    }
  } catch {
    log.debug('Could not fetch the user info; using the default git user');
  }

  try {
    execFileSync('git', ['config', 'user.name', name], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', email], { cwd: repoPath, stdio: 'ignore' });
    log.debug(`Git user: ${name} <${email}>`);
  } catch {
    log.debug('git config failed (not a git repo); skipping');
  }
}

// ─── Write logic ────────────────────────────────────────────

/**
 * Writes the learning and codebase suggestions to the team repo.
 */
async function writeKnowledgeToRepo(
  teamRepo: string,
  learning: LearningDraft | undefined,
  suggestions: CodebaseSuggestion[] | undefined,
  writeMode: 'direct' | 'pending-review',
  mrUrl: string,
  dryRun?: boolean,
  graphWritten?: boolean,
): Promise<void> {
  const changedFiles: string[] = [];

  if (graphWritten) {
    changedFiles.push('teamwiki');
  }

  // Write the learning
  if (learning) {
    const safeTitle = learning.title
      .replace(/[^a-zA-Z0-9一-鿿_-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 50);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${dateStr}-${safeTitle}.md`;
    // learnings-root ok: CI runs against a bare checkout, with no LocalConfig
    const learningsDir = path.join(teamRepo, 'learnings');
    const learningPath = path.join(learningsDir, filename);

    if (!dryRun) {
      await fs.mkdir(learningsDir, { recursive: true });
      await fs.writeFile(learningPath, learning.content, 'utf-8');
    }
    log.success(`Learning written: learnings/${filename}`);
    changedFiles.push(`learnings/${filename}`);
  }

  // Handle codebase suggestions
  // NOTE: the incremental teamwiki/ graph update replaced the direct-mode AI rewrite (Phase 3.3).
  // Suggestions go to the jsonl for human review only in pending-review mode.
  if (suggestions && suggestions.length > 0) {
    if (writeMode === 'direct') {
      log.debug('Codebase suggestions (direct mode): graph changes are handled in the comment/write stage; skipping the AI rewrite');
    } else {
      // pending-review mode
      for (const s of suggestions) {
        if (!dryRun) {
          await appendPendingReview(teamRepo, {
            kind: 'codebase-section',
            target: { file: 'docs/codebase.md', section: s.section },
            payload: { content: s.content, action: s.action },
            source: `ci:extract-mr:${mrUrl}`,
          });
        }
      }
      log.success(`${suggestions.length} suggestion(s) added to the pending-review queue`);
      changedFiles.push('.teamai/pending-review.jsonl');
    }
  }

  // Commit and push
  if (!dryRun && changedFiles.length > 0) {
    try {
      const provider = mrUrl.includes('github.com') ? 'github' as const
        : mrUrl.includes('git.woa.com') ? 'tgit' as const
          : 'gitlab' as const;
      await configureGitUser(teamRepo, provider);
      await pushRepoDirectly(teamRepo, `[teamai] CI extract knowledge from MR`, changedFiles);
      log.success('Pushed to the team repo');
    } catch (err) {
      log.warn(`Push failed: ${(err as Error).message}; the files are written locally`);
    }
  }
}

// ─── Incremental teamwiki update ───────────────────────────────────

/**
 * Import the merged checkout (the working directory) into the team repo's
 * teamwiki, as `teamai import --dir . --incremental` does, under the slug
 * `teamai import --from-repo` and `--from-mr` use for this repo. The baseline
 * published with that codebase's evidence makes the run incremental, even on a
 * fresh CI clone of the team repo.
 *
 * Non-blocking: a failure is logged and leaves the teamwiki as it was.
 *
 * @returns whether the teamwiki changed
 */
async function importMergedCheckout(teamRepo: string, repoUrl: string, mrUrl: string): Promise<boolean> {
  const sourceDir = process.cwd();
  const teamRepoDir = path.resolve(teamRepo);
  const relative = path.relative(sourceDir, teamRepoDir);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    log.warn(`Skipped the teamwiki update: the team repo (${teamRepoDir}) is inside the source checkout `
      + `(${sourceDir}), so its files would be extracted as source. Clone it outside the checkout (see examples/ci/).`);
    return false;
  }
  try {
    const { repoSlugForUrl } = await import('../import-repo.js');
    const { importLocalCheckout } = await import('../import-codebase.js');
    return await importLocalCheckout({
      sourceDir,
      slug: repoSlugForUrl(repoUrl),
      wikiRoot: path.join(teamRepoDir, 'teamwiki'),
      incremental: true,
      repoUrl,
      sourceMrUrl: mrUrl,
    });
  } catch (err) {
    log.warn(`teamwiki update failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ─── Output artifacts ─────────────────────────────────────

async function writeArtifacts(
  outputDir: string,
  learning: LearningDraft | undefined,
  suggestions: CodebaseSuggestion[] | undefined,
): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });

  if (learning) {
    await fs.writeFile(path.join(outputDir, 'learning.md'), learning.content, 'utf-8');
  }

  if (suggestions && suggestions.length > 0) {
    await fs.writeFile(
      path.join(outputDir, 'codebase-suggestions.json'),
      JSON.stringify(suggestions, null, 2),
      'utf-8',
    );
  }
}

// ─── Main entry ─────────────────────────────────────────────

/**
 * Runs the CI MR knowledge extraction.
 *
 * @param opts  command options
 * @throws     Error when argument validation or the AI call fails
 */
export async function ciExtractMr(opts: CiExtractMrOptions): Promise<void> {
  // Validate arguments
  if ((opts.mode === 'write' || opts.mode === 'both') && !opts.teamRepo) {
    throw new Error('write mode requires --team-repo');
  }

  // AI extraction (reuses importFromMR)
  let learning: LearningDraft | undefined;

  // The team repo's `language: en` makes the learning English (#1187).
  const language = opts.teamRepo
    ? (await import('../config.js').then(({ loadTeamConfig }) => loadTeamConfig(opts.teamRepo!)))?.language
    : undefined;
  const result = await importFromMR({
    url: opts.url,
    all: true,
    // learnings-root ok: CI runs against a bare checkout, with no LocalConfig
    learningsDirs: opts.teamRepo ? [path.join(opts.teamRepo, 'learnings')] : undefined,
    dryRun: true, // importFromMR writes nothing; this function controls the writes
    discussions: opts.discussions,
    // A custom marker's comments are teamai's own too: keep them out of the threads.
    commentMarker: opts.commentMarker,
    language,
  });
  learning = result.learning;

  // Run comment
  // NOTE: codebase suggestions are no longer posted as their own comment; the graph change comment replaced it
  if (opts.mode === 'comment' || opts.mode === 'both') {
    if (opts.individualComments) {
      const { posted } = await postIndividualComments(opts.url, learning, undefined, opts.dryRun);
      log.success(`Posted ${posted} individual suggestion comment(s)`);
    } else {
      const result = await postOrUpdateMrComment(
        opts.url,
        learning,
        undefined,
        opts.commentMarker,
        opts.dryRun,
      );
      if (result.created) {
        log.success('MR comment posted');
      } else {
        log.success('MR comment updated');
      }
      if (result.url) {
        log.info(`Comment URL: ${result.url}`);
      }
    }
  }

  // ── Codebase graph changes ──────────────────────────────────────
  let graphChangeSummary: { added: string[]; removed: string[] } | undefined;
  // The merge touched a source file (added, changed or deleted) in a git checkout.
  let sourceChanged = false;
  try {
    const { collectCode, extractCodeFacts, buildCodeGraph } = await import('../wiki-engine/adapters/index.js');
    const { execFileSync } = await import('node:child_process');
    const businessRepo = process.cwd();

    // Get the files this MR/PR changed from git
    // Try several ways, to cope with a shallow clone (HEAD~1 does not exist at depth=1)
    let changedFiles: string[] = [];
    const defaultBranch = await getDefaultBranch(businessRepo).catch(() => 'master');
    const diffCommands = [
      ['diff', '--name-only', 'HEAD~1', 'HEAD'],
      ['show', '--name-only', '--format=', 'HEAD'],
      ['diff', '--name-only', `origin/${defaultBranch}...HEAD`],
    ];
    for (const args of diffCommands) {
      try {
        const diffOutput = execFileSync(
          'git', args,
          { cwd: businessRepo, encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        changedFiles = diffOutput.trim().split('\n')
          .filter(f => f && /\.(ts|tsx|js|jsx|py|go|rs|java|swift|scala)$/.test(f));
        if (changedFiles.length > 0) break;
      } catch {
        continue;
      }
    }
    if (changedFiles.length === 0) {
      log.debug('[codebase-graph] every git diff attempt failed or no source file changed');
    }
    sourceChanged = changedFiles.length > 0;

    if (changedFiles.length > 0) {
      const { files } = await collectCode({ root: businessRepo, changedFiles, maxFiles: 50 });
      if (files.length > 0) {
        const facts = extractCodeFacts(files);
        const graph = buildCodeGraph(facts);
        graphChangeSummary = {
          added: graph.nodes.map(n => `\`${n.type}:${n.title}\` (${n.slug})`),
          removed: [],
        };

        if ((opts.mode === 'comment' || opts.mode === 'both') && graphChangeSummary.added.length > 0) {
          // Infer the affected modules and attach them to the graph comment as a teamwiki update preview
          const affectedModules = [...new Set(changedFiles.map(f => f.split('/')[0]))];
          const wikiUpdatePreview = affectedModules.length > 0
            ? `**📚 The teamwiki will be updated incrementally for these modules:**\n${affectedModules.map(m => `- \`${m}\` (evidence + G-document)`).join('\n')}`
            : '';
          await postCodebaseGraphComment(
            opts.url,
            { ...graphChangeSummary, wikiUpdatePreview },
            opts.dryRun,
          );
        }
      }
    }
  } catch (err) {
    log.debug(`[codebase-graph] graph change extraction failed (non-blocking): ${err instanceof Error ? err.message : err}`);
  }

  // Run write
  if (opts.mode === 'write' || opts.mode === 'both') {
    // With individual comments, read the rejection state to filter what is written
    let filteredLearning = learning;

    if (opts.individualComments && !opts.dryRun) {
      const parsed = parseMrUrl(opts.url);
      const rejections = await readRejections(opts.url);

      if (rejections.allIds.size > 0) {
        // Filter the learning
        if (learning && !shouldWrite('learning', rejections, parsed.provider)) {
          log.info('Learning rejected; skipping the write');
          filteredLearning = undefined;
        }
      }
    }

    // ── Write graph changes to <team-repo>/teamwiki/ (incrementally, through the same flow as teamai import) ──
    // Gated on any changed source file, not on graph nodes added: a merge that
    // only deletes or empties files still has to prune them from the teamwiki.
    let graphWritten = false;
    if (sourceChanged && !opts.dryRun) {
      let graphRejected = false;
      if (opts.individualComments) {
        const parsed = parseMrUrl(opts.url);
        const rejections = await readRejections(opts.url);
        if (!shouldWrite('codebase-graph', rejections, parsed.provider)) {
          graphRejected = true;
          log.info('Codebase graph changes rejected; skipping the write');
        }
      }

      if (!graphRejected) {
        graphWritten = await importMergedCheckout(opts.teamRepo!, result.repoUrl, opts.url);
      }
    }

    await writeKnowledgeToRepo(
      opts.teamRepo!,
      filteredLearning,
      undefined,
      opts.writeMode ?? 'direct',
      opts.url,
      opts.dryRun,
      graphWritten,
    );
  }

  // Output artifacts
  if (opts.output) {
    await writeArtifacts(opts.output, learning, undefined);
    log.success(`Artifacts written to: ${opts.output}`);
  }
}
