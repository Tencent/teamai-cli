/**
 * What a member should receive from the team repo: the skills, agents, rules
 * and claudemd files of the active namespaces, with the namespace rule applied
 * (#707). `pull` delivers these sets, `doctor` checks what landed against
 * them, and `recall` and `contribute` index them; keeping them in one place is
 * what stops the four from drifting apart.
 */
import path from 'node:path';
import { loadStateForScope, loadTeamConfig } from '../config.js';
import {
  itemCandidate, resolveNamespacedItems, resolveRootOverrides,
  type NamespaceCandidate, type NamespaceConflict, type NamespaceOverride,
} from '../namespace-resolver.js';
import { placedResourcePath } from '../push-namespaces.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import type { ResourceNamespaces } from '../roles.js';
import type { LocalConfig, ResourceItem, TeamaiConfig } from '../types.js';
import { dirContentEqual, fileContentEqual, listDirs, listFiles, pathExists, readFileSafe } from '../utils/fs.js';
import type { BuildIndexOptions, IndexedSkills } from '../utils/search-index.js';
import { filterByTags, loadTagsConfig } from '../utils/tags.js';
import { warnOnce } from '../utils/warn-once.js';
import { deliveredMembers, unionMemberItems } from '../workspace-children.js';
import { resolveAgentsForDirectory } from './agents.js';
import { resolveDocsForDirectory } from './docs.js';
import { getHandler } from './index.js';

export interface RolePullContext {
  activeNamespaces: ResourceNamespaces;
  activeSkillNames: Set<string>;
  inactiveSkillNames: Set<string>;
  /**
   * Map of inactive skill name → its team-repo source directory
   * (`<clone>/skills/<namespace>/<name>`). Cleanup compares the deployed copy
   * against this source and only deletes when they are byte-identical, so a
   * user's local edits or unpushed files are never silently destroyed.
   */
  inactiveSkillSources: Map<string, string>;
  /** Docs namespaces some role or project declares and this member does not have active. */
  inactiveDocsNamespaces: string[];
}

export async function buildRolePullContext(localConfig: LocalConfig): Promise<RolePullContext | null> {
  const resolved = await resolveResourceNamespaces(localConfig);
  if (!resolved) return null;
  const { activeNamespaces, allSkillNamespaces, inactiveDocsNamespaces } = resolved;
  const inactiveSkillNamespaces = [...allSkillNamespaces].filter((namespace) => !activeNamespaces.skills.includes(namespace));
  const activeSkillNames = new Set<string>();
  const inactiveSkillNames = new Set<string>();
  const inactiveSkillSources = new Map<string, string>();

  for (const namespace of activeNamespaces.skills) {
    const namespaceDir = path.join(localConfig.repo.localPath, 'skills', namespace);
    const names = await listDirs(namespaceDir);
    for (const name of names) {
      activeSkillNames.add(name);
    }
  }

  for (const namespace of inactiveSkillNamespaces) {
    const namespaceDir = path.join(localConfig.repo.localPath, 'skills', namespace);
    const names = await listDirs(namespaceDir);
    for (const name of names) {
      inactiveSkillNames.add(name);
      // Record the source dir so cleanup can verify the deployed copy is
      // unmodified before deleting it. (If a name lives in multiple inactive
      // namespaces, keeping the first is fine — cleanup only needs one source to
      // compare against; a mismatch always errs toward keeping the local copy.)
      if (!inactiveSkillSources.has(name)) {
        inactiveSkillSources.set(name, path.join(namespaceDir, name));
      }
    }
  }

  return { activeNamespaces, activeSkillNames, inactiveSkillNames, inactiveSkillSources, inactiveDocsNamespaces };
}

/**
 * Filter rules by the user's active knowledge namespaces.
 *
 * Rules whose name starts with a namespace path (e.g. "common/coding-style")
 * are filtered: only those in activeKnowledgeNamespaces pass through.
 * Root-level rules (no "/" in name) are always included.
 *
 * When knowledgeNamespaces is null (no role configured), all rules pass through.
 */
