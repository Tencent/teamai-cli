import path from 'node:path';
import { COPILOT_TOOL_ID, getCopilotHome, resolveToolBaseDir, toolGateRoot, toolInstallRoot } from '../types.js';
import type { ResourceType, ResourceItem, ResourceDiff, DeliveryTarget, TeamaiConfig, LocalConfig, PendingPush, State } from '../types.js';

/** The placement records `publishedNameFor` resolves a bare name through. */
export type PlacementRecords = Pick<State, 'placedRules' | 'placedAgents'>;
import { readFileSafe, writeFile, ensureDir, pathExists } from '../utils/fs.js';
import { getUserHome } from '../utils/home.js';
import { isOnPath } from '../utils/lookpath.js';
import type { DeliveryLedger } from './delivered-copies.js';

const TOMBSTONE_FILE = '.removed';

/**
 * The root that says a tool is installed, for a tool with a path under
 * another tool's root: WorkBuddy reads a project's rules from CodeBuddy's
 * `.codebuddy/rules` (#946), which says nothing about WorkBuddy.
 */
const INSTALL_ROOTS: Readonly<Record<string, string>> = { workbuddy: '.workbuddy' };

/**
 * The HOME root that says a tool is installed, in every scope, for a tool with
 * no project path of its own: Muse Code's `.agents` and `.mcp.json` are read
 * by Codex and Claude Code too.
 */
const HOME_INSTALL_ROOTS: Readonly<Record<string, string>> = { muse: '.config/muse' };

/** Each edition of a product sharing one project directory, and the HOME root that alone says the member runs it. */
const EDITION_HOME_ROOTS: Readonly<Record<string, string>> = {
  trae: '.trae',
  'trae-cn': '.trae-cn',
  qoder: '.qoder',
  'qoder-cn': '.qoder-cn',
};

/** The Antigravity tool id, referenced from both the probe and its entry point. */
const ANTIGRAVITY_TOOL_ID = 'antigravity';

/**
 * Paths in the tool's own base dir that are Antigravity's and nobody else's:
 * its hooks config (the project root one older teamai wrote, and the
 * customization-root one the CLI actually runs), its instruction file, and its
 * own hidden directory. `.agents/` as a whole is deliberately absent — that
 * tree is shared with the central Agent Skills entry, so its presence says
 * nothing about Antigravity (and accepting it would add Antigravity's
 * MCP/skills targets to every project that merely uses `.agents/`); the
 * `.agents/hooks.json` file inside it is Antigravity's alone.
 */
const ANTIGRAVITY_OWN_PATHS = ['hooks.json', '.agents/hooks.json', 'GEMINI.md', '.gemini'] as const;

/**
 * The PATH half of Antigravity's install evidence, cached per PATH value.
 *
 * `isOnPath` walks PATH with synchronous `statSync`, and this probe runs once
 * per MCP target inside reconciliation (mcp-reconcile.ts calls
 * `isToolInstalledForConfig` per tool and file) — measured on WSL, where most
 * of PATH's 58 entries sit on a 9p mount and one stat costs ~1.6ms, a single
 * uncached call is ~185ms of blocking I/O, which made reconciliation an order
 * of magnitude slower and pushed its tests past the 15s timeout. The answer
 * only changes when PATH does, so it is cached per PATH/PATHEXT value and a
 * stubbed PATH (as the tests do) still gets a fresh scan.
 *
 * Readers: `isAntigravityInstalledWith` only. Writer: itself.
 */
let antigravityPathProbe: { key: string; found: boolean } | undefined;

function antigravityOnPath(): boolean {
  const key = `${process.env.PATH ?? process.env.Path ?? ''}\0${process.env.PATHEXT ?? ''}`;
  if (antigravityPathProbe?.key !== key) {
    antigravityPathProbe = { key, found: isOnPath('agy') || isOnPath('antigravity') };
  }
  return antigravityPathProbe.found;
}

/**
 * Antigravity's install evidence. `baseDir` is the scope's base — the project
 * root in project scope, HOME in user scope — so both the machine-level signals
 * and the tool's own files in that scope count.
 *
 * The generic `toolInstallRoot` probe is NOT used: a project's `.agents/` tree
 * is shared with the central Agent Skills entry, so it would report Antigravity
 * installed for anyone who has ever used `.agents/`.
 *
 * The cheap checks come first so the costly (cached) PATH scan is only reached
 * when nothing else says installed; the result is the same either way — the
 * signals are OR'd.
 */
