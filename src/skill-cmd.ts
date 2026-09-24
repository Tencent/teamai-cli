import path from 'node:path';
import { log } from './utils/logger.js';
import { listDirs, pathExists } from './utils/fs.js';
import { SkillsHandler } from './resources/skills.js';
import { loadTagsConfig } from './utils/tags.js';
import {
  buildClassifyContext,
  classifySkill,
  formatSkillSource,
  readSkillDescription,
  truncate,
  type SkillSource,
} from './agent-skills.js';
import { detectInstalledAgents, type ResolvedAgent } from './known-agents.js';
import { LEGACY_BUILTIN_SKILL_NAMES } from './builtin-skills.js';
import {
  BLOCK_NOTES,
  detectTeam,
  refuseBlocked,
  resolveServableSkill,
  skillCatalog,
  type BlockedSkill,
  type ServableSkillResolution,
} from './skill-content.js';
import type { GlobalOptions, LocalConfig } from './types.js';

const DESCRIPTION_MAX = 160;

interface ResolvedSkill {
  kind: 'found';
  name: string;
  /** Path used to read SKILL.md, contributors and description. */
  primaryPath: string;
  /** Where the primary copy was discovered. */
  primaryOrigin: 'team' | 'agent' | 'builtin';
  /** Optional namespace if found in the team repo. */
  namespace?: string;
}

type LocatedSkill = ResolvedSkill | BlockedSkill;

/**
 * `teamai skill show <name>` — print metadata about a single
 * skill: source classification, contributors, namespace, tags
 * and which installed agents currently host it.
 *
 * The full SKILL.md body is intentionally not rendered; users
 * who need the markdown can `cat` it directly using the path
 * we print under "Repo path" or "Installed in".
 */
export async function skillShow(name: string, options: GlobalOptions): Promise<void> {
  // One config load for both the gate and the lookup, so a broken config is
  // reported once.
  const team = await detectTeam();
  const served = await resolveServableSkill(name, undefined, team);
  if (team.kind !== 'team') {
    // Only the package can answer without a team: it ships with the CLI, so
    // `teamai skill show core` still works on a machine that has never run
    // `teamai init`. A config that cannot be loaded leaves the team unknown
    // too, so the repo and agents detection would fall back to (another
    // team's) are not searched, and the member is told what failed.
    if (served.kind === 'blocked') {
      refuseBlocked(served);
      return;
    }
    if (served.kind !== 'found') {
      log.error(`Skill "${name}" not found among the skills the installed CLI serves.`);
      log.dim(team.kind === 'none'
        ? 'Run `teamai init` first to search the team repo and installed agents too.'
        : `The team repo and installed agents were not searched: the teamai config could not be loaded. ${team.detail}`);
      process.exitCode = 1;
      return;
    }
    printSkillCard({
      name: served.skill.name,
      source: { kind: 'builtin' },
      description: truncate(await readSkillDescription(path.join(served.skill.dir, 'SKILL.md')), DESCRIPTION_MAX),
      contributors: [],
      tags: [],
      primaryPath: served.skill.dir,
      primaryOrigin: 'builtin',
      installedIn: [],
    });
    if (team.kind === 'none') {
      log.dim('No team is set up on this machine, so contributors, tags and installed agents are not shown.');
    } else {
      log.error(`The teamai config could not be loaded, so contributors, tags and installed agents are not shown. ${team.detail}`);
      process.exitCode = 1;
    }
    return;
  }
  const { localConfig, teamConfig } = team.init;

  const agents = await detectInstalledAgents(localConfig, teamConfig);
  const located = await locateSkill(name, localConfig, agents, served);
  if (!located) {
    log.error(`Skill "${name}" not found in team repo or any installed agent.`);
    log.dim('Try `teamai list --source all` to see available skills.');
    process.exitCode = 1;
    return;
  }
  // The resolver never hands out a blocked skill, so there is no directory to
  // print here even by accident; only the refusal is left to do.
  if (located.kind === 'blocked') {
    refuseBlocked(located);
    return;
  }
  const resolved: ResolvedSkill = located;

  const resolvedName = resolved.name;

  // A skill served from the package is built in by construction; BUILTIN_SKILL_NAMES
  // only knows the deployed stub, so classifying by name would call `core` local-only.
  const source: SkillSource = resolved.primaryOrigin === 'builtin'
    ? { kind: 'builtin' }
    : classifySkill(resolvedName, await buildClassifyContext(localConfig));

  const description = truncate(await readSkillDescription(path.join(resolved.primaryPath, 'SKILL.md')), DESCRIPTION_MAX);
  const contributors = await SkillsHandler.readContributors(resolved.primaryPath);

  const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);
  const tags = tagsConfig?.skills?.[resolvedName] ?? [];

  const installedIn = await collectInstalledAgents(resolvedName, agents);

  printSkillCard({
    name: resolvedName,
    source,
    namespace: resolved.namespace ?? (source.kind === 'team' ? source.namespace : undefined),
    description,
    contributors,
    tags,
    primaryPath: resolved.primaryPath,
    primaryOrigin: resolved.primaryOrigin,
    installedIn,
  });

  if (options.verbose) {
    console.log('');
    console.log(`  Verbose: SKILL.md path is ${path.join(resolved.primaryPath, 'SKILL.md')}`);
  }
}

