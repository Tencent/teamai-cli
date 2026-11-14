import path from 'node:path';
import { readFileSafe } from '../utils/fs.js';
import { NOT_A_SCORER, scorerSourceHash } from './cache.js';
import { formatScorerDiagnostic, parseScorer, type ScorerDefinition } from './definition.js';
import type { PinnedScorer } from './pin.js';
import { ScorerFolder, type ScorerFolderFile } from './folder.js';

// The scorer files a teamai-try-scorer run tries, read as `teamai pull` reads them.

export type Refusal = { ok: false; code: string; message: string };

export function refused(code: string, message: string): Refusal {
  return { ok: false, code, message };
}

/** A scorer file read as `teamai pull` reads it, with its path relative to the current directory, or absolute outside it. */
export interface TriedFile {
  scorer: string;
  file: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
}

/** The text of the scorer file at `full`, and the files beside it when it is a scorer folder's `SCORER.md`, or why it cannot be read. */
async function readTried(full: string, file: string, place: string): Promise<{ content: string; files?: ScorerFolderFile[] } | Refusal> {
  if (!ScorerFolder.marks(place)) {
    const content = await readFileSafe(full);

    return content === null ? refused('scorer_not_found', formatScorerDiagnostic({ file, message: 'could not be read' })) : { content };
  }

  const folder = await ScorerFolder.read(path.dirname(full));

  return folder.kind === 'folder' ? { content: folder.content, files: folder.files } : refused('scorer_invalid', formatScorerDiagnostic({ file, message: `${path.dirname(file)}/ is not a valid scorer folder: ${folder.problem}` }));
}

/** The scorer file `value` names, relative to the current directory, read and parsed as `teamai pull` parses it. */
async function fileOf(value: string): Promise<TriedFile | Refusal> {
  const full = path.resolve(value);
  const relative = path.relative(process.cwd(), full);
  const file = relative.startsWith('..') || path.isAbsolute(relative) ? full : relative.split(path.sep).join('/');

  if (!file.endsWith('.md') || path.posix.basename(file) === 'README.md') return refused('scorer_invalid', formatScorerDiagnostic({ file, message: NOT_A_SCORER }));
  // A tried file sits in no team repo: its path from here stands for its place in one, or, with no directory in it, the directory it is in and its name.
  const place = file !== full && file.includes('/') ? file : path.posix.join(path.basename(path.dirname(full)), path.basename(full));
  const read = await readTried(full, file, place);

  if ('ok' in read) return read;
  const parsed = parseScorer(place, read.content);

  if (!parsed.ok) return refused('scorer_invalid', parsed.diagnostics.map((diagnostic) => formatScorerDiagnostic({ ...diagnostic, file })).join('\n'));

  if (read.files === undefined && ScorerFolder.mentions(parsed.definition.prompt)) return refused('scorer_invalid', formatScorerDiagnostic({ file, message: ScorerFolder.fileFormProblem(file) }));
  const pin: PinnedScorer = { sourceHash: scorerSourceHash(read.content, read.files), relativePath: file, content: read.content };

  if (read.files !== undefined) pin.files = read.files;

  return { scorer: parsed.definition.name, file, definition: parsed.definition, pin };
}

/** The scorer files `values` name, read once each, or why they cannot be tried together. */
async function readAll(values: readonly string[]): Promise<{ ok: true; files: TriedFile[] } | Refusal> {
  const read: TriedFile[] = [];

  for (const value of new Set(values)) {
    const one = await fileOf(value);

    if ('ok' in one) return one;
    const twin = read.find((other) => other.scorer === one.scorer);

    if (twin) return refused('invalid_arguments', `--scorer ${twin.file} and --scorer ${one.file} are both scorer ${one.scorer}. Judge them in separate commands.`);
    read.push(one);
  }

  return { ok: true, files: read };
}

export const TriedFile = { readAll } as const;
