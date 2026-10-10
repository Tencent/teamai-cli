import crypto from 'node:crypto';
import path from 'node:path';
import fse from 'fs-extra';
import { gitTracks, gitUntracked } from '../git-exclude.js';
import type { DeliveryRecorder } from '../git-exclude-delivered.js';
import type { AgentModelRecords, CopyOrigin, DeliveryTarget, ResourceItem } from '../types.js';
import { fileHash, listFilesRecursive } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { matchesHistory } from '../utils/team-history.js';
import { warnOnce } from '../utils/warn-once.js';

/**
 * What teamai last wrote at each skill, rule and agent file it delivered into
 * one checkout, and what pull does with a copy that no longer has those bytes
 * (#822). A copy is the member's edit only when it has a record and differs
 * from it. A file with no record is teamai's only on proof (#993): it holds
 * teamai's render of the resource at some revision of the team repo's history
 * (`isTeamaiCopy`). Otherwise it is the member's, and pull neither writes nor
 * deletes it. Where no file exists, pull writes.
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
  | { kind: 'keep'; teamChanged: boolean }
  /** A file with no record that teamai cannot prove its own (#993). */
  | { kind: 'member' };

/** Push does not count a skill's CONTRIBUTORS as a change, so neither does this. */
const CONTRIBUTORS_FILE = 'CONTRIBUTORS';
const SKILL_MD = 'SKILL.md';

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
  /** Files with no record that pull left as the member's, and the team resource each holds back (#993). */
  readonly members: { dest: string; teamRelPath: string; link?: true }[];
  /**
   * What the state's other checkout records say teamai wrote at each path. A
   * record lost to a new key (a restored or copied `.git`, #993) still names
   * this checkout's paths. It only words a kept copy as the member's edit; it
   * never makes a file teamai's, and is never carried over to this record.
   */
  readonly otherRecords: DeliveredHashes;
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
  /** Copies that failed with an error, already reported: the pull is not synced, and the next one is full. */
  readonly failed: { name: string; tool: string }[];
  /**
   * Where a writer reports the paths it delivered into the project checkout
   * and whether it delivered all it meant to (#915). Only pull's project
   * scope sets it; a ledger without one (another command) reports nothing.
   */
  readonly recorder?: DeliveryRecorder;
}

