import path from 'node:path';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { expandHome, listFilesRecursive, pathExists, readFileSafe, readJsonObject } from './utils/fs.js';
import {
  DEFAULT_TOOL_PATHS, getDataHome, getMcpSharing, getTeamaiHome, isAgentExcluded, isGitExcludeEnabled, managedMcpManifestKey, MUSE_TOOL_ID,
  resolveBaseDir, scopedToolPaths,
} from './types.js';
import type { DeliveryTarget, LocalConfig, ManagedMcpManifest, McpServerDef, ResourceItem, TeamaiConfig } from './types.js';
import type { EntryLayout, EntryResolution } from './namespaced-entries.js';
import { splitFrontmatter } from './utils/frontmatter.js';
import type { ResourceHandler } from './resources/base.js';
import type { Check, DoctorContext } from './doctor.js';
import type { DirectoryEnv } from './resources/env-loader.js';
import type { EnvVariable } from './resources/env.js';
import type { DesiredMcpContext, McpTarget } from './mcp-reconcile.js';
import type { ResolvedMcpFile } from './mcp-resolved-files.js';
import {
  findEnvBlockFor,
  envBlockSourcesPath,
  sameFile,
  SHELL_PROFILE_CANDIDATE_NAMES,
} from './utils/shell-profile.js';
import { getUserHome } from './utils/home.js';
import { loadStateForScope } from './config.js';
import { installOf, isInstalledFor, locate, ownOf, unreadWrites, writable, writesOf, type DirPlace, type FilesChannel, type Install, type Location, type Session, type Unread } from './locate.js';
import { codexProjectTrust, codexTrustFix } from './codex-project-trust.js';
import { amongPlaces, placesRecordOf, samePlaces } from './resources/places.js';
import { realHost } from './tool-home.js';
import { getsRulesFromExtension, ruleFormatForTool, ruleStemsForTool } from './resources/rule-format.js';
import { declaredSecretKeys } from './resources/secrets.js';
import { isReservedTeamEnvKey } from './env-reserved.js';
import { skillsGuardBase } from './builtin-skills.js';
import { findSkillDirectoryBlock, describeSkippedSkillDirectory } from './resources/skills.js';

/**
 * The checks that verify the payload rather than the plumbing: what each tool
 * was owed, against what is on its disk (#598, #624).
 *
 * They live beside `doctor.ts` rather than inside it because every one of them
 * is domain logic — where a rule lands for Cursor, which tools an agent's spec
 * targets, whether a shell block would load — and `doctor.ts` is the registry
 * that runs them.
 *
 * Every check here is read-only by contract. `doctor-delivery.test.ts` asserts
 * it directly: resolving a destination must never write, or the command whose
 * job is to describe the machine would change it.
 */

/**
 * Whether a delivered skill directory is one an agent can actually discover:
 * SKILL.md present, frontmatter parses, and its `name` is the directory's own.
 * A copy that fails this landed successfully — no write-time gate can see it.
 */
async function skillIsDiscoverable(skillDir: string, skillName: string): Promise<boolean> {
  const content = await readFileSafe(path.join(skillDir, 'SKILL.md'));
  if (!content) return false;

  const { data, valid } = splitFrontmatter(content);
  if (!valid) return false;
  return data.name === skillName;
}

/**
 * Whether `filePath` is a file something can actually read. `pathExists`
 * follows symlinks but says yes to a directory too, so on its own it cannot
 * tell a delivered document from a name occupied by something else.
 */
async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(expandHome(filePath))).isFile();
  } catch {
    return false;
  }
}

/** At most this many names in a fix string; the rest are counted. */
const MAX_NAMED_IN_FIX = 5;

/** Group item names under the tool that did not receive them. */
function appendTo(buckets: Map<string, string[]>, tool: string, name: string): void {
  const names = buckets.get(tool);
  if (names) names.push(name);
  else buckets.set(tool, [name]);
}

/** What one tool was owed, and which of it did not arrive intact. */
interface ToolDelivery {
  /** The tool whose format its items land in; the map key also names the tools sharing the copy. */
  tool: string;
  /** Where its items land — the fix names it when the filename is derived. */
  dir: string;
  /** Item names grouped by the problem label `classify` gave them. */
  problems: Map<string, string[]>;
}

/**
 * Walk every desired item across the tools that receive it, letting `classify`
 * name what is wrong with each delivered path, or return null when it arrived
 * intact. A tool absent from every item's targets receives nothing, so nothing
 * is owed: it is either uninstalled — caught by its own `<tool> is installed`
 * check — or configured without a path for this resource.
 */
async function walkDelivery(
  handler: ResourceHandler,
  ctx: DoctorContext,
  items: ResourceItem[],
  classify: (target: DeliveryTarget, item: ResourceItem) => Promise<string | null>,
): Promise<{ byTool: Map<string, ToolDelivery>; unreceived: string[] }> {
  // `items` is what this member receives, so the handler need not resolve it again.
  const received = items.map((item) => item.name);
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return { byTool: new Map(), unreceived: [] };

  const byTool = new Map<string, ToolDelivery>();
  const unreceived: string[] = [];

  for (const item of items) {
    const targets = await handler.deliveryTargets(teamConfig, localConfig, item, received);
    if (targets.length === 0) unreceived.push(item.name);

    for (const target of targets) {
      // One check for a copy several tools read, naming them all (#946).
      const key = [target.tool, ...target.sharedWith ?? []].join(', ');
      let delivery = byTool.get(key);
      if (!delivery) {
        delivery = { tool: target.tool, dir: path.dirname(target.dest), problems: new Map() };
        byTool.set(key, delivery);
      }
      const problem = await classify(target, item);
      if (problem !== null) appendTo(delivery.problems, problem, item.name);
    }
  }

  return { byTool, unreceived };
}

/**
 * `not delivered: a, b; unreadable: c`, with the labels in the order the caller
 * lists them rather than the order the failures happened, so the same broken
 * machine reads the same way twice.
 */
function describeProblems(problems: Map<string, string[]>, labels: readonly string[]): string {
  return labels
    .filter((label) => (problems.get(label)?.length ?? 0) > 0)
    .map((label) => `${label}: ${nameList(problems.get(label) ?? [])}`)
    .join('; ');
}

/**
 * The label for a copy pull keeps because the member changed it (#822). It is
 * not a delivery problem, so it never fails a check, and `pull --force` would
 * not replace it.
 */
const CHANGED_BY_YOU = 'changed by you (kept by pull)';
/** The advice for CHANGED_BY_YOU, when a failing check lists it. */
function changedByYouFix(delivery: ToolDelivery): string {
  return delivery.problems.has(CHANGED_BY_YOU)
    ? ' A copy changed by you is kept by pull: share it with `teamai push`, '
      + 'or delete it and run `teamai pull --force` to take the team version.'
    : '';
}

/**
 * The label for an agent copy that still carries the model the last pull
 * resolved, since changed by the member's aliases file, a model switch or the
 * team's aliases (#830). A plain pull redeploys it.
 */
const MODEL_CHANGED = 'model changed since the last pull';

/**
 * Whether a tool's delivery has a problem other than copies the member
 * changed or whose model changed since the last pull, which the next pull
 * redeploys (spec story 52 of #830).
 */
function hasDeliveryProblem(delivery: ToolDelivery): boolean {
  return [...delivery.problems.keys()].some((label) => label !== CHANGED_BY_YOU && label !== MODEL_CHANGED);
}

/**
 * The label for a file at a team resource's path that teamai has no record
 * of and that holds no team version of it (#993): the member's own, which
 * pull keeps, so the team version does not reach the tool. Each is named in
 * the fix with pull's own line; `pull --force` does not replace it.
 */
const MEMBERS_OWN = 'not teamai\'s (kept by pull)';

/** The list `lines` keeps for `tool`, created on first use. */
function linesFor(lines: Map<string, string[]>, tool: string): string[] {
  let list = lines.get(tool);
  if (!list) lines.set(tool, list = []);
  return list;
}

/** Pull's line for each file of the member's own in `delivery`'s tool, when the check lists any. */
function membersOwnFix(lines: Map<string, string[]>, delivery: ToolDelivery): string {
  const list = delivery.problems.has(MEMBERS_OWN) ? lines.get(delivery.tool) ?? [] : [];
  return list.map((line) => ` ${line}`).join('');
}

/**
 * What `pullItem` did not write at `target`: an older render, a copy the
 * member changed since teamai delivered it, or a file of the member's own,
 * which pull keeps; the line naming one of the last goes on `memberLines`.
 * With `recordedLabel`, an older render still holding what teamai recorded
 * writing gets that label instead.
 */
async function differingCopyLabel(
  item: ResourceItem, target: DeliveryTarget, olderLabel: string, localConfig: LocalConfig, memberLines: string[], recordedLabel?: string,
): Promise<string> {
  const { deliveredHashes } = await import('./pull.js');
  const { describeKeptEntry, judgeCopy, recordedUnchanged } = await import('./resources/delivered-copies.js');
  const previous = await deliveredHashes(localConfig);
  const verdict = await judgeCopy(previous, item, target);
  if (verdict.kind === 'keep') return CHANGED_BY_YOU;
  if (verdict.kind === 'member') {
    memberLines.push(await describeKeptEntry(target.dest, item.relativePath));
    return MEMBERS_OWN;
  }
  return recordedLabel !== undefined && await recordedUnchanged(previous, target.dest) ? recordedLabel : olderLabel;
}

/** `a, b, c and 4 more` — a fix a human reads, not a wall of paths. */
export function nameList(names: string[]): string {
  if (names.length <= MAX_NAMED_IN_FIX) return names.join(', ');
  const shown = names.slice(0, MAX_NAMED_IN_FIX).join(', ');
  return `${shown} and ${names.length - MAX_NAMED_IN_FIX} more`;
}

/**
 * Build one delivery check per installed tool: every skill the member should
 * have, against what is actually on disk for that tool.
 *
 * This is the only check that looks at the payload rather than the plumbing. A
 * write-time gate cannot cover it — `SkillsHandler.pullItem` skips each
 * uninstalled tool on its own, and a directory deleted by hand after a correct
 * pull leaves every gate happy (#598).
 *
 * The scan runs here rather than inside `check()` because the fix names the
 * skills that are missing, and a `Check`'s fix is read as it was built.
 */
/**
 * The one check for a type whose desired set cannot be resolved: two active
 * namespaces collide, or a manifest cannot be read. `pull` reports the same
 * reason, and the command whose job is explaining bad state must report it,
 * not stack-trace on it.
 */
function unresolvableCheck(type: 'skills' | 'agents' | 'docs', reason: string): Check[] {
  const noun = type[0].toUpperCase() + type.slice(1);
  return [{
    name: `${noun} to deliver can be resolved`,
    source: 'local',
    check: async () => false,
    fix: `${reason}. Until the team repo is fixed, pull cannot sync ${type} for this role.`,
  }];
}

/**
 * #1115's dropped-key half: a team `toolPaths` entry replaces that tool's
 * default whole, so naming a tool while omitting a key the default provides
 * silently disables the surface behind the key — hooks skip the tool, no
 * skills arrive — with no warning at pull time. One note per tool whose entry
 * drops keys the default table provides. Omission stays a valid opt-out, so
 * this is a note, not a finding: surfaced, never failing.
 */
export function toolPathsDroppedKeyNotes(ctx: DoctorContext): string[] {
  const { teamConfig, toolPaths } = ctx;
  if (!teamConfig) return [];
  // What each key's absence does, for the note text. Keys the default entry
  // does not provide cannot be dropped, so the loop below never looks them up.
  const CONSEQUENCES: Record<string, string> = {
    settings: 'hook reconciliation silently skips the tool',
    skills: 'no skills are delivered to it',
    rules: 'no rules are delivered to it',
    claudemd: 'the team rules have no instructions file to inline into',
    agents: 'no agents are delivered to it',
    mcp: 'team MCP servers are not written to its user config',
    mcpProject: 'team MCP servers are not written to its project config',
  };
  const defaults = DEFAULT_TOOL_PATHS as unknown as Record<string, Record<string, string>>;
  const notes: string[] = [];
  // The team's own entries, not `toolPaths`: that one is scoped, and user scope
  // drops keys on purpose (joycode's `rules: null`). `teamConfig.toolPaths` is
  // already merged over the defaults, so a tool the team did not name holds its
  // default and drops nothing. The enabled filter still comes from `toolPaths`.
  for (const [tool, entryRaw] of Object.entries(teamConfig.toolPaths)) {
    if (toolPaths[tool] === undefined) continue; // not enabled or excluded here.
    const def = defaults[tool];
    if (!def) continue; // a custom tool: no default entry to drop keys from.
    const entry = entryRaw as unknown as Record<string, string | undefined>;
    const dropped = Object.keys(def)
      .filter((key) => key !== 'userScope' && entry[key] === undefined && CONSEQUENCES[key] !== undefined)
      .map((key) => `\`${key}\` (${def[key]} — ${CONSEQUENCES[key]})`);
    if (dropped.length === 0) continue;
    notes.push(`toolPaths.${tool} replaces the tool's default entry whole and drops keys the default provides: `
      + `${dropped.join(', ')}. Add a key back to restore its surface, or leave it out on purpose.`);
  }
  return notes;
}

export async function buildDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  // The desired set is policy that must not be restated here.
  const { buildRolePullContext, describeDeliveryConflict, resolveDesiredSkills } = await import('./resources/desired.js');
  const { getHandler } = await import('./resources/index.js');

  let items: ResourceItem[];
  try {
    const desired = await resolveDesiredSkills(teamConfig, localConfig, await buildRolePullContext(localConfig));
    if (desired.kind === 'conflict') return unresolvableCheck('skills', describeDeliveryConflict(desired));
    ({ items } = desired);
  } catch (e) {
    return unresolvableCheck('skills', e instanceof Error ? e.message : String(e));
  }
  if (items.length === 0) return [];

  const labels = ['not delivered', 'delivered but unreadable', MEMBERS_OWN] as const;
  // Pull's line for each skill directory of the member's own, by the tool it is in.
  const memberLines = new Map<string, string[]>();
  const { deliveredHashes } = await import('./pull.js');
  const { describeKeptEntry, judgeCopy } = await import('./resources/delivered-copies.js');
  const previous = await deliveredHashes(localConfig);
  const { byTool } = await walkDelivery(getHandler('skills'), ctx, items, async (target, item) => {
    if (!await pathExists(target.dest)) return labels[0];
    if ((await judgeCopy(previous, item, target)).kind === 'member') {
      linesFor(memberLines, target.tool).push(await describeKeptEntry(target.dest, item.relativePath));
      return MEMBERS_OWN;
    }
    return await skillIsDiscoverable(target.dest, item.name) ? null : labels[1];
  });

  return [...byTool].map(([tool, delivery]) => ({
    name: `Skills delivered to ${tool}`,
    source: 'local',
    check: async () => delivery.problems.size === 0,
    fix: `In ${tool}, ${describeProblems(delivery.problems, labels)}.`
      + (delivery.problems.has(labels[0]) || delivery.problems.has(labels[1])
        ? ' Run `teamai pull --force`: '
          + 'a plain pull skips a scope whose team repo has not changed, so it cannot restore this. '
          + 'If a skill stays unreadable, fix its SKILL.md in the team repo — the '
          + 'frontmatter needs a `name` matching the directory, or the agent never '
          + 'discovers it.'
        : '')
      + membersOwnFix(memberLines, delivery),
  }));
}

/**
 * The sessions doctor judges reads for: any session in a project install's
 * root, any session at all for a user install. Never doctor's own directory,
 * so the report is the same from every directory doctor runs in. The read
 * checks count only writes no session reads (`not-read`, `shadowed`).
 */
function doctorSession(install: Install): Session {
  return install.scope === 'project' ? { kind: 'within', root: install.projectRoot } : { kind: 'anywhere' };
}

/** Each tool teamai writes skills for now, with where it takes them. */

async function writableSkillLocations(ctx: DoctorContext): Promise<{ tool: string; own: string; where: Location<'skills'>; unread: readonly Unread[] }[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];
  const install = installOf(teamConfig, localConfig);
  const located: { tool: string; own: string; where: Location<'skills'>; unread: readonly Unread[] }[] = [];
  for (const tool of Object.keys(ctx.toolPaths)) {
    const where = await locate(tool, 'skills', install);
    const own = writable(where);
    if (own !== null) located.push({ tool, own: own.path, where, unread: unreadWrites(where, realHost(), doctorSession(install)) });
  }
  return located;
}

