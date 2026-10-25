import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readFileSafe, writeJsonAtomic } from '../../utils/fs.js';
import type { WorkflowFailure } from '../types.js';
import { changedPaths, snapshotWorktree } from './worktree-snapshot.js';

const SnapshotSchema = z.object({
  ok: z.boolean(),
  head: z.string().optional(),
  branch: z.string(),
  files: z.array(z.tuple([z.string(), z.string()])),
});

/** A reader step in `dir`: what `dir` holds before it runs, by path and content hash, saved to `file`. */
export async function stageReader(dir: string, file: string): Promise<void> {
  const before = await snapshotWorktree(dir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, { ...before, files: [...before.files] });
}

/**
 * Why a reader step that ran in `dir` fails: it changed what `stageReader` saved in `file`. A command is checked only
 * when it succeeded, so a failing command keeps its own failure; a prompt is checked whatever its tool reported. An
 * interactive prompt that does not set `workspace: read-only` may write, so it is never checked.
 */
export async function finishReader(input: {
  dir: string;
  file: string;
  executor: 'command' | 'prompt';
  outcome: 'success' | 'failed' | 'released';
  interactive?: true;
  readOnly?: true;
}): Promise<WorkflowFailure | undefined> {
  if (input.interactive && !input.readOnly) return undefined;
  if (input.outcome === 'released' || (input.executor === 'command' && input.outcome !== 'success')) return undefined;
  const saved = SnapshotSchema.safeParse(JSON.parse(await readFileSafe(input.file) ?? 'null'));
  if (!saved.success) {
    return { code: 'read_only_dirty', message: `The snapshot of ${input.dir} taken before the step is missing or unreadable (${input.file}), so its changes cannot be checked.` };
  }
  const paths = changedPaths({ ...saved.data, files: new Map(saved.data.files) }, await snapshotWorktree(input.dir));
  if (paths.length === 0) return undefined;
  return { code: 'read_only_dirty', message: `Read-only ${input.executor} step changed repository paths: ${paths.join(', ')}` };
}