export function filterRulesByKnowledgeNamespaces(
  rules: ResourceItem[],
  knowledgeNamespaces: string[] | null,
): ResourceItem[] {
  if (!knowledgeNamespaces) return rules;

  return rules.filter((rule) => {
    const slashIndex = rule.name.indexOf('/');
    if (slashIndex === -1) return true; // root-level rule, always include
    const namespace = rule.name.slice(0, slashIndex);
    return knowledgeNamespaces.includes(namespace);
  });
}

/**
 * Two items of one skill or agent name would be delivered here, and both land
 * at one installed path: nothing says which one this member receives. `pull`
 * stops that type for the run and keeps what is installed (#707).
 */
export interface DeliveryConflict {
  readonly kind: 'conflict';
  readonly type: 'skill' | 'agent';
  readonly conflict: NamespaceConflict<ResourceItem>;
}

/** The skills or agents a member should have, or why that cannot be said this run. */
export type DesiredItems =
  | {
    readonly kind: 'resolved';
    readonly items: ResourceItem[];
    /** Which namespace item replaces which root item, for `doctor`. Empty in legacy mode. */
    readonly overrides: readonly NamespaceOverride[];
  }
  | DeliveryConflict;

/** The conflict as one line naming both items' files. */
export function describeDeliveryConflict({ type, conflict }: DeliveryConflict): string {
  const { name, first, second } = conflict;
  const files = `${first.source} and ${second.source}`;
  if (conflict.reason === 'duplicate') {
    const place = first.namespace === null ? 'the root' : `namespace "${first.namespace}"`;
    return `Duplicate ${type} "${name}" in ${place}: ${files}`;
  }
  return `Duplicate ${type} "${name}" found in active namespaces "${first.namespace ?? '(root)'}" `
    + `and "${second.namespace ?? '(root)'}" (${files})`;
}

/**
 * Filter team agents by the active `agents` namespaces, apply the namespace
 * rule, and reject stem collisions among what survives.
 *
 * Same convention as rules: a root-level agent (no `namespace`) ships unless
 * an active namespace agent of the same stem replaces it; `agents/<ns>/x.yaml`
 * ships only when `<ns>` is active. `null` means no role or project is
 * configured and everything passes through.
 *
 * Agents deploy flattened to `<tool>/agents/<stem><ext>`, so two delivered
 * items with one stem would overwrite each other. That is an admin-side layout
 * error, reported the way `scanRoleAwareSkills` reports duplicate skills. In
 * legacy mode every namespace ships, so a root agent and a namespace agent of
 * one stem collide too: nothing says which namespace replaces the root.
 */
export function filterAgentsByNamespaces(
  agents: ResourceItem[],
  agentNamespaces: string[] | null,
  placedAgents?: Record<string, string>,
): DesiredItems {
  if (agentNamespaces === null) {
    // Every agent ships, so each namespace counts as active here, ranked in
    // scan order so the message names the pair the way the scan meets it.
    const shipped = [...new Set(agents.flatMap((agent) => (agent.namespace ? [agent.namespace] : [])))];
    const resolution = resolveNamespacedItems(agents.map(itemCandidate), shipped);
    if (resolution.kind === 'conflict') return { kind: 'conflict', type: 'agent', conflict: resolution };
    const [clash] = resolution.items.flatMap((item) => (item.replaces ? [{ root: item.replaces, namespaced: item }] : []));
    if (clash) {
      return {
        kind: 'conflict',
        type: 'agent',
        conflict: { kind: 'conflict', reason: 'two-namespaces', name: clash.root.name, first: clash.root, second: clash.namespaced },
      };
    }
    return { kind: 'resolved', items: agents, overrides: [] };
  }

  const resolution = resolveAgentsForDirectory(agents, agentNamespaces, placedAgents);
  if (resolution.kind === 'conflict') return { kind: 'conflict', type: 'agent', conflict: resolution };
  const delivered = new Set(resolution.items.map((item) => item.value));
  return {
    kind: 'resolved',
    items: agents.filter((agent) => delivered.has(agent)),
    overrides: resolution.items.flatMap((item) => (item.replaces
      ? [{ name: item.name, source: item.source, replaces: item.replaces.source }]
      : [])),
  };
}

