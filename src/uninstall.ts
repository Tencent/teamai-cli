import path from 'node:path';
import { autoDetectInit, saveLocalConfig, saveLocalConfigForScope } from './config.js';
import { reconcileHooks, hasTeamaiHooks } from './hooks.js';
import {
  removeOpenClawHooks,
  OPENCLAW_HOOK_DIR,
  resolveOpenClawHooksDir,
  resolveOpenclawWorkspaceDir,
} from './openclaw-hooks.js';
import {
  TEAMAI_RULES_START,
  TEAMAI_RULES_END,
  TEAMAI_CULTURE_START,
  TEAMAI_CULTURE_END,
  TEAMAI_CLAUDEMD_START,
  TEAMAI_CLAUDEMD_END,
  TEAMAI_RECALL_RULES_START,
  TEAMAI_RECALL_RULES_END,
  TEAMAI_ENV_START,
  TEAMAI_ENV_END,
  getTeamaiHome,
  getManagedHooksPath,
  managedMcpManifestPath,
  resolveBaseDir,
  scopedToolPaths,
  type GlobalOptions,
  type TeamaiConfig,
  type LocalConfig,
  type Scope,
  type ManagedMcpManifest,
} from './types.js';
import { BUILTIN_RULE_NAMES } from './builtin-rules.js';
import { BUILTIN_AGENT_NAMES } from './builtin-agents.js';
import { BUILTIN_SKILL_NAMES } from './builtin-skills.js';
import {
  pathExists,
  readFileSafe,
  readJson,
  writeFile,
  remove,
  listDirs,
  listFiles,
  listFilesRecursive,
  expandHome,
} from './utils/fs.js';
import { log } from './utils/logger.js';
import { askConfirmation } from './utils/prompt.js';
import { getUserHome } from './utils/home.js';

// ─── Types ─────────────────────────────────────────────

interface UninstallOptions extends GlobalOptions {
  force?: boolean;
  agent?: string;
}

interface RemovalPlan {
  /** Tool settings files that contain teamai hooks. */
  hookFiles: Array<{ path: string; tool: string }>;
  /** OpenClaw-style hook dirs (<base>/.<tool>/hooks) holding teamai HOOK.md+handler.ts. */
  openclawHookDirs: Array<{ hooksDir: string; tool: string }>;
  /** OpenCode teamai plugin files (.opencode/plugin/teamai-*.ts) to delete. */
  opencodeHookScopes: Array<{ baseDir: string; scope: Scope }>;
  /** CLAUDE.md files with teamai rules blocks. */
  claudeMdFiles: string[];
  /** Skill directories synced from team repo. */
  skillDirs: string[];
  /** Rule .md files synced from team repo (plus CLI built-in rules). */
  ruleFiles: string[];
  /** Built-in agent .md files deployed by the CLI (e.g. teamai-recall). */
  agentFiles: string[];
  /** teamai-managed MCP servers from managed-mcp.json (`tool/server` or `tool:project/server`). */
  mcpServers: string[];
  /** Shell profile path containing env block (null if none). */
  shellProfile: string | null;
  /** Docs directory (null if doesn't exist). */
  docsDir: string | null;
  /** The .teamai home directory path. */
  teamaiHome: string;
  /** Whether teamaiHome exists on disk. */
  teamaiHomeExists: boolean;
  /** Managed-hooks manifest path (for team-hook cleanup). */
  managedHooksPath: string;
  /** Whether shared resources (docs / ~/.teamai / shell profile) are part of this removal. */
  includeShared: boolean;
  /** Whether this removal targets Hermes (clears its SOUL.md block + config.yaml hook). */
  hermesCleanup: boolean;
  /** Scope being uninstalled (issue #73: surfaced to the user). */
  scope: Scope;
}

/** Per-tool findings collected during discovery (tool-specific resources only). */
interface ToolResources {
  hookFiles: Array<{ path: string; tool: string }>;
  openclawHookDirs: Array<{ hooksDir: string; tool: string }>;
  opencodeHookScopes: Array<{ baseDir: string; scope: Scope }>;
  claudeMdFiles: string[];
  skillDirs: string[];
  ruleFiles: string[];
  agentFiles: string[];
}

function hasToolResources(r: ToolResources): boolean {
  return (
    r.hookFiles.length > 0 ||
    r.openclawHookDirs.length > 0 ||
    r.opencodeHookScopes.length > 0 ||
    r.claudeMdFiles.length > 0 ||
    r.skillDirs.length > 0 ||
    r.ruleFiles.length > 0 ||
    r.agentFiles.length > 0
  );
}

