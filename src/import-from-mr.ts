/**
 * The default workflow `teamai-import-from-mr`, which `teamai import --from-mr` starts and the session-start MR hint
 * offers: the `teamai import` verbs its steps call read an MR, keep the learning the AI tool drafted from it, publish the
 * accepted ones as `teamai contribute` does with the teamwiki of their repositories updated, and sum the run up.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { TeamaiInit } from './config.js';
import { ImportInputError } from './import-from-repo.js';
import { ImportLearnings } from './import-local.js';
import { extractRepoUrlFromMrUrl, fetchMR, formatMrThreads, parseLearningDraft } from './import-mr.js';
import { RUN_DIR_ENV } from './launch-context.js';
import type { LocalConfig } from './types.js';
import type { ShortcutEnd } from './workflow-commands.js';
import { log, spinner } from './utils/logger.js';

const WORKFLOW = 'teamai-import-from-mr';

/** How much of an MR's diff the AI tool is shown. */
const DIFF_CHARS = 3000;

/** What `teamai import fetch-mr` prints: the MR as the extraction prompt shows it. */
interface FetchedMr {
  url: string;
  title: string;
  description: string;
  /** One `- <hash8>: <message>` line per commit. */
  commits: string;
  /** The first {@link DIFF_CHARS} characters of the diff. */
  diff: string;
  /** The review threads, as `formatMrThreads` renders them; '' when there are none. */
  threads: string;
  thread_count: number;
  author: string;
  /** The day it merged, else today: `YYYY-MM-DD`. */
  date: string;
}

/** What `teamai import draft-mr` prints: the learning the AI tool drafted, kept in the run's directory. */
const DraftSchema = z.object({
  title: z.string(),
  file: z.string(),
  tags: z.array(z.string()),
  /** The existing learnings it overlaps, by file name. */
  overlaps: z.array(z.string()),
  /** The repository the MR belongs to, whose teamwiki the publish updates; '' when the URL names none. */
  repo_url: z.string(),
});

type Draft = z.infer<typeof DraftSchema>;

/** Each MR of the extract step: its URL, and its draft when it succeeded; a failed one's outputs are empty. */
const ExtractedSchema = z.array(z.union([
  z.object({ item: z.string(), outcome: z.literal('success'), outputs: DraftSchema }),
  z.object({ item: z.string(), outcome: z.string().refine((outcome) => outcome !== 'success') }),
]));

type Extracted = z.infer<typeof ExtractedSchema>;

/** Each answer of the review step: the extract result it asked about, and the person's choice. */
const ReviewedSchema = z.array(z.object({
  item: z.object({ item: z.string() }),
  outputs: z.object({ choice: z.enum(['accept', 'edit', 'skip']), note: z.string().nullable().optional() }),
}));

/** A draft of the run, with the MR it came from and that MR's place among the run's MRs. */
interface RunDraft {
  url: string;
  index: number;
  draft: Draft;
}

function parseFlag<T>(schema: z.ZodType<T>, flag: string, raw: string): T {
  return ImportLearnings.parseFlag(schema, flag, raw, WORKFLOW);
}

/** The drafts the extract step produced, in the order of its MRs. */
function draftsOf(extracted: Extracted): RunDraft[] {
  return extracted.flatMap((entry, index) => ('outputs' in entry ? [{ url: entry.item, index, draft: entry.outputs }] : []));
}

/**
 * `teamai import fetch-mr`: reads an MR from its provider, with its review threads unless `threads` is false, as the
 * extraction prompt shows it. Says which of several MRs it is.
 */
