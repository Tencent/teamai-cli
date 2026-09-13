import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { getUserHome } from './utils/home.js';
import { ensureRepoCache, diffNameSets } from './utils/external-repo-cache.js';
import { readJson, writeJson, readFileSafe, pathExists, listDirs, listFilesRecursive, copyDir, remove } from './utils/fs.js';
import { injectClaudeMdSection } from './utils/claudemd.js';
import { log } from './utils/logger.js';
import { getHandler } from './resources/index.js';
import { ResourceHandler } from './resources/base.js';
import {
  resolveSkillDestination,
  ensureSkillFrontmatter,
  getLocalTeamSkillNames,
  removeSkillFromToolPaths,
} from './resources/skills.js';
import { ruleFileExtensionForTool } from './resources/rule-format.js';
import type { TeamaiConfig, LocalConfig, GlobalOptions, ResourceItem, TeamContextInstallManifest } from './types.js';
import {
  resolveBaseDir,
  scopedToolPaths,
  isAgentExcluded,
  TEAM_CONTEXT_SCHEMA_VERSION,
  TEAM_CONTEXT_PULL_TTL_MS,
  TEAMAI_TEAM_CONTEXT_GOVERNANCE_START,
  TEAMAI_TEAM_CONTEXT_GOVERNANCE_END,
} from './types.js';

// ─── DSH Team Context adapter (v0, read-only) ─────────────
//
//  See types.ts's "DSH Team Context (canonical, read-only)" comment for the
//  data-flow diagram. This module is the entire adapter: pull the upstream
//  clone, validate+resolve a full snapshot, then materialize it. There is no
//  push/propose path here and none should ever be added without an explicit,
//  human-reviewed upstream workflow (deferred, out of scope for v0).
//
//  Clone/pull-with-TTL and name-set diffing are the shared `external-repo-cache.ts`
//  primitives (also used by source.ts's peer `sources`); everything below is
//  specific to what a canonical Team Context repo contains and how each
//  entity type resolves a collision against team-authored content.

/** A resolved item ready to deploy: its canonical name and its path inside the upstream clone. */
interface ResolvedItem {
  name: string;
  sourcePath: string;
}

/** The fully validated, in-memory desired state for one pull — never partially applied. */
export interface TeamContextSnapshot {
  schemaVersion: number;
  skills: ResolvedItem[];
  rules: ResolvedItem[];
  governanceFiles: ResolvedItem[];
}

export interface TeamContextMaterializeResult {
  deployedSkills: string[];
  /** Skills NOT deployed because a local team-authored skill has the same name (local-wins, observable). */
  skippedSkillsLocalOverride: string[];
  removedSkills: string[];
  deployedRules: string[];
  removedRules: string[];
  governanceInjected: boolean;
  skillPaths: Record<string, string[]>;
}

function teamContextCacheKey(repoUrl: string): string {
  return createHash('sha256').update(repoUrl).digest('hex').slice(0, 16);
}

function getTeamContextDir(repoUrl: string): string {
  return path.join(getUserHome(), '.teamai', 'team-context', teamContextCacheKey(repoUrl));
}

/** Exported for tests: the local clone directory a given Team Context repo materializes into. */
export function getTeamContextRepoDir(repoUrl: string): string {
  return path.join(getTeamContextDir(repoUrl), 'repo');
}

function getTeamContextManifestPath(repoUrl: string): string {
  return path.join(getTeamContextDir(repoUrl), 'installed.json');
}

async function loadTeamContextManifest(repoUrl: string): Promise<TeamContextInstallManifest | null> {
  return readJson<TeamContextInstallManifest>(getTeamContextManifestPath(repoUrl));
}

async function saveTeamContextManifest(repoUrl: string, manifest: TeamContextInstallManifest): Promise<void> {
  await writeJson(getTeamContextManifestPath(repoUrl), manifest);
}

/**
 * Read `<repoDir>/skills/<name>/SKILL.md` entries. Flat layout only in v0 —
 * a canonical, org-wide repo has no role/project namespace concept yet
 * (namespace-aware resolve is deferred); a directory without SKILL.md is
 * skipped rather than treated as a namespace.
 */
async function listCanonicalSkills(repoDir: string): Promise<ResolvedItem[]> {
  const skillsDir = path.join(repoDir, 'skills');
  if (!await pathExists(skillsDir)) return [];

  const items: ResolvedItem[] = [];
  for (const name of await listDirs(skillsDir)) {
    const dir = path.join(skillsDir, name);
    if (await pathExists(path.join(dir, 'SKILL.md'))) {
      items.push({ name, sourcePath: dir });
    } else {
      log.debug(`[team-context] Skipping "skills/${name}": no SKILL.md (namespaced skills are not supported in v0)`);
    }
  }
  return items;
}