// ─── Helpers ───────────────────────────────────────────

const CLAUDEMD_MARKER_PAIRS: Array<[string, string]> = [
  [TEAMAI_RULES_START, TEAMAI_RULES_END],
  [TEAMAI_CULTURE_START, TEAMAI_CULTURE_END],
  [TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END],
  [TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END],
];

function detectShellProfile(): string {
  const home = getUserHome();
  const shell = process.env.SHELL ?? '';
  if (shell.includes('zsh')) {
    return path.join(home, '.zshrc');
  }
  return path.join(home, '.bashrc');
}

/**
 * Collect team repo skill names, handling both flat and namespaced layouts.
 * A directory is a namespace if it does NOT contain SKILL.md.
 */
async function collectTeamSkillNames(repoPath: string): Promise<Set<string>> {
  const teamSkillsDir = path.join(repoPath, 'skills');
  if (!await pathExists(teamSkillsDir)) return new Set();

  const names = new Set<string>();
  const topDirs = await listDirs(teamSkillsDir);

  for (const dir of topDirs) {
    const dirPath = path.join(teamSkillsDir, dir);
    const hasSkillMd = await pathExists(path.join(dirPath, 'SKILL.md'));
    if (hasSkillMd) {
      // Flat skill
      names.add(dir);
    } else {
      // Namespace directory — add sub-skills
      const subDirs = await listDirs(dirPath);
      for (const sub of subDirs) {
        names.add(sub);
      }
    }
  }

  return names;
}

/**
 * Collect team repo rule names (relative paths without .md extension).
 */
async function collectTeamRuleNames(repoPath: string): Promise<Set<string>> {
  const teamRulesDir = path.join(repoPath, 'rules');
  if (!await pathExists(teamRulesDir)) return new Set();

  const files = await listFilesRecursive(teamRulesDir);
  return new Set(
    files
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, '')),
  );
}

/** Collect custom agent names from canonical YAML and legacy Markdown files. */
async function collectTeamAgentNames(repoPath: string): Promise<Set<string>> {
  const teamAgentsDir = path.join(repoPath, 'agents');
  if (!await pathExists(teamAgentsDir)) return new Set();

  const files = await listFiles(teamAgentsDir);
  return new Set(
    files
      .filter((file) => file.endsWith('.yaml') || file.endsWith('.md'))
      .map((file) => path.basename(file).replace(/\.(yaml|md)$/, '')),
  );
}

/** Detect hooks cleared to empty arrays — a residue of prior teamai installation. */
function isEmptyHooksResidue(parsed: Record<string, unknown> | null): boolean {
  if (parsed == null || !('hooks' in parsed) || typeof parsed.hooks !== 'object' || parsed.hooks == null) return false;
  const entries = Object.values(parsed.hooks as Record<string, unknown>);
  return entries.length > 0 && entries.every((v) => Array.isArray(v) && v.length === 0);
}

/**
 * OpenCode plugin locations to sweep on uninstall.
 *
 * teamai writes a single plugin into the user dir (`~/.config/opencode/plugin`),
 * so that one is always checked. A project-scope uninstall additionally checks
 * `<projectRoot>/.opencode/plugin`, where an earlier layout wrote a second copy
 * that OpenCode would load alongside the user one.
 */
function opencodePluginTargets(baseDir: string, scope: Scope): Array<{ baseDir: string; scope: Scope }> {
  const home = getUserHome();
  const targets: Array<{ baseDir: string; scope: Scope }> = [{ baseDir: home, scope: 'user' }];
  if (scope === 'project' && path.resolve(baseDir) !== path.resolve(home)) {
    targets.push({ baseDir, scope: 'project' });
  }
  return targets;
}

// ─── Discovery ─────────────────────────────────────────

