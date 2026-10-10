import path from 'node:path';
import { pathExists, ensureDir, writeJson } from './utils/fs.js';
import {
  COPILOT_TOOL_ID,
  getCopilotHome,
  resolveBaseDir,
  resolveToolBaseDir,
  isAgentDisabled,
  isSelfMode,
  resolveHookScope,
  scopedToolPaths,
  toolGateRoot,
  detectToolRoot,
} from './types.js';
import { isToolInstalledForConfig } from './resources/base.js';
import type { LocalConfig, TeamaiConfig, Scope } from './types.js';
import { getUserHome } from './utils/home.js';

/**
 * Single-repo mode: the AI tools offered when `teamai init .` asks which tool
 * directories to create (interactive multi-select), and the candidate set probed
 * against the user's HOME in non-interactive contexts. Order is the display order.
 * Kept small on purpose — the common coding agents, not the full KNOWN_AGENTS list.
 */
export const SELF_MODE_AGENT_CHOICES = ['claude', 'codex', 'cursor', 'copilot', 'pi', 'joycode', 'codebuddy', 'workbuddy'] as const;

/**
 * Normalize the `--agent` option into a deduplicated id list.
 *
 * Accepts commander's variadic array (`--agent claude --agent codex` → ['claude',
 * 'codex']), a single string (legacy `--agent claude`), or a comma-separated
 * string (`--agent claude,codex`). Any element may itself be comma-separated, so
 * both invocation styles compose. Blank entries are dropped; order/first-seen is
 * preserved. Returns [] for undefined/empty.
 */