export function openLedger(
  previous: DeliveredHashes | undefined, agentModels?: AgentModelRecords, otherRecords: DeliveredHashes = {},
): DeliveryLedger {
  return {
    previous,
    hashes: { ...previous },
    kept: [],
    members: [],
    otherRecords,
    held: [],
    failed: [],
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

/**
 * Whether the file at `file`, which has no delivery record, is teamai's
 * (#993): its bytes are a version of `origin.pathspec` in the history of
 * `origin.repoPath`, or one of `origin.renders` of such a version, compared
 * by git blob id. False when there is no file, or git cannot read the history:
 * without proof, it is the member's. Read-only; run it only for a file that
 * exists without a record, as it reads the history.
 */
export async function isTeamaiCopy(file: string, origin: CopyOrigin): Promise<boolean> {
  // teamai writes files, never links: a link is the member's, whatever its target holds.
  if (await isLink(file)) return false;
  const bytes = await fse.readFile(file).catch(() => null);
  if (bytes === null) return false;
  if (await matchesHistory(origin.repoPath, origin.pathspec, bytes)) return true;
  for (const render of origin.renders ?? []) {
    if (await matchesHistory(origin.repoPath, origin.pathspec, bytes, render)) return true;
  }
  log.debug(`${file} has no delivery record and matches no team version of ${origin.pathspec}: it is the member's`);
  return false;
}

/**
 * Why a file at `resource`'s path is the member's (#993), for every line that
 * names one. `origin` names whose versions it was compared with: a source
 * repo has no team version.
 */
export function notTeamaisReason(resource: string, origin: 'team' | 'source' = 'team'): string {
  return `it is not teamai's (no delivery record, and it matches no ${origin} version of ${resource})`;
}

/**
 * The line for a file pull keeps because it is not teamai's (#993), for
 * pull and doctor alike: `resource` is the team file it holds back, or the
 * `<source>/<skill>` a source skill's copy holds back.
 */
export function describeMembersFile(file: string, resource: string, origin: 'team' | 'source' = 'team'): string {
  return `Kept ${file}: ${notTeamaisReason(resource, origin)}. `
    + `Rename or delete it, then run teamai pull, to receive the ${origin} version.`;
}

/**
 * The line for a link of the member's at a delivered path (#993): teamai never writes,
 * follows or deletes it. `resource` is the team resource held back, or `<source>/<skill>`.
 */
export function describeMembersLink(file: string, resource: string, origin: 'team' | 'source' = 'team'): string {
  return `Kept ${file}: it is a link of yours, so teamai does not replace it. `
    + `Remove the link to receive ${resource} from ${origin === 'team' ? 'the team' : 'its source'}.`;
}

/**
 * The line for a link in a skill's source that delivery skipped (#993): teamai never
 * creates a link. `link` is its path in the skill, `skill` the skill's team or source name.
 */
export function describeSkippedLink(link: string, skill: string): string {
  return `Skipped ${link} in ${skill}: teamai does not deliver links.`;
}

/** `describeMembersLink` for a link at `file` or inside it (`membersLinkAt`), else `describeMembersFile`. */
export async function describeKeptEntry(file: string, resource: string, origin: 'team' | 'source' = 'team'): Promise<string> {
  const link = await membersLinkAt(file);
  return link !== null ? describeMembersLink(link, resource, origin) : describeMembersFile(file, resource, origin);
}

/**
 * The member's link that keeps the copy at `file` theirs: `file` itself when it is a link,
 * else the first link (or other non-regular entry) inside the directory there. Null when none.
 */
export async function membersLinkAt(file: string): Promise<string | null> {
  return await isLink(file) ? file : firstNonRegular(file);
}

/**
 * Whether the skill directory `dir` is teamai's copy (#993): it exists, and
 * every file in it is either what pull writes there now
 * (`current`, by absolute path) or a version of that file of the skill in the
 * history `origin` names (`pathspec` is the skill directory; `renders` apply
 * to its SKILL.md). One file that is neither, the member's own included,
 * makes the whole directory the member's. Read-only. Callers with a ledger
 * ask it only for a directory with no file on record (`ownsSkillDir` for
 * `teamai remove` and `uninstall`); doctor decides with it alone.
 */
export async function isTeamaiSkillCopy(
  dir: string, origin: CopyOrigin, current: ReadonlyMap<string, string | null> = new Map(),
): Promise<boolean> {
  // A link in place of the directory, or any non-regular entry inside it, is the member's.
  if (await isLink(dir) || !await isDirectory(dir) || await holdsNonRegular(dir) || await holdsGitDir(dir)) return false;
  // A CONTRIBUTORS file too: teamai's only on the same proof, never by its name.
  for (const rel of await listFilesRecursive(dir)) {
    const file = path.join(dir, rel);
    const next = current.get(file);
    if (next != null && await fileHash(file) === next) continue;
    const fileOrigin: CopyOrigin = {
      repoPath: origin.repoPath,
      pathspec: `${origin.pathspec}/${rel}`,
      renders: rel === SKILL_MD ? origin.renders : undefined,
    };
    if (!await isTeamaiCopy(file, fileOrigin)) return false;
  }
  return true;
}

/**
 * Whether a command the member ran to delete skill copies (`teamai remove`,
 * `uninstall`) may delete the skill directory `dir` (#993): a file under it
 * is on `previous`, the checkout's record, edited since or not, or
 * `isTeamaiSkillCopy` proves it teamai's, each file being what pull writes
 * today from one of `sources` (the team skill's directories, while they are
 * still there) or a version from the history. Read-only.
 */
export async function ownsSkillDir(
  previous: DeliveredHashes | undefined, dir: string, origin: CopyOrigin, sources: readonly ResourceItem[] = [],
): Promise<boolean> {
  // A link at or anywhere inside the directory is the member's: deleting the directory would take it.
  // So is a repository the member made in it.
  if (await isLink(dir) || await holdsNonRegular(dir) || await holdsGitDir(dir)) return false;
  // On record, the directory is teamai's only when no file in it is the member's own (#993):
  // removing it would take a file the member added beside teamai's.
  if (recordedUnder(previous ?? {}, dir).length > 0) return !await holdsMembersFile(previous ?? {}, dir, origin);
  if (sources.length === 0) return isTeamaiSkillCopy(dir, origin);
  for (const source of sources) {
    if (await isTeamaiSkillCopy(dir, origin, await nextHashes({}, source, { tool: '', dest: dir }))) return true;
  }
  return false;
}

/**
 * The files of skill directory `dir` that are teamai's, and those that are the member's (#993),
 * absolute: teamai's are on `previous` or a version of that file of the skill in the history
 * `origin` names; a link or any other non-regular entry, and any other file, is the member's.
 * Read-only; `remove` and `uninstall` delete only teamai's and keep the directory while anything
 * is left in it.
 */
export async function teamaiSkillFiles(
  previous: DeliveredHashes | undefined, dir: string, origin: CopyOrigin,
): Promise<{ teamais: string[]; members: string[] }> {
  const result = { teamais: [] as string[], members: [] as string[] };
  const walk = async (current: string, rel: string): Promise<void> => {
    for (const entry of await fse.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(current, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(file, entryRel);
        continue;
      }
      if (!entry.isFile()) {
        result.members.push(file);
        continue;
      }
      const fileOrigin: CopyOrigin = {
        repoPath: origin.repoPath, pathspec: `${origin.pathspec}/${entryRel}`, renders: entryRel === SKILL_MD ? origin.renders : undefined,
      };
      const teamais = previous?.[file] !== undefined || await isTeamaiCopy(file, fileOrigin);
      (teamais ? result.teamais : result.members).push(file);
    }
  };
  await walk(dir, '');
  return result;
}

/**
 * The files a delivery of the skill at `source` writes into `dest`, absolute:
 * each regular file `copyDir` copies (no link, no ignored name), so a file the
 * member adds in `dest` is never one of them (#915). `blocked` (paths from the
 * skill's root) were left undelivered, with everything under them.
 */
export async function deliveredSkillFiles(source: string, dest: string, blocked: readonly string[] = []): Promise<string[]> {
  const delivered = (rel: string): boolean => !blocked.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
  return (await listFilesRecursive(source)).filter(delivered).map((rel) => path.join(dest, ...rel.split('/')));
}

/**
 * Whether the recorded skill directory `dir` holds a file that is the member's own: not on
 * `previous` and, with an `origin`, no version of that file of the skill in the history.
 * Without an origin, any file off the record is the member's.
 */
async function holdsMembersFile(previous: DeliveredHashes, dir: string, origin?: CopyOrigin): Promise<boolean> {
  for (const rel of await listFilesRecursive(dir)) {
    const file = path.join(dir, rel);
    if (previous[file] !== undefined) continue;
    if (origin === undefined) return true;
    const fileOrigin: CopyOrigin = {
      repoPath: origin.repoPath, pathspec: `${origin.pathspec}/${rel}`, renders: rel === SKILL_MD ? origin.renders : undefined,
    };
    if (!await isTeamaiCopy(file, fileOrigin)) return true;
  }
  return false;
}

/** The line for a copy `command` did not delete because it is not teamai's (#993). */
/**
 * The line for a skill directory `command` did not delete (#993): a link of the member's, one
 * holding a link of theirs, or else one that is not teamai's.
 */
export async function describeKeptDir(dir: string, resource: string, command: string): Promise<string> {
  if (await isLink(dir)) return `Kept ${dir}: it is a link of yours, so ${command} left it.`;
  if (await holdsNonRegular(dir)) return `Kept ${dir}: it holds a link of yours, so ${command} left it.`;
  return describeMembersDirLeft(dir, resource, command);
}

export function describeMembersDirLeft(dir: string, resource: string, command: string): string {
  return `Kept ${dir}: ${notTeamaisReason(resource)}, so ${command} left it.`;
}

/** Whether `file` is a symbolic link itself (never followed). */
export async function isLink(file: string): Promise<boolean> {
  return (await fse.lstat(file).catch(() => null))?.isSymbolicLink() ?? false;
}

/**
 * Whether `dir` holds, anywhere below it, an entry that is neither a regular file nor a
 * directory (a link, above all). teamai writes only files, and `listFilesRecursive` does
 * not list the others.
 */
export async function holdsNonRegular(dir: string): Promise<boolean> {
  return await firstNonRegular(dir) !== null;
}

/**
 * Whether `dir` holds, anywhere below it, a `.git` entry: a repository the member made there.
 * `listFilesRecursive` skips it, so no file check sees it; deleting the directory would take
 * the member's local commits with it.
 */
export async function holdsGitDir(dir: string): Promise<boolean> {
  for (const entry of await fse.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === '.git') return true;
    if (entry.isDirectory() && await holdsGitDir(path.join(dir, entry.name))) return true;
  }
  return false;
}

/** The path of the first entry `holdsNonRegular` finds under `dir`, or null. */
async function firstNonRegular(dir: string): Promise<string | null> {
  for (const entry of await fse.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await firstNonRegular(entryPath);
      if (found !== null) return found;
    } else if (!entry.isFile()) {
      return entryPath;
    }
  }
  return null;
}

