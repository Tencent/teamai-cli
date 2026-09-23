import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { isToolInstalledForConfig, ResourceHandler, type ScanForPushOptions } from './base.js';
import type { ResourceItem, ResourceItemStatus, DeliveryTarget, TeamaiConfig, LocalConfig } from '../types.js';
import { listFiles, listDirs, pathExists, copyFile, ensureDir, remove, fileContentEqual, getFileMtime, writeFile, readFileSafe } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { resolveToolBaseDir, isAgentExcluded, isSelfMode, scopedToolPaths } from '../types.js';
import { BUILTIN_AGENT_NAMES } from '../builtin-agents.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import { isSafeNamespaceSegment } from '../projects.js';
import { assertWithinRoot } from '../utils/path-safety.js';
import { loadStateForScope } from '../config.js';
import { placedResourcePath } from '../push-namespaces.js';
import { getFileContentAtRev, getFileContentWhenAdded, isPastVersionOf } from '../utils/git.js';
import {
  parseAgentYaml,
  serializeAgentYaml,
  renderForTool,
  reverseFromClaude,
  reverseFromCodebuddy,
  reverseFromCodex,
  reverseFromCursor,
  reverseFromCopilot,
  reverseFromJoycode,
  reverseFromKiro,
  reverseFromOpencode,
  mergeReverseResults,
  ALL_SUPPORTED_TOOLS,
  AGENT_FILE_EXTENSIONS,
  agentStemFromFilename,
} from './agent-format.js';
import type { AgentSpec, ToolName, ReverseResult, ParseResult, MergeResult, RenderResult } from './agent-format.js';

/**
 * Extended ResourceItem for agents — carries merged spec or skip reason
 * from multi-tool reverse parse (new YAML format push path).
 */
export interface AgentResourceItem extends ResourceItem {
  /** Merged spec produced by scanLocalForPush (new .yaml format only). */
  mergedSpec?: AgentSpec;
  /** Human-readable reason to skip this item during pushItem (merge failed). */
  skipReason?: string;
  /**
   * Set when the scan could not find a team source this directory may write to,
   * so the agent needs a destination named before it can go anywhere. `push`
   * reads it to decide whether a `--project` whose agents axis is empty is a
   * problem for THIS run: a modified agent already in a namespace needs no
   * placement and must not be blocked by it (#649 review).
   */
  needsDestination?: boolean;
  /** True when item came from a legacy .md team-repo file (older format). */
  legacy?: boolean;
  /**
   * Team-relative path of the file this push retires: the recorded canonical
   * file when the author renamed their source from `.md` to `.yaml` or back.
   * `pushItem` deletes it and `push` stages the deletion and moves the record.
   */
  supersedes?: string;
}

/**
 * AgentsHandler — manage AI subagent definitions distributed via the team repo.
 *
 * Layout:
 *   New format:   team-repo/agents/<name>.yaml  → rendered per-tool on pull
 *   Legacy format: team-repo/agents/<name>.md    → copied as-is (claude/claude-internal/codebuddy only)
 *
 * Tools without an `agents` path in toolPaths are silently skipped.
 */
/**
 * The agents this directory should hold: the ones in an active namespace, plus
 * any this machine published into a namespace it does not activate — push lets
 * the author keep editing those through the placement record, so pull has to
 * deliver them or the local copy never tracks the team file (#649).
 *
 * A stem an ACTIVE namespace already claims is left alone: agents deploy
 * flattened, so two would collide on one filename, and the active one is the
 * agent deployed here.
 *
 * Delivery and revocation both resolve through this. They must agree — when
 * only delivery knew about the record, `pull` wrote the agent and the
 * revocation pass deleted it again in the same run.
 */
export function selectAgentsForDirectory(
  agents: ResourceItem[],
  activeNamespaces: string[] | null,
  placedAgents?: Record<string, string>,
): ResourceItem[] {
  if (activeNamespaces === null) return agents;

  const active = agents.filter(
    (agent) => !agent.namespace || activeNamespaces.includes(agent.namespace),
  );
  if (!placedAgents) return active;

  const claimed = new Set(active.map((agent) => agent.name));
  const recovered = agents.filter((agent) => agent.namespace
    && !claimed.has(agent.name)
    && placedResourcePath(placedAgents, 'agents', agent.name)
      === `agents/${agent.namespace}/${path.basename(agent.relativePath)}`);
  return recovered.length > 0 ? [...active, ...recovered] : active;
}

export class AgentsHandler extends ResourceHandler {
  readonly type = 'agents' as const;

