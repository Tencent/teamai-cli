/**
 * Where a workflow copy's install puts knowledge: skills, rules, instruction blocks and agents for each tool it delivers
 * to, as `locate` places them for the copy's config, and the team docs. A copy that runs with a team role must hold all
 * of it inside itself (`roleCopyRefusal`): a place outside it is shared with other checkouts, which would then read the
 * role's knowledge, or the member's would reach the step. The places inside it beyond the agent paths are what the copy's
 * overlay must also put back before a step commits (`copyKnowledgePaths`).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanupOf, installOf, locate, type Location, type Place } from '../../locate.js';
import { resolveDocsDestination } from '../../resources/docs.js';
import { realHost, type Host } from '../../tool-home.js';
import type { LocalConfig, TeamaiConfig } from '../../types.js';
import type { WorkflowFailure } from '../types.js';
import { AGENT_PATHS } from '../worktree.js';

/** The resources `locate` answers for that carry knowledge rather than a channel the member's roles grant. */
const KNOWLEDGE_RESOURCES = ['skills', 'rules', 'blocks', 'agents'] as const;

type KnowledgeResource = (typeof KNOWLEDGE_RESOURCES)[number];

/** Every place a location may hold the resource in: its writes and cleanups when it writes files, its retired ones else. */
function placesOf(location: Location<KnowledgeResource>): readonly Place[] {
  return location.channel === 'files' ? cleanupOf(location) : location.retired.map((retired) => retired.place);
}

/** One knowledge place of the copy's install, with the tool and resource it is for. */
interface KnowledgePlace {
  tool: string;
  resource: KnowledgeResource | 'docs';
  path: string;
}

async function knowledgePlacesOf(team: TeamaiConfig, install: LocalConfig, host: Host): Promise<KnowledgePlace[]> {
  const located = installOf(team, install);
  const places: KnowledgePlace[] = [];

  for (const tool of install.enabledAgents ?? []) {
    for (const resource of KNOWLEDGE_RESOURCES) {
      for (const place of placesOf(await locate(tool, resource, located, host))) places.push({ tool, resource, path: place.path });
    }
  }

  places.push({ tool: 'every tool', resource: 'docs', path: resolveDocsDestination(team, install) });

  return places;
}

/** `file` with symlinked parents resolved: the real path of its nearest existing ancestor, and the rest as written. */
async function resolvedPath(file: string): Promise<string> {
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  const real = await fs.realpath(absolute).catch(() => undefined);

  if (real !== undefined) return real;

  return parent === absolute ? absolute : path.join(await resolvedPath(parent), path.basename(absolute));
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Why the copy `install` governs cannot run with team role `role`: a tool it delivers to would take knowledge from a
 * place outside the copy, or the team docs would land outside it. Undefined when every such place is inside the copy.
 * Checked before anything is delivered there.
 */
export async function roleCopyRefusal(input: { team: TeamaiConfig; install: LocalConfig; role: string; host?: Host }): Promise<WorkflowFailure | undefined> {
  const { team, install, role } = input;

  if (install.projectRoot === undefined) return undefined;
  const copy = await resolvedPath(install.projectRoot);

  for (const place of await knowledgePlacesOf(team, install, input.host ?? realHost())) {
    const resolved = await resolvedPath(place.path);

    if (isInside(copy, resolved)) continue;

    if (place.resource === 'docs') {
      return { code: 'role_unavailable', message: `Role ${role} was not delivered into ${copy}: the team docs land in ${resolved}, outside the copy, where every checkout would read them. Set sharing.docs.localDir in teamai.yaml to a directory inside the project, such as .teamai/docs, or run the step without a role.` };
    }

    return { code: 'role_unavailable', message: `Role ${role} was not delivered into ${copy}: ${place.tool} takes its ${place.resource} from ${resolved}, outside the copy, where every checkout would read them. Run the step on a tool that takes them inside the project, or without a role.` };
  }

  return undefined;
}

/**
 * The paths inside the copy, relative to it, where its install delivers knowledge beyond `AGENT_PATHS`: a team's custom
 * tool paths and the team docs. The copy's overlay covers them too, so a step's commit holds none of what was delivered.
 */
export async function copyKnowledgePaths(input: { team: TeamaiConfig; install: LocalConfig; host?: Host }): Promise<string[]> {
  const { team, install } = input;

  if (install.projectRoot === undefined) return [];
  const copy = await resolvedPath(install.projectRoot);
  const covered = (relative: string): boolean => AGENT_PATHS.some((root) => relative === root || relative.startsWith(`${root}/`));
  const paths = new Set<string>();

  for (const place of await knowledgePlacesOf(team, install, input.host ?? realHost())) {
    const resolved = await resolvedPath(place.path);

    if (!isInside(copy, resolved)) continue;
    const relative = path.relative(copy, resolved).split(path.sep).join('/');

    if (!covered(relative)) paths.add(relative);
  }

  return [...paths].sort();
}