async function isDirectory(dir: string): Promise<boolean> {
  return (await fse.stat(dir).catch(() => null))?.isDirectory() ?? false;
}

/**
 * Whether `target.dest` holds a copy with no record, other than the render,
 * that its origin does not prove teamai's. A skill directory counts as
 * recorded when any file under it is: its edits are then judged as before.
 */
async function isMembersCopy(previous: DeliveredHashes | undefined, item: ResourceItem, target: DeliveryTarget): Promise<boolean> {
  if (target.origin === undefined) return false;
  // A link at the delivered path is the member's: teamai never writes through, replaces or deletes it.
  if (await isLink(target.dest)) return true;
  // An entry of the other type (a file where a skill directory goes, a directory where a file
  // goes) is the member's: teamai writes neither, and delivering over it would fail.
  const existing = await fse.lstat(target.dest).catch(() => null);
  if (existing && existing.isDirectory() !== (item.type === 'skills')) return true;
  if (item.type === 'skills') {
    if (!await isDirectory(target.dest)) return false;
    // A link the member put inside the skill is theirs, on record or not: copying over it would replace it.
    if (await holdsNonRegular(target.dest)) return true;
    if (recordedUnder(previous ?? {}, target.dest).length > 0) return false;
    return !await isTeamaiSkillCopy(target.dest, target.origin, await nextHashes({}, item, target));
  }
  if (previous?.[target.dest] !== undefined) return false;
  const disk = await fileHash(target.dest);
  if (disk === null || (target.content !== undefined && disk === contentHash(target.content))) return false;
  return !await isTeamaiCopy(target.dest, target.origin);
}