async function discoverToolResources(
  tool: string,
  toolPath: TeamaiConfig['toolPaths'][string],
  baseDir: string,
  teamSkillNames: Set<string>,
  teamRuleNames: Set<string>,
  teamAgentNames: Set<string>,
  managedHooksPath: string,
  scope: Scope,
): Promise<ToolResources> {
  const res: ToolResources = {
    hookFiles: [], openclawHookDirs: [], opencodeHookScopes: [], claudeMdFiles: [],
    skillDirs: [], ruleFiles: [], agentFiles: [],
  };

  // (a) Hooks — settings.json / hooks.json
  if (tool === 'opencode') {
    // OpenCode has no settings file; its teamai hooks are plugin .ts files under
    // <base>/.config/opencode/plugin (where teamai writes them) or
    // <base>/.opencode/plugin (a project-scope copy from an earlier layout).
    const { resolveOpencodePluginDir, OPENCODE_HOOK_FILE } = await import('./opencode-hooks.js');
    for (const target of opencodePluginTargets(baseDir, scope)) {
      const pluginDir = resolveOpencodePluginDir(target.baseDir, target.scope);
      if (await pathExists(path.join(pluginDir, OPENCODE_HOOK_FILE))) {
        res.opencodeHookScopes.push(target);
      } else if (await pathExists(pluginDir)) {
        // Agent-hook plugins (teamai-agent-*.ts) may exist without the main hook file.
        const files = await listFilesRecursive(pluginDir);
        if (files.some((f) => path.basename(f).startsWith('teamai-agent-'))) {
          res.opencodeHookScopes.push(target);
        }
      }
    }
  } else if (toolPath.settings) {
    const settingsPath = path.join(baseDir, toolPath.settings);
    if (await pathExists(settingsPath)
      && (await hasTeamaiHooks(settingsPath, tool, managedHooksPath)
        || isEmptyHooksResidue(await readJson<Record<string, unknown>>(settingsPath)))) {
      res.hookFiles.push({ path: settingsPath, tool });
    }
  } else {
    // OpenClaw-style agents (no settings file) inject a HOOK.md + handler.ts
    // under <hooksDir>/<OPENCLAW_HOOK_DIR>. Check both the default path and
    // the OPENCLAW_STATE_DIR override to cover imate container environments.
    const defaultHooksDir = path.join(baseDir, `.${tool}`, 'hooks');
    const resolvedHooksDir = resolveOpenClawHooksDir(tool);
    const dirsToCheck = new Set([defaultHooksDir, resolvedHooksDir]);
    for (const hooksDir of dirsToCheck) {
      if (await pathExists(path.join(hooksDir, OPENCLAW_HOOK_DIR))) {
        res.openclawHookDirs.push({ hooksDir, tool });
      }
    }
  }

  // (b) CLAUDE.md teamai section blocks
  if (toolPath.claudemd) {
    const claudeMdPath = path.join(baseDir, toolPath.claudemd);
    const content = await readFileSafe(claudeMdPath);
    if (content && CLAUDEMD_MARKER_PAIRS.some(([start]) => content.includes(start))) {
      res.claudeMdFiles.push(claudeMdPath);
    }
  }

  // (c) Skills — only those matching team repo
  if (toolPath.skills) {
    const skillRoots = new Set([path.join(baseDir, toolPath.skills)]);
    if (tool === 'openclaw') {
      const workspaceDir = await resolveOpenclawWorkspaceDir();
      if (workspaceDir) skillRoots.add(path.join(workspaceDir, 'skills'));
    }
    for (const skillsDir of skillRoots) {
      if (await pathExists(skillsDir)) {
        const dirs = await listDirs(skillsDir);
        for (const dir of dirs) {
          if (teamSkillNames.has(dir)) {
            res.skillDirs.push(path.join(skillsDir, dir));
          }
        }
      }
    }
  }

  // (d) Rules — team-synced rules plus CLI built-in rules (teamRuleNames
  // now includes BUILTIN_RULE_NAMES). User-authored rules are left alone.
  if (toolPath.rules) {
    const rulesDir = path.join(baseDir, toolPath.rules);
    if (await pathExists(rulesDir)) {
      const files = await listFilesRecursive(rulesDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const ruleName = file.replace(/\.md$/, '');
        if (teamRuleNames.has(ruleName)) {
          res.ruleFiles.push(path.join(rulesDir, file));
        }
      }
    }
  }

  // (d2) Team-synced custom agents plus CLI built-ins. Native output uses
  // .md for most tools and .toml for Codex, so match installed files by stem.
  if (toolPath.agents) {
    const agentsDir = path.join(baseDir, toolPath.agents);
    if (await pathExists(agentsDir)) {
      for (const file of await listFiles(agentsDir)) {
        if (!file.endsWith('.md') && !file.endsWith('.toml')) continue;
        const name = path.basename(file).replace(/\.(md|toml)$/, '');
        if (!teamAgentNames.has(name) && !BUILTIN_AGENT_NAMES.has(name)) continue;
        res.agentFiles.push(path.join(agentsDir, file));
      }
    }
  }

  return res;
}

