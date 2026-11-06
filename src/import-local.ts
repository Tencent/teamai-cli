/**
 * The default workflows `teamai-import-rules`, which `teamai import --from-tools` (and its alias `--from-claude`)
 * starts, and `teamai-import-learnings`, which it and `teamai-import-from-iwiki` run: the `teamai import` verbs their
 * steps call scan the rules directory of every tool, read a file to classify, read the AI tool's classification, write
 * the accepted items by their type, and publish them.
 */
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { ImportInputError } from './import-from-repo.js';
import type { Install } from './locate.js';
import type { JsonValue } from './types.js';
import type { ShortcutEnd } from './workflow-commands.js';
import { listFilesRecursive, readFileSafe, writeFile, ensureDir } from './utils/fs.js';
import { log } from './utils/logger.js';
import { assertSafePath, defaultAllowedRoots } from './utils/path-safety.js';

/** A file over this size is not imported. */
const MAX_FILE_SIZE_BYTES = 50 * 1024;

/** How much of a file the AI tool is shown to classify it. */
const MAX_CONTENT_CHARS = 3000;

/** The rule files a tool keeps: Markdown, and Cursor's and JoyCode's `.mdc`. */
const RULE_EXTENSIONS = new Set(['.md', '.mdc']);

/** A file to classify: the path it is shown as, and the file that holds its text. */
const CandidateSchema = z.object({ path: z.string().min(1), file: z.string().min(1) });

export type Candidate = z.infer<typeof CandidateSchema>;

const ItemTypeSchema = z.enum(['rule', 'doc', 'learning']);

type ItemType = z.infer<typeof ItemTypeSchema>;

/** How the AI tool classified a file, as the `classify-reply` verb prints it. */
const ClassifiedSchema = z.object({
  type: ItemTypeSchema,
  title: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  personal: z.boolean(),
});

type Classified = z.infer<typeof ClassifiedSchema>;

/** The AI's classification of a file; a field of the wrong type reads as absent, and a tag that is not text is dropped. */
const ClassifyReplySchema = z.object({
  type: z.unknown().optional(),
  title: z.string().optional().catch(undefined),
  summary: z.string().optional().catch(undefined),
  tags: z.array(z.string().optional().catch(undefined)).catch([]),
  isPersonal: z.boolean().optional().catch(undefined),
});

/** Each item of the classify step, as its results carry it. */
const ClassifiedResultsSchema = z.array(z.object({ item: CandidateSchema, outputs: ClassifiedSchema }));

/** Each item of the review step: the classify result it asked about, and the person's answer. */
const ReviewedResultsSchema = z.array(z.object({
  item: z.object({ item: CandidateSchema }),
  outputs: z.object({ choice: z.enum(['accept', 'edit', 'skip']), note: z.string().nullable().optional() }),
}));

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `<YYYY-MM-DD>-<slug>.md`, or `<YYYY-MM-DD>-<slug>-<n>.md` for the `n`th of one name. The number follows the cut slug, so a long title cannot cut it off. */
function buildFilename(title: string, n?: number): string {
  const slug = toSlug(title) || 'untitled';

  return `${todayStr()}-${slug}${n === undefined ? '' : `-${n}`}.md`;
}

/** The file an item is written as: its frontmatter, with the `type:` that routes it, and its summary. */
function buildMarkdown(item: Classified): string {
  const tagsYaml = item.tags.length > 0 ? `[${item.tags.map((t) => `"${t}"`).join(', ')}]` : '[]';

  return ['---', `title: "${item.title}"`, `type: ${item.type}`, 'author: import', `date: ${todayStr()}`, `tags: ${tagsYaml}`, '---', '', item.summary, ''].join('\n');
}

/** The directory of the team repo an item of `type` lands in. */
function typeDir(type: ItemType): string {
  switch (type) {
    case 'rule':
      return 'rules';
    case 'doc':
      return 'docs';
    case 'learning':
      return 'learnings';
    default: {
      const unhandled: never = type;

      return unhandled;
    }
  }
}

/** A verb's JSON flag, as the step of `workflow` passes it; anything else is refused, so the step fails input_rejected. */
function parseFlag<T>(schema: z.ZodType<T>, flag: string, raw: string, workflow = 'teamai-import-learnings'): T {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch {
    throw new ImportInputError(`${flag} is not JSON. Pass what the ${workflow} step passes.`);
  }

  const parsed = schema.safeParse(json);

  if (!parsed.success) throw new ImportInputError(`${flag} is not what the ${workflow} step passes: ${parsed.error.message}`);

  return parsed.data;
}

function parseBoolean(flag: string, raw: string): boolean {
  if (raw === 'true' || raw === 'false') return raw === 'true';
  throw new ImportInputError(`${flag} must be true or false, not ${JSON.stringify(raw)}.`);
}

