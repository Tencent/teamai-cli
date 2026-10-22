import { realpath } from 'node:fs/promises';
import { locate, writableDir, writesOf, type Install } from '../locate.js';
import { realHost, toolHome, type Host } from '../tool-home.js';
import { isToolId, skillsFollowSession } from '../tools.js';
import type { State } from '../types.js';
import { samePath } from '../utils/agent-path.js';
import { log } from '../utils/logger.js';

type CheckoutRecord = NonNullable<State['lastPullByWorkspace']>[string];

/** Tool → the absolute directories teamai writes its skills into, for each tool whose write gates are met. */
export type SkillDirs = NonNullable<CheckoutRecord['skillDirs']>;

/** Tool → its home, for each tool whose skills follow the session. */
export type SessionToolHomes = NonNullable<CheckoutRecord['sessionToolHomes']>;

/** Where every tool of `install` whose write gates are met takes skills now, session-following tools included. */
export async function skillDirsOf(install: Install, host: Host = realHost()): Promise<SkillDirs> {
  const located = await Promise.all(Object.keys(install.toolPaths).sort()
    .map(async (tool) => ({ tool, where: await locate(tool, 'skills', install, host) })));
  const dirs: SkillDirs = {};
  for (const { tool, where } of located) if (writableDir(where) !== null) dirs[tool] = writesOf(where);
  return dirs;
}

export function sessionToolHomesOf(current: SkillDirs, host: Host = realHost()): SessionToolHomes {
  return Object.fromEntries(Object.keys(current).filter(isToolId).filter(skillsFollowSession).map((tool) => [tool, toolHome(tool, host)]));
}

/**
 * Whether the tools take skills where the last full pull recorded writing
 * them. A tool whose skills follow the session is compared by its home, as
 * each session may name another directory under it.
 */
export async function skillDirsUnmoved(
  recorded: { readonly skillDirs: SkillDirs; readonly sessionToolHomes?: SessionToolHomes },
  current: SkillDirs,
  host: Host = realHost(),
): Promise<boolean> {
  const asDirs = (homes: SessionToolHomes): SkillDirs => Object.fromEntries(Object.entries(homes).map(([tool, dir]) => [tool, [dir]]));
  return await sameSkillDirs(recorded.skillDirs, withoutSessionTools(current, skillsFollowSession))
    && await sameSkillDirs(asDirs(recorded.sessionToolHomes ?? {}), asDirs(sessionToolHomesOf(current, host)));
}

function withoutSessionTools(dirs: SkillDirs, followsSession: (tool: string) => boolean): SkillDirs {
  return Object.fromEntries(Object.entries(dirs).filter(([tool]) => !followsSession(tool)));
}

/**
 * Whether `a` and `b` are one skills directory: the same path (`samePath`)
 * once each is resolved through its links. A directory that does not exist
 * yet is compared as written. Every comparison of the skills directories a
 * pull recorded goes through here: the pull's fast path, the directories the
 * tools left, and doctor.
 */
export async function sameSkillDir(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([realOrSelf(a), realOrSelf(b)]);
  return samePath(ra, rb);
}

async function realOrSelf(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return dir;
    throw e;
  }
}

/** Whether `dir` is one of `dirs` (`sameSkillDir`). */
export async function amongSkillDirs(dir: string, dirs: readonly string[]): Promise<boolean> {
  for (const other of dirs) if (await sameSkillDir(dir, other)) return true;
  return false;
}

/** Whether two answers name the same directories for the same tools (`sameSkillDir`). */
export async function sameSkillDirs(recorded: SkillDirs, current: SkillDirs): Promise<boolean> {
  const tools = Object.keys(current);
  if (Object.keys(recorded).length !== tools.length) return false;
  for (const tool of tools) {
    const before = recorded[tool];
    if (before === undefined) return false;
    const after = current[tool];
    for (const dir of before) if (!await amongSkillDirs(dir, after)) return false;
    for (const dir of after) if (!await amongSkillDirs(dir, before)) return false;
  }
  return true;
}

/** A directory `tool` took skills from at the last full pull and no tool takes them from now; `currentDir` is where `tool` takes them now. */
export type LeftSkillDir = { readonly dir: string; readonly tool: string; readonly currentDir: string };

/**
 * What a full pull records as `skillDirs`, and which directories the tools
 * left, decided over every tool at once. `incomplete` names the tools that did
 * not take every skill or the built-in stub this pull: they keep their
 * previous directories on record, so the next pull syncs them in full again. A
 * directory is left when its tool takes skills elsewhere now, and no tool
 * takes skills from it now or keeps it on record. Directories are compared by
 * `sameSkillDir`.
 */
export async function settleSkillDirs({ previous, current, incomplete, followsSession }: {
  readonly previous: SkillDirs | undefined;
  readonly current: SkillDirs;
  readonly incomplete: ReadonlySet<string>;
  readonly followsSession: (tool: string) => boolean;
}): Promise<{ readonly record: SkillDirs; readonly left: readonly LeftSkillDir[] }> {
  const before: SkillDirs = previous ?? {};
  const next: SkillDirs = {};
  for (const [tool, dirs] of Object.entries(current)) {
    const earlier: string[] = [];
    if (incomplete.has(tool)) for (const dir of before[tool] ?? []) if (!await amongSkillDirs(dir, dirs)) earlier.push(dir);
    next[tool] = [...earlier, ...dirs];
  }
  const live = [...Object.values(current).flat(), ...[...incomplete].flatMap((tool) => before[tool] ?? [])];
  const left: LeftSkillDir[] = [];
  for (const [tool, dirs] of Object.entries(before)) {
    const currentDirs = current[tool];
    if (currentDirs === undefined || incomplete.has(tool) || followsSession(tool)) continue;
    for (const dir of dirs) {
      if (!await amongSkillDirs(dir, [...live, ...left.map((other) => other.dir)])) left.push({ dir, tool, currentDir: currentDirs[0] });
    }
  }
  return { record: withoutSessionTools(next, followsSession), left };
}

/**
 * Name each directory the tools left (`settleSkillDirs`) and return what to
 * record: its `skillDirs`, and the `sessionToolHomes` of each
 * session-following tool that took every skill. An incomplete one keeps the
 * home recorded before.
 *
 * teamai's copies in a left directory stay: another shell, another checkout
 * or a tool teamai does not manage may still read it, and no pull can rule
 * that out. The member deletes them.
 */
export async function recordSkillDirs({ previous, current, incomplete, scopeLabel, host = realHost() }: {
  readonly previous: Pick<CheckoutRecord, 'skillDirs' | 'sessionToolHomes'> | undefined;
  readonly current: SkillDirs;
  readonly incomplete: ReadonlySet<string>;
  readonly scopeLabel: string;
  readonly host?: Host;
}): Promise<{ readonly skillDirs: SkillDirs; readonly sessionToolHomes: SessionToolHomes }> {
  const { record, left } = await settleSkillDirs({ previous: previous?.skillDirs, current, incomplete, followsSession: skillsFollowSession });
  for (const { dir, tool, currentDir } of left) {
    log.info(`[${scopeLabel}] ${tool} takes skills from ${currentDir} now, so teamai no longer updates its copies in ${dir}. Delete them once no tool reads that directory.`);
  }
  const sessionToolHomes: SessionToolHomes = {};
  for (const [tool, home] of Object.entries(sessionToolHomesOf(current, host))) {
    sessionToolHomes[tool] = incomplete.has(tool) ? (previous?.sessionToolHomes?.[tool] ?? home) : home;
  }
  return { skillDirs: record, sessionToolHomes };
}
