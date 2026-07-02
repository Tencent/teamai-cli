import path from 'node:path';
import YAML from 'yaml';
import { autoDetectInit, loadStateForScope } from './config.js';
import { getRepoStatus } from './utils/git.js';
import { assertSafeResourceName } from './utils/path-safety.js';
import { log } from './utils/logger.js';
import { getAllHandlers } from './resources/index.js';
import { listDirs, listFiles, pathExists, readFileSafe } from './utils/fs.js';
import { SkillsHandler } from './resources/skills.js';
import { detectInstalledAgents, type ResolvedAgent } from './known-agents.js';
import {
  buildClassifyContext,
  classifySkill,
  formatSkillSource,
  scanAgentSkills,
  truncate,
  type AgentSkillsView,
} from './agent-skills.js';
import type { GlobalOptions, ResourceType } from './types.js';

export interface ListOptions extends GlobalOptions {
  /** Where to look for resources: 'repo' (default for backwards compat),
   *  'local' (only installed agents) or 'all' (both). */
  source?: 'repo' | 'local' | 'all';
  /** Restrict --source local|all output to a single agent id. */
  agent?: string;
}

export async function status(options: GlobalOptions): Promise<void> {
  // Auto-detect scope
  const { localConfig, teamConfig } = await autoDetectInit();
  const scopeLabel = localConfig.scope;

  // Scope info
  console.log('');
  log.info(`Scope: ${scopeLabel}${scopeLabel === 'project' && localConfig.projectRoot ? ` (${localConfig.projectRoot})` : ''}`);

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
  const state = await loadStateForScope(localConfig.scope, localConfig.projectRoot);
  console.log('');
  log.info('Sync state:');
  console.log(`  last push: ${state.lastPush ?? 'never'}`);
  console.log(`  last pull: ${state.lastPull ?? 'never'}`);

  // Resource counts
  console.log('');
  log.info('Team resources:');

  const repoPath = localConfig.repo.localPath;
  const counts: Record<string, number> = {};

  // Skills
  const skillsDirs = await listDirs(path.join(repoPath, 'skills'));
  counts.skills = skillsDirs.length;

  // Rules
  const rulesFiles = (await listFiles(path.join(repoPath, 'rules'))).filter(f => f.endsWith('.md'));
  counts.rules = rulesFiles.length;

  // Docs
  const docsExists = await pathExists(path.join(repoPath, 'docs'));
  const docFiles = docsExists ? (await listFiles(path.join(repoPath, 'docs'))).filter(f => !f.startsWith('.')) : [];
  counts.docs = docFiles.length;

  // Env
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

  // Hooks (team-declared, hooks/hooks.yaml)
  const hooksHandler = getAllHandlers().find((h) => h.type === 'hooks') as
    | { countHooks: (repoPath: string) => Promise<number> }
    | undefined;
  counts.hooks = hooksHandler ? await hooksHandler.countHooks(repoPath) : 0;

  for (const [type, count] of Object.entries(counts)) {
    console.log(`  ${type}: ${count}`);
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

  const types: ResourceType[] = type
    ? [type as ResourceType]
    : ['skills', 'rules', 'docs', 'env'];

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
            for (const v of envData.variables) {
              console.log(`  ${v.key}=${v.value}`);
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