/**
 * The items that are skills: a directory without SKILL.md is not one, so it
 * neither replaces the root skill of its name nor is installed over it, which
 * would strip the installed copy of its SKILL.md. Each one is named once a run.
 */
async function withSkillMd(items: ResourceItem[]): Promise<ResourceItem[]> {
  const skills: ResourceItem[] = [];
  for (const item of items) {
    if (await pathExists(path.join(item.sourcePath, 'SKILL.md'))) {
      skills.push(item);
    } else {
      warnOnce(`${item.relativePath} has no SKILL.md, so it is not delivered as a skill. Add SKILL.md to it in the team repo, or remove it.`);
    }
  }
  return skills;
}

export async function scanRoleAwareSkills(
  localConfig: LocalConfig,
  namespaces: ResourceNamespaces,
): Promise<{ kind: 'resolved'; items: ResourceItem[] } | DeliveryConflict> {
  const items: ResourceItem[] = [];

  for (const namespace of namespaces.skills) {
    const namespaceDir = path.join(localConfig.repo.localPath, 'skills', namespace);
    const dirs = await listDirs(namespaceDir);
    for (const dir of dirs) {
      items.push({
        name: dir,
        type: 'skills',
        sourcePath: path.join(namespaceDir, dir),
        relativePath: `skills/${namespace}/${dir}`,
        namespace,
      });
    }
  }

  const resolution = resolveNamespacedItems((await withSkillMd(items)).map(itemCandidate), namespaces.skills);
  if (resolution.kind === 'conflict') return { kind: 'conflict', type: 'skill', conflict: resolution };
  return { kind: 'resolved', items: resolution.items.map((item) => item.value) };
}

/** What a member should have on disk, and what the team repo holds. */
export type DesiredSkills = Extract<DesiredItems, { kind: 'resolved' }> & {
  /** Every skill in the team repo — the set cleanup is allowed to prune from. */
  readonly teamItems: ResourceItem[];
  /** How many skills the tag channel left out, for the sync line. */
  readonly skippedByTags: number;
  /**
   * Skills a workspace holds back because two of its members deliver
   * different copies of one name (#913). Pull keeps an installed copy of them.
   */
  readonly held: readonly string[];
  /**
   * In a workspace with children (#913), the team skill directories each name
   * comes from in any member, before the union and the workspace's
   * exclusions. Cleanup takes a copy equal to any of them as unedited. Empty
   * for a scope without children.
   */
  readonly memberSources: ReadonlyMap<string, readonly string[]>;
};

/**
 * Resolve the skills this member should have: role namespaces ∪ subscribed
 * tags − exclusions. Read-only: `pull` calls it to decide what to install, and
 * `doctor` calls it to check what landed (#598). Keeping it in one place is the
 * point — re-deriving the union inside the check would put role namespaces,
 * tag subscriptions and exclusions in a second place that drifts on its own.
 *
 * `roleContext` is explicit rather than resolved here: `pullForScope` already
 * holds one (it also drives rules, agents and cleanup), and null means "no roles
 * configured", not "not looked up yet".
 */