/** What pull does with `target`'s copy of `item`. Read-only. */
export async function judgeCopy(previous: DeliveredHashes | undefined, item: ResourceItem, target: DeliveryTarget): Promise<CopyVerdict> {
  if (await isMembersCopy(previous, item, target)) return { kind: 'member' };
  if (previous === undefined) return { kind: 'write' };
  const verdict = classifyCopy(await withDisk(previous, await nextHashes(previous, item, target)));
  // A recorded skill the member added a file to, at a path the team now delivers too, is kept
  // whole like an edited one: writing would replace the member's file (#993).
  if (verdict.kind === 'write' && recordedUnder(previous, target.dest).length > 0 && await overwritesMembersFile(previous, item, target)) {
    return { kind: 'keep', teamChanged: true };
  }
  return verdict;
}

/**
 * The entries in skill copy `dest` that are the member's because they are of the other type than what
 * teamai delivers there (#993): a directory or another non-file where the skill at `sourcePath` has a
 * file, or a non-directory where one of its directories goes. Pull leaves each one, and the files it
 * would cover, undelivered. Relative paths, `/`-separated.
 */
export async function blockingEntries(dest: string, sourcePath: string): Promise<string[]> {
  const blocked = new Set<string>();
  for (const rel of await listFilesRecursive(sourcePath)) {
    if (!(await fse.lstat(path.join(sourcePath, rel)).catch(() => null))?.isFile()) continue;
    const parts = rel.split(/[\\/]/);
    for (let i = 1; i <= parts.length; i++) {
      const stat = await fse.lstat(path.join(dest, ...parts.slice(0, i))).catch(() => null);
      if (stat === null) break;
      if (i < parts.length ? !stat.isDirectory() : !stat.isFile()) {
        blocked.add(parts.slice(0, i).join('/'));
        break;
      }
    }
  }
  return [...blocked];
}

