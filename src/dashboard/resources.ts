/**
 * The rules inventory behind the dashboard's Resources page (#1028): every
 * rule in the team repo, with whether `pull` delivers it to this scope and,
 * when it does not, which channel left it out. `resolveDesiredRules` already
 * states what pull delivers (namespace rule, tag channel, root override), so
 * it decides `delivered`; the two filters run once more here only to attribute
 * each undelivered rule to the channel that dropped it. Metadata only — the
 * dashboard must not return rule bodies or environment values.
 */
import matter from 'gray-matter';
import { buildRolePullContext, filterRulesByKnowledgeNamespaces, resolveDesiredRules } from '../resources/desired.js';
import { getHandler } from '../resources/index.js';
import { filterByTags, loadTagsConfig } from '../utils/tags.js';
import { deliveredMembers } from '../workspace-children.js';
import { readFileSafe } from '../utils/fs.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

export interface DashboardRule {
  /** The rule's team name: `ns/name` for a namespaced rule, `name` at the root. */
  name: string;
  /** The namespace segment, or null for a root rule delivered to everyone. */
  namespace: string | null;
  /** Path inside the team repo, e.g. `rules/common/style.md`. */
  path: string;
  /** The frontmatter `description`, when the rule file carries one. */
  description: string | null;
  delivered: boolean;
  /** Why pull leaves the rule out; only set on an undelivered rule. */
  undeliveredReason: 'namespace' | 'tags' | 'replaced' | undefined;
}

/** One rule's frontmatter description, or null: the page lists metadata only. */
async function ruleDescription(sourcePath: string): Promise<string | null> {
  const raw = await readFileSafe(sourcePath);
  if (raw === null) return null;
  try {
    const { data } = matter(raw);
    const description = (data as { description?: unknown }).description;
    return typeof description === 'string' && description.trim() !== '' ? description.trim() : null;
  } catch {
    // Damaged frontmatter must not take the whole listing down.
    return null;
  }
}

/**
 * Every rule in the team repo with its delivery state for this scope, sorted
 * by name. Read-only, like `doctor`'s view of the same sets.
 */
export async function collectRulesInventory(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  roleContext: Awaited<ReturnType<typeof buildRolePullContext>>,
): Promise<DashboardRule[]> {
  const allItems = await getHandler('rules').scanTeamForPull(teamConfig, localConfig);
  if (allItems.length === 0) return [];
  const { items, overrides, replaced } = await resolveDesiredRules(teamConfig, localConfig, roleContext);
  const delivered = new Set(items.map((item) => item.relativePath));
  // A root rule an active namespace rule (or the author's own namespaced copy
  // of it, by its placed record) stands for — pull delivers that one instead.
  const superseded = new Set([
    ...replaced.map((item) => item.relativePath),
    ...overrides.map((override) => override.replaces),
  ]);
  // The two channels below only label what the sets above left undelivered.
  // In a workspace with children each member reads its own (#913): a rule is
  // outside the namespaces when no member's hold it, and left out by tags when
  // every member whose namespaces hold it skips it.
  const members = await deliveredMembers(localConfig);
  const channels = members
    ? await Promise.all(members.map(async (member) => ({ member, roleContext: await buildRolePullContext(member) })))
    : [{ member: localConfig, roleContext }];
  const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);
  const inNamespace = new Set<string>();
  const tagIncluded = new Set<string>();
  for (const channel of channels) {
    const knowledgeNs = channel.roleContext ? channel.roleContext.activeNamespaces.knowledge : null;
    const namespaced = filterRulesByKnowledgeNamespaces(allItems, knowledgeNs);
    for (const item of namespaced) inNamespace.add(item.relativePath);
    const { included } = filterByTags(namespaced, tagsConfig, channel.member.subscribedTags, 'rules');
    for (const item of included) tagIncluded.add(item.relativePath);
  }

  const rules: DashboardRule[] = [];
  for (const item of allItems) {
    const [namespace] = item.name.split('/');
    const root = item.name.split('/').length === 1;
    let undeliveredReason: DashboardRule['undeliveredReason'];
    if (delivered.has(item.relativePath)) undeliveredReason = undefined;
    else if (superseded.has(item.relativePath)) undeliveredReason = 'replaced';
    else if (!inNamespace.has(item.relativePath)) undeliveredReason = 'namespace';
    else if (!tagIncluded.has(item.relativePath)) undeliveredReason = 'tags';
    else undeliveredReason = 'replaced';
    rules.push({
      name: item.name,
      namespace: root ? null : namespace ?? null,
      path: item.relativePath,
      description: await ruleDescription(item.sourcePath),
      delivered: undeliveredReason === undefined,
      undeliveredReason,
    });
  }
  return rules.sort((a, b) => a.name.localeCompare(b.name));
}