/**
 * Per tool, whether the last pull wrote its skills where it takes them now
 * (#1221): the env, or a recorded home, can move them after that pull. And
 * whether the tool reads the directory at all, when its reads are known.
 */
export async function buildSkillDirChecks(ctx: DoctorContext): Promise<Check[]> {
  const located = await writableSkillLocations(ctx);
  if (located.length === 0) return [];
  const { checkoutRecordKey } = await import('./pull.js');
  const key = await checkoutRecordKey(ctx.localConfig);
  const recorded = key === undefined ? undefined : placesRecordOf((await loadStateForScope(ctx.localConfig)).lastPullByWorkspace?.[key])?.skills;
  const unmoved = async (tool: string, where: Location<'skills'>): Promise<boolean> => {
    const wrote = recorded?.[tool];
    return wrote === undefined || samePlaces({ [tool]: wrote }, { [tool]: writesOf(where).map((place) => place.path) });
  };
  const moved = (await Promise.all(located.map(({ tool, where }) => unmoved(tool, where)))).includes(false);
  const holds = moved ? await moveHolds(ctx, located) : { members: new Map<string, string[]>(), workspaceHeld: [] };
  const checks: Check[] = [];
  for (const { tool, own, where, unread } of located) {
    const blocks = [];
    for (const { path: dir } of writesOf(where)) {
      const base = await skillsGuardBase(resolveBaseDir(ctx.localConfig), dir);
      // The built-in teamai skill is always owed, even without team skills.
      const block = await findSkillDirectoryBlock(base, path.join(dir, 'teamai'), { keepSkillLink: true });
      if (block) blocks.push(describeSkippedSkillDirectory('teamai', tool, block));
    }
    checks.push({
      name: `${tool} skills directory is usable`,
      source: 'local',
      check: async () => blocks.length === 0,
      fix: blocks.join(' '),
    });
    const wrote = recorded?.[tool];
    if (wrote !== undefined) {
      checks.push({
        name: `${tool} skills are where the last pull wrote them`,
        source: 'local',
        check: async () => blocks.length === 0 && await unmoved(tool, where),
        fix: blocks.length > 0 ? blocks.join(' ') : await moveFix({ tool, own, writes: writesOf(where).map((place) => place.path), wrote, members: holds.members.get(tool) ?? [], workspaceHeld: holds.workspaceHeld }),
      });
    }
    if (where.reads === 'unknown') continue;
    const notRead = unread.filter((entry) => entry.reason === 'not-read');
    checks.push({
      name: `${tool} reads the skills teamai writes`,
      source: 'local',
      check: async () => notRead.length === 0,
      fix: `${notRead.map((entry) => `${tool} does not read ${entry.write}`).join('; ')}. `
        + `Point toolPaths.${tool}.skills in teamai.yaml at a directory ${tool} reads.`,
    });
  }
  return checks;
}

/** Doctor's fix for a tool whose skills are not where the last pull wrote them. */
async function moveFix({ tool, own, writes, wrote, members, workspaceHeld }: {
  readonly tool: string;
  readonly own: string;
  readonly writes: readonly string[];
  readonly wrote: readonly string[];
  readonly members: readonly string[];
  readonly workspaceHeld: readonly string[];
}): Promise<string> {
  const earlier: string[] = [];
  for (const dir of wrote) if (!await amongPlaces(dir, writes)) earlier.push(dir);
  let keptOldCopies = earlier.length > 0;
  for (const write of writes) keptOldCopies &&= await amongPlaces(write, wrote);
  if (!keptOldCopies) {
    return `${tool} takes skills from ${own}, but the last pull wrote them to ${wrote[0]}. `
      + (members.length > 0 ? members.join(' ') : 'Run `teamai pull` to sync them there.');
  }
  const { BUILTIN_SKILL_NAMES } = await import('./builtin-skills.js');
  const reasons = [...members];
  if (workspaceHeld.length > 0) reasons.push(`This workspace holds back ${workspaceHeld.join(', ')}: its members deliver different copies. Make the copies equal in the team repo, or rename one.`);
  for (const name of BUILTIN_SKILL_NAMES) {
    const deployed = await Promise.all(writes.map((dir) => pathExists(path.join(dir, name, 'SKILL.md'))));
    if (!deployed.includes(true)) reasons.push(`The built-in ${name} skill is not there: \`teamai pull\` says why it could not deploy it.`);
  }
  return `${tool} takes skills from ${own}, but the last pull could not deliver every skill there, so it kept teamai's copies in ${earlier.join(', ')}. `
    + (reasons.length > 0 ? reasons.join(' ') : 'Run `teamai pull`: it says what holds them back.');
}

/**
 * What holds skills back where each tool takes them now: pull's line for each
 * file of the member's own where a team or built-in skill goes, by tool, and
 * the skills this workspace holds back (#913).
 */
async function moveHolds(
  ctx: DoctorContext,
  located: readonly { readonly tool: string; readonly where: Location<'skills'> }[],
): Promise<{ readonly members: Map<string, string[]>; readonly workspaceHeld: readonly string[] }> {
  const members = new Map<string, string[]>();
  const { keptStubLine, BUILTIN_SKILL_NAMES } = await import('./builtin-skills.js');
  for (const { tool, where } of located) {
    for (const dir of writesOf(where).map((place) => place.path)) {
      for (const name of BUILTIN_SKILL_NAMES) {
        const kept = await keptStubLine(path.join(dir, name), name);
        if (kept !== null) linesFor(members, tool).push(kept);
      }
    }
  }
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return { members, workspaceHeld: [] };
  const { buildRolePullContext, resolveDesiredSkills } = await import('./resources/desired.js');
  // A team repo whose skills cannot be resolved fails the delivery check, which says why.
  const desired = await resolveDesiredSkills(teamConfig, localConfig, await buildRolePullContext(localConfig)).catch(() => undefined);
  if (desired?.kind !== 'resolved') return { members, workspaceHeld: [] };
  const { getHandler } = await import('./resources/index.js');
  const { deliveredHashes } = await import('./pull.js');
  const { describeKeptEntry, judgeCopy } = await import('./resources/delivered-copies.js');
  const previous = await deliveredHashes(localConfig);
  await walkDelivery(getHandler('skills'), ctx, desired.items, async (target, item) => {
    if (await pathExists(target.dest) && (await judgeCopy(previous, item, target)).kind === 'member') {
      linesFor(members, target.tool).push(await describeKeptEntry(target.dest, item.relativePath));
    }
    return null;
  });
  return { members, workspaceHeld: desired.held };
}

/** Skills a tool reads only from a session started in one place (#1221). */
export async function skillReadNotes(ctx: DoctorContext): Promise<string[]> {
  const notes: string[] = [];
  for (const { tool, unread: unreadSkills } of await writableSkillLocations(ctx)) {
    for (const unread of unreadSkills) {
      switch (unread.reason) {
        case 'not-read':
        case 'shadowed':
          break;
        case 'cwd-only':
          notes.push(`${tool} reads project skills only from a session started in ${unread.readFrom}.`);
          break;
        case 'outside-workspace':
          notes.push(`${tool} reads ${unread.write} only from sessions under ${unread.readFrom}.`);
          break;
        default: {
          const unhandled: never = unread;
          return unhandled;
        }
      }
    }
  }
  return notes;
}

const RECORDED_WORDS = {
  rules: { noun: 'rules', every: 'every rule', field: 'rules' },
  blocks: { noun: 'instruction blocks', every: 'every instruction block', field: 'claudemd' },
} as const;

/** What doctor compares for one tool that teamai writes rules or blocks for now. */
type WrittenPlace = {
  readonly tool: string;
  readonly own: string;
  readonly writes: readonly string[];
  readonly unread: 'unknown' | readonly Unread[];
};

async function writtenPlaces(ctx: DoctorContext, resource: 'rules' | 'blocks'): Promise<WrittenPlace[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];
  const install = installOf(teamConfig, localConfig);
  const located: WrittenPlace[] = [];
  for (const tool of Object.keys(ctx.toolPaths)) {
    const where = resource === 'rules'
      ? await locate(tool, 'rules', install)
      : await locate(tool, 'blocks', install);
    if (where.channel !== 'files') continue;
    const own = writable(where);
    if (own === null) continue;
    located.push({
      tool,
      own: own.path,
      writes: writesOf(where).map((place) => place.path),
      unread: where.reads === 'unknown' ? 'unknown' : unreadWrites(where, realHost(), doctorSession(install)),
    });
  }
  return located;
}

/**
 * Per tool, whether it reads the rules or instruction blocks teamai writes,
 * and whether the last pull wrote them where it takes them now (#1221).
 */
export async function buildRecordedPlaceChecks(ctx: DoctorContext, resource: 'rules' | 'blocks'): Promise<Check[]> {
  const located = await writtenPlaces(ctx, resource);
  if (located.length === 0) return [];
  const words = RECORDED_WORDS[resource];
  const { checkoutRecordKey } = await import('./pull.js');
  const key = await checkoutRecordKey(ctx.localConfig);
  const recorded = key === undefined ? undefined : placesRecordOf((await loadStateForScope(ctx.localConfig)).lastPullByWorkspace?.[key])?.[resource];
  const checks: Check[] = [];
  for (const { tool, own, writes, unread } of located) {
    if (unread !== 'unknown') {
      const notRead = unread.filter((entry) => entry.reason === 'not-read');
      checks.push({
        name: `${tool} reads the ${words.noun} teamai writes`,
        source: 'local',
        check: async () => notRead.length === 0,
        fix: `${notRead.map((entry) => `${tool} does not read ${entry.write}`).join('; ')}. `
          + `Point toolPaths.${tool}.${words.field} in teamai.yaml at a place ${tool} reads.`,
      });
    }
    const wrote = recorded?.[tool];
    if (wrote === undefined) continue;
    const earlier: string[] = [];
    for (const place of wrote) if (!await amongPlaces(place, writes)) earlier.push(place);
    checks.push({
      name: `${tool} ${words.noun} are where the last pull wrote them`,
      source: 'local',
      check: async () => samePlaces({ [tool]: wrote }, { [tool]: [...writes] }),
      fix: await amongPlaces(own, wrote)
        ? `${tool} takes ${words.noun} from ${own}, but the last pull could not deliver ${words.every} there, so it kept teamai's copies in ${earlier.join(', ')}. `
          + 'Run `teamai pull`: it says what holds them back.'
        : `${tool} takes ${words.noun} from ${own}, but the last pull wrote them to ${wrote[0]}. Run \`teamai pull\` to sync them there.`,
    });
  }
  return checks;
}

/** A session-limited read of `resource` (#1221). */
export async function recordedPlaceNotes(ctx: DoctorContext, resource: 'rules' | 'blocks'): Promise<string[]> {
  const notes: string[] = [];
  const words = RECORDED_WORDS[resource];
  for (const { tool, unread } of await writtenPlaces(ctx, resource)) {
    if (unread === 'unknown') continue;
    for (const entry of unread) {
      switch (entry.reason) {
        case 'not-read':
        case 'shadowed':
          break;
        case 'cwd-only':
          notes.push(`${tool} reads project ${words.noun} only from a session started in ${entry.readFrom}.`);
          break;
        case 'outside-workspace':
          notes.push(`${tool} reads ${entry.write} only from sessions under ${entry.readFrom}.`);
          break;
        default: {
          const unhandled: never = entry;
          return unhandled;
        }
      }
    }
  }
  return notes;
}

/**
 * Build one delivery check per tool that receives rules: every rule the member
 * should have, against what is on disk for that tool.
 *
 * Rules change filename *and* content per tool, so only the handler can say
 * where one lands. Asking it here is what keeps the check from growing its own
 * copy of the extension table (#624).
 */
export async function buildRulesDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { buildRolePullContext, resolveDesiredRules } = await import('./resources/desired.js');
  const { getHandler } = await import('./resources/index.js');

  const roleContext = await buildRolePullContext(localConfig);
  const { items } = await resolveDesiredRules(teamConfig, localConfig, roleContext);
  const activation = await buildRulesActivationChecks(ctx, items);
  if (items.length === 0) {
    // Failed cleanup can leave an active glob or inline block after the last rule goes.
    const failing: Check[] = [];
    for (const check of activation) if (!await check.check()) failing.push(check);
    return failing;
  }

  // `pullItem` writes the handler's render byte for byte, so anything else at
  // that path is a stale or hand-edited copy. A tool with its own rules format
  // scopes the rule by fields of it (Cursor `globs`, Kiro `inclusion`, …);
  // comparing against the render catches a wrong value there, which checking
  // the keys were present did not.
  const ruleLabels = ['not delivered', 'delivered from an older copy', RECORDED_OLDER_RULE, FLAT_NAME_TAKEN, CHANGED_BY_YOU, MEMBERS_OWN] as const;
  // Pull's line for each file of the member's own, by the tool it is in.
  const memberLines = new Map<string, string[]>();
  const { byTool } = await walkDelivery(
    getHandler('rules'),
    ctx,
    items,
    async (target, item) => {
      // readFileSafe answers both questions at once: a directory or a dangling
      // link on the name reads as null, the same as nothing being there.
      const delivered = await readFileSafe(target.dest);
      if (delivered === null) return ruleLabels[0];
      if (target.content === undefined || delivered === target.content) return null;
      return differingCopyLabel(item, target, ruleLabels[1], localConfig, linesFor(memberLines, target.tool), RECORDED_OLDER_RULE);
    },
  );
  // A tool that reads only the top of its rules directory gets no file for a
  // namespaced rule whose flat name another rule has (`deliveryTargets`).
  const install = installOf(teamConfig, localConfig);
  const rulesDirOf = async (tool: string): Promise<string | null> => {
    const own = writable(await locate(tool, 'rules', install));
    return own?.kind === 'dir' ? own.path : null;
  };
  for (const tool of Object.keys(install.toolPaths)) {
    if (!ruleFormatForTool(tool)?.flat) continue;
    const dir = await rulesDirOf(tool);
    if (dir === null) continue;
    const stems = ruleStemsForTool(tool, items.map((item) => item.name));
    const collisions = items.filter((item) => !stems.has(item.name));
    if (collisions.length === 0) continue;
    let delivery = byTool.get(tool);
    if (!delivery) {
      delivery = { tool, dir, problems: new Map() };
      byTool.set(tool, delivery);
    }
    for (const item of collisions) appendTo(delivery.problems, FLAT_NAME_TAKEN, item.name);
  }
  const { unreadRulesDir } = await import('./resources/rules.js');
  const perTool: Check[] = [];
  for (const [tool, delivery] of byTool) {
    // A team `toolPaths` entry written before the tool's rules moved still
    // sends them to a directory it never reads (#946).
    const rulesDir = await rulesDirOf(delivery.tool);
    const unread = rulesDir === null ? undefined : unreadRulesDir(delivery.tool, rulesDir, localConfig);
    const problems = describeProblems(delivery.problems, ruleLabels);
    const restore = delivery.problems.has(ruleLabels[0]) || delivery.problems.has(ruleLabels[1]);
    perTool.push({
      name: `Rules delivered to ${tool}`,
      source: 'local',
      check: async () => !hasDeliveryProblem(delivery) && unread === undefined,
      // The fix names the directory rather than the tool: a rule's delivered
      // filename carries a per-tool extension the reader would have to derive.
      // A copy there is inert whatever its state, so only the entry is worth fixing.
      fix: unread
        ? `${unread.why}, but the team teamai.yaml's toolPaths.${delivery.tool} entry still sends the rules to `
          + `${rulesDir}: a team entry replaces teamai's default for ${delivery.tool} whole, so ${delivery.tool} gets `
          + `none of the rules copied there. In the team teamai.yaml, ${unread.toolPathsFix}, then run \`teamai pull\`.`
        : `In ${delivery.dir}, ${problems}. `
          + (delivery.problems.has(FLAT_NAME_TAKEN)
            ? `${tool} reads only the top level of that directory, so a rule not written there never reaches it: `
              + 'rename one of them in the team repo; `teamai pull` names the rules that share the file. '
            : '')
          + (restore
            ? 'Run `teamai pull --force`: a plain pull skips a scope whose team repo has not changed, '
              + 'so it cannot restore a missing copy or one teamai has no record of writing. '
            : '')
          + (delivery.problems.has(RECORDED_OLDER_RULE)
            ? 'Run `teamai pull` to rewrite a copy that still holds what teamai recorded writing: it re-renders '
              + 'one even when the team repo has not changed. '
            : '')
          + `${olderRuleCopyMeaning(delivery.tool)}${changedByYouFix(delivery)}${membersOwnFix(memberLines, delivery)}`,
    });
  }

  return [...activation, ...perTool];
}