export async function resolveDesiredSkills(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  roleContext: RolePullContext | null,
): Promise<DesiredSkills | DeliveryConflict> {
  const members = await deliveredMembers(localConfig);
  if (members) return resolveWorkspaceSkills(teamConfig, localConfig, members);
  const handler = getHandler('skills');
  const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);
  const subscribedTags = localConfig.subscribedTags;
  const excludedSkills = new Set(localConfig.excludedSkills ?? []);

  let directoryItems: ResourceItem[];
  if (roleContext) {
    const scanned = await scanRoleAwareSkills(localConfig, roleContext.activeNamespaces);
    if (scanned.kind === 'conflict') return scanned;
    directoryItems = scanned.items;
  } else {
    directoryItems = await withSkillMd(await handler.scanTeamForPull(teamConfig, localConfig));
  }

  const teamItems = await withSkillMd(await handler.scanTeamForPull(teamConfig, localConfig));

  // Tag channel: only augment when subscriptions are actually active
  const hasActiveTagSubscriptions = tagsConfig != null
    && subscribedTags != null
    && subscribedTags.length > 0;

  let tagIncluded: ResourceItem[] = [];
  let skippedByTags = 0;
  if (hasActiveTagSubscriptions) {
    const tagResult = filterByTags(teamItems, tagsConfig, subscribedTags, 'skills');
    const subscribedTagSet = new Set(subscribedTags);
    tagIncluded = tagResult.included.filter((item) => {
      const itemTags = tagsConfig.skills[item.name];
      return itemTags?.some((tag) => subscribedTagSet.has(tag));
    });
    skippedByTags = tagResult.skipped.length;
  }

  // Union: merge directory items with tag-matched items. A directory item
  // wins, so an active namespace skill replaces the root skill a tag brings
  // (#707). Tags are keyed by name alone, so among tag matches the root skill
  // — the tag catalog — wins over a same-name skill in some other namespace.
  const merged = new Map<string, ResourceItem>();
  for (const item of directoryItems) merged.set(item.name, item);
  const rootFirst = [...tagIncluded].sort((a, b) => Number(a.namespace !== undefined) - Number(b.namespace !== undefined));
  for (const item of rootFirst) {
    if (!merged.has(item.name)) merged.set(item.name, item);
  }

  const items = excludedSkills.size > 0
    ? [...merged.values()].filter((item) => !excludedSkills.has(item.name))
    : [...merged.values()];

  // A delivered namespace skill stands in for the root skill of its name,
  // whether or not a tag would have brought that one.
  const rootSkills = new Map(teamItems.flatMap((item) => (item.namespace ? [] : [[item.name, item.relativePath] as const])));
  const overrides = roleContext
    ? items.flatMap((item) => {
      const replaces = item.namespace ? rootSkills.get(item.name) : undefined;
      return replaces ? [{ name: item.name, source: item.relativePath, replaces }] : [];
    })
    : [];

  return { kind: 'resolved', items, overrides, teamItems, skippedByTags, held: [], memberSources: new Map() };
}

/**
 * The team skill directories a workspace with children delivers skills from
 * (#913): each member's, before the union, absolute. Null for a scope without
 * children. Push sends an edit of one copy several delivered to these only.
 */