/**
 * `teamai skill` / `teamai skill list` — the repo and installed-agent listing,
 * plus the catalog the installed CLI serves on demand.
 */
export async function skillList(options: GlobalOptions & { json?: boolean }): Promise<void> {
  // One config load for the catalog's gate and the team listing, so a broken
  // config is reported once.
  const team = await detectTeam();
  const catalog = await skillCatalog(undefined, team);

  if (options.json) {
    console.log(JSON.stringify({ skills: catalog }, null, 2));
    return;
  }

  // The packaged catalog needs no team: a machine that has not run `teamai init`
  // still gets to discover what the installed CLI serves, like `skill get` does.
  // A config that cannot be loaded lists no team either, rather than the one
  // detection would fall back to, and says what failed.
  if (team.kind === 'team') {
    const { list } = await import('./status.js');
    await list('skills', { ...options, source: 'all' });
  } else if (team.kind === 'none') {
    log.dim('Not initialized: run `teamai init` to list team and installed skills.');
    console.log('');
  } else {
    log.error(`Team and installed skills are not listed: the teamai config could not be loaded. ${team.detail}`);
    console.log('');
    process.exitCode = 1;
  }

  console.log('=== BUILT-IN SKILLS (served by the CLI) ===');
  console.log('');
  if (catalog.length === 0) {
    console.log('  (none — the installed package ships no skill content)');
  } else {
    for (const entry of catalog) {
      console.log(`  ${entry.name}${entry.blockedBy ? `  (${BLOCK_NOTES[entry.blockedBy]})` : ''}`);
      console.log(`    ${truncate(entry.description, DESCRIPTION_MAX) || '(no description)'}`);
      console.log(`    teamai skill get ${entry.name}`);
    }
  }
  console.log('');
}

