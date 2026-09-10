import path from 'node:path';
import YAML from 'yaml';
import { autoDetectInit, loadStateForScope } from './config.js';
import { getRepoStatus } from './utils/git.js';
import { assertSafeResourceName } from './utils/path-safety.js';
import { log } from './utils/logger.js';
import { getAllHandlers } from './resources/index.js';
import { listDirs, listFilesRecursive, pathExists, readFileSafe } from './utils/fs.js';
import { SkillsHandler } from './resources/skills.js';
import { DocsHandler } from './resources/docs.js';
import { detectInstalledAgents, type ResolvedAgent } from './known-agents.js';
import {
  buildClassifyContext,
  classifySkill,
  formatSkillSource,
  scanAgentSkills,
  truncate,
  type AgentSkillsView,
} from './agent-skills.js';
import { RESOURCE_TYPES, LocalConfigSchema, getDataHome, type GlobalOptions, type ResourceType } from './types.js';
import { projectsRootDir, readAnchorFile, projectSlug } from './utils/partition.js';
import { maskEnvValue } from './resources/env.js';
import { parseTeamMcpServers } from './resources/mcp.js';
import { parseHooksYaml } from './resources/hooks.js';

export interface ListOptions extends GlobalOptions {
  /** Where to look for resources: 'repo' (default for backwards compat),
   *  'local' (only installed agents) or 'all' (both). */
  source?: 'repo' | 'local' | 'all';
  /** Restrict --source local|all output to a single agent id. */
  agent?: string;
  /** Show env values in plaintext (default: masked). Same as `teamai env list --reveal`. */
  reveal?: boolean;
}

export async function status(options: GlobalOptions): Promise<void> {
  if (options.all) {
    await statusAll();
    return;
  }
  // Auto-detect scope
  const { localConfig, teamConfig } = await autoDetectInit();
  const scopeLabel = localConfig.scope;

  // Scope info
  console.log('');
  log.info(`Scope: ${scopeLabel}${scopeLabel === 'project' && localConfig.projectRoot ? ` (${localConfig.projectRoot})` : ''}`);
  // Machine-data partition: where this project's teamai data actually lives
  // (~/.teamai/projects/<slug>/ for a partitioned install, else legacy .teamai).
  log.info(`  data: ${getDataHome(localConfig)}`);

  // Git status
  console.log('');
  log.info('Team repo status:');
  try {
    const gitStatus = await getRepoStatus(localConfig.repo.localPath);
    console.log(`  repo: ${localConfig.repo.remote}`);
    console.log(`  local: ${localConfig.repo.localPath}`);
    if (gitStatus.ahead > 0) console.log(`  ahead: ${gitStatus.ahead} commit(s)`);
    if (gitStatus.behind > 0) console.log(`  behind: ${gitStatus.behind} commit(s)`);
    if (gitStatus.modified.length > 0) {
      console.log(`  modified: ${gitStatus.modified.length} file(s)`);
    }
    if (gitStatus.ahead === 0 && gitStatus.behind === 0 && gitStatus.modified.length === 0) {
      console.log('  up to date');
    }
  } catch (e) {
    log.warn(`Could not check git status: ${(e as Error).message}`);
  }

  // State
  const state = await loadStateForScope(localConfig);
  console.log('');
  log.info('Sync state:');
  console.log(`  last push: ${state.lastPush ?? 'never'}`);
  console.log(`  last pull: ${state.lastPull ?? 'never'}`);

  // Resource counts — cover every ResourceType, in RESOURCE_TYPES order.
  console.log('');
  log.info('Team resources:');

  const repoPath = localConfig.repo.localPath;
  const counts: Record<string, number> = {};

  // Match `list skills --source repo`: count skills, not namespace directories.
  counts.skills = (await new SkillsHandler().scanTeamForPull(teamConfig, localConfig)).length;

  const rulesFiles = (await listFilesRecursive(path.join(repoPath, 'rules'))).filter(f => f.endsWith('.md'));
  counts.rules = rulesFiles.length;

  counts.docs = await new DocsHandler().countDocFiles(path.join(repoPath, 'docs'));

  const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
  let envCount = 0;
  if (await pathExists(envYamlPath)) {
    const envContent = await readFileSafe(envYamlPath);
    if (envContent) {
      try {
        const envData = YAML.parse(envContent) as { variables?: unknown[] };
        envCount = Array.isArray(envData?.variables) ? envData.variables.length : 0;
      } catch {
        // invalid yaml
      }
    }
  }
  counts.env = envCount;

  const agentsHandler = getAllHandlers().find((h) => h.type === 'agents');
  counts.agents = agentsHandler
    ? (await agentsHandler.scanTeamForPull(teamConfig, localConfig)).length
    : 0;

  const hooksHandler = getAllHandlers().find((h) => h.type === 'hooks') as
    | { countHooks: (repoPath: string) => Promise<number> }
    | undefined;
  counts.hooks = hooksHandler ? await hooksHandler.countHooks(repoPath) : 0;

  counts.mcp = (await parseTeamMcpServers(repoPath)).length;

  for (const type of RESOURCE_TYPES) {
    console.log(`  ${type}: ${counts[type] ?? 0}`);
  }

  // Local pushable items
  console.log('');
  log.info('Local resources not yet pushed:');
  let anyNew = false;
  for (const handler of getAllHandlers()) {
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    if (items.length > 0) {
      anyNew = true;
      console.log(`  [${handler.type}] ${items.length} new`);
      if (options.verbose) {
        for (const item of items) {
          console.log(`    - ${item.name}`);
        }
      }
    }
  }
  if (!anyNew) {
    console.log('  (none)');
  }

  console.log('');
}