/** An older render of a rule that still holds what teamai recorded writing, which a plain pull re-renders. */
const RECORDED_OLDER_RULE = 'delivered in an older render teamai recorded';

/** A namespaced rule a tool reading only the top of its rules directory gets no file for. */
const FLAT_NAME_TAKEN = 'not written, as another team rule has its flat name';

/** What a rule copy "delivered from an older copy" means for `tool`, in its own format. */
function olderRuleCopyMeaning(tool: string): string {
  const fields = ruleFormatForTool(tool)?.scopeFields ?? [];
  if (fields.length === 0) {
    return `An older copy is one whose bytes are no longer the team \`.md\`, which ${tool} gets verbatim.`;
  }
  const named = fields.map((field) => `\`${field}\``);
  return `An older copy is one whose bytes are no longer what teamai renders for ${tool}, frontmatter included: `
    + `one whose ${named.slice(0, -1).join(', ')}${named.length > 1 ? ' or ' : ''}${named[named.length - 1]} drifted `
    + 'from the team `.md` applies to the wrong files while looking perfectly well-formed.';
}

/**
 * On OpenCode V2, which parses `instructions` and ignores it (#993), the check
 * that teamai's plugin in HOME is installed as this build writes it; its
 * context hook is what adds `what`. Null on V1, which loads `instructions`.
 */
async function opencodeV2PluginCheck(ctx: DoctorContext, name: string, what: string): Promise<Check | null> {
  const { opencodeContextPlugin, opencodeMajorVersion } = await import('./opencode-hooks.js');
  if (await opencodeMajorVersion() < 2) return null;
  const { file, ready } = await opencodeContextPlugin();
  const { localConfig, teamConfig } = ctx;
  // Without the plugin a pull keeps what OpenCode V1 reads, which V2 then reads its MCP servers from (#915).
  const keeps = localConfig.scope === 'project' && localConfig.repo.kind !== 'http' && teamConfig !== null && isGitExcludeEnabled(localConfig, teamConfig)
    ? ' Until it is current, teamai keeps the entries OpenCode V1 reads in the project\'s opencode.json files; the next pull with the plugin in place takes them out.'
    : '';
  return {
    name,
    source: 'local',
    check: async () => ready,
    fix: `${file} is missing or out of date. OpenCode V2 ignores \`instructions\` and gets ${what} only through this plugin. `
      + `Run \`teamai hooks inject\` to reinstall it.${keeps}`,
  };
}

/**
 * The two rule destinations that are not a file per tool.
 *
 * OpenCode does not auto-scan its rules directory: a `.md` copied there is
 * inert until `opencode.json` references it through the glob the pull owns.
 * Hermes has no rules directory at all — its rules are inlined into a managed
 * block of SOUL.md. Both are delivered by `pullAllRules` rather than by
 * `pullItem`, so `deliveryTargets` cannot see them, and a per-file check
 * passes over a tool that reads none of what it was given.
 *
 * They take the shape of the hook and MCP checks — one destination, not one
 * per tool — rather than an invented entry in `deliveryTargets`.
 */
async function buildRulesActivationChecks(ctx: DoctorContext, items: ResourceItem[]): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { RulesHandler, inlinedRulesText } = await import('./resources/rules.js');
  const handler = new RulesHandler();
  const checks: Check[] = [];

  const opencode = await handler.opencodeInstructionsTarget(teamConfig, localConfig, items);
  const opencodeV2 = opencode === null ? null : await opencodeV2PluginCheck(ctx, 'Team rules are active in opencode', 'the team rules');
  if (opencodeV2) {
    checks.push(opencodeV2);
  } else if (opencode !== null) {
    const { readOpencodeInstructionList } = await import('./resources/opencode-config.js');
    // A missing file just lists nothing yet; null is one the pull cannot parse.
    const instructions = await pathExists(opencode.configFile) ? await readOpencodeInstructionList(opencode.configFile) : [];
    const globs = items.length > 0 ? opencode.globs : [];
    const missing = globs.filter((glob) => !instructions?.includes(glob));
    const stale = (instructions ?? []).filter((entry): entry is string =>
      typeof entry === 'string' && opencode.owns(entry) && !globs.includes(entry));
    const relativeStale = stale.filter((entry) => !path.isAbsolute(entry));
    const namespaceStale = stale.filter((entry) => path.isAbsolute(entry));
    const quoted = (entries: string[]): string => entries.map((entry) => `\`${entry}\``).join(', ');
    // Pull sets these globs even when the team repo has not moved (#946).
    const rerun = 'Run `teamai pull`.';
    checks.push({
      name: 'Team rules are active in opencode',
      source: 'local',
      check: async () => instructions !== null && missing.length === 0 && stale.length === 0,
      fix: instructions === null
        ? `${opencode.configFile} could not be read as a JSON object, so the pull left it alone `
          + 'without updating `instructions`. Fix the file, then run '
          + '`teamai pull`.'
        : [
          ...(missing.length > 0
            ? [`${opencode.configFile} does not list ${quoted(missing)} under \`instructions\`. `
              + 'OpenCode does not scan a rules directory, so every team rule delivered there is '
              + 'inert until a glob references it.']
            : []),
          ...(relativeStale.length > 0
            ? [`${opencode.configFile} still lists ${quoted(relativeStale)}, which teamai no longer writes. `
              + 'OpenCode resolves a relative entry from the session\'s working directory, so it loads '
              + 'that directory\'s rules instead of the team rules.']
            : []),
          ...(namespaceStale.length > 0
            ? [`${opencode.configFile} still lists ${quoted(namespaceStale)}, for team rules that `
              + 'no longer reach this scope, so OpenCode loads whatever copy is left there.']
            : []),
          rerun,
        ].join(' '),
    });
  }

  // SOUL.md is global and only a user-scope pull writes it; in a project,
  // `ruleChannelNotes` says why Hermes gets no project rules (#946).
  const soulLocation = localConfig.scope === 'user' && !isAgentExcluded(localConfig, 'hermes')
    ? await locate('hermes', 'blocks', installOf(teamConfig, localConfig))
    : null;
  const soul = soulLocation !== null && isInstalledFor(soulLocation) ? ownOf(soulLocation)?.path : undefined;
  if (soul !== undefined) {
    const { readSoulRules } = await import('./hermes-config.js');
    const expected = await inlinedRulesText(items);
    const delivered = await readSoulRules(soul);
    checks.push({
      name: 'Team rules are inlined in Hermes SOUL.md',
      source: 'local',
      check: async () => (items.length === 0 && delivered === null) || delivered === expected.trim(),
      fix: delivered === null
        ? `${soul} carries no teamai rules block, so Hermes reads none of the `
          + 'team rules. Run `teamai pull` to restore it.'
        : `The teamai block in ${soul} is not what the team rules inline to: `
          + 'Hermes reads standing instructions from this file rather than a rules directory, '
          + 'so a stale block is a stale rule set. Run `teamai pull` to rewrite it.',
    });
  }

  checks.push(...await buildUserRulesFileChecks(ctx, items));
  checks.push(...await buildCursorUserRulesHookChecks(ctx));
  if (items.length > 0) checks.push(...await buildProjectRulesHookChecks(ctx));
  return checks;
}

/**
 * Cursor loads the user-scope rules file only in a workspace under the home
 * directory; elsewhere the sessionStart hook adds them (#1197). So the file
 * check covers half the workspaces, and this one covers the rest: the hook is
 * registered, and what it adds fits Cursor's limit. The team env hint shares
 * that reply in every session, and the dispatcher keeps it over the rules when
 * both do not fit, so a second check says when they do not.
 */
async function buildCursorUserRulesHookChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig || localConfig.scope !== 'user' || isAgentExcluded(localConfig, 'cursor')) return [];
  const toolPath = scopedToolPaths(teamConfig, localConfig).cursor;
  const rulesDir = writable(await locate('cursor', 'rules', installOf(teamConfig, localConfig)));
  if (rulesDir?.kind !== 'dir' || !toolPath?.settings) return [];
  const { cursorUserRulesText } = await import('./cursor-user-rules.js');
  const text = await cursorUserRulesText(teamConfig, localConfig);
  if (text === null) return [];

  const { CURSOR_HOOK_CONTEXT_LIMIT } = await import('./hook-dispatch.js');
  const { readBuiltinOverride } = await import('./resources/hooks.js');
  const builtin = await readBuiltinOverride(localConfig);
  const disabledByTeam = builtin.known && (builtin.override?.disabled ?? []).includes('Hook dispatch session-start');
  const file = path.join(resolveBaseDir(localConfig), toolPath.settings);
  const read = await readJsonObject(file);
  const hooks = read.kind === 'ok' ? read.value.hooks : undefined;
  const sessionStart = hooks !== null && typeof hooks === 'object' ? (hooks as { sessionStart?: unknown }).sessionStart : undefined;
  const registered = Array.isArray(sessionStart) && sessionStart.some((entry: unknown) => {
    const command = entry !== null && typeof entry === 'object' ? String((entry as { command?: unknown }).command ?? '') : '';
    return /\bhook-dispatch session-start\b/.test(command) && /--tool[= ]cursor(?![\w-])/.test(command);
  });
  const fits = text.length <= CURSOR_HOOK_CONTEXT_LIMIT;
  const why = `Cursor loads ${rulesDir.path} only in a workspace under the home directory; `
    + 'elsewhere the teamai sessionStart hook adds the team rules and instructions';
  const fix = read.kind === 'invalid'
    ? `${why}, but ${file} is not valid JSON (${read.error}), so Cursor runs no hooks from it and those workspaces `
      + 'get none of them. Fix the file by hand (teamai does not rewrite a file it cannot parse), then run '
      + '`teamai hooks inject`.'
    : !registered && disabledByTeam
      ? `${why}, but the team's hooks/hooks.yaml lists \`Hook dispatch session-start\` under \`builtin.disabled\`, so `
        + `${file} registers none and those workspaces get none of them. Ask the team to remove that entry, then run `
        + '`teamai hooks inject`.'
      : !registered
        ? `${why}, but ${file} registers no teamai sessionStart hook for Cursor, so those workspaces get none of them. `
          + 'Run `teamai hooks inject` to rewrite it.'
        : `${why}, but they are ${text.length} characters, over Cursor's ${CURSOR_HOOK_CONTEXT_LIMIT}-character limit `
          + 'for hook context, so teamai leaves them out and those workspaces get none of them. Shorten the team rules, '
          + 'culture.md or the claudemd/ files for this scope.';
  const checks: Check[] = [{
    name: 'Team rules reach Cursor workspaces outside the home directory',
    source: 'local',
    check: async () => registered && fits,
    fix,
  }];
  if (!registered || !fits) return checks;

  const { buildHandlerRegistry } = await import('./hook-handlers.js');
  const envHint = buildHandlerRegistry().find((registration) => registration.handler.name === 'team-env-hint');
  const reply = await envHint?.handler.execute({ hook_event_name: 'SessionStart' }, 'cursor', localConfig) ?? null;
  const envText = reply === null ? '' : String(JSON.parse(reply)?.hookSpecificOutput?.additionalContext ?? '');
  const length = (envText === '' ? text : `${text}\n${envText}`).trim().length;
  checks.push({
    name: 'Team rules and the team env hint fit one Cursor hook reply',
    source: 'local',
    informational: true,
    check: async () => length <= CURSOR_HOOK_CONTEXT_LIMIT,
    fix: `In a Cursor workspace outside the home directory the team rules (${text.length} characters) and the team env `
      + `hint (${envText.length}) make ${length} characters, over Cursor's ${CURSOR_HOOK_CONTEXT_LIMIT}-character limit `
      + 'for hook context, so teamai keeps the env hint and leaves the rules out. Shorten the team rules, culture.md, '
      + 'the claudemd/ files or the env variable descriptions for this scope.',
  });
  return checks;
}

/** The entries under `SessionStart` that dispatch a teamai session-start. */
function sessionStartDispatchEntries(eventMap: unknown): { command: string; args: string[] }[] {
  const groups = (eventMap as Record<string, unknown> | null | undefined)?.SessionStart;
  if (!Array.isArray(groups)) return [];
  return groups
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((entry: { command?: unknown; args?: unknown }) => ({
      command: String(entry?.command ?? ''),
      args: (Array.isArray(entry?.args) ? entry.args : []).map(String),
    }))
    .filter(({ command, args }) => [command, ...args].join(' ').includes('hook-dispatch session-start'));
}

/**
 * The teamai `hook-dispatch session-start` commands under `SessionStart` in a
 * Claude-shaped map of hook events (ZCode's `hooks.events`, the dsh bridge's
 * `hooks`).
 */
function sessionStartDispatches(eventMap: unknown): string[] {
  return sessionStartDispatchEntries(eventMap).map(({ command, args }) => [command, ...args].join(' '));
}

/**
 * Whether the registered ZCode entry hands back what it is given.
 *
 * ZCode talks to a `process` hook over stdio — one JSON line in, the reply on
 * stdout — and on Windows the entry runs a Node launcher written beside the
 * config, so the dispatch's bytes have to survive that hop. In #1030 they did
 * not: the launcher's predecessor dropped the dispatch's stdout outright, so
 * sessions got no rules while the entry stayed registered and enabled and the
 * registration check above stayed green.
 *
 * This exercises that hop with the entry's own command and arguments, swapping
 * its tail for two stubs: one that echoes its stdin, one that exits 7. The tail
 * is the dispatch itself, which must not be run — a session-start dispatch
 * carries a network pull (`toZcodeEntry`). Both stubs are bounded by
 * `ZCODE_PROBE_TIMEOUT_MS` and touch nothing but the three stdio handles, so
 * the check stays read-only.
 */
const ZCODE_PROBE_TIMEOUT_MS = 10_000;

function zcodeEntryCarriesItsReply(entry: { command: string; args: string[] }): boolean {
  // The tail is the entry's last argument: the dispatch command on POSIX
  // (`bash -c <tail>`), the same command behind the launcher on Windows
  // (`node <launcher> <tail>`). Replacing only that slot leaves the rest of the
  // entry — the launcher included — exactly as ZCode will invoke it, which is
  // the point: the launcher is where #1030 broke.
  if (!entry.command || entry.args.length === 0) return false;
  const head = entry.args.slice(0, -1);
  const run = (tail: string, input?: Buffer) => spawnSync(entry.command, [...head, tail], {
    input,
    timeout: ZCODE_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });

  const probe = Buffer.from('{"probe":"teamai-zcode-delivery"}', 'utf8');
  const echoed = run('node -e "process.stdin.pipe(process.stdout)"', probe);
  if (echoed.error || echoed.status !== 0 || !Buffer.isBuffer(echoed.stdout)) return false;
  // ZCode parses the whole reply as JSON: any startup output corrupts it.
  if (!echoed.stdout.equals(probe)) return false;
  return run('node -e "process.exit(7)"').status === 7;
}

/**
 * In a project, ZCode and DeepSeek Harness get the team rules only from
 * teamai's session-start hook (#946), so doctor checks the hook the tool
 * runs: ZCode reads only the user-level ~/.zcode/cli/config.json, and only
 * with `hooks.enabled`; DeepSeek Harness loads teamai's hook config only
 * through the row teamai keeps in `$DSH_HOME/cordis.patch.yml` (#1219).
 * Pi's extension is checked with the team instructions it also carries
 * (`buildInstructionDeliveryChecks`).
 *
 * The ZCode checks are split by what each one can see: registration reads the
 * two things ZCode itself reads off the config — `hooks.enabled` and the
 * SessionStart entry — and delivery runs that entry's own command with its
 * dispatch tail swapped for a stub, because nothing in the file says whether
 * the hook's output actually reaches a session (#1030).
 */