async function fetch(flags: { url: string; mrs: string; threads: string }): Promise<FetchedMr> {
  const mrs = parseFlag(z.array(z.string()), '--mrs', flags.mrs);
  const discussions = ImportLearnings.parseBoolean('--threads', flags.threads);

  if (mrs.length > 1) log.info(`[${mrs.indexOf(flags.url) + 1}/${mrs.length}] ${flags.url}`);
  const fetching = await spinner('Fetching MR data...');
  fetching.start();

  try {
    const mr = await fetchMR(flags.url, { discussions });
    const threads = mr.discussions ?? [];
    fetching.succeed(threads.length > 0 ? `MR data fetched (${threads.length} review thread${threads.length === 1 ? '' : 's'})` : 'MR data fetched');

    return {
      url: mr.url,
      title: mr.title,
      description: mr.description,
      commits: mr.commits.map((commit) => `- ${commit.hash.slice(0, 8)}: ${commit.message}`).join('\n'),
      diff: mr.diff.slice(0, DIFF_CHARS),
      threads: threads.length > 0 ? formatMrThreads(threads, mr.author) : '',
      thread_count: threads.length,
      author: mr.author ?? 'unknown',
      date: (mr.mergedAt ?? new Date().toISOString()).slice(0, 10),
    };
  } catch (error) {
    fetching.fail('MR data fetch failed');
    throw error;
  }
}

/**
 * The learnings recall reads here that the draft's keywords overlap, by file name: the queue, and the published roots
 * of the shared root and the active namespaces. A broken projects.yaml narrows it to the shared root, and says so.
 */
async function overlapping(content: string): Promise<string[]> {
  const { autoDetectInit } = await import('./config.js');
  const { localConfig } = await autoDetectInit(undefined, { dryRun: true });
  const { deliveredLearningsNamespaces } = await import('./workspace-children.js');
  const { pendingLearningsDir } = await import('./utils/pending-learnings.js');
  const { indexableLearningsRoots } = await import('./utils/learnings-roots.js');
  const { extractKeywords, findOverlappingLearnings } = await import('./utils/dedup.js');

  // The check is advisory, as recall's namespaces are.
  const namespaces = await deliveredLearningsNamespaces(localConfig).catch((cause: unknown) => {
    log.warn(`The duplicate check reads the shared learnings only: ${cause instanceof Error ? cause.message : String(cause)}`);

    return [];
  });

  const dirs = [pendingLearningsDir(localConfig), ...await indexableLearningsRoots(localConfig)];

  return (await findOverlappingLearnings(extractKeywords(content), dirs, { namespaces })).map((entry) => entry.filename);
}

/**
 * `teamai import draft-mr`: keeps the learning the AI tool wrote for the MR `url` in the run's directory, titled by its
 * frontmatter, else by the MR's `title`, and says its title, its tags and the learnings it overlaps.
 */
async function draft(flags: { url: string; title: string; reply: string }): Promise<Draft> {
  const runDir = process.env[RUN_DIR_ENV];

  if (!runDir) throw new ImportInputError(`${RUN_DIR_ENV} is not set. teamai import draft-mr is a step of a ${WORKFLOW} run.`);

  if (flags.reply.trim() === '') throw new ImportInputError(`--reply is empty: the AI tool wrote no learning for ${flags.url}.`);
  const { content, data } = parseLearningDraft(flags.reply);
  const title = data.title ?? flags.title;
  const tags = (data.tags ?? []).flatMap((tag) => (tag === undefined ? [] : [tag]));
  const file = path.join(await fs.mkdtemp(path.join(runDir, 'mr-')), 'learning.md');
  await fs.writeFile(file, content, 'utf-8');
  const overlaps = await overlapping(content);

  log.info(`✅ Learning draft generated: ${title}`);

  if (tags.length > 0) log.info(`   Tags: ${tags.join(', ')}`);

  // Names the existing learnings; accepting the draft changes none of them.
  if (overlaps.length > 0) log.warn(`Possible duplicate: this learning overlaps ${overlaps.length} existing learning(s): ${overlaps.join(', ')}.`);

  return { title, file, tags, overlaps, repo_url: extractRepoUrlFromMrUrl(flags.url) };
}

/** A draft the person accepted, with the title it is published under. */
interface AcceptedDraft extends RunDraft {
  title: string;
  isEdited: boolean;
}