/** Read `<repoDir>/rules/*.md` (recursively, so subdirectories are supported like team rules). */
async function listCanonicalRules(repoDir: string): Promise<ResolvedItem[]> {
  const rulesDir = path.join(repoDir, 'rules');
  if (!await pathExists(rulesDir)) return [];

  const files = (await listFilesRecursive(rulesDir)).filter((f) => f.endsWith('.md'));
  return files.map((f) => ({ name: f.slice(0, -'.md'.length), sourcePath: path.join(rulesDir, f) }));
}

/** Read `<repoDir>/governance/*.md`, sorted for a deterministic compiled block. */
async function listCanonicalGovernanceFiles(repoDir: string): Promise<ResolvedItem[]> {
  const governanceDir = path.join(repoDir, 'governance');
  if (!await pathExists(governanceDir)) return [];

  const files = (await listFilesRecursive(governanceDir)).filter((f) => f.endsWith('.md')).sort();
  return files.map((f) => ({ name: f, sourcePath: path.join(governanceDir, f) }));
}

/**
 * Validate the upstream repo's contract and resolve everything it publishes
 * into one in-memory snapshot. Throws (rather than returning a partial
 * result) on a missing or unsupported `team-context.yaml` — the caller MUST
 * treat a thrown error as "do not materialize, leave local state untouched",
 * which is what makes an invalid/incompatible upstream unable to leave
 * partial or tombstoned local state.
 *
 * No allow-list: everything under skills/, rules/, governance/ is canonical
 * published content (unlike peer `sources`, which gate on `publicSkills`).
 */
