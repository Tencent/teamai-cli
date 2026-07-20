import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';
import { loadTeamConfig, autoDetectInit, loadLocalConfig, detectProjectConfig } from './config.js';
import { createGit, pullRepo } from './utils/git.js';
import { detectProvider, getProvider } from './providers/index.js';
import { log, spinner } from './utils/logger.js';
import {
  pathExists,
  readFileSafe,
  readJson,
  writeJson,
  listDirs,
  copyDir,
  remove,
  ensureDir,
} from './utils/fs.js';
import { getHandler } from './resources/index.js';
import { ResourceHandler } from './resources/base.js';
import { BUILTIN_SKILL_NAMES } from './builtin-skills.js';
import type {
  TeamaiConfig,
  LocalConfig,
  SourceConfig,
  SourceInstallManifest,
  GlobalOptions,
} from './types.js';
import { resolveBaseDir, SOURCE_PULL_TTL_MS } from './types.js';

// ─── Source repo management ──────────────────────────────

function getSourceDir(sourceName: string): string {
  return path.join(process.env.HOME ?? '', '.teamai', 'sources', sourceName);
}

function getSourceRepoDir(sourceName: string): string {
  return path.join(getSourceDir(sourceName), 'repo');
}

function getSourceManifestPath(sourceName: string): string {
  return path.join(getSourceDir(sourceName), 'installed.json');
}

async function loadSourceManifest(sourceName: string): Promise<SourceInstallManifest | null> {
  return readJson<SourceInstallManifest>(getSourceManifestPath(sourceName));
}

async function saveSourceManifest(sourceName: string, manifest: SourceInstallManifest): Promise<void> {
  await writeJson(getSourceManifestPath(sourceName), manifest);
}

/**
 * Check if a source repo needs pulling based on TTL.
 * Returns true if the last pull was more than SOURCE_PULL_TTL_MS ago.
 */
async function shouldPullSource(sourceName: string): Promise<boolean> {
  const manifest = await loadSourceManifest(sourceName);
  if (!manifest) return true;
  const elapsed = Date.now() - new Date(manifest.lastPull).getTime();
  return elapsed > SOURCE_PULL_TTL_MS;
}

/**
 * Clone or pull a source repo. Returns the repo path, or null on failure.
 */
async function ensureSourceRepo(source: SourceConfig, force: boolean): Promise<string | null> {
  const repoDir = getSourceRepoDir(source.name);

  if (await pathExists(repoDir)) {
    // Existing clone: pull if TTL expired or forced
    if (!force && !(await shouldPullSource(source.name))) {
      log.debug(`[source:${source.name}] Within pull TTL, skipping git pull`);
      return repoDir;
    }

    try {
      const result = await pullRepo(repoDir);
      log.debug(`[source:${source.name}] Git pull: ${result}`);
      return repoDir;
    } catch (e) {
      log.warn(`[source:${source.name}] Pull failed: ${(e as Error).message}`);
      // Return existing repo even if pull fails (use cached version)
      return repoDir;
    }
  }

  // First time: clone via provider so private repos get an auth token
  try {
    await ensureDir(path.dirname(repoDir));
    const cloneSpin = spinner(`[source:${source.name}] Cloning...`).start();

    const providerName = detectProvider(source.repo);
    const provider = getProvider(providerName);
    const repoInfo = provider.parseRepoInput(source.repo);
    provider.cloneRepo(`${repoInfo.owner}/${repoInfo.repo}`, repoDir);

    cloneSpin.succeed(`[source:${source.name}] Cloned`);
    return repoDir;
  } catch (e) {
    log.warn(`[source:${source.name}] Clone failed: ${(e as Error).message}`);
    return null;
  }
}

// ─── Commands ────────────────────────────────────────────

/**
 * Add a source to the team's teamai.yaml.
 * This modifies the team repo and requires a push (via MR or direct).
 */
