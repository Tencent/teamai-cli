import path from 'node:path';
import YAML from 'yaml';
import { listDirs, pathExists, readFileSafe } from './utils/fs.js';
import { detectInstalledAgents, type ResolvedAgent } from './known-agents.js';
import { BUILTIN_SKILL_NAMES } from './builtin-skills.js';
import type { LocalConfig, TeamaiConfig } from './types.js';
import { getUserHome } from './utils/home.js';

// ─── Local agent skill scanning ─────────────────────────
//
//  Walks each agent's `<HOME>/.<agent>/skills/` directory,
//  reads SKILL.md frontmatter, and tags each skill with its
//  origin so users can tell at a glance which skills came
//  from the team repo, which are CLI built-ins, which were
//  pulled from a cross-team source, and which are local-only
//  drafts that have not been pushed yet.

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---/;

export type SkillSource =
  | { kind: 'team'; namespace?: string }
  | { kind: 'builtin' }
  | { kind: 'source'; name: string }
  | { kind: 'local-only' };

export interface AgentSkill {
  /** Skill directory name (matches <agent>/skills/<name>/). */
  name: string;
  /** Frontmatter description, trimmed and possibly truncated by callers. */
  description: string;
  /** Absolute path to the skill directory inside the agent. */
  path: string;
  /** Provenance of this skill. */
  source: SkillSource;
}

export interface AgentSkillsView {
  agent: ResolvedAgent;
  skills: AgentSkill[];
}

export interface ClassifyContext {
  /** Skill names found anywhere in the team repo (flat + namespaced). */
  teamSkills: Map<string, { namespace?: string }>;
  /** Skill names provided by external source repos. */
  sourceSkills: Map<string, string>;
}

/**
 * Build the classification context once so repeated `classifySkill`
 * calls (one per agent + skill) stay cheap.
 */
export async function buildClassifyContext(localConfig: LocalConfig): Promise<ClassifyContext> {
  const teamSkills = await collectTeamRepoSkills(localConfig.repo.localPath);

  const sourceSkills = new Map<string, string>();
  try {
    const sourcesDir = path.join(getUserHome(), '.teamai', 'sources');
    if (await pathExists(sourcesDir)) {
      const sourceNames = await listDirs(sourcesDir);
      for (const sourceName of sourceNames) {
        const manifestPath = path.join(sourcesDir, sourceName, 'installed.json');
        const raw = await readFileSafe(manifestPath);
        if (!raw) continue;
        try {
          const manifest = JSON.parse(raw) as { installedSkills?: string[] };
          for (const skill of manifest.installedSkills ?? []) {
            if (!sourceSkills.has(skill)) sourceSkills.set(skill, sourceName);
          }
        } catch {
          // ignore malformed manifest
        }
      }
    }
  } catch {
    // ignore — running outside a normal HOME env
  }

  return { teamSkills, sourceSkills };
}

/**
 * Walk the team repo `skills/` directory, returning a map of
 * skill name → namespace. Flat skills get an empty namespace.
 */
async function collectTeamRepoSkills(repoPath: string): Promise<Map<string, { namespace?: string }>> {
  const teamSkillsDir = path.join(repoPath, 'skills');
  const result = new Map<string, { namespace?: string }>();
  if (!await pathExists(teamSkillsDir)) return result;

  const topDirs = await listDirs(teamSkillsDir);
  for (const dir of topDirs) {
    const dirPath = path.join(teamSkillsDir, dir);
    const hasSkillMd = await pathExists(path.join(dirPath, 'SKILL.md'));
    if (hasSkillMd) {
      result.set(dir, {});
    } else {
      const subDirs = await listDirs(dirPath);
      for (const subDir of subDirs) {
        if (!result.has(subDir)) {
          result.set(subDir, { namespace: dir });
        }
      }
    }
  }

  return result;
}

/** Resolve a skill name to its source tag using the prebuilt context. */
export function classifySkill(name: string, ctx: ClassifyContext): SkillSource {
  if (BUILTIN_SKILL_NAMES.has(name)) return { kind: 'builtin' };
  if (ctx.teamSkills.has(name)) {
    return { kind: 'team', namespace: ctx.teamSkills.get(name)?.namespace };
  }
  if (ctx.sourceSkills.has(name)) {
    return { kind: 'source', name: ctx.sourceSkills.get(name)! };
  }
  return { kind: 'local-only' };
}

/** Pretty-print a SkillSource for terminal output. */
export function formatSkillSource(source: SkillSource): string {
  switch (source.kind) {
    case 'team':
      return source.namespace ? `[team:${source.namespace}]` : '[team]';
    case 'builtin':
      return '[builtin]';
    case 'source':
      return `[source:${source.name}]`;
    case 'local-only':
      return '[local-only]';
  }
}

/**
 * Walk a single agent's skills directory, returning one AgentSkill
 * per `<skillsDir>/<name>/SKILL.md`. Skips entries without SKILL.md
 * so unrelated directories don't get reported as broken skills.
 */
export async function scanAgentSkills(agent: ResolvedAgent, ctx: ClassifyContext): Promise<AgentSkillsView> {
  const skills: AgentSkill[] = [];
  if (!agent.installed) {
    return { agent, skills };
  }
  if (!await pathExists(agent.absoluteSkillsPath)) {
    return { agent, skills };
  }

  const dirs = await listDirs(agent.absoluteSkillsPath);
  for (const name of dirs) {
    // Skip hidden directories (e.g. .system) and workspace scratch dirs
    if (name.startsWith('.') || name.endsWith('-workspace')) continue;
    const skillDir = path.join(agent.absoluteSkillsPath, name);
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (!await pathExists(skillMd)) continue;
    const description = await readSkillDescription(skillMd);
    skills.push({
      name,
      description,
      path: skillDir,
      source: classifySkill(name, ctx),
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { agent, skills };
}

/**
 * Scan every installed agent in one pass. Agents that are not
 * installed (no `~/.<id>/` directory) are silently dropped — they
 * are intentionally not part of the output, matching the rule that
 * `pull` already skips uninstalled tools.
 */
export async function scanInstalledAgents(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
): Promise<AgentSkillsView[]> {
  const agents = await detectInstalledAgents(localConfig, teamConfig);
  const ctx = await buildClassifyContext(localConfig);
  const views: AgentSkillsView[] = [];
  for (const agent of agents) {
    if (!agent.installed) continue;
    views.push(await scanAgentSkills(agent, ctx));
  }
  return views;
}

/**
 * Extract a description from a SKILL.md file. Parses the YAML
 * frontmatter and returns the `description` field, normalizing
 * any multi-line block scalar to a single space-joined string.
 */
export async function readSkillDescription(skillMdPath: string): Promise<string> {
  const content = await readFileSafe(skillMdPath);
  if (!content) return '';
  const fm = content.match(FRONTMATTER_REGEX);
  if (!fm) return '';

  let parsed: unknown;
  try {
    parsed = YAML.parse(fm[1]);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const desc = (parsed as Record<string, unknown>).description;
  if (typeof desc !== 'string') return '';

  // Normalize whitespace: collapse newlines + indentation into single spaces
  return desc.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
}

/** Truncate description to `max` characters with an ellipsis suffix. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 3)) + '...';
}
