import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import matter from 'gray-matter';
import { isToolInstalledForConfig, ResourceHandler, type PlacementRecords, type ScanForPushOptions } from './base.js';
import type { CopyOrigin, ResourceItem, ResourceItemStatus, DeliveryTarget, TeamaiConfig, LocalConfig, AgentModelRecords, RecordedAgentModel } from '../types.js';
import { listFiles, listDirs, pathExists, copyFile, ensureDir, remove, fileContentEqual, getFileMtime, writeFile, readFileSafe, fileHash } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { resolveToolBaseDir, isAgentExcluded, isSelfMode, scopedToolPaths } from '../types.js';
import { BUILTIN_AGENT_NAMES } from '../builtin-agents.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import { isSafeNamespaceSegment } from '../manifest-schema.js';
import { assertWithinRoot } from '../utils/path-safety.js';
import { loadStateForScope } from '../config.js';
import { placedResourcePath } from '../push-namespaces.js';
import { recordedNamespace } from '../utils/pending-push.js';
import { itemCandidate, resolveNamespacedItems, type NamespaceResolution } from '../namespace-resolver.js';
import { getFileContentAtRev, getFileContentWhenAdded, isPastVersionOf } from '../utils/git.js';
import {
  describeMembersDirLeft, forgetDelivered, isLink, isTeamaiCopy, judgeRemoval, keepsEditedCopy, keepsTrackedCopy, recordDelivered, recordedUnchanged,
  type DeliveredHashes, type DeliveryLedger,
} from './delivered-copies.js';
import { warnOnce } from '../utils/warn-once.js';
import { TEAM_ALIASES_FILE, aliasWarningsFor, isModelAlias, loadModelAliases, localAliasesPath, resolveAgentModel, type ModelAliases, type ResolutionStep } from '../models/aliases.js';
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
  reverseFromWorkbuddy,
  mergeReverseResults,
  agentEffortField,
  toolExtrasFor,
  EXTRAS_BASE_TOOL,
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
   * Model or effort edits push leaves out because the agent's `model` is an
   * alias (#830), one message per tool. The item's other edits still push.
   */
  modelDrift?: string[];
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
 * agent deployed here. A root agent of the stem does not claim it: the
 * recorded agent replaces it, as an active namespace agent would (#707).
 *
 * This is the candidate set, root agents included; `resolveAgentsForDirectory`
 * applies the namespace rule to it. Delivery and revocation both resolve
 * through that. They must agree — when only delivery knew about the record,
 * `pull` wrote the agent and the revocation pass deleted it again in the same
 * run.
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

  const claimed = new Set(active.flatMap((agent) => (agent.namespace ? [agent.name] : [])));
  const recovered = agents.filter((agent) => agent.namespace
    && !claimed.has(agent.name)
    && placedResourcePath(placedAgents, 'agents', agent.name)
      === `agents/${agent.namespace}/${path.basename(agent.relativePath)}`);
  return recovered.length > 0 ? [...active, ...recovered] : active;
}

/**
 * The agents this directory receives, with the namespace rule applied: an
 * active (or recorded) namespace agent replaces the root agent of its stem,
 * and one stem in two active namespaces is a conflict. A recorded namespace
 * ranks after the active ones, for the message only; it never shares a stem
 * with an active namespace agent (`selectAgentsForDirectory`).
 *
 * Role/project mode only. Legacy mode delivers every namespace into one flat
 * folder, so there any shared stem is a collision (`filterAgentsByNamespaces`).
 */
export function resolveAgentsForDirectory(
  agents: ResourceItem[],
  activeNamespaces: string[],
  placedAgents?: Record<string, string>,
): NamespaceResolution<ResourceItem> {
  const selected = selectAgentsForDirectory(agents, activeNamespaces, placedAgents);
  const recorded = selected.flatMap((agent) => (
    agent.namespace && !activeNamespaces.includes(agent.namespace) ? [agent.namespace] : []
  ));
  return resolveNamespacedItems(selected.map(itemCandidate), [...new Set([...activeNamespaces, ...recorded])]);
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
    const state = await loadStateForScope(localConfig);
    const { placedAgents, lastPullRev, lastInheritedPullRev, lastPullByWorkspace, pendingPushes } = state;
    // The revisions THIS checkout's copies can be at, with the same fallback
    // as the pre-push sync: state.json is shared by every worktree, and a pull
    // in another checkout moves lastPullRev past a copy this one still holds
    // unedited (#812, #823).
    const checkoutBases = async (): Promise<string[]> => {
      const { resolveCheckoutBases } = await import('../pull.js');
      return (await resolveCheckoutBases(localConfig, { lastPullRev, lastInheritedPullRev, lastPullByWorkspace })).revs;
    };
    // Agents this machine placed in a namespace and has awaiting review: the
    // open PR is their destination, not "no active source".
    const pendingPlacedAgents = new Set((pendingPushes ?? []).flatMap((entry) => entry.items)
      .filter((item) => item.type === 'agents' && recordedNamespace(item) !== undefined)
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
    const aliases = await loadModelAliases(localConfig);
    // What each copy received at the last pull: a copy written with it is
    // unedited even after the alias has changed since (#830).
    const { recordedAgentModels, deliveredHashes } = await import('../pull.js');
    const modelRecords = await recordedAgentModels(localConfig, state);
    // A copy still holding the bytes teamai last wrote there is not an edit,
    // even when this CLI would render it differently (#830).
    const delivered = await deliveredHashes(localConfig, state);
    for (const [stem, toolFiles] of grouped) {
      // Determine if this agent is already in the team repo (root or agents/<ns>/).
      // A modified agent must be written back where it lives, so its namespace
      // directory is carried into `relativePath` below.
      const sources = await findTeamAgentFiles(teamAgentsDir, stem);
      const placedNamespace = placedResourcePath(placedAgents, 'agents', stem)?.split('/')[1];
      // Which team file this local agent is a copy of, in the order pull
      // delivers them: an active namespace source, then the one this
      // machine's record names, then the shared root, which either of the
      // first two replaces (#707). In legacy mode everything is active and
      // nothing replaces the root. Only when none exists does an explicit
      // --role/--project decide — the agent then needs a destination, and a
      // same-stem copy in some other inactive namespace is a different agent
      // that must not block it (#649 review). Letting the flag win outright
      // compared an active agent's rendering with the requested namespace's
      // file and overwrote it without an edit.
      const active = sources.filter(
        (file) => activeNamespaces === null || !file.namespace
          || activeNamespaces.includes(file.namespace),
      );
      const activeInNamespace = active.filter((file) => file.namespace);
      const recorded = placedNamespace ? sources.filter((file) => file.namespace === placedNamespace) : [];
      const atRoot = active.filter((file) => !file.namespace);
      // Two active sources stay ambiguous even under a flag: the flattened file
      // cannot say which one it was delivered from, and picking the requested
      // one compared the other's untouched copy with it (#649 review).
      const candidates = activeNamespaces === null
        ? (active.length > 0 ? active : recorded)
        : [activeInNamespace, recorded, atRoot].find((files) => files.length > 0) ?? [];
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
        // Compare like with like: native files against the rendering pull
        // writes, aliases resolved. Unchanged/untargeted copies must not join a merge.
        let unresolved: string | undefined;
        for (const [tool, filePath] of toolFiles) {
          if (!isKnownTool(tool)
            || (canonicalSpec.targets && !canonicalSpec.targets.includes(tool))) {
            toolFiles.delete(tool);
            continue;
          }
          const expected = renderResolved(canonicalSpec, tool, aliases);
          if (!expected.ok) {
            unresolved = expected.reason;
            break;
          }
          const content = await readFileSafe(filePath);
          const recorded = modelRecords[stem]?.[tool];
          if (content === expected.render.content
            || (recorded !== undefined && content === renderWithModel(canonicalSpec, tool, recorded).content)
            || (delivered?.[filePath] !== undefined && delivered[filePath] === await fileHash(filePath))) {
            toolFiles.delete(tool);
          }
        }
        // Without a resolution a deployed model cannot be told from an edit.
        if (unresolved !== undefined) {
          items.push({ name: stem, type: 'agents', sourcePath: teamYamlPath,
            relativePath: `${teamDir}/${stem}.yaml`, status: 'modified',
            skipReason: `its model cannot be resolved: ${unresolved}` });
          continue;
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
      if (located && candidates === recorded) {
        const recordedPath = `agents/${located.namespace}/${stem}${located.ext}`;
        if (await recordedAgentMovedOn(localConfig.repo.localPath, recordedPath, await checkoutBases())) {
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
        const relPath = `${teamDir}/${stem}.yaml`;
        const { merge: mergeResult, drift } = canonicalSpec
          ? mergeCanonicalEdits(canonicalSpec, perToolSpecs, { aliases, recorded: modelRecords[stem], files: toolFiles, relPath })
          : { merge: mergeReverseResults(perToolSpecs), drift: [] };
        if (!mergeResult.ok) {
          const conflictSummary = mergeResult.conflicts
            .map((c) => `${c.field}: ${JSON.stringify(c.values)}`)
            .join('; ');
          skipReason = [`conflicting values across tools — ${conflictSummary}`, ...drift].join('; ');
        } else {
          if (canonicalSpec && isDeepStrictEqual(canonicalSpec, mergeResult.spec)) {
            // Nothing else to push: the drift alone is what the member hears about.
            if (drift.length > 0) {
              items.push({ name: stem, type: 'agents', sourcePath: bestPath, relativePath: relPath, status,
                skipReason: drift.join(' '), ...(located?.namespace ? { namespace: located.namespace } : {}) });
            }
            continue;
          }
          items.push({
            name: stem,
            type: 'agents',
            sourcePath: bestPath,
            relativePath: relPath,
            status,
            mergedSpec: mergeResult.spec,
            ...(drift.length > 0 ? { modelDrift: drift } : {}),
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
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig, ledger?: DeliveryLedger): Promise<void> {
    const agentItem = item as AgentResourceItem;

    // Determine format: explicit flag takes precedence; fall back to extension detection
    const content = await readFileSafe(item.sourcePath);
    if (content === null) {
      ledger?.recorder?.failed('agents');
      log.warn(`agents: cannot read ${item.sourcePath}`);
      return;
    }

    const aliases = await aliasesForPull(localConfig, ledger);
    // Say why an agent reaches nothing before the loop silently delivers
    // nowhere: `resolveRenders` skips an unparsable spec for every tool alike.
    let spec: AgentSpec | undefined;
    let specModel: string | undefined;
    if (!isLegacyAgent(agentItem)) {
      const parseResult: ParseResult = parseAgentYaml(content, `${item.name}.yaml`);
      if (!parseResult.ok) {
        ledger?.recorder?.failed('agents');
        log.warn(`[agents] Skipped ${item.name}.yaml: ${parseResult.reason}`);
        return;
      }
      spec = parseResult.spec;
      specModel = parseResult.spec.model;
      if (specModel !== undefined) {
        const holds = await this.modelHolds(item.name, spec, teamConfig, localConfig, aliases);
        if (ledger) ledger.held.push(...holds);
        else reportHeld(holds);
      }
    } else {
      warnLegacyAlias(item, content, aliases);
    }

    const renders = await this.resolveRenders(teamConfig, localConfig, item, aliases);
    if (ledger && specModel !== undefined) warnAliasGone(item, specModel, renders, ledger.agentModels[item.name]);
    // A dropped aliases entry concerns this member only where an agent they
    // receive reads it; each is said once per pull, however many agents do.
    if (spec) {
      for (const { tool } of renders) {
        for (const warning of aliasWarningsFor(aliases, spec, tool)) warnOnce(`[agents] ${warning}`);
      }
    }
    for (const { tool, dest, render, origin } of renders) {
      const destDir = path.dirname(dest);
      try {
        if (ledger && await keepsEditedCopy(ledger, item, { tool, dest, content: render.content, origin })) continue;
        await ensureDir(destDir);
        // Only a rendered spec can leave a sibling behind: its extension follows
        // the tool's format and changes when `targets` does. A legacy `.md` is
        // copied verbatim to one extension for every tool, so a same-stem
        // `.toml`, `.json` or `.agent.md` beside it is the member's own file
        // and not ours to delete (#624 review).
        if (!isLegacyAgent(agentItem)) {
          await removeStaleAgentSiblings(destDir, item.name, render.ext, ledger, origin);
        }
        await writeFile(dest, render.content);
        if (ledger) {
          await recordDelivered(ledger.hashes, dest);
          recordAgentModel(ledger.agentModels, item.name, tool, render.model?.recorded);
        }
        ledger?.recorder?.report('agents', dest);
        log.debug(`Rendered agent ${item.name} → ${tool} (${render.ext})`);
      } catch (e) {
        ledger?.recorder?.failed('agents');
        log.warn(`Failed to sync agent ${item.name} to ${tool}: ${(e as Error).message}`);
        ledger?.failed.push({ name: item.name, tool });
      }
    }
    if (ledger?.recorder) await this.reportHeldCopies(agentItem, teamConfig, localConfig, aliases, ledger);
  }

  /**
   * A tool held for its model keeps the copy teamai delivered there before
   * (#830): still teamai's while it holds what the record says, so it stays
   * in what this pull delivered (#915).
   */
  private async reportHeldCopies(
    item: AgentResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig, aliases: ModelAliases, ledger: DeliveryLedger,
  ): Promise<void> {
    for (const { tool, dir } of await this.agentToolDirs(teamConfig, localConfig)) {
      if (!await this.heldForTool(item, tool, aliases)) continue;
      for (const file of await listFiles(dir)) {
        const copy = path.join(dir, file);
        if (agentStemFromFilename(file) === item.name && await recordedUnchanged(ledger.previous, copy)) {
          ledger.recorder?.report('agents', copy);
        }
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
  async publishedNameFor(name: string, localConfig: LocalConfig, records: PlacementRecords): Promise<string | null> {
    const placed = placedResourcePath(
      records.placedAgents, 'agents', name,
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
    const located = await findTeamAgentFiles(teamAgentsDir, name);
    // The team file a kept copy is named against, before it goes.
    const resource = located.length > 0
      ? path.relative(localConfig.repo.localPath, located[0].path).split(path.sep).join('/')
      : `agents/${name}.yaml`;
    for (const { path: teamFile } of located) {
      await remove(teamFile);
      removed.push(teamFile);
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

    // What this checkout's pulls recorded writing: a copy with no record is
    // teamai's only on proof, here as in pull (#993).
    const { deliveredHashes } = await import('../pull.js');
    const previous = await deliveredHashes(localConfig);
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
          // A link is the member's, whatever the records say: teamai never deletes one (#993).
          if (await isLink(filePath)) continue;
          // The author's root copy is this agent's by the placement record, which proves it here.
          if (localName === name && await pathExists(filePath)
            && !await ownsAgentCopy(localConfig, filePath, stem, tool, previous)) {
            log.warn(describeMembersDirLeft(filePath, resource, 'remove'));
            continue;
          }
          if (await pathExists(filePath) && !await keepsTrackedCopy(filePath)) {
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
   * The YAML agents among `items` whose copies the "Already synced" pull
   * redeploys (#830), with each copy it would write and why:
   *
   * - `model`: a tool's resolution differs from what `ledger` recorded for its
   *   copy. With no record, the copy was written by a CLI that recorded
   *   nothing and resolved no alias, so it differs only where this CLI
   *   replaces the spec's `model`. A copy the member changed is kept and
   *   queued on `ledger.kept`, so the pull names it and the step that takes
   *   the new model.
   * - `missing`: no copy, as an agent held before it was ever delivered, or
   *   one the member deleted.
   * - `render`: no record, and the copy is still what teamai delivered but
   *   not what it renders now, such as another tool's extras an older CLI
   *   wrote there. Without a delivered record nothing tells that copy from
   *   the member's edit, so it is left alone.
   *
   * A tool whose model cannot be resolved is held, so it never counts. The
   * holds of an agent it does not select are queued on `ledger.held`, as a
   * full sync queues them; `pullItem` queues those of an agent it selects.
   */
  async agentsToRedeploy(
    items: readonly ResourceItem[],
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    ledger: DeliveryLedger,
  ): Promise<{ item: ResourceItem; copies: RedeployedCopy[] }[]> {
    const aliases = await loadModelAliases(localConfig);
    const redeploy: { item: ResourceItem; copies: RedeployedCopy[] }[] = [];
    for (const item of items) {
      if (isLegacyAgent(item as AgentResourceItem)) continue;
      const copies: RedeployedCopy[] = [];
      for (const { tool, dest, render, origin } of await this.resolveRenders(teamConfig, localConfig, item, aliases)) {
        if (!render.model) continue;
        const target = { tool, dest, content: render.content, origin };
        const recorded = ledger.agentModels[item.name]?.[tool];
        const reason = !await pathExists(dest) ? 'missing'
          : recorded ? (sameAgentModel(recorded, render.model.recorded) ? undefined : 'model')
            : render.model.replacesSpecModel ? 'model'
              : await deliveredAndOutdated(ledger, dest, render.content) ? 'render' : undefined;
        if (reason === undefined) continue;
        if (reason === 'model' && await keepsEditedCopy(ledger, item, target)) continue;
        copies.push({ ...target, reason });
      }
      if (copies.length > 0) {
        redeploy.push({ item, copies });
        continue;
      }
      await this.queueHolds(item, teamConfig, localConfig, aliases, ledger);
    }
    return redeploy;
  }

  /** Queue on `ledger.held` the holds a pull of `items` would make, for `pull --dry-run` to say. */
  async queueModelHolds(
    items: readonly ResourceItem[],
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    ledger: DeliveryLedger,
  ): Promise<void> {
    const aliases = await aliasesForPull(localConfig, ledger);
    for (const item of items) await this.queueHolds(item, teamConfig, localConfig, aliases, ledger);
  }

  private async queueHolds(
    item: ResourceItem,
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    aliases: ModelAliases,
    ledger: DeliveryLedger,
  ): Promise<void> {
    if (isLegacyAgent(item as AgentResourceItem)) return;
    const content = await readFileSafe(item.sourcePath);
    const parsed = content === null ? null : parseAgentYaml(content, `${item.name}.yaml`);
    if (parsed?.ok && parsed.spec.model !== undefined) {
      ledger.held.push(...await this.modelHolds(item.name, parsed.spec, teamConfig, localConfig, aliases));
    }
  }

  /**
   * Revocation pass for role/project scoping. Removes the deployed copies of
   * every agent whose namespace is no longer active, on every installed tool,
   * and of every root agent a namespace agent now replaces.
   *
   * Data-safety gate, same as inactive skills: a file is deleted only when it
   * is byte-equal to what pull would render from the team source, with the
   * model resolved now or with the one recorded when teamai wrote the copy
   * (#830). A local edit is kept and reported so nothing unpushed is lost. An agent still deployed
   * to the same tool destination never qualifies, so a replaced root agent is
   * only removed from a tool its replacement does not target.
   */
  async cleanupInactiveNamespaces(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    activeNamespaces: string[],
  ): Promise<void> {
    const items = await this.scanTeamForPull(teamConfig, localConfig);
    // The same selection `pull` delivers with, records and overrides included:
    // revoking an agent this machine published would delete the copy pull had
    // just written, and a root agent a namespace replaces is not delivered.
    const { placedAgents } = await loadStateForScope(localConfig);
    const resolution = resolveAgentsForDirectory(items, activeNamespaces, placedAgents);
    // `pull` stops the scope on a collision before it gets here; with nothing
    // settled about what is delivered, nothing is revoked either.
    if (resolution.kind === 'conflict') return;
    const kept = new Set(resolution.items.map((item) => item.value.relativePath));
    const active = items.filter((item) => kept.has(item.relativePath));
    const inactive = items.filter(
      (item) => !kept.has(item.relativePath) && !BUILTIN_AGENT_NAMES.has(item.name),
    );
    if (inactive.length === 0) return;
    // A replacement that cannot be read or parsed delivers nothing, so the
    // root agent it replaces stays until the team repo fixes it.
    const unusable = new Set<string>();
    for (const item of active) {
      if (!await this.parsesAsAgent(item)) unusable.add(item.name);
    }
    const aliases = await loadModelAliases(localConfig);
    const { recordedAgentModels } = await import('../pull.js');
    const records = await recordedAgentModels(localConfig);

    for (const { tool, dir: destDir } of await this.agentToolDirs(teamConfig, localConfig)) {
      const activeDestinations = new Set<string>();
      // Held while its model cannot be resolved: the copy on disk may be its
      // own, and a root agent it replaces stays until it can be delivered.
      const held = new Set<string>();
      for (const item of active) {
        const rendered = await this.renderedForTool(item, tool, aliases);
        if (rendered) activeDestinations.add(`${item.name}${rendered.ext}`);
        else if (await this.heldForTool(item, tool, aliases)) held.add(item.name);
      }
      for (const item of inactive) {
        if (item.namespace === undefined && unusable.has(item.name)) continue;
        if (held.has(item.name)) continue;
        const expected = await this.renderedForTool(item, tool, aliases);
        if (!expected || activeDestinations.has(`${item.name}${expected.ext}`)) continue;
        const deployed = path.join(destDir, `${item.name}${expected.ext}`);
        // A link is the member's, whatever its target holds (#993).
        if (await isLink(deployed)) continue;
        const current = await readFileSafe(deployed);
        if (current === null) continue;
        const recorded = records[item.name]?.[tool];
        const recordedRender = recorded ? await this.renderedForTool(item, tool, aliases, recorded) : null;
        if (current !== expected.content && current !== recordedRender?.content) {
          log.warn(`[${localConfig.scope}] Kept agent "${item.name}" (${tool}): it differs from the team source ${item.relativePath}. Back it up, then delete it manually.`);
          continue;
        }
        if (await keepsTrackedCopy(deployed)) continue;
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
    aliases?: ModelAliases,
    recorded?: Readonly<Record<string, RecordedAgentModel>>,
  ): Promise<{ tool: ToolName; dest: string; render: AgentRender; origin: CopyOrigin }[]> {
    const agentItem = item as AgentResourceItem;
    const renders: { tool: ToolName; dest: string; render: AgentRender; origin: CopyOrigin }[] = [];
    const modelAliases = aliases ?? await loadModelAliases(localConfig);

    for (const { tool, dir } of await this.agentToolDirs(teamConfig, localConfig)) {
      const render = await this.renderedForTool(agentItem, tool, modelAliases, recorded?.[tool]);
      if (!render) continue;

      const origin = agentOrigin(localConfig.repo.localPath, item.name, tool, modelAliases);
      renders.push({ tool, dest: path.join(dir, `${item.name}${render.ext}`), render, origin });
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
      .map(({ tool, dest, render, origin }) => ({ tool, dest, content: render.content, origin }));
  }

  /**
   * `deliveryTargets` with each copy rendered with the model the last pull
   * recorded for it, where there is one. Push never writes an alias's model
   * (#830), so a changed resolution alone is not a change push replaces.
   */
  async recordedDeliveryTargets(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    item: ResourceItem,
  ): Promise<DeliveryTarget[]> {
    const { recordedAgentModels } = await import('../pull.js');
    const records = await recordedAgentModels(localConfig);
    return (await this.resolveRenders(teamConfig, localConfig, item, undefined, records[item.name]))
      .map(({ tool, dest, render, origin }) => ({ tool, dest, content: render.content, origin }));
  }

  /** Whether `item`'s team file can be read and, for a YAML spec, parses. */
  private async parsesAsAgent(item: AgentResourceItem): Promise<boolean> {
    const content = await readFileSafe(item.sourcePath);
    if (content === null) return false;
    return isLegacyAgent(item) || parseAgentYaml(content, `${item.name}.yaml`).ok;
  }

  /**
   * What `pullItem` writes for this agent on this tool, or null when the tool
   * is not a target (legacy `.md` only reaches LEGACY_MD_TOOLS, a YAML spec
   * honours `targets`, an unparsable spec is skipped like pull skips it) or
   * its model cannot be resolved, which holds the deployed copy. With
   * `recorded`, the bytes it wrote with that recorded model instead.
   */
  private async renderedForTool(
    item: AgentResourceItem,
    tool: ToolName,
    aliases: ModelAliases,
    recorded?: RecordedAgentModel,
  ): Promise<AgentRender | null> {
    const content = await readFileSafe(item.sourcePath);
    if (content === null) return null;
    if (isLegacyAgent(item)) {
      return LEGACY_MD_TOOLS.has(tool) ? { ext: '.md', content } : null;
    }
    const parsed = parseAgentYaml(content, `${item.name}.yaml`);
    if (!parsed.ok) return null;
    if (parsed.spec.targets && !parsed.spec.targets.includes(tool)) return null;
    if (recorded) return renderWithModel(parsed.spec, tool, recorded);
    const resolved = renderResolved(parsed.spec, tool, aliases);
    return resolved.ok ? resolved.render : null;
  }

  /**
   * The holds pull queues for an agent with a `model` while it cannot be
   * resolved in a tool it targets. Some tools can fail alone, such as those
   * whose model switch cannot be read.
   */
  private async modelHolds(
    name: string,
    spec: AgentSpec,
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    aliases: ModelAliases,
  ): Promise<DeliveryLedger['held']> {
    const heldTools = new Map<string, ToolName[]>();
    let targeted = 0;
    for (const { tool } of await this.agentToolDirs(teamConfig, localConfig)) {
      if (spec.targets && !spec.targets.includes(tool)) continue;
      targeted += 1;
      const resolution = resolveAgentModel(aliases, spec, tool);
      if (!resolution.ok) heldTools.set(resolution.reason, [...heldTools.get(resolution.reason) ?? [], tool]);
    }
    const heldCount = [...heldTools.values()].reduce((sum, tools) => sum + tools.length, 0);
    // A load failure holds only the tools that fail for it: an extras model pin
    // needs no aliases, and the member's file only holds an alias agent. The
    // line names those tools when others were written.
    if (heldCount === 0) return [];
    const everyTool = heldCount === targeted;
    const loadFailure = !aliases.ok ? aliases.reason : aliases.localFailure;
    return loadFailure !== undefined
      ? [{ name, reason: loadFailure, ...(everyTool ? {} : { tools: [...heldTools.values()].flat() }), everyTool }]
      : [...heldTools].map(([reason, tools]) => ({ name, reason, tools, everyTool }));
  }

  /** Whether `tool` would receive `item` but for a model that cannot be resolved. */
  private async heldForTool(item: AgentResourceItem, tool: ToolName, aliases: ModelAliases): Promise<boolean> {
    if (isLegacyAgent(item)) return false;
    const content = await readFileSafe(item.sourcePath);
    const parsed = content === null ? null : parseAgentYaml(content, `${item.name}.yaml`);
    if (!parsed?.ok || (parsed.spec.targets && !parsed.spec.targets.includes(tool))) return false;
    return !resolveAgentModel(aliases, parsed.spec, tool).ok;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

}

// ─── Module-level helpers ──────────────────────────────────────────────────

/**
 * The model aliases, loaded once per ledger: a ledger lives for one pull of
 * one checkout, which reads the same alias files and switch state for every
 * agent (model profiles are synced before it opens). Without one, each call
 * loads afresh.
 */
const aliasesByLedger = new WeakMap<DeliveryLedger, Promise<ModelAliases>>();

function aliasesForPull(localConfig: LocalConfig, ledger: DeliveryLedger | undefined): Promise<ModelAliases> {
  if (!ledger) return loadModelAliases(localConfig);
  let aliases = aliasesByLedger.get(ledger);
  if (!aliases) {
    aliases = loadModelAliases(localConfig);
    aliasesByLedger.set(ledger, aliases);
  }
  return aliases;
}

/**
 * Say which agents pull held because their model cannot be resolved, one line
 * per reason and set of tools however many agents share it, and empty the
 * ledger's list. Returns how many of them no tool they target received.
 * With `dryRunScope`, says it as `pull --dry-run` does: what it would hold.
 */
export function reportHeldAgents(ledger: DeliveryLedger, dryRunScope?: string): number {
  const held = ledger.held.splice(0);
  reportHeld(held, dryRunScope === undefined ? '[agents] Held' : `[${dryRunScope}] [dry-run] Would hold`);
  return new Set(held.filter((hold) => hold.everyTool).map((hold) => hold.name)).size;
}

function reportHeld(held: DeliveryLedger['held'], lead = '[agents] Held'): void {
  const byCause = new Map<string, { reason: string; tools?: string[]; names: string[] }>();
  for (const { name, reason, tools } of held) {
    const key = `${tools?.join(',') ?? ''}\n${reason}`;
    const group = byCause.get(key) ?? { reason, ...(tools ? { tools } : {}), names: [] };
    if (!group.names.includes(name)) group.names.push(name);
    byCause.set(key, group);
  }
  for (const { reason, tools, names } of byCause.values()) {
    const files = names.map((name) => `${name}.yaml`).join(', ');
    const its = names.length === 1 ? 'Its' : 'Their';
    log.warn(tools
      ? `${lead} ${files} for ${tools.join(', ')}: ${reason}. ${its} copies there are kept, and none are written, until that is fixed.`
      : `${lead} ${files}: ${reason}. ${its} deployed copies are kept and no new ones are written until the file is fixed.`);
  }
}

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
 * changed since this checkout's copy of it was current: the version at any of
 * the checkout's bases, or — for a placement that landed after one of them —
 * the version it was added with. Agents have no pre-push sync, so a teammate's
 * edit made before the author's next pull would otherwise be overwritten by the
 * stale local copy (#649 review). The copy stays at the revision pull delivered
 * while push bases move on (push records the team HEAD before the scan), so a
 * difference from any of those versions counts. A guard, not a merge: pull
 * keeps the edited copy (#822), so the member takes the team version by
 * deleting it and pulling, which resets the bases, then reapplies the edit.
 */
async function recordedAgentMovedOn(repoPath: string, relPath: string, bases: readonly string[]): Promise<boolean> {
  const current = await readFileSafe(path.join(repoPath, relPath));
  if (current === null) return false;
  const baselines: Buffer[] = [];
  for (const rev of bases) {
    const content = await getFileContentAtRev(repoPath, rev, `./${relPath}`);
    if (content !== null) baselines.push(content);
  }
  if (baselines.length < bases.length || bases.length === 0) {
    const added = await getFileContentWhenAdded(repoPath, relPath);
    if (added !== null) baselines.push(added);
  }
  return baselines.some((baseline) => baseline.toString('utf-8') !== current);
}

function staleRecordedAgentReason(stem: string, relPath: string): string {
  return `Agent "${stem}" (${relPath}) changed on the team since this checkout last synced it, `
    + 'so pushing your copy would overwrite that change. `teamai pull` keeps a copy you changed, '
    + 'so copy your edit aside, delete your copy, run `teamai pull --force`, reapply the edit, and push again.';
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

/** The spec fields reverse parsing reads from a native copy, outside `tool_extras`. */
const ROOT_AGENT_FIELDS = ['name', 'description', 'instructions', 'model', 'tools'] as const;

/** What push needs to tell a deployed alias model from a member's edit. */
interface PushModelContext {
  aliases: ModelAliases;
  /** What the last pull recorded for this agent's copies, by tool. */
  recorded: Readonly<Record<string, RecordedAgentModel>> | undefined;
  /** Each edited tool's deployed file. */
  files: ReadonlyMap<string, string>;
  /** The canonical file, team-relative. */
  relPath: string;
}

/** Apply native-file deltas to the canonical spec, never replace it with a
 * lossy reverse rendering. Compare against each tool's projection so omitted
 * fields (e.g. Codex tools) and other tools' metadata remain untouched.
 *
 * While the canonical `model` is an alias (#830), each tool's model and the
 * effort the alias writes are the alias's, not the member's: they are left
 * out of the deltas, so the alias is never replaced by a concrete model or
 * pinned into `tool_extras`. A copy whose values match neither the recorded
 * nor the current resolution is `drift`, reported and not pushed. Only an
 * alias name written in its place is proposed, as `model: <alias>`. */
function mergeCanonicalEdits(
  canonical: AgentSpec,
  perTool: Partial<Record<ToolName, AgentSpec>>,
  context: PushModelContext,
): { merge: MergeResult; drift: string[] } {
  const { aliases } = context;
  const canonicalAlias = canonical.model !== undefined && isModelAlias(aliases, canonical.model);
  const drift: string[] = [];
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
    // The baseline is what pull deployed, so a resolved alias is not an edit.
    const resolved = renderResolved(canonical, tool, aliases);
    if (!resolved.ok) return { merge: { ok: false, conflicts: [{ field: tool, values: { error: resolved.reason } }] }, drift };
    const rendered = resolved.render;
    const baseline = reverseByTool(tool, `${canonical.name}${rendered.ext}`, rendered.content);
    if (!baseline.ok) return { merge: { ok: false, conflicts: [{ field: tool, values: { error: baseline.reason } }] }, drift };
    const before: Record<string, unknown> = { ...Object.values(baseline.spec.tool_extras ?? {})[0] };
    const after: Record<string, unknown> = { ...Object.values(edited.tool_extras ?? {})[0] };
    // tclaude and tcodex also render what `claude` and `codex` carry.
    const base = EXTRAS_BASE_TOOL[tool];
    const inherited: Record<string, unknown> = (base && canonical.tool_extras?.[base]) || {};
    // A model pin, the tool's own or inherited, reaches the copy as its native
    // `model`, which reverse parsing reads as the root field: compared as an
    // extras key, a change to it stays this tool's, and the root model and the
    // base tool's pin are kept.
    const modelPin = !canonicalAlias && toolExtrasFor(canonical, tool)?.['model'] !== undefined;
    if (modelPin) {
      before['model'] = baseline.spec.model;
      if (edited.model !== undefined) after['model'] = edited.model;
    }
    // The canonical agent stopped using an alias since the last pull: the
    // model and effort that alias wrote, still as recorded, are not edits.
    let aliasWroteModel = false;
    const recorded = context.recorded?.[tool];
    if (!canonicalAlias && recorded !== undefined && !KEEPS_SPEC_MODEL.has(recorded.step)) {
      aliasWroteModel = edited.model === recorded.model;
      const field = agentEffortField(tool);
      if (field !== undefined && recorded.effort !== undefined && after[field] === recorded.effort) {
        if (field in before) after[field] = before[field];
        else delete after[field];
      }
    }

    if (canonicalAlias) {
      const expected = rendered.model!.recorded;
      // The effort field is the alias's unless an extras model skips the
      // alias or the extras set that field themselves.
      const field = agentEffortField(tool);
      const effortField = expected.step !== 'extras' && field !== undefined && toolExtrasFor(canonical, tool)?.[field] === undefined
        ? field
        : undefined;
      const deployed = { model: edited.model, effort: effortField === undefined ? undefined : after[effortField] };
      if (effortField !== undefined) {
        delete before[effortField];
        delete after[effortField];
      }
      // What pull wrote, as recorded or as it would write now, is unedited,
      // even a model that is also an alias name.
      const known = [expected, ...(recorded ? [recorded] : [])];
      const unedited = known.some((value) => value.model === deployed.model && (effortField === undefined || value.effort === deployed.effort));
      // An extras model pin is the author's value, even one named like an
      // alias: a change to it is an extras edit, not an adoption.
      if (unedited) {
        // Nothing to propose or report.
      } else if (deployed.model !== undefined && expected.step !== 'extras' && isModelAlias(aliases, deployed.model)
        && !known.some((value) => value.model === deployed.model)) {
        if (deployed.model !== canonical.model) {
          const alias = deployed.model;
          propose('model', alias, () => { merged.model = alias; });
        }
      } else {
        drift.push(modelDrift({
          tool, file: context.files.get(tool) ?? tool, alias: canonical.model!, relPath: context.relPath,
          deployed, expected, effortField,
        }));
      }
    }

    for (const field of ROOT_AGENT_FIELDS) {
      if (field === 'model' && (canonicalAlias || aliasWroteModel || modelPin)) continue;
      if (isDeepStrictEqual(baseline.spec[field], edited[field])) continue;
      propose(field, edited[field], () => {
        const output = merged as unknown as Record<string, unknown>;
        if (edited[field] === undefined) delete output[field];
        else output[field] = edited[field];
      });
    }

    // Each tool owns the extras key renderForTool reads for it. For tclaude
    // and tcodex the values that differ from the base tool's are theirs, as
    // are their own keys while unchanged; a removed inherited key cannot be
    // expressed there and is reported rather than dropped. Keys reverse parsing reads as root fields
    // are never in `after`, so only a model pin put there counts.
    // Alias-owned fields are already out of `before` and `after`, and never inherited.
    if (!isDeepStrictEqual(before, after)) {
      const removed = Object.keys(inherited)
        .filter((key) => !(key in after) && (!(ROOT_AGENT_FIELDS as readonly string[]).includes(key) || (key === 'model' && modelPin)));
      if (base && removed.length) {
        conflicts.push({ field: `tool_extras.${tool}`, values: { inheritedFrom: `tool_extras.${base}`, removed } });
        continue;
      }
      const ownBefore = canonical.tool_extras?.[tool] ?? {};
      const own = Object.fromEntries(Object.entries(after).filter(([key, value]) =>
        !isDeepStrictEqual(inherited[key], value) || (key in ownBefore && isDeepStrictEqual(before[key], value))));
      propose(`tool_extras.${tool}`, own, () => {
        if (Object.keys(own).length) extras[tool] = own;
        else delete extras[tool];
      });
    }
  }
  if (conflicts.length) return { merge: { ok: false, conflicts }, drift };
  for (const change of changes.values()) change.apply();
  if (Object.keys(extras).length) merged.tool_extras = extras;
  else delete merged.tool_extras;
  return { merge: { ok: true, spec: merged }, drift };
}

/**
 * Why a copy's model or effort is not pushed, and where the member can make
 * that change instead: the step that produced the model decides.
 */
function modelDrift({ tool, file, alias, relPath, deployed, expected, effortField }: {
  tool: ToolName;
  file: string;
  alias: string;
  relPath: string;
  deployed: { model?: string; effort?: unknown };
  expected: RecordedAgentModel;
  effortField: string | undefined;
}): string {
  const describe = (values: { model?: string; effort?: unknown }): string => {
    const model = values.model === undefined ? 'no model' : `model "${values.model}"`;
    return effortField === undefined || values.effort === undefined ? model : `${model} and ${effortField} "${String(values.effort)}"`;
  };
  const local = localAliasesPath();
  const team = expected.source ?? TEAM_ALIASES_FILE;
  const entry = `${alias}.${tool}`;
  const [source, hint] = ((): [string, string] => {
    switch (expected.step) {
      case 'switched':
        return [`, because ${tool} is switched to a model profile`,
          `Run \`teamai models restore --agent ${tool}\` to take ${tool} off the profile, or switch it to another one.`];
      case 'local':
        return [` from your ${local}`, `To use it, change ${entry} in ${local}.`];
      case 'extras':
        return [` from tool_extras.${tool}.model in ${relPath}`, `To pin another model, change tool_extras.${tool}.model in ${relPath}.`];
      case 'team':
        return [` from the team's ${team}`,
          `To use it on this machine, map ${entry} in ${local}; for the whole team, change ${entry} in ${team}.`];
      default:
        return [`, as no aliases file maps ${entry}`,
          `To use it on this machine, map ${entry} in ${local}; for the whole team, map ${entry} in ${team}.`];
    }
  })();
  return `its ${tool} copy (${file}) sets ${describe(deployed)}, but model: ${alias} gives ${tool} ${describe(expected)}${source}. `
    + `Push never writes a concrete model over a model alias, so this change stays on this machine. ${hint}`;
}

/** A copy the "Already synced" pull writes, and why: see `AgentsHandler.agentsToRedeploy`. */
export type RedeployedCopy = DeliveryTarget & { reason: 'model' | 'missing' | 'render' };

/** What pull writes for one tool: the bytes, and for a YAML spec the model they carry. */
type AgentRender = RenderResult & { model?: DeployedModel };

interface DeployedModel {
  /** What pull records for the copy once it writes these bytes. */
  recorded: RecordedAgentModel;
  /** The spec's own `model` is replaced, which a CLI without aliases wrote as is. */
  replacesSpecModel: boolean;
}

/**
 * The extras each tool's copy carried before #830 gave every tool its own
 * key: Qoder, Qoder CN, ZCode and OMP rendered Claude's, tclaude and tcodex
 * their base tool's only. 0.26.0 and earlier wrote these, with the spec's
 * `model` as written and no delivery record.
 */
const PRE_830_EXTRAS_TOOL: Readonly<Partial<Record<ToolName, ToolName>>> = {
  qoder: 'claude', 'qoder-cn': 'claude', zcode: 'claude', omp: 'claude', tclaude: 'claude', tcodex: 'codex',
};

/**
 * How a file with no record in `tool`'s agents directory is proven teamai's
 * (#993): it holds a version of a team agent named `stem`, in any namespace
 * (agents land flat, so same-stem agents share the file), verbatim (a legacy
 * `.md`), as pull renders that version for `tool` today, aliases resolved, or
 * as an older CLI rendered it: the spec's `model` as written (before aliases),
 * and before #830 another tool's extras (`PRE_830_EXTRAS_TOOL`).
 */
export function agentOrigin(repoPath: string, stem: string, tool: ToolName, aliases: ModelAliases): CopyOrigin {
  const specOf = (content: Buffer, version: { path: string }): AgentSpec | null => {
    const file = path.posix.basename(version.path);
    if (file !== `${stem}.yaml`) return null;
    const parsed = parseAgentYaml(content.toString('utf-8'), file);
    if (!parsed.ok || (parsed.spec.targets && !parsed.spec.targets.includes(tool))) return null;
    return parsed.spec;
  };
  const extrasTool = PRE_830_EXTRAS_TOOL[tool];
  return {
    repoPath,
    pathspec: `:(glob)agents/**/${stem}.*`,
    renders: [
      (content, version) => {
        const spec = specOf(content, version);
        const resolved = spec && renderResolved(spec, tool, aliases);
        return resolved?.ok ? resolved.render.content : null;
      },
      (content, version) => {
        const spec = specOf(content, version);
        return spec && renderForTool(spec, tool).content;
      },
      ...extrasTool ? [(content: Buffer, version: { path: string }) => {
        const spec = specOf(content, version);
        return spec && renderForTool(spec, extrasTool).content;
      }] : [],
    ],
  };
}

/** `agentOrigin` for a copy of a removed agent; for a tool teamai renders no agents for, the team agents verbatim. */
export async function removedAgentOrigin(localConfig: LocalConfig, stem: string, tool: string): Promise<CopyOrigin> {
  // A tool teamai renders no agents for still gets a proof: the team agents' own bytes, verbatim (#993).
  if (!isKnownTool(tool)) return { repoPath: localConfig.repo.localPath, pathspec: `:(glob)agents/**/${stem}.*` };
  return agentOrigin(localConfig.repo.localPath, stem, tool, await loadModelAliases(localConfig));
}

/**
 * Whether `file`, a copy of agent `stem` in `tool`'s agents directory, is
 * teamai's to delete in a command the member ran (`teamai remove`,
 * `uninstall`; #993): a built-in's name, on `previous`, the checkout's
 * record, edited since or not, or a version of a team agent of that stem by
 * the team history, verbatim or as teamai rendered it for `tool`. Read-only.
 */
export async function ownsAgentCopy(
  localConfig: LocalConfig, file: string, stem: string, tool: string, previous: DeliveredHashes | undefined,
): Promise<boolean> {
  if (await isLink(file)) return false;
  if (BUILTIN_AGENT_NAMES.has(stem) || previous?.[file] !== undefined) return true;
  const origin = await removedAgentOrigin(localConfig, stem, tool);
  return isTeamaiCopy(file, origin);
}

/**
 * What `tool` receives for `spec`, its model aliases resolved: the one
 * rendering pull writes and push compares against. Fails while the model
 * cannot be resolved, which holds the tool's copy.
 */
function renderResolved(
  spec: AgentSpec,
  tool: ToolName,
  aliases: ModelAliases,
): { ok: true; render: AgentRender } | { ok: false; reason: string } {
  const resolution = resolveAgentModel(aliases, spec, tool);
  if (!resolution.ok) return resolution;
  const { ok: _ok, ...resolved } = resolution;
  return { ok: true, render: renderWithModel(spec, tool, resolved) };
}

/**
 * `spec` rendered for `tool` with `resolved`, a resolution or its record. An
 * extras model and a literal render as written; only an alias is replaced,
 * so an agent without one has the same bytes as before aliases existed.
 */
function renderWithModel(spec: AgentSpec, tool: ToolName, resolved: RecordedAgentModel): AgentRender {
  const replacesSpecModel = spec.model !== undefined && !KEEPS_SPEC_MODEL.has(resolved.step);
  const recorded: RecordedAgentModel = {
    step: resolved.step,
    ...(resolved.model !== undefined ? { model: resolved.model } : {}),
    ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
    ...(resolved.source !== undefined ? { source: resolved.source } : {}),
    ...(replacesSpecModel ? { alias: spec.model } : {}),
  };
  const rendered = resolved.step === 'switched' ? withoutExtrasEffort(spec, tool) : spec;
  return { ...renderForTool(rendered, tool, replacesSpecModel ? recorded : undefined), model: { recorded, replacesSpecModel } };
}

/**
 * `spec` without the effort its extras set for `tool`, which a tool switched
 * to a model profile never receives. Only a tool id is switched, never a
 * variant, so its own extras key is the one it reads.
 */
function withoutExtrasEffort(spec: AgentSpec, tool: ToolName): AgentSpec {
  const field = agentEffortField(tool);
  const own = spec.tool_extras?.[tool];
  if (field === undefined || own?.[field] === undefined) return spec;
  const { [field]: _dropped, ...rest } = own;
  return { ...spec, tool_extras: { ...spec.tool_extras, [tool]: rest } };
}

/** The steps that leave the spec's `model` as written: every other one comes from an alias. */
const KEEPS_SPEC_MODEL: ReadonlySet<string> = new Set<ResolutionStep>(['extras', 'literal']);

/** Whether two records or resolutions give a copy the same model. The alias name is not compared: records written before it lack it. */
export function sameAgentModel(a: RecordedAgentModel, b: RecordedAgentModel): boolean {
  return a.step === b.step && a.model === b.model && a.effort === b.effort && a.source === b.source;
}

/** Whether the copy at `dest` is still what teamai delivered there, and not `content`. */
async function deliveredAndOutdated(ledger: DeliveryLedger, dest: string, content: string): Promise<boolean> {
  const delivered = ledger.previous?.[dest];
  return delivered !== undefined && await fileHash(dest) === delivered && await readFileSafe(dest) !== content;
}

/**
 * Record what `tool`'s copy of `stem` received. A legacy `.md` carries no
 * resolved model, so writing one over a YAML agent's copy drops that record.
 */
function recordAgentModel(records: AgentModelRecords, stem: string, tool: ToolName, recorded: RecordedAgentModel | undefined): void {
  if (recorded) {
    records[stem] = { ...records[stem], [tool]: recorded };
    return;
  }
  const byTool = records[stem];
  if (!byTool) return;
  delete byTool[tool];
  if (Object.keys(byTool).length === 0) delete records[stem];
}

/**
 * An alias the team removed turns `model: <name>` into a literal model name
 * no tool knows. Said when a copy that received `<name>` as an alias at the
 * last pull, a model or the tool's default, is about to receive the name itself.
 */
function warnAliasGone(
  item: ResourceItem,
  specModel: string,
  renders: readonly { tool: ToolName; render: AgentRender }[],
  records: Record<string, RecordedAgentModel> | undefined,
): void {
  if (!records) return;
  const was = renders.find(({ tool, render }) => {
    const recorded = records[tool];
    if (render.model?.recorded.step !== 'literal' || recorded === undefined || KEEPS_SPEC_MODEL.has(recorded.step)) return false;
    // A record written before records named the alias tells only by a model,
    // which a formerly model-less agent never had.
    return recorded.alias !== undefined ? recorded.alias === specModel : recorded.model !== undefined;
  });
  if (!was) return;
  const { model: before, source } = records[was.tool]!;
  const received = before === undefined ? 'no model field' : `"${before}"`;
  // A local entry counts only for a name a team file defines, so the team file is where it goes back.
  const file = source !== undefined && !path.isAbsolute(source) ? source : TEAM_ALIASES_FILE;
  log.warn(`[agents] ${item.relativePath} sets model: ${specModel}, which is no longer a model alias, so each tool now receives "${specModel}" literally `
    + `(${was.tool} received ${received} at the last pull). Define "${specModel}" in ${file} again, or set a concrete model in ${item.relativePath}.`);
}

/**
 * A legacy `.md` is copied byte for byte, so an alias in its `model` reaches
 * the tool as a literal model name no tool knows.
 */
function warnLegacyAlias(item: ResourceItem, content: string, aliases: ModelAliases): void {
  let model: unknown;
  try {
    model = (matter(content).data as Record<string, unknown>)['model'];
  } catch {
    return;
  }
  if (typeof model !== 'string' || !isModelAlias(aliases, model)) return;
  log.warn(`[agents] ${item.relativePath} sets model: ${model}, a model alias, but a legacy .md agent is copied as is, `
    + `so each tool receives "${model}" literally. Move it to ${item.relativePath.replace(/\.md$/, '.yaml')} to have the alias resolved.`);
}

/**
 * Remove an obsolete same-stem native rendering after a format migration:
 * only a file the checkout's record or the team history (`origin`) proves
 * teamai's (#993). A same-stem file of the member's stays, named.
 */
async function removeStaleAgentSiblings(
  agentsDir: string, stem: string, targetExt: string, ledger: DeliveryLedger | undefined, origin: CopyOrigin | undefined,
): Promise<void> {
  for (const file of await listFiles(agentsDir)) {
    if (agentStemFromFilename(file) !== stem || file === `${stem}${targetExt}`) continue;
    const sibling = path.join(agentsDir, file);
    const removal = await judgeRemoval(ledger?.previous, sibling, origin, ledger?.otherRecords);
    if (removal === 'edited') {
      warnOnce(`Kept ${sibling}: teamai no longer writes ${stem} in this format, but you changed this copy. Delete it when you no longer need it.`);
      continue;
    }
    if (removal === 'notTeamais') {
      warnOnce(describeMembersDirLeft(sibling, `agents/${stem}`, 'pull'));
      continue;
    }
    if (await keepsTrackedCopy(sibling, path.join(agentsDir, `${stem}${targetExt}`))) continue;
    await remove(sibling);
    if (ledger) forgetDelivered(ledger.hashes, sibling);
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
 * Dispatch reverse parsing to the correct function for each tool, keying the
 * extras by that tool: several tools share a parser, and each renders its own key.
 */
function reverseByTool(tool: ToolName, filePath: string, content: string): ReverseResult {
  const result = reverseByParser(tool, filePath, content);
  const extras = result.ok ? Object.values(result.spec.tool_extras ?? {})[0] : undefined;
  if (result.ok && extras) result.spec.tool_extras = { [tool]: extras };
  return result;
}

function reverseByParser(tool: ToolName, filePath: string, content: string): ReverseResult {
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
    case 'workbuddy':
      return reverseFromWorkbuddy(filePath, content);
  }
}