export async function resolveTeamContextSnapshot(repoDir: string): Promise<TeamContextSnapshot> {
  const manifestPath = path.join(repoDir, 'team-context.yaml');
  const raw = await readFileSafe(manifestPath);
  if (raw === null) {
    throw new Error(
      `DSH Team Context repo is missing team-context.yaml at its root `
      + `(expected "schemaVersion: ${TEAM_CONTEXT_SCHEMA_VERSION}"). Refusing to materialize.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    throw new Error(`DSH Team Context team-context.yaml is not valid YAML: ${(e as Error).message}`);
  }

  const schemaVersion = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (schemaVersion !== TEAM_CONTEXT_SCHEMA_VERSION) {
    throw new Error(
      `DSH Team Context team-context.yaml declares unsupported schemaVersion `
      + `${JSON.stringify(schemaVersion)} (this teamai version supports `
      + `${TEAM_CONTEXT_SCHEMA_VERSION}). Refusing to materialize.`,
    );
  }

  const [skills, rules, governanceFiles] = await Promise.all([
    listCanonicalSkills(repoDir),
    listCanonicalRules(repoDir),
    listCanonicalGovernanceFiles(repoDir),
  ]);

  return { schemaVersion, skills, rules, governanceFiles };
}

/** governance/*.md concatenated into one deterministic, always-present block. */
function compileGovernanceBlock(files: { name: string; content: string }[]): string {
  const parts = files.map((f) => f.content.trim()).filter((c) => c.length > 0);
  const body = parts.length > 0
    ? parts.join('\n\n')
    : '_The Team Context repo currently publishes no governance content._';

  return [
    TEAMAI_TEAM_CONTEXT_GOVERNANCE_START,
    '<!-- DO NOT EDIT: authoritative content mirrored from the DSH Team Context repo. -->',
    '<!-- Fully regenerated on every `teamai pull`; cannot be locally overridden or disabled. -->',
    '',
    '## Team Context Governance (canonical, read-only)',
    '',
    body,
    '',
    TEAMAI_TEAM_CONTEXT_GOVERNANCE_END,
  ].join('\n');
}

/**
 * Inject the governance block into every tool's CLAUDE.md, unconditionally
 * (no `teamContext`-shaped opt-out exists anywhere in local or team config).
 * Always regenerates the full block, even when governanceFiles is empty, so
 * an upstream removal cannot leave stale policy text behind (non-shadowable
 * in practice, not just by convention).
 */
async function injectGovernanceBlock(
  governanceFiles: ResolvedItem[],
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  baseDir: string,
): Promise<boolean> {
  const contents: { name: string; content: string }[] = [];
  for (const file of governanceFiles) {
    const content = await readFileSafe(file.sourcePath);
    if (content !== null) contents.push({ name: file.name, content });
  }
  const block = compileGovernanceBlock(contents);

  let injected = false;
  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    if (isAgentExcluded(localConfig, tool)) continue;
    if (!toolPath.claudemd) continue;
    // Same "is this tool actually set up" proxy pull.ts uses for culture/claudemd injection.
    if (toolPath.rules && !await ResourceHandler.isToolInstalled(toolPath.rules, baseDir)) continue;

    const claudeMdPath = path.join(baseDir, toolPath.claudemd);
    try {
      await injectClaudeMdSection(claudeMdPath, TEAMAI_TEAM_CONTEXT_GOVERNANCE_START, TEAMAI_TEAM_CONTEXT_GOVERNANCE_END, block);
      injected = true;
      log.debug(`[team-context] Injected governance into ${tool} CLAUDE.md`);
    } catch (e) {
      log.warn(`[team-context] Failed to inject governance into ${tool} CLAUDE.md: ${(e as Error).message}`);
    }
  }
  return injected;
}

/** Remove a canonical rule (not a team-authored one — no tombstone, no team-repo write) from every tool's rules dir. */
async function removeCanonicalRuleFromToolPaths(
  name: string,
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  baseDir: string,
): Promise<void> {
  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    if (!toolPath.rules) continue;
    for (const ext of new Set([ruleFileExtensionForTool(tool), '.md'])) {
      const filePath = path.join(baseDir, toolPath.rules, `${name}${ext}`);
      if (await pathExists(filePath)) {
        await remove(filePath);
        log.debug(`[team-context] Removed canonical rule ${name} from ${tool}`);
      }
    }
  }
}

/**
 * Deploy a validated, already-resolved snapshot. Callers MUST only call this
 * after `resolveTeamContextSnapshot` succeeded — never on a partially-read or
 * unvalidated upstream state.
 *
 * Collision policy (deliberately asymmetric, not a single "local wins"):
 *  - skills: a local team-authored skill of the same name wins; the
 *    canonical copy is skipped, logged (log.warn, not debug — must be
 *    observable), and reported in the result.
 *  - rules: canonical always wins. Deployed unconditionally, which — because
 *    this runs after the per-scope team-rule sync in `pull()` — deterministically
 *    overwrites a same-named team rule at its tool-dir location. There is no
 *    per-item check here: ordering in pull.ts is what guarantees this, and
 *    the acceptance test pins the outcome rather than the ordering.
 *  - governance: always regenerated in full (see injectGovernanceBlock);
 *    no collision concept applies.
 */
export async function materializeTeamContext(
  snapshot: TeamContextSnapshot,
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  previousManifest: TeamContextInstallManifest | null,
): Promise<TeamContextMaterializeResult> {
  const baseDir = resolveBaseDir(localConfig);

  // ---- skills: local override wins, observable ----
  const localTeamSkillNames = await getLocalTeamSkillNames(teamConfig, localConfig);
  const deployedSkills: string[] = [];
  const skippedSkillsLocalOverride: string[] = [];
  const skillPaths: Record<string, string[]> = {};

  for (const skill of snapshot.skills) {
    if (localTeamSkillNames.has(skill.name)) {
      skippedSkillsLocalOverride.push(skill.name);
      log.warn(
        `[team-context] Local skill "${skill.name}" overrides the canonical Team Context skill of the same name `
        + `(canonical copy not deployed — run \`teamai status\` to review).`,
      );
      continue;
    }

    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (isAgentExcluded(localConfig, tool)) continue;
      if (!toolPath.skills) continue;
      if (!await ResourceHandler.isToolInstalled(toolPath.skills, baseDir)) continue;

      const targetDir = await resolveSkillDestination(tool, toolPath.skills, baseDir, skill.name, skill.sourcePath);
      await copyDir(skill.sourcePath, targetDir);
      await ensureSkillFrontmatter(targetDir, skill.name);
      const relativeTarget = path.relative(baseDir, targetDir);
      const paths = skillPaths[skill.name] ??= [];
      if (!paths.includes(relativeTarget)) paths.push(relativeTarget);
    }
    deployedSkills.push(skill.name);
  }

  // Tombstone: anything we previously deployed that isn't deployed this run —
  // either removed upstream, or newly shadowed by a local skill. Either way
  // the canonical copy this adapter placed on disk no longer belongs there.
  const skillDiff = diffNameSets(previousManifest?.skills ?? [], deployedSkills);
  for (const name of skillDiff.removed) {
    await removeSkillFromToolPaths(name, teamConfig, localConfig, baseDir, previousManifest?.skillPaths?.[name]);
  }

  // ---- rules: canonical wins by default ----
  const rulesHandler = getHandler('rules');
  const deployedRules: string[] = [];
  for (const rule of snapshot.rules) {
    const item: ResourceItem = {
      name: rule.name,
      type: 'rules',
      sourcePath: rule.sourcePath,
      relativePath: `rules/${rule.name}.md`,
    };
    await rulesHandler.pullItem(item, teamConfig, localConfig);
    deployedRules.push(rule.name);
  }

  const ruleDiff = diffNameSets(previousManifest?.rules ?? [], deployedRules);
  for (const name of ruleDiff.removed) {
    await removeCanonicalRuleFromToolPaths(name, teamConfig, localConfig, baseDir);
  }

  // ---- governance: authoritative, always regenerated in full ----
  const governanceInjected = await injectGovernanceBlock(snapshot.governanceFiles, teamConfig, localConfig, baseDir);

  return {
    deployedSkills,
    skippedSkillsLocalOverride,
    removedSkills: skillDiff.removed,
    deployedRules,
    removedRules: ruleDiff.removed,
    governanceInjected,
    skillPaths,
  };
}