/** The Markdown files under `dir` no larger than the import takes, as candidates that are their own file. */
async function candidatesIn(dir: string, extensions: ReadonlySet<string>): Promise<Candidate[]> {
  const found: Candidate[] = [];

  for (const relPath of await listFilesRecursive(dir)) {
    if (!extensions.has(path.extname(relPath).toLowerCase())) continue;
    const absPath = path.join(dir, relPath);

    try {
      if (fs.statSync(absPath).size > MAX_FILE_SIZE_BYTES) continue;
    } catch (statErr: unknown) {
      log.warn(`cannot stat file, skipped: ${absPath} (${String(statErr)})`);
      continue;
    }

    found.push({ path: absPath, file: absPath });
  }

  return found;
}

/**
 * What the user scope's pulls recorded writing into the tools' user directories, or undefined with no user-scope
 * install or no record. A rule teamai delivered is the team's, edited or not: push carries an edit back.
 */
async function deliveredToUserScope(): Promise<Readonly<Record<string, string>> | undefined> {
  const { loadLocalConfigForScope } = await import('./config.js');
  const user = await loadLocalConfigForScope('user', undefined, { dryRun: true });

  if (!user) return undefined;
  const { deliveredHashes } = await import('./pull.js');

  return deliveredHashes(user);
}

/**
 * `teamai import scan-rules`: the rule files in the user rules directory of every tool teamai supports, as the member's
 * `toolRoots` and each tool's home place them, but for those teamai delivered there. Says so when there are none.
 */
async function scanRules(): Promise<{ candidates: Candidate[] }> {
  const { resolveMemberToolRoots } = await import('./config.js');
  const { locate } = await import('./locate.js');
  const { TOOLS } = await import('./tools.js');
  const { DEFAULT_TOOL_PATHS } = await import('./types.js');
  const toolRoots = await resolveMemberToolRoots(undefined) ?? {};
  const install: Install = { scope: 'user', toolPaths: DEFAULT_TOOL_PATHS, agents: {}, toolRoots, gitExclude: false };
  const dirs = new Set<string>();

  for (const tool of Object.keys(TOOLS)) {
    const rules = await locate(tool, 'rules', install);

    if (rules.channel === 'files' && rules.own?.kind === 'dir') dirs.add(rules.own.path);
  }

  const candidates: Candidate[] = [];
  const delivered = await deliveredToUserScope();

  for (const dir of dirs) {
    if (fs.existsSync(dir)) candidates.push(...(await candidatesIn(dir, RULE_EXTENSIONS)).filter((candidate) => delivered?.[candidate.file] === undefined));
  }

  if (candidates.length === 0) log.info('no importable files found');

  return { candidates };
}

/** `teamai import read-candidate`: the start of a file to classify, as much as the AI tool is shown. */
async function readCandidate({ file }: { file: string }): Promise<{ content: string }> {
  const raw = await readFileSafe(file);

  if (raw === null) throw new Error(`Cannot read ${file}, which the import was to classify.`);

  return { content: raw.slice(0, MAX_CONTENT_CHARS) };
}

/**
 * `teamai import classify-reply`: what the AI tool said a file is. A reply that is not the JSON asked for reads as
 * personal, so the file is left out, as is a file the tool called personal.
 */
function classifyReply({ path: shown, reply }: { path: string; reply: string }): Classified {
  const cleaned = reply.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

  try {
    const parsed = ClassifyReplySchema.parse(JSON.parse(cleaned));
    const type = ItemTypeSchema.safeParse(parsed.type);

    return {
      type: type.success ? type.data : 'learning',
      title: parsed.title ?? path.basename(shown),
      summary: parsed.summary ?? '',
      tags: parsed.tags.flatMap((tag) => (tag === undefined ? [] : [tag])),
      personal: parsed.isPersonal ?? false,
    };
  } catch (parseErr: unknown) {
    log.warn(`AI classification parse failed, using conservative default (isPersonal=true): ${String(parseErr)}`);

    return { type: 'learning', title: path.basename(shown), summary: '', tags: [], personal: true };
  }
}

/**
 * `teamai import write-learnings`: writes each item that is not personal and was accepted, or edited with the note as
 * its title, as `<date>-<slug>.md`: by its type into rules/, docs/ or learnings/ of `target`, or with `byType` false into
 * `target` itself. Without a review every item is accepted. Says each file it wrote, or could not write.
 */