async function buildProjectRulesHookChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig || localConfig.scope !== 'project') return [];
  const home = getUserHome();
  const inject = 'Run `teamai hooks inject` to rewrite it.';
  const checks: Check[] = [];

  const zcodeSettings = scopedToolPaths(teamConfig, { ...localConfig, scope: 'user' }).zcode?.settings;
  if (zcodeSettings && !isAgentExcluded(localConfig, 'zcode') && await pathExists(path.join(home, '.zcode'))) {
    const file = path.join(home, zcodeSettings);
    const read = await readJsonObject(file);
    const hooks = read.kind === 'ok' ? read.value.hooks as { enabled?: unknown; events?: unknown; maxOutputBytes?: unknown } | undefined : undefined;
    const entries = sessionStartDispatchEntries(hooks?.events);
    const registered = entries.length > 0;
    const enabled = hooks?.enabled === true;
    checks.push({
      name: 'The teamai SessionStart hook is registered and enabled for zcode',
      source: 'local',
      check: async () => registered && enabled,
      fix: read.kind === 'invalid'
        ? `${file} is not valid JSON (${read.error}), so ZCode reads no hooks from it: the teamai SessionStart hook `
          + 'is neither registered nor enabled, and sessions in this project get none of the team rules. Fix the file '
          + 'by hand (teamai does not rewrite a file it cannot parse), then run `teamai hooks inject`.'
        : !registered
          ? `${file} registers no teamai SessionStart hook, so sessions in this project get none of the team rules: `
            + `ZCode runs only the hooks in this file, none from a project. ${inject}`
          : `${file} sets hooks.enabled to something other than true, so ZCode runs none of the hooks it registers, `
            + 'and sessions in this project get none of the team rules. Run `teamai hooks inject`, which turns them on.',
    });
    // Registration is not delivery: nothing below is worth probing until the
    // entry is there and turned on, and while it is not, the check above
    // already fails and names the reason.
    const entry = entries[0];
    if (entry && enabled) {
      const { teamRulesContext } = await import('./resources/rules.js');
      const rules = await teamRulesContext(teamConfig, localConfig);
      if (rules !== null) {
        // ZCode caps the serialized stdout, not the number of context characters.
        // Other session hints can make the final reply larger; this is a lower bound.
        const bytes = Buffer.byteLength(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: rules } }), 'utf8');
        const limit = hooks?.maxOutputBytes ?? 32_768;
        const valid = typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0;
        checks.push({
          name: 'Project rules fit the zcode hook stdout budget',
          source: 'local',
          check: async () => valid && bytes <= limit,
          fix: `The project rules alone need ${bytes} UTF-8 bytes of hook stdout, before other session hints. `
            + `${file} uses hooks.maxOutputBytes=${String(limit)} (default 32768). ZCode truncates oversized stdout and drops the reply when it no longer parses, `
            + 'so registration can be healthy while no rules reach the model. Shorten the project rules or set '
            + 'hooks.maxOutputBytes to a positive integer large enough for the complete reply, then start a new ZCode session.',
        });
      }
      checks.push({
        name: 'The teamai SessionStart hook for zcode returns its reply to the session',
        source: 'local',
        check: async () => zcodeEntryCarriesItsReply(entry),
        fix: `${file} registers the teamai SessionStart hook and turns hooks on, but running that entry's own `
          + 'command handed back nothing where the dispatch should have answered (or lost its exit status), so a '
          + 'session would start with none of the team rules while registration still looks healthy (#1030). On '
          + `Windows the entry goes through the Node launcher beside this file. ${inject} If it keeps failing, `
          + "the entry's launch command cannot run in this shell.",
      });
    }
  }

  const { isDshInstalled } = await import('./dsh-hooks.js');
  if (!isAgentExcluded(localConfig, 'dsh') && await isDshInstalled()) {
    const { isDshHooksMounted, resolveDshHomePatchPath, resolveDshHookConfigPath } = await import('./dsh-hooks.js');
    const configPath = resolveDshHookConfigPath();
    const homePatchPath = resolveDshHomePatchPath();
    const mounted = await isDshHooksMounted(configPath);
    const read = await readJsonObject(configPath);
    const registered = read.kind === 'ok' && sessionStartDispatches(read.value.hooks).length > 0;
    const broken = [...(mounted ? [] : [homePatchPath]), ...(registered ? [] : [configPath])];
    checks.push({
      name: 'Project rules reach dsh through its session-start hook',
      source: 'local',
      check: async () => broken.length === 0,
      fix: `${broken.join(' and ')} ${broken.length === 1 ? 'is' : 'are'} missing or out of date, so DeepSeek Harness `
        + 'sessions in this project get none of the team rules. Run `teamai hooks inject` to rewrite '
        + `${broken.length === 1 ? 'it' : 'them'}.`,
    });
  }
  return checks;
}

/**
 * In user scope each tool with no rules format reads the team rules from a
 * managed block of a file only it reads (`userRulesFile`: the Codex family's
 * AGENTS.md, #938; ZCode, DeepSeek Harness, the OpenClaw workspace, Pi,
 * JoyCode's rules.txt, #946); in a project the session-start hook (the Codex
 * family, ZCode, DeepSeek Harness) or Pi's extension adds them, and doctor
 * checks that channel instead. One check per enabled,
 * installed tool, on the bytes of the block in the file the tool reads.
 */
async function buildUserRulesFileChecks(ctx: DoctorContext, items: ResourceItem[]): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig || localConfig.scope !== 'user') return [];

  const { inlineRulesLabelOf, inlineRulesLocationOf, teamRulesBlock, unreadableConfigOf } = await import('./resources/rules.js');
  const { isCodexTool } = await import('./utils/tool-names.js');
  const { TEAMAI_TEAM_RULES_START, TEAMAI_TEAM_RULES_END, scopedToolPaths } = await import('./types.js');
  const expected = await teamRulesBlock(items);
  const install = installOf(teamConfig, localConfig);
  const checks: Check[] = [];
  for (const tool of Object.keys(install.toolPaths)) {
    const label = inlineRulesLabelOf(tool);
    // Hermes keeps its rules in its own SOUL.md block.
    if (label === null || tool === 'hermes' || isAgentExcluded(localConfig, tool)) continue;
    const location = await inlineRulesLocationOf(tool, install);
    if (location === null) continue;
    const codexFamily = isCodexTool(tool);
    const name = codexFamily && tool !== 'codex'
      ? `Team rules are inlined in ${label} (${tool})`
      : `Team rules are inlined in ${label}`;
    const unreadable = unreadableConfigOf(location);
    if (unreadable !== undefined) {
      const { unreadableRulesFileMessage } = await import('./instruction-targets.js');
      const fix = await unreadableRulesFileMessage(tool, unreadable);
      checks.push({ name, source: 'local', check: async () => false, fix });
      continue;
    }
    if (!location.gates.every((gate) => gate.met)) continue;
    const file = location.channel === 'files' ? location.own?.path ?? null : null;
    if (file === null) {
      // A team `toolPaths` entry replaces the default one whole, so a Codex
      // entry written before #938 leaves it nowhere to read user rules from.
      // One with no `rules` path delivers no rules to it on purpose; with no
      // team rules it misses none.
      if (!codexFamily || items.length === 0 || !scopedToolPaths(teamConfig, localConfig)[tool]?.rules) continue;
      checks.push({
        name,
        source: 'local',
        check: async () => false,
        fix: `The toolPaths entry for ${tool} has no \`claudemd\` path, so pull has no instructions `
          + `file to inline the team rules into and ${tool} reads none of them. Add `
          + `\`userScope.claudemd: .${tool}/AGENTS.md\` to that entry in the team teamai.yaml, `
          + 'then run `teamai pull`.',
      });
      continue;
    }
    const content = await readFileSafe(file);
    const start = content?.indexOf(TEAMAI_TEAM_RULES_START) ?? -1;
    const end = content?.indexOf(TEAMAI_TEAM_RULES_END) ?? -1;
    const delivered = content !== null && start !== -1 && end > start
      ? content.slice(start, end + TEAMAI_TEAM_RULES_END.length)
      : null;
    const problems: string[] = [];
    // With no rule body to inline (`expected === null`), pull writes no block.
    if (delivered === null && expected !== null) {
      problems.push(`${file} carries no team-rules block, so ${tool} reads none of the team `
        + 'rules. Run `teamai pull` to restore it.');
    } else if (delivered !== expected) {
      problems.push(`The team-rules block in ${file} is not what the team rules inline to: ${tool} reads `
        + 'the team rules from this file rather than a rules directory, so a stale block '
        + 'is a stale rule set. Run `teamai pull` to rewrite it.');
    }
    // Codex reads AGENTS.override.md instead of AGENTS.md in the same
    // directory, so a current block there is never seen. An empty or
    // whitespace-only override shadows it too (checked with `codex exec`).
    const override = path.join(path.dirname(file), 'AGENTS.override.md');
    if (codexFamily && expected !== null && await isReadableFile(override)) {
      problems.push(`${override} exists, so Codex reads it instead of ${file} and never sees the `
        + 'team rules. Move its content into AGENTS.md, or delete it.');
    }
    checks.push({ name, source: 'local', check: async () => problems.length === 0, fix: problems.join(' ') });
  }
  return checks;
}


/**
 * Build one delivery check per tool that receives agents.
 *
 * An agent's desired set is a relation rather than a product: `spec.targets`
 * names the tools it is for, and each renders into its own format, so the
 * handler is the only thing that can say which tools owe what file (#624).
 */
export async function buildAgentsDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { buildRolePullContext, describeDeliveryConflict, resolveDesiredAgents } = await import('./resources/desired.js');
  const { AgentsHandler } = await import('./resources/agents.js');
  const handler = new AgentsHandler();

  let items: ResourceItem[];
  try {
    const desired = await resolveDesiredAgents(teamConfig, localConfig, await buildRolePullContext(localConfig));
    if (desired.kind === 'conflict') return unresolvableCheck('agents', describeDeliveryConflict(desired));
    ({ items } = desired);
  } catch (e) {
    return unresolvableCheck('agents', e instanceof Error ? e.message : String(e));
  }
  if (items.length === 0) return [];

  // An agent whose spec reaches no tool at all is not a per-tool failure: the
  // file is in the team repo and nothing renders it anywhere.
  const agentLabels = ['not delivered', 'delivered from an older spec', MODEL_CHANGED, CHANGED_BY_YOU, MEMBERS_OWN] as const;
  // Pull's line for each file of the member's own, by the tool it is in.
  const memberLines = new Map<string, string[]>();
  // What the last pull wrote for each agent, its model as recorded then (#830).
  const recordedTargets = new Map<string, Promise<DeliveryTarget[]>>();
  const recordedContent = async (item: ResourceItem, tool: string): Promise<string | undefined> => {
    let targets = recordedTargets.get(item.name);
    if (!targets) {
      targets = handler.recordedDeliveryTargets(teamConfig, localConfig, item);
      recordedTargets.set(item.name, targets);
    }
    return (await targets).find((target) => target.tool === tool)?.content;
  };
  const { byTool, unreceived } = await walkDelivery(
    handler,
    ctx,
    items,
    // `pullItem` writes `content` verbatim, so anything else at that path is a
    // render of an older spec — a copy that landed and is still wrong, the
    // same class as a rule whose delivered copy no longer matches its render —
    // or of the model the last pull resolved, which has changed since.
    async (target, item) => {
      // readFileSafe answers both questions at once: a directory or a dangling
      // link on the name reads as null, the same as nothing being there.
      const delivered = await readFileSafe(target.dest);
      if (delivered === null) return agentLabels[0];
      if (target.content === undefined || delivered === target.content) return null;
      if (delivered === await recordedContent(item, target.tool)) return MODEL_CHANGED;
      return differingCopyLabel(item, target, agentLabels[1], localConfig, linesFor(memberLines, target.tool));
    },
  );
  // An agent whose model cannot be resolved is held, not unreachable: the
  // model aliases check names the reason.
  const { heldAgentNames } = await import('./doctor-agent-models.js');
  const held = await heldAgentNames(ctx);
  // A tool that would not load an agent gets no copy; this check, not the unreachable one, says why.
  const rejections: { name: string; tool: string; reason: string }[] = [];
  for (const item of items) {
    for (const { tool, reason } of await handler.rejectedTools(teamConfig, localConfig, item)) rejections.push({ name: item.name, tool, reason });
  }
  const unreachable = unreceived.filter((name) => !held.has(name) && !rejections.some((rejection) => rejection.name === name));

  const checks: Check[] = [...byTool].map(([tool, delivery]) => {
    const modelChanged = delivery.problems.has(MODEL_CHANGED);
    const restoredByForce = [...delivery.problems.keys()]
      .some((label) => label !== MODEL_CHANGED && label !== CHANGED_BY_YOU && label !== MEMBERS_OWN);
    return {
      name: tool === 'cursor' && localConfig.scope === 'user'
        ? 'Agents delivered to cursor (the Cursor IDE reads them; the Cursor CLI reads agents only from the workspace)'
        : `Agents delivered to ${tool}`,
      source: 'local',
      check: async () => !hasDeliveryProblem(delivery),
      fix: [
        `In ${delivery.dir}, ${describeProblems(delivery.problems, agentLabels)}.`,
        ...(modelChanged ? ['A plain `teamai pull` redeploys an agent whose model changed.'] : []),
        ...(restoredByForce
          ? [`${modelChanged ? 'For the rest, run' : 'Run'} \`teamai pull --force\`: a plain pull skips a scope whose team repo `
            + 'has not changed, so it cannot restore this.']
          : []),
      ].join(' ') + changedByYouFix(delivery) + membersOwnFix(memberLines, delivery),
    };
  });

  // Only worth reporting once a tool is there to receive agents: with none
  // installed, "reaches no tool" is the machine, not the team repo. The gate is
  // the installed tools rather than the deliveries, or a set of agents that all
  // fail to render would report nothing at all.
  if (rejections.length > 0) {
    checks.push({
      name: 'Every team agent loads in the tools it targets',
      source: 'local',
      check: async () => false,
      fix: `Pull gives these agents no copy, since the tool would not load them. ${rejections.map(({ name, tool, reason }) => `${name} for ${tool}: ${reason}`).join(' ')} Fix the agent in the team repo.`,
    });
  }

  const agentTools = await handler.agentToolDirs(teamConfig, localConfig);
  if (unreachable.length > 0 && agentTools.length > 0) {
    checks.push({
      name: 'Every team agent reaches a tool',
      source: 'local',
      check: async () => false,
      fix: `${nameList(unreachable)} render for no installed tool. Either the spec does not `
        + 'parse — `teamai pull` names the reason — or its `targets:` lists only tools that '
        + 'are not installed here.',
    });
  }

  checks.push(...await agentsTrustChecks(ctx, handler, items));
  return checks;
}

/**
 * A tool that loads a project's agents only once it trusts the project (Codex,
 * #954), while teamai delivers team agents there. Pull writes them whatever
 * the verdict, so they are on disk and inert until the member trusts it.
 */
async function agentsTrustChecks(ctx: DoctorContext, handler: ResourceHandler, items: ResourceItem[]): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];
  const received = items.map((item) => item.name);
  const checks: Check[] = [];
  for (const { tool, own, where } of await writableAgentLocations(ctx)) {
    if (where.readGates.length === 0) continue;
    const names: string[] = [];
    for (const item of items) {
      if ((await handler.deliveryTargets(teamConfig, localConfig, item, received)).some((target) => target.tool === tool)) names.push(item.name);
    }
    if (names.length === 0) continue;
    for (const gate of where.readGates) {
      switch (gate.kind) {
        case 'codex-project-trust': {
          const trust = await codexProjectTrust(gate);
          const cause = `${own} holds team agents (${nameList(names)}), but Codex loads a project's agents only in a trusted project`;
          checks.push({
            name: 'Codex trusts this project, so it loads its team agents',
            source: 'local',
            check: async () => trust.kind === 'trusted',
            fix: trust.kind === 'trusted' ? '' : codexTrustFix(trust, gate, cause),
          });
          break;
        }
        default: {
          const unhandled: never = gate.kind;
          return unhandled;
        }
      }
    }
  }
  return checks;
}

/** Each tool teamai writes agents for now, with where it takes them. */
async function writableAgentLocations(ctx: DoctorContext): Promise<{ tool: string; own: string; where: FilesChannel<DirPlace> }[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];
  const install = installOf(teamConfig, localConfig);
  const located: { tool: string; own: string; where: FilesChannel<DirPlace> }[] = [];
  for (const tool of Object.keys(ctx.toolPaths)) {
    const where = await locate(tool, 'agents', install);
    if (where.channel !== 'files') continue;
    const own = writable(where);
    if (own !== null) located.push({ tool, own: own.path, where });
  }
  return located;
}

/**
 * Per tool, whether the last pull wrote its agents where it takes them now
 * (#1221): the env, or a recorded home, can move them after that pull.
 */