async function buildRemovalPlan(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
  agentFilter?: string,
): Promise<RemovalPlan> {
  const baseDir = resolveBaseDir(localConfig);
  const teamaiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);

  // Discover team repo resource names for targeted removal. CLI built-in
  // resources (recall agent/rule, share-learnings skill, …) are deployed by
  // the CLI itself rather than synced from the team repo, so fold their names
  // in explicitly — otherwise uninstall leaks them (they match neither the
  // team-repo set nor a user-authored resource).
  const repoPath = localConfig.repo.localPath;
  const teamSkillNames = await collectTeamSkillNames(repoPath);
  for (const name of BUILTIN_SKILL_NAMES) teamSkillNames.add(name);
  const teamRuleNames = await collectTeamRuleNames(repoPath);
  for (const name of BUILTIN_RULE_NAMES) teamRuleNames.add(name);
  const teamAgentNames = await collectTeamAgentNames(repoPath);

  // Also include resources installed by local-agent (HTTP distribution)
  const localAgentManifestPath = path.join(
    getUserHome(), '.teamai', 'local-agent', 'manifest.json',
  );
  if (await pathExists(localAgentManifestPath)) {
    try {
      const raw = await readFileSafe(localAgentManifestPath);
      if (raw) {
        const manifest = JSON.parse(raw) as { scopes?: Record<string, { skills?: Record<string, unknown>; rules?: Record<string, unknown> }> };
        for (const scopeVal of Object.values(manifest.scopes ?? {})) {
          for (const slug of Object.keys(scopeVal.skills ?? {})) teamSkillNames.add(slug);
          for (const slug of Object.keys(scopeVal.rules ?? {})) teamRuleNames.add(slug);
        }
      }
    } catch { /* best effort */ }
  }

  // Discover per-tool resources
  const managedHooksPath = getManagedHooksPath(localConfig.scope, localConfig.projectRoot);
  const perTool = new Map<string, ToolResources>();
  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    perTool.set(
      tool,
      await discoverToolResources(
        tool,
        toolPath,
        baseDir,
        teamSkillNames,
        teamRuleNames,
        teamAgentNames,
        managedHooksPath,
        localConfig.scope,
      ),
    );
  }

  // Decide which tools to merge and whether to include shared resources
  let includeShared: boolean;
  let toolsToMerge: string[];
  if (agentFilter) {
    toolsToMerge = [agentFilter];
    const targetRes = perTool.get(agentFilter);
    const targetHasResources = targetRes ? hasToolResources(targetRes) : false;
    // Other tools still have teamai resources → keep shared resources.
    const othersHaveResources = [...perTool.entries()]
      .some(([t, r]) => t !== agentFilter && hasToolResources(r));
    // Remove shared resources only when the target itself has resources AND is
    // the last tool using teamai. Targeting a tool with no teamai resources is a
    // no-op for shared resources (plan will be empty → "Nothing to uninstall").
    includeShared = targetHasResources && !othersHaveResources;
  } else {
    toolsToMerge = [...perTool.keys()];
    includeShared = true;
  }

  const plan: RemovalPlan = {
    hookFiles: [],
    openclawHookDirs: [],
    opencodeHookScopes: [],
    claudeMdFiles: [],
    skillDirs: [],
    ruleFiles: [],
    agentFiles: [],
    mcpServers: [],
    shellProfile: null,
    docsDir: null,
    teamaiHome,
    teamaiHomeExists: includeShared && await pathExists(teamaiHome),
    managedHooksPath,
    includeShared,
    hermesCleanup: toolsToMerge.includes('hermes'),
    scope: localConfig.scope,
  };

  // Merge tool-specific resources for selected tools
  for (const tool of toolsToMerge) {
    const res = perTool.get(tool);
    if (!res) continue;
    plan.hookFiles.push(...res.hookFiles);
    plan.openclawHookDirs.push(...res.openclawHookDirs);
    plan.opencodeHookScopes.push(...res.opencodeHookScopes);
    plan.claudeMdFiles.push(...res.claudeMdFiles);
    plan.skillDirs.push(...res.skillDirs);
    plan.ruleFiles.push(...res.ruleFiles);
    plan.agentFiles.push(...res.agentFiles);
  }

  if (includeShared) {
    // (d3) teamai-managed MCP servers, tracked in managed-mcp.json (same
    // ownership model as hooks). These live under ~/.teamai, so they are shared
    // resources: only removed when the target is the last tool using teamai.
    const mcpManifestPath = expandHome(
      managedMcpManifestPath(localConfig.scope, localConfig.projectRoot),
    );
    const mcpManifest = (await readJson<ManagedMcpManifest>(mcpManifestPath)) ?? {};
    for (const [toolKey, records] of Object.entries(mcpManifest)) {
      for (const rec of records ?? []) {
        if (rec?.name) plan.mcpServers.push(`${toolKey}/${rec.name}`);
      }
    }
    plan.mcpServers.sort();

    // (e) Shell profile env block
    const shellProfilePath = teamConfig.sharing.env.shellProfilePath
      ? expandHome(teamConfig.sharing.env.shellProfilePath)
      : detectShellProfile();
    if (shellProfilePath) {
      const profileContent = await readFileSafe(shellProfilePath);
      if (profileContent && profileContent.includes(TEAMAI_ENV_START)) {
        plan.shellProfile = shellProfilePath;
      }
    }

    // (f) Docs directory
    const docsLocalDir = teamConfig.sharing.docs.localDir;
    let docsDir: string;
    if (localConfig.scope === 'project' && localConfig.projectRoot) {
      docsDir = docsLocalDir.startsWith('~/')
        ? path.join(localConfig.projectRoot, docsLocalDir.substring(2))
        : expandHome(docsLocalDir);
    } else {
      docsDir = expandHome(docsLocalDir);
    }
    if (await pathExists(docsDir)) {
      plan.docsDir = docsDir;
    }
  }

  return plan;
}

