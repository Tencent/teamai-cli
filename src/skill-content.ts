import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { listFilesRecursive, pathExists } from './utils/fs.js';
import { readSkillDescription } from './agent-skills.js';
import { log, setStderrOnly } from './utils/logger.js';
import type { TeamaiInit } from './config.js';

// ─── CLI-served skill content ────────────────────────────
//
//  Built-in skill bodies ship inside the npm package and are
//  printed on demand instead of being copied into every agent
//  skills directory.  What the agent reads therefore always
//  matches the installed CLI version.
//
//  npm package
//    skills/<name>/SKILL.md       deployed to agents (discovery stub)
//    skill-data/<name>/SKILL.md   never deployed, printed by `teamai skill get`
//
//  Output discipline, mirrored from agent-browser: skill content
//  goes to stdout untouched, every diagnostic goes to stderr, so a
//  piped `teamai skill get <name> > SKILL.md` stays byte-exact.
//  log.warn()/log.info() write to stdout outside hook mode, so this
//  module writes its diagnostics with console.error directly.
//

/** Placeholder replaced with the absolute skill directory when content is printed. */
export const SKILL_DIR_PLACEHOLDER = '{SKILL_DIR}';

/** Directories inside a skill whose files `--full` appends, in this order. */
const SUPPLEMENTARY_DIRS = ['references', 'templates'] as const;

const SKILL_MD = 'SKILL.md';

/**
 * Alternative names accepted by `skill get` / `skill path`.
 *
 * Legacy directory names are kept as aliases so that documentation,
 * muscle memory and older team guides keep resolving after the content
 * moves under skill-data/.
 */
const SKILL_ALIASES: Readonly<Record<string, string>> = {
  default: 'core',
  onboarding: 'setup',
  join: 'setup',
  codebase: 'wiki',
  'team-wiki-codebase': 'wiki',
  learning: 'share',
  learnings: 'share',
  'teamai-share-learnings': 'share',
};

/**
 * Served skills that write to the team repo and need recall to be on.
 *
 * `share` publishes a session's learnings into the team's learnings branch,
 * which is meaningful only when recall is enabled, and impossible against a
 * read-only HTTP source. Before the discovery stub both gates were in
 * deployment (`skipRecall`, `reportingOnly`) — the skill was simply absent. One
 * stub routes to every workflow, so the gates moved here, where the command can
 * also say why.
 */
const RECALL_DEPENDENT_SKILLS = new Set(['share']);

/**
 * Why a served skill is withheld right now. A config that cannot be loaded
 * carries what failed: nothing else reports it, because detection skips a
 * broken project file and `teamai doctor` reads the one it falls back to.
 */
export type SkillBlock =
  | { reason: 'recall' }
  | { reason: 'read-only' }
  | { reason: 'config'; detail: string };

export type SkillBlockReason = SkillBlock['reason'];

/**
 * The share gate's answer. A blocked answer carries no config: nothing past the
 * gate may act on it. An open one carries the config it was decided on, or
 * null when there is none on the machine.
 */
export type ShareGate =
  | { block: SkillBlock; config: null }
  | { block: null; config: TeamaiInit | null };

/**
 * Which team this directory belongs to, or why that is unknown. `share`, and
 * the `skill show` / `skill list` lookups, ask this so none of them answers for
 * the wrong team: detection skips a broken project config and falls back to
 * the user config, another team's repo, recall and source. A config that
 * cannot be loaded carries what failed, since nothing else reports it. Only
 * loading the config is read as "cannot be loaded".
 */
export type TeamDetection =
  | { kind: 'team'; init: TeamaiInit }
  | { kind: 'none' }
  | { kind: 'unusable'; detail: string };

