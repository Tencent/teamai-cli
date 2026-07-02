import { pathExists } from './utils/fs.js';
import { resolveBaseDir } from './types.js';
import type { LocalConfig, TeamaiConfig } from './types.js';

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
  { id: 'codebuddy', displayName: 'CodeBuddy', category: 'coding', skillsPath: '.codebuddy/skills' },

  // Additional coding agents from skills-manage
  { id: 'gemini', displayName: 'Gemini CLI', category: 'coding', skillsPath: '.gemini/skills' },
  { id: 'aider', displayName: 'Aider', category: 'coding', skillsPath: '.aider/skills' },
  { id: 'amp', displayName: 'Amp', category: 'coding', skillsPath: '.amp/skills' },
  { id: 'augment', displayName: 'Augment', category: 'coding', skillsPath: '.augment/skills' },
  { id: 'copilot', displayName: 'Copilot', category: 'coding', skillsPath: '.copilot/skills' },
  { id: 'factory', displayName: 'Factory Droid', category: 'coding', skillsPath: '.factory/skills' },
  { id: 'hermes', displayName: 'Hermes', category: 'coding', skillsPath: '.hermes/skills' },
  { id: 'junie', displayName: 'Junie', category: 'coding', skillsPath: '.junie/skills' },
  { id: 'kilocode', displayName: 'KiloCode', category: 'coding', skillsPath: '.kilocode/skills' },
  { id: 'kiro', displayName: 'Kiro', category: 'coding', skillsPath: '.kiro/skills' },
  { id: 'ob1', displayName: 'OB1', category: 'coding', skillsPath: '.ob1/skills' },
  { id: 'opencode', displayName: 'OpenCode', category: 'coding', skillsPath: '.opencode/skills' },
  { id: 'qoder', displayName: 'Qoder', category: 'coding', skillsPath: '.qoder/skills' },
  { id: 'qwen', displayName: 'Qwen', category: 'coding', skillsPath: '.qwen/skills' },
  { id: 'trae', displayName: 'Trae', category: 'coding', skillsPath: '.trae/skills' },
  { id: 'trae-cn', displayName: 'Trae CN', category: 'coding', skillsPath: '.trae-cn/skills' },
  { id: 'windsurf', displayName: 'Windsurf', category: 'coding', skillsPath: '.windsurf/skills' },

  // Lobster family
  { id: 'openclaw', displayName: 'OpenClaw', category: 'lobster', skillsPath: '.openclaw/skills' },
  { id: 'qclaw', displayName: 'QClaw', category: 'lobster', skillsPath: '.qclaw/skills' },
  { id: 'easyclaw', displayName: 'EasyClaw', category: 'lobster', skillsPath: '.easyclaw/skills' },
  { id: 'autoclaw', displayName: 'AutoClaw', category: 'lobster', skillsPath: '.openclaw-autoclaw/skills' },
  { id: 'workbuddy', displayName: 'WorkBuddy', category: 'lobster', skillsPath: '.workbuddy/skills' },

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
export function getEffectiveAgents(teamConfig: TeamaiConfig): KnownAgent[] {
  const byId = new Map<string, KnownAgent & { fromTeamConfig?: boolean }>();

  for (const agent of KNOWN_AGENTS) {
    byId.set(agent.id, { ...agent });
  }

  for (const [id, paths] of Object.entries(teamConfig.toolPaths)) {
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
  const baseDir = resolveBaseDir(localConfig);
  const agents = getEffectiveAgents(teamConfig);
  const fromTeamConfig = new Set(
    Object.entries(teamConfig.toolPaths)
      .filter(([, paths]) => paths.skills)
      .map(([id]) => id),
  );

  const results: ResolvedAgent[] = [];
  for (const agent of agents) {
    const segments = agent.skillsPath.split('/');
    const rootSegment = segments[0] ?? '';
    const rootPath = `${baseDir}/${rootSegment}`;
    const installed = rootSegment ? await pathExists(rootPath) : false;
    results.push({
      ...agent,
      absoluteSkillsPath: `${baseDir}/${agent.skillsPath}`,
      installed,
      fromTeamConfig: fromTeamConfig.has(agent.id),
    });
  }

  return results;
}