/**
 * `teamai status --all` — enumerate every project data partition under
 * ~/.teamai/projects and flag the stale/orphan ones (issue #374 P3). teamai never
 * auto-collects orphans (a renamed/moved/deleted project leaves its partition
 * behind), so this is how a user finds partitions safe to delete by hand.
 *
 * The verdict rests on the `anchor` reverse-lookup file — the shared project
 * anchor this partition is keyed by. The persisted repo.businessRepoRoot /
 * projectRoot in config.yaml is read only as a DISPLAY fallback (an older
 * partition may predate anchor files); it is a workspace path that can point at a
 * linked worktree, so it must never drive the orphan verdict. We mark it:
 *   - active  : anchor exists on disk
 *   - orphan  : anchor is gone (project deleted/moved) → safe to delete
 *   - unknown : no anchor → cannot confirm orphan (partition may still be active,
 *               e.g. a pre-P3 partition still loaded by its main checkout)
 *   - corrupt : the dir name does not match slug(anchor) → tampered/half-written
 */
async function statusAll(): Promise<void> {
  const root = projectsRootDir();
  const slugs = await listDirs(root);

  console.log('');
  log.info(`Project data partitions (${root}):`);
  if (slugs.length === 0) {
    log.info('  (none — no project has been initialized or migrated on this machine)');
    console.log('');
    return;
  }

  let orphanCount = 0;
  for (const slug of slugs.sort()) {
    const partitionDir = path.join(root, slug);
    const anchor = await readAnchorFile(partitionDir);

    // Recover the project path + read a bit of config for DISPLAY context. The
    // anchor is the trustworthy source; the config's businessRepoRoot/projectRoot
    // is only a display fallback (see the orphan-verdict note below).
    let projectPath = anchor;
    let scope: string | undefined;
    let kind: string | undefined;
    const cfgRaw = await readFileSafe(path.join(partitionDir, 'config.yaml'));
    if (cfgRaw) {
      try {
        const parsed = LocalConfigSchema.parse(YAML.parse(cfgRaw));
        scope = parsed.scope;
        kind = parsed.repo.kind;
        if (!projectPath) projectPath = parsed.repo.businessRepoRoot ?? parsed.projectRoot ?? null;
      } catch { /* unreadable config — leave fields undefined */ }
    }

    // The orphan verdict must rest ONLY on the anchor — it is the shared project
    // anchor this partition is keyed by (projectSlug(anchor)). The config's
    // businessRepoRoot/projectRoot is a persisted *workspace* path that may point
    // at a linked worktree; its disappearance does NOT prove the shared partition
    // (still used by the main checkout) is orphaned. So without a trustworthy
    // anchor we never recommend deletion — classify as unknown.
    let state: string;
    if (!anchor) {
      state = projectPath
        ? 'unknown — no anchor; cannot confirm orphan (partition may still be active)'
        : 'unknown (no anchor / project path)';
    } else if (!(await pathExists(anchor))) {
      state = 'ORPHAN — project path is gone, safe to delete';
      orphanCount++;
    } else if (projectSlug(anchor) !== slug) {
      state = 'corrupt — dir name does not match anchor';
    } else {
      state = 'active';
    }

    const kindLabel = kind ? ` ${kind}` : '';
    log.info(`  ${slug}  [${state}]`);
    log.info(`    project: ${projectPath ?? '(unresolved)'}${scope ? `  (${scope}${kindLabel})` : ''}`);
  }

  console.log('');
  if (orphanCount > 0) {
    log.warn(
      `${orphanCount} orphan partition(s) found. teamai never deletes them automatically; ` +
        `remove one with:  rm -rf "${root}/<slug>"`,
    );
    console.log('');
  }
}

