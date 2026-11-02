/**
 * What `pull` delivers to a scope, summarized by name for the dashboard, and
 * how two such summaries differ. Read-only: it calls the resolvers `pull`
 * uses and never writes, so a preview can compare a selection that is not
 * saved yet with the one that is.
 */
import { loadTeamConfig } from '../config.js';
import type { RolesManifest } from '../roles.js';
import type { ProjectsManifest } from '../projects.js';
import { buildRolePullContext, describeDeliveryConflict, resolveDesiredRules, resolveDesiredSkills } from '../resources/desired.js';
import type { LocalConfig } from '../types.js';

/** The namespace types the page shows: the four a role or project names a directory for. */
export const NAMESPACE_TYPES = ['skills', 'knowledge', 'agents', 'learnings'] as const;

export type NamespaceType = typeof NAMESPACE_TYPES[number];

export type Namespaces = Record<NamespaceType, string[]>;

export function pickNamespaces(resources: Partial<Record<NamespaceType, string[]>>): Namespaces {
  return {
    skills: [...(resources.skills ?? [])],
    knowledge: [...(resources.knowledge ?? [])],
    agents: [...(resources.agents ?? [])],
    learnings: [...(resources.learnings ?? [])],
  };
}

export interface Delivery {
  /** Null when no role or project filters the scope, so every namespace is delivered. */
  namespaces: Namespaces | null;
  skills: string[];
  /** The namespaces the delivered skills sit in. */
  skillNamespaces: string[];
  rules: string[];
  /**
   * Skills a workspace holds back because two members deliver different copies
   * of one name (#913). Pull keeps whatever copy is installed: they neither
   * enter nor leave.
   */
  heldSkills: string[];
  /** Set when two skills of one name would be delivered: pull leaves skills as installed until it is fixed. */
  skillConflict?: string;
}

/**
 * What pull delivers to `config`. Pass the config with its children attached
 * (`readWorkspaceChildren`): a workspace delivers its children's selections
 * too (#913). Throws where pull would fail (an invalid manifest).
 */
export async function resolveDelivery(config: LocalConfig): Promise<Delivery> {
  const teamConfig = await loadTeamConfig(config.repo.localPath);

  if (!teamConfig) return { namespaces: null, skills: [], skillNamespaces: [], rules: [], heldSkills: [] };
  const roleContext = await buildRolePullContext(config);
  const skills = await resolveDesiredSkills(teamConfig, config, roleContext);
  const rules = await resolveDesiredRules(teamConfig, config, roleContext);
  const resolved = skills.kind === 'resolved' ? skills : null;

  const delivery: Delivery = {
    namespaces: roleContext ? pickNamespaces(roleContext.activeNamespaces) : null,
    skills: (resolved?.items ?? []).map((item) => item.name).sort(),
    skillNamespaces: [...new Set((resolved?.items ?? []).flatMap((item) => (item.namespace ? [item.namespace] : [])))].sort(),
    rules: rules.items.map((item) => item.name).sort(),
    heldSkills: [...(resolved?.held ?? [])].sort(),
  };

  if (skills.kind === 'conflict') delivery.skillConflict = describeDeliveryConflict(skills);

  return delivery;
}

/**
 * Every namespace an unfiltered scope receives: each one a role or project
 * declares, and each one the delivered skills and rules sit in. Comparing a
 * filtered side against this, not against nothing, is what makes a switch
 * from unfiltered delivery show the namespaces that leave.
 */
function everyNamespace(manifests: Manifests, delivery: Delivery): Namespaces {
  const declared = [...(manifests.roles?.roles ?? []), ...(manifests.projects?.projects ?? [])]
    .map((entry): Partial<Namespaces> => entry.resources);

  const union = (type: NamespaceType, seen: string[]) => [...new Set([...declared.flatMap((resources) => resources[type] ?? []), ...seen])].sort();
  const ruleNamespaces = delivery.rules.flatMap((name) => (name.includes('/') ? [name.split('/')[0]] : []));

  return {
    skills: union('skills', delivery.skillNamespaces),
    knowledge: union('knowledge', ruleNamespaces),
    agents: union('agents', []),
    learnings: union('learnings', []),
  };
}

interface Manifests {
  roles: RolesManifest | null;
  projects: ProjectsManifest | null;
}

function diff(before: readonly string[], after: readonly string[]) {
  return { entering: after.filter((item) => !before.includes(item)), leaving: before.filter((item) => !after.includes(item)) };
}

/** What changes between two deliveries, the way the next pull would carry it out. */
export function diffDelivery(before: Delivery, after: Delivery, manifests: Manifests) {
  // An unfiltered side receives every namespace, not none.
  const namespacesOf = (side: Delivery) => side.namespaces ?? everyNamespace(manifests, side);
  const [from, to] = [namespacesOf(before), namespacesOf(after)];
  // A held skill keeps its installed copy, and a skill conflict leaves every
  // skill as installed: neither is a skill leaving.
  const skills = after.skillConflict ? { entering: [], leaving: [] } : diff(before.skills, after.skills);
  const conflict: Pick<Delivery, 'skillConflict'> = {};

  if (after.skillConflict) conflict.skillConflict = after.skillConflict;

  return {
    unfiltered: { before: before.namespaces === null, after: after.namespaces === null },
    namespaces: {
      skills: diff(from.skills, to.skills),
      knowledge: diff(from.knowledge, to.knowledge),
      agents: diff(from.agents, to.agents),
      learnings: diff(from.learnings, to.learnings),
    },
    skills: { entering: skills.entering, leaving: skills.leaving.filter((name) => !after.heldSkills.includes(name)), held: after.heldSkills },
    rules: diff(before.rules, after.rules),
    ...conflict,
  };
}
