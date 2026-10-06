import crypto from 'node:crypto';
import path from 'node:path';
import fse from 'fs-extra';
import type { AgentModelRecords, DeliveryTarget, ResourceItem } from '../types.js';
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
  /**
   * The model each agent copy received (#830): the record the pull started
   * from until it writes that copy, then what it wrote. A copy pull kept or
   * held keeps its old entry.
   */
  readonly agentModels: AgentModelRecords;
  /**
   * Agents pull held because their model cannot be resolved (#830), said
   * once per reason after the pass: `tools` when only those tools are held,
   * `everyTool` when no tool the agent targets received it.
   */
  readonly held: { name: string; reason: string; tools?: string[]; everyTool: boolean }[];
}

export function openLedger(previous: DeliveredHashes | undefined, agentModels?: AgentModelRecords): DeliveryLedger {
  return {
    previous,
    hashes: { ...previous },
    kept: [],
    held: [],
    agentModels: Object.fromEntries(Object.entries(agentModels ?? {}).map(([stem, byTool]) => [stem, { ...byTool }])),
  };
}

/** sha256 of `content`, as `fileHash` and the record spell it. */
export function contentHash(content: string | Buffer): string {
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
    return new Map([[target.dest, target.content === undefined ? null : contentHash(target.content)]]);
  }
  const { withSkillFrontmatter } = await import('./skills.js');
  const next = new Map<string, string | null>();
  for (const file of await listFilesRecursive(item.sourcePath)) {
    if (path.basename(file) === CONTRIBUTORS_FILE) continue;
    const bytes = await fse.readFile(path.join(item.sourcePath, file));
    const text = bytes.toString('utf-8');
    const written = file === 'SKILL.md' ? withSkillFrontmatter(text, item.name) : text;
    next.set(path.join(target.dest, file), contentHash(written === text ? bytes : written));
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

/**
 * Whether `file` holds the bytes the record has for it, or for `recordAt`
 * (the file a tool copied it from): on record and unchanged since.
 */
export async function recordedUnchanged(previous: DeliveredHashes | undefined, file: string, recordAt: string = file): Promise<boolean> {
  const recorded = previous?.[recordAt];
  return recorded !== undefined && recorded === await fileHash(file);
}

/**
 * Give `file`, which has no record, the record `hash` of the copy it was made
 * from, so pull treats it as that copy: kept once it differs. Returns whether
 * it did; a pull with no record at all protects nothing, so it does not.
 */
export function adoptRecord(ledger: DeliveryLedger, file: string, hash: string): boolean {
  if (ledger.previous === undefined || ledger.previous[file] !== undefined) return false;
  ledger.previous[file] = hash;
  ledger.hashes[file] = hash;
  return true;
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
        // The change may be the team's or the member's own model alias override.
        `[${scopeLabel}] Kept ${dest}: you changed it, and the version teamai would deploy there (${teamRelPath}) has changed since. `
        + 'Merge that change into your copy and share it with `teamai push`, '
        + 'or delete your copy and run `teamai pull --force` to take that version.',
      );
    } else {
      log.info(
        `[${scopeLabel}] Kept ${dest}: you changed it since teamai delivered it. `
        + 'Share it with `teamai push`, or delete it and run `teamai pull --force` to get the team version back.',
      );
    }
  }
}