export async function sourceAdd(repoUrl: string, options: { name?: string } & GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit();
  const repoPath = localConfig.repo.localPath;

  // Derive name from repo URL if not provided
  const name = options.name ?? deriveSourceName(repoUrl);
  if (!name) {
    log.error('Could not derive source name from URL. Use --name to specify one.');
    return;
  }

  // Check for duplicates
  const existing = teamConfig.sources ?? [];
  if (existing.some((s) => s.name === name)) {
    log.error(`Source "${name}" already exists. Use a different name or remove it first.`);
    return;
  }
  if (existing.some((s) => s.repo === repoUrl)) {
    log.error(`Source repo "${repoUrl}" already configured (as "${existing.find((s) => s.repo === repoUrl)!.name}").`);
    return;
  }

  // Verify the source repo is accessible by cloning it
  const cloneResult = await ensureSourceRepo({ name, repo: repoUrl }, true);
  if (!cloneResult) {
    log.error('Could not access the source repo. Check the URL and your git credentials.');
    return;
  }

  // Read source's teamai.yaml to verify it's a valid teamai repo
  const sourceConfig = await loadTeamConfig(cloneResult);
  if (!sourceConfig) {
    log.warn(`Source repo has no teamai.yaml. It can still be used, but no publicSkills are declared.`);
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would add source "${name}" (${repoUrl})`);
    return;
  }

  // Update teamai.yaml
  const yamlPath = path.join(repoPath, 'teamai.yaml');
  const content = await readFileSafe(yamlPath);
  if (!content) {
    log.error('Could not read teamai.yaml');
    return;
  }

  const raw = YAML.parse(content);
  if (!raw.sources) {
    raw.sources = [];
  }
  raw.sources.push({ name, repo: repoUrl });
  await fse.writeFile(yamlPath, YAML.stringify(raw));

  log.success(`Added source "${name}" (${repoUrl})`);
  log.info('Run `teamai push` to share this change with your team.');
}

/**
 * Remove a source from teamai.yaml and clean up local cache.
 */
export async function sourceRemove(name: string, options: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit();
  const repoPath = localConfig.repo.localPath;

  const existing = teamConfig.sources ?? [];
  if (!existing.some((s) => s.name === name)) {
    log.error(`Source "${name}" not found. Run \`teamai source list\` to see configured sources.`);
    return;
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would remove source "${name}"`);
    return;
  }

  // Update teamai.yaml
  const yamlPath = path.join(repoPath, 'teamai.yaml');
  const content = await readFileSafe(yamlPath);
  if (!content) {
    log.error('Could not read teamai.yaml');
    return;
  }

  const raw = YAML.parse(content);
  raw.sources = (raw.sources ?? []).filter((s: SourceConfig) => s.name !== name);
  await fse.writeFile(yamlPath, YAML.stringify(raw));

  // Clean up deployed source skills from tool paths
  await cleanupSourceSkills(name, teamConfig, localConfig);

  // Clean up local source cache
  const sourceDir = getSourceDir(name);
  if (await pathExists(sourceDir)) {
    await remove(sourceDir);
    log.debug(`Removed local cache for source "${name}"`);
  }

  log.success(`Removed source "${name}"`);
  log.info('Run `teamai push` to share this change with your team.');
}

/**
 * List all configured sources: team-level git cross-team sources (from
 * teamai.yaml) plus the personal HTTP bypass (report/sync/ack), if configured.
 */
export async function sourceList(): Promise<void> {
  // Git cross-team sources come from the team config. Tolerate a missing init:
  // the HTTP bypass is independent of the team repo, so still show it.
  let gitSources: SourceConfig[] = [];
  try {
    const { teamConfig } = await autoDetectInit();
    gitSources = teamConfig.sources ?? [];
  } catch {
    // Not initialized (no team repo) — only the HTTP bypass may exist.
  }

  const { describeLocalAgent } = await import('./local-agent.js');
  const httpSource = await describeLocalAgent();

  if (gitSources.length === 0 && !httpSource) {
    log.info('No sources configured. Use `teamai source add <url>` or `teamai source add-http <endpoint>`.');
    return;
  }

  if (gitSources.length > 0) {
    log.info(`Git cross-team sources (${gitSources.length}):`);
    for (const source of gitSources) {
      const repoDir = getSourceRepoDir(source.name);
      const cloned = await pathExists(repoDir);
      const status = cloned ? '(synced)' : '(not yet synced)';
      log.info(`  ${source.name} ${status}`);
      log.dim(`    ${source.repo}`);
    }
  }

  if (httpSource) {
    const { skills, rules, claudemd } = httpSource.resourceCounts;
    log.info('HTTP source (report/sync/ack):');
    log.info(`  ${httpSource.endpoint}`);
    log.dim(`    ${skills} skill(s), ${rules} rule(s), ${claudemd} claude.md`);
    for (const p of httpSource.boundProjects) {
      log.dim(`    bound: ${p.projectName ?? p.projectId} — ${p.path}`);
    }
  }
}

/**
 * Add a personal HTTP source (report/sync/ack side channel) alongside the git
 * main repo. Reuses the local-agent bypass so a git-based user gets the same
 * report/sync/ack lifecycle an `init --http` user has, without touching the git
 * main repo.
 *
 * Rejected when the main repo itself is HTTP: that setup already owns the single
 * local-agent config, and a second endpoint would silently overwrite it.
 */
export async function sourceAddHttp(
  endpoint: string,
  options: { token?: string; force?: boolean } & GlobalOptions,
): Promise<void> {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    log.error('Endpoint is required. Usage: teamai source add-http <endpoint> --token <key>');
    return;
  }

  // Guard: if the main repo is already an HTTP backend, it owns the single
  // local-agent config — refuse rather than overwrite its endpoint.
  const mainConfig = (await detectProjectConfig()) ?? (await loadLocalConfig());
  if (mainConfig?.repo.kind === 'http') {
    log.error('Your main team repo is already an HTTP backend, which owns the HTTP source config.');
    log.info('An HTTP bypass is only for git-based main repos. Nothing changed.');
    return;
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would add HTTP source ${trimmed}`);
    return;
  }

  const { initLocalAgentHttp } = await import('./local-agent.js');
  // force: true so re-running add-http updates the bypass's own endpoint/token.
  await initLocalAgentHttp({ endpoint: trimmed, token: options.token, force: true });
  log.success(`HTTP source added (${trimmed}).`);
  log.info('It will report/sync on the next AI session (via the hook-dispatch hook already installed).');
}

