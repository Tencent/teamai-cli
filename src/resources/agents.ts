import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { isToolInstalledForConfig, ResourceHandler } from './base.js';
import type { ResourceItem, ResourceItemStatus, TeamaiConfig, LocalConfig } from '../types.js';
import { listFiles, listDirs, pathExists, copyFile, ensureDir, remove, fileContentEqual, getFileMtime, writeFile, readFileSafe } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { resolveToolBaseDir, isAgentExcluded, isSelfMode, scopedToolPaths } from '../types.js';
import { BUILTIN_AGENT_NAMES } from '../builtin-agents.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import { isSafeNamespaceSegment } from '../projects.js';
import { assertWithinRoot } from '../utils/path-safety.js';
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
  /** True when item came from a legacy .md team-repo file (older format). */
  legacy?: boolean;
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
export class AgentsHandler extends ResourceHandler {
  readonly type = 'agents' as const;

  /**
   * Scan local AI tool agents/ directories for files that are new or modified
   * compared to the team repo. Groups by agent name stem across all tools.
   *
   * New format (.yaml in team repo): attempts multi-tool reverse + merge.
   * Built-in CLI agents are excluded from push.
   */
  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<AgentResourceItem[]> {
    const teamAgentsDir = path.join(localConfig.repo.localPath, 'agents');
    const tombstones = await this.readTombstones(localConfig);
    // Single-repo mode: users drop canonical agent files straight into the repo's
    // own .teamai/agents/ (<name>.yaml, or legacy <name>.md) rather than authoring
    // them in a tool's agents dir. Those are ALREADY in team-repo format, so we
    // pick them up directly (no reverse/merge) — diffed against the worktree's
    // origin/<default> checkout so only genuine additions/edits surface. These win
    // over the reverse-parse path below on name conflicts (explicit canonical is
    // authoritative). Active tree = projectRoot (kept intact by withKnowledgeWorktree).
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
            const basePath = path.join(localConfig.repo.localPath, relDir, file);
            const baseExists = await pathExists(basePath);
            if (baseExists && await fileContentEqual(activePath, basePath)) continue; // unchanged

            directItems.push({
              name: stem,
              type: 'agents',
              sourcePath: activePath,
              relativePath: `${relDir}/${file}`,
              status: (baseExists ? 'modified' : 'new') as ResourceItemStatus,
              legacy: isMd,
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
      const candidates = sources.filter(
        (file) => activeNamespaces === null || !file.namespace || activeNamespaces.includes(file.namespace),
      );
      if (candidates.length > 1) {
        items.push({ name: stem, type: 'agents', sourcePath: teamAgentsDir,
          relativePath: `agents/${stem}.yaml`, status: 'modified',
          skipReason: `Ambiguous agent "${stem}": multiple active sources (${candidates.map((file) => file.path).join(', ')}). Give active agents unique names before pushing.` });
        continue;
      }
      if (sources.length > 0 && candidates.length === 0) {
        items.push({ name: stem, type: 'agents', sourcePath: teamAgentsDir,
          relativePath: `agents/${stem}.yaml`, status: 'modified',
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
          if (!isKnownTool(tool) || isAgentExcluded(localConfig, tool)
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
    const isLegacy = agentItem.legacy === true || (!agentItem.legacy && !item.sourcePath.endsWith('.yaml'));

    if (isLegacy) {
      // Legacy: copy .md to tools that support agents
      await this.pullLegacyMd(item, teamConfig, localConfig);
      return;
    }

    // New YAML format: parse + render per-tool
    const content = await readFileSafe(item.sourcePath);
    if (!content) {
      log.warn(`agents: cannot read ${item.sourcePath}`);
      return;
    }

    let spec: AgentSpec;
    const parseResult: ParseResult = parseAgentYaml(content, item.name + '.yaml');
    if (!parseResult.ok) {
      console.warn(`[agents] 解析失败 ${item.name}.yaml: ${parseResult.reason}, 已跳过`);
      return;
    }
    spec = parseResult.spec;

    const targets = spec.targets ?? ALL_SUPPORTED_TOOLS;
    const scoped = scopedToolPaths(teamConfig, localConfig);

    for (const tool of targets) {
      const toolPath = scoped[tool];
      if (!toolPath?.agents) {
        log.debug(`Skipping agent sync for ${tool}: no agents path configured`);
        continue;
      }
      if (!await isToolInstalledForConfig(tool, toolPath.agents, localConfig)) {
        log.debug(`Skipping agent sync for ${tool}: tool not installed`);
        continue;
      }
      if (isAgentExcluded(localConfig, tool)) continue;

      const baseDir = resolveToolBaseDir(tool, localConfig);
      const destDir = path.join(baseDir, toolPath.agents);
      try {
        await ensureDir(destDir);
        const { ext, content: rendered } = renderForTool(spec, tool);
        await removeStaleAgentSiblings(destDir, item.name, ext);
        const dest = path.join(destDir, `${item.name}${ext}`);
        await writeFile(dest, rendered);
        log.debug(`Rendered agent ${item.name} → ${tool} (${ext})`);
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
  async removeItem(name: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const removed: string[] = [];

    const teamAgentsDir = path.join(localConfig.repo.localPath, 'agents');

    // Root or agents/<ns>/, both extensions, every namespace the stem lives in.
    for (const located of await findTeamAgentFiles(teamAgentsDir, name)) {
      await remove(located.path);
      removed.push(located.path);
    }

    await this.addTombstone(name, localConfig);

    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.agents) continue;
      // A tool the member excluded is not ours to write to, so it is not ours
      // to delete from either. This is the gate pull's tombstone pass applies.
      if (isAgentExcluded(localConfig, tool)) continue;
      const baseDir = resolveToolBaseDir(tool, localConfig);
      // Try every native agent extension: the render format varies per tool.
      for (const ext of AGENT_FILE_EXTENSIONS) {
        const filePath = path.join(baseDir, toolPath.agents, `${name}${ext}`);
        if (await pathExists(filePath)) {
          await remove(filePath);
          removed.push(filePath);
          log.debug(`Removed agent ${name} from ${tool}`);
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
    const isActive = (item: AgentResourceItem): boolean => !item.namespace || activeNamespaces.includes(item.namespace);
    const active = items.filter(isActive);
    const inactive = items.filter((item) => !isActive(item) && !BUILTIN_AGENT_NAMES.has(item.name));
    if (inactive.length === 0) return;

    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.agents || !isKnownTool(tool) || isAgentExcluded(localConfig, tool)) continue;
      if (!await isToolInstalledForConfig(tool, toolPath.agents, localConfig)) continue;
      const baseDir = resolveToolBaseDir(tool, localConfig);
      const destDir = path.join(baseDir, toolPath.agents);

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
   * What `pullItem` writes for this agent on this tool, or null when the tool
   * is not a target (legacy `.md` only reaches LEGACY_MD_TOOLS, a YAML spec
   * honours `targets`, an unparsable spec is skipped like pull skips it).
   */
  private async renderedForTool(item: AgentResourceItem, tool: ToolName): Promise<RenderResult | null> {
    const content = await readFileSafe(item.sourcePath);
    if (content === null) return null;
    if (item.legacy) {
      return LEGACY_MD_TOOLS.has(tool) ? { ext: '.md', content } : null;
    }
    const parsed = parseAgentYaml(content, `${item.name}.yaml`);
    if (!parsed.ok) return null;
    if (parsed.spec.targets && !parsed.spec.targets.includes(tool)) return null;
    return renderForTool(parsed.spec, tool);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Legacy pull: copies .md as-is to Claude-compatible tools, including JoyCode.
   */
  private async pullLegacyMd(
    item: ResourceItem,
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<void> {
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!LEGACY_MD_TOOLS.has(tool)) continue;
      if (!toolPath.agents) {
        log.debug(`Skipping legacy agent sync for ${tool}: no agents path configured`);
        continue;
      }
      if (!await isToolInstalledForConfig(tool, toolPath.agents, localConfig)) {
        log.debug(`Skipping legacy agent sync for ${tool}: tool not installed`);
        continue;
      }
      if (isAgentExcluded(localConfig, tool)) continue;

      const baseDir = resolveToolBaseDir(tool, localConfig);
      const destDir = path.join(baseDir, toolPath.agents);
      try {
        await ensureDir(destDir);
        const dest = path.join(destDir, `${item.name}.md`);
        await copyFile(item.sourcePath, dest);
        log.debug(`Synced legacy agent ${item.name} → ${tool}`);
      } catch (e) {
        log.warn(`Failed to sync legacy agent ${item.name} to ${tool}: ${(e as Error).message}`);
      }
    }
  }
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