  /**
   * The tombstones as flattened local copies see them. Removing `fe/vr`
   * tombstones only `fe/vr`, but every member holds that agent as `<agents>/vr`,
   * so the tombstone alone never reaches their copy, and the next push reads it
   * as a new agent and republishes it (#649 review). `vr` counts as removed
   * here only when both hold:
   *   - `fe/vr` could have been delivered HERE: `fe` is active, or nothing is
   *     filtered, or this machine placed `vr` in `fe` (its record, or the one
   *     reconcile retired when the file was deleted). On a member who never
   *     had `fe`, a `vr` is their own agent, and deleting it — or refusing to
   *     push it — takes something that was never the team's.
   *   - THIS directory is not meant to hold another agent of that stem, by the
   *     same selection pull delivers with (`selectAgentsForDirectory`): while a
   *     `be/vr` is delivered here, the copy is be/vr's, and suppressing it is
   *     what round 8 of the review ruled out.
   */
  async removedStems(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<Set<string>> {
    const tombstones = await this.readTombstones(localConfig);
    const removed = new Set(tombstones);
    if (![...tombstones].some((tombstone) => tombstone.includes('/'))) return removed;
    const activeNamespaces = (await resolveResourceNamespaces(localConfig))?.activeNamespaces.agents ?? null;
    const { placedAgents, retiredPlacedAgents } = await loadStateForScope(localConfig);
    // This machine's record — live, or dropped when the team deleted the file —
    // says its flattened copy stood for the agent in that namespace.
    const placedIn = (stem: string): string | undefined => (
      placedResourcePath(placedAgents, 'agents', stem) ?? placedResourcePath(retiredPlacedAgents, 'agents', stem)
    )?.split('/')[1];
    const desired = new Set(selectAgentsForDirectory(
      await this.scanTeamForPull(teamConfig, localConfig),
      activeNamespaces,
      placedAgents,
    ).map((agent) => agent.name));
    for (const tombstone of tombstones) {
      const segments = tombstone.split('/');
      if (segments.length !== 2) continue;
      const [namespace, stem] = segments as [string, string];
      const deliveredHere = activeNamespaces === null || activeNamespaces.includes(namespace)
        || placedIn(stem) === namespace;
      if (deliveredHere && !desired.has(stem)) removed.add(stem);
    }
    return removed;
  }

  /**
   * Scan local AI tool agents/ directories for files that are new or modified
   * compared to the team repo. Groups by agent name stem across all tools.
   *
   * New format (.yaml in team repo): attempts multi-tool reverse + merge.
   * Built-in CLI agents are excluded from push.
   */
  async scanLocalForPush(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    options?: ScanForPushOptions,
  ): Promise<AgentResourceItem[]> {
    const requestedNamespace = options?.namespace;
    const teamAgentsDir = path.join(localConfig.repo.localPath, 'agents');
    const tombstones = await this.removedStems(teamConfig, localConfig);
    // Single-repo mode: users drop canonical agent files straight into the repo's
    // own .teamai/agents/ (<name>.yaml, or legacy <name>.md) rather than authoring
    // them in a tool's agents dir. Those are ALREADY in team-repo format, so we
    // pick them up directly (no reverse/merge) — diffed against the worktree's
    // origin/<default> checkout so only genuine additions/edits surface. These win
    // over the reverse-parse path below on name conflicts (explicit canonical is
    // authoritative). Active tree = projectRoot (kept intact by withKnowledgeWorktree).
    // An agent this machine published with --role/--project lives in a
    // namespace this directory need not have activated. Without the record it
    // would read as "no active source" and the author could never edit the
    // agent they just created (#649 review).
    const { placedAgents, lastPullRev, pendingPushes } = await loadStateForScope(localConfig);
    // Agents this machine placed in a namespace and has awaiting review: the
    // open PR is their destination, not "no active source".
    const pendingPlacedAgents = new Set((pendingPushes ?? []).flatMap((entry) => entry.items)
      .filter((item) => item.type === 'agents' && item.relativePath.split('/').length === 3)
      .map((item) => item.name));

    const directItems: AgentResourceItem[] = [];
    const directStems = new Set<string>();
    if (isSelfMode(localConfig) && localConfig.projectRoot) {
      const activeAgentsDir = path.join(localConfig.projectRoot, '.teamai', 'agents');
      if (await pathExists(activeAgentsDir)) {
        for (const { dir, namespace } of await listTeamAgentDirs(activeAgentsDir)) {
          const relDir = namespace ? `agents/${namespace}` : 'agents';
          for (const file of await listFiles(dir)) {
            const isYaml = file.endsWith('.yaml');
            const isMd = file.endsWith('.md');
            if (!isYaml && !isMd) continue;
            const stem = file.replace(/\.(yaml|md)$/, '');
            if (tombstones.has(stem)) continue;
            if (BUILTIN_AGENT_NAMES.has(stem)) continue;

            const activePath = path.join(dir, file);
            let teamRelPath = `${relDir}/${file}`;
            let basePath = path.join(localConfig.repo.localPath, teamRelPath);
            let baseExists = await pathExists(basePath);
            let supersedes: string | undefined;
            // A canonical source authored at .teamai/agents/ root and placed
            // under agents/<ns>/ has nothing at agents/<stem>.yaml, so without
            // the record it reads as brand new — and the collision check then
            // refuses the very agent this machine published (#649 review).
            if (!baseExists && !namespace) {
              const placed = placedResourcePath(placedAgents, 'agents', stem);
              if (placed && await pathExists(path.join(localConfig.repo.localPath, placed))) {
                // The destination keeps the record's directory but THIS file's
                // extension: `pushItem` writes by the source's extension, so a
                // relativePath still naming the recorded `.md` would stage a
                // path nothing was written to, and leave that `.md` behind.
                teamRelPath = `${path.posix.dirname(placed)}/${file}`;
                if (teamRelPath !== placed) supersedes = placed;
                basePath = path.join(localConfig.repo.localPath, placed);
                baseExists = true;
                // Nothing refreshes this root file after placement — pull
                // deploys to tool dirs, and the pre-push sync covers those only
                // — so `lastPullRev` says nothing about it. A copy equal to an
                // OLDER version of the team file is one nobody edited, and
                // pushing it would revert whoever changed the file since
                // (#649 review).
                if (!supersedes && !await fileContentEqual(activePath, basePath)
                  && await isPastVersionOf(localConfig.repo.localPath, activePath, placed)) {
                  directItems.push({ name: stem, type: 'agents', sourcePath: activePath,
                    relativePath: placed, status: 'modified', namespace: placed.split('/')[1],
                    skipReason: `${path.relative(localConfig.projectRoot, activePath)} is an older version of ${placed}, `
                      + 'which has changed on the team since. Copy the current file over it (or delete it) before editing.' });
                  directStems.add(stem);
                  continue;
                }
              }
            }
            if (baseExists && !supersedes && await fileContentEqual(activePath, basePath)) continue; // unchanged

            directItems.push({
              name: stem,
              type: 'agents',
              sourcePath: activePath,
              relativePath: teamRelPath,
              status: (baseExists ? 'modified' : 'new') as ResourceItemStatus,
              legacy: isMd,
              ...(baseExists && teamRelPath !== `${relDir}/${file}`
                ? { namespace: teamRelPath.split('/')[1] }
                : {}),
              ...(supersedes ? { supersedes } : {}),
            });
            directStems.add(stem);
          }
        }
      }
    }

    // Collect all local agent files grouped by stem
    const grouped = new Map<string, Map<string, string>>(); // stem → (tool → filePath)

    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.agents) continue;
      // An excluded tool is neither written nor cleaned by teamai, so what it
      // holds is not a source either: `removeItem` leaves its copy behind, and
      // a namespaced removal tombstones only `<ns>/<stem>`, so reading that
      // copy republished the agent just removed (#649 review).
      if (isAgentExcluded(localConfig, tool)) continue;
      const baseDir = resolveToolBaseDir(tool, localConfig);
      const agentsDir = path.join(baseDir, toolPath.agents);
      if (!await pathExists(agentsDir)) continue;

      const files = await listFiles(agentsDir);
      for (const file of files) {
        const stem = agentStemFromFilename(file);
        if (stem === null) continue;
        if (tombstones.has(stem)) continue;
        if (BUILTIN_AGENT_NAMES.has(stem)) continue;
        if (directStems.has(stem)) continue; // canonical direct-pickup wins (self mode)

        const filePath = path.join(agentsDir, file);
        let toolGroup = grouped.get(stem);
        if (!toolGroup) {
          toolGroup = new Map();
          grouped.set(stem, toolGroup);
        }
        // Use latest mtime if same tool appears via multiple tool paths (shouldn't happen normally)
        if (!toolGroup.has(tool)) {
          toolGroup.set(tool, filePath);
        }
      }
    }