// ─── Summary ───────────────────────────────────────────

function isPlanEmpty(plan: RemovalPlan): boolean {
  return (
    plan.hookFiles.length === 0 &&
    plan.openclawHookDirs.length === 0 &&
    plan.opencodeHookScopes.length === 0 &&
    plan.claudeMdFiles.length === 0 &&
    plan.skillDirs.length === 0 &&
    plan.ruleFiles.length === 0 &&
    plan.agentFiles.length === 0 &&
    plan.mcpServers.length === 0 &&
    plan.shellProfile === null &&
    plan.docsDir === null &&
    !plan.teamaiHomeExists
  );
}

function printSummary(plan: RemovalPlan, agentFilter?: string): void {
  console.log('');
  console.log(`⚠  Uninstalling ${plan.scope} scope — ${plan.teamaiHome}`);
  if (agentFilter) {
    const sharedNote = plan.includeShared
      ? ' (last tool — shared resources removed too)'
      : ' (shared resources kept for remaining tools)';
    console.log(`⚠  Uninstalling tool only: ${agentFilter}${sharedNote}`);
  }
  console.log('⚠  The following teamai resources will be removed:');
  console.log('');

  if (plan.hookFiles.length > 0) {
    console.log(`   Hooks (${plan.hookFiles.length} files):`);
    for (const { path: p } of plan.hookFiles) {
      console.log(`     ${p}`);
    }
    console.log('');
  }

  if (plan.openclawHookDirs.length > 0) {
    console.log(`   OpenClaw Hooks (${plan.openclawHookDirs.length} directories):`);
    for (const { hooksDir } of plan.openclawHookDirs) {
      console.log(`     ${path.join(hooksDir, OPENCLAW_HOOK_DIR)}/`);
    }
    console.log('');
  }

  if (plan.opencodeHookScopes.length > 0) {
    console.log(`   OpenCode Hooks (${plan.opencodeHookScopes.length} plugin dirs):`);
    for (const { baseDir, scope } of plan.opencodeHookScopes) {
      const configDir = scope === 'project' ? '.opencode' : path.join('.config', 'opencode');
      console.log(`     ${path.join(baseDir, configDir, 'plugin')}/teamai-*.ts`);
    }
    console.log('');
  }

  if (plan.claudeMdFiles.length > 0) {
    console.log(`   CLAUDE.md rule blocks (${plan.claudeMdFiles.length} files):`);
    for (const p of plan.claudeMdFiles) {
      console.log(`     ${p}`);
    }
    console.log('');
  }

  if (plan.skillDirs.length > 0) {
    console.log(`   Skills (${plan.skillDirs.length} directories):`);
    for (const skillDir of plan.skillDirs) {
      console.log(`     ${skillDir}`);
    }
    console.log('');
  }

  if (plan.ruleFiles.length > 0) {
    console.log(`   Rules (${plan.ruleFiles.length} files)`);
    console.log('');
  }

  if (plan.agentFiles.length > 0) {
    console.log(`   Agents (${plan.agentFiles.length} files):`);
    for (const agentFile of plan.agentFiles) {
      console.log(`     ${agentFile}`);
    }
    console.log('');
  }

  if (plan.mcpServers.length > 0) {
    console.log(`   MCP servers (${plan.mcpServers.length}):`);
    for (const entry of plan.mcpServers) {
      console.log(`     ${entry}`);
    }
    console.log('');
  }

  if (plan.shellProfile) {
    console.log('   Shell profile env block:');
    console.log(`     ${plan.shellProfile}`);
    console.log('');
  }

  if (plan.docsDir) {
    console.log('   Docs directory:');
    console.log(`     ${plan.docsDir}`);
    console.log('');
  }

  if (plan.teamaiHomeExists) {
    console.log('   TeamAI home directory:');
    console.log(`     ${plan.teamaiHome}/`);
    console.log('');
  }
}