/**
 * Whether delivering skill `item` to `target` would write over a file that is the member's: one
 * off the record that is neither what teamai writes there now nor a team version of it.
 */
async function overwritesMembersFile(previous: DeliveredHashes, item: ResourceItem, target: DeliveryTarget): Promise<boolean> {
  if (item.type !== 'skills' || target.origin === undefined) return false;
  const { withSkillFrontmatter } = await import('./skills.js');
  for (const rel of await listFilesRecursive(item.sourcePath)) {
    const file = path.join(target.dest, rel);
    if (previous[file] !== undefined) continue;
    if (await isLink(file)) return true;
    const disk = await fileHash(file);
    if (disk === null) continue;
    const bytes = await fse.readFile(path.join(item.sourcePath, rel));
    const text = bytes.toString('utf-8');
    const written = rel === SKILL_MD ? withSkillFrontmatter(text, item.name) : text;
    if (disk === contentHash(written === text ? bytes : written)) continue;
    const fileOrigin: CopyOrigin = {
      repoPath: target.origin.repoPath, pathspec: `${target.origin.pathspec}/${rel}`, renders: rel === SKILL_MD ? target.origin.renders : undefined,
    };
    if (!await isTeamaiCopy(file, fileOrigin)) return true;
  }
  return false;
}

/**
 * Whether pull leaves `target`'s copy alone: the member changed it, or it is
 * not teamai's. reportKept names it: as an edit when another checkout record
 * shows teamai wrote that path (a record lost to a new key), else as the
 * member's own file.
 */
export async function keepsEditedCopy(ledger: DeliveryLedger, item: ResourceItem, target: DeliveryTarget): Promise<boolean> {
  const verdict = await judgeCopy(ledger.previous, item, target);
  if (verdict.kind === 'write') return false;
  if (verdict.kind === 'keep') {
    ledger.kept.push({ dest: target.dest, teamRelPath: item.relativePath, teamChanged: verdict.teamChanged });
    return true;
  }
  // Named by the link itself: the one at the path, or the first inside the skill.
  const link = await membersLinkAt(target.dest);
  if (link !== null) {
    ledger.members.push({ dest: link, teamRelPath: item.relativePath, link: true });
  } else if (recordedUnder(ledger.otherRecords, target.dest).length > 0) {
    const next = await nextHashes(ledger.otherRecords, item, target);
    const teamChanged = [...next].some(([file, hash]) => hash !== (ledger.otherRecords[file] ?? null));
    ledger.kept.push({ dest: target.dest, teamRelPath: item.relativePath, teamChanged });
  } else {
    ledger.members.push({ dest: target.dest, teamRelPath: item.relativePath });
  }
  return true;
}

