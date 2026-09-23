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
  getDataHome,
  getManagedHooksPath,
  isAgentExcluded,
  managedMcpManifestPath,
  resolveBaseDir,
  resolveHookScope,
  resolveLegacyProjectHookScope,
  resolveToolBaseDir,
  scopedToolPaths,
  type GlobalOptions,
  type TeamaiConfig,
  type LocalConfig,
  type Scope,
  type ManagedMcpManifest,
} from './types.js';
import { BUILTIN_RULE_NAMES } from './builtin-rules.js';
import { ruleStemFromFilename } from './resources/rule-format.js';
import { agentStemFromFilename } from './resources/agent-format.js';
import { resolveDocsDestination } from './resources/docs.js';
import { listTeamAgentDirs } from './resources/agents.js';
import { isToolInstalledForConfig } from './resources/base.js';
import { BUILTIN_AGENT_NAMES } from './builtin-agents.js';
import {
  BUILTIN_SKILL_NAMES,
  LEGACY_BUILTIN_SKILL_NAMES,
  ownedSkillFiles,
  isCliOwnedSkillName,
  prunedWhole,
  removeOwnedFiles,
  skillsGuardBase,
} from './builtin-skills.js';
import { getHermesHome } from './hermes-home.js';
import { CODEX_TOOL, SHARED_AGENT_SKILLS_PATH } from './resources/skills.js';
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
import {
  detectShellProfile,
  extractEnvBlock,
  envBlockReferencesDataHome,
  SHELL_PROFILE_CANDIDATE_NAMES,
} from './utils/shell-profile.js';

// ─── Types ─────────────────────────────────────────────

interface UninstallOptions extends GlobalOptions {
  force?: boolean;
  agent?: string;
}

interface RemovalPlan {
  /** Tool settings files that contain teamai hooks (each with the manifest that
   *  recorded its team hooks — HOME/user or a legacy <projectRoot>/project one). */
  hookFiles: Array<{ path: string; tool: string; manifestPath: string }>;
  /** OpenClaw-style hook dirs (<base>/.<tool>/hooks) holding teamai HOOK.md+handler.ts. */
  openclawHookDirs: Array<{ hooksDir: string; tool: string }>;
  /** OpenCode teamai plugin files (.opencode/plugin/teamai-*.ts) to delete. */
  opencodeHookScopes: Array<{ baseDir: string; scope: Scope }>;
  /** teamai-managed OMP extension file (~/.omp/agent/extensions/teamai-hooks.ts), if present. */
  ompHookFile: string | null;
  /** Pi extension files owned by this scope (global for user, legacy project copy for project). */
  piHookFiles: string[];
  /** TeamAI-managed DeepSeek Harness patch (~/.teamai/dsh/cordis.patch.yml), if present. */
  dshHookFile: string | null;
  /** Manifest used by the primary hook injection scope. */
  hookManifestPath: string;
  /** CLAUDE.md files with teamai rules blocks. */
  claudeMdFiles: string[];
  /**
   * Skill directories synced from team repo, each with the base directory its
   * skills root hangs off: the prune refuses a link anywhere below that base.
   */
  skillDirs: SkillDirEntry[];
  /** Rule .md files synced from team repo (plus CLI built-in rules). */
  ruleFiles: string[];
  /** Built-in agent .md files deployed by the CLI (e.g. teamai-recall). */
  agentFiles: string[];
  /** teamai-managed MCP servers from managed-mcp.json (`tool/server` or `tool:project/server`). */
  mcpServers: string[];
  /** Shell profile paths carrying a teamai env block (usually one, but see #682/#693). */
  shellProfiles: string[];
  /** Docs directory (null if doesn't exist). */
  docsDir: string | null;
  /** The .teamai home directory path. */
  teamaiHome: string;
  /** Whether teamaiHome exists on disk. */
  teamaiHomeExists: boolean;
  /** Whether shared resources (docs / ~/.teamai / shell profile) are part of this removal. */
  includeShared: boolean;
  /** Whether this removal targets Hermes (clears its SOUL.md block + config.yaml hook). */
  hermesCleanup: boolean;
  /** Scope being uninstalled (issue #73: surfaced to the user). */
  scope: Scope;
}