/** The drafts the person accepted, an edited one under the note as its title; every draft without a review. */
function acceptedOf(extracted: Extracted, reviewed: z.infer<typeof ReviewedSchema> | undefined): AcceptedDraft[] {
  const answers = new Map(reviewed?.map((entry) => [entry.item.item, entry.outputs]));

  return draftsOf(extracted).flatMap((entry) => {
    const answer = answers.get(entry.url);

    if (reviewed !== undefined && (answer === undefined || answer.choice === 'skip')) return [];
    const note = answer?.choice === 'edit' ? answer.note?.trim() ?? '' : '';

    return [{ ...entry, title: note === '' ? entry.draft.title : note, isEdited: note !== '' }];
  });
}

/**
 * The text an accepted draft is written with: an edited one carries its new title in its frontmatter, with the rest of
 * the frontmatter as the AI tool wrote it.
 */
async function contentOf(entry: AcceptedDraft): Promise<string> {
  const content = await fs.readFile(entry.draft.file, 'utf-8');

  if (!entry.isEdited) return content;
  const line = `title: ${JSON.stringify(entry.title)}`;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);

  if (!frontmatter) return `---\n${line}\n---\n\n${content}`;
  const [whole, fields] = frontmatter;
  const retitled = /^title:.*$/m.test(fields) ? fields.replace(/^title:.*$/m, line) : `${line}\n${fields}`;

  return `---\n${retitled}\n---${content.slice(whole.length)}`;
}

/**
 * `teamai import publish-mr`: with `drafts` true, writes each accepted draft into `target` as learning.md, or
 * learning-<n>.md when the run read several MRs. Otherwise queues each one into the learnings namespace contribute picks
 * and publishes the queue once, then updates the teamwiki of each repository an extracted MR names and whose evidence
 * the team repo `target` holds, and pushes that update on an MR branch. Says each file it wrote.
 */
async function publish(flags: { extracted: string; reviewed: string; target: string; drafts: string }): Promise<{ published: string[] }> {
  const extracted = parseFlag(ExtractedSchema, '--extracted', flags.extracted);
  const reviewed = flags.reviewed.trim() === '' ? undefined : parseFlag(ReviewedSchema, '--reviewed', flags.reviewed);
  const accepted = acceptedOf(extracted, reviewed);

  if (ImportLearnings.parseBoolean('--drafts', flags.drafts)) {
    const written: string[] = [];

    for (const entry of accepted) {
      await fs.mkdir(flags.target, { recursive: true });
      const file = path.join(flags.target, extracted.length > 1 ? `learning-${entry.index + 1}.md` : 'learning.md');
      await fs.writeFile(file, await contentOf(entry), 'utf-8');
      log.info(`Learning written: ${file}`);
      written.push(file);
    }

    return { published: written };
  }

  const { autoDetectInit } = await import('./config.js');
  const team = await autoDetectInit(undefined, { dryRun: false });

  if (path.resolve(team.localConfig.repo.localPath) !== path.resolve(flags.target)) {
    throw new ImportInputError(`--target is ${flags.target}, but the team repo of this config is ${team.localConfig.repo.localPath}. Run the import again from the checkout it started in.`);
  }

  const learnings = await Promise.all(accepted.map(async (entry) => ({ title: entry.title, content: await contentOf(entry) })));
  const published = learnings.length > 0 ? await publishLearnings(team.localConfig, learnings) : [];
  await updateTeamwiki(team, draftsOf(extracted));

  return { published };
}

