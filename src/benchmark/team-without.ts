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
import { withTeamRevision } from '../workflow/cache.js';
import type { TeamSelection } from '../workflow/clone.js';
import { git } from '../workflow/worktree.js';
import type { Arm } from './suite.js';

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
]);

/**
 * Why plan refuses arm `arm` that runs without `paths` at team commit `revision`, or undefined when its trials can run
 * without them. `config` is the member's; `selection`, the assets the run's clones install. Refused: a path the revision
 * does not have; teamai.yaml, which the clone's pull reads; and a path under skills/, rules/, agents/, claudemd/ or docs/
 * whose leaving out leaves what pull delivers as it was, with the reason pull's resolvers give.
 */
export async function withoutRefusal(
  config: LocalConfig,
  { arm, paths, revision, selection }: { arm: string; paths: readonly string[]; revision: string; selection: TeamSelection },
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

  // The member as the clone's own pull reads it: the run's selection, on a scope with no state of its own.
  const member: LocalConfig = { repo: config.repo, username: config.username, scope: 'project', projectRoot: config.projectRoot, ...selection };
  const read = await withTeamRevision(member, revision, async (at) => ({ unchanged: await firstUnchanged(at, { subject: `Arm "${arm}" runs without`, advice: REMOVE, paths, files, short, excluded: selection.excludedSkills }) }));

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

/** An arm as the covers check reads it: a team-free arm (`team: none`) pulls nothing, so it receives no covered path. */
type CoveringArm = Pick<Arm, 'name' | 'role'> & Partial<Pick<Arm, 'team'>>;

/**
 * Every selection the run's arms pull under, with the arms that pull under it: the member's own when an arm with team
 * assets runs with no role, then each arm's role, so a path only one role receives is not refused and one no arm
 * receives is.
 */
export function armSelections(planned: readonly CoveringArm[], member: TeamSelection): Array<{ selection: TeamSelection; arms: string[] }> {
  const arms = planned.filter(({ team }) => team?.kind !== 'none');
  const roles = [...new Set(arms.flatMap(({ role }) => (role !== undefined ? [role] : [])))];
  const own = arms.some(({ role }) => role === undefined) ? [member] : [];

  return [...own, ...roles.map((role) => ({ ...member, primaryRole: role }))]
    .flatMap((selection, index, all) => (all.findIndex((other) => other.primaryRole === selection.primaryRole) === index
      ? [{ selection, arms: arms.flatMap(({ name, role }) => ((role ?? member.primaryRole) === selection.primaryRole ? [name] : [])) }]
      : []));
}

/**
 * Why plan refuses the paths the tasks cover, or, by each covered path, the arms whose selection pull does not deliver
 * it to, so their trials record no routing for it. Refused: a path the revision does not have, teamai.yaml, and a path
 * no arm's selection receives.
 */
export async function coveredDelivery(
  config: LocalConfig,
  { paths, revision, arms, member, files }: { paths: readonly string[]; revision: string; arms: readonly CoveringArm[]; member: TeamSelection; files: readonly string[] },
): Promise<{ refusal: Refusal } | { withheldFrom: Record<string, string[]> }> {
  const short = revision.slice(0, 7);
  const selections = armSelections(arms, member);
  const missing = paths.find((one) => !files.some((file) => leavesOut([one], file)));

  if (missing !== undefined) {
    return { refusal: { code: 'arm_team_unresolved', message: `A task covers ${missing}, which team revision ${short} does not have. ${TASK_FIX}` } };
  }

  if (paths.includes('teamai.yaml')) {
    return { refusal: { code: 'arm_team_unresolved', message: `A task covers teamai.yaml, which teamai pull reads to install the team, so no trial could run. ${TASK_FIX}` } };
  }

  // Every selection the run's arms pull under, so a path only a role arm receives is not refused. A path refuses
  // only when every selection's delivery leaves it unchanged: each read is the member as the clone's own pull reads
  // it, on a scope with no state of its own.
  // Each path once, however many tasks cover it, each checked on its own against the whole tree.
  const unique = [...new Set(paths)];

  // One path at a time within a clone — each check renames its path out and back — while the selections run apart,
  // each in its own clone, so no check reads a clone another path is moved out of.
  const reads = await Promise.all(selections.map(async ({ selection, arms: pulling }) => {
    const reader: LocalConfig = { repo: config.repo, username: config.username, scope: 'project', projectRoot: config.projectRoot, ...selection };

    return withTeamRevision(reader, revision, async (at) => {
      const unchangedByPath: Array<[string, string | undefined]> = [];

      for (const covered of unique) {
        unchangedByPath.push([covered, await firstUnchanged(at, { subject: 'A task covers', advice: TASK_FIX, paths: [covered], files, short, excluded: selection.excludedSkills })]);
      }

      return { arms: pulling, unchangedByPath };
    });
  }));

  const failed = reads.find((read) => 'failed' in read);

  if (failed && 'failed' in failed) {
    return { refusal: { code: 'arm_team_unreadable', message: `A task covers ${paths.join(', ')}, and what teamai pull delivers at team revision ${short} could not be read: ${failed.failed}. Repair the team repo, or run teamai pull, and start again.` } };
  }

  const read = reads.flatMap((one) => ('failed' in one ? [] : [one]));

  // A path refuses only when every selection's delivery leaves it unchanged; one role arm that receives it is enough.
  const unchangedFor = (covered: string) => read.flatMap(({ arms: pulling, unchangedByPath }) => unchangedByPath.flatMap(([one, unchanged]) => (one === covered && unchanged !== undefined ? [{ arms: pulling, unchanged }] : [])));

  const refused = unique.map(unchangedFor).find((ones) => ones.length === read.length)?.[0];

  if (refused !== undefined) return { refusal: { code: 'arm_team_unresolved', message: refused.unchanged } };

  return { withheldFrom: Object.fromEntries(unique.map((covered) => [covered, unchangedFor(covered).flatMap(({ arms: pulling }) => pulling)])) };
}

/**
 * Why pull delivers the same with the first of `paths` that it does as without it, at the checkout of the team revision
 * `at` names, whose files are `files`, or undefined when each path changes what it delivers. Each path is set aside in
 * turn, with the others out of the checkout, and every path is back in the checkout when it returns.
 */
async function firstUnchanged(
  at: LocalConfig,
  { subject, advice, paths, files, short, excluded }: { subject: string; advice: string; paths: readonly string[]; files: readonly string[]; short: string; excluded: readonly string[] },
): Promise<string | undefined> {
  const repo = at.repo.localPath;
  const held = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-without-'));

  const out = new Set<string>();

  const move = async (from: string, to: string, one: string): Promise<void> => {
    await fs.mkdir(path.dirname(path.join(to, one)), { recursive: true });
    await fs.rename(path.join(from, one), path.join(to, one));

    if (to === held) out.add(one);
    else out.delete(one);
  };

  const present = (left: readonly string[]): string[] => files.filter((file) => !leavesOut(left, file));

  try {
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
    await fs.rm(held, { recursive: true });
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