export async function detectTeam(cwd?: string): Promise<TeamDetection> {
  const { autoDetectInit, findUnreadableProjectConfig, requireInit, NotInitializedError, BROKEN_CONFIG_ADVICE } =
    await import('./config.js');
  // Loading the config can migrate it and say so with `log.info`. That line
  // must not land in the skill content, the JSON these commands print on
  // stdout, or a hook's reply, so config loading reports on stderr here.
  const previous = setStderrOnly(true);
  try {
    if (cwd !== undefined) {
      try {
        await fs.promises.stat(cwd);
      } catch (e) {
        // A directory that no longer exists (a hook payload naming a deleted
        // worktree) holds no project config, and git refuses to open it. Any
        // other failure (no permission, a path through a file) leaves the
        // project unknown, not absent.
        if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT') {
          return { kind: 'team', init: await requireInit() };
        }
        return { kind: 'unusable', detail: `${cwd} cannot be checked: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const unreadable = await findUnreadableProjectConfig(cwd);
    if (unreadable) {
      // A parse error spans several lines (a code frame); its first names the
      // file, the line and the column, which is what the member acts on.
      return { kind: 'unusable', detail: `${firstLine(unreadable)}. ${BROKEN_CONFIG_ADVICE}` };
    }
    return { kind: 'team', init: await autoDetectInit(cwd) };
  } catch (e) {
    if (e instanceof NotInitializedError) return { kind: 'none' };
    return { kind: 'unusable', detail: firstLine(e instanceof Error ? e.message : String(e)) };
  } finally {
    setStderrOnly(previous);
  }
}

/**
 * Whether `share` can be served here. The Stop-hook reminder asks this too, so
 * the nudge and `teamai skill get share` cannot disagree, and it reads its own
 * on/off switch from the config returned instead of loading it a second time.
 *
 * Fails open only where there is no config at all: a fresh install reading
 * the docs gets the content rather than a refusal it cannot act on. A config
 * that exists but cannot be loaded blocks: whether recall is on, or the source
 * writable, is then unknown, and the workflow would fail at `teamai contribute`.
 * Any failure past loading the config is a fault here and propagates.
 */
export async function shareGate(cwd?: string): Promise<ShareGate> {
  return gateFor(await detectTeam(cwd));
}

/** The share gate on a team already detected, for a command that needs the team too. */
async function gateFor(team: TeamDetection): Promise<ShareGate> {
  const { isRecallEnabled } = await import('./types.js');
  if (team.kind === 'none') return { block: null, config: null };
  if (team.kind === 'unusable') return { block: { reason: 'config', detail: team.detail }, config: null };
  const { localConfig, teamConfig } = team.init;
  // `teamai contribute` refuses a read-only source (read-only.ts), so the
  // workflow would fail at its last step after the agent did all the work.
  if (localConfig.repo?.kind === 'http') return { block: { reason: 'read-only' }, config: null };
  if (!isRecallEnabled(localConfig, teamConfig)) return { block: { reason: 'recall' }, config: null };
  return { block: null, config: team.init };
}

/** The first line of an error, without the colon that introduces its code frame. */
export function firstLine(text: string): string {
  return text.trim().split('\n')[0].trim().replace(/:$/, '');
}

/**
 * Whether the Stop-hook share reminder may be shown. Resolved per hook run so
 * a team can switch it off in teamai.yaml (or a member in local config) without
 * re-injecting hooks; on by default. Never with no config at all: a project
 * that never set up teamai has no team to share with, although
 * `teamai skill get share` still serves there.
 *
 * The reminder routes to `share`, so it is withheld wherever `shareGate`
 * blocks it: a nudge there would send the agent to a command that says no.
 * Both the hook dispatcher and the legacy `teamai contribute-check` ask this,
 * passing the session's cwd: the process may run anywhere, and a `chdir` into
 * the cwd can fail.
 */
export async function contributeHintAllowed(cwd?: string): Promise<boolean> {
  const { isContributeHintEnabled } = await import('./types.js');
  let gate: ShareGate;
  try {
    gate = await shareGate(cwd);
  } catch (e) {
    // A fault in the gate itself, not a config it could not load (the gate
    // answers that): a Stop hook must not fail the turn over a reminder.
    log.debug(`share gate failed, reminder withheld: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  if (gate.block) return false;
  return gate.config
    ? isContributeHintEnabled(gate.config.localConfig, gate.config.teamConfig)
    : false;
}

/** What makes this skill unusable right now, or null. */
async function blockReason(name: string, team?: TeamDetection): Promise<SkillBlock | null> {
  if (!RECALL_DEPENDENT_SKILLS.has(name)) return null;
  return (team ? await gateFor(team) : await shareGate()).block;
}

/** A skill directory that ships inside the npm package. */
export interface PackagedSkill {
  name: string;
  /** Absolute path of the skill directory. */
  dir: string;
  /** True when this copy is the unit deployed into agent skills directories. */
  deployed: boolean;
}

/** The two packaged roots: deployable units and CLI-served content. */
export interface PackagedSkillRoots {
  /** `skills/` — what `deployBuiltinSkills` copies into agents. */
  deployRoot: string;
  /** `skill-data/` — never deployed, printed on demand. */
  dataRoot: string;
}

/**
 * Locate the packaged roots relative to this module.
 *
 * `realpathSync` first: a global `npm i -g` install exposes the CLI through a
 * symlinked bin, and without resolving it `..` can land outside the package.
 */
export function packagedSkillRoots(): PackagedSkillRoots {
  const modulePath = fileURLToPath(import.meta.url);
  let moduleDir: string;
  try {
    moduleDir = path.dirname(fs.realpathSync(modulePath));
  } catch {
    moduleDir = path.dirname(modulePath);
  }
  const packageRoot = path.join(moduleDir, '..');
  return {
    deployRoot: path.join(packageRoot, 'skills'),
    dataRoot: path.join(packageRoot, 'skill-data'),
  };
}

async function readSkillDirs(root: string, deployed: boolean): Promise<PackagedSkill[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(root);
  } catch {
    return [];
  }

  const skills: PackagedSkill[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue;
    const dir = path.join(root, entry);
    if (await pathExists(path.join(dir, SKILL_MD))) {
      skills.push({ name: entry, dir, deployed });
    }
  }
  return skills;
}

/** Skills the CLI serves on demand: everything under skill-data/. */
export async function listServableSkills(roots: PackagedSkillRoots = packagedSkillRoots()): Promise<PackagedSkill[]> {
  return readSkillDirs(roots.dataRoot, false);
}

/**
 * Resolve a name or alias to a packaged skill. Servable content wins over the
 * deployed stub, which stays reachable by its exact name for debugging.
 */
async function resolvePackagedSkill(
  name: string,
  roots: PackagedSkillRoots = packagedSkillRoots(),
): Promise<PackagedSkill | null> {
  const servable = await listServableSkills(roots);
  const deployed = await readSkillDirs(roots.deployRoot, true);
  const candidates = [...servable, ...deployed.filter((s) => !servable.some((v) => v.name === s.name))];

  const direct = candidates.find((s) => s.name === name);
  if (direct) return direct;

  const aliased = SKILL_ALIASES[name];
  if (aliased) {
    const match = candidates.find((s) => s.name === aliased);
    if (match) return match;
  }
  return null;
}

/**
 * The outcome of asking for a skill by name. `blocked` carries the same
 * information as `found`, minus the skill: a caller cannot print a directory it
 * never received.
 */
export type ServableSkillResolution =
  | { kind: 'found'; skill: PackagedSkill }
  | BlockedSkill
  | { kind: 'not-found'; name: string };

/** A packaged skill the gate withholds: its canonical name and why. */
export type BlockedSkill = { kind: 'blocked'; name: string } & SkillBlock;

/**
 * The only way to obtain a packaged skill outside this module.
 *
 * The recall and read-only gates are applied here, once, so every command that hands out a
 * skill's content or its directory (`get`, `path`, `list`, `show`) inherits it
 * by construction instead of remembering to check.
 */
export async function resolveServableSkill(
  name: string,
  roots: PackagedSkillRoots = packagedSkillRoots(),
  team?: TeamDetection,
): Promise<ServableSkillResolution> {
  const skill = await resolvePackagedSkill(name, roots);
  if (!skill) return { kind: 'not-found', name };
  const block = await blockReason(skill.name, team);
  if (block) return { kind: 'blocked', name: skill.name, ...block };
  return { kind: 'found', skill };
}

/** The short note `skill list` prints beside a blocked skill, per reason. */
export const BLOCK_NOTES: Record<SkillBlockReason, string> = {
  recall: 'needs recall — teamai recall enable',
  'read-only': 'not available on a read-only HTTP source',
  config: 'not available: the teamai config could not be loaded',
};

/** The two lines every command prints for a blocked skill. */
export function blockMessage(name: string, block: SkillBlock): { headline: string; hint: string } {
  switch (block.reason) {
    case 'recall':
      return {
        headline: `${name} needs recall, which is disabled for this team.`,
        hint: 'Turn it on with `teamai recall enable`, or ask your team admin to enable sharing.',
      };
    case 'read-only':
      return {
        headline: `${name} is not available: this team uses a read-only HTTP source, so nothing can be contributed from here.`,
        hint: 'Ask a team admin to add the learning to the team repo.',
      };
    case 'config':
      return {
        headline: `${name} is not available: the teamai config on this machine could not be loaded, so whether it can contribute is unknown.`,
        hint: block.detail,
      };
    default: {
      const exhaustive: never = block;
      throw new Error(`Unhandled block reason ${String(exhaustive)}`);
    }
  }
}

async function collectSupplementaryFiles(skillDir: string): Promise<Array<{ relativePath: string; content: string }>> {
  const files: Array<{ relativePath: string; content: string }> = [];

  for (const dirName of SUPPLEMENTARY_DIRS) {
    // listFilesRecursive walks nested directories and skips .pyc, __pycache__ and
    // the rest of the repo's ignore list, which matters for the wiki's scripts/.
    // Our references nest (references/methodology/, references/phases/), so a
    // single-level scan would serve an incomplete skill.
    const relativePaths = (await listFilesRecursive(path.join(skillDir, dirName)))
      .map((relative) => `${dirName}/${relative}`)
      .sort();

    for (const relativePath of relativePaths) {
      files.push({
        relativePath,
        content: await fs.promises.readFile(path.join(skillDir, relativePath), 'utf8'),
      });
    }
  }

  return files;
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Render a packaged skill exactly as the agent should read it: the raw
 * SKILL.md including frontmatter, with {SKILL_DIR} resolved to the absolute
 * packaged directory so that documented script invocations can be run as-is.
 */
export async function renderSkill(skill: PackagedSkill, options: { full?: boolean } = {}): Promise<string> {
  const resolve = (text: string): string => text.split(SKILL_DIR_PLACEHOLDER).join(skill.dir);

  let out = withTrailingNewline(resolve(await fs.promises.readFile(path.join(skill.dir, SKILL_MD), 'utf8')));

  if (options.full) {
    for (const file of await collectSupplementaryFiles(skill.dir)) {
      out += `\n--- ${file.relativePath} ---\n\n`;
      out += withTrailingNewline(resolve(file.content));
    }
  }

  return out;
}

/** Diagnostics never share stdout with skill content. */
function diagnostic(line: string): void {
  console.error(line);
}

function notFound(name: string, available: PackagedSkill[]): void {
  diagnostic(`${chalk.red('✖')} Skill not found: ${name}`);
  diagnostic(`  Available: ${available.map((s) => s.name).join(', ')}`);
  diagnostic('  Run `teamai skill list` to see what the installed CLI serves.');
  process.exitCode = 1;
}

function rootsMissing(): void {
  diagnostic(`${chalk.red('✖')} Packaged skill content not found.`);
  diagnostic('  The installed teamai-cli package looks incomplete; reinstall with `npm i -g teamai-cli`.');
  process.exitCode = 1;
}

/**
 * Refuse a blocked skill. Every command that hands out a skill's content or its
 * directory goes through here, so an agent is routed away from a workflow that
 * cannot finish whichever way it asks. A routing aid, not access control: the
 * files ship in the npm package either way.
 */
export function refuseBlocked(blocked: BlockedSkill): void {
  const { headline, hint } = blockMessage(blocked.name, blocked);
  diagnostic(`${chalk.red('✖')} ${headline}`);
  diagnostic(`  ${hint}`);
  process.exitCode = 1;
}

export interface SkillGetOptions {
  full?: boolean;
  all?: boolean;
}

/**
 * `teamai skill get <name...> [--full] [--all]` — print version-matched skill
 * content to stdout.
 */
export async function skillGet(names: string[], options: SkillGetOptions = {}): Promise<void> {
  const roots = packagedSkillRoots();
  const servable = await listServableSkills(roots);

  if (servable.length === 0) {
    rootsMissing();
    return;
  }

  // An unknown flag is forgiven — a hallucinated flag should not cost the agent a
  // round-trip — but an unknown name is fatal: the agent would act on the wrong
  // instructions. Commander hands unknown options through as operands here.
  const requested: string[] = [];
  for (const name of names) {
    if (name.startsWith('-')) {
      diagnostic(`${chalk.yellow('⚠')} Unknown flag ignored: ${name}`);
      continue;
    }
    requested.push(name);
  }

  const targets: PackagedSkill[] = [];
  if (options.all) {
    // The gate holds for the inventory dump too: a blocked skill is left out
    // and named on stderr, the rest is still served.
    for (const listed of servable) {
      const resolved = await resolveServableSkill(listed.name, roots);
      // The listing and the resolver read one catalog, so a listed name is
      // either found or blocked.
      if (resolved.kind !== 'found') {
        if (resolved.kind === 'blocked') {
          const { headline, hint } = blockMessage(listed.name, resolved);
          diagnostic(`${chalk.yellow('⚠')} Skipped ${listed.name}. ${headline} ${hint}`);
        }
        continue;
      }
      targets.push(resolved.skill);
    }
  } else {
    for (const name of requested) {
      const resolved = await resolveServableSkill(name, roots);
      if (resolved.kind === 'not-found') {
        notFound(name, servable);
        return;
      }
      if (resolved.kind === 'blocked') {
        refuseBlocked(resolved);
        return;
      }
      targets.push(resolved.skill);
    }
  }

  if (targets.length === 0) {
    diagnostic(`${chalk.red('✖')} No skill name provided. Usage: teamai skill get <name> [--full], or --all`);
    diagnostic(`  Available: ${servable.map((s) => s.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const rendered: string[] = [];
  for (const skill of targets) {
    rendered.push(await renderSkill(skill, { full: options.full }));
  }
  process.stdout.write(rendered.join('\n---\n\n'));
}

/**
 * `teamai skill path <name>` — print the packaged directory, for agents that
 * read files directly or need to run the scripts a skill ships.
 *
 * A name is required, and a blocked skill gets the same refusal as `skill get`,
 * so an agent asking for the directory is routed the same way.
 */
export async function skillPath(name: string): Promise<void> {
  const roots = packagedSkillRoots();

  const resolved = await resolveServableSkill(name, roots);
  switch (resolved.kind) {
    case 'not-found':
      notFound(name, await listServableSkills(roots));
      return;
    case 'blocked':
      refuseBlocked(resolved);
      return;
    case 'found':
      console.log(resolved.skill.dir);
      return;
    default: {
      const exhaustive: never = resolved;
      throw new Error(`Unhandled resolution ${String(exhaustive)}`);
    }
  }
}

/**
 * One catalog entry, as `teamai skill list --json` reports it.
 *
 * A skill the recall gate blocks is still listed, so the agent learns it exists
 * and what to turn on, but its directory is withheld like `skill path` does.
 */
interface SkillCatalogEntryFields {
  name: string;
  description: string;
  deployed: boolean;
}

/**
 * `blockedBy` carries the directory with it: a blocked entry has no path to
 * report, and a served one always has. Both variants keep the `path` key so the
 * JSON shape does not change with the gate.
 */
export type SkillCatalogEntry =
  | (SkillCatalogEntryFields & { blockedBy: null; path: string })
  | (SkillCatalogEntryFields & { blockedBy: SkillBlockReason; path: null });

export async function skillCatalog(
  roots: PackagedSkillRoots = packagedSkillRoots(),
  team?: TeamDetection,
): Promise<SkillCatalogEntry[]> {
  const skills = await listServableSkills(roots);
  const entries: SkillCatalogEntry[] = [];
  for (const skill of skills) {
    const resolved = await resolveServableSkill(skill.name, roots, team);
    const fields: SkillCatalogEntryFields = {
      name: skill.name,
      description: await readSkillDescription(path.join(skill.dir, SKILL_MD)),
      deployed: skill.deployed,
    };
    entries.push(resolved.kind === 'blocked'
      ? { ...fields, blockedBy: resolved.reason, path: null }
      : { ...fields, blockedBy: null, path: skill.dir });
  }
  return entries;
}
