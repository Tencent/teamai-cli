/**
 * Plan's check of an arm's `team: { without: paths }`, before any run exists: each path is a file or directory of the
 * arm's team revision, and leaving it out changes what teamai pull delivers to the arm's trials. Pull's own resolvers
 * decide that, at the revision with the arm's other paths left out, once with the path and once without it.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTeamConfig } from '../config.js';
import {
  buildRolePullContext, collectClaudemdFiles, describeDeliveryConflict, resolveDesiredAgents, resolveDesiredRules,
  resolveDesiredSkills, type DeliveryConflict,
} from '../resources/desired.js';
import { resolveDesiredDocs } from '../resources/docs.js';
import type { LocalConfig, ResourceItem } from '../types.js';
import { usesMemberFilters } from '../resource-namespaces.js';
import { withTeamRevision } from '../workflow/cache.js';
import type { TeamSelection } from '../workflow/clone.js';
import { git } from '../workflow/worktree.js';
import type { Arm } from './suite.js';
import type { ArmTeam } from './terms.js';

/** Why plan refuses the arm: git could not read its team revision, or a path changes nothing its trials get. */
type Refusal = { code: 'arm_team_unreadable' | 'arm_team_unresolved'; message: string };

/** What plan says a path's refusal ends with, by who lists it: an arm's team fix, or the team's task files. */
const TASK_FIX = 'Fix the team\'s tasks, push them, run teamai pull, and start again.';

/** What teamai pull delivers from one tree of the team repo, as its resolvers say, and `key`, the whole of it as text. */
type Delivery = Awaited<ReturnType<typeof deliveryAt>>;

const REMOVE = 'Remove it from the arm\'s team, push it, run teamai pull, and start again.';

/**
 * By each team repo directory pull's resolvers deliver from, why pull delivers the same with a path in it as without
 * it, after "Arm "x" runs without <path>": pull delivers no skills or agents, the item is one the member excludes, its
 * namespace does not reach the member, another item stands in its place, or the tag channel leaves it out. Undefined
 * when the resolvers give no reason. A path in a directory with no entry here only has to exist.
 */
const REASONS: ReadonlyMap<string, (unchanged: Unchanged) => string | undefined> = new Map([
  ['skills', skillsReason], ['rules', rulesReason], ['agents', agentsReason], ['claudemd', claudemdReason], ['docs', docsReason],
  // `agentsmd/` is the alternative shared-instruction source directory (#1682).
  ['agentsmd', claudemdReason],
]);

/**
 * Why plan refuses arm `arm` that runs without `paths` at team commit `revision`, or undefined when its trials can run
 * without them. `config` is the member's; `selection`, the assets the run's clones install; `role`, the arm's, which its
 * clone pulls with in place of the member's roles and filters. Refused: a path the revision
 * does not have; teamai.yaml, which the clone's pull reads; and a path under skills/, rules/, agents/, claudemd/ or docs/
 * whose leaving out leaves what pull delivers as it was, with the reason pull's resolvers give.
 */
export async function withoutRefusal(
  config: LocalConfig,
  { arm, paths, revision, selection, role }: { arm: string; paths: readonly string[]; revision: string; selection: TeamSelection; role?: string },
): Promise<Refusal | undefined> {
  const short = revision.slice(0, 7);
  const listed = await git(config.repo.localPath, ['ls-tree', '-r', '-z', '--name-only', revision]);

  if (listed.code !== 0) {
    return { code: 'arm_team_unreadable', message: `Arm "${arm}" runs without ${paths.join(', ')}, and git could not list team revision ${short} at ${config.repo.localPath}: ${listed.stderr.trim()}. Repair the team repo, or run teamai pull, and start again.` };
  }

  const files = listed.stdout.split('\0').filter((file) => file !== '');
  const missing = paths.find((one) => !files.some((file) => leavesOut([one], file)));

  if (missing !== undefined) {
    return { code: 'arm_team_unresolved', message: `Arm "${arm}" runs without ${missing}, which team revision ${short} does not have. Fix the arm's team, push it, run teamai pull, and start again.` };
  }

  if (paths.includes('teamai.yaml')) {
    return { code: 'arm_team_unresolved', message: `Arm "${arm}" runs without teamai.yaml, which teamai pull reads to install the team, so no trial could run. ${REMOVE}` };
  }

  const { reader, excluded } = readerOf(config, selection, role);
  const read = await withTeamRevision(reader, revision, async (at) => ({ unchanged: await firstUnchanged(at, { subject: `Arm "${arm}" runs without`, advice: REMOVE, paths, files, short, excluded }) }));

  if ('failed' in read) {
    return { code: 'arm_team_unreadable', message: `Arm "${arm}" runs without ${paths.join(', ')}, and what teamai pull delivers at team revision ${short} could not be read: ${read.failed}. Repair the team repo, or run teamai pull, and start again.` };
  }

  return read.unchanged === undefined ? undefined : { code: 'arm_team_unresolved', message: read.unchanged };
}