/**
 * Full pull cycle for the team's configured Team Context (if any): clone/pull
 * (best-effort, cached, TTL-gated), then validate+resolve the ENTIRE snapshot
 * before touching any local state, then materialize. A missing `teamContext`
 * config is a silent no-op (most teams won't have one in v0).
 *
 * Invalid/incompatible upstream (bad or missing team-context.yaml) fails
 * loud via `log.error` and returns WITHOUT calling materialize — previously
 * materialized skills/rules/governance and the manifest are left exactly as
 * they were, so a broken upstream can never leave partial or tombstoned
 * local state.
 */
export async function syncTeamContext(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  options: GlobalOptions,
): Promise<void> {
  const teamContext = teamConfig.teamContext;
  if (!teamContext) return;

  const repoDir = getTeamContextRepoDir(teamContext.repo);
  const previousManifest = await loadTeamContextManifest(teamContext.repo);

  const cacheResult = await ensureRepoCache(repoDir, teamContext.repo, previousManifest?.lastPull ?? null, {
    force: !!options.force,
    ttlMs: TEAM_CONTEXT_PULL_TTL_MS,
    label: 'team-context',
  });
  if (!cacheResult) {
    log.warn('[team-context] Could not access the DSH Team Context repo. Skipping this pull.');
    return;
  }

  let snapshot: TeamContextSnapshot;
  try {
    snapshot = await resolveTeamContextSnapshot(repoDir);
  } catch (e) {
    // Fail loud, but never proceed to materialize: previously-deployed
    // canonical content and the manifest are left untouched.
    log.error(`[team-context] ${(e as Error).message}`);
    return;
  }

  if (options.dryRun) {
    log.info(
      `[dry-run] [team-context] Would sync ${snapshot.skills.length} skill(s), `
      + `${snapshot.rules.length} rule(s), ${snapshot.governanceFiles.length} governance file(s)`,
    );
    return;
  }

  const result = await materializeTeamContext(snapshot, teamConfig, localConfig, previousManifest);

  await saveTeamContextManifest(teamContext.repo, {
    lastPull: new Date().toISOString(),
    schemaVersion: snapshot.schemaVersion,
    skills: result.deployedSkills,
    skillPaths: result.skillPaths,
    rules: result.deployedRules,
    governanceFiles: snapshot.governanceFiles.map((f) => f.name),
  });

  const parts: string[] = [];
  if (result.deployedSkills.length > 0) parts.push(`${result.deployedSkills.length} skill(s)`);
  if (result.deployedRules.length > 0) parts.push(`${result.deployedRules.length} rule(s)`);
  if (result.governanceInjected) parts.push('governance');
  if (parts.length > 0) {
    log.success(`[team-context] Synced ${parts.join(', ')}`);
  }
  if (result.skippedSkillsLocalOverride.length > 0) {
    log.info(`[team-context] ${result.skippedSkillsLocalOverride.length} canonical skill(s) shadowed by local override: ${result.skippedSkillsLocalOverride.join(', ')}`);
  }
}

/**
 * Names of skills/rules currently deployed from the team's Team Context, per
 * its own install manifest. Used by `scanLocalForPush` (skills.ts, rules.ts)
 * to exclude canonical content from push candidates — the same shape as
 * source.ts's `getAllSourceSkillNames`, but scoped to the team's single
 * configured `teamContext` instead of scanning every cached peer source.
 */
export async function getTeamContextItemNames(
  teamConfig: TeamaiConfig,
  type: 'skills' | 'rules',
): Promise<Set<string>> {
  const repoUrl = teamConfig.teamContext?.repo;
  if (!repoUrl) return new Set();

  const manifest = await loadTeamContextManifest(repoUrl);
  if (!manifest) return new Set();

  return new Set(type === 'skills' ? manifest.skills : manifest.rules);
}
