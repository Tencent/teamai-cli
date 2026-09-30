import crypto from 'node:crypto';
import path from 'node:path';
import fse from 'fs-extra';
import type { DeliveryTarget, ResourceItem } from '../types.js';
import { fileHash, listFilesRecursive } from '../utils/fs.js';
import { log } from '../utils/logger.js';

/**
 * What teamai last wrote at each skill, rule and agent file it delivered into
 * one checkout, and what pull does with a copy that no longer has those bytes
 * (#822). A copy is the member's edit only when it has a record and differs
 * from it: without a record, pull writes as it always has.
 */

/** sha256 of the bytes teamai last wrote, by absolute destination file path. */
export type DeliveredHashes = Record<string, string>;

/**
 * One file of a delivered copy, as hashes: on disk (null when missing), on
 * record (undefined when teamai never recorded writing it), and what pull
 * writes there now (null when the team version no longer has the file).
 */
export interface DeliveredFile {
  disk: string | null;
  recorded: string | undefined;
  next: string | null;
}

export type CopyVerdict =
  | { kind: 'write' }
  | { kind: 'keep'; teamChanged: boolean };

/** Push does not count a skill's CONTRIBUTORS as a change, so neither does this. */
const CONTRIBUTORS_FILE = 'CONTRIBUTORS';

/**
 * Keep a copy only on proof that the member changed it: a recorded file whose
 * bytes are neither what teamai wrote nor what it would write now. A skill is
 * one copy, kept whole, as push reads it. A copy with no file left is written,
 * so deleting it is how the member takes the team version back.
 */
export function classifyCopy(files: readonly DeliveredFile[]): CopyVerdict {
  if (files.every((file) => file.disk === null)) return { kind: 'write' };
  const edited = files.some((file) => file.recorded !== undefined && file.disk !== file.recorded && file.disk !== file.next);
  if (!edited) return { kind: 'write' };
  return { kind: 'keep', teamChanged: files.some((file) => file.next !== (file.recorded ?? null)) };
}

/** A pull's view of the checkout's record, and the copies it kept. */
export interface DeliveryLedger {
  /** The record the pull started from; undefined when there is none yet, which protects nothing. */
  readonly previous: DeliveredHashes | undefined;
  /** What the pull leaves on record: `previous` with its writes and removals applied. */
  readonly hashes: DeliveredHashes;
  readonly kept: { dest: string; teamRelPath: string; teamChanged: boolean }[];
}

export function openLedger(previous: DeliveredHashes | undefined): DeliveryLedger {
  return { previous, hashes: { ...previous }, kept: [] };
}

function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** The recorded paths of the copy at `dest`: the file, or every file under the skill directory. */
function recordedUnder(hashes: DeliveredHashes, dest: string): string[] {
  return Object.keys(hashes).filter((file) => file === dest || file.startsWith(dest + path.sep));
}

/**
 * Each file pull writes for `target`, with its hash, plus each recorded file
 * the team version no longer has. A rule or an agent is the rendered file; a
 * skill is every team file, with SKILL.md as pull repairs its frontmatter.
 */
async function nextHashes(previous: DeliveredHashes, item: ResourceItem, target: DeliveryTarget): Promise<Map<string, string | null>> {
  if (item.type !== 'skills') {
    return new Map([[target.dest, target.content === undefined ? null : sha256(target.content)]]);
  }
  const { withSkillFrontmatter } = await import('./skills.js');
  const next = new Map<string, string | null>();
  for (const file of await listFilesRecursive(item.sourcePath)) {
    if (path.basename(file) === CONTRIBUTORS_FILE) continue;
    const bytes = await fse.readFile(path.join(item.sourcePath, file));
    const text = bytes.toString('utf-8');
    const written = file === 'SKILL.md' ? withSkillFrontmatter(text, item.name) : text;
    next.set(path.join(target.dest, file), sha256(written === text ? bytes : written));
  }
  for (const file of recordedUnder(previous, target.dest)) {
    if (!next.has(file)) next.set(file, null);
  }
  return next;
}

async function withDisk(previous: DeliveredHashes, next: Iterable<[string, string | null]>): Promise<DeliveredFile[]> {
  return Promise.all([...next].map(async ([file, hash]) => ({ disk: await fileHash(file), recorded: previous[file], next: hash })));
}

/** What pull does with `target`'s copy of `item`. Read-only. */
export async function judgeCopy(previous: DeliveredHashes | undefined, item: ResourceItem, target: DeliveryTarget): Promise<CopyVerdict> {
  if (previous === undefined) return { kind: 'write' };
  return classifyCopy(await withDisk(previous, await nextHashes(previous, item, target)));
}

/** Whether pull leaves `target`'s copy as the member changed it; a kept copy is named by reportKept. */
export async function keepsEditedCopy(ledger: DeliveryLedger, item: ResourceItem, target: DeliveryTarget): Promise<boolean> {
  const verdict = await judgeCopy(ledger.previous, item, target);
  if (verdict.kind === 'write') return false;
  ledger.kept.push({ dest: target.dest, teamRelPath: item.relativePath, teamChanged: verdict.teamChanged });
  return true;
}

/**
 * Whether the copy at `dest` of a resource the team removed has changed since
 * teamai delivered it. Without a record it has not, and is removed as before.
 */
export async function removedCopyChanged(previous: DeliveredHashes | undefined, dest: string): Promise<boolean> {
  if (previous === undefined) return false;
  const files = await withDisk(previous, recordedUnder(previous, dest).map((file) => [file, null]));
  return classifyCopy(files).kind === 'keep';
}

/**
 * Record what teamai just wrote at `dest`: the file, or for a skill, each
 * file of its team version `skillSource`. Files only the member has are not
 * recorded, so they never count as an edit.
 */
export async function recordDelivered(hashes: DeliveredHashes, dest: string, skillSource?: string): Promise<void> {
  forgetDelivered(hashes, dest);
  const files = skillSource === undefined
    ? [dest]
    : (await listFilesRecursive(skillSource))
      .filter((file) => path.basename(file) !== CONTRIBUTORS_FILE)
      .map((file) => path.join(dest, file));
  for (const file of files) {
    const hash = await fileHash(file);
    if (hash !== null) hashes[file] = hash;
  }
}

export function forgetDelivered(hashes: DeliveredHashes, dest: string): void {
  for (const file of recordedUnder(hashes, dest)) delete hashes[file];
}

/**
 * Name each copy pull kept, with the step that shares it or takes the team
 * version. The step is `pull --force`: this pull has recorded the team
 * revision, so a plain pull after it would skip the sync.
 */
export function reportKept(ledger: DeliveryLedger, scopeLabel: string): void {
  const named = new Set<string>();
  for (const { dest, teamRelPath, teamChanged } of ledger.kept.splice(0)) {
    if (named.has(dest)) continue;
    named.add(dest);
    if (teamChanged) {
      log.warn(
        `[${scopeLabel}] Kept ${dest}: you changed it, and the team version (${teamRelPath}) has changed since. `
        + 'Merge the team change into your copy and share it with `teamai push`, '
        + 'or delete your copy and run `teamai pull --force` to take the team version.',
      );
    } else {
      log.info(
        `[${scopeLabel}] Kept ${dest}: you changed it since teamai delivered it. `
        + 'Share it with `teamai push`, or delete it and run `teamai pull --force` to get the team version back.',
      );
    }
  }
}
