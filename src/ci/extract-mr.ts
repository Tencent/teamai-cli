// -*- coding: utf-8 -*-
/**
 * `teamai ci extract-mr`, which starts the default workflow teamai-ci-extract-mr, and the `teamai ci` verbs its steps
 * call once teamai-import-from-mr drafted the MR's learning: post it on the MR, write it into the team repo with the
 * teamwiki of the merged checkout updated, and write it into an output directory.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { ImportInputError } from '../import-from-repo.js';
import { ImportLearnings } from '../import-local.js';
import { getDefaultBranch, pushRepoDirectly } from '../utils/git.js';
import { log } from '../utils/logger.js';
import type { LearningDraft } from '../types.js';
import { githubApiUrl, postOrUpdateMrComment, postIndividualComments, postCodebaseGraphComment, parseMrUrl } from './mr-comment.js';
import { readRejections, shouldWrite } from './read-rejections.js';
import { tgitFetch } from '../providers/tgit/rest-auth.js';

const WORKFLOW = 'teamai-ci-extract-mr';

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

/** What the extract step drafted: `teamai import finish-mr`'s learnings, one for the run's MR. */
const LearningsSchema = z.array(z.object({ url: z.string(), title: z.string(), file: z.string(), repo_url: z.string() }));

function parseFlag<T>(schema: z.ZodType<T>, flag: string, raw: string): T {
  return ImportLearnings.parseFlag(schema, flag, raw, WORKFLOW);
}

/** The learning the extract step drafted, and the repository its MR belongs to ('' when the URL names none). */
async function draftedOf(learnings: string): Promise<{ learning: LearningDraft; repoUrl: string }> {
  const [drafted] = parseFlag(LearningsSchema, '--learnings', learnings);

  if (drafted === undefined) throw new ImportInputError(`--learnings holds no learning. Pass what the ${WORKFLOW} step passes.`);

  return { learning: { title: drafted.title, content: await fs.readFile(drafted.file, 'utf-8') }, repoUrl: drafted.repo_url };
}

// ─── Git user setup ───────────────────────────────────────

const GitHubUserSchema = z.object({ login: z.string(), email: z.string().nullish() });
const TGitUserSchema = z.object({ username: z.string(), email: z.string() });

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
        const resp = await fetch(`${githubApiUrl()}/user`, {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'teamai-cli' },
          signal: AbortSignal.timeout(8000),
        });

        if (resp.ok) {
          const user = GitHubUserSchema.parse(await resp.json());
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
        const user = TGitUserSchema.parse(await resp.json());
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

/** Writes the learning to the team repo's learnings/, then commits and pushes it with the teamwiki when that changed. */
async function writeKnowledgeToRepo(
  teamRepo: string,
  learning: LearningDraft | undefined,
  mrUrl: string,
  dryRun: boolean,
  graphWritten: boolean,
): Promise<void> {
  const changedFiles: string[] = [];

  if (graphWritten) {
    changedFiles.push('teamwiki');
  }

  if (learning) {
    const safeTitle = learning.title
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 50);

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${dateStr}-${safeTitle}.md`;
    // oxlint-disable-next-line teamai/learnings-root -- CI runs against a bare checkout, with no LocalConfig
    const learningsDir = path.join(teamRepo, 'learnings');
    const learningPath = path.join(learningsDir, filename);

    if (!dryRun) {
      await fs.mkdir(learningsDir, { recursive: true });
      await fs.writeFile(learningPath, learning.content, 'utf-8');
    }

    log.success(`Learning written: learnings/${filename}`);
    changedFiles.push(`learnings/${filename}`);
  }

  if (!dryRun && changedFiles.length > 0) {
    try {
      const provider = mrUrl.includes('github.com') ? 'github' as const
        : mrUrl.includes('git.woa.com') ? 'tgit' as const
          : 'gitlab' as const;

      await configureGitUser(teamRepo, provider);
      await pushRepoDirectly(teamRepo, `[teamai] CI extract knowledge from MR`, changedFiles);
      log.success('Pushed to the team repo');
    } catch (err) {
      log.warn(`Push failed: ${err instanceof Error ? err.message : String(err)}; the files are written locally`);
    }
  }
}

/**
 * The source files the merge changed in the checkout `businessRepo`. Tries several diffs, as a shallow clone may have
 * no HEAD~1.
 */
async function changedSourceFiles(businessRepo: string): Promise<string[]> {
  const { execFileSync } = await import('node:child_process');
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

      const changedFiles = diffOutput.trim().split('\n')
        .filter(f => f && /\.(ts|tsx|js|jsx|py|go|rs|java|swift|scala)$/.test(f));

      if (changedFiles.length > 0) return changedFiles;
    } catch {
      continue;
    }
  }

  log.debug('[codebase-graph] every git diff attempt failed or no source file changed');

  return [];
}

// ─── Incremental teamwiki update ───────────────────────────────────

/**
 * Import the merged checkout (the working directory) into the team repo's
 * teamwiki through a teamai-import-from-repo run, as `teamai import --dir . --incremental` does, under the slug
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

  // Non-blocking: a failed update leaves the exit code of the extraction as it was.
  const exitCode = process.exitCode;

  try {
    const { repoSlugForUrl } = await import('../import-repo.js');
    const { ImportFromRepo } = await import('../import-from-repo.js');

    const ended = await ImportFromRepo.start({
      mode: 'ci',
      items: [{ kind: 'dir', dir: sourceDir, slug: repoSlugForUrl(repoUrl), repoUrl, mrUrls: [mrUrl] }],
      settings: { depth: 1, forceSsh: false, incremental: true, skipEnrich: false },
      target: { wikiRoot: path.join(teamRepoDir, 'teamwiki') },
      command: 'teamai ci extract-mr',
    });

    const imported = ImportFromRepo.importedOf(ended).at(0);

    if (!imported || imported.failed) {
      log.warn('teamwiki update failed (non-blocking): the step that failed is named above');

      return false;
    }

    return imported.updated;
  } catch (err) {
    log.warn(`teamwiki update failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);

    return false;
  } finally {
    process.exitCode = exitCode;
  }
}