/**
 * Remove the personal HTTP source: uninstall its resources and clear its config.
 */
export async function sourceRemoveHttp(options: GlobalOptions): Promise<void> {
  if (options.dryRun) {
    log.info('[dry-run] Would remove the HTTP source');
    return;
  }
  const { removeLocalAgentHttp } = await import('./local-agent.js');
  await removeLocalAgentHttp();
}

/**
 * Browse public skills from a source.
 */
export async function sourceBrowse(name: string, options: GlobalOptions): Promise<void> {
  const { teamConfig } = await autoDetectInit();
  const sources = teamConfig.sources ?? [];
  const source = sources.find((s) => s.name === name);

  if (!source) {
    log.error(`Source "${name}" not found. Run \`teamai source list\` to see configured sources.`);
    return;
  }

  // Ensure source repo is cloned
  const repoDir = await ensureSourceRepo(source, !!options.force);
  if (!repoDir) {
    log.error(`Could not access source "${name}".`);
    return;
  }

  const sourceTeamConfig = await loadTeamConfig(repoDir);
  if (!sourceTeamConfig) {
    log.warn(`Source "${name}" has no teamai.yaml.`);
    return;
  }

  const publicSkills = sourceTeamConfig.publicSkills;
  if (!publicSkills || publicSkills.length === 0) {
    log.info(`Source "${name}" has not declared any public skills.`);
    log.dim('  The source team needs to add `publicSkills: [...]` to their teamai.yaml.');
    return;
  }

  // Verify which declared public skills actually exist
  const skillsDir = path.join(repoDir, 'skills');
  const available: Array<{ name: string; description: string }> = [];

  for (const skillName of publicSkills) {
    const exists = await findSkillInRepo(skillsDir, skillName);
    if (exists) {
      const desc = await extractSkillDescription(exists);
      available.push({ name: skillName, description: desc });
    }
  }

  if (available.length === 0) {
    log.info(`Source "${name}" declares ${publicSkills.length} public skill(s), but none were found in the repo.`);
    return;
  }

  log.info(`Public skills from "${name}" (${available.length}):`);
  for (const skill of available) {
    const desc = skill.description ? ` — ${skill.description}` : '';
    log.info(`  ${skill.name}${desc}`);
  }
}

// ─── Pull sources ────────────────────────────────────────

/**
 * Pull skills from all configured sources.
 * Called from pull() at the top level (not inside pullForScope).
 */