/** Per-tool findings collected during discovery (tool-specific resources only). */
/** A skill directory to remove, and the base the link guard starts from. */
interface SkillDirEntry {
  dir: string;
  baseDir: string;
}

interface ToolResources {
  hookFiles: Array<{ path: string; tool: string; manifestPath: string }>;
  openclawHookDirs: Array<{ hooksDir: string; tool: string }>;
  opencodeHookScopes: Array<{ baseDir: string; scope: Scope }>;
  ompHookFile: string | null;
  piHookFiles: string[];
  dshHookFile: string | null;
  claudeMdFiles: string[];
  skillDirs: SkillDirEntry[];
  ruleFiles: string[];
  agentFiles: string[];
}

function hasToolResources(r: ToolResources): boolean {
  return (
    r.hookFiles.length > 0 ||
    r.openclawHookDirs.length > 0 ||
    r.opencodeHookScopes.length > 0 ||
    r.ompHookFile !== null ||
    r.piHookFiles.length > 0 ||
    r.dshHookFile !== null ||
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

/**
 * Collect custom agent names from canonical YAML and legacy Markdown files,
 * at the root and one level of `agents/<namespace>/` (role-scoped agents
 * deploy flattened, so their stems are removal candidates too).
 */
async function collectTeamAgentNames(repoPath: string): Promise<Set<string>> {
  const teamAgentsDir = path.join(repoPath, 'agents');
  if (!await pathExists(teamAgentsDir)) return new Set();

  const names = new Set<string>();
  for (const { dir } of await listTeamAgentDirs(teamAgentsDir)) {
    for (const file of await listFiles(dir)) {
      if (file.endsWith('.yaml') || file.endsWith('.md')) names.add(file.replace(/\.(yaml|md)$/, ''));
    }
  }
  return names;
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
  /** Home, or the project root: where the skills link guard starts (`skillsGuardBase`). */
  scopeRoot: string,
  teamSkillNames: Set<string>,
  teamRuleNames: Set<string>,
  teamAgentNames: Set<string>,
  hookTargets: Array<{ baseDir: string; manifestPath: string }>,
  standaloneHookManifestPath: string,
  scope: Scope,
  /**
   * The settings file's path at the scope hooks were injected into
   * (`resolveHookScope`), which is not the config's scope for a non-self project
   * scope. Only hook discovery uses it: a tool whose user-scope prefix differs
   * from its project-scope one (Qoder CN: `~/.qoder-cn` vs `<root>/.qoder`) would
   * otherwise be searched for in the other build's file, leaving its hooks in
   * HOME forever.
   */
  hookSettingsPath?: string,
): Promise<ToolResources> {
  const res: ToolResources = {
    hookFiles: [], openclawHookDirs: [], opencodeHookScopes: [], ompHookFile: null, piHookFiles: [], dshHookFile: null,
    claudeMdFiles: [], skillDirs: [], ruleFiles: [], agentFiles: [],
  };

  // (a) Hooks — settings.json / hooks.json
  if (toolPath.hooks) {
    const hooksPath = path.join(baseDir, toolPath.hooks);
    if (await pathExists(hooksPath)
      && (await hasTeamaiHooks(hooksPath, tool, standaloneHookManifestPath)
        || isEmptyHooksResidue(await readJson<Record<string, unknown>>(hooksPath)))) {
      res.hookFiles.push({
        path: hooksPath,
        tool,
        manifestPath: standaloneHookManifestPath,
      });
    }
  } else if (tool === 'dsh') {
    const { resolveDshPatchPath } = await import('./dsh-hooks.js');
    const patchPath = resolveDshPatchPath();
    if (await pathExists(patchPath)) res.dshHookFile = patchPath;
  } else if (tool === 'opencode') {
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
  } else if (tool === 'omp') {
    // OMP hooks are a single teamai-managed TS extension in the user agent dir
    // (~/.omp/agent/extensions/teamai-hooks.ts) — the adapter never writes a
    // project copy, so there is just the one place to look.
    const { resolveOmpExtensionsDir, OMP_HOOK_FILE } = await import('./omp-hooks.js');
    const extFile = path.join(resolveOmpExtensionsDir(), OMP_HOOK_FILE);
    if (await pathExists(extFile)) {
      res.ompHookFile = extFile;
    }
  } else if (tool === 'pi') {
    const {
      hasPiHooks,
      hasPiAgentHook,
      resolvePiExtensionsDir,
      resolvePiProjectExtensionsDir,
      PI_HOOK_FILE,
    } = await import('./pi-hooks.js');
    // Mirrors OMP: a targeted uninstall removes the single global extension
    // outright, regardless of scope. Pi has no way to scope a shared file to
    // one project — the generated extension fires for every Pi session
    // machine-wide — so a scoped "preserve for other projects" guarantee was
    // never actually enforceable, and pretending otherwise just left Pi still
    // firing hooks for a project that had supposedly uninstalled it.
    if (await hasPiHooks()) {
      res.piHookFiles.push(path.join(resolvePiExtensionsDir(), PI_HOOK_FILE));
    }
    // Server-pushed agent hooks (teamai-agent-<slug>.ts) always install into
    // the global extension dir and can exist without the main lifecycle
    // extension — mirrors OpenCode's discovery, which scans for the same
    // leftover-plugin pattern so a Pi-only agent-hook install isn't missed.
    // Each match is marker-checked by its own slug so a same-named file a
    // user authored by hand is never swept up.
    for (const file of await listFiles(resolvePiExtensionsDir())) {
      const base = path.basename(file);
      if (!base.startsWith('teamai-agent-') || !base.endsWith('.ts')) continue;
      const slug = base.slice('teamai-agent-'.length, -'.ts'.length);
      if (await hasPiAgentHook(slug)) {
        res.piHookFiles.push(path.join(resolvePiExtensionsDir(), file));
      }
    }
    // Clean up a TeamAI-marked legacy project copy left by an earlier
    // revision, when this discovery pass is scoped to an actual project.
    if (path.resolve(baseDir) !== path.resolve(getUserHome()) && await hasPiHooks(baseDir)) {
      res.piHookFiles.push(path.join(resolvePiProjectExtensionsDir(baseDir), PI_HOOK_FILE));
    }
  } else if (toolPath.settings) {
    // Hooks live where resolveHookScope injected them (HOME for a non-self
    // project scope, per #370) — plus any legacy <projectRoot> copy. Scan every
    // target and tag each match with the manifest that recorded its team hooks,
    // so removal strips the right entries at each location. The file name comes
    // from the same scope decision (`hookSettingsPath`), not from `toolPath` —
    // except for the legacy copy, written into <projectRoot> by a CLI that knew
    // nothing about a member's relocated root, so it sits at the team path.
    for (const { baseDir: hookBaseDir, manifestPath } of hookTargets) {
      const settingsRel = path.resolve(hookBaseDir) === path.resolve(getUserHome())
        ? (hookSettingsPath ?? toolPath.settings)
        : toolPath.settings;
      const settingsPath = path.join(hookBaseDir, settingsRel);
      if (await pathExists(settingsPath)
        && (await hasTeamaiHooks(settingsPath, tool, manifestPath)
          || isEmptyHooksResidue(await readJson<Record<string, unknown>>(settingsPath)))) {
        res.hookFiles.push({ path: settingsPath, tool, manifestPath });
      }
    }
  } else {
    // OpenClaw-style agents (no settings file) inject a HOOK.md + handler.ts
    // under <hooksDir>/<OPENCLAW_HOOK_DIR>. Check the default path, the
    // OPENCLAW_STATE_DIR override (imate containers), and the resolved
    // workspace dir — injection now targets `<workspace>/hooks`, so teardown
    // must cover it too, otherwise the hook is orphaned on uninstall.
    const defaultHooksDir = path.join(baseDir, `.${tool}`, 'hooks');
    const resolvedHooksDir = resolveOpenClawHooksDir(tool);
    const dirsToCheck = new Set([defaultHooksDir, resolvedHooksDir]);
    const workspaceDir = await resolveOpenclawWorkspaceDir();
    if (workspaceDir) {
      dirsToCheck.add(path.join(workspaceDir, 'hooks'));
    }
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
    // Skills root → the base the link guard starts from.
    const configuredSkills = path.join(baseDir, toolPath.skills);
    const skillRoots = new Map([[configuredSkills, skillsGuardBase(scopeRoot, configuredSkills)]]);
    // OpenClaw and Hermes receive skills where team sync and the stub put them
    // (`skillsDirForTool`): the workspace, and HERMES_HOME.
    if (tool === 'openclaw') {
      const workspaceDir = await resolveOpenclawWorkspaceDir();
      if (workspaceDir) {
        const workspaceSkills = path.join(workspaceDir, 'skills');
        skillRoots.set(workspaceSkills, skillsGuardBase(scopeRoot, workspaceSkills));
      }
    }
    if (tool === 'hermes') {
      const hermesSkills = path.join(getHermesHome(), 'skills');
      skillRoots.set(hermesSkills, skillsGuardBase(scopeRoot, hermesSkills));
    }
    // `resolveSkillDestination` writes Codex's copy into the shared
    // .agents/skills root whenever that skill already lives there, so uninstall
    // must look where deployment could have put it — the legacy prune already
    // does. Codex only: another tool's pass must not reach into it.
    if (tool === CODEX_TOOL) {
      const sharedSkills = path.join(baseDir, SHARED_AGENT_SKILLS_PATH);
      skillRoots.set(sharedSkills, skillsGuardBase(scopeRoot, sharedSkills));
    }
    for (const [skillsDir, rootBase] of skillRoots) {
      if (await pathExists(skillsDir)) {
        const dirs = await listDirs(skillsDir);
        for (const dir of dirs) {
          if (teamSkillNames.has(dir)) {
            res.skillDirs.push({ dir: path.join(skillsDir, dir), baseDir: rootBase });
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
        // Cursor's copies are `.mdc`; match by stem so both extensions are
        // collected and uninstall does not leave team rules behind.
        const ruleName = ruleStemFromFilename(file);
        if (ruleName === null) continue;
        if (teamRuleNames.has(ruleName)) {
          res.ruleFiles.push(path.join(rulesDir, file));
        }
      }
    }
  }

  // (d2) Team-synced custom agents plus CLI built-ins. Native output uses
  // .agent.md for Copilot, .md for most tools, .toml for Codex, and .json for
  // Kiro, so match by stem.
  if (toolPath.agents) {
    const agentsDir = path.join(baseDir, toolPath.agents);
    if (await pathExists(agentsDir)) {
      for (const file of await listFiles(agentsDir)) {
        const name = agentStemFromFilename(path.basename(file));
        if (name === null) continue;
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
  const teamaiHome = getDataHome(localConfig);
  const standaloneHookManifestPath = getManagedHooksPath(
    localConfig.scope,
    localConfig.projectRoot,
  );

  // Discover team repo resource names for targeted removal. CLI built-in
  // resources (recall agent/rule, share-learnings skill, …) are deployed by
  // the CLI itself rather than synced from the team repo, so fold their names
  // in explicitly — otherwise uninstall leaks them (they match neither the
  // team-repo set nor a user-authored resource).
  const repoPath = localConfig.repo.localPath;
  const teamSkillNames = await collectTeamSkillNames(repoPath);
  for (const name of BUILTIN_SKILL_NAMES) teamSkillNames.add(name);
  // Directories earlier releases deployed: uninstall would otherwise leave the
  // pre-stub skill trees behind on any machine that upgraded.
  for (const name of LEGACY_BUILTIN_SKILL_NAMES) teamSkillNames.add(name);
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

  // Discover per-tool resources. Hooks are discovered at the injection target
  // resolveHookScope reports (HOME + user manifest for a non-self project scope,
  // #370) — the previous code scanned <projectRoot>, so uninstall silently left
  // the SessionStart hook live in HOME forever. A legacy <projectRoot> copy from
  // a pre-#370 CLI is swept too, tagged with its project manifest.
  const primaryHookScope = resolveHookScope(localConfig);
  const hookTargets = [primaryHookScope];
  const legacyHookScope = resolveLegacyProjectHookScope(localConfig);
  if (legacyHookScope) hookTargets.push(legacyHookScope);
  // Hook discovery resolves its file name at the same scope as the targets: a
  // non-self project scope discovers under HOME, so the tool paths there must be
  // the user-scope ones (previously the project-scope name was used, and a tool
  // whose two scopes differ kept its hooks in HOME forever). Skills, rules,
  // agents and CLAUDE.md stay on the config-scope paths below — those are real
  // project resources.
  const hookToolPaths = scopedToolPaths(teamConfig, { ...localConfig, scope: primaryHookScope.scope });
  const perTool = new Map<string, ToolResources>();
  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    perTool.set(
      tool,
      await discoverToolResources(
        tool,
        toolPath,
        resolveToolBaseDir(tool, localConfig),
        resolveBaseDir(localConfig),
        teamSkillNames,
        teamRuleNames,
        teamAgentNames,
        hookTargets,
        standaloneHookManifestPath,
        localConfig.scope,
        hookToolPaths[tool]?.settings,
      ),
    );
  }

  // A tool only still "uses" a shared resource (AGENTS.md, .teamai/) if it is
  // actually enabled and installed. Several tools default to the same shared
  // path — e.g. Hermes/WorkBuddy default to the same project AGENTS.md as Pi —
  // so a schema entry that merely shares a path must not block cleanup for a
  // tool that was never enabled or set up. The probe path must be a
  // tool-specific root (skills/rules/settings), never `claudemd`: that's
  // exactly the shared, ambiguous path this check exists to disambiguate.
  const activeTools = new Set<string>();
  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    if (isAgentExcluded(localConfig, tool)) continue;
    const probePath = toolPath.skills ?? toolPath.rules ?? toolPath.settings ?? toolPath.claudemd;
    if (probePath && await isToolInstalledForConfig(tool, probePath, localConfig)) {
      activeTools.add(tool);
    }
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
      .some(([t, r]) => t !== agentFilter && activeTools.has(t) && hasToolResources(r));
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
    ompHookFile: null,
    piHookFiles: [],
    dshHookFile: null,
    hookManifestPath: hookTargets[0].manifestPath,
    claudeMdFiles: [],
    skillDirs: [],
    ruleFiles: [],
    agentFiles: [],
    mcpServers: [],
    shellProfiles: [],
    docsDir: null,
    teamaiHome,
    teamaiHomeExists: includeShared && await pathExists(teamaiHome),
    includeShared,
    hermesCleanup: toolsToMerge.includes('hermes'),
    scope: localConfig.scope,
  };

  // A single instruction file can be the native target for several agents
  // (for example project `AGENTS.md` is shared by Pi, Hermes, and WorkBuddy).
  // Keep its TeamAI blocks when another enabled, installed agent still
  // references the same file; a targeted uninstall must not remove
  // instructions owned by that remaining agent.
  const retainedInstructionFiles = new Set<string>();
  for (const [tool, resources] of perTool) {
    if (!toolsToMerge.includes(tool) && activeTools.has(tool)) {
      for (const file of resources.claudeMdFiles) retainedInstructionFiles.add(file);
    }
  }

  // Merge tool-specific resources for selected tools
  for (const tool of toolsToMerge) {
    const res = perTool.get(tool);
    if (!res) continue;
    plan.hookFiles.push(...res.hookFiles);
    plan.openclawHookDirs.push(...res.openclawHookDirs);
    plan.opencodeHookScopes.push(...res.opencodeHookScopes);
    if (res.ompHookFile) plan.ompHookFile = res.ompHookFile;
    plan.piHookFiles.push(...res.piHookFiles);
    if (res.dshHookFile) plan.dshHookFile = res.dshHookFile;
    for (const file of res.claudeMdFiles) {
      if (!retainedInstructionFiles.has(file) && !plan.claudeMdFiles.includes(file)) {
        plan.claudeMdFiles.push(file);
      }
    }
    plan.skillDirs.push(...res.skillDirs);
    plan.ruleFiles.push(...res.ruleFiles);
    plan.agentFiles.push(...res.agentFiles);
  }

  if (includeShared) {
    // (d3) teamai-managed MCP servers, tracked in managed-mcp.json (same
    // ownership model as hooks). Project scope reads THIS worktree's own
    // per-worktree manifest; user scope reads the single global file.
    const mcpManifestPath = expandHome(
      managedMcpManifestPath(
        getDataHome(localConfig),
        localConfig.scope === 'project' ? localConfig.projectRoot : undefined,
      ),
    );
    const mcpManifest = (await readJson<ManagedMcpManifest>(mcpManifestPath)) ?? {};
    for (const [toolKey, records] of Object.entries(mcpManifest)) {
      for (const rec of records ?? []) {
        if (rec?.name) plan.mcpServers.push(`${toolKey}/${rec.name}`);
      }
    }
    plan.mcpServers.sort();

    // (e) Shell profile env block(s). Scan every profile file teamai could
    // ever have written to, not just the one detectShellProfile() resolves to
    // today: the Windows fix (#682) changed which file `pull` prefers, so a
    // machine last pulled with an older CLI can carry a stale block in a file
    // the current resolution no longer points at, and a plain uninstall would
    // silently leave that managed block behind.
    //
    // A candidate only counts if its block actually names THIS scope's
    // env.sh (envBlockReferencesDataHome) — matching on the marker alone
    // would let this uninstall delete a different scope's still-active block
    // just because it also happens to live in one of the candidate
    // filenames. This check is deliberately looser than doctor's "does it
    // load" check: a legacy block written by a pre-#661/#682 CLI (raw
    // backslashes, or the MSYS drive form) still belongs to this scope and
    // still has to be found and removed, even though it never worked.
    const configuredProfilePath = teamConfig.sharing.env.shellProfilePath
      ? expandHome(teamConfig.sharing.env.shellProfilePath)
      : await detectShellProfile();
    const home = getUserHome();
    const envShPath = path.join(getDataHome(localConfig), 'env.sh');
    const candidateProfilePaths = Array.from(new Set([
      configuredProfilePath,
      ...SHELL_PROFILE_CANDIDATE_NAMES.map((name) => path.join(home, name)),
    ]));
    for (const candidate of candidateProfilePaths) {
      const profileContent = await readFileSafe(candidate);
      const block = profileContent ? extractEnvBlock(profileContent) : null;
      if (block && envBlockReferencesDataHome(block, envShPath)) {
        plan.shellProfiles.push(candidate);
      }
    }

    // (f) Docs directory
    const docsDir = resolveDocsDestination(teamConfig, localConfig);
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
    plan.ompHookFile === null &&
    plan.piHookFiles.length === 0 &&
    plan.dshHookFile === null &&
    plan.claudeMdFiles.length === 0 &&
    plan.skillDirs.length === 0 &&
    plan.ruleFiles.length === 0 &&
    plan.agentFiles.length === 0 &&
    plan.mcpServers.length === 0 &&
    plan.shellProfiles.length === 0 &&
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

  if (plan.ompHookFile !== null) {
    console.log('   OMP Hook (extension):');
    console.log(`     ${plan.ompHookFile}`);
    console.log('');
  }
  if (plan.piHookFiles.length > 0) {
    console.log(`   Pi Hooks (${plan.piHookFiles.length} files):`);
    for (const p of plan.piHookFiles) console.log(`     ${p}`);
    console.log('');
  }

  if (plan.dshHookFile !== null) {
    console.log('   DeepSeek Harness hook patch:');
    console.log(`     ${plan.dshHookFile}`);
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
    for (const { dir: skillDir } of plan.skillDirs) {
      // A CLI-owned directory loses the files TeamAI packaged, not whatever the
      // member added beside them, so the prompt must not promise the directory.
      const suffix = isCliOwnedSkillName(path.basename(skillDir))
        ? '   (TeamAI-packaged files only; anything you added stays)'
        : '';
      console.log(`     ${skillDir}${suffix}`);
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

  if (plan.shellProfiles.length > 0) {
    console.log(`   Shell profile env blocks (${plan.shellProfiles.length}):`);
    for (const profilePath of plan.shellProfiles) {
      console.log(`     ${profilePath}`);
    }
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
  // (a) Remove hooks from tool settings (built-in A + team B via the manifest).
  // Each settings entry carries the manifest for its own location (HOME/user
  // or a legacy <projectRoot>/project copy), so team hooks are stripped at the
  // location that owns them. File-based adapters apply their own scope rules
  // below; in particular, project uninstall never owns Pi's global extension.
  for (const { path: settingsPath, tool, manifestPath } of plan.hookFiles) {
    try {
      await reconcileHooks(settingsPath, tool, [], { removeAll: true, manifestPath });
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

  // (a2c) Remove the teamai OMP extension (single user-agent-dir copy).
  if (plan.ompHookFile !== null) {
    try {
      const { removeOmpHooks } = await import('./omp-hooks.js');
      await removeOmpHooks();
    } catch (e) {
      log.warn(`Failed to remove OMP hook: ${(e as Error).message}`);
    }
  }

  // (a2c) Remove the generated Pi extension.
  for (const hookFile of plan.piHookFiles) {
    try {
      await remove(hookFile);
      log.success(`Removed Pi hook from ${hookFile}`);
    } catch (e) {
      log.warn(`Failed to remove Pi hook ${hookFile}: ${(e as Error).message}`);
    }
  }

  // (a2d) Remove the DSH bridge config and profile patch through the same
  // adapter used by `teamai hooks remove`, preserving unrelated hook entries.
  if (plan.dshHookFile !== null) {
    try {
      const { reconcileDshHooks } = await import('./dsh-hooks.js');
      await reconcileDshHooks([], { manifestPath: plan.hookManifestPath, removeAll: true });
    } catch (e) {
      log.warn(`Failed to remove DeepSeek Harness hooks: ${(e as Error).message}`);
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

  // (c) Remove synced skills.
  //
  // A team-repo skill is synced whole, so the whole directory goes. A CLI-owned
  // one is not: deployment writes only the files in PACKAGED_SKILL_FILES and
  // never touched a file a member added beside them, so uninstall removes those
  // same paths and keeps the rest — the same ownership rule pull applies.
  // Deleting the directory here would undo the guarantee one command over.
  //
  // Pull's archive is deliberately not applied: there the member is upgrading
  // and did not ask for anything to go, here they asked for all of it. Leaving
  // copies behind would be the thing they ran the command to avoid.
  let removedSkillDirs = 0;
  const keptSkillDirs: string[] = [];
  const linkedSkillDirs: string[] = [];
  const failedSkillDirs: { skillDir: string; first: { file: string; error: string } }[] = [];
  for (const { dir: skillDir, baseDir } of plan.skillDirs) {
    try {
      const name = path.basename(skillDir);
      if (isCliOwnedSkillName(name)) {
        const result = await removeOwnedFiles(skillDir, await ownedSkillFiles(name), baseDir);
        if (prunedWhole(result)) removedSkillDirs++;
        else if (result.skippedSymlink) linkedSkillDirs.push(skillDir);
        // A delete that failed is not a member's file: say what happened, not
        // "the packaged files were removed".
        else if (result.notRemoved.length > 0) failedSkillDirs.push({ skillDir, first: result.notRemoved[0] });
        else keptSkillDirs.push(skillDir);
      } else {
        await remove(skillDir);
        removedSkillDirs++;
      }
    } catch (e) {
      log.warn(`Failed to remove skill ${skillDir}: ${(e as Error).message}`);
    }
  }
  if (removedSkillDirs > 0) {
    log.success(`Removed ${removedSkillDirs} skill directories`);
  }
  for (const skillDir of keptSkillDirs) {
    log.warn(`Kept ${skillDir}: it holds files TeamAI did not put there. The packaged files were removed; delete the rest yourself once you have saved what you need.`);
  }
  // A different reason, so a different sentence: nothing here was touched, and
  // "delete the rest yourself" would send the member into the link target.
  for (const skillDir of linkedSkillDirs) {
    log.warn(`Kept ${skillDir}: it is reached through a symlink, so TeamAI left it and whatever the link points at alone.`);
  }
  for (const { skillDir, first } of failedSkillDirs) {
    log.warn(`Could not delete packaged files under ${skillDir}. First: ${first.file} — ${first.error}. Fix the permissions and run \`teamai uninstall\` again, or delete the directory yourself.`);
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

  // (e) Clean shell profile env block(s) — every file discovered in
  // buildRemovalPlan, not just the one detectShellProfile() resolves to today.
  for (const profilePath of plan.shellProfiles) {
    try {
      const content = await readFileSafe(profilePath);
      if (content) {
        const startIdx = content.indexOf(TEAMAI_ENV_START);
        const endIdx = content.indexOf(TEAMAI_ENV_END);
        if (startIdx !== -1 && endIdx !== -1) {
          const before = content.substring(0, startIdx).replace(/\n+$/, '\n');
          const after = content.substring(endIdx + TEAMAI_ENV_END.length).replace(/^\n+/, '\n');
          await writeFile(profilePath, before + after);
          log.success(`Cleaned shell profile: ${profilePath}`);
        }
      }
    } catch (e) {
      log.warn(`Failed to clean shell profile ${profilePath}: ${(e as Error).message}`);
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

    // Model profiles are machine-global, independent of a project's resources.
    // Only removal of the user-scope TeamAI home may restore them. Run this
    // gate before MCP cleanup so a model conflict cannot partially uninstall
    // integrations in this or another worktree.
    if (plan.includeShared && localConfig.scope === 'user') {
      let modelRestoreIncomplete = false;
      try {
        const { ALL_MODEL_AGENTS, restoreModelProfiles } = await import('./models/switch.js');
        const results = await restoreModelProfiles(ALL_MODEL_AGENTS);
        const restored = results.filter((result) => result.status === 'restored').length;
        if (restored > 0) log.info(`Restored model settings for ${restored} agent(s)`);
        for (const result of results.filter((item) => item.status === 'failed' || item.status === 'skipped')) {
          log.warn(result.message);
          modelRestoreIncomplete = true;
        }
      } catch (e) {
        log.warn(`Failed to restore TeamAI-managed model settings: ${(e as Error).message}`);
        modelRestoreIncomplete = true;
      }
      if (modelRestoreIncomplete) {
        log.error('Cannot remove TeamAI home while model restoration is incomplete. Resolve the model conflict or run `teamai models restore` first.');
        process.exitCode = 1;
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
        // Project scope: the managed-mcp manifests are PER-WORKTREE under the
        // shared partition (#374 P1-2C), and each worktree's MCP config lives in
        // its own checkout. Since executeRemoval deletes the whole shared
        // partition, we must first remove the managed MCP servers from EVERY
        // linked worktree — otherwise a sibling worktree is left with an injected
        // server whose ownership record just got deleted (orphaned). User scope
        // has a single global manifest, so the current config is enough.
        const configs: LocalConfig[] = [localConfig];
        if (localConfig.scope === 'project' && localConfig.projectRoot) {
          const { listWorktrees } = await import('./utils/git.js');
          const { resolveProjectDataHome } = await import('./config.js');
          const worktrees = await listWorktrees(localConfig.projectRoot);
          for (const wt of worktrees) {
            if (wt === localConfig.projectRoot) continue;
            const dataHome = await resolveProjectDataHome(wt);
            configs.push({ ...localConfig, projectRoot: wt, dataHome });
          }
        }
        let removedTotal = 0;
        for (const cfg of configs) {
          const { changes } = await reconcileMcpForConfig(teamConfig, cfg, { removeAll: true });
          removedTotal += changes.filter((c) => c.action === 'removed').length;
        }
        if (removedTotal > 0) log.info(`Removed ${removedTotal} teamai-managed MCP server(s)`);
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
      try {
        const { ALL_MODEL_AGENTS, restoreModelProfiles } = await import('./models/switch.js');
        const results = await restoreModelProfiles(ALL_MODEL_AGENTS);
        const incomplete = results.filter((result) => result.status === 'failed' || result.status === 'skipped');
        if (incomplete.length > 0) {
          for (const result of incomplete) log.warn(result.message);
          log.error('Cannot remove TeamAI home while model restoration is incomplete.');
          process.exitCode = 1;
          return;
        }
      } catch (e) {
        log.warn(`Failed to restore TeamAI-managed model settings: ${(e as Error).message}`);
        process.exitCode = 1;
        return;
      }
      await teardownPlugins();
      await remove(home);
      log.success(`Removed ${home}/`);
      log.success('teamai uninstalled');
    } catch (e) {
      log.warn(`Failed to remove ${home}: ${(e as Error).message}`);
    }
  }
}
