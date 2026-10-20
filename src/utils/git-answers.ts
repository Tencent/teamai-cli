import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { getCurrentVersion } from '../package-info.js';
import { writeFileAtomic } from './fs.js';
import { log } from './logger.js';

/**
 * What git answered, remembered under a stamp that changes whenever the answer
 * could (repositoryStamp, linkedWorktreesStamp): for the rest of the run, and
 * on disk for later runs. Every command, each hook included, otherwise started
 * git twice for answers that change only with their stamp.
 */
export interface GitAnswers<T> {
  /**
   * The answer remembered for `key` under `stamp`, else `read()`'s, then
   * remembered. Callers asking at the same time share one read. A null is
   * not remembered: the next ask reads again.
   */
  answer(key: string, stamp: string, read: () => Promise<T | null>): Promise<T | null>;
}

export const GitAnswers = {
  /** The answers of one kind, each checked against `schema` when read back from disk. */
  of<T>(kind: string, schema: z.ZodType<T>): GitAnswers<T> {
    const known = new Map<string, { stamp: string; answer: Promise<T | null> }>();
    return {
      async answer(key, stamp, read) {
        const remembered = known.get(key);
        if (remembered?.stamp === stamp) return remembered.answer;
        const answer = (async () => {
          const kept = (await keptNow())[kind]?.[key];
          const keptAnswer = kept?.stamp === stamp ? schema.safeParse(kept.answer) : undefined;
          if (keptAnswer?.success) return keptAnswer.data;
          const fresh = await read();
          if (fresh !== null) await keep(kind, key, { stamp, answer: fresh });
          return fresh;
        })();
        known.set(key, { stamp, answer });
        if (await answer === null && known.get(key)?.answer === answer) known.delete(key);
        return answer;
      },
    };
  },
} as const;

/** The newest answers of each kind that stay on disk. */
const KEPT_PER_KIND = 64;

const Kept = z.record(z.string(), z.record(z.string(), z.object({ stamp: z.string(), answer: z.unknown() })));
type Kept = z.infer<typeof Kept>;

let keptFileAt: { tmp: string; file: Promise<string | null> } | undefined;
let keptAtStart: { file: string; answers: Promise<Kept> } | undefined;
const unwritten: Array<{ kind: string; key: string; entry: Kept[string][string] }> = [];
let writing: Promise<void> = Promise.resolve();

/**
 * Where the answers are kept: `teamai-<uid>/git-answers-<version>.json` in
 * the temporary directory, beside Node's compile cache, so a dry run leaves the
 * TeamAI home as it found it. One file per CLI version: another release may
 * stamp or answer differently under the same keys. Null, and nothing kept,
 * when that directory is not this user's alone (another user made it in a
 * shared /tmp), or where its owner cannot be read this way (Windows): answers
 * read from there would say where teamai writes.
 */
function keptFile(): Promise<string | null> {
  const tmp = os.tmpdir();
  if (keptFileAt?.tmp === tmp) return keptFileAt.file;
  const file = (async () => {
    const uid = process.getuid?.();
    if (uid === undefined) return null;
    const dir = path.join(tmp, `teamai-${uid}`);
    await fs.promises.mkdir(dir, { mode: 0o700 }).catch(() => undefined);
    const stat = await fs.promises.lstat(dir).catch(() => null);
    if (!stat?.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) return null;
    return path.join(dir, `git-answers-${getCurrentVersion()}.json`);
  })();
  keptFileAt = { tmp, file };
  return file;
}

/** The answers kept in `file`: none when it is missing, unreadable, or not in their shape. */
async function readKept(file: string): Promise<Kept> {
  const text = await fs.promises.readFile(file, 'utf8').catch(() => '');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const parsed = Kept.safeParse(json);
  return parsed.success ? parsed.data : {};
}

/** The answers kept when this run first looked, read once per file. */
async function keptNow(): Promise<Kept> {
  const file = await keptFile();
  if (file === null) return {};
  if (keptAtStart?.file !== file) keptAtStart = { file, answers: readKept(file) };
  return keptAtStart.answers;
}

/**
 * Keep one more answer: merged into what is on disk then, the oldest of its
 * kind dropped past KEPT_PER_KIND. Writes from this run go one at a time,
 * each taking every answer not yet written. Runs writing at once keep one
 * run's answers; the other asks git again next time.
 */
function keep(kind: string, key: string, entry: Kept[string][string]): Promise<void> {
  unwritten.push({ kind, key, entry });
  writing = writing.then(async () => {
    if (unwritten.length === 0) return;
    const taken = unwritten.splice(0);
    const file = await keptFile();
    if (file === null) return;
    const answers = await readKept(file);
    for (const { kind, key, entry } of taken) {
      const entries = answers[kind] ??= {};
      // Deleted first, so the answer becomes the newest.
      delete entries[key];
      entries[key] = entry;
      for (const old of Object.keys(entries).slice(0, -KEPT_PER_KIND)) delete entries[old];
    }
    try {
      await writeFileAtomic(file, JSON.stringify(answers));
    } catch (error) {
      log.debug(`git answers not kept in ${file}, the next run asks git again: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return writing;
}