export async function list(type: string | undefined, options: ListOptions): Promise<void> {
  // Auto-detect scope
  const { localConfig, teamConfig } = await autoDetectInit();
  const repoPath = localConfig.repo.localPath;

  const source = options.source ?? 'all';
  if (!['repo', 'local', 'all'].includes(source)) {
    log.error(`Invalid --source: ${source}. Must be one of: repo, local, all.`);
    process.exitCode = 1;
    return;
  }

  // Validate --agent to prevent path traversal attacks
  if (options.agent != null) {
    try {
      assertSafeResourceName(options.agent);
    } catch (err) {
      log.error(`Invalid --agent: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
      return;
    }
  }

  // --agent / --source local restrict the output to local skill scanning,
  // which is only meaningful for the "skills" resource type.
  const isSkillsScope = !type || type === 'skills';
  if ((options.agent || source === 'local') && !isSkillsScope) {
    log.error('--source local / --agent only apply when listing skills.');
    process.exitCode = 1;
    return;
  }

  if (type && !RESOURCE_TYPES.includes(type as ResourceType)) {
    log.error(`Unknown resource type: ${type}. Supported: ${RESOURCE_TYPES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const types: ResourceType[] = type
    ? [type as ResourceType]
    : [...RESOURCE_TYPES];

  // ── Repo section ────────────────────────────────────
  if (source === 'repo' || source === 'all') {
    for (const t of types) {
      await printRepoSection(t, options, { repoPath, teamConfig, localConfig });
    }
  }

  // ── Local agent section (skills only) ───────────────
  if (source === 'local' || source === 'all') {
    if (isSkillsScope) {
      await printLocalAgentsSection(options, localConfig, teamConfig);
    }
  }

  console.log('');
}

async function printRepoSection(
  t: ResourceType,
  options: ListOptions,
  ctx: { repoPath: string; teamConfig: Awaited<ReturnType<typeof autoDetectInit>>['teamConfig']; localConfig: Awaited<ReturnType<typeof autoDetectInit>>['localConfig'] },
): Promise<void> {
  const { repoPath, teamConfig, localConfig } = ctx;
  console.log('');
  console.log(`=== REPO ${t.toUpperCase()} ===`);

  if (t === 'env') {
    const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
    if (await pathExists(envYamlPath)) {
      const envContent = await readFileSafe(envYamlPath);
      if (envContent) {
        try {
          const envData = YAML.parse(envContent) as { variables?: Array<{ key: string; value: string; description?: string }> };
          if (envData?.variables && envData.variables.length > 0) {
            if (options.reveal) {
              process.stderr.write('[warn] Env values will be shown in plaintext\n');
            }
            for (const v of envData.variables) {
              const display = options.reveal ? v.value : maskEnvValue(v.value);
              console.log(`  ${v.key}=${display}`);
              if (options.verbose && v.description) {
                console.log(`    ${v.description}`);
              }
            }
          } else {
            console.log('  (none)');
          }
        } catch {
          console.log('  (invalid env.yaml)');
        }
      } else {
        console.log('  (none)');
      }
    } else {
      console.log('  (none)');
    }
    return;
  }

  if (t === 'mcp') {
    const servers = await parseTeamMcpServers(repoPath);
    if (servers.length === 0) {
      console.log('  (none)');
      return;
    }
    for (const s of servers) {
      const endpoint = s.transport === 'stdio'
        ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim()
        : (s.url ?? '');
      console.log(`  ${s.name}  [${s.transport}]  ${endpoint}`);
      if (options.verbose && s.description) {
        console.log(`    ${s.description}`);
      }
    }
    return;
  }

  if (t === 'hooks') {
    const parsed = await parseHooksYaml(repoPath);
    const hooks = parsed?.hooks ?? [];
    if (hooks.length === 0) {
      console.log('  (none)');
      return;
    }
    for (const h of hooks) {
      console.log(`  ${h.id}  [${h.event}]`);
      if (options.verbose && h.description) {
        console.log(`    ${h.description}`);
      }
    }
    return;
  }

  const handler = getAllHandlers().find((h) => h.type === t);
  if (!handler) return;

  const items = await handler.scanTeamForPull(teamConfig, localConfig);
  if (items.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const item of items) {
    let suffix = '';
    if (t === 'skills') {
      const contributors = await SkillsHandler.readContributors(item.sourcePath);
      if (contributors.length > 0) {
        suffix = `  (${contributors.join(', ')})`;
      }
    }
    console.log(`  ${item.name}${suffix}`);
    if (options.verbose) {
      console.log(`    path: ${item.sourcePath}`);
    }
  }
}

async function printLocalAgentsSection(
  options: ListOptions,
  localConfig: Awaited<ReturnType<typeof autoDetectInit>>['localConfig'],
  teamConfig: Awaited<ReturnType<typeof autoDetectInit>>['teamConfig'],
): Promise<void> {
  const allAgents = await detectInstalledAgents(localConfig, teamConfig);
  const agents = filterAgents(allAgents, options.agent);

  if (options.agent) {
    if (agents.length === 0) {
      log.error(`Agent "${options.agent}" is unknown. Use \`teamai list --source local\` to see installed agents.`);
      process.exitCode = 1;
      return;
    }
    if (!agents[0].installed) {
      log.error(`Agent "${options.agent}" is not installed (no directory at ~/.${options.agent}/).`);
      process.exitCode = 1;
      return;
    }
  }

  console.log('');
  console.log('=== LOCAL AGENTS ===');

  const installed = agents.filter((a) => a.installed);
  if (installed.length === 0) {
    console.log('  (no installed agents detected)');
    return;
  }

  const ctx = await buildClassifyContext(localConfig);
  const views: AgentSkillsView[] = [];
  for (const agent of installed) {
    views.push(await scanAgentSkills(agent, ctx));
  }

  // Summary line per agent
  const idCol = Math.max(...views.map((v) => v.agent.id.length), 6);
  const pathCol = Math.max(...views.map((v) => v.agent.absoluteSkillsPath.length), 12);
  for (const view of views) {
    const id = view.agent.id.padEnd(idCol);
    const p = view.agent.absoluteSkillsPath.padEnd(pathCol);
    const note = view.agent.fromTeamConfig ? '' : '  (not configured in teamai.yaml)';
    console.log(`  [${id}]  ${p}  ${view.skills.length} skills${note}`);
  }

  if (!options.verbose) return;

  // Verbose: per-agent skill listing with source tag and description
  for (const view of views) {
    if (view.skills.length === 0) continue;
    console.log('');
    console.log(`  --- ${view.agent.id} (${view.skills.length}) ---`);
    const nameCol = Math.max(...view.skills.map((s) => s.name.length));
    const sourceCol = Math.max(...view.skills.map((s) => formatSkillSource(s.source).length));
    for (const skill of view.skills) {
      const desc = truncate(skill.description, 80);
      console.log(
        `    ${skill.name.padEnd(nameCol)}  ${formatSkillSource(skill.source).padEnd(sourceCol)}  ${desc}`,
      );
    }
  }
}

function filterAgents(agents: ResolvedAgent[], agentFilter?: string): ResolvedAgent[] {
  if (!agentFilter) return agents;
  return agents.filter((a) => a.id === agentFilter);
}