// ─── Execution ─────────────────────────────────────────

/**
 * Stop and uninstall local-agent plugins (best-effort) before ~/.teamai is deleted.
 * Dynamic import mirrors source.ts — keeps local-agent's heavy dependency graph out
 * of uninstall's static import chain.
 */
async function teardownPlugins(): Promise<void> {
  try {
    const { teardownLocalAgentPlugins } = await import('./local-agent.js');
    await teardownLocalAgentPlugins();
  } catch (e) {
    log.warn(`plugin teardown failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function executeRemoval(plan: RemovalPlan): Promise<void> {
  // (a) Remove hooks from tool settings (built-in A + team B via the manifest)
  for (const { path: settingsPath, tool } of plan.hookFiles) {
    try {
      await reconcileHooks(settingsPath, tool, [], { removeAll: true, manifestPath: plan.managedHooksPath });
    } catch (e) {
      log.warn(`Failed to remove hooks from ${settingsPath}: ${(e as Error).message}`);
    }
  }

  // (a2) Remove OpenClaw-style hook dirs
  for (const { hooksDir } of plan.openclawHookDirs) {
    try {
      await removeOpenClawHooks(hooksDir);
    } catch (e) {
      log.warn(`Failed to remove OpenClaw hook from ${hooksDir}: ${(e as Error).message}`);
    }
  }

  // (a2b) Remove OpenCode teamai plugin files (main hook + any agent-hook plugins).
  for (const { baseDir, scope } of plan.opencodeHookScopes) {
    try {
      const { removeOpencodeHooks, resolveOpencodePluginDir } = await import('./opencode-hooks.js');
      await removeOpencodeHooks(baseDir, scope);
      // Sweep leftover teamai-agent-*.ts plugins not tracked in the agent-hook
      // manifest. listFilesRecursive yields paths relative to pluginDir.
      const pluginDir = resolveOpencodePluginDir(baseDir, scope);
      if (await pathExists(pluginDir)) {
        for (const rel of await listFilesRecursive(pluginDir)) {
          if (path.basename(rel).startsWith('teamai-agent-')) await remove(path.join(pluginDir, rel));
        }
      }
    } catch (e) {
      log.warn(`Failed to remove OpenCode hook (${scope} scope): ${(e as Error).message}`);
    }
  }

  // (a3) Remove HTTP-source agent hooks across all formats via their manifest
  // (issue #238). Dynamic import mirrors teardownPlugins — keeps local-agent's
  // heavy dependency graph out of uninstall's static import chain. Best-effort.
  try {
    const { removeAllAgentHooks } = await import('./local-agent.js');
    await removeAllAgentHooks();
  } catch (e) {
    log.warn(`Failed to remove agent hooks: ${(e as Error).message}`);
  }

  // (b) Clean CLAUDE.md teamai section blocks
  for (const claudeMdPath of plan.claudeMdFiles) {
    try {
      const raw = await readFileSafe(claudeMdPath);
      if (!raw) continue;

      let content: string = raw;
      for (const [startMarker, endMarker] of CLAUDEMD_MARKER_PAIRS) {
        const startIdx = content.indexOf(startMarker);
        const endIdx = content.indexOf(endMarker);
        if (startIdx === -1 || endIdx === -1) continue;

        const before = content.substring(0, startIdx).replace(/\n+$/, '\n');
        const after = content.substring(endIdx + endMarker.length).replace(/^\n+/, '\n');
        content = (before + after).trim();
      }

      if (content.length === 0) {
        await remove(claudeMdPath);
      } else {
        await writeFile(claudeMdPath, content + '\n');
      }
      log.success(`Cleaned CLAUDE.md: ${claudeMdPath}`);
    } catch (e) {
      log.warn(`Failed to clean CLAUDE.md ${claudeMdPath}: ${(e as Error).message}`);
    }
  }

  // (c) Remove synced skills
  for (const skillDir of plan.skillDirs) {
    try {
      await remove(skillDir);
    } catch (e) {
      log.warn(`Failed to remove skill ${skillDir}: ${(e as Error).message}`);
    }
  }
  if (plan.skillDirs.length > 0) {
    log.success(`Removed ${plan.skillDirs.length} skill directories`);
  }

  // (d) Remove synced rules
  for (const ruleFile of plan.ruleFiles) {
    try {
      await remove(ruleFile);
    } catch (e) {
      log.warn(`Failed to remove rule ${ruleFile}: ${(e as Error).message}`);
    }
  }
  if (plan.ruleFiles.length > 0) {
    log.success(`Removed ${plan.ruleFiles.length} rule files`);
  }

  // (d2) Remove built-in agent files (e.g. teamai-recall)
  for (const agentFile of plan.agentFiles) {
    try {
      await remove(agentFile);
    } catch (e) {
      log.warn(`Failed to remove agent ${agentFile}: ${(e as Error).message}`);
    }
  }
  if (plan.agentFiles.length > 0) {
    log.success(`Removed ${plan.agentFiles.length} agent files`);
  }

  // (e) Clean shell profile env block
  if (plan.shellProfile) {
    try {
      const content = await readFileSafe(plan.shellProfile);
      if (content) {
        const startIdx = content.indexOf(TEAMAI_ENV_START);
        const endIdx = content.indexOf(TEAMAI_ENV_END);
        if (startIdx !== -1 && endIdx !== -1) {
          const before = content.substring(0, startIdx).replace(/\n+$/, '\n');
          const after = content.substring(endIdx + TEAMAI_ENV_END.length).replace(/^\n+/, '\n');
          await writeFile(plan.shellProfile, before + after);
          log.success(`Cleaned shell profile: ${plan.shellProfile}`);
        }
      }
    } catch (e) {
      log.warn(`Failed to clean shell profile: ${(e as Error).message}`);
    }
  }

  // (f) Remove docs directory
  if (plan.docsDir) {
    try {
      await remove(plan.docsDir);
      log.success(`Removed docs: ${plan.docsDir}`);
    } catch (e) {
      log.warn(`Failed to remove docs: ${(e as Error).message}`);
    }
  }

  // (g) Remove ~/.teamai/ directory (last — earlier steps read from it)
  if (plan.teamaiHomeExists) {
    // Tear down plugins first: their manifest/config live under ~/.teamai/local-agent.
    await teardownPlugins();
    try {
      await remove(plan.teamaiHome);
      log.success(`Removed ${plan.teamaiHome}/`);
    } catch (e) {
      log.warn(`Failed to remove ${plan.teamaiHome}: ${(e as Error).message}`);
    }
  }

  // (h) Hermes: clear teamai-managed entries — the SOUL.md rules block, the
  // status-report hook (config.yaml + allowlist + script). Gated on hermesCleanup
  // so a targeted `--agent <other>` uninstall never touches ~/.hermes. No-op safe.
  if (plan.hermesCleanup) {
    try {
      const { removeHermesHooks } = await import('./hermes-hooks.js');
      const { removeSoulRules } = await import('./hermes-config.js');
      await removeHermesHooks();
      await removeSoulRules();
    } catch (e) {
      log.debug(`Hermes uninstall cleanup skipped: ${(e as Error).message}`);
    }
  }
}

// ─── Public API ────────────────────────────────────────

export async function uninstall(opts: UninstallOptions): Promise<void> {
  let localConfig: LocalConfig | null = null;
  let teamConfig: TeamaiConfig | null = null;

  try {
    const result = await autoDetectInit();
    localConfig = result.localConfig;
    teamConfig = result.teamConfig;
  } catch {
    log.warn('teamai configuration not found or invalid');
  }

  if (localConfig && teamConfig) {
    // Full uninstall with discovery
    let agentKey: string | undefined = opts.agent;
    if (opts.agent) {
      const tools = Object.keys(teamConfig.toolPaths);
      const matched = tools.find((t) => t.toLowerCase() === opts.agent!.toLowerCase());
      if (!matched) {
        log.error(`Unknown tool "${opts.agent}". Available tools: ${tools.join(', ')}`);
        process.exitCode = 2;
        return;
      }
      agentKey = matched; // normalize to canonical toolPaths key
    }
    const plan = await buildRemovalPlan(localConfig, teamConfig, agentKey);

    if (isPlanEmpty(plan)) {
      log.info('Nothing to uninstall');
      return;
    }

    printSummary(plan, agentKey);

    if (opts.dryRun) {
      log.info('Dry run — no changes made');
      return;
    }

    if (!opts.force) {
      const confirmed = await askConfirmation('Confirm uninstall? [y/N] ');
      if (!confirmed) {
        log.info('Cancelled');
        return;
      }
    }

    // MCP cleanup must run before executeRemoval deletes ~/.teamai/: ownership is
    // tracked in managed-mcp.json inside that directory. Hooks already do this
    // inside executeRemoval for the same reason. MCP servers are shared
    // resources (see buildRemovalPlan), so only reconcile them away when this
    // uninstall includes shared resources — a targeted non-last-tool uninstall
    // must leave the remaining tools' MCP servers intact.
    if (plan.includeShared) {
      try {
        const { reconcileMcpForConfig } = await import('./mcp-reconcile.js');
        const { changes } = await reconcileMcpForConfig(teamConfig, localConfig, { removeAll: true });
        const removed = changes.filter((c) => c.action === 'removed');
        if (removed.length > 0) log.info(`Removed ${removed.length} teamai-managed MCP server(s)`);
      } catch (e) {
        log.warn(`Failed to remove MCP servers: ${(e as Error).message}`);
      }
    }

    await executeRemoval(plan);

    // Persist the exclusion so the next pull (or another tool's session-start
    // hook) does not resurrect this tool's resources. Only meaningful when the
    // shared ~/.teamai home survives (non-last-tool uninstall); on a last-tool
    // uninstall the home is deleted and there is nothing to persist.
    if (agentKey && !plan.includeShared) {
      const cfg = localConfig!;
      // Only prune an existing whitelist. Leaving `enabledAgents` undefined
      // (meaning "all tools") as-is is important: collapsing it to [] would be
      // read by the hook path as "whitelist nothing" and stop hook sync for the
      // remaining tools too. The disabledAgents exclusion below is what actually
      // keeps the uninstalled tool out on the next pull.
      if (cfg.enabledAgents) {
        cfg.enabledAgents = cfg.enabledAgents.filter((t) => t !== agentKey);
      }
      const prevDisabled = cfg.disabledAgents ?? [];
      cfg.disabledAgents = [...new Set([...prevDisabled, agentKey])];
      if (cfg.scope === 'project') {
        await saveLocalConfigForScope(cfg, cfg.scope, cfg.projectRoot);
      } else {
        await saveLocalConfig(cfg);
      }
    }

    log.success('teamai uninstalled');
  } else {
    // Minimal uninstall — just try to remove ~/.teamai/
    if (opts.agent) {
      log.warn('No valid teamai configuration detected; cannot target a specific tool with --agent');
      process.exitCode = 2;
      return;
    }
    const home = path.join(getUserHome(), '.teamai');
    if (!await pathExists(home)) {
      log.info('Nothing to uninstall');
      return;
    }

    console.log('');
    console.log('⚠  Uninstalling user scope (no valid configuration detected — home directory only)');
    console.log('⚠  The following TeamAI home directory will be removed:');
    console.log(`     ${home}/`);
    console.log('');

    if (opts.dryRun) {
      log.info('Dry run — no changes made');
      return;
    }

    if (!opts.force) {
      const confirmed = await askConfirmation('Confirm uninstall? [y/N] ');
      if (!confirmed) {
        log.info('Cancelled');
        return;
      }
    }

    try {
      await teardownPlugins();
      await remove(home);
      log.success(`Removed ${home}/`);
      log.success('teamai uninstalled');
    } catch (e) {
      log.warn(`Failed to remove ${home}: ${(e as Error).message}`);
    }
  }
}