export async function pullSources(localConfig: LocalConfig, options: GlobalOptions): Promise<void> {
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!teamConfig) return;

  const sources = teamConfig.sources ?? [];
  if (sources.length === 0) return;

  const baseDir = resolveBaseDir(localConfig);

  for (const source of sources) {
    try {
      await pullSingleSource(source, teamConfig, localConfig, baseDir, options);
    } catch (e) {
      log.warn(`[source:${source.name}] Pull failed: ${(e as Error).message}`);
    }
  }
}

async function pullSingleSource(
  source: SourceConfig,
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  baseDir: string,
  options: GlobalOptions,
): Promise<void> {
  // Ensure source repo is cloned/updated
  const repoDir = await ensureSourceRepo(source, !!options.force);
  if (!repoDir) return;

  // Load source's teamai.yaml
  const sourceTeamConfig = await loadTeamConfig(repoDir);
  if (!sourceTeamConfig) {
    log.debug(`[source:${source.name}] No teamai.yaml, skipping`);
    return;
  }

  // Check publicSkills declaration (opt-in: no field = no sharing)
  const publicSkills = sourceTeamConfig.publicSkills;
  if (!publicSkills || publicSkills.length === 0) {
    log.debug(`[source:${source.name}] No publicSkills declared, skipping`);
    return;
  }

  // Find actual skill directories in the source repo
  const skillsDir = path.join(repoDir, 'skills');
  const skillsToDeploy: Array<{ name: string; sourcePath: string }> = [];

  for (const skillName of publicSkills) {
    const skillPath = await findSkillInRepo(skillsDir, skillName);
    if (skillPath) {
      skillsToDeploy.push({ name: skillName, sourcePath: skillPath });
    }
  }

  if (skillsToDeploy.length === 0) return;

  // Load current manifest to determine what to add/remove
  const oldManifest = await loadSourceManifest(source.name);
  const oldInstalled = new Set(oldManifest?.installedSkills ?? []);

  // Collect skills that belong to the local team (they take priority)
  const localTeamSkills = await getLocalTeamSkillNames(teamConfig, localConfig);

  // Deploy skills to tool paths
  const deployed: string[] = [];
  let newCount = 0;
  let updatedCount = 0;

  for (const skill of skillsToDeploy) {
    // Local team skills take priority: skip source skill if name conflicts
    if (localTeamSkills.has(skill.name)) {
      log.debug(`[source:${source.name}] Skipping "${skill.name}" (local team has same name)`);
      continue;
    }

    if (options.dryRun) {
      const label = oldInstalled.has(skill.name) ? 'update' : 'new';
      log.info(`[dry-run] [source:${source.name}] Would pull ${skill.name} (${label})`);
      deployed.push(skill.name);
      continue;
    }

    // Deploy to each tool's skills directory
    for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.skills) continue;
      if (!await ResourceHandler.isToolInstalled(toolPath.skills, baseDir)) continue;

      const targetDir = path.join(baseDir, toolPath.skills, skill.name);
      await copyDir(skill.sourcePath, targetDir);
    }

    if (oldInstalled.has(skill.name)) {
      updatedCount++;
    } else {
      newCount++;
    }
    deployed.push(skill.name);
  }

  // Clean up skills that were previously installed but are no longer in publicSkills
  if (!options.dryRun) {
    const deployedSet = new Set(deployed);
    for (const oldSkill of oldInstalled) {
      if (!deployedSet.has(oldSkill) && !localTeamSkills.has(oldSkill)) {
        await removeSkillFromToolPaths(oldSkill, teamConfig, baseDir);
        log.debug(`[source:${source.name}] Removed "${oldSkill}" (no longer public)`);
      }
    }
  }

  // Save manifest
  if (!options.dryRun) {
    await saveSourceManifest(source.name, {
      lastPull: new Date().toISOString(),
      installedSkills: deployed,
    });
  }

  if (deployed.length > 0) {
    if (newCount > 0) {
      log.success(`[source:${source.name}] Synced ${deployed.length} skills (${newCount} new, ${updatedCount} updated)`);
    } else {
      log.success(`[source:${source.name}] Synced ${deployed.length} skills (all updated)`);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * Derive a source name from a git remote URL.
 * Works for any host (github.com, git.woa.com, gitlab.com, etc.):
 *   - "git@github.com:teamai/skills.git"      → "teamai"
 *   - "https://github.com/teamai/skills.git"  → "teamai"
 *   - "git@git.woa.com:platform/skills.git"   → "platform"
 */
function deriveSourceName(repoUrl: string): string | null {
  // SSH format: git@host:owner/repo.git (or git@host:group/sub/repo.git)
  const sshMatch = repoUrl.match(/:([^/]+)\//);
  if (sshMatch) return sshMatch[1];

  // HTTPS format: https://host/owner/repo(.git)?
  const httpsMatch = repoUrl.match(/\/\/[^/]+\/([^/]+)\/[^/]+?(?:\.git)?\/?$/);
  if (httpsMatch) return httpsMatch[1];

  // Fallback: penultimate segment of the URL, stripping .git
  const parts = repoUrl.replace(/\.git$/, '').split('/');
  if (parts.length >= 2) return parts[parts.length - 2];

  return null;
}

/**
 * Find a skill directory in a repo, handling both flat and namespaced layouts.
 * Returns the full path to the skill directory, or null if not found.
 */
async function findSkillInRepo(skillsDir: string, skillName: string): Promise<string | null> {
  if (!await pathExists(skillsDir)) return null;

  // Check flat layout first: skills/<name>/SKILL.md
  const flatPath = path.join(skillsDir, skillName);
  if (await pathExists(path.join(flatPath, 'SKILL.md'))) {
    return flatPath;
  }

  // Check namespaced layout: skills/<namespace>/<name>/SKILL.md
  const topDirs = await listDirs(skillsDir);
  for (const ns of topDirs) {
    const nsPath = path.join(skillsDir, ns, skillName);
    if (await pathExists(path.join(nsPath, 'SKILL.md'))) {
      return nsPath;
    }
  }

  return null;
}

/**
 * Extract description from a SKILL.md frontmatter.
 */
async function extractSkillDescription(skillDir: string): Promise<string> {
  const content = await readFileSafe(path.join(skillDir, 'SKILL.md'));
  if (!content) return '';

  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return '';

  const frontmatter = match[1];

  // Single-line description
  const singleMatch = frontmatter.match(/description:\s*["']?(.+?)["']?\s*$/m);
  if (singleMatch) return singleMatch[1].trim();

  // Multi-line description
  const multiMatch = frontmatter.match(/description:\s*>-?\s*\n([\s\S]*?)(?=\n\w|\n---)/);
  if (multiMatch) {
    return multiMatch[1].split('\n').map((l) => l.trim()).filter((l) => l).join(' ');
  }

  return '';
}

/**
 * Get the set of skill names that belong to the local team.
 */
async function getLocalTeamSkillNames(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<Set<string>> {
  const handler = getHandler('skills');
  const items = await handler.scanTeamForPull(teamConfig, localConfig);
  const names = new Set(items.map((i) => i.name));
  // Also include builtin skills
  for (const name of BUILTIN_SKILL_NAMES) {
    names.add(name);
  }
  return names;
}

/**
 * Remove a skill from all tool paths.
 */
async function removeSkillFromToolPaths(skillName: string, teamConfig: TeamaiConfig, baseDir: string): Promise<void> {
  for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
    if (!toolPath.skills) continue;
    const skillDir = path.join(baseDir, toolPath.skills, skillName);
    if (await pathExists(skillDir)) {
      await remove(skillDir);
    }
  }
}

/**
 * Clean up all deployed skills from a specific source.
 */
async function cleanupSourceSkills(sourceName: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
  const manifest = await loadSourceManifest(sourceName);
  if (!manifest) return;

  const baseDir = resolveBaseDir(localConfig);
  for (const skillName of manifest.installedSkills) {
    await removeSkillFromToolPaths(skillName, teamConfig, baseDir);
  }
}

/**
 * Get all installed source skill names (across all sources).
 * Used by scanLocalForPush to exclude source skills from push candidates.
 */
export async function getAllSourceSkillNames(): Promise<Set<string>> {
  const names = new Set<string>();
  const sourcesDir = path.join(process.env.HOME ?? '', '.teamai', 'sources');
  if (!await pathExists(sourcesDir)) return names;

  const sourceDirs = await listDirs(sourcesDir);
  for (const dir of sourceDirs) {
    const manifest = await loadSourceManifest(dir);
    if (manifest) {
      for (const skill of manifest.installedSkills) {
        names.add(skill);
      }
    }
  }

  return names;
}