    // Seed with the canonical direct-pickup items (self mode); reverse-parsed
    // items for other stems are appended below.
    const items: AgentResourceItem[] = [...directItems];

    const resolved = await resolveResourceNamespaces(localConfig);
    const activeNamespaces = resolved?.activeNamespaces.agents ?? null;
    for (const [stem, toolFiles] of grouped) {
      // Determine if this agent is already in the team repo (root or agents/<ns>/).
      // A modified agent must be written back where it lives, so its namespace
      // directory is carried into `relativePath` below.
      const sources = await findTeamAgentFiles(teamAgentsDir, stem);
      const placedNamespace = placedResourcePath(placedAgents, 'agents', stem)?.split('/')[1];
      // Which team file this local agent is a copy of, in the order pull
      // delivers them: an active source (the shared root counts) is what was
      // deployed here, then the one this machine's record names. Only when
      // neither exists does an explicit --role/--project decide — the agent
      // then needs a destination, and a same-stem copy in some other inactive
      // namespace is a different agent that must not block it (#649 review).
      // Letting the flag win outright compared an active agent's rendering
      // with the requested namespace's file and overwrote it without an edit.
      const active = sources.filter(
        (file) => activeNamespaces === null || !file.namespace
          || activeNamespaces.includes(file.namespace),
      );
      const recorded = placedNamespace ? sources.filter((file) => file.namespace === placedNamespace) : [];
      // Two active sources stay ambiguous even under a flag: the flattened file
      // cannot say which one it was delivered from, and picking the requested
      // one compared the other's untouched copy with it (#649 review).
      const candidates = active.length > 0 ? active : recorded;
      if (candidates.length > 1) {
        items.push({ name: stem, type: 'agents', sourcePath: teamAgentsDir,
          relativePath: `agents/${stem}.yaml`, status: 'modified',
          skipReason: `Ambiguous agent "${stem}": multiple active sources (${candidates.map((file) => file.path).join(', ')}). Give active agents unique names before pushing.` });
        continue;
      }
      // A shared-root copy is always active, so it is a candidate above and
      // this local file is an edit of it: no namespaced second copy is made.
      //
      // With a destination named that already holds this stem — never
      // delivered here, so this local file is not a copy of it — the agent is
      // new there and would land on somebody else's, which rules already
      // refuse (#649 review).
      const inRequested = requestedNamespace
        ? sources.find((file) => file.namespace === requestedNamespace)
        : undefined;
      if (candidates.length === 0 && inRequested) {
        const taken = `agents/${requestedNamespace}/${stem}${inRequested.ext}`;
        items.push({ name: stem, type: 'agents', sourcePath: teamAgentsDir,
          relativePath: taken, status: 'new', namespace: requestedNamespace,
          skipReason: `Agent "${stem}" cannot be placed: ${taken} already exists in the team repo and was never `
            + 'delivered here, so this local copy is not an edit of it and pushing would overwrite it. '
            + 'Activate that namespace and pull to edit the existing one, rename yours, or pick another namespace with --role <ns>.' });
        continue;
      }
      // With no destination named, a stem that exists only in namespaces this
      // directory has not activated is not ours to edit — unless this machine
      // has it awaiting review as a placement, whose open PR it goes back to.
      if (!requestedNamespace && sources.length > 0 && candidates.length === 0 && !pendingPlacedAgents.has(stem)) {
        items.push({ name: stem, type: 'agents', sourcePath: teamAgentsDir,
          relativePath: `agents/${stem}.yaml`, status: 'modified',
          needsDestination: true,
          skipReason: `Agent "${stem}" has no active source. Activate its role or project before pushing local edits.` });
        continue;
      }
      const located = candidates[0];
      const teamYamlPath = located?.ext === '.yaml' ? located.path : path.join(teamAgentsDir, `${stem}.yaml`);
      const teamMdPath = located?.ext === '.md' ? located.path : path.join(teamAgentsDir, `${stem}.md`);
      const hasTeamYaml = located?.ext === '.yaml';
      const hasTeamMd = located?.ext === '.md';
      const teamDir = located?.namespace ? `agents/${located.namespace}` : 'agents';

      let canonicalSpec: AgentSpec | undefined;
      if (hasTeamYaml) {
        const raw = await readFileSafe(teamYamlPath);
        const parsed = raw === null ? null : parseAgentYaml(raw, `${stem}.yaml`);
        if (!parsed?.ok) {
          items.push({ name: stem, type: 'agents', sourcePath: teamYamlPath,
            relativePath: `${teamDir}/${stem}.yaml`, status: 'modified',
            skipReason: 'cannot read or parse canonical agent YAML' });
          continue;
        }
        // Validation normalizes known fields, but unrelated canonical fields
        // must survive edits from a tool that cannot represent them.
        canonicalSpec = { ...(parseYaml(raw!) as Record<string, unknown>), ...parsed.spec };
        // Compare like with like: native files against a native rendering of
        // the canonical YAML. Unchanged/untargeted copies must not join a merge.
        for (const [tool, filePath] of toolFiles) {
          if (!isKnownTool(tool)
            || (canonicalSpec.targets && !canonicalSpec.targets.includes(tool))) {
            toolFiles.delete(tool);
            continue;
          }
          if (await readFileSafe(filePath) === renderForTool(canonicalSpec, tool).content) {
            toolFiles.delete(tool);
          }
        }
      }

      // Check if any local file differs from team copy
      let hasChange = false;
      if (hasTeamYaml) {
        hasChange = toolFiles.size > 0;
      } else if (!hasTeamMd) {
        hasChange = true; // brand new
      } else {
        for (const [tool, filePath] of toolFiles) {
          const teamRef = hasTeamYaml ? teamYamlPath : teamMdPath;
          const equal = await agentContentEqual(tool, filePath, teamRef).catch((err) => {
            console.warn(
              `[agents] 比较文件内容失败 ${filePath} vs ${teamRef}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          });
          if (!equal) {
            hasChange = true;
            break;
          }
        }
      }

      if (!hasChange) continue;

      // Only a copy that differs is worth holding: an unchanged one — the
      // author's own merged edit included — has nothing to overwrite with.
      if (located && active.length === 0 && recorded.length > 0) {
        const recordedPath = `agents/${located.namespace}/${stem}${located.ext}`;
        if (await recordedAgentMovedOn(localConfig.repo.localPath, recordedPath, lastPullRev)) {
          items.push({ name: stem, type: 'agents', sourcePath: teamAgentsDir,
            relativePath: recordedPath, status: 'modified', namespace: located.namespace,
            skipReason: staleRecordedAgentReason(stem, recordedPath) });
          continue;
        }
      }

      const status: ResourceItemStatus = (hasTeamYaml || hasTeamMd) ? 'modified' : 'new';

      // Determine representative source path (prefer highest mtime)
      let bestPath = '';
      let bestMtime = 0;
      for (const [, filePath] of toolFiles) {
        const mtime = await getFileMtime(filePath);
        if (mtime > bestMtime) {
          bestMtime = mtime;
          bestPath = filePath;
        }
      }

      // Attempt reverse + merge for new YAML format push
      const perToolSpecs: Partial<Record<ToolName, AgentSpec>> = {};
      let skipReason: string | undefined;

      for (const [tool, filePath] of toolFiles) {
        if (!isKnownTool(tool)) continue;
        const content = await readFileSafe(filePath);
        if (!content) {
          if (canonicalSpec) skipReason = `cannot read edited agent file for ${tool}`;
          continue;
        }

        const result = reverseByTool(tool, filePath, content);
        if (result.ok) {
          perToolSpecs[tool as ToolName] = result.spec;
        } else {
          if (canonicalSpec) skipReason = `cannot parse edited agent file for ${tool}: ${result.reason}`;
          log.debug(`Reverse failed for ${stem} from ${tool}: ${result.reason}`);
        }
      }

      if (!skipReason && Object.keys(perToolSpecs).length === 0) {
        skipReason = `could not reverse-parse any tool's agent file for ${stem}`;
      } else if (!skipReason) {
        const mergeResult = canonicalSpec
          ? mergeCanonicalEdits(canonicalSpec, perToolSpecs)
          : mergeReverseResults(perToolSpecs);
        if (!mergeResult.ok) {
          const conflictSummary = mergeResult.conflicts
            .map((c) => `${c.field}: ${JSON.stringify(c.values)}`)
            .join('; ');
          skipReason = `conflicting values across tools — ${conflictSummary}`;
        } else {
          if (canonicalSpec && isDeepStrictEqual(canonicalSpec, mergeResult.spec)) continue;
          items.push({
            name: stem,
            type: 'agents',
            sourcePath: bestPath,
            relativePath: `${teamDir}/${stem}.yaml`,
            status,
            mergedSpec: mergeResult.spec,
            // Carried explicitly: an open PR records this item, and a record
            // with no namespace reads as "shared root" to everything that
            // later compares destinations (#649 review).
            ...(located?.namespace ? { namespace: located.namespace } : {}),
          });
          continue;
        }
      }

      // Fall back to pushing the raw md file (legacy behavior)
      items.push({
        name: stem,
        type: 'agents',
        sourcePath: bestPath,
        relativePath: `${teamDir}/${stem}.md`,
        status,
        skipReason,
        ...(located?.namespace ? { namespace: located.namespace } : {}),
      });
    }

    return items;
  }

  /**
   * Scan team repo `agents/` for files to pull.
   * Recognizes both *.yaml (new) and *.md (legacy).
   * Hidden files (tombstones) are filtered out by listFiles.
   *
   * Root-level files are shared with everyone. One level of subdirectories
   * (`agents/<namespace>/`) carries role/project-scoped agents, the same
   * convention `rules/<namespace>/` uses; pull filters them by the active
   * `agents` namespaces. Deeper nesting is not scanned.
   */
  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<AgentResourceItem[]> {
    const agentsDir = path.join(localConfig.repo.localPath, 'agents');
    if (!await pathExists(agentsDir)) return [];

    const items: AgentResourceItem[] = [];
    const scanDir = async (dir: string, namespace?: string): Promise<void> => {
      const prefix = namespace ? `agents/${namespace}` : 'agents';
      for (const file of await listFiles(dir)) {
        const legacy = file.endsWith('.md');
        if (!legacy && !file.endsWith('.yaml')) continue;
        items.push({
          name: file.replace(/\.(yaml|md)$/, ''),
          type: 'agents',
          sourcePath: path.join(dir, file),
          relativePath: `${prefix}/${file}`,
          legacy,
          ...(namespace ? { namespace } : {}),
        });
      }
    };

    for (const { dir, namespace } of await listTeamAgentDirs(agentsDir)) {
      await scanDir(dir, namespace);
    }

    return items;
  }

  /**
   * Push an agent to the team repo.
   * New format: writes mergedSpec as <name>.yaml.
   * Skip: logs warning and returns without writing.
   * Legacy fallback: copies the raw .md file.
   */
  async pushItem(item: ResourceItem, _teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const agentItem = item as AgentResourceItem;

    if (agentItem.skipReason) {
      log.warn(`[agents] Skipped ${item.name}: ${agentItem.skipReason}`);
      return;
    }

    // `relativePath` carries the namespace directory of an existing team agent
    // (agents/<ns>/<name>.<ext>); a brand-new agent lands at the root.
    const teamDir = path.resolve(localConfig.repo.localPath, path.dirname(item.relativePath));
    assertWithinRoot(
      path.join(localConfig.repo.localPath, 'agents'),
      teamDir,
      `Invalid agent destination outside team repo agents directory: ${item.relativePath}`,
    );

    if (agentItem.mergedSpec) {
      const dest = path.join(teamDir, `${item.name}.yaml`);
      await ensureDir(path.dirname(dest));
      const yamlContent = serializeAgentYaml(agentItem.mergedSpec);
      await writeFile(dest, yamlContent);
      log.debug(`Wrote agent ${item.name} → team repo (YAML format)`);
      return;
    }

    // Direct-pickup (self mode) or legacy .md: copy the source verbatim, PRESERVING
    // its extension. The old code hardcoded `.md`, which would corrupt a canonical
    // `<name>.yaml` a user placed directly under .teamai/agents/. Derive the ext
    // from the source so both .yaml and .md round-trip correctly.
    const ext = item.sourcePath.endsWith('.yaml') ? '.yaml' : '.md';
    const dest = path.join(teamDir, `${item.name}${ext}`);
    if (item.sourcePath !== dest) {
      await ensureDir(path.dirname(dest));
      await copyFile(item.sourcePath, dest);
    }
    // The recorded file under the other extension is the same agent; two
    // canonical files for one stem is what pull reports as a collision.
    if (agentItem.supersedes) {
      const retired = path.resolve(localConfig.repo.localPath, agentItem.supersedes);
      assertWithinRoot(path.join(localConfig.repo.localPath, 'agents'), retired,
        `Invalid superseded agent path outside team repo agents directory: ${agentItem.supersedes}`);
      if (retired !== dest) await remove(retired);
    }
    log.debug(`Copied agent ${item.name} → team repo (${ext} verbatim)`);
  }

  /**
   * Pull an agent to every installed tool's agents/ directory.
   *
   * New format (.yaml): parses spec, respects spec.targets, renders per-tool native format.
   * Legacy format (.md): copies .md as-is to Claude-compatible tools.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const agentItem = item as AgentResourceItem;

    // Determine format: explicit flag takes precedence; fall back to extension detection
    const content = await readFileSafe(item.sourcePath);
    if (content === null) {
      log.warn(`agents: cannot read ${item.sourcePath}`);
      return;
    }

    // Say why an agent reaches nothing before the loop silently delivers
    // nowhere: `resolveRenders` skips an unparsable spec for every tool alike.
    if (!isLegacyAgent(agentItem)) {
      const parseResult: ParseResult = parseAgentYaml(content, `${item.name}.yaml`);
      if (!parseResult.ok) {
        log.warn(`[agents] Skipped ${item.name}.yaml: ${parseResult.reason}`);
        return;
      }
    }

    for (const { tool, dest, render } of await this.resolveRenders(teamConfig, localConfig, item)) {
      const destDir = path.dirname(dest);
      try {
        await ensureDir(destDir);
        // Only a rendered spec can leave a sibling behind: its extension follows
        // the tool's format and changes when `targets` does. A legacy `.md` is
        // copied verbatim to one extension for every tool, so a same-stem
        // `.toml`, `.json` or `.agent.md` beside it is the member's own file
        // and not ours to delete (#624 review).
        if (!isLegacyAgent(agentItem)) {
          await removeStaleAgentSiblings(destDir, item.name, render.ext);
        }
        await writeFile(dest, render.content);
        log.debug(`Rendered agent ${item.name} → ${tool} (${render.ext})`);
      } catch (e) {
        log.warn(`Failed to sync agent ${item.name} to ${tool}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Remove an agent from the team repo and all tool agents/ directories.
   * Tries both .yaml and .md extensions in the team repo.
   * Records a tombstone to prevent re-push.
   */
  /**
   * `vr` when push placed it at `agents/fe/vr.yaml`: the author's local copy is
   * at the tool's agents root, so the name they type is the bare one. Without
   * this, `remove` matched that bare name and deleted every `vr` in every
   * namespace — other people's agents included (#649 review).
   */
  async publishedNameFor(name: string, localConfig: LocalConfig): Promise<string | null> {
    const placed = placedResourcePath(
      (await loadStateForScope(localConfig)).placedAgents, 'agents', name,
    );
    if (!placed) return null;
    if (!await pathExists(path.join(localConfig.repo.localPath, placed))) return null;
    return placed.slice('agents/'.length).replace(/\.(yaml|md)$/, '');
  }

  /**
   * Remove an agent from the team repo and all local AI tool agents/ directories.
   *
   * `name` is either a bare stem, which still means "this agent wherever it
   * lives", or the published `<ns>/<stem>` that `publishedNameFor` resolved —
   * and that one names exactly one file, so only it is removed. The local sweep
   * covers both spellings: a placed agent leaves the author's copy at the
   * agents root while every other member receives it under `<ns>/`.
   */
  async removeItem(name: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const removed: string[] = [];

    const teamAgentsDir = path.join(localConfig.repo.localPath, 'agents');
    const stem = path.basename(name);

    // Both extensions, and every namespace a BARE stem lives in. A published
    // `<ns>/<stem>` resolves to exactly one file, because the root directory is
    // one of the directories probed and `<ns>/<stem>.yaml` sits under it — so
    // naming a namespace leaves the same stem in other namespaces alone.
    for (const located of await findTeamAgentFiles(teamAgentsDir, name)) {
      await remove(located.path);
      removed.push(located.path);
    }

    // Only the name given. Agents deploy FLATTENED — `~/.claude/agents/<stem>` —
    // so a bare-stem tombstone is read globally by both the push scan and the
    // post-pull cleanup: removing `fe/vr` would suppress and delete `be/vr` the
    // moment that namespace became active (#649 review). Rules can afford the
    // bare spelling because they keep their namespace directory locally.
    await this.addTombstone(name, localConfig);

    // The author's own copy IS flattened, though, and it is theirs only when
    // this machine's record says the file just removed is where push put it.
    const localNames = new Set([name]);
    if (stem !== name) {
      const placed = placedResourcePath(
        (await loadStateForScope(localConfig)).placedAgents, 'agents', stem,
      );
      if (placed === `agents/${name}.yaml` || placed === `agents/${name}.md`) {
        localNames.add(stem);
      }
    }

    // Single-repo mode: the canonical source lives in the repo's own
    // .teamai/agents/, and the scan picks it up directly. Leaving it behind
    // republishes the agent on the next push, and a bare-stem tombstone cannot
    // stop that without suppressing the same stem in every other namespace,
    // because agents deploy flattened (#649 review).
    if (isSelfMode(localConfig) && localConfig.projectRoot) {
      const activeAgentsDir = path.join(localConfig.projectRoot, '.teamai', 'agents');
      for (const localName of localNames) {
        for (const ext of ['.yaml', '.md'] as const) {
          const filePath = path.join(activeAgentsDir, `${localName}${ext}`);
          if (await pathExists(filePath)) {
            await remove(filePath);
            removed.push(filePath);
          }
        }
      }
    }

    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.agents) continue;
      // A tool the member excluded is not ours to write to, so it is not ours
      // to delete from either. This is the gate pull's tombstone pass applies.
      if (isAgentExcluded(localConfig, tool)) continue;
      const baseDir = resolveToolBaseDir(tool, localConfig);
      // Try every native agent extension: the render format varies per tool.
      for (const localName of localNames) {
        for (const ext of AGENT_FILE_EXTENSIONS) {
          const filePath = path.join(baseDir, toolPath.agents, `${localName}${ext}`);
          if (await pathExists(filePath)) {
            await remove(filePath);
            removed.push(filePath);
            log.debug(`Removed agent ${localName} from ${tool}`);
          }
        }
      }
    }

    return removed;
  }

  /**
   * Revocation pass for role/project scoping. Removes the deployed copies of
   * every agent whose namespace is no longer active, on every installed tool.
   *
   * Data-safety gate, same as inactive skills: a file is deleted only when it
   * is byte-equal to what pull would render from the team source. A local edit
   * is kept and reported so nothing unpushed is lost. Root-level agents and
   * agents still deployed to the same tool destination never qualify.
   */
  async cleanupInactiveNamespaces(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    activeNamespaces: string[],
  ): Promise<void> {
    const items = await this.scanTeamForPull(teamConfig, localConfig);
    // The same selection `pull` delivers with, records included: revoking an
    // agent this machine published would delete the copy pull had just written.
    const { placedAgents } = await loadStateForScope(localConfig);
    const kept = new Set(
      selectAgentsForDirectory(items, activeNamespaces, placedAgents).map((item) => item.relativePath),
    );
    const active = items.filter((item) => kept.has(item.relativePath));
    const inactive = items.filter(
      (item) => !kept.has(item.relativePath) && !BUILTIN_AGENT_NAMES.has(item.name),
    );
    if (inactive.length === 0) return;

    for (const { tool, dir: destDir } of await this.agentToolDirs(teamConfig, localConfig)) {
      const activeDestinations = new Set<string>();
      for (const item of active) {
        const rendered = await this.renderedForTool(item, tool);
        if (rendered) activeDestinations.add(`${item.name}${rendered.ext}`);
      }
      for (const item of inactive) {
        const expected = await this.renderedForTool(item, tool);
        if (!expected || activeDestinations.has(`${item.name}${expected.ext}`)) continue;
        const deployed = path.join(destDir, `${item.name}${expected.ext}`);
        const current = await readFileSafe(deployed);
        if (current === null) continue;
        if (current !== expected.content) {
          log.warn(`[${localConfig.scope}] Kept agent "${item.name}" (${tool}): it differs from the team source ${item.relativePath}. Back it up, then delete it manually.`);
          continue;
        }
        await remove(deployed);
        log.debug(`[${localConfig.scope}] Removed inactive role-scoped agent ${item.name} from ${tool}`);
      }
    }
  }

  /**
   * Every tool that receives `item`, with the path and the bytes `pullItem`
   * writes there.
   *
   * An agent's desired set is a relation, not a product: a YAML spec carries
   * `targets`, a legacy `.md` only reaches LEGACY_MD_TOOLS, and the filename
   * extension comes from the render rather than the item. So this is the only
   * place that can answer where an agent lands.
   */
  private async resolveRenders(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    item: ResourceItem,
  ): Promise<{ tool: ToolName; dest: string; render: RenderResult }[]> {
    const agentItem = item as AgentResourceItem;
    const renders: { tool: ToolName; dest: string; render: RenderResult }[] = [];

    for (const { tool, dir } of await this.agentToolDirs(teamConfig, localConfig)) {
      const render = await this.renderedForTool(agentItem, tool);
      if (!render) continue;

      renders.push({ tool, dest: path.join(dir, `${item.name}${render.ext}`), render });
    }

    return renders;
  }

  /**
   * Every installed tool that receives agents at all, with the directory its
   * copies land in — the gate, without asking any agent to render.
   *
   * `doctor` needs this on its own. "This agent reaches no tool" is a team-repo
   * problem only once some tool was there to receive it, and taking the
   * successful renders as proof of that hides the case where every agent is
   * malformed: no render, no tool, no failure reported (#624).
   */
  async agentToolDirs(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<{ tool: ToolName; dir: string }[]> {
    const dirs: { tool: ToolName; dir: string }[] = [];

    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.agents || !isKnownTool(tool) || isAgentExcluded(localConfig, tool)) continue;
      if (!await isToolInstalledForConfig(tool, toolPath.agents, localConfig)) {
        log.debug(`Skipping agent sync for ${tool}: tool not installed`);
        continue;
      }
      dirs.push({ tool, dir: path.join(resolveToolBaseDir(tool, localConfig), toolPath.agents) });
    }

    return dirs;
  }