export async function deliveredSkillSources(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ReadonlySet<string> | null> {
  const members = await deliveredMembers(localConfig);
  if (!members) return null;
  const excluded = new Set(localConfig.excludedSkills ?? []);
  const sources = new Set<string>();
  for (const member of members) {
    const desired = await resolveDesiredSkills(teamConfig, member, await buildRolePullContext(member));
    if (desired.kind !== 'resolved') continue;
    for (const item of desired.items) if (!excluded.has(item.name)) sources.add(path.resolve(item.sourcePath));
  }
  return sources;
}

/**
 * A workspace's skills (#913): each member's, resolved with that member's
 * namespaces, tags and exclusions, then unioned, with the workspace's own
 * exclusions on top. A conflict inside one member stops skills as it would
 * in that member's own scope.
 */
async function resolveWorkspaceSkills(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  members: readonly LocalConfig[],
): Promise<DesiredSkills | DeliveryConflict> {
  const resolved: DesiredSkills[] = [];
  for (const member of members) {
    const desired = await resolveDesiredSkills(teamConfig, member, await buildRolePullContext(member));
    if (desired.kind === 'conflict') return desired;
    resolved.push(desired);
  }
  const { items, held } = await unionMemberItems({
    perMember: resolved.map((desired) => desired.items),
    nameOf: (item) => item.name,
    sameContent: (a, b) => a.sourcePath === b.sourcePath || dirContentEqual(a.sourcePath, b.sourcePath),
  });
  const excluded = new Set(localConfig.excludedSkills ?? []);
  for (const { name, first, second } of held) {
    // An excluded name is not held, so pull may take its copy out; saying it keeps one would be wrong.
    if (excluded.has(name)) continue;
    warnOnce(`Skill "${name}" differs between ${first.relativePath} and ${second.relativePath}, so this workspace holds it back; an installed copy is kept. Make the copies equal in the team repo, or rename one.`);
  }
  const memberSources = new Map<string, string[]>();
  for (const item of resolved.flatMap((desired) => desired.items)) {
    memberSources.set(item.name, [...memberSources.get(item.name) ?? [], item.sourcePath]);
  }
  const delivered = items.filter((item) => !excluded.has(item.name));
  const sources = new Set(delivered.map((item) => item.relativePath));
  const overrides = [...new Map(resolved.flatMap((desired) => desired.overrides)
    .filter((override) => sources.has(override.source))
    .map((override) => [override.source, override] as const)).values()];
  return {
    kind: 'resolved',
    items: delivered,
    overrides,
    teamItems: resolved[0]?.teamItems ?? [],
    skippedByTags: Math.max(0, ...resolved.map((desired) => desired.skippedByTags)),
    // A held name the workspace excludes is not kept: cleanup decides its copy.
    held: held.map((item) => item.name).filter((name) => !excluded.has(name)),
    memberSources,
  };
}

/**
 * The skills recall indexes, from the skills pull delivers. On a conflict pull
 * keeps the installed skills, so the index keeps the skills it already holds.
 */
export async function indexedSkills(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  roleContext: RolePullContext | null,
): Promise<IndexedSkills> {
  const desired = await resolveDesiredSkills(teamConfig, localConfig, roleContext);
  return desired.kind === 'resolved'
    ? { kind: 'dirs', dirs: desired.items.map((item) => item.sourcePath) }
    : { kind: 'keep-indexed', reason: describeDeliveryConflict(desired) };
}

/** The rules recall indexes, relative to `rules/`: the rules pull delivers. */
export async function indexedRuleFiles(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  roleContext: RolePullContext | null,
): Promise<string[]> {
  const { items } = await resolveDesiredRules(teamConfig, localConfig, roleContext);
  return items.map((item) => path.posix.relative('rules', item.relativePath));
}

/**
 * The docs, rules and skills to index outside `pull` (recall, contribute): the
 * sets pull delivers here, not the whole `docs/`, `rules/` and `skills/` trees.
 * Throws when the scope's manifests cannot be read, as `pull` stops the scope
 * then.
 */
export async function deliveredIndexSources(
  localConfig: LocalConfig,
): Promise<Pick<BuildIndexOptions, 'docFiles' | 'ruleFiles' | 'skills'>> {
  const repoPath = localConfig.repo.localPath;
  const docFiles = await pathExists(path.join(repoPath, 'docs'))
    ? (await resolveDocsForDirectory(localConfig)).files
    : undefined;
  const hasRules = await pathExists(path.join(repoPath, 'rules'));
  const hasSkills = await pathExists(path.join(repoPath, 'skills'));
  if (!hasRules && !hasSkills) return { docFiles };
  const teamConfig = await loadTeamConfig(repoPath);
  // pull delivers nothing to a scope without teamai.yaml.
  if (!teamConfig) return { docFiles, ruleFiles: [], skills: { kind: 'dirs', dirs: [] } };
  const roleContext = await buildRolePullContext(localConfig);
  return {
    docFiles,
    ...(hasRules ? { ruleFiles: await indexedRuleFiles(teamConfig, localConfig, roleContext) } : {}),
    ...(hasSkills ? { skills: await indexedSkills(teamConfig, localConfig, roleContext) } : {}),
  };
}

export interface DesiredRules {
  /**
   * The rules this member should have: active knowledge namespaces ∩ tag
   * subscriptions, with an active namespace rule replacing the root rule of
   * the same first-level file name.
   */
  items: ResourceItem[];
  /** Which rule replaced which, for `doctor`. */
  overrides: NamespaceOverride[];
  /**
   * The root rules an active namespace rule replaces. They are not delivered,
   * and `pullAllRules` withdraws their unchanged copies from the rule
   * directories its stale sweep leaves alone.
   */
  replaced: ResourceItem[];
  /** How many rules the tag channel left out, for the sync line. */
  skippedByTags: number;
}

/**
 * Resolve the rules this member should have. Same contract as
 * `resolveDesiredSkills`, and for the same reason: `pull` calls it to decide
 * what to install and `doctor` calls it to check what landed (#624), so the
 * namespace convention and the tag channel are stated once.
 */
export async function resolveDesiredRules(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  roleContext: RolePullContext | null,
): Promise<DesiredRules> {
  const members = await deliveredMembers(localConfig);
  if (members) return resolveWorkspaceRules(teamConfig, members);
  const handler = getHandler('rules');
  const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);
  const allItems = await handler.scanTeamForPull(teamConfig, localConfig);
  const knowledgeNs = roleContext ? roleContext.activeNamespaces.knowledge : null;
  // The tag channel first: only a namespace rule this member receives
  // replaces the root rule of its name.
  const { included, skipped } = filterByTags(
    filterRulesByKnowledgeNamespaces(allItems, knowledgeNs), tagsConfig, localConfig.subscribedTags, 'rules',
  );
  if (!knowledgeNs) return { items: included, overrides: [], replaced: [], skippedByTags: skipped.length };
  return { ...await overrideRootRules(included, knowledgeNs, localConfig), skippedByTags: skipped.length };
}

