/**
 * An attempt's result file, what its step gave: written by the step's tool, or by teamai for a command, a failed
 * confined run, or a tool that answered on stdout. The copy kept on disk holds no secret of the run: teamai masks what
 * it writes before writing it, and a driver masks what a tool wrote once the attempt ends. `teamai/attempt-result-writes`
 * keeps every write of teamai's own here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from '../utils/fs.js';
import { redact, redactJson } from '@teamai/shared/redact';
import type { WorkflowFailure } from './types.js';
import { readRegularFile } from '@teamai/shared/regular-file';

/** What teamai writes as an attempt's result: the step's output and its failure, or the output a failed confined tool gave. */
export type AttemptResultBody = { output?: unknown; failure?: WorkflowFailure } | { raw: string };

/** Writes `body` as the result file `file`, with each of `secrets` masked in it. */
async function write(file: string, body: AttemptResultBody, secrets: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, redactJson(body, secrets));
}

/**
 * Masks each of `secrets` in the result file `file` a tool wrote, so the copy it keeps on disk carries none. A file that
 * is not JSON, such as one a tool stopped writing halfway, is masked as text.
 */
async function mask(file: string, secrets: Record<string, string>): Promise<void> {
  const text = await readRegularFile(file, 'utf8').catch(() => null);

  if (text === null) return;
  let kept: unknown;

  try {
    kept = JSON.parse(text);
  } catch {
    // Text a tool wrote as JSON holds a secret with a quote or a backslash in its escaped form.
    const escaped = Object.fromEntries(Object.entries(secrets).map(([label, value]) => [label, JSON.stringify(value).slice(1, -1)]));
    const masked = redact(redact(text, { envSecrets: escaped, patterns: false }), { envSecrets: secrets, patterns: false });

    if (masked !== text) await writeFileAtomic(file, masked);

    return;
  }

  const masked = redactJson(kept, secrets);

  if (JSON.stringify(masked) !== JSON.stringify(kept)) await writeJsonAtomic(file, masked);
}

/**
 * Removes the result file `file` a run of the step's tool left, before the tool starts anew, so the attempt reads only
 * the result its own run writes. Anything but a regular file is left for the reader to refuse.
 */
async function removeLeft(file: string): Promise<void> {
  const left = await fs.lstat(file).catch(() => undefined);

  if (left?.isFile()) await fs.rm(file, { force: true });
}

export const AttemptResult = { write, mask, removeLeft } as const;
