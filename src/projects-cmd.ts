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
  listProjectIds,
  describeProjects,
} from './projects.js';
import { readFileSafe, listFiles } from './utils/fs.js';
import { pullRepo } from './utils/git.js';
import { log } from './utils/logger.js';
import { MemberConfigSchema } from './types.js';
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
  // projects manifest is knowledge on the default branch. Split the two roots
  // so leftover clone members/ is ignored and projects.yaml is still found.
  const knowledgePath = localConfig.repo.localPath;
  let membersRoot = knowledgePath;
  const { usesReportsBranch } = await import('./types.js');
  if (usesReportsBranch(localConfig)) {
    const { ensureReportsWorktree, refreshReportsWorktree } = await import('./utils/reports-branch.js');
    await refreshReportsWorktree(localConfig);
    membersRoot = await ensureReportsWorktree(localConfig);
  } else {
    await pullRepo(knowledgePath).catch(() => { /* offline — read local copy */ });
  }

  const manifest = await loadProjectsManifest(knowledgePath);
  if (manifest && !listProjectIds(manifest).includes(projectId)) {
    log.warn(`Project "${projectId}" is not defined in manifest/projects.yaml.`);
    // Continue anyway — the roster may still record historical membership.
  }

  const membersDir = path.join(membersRoot, 'members');
  const files = (await listFiles(membersDir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  const members: string[] = [];
  for (const file of files) {
    const content = await readFileSafe(path.join(membersDir, file));
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