/**
 * A workspace's rules (#913): each member's, with that member's namespaces
 * and tags, unioned by path. A rule keeps its path wherever it lands, so two
 * members never compete for one; a root rule one member replaces stays while
 * another member receives it.
 */
async function resolveWorkspaceRules(teamConfig: TeamaiConfig, members: readonly LocalConfig[]): Promise<DesiredRules> {
  const resolved: DesiredRules[] = [];
  for (const member of members) resolved.push(await resolveDesiredRules(teamConfig, member, await buildRolePullContext(member)));
  const items = [...new Map(resolved.flatMap((desired) => desired.items).map((item) => [item.relativePath, item] as const)).values()];
  const delivered = new Set(items.map((item) => item.relativePath));
  const once = <TItem>(list: TItem[], key: (item: TItem) => string): TItem[] => [...new Map(list.map((item) => [key(item), item] as const)).values()];
  return {
    items,
    overrides: once(resolved.flatMap((desired) => desired.overrides), (override) => `${override.source}\0${override.replaces}`).filter((override) => !delivered.has(override.replaces)),
    replaced: once(resolved.flatMap((desired) => desired.replaced), (item) => item.relativePath).filter((item) => !delivered.has(item.relativePath)),
    skippedByTags: Math.max(0, ...resolved.map((desired) => desired.skippedByTags)),
  };
}

/**
 * Root suppression for rules, keyed by first-level file name: an active
 * `rules/<ns>/<name>.md` replaces `rules/<name>.md` (`resolveRootOverrides`),
 * and deeper paths are neither replaced nor replace anything. A root rule this
 * machine placed in a namespace (its record, #649) is replaced by that rule the
 * same way: the author's root copy stands for it, and the shared-root rule of
 * the name would otherwise be delivered onto that copy.
 *
 * Role/project mode only: legacy mode delivers every rule, each at its own path.
 */
