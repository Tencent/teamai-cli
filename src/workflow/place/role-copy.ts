/**
 * Where a workflow copy's install puts knowledge: skills, rules, instruction blocks and agents for each tool it delivers
 * to, as `locate` places them for the copy's config, and the team docs. A copy that runs with a team role must hold all
 * of it inside itself (`roleCopyRefusal`): a place outside it is shared with other checkouts, which would then read the
 * role's knowledge, or the member's would reach the step. The places inside it beyond the agent paths are what the copy's
 * overlay must also put back before a step commits (`copyKnowledgePaths`).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { clearCheckoutRole, recordCheckoutRole, withCheckoutRole, type CheckoutRoleWrite } from '../../checkout-roles.js';
import { detectProjectConfig, loadTeamConfig } from '../../config.js';
import { cleanupOf, installOf, KNOWLEDGE_RESOURCES, locate, resolvedPathOn, type KnowledgeResource, type Location, type Place } from '../../locate.js';
import type { PullDelivery } from '../../pull.js';
import { resolveDocsDestination } from '../../resources/docs.js';
import { roleDeclaration, type RoleDeclaration } from '../../roles.js';
import { realHost, type Host } from '../../tool-home.js';
import { getProjectSearchIndexPath, selfModeGitignorePath, type LocalConfig, type TeamaiConfig } from '../../types.js';
import { getHeadCommit } from '../../utils/git.js';
import { log } from '../../utils/logger.js';
import type { Executor } from '../requirements.js';
import type { WorkflowFailure } from '../types.js';
import { AGENT_PATHS } from '../worktree.js';

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

/**
 * Every knowledge place of `install` for each tool it delivers to, including those a role copy's `locate` leaves out
 * because they are outside the copy, so a caller sees which tool would lose one.
 */