async function isAntigravityInstalledWith(localConfig: LocalConfig, baseDir: string): Promise<boolean> {
  if (localConfig.enabledAgents?.includes(ANTIGRAVITY_TOOL_ID) === true) return true;
  const home = getUserHome();
  if (await pathExists(path.join(home, '.gemini', 'antigravity-cli'))) return true;
  if (await pathExists(path.join(home, '.gemini', 'config'))) return true;
  for (const ownPath of ANTIGRAVITY_OWN_PATHS) {
    if (await pathExists(path.join(baseDir, ownPath))) return true;
  }
  return antigravityOnPath();
}

/** Detect an installed tool while respecting tool-specific user roots. */
export async function isToolInstalledForConfig(
  tool: string,
  toolPath: string,
  localConfig: LocalConfig,
  exactConfigPath?: string,
): Promise<boolean> {
  const baseDir = resolveToolBaseDir(tool, localConfig);
  if (tool === COPILOT_TOOL_ID) {
    return localConfig.enabledAgents?.includes(COPILOT_TOOL_ID) === true
      || (exactConfigPath !== undefined && await pathExists(exactConfigPath))
      || pathExists(getCopilotHome());
  }
  // Editions of one product that share every project path (Trae and Trae CN
  // share <root>/.trae/, Qoder and Qoder CN <root>/.qoder/): the shared root
  // says nothing about which edition the member runs. Each edition counts as
  // installed by its own HOME root, or by an explicit --agent whitelist entry
  // naming it (#904) — the bootstrap a project-only init needs before the
  // app has ever run and created its root.
  const editionHomeRoot = EDITION_HOME_ROOTS[tool];
  if (editionHomeRoot !== undefined) {
    if (localConfig.enabledAgents?.includes(tool) === true) return true;
    return pathExists(path.join(getUserHome(), editionHomeRoot));
  }
  // Antigravity must be probed by ITS OWN roots, never by the generic one: its
  // project skills live in the `.agents/` tree that the central Agent Skills
  // entry also uses, so the generic probe would report it installed for any
  // project that merely has `.agents/` — which adds Antigravity's MCP and
  // skills targets to teams that do not run it (#882's MCP reconciliation
  // assertions catch exactly that). `isAntigravityInstalledWith` therefore
  // looks at the machine-level roots plus Antigravity's own files in `baseDir`,
  // which is what the upstream #945 suite sets up before asserting delivery.
  // `toolGateRoot` is not consulted here: it resolves a recorded `toolRoots`
  // entry, and Antigravity is not in RELOCATABLE_TOOLS.
  if (tool === ANTIGRAVITY_TOOL_ID) return isAntigravityInstalledWith(localConfig, baseDir);
  if (Object.hasOwn(HOME_INSTALL_ROOTS, tool)) return pathExists(path.join(getUserHome(), HOME_INSTALL_ROOTS[tool]));
  const probe = Object.hasOwn(INSTALL_ROOTS, tool) ? INSTALL_ROOTS[tool] : toolPath;
  return ResourceHandler.isToolInstalled(probe, baseDir, toolGateRoot(tool, probe, localConfig.toolRoots));
}

/**
 * Abstract base class for resource handlers.
 * Each resource type (skills, rules, docs, env, agents, hooks, mcp) implements this.
 */
/**
 * What `push` knows before it scans. The destination an explicit
 * `--role`/`--project` names, which only agents read: their scan has to
 * decide which team file a local edit is an edit OF, and that answer changes
 * when the user has named a namespace (see `AgentsHandler.scanLocalForPush`).
 * And the open-PR records, which only skills read: an open PR is proof of
 * where a new skill goes, so it decides the copy's destination before copies
 * from several tools are merged (see `SkillsHandler.scanLocalForPush`).
 */
export interface ScanForPushOptions {
  /** The namespace `--role <ns>` / `--project <id>` resolved to, if any. */
  namespace?: string;
  /** Open-PR records whose branch is still on origin. */
  pending?: readonly PendingPush[];
  /** The real path of the copy `push --skill` names: --skill, not the scan, says why it is left out as another namespace's. */
  requestedSkillPath?: string;
}

export abstract class ResourceHandler {
  abstract readonly type: ResourceType;

  /**
   * Scan local sources for items that could be pushed to the team repo.
   * Returns items found locally that are not yet in the team repo.
   */
  abstract scanLocalForPush(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    options?: ScanForPushOptions,
  ): Promise<ResourceItem[]>;