async function overrideRootRules(
  rules: ResourceItem[],
  activeNamespaces: string[],
  localConfig: LocalConfig,
): Promise<Pick<DesiredRules, 'items' | 'overrides' | 'replaced'>> {
  const candidates = rules.flatMap((rule): NamespaceCandidate<ResourceItem>[] => {
    const segments = rule.name.split('/');
    if (segments.length === 1) return [{ name: rule.name, source: rule.relativePath, namespace: null, value: rule }];
    const [namespace, name] = segments;
    if (segments.length > 2 || namespace === undefined || name === undefined) return [];
    return [{ name, source: rule.relativePath, namespace, value: rule }];
  });
  const overrides = resolveRootOverrides(candidates, activeNamespaces);
  const replacedPaths = new Set(overrides.map((override) => override.replaces));
  const { placedRules } = await loadStateForScope(localConfig);
  const items: ResourceItem[] = [];
  const replaced: ResourceItem[] = [];
  for (const rule of rules) {
    if (replacedPaths.has(rule.relativePath)) {
      replaced.push(rule);
      continue;
    }
    const placed = rule.name.includes('/') ? null : placedResourcePath(placedRules, 'rules', rule.name);
    if (placed && await pathExists(path.join(localConfig.repo.localPath, placed))) {
      overrides.push({ name: rule.name, source: placed, replaces: rule.relativePath });
      continue;
    }
    items.push(rule);
  }
  return { items, overrides, replaced };
}

/**
 * Resolve the agents this member should have, or the stem collision between
 * two active namespaces that stops `pull` from delivering agents this run: a
 * caller that cannot say what should be delivered must not guess.
 */
export async function resolveDesiredAgents(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  roleContext: RolePullContext | null,
): Promise<DesiredItems> {
  const members = await deliveredMembers(localConfig);
  if (members) return resolveWorkspaceAgents(teamConfig, members);
  const items = await getHandler('agents').scanTeamForPull(teamConfig, localConfig);
  const { placedAgents } = await loadStateForScope(localConfig);
  return filterAgentsByNamespaces(
    items,
    roleContext ? roleContext.activeNamespaces.agents : null,
    placedAgents,
  );
}

/**
 * Collect claudemd .md files filtered by the user's active knowledge namespaces.
 *
 * Root-level claudemd/*.md files are shared with every member; claudemd/<namespace>/*.md
 * is collected for each active namespace, and replaces the root file of the same
 * name (#707); two active namespaces with one file name both stay in the block,
 * in namespace order (`resolveRootOverrides`). With no role configured every
 * subdirectory is collected, beside the root.
 *
 * A workspace with children (#913) collects each member's files with that
 * member's namespaces, then the union, as it does for rules: a root file one
 * member replaces stays while another member receives it.
 */
export async function collectClaudemdFiles(
  localConfig: LocalConfig,
  roleContext: RolePullContext | null,
): Promise<{ contents: string[]; overrides: NamespaceOverride[] }> {
  const repoPath = localConfig.repo.localPath;
  const own = await claudemdCandidates(repoPath, roleContext);
  const members = await deliveredMembers(localConfig);
  const { delivered, overrides } = members ? await workspaceClaudemd(repoPath, members) : claudemdDelivered(own);
  // The workspace's own context activates every namespace a member does, so
  // its candidates hold every member's files, in the order of one scope.
  const contents: string[] = [];
  for (const candidate of own.candidates) {
    if (!delivered.has(candidate.source)) continue;
    const content = await readFileSafe(candidate.value);
    if (content) contents.push(content);
  }
  return { contents, overrides };
}

interface ClaudemdCandidates {
  candidates: NamespaceCandidate<string>[];
  overrides: NamespaceOverride[];
}

