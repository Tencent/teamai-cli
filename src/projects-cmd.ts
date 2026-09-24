import path from 'node:path';
import YAML from 'yaml';
import {
  autoDetectInit,
  loadLocalConfig,
  saveLocalConfig,
  saveLocalConfigForScope,
  loadStateForScope,
  saveStateForScope,
} from './config.js';
import {
  loadProjectsManifest,
  saveProjectsManifest,
  validateProjectsManifest,
  findProject,
  listProjectIds,
  describeProjects,
  unknownProjectMessage,
  PROJECT_RESOURCE_TYPES,
} from './projects.js';
import type { ProjectsManifest, TeamProject } from './projects.js';
import { pullLatest, runManifestEdit, pushManifestChange } from './manifest-edit.js';
import { readFileSafe, listFiles } from './utils/fs.js';
import { pullRepo } from './utils/git.js';
import { log } from './utils/logger.js';
import { MemberConfigSchema } from './types.js';
import { memberReadRoots } from './members.js';
import type { GlobalOptions } from './types.js';

function parseIds(input: string[]): string[] {
  // Accept both repeated flags and comma-separated values.
  const flat = input.flatMap((s) => s.split(','));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of flat) {
    const id = raw.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// ─── projects list ──────────────────────────────────────

export async function projectsList(_options: GlobalOptions): Promise<void> {
  const { localConfig } = await autoDetectInit();
  const repoPath = localConfig.repo.localPath;

  const manifest = await loadProjectsManifest(repoPath);
  if (!manifest) {
    log.info('This team repo defines no projects (no manifest/projects.yaml).');
    log.info('Projects are optional — resources fall back to roles + shared learnings.');
    return;
  }

  console.log('');
  console.log(`Projects manifest (version ${manifest.version}):`);
  console.log('');
  if (manifest.projects.length === 0) {
    console.log('  (no projects defined)');
  }
  for (const project of manifest.projects) {
    const label = project.name ? `${project.id} — ${project.name}` : project.id;
    console.log(`  ${label}`);
    if (project.description) console.log(`    ${project.description}`);
    console.log(`    skills:    ${project.resources.skills.join(', ') || '(none)'}`);
    console.log(`    knowledge: ${project.resources.knowledge.join(', ') || '(none)'}`);
    console.log(`    learnings: ${project.resources.learnings.join(', ') || '(none)'}`);
    console.log('');
  }

  const active = localConfig.projects ?? [];
  if (active.length > 0) {
    console.log(`Your active projects (this directory): ${active.join(', ')}`);
  } else {
    console.log('No active projects in this directory. Run `teamai projects set <id>` to set them.');
  }
}

// ─── projects set ───────────────────────────────────────

export async function projectsSet(
  ids: string[],
  _options: GlobalOptions,
): Promise<void> {
  const { localConfig } = await autoDetectInit();
  const repoPath = localConfig.repo.localPath;

  const manifest = await loadProjectsManifest(repoPath);
  if (!manifest) {
    log.error('This team repo defines no projects (no manifest/projects.yaml).');
    return;
  }

  const requested = parseIds(ids);
  const validIds = new Set(listProjectIds(manifest));
  for (const id of requested) {
    if (!validIds.has(id)) {
      log.error(`Unknown project "${id}". Valid projects: ${[...validIds].join(', ') || '(none)'}`);
      return;
    }
  }

  // Overwrite semantics for this directory (contrast the member roster, which appends).
  const updatedConfig = { ...localConfig, projects: requested };

  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    await saveLocalConfigForScope(updatedConfig, localConfig.scope, localConfig.projectRoot);
  } else {
    await saveLocalConfig(updatedConfig);
  }

  // Invalidate pull cache so the next pull does a full sync + cleanup of the
  // now-inactive projects' resources.
  try {
    const state = await loadStateForScope(localConfig);
    state.lastPullRev = null;
    await saveStateForScope(state, localConfig);
  } catch {
    // Non-critical: a missing state file means the next pull is a full sync anyway.
  }

  if (requested.length > 0) {
    log.success(`Active projects set to: ${requested.join(', ')}`);
  } else {
    log.success('Active projects cleared (this directory now syncs role + shared learnings only).');
  }
  log.info('Run `teamai pull` to sync resources for your updated projects.');
}

// ─── projects members ───────────────────────────────────