export async function buildAgentPlaceChecks(ctx: DoctorContext): Promise<Check[]> {
  const located = await writableAgentLocations(ctx);
  if (located.length === 0) return [];
  const { checkoutRecordKey } = await import('./pull.js');
  const key = await checkoutRecordKey(ctx.localConfig);
  const recorded = key === undefined ? undefined : placesRecordOf((await loadStateForScope(ctx.localConfig)).lastPullByWorkspace?.[key])?.agents;
  const checks: Check[] = [];
  for (const { tool, own, where } of located) {
    const wrote = recorded?.[tool];
    if (wrote === undefined) continue;
    const writes = writesOf(where).map((place) => place.path);
    const earlier: string[] = [];
    for (const dir of wrote) if (!await amongPlaces(dir, writes)) earlier.push(dir);
    checks.push({
      name: `${tool} agents are where the last pull wrote them`,
      source: 'local',
      check: async () => samePlaces({ [tool]: wrote }, { [tool]: writes }),
      fix: await amongPlaces(own, wrote)
        ? `${tool} takes agents from ${own}, but the last pull could not deliver every agent there, so it kept teamai's copies in ${earlier.join(', ')}. `
          + 'Run `teamai pull`: it says what holds them back.'
        : `${tool} takes agents from ${own}, but the last pull wrote them to ${wrote[0]}. Run \`teamai pull\` to sync them there.`,
    });
  }
  return checks;
}

const UNRESOLVED_VARS_RE = /^unresolved variable\(s\): (.+)$/;

/**
 * `${VAR}` names a skipped server is missing that the team has not declared as
 * secrets (#1011). A failed declaration can't say, so it names none. A reserved
 * name is never one: a team value for it is ignored, so declaring it would not help.
 */
function undeclaredMissingVars(
  skipped: ReadonlyArray<{ server: string; reason?: string }>,
  kept: ReadonlySet<string>,
  declared: ReadonlySet<string> | null,
): string[] {
  if (!declared) return [];
  const names = new Set<string>();
  for (const change of skipped) {
    if (kept.has(change.server)) continue;
    const match = UNRESOLVED_VARS_RE.exec(change.reason ?? '');
    if (!match?.[1]) continue;
    for (const key of match[1].split(', ')) {
      if (key && !declared.has(key) && !isReservedTeamEnvKey(key)) names.add(key);
    }
  }
  return [...names].sort();
}

/**
 * How to declare a missing `${VAR}` when it is a personal token (#1011).
 * A shared value such as a host stays in env.yaml: declaring it as a secret
 * would ignore that value and make every member set it.
 */
function declareSecretHint(keys: readonly string[]): string {
  if (keys.length === 0) return '';
  const adds = keys.map((key) => `\`teamai env add ${key} --secret\``).join(', ');
  const sets = keys.map((key) => `\`teamai env set ${key}\``).join(', ');
  const named = keys.length === 1 ? keys[0] : `any of ${keys.join(', ')}`;
  return ` If ${named} is a personal token, do not put the value in env.yaml. Declare it with ${adds} (no value), then each member runs ${sets}. A shared value stays in env.yaml.`;
}

/**
 * Build one check per tool that receives MCP servers.
 *
 * An MCP server is an entry inside the tool's own config file, not a file of
 * its own, so this takes the shape of the hook check rather than of
 * `deliveryTargets`. It reports two things a pull says once and never again:
 * a desired server whose entry is not there, and a server the reconcile
 * skipped — an unresolved `${VAR}` is the reason behind "MCP does not work"
 * that no other output points at (#662).
 */
/**
 * The team MCP servers doctor judges and the targets it judges them in: none
 * when nothing is owed (no team config, an HTTP-backed team, or `autoApply`
 * off), unreadable when the team's MCP files cannot be read.
 */
type TeamMcpForDoctor =
  | { kind: 'none' }
  | { kind: 'unreadable'; fix: string }
  | { kind: 'read'; teamConfig: TeamaiConfig; teamDefs: McpServerDef[]; targets: McpTarget[] };

async function teamMcpForDoctor(ctx: DoctorContext): Promise<TeamMcpForDoctor> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return { kind: 'none' };
  // HTTP-backed teams have no repo tree: servers arrive through the local-agent
  // install channel, and the desired set here would always be empty.
  if (localConfig.repo.kind === 'http') return { kind: 'none' };
  // Nothing was promised automatically, so nothing is owed until the member
  // runs `teamai mcp inject`.
  if (!getMcpSharing(teamConfig).autoApply) return { kind: 'none' };

  const { resolveMcpTargets, mcpTargetExcluded } = await import('./mcp-reconcile.js');
  const { mcpEntryReader, teamMcpToDef } = await import('./resources/mcp.js');
  const { describeEntryFailure, resolveEntriesFor } = await import('./namespaced-entries.js');
  const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
  if (resolution.kind === 'failed') return { kind: 'unreadable', fix: describeEntryFailure(resolution.failure) };
  const teamDefs = resolution.entries.map((entry) => teamMcpToDef(entry.entry));
  if (teamDefs.length === 0) return { kind: 'none' };
  const targets = (await resolveMcpTargets(teamConfig, localConfig)).filter((target) => !mcpTargetExcluded(localConfig, target));
  return { kind: 'read', teamConfig, teamDefs, targets };
}

/** The team servers `target` gets none of because its format cannot express their transport, less those the member excluded. */
async function unsupportedTransportServers(localConfig: LocalConfig, target: McpTarget, teamDefs: McpServerDef[]): Promise<McpServerDef[]> {
  const { supportsTransport } = await import('./resources/mcp-format.js');
  const { mcpTargetTakes } = await import('./mcp-reconcile.js');
  const excludedByUser = new Set(localConfig.excludedSkills ?? []);
  return teamDefs.filter((def) => mcpTargetTakes(target, def.tools)
    && !excludedByUser.has(def.name) && !supportsTransport(target.format, def.transport));
}

/**
 * A team server a tool cannot use over its transport, such as an sse server
 * for Muse Code or Pi. Its tool skips it on every pull, and no pull or
 * `teamai` command can change that, so it is a note, not a failed delivery.
 */
export async function mcpTransportNotes(ctx: DoctorContext): Promise<string[]> {
  const team = await teamMcpForDoctor(ctx);
  if (team.kind !== 'read') return [];
  const { mcpTargetAgent, installedMcpEntries, loadMcpManifest } = await import('./mcp-reconcile.js');
  const { entryHash } = await import('./resources/mcp-format.js');
  const notes: string[] = [];
  const install = installOf(team.teamConfig, ctx.localConfig);
  const host = realHost();
  for (const tool of Object.keys(team.teamConfig.toolPaths)) {
    const where = await locate(tool, 'mcp', install, host);
    if (!where.gates.every((gate) => gate.met)) continue;
    if (where.channel === 'unknown') {
      notes.push(`${tool}'s MCP channel is unknown; teamai does not write its servers.`);
      continue;
    }
    const own = writable(where);
    if (where.channel !== 'files' || own === null) continue;
    for (const unread of unreadWrites(where, host, doctorSession(install))) {
      if (unread.reason === 'cwd-only') notes.push(`${tool} reads project MCP servers only from a session started in ${unread.readFrom}.`);
    }
    if (tool === 'zcode' && install.scope === 'user') {
      const fallback = where.retired.find(({ was }) => was === 'default')?.place;
      if (fallback === undefined) continue;
      const installed = await installedMcpEntries({ tool, format: 'claude', file: fallback.path, key: fallback.key, projectScope: false });
      const { manifest } = await loadMcpManifest(ctx.localConfig, true);
      const records = manifest.zcode ?? [];
      const names = [...installed ?? []].filter(([name, entry]) => !records.some((record) => record.name === name && record.hash === entryHash(entry))).map(([name]) => name);
      if (names.length > 0) notes.push(`⚠ ZCode reads ~/.agents/mcp.json only while ~/.zcode/cli/config.json has no servers; move these servers there: ${names.sort().join(', ')}`);
    }
  }
  for (const target of team.targets) {
    const unsupported = await unsupportedTransportServers(ctx.localConfig, target, team.teamDefs);
    if (unsupported.length === 0) continue;
    const agent = mcpTargetAgent(target);
    notes.push(`MCP servers ${agent} cannot use: ${unsupported.map((def) => `${def.name} (${def.transport})`).join(', ')} `
      + `in ${target.file}, over a transport ${agent} does not support.`);
  }
  return notes;
}

export async function buildMcpDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig } = ctx;
  // A file that does not parse, or a server name defined twice, is not a team
  // without MCP: the pull logs the reason once and changes nothing in any tool,
  // and every later run is silent. Flattening it to an empty desired set is
  // what let `doctor --json` answer `ok: true` over a team whose MCP is stuck.
  const team = await teamMcpForDoctor(ctx);
  if (team.kind === 'none') return [];
  if (team.kind === 'unreadable') {
    return [{ name: 'Team MCP servers can be read', source: 'local', check: async () => false, fix: team.fix }];
  }
  const { teamConfig, teamDefs, targets } = team;

  const {
    resolveMcpTargets, buildDesiredMcpContext, desiredMcpForTarget,
    mcpTargetAgent, mcpTargetAgents, installedMcpEntries, memberMcpServers, describeKeptMemberServer,
  } = await import('./mcp-reconcile.js');
  const { carriesResolvedValue, ensureExcludedFromGit } = await import('./mcp-git-exclude.js');

  const desiredContext = await buildDesiredMcpContext(teamConfig, localConfig, { teamEnv: ctx.teamEnv });
  const excludedByUser = new Set(localConfig.excludedSkills ?? []);

  const checks: Check[] = [];
  for (const target of targets) {
    const { desired, skipped, kept } = desiredMcpForTarget(target, teamDefs, desiredContext);
    // A server skipped only for a missing declared secret (#875), or for a
    // transport its tool cannot use (`mcpTransportNotes`), is a note doctor
    // prints, not a failed delivery.
    const unsupported = new Set((await unsupportedTransportServers(localConfig, target, teamDefs)).map((def) => def.name));
    const blocked = skipped
      .filter((change) => !excludedByUser.has(change.server) && !kept.has(change.server) && !unsupported.has(change.server))
      .map((change) => `${change.server} (${change.reason ?? 'skipped'})`);

    const problems: string[] = [];
    // Its fix is the exclusion's own, not another pull (#882).
    let withheld: string | undefined;
    const installed = await installedMcpEntries(target, { underKeyOnly: true });
    if (installed === null) {
      problems.push(`${target.file} could not be parsed, so no server was injected`);
    } else {
      const absent: string[] = [];
      const foreign: string[] = [];
      for (const [name, { entry }] of desired) {
        if (!installed.has(name)) absent.push(name);
        // An entry that is not the one teamai renders is not this server: the
        // appliers leave an entry they do not own alone, so the name can be
        // held by something else entirely, and a stale copy is equally undelivered.
        else if (!isDeepStrictEqual(installed.get(name), entry)) foreign.push(name);
      }
      // Pull writes a resolved value only into a file git leaves out of a
      // commit (#882), and otherwise leaves the whole file as it was.
      const exclusion = carriesResolvedValue(target, teamDefs, [...absent, ...foreign])
        ? await ensureExcludedFromGit(target.file, { dryRun: true })
        : undefined;
      if (exclusion?.kind === 'failed') {
        withheld = `In ${target.file}, withheld: ${nameList([...absent, ...foreign])}, as git would commit the file: ${exclusion.reason}. ${exclusion.fix}`;
      } else {
        if (absent.length > 0) problems.push(`not injected: ${nameList(absent)}`);
        if (foreign.length > 0) problems.push(`not the team's definition: ${nameList(foreign)}`);
      }
    }
    if (blocked.length > 0) problems.push(`skipped: ${nameList(blocked)}`);

    // Muse Code rejects a config holding one sse server and then loads no MCP
    // server at all, so an sse entry in a file it reads breaks Muse's MCP as a
    // whole. In a project that is the .mcp.json the claude target writes.
    const museReads = mcpTargetAgents(target).includes(MUSE_TOOL_ID);
    if (museReads && installed) {
      const sse = [...installed]
        .filter(([, entry]) => typeof entry === 'object' && entry !== null && (entry as { type?: unknown }).type === 'sse')
        .map(([name]) => name);
      checks.push({
        name: 'MCP servers load in muse',
        source: 'local',
        check: async () => sse.length === 0,
        fix: `In ${target.file}, ${nameList(sse)} ${sse.length === 1 ? 'uses' : 'use'} the sse transport, which Muse Code rejects, `
          + 'so it loads no MCP server at all. If the server speaks streamable HTTP, set `transport: http` for it in the team\'s '
          + 'mcp.yaml and run `teamai pull`. Otherwise Muse Code has no MCP servers while this file holds it.',
      });
    }

    if (problems.length === 0 && !withheld && desired.size === 0) continue;

    // A pull keeps a server of the member's own under a team name, and names it (#993).
    // Judged with every tool mapping the file, detected or not, as pull judges it (#993).
    const member = problems.length === 0 ? [] : await memberMcpServers(
      localConfig, await resolveMcpTargets(teamConfig, localConfig, { includeUndetected: true }), target, desired, desiredContext.vars);
    const declare = declareSecretHint(undeclaredMissingVars(
      skipped,
      kept,
      declaredSecretKeys(ctx.teamEnv?.declarations ?? { kind: 'absent' }),
    ));
    const delivery = problems.length === 0 ? [] : [`In ${target.file}, ${problems.join('; ')}. A server needing a variable reads it from `
      + '`env/env.yaml` or an active `env/<ns>/env.yaml`, whose top-level key is `variables:` — a plain `KEY: value` mapping '
      + `parses as no variables at all. Then run \`teamai pull\`.${declare}`,
      ...member.map((name) => describeKeptMemberServer(name, target.file)),
      ...member.length > 0 ? ['Or run `teamai mcp inject --force` to replace it with the team\'s.'] : []];
    checks.push({
      name: `MCP servers delivered to ${mcpTargetAgent(target)}`,
      source: 'local',
      check: async () => problems.length === 0 && !withheld,
      fix: [...withheld ? [withheld] : [], ...delivery].join(' '),
    });
  }

  return checks;
}

/**
 * CodeBuddy and WorkBuddy read only the first of their user MCP files that exists (#993).
 * Once the member creates an earlier one (`codebuddy mcp add -s user`
 * creates ~/.codebuddy/.mcp.json), teamai's servers in a later one are not
 * loaded, until a pull moves them. Built only while a file teamai's records
 * name holds them. Read-only.
 */
export async function buildMcpReadFileChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  // An HTTP-backed team's servers arrive through the local agent, which a pull does not run.
  if (!teamConfig || localConfig.repo.kind === 'http') return [];
  const { resolveMcpTargets, shadowedMcpRecords, loadMcpManifest, mcpManifestKey, recordedMcpTarget, sameMcpPlace, installedMcpEntries } = await import('./mcp-reconcile.js');
  const home = getUserHome();
  const checks: Check[] = [];
  const install = installOf(teamConfig, localConfig);
  const { manifest } = await loadMcpManifest(localConfig, true);
  for (const target of await resolveMcpTargets(teamConfig, localConfig)) {
    if (isAgentExcluded(localConfig, target.tool)) continue;
    const where = await locate(target.tool, 'mcp', install);
    const unread = unreadWrites(where, realHost(), doctorSession(install)).filter((read) => read.reason === 'not-read' || read.reason === 'shadowed');
    if (where.channel === 'files' && where.reads !== 'unknown') checks.push({
      name: `${target.tool} reads the MCP servers teamai writes`, source: 'local',
      check: async () => unread.length === 0,
      fix: unread.map((read) => read.reason === 'shadowed' ? `${read.write} is shadowed by ${read.by}.` : `${target.tool} does not read ${read.write}.`).join(' ')
        + ` Point toolPaths.${target.tool}.${install.scope === 'user' ? 'mcp' : 'mcpProject'} in teamai.yaml at a file ${target.tool} reads.`,
    });
    const moved = new Set<string>();
    for (const record of manifest[mcpManifestKey(target)] ?? []) {
      const recorded = await recordedMcpTarget(target, record);
      if (!await sameMcpPlace(recorded, target) && (await installedMcpEntries(recorded))?.has(record.name)) moved.add(recorded.file);
    }
    if (moved.size > 0) checks.push({
      name: `${target.tool} MCP servers are where the last write put them`, source: 'local', check: async () => false,
      fix: `${target.tool} takes MCP servers from ${target.file} now, but the last write put them in ${[...moved].join(', ')}. Run `
        + '`teamai pull` to sync them there. Old copies outside teamai relocation paths stay for you to remove when no tool reads them.',
    });
    const shadowed = await shadowedMcpRecords(localConfig, target);
    if (shadowed.size === 0) continue;
    const lookup = (target.lookupFiles ?? []).map((file) => file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file);
    checks.push({
      name: `${target.tool} reads the file holding teamai's MCP servers`,
      source: 'local',
      check: async () => false,
      fix: [...shadowed].map(([file, names]) => `teamai's MCP servers for ${target.tool} (${nameList(names)}) are in ${file}, `
        + `which ${target.tool} does not read: it reads only ${target.file}, the first of ${lookup.join(', ')} that exists.`).join(' ')
        + ' Run `teamai pull` to move them there.',
    });
  }
  return checks;
}

