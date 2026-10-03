import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { autoDetectInit, saveLocalConfig, saveLocalConfigForScope, UnreadableProjectConfigError } from './config.js';
import { reconcileHooks, hasTeamaiHooks, mainCheckoutHookFile, resolveMainCheckoutHooks } from './hooks.js';
import {
  removeOpenClawHooks,
  removeOpenClawHookEntry,
  OPENCLAW_HOOK_DIR,
  OPENCLAW_HOOK_KEY,
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
  TEAMAI_TEAM_RULES_START,
  TEAMAI_TEAM_RULES_END,
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
import { BUILTIN_RULE_NAMES, TEAMAI_CONTEXT_RULE_NAME } from './builtin-rules.js';
import { keptLegacyCopiesWarning, ruleStemFromFilename, type InstructionBlock, type LegacyRuleDir } from './resources/rule-format.js';
import { agentStemFromFilename } from './resources/agent-format.js';
import { resolveDocsDestination } from './resources/docs.js';
import { listTeamAgentDirs } from './resources/agents.js';
import { RulesHandler } from './resources/rules.js';
import { deliveredHashes } from './pull.js';
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
import { CODEX_TOOL_IDS } from './utils/tool-names.js';
import { CODEX_TOOL, SHARED_AGENT_SKILLS_PATH } from './resources/skills.js';
import { clearInstructionFile, instructionTargetFile, readsTeamRulesFromFile, retiredInstructionFiles, resolveInstructionTargets, userRulesFile } from './instruction-targets.js';
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
import { listQueuesIn } from './utils/pending-learnings.js';
import { log } from './utils/logger.js';
import { askConfirmation } from './utils/prompt.js';
import { getUserHome } from './utils/home.js';
import { listWorktrees } from './utils/git.js';
import {
  detectShellProfile,
  findEnvBlockFor,
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
  hookFiles: Array<{ path: string; tool: string; manifestPath: string; teamOnly?: boolean; legacyManifestPath?: string }>;
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
  /** Instruction files (CLAUDE.md, AGENTS.md, …), each with the teamai blocks to strip from it. */
  /** `owned`: teamai's generated file, which goes with its last block; else a member's file. */
  claudeMdFiles: Array<{ path: string; blocks: Array<[string, string]>; owned: boolean }>;
  opencodeInstructions: OpencodeInstruction[];
  /**
   * Skill directories synced from team repo, each with the base directory its
   * skills root hangs off: the prune refuses a link anywhere below that base.
   */
  skillDirs: SkillDirEntry[];
  /** Rule .md files synced from team repo (plus CLI built-in rules). */
  ruleFiles: string[];
  /** Copies in a tool's legacy rules directory the member edited, by directory: never removed, only named. */
  keptRuleFiles: { files: string[]; entry: LegacyRuleDir }[];
  /** OMP's flat copies of namespaced rules the member edited after delivery: never removed, only named (#946). */
  keptFlatCopies: string[];
  /** The rules globs teamai owns in OpenCode's opencode.json `instructions`, per file (#946). */
  opencodeOwnedGlobs: OpencodeRuleGlobEntries[];
  /** Built-in agent .md files deployed by the CLI (e.g. teamai-recall). */
  agentFiles: string[];
  /** teamai-managed MCP servers from managed-mcp.json (`tool/server` or `tool:project/server`). */
  mcpServers: string[];
  /** Shell profile paths carrying a teamai env block (usually one, but see #682/#693). */
  shellProfiles: string[];
  /** Docs directory (null if doesn't exist). */
  docsDir: string | null;
  /** The .git/info/exclude files holding teamai's MCP config block (#882), each with its patterns and the paths each protects. */
  gitExcludes: Map<string, Array<{ pattern: string; files: string[] }>>;
  /** teamai's git hook in the project repository: config sections and hook scripts holding its block. */
  gitHook: { repoDir: string; entries: string[] } | null;
  /** The .teamai home directory path. */
  teamaiHome: string;
  /** Whether teamaiHome exists on disk. */
  teamaiHomeExists: boolean;
  /**
   * Queues of learnings not published yet that deleting teamaiHome takes with
   * it, each with how many it holds; empty when teamaiHome stays.
   */
  unpublishedQueues: Array<{ dir: string; count: number }>;
  /** Whether shared resources (docs / ~/.teamai / shell profile) are part of this removal. */
  includeShared: boolean;
  /** Whether this removal targets Hermes (clears its SOUL.md block + config.yaml hook). */
  hermesCleanup: boolean;
  /** Scope being uninstalled (issue #73: surfaced to the user). */
  scope: Scope;
  /** Whether this removal takes the machine-wide adapters: a user-scope uninstall only. */
  globalAdapters: boolean;
  /** Machine-wide adapters a project uninstall keeps for other installs; `teamai hooks remove` takes them. */
  keptGlobal: string[];
}

/** Per-tool findings collected during discovery (tool-specific resources only). */
/** A skill directory to remove, and the base the link guard starts from. */
interface SkillDirEntry {
  dir: string;
  baseDir: string;
}

/** An entry teamai added to an OpenCode config's `instructions`. */
interface OpencodeInstruction {
  config: string;
  entry: string;
}

interface ToolResources {
  hookFiles: Array<{ path: string; tool: string; manifestPath: string; teamOnly?: boolean; legacyManifestPath?: string }>;
  openclawHookDirs: Array<{ hooksDir: string; tool: string }>;
  opencodeHookScopes: Array<{ baseDir: string; scope: Scope }>;
  ompHookFile: string | null;
  piHookFiles: string[];
  dshHookFile: string | null;
  claudeMdFiles: string[];
  /** Files an earlier release wrote this tool's instruction blocks to; no tool reads them now (#945). */
  retiredInstructionFiles: string[];
  /** teamai's entries in OpenCode's `instructions`, whether or not their file still holds blocks (#945). */
  opencodeInstructions: OpencodeInstruction[];
  /** Machine-wide adapters this project uninstall keeps (`RemovalPlan.keptGlobal`). */
  keptGlobal: string[];
  skillDirs: SkillDirEntry[];
  ruleFiles: string[];
  keptRuleFiles: { files: string[]; entry: LegacyRuleDir }[];
  opencodeOwnedGlobs: OpencodeRuleGlobEntries[];
  agentFiles: string[];
}

/** The `instructions` entries teamai owns in one opencode.json. */
interface OpencodeRuleGlobEntries {
  configFile: string;
  entries: string[];
  /** A file teamai creates (a project's `.opencode/opencode.json`): deleted once nothing else is left in it. */
  deleteIfEmpty: boolean;
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
    r.retiredInstructionFiles.length > 0 ||
    r.opencodeInstructions.length > 0 ||
    r.skillDirs.length > 0 ||
    r.ruleFiles.length > 0 ||
    r.opencodeOwnedGlobs.length > 0 ||
    r.agentFiles.length > 0
  );
}