/**
 * What happens to the copy at `dest` of a resource no longer delivered there.
 * - `remove`: teamai's and unchanged, or teamai's by `origin` (a skill
 *   directory by every file in it, `isTeamaiSkillCopy`). Without a record and
 *   an origin, it is removed as before.
 * - `edited`: on record and changed since teamai delivered it, or with no
 *   record here but on `otherRecords` (a record lost to a new key, as after a
 *   restore) and not proven teamai's.
 * - `notTeamais`: no record, and `origin` proves nothing (#993).
 */
export async function judgeRemoval(
  previous: DeliveredHashes | undefined, dest: string, origin?: CopyOrigin, otherRecords: DeliveredHashes = {},
): Promise<'remove' | 'edited' | 'notTeamais'> {
  const recorded = previous === undefined ? [] : recordedUnder(previous, dest);
  // A link the member put there is theirs: teamai never writes one.
  if (await isLink(dest)) return recorded.length > 0 || recordedUnder(otherRecords, dest).length > 0 ? 'edited' : 'notTeamais';
  if (recorded.length > 0) {
    // A link the member put inside a recorded skill changes it: removing the directory would take the link.
    if (await holdsNonRegular(dest)) return 'edited';
    const files = await withDisk(previous ?? {}, recorded.map((file) => [file, null]));
    if (classifyCopy(files).kind === 'keep') return 'edited';
    // A file the member added beside teamai's goes with the directory: keep it all.
    return await isDirectory(dest) && await holdsMembersFile(previous ?? {}, dest, origin) ? 'edited' : 'remove';
  }
  if (origin === undefined) return 'remove';
  // A file there that cannot be read proves nothing, so it is not teamai's (isTeamaiCopy).
  const teamais = await isDirectory(dest)
    ? await isTeamaiSkillCopy(dest, origin)
    : !await fse.pathExists(dest) || await isTeamaiCopy(dest, origin);
  if (teamais) return 'remove';
  return recordedUnder(otherRecords, dest).length > 0 ? 'edited' : 'notTeamais';
}

/**
 * Whether a removal pass keeps `dest`, a copy teamai no longer delivers there,
 * because the repository it sits in tracks it (#915): deleting it would be a
 * change in the member's repository. Asked right before the deletion, after
 * whatever proved the copy teamai's, so no proof deletes it. Named once per
 * run. A path in no repository is not kept; one in a repository git cannot
 * answer for is, as it may be tracked. `movedTo` is
 * where a layout migration writes the resource now: the tool may then load
 * both copies, and the message says so.
 */
export async function keepsTrackedCopy(dest: string, movedTo?: string): Promise<boolean> {
  if (await gitUntracked(dest, 'entry')) return false;
  const tracks = await gitTracks(dest, 'entry');
  const moved = movedTo === undefined ? '' : ` The resource now lives at ${movedTo}, and the tool may load both until the repository removes this copy.`;
  warnOnce(tracks.kind === 'unknown'
    ? `Kept ${dest}: git could not say whether this repository tracks it (${tracks.error}), so teamai does not delete it. `
      + `Fix that repository, then run the command again.${moved}`
    : `Kept ${dest}: this repository tracks it, so teamai does not delete it. `
      + `Run \`git rm -r ${dest}\` and commit if the repository no longer needs it.${moved}`);
  return true;
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
  return recorded !== undefined && !await isLink(file) && recorded === await fileHash(file);
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
 * version. The step for an edited copy is `pull --force`: this pull has
 * recorded the team revision, so a plain pull after it would skip the sync.
 * A member's own file holds a team resource back, so a full pull that met one
 * does not count as synced (see the caller), and a plain pull delivers the
 * team version once the file is gone. Returns how many such files it named.
 */
export function reportKept(ledger: DeliveryLedger, scopeLabel: string): number {
  const members = new Set<string>();
  for (const { dest, teamRelPath, link } of ledger.members.splice(0)) {
    if (members.has(dest)) continue;
    members.add(dest);
    log.warn(`[${scopeLabel}] ${link ? describeMembersLink(dest, teamRelPath) : describeMembersFile(dest, teamRelPath)}`);
  }
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
  return members.size;
}