// ─── Verbs ─────────────────────────────────────────────────

/**
 * `teamai ci comment`: posts the drafted learning on the MR, as one comment found and updated by `marker`, or as its own
 * comment whose reactions decide what `teamai ci write` keeps; then the knowledge graph nodes of the source files the
 * merge changed, as a comment of their own. With `preview` true, says each comment instead of posting it.
 */
async function comment(flags: { url: string; learnings: string; marker: string; individual: string; preview: string }): Promise<Record<string, never>> {
  const { learning } = await draftedOf(flags.learnings);
  const dryRun = ImportLearnings.parseBoolean('--preview', flags.preview);

  if (ImportLearnings.parseBoolean('--individual', flags.individual)) {
    const { posted } = await postIndividualComments(flags.url, learning, undefined, dryRun);
    log.success(`Posted ${posted} individual suggestion comment(s)`);
  } else {
    const commentResult = await postOrUpdateMrComment(flags.url, learning, undefined, flags.marker, dryRun);
    log.success(commentResult.created ? 'MR comment posted' : 'MR comment updated');

    if (commentResult.url) log.info(`Comment URL: ${commentResult.url}`);
  }

  // Non-blocking: a graph that could not be read leaves the comments as they are.
  try {
    const businessRepo = process.cwd();
    const changedFiles = await changedSourceFiles(businessRepo);

    if (changedFiles.length > 0) {
      const { collectCode, extractCodeFacts, buildCodeGraph } = await import('../wiki-engine/adapters/index.js');
      const { files } = await collectCode({ root: businessRepo, changedFiles, maxFiles: 50 });

      if (files.length > 0) {
        const graph = buildCodeGraph(extractCodeFacts(files));
        const added = graph.nodes.map(n => `\`${n.type}:${n.title}\` (${n.slug})`);

        if (added.length > 0) {
          // The affected modules, as a preview of the teamwiki update
          const affectedModules = [...new Set(changedFiles.map(f => f.split('/')[0]))];

          const wikiUpdatePreview = affectedModules.length > 0
            ? `**📚 The teamwiki will be updated incrementally for these modules:**\n${affectedModules.map(m => `- \`${m}\` (evidence + G-document)`).join('\n')}`
            : '';

          await postCodebaseGraphComment(flags.url, { added, removed: [], wikiUpdatePreview }, dryRun);
        }
      }
    }
  } catch (err) {
    log.debug(`[codebase-graph] graph change extraction failed (non-blocking): ${err instanceof Error ? err.message : err}`);
  }

  return {};
}

/**
 * `teamai ci write`: writes the drafted learning into `team-repo`'s learnings/ and pushes it, with the teamwiki updated
 * from the merged checkout when the merge changed a source file. With `individual` true, leaves out what a reviewer
 * rejected on its comment. With `preview` true, says the learning's file and writes and pushes nothing.
 */
async function write(flags: { url: string; learnings: string; teamRepo: string; individual: string; preview: string }): Promise<Record<string, never>> {
  const { learning, repoUrl } = await draftedOf(flags.learnings);
  const dryRun = ImportLearnings.parseBoolean('--preview', flags.preview);
  const individualComments = ImportLearnings.parseBoolean('--individual', flags.individual);
  let filteredLearning: LearningDraft | undefined = learning;

  if (individualComments && !dryRun) {
    const parsed = parseMrUrl(flags.url);
    const rejections = await readRejections(flags.url);

    if (rejections.allIds.size > 0 && !shouldWrite('learning', rejections, parsed.provider)) {
      log.info('Learning rejected; skipping the write');
      filteredLearning = undefined;
    }
  }

  // Gated on any changed source file, not on graph nodes added: a merge that only deletes or empties files still has
  // to prune them from the teamwiki.
  const sourceChanged = (await changedSourceFiles(process.cwd()).catch(() => [])).length > 0;
  let graphWritten = false;

  if (sourceChanged && !dryRun) {
    let graphRejected = false;

    if (individualComments) {
      const parsed = parseMrUrl(flags.url);
      const rejections = await readRejections(flags.url);

      if (!shouldWrite('codebase-graph', rejections, parsed.provider)) {
        graphRejected = true;
        log.info('Codebase graph changes rejected; skipping the write');
      }
    }

    if (!graphRejected) {
      graphWritten = await importMergedCheckout(flags.teamRepo, repoUrl, flags.url);
    }
  }

  await writeKnowledgeToRepo(flags.teamRepo, filteredLearning, flags.url, dryRun, graphWritten);

  return {};
}

/** `teamai ci artifacts`: writes the drafted learning into `dir` as learning.md. */
async function artifacts(flags: { learnings: string; dir: string }): Promise<Record<string, never>> {
  const { learning } = await draftedOf(flags.learnings);
  await fs.mkdir(flags.dir, { recursive: true });
  await fs.writeFile(path.join(flags.dir, 'learning.md'), learning.content, 'utf-8');
  log.success(`Artifacts written to: ${flags.dir}`);

  return {};
}

// ─── Main entry ─────────────────────────────────────────────

/** The marker the MR comment is found and updated by when `--comment-marker` names none. */
const DEFAULT_COMMENT_MARKER = '<!-- teamai:ci-extract -->';

/**
 * Starts a teamai-ci-extract-mr run for the MR `url`, with no teamai init needed: a run where none serves this
 * directory takes `--team-repo` as its team repo, with its teamai.yaml and its workflows.
 *
 * @throws Error when write mode has no team repo
 */
async function start(opts: CiExtractMrOptions): Promise<void> {
  if ((opts.mode === 'write' || opts.mode === 'both') && !opts.teamRepo) {
    throw new Error('write mode requires --team-repo');
  }

  if (opts.writeMode === 'pending-review') {
    log.warn('--write-mode pending-review has no effect: ci extract-mr queues nothing for review, so the learning is written to learnings/ as with direct.');
  }

  const teamRepo = opts.teamRepo === undefined ? undefined : path.resolve(opts.teamRepo);
  // The team repo's `language: en` makes the learning English (#1187).
  const { loadTeamConfig } = await import('../config.js');
  const language = (teamRepo === undefined ? undefined : (await loadTeamConfig(teamRepo))?.language) ?? 'zh';
  const { runShortcut } = await import('../workflow-commands.js');

  await runShortcut({
    workflow: WORKFLOW,
    inputs: {
      url: opts.url,
      mode: opts.mode,
      team_repo: teamRepo ?? '',
      comment_marker: opts.commentMarker ?? DEFAULT_COMMENT_MARKER,
      individual_comments: opts.individualComments === true,
      output: opts.output === undefined ? '' : path.resolve(opts.output),
      discussions: opts.discussions ?? true,
      language,
      dry_run: opts.dryRun === true,
    },
    command: 'teamai ci extract-mr',
    json: false,
    preview: opts.dryRun === true,
    teamRepo,
  });
}

export const CiExtractMr = { WORKFLOW, start, comment, write, artifacts } as const;