async function locateSkill(
  name: string,
  localConfig: LocalConfig,
  agents: ResolvedAgent[],
  served: ServableSkillResolution,
): Promise<LocatedSkill | null> {
  const teamSkillsDir = path.join(localConfig.repo.localPath, 'skills');

  // 1. Flat layout in team repo
  const flat = path.join(teamSkillsDir, name);
  if (await pathExists(path.join(flat, 'SKILL.md'))) {
    return { kind: 'found', name, primaryPath: flat, primaryOrigin: 'team' };
  }

  // 2. Namespaced layout in team repo
  if (await pathExists(teamSkillsDir)) {
    const namespaces = await listDirs(teamSkillsDir);
    for (const ns of namespaces) {
      const candidate = path.join(teamSkillsDir, ns, name);
      if (await pathExists(path.join(candidate, 'SKILL.md'))) {
        return { kind: 'found', name, primaryPath: candidate, primaryOrigin: 'team', namespace: ns };
      }
    }
  }

  // 3. First installed agent that has the skill. Ahead of the packaged content
  //    on purpose: `codebase`, `default`, `learning` and `share` are ordinary
  //    names, and a directory a member created under one of them is the skill
  //    they are asking about, not the built-in it happens to alias. A legacy
  //    built-in name is the exception: that directory is a stale copy a
  //    pre-stub release wrote, so the name goes to the packaged skill and its
  //    gate, never to the leftover a pull has not pruned yet.
  for (const agent of LEGACY_BUILTIN_SKILL_NAMES.has(name) ? [] : agents) {
    if (!agent.installed) continue;
    const candidate = path.join(agent.absoluteSkillsPath, name);
    if (await pathExists(path.join(candidate, 'SKILL.md'))) {
      return { kind: 'found', name, primaryPath: candidate, primaryOrigin: 'agent' };
    }
  }

  // 4. Built-in skill served by the CLI, including legacy-name aliases. Last,
  //    so it answers for the names nothing on this machine claims: `core` and
  //    `wiki` live in the package, and the agent directory holds only the stub.
  if (served.kind === 'blocked') return served;
  if (served.kind === 'found') {
    return { kind: 'found', name: served.skill.name, primaryPath: served.skill.dir, primaryOrigin: 'builtin' };
  }

  return null;
}

async function collectInstalledAgents(
  name: string,
  agents: ResolvedAgent[],
): Promise<Array<{ agent: ResolvedAgent; path: string }>> {
  const matches: Array<{ agent: ResolvedAgent; path: string }> = [];
  for (const agent of agents) {
    if (!agent.installed) continue;
    const skillDir = path.join(agent.absoluteSkillsPath, name);
    if (await pathExists(path.join(skillDir, 'SKILL.md'))) {
      matches.push({ agent, path: skillDir });
    }
  }
  return matches;
}

const PRIMARY_PATH_LABEL: Record<ResolvedSkill['primaryOrigin'], string> = {
  team: 'Repo path  ',
  agent: 'Source path',
  builtin: 'Package dir',
};

interface SkillCard {
  name: string;
  source: SkillSource;
  namespace?: string;
  description: string;
  contributors: string[];
  tags: string[];
  primaryPath: string;
  primaryOrigin: ResolvedSkill['primaryOrigin'];
  installedIn: Array<{ agent: ResolvedAgent; path: string }>;
}

function printSkillCard(card: SkillCard): void {
  const bar = '='.repeat(60);
  console.log('');
  console.log(bar);
  console.log(`  skill: ${card.name}`);
  console.log(bar);
  console.log('');

  console.log(`  Source       : ${formatSkillSource(card.source)}`);
  if (card.namespace) {
    console.log(`  Namespace    : ${card.namespace}`);
  }
  console.log(`  Description  : ${card.description || '(none)'}`);
  console.log(`  Contributors : ${card.contributors.length > 0 ? card.contributors.join(', ') : '(none)'}`);
  console.log(`  Tags         : ${card.tags.length > 0 ? card.tags.join(', ') : '(none)'}`);
  console.log(`  ${PRIMARY_PATH_LABEL[card.primaryOrigin]}  : ${card.primaryPath}/`);
  if (card.primaryOrigin === 'builtin') {
    console.log(`  Read it with : teamai skill get ${card.name}`);
  }

  if (card.installedIn.length === 0) {
    // A served skill is never copied into an agent, so "yet" would be false.
    console.log(card.primaryOrigin === 'builtin'
      ? '  Installed in : (served by the CLI, not installed)'
      : '  Installed in : (not installed in any agent yet)');
  } else {
    const first = card.installedIn[0];
    console.log(`  Installed in : ${first.agent.id} (${first.path})`);
    for (let i = 1; i < card.installedIn.length; i++) {
      const entry = card.installedIn[i];
      console.log(`                 ${entry.agent.id} (${entry.path})`);
    }
  }
  console.log('');
}
