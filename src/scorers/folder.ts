import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FOLDER_MARKERS } from '../folder-markers.js';
import { WorkflowFolder } from '../workflow/folder.js';

// ─── Scorer folders ──────────────────────────────────────
//
//  scorers/[<ns>/]<name>/SCORER.md with the files its judge
//  reads beside it. Pull keeps every support file in the
//  scorer's cache entry, so a run pins them with the rubric
//  and its sourceHash covers them. A judge reads only its
//  evidence directory, so `score evidence` writes the files
//  there and renders ${TEAMAI_SCORER_DIR} to that copy.
//

/** The file that makes a directory under `scorers/` a scorer folder. */
export const SCORER_MARKER = FOLDER_MARKERS.scorers.marker;

/** The variable a scorer folder's prompt names its folder with, as `${TEAMAI_RULE_DIR}` names a rule folder's. */
const SCORER_DIR_VARIABLE = 'TEAMAI_SCORER_DIR';

const PLACEHOLDER = `\${${SCORER_DIR_VARIABLE}}`;

/** A `/`-separated path inside a folder: no empty, `.` or `..` segment, so it never leaves the folder it is written in. */
const FolderPathSchema = z.string().refine((file) => file.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('\\')), 'must be a path inside the folder');

/** One support file of a scorer folder: its path from the folder and its text with LF line endings. */
export const ScorerFolderFileSchema = z.object({ path: FolderPathSchema, content: z.string() });

export type ScorerFolderFile = z.infer<typeof ScorerFolderFileSchema>;

/** A scorer folder's `SCORER.md` and its support files, or why it is not one. */
export type ScorerFolderRead =
  | { readonly kind: 'folder'; readonly content: string; readonly files: ScorerFolderFile[] }
  | { readonly kind: 'invalid'; readonly problem: string };

/** The scorer folder at `dir`, read as a workflow folder is: UTF-8 text, no symlink, 1 MB in all. */
async function read(dir: string): Promise<ScorerFolderRead> {
  const found = await WorkflowFolder.read(dir);

  if (found.kind === 'invalid') return found;
  const marker = found.files.find((file) => file.path === SCORER_MARKER);

  if (marker === undefined) return { kind: 'invalid', problem: `${SCORER_MARKER} cannot be read` };

  return { kind: 'folder', content: marker.content, files: found.files.flatMap((file) => (file === marker ? [] : [{ path: file.path, content: file.content }])) };
}

/** Whether `text` names a scorer folder through `${TEAMAI_SCORER_DIR}`. */
function mentions(text: string): boolean {
  return text.includes(PLACEHOLDER);
}

/** Why the scorer file `file`, which is no folder, cannot name `${TEAMAI_SCORER_DIR}`. */
function fileFormProblem(file: string): string {
  return `names ${PLACEHOLDER}, which only a scorer folder has: move it to ${file.replace(/\.md$/, '')}/${SCORER_MARKER} with the files it names beside it`;
}

/** Where scorer `name`'s files are written in the evidence directory `evidenceDir`. */
function dirIn(evidenceDir: string, name: string): string {
  return path.join(evidenceDir, 'scorers', name);
}

/** `prompt` with each `${TEAMAI_SCORER_DIR}` replaced by `dir`, with forward slashes on every platform. */
function render(prompt: string, dir: string): string {
  return prompt.split(PLACEHOLDER).join(dir.split(path.sep).join('/'));
}

/** Whether `relativePath`, a path in the team repo, is a scorer folder's marker. `scorers/SCORER.md` sits in no folder of its own: it is the file-form scorer SCORER. */
function marks(relativePath: string): boolean {
  return path.posix.basename(relativePath) === SCORER_MARKER && path.posix.dirname(relativePath) !== 'scorers';
}

/** Writes `files` under `dir`, which the judge reads. */
async function write(dir: string, files: readonly ScorerFolderFile[]): Promise<void> {
  for (const file of files) {
    const full = path.join(dir, ...file.path.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, file.content);
  }
}

export const ScorerFolder = { marks, read, mentions, fileFormProblem, dirIn, render, write } as const;
