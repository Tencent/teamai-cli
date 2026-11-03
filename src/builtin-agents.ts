import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, fileHash, pathExists, writeFile, remove, listFiles } from './utils/fs.js';
import { log } from './utils/logger.js';
import { warnOnce } from './utils/warn-once.js';
import type { TeamaiConfig, LocalConfig, Scope } from './types.js';
import {
  contentHash, forgetDelivered, keepsTrackedCopy, type DeliveredHashes, type DeliveryLedger,
} from './resources/delivered-copies.js';
import { agentStemFromFilename, renderForTool, reverseFromClaude, type RenderResult } from './resources/agent-format.js';
import { isAgentToolId, type AgentToolId } from './tools.js';
import { installOf, locate, writable } from './locate.js';
import type { DeliveryRecorder } from './git-exclude-delivered.js';

// ─── Built-in agents deployment ──────────────────────────
//
//  CLI ships with built-in subagent definitions (e.g. teamai-recall).
//  These are bundled in the npm package under agents/.
//  On each `teamai pull`, we copy them to local AI tool
//  agents directories so they're always available and
//  stay in sync with the CLI version.
//
//  npm package
//    agents/teamai-recall.md
//      │
//      ▼  (teamai pull)
//    ~/.claude/agents/teamai-recall.md
//    ~/.claude-internal/agents/teamai-recall.md
//    ~/.codebuddy/agents/teamai-recall.md
//
//  A team agent of the same name replaces a built-in one, as a
//  team workflow replaces a default (#1388): the team's
//  agents/teamai-recall.* or agents/<ns>/teamai-recall.*, when
//  pull delivers it here, is the copy the tools get, and this
//  deployment leaves it alone.
//

/** The recall subagent teamai ships while recall is on. */
export const RECALL_AGENT = 'teamai-recall';

/**
 * Names of CLI built-in agents. `AgentsHandler.scanLocalForPush` leaves a
 * copy of one out of a push unless a team agent of that name replaces it
 * (`builtinAgentsReplacedByTeam`): teamai's own copy is never the team's.
 */
export const BUILTIN_AGENT_NAMES = new Set<string>([RECALL_AGENT]);

/**
 * Each built-in agent a team agent of the same name replaces in this
 * directory, with the destinations it replaces it at: where pull writes the
 * team agent (`deliveryDestinations`), so a tool the team agent does not
 * reach keeps teamai's, and tools sharing one directory agree. A team file
 * that cannot be read or parsed replaces nothing, and pull says so, as for a
 * team workflow with no runnable version. While the team's agents collide,
 * pull delivers none and keeps the installed ones, so a built-in counts as
 * replaced only where a team agent this directory could receive already has a
 * file, and a new member still gets teamai's.
 */
export async function builtinAgentsReplacedByTeam(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  // Lazy: resources/agents.ts imports this module.
  const [{ buildRolePullContext, resolveTeamAgents }, { getHandler }, { selectAgentsForDirectory }, { loadStateForScope }] = await Promise.all([
    import('./resources/desired.js'), import('./resources/index.js'), import('./resources/agents.js'), import('./config.js'),
  ]);

  const roleContext = await buildRolePullContext(localConfig);
  const desired = await resolveTeamAgents(teamConfig, localConfig, roleContext);
  const handler = getHandler('agents');
  const held = desired.kind === 'conflict';

  const items = held
    ? selectAgentsForDirectory(
      await handler.scanTeamForPull(teamConfig, localConfig),
      roleContext?.activeNamespaces.agents ?? null,
      (await loadStateForScope(localConfig)).placedAgents,
    )
    : desired.items;

  const replaced = new Map<string, Set<string>>();

  for (const item of items) {
    if (!BUILTIN_AGENT_NAMES.has(item.name)) continue;
    const destinations = await handler.deliveryDestinations(teamConfig, localConfig, item);

    if (!destinations.ok) {
      warnOnce(`[agents] ${item.relativePath} cannot be delivered (${destinations.reason}), so teamai's ${item.name} stays in effect`);
      continue;
    }

    const dests = replaced.get(item.name) ?? new Set<string>();

    for (const dest of destinations.dests) {
      if (!held || await pathExists(dest)) dests.add(dest);
    }

    replaced.set(item.name, dests);
  }

  return replaced;
}