export async function projectsMembers(
  projectId: string,
  _options: GlobalOptions,
): Promise<void> {
  const { localConfig } = await autoDetectInit();

  // Members live on the teamai-reports orphan branch for non-HTTP repos; the
  // projects manifest is knowledge on the default branch. Split the two roots:
  // the clone's members/ is a read-only inherited root for pre-switch files.
  const knowledgePath = localConfig.repo.localPath;
  let membersRoot = knowledgePath;
  const { usesBranchWorktree } = await import('./types.js');
  if (usesBranchWorktree(localConfig)) {
    const { ensureReportsWorktree, refreshReportsWorktree } = await import('./utils/reports-branch.js');
    // Read-only: never publish a missing reports branch.
    await refreshReportsWorktree(localConfig, { pushIfCreated: false });
    membersRoot = await ensureReportsWorktree(localConfig, { pushIfCreated: false });
  } else {
    await pullRepo(knowledgePath).catch(() => { /* offline — read local copy */ });
  }

  const manifest = await loadProjectsManifest(knowledgePath);
  if (manifest && !listProjectIds(manifest).includes(projectId)) {
    log.warn(`Project "${projectId}" is not defined in manifest/projects.yaml.`);
    // Continue anyway — the roster may still record historical membership.
  }

  // Union across read roots; the first root that has a file supplies its
  // bytes, so a copy on the reports branch supersedes the inherited one.
  const members: string[] = [];
  const listed = new Set<string>();
  for (const root of memberReadRoots(membersRoot, localConfig)) {
    const files = (await listFiles(path.join(root, 'members'))).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      if (listed.has(file)) continue;
      listed.add(file);
      const content = await readFileSafe(path.join(root, 'members', file));
      if (!content) continue;
      try {
        const member = MemberConfigSchema.parse(YAML.parse(content));
        if ((member.projects ?? []).includes(projectId)) {
          const display = member.displayName ? ` — ${member.displayName}` : '';
          members.push(`${member.username}${display}`);
        }
      } catch {
        // Skip invalid member files silently (listMembers already warns on `members`).
      }
    }
  }

  console.log('');
  if (members.length === 0) {
    console.log(`No members registered for project "${projectId}".`);
  } else {
    console.log(`Members of project "${projectId}" (${members.length}):`);
    console.log('');
    for (const m of members.sort()) {
      console.log(`  ${m}`);
    }
  }
  console.log('');
}

// ─── projects add / update / remove (admin) ─────────────

type ProjectResources = TeamProject['resources'];

/** `--namespaces` sets one namespace set on every project resource type. */
function uniformResources(namespaces: string[]): ProjectResources {
  return { knowledge: [...namespaces], skills: [...namespaces], learnings: [...namespaces], agents: [...namespaces] };
}

function mapResources(
  resources: ProjectResources,
  fn: (namespaces: string[]) => string[],
): ProjectResources {
  return Object.fromEntries(PROJECT_RESOURCE_TYPES.map((type) => [type, fn(resources[type])])) as ProjectResources;
}

function describeResources(resources: ProjectResources): string {
  return PROJECT_RESOURCE_TYPES.map((type) => `${type}: ${resources[type].join(', ') || '(none)'}`).join('; ');
}

/**
 * Load, change and validate the projects manifest, then write it and open a PR
 * (or only report the change with --dry-run). `change` returns the updated
 * manifest plus the messages to report, or null after logging why it refused.
 */
async function editProjectsManifest(
  options: GlobalOptions,
  change: (manifest: ProjectsManifest | null) => {
    manifest: ProjectsManifest;
    summary: string;
    commitMsg: string;
  } | null,
  afterWrite?: () => void,
): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit();

  await runManifestEdit(localConfig, 'Projects', async (repoPath, editConfig) => {
    if (editConfig.repo.kind !== 'self') await pullLatest(repoPath);

    let current: ProjectsManifest | null;
    try {
      current = await loadProjectsManifest(repoPath);
    } catch (e) {
      log.error((e as Error).message);
      return;
    }

    const result = change(current);
    if (!result) return;

    try {
      validateProjectsManifest(result.manifest);
    } catch (e) {
      log.error((e as Error).message);
      return;
    }

    if (options.dryRun) {
      log.info(`[dry-run] Would ${result.summary}`);
      return;
    }

    const done = result.summary.charAt(0).toUpperCase() + result.summary.slice(1);
    await saveProjectsManifest(repoPath, result.manifest);
    log.success(done);
    afterWrite?.();

    await pushManifestChange({
      repoPath,
      teamConfig,
      localConfig: editConfig,
      commitMsg: result.commitMsg,
      prDescription: done,
    });
  });
}

