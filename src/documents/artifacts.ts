import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readDocument } from './okf.js';

const exec = promisify(execFile);
const gitId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const ArtifactSchema = z.object({
  path: z.string().min(1).refine((value) => !path.posix.isAbsolute(value) && !value.includes('\\')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..') && !value.includes('\0'), 'Use a repository-relative file path.'),
  commit: gitId,
  blob: gitId,
}).strict();
export const ArtifactsSchema = z.array(ArtifactSchema).min(1).superRefine((items, ctx) => {
  if (new Set(items.map((item) => item.path)).size !== items.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Artifact paths must be unique.' });
});
export type ArtifactReference = z.infer<typeof ArtifactSchema>;

export const SDLC_TYPES = { intent: 'Intent', spec: 'Specification', plan: 'Implementation Plan' } as const;
export type SdlcStage = keyof typeof SDLC_TYPES;

export function taskDirectory(workspace: string, task: string): string {
  const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  if (!id.test(workspace) || !id.test(task)) throw new Error('Workspace and task IDs must be immutable IDs without path separators.');
  return `intent/${workspace}/${task}`;
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}

/** Resolve every component without following symlinks into another tree. */
export async function documentPath(root: string, relative: string): Promise<string> {
  ArtifactSchema.shape.path.parse(relative);
  const canonical = await realpath(root);
  let current = canonical;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing a document path through a symbolic link: ${relative}`);
  }
  if (!(await lstat(current)).isFile()) throw new Error(`Not a document file: ${relative}`);
  return current;
}

/** Validate the destination before an authoring prompt can write anything. */
export async function checkTaskLocation(root: string, workspace: string, task: string): Promise<string> {
  const repository = await git(root, ['rev-parse', '--show-toplevel']);
  if (await realpath(repository) !== await realpath(root)) throw new Error('Run the document check from the business repository root.');
  const directory = taskDirectory(workspace, task);
  let current = await realpath(root);
  for (const part of directory.split('/')) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Task directory conflicts with an existing file or symbolic link: ${directory}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return directory;
}

/** Read committed bytes and prove the current checkout still has the same content. */
export async function checkArtifact(root: string, relative: string, expected?: ArtifactReference): Promise<ArtifactReference> {
  const fullPath = await documentPath(root, relative);
  const commit = expected?.commit ?? await git(root, ['rev-parse', 'HEAD']);
  const parsed = ArtifactSchema.parse({ path: relative, commit, blob: expected?.blob ?? await git(root, ['rev-parse', `${commit}:${relative}`]) });
  if (await git(root, ['cat-file', '-t', parsed.blob]) !== 'blob'
    || await git(root, ['rev-parse', `${parsed.commit}:${relative}`]) !== parsed.blob) {
    throw new Error(`Artifact is not the recorded file at its commit: ${relative}`);
  }
  const current = await git(root, ['hash-object', `--path=${relative}`, '--', fullPath]);
  if (current !== parsed.blob) throw new Error(`Document changed since its recorded commit; review it again: ${relative}`);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(fullPath));
  const document = readDocument(content, relative);
  if (document.diagnostics.length) throw new Error(`${relative}: ${document.diagnostics.map((entry) => entry.message).join('; ')}`);
  if (!document.body.trim()) throw new Error(`Task document body is empty: ${relative}`);
  return parsed;
}

export async function checkTaskDocuments(root: string, workspace: string, task: string, stage: SdlcStage, expected: ArtifactReference[] = []): Promise<ArtifactReference[]> {
  const directory = await checkTaskLocation(root, workspace, task);
  const names = Object.keys(SDLC_TYPES) as SdlcStage[];
  if (!names.includes(stage)) throw new Error('Stage must be intent, spec or plan.');
  const selected = names.slice(0, names.indexOf(stage) + 1);
  for (const item of expected) {
    if (!selected.some((name) => item.path === `${directory}/${name}.md`)) throw new Error(`Approval belongs to another task or stage: ${item.path}`);
    await checkArtifact(root, item.path, item);
  }
  const artifacts: ArtifactReference[] = [];
  for (const name of selected) {
    const relative = `${directory}/${name}.md`;
    const artifact = await checkArtifact(root, relative);
    const doc = readDocument(await readFile(path.join(root, relative), 'utf8'), relative);
    if (doc.data.type !== SDLC_TYPES[name]) throw new Error(`${relative}: expected task type ${SDLC_TYPES[name]}.`);
    artifacts.push(artifact);
  }
  return artifacts;
}
