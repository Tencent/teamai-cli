import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
import { copyRegularFile } from '@teamai/shared/regular-file';
import { copyDir, dirContentEqual, dirTeamSubsetEqual, fileContentEqual, isDraft, listFilesRecursive, pathExists, readFileSafe } from '../utils/fs.js';
import { splitFrontmatter } from '../utils/frontmatter.js';

const SKILL_MD = 'SKILL.md';

/**
 * Where a team skill comes from: a folder holding SKILL.md, or the file form `skills/[<ns>/]<name>.md`, which pull
 * delivers as `<name>/SKILL.md`, exactly as a folder holding only SKILL.md. A team skill folder's name never ends in
 * `.md` (the skills layout's name rule), so the path alone tells the two apart.
 */
export type TeamSkillSource = string;

function isFile(source: TeamSkillSource): boolean {
  return source.endsWith('.md');
}

/** The skill's name: its folder's, or its file's without `.md`. */
function name(source: TeamSkillSource): string {
  const base = path.basename(source);

  return isFile(source) ? base.slice(0, -'.md'.length) : base;
}

/** The file delivered as the skill's SKILL.md. */
function skillMd(source: TeamSkillSource): string {
  return isFile(source) ? source : path.join(source, SKILL_MD);
}

/** The files a delivery writes, by their `/`-separated path in the skill directory, as `listFilesRecursive` lists a folder. */
async function files(source: TeamSkillSource): Promise<string[]> {
  if (!isFile(source)) return listFilesRecursive(source);

  return await pathExists(source) ? [SKILL_MD] : [];
}

/** Where the file a delivery writes at `rel` (`files`) is read from. */
function fileAt(source: TeamSkillSource, rel: string): string {
  return isFile(source) ? source : path.join(source, ...rel.split('/'));
}

/** Copy the skill into the directory `dest`, as `copyDir` copies a folder: `skip` names paths in it left as `dest` has them. */
async function copyTo(source: TeamSkillSource, dest: string, onLink?: (relativePath: string) => void, skip: readonly string[] = []): Promise<void> {
  if (!isFile(source)) return copyDir(source, dest, onLink, skip);

  if (isDraft(source) || skip.includes(SKILL_MD)) return;
  await fse.ensureDir(dest);
  await copyRegularFile(source, path.join(dest, SKILL_MD));
}

/** Whether the skill directory `copy` holds exactly the team skill at `source`, as `dirContentEqual` compares two folders. */
async function equalsCopy(copy: string, source: TeamSkillSource, ignore?: string[]): Promise<boolean> {
  if (!isFile(source)) return dirContentEqual(copy, source, ignore);
  const copyFiles = (await listFilesRecursive(copy)).filter((rel) => !ignore?.some((ignored) => rel.split('/').includes(ignored)));

  return await pathExists(source) && copyFiles.length === 1 && copyFiles[0] === SKILL_MD && fileContentEqual(path.join(copy, SKILL_MD), source);
}

/** Whether every file of the team skill at `source` is in the skill directory `copy` with the same bytes, as `dirTeamSubsetEqual` compares two folders. */
async function isInCopy(copy: string, source: TeamSkillSource, ignore?: string[]): Promise<boolean> {
  if (!isFile(source)) return dirTeamSubsetEqual(copy, source, ignore);

  return await pathExists(copy) && await pathExists(source) && fileContentEqual(path.join(copy, SKILL_MD), source);
}

/** Whether the team skills at `a` and `b` deliver the same files with the same bytes, as `dirContentEqual` compares two folders. */
async function sameFiles(a: TeamSkillSource, b: TeamSkillSource): Promise<boolean> {
  if (!isFile(a) && !isFile(b)) return dirContentEqual(a, b);
  const [filesA, filesB] = await Promise.all([files(a), files(b)]);

  if (filesA.length === 0 || filesA.length !== filesB.length || filesA.some((rel) => !filesB.includes(rel))) return false;

  for (const rel of filesA) {
    if (!await fileContentEqual(fileAt(a, rel), fileAt(b, rel))) return false;
  }

  return true;
}

const DescribedSchema = z.object({ description: z.string().trim().min(1) });

/**
 * Whether the file `file` is a skill rather than notes kept beside the skills: its frontmatter has a description, which
 * `review --branch` asks of every skill. Team repos kept notes such as NOTES.md in skills/ before a file could be a skill.
 */
async function isDescribed(file: string): Promise<boolean> {
  const content = await readFileSafe(file);

  return content !== null && describes(content);
}

/** Whether a skill file's text `content` makes it a skill (`isDescribed`). */
function describes(content: string): boolean {
  return DescribedSchema.safeParse(splitFrontmatter(content).data).success;
}

export const TeamSkillSource = { isFile, isDescribed, describes, name, skillMd, files, fileAt, copyTo, equalsCopy, isInCopy, sameFiles } as const;