/**
 * The checkout record the built-in step reads, where a team agent of a
 * built-in's name may have left a copy on record: the full sync's ledger,
 * which it updates, or the fast path's read-only snapshot of the record.
 */
export type BuiltinAgentRecord =
  | { kind: 'full-sync'; ledger: DeliveryLedger }
  | { kind: 'fast-path'; delivered: DeliveredHashes | undefined };

/**
 * What the built-in step does at `dest`, which may hold a copy of a team agent
 * that no longer replaces the built-in here. A copy on record is the team's:
 * written over when unedited, kept when the member edited it, as pull keeps any
 * edited copy. The fast path cannot update the record, so it leaves such a copy
 * to the next full sync.
 */
async function builtinDestination(dest: string, content: string, record: BuiltinAgentRecord | undefined): Promise<'write' | 'leave' | 'keep-edit'> {
  if (record === undefined) return 'write';
  const recorded = record.kind === 'full-sync' ? record.ledger.hashes[dest] : record.delivered?.[dest];

  if (recorded === undefined) return 'write';
  const disk = await fileHash(dest);

  if (disk === null) return 'write';

  if (record.kind === 'fast-path') return 'leave';

  return disk === recorded || disk === contentHash(content) ? 'write' : 'keep-edit';
}

/**
 * Resolve the path to the built-in agents directory bundled with the CLI.
 * Mirrors getBuiltinSkillsDir() — `dist/` lives one level below the
 * package root, so we walk up to find `agents/`.
 */
function getBuiltinAgentsDir(): string {
  // __dirname equivalent for ESM: import.meta.url → file path → parent.
  // Use fileURLToPath (not URL.pathname) so Windows drive-letter paths
  // resolve correctly — a raw `/C:/…` pathname is not resolvable by fs.
  const distDir = path.dirname(fileURLToPath(import.meta.url));

  return path.join(distDir, '..', 'agents');
}

/**
 * What teamai writes for its built-in agent `stem` in `tool`'s agents
 * directory: the deployment below writes it, and a copy holding exactly these
 * bytes is teamai's own, never the member's or the team's. Undefined for a
 * name teamai ships no agent under. A shipped file that does not parse is a
 * teamai bug, so it throws.
 */
export function shippedAgentRender(stem: string, tool: AgentToolId, scope: Scope): RenderResult | undefined {
  if (!BUILTIN_AGENT_NAMES.has(stem)) return undefined;
  const src = path.join(getBuiltinAgentsDir(), `${stem}.md`);
  let source: string;

  try {
    source = fs.readFileSync(src, 'utf8');
  } catch {
    return undefined; // a dev checkout without the bundled agents
  }

  const parsed = reverseFromClaude(src, source);

  if (!parsed.ok) throw new Error(`invalid built-in agent ${stem}.md: ${parsed.reason}`);

  return renderForTool(parsed.spec, tool, undefined, scope);
}

/**
 * Deploy CLI built-in agent .md files to every installed tool's agents
 * directory.
 *
 * Silently skips:
 * - Built-in directory missing (dev environment without build step)
 * - Tool whose toolPaths.<tool>.agents is unset (Tier-2/3/4 tools)
 * - Tool not yet installed on the user's machine
 *
 * Per-tool failures only log a warning and do not abort other tools.
 *
 * @returns Total number of (agent × tool) deployments performed
 */
/**
 * Remove any same-stem sibling agent file whose extension differs from `targetExt`.
 *
 * Per-tool rendering can change an agent's native extension (e.g. Codex ships as
 * `.toml` while Claude ships as `.md` and Kiro as `.json`). On re-render, a
 * stale file from a previous extension (left behind by an upgrade or a renderer
 * change) must be cleaned up so the tool does not load two conflicting copies —
 * stale sibling would otherwise make the tool load two conflicting copies.
 *
 * Mirrors the stem-based match already used by `src/uninstall.ts`.
 */
async function removeStaleAgentSiblings(targetAgentsDir: string, stem: string, targetExt: string): Promise<void> {
  let files: string[];

  try {
    files = await listFiles(targetAgentsDir);
  } catch {
    return; // dir missing or unreadable — nothing to clean
  }

  for (const file of files) {
    if (agentStemFromFilename(file) !== stem) continue;

    if (file === `${stem}${targetExt}`) continue;

    try {
      if (await keepsTrackedCopy(path.join(targetAgentsDir, file), path.join(targetAgentsDir, `${stem}${targetExt}`))) continue;
      await remove(path.join(targetAgentsDir, file));
      log.debug(`Removed stale agent sibling ${file} for ${stem}`);
    } catch {
      // best-effort
    }
  }
}