/**
 * HTTP mode (#915): the project MCP servers the local agent recorded in a
 * project's `.mcp.json` while the git exclude flag gives Claude and CodeBuddy
 * theirs in the tool's local scope. Its next sync moves them there. Built
 * only while that file holds them. Read-only.
 */
export async function buildLocalAgentMcpLocationChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  const { projectRoot } = localConfig;
  if (!teamConfig || localConfig.repo.kind !== 'http' || localConfig.scope !== 'project' || !projectRoot) return [];
  const { projectMcpLocations, mcpRelocated, installedMcpEntries, describeMcpLocation } = await import('./mcp-reconcile.js');
  const { loadProjectMcpManifest } = await import('./utils/mcp-manifest.js');
  const { manifest } = await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true });
  const checks: Check[] = [];
  for (const tool of Object.keys(teamConfig.toolPaths)) {
    const records = manifest[managedMcpManifestKey(tool, true)] ?? [];
    if (records.length === 0) continue;
    const places = await projectMcpLocations(teamConfig, localConfig, tool);
    if (!places || !await mcpRelocated(teamConfig, localConfig, tool)) continue;
    const installed = await installedMcpEntries(places.tree);
    const names = records.map((record) => record.name).filter((name) => installed?.has(name)).sort();
    if (names.length === 0) continue;
    checks.push({
      name: `${tool} gets the local agent's MCP servers from its local scope`,
      source: 'local',
      check: async () => false,
      fix: `teamai's MCP servers for ${tool} from the local agent (${nameList(names)}) are still in ${places.tree.file}, while sharing.gitExclude `
        + `gives ${tool} them in ${describeMcpLocation(places.local)}. Start a new session: the local agent's sync moves them there. `
        + `A copy you changed stays in ${places.tree.file}, as yours.`,
    });
  }
  return checks;
}

/**
 * Codex loads a project's `.codex/config.toml` only in a trusted project, and
 * skips an untrusted one silently (#954), so team servers a pull or
 * `teamai mcp inject` wrote there are on disk and inert. Built while that file
 * holds a server this worktree's `managed-mcp.json` records for Codex.
 * Read-only: this check only reads Codex's config.
 */
export async function buildCodexProjectTrustCheck(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  const { projectRoot } = localConfig;
  if (!teamConfig || localConfig.scope !== 'project' || !projectRoot) return [];

  const { resolveMcpTargets, mcpTargetExcluded, installedMcpEntries } = await import('./mcp-reconcile.js');
  const { isCodexTrustGatedTool } = await import('./hooks.js');
  const target = (await resolveMcpTargets(teamConfig, localConfig))
    .find((candidate) => isCodexTrustGatedTool(candidate.tool) && !mcpTargetExcluded(localConfig, candidate));
  if (!target) return [];

  const { loadProjectMcpManifest } = await import('./utils/mcp-manifest.js');
  const { manifest } = await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true });
  const installed = await installedMcpEntries(target);
  const names = (manifest[managedMcpManifestKey(target.tool, true)] ?? [])
    .map((record) => record.name)
    .filter((name) => installed?.has(name));
  if (names.length === 0) return [];

  const where = await locate(target.tool, 'mcp', installOf(teamConfig, localConfig));
  const gate = where.channel === 'files' ? where.readGates.find((gate) => gate.kind === 'codex-project-trust') : undefined;
  if (gate === undefined) return [];
  const trust = await codexProjectTrust(gate);
  const cause = `${target.file} holds team MCP servers (${nameList(names)}), but Codex loads a project's `
    + '.codex/config.toml only in a trusted project';

  return [{
    name: 'Codex trusts this project, so it loads its team MCP servers',
    source: 'local',
    check: async () => trust.kind === 'trusted',
    fix: trust.kind === 'trusted' ? '' : codexTrustFix(trust, gate, cause),
  }];
}

/**
 * A project MCP config holding a resolved `${VAR}` that git would commit
 * (#882). Pull lists such a file in `.git/info/exclude`; this is the standing
 * check for a file that is tracked already, or a repo whose exclude could not
 * be written. For an HTTP-backed team, whose local agent writes the servers,
 * a config holding a credential its install recorded. Read-only:
 * `git check-ignore` changes nothing.
 */
export async function buildMcpGitExcludeCheck(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  const { projectRoot } = localConfig;
  if (!teamConfig || localConfig.scope !== 'project' || !projectRoot) return [];

  const {
    resolveMcpTargets, resolvedValueEvidence, buildVarTable, buildDesiredMcpContext, recordedMcpTargets, recordedMcpFileEvidence, localAgentCredentialFiles,
    earlierMappedMcpTargets, earlierMappedMcpFileEvidence, ownedByMappers, unrecordedMcpTool, unmappedMcpDefaults, unrecordedUnmappedMcpDefaults, unclaimedMcpServers,
  } = await import('./mcp-reconcile.js');
  const { readResolvedMcpFiles } = await import('./mcp-resolved-files.js');
  const { gitPathOf, gitTracking, gitTracks } = await import('./git-exclude.js');
  const { sameServerKey } = await import('./resources/mcp-format.js');
  const { mcpEntryReader, teamMcpToDef } = await import('./resources/mcp.js');
  const { resolveEntriesFor } = await import('./namespaced-entries.js');
  const { loadProjectMcpManifest } = await import('./utils/mcp-manifest.js');

  // Unreadable team servers still leave teamai's entries on disk: judged by the manifest, as pull does.
  const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
  const teamDefs = resolution.kind === 'failed' ? null : resolution.entries.map((entry) => teamMcpToDef(entry.entry));
  let manifest: ManagedMcpManifest | undefined;
  let vars: Record<string, string> | undefined;
  let ledger: Record<string, ResolvedMcpFile> | undefined;
  let desiredContext: Promise<DesiredMcpContext> | undefined;
  const desired = (): Promise<DesiredMcpContext> => desiredContext ??= buildDesiredMcpContext(teamConfig, localConfig);

  const holding = new Set<string>();
  const tracked: string[] = [];
  const hold = async (file: string): Promise<void> => {
    holding.add(file);
    const tracking = await gitTracking(file);
    if (tracking.kind === 'would-commit') tracked.push((await gitPathOf(file)).label);
    else if (tracking.kind === 'unknown') tracked.push(`${(await gitPathOf(file)).label} (git failed: ${tracking.error})`);
  };
  // Every tool's file, delivery on or off, the same files and evidence pull protects. Two tools may share one.
  const mapped = await resolveMcpTargets(teamConfig, localConfig, { includeUndetected: true });
  // A built-in location no mapping reaches today (its tool moved or dropped): its tool's records describe another file.
  const unmapped = await unmappedMcpDefaults(mapped);
  const targets = mapped.filter((target) => !unmapped.has(target));
  const report = (held: string, next: string): Check[] => holding.size === 0 ? [] : [{
    name: 'Project MCP configs with resolved values are kept out of git',
    source: 'local',
    check: async () => tracked.length === 0,
    fix: `${tracked.join(', ')} may hold ${held}, and git would commit them or cannot say. ${next}`,
  }];
  if (localConfig.repo.kind === 'http') {
    // No mcp.yaml to judge by: the files that may hold a credential the local agent wrote.
    for (const { file } of await localAgentCredentialFiles(localConfig, targets)) {
      if (!holding.has(file)) await hold(file);
    }
    return report('MCP credentials in plaintext', 'Fix any git error shown, then add each to .git/info/exclude. If git already tracks one, run '
      + '`git rm --cached <file>` and rotate the values it held.');
  }
  for (const target of targets) {
    if (holding.has(target.file) || !await pathExists(target.file)) continue;
    manifest ??= (await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true })).manifest;
    vars ??= await buildVarTable(localConfig);
    ledger ??= (await readResolvedMcpFiles(localConfig)).files;
    const owned = manifest[managedMcpManifestKey(target.tool, true)] ?? [];
    // No managed-mcp.json at all, no record for this installed tool the team maps, or a record a pull wrote
    // without one whose note hasn't landed: any server no record claims may be teamai's, as pull judges it.
    const claimed = targets.filter((t) => t.file === target.file && sameServerKey(t.format, target.format))
      .flatMap((t) => manifest?.[managedMcpManifestKey(t.tool, true)] ?? []).map((record) => record.name);
    const unrecorded = unrecordedMcpTool(target, targets, ledger[target.file]?.tools) && manifest[managedMcpManifestKey(target.tool, true)] === undefined;
    if (((Object.keys(manifest).length === 0 || unrecorded || owned.some((record) => record.unnoted))
      && (await unclaimedMcpServers(target, claimed)).length > 0)
      || await resolvedValueEvidence(target, teamDefs, { owned, unverified: ledger[target.file]?.unverified }, vars, desired)) await hold(target.file);
  }
  // And a file a pull wrote under a mapping the team has since changed, but one recorded as tracked while git
  // tracks it: no line protects it. In a file another tool now maps, that tool's records tell its own servers.
  for (const [file, { targets: group, mappedBy, tracked }] of await recordedMcpTargets(localConfig, targets)) {
    if (holding.has(file) || (tracked && (await gitTracks(file)).kind === 'tracked')) continue;
    manifest ??= (await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true })).manifest;
    if (await recordedMcpFileEvidence(group, ownedByMappers(mappedBy, manifest))) await hold(file);
  }
  // And, until a pull on this version reads them, those an older teamai wrote under a mapping an earlier
  // teamai.yaml made. Read-only: the record of that read is pull's. Unreadable history skips them.
  // A built-in location no mapping reaches today, which no record covers, is judged as one of them.
  const earlier = (await readResolvedMcpFiles(localConfig)).earlierMappingsRead ? []
    : await earlierMappedMcpTargets(localConfig, mapped).catch(() => null) ?? [];
  for (const { tracked, mappedBy, ...target } of [...earlier, ...await unrecordedUnmappedMcpDefaults(localConfig, unmapped, targets)]) {
    if (tracked || holding.has(target.file)) continue;
    vars ??= await buildVarTable(localConfig);
    manifest ??= (await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true })).manifest;
    if (await earlierMappedMcpFileEvidence(target, teamDefs, vars, desired, ownedByMappers(mappedBy, manifest))) await hold(target.file);
  }
  return report('MCP variables resolved to plaintext', 'Fix any git error shown, then run `teamai pull` to list them in .git/info/exclude. If git already tracks one, run '
    + '`git rm --cached <file>` and rotate the values it held.');
}

/**
 * Env, hook and MCP entries carrying a key to fix: the per-entry `roles:` /
 * `projects:` keys that namespace files replace (#707), or a key the entry's
 * schema does not know (#822). An entry with an unknown key or `projects:` (and
 * `roles:` on env) is not delivered; `roles:` on hooks and MCP still filters
 * for one minor release. Pull warns once per run, and this is the standing
 * version of that warning. Informational: each entry resolves as its warning says.
 */
export async function buildEntryScopeKeyCheck(ctx: DoctorContext): Promise<Check[]> {
  const messages = (await resolveEntryTypes(ctx.localConfig))
    .flatMap(({ resolution }) => resolution.notices)
    .filter((notice) => notice.kind !== 'file-note')
    .map((notice) => notice.message);
  if (messages.length === 0) return [];
  return [{
    name: 'Team env, hooks and MCP entries have no per-entry key to fix',
    source: 'local',
    informational: true,
    check: async () => false,
    fix: messages.join(' '),
  }];
}

/**
 * A failing check for hooks, model profiles and team secrets that do not
 * resolve: pull keeps what is installed and says why once, then every later
 * run is silent, and `teamai status` sends the member here. Env and MCP report
 * the same failure in their own delivery checks.
 */
export async function buildEntryResolutionChecks(ctx: DoctorContext): Promise<Check[]> {
  const { describeEntryFailure } = await import('./namespaced-entries.js');
  const checks: Check[] = [];
  for (const { checkName: name, resolution } of await resolveEntryTypes(ctx.localConfig)) {
    if (name === null || resolution.kind !== 'failed') continue;
    checks.push({ name, source: 'local', check: async () => false, fix: describeEntryFailure(resolution.failure) });
  }
  return checks;
}

/**
 * The member's values for this team and machine can be read (#875). While one
 * can't, every secret has no value and MCP keeps what the last pull wrote,
 * which the MCP check can't see. Only for a scope whose secrets or variables
 * read those files.
 */
export function buildSecretValuesCheck(ctx: DoctorContext): Check[] {
  const { teamEnv } = ctx;
  if (!teamEnv) return [];
  const reads = (teamEnv.declarations.kind === 'resolved' && teamEnv.declarations.entries.length > 0)
    || (teamEnv.variables.kind === 'resolved' && teamEnv.variables.entries.length > 0);
  if (!reads) return [];
  const unreadable = [teamEnv.secrets, teamEnv.variableValues].find((values) => values.kind === 'store-unreadable');
  return [{
    name: 'Your team secret values can be read',
    source: 'local',
    check: async () => unreadable === undefined,
    fix: unreadable?.kind === 'store-unreadable' ? unreadable.reason : undefined,
  }];
}

/**
 * Info lines for `doctor`: which namespace entry replaces which root entry,
 * and in legacy mode each name the root file repeats. They answer "why do I
 * have this value?" and are not problems, so they are notes, not checks.
 */
export async function entryNamespaceNotes(ctx: DoctorContext): Promise<string[]> {
  const { describeEntryNotes } = await import('./namespaced-entries.js');
  return (await resolveEntryTypes(ctx.localConfig)).flatMap(({ layout, resolution }) => describeEntryNotes(layout, resolution));
}

/**
 * Every namespaced entry file set, each with the layout its messages use and
 * the doctor check that fails when it does not resolve (null for env and MCP,
 * whose delivery checks report it).
 */
async function resolveEntryTypes(
  localConfig: LocalConfig,
): Promise<{ layout: EntryLayout; resolution: EntryResolution<unknown>; checkName: string | null }[]> {
  if (localConfig.repo.kind === 'http') return [];
  const { entryLayout, resolveEntriesFor } = await import('./namespaced-entries.js');
  const { envEntryReader } = await import('./resources/env.js');
  const { SECRETS_LAYOUT, secretsEntryReader } = await import('./resources/secrets.js');
  const { hooksEntryReader } = await import('./resources/hooks.js');
  const { mcpEntryReader } = await import('./resources/mcp.js');
  const { modelsEntryReader } = await import('./models/profile.js');
  return [
    { layout: entryLayout('env'), resolution: await resolveEntriesFor(envEntryReader, localConfig), checkName: null },
    {
      layout: SECRETS_LAYOUT,
      resolution: await resolveEntriesFor(secretsEntryReader, localConfig),
      checkName: 'Team secrets can be resolved',
    },
    {
      layout: entryLayout('hooks'),
      resolution: await resolveEntriesFor(hooksEntryReader, localConfig),
      checkName: 'Team hooks can be resolved',
    },
    { layout: entryLayout('mcp'), resolution: await resolveEntriesFor(mcpEntryReader, localConfig), checkName: null },
    {
      layout: entryLayout('models'),
      resolution: await resolveEntriesFor(modelsEntryReader, localConfig),
      checkName: 'Team model profiles can be resolved',
    },
  ];
}

/**
 * Check that the env variables the team declares actually reach a shell.
 *
 * The plumbing version of this check asked only whether the marker comment was
 * in the profile, which is true of a block that cannot load and of a run that
 * delivered nothing. Both failures surface three layers away, as MCP servers
 * skipped for `unresolved variable(s)`, with nothing pointing back here.
 */