async function writeLearnings(flags: { classified: string; reviewed: string; target: string; byType: string }): Promise<{ kept: number; written: string[] }> {
  const classified = parseFlag(ClassifiedResultsSchema, '--classified', flags.classified);
  const reviewed = flags.reviewed.trim() === '' ? undefined : parseFlag(ReviewedResultsSchema, '--reviewed', flags.reviewed);
  const byType = parseBoolean('--by-type', flags.byType);
  const kept = classified.filter((entry) => !entry.outputs.personal);
  const answers = new Map(reviewed?.map((entry) => [entry.item.item.path, entry.outputs]));
  const written: string[] = [];

  for (const { item, outputs } of kept) {
    const answer = answers.get(item.path);

    if (reviewed !== undefined && (answer === undefined || answer.choice === 'skip')) continue;
    const title = answer?.choice === 'edit' && answer.note?.trim() ? answer.note.trim() : outputs.title;
    const destDir = byType ? path.join(flags.target, typeDir(outputs.type)) : flags.target;

    if (!byType) {
      try {
        assertSafePath(destDir, defaultAllowedRoots());
      } catch (err: unknown) {
        log.error(`refused to write to directory [${destDir}]: ${String(err)}`);
        continue;
      }
    }

    let destPath = path.join(destDir, buildFilename(title));

    // Two items of one title on one day, or one imported earlier today, keep their own files.
    for (let n = 2; written.includes(destPath) || fs.existsSync(destPath); n += 1) destPath = path.join(destDir, buildFilename(title, n));

    try {
      await ensureDir(destDir);
      await writeFile(destPath, buildMarkdown({ ...outputs, title }));
      log.info(`Wrote: ${destPath}`);
      written.push(destPath);
    } catch (err: unknown) {
      log.error(`Failed to write [${destPath}]: ${String(err)}`);
    }
  }

  return { kept: kept.length, written };
}

/** `teamai import publish-rules`: commits and pushes what an import of rules wrote into the team repo. */
async function publishRules(flags: { kept: string; written: string; target: string; byType: string }): Promise<Record<string, never>> {
  const written = parseFlag(z.array(z.string()), '--written', flags.written, 'teamai-import-rules');

  if (Number(flags.kept) === 0) log.info('all entries processed, no further interaction needed.');

  if (written.length > 0 && parseBoolean('--by-type', flags.byType)) {
    const { autoPushTeamRepo } = await import('./utils/git.js');
    await autoPushTeamRepo(flags.target, '[teamai] Import from local: tool rules');
  }

  log.success('Import complete');

  return {};
}

/** Said when an import's review has nobody to answer it, before anything else runs. */
const NOBODY_REVIEWS = 'This import asks a person to accept, edit or skip each item it found, and nobody can answer here: it runs inside a workflow step, or its input is not a terminal. Run it in your own terminal, or pass --all to accept every item.';

/** Said for `--resume`, which the import's workflow run replaced. */
const RESUME_REPLACED = 'teamai import --resume is gone: an import\'s review is part of its workflow run now. Continue a stopped import with teamai workflow resume <run>, the command it printed when it started.';

/** What an import that classifies and reviews items is told, and where its items go. */
export interface LearningsImport {
  /** Accept every item without asking. */
  all: boolean;
  /** The directory every item is written into, in place of the team repo. */
  output?: string;
  resume: boolean;
  /**
   * Load the member's config as a preview and start nothing. The CLI refuses `--dry-run` for these imports before they
   * run (`dry-run-guard.ts`), so only an in-process caller passes it.
   */
  dryRun: boolean;
  /** The command a person runs, as a refusal names it. */
  command: string;
}

/**
 * Starts `workflow`, which runs teamai-import-learnings into the member's team repo, or `output`, with `inputs` beside
 * where its items go. Refused, said and exited 1, before any AI call: `--resume`, no teamai init, what `ready` throws
 * once the config is loaded, and a review nobody can answer, inside a workflow step or with no terminal.
 */
async function start(workflow: string, inputs: Record<string, JsonValue>, options: LearningsImport, ready: () => void = () => {}): Promise<ShortcutEnd | undefined> {
  if (options.resume) {
    log.error(RESUME_REPLACED);
    process.exitCode = 1;

    return undefined;
  }

  const { autoDetectInit } = await import('./config.js');
  const { localConfig } = await autoDetectInit(undefined, { dryRun: options.dryRun });

  if (options.dryRun) return undefined;
  ready();
  const { runShortcut } = await import('./workflow-commands.js');
  const dir = options.output === undefined ? localConfig.repo.localPath : path.resolve(options.output);

  return runShortcut({
    workflow,
    inputs: { ...inputs, dir, by_type: options.output === undefined, all: options.all },
    command: options.command,
    json: false,
    nobodyAnswers: options.all ? undefined : NOBODY_REVIEWS,
  });
}

/** `teamai import --from-tools`: imports the rules of every tool through a teamai-import-rules run. */
function startRules(options: LearningsImport): Promise<ShortcutEnd | undefined> {
  return start('teamai-import-rules', {}, options);
}

export const ImportLearnings = { scanRules, readCandidate, classifyReply, writeLearnings, publishRules, start, startRules, parseFlag, parseBoolean, NOBODY_REVIEWS } as const;