/**
 * Why plan refuses the paths a task covers, before any run exists: each is a file or directory of the pulled team
 * revision, and leaving it out changes what teamai pull delivers, so an arm can run without it and the asset-effect
 * tables can compare. Undefined when every covered path can be left out. The same resolvers as `withoutRefusal`.
 */
/** Every file a team revision holds, listed once for the checks on paths the run names. */
export async function teamFilesAt(
  config: LocalConfig,
  { paths, revision }: { paths: readonly string[]; revision: string },
): Promise<{ files: string[] } | { failed: Refusal }> {
  const short = revision.slice(0, 7);
  const listed = await git(config.repo.localPath, ['ls-tree', '-r', '-z', '--name-only', revision]);

  if (listed.code !== 0) {
    return { failed: { code: 'arm_team_unreadable', message: `${paths.join(', ')}, and git could not list team revision ${short} at ${config.repo.localPath}: ${listed.stderr.trim()}. Repair the team repo, or run teamai pull, and start again.` } };
  }

  return { files: listed.stdout.split('\0').filter((file) => file !== '') };
}

/**
 * The bare name a trial's load record would show for a covered team repo path: the last segment of a `skills/` path
 * whose directory the revision delivers as a skill, that is, holds a SKILL.md directly. Undefined for a namespace
 * directory, a single skill file, a rule, a doc or anything else: only skill loads are observed, and a namespace
 * directory is not one.
 */
export function coveredSkillName(listed: string, files: readonly string[]): string | undefined {
  if (!listed.startsWith('skills/')) return undefined;

  return files.includes(skillDefinitionOf(listed)) ? listed.split('/').at(-1) : undefined;
}

/** The file that makes the skill directory `skill` a skill: without it, nothing loads the skill. */
export function skillDefinitionOf(skill: string): string {
  return `${skill}/SKILL.md`;
}

/** An arm as the covers check reads it: its team as plan resolved it (absent: the pulled revision) and its role. */
type CoveringArm = Pick<Arm, 'name' | 'role'> & { team?: ArmTeam };

/** What an arm's clone installs from: a team revision, the role it pulls with (absent: the member's), and the paths it runs without. */
type ArmSource = { revision: string; role: string | undefined; without: readonly string[] };

/**
 * The sources the run's arms install from, each with the arms that install from it, so arms that share a revision, a
 * role and the paths they run without share one read. A team-free arm (`team: none`) installs nothing, so it has none.
 */
export function armSources(planned: readonly CoveringArm[], pulled: string): Array<{ source: ArmSource; arms: string[] }> {
  const sources = new Map<string, { source: ArmSource; arms: string[] }>();

  for (const { name, role, team } of planned) {
    if (team?.kind === 'none') continue;
    const source: ArmSource = { revision: team?.revision ?? pulled, role, without: team?.kind === 'without' ? [...team.paths].sort() : [] };
    const key = JSON.stringify([source.revision, source.role ?? null, source.without]);
    const known = sources.get(key) ?? { source, arms: [] };

    known.arms.push(name);
    sources.set(key, known);
  }

  return [...sources.values()];
}

/**
 * The member as an arm's clone pulls, on a scope with no state of its own: the run's selection, and with a role, that
 * role as the clone's step role, which replaces the member's roles and drops their tags and excluded skills. `excluded`:
 * the skills that pull still excludes.
 */
function readerOf(config: LocalConfig, selection: TeamSelection, role: string | undefined) {
  const reader: LocalConfig = { repo: config.repo, username: config.username, scope: 'project', projectRoot: config.projectRoot, ...selection };

  if (role !== undefined) reader.stepRole = role;

  return { reader, excluded: usesMemberFilters(reader) ? selection.excludedSkills : [] };
}

/**
 * Why plan refuses the paths the tasks cover, or, by each covered path, the arms whose clone does not receive it, so
 * their trials record no routing for it. Each arm is read as its clone installs: at its own team revision, with its
 * role, and without the paths it runs without. Refused: a path the pulled revision does not have, teamai.yaml, and a
 * path no arm receives.
 */
