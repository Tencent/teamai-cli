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

/** Why plan refuses the arm: git could not read its team revision, or a path changes nothing its trials get. */
type Refusal = { code: 'arm_team_unreadable' | 'arm_team_unresolved'; message: string };

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
  const read = await withTeamRevision(member, revision, (at) => firstUnchanged(at, { arm, paths, files, short, excluded: selection.excludedSkills }));
  if (typeof read === 'object') {
    return { code: 'arm_team_unreadable', message: `Arm "${arm}" runs without ${paths.join(', ')}, and what teamai pull delivers at team revision ${short} could not be read: ${read.failed}. Repair the team repo, or run teamai pull, and start again.` };
  }
  return read === undefined ? undefined : { code: 'arm_team_unresolved', message: read };
}

/**
 * Why pull delivers the same with the first of `paths` that it does as without it, at the checkout of the team revision
 * `at` names, whose files are `files`, or undefined when each path changes what it delivers. Each path is set aside in
 * turn, with the others out of the checkout, and put back after.
 */
async function firstUnchanged(
  at: LocalConfig,
  { arm, paths, files, short, excluded }: { arm: string; paths: readonly string[]; files: readonly string[]; short: string; excluded: readonly string[] },
): Promise<string | undefined> {
  const repo = at.repo.localPath;
  const held = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-without-'));
  const move = async (from: string, to: string, one: string): Promise<void> => {
    await fs.mkdir(path.dirname(path.join(to, one)), { recursive: true });
    await fs.rename(path.join(from, one), path.join(to, one));
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
        const why = reason({ listed: one, short, files, excluded, withIt, without })
          ?? `, and teamai pull delivers the same team assets at team revision ${short} with or without it, so leaving it out changes nothing. ${REMOVE}`;
        return `Arm "${arm}" runs without ${one}${why}`;
      }
      await move(repo, held, one);
    }
    return undefined;
  } finally {
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
type Unchanged = { listed: string; short: string; files: readonly string[]; excluded: readonly string[]; withIt: Delivery; without: Delivery };

function skillsReason({ listed, short, excluded, withIt }: Unchanged): string | undefined {
  const { skills, context } = withIt;
  if (skills.kind === 'conflict') return noneOf(skills, short);
  const item = skills.teamItems.find((one) => covers(listed, one.relativePath) && !skills.items.some((other) => other.relativePath === one.relativePath));
  return item && skillReason(item, { delivered: skills.items, excluded, active: context?.activeNamespaces.skills });
}

/**
 * Why pull leaves out skill `item`, with the skills it delivers and the skill namespaces the member receives (`active`,
 * undefined when every namespace reaches the member), or undefined.
 */
function skillReason(item: ResourceItem, { delivered, excluded, active }: { delivered: readonly ResourceItem[]; excluded: readonly string[]; active: readonly string[] | undefined }): string | undefined {
  if (excluded.includes(item.name)) return `, skill ${item.name}, which the member excludes, so pull leaves it out already and leaving it out changes nothing. ${REMOVE}`;
  if (item.namespace !== undefined && active && !active.includes(item.namespace)) return inactive(item.namespace);
  const standIn = delivered.find((one) => one.name === item.name);
  if (standIn) return inPlace(standIn.relativePath, standIn.namespace);
  return item.namespace === undefined && active ? `, a shared skill, which the arm's roles or projects receive only through a subscribed tag, and none brings it, so leaving it out changes nothing. ${REMOVE}` : undefined;
}

function rulesReason({ listed, files, withIt, without }: Unchanged): string | undefined {
  const namespace = notReceived(listed, files, withIt.context?.activeNamespaces.knowledge);
  if (namespace !== undefined) return inactive(namespace);
  if (withIt.rules.skippedByTags > without.rules.skippedByTags) return `, a rule tagged only with tags the member does not subscribe, so pull leaves it out already and leaving it out changes nothing. ${REMOVE}`;
  return replacing(listed, withIt.rules.overrides);
}

function agentsReason({ listed, short, files, withIt }: Unchanged): string | undefined {
  if (withIt.agents.kind === 'conflict') return noneOf(withIt.agents, short);
  const namespace = notReceived(listed, files, withIt.context?.activeNamespaces.agents);
  return namespace !== undefined ? inactive(namespace) : replacing(listed, withIt.agents.overrides);
}

function claudemdReason({ listed, files, withIt }: Unchanged): string | undefined {
  const namespace = notReceived(listed, files, withIt.context?.activeNamespaces.knowledge);
  return namespace !== undefined ? inactive(namespace) : replacing(listed, withIt.claudemd.overrides);
}

function docsReason({ listed, withIt }: Unchanged): string | undefined {
  const withheld = withIt.docs.withheld.find(({ dir }) => covers(listed, `docs/${dir}`));
  return withheld && inactive(withheld.dir);
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
function replacing(listed: string, overrides: ReadonlyArray<{ source: string; replaces: string }>): string | undefined {
  const override = overrides.find((one) => covers(listed, one.replaces));
  return override && inPlace(override.source, override.source.split('/')[1]);
}

function inPlace(source: string, namespace: string | undefined): string {
  return `, but ${namespace === undefined ? 'the team root' : `its namespace ${namespace}`} delivers ${source} in its place; list ${source} too.`;
}

function inactive(namespace: string): string {
  return `, which is in namespace ${namespace}, and the arm's roles or projects don't receive ${namespace}, so leaving it out changes nothing. ${REMOVE}`;
}

function noneOf(conflict: DeliveryConflict, short: string): string {
  return `, and teamai pull delivers no ${conflict.type}s at team revision ${short} with or without it: ${describeDeliveryConflict(conflict)}. Fix that in the team repo, push it, run teamai pull, and start again.`;
}
