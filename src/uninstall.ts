import path from 'node:path';
import { autoDetectInit, saveLocalConfig, saveLocalConfigForScope } from './config.js';
import { reconcileHooks, hasTeamaiHooks } from './hooks.js';
import { removeOpenClawHooks, OPENCLAW_HOOK_DIR, resolveOpenClawHooksDir } from './openclaw-hooks.js';
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
  listFilesRecursive,
  expandHome,
} from './utils/fs.js';
import { log } from './utils/logger.js';
import { askConfirmation } from './utils/prompt.js';

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
  claudeMdFiles: string[];
  skillDirs: string[];
  ruleFiles: string[];
  agentFiles: string[];
}

function hasToolResources(r: ToolResources): boolean {
  return (
    r.hookFiles.length > 0 ||
    r.openclawHookDirs.length > 0 ||
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

function detectShellProfile(): string | null {
  const home = process.env.HOME;
  if (!home) return null;
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

/** Detect hooks cleared to empty arrays — a residue of prior teamai installation. */
function isEmptyHooksResidue(parsed: Record<string, unknown> | null): boolean {
  if (parsed == null || !('hooks' in parsed) || typeof parsed.hooks !== 'object' || parsed.hooks == null) return false;
  const entries = Object.values(parsed.hooks as Record<string, unknown>);
  return entries.length > 0 && entries.every((v) => Array.isArray(v) && v.length === 0);
}

// ─── Discovery ─────────────────────────────────────────

async function discoverToolResources(
  tool: string,
  toolPath: TeamaiConfig['toolPaths'][string],
  baseDir: string,
  teamSkillNames: Set<string>,
  teamRuleNames: Set<string>,
  managedHooksPath: string,
): Promise<ToolResources> {
  const res: ToolResources = {
    hookFiles: [], openclawHookDirs: [], claudeMdFiles: [],
    skillDirs: [], ruleFiles: [], agentFiles: [],
  };

  // (a) Hooks — settings.json / hooks.json
  if (toolPath.settings) {
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
    const skillsDir = path.join(baseDir, toolPath.skills);
    if (await pathExists(skillsDir)) {
      const dirs = await listDirs(skillsDir);
      for (const dir of dirs) {
        if (teamSkillNames.has(dir)) {
          res.skillDirs.push(path.join(skillsDir, dir));
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

  // (d2) Built-in agents — CLI-deployed subagents (e.g. teamai-recall).
  // Not synced from the team repo, so match by BUILTIN_AGENT_NAMES.
  if (toolPath.agents) {
    const agentsDir = path.join(baseDir, toolPath.agents);
    if (await pathExists(agentsDir)) {
      for (const name of BUILTIN_AGENT_NAMES) {
        const agentFile = path.join(agentsDir, `${name}.md`);
        if (await pathExists(agentFile)) {
          res.agentFiles.push(agentFile);
        }
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

  // Also include resources installed by local-agent (HTTP distribution)
  const localAgentManifestPath = path.join(
    process.env.HOME ?? '', '.teamai', 'local-agent', 'manifest.json',
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
  for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
    perTool.set(
      tool,
      await discoverToolResources(tool, toolPath, baseDir, teamSkillNames, teamRuleNames, managedHooksPath),
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
    // no-op for shared resources (plan will be empty → "没有需要卸载的内容").
    includeShared = targetHasResources && !othersHaveResources;
  } else {
    toolsToMerge = [...perTool.keys()];
    includeShared = true;
  }

  const plan: RemovalPlan = {
    hookFiles: [],
    openclawHookDirs: [],
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
  const cn = plan.scope === 'project' ? '项目级' : '用户级';
  console.log('');
  console.log(`⚠  正在卸载 ${plan.scope} scope（${cn}）— ${plan.teamaiHome}`);
  if (agentFilter) {
    const sharedNote = plan.includeShared
      ? ' (last tool — shared resources removed too)'
      : ' (shared resources kept for remaining tools)';
    console.log(`⚠  Uninstalling tool only: ${agentFilter}${sharedNote}`);
  }
  console.log('⚠  以下 teamai 资源将被移除:');
  console.log('');

  if (plan.hookFiles.length > 0) {
    console.log(`   Hooks (${plan.hookFiles.length} 个文件):`);
    for (const { path: p } of plan.hookFiles) {
      console.log(`     ${p}`);
    }
    console.log('');
  }

  if (plan.openclawHookDirs.length > 0) {
    console.log(`   OpenClaw Hooks (${plan.openclawHookDirs.length} 个目录):`);
    for (const { hooksDir } of plan.openclawHookDirs) {
      console.log(`     ${path.join(hooksDir, OPENCLAW_HOOK_DIR)}/`);
    }
    console.log('');
  }

  if (plan.claudeMdFiles.length > 0) {
    console.log(`   CLAUDE.md 规则块 (${plan.claudeMdFiles.length} 个文件):`);
    for (const p of plan.claudeMdFiles) {
      console.log(`     ${p}`);
    }
    console.log('');
  }

  if (plan.skillDirs.length > 0) {
    console.log(`   Skills (${plan.skillDirs.length} 个目录)`);
    console.log('');
  }

  if (plan.ruleFiles.length > 0) {
    console.log(`   Rules (${plan.ruleFiles.length} 个文件)`);
    console.log('');
  }

  if (plan.agentFiles.length > 0) {
    console.log(`   Agents (${plan.agentFiles.length} 个文件)`);
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
    console.log('   Shell profile 环境变量块:');
    console.log(`     ${plan.shellProfile}`);
    console.log('');
  }

  if (plan.docsDir) {
    console.log('   Docs 目录:');
    console.log(`     ${plan.docsDir}`);
    console.log('');
  }

  if (plan.teamaiHomeExists) {
    console.log('   TeamAI 主目录:');
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
      log.warn(`移除 hooks 失败 ${settingsPath}: ${(e as Error).message}`);
    }
  }

  // (a2) Remove OpenClaw-style hook dirs
  for (const { hooksDir } of plan.openclawHookDirs) {
    try {
      await removeOpenClawHooks(hooksDir);
    } catch (e) {
      log.warn(`移除 OpenClaw hook 失败 ${hooksDir}: ${(e as Error).message}`);
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
      log.success(`清理 CLAUDE.md: ${claudeMdPath}`);
    } catch (e) {
      log.warn(`清理 CLAUDE.md 失败 ${claudeMdPath}: ${(e as Error).message}`);
    }
  }

  // (c) Remove synced skills
  for (const skillDir of plan.skillDirs) {
    try {
      await remove(skillDir);
    } catch (e) {
      log.warn(`移除 skill 失败 ${skillDir}: ${(e as Error).message}`);
    }
  }
  if (plan.skillDirs.length > 0) {
    log.success(`移除了 ${plan.skillDirs.length} 个 skill 目录`);
  }

  // (d) Remove synced rules
  for (const ruleFile of plan.ruleFiles) {
    try {
      await remove(ruleFile);
    } catch (e) {
      log.warn(`移除 rule 失败 ${ruleFile}: ${(e as Error).message}`);
    }
  }
  if (plan.ruleFiles.length > 0) {
    log.success(`移除了 ${plan.ruleFiles.length} 个 rule 文件`);
  }

  // (d2) Remove built-in agent files (e.g. teamai-recall)
  for (const agentFile of plan.agentFiles) {
    try {
      await remove(agentFile);
    } catch (e) {
      log.warn(`移除 agent 失败 ${agentFile}: ${(e as Error).message}`);
    }
  }
  if (plan.agentFiles.length > 0) {
    log.success(`移除了 ${plan.agentFiles.length} 个 agent 文件`);
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
          log.success(`清理 shell profile: ${plan.shellProfile}`);
        }
      }
    } catch (e) {
      log.warn(`清理 shell profile 失败: ${(e as Error).message}`);
    }
  }

  // (f) Remove docs directory
  if (plan.docsDir) {
    try {
      await remove(plan.docsDir);
      log.success(`移除 docs: ${plan.docsDir}`);
    } catch (e) {
      log.warn(`移除 docs 失败: ${(e as Error).message}`);
    }
  }

  // (g) Remove ~/.teamai/ directory (last — earlier steps read from it)
  if (plan.teamaiHomeExists) {
    // Tear down plugins first: their manifest/config live under ~/.teamai/local-agent.
    await teardownPlugins();
    try {
      await remove(plan.teamaiHome);
      log.success(`移除 ${plan.teamaiHome}/`);
    } catch (e) {
      log.warn(`移除 ${plan.teamaiHome} 失败: ${(e as Error).message}`);
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
    log.warn('teamai 配置未找到或无效');
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
      log.info('没有需要卸载的内容');
      return;
    }

    printSummary(plan, agentKey);

    if (opts.dryRun) {
      log.info('Dry run — 未做任何更改');
      return;
    }

    if (!opts.force) {
      const confirmed = await askConfirmation('确认卸载? [y/N] ');
      if (!confirmed) {
        log.info('已取消');
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

    log.success('teamai 卸载完成');
  } else {
    // Minimal uninstall — just try to remove ~/.teamai/
    if (opts.agent) {
      log.warn('No valid teamai configuration detected; cannot target a specific tool with --agent');
      process.exitCode = 2;
      return;
    }
    const homeDir = process.env.HOME;
    if (!homeDir) {
      log.error('无法确定用户主目录（HOME 环境变量未设置）');
      return;
    }
    const home = path.join(homeDir, '.teamai');
    if (!await pathExists(home)) {
      log.info('没有需要卸载的内容');
      return;
    }

    console.log('');
    console.log('⚠  正在卸载 user scope（用户级，未检测到有效配置，仅清理主目录）');
    console.log('⚠  将移除 TeamAI 主目录:');
    console.log(`     ${home}/`);
    console.log('');

    if (opts.dryRun) {
      log.info('Dry run — 未做任何更改');
      return;
    }

    if (!opts.force) {
      const confirmed = await askConfirmation('确认卸载? [y/N] ');
      if (!confirmed) {
        log.info('已取消');
        return;
      }
    }

    try {
      await teardownPlugins();
      await remove(home);
      log.success(`移除 ${home}/`);
      log.success('teamai 卸载完成');
    } catch (e) {
      log.warn(`移除 ${home} 失败: ${(e as Error).message}`);
    }
  }
}