  async deliveryTargets(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    item: ResourceItem,
  ): Promise<DeliveryTarget[]> {
    return (await this.resolveRenders(teamConfig, localConfig, item))
      .map(({ tool, dest, render }) => ({ tool, dest, content: render.content }));
  }

  /**
   * What `pullItem` writes for this agent on this tool, or null when the tool
   * is not a target (legacy `.md` only reaches LEGACY_MD_TOOLS, a YAML spec
   * honours `targets`, an unparsable spec is skipped like pull skips it).
   */
  private async renderedForTool(item: AgentResourceItem, tool: ToolName): Promise<RenderResult | null> {
    const content = await readFileSafe(item.sourcePath);
    if (content === null) return null;
    if (isLegacyAgent(item)) {
      return LEGACY_MD_TOOLS.has(tool) ? { ext: '.md', content } : null;
    }
    const parsed = parseAgentYaml(content, `${item.name}.yaml`);
    if (!parsed.ok) return null;
    if (parsed.spec.targets && !parsed.spec.targets.includes(tool)) return null;
    return renderForTool(parsed.spec, tool);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

}

// ─── Module-level helpers ──────────────────────────────────────────────────

/** Tools that receive a legacy `agents/<name>.md` copied verbatim. */
const LEGACY_MD_TOOLS = new Set(['claude', 'claude-internal', 'tclaude', 'codebuddy', 'joycode', 'omp']);

type TeamAgentDir = { dir: string; namespace?: string };

/**
 * The directories that hold team agents: the root plus one level of
 * namespace subdirectories (`agents/<namespace>/`). Unsafe segment names are
 * skipped so a namespace can never become a path traversal.
 */
export async function listTeamAgentDirs(teamAgentsDir: string): Promise<TeamAgentDir[]> {
  const dirs: TeamAgentDir[] = [{ dir: teamAgentsDir }];
  for (const namespace of await listDirs(teamAgentsDir)) {
    if (isSafeNamespaceSegment(namespace)) dirs.push({ dir: path.join(teamAgentsDir, namespace), namespace });
  }
  return dirs;
}

type TeamAgentFile = { path: string; ext: '.yaml' | '.md'; namespace?: string };

/**
 * Whether a team agent reached through this machine's placement record has
 * changed since this machine's copy of it was current: the version at the last
 * pull, or — for a placement that landed after it — the version it was added
 * with. Agents have no pre-push sync, so a teammate's edit made before the
 * author's next pull would otherwise be overwritten by the stale local copy
 * (#649 review). A guard, not a merge: `pull` delivers the recorded agent and
 * moves the baseline, after which the edit can be pushed.
 */
async function recordedAgentMovedOn(repoPath: string, relPath: string, lastPullRev: string | null): Promise<boolean> {
  const current = await readFileSafe(path.join(repoPath, relPath));
  if (current === null) return false;
  const baseline = (lastPullRev ? await getFileContentAtRev(repoPath, lastPullRev, `./${relPath}`) : null)
    ?? await getFileContentWhenAdded(repoPath, relPath);
  return baseline !== null && baseline.toString('utf-8') !== current;
}

function staleRecordedAgentReason(stem: string, relPath: string): string {
  return `Agent "${stem}" (${relPath}) changed on the team since this machine last synced it, `
    + 'so pushing your copy would overwrite that change. `teamai pull` replaces your copy with the team version, '
    + 'so first copy your edit aside, then pull, reapply it, and push again.';
}

/**
 * Every team file for a stem, root first, then namespaces in directory order,
 * `.yaml` before `.md` in each. A stem may legitimately live in several
 * namespaces, so `remove` needs all of them; push filters by active namespaces.
 */
export async function findTeamAgentFiles(teamAgentsDir: string, stem: string): Promise<TeamAgentFile[]> {
  const found: TeamAgentFile[] = [];
  for (const { dir, namespace } of await listTeamAgentDirs(teamAgentsDir)) {
    for (const ext of ['.yaml', '.md'] as const) {
      const candidate = path.join(dir, `${stem}${ext}`);
      if (await pathExists(candidate)) found.push({ path: candidate, ext, ...(namespace ? { namespace } : {}) });
    }
  }
  return found;
}

/** Apply native-file deltas to the canonical spec, never replace it with a
 * lossy reverse rendering. Compare against each tool's projection so omitted
 * fields (e.g. Codex tools) and other tools' metadata remain untouched. */
function mergeCanonicalEdits(
  canonical: AgentSpec,
  perTool: Partial<Record<ToolName, AgentSpec>>,
): MergeResult {
  const merged = { ...canonical };
  const extras = { ...canonical.tool_extras };
  const changes = new Map<string, { value: unknown; apply: () => void }>();
  const conflicts: Array<{ field: string; values: Record<string, unknown> }> = [];
  const propose = (key: string, value: unknown, apply: () => void) => {
    const previous = changes.get(key);
    if (previous && !isDeepStrictEqual(previous.value, value)) {
      conflicts.push({ field: key, values: { previous: previous.value, next: value } });
    } else {
      changes.set(key, { value, apply });
    }
  };

  for (const [tool, edited] of Object.entries(perTool) as Array<[ToolName, AgentSpec]>) {
    const rendered = renderForTool(canonical, tool);
    const baseline = reverseByTool(tool, `${canonical.name}${rendered.ext}`, rendered.content);
    if (!baseline.ok) return { ok: false, conflicts: [{ field: tool, values: { error: baseline.reason } }] };
    for (const field of ['name', 'description', 'instructions', 'model', 'tools'] as const) {
      if (isDeepStrictEqual(baseline.spec[field], edited[field])) continue;
      propose(field, edited[field], () => {
        const output = merged as unknown as Record<string, unknown>;
        if (edited[field] === undefined) delete output[field];
        else output[field] = edited[field];
      });
    }

    // These aliases render the base tool's private metadata; other renderers
    // own their own namespace even when they share a reverse parser.
    const extrasKey = tool === 'tclaude' ? 'claude' : tool === 'tcodex' ? 'codex' : tool;
    const before = Object.values(baseline.spec.tool_extras ?? {})[0] ?? {};
    const after = Object.values(edited.tool_extras ?? {})[0] ?? {};
    if (!isDeepStrictEqual(before, after)) {
      propose(`tool_extras.${extrasKey}`, after, () => {
        if (Object.keys(after).length) extras[extrasKey] = after;
        else delete extras[extrasKey];
      });
    }
  }
  if (conflicts.length) return { ok: false, conflicts };
  for (const change of changes.values()) change.apply();
  if (Object.keys(extras).length) merged.tool_extras = extras;
  else delete merged.tool_extras;
  return { ok: true, spec: merged };
}

/** Remove an obsolete same-stem native rendering after a format migration. */
async function removeStaleAgentSiblings(agentsDir: string, stem: string, targetExt: string): Promise<void> {
  for (const file of await listFiles(agentsDir)) {
    if (agentStemFromFilename(file) !== stem || file === `${stem}${targetExt}`) continue;
    await remove(path.join(agentsDir, file));
    log.debug(`Removed stale agent sibling ${file} for ${stem}`);
  }
}

/**
 * Whether an agent is the legacy `.md` kind, copied verbatim to Claude-shaped
 * tools rather than rendered from a spec. `scanTeamForPull` sets the flag; a
 * caller that builds an item by hand may not, so the source extension decides
 * when it is absent. Pull and the delivery check must agree on this, or one
 * renders a `.md` body as YAML while the other copies it.
 */
function isLegacyAgent(item: AgentResourceItem): boolean {
  return item.legacy === true || !item.sourcePath.endsWith('.yaml');
}

/**
 * Check if a tool name is a known agent-capable tool.
 */
function isKnownTool(tool: string): tool is ToolName {
  return (ALL_SUPPORTED_TOOLS as string[]).includes(tool);
}

/**
 * Compare a tool-native agent with its canonical team-repo definition.
 * YAML definitions must be rendered first because tools such as Codex use a
 * different on-disk format (TOML), making a raw byte comparison always differ.
 */
async function agentContentEqual(tool: string, localPath: string, teamPath: string): Promise<boolean> {
  if (!teamPath.endsWith('.yaml') || !isKnownTool(tool)) {
    return fileContentEqual(localPath, teamPath);
  }

  const canonicalContent = await readFileSafe(teamPath);
  const localContent = await readFileSafe(localPath);
  if (canonicalContent === null || localContent === null) return false;

  const parsed = parseAgentYaml(canonicalContent, path.basename(teamPath));
  if (!parsed.ok) return false;

  return localContent === renderForTool(parsed.spec, tool).content;
}

/**
 * Dispatch reverse parsing to the correct function for each tool.
 */
function reverseByTool(tool: ToolName, filePath: string, content: string): ReverseResult {
  switch (tool) {
    case 'claude':
    case 'claude-internal':
    case 'tclaude':
      return reverseFromClaude(filePath, content);
    case 'codebuddy':
      return reverseFromCodebuddy(filePath, content);
    case 'codex':
    case 'codex-internal':
    case 'tcodex':
      return reverseFromCodex(filePath, content);
    case 'cursor':
      return reverseFromCursor(filePath, content);
    case 'copilot':
      return reverseFromCopilot(filePath, content);
    case 'joycode':
      return reverseFromJoycode(filePath, content);
    case 'qoder':
      return reverseFromClaude(filePath, content);
    case 'qoder-cn':
      return reverseFromClaude(filePath, content);
    case 'kiro':
      return reverseFromKiro(filePath, content);
    case 'zcode':
      return reverseFromClaude(filePath, content);
    case 'omp':
      return reverseFromClaude(filePath, content);
    case 'opencode':
      return reverseFromOpencode(filePath, content);
  }
}