export async function buildEnvDeliveryCheck(ctx: DoctorContext): Promise<Check[]> {
  const { problems, staleProfiles, isLoaderOwed } = await envDeliveryProblems(ctx);
  const { localConfig } = ctx;
  const { directoryEnv } = await import('./resources/env-loader.js');
  const dir = localConfig.scope === 'project' && localConfig.projectRoot ? localConfig.projectRoot : process.cwd();
  const directory = isLoaderOwed ? await directoryEnv(localConfig, dir) : null;
  return [
    {
      name: 'Env variables injected in shell profile',
      source: 'local',
      check: async () => problems.length === 0,
      fix: problems.length === 0
        ? 'Run `teamai pull` to inject env variables into shell profile'
        : `${problems.join('; ')}. Run \`teamai pull\` after fixing the cause, then open a new shell.`,
    },
    // Several projects open at once each load their own env (#1018): this
    // asks the loader, in a real shell started here, which env.sh it loads.
    // A shell that runs no loader passes here; envLoaderNotes names the gap.
    {
      name: 'This directory resolves its team env',
      source: 'local',
      check: async () => directoryEnvFix(directory, dir) === undefined,
      fix: directoryEnvFix(directory, dir),
    },
    // A separate check, not folded into the one above: a stray leftover
    // block for this same scope (e.g. from before #682 changed which file
    // `pull` prefers) is dead weight, not a delivery failure — the variables
    // are reaching a shell just fine through the resolved profile. Reporting
    // it as the SAME failure as "your env vars aren't reaching a shell"
    // would tell a user whose delivery genuinely works that it is broken
    // (#693 review round 5).
    {
      name: 'No stale env blocks left behind',
      source: 'local',
      informational: true,
      check: async () => staleProfiles.length === 0,
      fix: staleProfiles.length === 0
        ? undefined
        : `${nameList(staleProfiles)} still carries a teamai env block for this scope from an `
          + 'earlier install; run `teamai uninstall` to remove it, or delete the block manually.',
    },
  ];
}

/** What to do about what a shell started in `dir` loads, or undefined when there is nothing to do. */
function directoryEnvFix(directory: DirectoryEnv | null, dir: string): string | undefined {
  if (directory === null) return undefined;
  switch (directory.kind) {
    case 'loads-scope':
    case 'shell-without-loader':
      return undefined;
    case 'loads-other':
      return `A shell started in ${dir} loads ${directory.loaded.length > 0 ? nameList([...directory.loaded]) : 'no team env'} `
        + `instead of ${nameList([...directory.expected])}. Run \`teamai pull\` here, then open a new shell.`;
    case 'shell-failed':
      return `Could not run ${directory.shell} in ${dir} to check which team env it loads: ${directory.reason}. `
        + 'Check that SHELL names a shell that starts.';
    default: {
      const unhandled: never = directory;
      return unhandled;
    }
  }
}

/**
 * Info for a member whose shell runs no env loader (#1018): the team env does
 * not reach it, and `env exec` does. Not a check, since nothing here is
 * broken and no pull changes it.
 */
export async function envLoaderNotes(ctx: DoctorContext): Promise<string[]> {
  const { localConfig, teamConfig } = ctx;
  if (teamConfig?.sharing?.env?.injectShellProfile === false) return [];
  const { loaderShell, scopeEnvFiles } = await import('./resources/env-loader.js');
  const shell = process.env.SHELL ?? '';
  if (loaderShell(shell)) return [];
  // Only name the gap when a loader would apply a value. An empty project
  // env.sh can exist solely as the readability gate for inherited user env.
  const { parseEnvFile } = await import('./resources/env.js');
  const files = await scopeEnvFiles(localConfig);
  const loadsValues = await Promise.all(files.map(async (file) => {
    const content = await readFileSafe(file);
    return content !== null && parseEnvFile(content).size > 0;
  }));
  if (!loadsValues.some(Boolean)) return [];
  return [`Team env does not load in ${path.basename(shell) || 'a shell without SHELL'}: only zsh and bash run the teamai env loader. `
    + 'Run the commands that need it through `teamai env exec -- <command>`.'];
}

/** Every reason the team's env variables are not reaching a shell, and any stray leftover blocks found along the way. */
async function envDeliveryProblems(
  ctx: DoctorContext,
): Promise<{ problems: string[]; staleProfiles: string[]; isLoaderOwed?: true }> {
  const { localConfig, teamConfig } = ctx;
  const none = { problems: [], staleProfiles: [] };
  if (teamConfig?.sharing?.env?.injectShellProfile === false) return none;

  // The variables this member and directory receive: the same resolution pull
  // writes env.sh from, not a second copy of it. A file that cannot be used, or
  // a name defined twice, is reported here as pull reports it (#662), and a
  // deliberate `variables: []` is not.
  const { describeEntryFailure } = await import('./namespaced-entries.js');
  const { envShVariables, keptFromUserScope, resolveTeamEnv } = await import('./env-resolution.js');
  const teamEnv = ctx.teamEnv ?? await resolveTeamEnv(localConfig);
  const { variables: resolution, declarations: secrets, variableValues: values } = teamEnv;
  const { parseEnvFile, parseEnvFileKept } = await import('./resources/env.js');
  const { sameEnvName } = await import('./resources/env-key.js');
  /** The keys of `owed` that `delivered` lacks, and those it holds another value for, in any case on Windows. */
  const compare = (owed: readonly EnvVariable[], delivered: ReadonlyMap<string, string>): { undelivered: string[]; stale: string[] } => {
    const valueOf = (key: string): string | undefined => {
      const name = sameEnvName(delivered.keys(), key);
      return name === undefined ? undefined : delivered.get(name);
    };
    return {
      undelivered: owed.filter(({ key }) => valueOf(key) === undefined).map(({ key }) => key),
      stale: owed.filter(({ key, value }) => valueOf(key) !== undefined && valueOf(key) !== value).map(({ key }) => key),
    };
  };

  // An inheriting project's shells load the user scope's env.sh first, which
  // the user scope's own pull writes: its variables are owed here too, whatever
  // state the project's own declarations are in.
  const { userEnvInShells } = await import('./resources/env-loader.js');
  // While the user scope's env can't be resolved, its pull keeps its env.sh as
  // it is: nothing to compare, but shells still load it, so it must be there.
  const inheritsUser = localConfig.scope === 'project' && await userEnvInShells();
  const inherited = inheritsUser && teamEnv.inheritedValues.kind === 'resolved' && teamEnv.inheritedVariables.length > 0
    ? envShVariables(teamEnv.inheritedVariables, teamEnv.inheritedValues.values)
    : [];
  const keptInherited = inheritsUser && (teamEnv.keptInheritedValues?.size ?? 0) > 0;
  const inheritedProblems: string[] = [];
  const userEnvShPath = path.join(getTeamaiHome('user'), 'env.sh');
  if (keptInherited && !await pathExists(userEnvShPath)) {
    const reason = teamEnv.inheritedValues.kind === 'store-unreadable' ? `${teamEnv.inheritedValues.reason}; fix that, then ` : '';
    inheritedProblems.push(`${userEnvShPath}, which this project inherits, is missing: ${reason}run \`teamai pull\` outside any project to rewrite it`);
  } else if (inheritsUser && teamEnv.inheritedValues.kind === 'store-unreadable') {
    // Shells keep loading the user scope's last env.sh, and env exec and MCP warn with this same reason.
    inheritedProblems.push(teamEnv.inheritedValues.reason);
  }
  const pullUser = 'run `teamai pull` outside any project to rewrite it';
  if (inherited.length > 0) {
    const userEnvSh = await readFileSafe(userEnvShPath);
    const { undelivered, stale } = compare(inherited, parseEnvFile(userEnvSh ?? ''));
    if (userEnvSh === null) inheritedProblems.push(`${userEnvShPath}, which this project inherits, is missing: ${pullUser}`);
    else if (undelivered.length > 0) inheritedProblems.push(`${userEnvShPath} is missing ${nameList(undelivered)}, which this project inherits: ${pullUser}`);
    if (stale.length > 0) inheritedProblems.push(`${userEnvShPath} has a stale value for ${nameList(stale)}, which this project inherits: ${pullUser}`);
  }

  // A key the team also declares as a secret is not delivered (#875); declarations
  // that cannot be read keep env.sh as it is, as a broken env file does. A
  // variable the member set for this team is owed their value, and one set
  // with `--from-env` is not owed at all (#875); a values file that cannot be
  // read keeps env.sh as it is, as pull does. Either way shells still load the
  // kept env.sh and the inherited one through the profile block, checked below.
  const projectFailure = resolution.kind === 'failed' ? describeEntryFailure(resolution.failure)
    : secrets.kind === 'failed' ? describeEntryFailure(secrets.failure)
      : values.kind === 'store-unreadable' ? values.reason : null;
  let declared: EnvVariable[] = [];
  let kept: string[] = [];
  // What the last pull wrote while this scope can't be resolved: pull keeps it, and shells load it.
  const keptOwn = (teamEnv.keptValues?.size ?? 0) > 0;
  if (resolution.kind === 'resolved' && secrets.kind !== 'failed' && values.kind !== 'store-unreadable') {
    declared = envShVariables(resolution.entries, values.values);
    kept = keptFromUserScope(localConfig, teamEnv, declared);
  }
  // The user scope's env.sh holds only what its pull wrote: a key there that it
  // no longer delivers, and this project does not set, still reaches this
  // project's shells, where `env exec` and MCP leave it out.
  if (inheritsUser && localConfig.inheritUserScope === true && teamEnv.inheritedValues.kind === 'resolved' && resolution.kind === 'resolved' && projectFailure === null) {
    const { declaredSecretKeys } = await import('./resources/secrets.js');
    const owed = [...inherited.map(({ key }) => key), ...resolution.entries.map(({ name }) => name), ...declaredSecretKeys(secrets) ?? []];
    const extra = [...parseEnvFile(await readFileSafe(userEnvShPath) ?? '').keys()].filter((key) => sameEnvName(owed, key) === undefined);
    if (extra.length > 0) inheritedProblems.push(`${userEnvShPath} still exports ${nameList(extra)}, which the user scope no longer delivers and this project inherits: ${pullUser}`);
  }
  const problems: string[] = [...projectFailure === null ? [] : [projectFailure], ...inheritedProblems];

  // env.sh lives under teamaiHome, which is <projectRoot>/.teamai in project
  // scope and ~/.teamai in user scope — mirror the path that `teamai pull`
  // actually writes to, not a hardcoded user-home path.
  const envShPath = path.join(getDataHome(localConfig), 'env.sh');
  const envSh = await readFileSafe(envShPath);
  if (envSh === null) {
    // Nothing reaches this member and nothing was ever written: there is
    // nothing to deliver, so there is nothing to report missing.
    if (declared.length === 0 && kept.length === 0 && inherited.length === 0 && !keptOwn && !keptInherited) return problems.length === 0 ? none : { problems, staleProfiles: [] };
    if (declared.length > 0 || kept.length > 0 || keptOwn) problems.push(`${envShPath} is missing`);
  } else if (projectFailure === null) {
    // Read the file back through the generator's own inverse, value included:
    // a key whose value changed in env.yaml exports the old one until the next
    // pull rewrites the file, and every shell and MCP server reads that. It is
    // a parse rather than a line scan because a value may be multiline — a
    // YAML block scalar quotes into an export spanning several lines.
    const delivered = parseEnvFile(envSh);
    const { undelivered, stale } = compare(declared, delivered);
    if (undelivered.length > 0) problems.push(`${envShPath} is missing ${nameList(undelivered)}`);
    if (stale.length > 0) {
      problems.push(
        `${envShPath} has a stale value for ${nameList(stale)}: env.yaml or your value for this team is a different one`,
      );
    }
    // env.sh holds only what pull wrote, so a key the resolved set lacks is
    // left over from before a namespace deactivated or the team removed it,
    // and still live in every new shell until the next pull.
    const deliverable = declared.map((variable) => variable.key);
    const leftover = [...delivered.keys()].filter((key) => sameEnvName(deliverable, key) === undefined);
    if (leftover.length > 0) {
      problems.push(
        `${envShPath} still exports ${nameList(leftover)}, which the team no longer delivers to this `
        + 'directory (removed, or its namespace is no longer active)',
      );
    }
    // A key the project declares but does not export keeps the member's own
    // value, not the one the user scope's env.sh set before it.
    const keptInFile = parseEnvFileKept(envSh);
    const unkept = kept.filter((key) => sameEnvName(keptInFile, key) === undefined);
    if (unkept.length > 0) problems.push(`${envShPath} does not keep ${nameList(unkept)} from the user scope's env.sh`);
    // Nothing is owed, so the profile block has nothing to load: a leftover is
    // the only thing that can be wrong here.
    if (declared.length === 0 && kept.length === 0 && inherited.length === 0 && !keptInherited) return { problems, staleProfiles: [] };
  }

  // Same resolution the injection runs, not a second copy of it. Expanded
  // up front (not left to readFileSafe's internal expansion) because the
  // stray-block scan below compares this string for identity against
  // candidates that are always absolute — an unexpanded `~/...` override
  // would never match its own resolved file and get reported as a stray
  // copy of itself (#693 review round 4).
  const { envLoaderPath } = await import('./resources/env-loader.js');
  const { envLoaderProfiles } = await import('./utils/shell-profile.js');
  const loaderPath = envLoaderPath();
  // For zsh, a file every zsh reads, whatever shellProfilePath names (#1018).
  // The other shell's profile and bash's login file too, when they exist, as pull writes them.
  const override = teamConfig?.sharing?.env?.shellProfilePath;
  const { paths: profilePaths } = await envLoaderProfiles(override, loaderPath);
  // One block for every scope: it sources the loader, which picks the env.sh
  // for the shell's directory (#1018).
  for (const profilePath of profilePaths) {
    const profile = await readFileSafe(profilePath);
    const block = profile === null ? null : findEnvBlockFor(profile, loaderPath);
    if (block === null) {
      problems.push(`${profilePath} carries no TeamAI env block for ${loaderPath}`);
    } else if (!envBlockSourcesPath(block.text, loaderPath)) {
      problems.push(
        `the block in ${profilePath} does not load ${loaderPath}: a POSIX shell reads an unquoted `
        + 'backslash as an escape, so the `[ -f ... ]` test fails and `source` never runs',
      );
    }
  }

  // A stray block can also sit in a different candidate file: which file
  // `pull` prefers has changed at least once (#682), and `pull` only ever
  // adds a block, never migrates an old one away. Checking `profilePath`
  // alone would stay green forever while a dead block for this same scope
  // sits in, say, `.bashrc` from a pre-#682/#661 install (#693 review).
  const home = getUserHome();
  const staleProfiles: string[] = [];
  for (const candidate of new Set([...override ? [expandHome(override)] : [], ...SHELL_PROFILE_CANDIDATE_NAMES.map((name) => path.join(home, name))])) {
    if (profilePaths.some((profilePath) => sameFile(candidate, profilePath))) continue;
    const content = await readFileSafe(candidate);
    if (content && findEnvBlockFor(content, envShPath)) staleProfiles.push(candidate);
  }

  return { problems, staleProfiles, isLoaderOwed: true };
}

/**
 * The docs bundle has one destination rather than one per tool: `DocsHandler`
 * mirrors the team's visible `docs/` tree into `sharing.docs.localDir`. So this
 * check compares the delivered set with that directory, file by file, rather
 * than asking each tool.
 */