export async function projectsAdd(
  projectId: string,
  options: GlobalOptions & { namespaces: string; name?: string; description?: string },
): Promise<void> {
  const namespaces = parseIds([options.namespaces]);
  if (namespaces.length === 0) {
    log.error(`At least one namespace is required. Use --namespaces common,${projectId}`);
    return;
  }

  await editProjectsManifest(options, (manifest) => {
    const base: ProjectsManifest = manifest ?? { version: 1, projects: [] };
    if (findProject(base, projectId)) {
      log.error(`Project "${projectId}" already exists. Use \`teamai projects update ${projectId}\` to modify it.`);
      return null;
    }

    const project: TeamProject = {
      id: projectId,
      name: options.name ?? '',
      description: options.description ?? '',
      resources: uniformResources(namespaces),
    };
    return {
      manifest: { ...base, projects: [...base.projects, project] },
      summary: `add project "${projectId}" (namespaces: ${namespaces.join(', ')})`,
      commitMsg: `[teamai] Add project "${projectId}"`,
    };
  });
}

export async function projectsUpdate(
  projectId: string,
  options: GlobalOptions & {
    addNamespaces?: string;
    removeNamespaces?: string;
    name?: string;
    description?: string;
  },
): Promise<void> {
  const toAdd = options.addNamespaces !== undefined ? parseIds([options.addNamespaces]) : [];
  const toRemove = new Set(options.removeNamespaces !== undefined ? parseIds([options.removeNamespaces]) : []);
  if (toAdd.length === 0 && toRemove.size === 0 && options.name === undefined && options.description === undefined) {
    log.error('Nothing to update. Use --add-namespaces, --remove-namespaces, --name, or --description.');
    return;
  }

  await editProjectsManifest(options, (manifest) => {
    const existing = manifest ? findProject(manifest, projectId) : undefined;
    if (!manifest || !existing) {
      log.error(manifest ? unknownProjectMessage(manifest, projectId) : 'This team repo defines no projects (no manifest/projects.yaml).');
      return null;
    }

    // Each resource type keeps its own list, so a hand-edited per-type layout survives.
    const resources = mapResources(existing.resources, (namespaces) => {
      const next = namespaces.filter((ns) => !toRemove.has(ns));
      for (const ns of toAdd) {
        if (!next.includes(ns)) next.push(ns);
      }
      return next;
    });
    if (PROJECT_RESOURCE_TYPES.every((type) => resources[type].length === 0)) {
      log.error(`Cannot remove every namespace from project "${projectId}". Use \`teamai projects remove ${projectId}\` to delete it.`);
      return null;
    }

    const updated: TeamProject = {
      ...existing,
      name: options.name ?? existing.name,
      description: options.description ?? existing.description,
      resources,
    };
    return {
      manifest: { ...manifest, projects: manifest.projects.map((p) => (p.id === projectId ? updated : p)) },
      summary: `update project "${projectId}" (${describeResources(resources)})`,
      commitMsg: `[teamai] Update project "${projectId}"`,
    };
  });
}

export async function projectsRemove(projectId: string, options: GlobalOptions): Promise<void> {
  await editProjectsManifest(
    options,
    (manifest) => {
      if (!manifest || !findProject(manifest, projectId)) {
        log.error(manifest ? unknownProjectMessage(manifest, projectId) : 'This team repo defines no projects (no manifest/projects.yaml).');
        return null;
      }
      return {
        manifest: { ...manifest, projects: manifest.projects.filter((p) => p.id !== projectId) },
        summary: `remove project "${projectId}"`,
        commitMsg: `[teamai] Remove project "${projectId}"`,
      };
    },
    () => {
      log.warn(`Directories with "${projectId}" active will warn on their next pull and fall back to role-only filtering.`);
      log.warn('The project\'s namespace content stays in the team repo, so the next pull can reclaim the copies members deployed from it; deleting that content in the same change leaves those copies behind.');
    },
  );
}