export async function coveredDelivery(
  config: LocalConfig,
  { paths, revision, arms, member, files }: { paths: readonly string[]; revision: string; arms: readonly CoveringArm[]; member: TeamSelection; files: readonly string[] },
): Promise<{ refusal: Refusal } | { withheldFrom: Record<string, string[]> }> {
  const short = revision.slice(0, 7);
  const sources = armSources(arms, revision);
  const missing = paths.find((one) => !files.some((file) => leavesOut([one], file)));

  if (missing !== undefined) {
    return { refusal: { code: 'arm_team_unresolved', message: `A task covers ${missing}, which team revision ${short} does not have. ${TASK_FIX}` } };
  }

  if (paths.includes('teamai.yaml')) {
    return { refusal: { code: 'arm_team_unresolved', message: `A task covers teamai.yaml, which teamai pull reads to install the team, so no trial could run. ${TASK_FIX}` } };
  }

  if (sources.length === 0) {
    return { refusal: { code: 'arm_team_unresolved', message: `A task covers ${paths.join(', ')}, but every arm runs with team: none, so no arm receives it. ${TASK_FIX}` } };
  }

  // Each path once, however many tasks cover it, each checked on its own against the whole tree.
  const unique = [...new Set(paths)];

  // One path at a time within a clone — each check renames its path out and back — while the sources run apart, each
  // in its own clone, so no check reads a clone another path is moved out of.
  const reads = await Promise.all(sources.map(async ({ source, arms: installing }) => {
    const listed = source.revision === revision ? { files } : await teamFilesAt(config, { paths: unique, revision: source.revision });

    const at = source.revision.slice(0, 7);

    if ('failed' in listed) return { failed: `git could not list it`, at };
    // A path the arm runs without, or that its revision does not have, never reaches it; the rest are read.
    const absent = (covered: string) => leavesOut(source.without, covered) || !listed.files.some((file) => leavesOut([covered], file));
    const read = unique.filter((covered) => !absent(covered));
    const { reader, excluded } = readerOf(config, member, source.role);

    const checked = read.length === 0 ? [] : await withTeamRevision(reader, source.revision, async (clone) => {
      const unchangedByPath: Array<[string, string | undefined]> = [];

      for (const covered of read) {
        unchangedByPath.push([covered, await firstUnchanged(clone, { subject: 'A task covers', advice: TASK_FIX, paths: [covered], aside: source.without, files: listed.files, short: at, excluded })]);
      }

      return unchangedByPath;
    });

    if ('failed' in checked) return { failed: checked.failed, at };
    const reasons = new Map(checked);

    // By covered path: received (undefined), withheld with the reason pull's resolvers give, or withheld with none.
    return { arms: installing, withheld: unique.map((covered): [string, { reason: string | undefined } | undefined] => [covered, absent(covered) ? { reason: undefined } : reasons.get(covered) === undefined ? undefined : { reason: reasons.get(covered) }]) };
  }));

  const failed = reads.find((one) => 'failed' in one);

  if (failed && 'failed' in failed) {
    return { refusal: { code: 'arm_team_unreadable', message: `A task covers ${paths.join(', ')}, and what teamai pull delivers at team revision ${failed.at} could not be read: ${failed.failed}. Repair the team repo, or run teamai pull, and start again.` } };
  }

  const read = reads.flatMap((one) => ('failed' in one ? [] : [one]));
  const withheldOf = (covered: string) => read.flatMap(({ arms: installing, withheld }) => withheld.flatMap(([one, why]) => (one === covered && why !== undefined ? [{ arms: installing, reason: why.reason }] : [])));

  // A path refuses only when no arm receives it; one arm that receives it is enough.
  for (const covered of unique) {
    const withheld = withheldOf(covered);

    if (withheld.length < read.length) continue;
    const reasons = withheld.flatMap(({ reason }) => (reason === undefined ? [] : [reason]));

    return {
      refusal: {
        code: 'arm_team_unresolved',
        // Every arm's pull leaves it out for a reason its resolvers give: the first. Otherwise some arm runs without it
        // or on a revision that lacks it.
        message: reasons.length === withheld.length && reasons[0] !== undefined
          ? reasons[0]
          : `A task covers ${covered}, and no arm receives it: each arm that pulls team assets runs without it, on a team revision that does not have it, or with roles or projects that leave it out. ${TASK_FIX}`,
      },
    };
  }

  return { withheldFrom: Object.fromEntries(unique.map((covered) => [covered, withheldOf(covered).flatMap(({ arms: installing }) => installing)])) };
}

/**
 * Why pull delivers the same with the first of `paths` that it does as without it, at the checkout of the team revision
 * `at` names, whose files are `files`, or undefined when each path changes what it delivers. Each path is set aside in
 * turn, with the others out of the checkout, `aside` stays out throughout, and every path is back in the checkout when
 * it returns.
 */
