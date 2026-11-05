/**
 * Trying a scorer file before it is pushed: `teamai score --session <id> --scorer ./draft.md` starts the default workflow
 * teamai-try-scorer, which runs teamai-score on the session and on its control with `files` and `store: false`. A tried
 * label is never stored; the report sets it beside the labels the scope keeps of its scorer and the control's verdict.
 */
import path from 'node:path';
import { readFileSafe } from '../utils/fs.js';
import { NOT_A_SCORER, scorerSourceHash } from './cache.js';
import { formatScorerDiagnostic, parseScorer, type ScorerDefinition } from './definition.js';
import type { PinnedScorer } from './pin.js';

type Refusal = { ok: false; code: string; message: string };

function refused(code: string, message: string): Refusal {
  return { ok: false, code, message };
}

/** A scorer file read as `teamai pull` reads it, with the path it was named by, relative to the current directory. */
export interface TriedFile {
  scorer: string;
  file: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
}

/** The scorer file `value` names, relative to the current directory, read and parsed as `teamai pull` parses it. */
async function fileOf(value: string): Promise<TriedFile | Refusal> {
  const full = path.resolve(value);
  const file = path.relative(process.cwd(), full).split(path.sep).join('/');

  if (!file.endsWith('.md') || path.posix.basename(file) === 'README.md') return refused('scorer_invalid', formatScorerDiagnostic({ file, message: NOT_A_SCORER }));
  const content = await readFileSafe(full);

  if (content === null) return refused('scorer_not_found', formatScorerDiagnostic({ file, message: 'could not be read' }));
  const parsed = parseScorer(file, content);

  if (!parsed.ok) return refused('scorer_invalid', parsed.diagnostics.map(formatScorerDiagnostic).join('\n'));

  return { scorer: parsed.definition.name, file, definition: parsed.definition, pin: { sourceHash: scorerSourceHash(content), relativePath: file, content } };
}

export const TryScorer = {
  /** The scorer files `values` name, read once each, or why they cannot be tried together. */
  async files(values: readonly string[]): Promise<{ ok: true; files: TriedFile[] } | Refusal> {
    const files: TriedFile[] = [];

    for (const value of new Set(values)) {
      const read = await fileOf(value);

      if ('ok' in read) return read;
      const twin = files.find((other) => other.scorer === read.scorer);

      if (twin) return refused('invalid_arguments', `--scorer ${twin.file} and --scorer ${read.file} are both scorer ${read.scorer}. Judge them in separate commands.`);
      files.push(read);
    }

    return { ok: true, files };
  },
} as const;