export function normalizeAgentList(agent?: string | string[]): string[] {
  if (agent === undefined) return [];
  const raw = Array.isArray(agent) ? agent : [agent];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw) {
    for (const piece of String(part).split(',')) {
      const id = piece.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

// ─── Known AI coding agents registry ────────────────────
//
//  Curated list of agents whose skills directory layout is
//  predictable (~/.<id>/skills/). Sourced from the
//  iamzhihuix/skills-manage project's supported-platforms
//  table.
//
//  At runtime the list is merged with `teamConfig.toolPaths`
//  so user-customized agents (or new tools added to the
//  team config) always take precedence.

export type AgentCategory = 'coding' | 'lobster' | 'central';

export interface KnownAgent {
  /** Lowercase identifier used in CLI flags and toolPaths keys. */
  id: string;
  /** Human-friendly name for output. */
  displayName: string;
  /** Logical grouping for display ordering. */
  category: AgentCategory;
  /** Skills directory relative to the user's HOME (no leading slash). */
  skillsPath: string;
}

/**
 * Built-in agent registry. Order is intentional: agents that already
 * appear in default `toolPaths` are listed first (coding section), then
 * additional skills-manage entries we don't yet ship in toolPaths.
 */
export const KNOWN_AGENTS: KnownAgent[] = [
  // Coding agents already wired through teamConfig.toolPaths defaults
  { id: 'claude', displayName: 'Claude Code', category: 'coding', skillsPath: '.claude/skills' },
  { id: 'claude-internal', displayName: 'Claude Code Internal', category: 'coding', skillsPath: '.claude-internal/skills' },
  { id: 'tclaude', displayName: 'TClaude', category: 'coding', skillsPath: '.tclaude/skills' },
  { id: 'codex', displayName: 'Codex CLI', category: 'coding', skillsPath: '.codex/skills' },
  { id: 'codex-internal', displayName: 'Codex CLI Internal', category: 'coding', skillsPath: '.codex-internal/skills' },
  { id: 'tcodex', displayName: 'TCodex', category: 'coding', skillsPath: '.tcodex/skills' },
  { id: 'cursor', displayName: 'Cursor', category: 'coding', skillsPath: '.cursor/skills' },
  { id: 'joycode', displayName: 'JoyCode', category: 'coding', skillsPath: '.joycode/skills' },
  { id: 'codebuddy', displayName: 'CodeBuddy', category: 'coding', skillsPath: '.codebuddy/skills' },

  // Additional coding agents from skills-manage
  { id: 'gemini', displayName: 'Gemini CLI', category: 'coding', skillsPath: '.gemini/skills' },
  { id: 'aider', displayName: 'Aider', category: 'coding', skillsPath: '.aider/skills' },
  { id: 'amp', displayName: 'Amp', category: 'coding', skillsPath: '.amp/skills' },
  { id: 'augment', displayName: 'Augment', category: 'coding', skillsPath: '.augment/skills' },
  { id: 'copilot', displayName: 'Copilot', category: 'coding', skillsPath: '.copilot/skills' },
  { id: 'pi', displayName: 'Pi Coding Agent', category: 'coding', skillsPath: '.pi/skills' },
  { id: 'factory', displayName: 'Factory Droid', category: 'coding', skillsPath: '.factory/skills' },
  { id: 'hermes', displayName: 'Hermes', category: 'coding', skillsPath: '.hermes/skills' },
  { id: 'junie', displayName: 'Junie', category: 'coding', skillsPath: '.junie/skills' },
  { id: 'kilocode', displayName: 'KiloCode', category: 'coding', skillsPath: '.kilocode/skills' },
  { id: 'kiro', displayName: 'Kiro', category: 'coding', skillsPath: '.kiro/skills' },
  { id: 'ob1', displayName: 'OB1', category: 'coding', skillsPath: '.ob1/skills' },
  { id: 'omp', displayName: 'Oh My Pi', category: 'coding', skillsPath: '.omp/skills' },
  { id: 'opencode', displayName: 'OpenCode', category: 'coding', skillsPath: '.opencode/skills' },
  { id: 'qoder', displayName: 'Qoder', category: 'coding', skillsPath: '.qoder/skills' },
  { id: 'qoder-cn', displayName: 'Qoder CN', category: 'coding', skillsPath: '.qoder-cn/skills' },
  { id: 'qwen', displayName: 'Qwen', category: 'coding', skillsPath: '.qwen/skills' },
  { id: 'trae', displayName: 'Trae', category: 'coding', skillsPath: '.trae/skills' },
  { id: 'trae-cn', displayName: 'Trae CN', category: 'coding', skillsPath: '.trae-cn/skills' },
  { id: 'windsurf', displayName: 'Windsurf', category: 'coding', skillsPath: '.windsurf/skills' },
  { id: 'zcode', displayName: 'ZCode', category: 'coding', skillsPath: '.zcode/skills' },

  // Lobster family
  { id: 'openclaw', displayName: 'OpenClaw', category: 'lobster', skillsPath: '.openclaw/skills' },
  { id: 'qclaw', displayName: 'QClaw', category: 'lobster', skillsPath: '.qclaw/skills' },
  { id: 'easyclaw', displayName: 'EasyClaw', category: 'lobster', skillsPath: '.easyclaw/skills' },
  { id: 'autoclaw', displayName: 'AutoClaw', category: 'lobster', skillsPath: '.openclaw-autoclaw/skills' },
  { id: 'workbuddy', displayName: 'WorkBuddy', category: 'lobster', skillsPath: '.workbuddy/skills' },

  // DeepSeek Harness (dsh) — plugin-based agent harness. Its skill-filesystem
  // provider scans user skill roots: ~/.dsh/skills (rank 400) and ~/.agents/skills
  // (rank 500). We sync to ~/.dsh/skills so dsh keeps its own copy; the central
  // `.agents` entry below covers the shared root as well.
  { id: 'dsh', displayName: 'DeepSeek Harness', category: 'coding', skillsPath: '.dsh/skills' },

  // Central agent skills directory (codex / generic)
  { id: 'agents', displayName: 'Central (Agent Skills)', category: 'central', skillsPath: '.agents/skills' },
];

export interface ResolvedAgent extends KnownAgent {
  /** Absolute path to the skills directory after expanding HOME / projectRoot. */
  absoluteSkillsPath: string;
  /** Whether the parent agent directory (~/.<id>/) exists on disk. */
  installed: boolean;
  /** True when the entry came from teamConfig.toolPaths (vs the built-in registry). */
  fromTeamConfig: boolean;
}

/**
 * Merge the static KNOWN_AGENTS list with the per-team `toolPaths`
 * config. Entries that share the same id prefer the team config's
 * skillsPath (admin can override the default location).
 */
/**
 * Seed the tool skills-directory root for the agents this scope should sync
 * to, so that first-run injection actually lands.
 *
 * `teamai pull` only injects into AI tools whose root dir already exists
 * (isToolInstalled) — normally the user "opts in" by having e.g. ~/.claude
 * before ever running teamai. Two cases break that assumption, and both call
 * this to seed the dir instead of relying on it already being there:
 *
 * - Single-repo mode's whole promise is "clone → auto-inject": a teammate's
 *   fresh clone has no <repo>/.claude yet, so nothing would ever inject.
 * - Any mode's `--agent <id>` naming a custom agent configured only in
 *   `teamai.yaml`'s `toolPaths` (not one of the built-in tools a user
 *   installs themselves): its root is not something anything else ever
 *   creates, so without seeding, `--agent` would name a target `pull` can
 *   never actually reach (#867).
 *
 * Outside self mode, only the second case applies: a built-in tool (one
 * KNOWN_AGENTS already lists) is left alone even if enabled, since its root
 * already existing is exactly what `doctor`'s "is installed" check verifies
 * (#598) — seeding it here would silently manufacture a directory for
 * software that was never actually installed.
 *
 * Which agents: strictly `localConfig.enabledAgents`. The caller decides that
 * set — interactively (multi-select in `teamai init .`), from `--agent`, or
 * by probing the user's HOME in non-interactive contexts (see
 * detectHomeInstalledAgents). We deliberately do NOT fall back to a
 * hardcoded default here: an empty enabledAgents means "create nothing", so
 * no `.claude/` is conjured for someone who never asked for it.
 *
 * Returns the list of agent ids whose dirs were ensured.
 */
export async function seedSelfModeToolDirs(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
): Promise<string[]> {
  const selfMode = isSelfMode(localConfig);
  const baseDir = resolveBaseDir(localConfig);
  const configured = scopedToolPaths(teamConfig, localConfig);

  // Non-self project scope injects hooks into HOME, not the project root
  // (`resolveHookScope`, #264): `~/.claude` always exists for a built-in tool,
  // so that gate passes, but a custom tool's HOME root is not something
  // anything else creates either. Seed there too when it differs, or the
  // custom agent's session-start hook is silently skipped (#867 review).
  const hookScope = resolveHookScope(localConfig);
  const seedHookRoot = hookScope.baseDir !== baseDir;
  const hookConfigured = seedHookRoot
    ? scopedToolPaths(teamConfig, { ...localConfig, scope: hookScope.scope })
    : configured;

  let targets = localConfig.enabledAgents ?? [];
  // Never seed an explicitly disabled agent.
  targets = targets.filter((id) => !isAgentDisabled(localConfig, id));

  const seeded: string[] = [];
  for (const id of targets) {
    const isCustom = !KNOWN_AGENTS.some((a) => a.id === id);
    if (!selfMode && !isCustom) continue;

    const fallbackSkills = KNOWN_AGENTS.find((a) => a.id === id)?.skillsPath;
    let ensured = await seedToolRoots(id, baseDir, configured[id], fallbackSkills, localConfig.toolRoots);
    // The HOME pass is restricted to what hook installation actually reads
    // (settings/hooks) — seeding skills/rules/agents/claudemd there too would
    // create a redundant directory for a tool with no settings-based hook
    // surface (#867 review, P2).
    if (seedHookRoot && await seedHookInstallRoot(id, hookScope.baseDir, hookConfigured[id], localConfig.toolRoots)) ensured = true;
    if (ensured) seeded.push(id);
  }
  return seeded;
}

/**
 * Every distinct root a tool's configured resource paths imply, ensured on
 * disk. skills/rules/agents are directories themselves; claudemd is a FILE
 * (e.g. "a/AGENTS.md" — see ToolPathsSchema), so ensureDir-ing it directly
 * would create a directory literally named "AGENTS.md" — a nested one seeds
 * its parent root instead. A bare root-level claudemd (no "/") has no parent
 * to create — its own "installed" check keys off a `.${tool}` directory
 * convention instead (local-agent.ts), unrelated to its own path, so it is
 * left alone here. settings/hooks are handled by seedHookInstallRoot.
 *
 * The root created is the one the gate reads (`toolGateRoot`), not the
 * two-segment shape of the path: seeding a prefix the gate no longer probes
 * would leave the tool looking uninstalled and the hook injection skipped.
 */
async function seedToolRoots(
  tool: string,
  baseDir: string,
  paths: ReturnType<typeof scopedToolPaths>[string] | undefined,
  fallbackSkills?: string,
  toolRoots?: Record<string, string>,
): Promise<boolean> {
  const dirPaths = [paths?.skills, paths?.rules, paths?.agents].filter((p): p is string => !!p);
  if (dirPaths.length === 0 && fallbackSkills) dirPaths.push(fallbackSkills);
  for (const dirPath of dirPaths) await ensureDir(path.join(baseDir, dirPath));

  let ensuredAnything = dirPaths.length > 0;
  const claudemd = paths?.claudemd;
  if (claudemd) {
    const claudemdRoot = toolGateRoot(tool, claudemd, toolRoots);
    if (claudemdRoot !== claudemd) {
      await ensureDir(path.join(baseDir, claudemdRoot));
      ensuredAnything = true;
    }
  }
  if (await seedHookInstallRoot(tool, baseDir, paths, toolRoots)) ensuredAnything = true;
  return ensuredAnything;
}

/**
 * The root `reconcileHooksToAllTools`'s generic per-tool gate and doctor's
 * own probe actually read (`paths.settings ?? paths.hooks`), ensured on disk.
 * Nested, that's its parent directory, same as any other file-valued path.
 * Bare (no "/"), there is no parent — the gate checks the FILE itself
 * (`toolGateRoot` returns a bare path unchanged) — but reconcileHooks
 * already treats a missing settings/hooks file as `{}`, so an empty JSON
 * object satisfies the gate and gives it something valid to merge into,
 * instead of a bogus same-named directory.
 */
async function seedHookInstallRoot(
  tool: string,
  baseDir: string,
  paths: ReturnType<typeof scopedToolPaths>[string] | undefined,
  toolRoots?: Record<string, string>,
): Promise<boolean> {
  let seeded = false;
  for (const filePath of [paths?.settings, paths?.hooks].filter((p): p is string => !!p)) {
    const root = toolGateRoot(tool, filePath, toolRoots);
    if (root !== filePath) {
      await ensureDir(path.join(baseDir, root));
    } else {
      const full = path.join(baseDir, filePath);
      if (!await pathExists(full)) await writeJson(full, {});
    }
    seeded = true;
  }
  return seeded;
}

/**
 * Detect which candidate AI tools are already installed under the user's HOME.
 *
 * Used by single-repo mode in non-interactive contexts (CI, session-start hook,
 * clone-time bootstrap) to decide which tool dirs to seed when the user cannot be
 * asked: we mirror whatever tools they already use globally (~/.claude, ~/.codex,
 * ...). Returns [] when none are present — the caller then seeds nothing rather
 * than conjuring a `.claude/` nobody uses.
 *
 * Note this probes HOME, not resolveBaseDir(localConfig) (which in project scope
 * is the repo root). The whole point is "what does this developer use elsewhere".
 */
export async function detectHomeInstalledAgents(
  candidateIds: readonly string[] = SELF_MODE_AGENT_CHOICES,
): Promise<string[]> {
  const home = getUserHome();

  const found: string[] = [];
  for (const id of candidateIds) {
    if (id === COPILOT_TOOL_ID) {
      if (await pathExists(getCopilotHome())) found.push(id);
      continue;
    }
    const skillsPath = KNOWN_AGENTS.find((a) => a.id === id)?.skillsPath;
    if (!skillsPath) continue;
    const rootSegment = skillsPath.split('/')[0]; // e.g. ".claude"
    if (!rootSegment) continue;
    // A Claude Code relocated with CLAUDE_CONFIG_DIR (or a Codex with
    // CODEX_HOME) may have no default root at all; the developer still uses
    // it. This runs before any config exists, so the variable is the only signal.
    const relocated = detectToolRoot(id);
    if (await pathExists(path.join(home, rootSegment)) || (relocated !== null && await pathExists(relocated))) {
      found.push(id);
    }
  }
  return found;
}

export function getEffectiveAgents(
  teamConfig: TeamaiConfig,
  localConfig?: { scope?: Scope },
): KnownAgent[] {
  const byId = new Map<string, KnownAgent & { fromTeamConfig?: boolean }>();

  for (const agent of KNOWN_AGENTS) {
    byId.set(agent.id, { ...agent });
  }

  const toolPaths = scopedToolPaths(teamConfig, localConfig ?? {});
  for (const [id, paths] of Object.entries(toolPaths)) {
    if (!paths.skills) continue;
    const existing = byId.get(id);
    if (existing) {
      byId.set(id, { ...existing, skillsPath: paths.skills, fromTeamConfig: true });
    } else {
      byId.set(id, {
        id,
        displayName: id,
        category: 'coding',
        skillsPath: paths.skills,
        fromTeamConfig: true,
      });
    }
  }

  return [...byId.values()];
}

/**
 * Resolve agents to absolute paths and detect installation state.
 *
 * `installed` is true when the agent's root directory (~/.<id>/)
 * exists; this mirrors `ResourceHandler.isToolInstalled` so the
 * detection lines up with what `teamai pull` actually writes to.
 */
export async function detectInstalledAgents(localConfig: LocalConfig, teamConfig: TeamaiConfig): Promise<ResolvedAgent[]> {
  const agents = getEffectiveAgents(teamConfig, localConfig);
  const scoped = scopedToolPaths(teamConfig, localConfig);
  const fromTeamConfig = new Set(
    Object.entries(scoped)
      .filter(([, paths]) => paths.skills)
      .map(([id]) => id),
  );

  const results: ResolvedAgent[] = [];
  for (const agent of agents) {
    const baseDir = resolveToolBaseDir(agent.id, localConfig);
    const installed = await isToolInstalledForConfig(agent.id, agent.skillsPath, localConfig);
    results.push({
      ...agent,
      absoluteSkillsPath: path.join(baseDir, agent.skillsPath),
      installed,
      fromTeamConfig: fromTeamConfig.has(agent.id),
    });
  }

  return results;
}