async function firstUnchanged(
  at: LocalConfig,
  { subject, advice, paths, aside = [], files, short, excluded }: { subject: string; advice: string; paths: readonly string[]; aside?: readonly string[]; files: readonly string[]; short: string; excluded: readonly string[] },
): Promise<string | undefined> {
  const repo = at.repo.localPath;
  const held = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-without-'));
  // Apart from `held`, so a checked path that holds one of `aside` moves out whole and back before it returns.
  const apart = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-without-'));
  const setAside: string[] = [];

  const out = new Set<string>();

  const move = async (from: string, to: string, one: string): Promise<void> => {
    await fs.mkdir(path.dirname(path.join(to, one)), { recursive: true });
    await fs.rename(path.join(from, one), path.join(to, one));

    if (to === held) out.add(one);
    else out.delete(one);
  };

  const present = (left: readonly string[]): string[] => files.filter((file) => !leavesOut([...aside, ...left], file));

  try {
    for (const one of aside) {
      await fs.mkdir(path.dirname(path.join(apart, one)), { recursive: true });
      await fs.rename(path.join(repo, one), path.join(apart, one));
      setAside.push(one);
    }

    for (const one of paths) await move(repo, held, one);
    const without = await deliveryAt(at, present(paths));

    for (const one of paths) {
      const reason = REASONS.get(one.split('/')[0] ?? '');

      if (reason === undefined) continue;
      await move(held, repo, one);
      const withIt = await deliveryAt(at, present(paths.filter((other) => other !== one)));

      if (withIt.key === without.key) {
        const why = reason({ listed: one, short, files, excluded, advice, withIt, without })
          ?? `, and teamai pull delivers the same team assets at team revision ${short} with or without it, so leaving it out changes nothing. ${advice}`;

        return `${subject} ${one}${why}`;
      }

      await move(repo, held, one);
    }

    return undefined;
  } finally {
    // Every path goes back, so the next check in this checkout reads the whole tree.
    for (const one of out) await move(held, repo, one);

    for (const one of setAside) await fs.rename(path.join(apart, one), path.join(repo, one));
    await fs.rm(held, { recursive: true });
    await fs.rm(apart, { recursive: true });
  }
}

/** Whether running without `paths` leaves out `file`: one of them is that path, or a directory that holds it. */
export function leavesOut(paths: readonly string[], file: string): boolean {
  return paths.some((listed) => file === listed || file.startsWith(`${listed}/`));
}

/** What pull delivers from the team repo `at` names, whose files are `present`, by pull's resolvers. */
async function deliveryAt(at: LocalConfig, present: readonly string[]) {
  const team = await loadTeamConfig(at.repo.localPath);

  if (team === null) throw new Error('its teamai.yaml cannot be read');
  const context = await buildRolePullContext(at);

  const [skills, rules, agents, claudemd, docs] = await Promise.all([
    resolveDesiredSkills(team, at, context), resolveDesiredRules(team, at, context), resolveDesiredAgents(team, at, context),
    collectClaudemdFiles(at, context), resolveDesiredDocs(at.repo.localPath, context?.inactiveDocsNamespaces ?? []),
  ]);

  const sources = (items: ReadonlyArray<{ relativePath: string }>): string[] => items.map((item) => item.relativePath).sort();

  const key = JSON.stringify({
    // A skill is delivered as its directory, so each file in it is part of what the trial gets.
    skills: skills.kind === 'resolved' ? sources(skills.items).map((source) => present.filter((file) => file.startsWith(`${source}/`))) : describeDeliveryConflict(skills),
    rules: sources(rules.items),
    agents: agents.kind === 'resolved' ? sources(agents.items) : describeDeliveryConflict(agents),
    claudemd: claudemd.contents,
    docs: docs.files,
  });

  return { key, context, skills, rules, agents, claudemd, docs };
}

/** A path an arm leaves out, and what pull's resolvers deliver with it (`withIt`) and without it. */
type Unchanged = { listed: string; short: string; files: readonly string[]; excluded: readonly string[]; advice: string; withIt: Delivery; without: Delivery };

function skillsReason({ listed, short, excluded, advice, withIt }: Unchanged): string | undefined {
  const { skills, context } = withIt;

  if (skills.kind === 'conflict') return noneOf(skills, short);
  const item = skills.teamItems.find((one) => covers(listed, one.relativePath) && !skills.items.some((other) => other.relativePath === one.relativePath));

  return item && skillReason(item, { delivered: skills.items, excluded, active: context?.activeNamespaces.skills, advice });
}