// ─── Helpers ───────────────────────────────────────────

const CLAUDEMD_MARKER_PAIRS: Array<[string, string]> = [
  [TEAMAI_RULES_START, TEAMAI_RULES_END],
  [TEAMAI_CULTURE_START, TEAMAI_CULTURE_END],
  [TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END],
  [TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END],
  [TEAMAI_TEAM_RULES_START, TEAMAI_TEAM_RULES_END],
];

const INSTRUCTION_BLOCK_STARTS: Record<InstructionBlock, string> = {
  culture: TEAMAI_CULTURE_START,
  claudemd: TEAMAI_CLAUDEMD_START,
  recall: TEAMAI_RECALL_RULES_START,
  'team-rules': TEAMAI_TEAM_RULES_START,
};

/**
 * Start markers of the blocks a pull writes into a tool's instruction target
 * (#945): culture, claudemd and recall always (a tool without the
 * `teamai-recall` subagent gets the direct variant, under the same markers),
 * and team rules for a tool that reads them from a file of its own
 * (`readsTeamRulesFromFile`). Nobody writes the
 * legacy `[teamai:rules]` block any more.
 */
function instructionBlocksWrittenBy(tool: string): string[] {
  return (Object.keys(INSTRUCTION_BLOCK_STARTS) as InstructionBlock[])
    .filter((block) => block !== 'team-rules' || readsTeamRulesFromFile(tool))
    .map((block) => INSTRUCTION_BLOCK_STARTS[block]);
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

/**
 * A location teamai injected hooks into. `fileFor` names the file per tool for
 * a location that holds only some tools' files (the main checkout's team hook
 * files, #955); without it the tool's settings path is probed.
 */
interface HookTarget {
  baseDir: string;
  manifestPath: string;
  fileFor?: (tool: string) => string | null;
  teamOnly?: boolean;
  legacyManifestPath?: string;
}

async function discoverToolResources(
  tool: string,
  toolPath: TeamaiConfig['toolPaths'][string],
  baseDir: string,
  /** Home, or the project root: where the skills link guard starts (`skillsGuardBase`). */
  scopeRoot: string,
  teamSkillNames: Set<string>,
  teamRuleNames: Set<string>,
  teamAgentNames: Set<string>,
  hookTargets: HookTarget[],
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
  /**
   * Whether the machine-wide Pi/OMP extensions and Codex user hooks go too.
   * Only a user-scope uninstall takes them: a project cannot tell whether an
   * HTTP agent, a self-mode project or another checkout still uses them (#945).
   */
  globalAdapters = scope === 'user',
): Promise<ToolResources> {
  const res: ToolResources = {
    hookFiles: [], openclawHookDirs: [], opencodeHookScopes: [], ompHookFile: null, piHookFiles: [], dshHookFile: null,
    claudeMdFiles: [], retiredInstructionFiles: [], opencodeInstructions: [], keptGlobal: [], skillDirs: [], ruleFiles: [], keptRuleFiles: [], opencodeOwnedGlobs: [], agentFiles: [],
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
    const { hasOmpHooks, resolveOmpExtensionsDir, OMP_HOOK_FILE } = await import('./omp-hooks.js');
    const extFile = path.join(resolveOmpExtensionsDir(), OMP_HOOK_FILE);
    if (await hasOmpHooks()) {
      if (globalAdapters) res.ompHookFile = extFile;
      else res.keptGlobal.push(extFile);
    }
  } else if (tool === 'pi') {
    const {
      hasPiHooks,
      hasPiAgentHook,
      resolvePiExtensionsDir,
      resolvePiProjectExtensionsDir,
      PI_HOOK_FILE,
    } = await import('./pi-hooks.js');
    // Project uninstall owns only legacy project copies while other installs
    // still use the single global extension and server-pushed agent hooks.
    if (await hasPiHooks()) {
      if (globalAdapters) res.piHookFiles.push(path.join(resolvePiExtensionsDir(), PI_HOOK_FILE));
      else res.keptGlobal.push(path.join(resolvePiExtensionsDir(), PI_HOOK_FILE));
    }
    // Server-pushed agent hooks (teamai-agent-<slug>.ts) always install into
    // the global extension dir and can exist without the main lifecycle
    // extension — mirrors OpenCode's discovery, which scans for the same
    // leftover-plugin pattern so a Pi-only agent-hook install isn't missed.
    // Each match is marker-checked by its own slug so a same-named file a
    // user authored by hand is never swept up.
    for (const file of globalAdapters ? await listFiles(resolvePiExtensionsDir()) : []) {
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
    // Main-checkout files are canonical; a legacy target may name one through a symlink.
    const canonical = (file: string) => realpath(file).catch(() => path.resolve(file));
    const mainFiles = new Set(await Promise.all(hookTargets.flatMap((target) => {
      const file = target.teamOnly ? target.fileFor?.(tool) : null;
      return file ? [canonical(file)] : [];
    })));
    for (const { baseDir: hookBaseDir, manifestPath, fileFor, teamOnly, legacyManifestPath } of hookTargets) {
      const settingsRel = path.resolve(hookBaseDir) === path.resolve(getUserHome())
        ? (hookSettingsPath ?? toolPath.settings)
        : toolPath.settings;
      const settingsPath = fileFor ? fileFor(tool) : path.join(hookBaseDir, settingsRel);
      // Prefer main-file ownership when a legacy target names the same file.
      if (!teamOnly && settingsPath && mainFiles.has(await canonical(settingsPath))) continue;
      // Other installs use Codex's user hooks as their instruction channel.
      if (settingsPath && !globalAdapters && CODEX_TOOL_IDS.some((id) => id === tool)
        && path.resolve(hookBaseDir) === path.resolve(getUserHome())) {
        if (await pathExists(settingsPath) && await hasTeamaiHooks(settingsPath, tool, manifestPath)) res.keptGlobal.push(settingsPath);
        continue;
      }
      if (settingsPath && await pathExists(settingsPath)
        && (await hasTeamaiHooks(settingsPath, tool, manifestPath)
          || (legacyManifestPath && await hasTeamaiHooks(settingsPath, tool, legacyManifestPath))
          || isEmptyHooksResidue(await readJson<Record<string, unknown>>(settingsPath)))) {
        res.hookFiles.push({ path: settingsPath, tool, manifestPath,
          ...(teamOnly ? { teamOnly, legacyManifestPath } : {}),
        });
      }
    }
  } else {
    // OpenClaw-style agents (no settings file) inject a HOOK.md + handler.ts
    // under <hooksDir>/<OPENCLAW_HOOK_DIR>. Check the default path, the
    // resolved state dir (OPENCLAW_STATE_DIR or OPENCLAW_PROFILE), and the
    // resolved workspace dir — injection now targets `<workspace>/hooks`, so
    // teardown must cover it too, otherwise the hook is orphaned on uninstall.
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
  const instructionFile = await instructionTargetFile(tool, toolPath, scope);
  if (instructionFile) {
    const claudeMdPath = path.resolve(baseDir, instructionFile);
    const content = await readFileSafe(claudeMdPath);
    if (content && CLAUDEMD_MARKER_PAIRS.some(([start]) => content.includes(start))) {
      res.claudeMdFiles.push(claudeMdPath);
    }
  }
  // OpenCode's instructions entry goes only when teamai recorded adding it
  // (buildRemovalPlan): an entry the member listed is theirs, whatever the file holds.
  for (const retired of await retiredInstructionFiles(tool, toolPath, scope)) {
    const file = path.resolve(baseDir, retired);
    const content = await readFileSafe(file);
    if (content && CLAUDEMD_MARKER_PAIRS.some(([start]) => content.includes(start))) {
      res.retiredInstructionFiles.push(file);
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
  // A legacy rules directory is buildRemovalPlan's: its copies go on ownership.
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
          // teamai's instruction file shares the reserved name; its blocks are
          // stripped above, keeping what another tool or the member still uses.
          if (ruleName === TEAMAI_CONTEXT_RULE_NAME) {
            const text = await readFileSafe(path.join(rulesDir, file));
            if (text && CLAUDEMD_MARKER_PAIRS.some(([start]) => text.includes(start))) continue;
          }
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
  const hookTargets: HookTarget[] = [primaryHookScope];
  const legacyHookScope = resolveLegacyProjectHookScope(localConfig);
  if (legacyHookScope) hookTargets.push(legacyHookScope);
  // The project's Claude and Codex team hooks, in the main checkout (#955).
  const mainCheckout = await resolveMainCheckoutHooks(localConfig, teamConfig.toolPaths);
  const mainCheckouts = mainCheckout ? [mainCheckout] : [];
  // A bare anchor has no shared checkout file. Uninstall removes the shared
  // data home, so collect every live workspace's hooks before deleting ownership.
  if (mainCheckout?.worktreeScoped) {
    for (const root of await listWorktrees(localConfig.projectRoot!)) {
      if (root === mainCheckout.root) continue;
      const target = await resolveMainCheckoutHooks({ ...localConfig, projectRoot: root }, teamConfig.toolPaths);
      if (target?.worktreeScoped) mainCheckouts.push(target);
    }
  }
  for (const target of mainCheckouts) {
    hookTargets.push({
      baseDir: target.root,
      manifestPath: target.manifestPath,
      teamOnly: true,
      legacyManifestPath: getManagedHooksPath('project', target.root),
      fileFor: (tool) => mainCheckoutHookFile(target, tool),
    });
  }
  // Hook discovery resolves its file name at the same scope as the targets: a
  // non-self project scope discovers under HOME, so the tool paths there must be
  // the user-scope ones (previously the project-scope name was used, and a tool
  // whose two scopes differ kept its hooks in HOME forever). Skills, rules,
  // agents and CLAUDE.md stay on the config-scope paths below — those are real
  // project resources.
  const hookToolPaths = scopedToolPaths(teamConfig, { ...localConfig, scope: primaryHookScope.scope });
  const toolPaths = scopedToolPaths(teamConfig, localConfig);
  const perTool = new Map<string, ToolResources>();
  const globalAdapters = localConfig.scope === 'user';
  for (const [tool, toolPath] of Object.entries(toolPaths)) {
    perTool.set(
      tool,
      await discoverToolResources(
        tool,
        toolPath,
        resolveToolBaseDir(tool, localConfig),
        baseDir,
        teamSkillNames,
        teamRuleNames,
        teamAgentNames,
        hookTargets,
        standaloneHookManifestPath,
        localConfig.scope,
        hookToolPaths[tool]?.settings,
        globalAdapters,
      ),
    );
  }

  // OpenCode's instructions entry is teamai's only when pull recorded adding
  // it, whatever the context file holds now. No release before #945 added
  // this entry, so there are no unrecorded teamai entries to migrate.
  const opencodeRes = perTool.get('opencode');
  if (opencodeRes) {
    const { loadStateForScope } = await import('./config.js');
    const { opencodeContextReference, readOpencodeInstructionList } = await import('./resources/opencode-config.js');
    const contextFile = toolPaths.opencode && await instructionTargetFile('opencode', toolPaths.opencode, localConfig.scope);
    // Worktrees share state.json: only this checkout's own record counts.
    const own = contextFile
      ? opencodeContextReference(path.resolve(resolveToolBaseDir('opencode', localConfig), contextFile), localConfig.scope, resolveToolBaseDir('opencode', localConfig))
      : undefined;
    const recorded = (await loadStateForScope(localConfig)).opencodeContextEntries ?? [];
    if (own && recorded.some((ref) => ref.config === own.config && ref.entry === own.entry)) {
      const listed = await readOpencodeInstructionList(own.config);
      if (listed?.includes(own.entry) || (listed === null && await pathExists(own.config))) {
        opencodeRes.opencodeInstructions.push(own);
      }
    }
  }

  // (d) continued: the copies a release made in a tool's legacy rules
  // directory, before its rules moved into its instructions file, which a pull
  // may not have reclaimed yet. A name is no proof there: only the copies a
  // pull would reclaim go, and the ones the member edited stay, named.
  const rulesHandler = new RulesHandler();
  const legacyCopies = await rulesHandler
    .legacyRuleCopies(teamConfig, localConfig, await deliveredHashes(localConfig));
  for (const { entry, owned, edited } of legacyCopies) {
    // A directory the tool reads is its rules directory, collected above.
    if (entry.copiedFrom !== undefined) continue;
    const res = perTool.get(entry.tool);
    if (!res) continue;
    res.ruleFiles.push(...owned);
    if (edited.length > 0) res.keptRuleFiles.push({ files: edited, entry });
  }

  // (d) continued: OMP's flat copies of namespaced rules (`fe.style.md`),
  // which a member's own file can share a name with: only those holding what
  // was recorded or the render go; an edited one stays, named (#946).
  const teamRules = await rulesHandler.scanTeamForPull(teamConfig, localConfig);
  const flatCopies = await rulesHandler.ownedFlatCopies(teamConfig, localConfig, teamRules, await deliveredHashes(localConfig));
  for (const { tool, file } of flatCopies.owned) perTool.get(tool)?.ruleFiles.push(file);

  // (b) continued: the team-rules block in the user file a tool with no
  // rules format reads them from (#938, #946), when that is not its
  // instruction file already.
  for (const [tool, toolPath] of Object.entries(toolPaths)) {
    const res = perTool.get(tool);
    const file = (await userRulesFile(tool, toolPath, localConfig))?.file;
    if (!res || file === undefined || res.claudeMdFiles.includes(file)) continue;
    if ((await readFileSafe(file))?.includes(TEAMAI_TEAM_RULES_START)) res.claudeMdFiles.push(file);
  }

  // (d) continued: OpenCode loads its rules through globs in opencode.json,
  // which would point at nothing once the copies go (#946).
  const opencodeTarget = opencodeRes
    ? await rulesHandler.opencodeInstructionsTarget(teamConfig, localConfig, [])
    : null;
  if (opencodeRes && opencodeTarget) {
    const { readOpencodeInstructionList } = await import('./resources/opencode-config.js');
    // In a project, also the root opencode.json glob an earlier release wrote.
    const { retired } = opencodeTarget;
    const files = [
      { configFile: opencodeTarget.configFile, owns: opencodeTarget.owns, deleteIfEmpty: localConfig.scope === 'project' },
      ...(retired ? [{ ...retired, deleteIfEmpty: false }] : []),
    ];
    for (const { configFile, owns, deleteIfEmpty } of files) {
      const entries = ((await readOpencodeInstructionList(configFile)) ?? [])
        .filter((entry): entry is string => typeof entry === 'string' && owns(entry));
      if (entries.length > 0) opencodeRes.opencodeOwnedGlobs.push({ configFile, entries, deleteIfEmpty });
    }
  }

  // A tool only still "uses" a shared resource (AGENTS.md, .teamai/) if it is
  // actually enabled and installed. Several tools default to the same shared
  // path — e.g. Hermes/WorkBuddy default to the same project AGENTS.md as Pi —
  // so a schema entry that merely shares a path must not block cleanup for a
  // tool that was never enabled or set up. The probe path must be a
  // tool-specific root (skills/rules/settings), never `claudemd`: that's
  // exactly the shared, ambiguous path this check exists to disambiguate.
  const { hooks: instructionHooks } = await resolveInstructionTargets(teamConfig, localConfig);
  const hookTools = new Set(instructionHooks.map((hook) => hook.tool));
  const activeTools = new Set(hookTools);
  for (const [tool, toolPath] of Object.entries(toolPaths)) {
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
      .some(([t, r]) => t !== agentFilter && activeTools.has(t) && (hasToolResources(r) || hookTools.has(t)));
    // Remove shared resources only when the target itself has resources AND is
    // the last tool using teamai. Targeting a tool with no teamai resources is a
    // no-op for shared resources (plan will be empty → "Nothing to uninstall").
    includeShared = targetHasResources && !othersHaveResources;
    // Keep this project's config so the global hook can read its exclusion.
    if (!globalAdapters && CODEX_TOOL_IDS.some((id) => id === agentFilter)) includeShared = false;
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
    opencodeInstructions: [],
    skillDirs: [],
    ruleFiles: [],
    keptRuleFiles: [],
    // Only the tools being uninstalled: another tool's copy is not touched, so not "kept".
    keptFlatCopies: flatCopies.edited.filter(({ tool }) => toolsToMerge.includes(tool)).map(({ file }) => file),
    opencodeOwnedGlobs: [],
    agentFiles: [],
    mcpServers: [],
    shellProfiles: [],
    docsDir: null,
    gitExcludes: new Map(),
    gitHook: null,
    teamaiHome,
    teamaiHomeExists: includeShared && await pathExists(teamaiHome),
    unpublishedQueues: includeShared ? await listQueuesIn(teamaiHome) : [],
    includeShared,
    hermesCleanup: globalAdapters && toolsToMerge.includes('hermes'),
    scope: localConfig.scope,
    globalAdapters,
    keptGlobal: [],
  };

  // A single instruction file can be the target of several agents (for
  // example CodeBuddy and WorkBuddy share `.codebuddy/rules/teamai-context.md`).
  // Keep a TeamAI block when another enabled, installed agent that maps the
  // same file would write that block; the rest go, since no remaining agent's
  // pull would ever refresh or remove them.
  const retainedBlocks = new Map<string, Set<string>>();
  for (const [tool, resources] of perTool) {
    if (toolsToMerge.includes(tool) || !activeTools.has(tool)) continue;
    const written = instructionBlocksWrittenBy(tool);
    for (const file of resources.claudeMdFiles) {
      const kept = retainedBlocks.get(file) ?? new Set<string>();
      for (const start of written) kept.add(start);
      retainedBlocks.set(file, kept);
    }
  }

  // A rule file another enabled, installed tool reads stays: in a project
  // CodeBuddy and WorkBuddy share `.codebuddy/rules` (#946).
  const retainedRuleFiles = new Set<string>();
  for (const [tool, resources] of perTool) {
    if (toolsToMerge.includes(tool) || !activeTools.has(tool)) continue;
    for (const file of resources.ruleFiles) retainedRuleFiles.add(file);
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
    plan.opencodeInstructions.push(...res.opencodeInstructions);
    plan.keptGlobal.push(...res.keptGlobal);
    for (const file of res.claudeMdFiles) {
      if (plan.claudeMdFiles.some((entry) => entry.path === file)) continue;
      const content = await readFileSafe(file) ?? '';
      const kept = retainedBlocks.get(file);
      const blocks = CLAUDEMD_MARKER_PAIRS
        .filter(([start]) => content.includes(start) && !kept?.has(start));
      // The configured `claudemd` (no `rules`) is the member's, whatever its name.
      const owned = await instructionTargetFile(tool, toolPaths[tool], localConfig.scope) !== toolPaths[tool].claudemd;
      if (blocks.length > 0) plan.claudeMdFiles.push({ path: file, blocks, owned });
    }
    // A retired file keeps only the blocks a remaining tool still writes
    // there, which a team's toolPaths can make it.
    for (const file of res.retiredInstructionFiles) {
      if (plan.claudeMdFiles.some((entry) => entry.path === file)) continue;
      const content = await readFileSafe(file) ?? '';
      const kept = retainedBlocks.get(file);
      const blocks = CLAUDEMD_MARKER_PAIRS.filter(([start]) => content.includes(start) && !kept?.has(start));
      // Retired paths are configured member files, whatever their basename.
      if (blocks.length > 0) plan.claudeMdFiles.push({ path: file, blocks, owned: false });
    }
    plan.skillDirs.push(...res.skillDirs);
    plan.ruleFiles.push(...res.ruleFiles.filter((file) => !retainedRuleFiles.has(file) && !plan.ruleFiles.includes(file)));
    plan.keptRuleFiles.push(...res.keptRuleFiles);
    plan.opencodeOwnedGlobs.push(...res.opencodeOwnedGlobs);
    plan.agentFiles.push(...res.agentFiles);
  }

  // Hermes' plugin is machine-wide too: a project uninstall names it as kept.
  if (!globalAdapters && toolsToMerge.includes('hermes')) {
    const { getInstructionsPluginDir, ownsInstructionsPlugin } = await import('./hermes-hooks.js');
    if (await pathExists(getInstructionsPluginDir()) && await ownsInstructionsPlugin()) plan.keptGlobal.push(getInstructionsPluginDir());
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
    // A candidate only counts if one of its blocks names THIS scope's
    // env.sh (findEnvBlockFor) — matching on the marker alone
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
      if (profileContent && findEnvBlockFor(profileContent, envShPath)) {
        plan.shellProfiles.push(candidate);
      }
    }

    // (f) Docs directory
    const docsDir = resolveDocsDestination(teamConfig, localConfig);
    if (await pathExists(docsDir)) {
      plan.docsDir = docsDir;
    }

    // (g) teamai's block in .git/info/exclude (#882): the project's own, and
    // that of any nested repository an MCP config sits in. It counts on its
    // own: a clone whose other resources are gone still gets it removed.
    if (localConfig.scope === 'project') {
      const { resolveMcpTargets, projectWorktreeConfigs } = await import('./mcp-reconcile.js');
      const { findMcpGitExcludes } = await import('./mcp-git-exclude.js');
      const { readResolvedMcpFiles } = await import('./mcp-resolved-files.js');
      const dirs: string[] = [];
      for (const cfg of await projectWorktreeConfigs(localConfig)) {
        if (cfg.projectRoot) dirs.push(cfg.projectRoot);
        for (const target of await resolveMcpTargets(teamConfig, cfg, { includeUndetected: true })) dirs.push(path.dirname(target.file));
        // A file a pull wrote under a toolPaths mapping since changed.
        for (const file of Object.keys((await readResolvedMcpFiles(cfg)).files)) dirs.push(path.dirname(file));
      }
      plan.gitExcludes = await findMcpGitExcludes(dirs);
      // (h) teamai's git hook, in the config every worktree shares.
      if (localConfig.projectRoot) {
        const { removeGitHook } = await import('./git-hook.js');
        const entries = await removeGitHook(localConfig.projectRoot, { dryRun: true }).catch(() => []);
        if (entries.length > 0) plan.gitHook = { repoDir: localConfig.projectRoot, entries };
      }
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
    plan.opencodeInstructions.length === 0 &&
    plan.skillDirs.length === 0 &&
    plan.ruleFiles.length === 0 &&
    plan.opencodeOwnedGlobs.length === 0 &&
    plan.agentFiles.length === 0 &&
    plan.mcpServers.length === 0 &&
    plan.shellProfiles.length === 0 &&
    plan.docsDir === null &&
    plan.gitExcludes.size === 0 &&
    plan.gitHook === null &&
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

  if (plan.opencodeInstructions.length > 0) {
    console.log('   OpenCode instructions entries:');
    for (const { config, entry } of plan.opencodeInstructions) console.log(`     ${entry} in ${config}`);
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
    console.log(`   Instruction-file blocks (${plan.claudeMdFiles.length} files):`);
    for (const { path: p } of plan.claudeMdFiles) {
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

  for (const { configFile, entries } of plan.opencodeOwnedGlobs) {
    console.log(`   OpenCode rules globs (${entries.length}) in ${configFile}`);
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

  if (plan.gitExcludes.size > 0) {
    console.log('   Git exclude entries for MCP configs (teamai\'s block):');
    for (const [file, entries] of plan.gitExcludes) console.log(`     ${file} (${entries.map((entry) => entry.pattern).join(', ')})`);
    console.log('');
  }

  if (plan.gitHook) {
    console.log(`   Git hook in ${plan.gitHook.repoDir} (teamai's entries and blocks):`);
    for (const entry of plan.gitHook.entries) console.log(`     ${entry}`);
    console.log('');
  }

  if (plan.teamaiHomeExists) {
    console.log('   TeamAI home directory:');
    console.log(`     ${plan.teamaiHome}/`);
    console.log('');
  }

  if (plan.unpublishedQueues.length > 0) {
    console.log('⚠  Learnings not published yet, deleted with the home directory:');
    for (const { dir, count } of plan.unpublishedQueues) {
      console.log(`     ${count} unpublished learning(s) in ${dir}`);
    }
    console.log('   Run `teamai pull` to publish them first, or copy them somewhere safe.');
    console.log('');
  }

  if (plan.keptGlobal.length > 0) {
    console.log('ℹ  Kept for other teamai installs on this machine (user scope, HTTP agent or other projects):');
    for (const file of plan.keptGlobal) console.log(`     ${file}`);
    console.log('   If none of them uses these, cancel and run `teamai hooks remove` here first: it removes them.');
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

async function executeRemoval(plan: RemovalPlan): Promise<RemovalPlan['opencodeInstructions']> {
  const pendingOpencode: RemovalPlan['opencodeInstructions'] = [];
  if (plan.gitHook) {
    const { removeGitHook } = await import('./git-hook.js');
    try {
      await removeGitHook(plan.gitHook.repoDir);
      log.info(`Removed the teamai git hook from ${plan.gitHook.repoDir}`);
    } catch (e) {
      log.warn(`Could not remove the teamai git hook from ${plan.gitHook.repoDir}: ${(e as Error).message}. `
        + 'Remove it yourself: `git config --local --remove-section hook.teamai-post-checkout` (and hook.teamai-post-merge), '
        + 'and the `# >>> teamai git hook` block in .git/hooks/post-checkout and post-merge.');
    }
  }

  // (a) Remove hooks from tool settings (built-in A + team B via the manifest).
  // Each settings entry carries the manifest for its own location (HOME/user
  // or a legacy <projectRoot>/project copy), so team hooks are stripped at the
  // location that owns them. File-based adapters apply their own scope rules
  // below; in particular, project uninstall never owns Pi's global extension.
  for (const { path: settingsPath, tool, manifestPath, teamOnly, legacyManifestPath } of plan.hookFiles) {
    try {
      await reconcileHooks(settingsPath, tool, [], { removeAll: true, manifestPath,
        ...(teamOnly ? { teamOnly, legacyManifestPath } : {}),
      });
    } catch (e) {
      log.warn(`Failed to remove hooks from ${settingsPath}: ${(e as Error).message}`);
    }
  }

  // (a2) Remove OpenClaw-style hook dirs, and OpenClaw's entry enabling ours
  for (const { hooksDir } of plan.openclawHookDirs) {
    try {
      await removeOpenClawHooks(hooksDir);
    } catch (e) {
      log.warn(`Failed to remove OpenClaw hook from ${hooksDir}: ${(e as Error).message}`);
    }
  }
  if (plan.openclawHookDirs.some(({ tool }) => tool === 'openclaw')) {
    try {
      await removeOpenClawHookEntry();
    } catch (e) {
      log.warn(`Failed to remove the teamai hook entry from OpenClaw's config: ${(e as Error).message}. `
        + 'OpenClaw keeps it, and while it is there OpenClaw loads only the hooks openclaw.json names. '
        + `Run \`openclaw hooks disable ${OPENCLAW_HOOK_KEY}\`, or remove it from openclaw.json by hand.`);
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
    if (plan.globalAdapters) await removeAllAgentHooks();
  } catch (e) {
    log.warn(`Failed to remove agent hooks: ${(e as Error).message}`);
  }

  // (b) Clean CLAUDE.md teamai section blocks
  for (const { path: claudeMdPath, blocks, owned } of plan.claudeMdFiles) {
    try {
      // A file teamai created goes with its last block; a member's file,
      // even an empty one, stays.
      const { changed, warnings } = await clearInstructionFile(claudeMdPath, blocks.map(([start]) => start), owned);
      for (const warning of warnings) log.warn(warning);
      if (changed) log.success(`Cleaned ${claudeMdPath}`);
    } catch (e) {
      log.warn(`Failed to clean ${claudeMdPath}: ${(e as Error).message}`);
    }
  }
  // OpenCode loads its file through an `instructions` entry teamai added: it
  // goes even when the member's text keeps the file, or the file is gone.
  for (const { config, entry } of plan.opencodeInstructions) {
    try {
      const { reconcileOpencodeInstructions } = await import('./resources/opencode-config.js');
      if (await reconcileOpencodeInstructions(config, entry, false, 'team instructions')) log.success(`Removed "${entry}" from the instructions of ${config}`);
    } catch (e) {
      log.warn(`Failed to remove "${entry}" from the instructions of ${config}: ${(e as Error).message}`);
    }
    const { readOpencodeInstructionList } = await import('./resources/opencode-config.js');
    const listed = await readOpencodeInstructionList(config);
    if (listed === null || listed.includes(entry)) pendingOpencode.push({ config, entry });
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
  for (const { configFile, entries, deleteIfEmpty } of plan.opencodeOwnedGlobs) {
    try {
      const { reconcileOpencodeInstructionSet } = await import('./resources/opencode-config.js');
      if (await reconcileOpencodeInstructionSet(configFile, [], (entry) => entries.includes(entry), undefined, { deleteIfEmpty })) {
        log.success(`Removed ${entries.length} OpenCode rules globs from ${configFile}`);
      }
    } catch (e) {
      log.warn(`Failed to remove the OpenCode rules globs from ${configFile}: ${(e as Error).message}. `
        + `They stay listed in its \`instructions\` and point at rule files uninstall deleted. `
        + `Remove ${entries.map((entry) => `\`${entry}\``).join(', ')} from that list by hand.`);
    }
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
  // Only this scope's own block: another scope's may share the file (#876).
  const envShPath = path.join(plan.teamaiHome, 'env.sh');
  for (const profilePath of plan.shellProfiles) {
    try {
      const content = await readFileSafe(profilePath);
      if (content) {
        const block = findEnvBlockFor(content, envShPath);
        if (block && block.end !== null) {
          const before = content.substring(0, block.start).replace(/\n+$/, '\n');
          const after = content.substring(block.end).replace(/^\n+/, '\n');
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
  if (plan.teamaiHomeExists && pendingOpencode.length === 0) {
    // Tear down plugins first: their manifest/config live under ~/.teamai/local-agent.
    await teardownPlugins();
    try {
      await remove(plan.teamaiHome);
      log.success(`Removed ${plan.teamaiHome}/`);
    } catch (e) {
      log.warn(`Failed to remove ${plan.teamaiHome}: ${(e as Error).message}`);
    }
  }

  // (h) Hermes: clear teamai-managed entries — the SOUL.md rules block (user scope), the
  // status-report hook (config.yaml + allowlist + script). Gated on hermesCleanup
  // so a targeted `--agent <other>` uninstall never touches ~/.hermes. No-op safe.
  if (plan.hermesCleanup) {
    try {
      const { removeHermesHooks } = await import('./hermes-hooks.js');
      const { removeSoulRules } = await import('./hermes-config.js');
      await removeHermesHooks();
      // SOUL.md is global and only a user-scope pull writes its rules block (#946).
      if (plan.scope === 'user') await removeSoulRules();
    } catch (e) {
      log.debug(`Hermes uninstall cleanup skipped: ${(e as Error).message}`);
    }
  }
  return pendingOpencode;
}

// ─── Public API ────────────────────────────────────────

async function excludeUninstalledAgent(config: LocalConfig, agent: string): Promise<void> {
  // Keep an absent whitelist meaning "all other tools".
  if (config.enabledAgents) config.enabledAgents = config.enabledAgents.filter((tool) => tool !== agent);
  config.disabledAgents = [...new Set([...config.disabledAgents ?? [], agent])];
  if (config.scope === 'project') await saveLocalConfigForScope(config, config.scope, config.projectRoot);
  else await saveLocalConfig(config);
}

export async function uninstall(opts: UninstallOptions): Promise<void> {
  let localConfig: LocalConfig | null = null;
  let teamConfig: TeamaiConfig | null = null;

  try {
    const result = await autoDetectInit(undefined, { dryRun: opts.dryRun });
    localConfig = result.localConfig;
    teamConfig = result.teamConfig;
  } catch (e) {
    if (e instanceof UnreadableProjectConfigError) throw e;
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
    // Uninstall never removes these, so they are named whatever happens next.
    for (const { files, entry } of plan.keptRuleFiles) log.warn(keptLegacyCopiesWarning(files, entry));
    if (plan.keptFlatCopies.length > 0) {
      const one = plan.keptFlatCopies.length === 1;
      log.warn(`Kept ${plan.keptFlatCopies.join(', ')}: you edited ${one ? 'it' : 'them'} after teamai delivered ${one ? 'it' : 'them'}. `
        + `Delete ${one ? 'it' : 'them'} once you have saved what you need.`);
    }

    const exclusionOnly = isPlanEmpty(plan) && agentKey && localConfig.scope === 'project'
      && ['pi', 'omp', 'hermes', ...CODEX_TOOL_IDS].includes(agentKey);
    if (isPlanEmpty(plan) && !exclusionOnly) {
      log.info('Nothing to uninstall');
      return;
    }

    printSummary(plan, agentKey);
    if (exclusionOnly) log.info(`Exclude ${agentKey} from this project; keep its global delivery channel.`);

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

    if (exclusionOnly) {
      // Exclusion is a config write even when there are no local files to delete.
      await excludeUninstalledAgent(localConfig, agentKey!);
      log.success(`Excluded ${agentKey} from this project; its global delivery channel is kept for other teamai installs on this machine. If none uses it, run \`teamai hooks remove\` to remove it.`);
      return;
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
        const { reconcileMcpForConfig, projectWorktreeConfigs, mcpConfigsNotProvenClean } = await import('./mcp-reconcile.js');
        // Project scope: the managed-mcp manifests are PER-WORKTREE under the
        // shared partition (#374 P1-2C), and each worktree's MCP config lives in
        // its own checkout. Since executeRemoval deletes the whole shared
        // partition, we must first remove the managed MCP servers from EVERY
        // linked worktree — otherwise a sibling worktree is left with an injected
        // server whose ownership record just got deleted (orphaned). User scope
        // has a single global manifest, so the current config is enough.
        let removedTotal = 0;
        for (const cfg of await projectWorktreeConfigs(localConfig)) {
          const { changes } = await reconcileMcpForConfig(teamConfig, cfg, { removeAll: true });
          removedTotal += changes.filter((c) => c.action === 'removed').length;
        }
        if (removedTotal > 0) log.info(`Removed ${removedTotal} teamai-managed MCP server(s)`);
        // Worktrees share one info/exclude, so it goes once they are all clean,
        // judged by what the files hold, not by what the cleanup reported: a
        // lost manifest cleans nothing and reports nothing. Without the block,
        // `git add -A` would commit a value teamai resolved.
        if (plan.gitExcludes.size > 0) {
          const { removeMcpGitExclude } = await import('./mcp-git-exclude.js');
          const held = await mcpConfigsNotProvenClean(teamConfig, localConfig, [...plan.gitExcludes.values()].flat());
          for (const [excludeFile, entries] of plan.gitExcludes) {
            const clean: string[] = [];
            for (const { pattern, files } of entries) {
              const still = files.flatMap((file) => {
                const why = held.get(file);
                return why ? [`${file} (${why})`] : [];
              });
              if (still.length === 0) {
                clean.push(pattern);
                continue;
              }
              log.warn(
                `Kept \`${pattern}\` in ${excludeFile}, so git still ignores ${still.join('; ')}: it may hold MCP values teamai resolved to plaintext. `
                + `Remove teamai's MCP servers from it (or delete the file), then delete that line from ${excludeFile} yourself, and the block's two marker lines with its last one.`,
              );
            }
            if (clean.length === 0) continue;
            const result = await removeMcpGitExclude(excludeFile, clean);
            if (result === 'written') log.info(`Removed teamai's MCP config entries ${clean.join(', ')} from ${excludeFile}`);
            if (result === 'locked') {
              log.warn(`Kept teamai's block in ${excludeFile}: another teamai command held it past the wait. Delete the block's ${clean.join(', ')} lines yourself.`);
            }
          }
        }
      } catch (e) {
        log.warn(`Failed to remove MCP servers: ${(e as Error).message}`);
      }
    }

    const pendingOpencode = await executeRemoval(plan);

    // The OpenCode entries uninstall removed are no longer teamai's to track;
    // one still listed (the write failed) stays recorded for the next try.
    if (plan.opencodeInstructions.length > 0 && (!plan.includeShared || pendingOpencode.length > 0)) {
      const { loadStateForScope, saveStateForScope } = await import('./config.js');
      const state = await loadStateForScope(localConfig!);
      if (state.opencodeContextEntries) {
        const removed = plan.opencodeInstructions.filter((ref) => !pendingOpencode.some(
          (pending) => pending.config === ref.config && pending.entry === ref.entry,
        ));
        state.opencodeContextEntries = state.opencodeContextEntries.filter(
          (ref) => !removed.some((e) => e.config === ref.config && e.entry === ref.entry),
        );
        await saveStateForScope(state, localConfig!);
      }
    }

    // Persist the exclusion so the next pull (or another tool's session-start
    // hook) does not resurrect this tool's resources. Only meaningful when the
    // shared ~/.teamai home survives (non-last-tool uninstall); on a last-tool
    // uninstall the home is deleted and there is nothing to persist.
    if (agentKey && (!plan.includeShared || pendingOpencode.length > 0)) {
      await excludeUninstalledAgent(localConfig, agentKey);
    }

    if (pendingOpencode.length > 0) {
      log.warn(`Uninstall incomplete: kept ${plan.teamaiHome} and OpenCode ownership so removal can be retried. Repair permissions or JSON in ${pendingOpencode.map((ref) => ref.config).join(', ')}, then run the same uninstall command again.`);
      process.exitCode = 1;
    } else {
      log.success('teamai uninstalled');
    }
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