  /**
   * Scan team repo for items that should be pulled to local.
   * Returns items from the team repo.
   */
  abstract scanTeamForPull(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<ResourceItem[]>;

  /**
   * Copy a resource item from local to the team repo directory.
   */
  abstract pushItem(
    item: ResourceItem,
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<void>;

  /**
   * Pull a resource item from the team repo and inject into local AI tool directories.
   * With `ledger`, a skill, rule or agent copy the member changed since teamai
   * delivered it is kept, and each write is recorded (#822).
   */
  abstract pullItem(
    item: ResourceItem,
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    ledger?: DeliveryLedger,
  ): Promise<void>;

  /**
   * Remove a resource from the team repo and all local AI tool directories.
   * Returns the list of paths that were removed.
   */
  abstract removeItem(
    name: string,
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<string[]>;

  /**
   * The name this resource is published under, when the user typed a different
   * one. `remove` matches what the user types against the team repo, where a
   * placed resource lives at `<root>/<ns>/<name>`; the author's local copy is
   * still at the resource root, so they know it by its bare name and `remove`
   * would answer "not found". Handlers that keep a placement record resolve it
   * here, from `records` as the caller reconciled them. Returns null when there
   * is nothing to translate.
   */
  async publishedNameFor(_name: string, _localConfig: LocalConfig, _records: PlacementRecords): Promise<string | null> {
    return null;
  }

  /**
   * Where `item` lands for each tool that can receive it on this machine.
   *
   * Read-only by contract: resolving a destination must never write, so the
   * same answer serves the sync and the checks that verify it. Two resolvers
   * for one destination is how "Synced N skills" ends up true while a tool
   * receives nothing (#598, #624).
   *
   * A tool that cannot receive the item is absent from the result: not
   * installed, no configured path, or outside the item's own targets.
   *
   * The default is empty, which also covers a resource with no per-tool file
   * destination at all. Docs land in one directory, env in one shell profile,
   * and hooks and MCP are entries inside a tool's own config file, so those
   * keep checks of their own instead of a sentinel tool.
   *
   * `received` names the items this member receives in this scope, when the
   * caller already resolved them; a handler that needs them otherwise
   * resolves them itself (rules, for a tool that writes them flat).
   */
  async deliveryTargets(
    _teamConfig: TeamaiConfig,
    _localConfig: LocalConfig,
    _item: ResourceItem,
    _received?: readonly string[],
  ): Promise<DeliveryTarget[]> {
    return [];
  }

  /**
   * Check if an AI tool is installed by verifying its root directory exists.
   * e.g. for toolPath ".codebuddy/skills", checks if ~/.codebuddy/ exists.
   * This prevents creating directories for tools the user hasn't installed.
   * @param baseDir - Override base directory (defaults to HOME). Used for project scope.
   * @param rootSegment - The root to probe, when the caller can name it better
   *   than the path's shape can (a member's recorded `toolRoots` entry; see
   *   `toolGateRoot`). Defaults to `toolInstallRoot(toolPath)`.
   */
  static async isToolInstalled(toolPath: string, baseDir?: string, rootSegment?: string): Promise<boolean> {
    const base = baseDir ?? getUserHome();
    const toolRoot = path.join(base, rootSegment ?? toolInstallRoot(toolPath));
    return pathExists(toolRoot);
  }

  /**
   * Read the tombstone file (`<type>/.removed`) from the team repo.
   * Returns a Set of resource names that have been explicitly deleted.
   */
  async readTombstones(localConfig: LocalConfig): Promise<Set<string>> {
    const tombstonePath = path.join(localConfig.repo.localPath, this.type, TOMBSTONE_FILE);
    const content = await readFileSafe(tombstonePath);
    if (!content) return new Set();
    return new Set(
      content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0),
    );
  }

  /**
   * Append a resource name to the tombstone file, deduplicating and sorting.
   */
  async addTombstone(name: string, localConfig: LocalConfig): Promise<void> {
    const dir = path.join(localConfig.repo.localPath, this.type);
    await ensureDir(dir);
    const tombstonePath = path.join(dir, TOMBSTONE_FILE);
    const existing = await this.readTombstones(localConfig);
    existing.add(name);
    const sorted = [...existing].sort();
    await writeFile(tombstonePath, sorted.join('\n') + '\n');
  }

  /**
   * Compute diff between local and team repo for this resource type.
   */
  async diff(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<ResourceDiff> {
    const localItems = await this.scanLocalForPush(teamConfig, localConfig);
    const teamItems = await this.scanTeamForPull(teamConfig, localConfig);

    const teamNames = new Set(teamItems.map((i) => i.name));
    const localNames = new Set(localItems.map((i) => i.name));

    const added = localItems.filter((i) => !teamNames.has(i.name));
    const removed = teamItems.filter((i) => !localNames.has(i.name));

    return { added, modified: [], removed };
  }
}