/**
 * Why pull leaves out skill `item`, with the skills it delivers and the skill namespaces the member receives (`active`,
 * undefined when every namespace reaches the member), or undefined.
 */
function skillReason(item: ResourceItem, { delivered, excluded, active, advice }: { delivered: readonly ResourceItem[]; excluded: readonly string[]; active: readonly string[] | undefined; advice: string }): string | undefined {
  if (excluded.includes(item.name)) return `, skill ${item.name}, which the member excludes, so pull leaves it out already and leaving it out changes nothing. ${advice}`;

  if (item.namespace !== undefined && active && !active.includes(item.namespace)) return inactive(item.namespace, advice);
  const standIn = delivered.find((one) => one.name === item.name);

  if (standIn) return inPlace(standIn.relativePath, standIn.namespace, advice);

  return item.namespace === undefined && active ? `, a shared skill, which the arm's roles or projects receive only through a subscribed tag, and none brings it, so leaving it out changes nothing. ${advice}` : undefined;
}

function rulesReason({ listed, files, advice, withIt, without }: Unchanged): string | undefined {
  const namespace = notReceived(listed, files, withIt.context?.activeNamespaces.knowledge);

  if (namespace !== undefined) return inactive(namespace, advice);

  if (withIt.rules.skippedByTags > without.rules.skippedByTags) return `, a rule tagged only with tags the member does not subscribe, so pull leaves it out already and leaving it out changes nothing. ${advice}`;

  return replacing(listed, withIt.rules.overrides, advice);
}

function agentsReason({ listed, short, files, advice, withIt }: Unchanged): string | undefined {
  if (withIt.agents.kind === 'conflict') return noneOf(withIt.agents, short);
  const namespace = notReceived(listed, files, withIt.context?.activeNamespaces.agents);

  return namespace !== undefined ? inactive(namespace, advice) : replacing(listed, withIt.agents.overrides, advice);
}

function claudemdReason({ listed, files, advice, withIt }: Unchanged): string | undefined {
  const namespace = notReceived(listed, files, withIt.context?.activeNamespaces.knowledge);

  return namespace !== undefined ? inactive(namespace, advice) : replacing(listed, withIt.claudemd.overrides, advice);
}

function docsReason({ listed, advice, withIt }: Unchanged): string | undefined {
  const withheld = withIt.docs.withheld.find(({ dir }) => covers(listed, `docs/${dir}`));

  return withheld && inactive(withheld.dir, advice);
}

/** Whether leaving out `listed` leaves out `source`, or a part of it. */
function covers(listed: string, source: string): boolean {
  return leavesOut([listed], source) || leavesOut([source], listed);
}

/** The namespace `<root>/<namespace>/` that `listed` is in or is, when it is a directory and not in `active`. */
function notReceived(listed: string, files: readonly string[], active: readonly string[] | undefined): string | undefined {
  const [root, namespace] = listed.split('/');
  const isDirectory = files.some((file) => file.startsWith(`${root}/${namespace}/`));

  return active && namespace !== undefined && isDirectory && !active.includes(namespace) ? namespace : undefined;
}

/** That the item of `overrides` that stands in for `listed` is delivered in its place. */
function replacing(listed: string, overrides: ReadonlyArray<{ source: string; replaces: string }>, advice: string): string | undefined {
  const override = overrides.find((one) => covers(listed, one.replaces));

  return override && inPlace(override.source, override.source.split('/')[1], advice);
}

/**
 * That `source` is delivered in place of the listed path. An arm leaves both out together, so it lists `source` too;
 * a cover is checked on its own, so listing `source` as well changes nothing, and the task covers `source` instead.
 */
function inPlace(source: string, namespace: string | undefined, advice: string): string {
  const by = namespace === undefined ? 'the team root' : `its namespace ${namespace}`;

  return advice === TASK_FIX
    ? `, but ${by} delivers ${source} in its place, so leaving it out changes nothing; cover ${source} instead. ${TASK_FIX}`
    : `, but ${by} delivers ${source} in its place; list ${source} too.`;
}

function inactive(namespace: string, advice: string): string {
  return `, which is in namespace ${namespace}, and the arm's roles or projects don't receive ${namespace}, so leaving it out changes nothing. ${advice}`;
}

function noneOf(conflict: DeliveryConflict, short: string): string {
  return `, and teamai pull delivers no ${conflict.type}s at team revision ${short} with or without it: ${describeDeliveryConflict(conflict)}. Fix that in the team repo, push it, run teamai pull, and start again.`;
}