async function claudemdCandidates(repoPath: string, roleContext: RolePullContext | null): Promise<ClaudemdCandidates> {
  const claudemdDir = path.join(repoPath, 'claudemd');
  if (!await pathExists(claudemdDir)) return { candidates: [], overrides: [] };

  const mdFiles = async (dir: string): Promise<string[]> => (await listFiles(dir))
    .filter((f) => f.endsWith('.md'))
    .sort();
  const candidates: NamespaceCandidate<string>[] = [];
  for (const file of await mdFiles(claudemdDir)) {
    candidates.push({ name: file, source: `claudemd/${file}`, namespace: null, value: path.join(claudemdDir, file) });
  }

  // Determine which namespace dirs to scan
  let namespaceDirs: string[];
  if (roleContext) {
    namespaceDirs = roleContext.activeNamespaces.knowledge;
  } else {
    // No role configured → scan all subdirectories
    namespaceDirs = await listDirs(claudemdDir);
  }

  for (const ns of namespaceDirs) {
    const nsDir = path.join(claudemdDir, ns);
    if (!await pathExists(nsDir)) continue;
    for (const file of await mdFiles(nsDir)) {
      candidates.push({ name: file, source: `claudemd/${ns}/${file}`, namespace: ns, value: path.join(nsDir, file) });
    }
  }

  return { candidates, overrides: roleContext ? resolveRootOverrides(candidates, namespaceDirs) : [] };
}

function claudemdDelivered({ candidates, overrides }: ClaudemdCandidates): { delivered: Set<string>; overrides: NamespaceOverride[] } {
  const replaced = new Set(overrides.map((override) => override.replaces));
  return { delivered: new Set(candidates.map((candidate) => candidate.source).filter((source) => !replaced.has(source))), overrides };
}

async function workspaceClaudemd(
  repoPath: string,
  members: readonly LocalConfig[],
): Promise<{ delivered: Set<string>; overrides: NamespaceOverride[] }> {
  const resolved: Array<ReturnType<typeof claudemdDelivered>> = [];
  for (const member of members) resolved.push(claudemdDelivered(await claudemdCandidates(repoPath, await buildRolePullContext(member))));
  const delivered = new Set(resolved.flatMap((one) => [...one.delivered]));
  const overrides = [...new Map(resolved.flatMap((one) => one.overrides)
    .map((override) => [`${override.source}\0${override.replaces}`, override] as const)).values()]
    .filter((override) => !delivered.has(override.replaces));
  return { delivered, overrides };
}

/**
 * A workspace's agents (#913): each member's, unioned by stem. A stem two
 * members deliver with the same content is delivered once; one whose copies
 * differ is held back and named, and pull keeps an installed copy of it. A conflict inside one member stops
 * agents as it would in that member's own scope.
 */
async function resolveWorkspaceAgents(teamConfig: TeamaiConfig, members: readonly LocalConfig[]): Promise<DesiredItems> {
  const resolved: Array<Extract<DesiredItems, { kind: 'resolved' }>> = [];
  for (const member of members) {
    const desired = await resolveDesiredAgents(teamConfig, member, await buildRolePullContext(member));
    if (desired.kind === 'conflict') return desired;
    resolved.push(desired);
  }
  const { items, held } = await unionMemberItems({
    perMember: resolved.map((desired) => desired.items),
    nameOf: (item) => item.name,
    sameContent: (a, b) => a.sourcePath === b.sourcePath || fileContentEqual(a.sourcePath, b.sourcePath),
  });
  for (const { name, first, second } of held) {
    warnOnce(`Agent "${name}" differs between ${first.relativePath} and ${second.relativePath}, so this workspace holds it back; an installed copy is kept. Make the copies equal in the team repo, or rename one.`);
  }
  const sources = new Set(items.map((item) => item.relativePath));
  return {
    kind: 'resolved',
    items,
    overrides: [...new Map(resolved.flatMap((desired) => desired.overrides)
      .filter((override) => sources.has(override.source))
      .map((override) => [override.source, override] as const)).values()],
  };
}