export async function deployBuiltinAgents(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  options?: {
    skipRecall?: boolean; recorder?: DeliveryRecorder; dryRun?: boolean; record?: BuiltinAgentRecord;
    /** Gets each tool that did not take every built-in agent (`DeliveryLedger.toolsMissingAgents`). */
    toolsMissingAgents?: Set<string>;
  },
): Promise<number> {
  const builtinDir = getBuiltinAgentsDir();

  if (!await pathExists(builtinDir)) {
    log.debug('No built-in agents directory found, skipping deployment');

    return 0;
  }

  let entries: string[];

  try {
    entries = await fs.promises.readdir(builtinDir);
  } catch {
    return 0;
  }

  const agentFiles = entries
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .filter((f) => !(options?.skipRecall && f === 'teamai-recall.md'));

  const replaced = await builtinAgentsReplacedByTeam(teamConfig, localConfig);

  if (agentFiles.length === 0) return 0;

  const install = installOf(teamConfig, localConfig);
  let deployed = 0;

  for (const tool of Object.keys(install.toolPaths)) {
    const where = await locate(tool, 'agents', install);

    if (!where.gates.every((gate) => gate.met)) {
      log.debug(`Skipping built-in agent deployment for ${tool}: excluded or not installed`);
      continue;
    }

    if (!isAgentToolId(tool)) {
      if (install.toolPaths[tool]?.agents) {
        log.warn(
          `Skipping built-in agent deployment for ${tool}: unsupported agent format; ` +
          'disable this target or add a native renderer',
        );
      }

      continue;
    }

    const targetAgentsDir = writable(where)?.path;

    if (targetAgentsDir === undefined) {
      log.debug(`Skipping built-in agent deployment for ${tool}: no agents path`);
      continue;
    }

    try {
      // A dry run writes nothing (#915): no directory, no sibling removed.
      if (!options?.dryRun) await ensureDir(targetAgentsDir);
    } catch (e) {
      options?.recorder?.failed('builtin');
      options?.toolsMissingAgents?.add(tool);
      log.warn(`Failed to create agents dir for ${tool}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    for (const file of agentFiles) {
      const src = path.join(builtinDir, file);

      try {
        const stem = path.basename(file, '.md');
        const rendered = shippedAgentRender(stem, tool, localConfig.scope);

        if (rendered === undefined) throw new Error(`cannot read ${src}`);

        // The team's agent of this name is delivered at this destination instead. While
        // its copy is missing (a pull that kept its revision did not deliver it again),
        // the member gets teamai's, which the next full sync replaces with the team's.
        const teamDest = path.join(targetAgentsDir, `${stem}${rendered.ext}`);

        if (replaced.get(stem)?.has(teamDest) && await pathExists(teamDest)) continue;

        if (options?.dryRun) {
          options.recorder?.report('builtin', path.join(targetAgentsDir, `${stem}${rendered.ext}`));
          deployed++;
          continue;
        }

        const dest = path.join(targetAgentsDir, `${stem}${rendered.ext}`);
        const destination = await builtinDestination(dest, rendered.content, options?.record);

        if (destination === 'leave') continue;

        if (destination === 'keep-edit') {
          log.warn(`Kept ${dest}: it holds your edit of the team's ${stem} agent, which no longer reaches this directory. Delete it to get teamai's ${stem} back.`);
          continue;
        }

        // Clean up any same-stem sibling with a different extension before
        // writing the (possibly new) native extension — e.g. an upgrade that
        // switches a tool's native extension must not leave the stale file behind.
        await removeStaleAgentSiblings(targetAgentsDir, stem, rendered.ext);
        await writeFile(dest, rendered.content);

        if (options?.record?.kind === 'full-sync') forgetDelivered(options.record.ledger.hashes, dest);
        options?.recorder?.report('builtin', dest);
        deployed++;
      } catch (e) {
        options?.recorder?.failed('builtin');
        options?.toolsMissingAgents?.add(tool);
        log.warn(`Failed to deploy built-in agent ${file} to ${tool}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return deployed;
}