export async function buildDocsCheck(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const {
    describeLinkedDocsRoot, isLinkedDocsRoot, isPrunedDoc, listDocFiles, listStaleDocDirectories, membersDocs, resolveDocsForDirectory, resolveDocsDestination,
  } = await import('./resources/docs.js');
  // The set pull delivers: no dotfiles, nothing of a docs namespace this member
  // does not have active (#707). Manifests that cannot be read leave nothing to
  // compare against, and pull stops the scope over them.
  let desired: Awaited<ReturnType<typeof resolveDocsForDirectory>>;
  try {
    desired = await resolveDocsForDirectory(localConfig);
  } catch (e) {
    return unresolvableCheck('docs', e instanceof Error ? e.message : String(e));
  }

  const dest = resolveDocsDestination(teamConfig, localConfig);
  // Pull delivers nothing through a linked root, and no pull can change that (#993).
  if (await isLinkedDocsRoot(dest)) {
    return [{ name: 'Team docs delivered', source: 'local', check: async () => false, fix: describeLinkedDocsRoot(dest, 'pull') }];
  }
  let localFiles: string[];
  let staleDirectories: string[];
  try {
    localFiles = await listDocFiles(dest);
    staleDirectories = await listStaleDocDirectories(desired.sourceDir, dest);
  } catch (e) {
    return [{
      name: 'Team docs delivered', source: 'local', check: async () => false,
      fix: `Could not inspect the docs mirror: ${e instanceof Error ? e.message : String(e)}. Check directory access, then run \`teamai pull --force\`.`,
    }];
  }
  const teamFiles = desired.files;
  if (teamFiles.length === 0 && localFiles.length === 0 && staleDirectories.length === 0) return [];
  // A team doc of a namespace not active here is not stale: pull removes the
  // unchanged copy and names the edited one it keeps.
  const known = new Set([
    ...teamFiles,
    ...desired.withheld.flatMap(({ dir, files }) => files.map((file) => `${dir}/${file}`)),
  ]);
  // A file pull keeps because it is no team version of a removed doc is the member's, not stale (#993).
  const staleFiles: string[] = [];
  for (const file of localFiles.filter((local) => !known.has(local))) {
    if (await isPrunedDoc(path.join(dest, file), file, localConfig.repo.localPath)) staleFiles.push(file);
  }
  const stale = [...staleFiles, ...staleDirectories];
  // Only the member's own files there, and no team doc: nothing for this check to say (#993).
  if (teamFiles.length === 0 && stale.length === 0) return [];

  // isFile, not merely "something is there": a directory sitting on the
  // expected name, or a symlink with nothing behind it, would satisfy a plain
  // existence check while the doc is no more readable than a missing one.
  const missing: string[] = [];
  for (const file of teamFiles) {
    if (!await isReadableFile(path.join(dest, file))) missing.push(file);
  }
  // Files at a team doc's path that hold no team version of it: pull keeps them (#993).
  const members = await membersDocs(desired, dest, localConfig.repo.localPath);
  const { describeKeptEntry } = await import('./resources/delivered-copies.js');
  const memberLines = await Promise.all(members.map((file) => describeKeptEntry(path.join(dest, file), `docs/${file}`)));

  return [{
    name: 'Team docs delivered',
    source: 'local',
    check: async () => missing.length === 0 && stale.length === 0 && members.length === 0,
    fix: [
      ...(missing.length ? [`Missing from ${dest}: ${nameList(missing)}.`] : []),
      ...(stale.length ? [`Stale docs in ${dest}: ${nameList(stale)}.`] : []),
      ...(missing.length || stale.length
        ? ['Run `teamai pull --force` to restore the docs mirror; a plain pull skips an already-synced revision.']
        : []),
      ...memberLines,
    ].join(' '),
  }];
}

/**
 * Pull's line for each file it keeps where the team removed a doc, because it
 * is no version of that doc, and for each directory of the member's in such a
 * doc's place (#993): information, never a failure, since no
 * pull removes it, and git sees it (#915). Nothing when the docs cannot be
 * read: the docs check says so.
 */
export async function keptDocNotes(ctx: DoctorContext): Promise<string[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];
  const {
    describeKeptRemovedDoc, describeMembersDocDirectory, isPrunableDoc, listDocFiles, resolveDocsForDirectory, resolveDocsDestination,
  } = await import('./resources/docs.js');
  try {
    const desired = await resolveDocsForDirectory(localConfig);
    const dest = resolveDocsDestination(teamConfig, localConfig);
    const known = [...desired.files, ...desired.withheld.flatMap(({ dir, files }) => files.map((file) => `${dir}/${file}`))];
    const teamHas = (rel: string): boolean => known.some((file) => file === rel || file.startsWith(`${rel}/`));
    const notes: string[] = [];
    // A directory of the member's where the team removed a doc file: pull keeps it whole, and doctor names it once.
    const keptDirs = new Set<string>();
    const underKeptDir = async (file: string): Promise<boolean> => {
      const parts = file.split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        const rel = parts.slice(0, depth).join('/');
        if (keptDirs.has(rel)) return true;
        if (teamHas(rel)) continue;
        const line = await describeMembersDocDirectory(path.join(dest, rel), rel, localConfig.repo.localPath);
        if (line === null) continue;
        notes.push(line);
        keptDirs.add(rel);
        return true;
      }
      return false;
    };
    for (const file of (await listDocFiles(dest)).filter((local) => !known.includes(local))) {
      if (await underKeptDir(file)) continue;
      const target = path.join(dest, file);
      if (await isPrunableDoc(target, file, localConfig.repo.localPath)) continue;
      const link = (await fs.promises.lstat(target).catch(() => null))?.isSymbolicLink() ?? false;
      const line = await describeKeptRemovedDoc(target, file, localConfig.repo.localPath, link);
      if (line !== null) notes.push(line);
    }
    return notes;
  } catch {
    return [];
  }
}

/**
 * Information lines, not checks, that answer "why do I have this version?"
 * (#707). With roles or projects: each namespace skill, agent, rule or
 * claudemd file that replaces a root item of the same name. In legacy mode,
 * where nothing replaces anything: each name the team repo defines more than
 * once, and what the member receives because of it.
 *
 * A team repo whose desired sets cannot be resolved yields no lines: the
 * delivery checks already report that as a failure.
 */
export async function buildNamespaceNotes(ctx: DoctorContext): Promise<string[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { describeOverride, repeatedNames } = await import('./namespace-resolver.js');
  let team: Awaited<ReturnType<typeof readNamespaceNoteInputs>>;
  try {
    team = await readNamespaceNoteInputs(teamConfig, localConfig);
  } catch {
    return [];
  }

  if (team.mode === 'legacy') {
    const firstLevelRules = team.rules.filter((rule) => rule.name.split('/').length <= 2);
    // claudemd file names at the root and one level down, as the block collects them.
    // listFilesRecursive joins with '/' on every platform.
    const claudemdFiles = team.claudemdFiles
      .map((file) => file.split('/'))
      .filter((segments) => segments.length <= 2 && (segments[segments.length - 1] ?? '').endsWith('.md'));
    return [
      ...repeatedNames(team.skills, (item) => item.name, (item) => item.relativePath).map(([name, sources]) => (
        `skills: "${name}" is defined in ${listed(sources)} (legacy mode: only one of them is installed)`)),
      ...repeatedNames(firstLevelRules, (item) => path.posix.basename(item.name), (item) => item.relativePath)
        .map(([name, sources]) => (
          `rules: "${name}" is defined in ${listed(sources)} (legacy mode: each is delivered at its own path)`)),
      ...repeatedNames(claudemdFiles, (segments) => segments[segments.length - 1] ?? '', (segments) => `claudemd/${segments.join('/')}`)
        .map(([name, sources]) => (
          `claudemd: "${name}" is defined in ${listed(sources)} (legacy mode: all of them are in the managed block)`)),
    ];
  }

  return [
    ...(team.skills.kind === 'resolved' ? team.skills.overrides : []).map((override) => describeOverride('skills', override)),
    ...(team.agents.kind === 'resolved' ? team.agents.overrides : []).map((override) => describeOverride('agents', override)),
    ...team.rules.overrides.map((override) => describeOverride('rules', override)),
    ...team.claudemd.overrides.map((override) => describeOverride('claudemd', override)),
  ];
}

/** What `buildNamespaceNotes` reads from the team repo; throws when a manifest cannot be read. */
async function readNamespaceNoteInputs(teamConfig: TeamaiConfig, localConfig: LocalConfig) {
  const desired = await import('./resources/desired.js');
  const { getHandler } = await import('./resources/index.js');
  const roleContext = await desired.buildRolePullContext(localConfig);
  if (!roleContext) {
    return {
      mode: 'legacy' as const,
      skills: await getHandler('skills').scanTeamForPull(teamConfig, localConfig),
      rules: await getHandler('rules').scanTeamForPull(teamConfig, localConfig),
      claudemdFiles: await listFilesRecursive(path.join(localConfig.repo.localPath, 'claudemd')),
    };
  }
  return {
    mode: 'namespaced' as const,
    skills: await desired.resolveDesiredSkills(teamConfig, localConfig, roleContext),
    agents: await desired.resolveDesiredAgents(teamConfig, localConfig, roleContext),
    rules: await desired.resolveDesiredRules(teamConfig, localConfig, roleContext),
    claudemd: await desired.collectClaudemdFiles(localConfig, roleContext),
  };
}

function listed(sources: string[]): string {
  return sources.length <= 2
    ? sources.join(' and ')
    : `${sources.slice(0, -1).join(', ')} and ${sources[sources.length - 1]}`;
}

/**
 * Team instructions (#945): whether each installed tool can load this
 * member's culture, claudemd and recall blocks, not only whether a file was
 * written. A file target must hold the current blocks, and OpenCode's must be
 * listed in its `instructions`; a hook target needs teamai's extension or
 * plugin as this build writes it, and room in its channel; and no file an
 * earlier release wrote may still hold blocks.
 */
export async function buildInstructionDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];
  const {
    channelReadiness, holdsInstructionBlocks, hookLimitProblem, instructionHookText,
    planInstructionFiles, resolveInstructionTargets,
  } = await import('./instruction-targets.js');
  const { resolveInstructionBlocks } = await import('./pull.js');
  const { buildRolePullContext } = await import('./resources/desired.js');
  const { opencodeContextReference, readOpencodeInstructionList } = await import('./resources/opencode-config.js');
  const { blocks } = await resolveInstructionBlocks(teamConfig, localConfig, await buildRolePullContext(localConfig));
  const { targets, hooks, stale, opencodeFallback } = await resolveInstructionTargets(teamConfig, localConfig);
  const pullNow = 'Run `teamai pull`.';
  const checks: Check[] = [];

  const openclawTarget = targets.find((target) => target.tools.includes('openclaw'));
  if (openclawTarget && await holdsInstructionBlocks(openclawTarget.path)) {
    const { openclawBootstrapBudget } = await import('./openclaw-home.js');
    const budget = await openclawBootstrapBudget();
    const length = (await readFileSafe(openclawTarget.path) ?? '').trimEnd().length;
    checks.push({
      name: 'OpenClaw AGENTS.md fits the default bootstrap read budget',
      source: 'local',
      check: async () => !budget.error && length <= budget.limit,
      fix: budget.error
        ? `${budget.config} could not be parsed, so the OpenClaw bootstrap budget is unknown: ${budget.error}. Fix the config and run teamai doctor again.`
        : `${openclawTarget.path} has ${length} characters including member text and all TeamAI blocks, over the `
          + `${budget.limit}-character bootstrap budget. OpenClaw truncates or skips it under these default-agent limits. Shorten the complete file or review `
          + `agents.defaults.bootstrapMaxChars and agents.defaults.bootstrapTotalMaxChars in ${budget.config}. Teamai does not truncate your instructions.`,
    });
  }

  for (const target of targets) {
    const plan = await planInstructionFiles([target], blocks);
    checks.push({
      name: `Team instructions are current for ${target.tools.join(', ')}`,
      source: 'local',
      check: async () => plan.changes.length === 0 && plan.warnings.length === 0,
      fix: plan.warnings.length > 0
        ? plan.warnings.join(' ')
        : `${target.path} does not hold this member's current team instructions. ${pullNow}`,
    });
  }

  const hermesSoul = targets.find((target) => target.tools.includes('hermes'));
  if (hermesSoul && await holdsInstructionBlocks(hermesSoul.path)) {
    const { hermesContextFileBudget, getHermesConfigPath } = await import('./hermes-config.js');
    const budget = await hermesContextFileBudget();
    // Hermes counts Python Unicode code points after stripping whitespace.
    // Python str.strip includes C0 separators and NEL, and excludes BOM.
    // eslint-disable-next-line no-control-regex
    const length = Array.from((await readFileSafe(hermesSoul.path) ?? '').replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '')).length;
    checks.push({
      name: 'Hermes SOUL.md fits the context-file read budget',
      source: 'local',
      informational: !budget.explicit && !budget.error,
      check: async () => !budget.error && length <= budget.limit,
      fix: budget.error
        ? `${getHermesConfigPath()} cannot be parsed, so the SOUL.md read budget is unknown: ${budget.error}. Fix its YAML and run teamai doctor again.`
        : `${hermesSoul.path} has ${length} characters including member text and all TeamAI blocks, over the `
          + `${budget.limit}-character ${budget.explicit ? 'context_file_max_chars cap, so Hermes truncates it' : 'minimum default context-file cap; Hermes may truncate it unless the selected model raises the cap'}. `
          + `Shorten the complete file or set context_file_max_chars in ${getHermesConfigPath()} to a suitable limit. Teamai does not truncate your instructions.`,
    });
  }

  const opencodeFile = teamConfig.toolPaths.opencode === undefined ? undefined
    : ownOf(await locate('opencode', 'blocks', installOf(teamConfig, localConfig)))?.path;
  // Only a file holding the blocks needs listing; pull registers it once it
  // writes them. Beside the Claude fallback V1 reads CLAUDE.md instead.
  const opencodeDelivered = opencodeFile !== undefined && targets.some((t) => t.path === opencodeFile) && await holdsInstructionBlocks(opencodeFile);
  const opencodeV2 = opencodeDelivered
    ? await opencodeV2PluginCheck(ctx, 'opencode adds the team instructions to its prompt', 'the team instructions')
    : null;
  if (opencodeV2) {
    checks.push(opencodeV2);
  } else if (opencodeFile && opencodeDelivered && !opencodeFallback) {
    const { config, entry } = opencodeContextReference(opencodeFile, localConfig.scope, resolveBaseDir(localConfig));
    const instructions = await readOpencodeInstructionList(config);
    checks.push({
      name: 'Team instructions are listed in opencode instructions',
      source: 'local',
      check: async () => instructions !== null && instructions.includes(entry),
      fix: instructions === null
        ? `${config} could not be read as a JSON object, so the pull left it alone and OpenCode never loads ${opencodeFile}. `
          + `Fix the file or add "${entry}" to its "instructions" by hand, then run \`teamai pull\`.`
        : `${config} does not list "${entry}" under "instructions", and OpenCode reads no file it is not told about. ${pullNow}`,
    });
  }

  // On OpenCode V2 a pull takes teamai's V1 entries only out of a file git does not track (#915).
  const { opencodeV1Leftovers } = await import('./teamai-only-files.js');
  const v1Left = await opencodeV1Leftovers(teamConfig, localConfig);
  if (v1Left.length > 0) {
    checks.push({
      name: 'No OpenCode V1 entries are left in shared config files',
      source: 'local',
      informational: true,
      check: async () => false,
      fix: `OpenCode V2 gets the team instructions, rules and MCP servers through teamai's plugin, but teamai's entries for OpenCode V1 `
        + `are still in ${v1Left.map(({ file, entries }) => `${file} (${entries.join(', ')})`).join(' and ')}: git tracks the file, or pull `
        + 'cannot edit it, so pull leaves it as it is. V2 ignores `instructions` and loads those servers a second time. '
        + 'Remove teamai\'s entries by hand once no one on the project uses OpenCode V1.',
    });
  }

  // Pi's extension also carries the project's team rules (#946).
  const { teamRulesContext } = await import('./resources/rules.js');
  let hasTeamRules: boolean | undefined;
  for (const hook of hooks) {
    const text = instructionHookText(blocks, hook.recall);
    if (!text && !getsRulesFromExtension(hook.tool)) continue;
    if (!text && !(hasTeamRules ??= await teamRulesContext(teamConfig, localConfig) !== null)) continue;
    const channel = await channelReadiness(hook.tool, hook.probe, { teamConfig, localConfig });
    const overLimit = hookLimitProblem(hook, text);
    checks.push({
      name: `${hook.tool} adds the team instructions${getsRulesFromExtension(hook.tool) ? ' and rules' : ''} to its prompt`,
      source: 'local',
      check: async () => channel.ready && overLimit === null,
      fix: channel.ready ? overLimit ?? '' : channel.fix,
    });
  }

  const leftovers: string[] = [];
  const warnings: string[] = [];
  for (const file of stale) {
    const plan = await planInstructionFiles([], {}, [file]);
    if (plan.changes.length > 0 || plan.warnings.length > 0) leftovers.push(file.path);
    warnings.push(...plan.warnings);
  }
  checks.push({
    name: 'No team instruction blocks are left in files no tool loads them from',
    source: 'local',
    check: async () => leftovers.length === 0,
    // A sharing.gitExclude switch moves Copilot's blocks too (#915).
    fix: [...warnings, `An earlier teamai release or sharing.gitExclude setting left team instruction blocks in ${nameList(leftovers)}, which can carry another member's selection. ${pullNow}`].join(' '),
  });
  return checks;
}