/** Queues each learning as contribute names it and publishes the queue once; says each file and how the publish went. */
async function publishLearnings(localConfig: LocalConfig, learnings: ReadonlyArray<{ title: string; content: string }>): Promise<string[]> {
  const contribute = await import('./contribute.js');
  const { savePendingLearning, queueWriteRefusal } = await import('./utils/pending-learnings.js');
  const { publishQueuedLearnings } = await import('./utils/learnings-publish.js');
  const subdir = await contribute.resolveLearningsSubdir(localConfig);
  const queued: string[] = [];
  const written: string[] = [];

  for (const learning of learnings) {
    // The random suffix keeps two members' learnings of one title and day apart once both are published (#823).
    const relPath = path.posix.join(subdir, contribute.generateFilename(learning.title));
    const saved = await savePendingLearning(localConfig, relPath, learning.content);

    if (saved.status !== 'saved') throw new Error(queueWriteRefusal(saved));
    log.info(`Learning written: ${saved.path}`);
    queued.push(relPath);
    written.push(saved.path);
  }

  // One publish for the whole run: it drains the queue every accepted learning was written into.
  const report = await publishQueuedLearnings(localConfig, localConfig.username);
  // Recall finds them where they are now: published, or still queued.
  await contribute.rebuildIndexAfterContribute(localConfig).catch((cause: unknown) =>
    log.debug(`import: index rebuild skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  const unpublished = queued.filter((file) => !report.published.includes(file));
  const why = report.lastError ?? 'not published yet';

  if (report.installChanged) log.warn(`Learning saved locally, not published: ${report.installChanged}. ${contribute.KEPT_FOR_ITS_INSTALL}`);
  else if (report.refused) log.warn(`Learning saved locally (${why}). ${contribute.KEPT_UNTIL_CHECKOUT_SETTLED}`);
  else if (unpublished.length > 0 && queued.length === 1) log.warn(`Learning saved locally (${why}); the next \`teamai pull\` publishes it`);
  else if (unpublished.length > 0) log.warn(`${unpublished.length} of ${queued.length} learning(s) saved locally (${why}); the next \`teamai pull\` publishes them`);
  else log.success(queued.length === 1 ? 'Learning published' : `Published ${queued.length} learnings`);

  return written;
}

/**
 * Updates the teamwiki of each repository the drafts name, once, with every MR of the run that named it as its
 * provenance, when the team repo holds its evidence; a repository whose update failed is said and left. Rebuilds the
 * index and pushes the teamwiki on an MR branch once something was updated.
 */
async function updateTeamwiki(team: TeamaiInit, drafts: readonly RunDraft[]): Promise<void> {
  const { localConfig, teamConfig } = team;
  const teamwikiRoot = path.join(localConfig.repo.localPath, 'teamwiki');
  const mrUrlsByRepo = new Map<string, string[]>();

  for (const { url, draft: { repo_url: repoUrl } } of drafts) {
    if (repoUrl) mrUrlsByRepo.set(repoUrl, [...(mrUrlsByRepo.get(repoUrl) ?? []), url]);
  }

  if (mrUrlsByRepo.size === 0) return;
  const { ImportFromRepo } = await import('./import-from-repo.js');
  const { repoSlugForUrl } = await import('./import-repo.js');
  const { pathExists } = await import('./utils/fs.js');
  let isUpdated = false;

  for (const [repoUrl, sourceMrUrls] of mrUrlsByRepo) {
    // Non-blocking: a repository whose update failed is named, and the import still succeeds.
    const { exitCode } = process;

    try {
      const slug = repoSlugForUrl(repoUrl);

      if (!(await pathExists(path.join(teamwikiRoot, 'evidence', 'code', slug)))) {
        log.info(`Incremental teamwiki update skipped: no existing evidence for ${slug}`);
        continue;
      }

      log.info(`Updating ${slug}...`);

      const ended = await ImportFromRepo.start({
        mode: 'update',
        items: [{ kind: 'repo', url: repoUrl, mrUrls: sourceMrUrls }],
        settings: { depth: 1, forceSsh: false, incremental: true, skipEnrich: false },
        target: { wikiRoot: teamwikiRoot, team },
        command: 'teamai import --from-mr',
      });

      if (ImportFromRepo.importedOf(ended).some((entry) => !entry.failed)) isUpdated = true;
      else log.info(`Incremental teamwiki update skipped: the import of ${slug} failed`);
    } catch (error) {
      log.info(`Incremental teamwiki update skipped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      process.exitCode = exitCode;
    }
  }

  if (!isUpdated) {
    log.info('Push changes via MR skipped: no teamwiki changes to push');

    return;
  }

  // The index covers the whole teamwiki, so it is rebuilt once.
  try {
    const { rebuildWikiIndex } = await import('./rebuild-wiki-index.js');
    await rebuildWikiIndex(teamwikiRoot);
  } catch (error) {
    log.warn(`[wiki] global index rebuild failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`);
  }

  const { autoPushViaMR } = await import('./utils/git.js');

  await autoPushViaMR(
    localConfig.repo.localPath,
    `[teamai] Import from MR: ${drafts.map((entry) => entry.url).join(', ')}`,
    ['.'],
    { repo: teamConfig.repo, provider: teamConfig.provider, reviewers: teamConfig.reviewers },
    { repo: localConfig.repo, username: localConfig.username, provider: localConfig.provider },
  );
}

/** What a `teamai-import-from-mr` run ends with: the exit code, and each draft, for a workflow that runs it. */
interface MrImportEnd {
  text: string;
  exit_code: number;
  learnings: Array<{ url: string; title: string; file: string; repo_url: string }>;
}

/** `teamai import finish-mr`: sums up a run of several MRs, naming each that failed. Exits 1 when one did. */
function finish(flags: { extracted: string }): MrImportEnd {
  const extracted = parseFlag(ExtractedSchema, '--extracted', flags.extracted);
  const drafts = draftsOf(extracted);
  const failed = extracted.filter((entry) => entry.outcome !== 'success');

  if (extracted.length > 1) {
    log.info(`Import from MR complete: ${drafts.length} succeeded, ${failed.length} failed`);

    for (const entry of failed) log.info(`  failed: ${entry.item}`);
  }

  return {
    text: '',
    exit_code: failed.length > 0 ? 1 : 0,
    learnings: drafts.map(({ url, draft: { title, file, repo_url: repoUrl } }) => ({ url, title, file, repo_url: repoUrl })),
  };
}

/** What `teamai import --from-mr` is told. */
export interface MrImport {
  mrs: string[];
  /** Accept every draft without asking. */
  all: boolean;
  /** The directory each draft is written into, in place of publishing it. */
  output?: string;
  /** Read the MRs' review threads; `--no-discussions` sets false (#1187). */
  discussions: boolean;
  /** Extract and say each draft, and write nothing. */
  dryRun: boolean;
  /** The command a person runs, as a refusal names it. */
  command: string;
}

/**
 * Starts a teamai-import-from-mr run for `mrs`. Refused, said and exited 1, before any AI call: no teamai init, a
 * read-only source a publish could not reach, and a review nobody can answer, inside a workflow step or with no terminal.
 */
async function start(options: MrImport): Promise<ShortcutEnd | undefined> {
  const { autoDetectInit } = await import('./config.js');
  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: options.dryRun });
  const isPublished = !options.dryRun;

  if (isPublished && options.output === undefined) {
    // Published the way `teamai contribute` publishes, which a read-only (HTTP) source refuses.
    const { assertNotReadOnly } = await import('./read-only.js');
    assertNotReadOnly(localConfig, options.command);
    // Publishing creates a worktree under `.teamai/`; self-heal the ignore rule first, as contribute does.
    const { migrateSelfModeGitignore } = await import('./init.js');
    await migrateSelfModeGitignore(localConfig);
  }

  const { runShortcut } = await import('./workflow-commands.js');

  return runShortcut({
    workflow: WORKFLOW,
    inputs: {
      mrs: options.mrs,
      all: options.all,
      publish: isPublished,
      dir: options.output === undefined ? localConfig.repo.localPath : path.resolve(options.output),
      output: options.output !== undefined,
      discussions: options.discussions,
      // `language: en` in teamai.yaml makes the learning English (#1187).
      language: teamConfig.language ?? 'zh',
    },
    command: options.command,
    json: false,
    nobodyAnswers: options.all || !isPublished ? undefined : ImportLearnings.NOBODY_REVIEWS,
    preview: options.dryRun,
  });
}

export const ImportFromMr = { WORKFLOW, fetch, draft, publish, finish, start } as const;