async function knowledgePlacesOf(team: TeamaiConfig, install: LocalConfig, host: Host): Promise<KnowledgePlace[]> {
  const installed = installOf(team, install);
  const located = installed.scope === 'project' ? { ...installed, keepsKnowledgeInside: false } : installed;
  const places: KnowledgePlace[] = [];

  for (const tool of install.enabledAgents ?? []) {
    for (const resource of KNOWLEDGE_RESOURCES) {
      for (const place of placesOf(await locate(tool, resource, located, host))) places.push({ tool, resource, path: place.path });
    }
  }

  places.push({ tool: 'every tool', resource: 'docs', path: resolveDocsDestination(team, install) });

  return places;
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
  const host = input.host ?? realHost();
  const copy = await resolvedPathOn(host, install.projectRoot);

  for (const place of await knowledgePlacesOf(team, install, host)) {
    const resolved = await resolvedPathOn(host, place.path);

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
 * tool paths and the team docs, and in self mode the tracked `.teamai/.gitignore` its pull may rewrite. The copy's
 * overlay covers them too, so a step's commit holds none of what was delivered.
 */
export async function copyKnowledgePaths(input: { team: TeamaiConfig; install: LocalConfig; host?: Host }): Promise<string[]> {
  const { team, install } = input;

  if (install.projectRoot === undefined) return [];
  const host = input.host ?? realHost();
  const copy = await resolvedPathOn(host, install.projectRoot);
  const covered = (relative: string): boolean => AGENT_PATHS.some((root) => relative === root || relative.startsWith(`${root}/`));
  const paths = new Set<string>();
  const gitignore = selfModeGitignorePath(install);

  for (const place of [...await knowledgePlacesOf(team, install, host), ...gitignore ? [{ path: gitignore }] : []]) {
    const resolved = await resolvedPathOn(host, place.path);

    if (!isInside(copy, resolved)) continue;
    const relative = path.relative(copy, resolved).split(path.sep).join('/');

    if (!covered(relative)) paths.add(relative);
  }

  return [...paths].sort();
}

/** Why a copy's own pull did not give it a role, as its checkout record shows. */
export type RoleDeliveryGap =
  | { kind: 'not_loaded'; loaded: string | undefined }
  | { kind: 'incomplete'; tool: string; gap: string }
  | { kind: 'other_role'; tool: string; delivered: string | undefined };

/**
 * Why `install`, the config of a copy as every teamai in it loads it, did not get role `role` for each of `tools`, or
 * undefined when it did: it loads the role, and its checkout record holds a complete delivery made for that role.
 */
async function roleDeliveryGap(input: { install: LocalConfig; tools: readonly string[]; role: string }): Promise<RoleDeliveryGap | undefined> {
  const loaded = await withCheckoutRole(input.install);

  if (loaded.stepRole !== input.role) return { kind: 'not_loaded', loaded: loaded.stepRole };
  const { teamDelivery } = await import('../../pull.js');

  for (const tool of input.tools) {
    const delivery = await teamDelivery(loaded, tool).catch(() => undefined);

    if (!delivery?.complete) return { kind: 'incomplete', tool, gap: delivery?.gap ?? 'its record cannot be read' };
    const delivered = delivery.record.selection?.stepRole;

    if (delivered !== input.role) return { kind: 'other_role', tool, delivered };
  }

  return undefined;
}

/** Why a worktree copy did not get its step's role: one of the checks setup and launch make, in the order they make them. */
type WorktreeRoleGap =
  | { kind: 'no_project_install' }
  | { kind: 'no_team_config'; repo: string }
  | { kind: 'undeclared'; declaration: Exclude<RoleDeclaration, { kind: 'declared' }> }
  | { kind: 'role_file'; written: Exclude<CheckoutRoleWrite, { kind: 'recorded' }> }
  | { kind: 'pull'; delivery: Exclude<PullDelivery, 'delivered' | 'unchanged'> }
  | RoleDeliveryGap;

/** Why a clone did not get its step's role: one of the checks its setup and launch make, at the team revision it installs. */
export type CloneRoleGap =
  | { kind: 'no_install' }
  | { kind: 'no_team_config'; revision: string }
  | { kind: 'undeclared'; declaration: Exclude<RoleDeclaration, { kind: 'declared' }>; revision: string }
  | { kind: 'role_file'; written: Exclude<CheckoutRoleWrite, { kind: 'recorded' }> }
  | { kind: 'pull_exited'; ref: string; code: number; output: string }
  | RoleDeliveryGap;

/**
 * Why step `step` runs without its role `role`, by the copy that should hold it: a worktree `dir`, which retrying the
 * step prepares again; a clone, which a run cannot retry, so its fix is to start the workflow again; or none, as a lease
 * from another teamai names no copy.
 */
export type RoleNotDelivered =
  | { copy: 'worktree'; dir: string; gap: WorktreeRoleGap }
  | { copy: 'clone'; gap: CloneRoleGap }
  | { copy: 'none' };

/** The `role_unavailable` failure of step `step`, which runs without role `role` for `notDelivered`. */
export function roleNotDeliveredFailure(input: { role: string; step: string; notDelivered: RoleNotDelivered }): WorkflowFailure {
  const { role, step, notDelivered } = input;
  const failed = (message: string): WorkflowFailure => ({ code: 'role_unavailable', message });

  switch (notDelivered.copy) {
    case 'worktree':
      return failed(worktreeRoleMessage({ role, step, dir: notDelivered.dir, gap: notDelivered.gap }));
    case 'clone':
      return failed(cloneRoleMessage({ role, step, gap: notDelivered.gap }));
    case 'none':
      return failed(`Role ${role} was not delivered for step "${step}": its lease names no copy for teamai to deliver the role into. Update teamai, then retry the step.`);
    default: {
      const unhandled: never = notDelivered;

      return unhandled;
    }
  }
}

/** Why the worktree copy `dir` of step `step` did not get role `role`, and how to retry the step. */
function worktreeRoleMessage(input: { role: string; step: string; dir: string; gap: WorktreeRoleGap }): string {
  const { role, step, dir, gap } = input;

  switch (gap.kind) {
    case 'no_project_install':
      return `Role ${role} was not delivered into the copy for step "${step}": no project install of teamai governs ${dir}, and only one delivers a step's role. Run teamai init in the project, then retry the step.`;
    case 'no_team_config':
      return `Role ${role} was not delivered into the copy for step "${step}": teamai.yaml in the team repo is missing or does not parse (${gap.repo}), so where the copy's knowledge would land is unknown. Run teamai pull in ${dir} to see why, fix teamai.yaml, then retry the step.`;
    case 'undeclared':
      switch (gap.declaration.kind) {
        case 'undeclared':
          return `Role ${role} was not delivered into the copy for step "${step}": manifest/roles.yaml in the team repo does not declare it (it declares ${gap.declaration.ids.join(', ') || 'no role'}), so the copy would get no role's knowledge. Add the role to manifest/roles.yaml, push it and run teamai pull, or give the step a role it declares, then retry the step.`;
        case 'missing':
          return `Role ${role} was not delivered into the copy for step "${step}": the team repo has no manifest/roles.yaml, so it declares no role and the copy would get no role's knowledge. Add manifest/roles.yaml declaring the role, push it and run teamai pull, or run the step without a role, then retry the step.`;
        case 'unreadable':
          return `Role ${role} was not delivered into the copy for step "${step}": manifest/roles.yaml in the team repo cannot be read (${gap.declaration.error}). Fix it, push it and run teamai pull, then retry the step.`;
        default: {
          const unhandled: never = gap.declaration;

          return unhandled;
        }
      }

    case 'role_file':
      switch (gap.written.kind) {
        case 'busy':
          return `Role ${role} was not delivered into the copy for step "${step}": another teamai held ${gap.written.lock} too long. Retry the step.`;
        case 'unreadable':
          return `Role ${role} was not delivered into the copy for step "${step}": ${gap.written.file} cannot be read (${gap.written.error}). Delete it, then retry the step.`;
        default: {
          const unhandled: never = gap.written;

          return unhandled;
        }
      }

    case 'pull':
      switch (gap.delivery) {
        case 'skipped':
          return `Role ${role} was not delivered into the copy for step "${step}": its pull was skipped, as another teamai held the team's sync lock past the wait, so the copy may hold what an earlier pull delivered. Retry the step once that pull ends.`;
        case 'failed':
          return `Role ${role} was not delivered into the copy for step "${step}": its pull did not deliver everything. Run teamai pull in ${dir} to see why, fix it, then retry the step.`;
        default: {
          const unhandled: never = gap.delivery;

          return unhandled;
        }
      }

    case 'not_loaded':
      return `Role ${role} was not delivered into the copy for step "${step}": teamai in ${dir} loads ${gap.loaded ?? 'no role'} for it, as something changed checkout-roles.json since setup. Retry the step.`;
    case 'incomplete':
      return `Role ${role} was not delivered into the copy for step "${step}": its pull did not record a complete delivery for ${gap.tool} (${gap.gap}). Run teamai pull in ${dir} to see why, fix it, then retry the step.`;
    case 'other_role':
      return `Role ${role} was not delivered into the copy for step "${step}": its last pull delivered for ${gap.delivered ?? 'the member\'s roles'} instead. Retry the step.`;
    default: {
      const unhandled: never = gap;

      return unhandled;
    }
  }
}

/** Why the clone of step `step` did not get role `role`, and how to run it again, as a run with a clone cannot be retried. */
function cloneRoleMessage(input: { role: string; step: string; gap: CloneRoleGap }): string {
  const { role, step, gap } = input;

  switch (gap.kind) {
    case 'no_install':
      return `Role ${role} was not delivered into the clone for step "${step}": teamai prepared no clone with a team install on this machine. Start the workflow again, as a run with a clone cannot be retried.`;
    case 'no_team_config':
      return `Role ${role} was not delivered into the clone for step "${step}": teamai.yaml at team revision ${gap.revision} is missing or does not parse, so where the clone's knowledge would land is unknown. Fix teamai.yaml at that revision, or run the step on another revision.`;
    case 'undeclared':
      switch (gap.declaration.kind) {
        case 'undeclared':
          return `Role ${role} was not delivered into the clone for step "${step}": manifest/roles.yaml at team revision ${gap.revision} does not declare it, so the clone would get no role's knowledge. Add the role to manifest/roles.yaml at that revision, or run the step with a role it declares.`;
        case 'missing':
          return `Role ${role} was not delivered into the clone for step "${step}": team revision ${gap.revision} has no manifest/roles.yaml, so it declares no role and the clone would get no role's knowledge. Add manifest/roles.yaml declaring the role at that revision, or run the step without a role.`;
        case 'unreadable':
          return `Role ${role} was not delivered into the clone for step "${step}": manifest/roles.yaml at team revision ${gap.revision} cannot be read (${gap.declaration.error}). Fix it at that revision, or run the step on another revision.`;
        default: {
          const unhandled: never = gap.declaration;

          return unhandled;
        }
      }

    case 'role_file':
      switch (gap.written.kind) {
        case 'busy':
          return `Role ${role} was not delivered into the clone for step "${step}": another teamai held ${gap.written.lock} too long. Start the workflow again, as a run with a clone cannot be retried.`;
        case 'unreadable':
          return `Role ${role} was not delivered into the clone for step "${step}": ${gap.written.file} cannot be read (${gap.written.error}). Delete it, then start the workflow again, as a run with a clone cannot be retried.`;
        default: {
          const unhandled: never = gap.written;

          return unhandled;
        }
      }

    case 'pull_exited':
      return `Role ${role} was not delivered into the clone for step "${step}": its teamai pull --team-ref ${gap.ref} exited ${gap.code}: ${gap.output}`;
    case 'not_loaded':
      return `Role ${role} was not delivered into the clone for step "${step}": the clone's install does not load it (it loads ${gap.loaded ?? 'no role'}). Start the workflow again, as a run with a clone cannot be retried.`;
    case 'incomplete':
      return `Role ${role} was not delivered into the clone for step "${step}": its pull did not record a complete delivery for ${gap.tool} (${gap.gap}). Start the workflow again, as a run with a clone cannot be retried.`;
    case 'other_role':
      return `Role ${role} was not delivered into the clone for step "${step}": its pull delivered for ${gap.delivered ?? 'the member\'s roles'} instead. Start the workflow again, as a run with a clone cannot be retried.`;
    default: {
      const unhandled: never = gap;

      return unhandled;
    }
  }
}

/**
 * Sets up what the worktree copy `dir` runs step `step` with, before the base agent configuration goes on and its pull
 * delivers: with `role`, after checking a project install governs the copy, the team declares the role, the team docs
 * land inside the copy and, for a prompt step, every knowledge place of `tool` (each tool the install delivers to
 * without one) is inside it, the copy is recorded to run with the role; without, any role an earlier step recorded for
 * it is cleared. Answers the paths the copy's overlay covers: the agent paths and the copy's other knowledge places, so
 * no delivered file is committed as the step's edit; and the tools whose delivery of the role `worktreeRoleProblem`
 * then checks, those the step launches.
 */
export async function setUpWorktreeRole(input: { dir: string; step: string; executor: Executor; role?: string; tool?: string }): Promise<{ paths: readonly string[]; tools: readonly string[] } | WorkflowFailure> {
  const { dir, step, role } = input;
  const install = await detectProjectConfig(dir);
  const project = install?.scope === 'project' ? install : undefined;
  const team = project ? await loadTeamConfig(project.repo.localPath).catch(() => null) : null;
  const paths = [...AGENT_PATHS, ...project && team ? await copyKnowledgePaths({ team, install: project }) : []];

  if (role === undefined) {
    const cleared = project ? await clearCheckoutRole({ config: project, checkout: dir }) : { kind: 'recorded' as const };

    switch (cleared.kind) {
      case 'recorded':
        return { paths, tools: [] };
      // Every teamai that loads an unreadable checkout-roles.json runs with no role (`withCheckoutRole`), as this step must.
      case 'unreadable':
        return { paths, tools: [] };
      case 'busy':
        return { code: 'role_unavailable', message: `The role an earlier step ran with in the copy for step "${step}" could not be cleared: another teamai held ${cleared.lock} too long, and the step would run with that role. Retry the step.` };
      default: {
        const unhandled: never = cleared;

        return unhandled;
      }
    }
  }

  const refused = (gap: WorktreeRoleGap): WorkflowFailure => roleNotDeliveredFailure({ role, step, notDelivered: { copy: 'worktree', dir, gap } });

  if (!project) return refused({ kind: 'no_project_install' });
  const declaration = await roleDeclaration(project.repo.localPath, role);

  if (declaration.kind !== 'declared') return refused({ kind: 'undeclared', declaration });

  if (!team) return refused({ kind: 'no_team_config', repo: project.repo.localPath });
  // Only a tool the step launches needs its knowledge places, and a command launches none: for every other tool, a place
  // outside the copy is no place (`locate`).
  const tools = launchedTools({ executor: input.executor, tool: input.tool, enabled: project.enabledAgents ?? [] });
  const outside = await roleCopyRefusal({ team, install: { ...project, enabledAgents: tools }, role });

  if (outside) return outside;
  const written = await recordCheckoutRole({ config: project, checkout: dir, role });

  if (written.kind !== 'recorded') return refused({ kind: 'role_file', written });

  return { paths, tools };
}

/** The tools a step of `executor` launches in a copy: none for a command, else its `tool`, or any tool `enabled`. */
export function launchedTools(input: { executor: Executor; tool: string | undefined; enabled: readonly string[] }): string[] {
  switch (input.executor) {
    case 'command':
      return [];
    case 'prompt':
      return input.tool !== undefined ? [input.tool] : [...input.enabled];
    default: {
      const unhandled: never = input.executor;

      return unhandled;
    }
  }
}

/**
 * Why step `step` must not run in the worktree copy `dir` with role `role` on `tools`, the tools it launches there, or
 * undefined when it may: the copy's pull, whose outcome setup passes as `delivery`, delivered for the role, the copy
 * loads it, and its record says so for each tool. Checked as setup ends and again right before launch, as something may
 * have pulled there since.
 */
export async function worktreeRoleProblem(input: { dir: string; step: string; role: string; tools: readonly string[]; delivery?: PullDelivery }): Promise<WorkflowFailure | undefined> {
  const { dir, step, role, tools, delivery } = input;
  const refused = (gap: WorktreeRoleGap): WorkflowFailure => roleNotDeliveredFailure({ role, step, notDelivered: { copy: 'worktree', dir, gap } });

  switch (delivery) {
    case 'skipped':
    case 'failed':
      return refused({ kind: 'pull', delivery });
    case undefined:
    case 'delivered':
    case 'unchanged':
      break;
    default: {
      const unhandled: never = delivery;

      return unhandled;
    }
  }

  const install = await detectProjectConfig(dir);

  if (install?.scope !== 'project') return refused({ kind: 'no_project_install' });
  const gap = await roleDeliveryGap({ install, tools, role });

  return gap && refused(gap);
}

/**
 * Why step `step` must not run in its clone with role `role` on `tools`, the tools it launches there, or undefined when
 * it may: each of `tools` takes the role's knowledge inside the clone, `install`, the clone's own install as every
 * teamai in the clone loads it, delivered the role, and its record says so for each tool. Checked as the clone's setup
 * ends, as each later step in it is prepared, and again right before launch.
 */
export async function cloneRoleProblem(input: { install: LocalConfig; step: string; role: string; tools: readonly string[] }): Promise<WorkflowFailure | undefined> {
  const { install, step, role, tools } = input;
  const team = await loadTeamConfig(install.repo.localPath).catch(() => null);

  if (!team) {
    const revision = await getHeadCommit(install.repo.localPath) ?? 'HEAD';

    return roleNotDeliveredFailure({ role, step, notDelivered: { copy: 'clone', gap: { kind: 'no_team_config', revision } } });
  }

  const outside = await roleCopyRefusal({ team, install: { ...install, enabledAgents: [...tools] }, role });

  if (outside) return outside;
  const gap = await roleDeliveryGap({ install, tools, role });

  return gap && roleNotDeliveredFailure({ role, step, notDelivered: { copy: 'clone', gap } });
}

/**
 * Releases what the worktree copy `dir` ran with a role: its search index and its entry in checkout-roles.json. A copy
 * that runs with none has neither. A role file still busy after the wait keeps the entry, which the next setup of a copy
 * at that path clears or replaces.
 */
export async function releaseWorktreeRole(dir: string): Promise<void> {
  const install = await detectProjectConfig(dir).catch(() => null);

  if (install?.stepRole === undefined) return;
  await fs.rm(getProjectSearchIndexPath(install), { force: true });
  const cleared = await clearCheckoutRole({ config: install, checkout: dir });

  switch (cleared.kind) {
    case 'recorded':
      break;
    case 'busy':
      log.warn(`The role of workflow copy ${dir} stays recorded: another teamai held ${cleared.lock} too long. A later copy at that path clears it.`);
      break;
    case 'unreadable':
      log.warn(`The role of workflow copy ${dir} stays recorded: ${cleared.file} cannot be read (${cleared.error}). Delete it.`);
      break;
    default: {
      const unhandled: never = cleared;
      void unhandled;
    }
  }
}
