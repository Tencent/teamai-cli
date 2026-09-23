import path from 'node:path';
import { isToolInstalledForConfig, ResourceHandler } from './base.js';
import type { ResourceItem, ResourceItemStatus, DeliveryTarget, TeamaiConfig, LocalConfig } from '../types.js';
import { listFilesRecursive, pathExists, copyFile, ensureDir, remove, fileContentEqual, getFileMtime, listDirs, readFileSafe, writeFile } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { TEAMAI_RULES_START, TEAMAI_RULES_END, resolveBaseDir, resolveToolBaseDir, isAgentExcluded, scopedToolPaths, SELF_KNOWLEDGE_SCAN_KEY } from '../types.js';
import { EXCLUDED_RULE_NAMES } from '../builtin-rules.js';
import { teamRuleToCursorMdc, mergeCursorBodyIntoTeamMd, cursorMdcBodyEqualsTeamMd } from './cursor-mdc.js';
import {
  copilotInstructionsBodyEqualsTeamMd,
  mergeCopilotBodyIntoTeamMd,
  teamRuleToCopilotInstructions,
} from './copilot-instructions.js';
import { assertWithinRoot } from '../utils/path-safety.js';
import { loadStateForScope } from '../config.js';
import { placedResourcePath } from '../push-namespaces.js';
import { isPastVersionOf } from '../utils/git.js';
import {
  ruleFileExtensionForTool,
  ruleStemFromFilename,
  usesCursorMdcRules,
  usesCopilotInstructions,
  isLegacyCursorRuleFile,
} from './rule-format.js';

export class RulesHandler extends ResourceHandler {
  readonly type = 'rules' as const;

  /**
   * Scan for local rule .md files that are new or modified compared to the team repo.
   * Looks in ALL tool's configured rules/ directories and compares each against the
   * team repo version. When multiple tool dirs have a modified copy, picks the one
   * with the latest mtime.
   */
  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    // Recursively list team repo rules to support subdirectories
    const teamRules = new Set(
      (await pathExists(teamRulesDir))
        ? (await listFilesRecursive(teamRulesDir)).filter((f) => f.endsWith('.md'))
        : [],
    );

    // Read tombstones to skip previously deleted resources
    const tombstones = await this.readTombstones(localConfig);

    // A rule placed under rules/<ns>/ on an earlier push is still authored at
    // the tool's rules root, so matching on the full path alone would read it
    // as brand new and send a second copy to the shared root — where it would
    // reach the whole team (issue #649). state.json records where this machine
    // placed each root-level rule, and that record — not the basename — maps
    // the local copy back to its team file. A namespaced team rule is pulled
    // into a namespaced local directory, so a root-level local rule that only
    // shares a basename with one, and has no record, is unrelated and stays new.
    const placedRules = (await loadStateForScope(localConfig)).placedRules;

    // Collect the best candidate for each rule name across all tool directories
    const candidates = new Map<string, {
      sourcePath: string; mtime: number; status: ResourceItemStatus; teamRelPath: string;
    }>();
    // One read per team rule, shared across every tool dir that compares against it.
    const teamContentCache = new Map<string, string>();
    const readTeamRule = async (filePath: string): Promise<string> => {
      const cached = teamContentCache.get(filePath);
      if (cached !== undefined) return cached;
      const content = (await readFileSafe(filePath)) ?? '';
      teamContentCache.set(filePath, content);
      return content;
    };

    // Scan each tool's rules/ directory (recursively)
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      const rulesPath = toolPath.rules;
      if (!rulesPath) continue;
      // Not written or cleaned by teamai, so not a source either: `removeItem`
      // leaves an excluded tool's copy behind, and read here it would republish
      // the rule just removed (#649 review). The single-repo scan source is not
      // a tool, and `enabledAgents` — which single-repo init always writes —
      // never lists it.
      if (tool !== SELF_KNOWLEDGE_SCAN_KEY && isAgentExcluded(localConfig, tool)) continue;
      const rulesDir = path.join(resolveToolBaseDir(tool, localConfig), rulesPath);
      if (!await pathExists(rulesDir)) continue;

      // Some tools require native rule extensions and derived frontmatter.
      const ext = ruleFileExtensionForTool(tool);
      const isMdcTool = usesCursorMdcRules(tool);
      const isCopilotTool = usesCopilotInstructions(tool);

      const files = await listFilesRecursive(rulesDir);
      for (const file of files) {
        if (!file.endsWith(ext)) continue;
        // name includes subdirectory path, e.g. "common/coding-standards"
        const name = file.slice(0, -ext.length);
        if (tombstones.has(name)) continue;
        if (EXCLUDED_RULE_NAMES.has(name)) continue; // Skip CLI built-in and legacy rules

        const localFilePath = path.join(rulesDir, file);
        // Team repo always stores `.md`, keyed by rule name.
        let teamFileName = `${name}.md`;
        // The record comes first. A shared-root rule that appears later with
        // the same basename belongs to whoever added it, and mapping the
        // author's copy onto it would push their content over that rule. A
        // record whose team file is gone (rule removed, namespace renamed) no
        // longer proves anything, so the rule is new again.
        const placed = placedResourcePath(placedRules, 'rules', name);
        const placedName = placed?.slice('rules/'.length);
        if (placedName && teamRules.has(placedName)) teamFileName = placedName;

        const teamRelPath = `rules/${teamFileName}`;

        if (teamRules.has(teamFileName)) {
          // File exists in team repo — check if content differs
          const teamFilePath = path.join(teamRulesDir, teamFileName);
          // For native formats, compare markdown bodies only: frontmatter is
          // machine-derived on pull, so a clean round trip is not a change.
          const localRule = (await readFileSafe(localFilePath)) ?? '';
          const teamRule = await readTeamRule(teamFilePath);
          const equal = isMdcTool
            ? cursorMdcBodyEqualsTeamMd(
                localRule,
                teamRule,
              )
            : isCopilotTool
              ? copilotInstructionsBodyEqualsTeamMd(localRule, teamRule)
            : await fileContentEqual(localFilePath, teamFilePath);
          if (equal) continue; // This tool dir's copy is identical, skip
          // Single-repo mode: nothing refreshes the author's `.teamai/rules`
          // copy of a rule placed under a namespace — pull deploys to tool
          // dirs and the pre-push sync covers those — so a copy equal to an
          // OLDER version of the team file is one nobody edited, and pushing
          // it would revert whoever changed the rule since (#649 review).
          if (tool === SELF_KNOWLEDGE_SCAN_KEY && teamFileName === placedName
            && await isPastVersionOf(localConfig.repo.localPath, localFilePath, teamRelPath)) {
            log.warn(
              `[rules] Skipped ${name}: ${path.relative(resolveToolBaseDir(tool, localConfig), localFilePath)} is an `
              + `older version of ${teamRelPath}, which has changed on the team since. `
              + 'Copy the current file over it (or delete it) before editing.',
            );
            continue;
          }

          // Content differs — candidate for "modified"
          const mtime = await getFileMtime(localFilePath);
          const existing = candidates.get(name);
          if (!existing || mtime > existing.mtime) {
            candidates.set(name, { sourcePath: localFilePath, mtime, status: 'modified', teamRelPath });
          }
        } else {
          // File does not exist in team repo — candidate for "new".
          // Native rule directories can contain personal rules created by the
          // target tool. Keep unknown files in the .mdc, Copilot-instructions,
          // OMP, and Pi rule directories local.
          if (isMdcTool || isCopilotTool || tool === 'omp' || tool === 'pi') continue;
          const existing = candidates.get(name);
          if (!existing) {
            const mtime = await getFileMtime(localFilePath);
            candidates.set(name, { sourcePath: localFilePath, mtime, status: 'new', teamRelPath });
          } else if (existing.status === 'new') {
            // Multiple tool dirs have the same new file — pick latest mtime
            const mtime = await getFileMtime(localFilePath);
            if (mtime > existing.mtime) {
              candidates.set(name, { sourcePath: localFilePath, mtime, status: 'new', teamRelPath });
            }
          }
        }
      }
    }

    // Convert candidates map to items array
    const items: ResourceItem[] = [];
    for (const [name, candidate] of candidates) {
      // `rules/<ns>/<file>.md` is namespaced; `rules/<file>.md` is shared. State
      // it on the item so an open PR can reuse the destination, the way skills do.
      const segments = candidate.teamRelPath.split('/');
      const namespace = segments.length > 2 ? segments[1] : undefined;
      items.push({
        name,
        type: 'rules',
        sourcePath: candidate.sourcePath,
        relativePath: candidate.teamRelPath,
        status: candidate.status,
        ...(namespace ? { namespace } : {}),
      });
    }

    return items;
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const rulesDir = path.join(localConfig.repo.localPath, 'rules');
    if (!await pathExists(rulesDir)) return [];

    const files = await listFilesRecursive(rulesDir);
    return files
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({
        name: f.replace(/\.md$/, ''),
        type: 'rules' as const,
        sourcePath: path.join(rulesDir, f),
        relativePath: `rules/${f}`,
      }));
  }

  async pushItem(item: ResourceItem, _teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const rulesRoot = path.join(localConfig.repo.localPath, 'rules');
    const dest = path.resolve(localConfig.repo.localPath, item.relativePath);
    assertWithinRoot(
      rulesRoot,
      dest,
      `Invalid rule destination outside team repo rules directory: ${item.relativePath}`,
    );
    if (item.sourcePath !== dest) {
      if (item.sourcePath.endsWith('.mdc')) {
        // Source is a tool-native `.mdc`. Only its markdown body is pushed: the
        // tool frontmatter is machine-derived, and the team file keeps its own
        // tool-neutral frontmatter (`paths:`, …) — dropping that would silently
        // un-scope the rule for the whole team on the next pull.
        const raw = await readFileSafe(item.sourcePath);
        if (raw === null) {
          // Never turn an unreadable source into an empty team rule.
          throw new Error(`Cannot read rule source ${item.sourcePath}`);
        }
        await writeFile(dest, mergeCursorBodyIntoTeamMd(raw, await readFileSafe(dest)));
      } else if (item.sourcePath.endsWith('.instructions.md')) {
        const raw = await readFileSafe(item.sourcePath);
        if (raw === null) {
          throw new Error(`Cannot read rule source ${item.sourcePath}`);
        }
        await writeFile(dest, mergeCopilotBodyIntoTeamMd(raw, await readFileSafe(dest)));
      } else {
        await copyFile(item.sourcePath, dest);
      }
    }
    log.debug(`Copied rule ${item.name} → team repo`);
  }

  /**
   * Where `item` lands for each tool that receives rules. The filename is
   * tool-dependent — `.md` verbatim, `.mdc` for Cursor-compatible tools,
   * `.instructions.md` for Copilot — so a reader cannot derive it from the
   * rule's name alone.
   */
  async deliveryTargets(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    item: ResourceItem,
  ): Promise<DeliveryTarget[]> {
    // The bytes as well as the path: Cursor and Copilot read frontmatter this
    // derives from the team `.md`, so a copy whose `globs`, `alwaysApply` or
    // `applyTo` no longer match the source is inert in exactly the way a
    // missing file is. Only a comparison against the render can see that, and
    // the render belongs here rather than in a second copy inside `doctor`.
    const source = await readFileSafe(item.sourcePath);
    const localName = await this.localNameFor(item.name, localConfig);
    const targets: DeliveryTarget[] = [];
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (isAgentExcluded(localConfig, tool)) continue;
      if (!toolPath.rules) continue;

      // Skip tools that are not installed
      if (!await isToolInstalledForConfig(tool, toolPath.rules, localConfig)) {
        log.debug(`Skipping rule sync for ${tool}: tool not installed`);
        continue;
      }

      const destDir = path.join(resolveToolBaseDir(tool, localConfig), toolPath.rules);
      const ext = ruleFileExtensionForTool(tool);
      targets.push({
        tool,
        dest: path.join(destDir, `${localName}${ext}`),
        content: source === null ? undefined : renderRuleForTool(tool, source),
        ...(localName !== item.name
          ? { supersedes: path.join(destDir, `${item.name}${ext}`) }
          : {}),
      });
    }
    return targets;
  }

  /**
   * The name a delivered rule has in a tool's rules directory. It is the
   * team name — `fe-know/my-rule` lands at `rules/fe-know/my-rule.*` — except
   * for a rule THIS machine placed: push left the author's copy at the rules
   * root under the bare name, and that copy is the one the scanner and the
   * pre-push sync read, so delivery updates it rather than writing a second
   * copy beside it that a tool loading rules recursively would apply as well
   * (#649 review).
   */
  private async localNameFor(teamName: string, localConfig: LocalConfig): Promise<string> {
    const bareName = path.basename(teamName);
    if (bareName === teamName) return teamName;
    const placed = placedResourcePath(
      (await loadStateForScope(localConfig)).placedRules, 'rules', bareName,
    );
    if (placed !== `rules/${teamName}.md`) return teamName;
    // A shared-root rule of the same name owns the root path in every tool
    // dir; delivering both there would leave whichever wrote last. The
    // reconcile pass withdraws the record for this case, but delivery must
    // not depend on having run after it.
    if (await pathExists(path.join(localConfig.repo.localPath, 'rules', `${bareName}.md`))) return teamName;
    return bareName;
  }

  /**
   * Pull a single rule file to all configured AI tool rules/ directories.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    for (const { tool, dest, content, supersedes } of await this.deliveryTargets(teamConfig, localConfig, item)) {
      const destDir = path.dirname(dest);
      try {
        if (content === undefined) {
          // Never write a stub always-on rule in place of an unreadable source.
          throw new Error(`Cannot read rule source ${item.sourcePath}`);
        }
        await ensureDir(destDir);
        await writeFile(dest, content);
        // Drop the `.md` copy left by an older layout; a tool that reads a
        // derived extension does not read it, and it would outlive the rule.
        const legacyCopy = path.join(destDir, `${path.basename(dest, path.extname(dest))}.md`);
        if (dest !== legacyCopy) await remove(legacyCopy);
        // The namespaced copy an earlier pull wrote beside the author's root
        // copy: the same rule twice, for a tool that loads rules recursively.
        if (supersedes) await remove(supersedes);
        log.debug(`Synced rule ${item.name} → ${tool}`);
      } catch (e) {
        log.warn(`Failed to sync rule ${item.name} to ${tool}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * `my-rule` when push placed it at `rules/fe-know/my-rule.md`: the author
   * types the name their local copy has, which is the bare one.
   */
  async publishedNameFor(name: string, localConfig: LocalConfig): Promise<string | null> {
    const placed = placedResourcePath(
      (await loadStateForScope(localConfig)).placedRules, 'rules', name,
    );
    if (!placed) return null;
    if (!await pathExists(path.join(localConfig.repo.localPath, placed))) return null;
    return placed.slice('rules/'.length, -'.md'.length);
  }

  /**
   * Remove a rule from the team repo and all local AI tool rules/ directories.
   *
   * `name` may be the published one (`fe-know/my-rule`) or the bare one the
   * author's own copy carries (`my-rule`) — `remove` resolves the first through
   * `publishedNameFor`, so both reach the same team file. The local sweep below
   * covers both spellings, because a rule placed in a namespace leaves the
   * author's copy at the rules root while every other member receives it at
   * `rules/<ns>/`.
   */
  async removeItem(name: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const removed: string[] = [];

    // Remove from team repo (always `.md`)
    const teamFile = path.join(localConfig.repo.localPath, 'rules', `${name}.md`);
    if (await pathExists(teamFile)) {
      await remove(teamFile);
      removed.push(teamFile);
    }

    // The author's own copy is at the rules root under the bare name, whatever
    // namespace the team file ended up in. Leaving it behind re-publishes the
    // rule on the next push — but only THIS machine's placement record makes
    // that copy ours to delete. Without it, `remove rules fe/foo` would take an
    // unrelated personal .claude/rules/foo.md with it (#649 review).
    const localNames = new Set([name]);
    const bareName = path.basename(name);
    if (bareName !== name) {
      const placed = placedResourcePath(
        (await loadStateForScope(localConfig)).placedRules, 'rules', bareName,
      );
      if (placed === `rules/${name}.md`) localNames.add(bareName);
    }

    // Record a tombstone so the resource won't be re-pushed. Only the name
    // given: every member reads the tombstone, and a bare `<name>` would sweep
    // and suppress their own unrelated root rule of that name (#649 review).
    // Members hold a namespaced rule under `<ns>/`, which the published name
    // matches; the author's root copy is swept below, and a copy an excluded
    // tool keeps is not a push source (`scanLocalForPush`).
    await this.addTombstone(name, localConfig);

    // Remove from each tool's rules directory. `.mdc` tools may have an older
    // teamai layout wrote `.md` there, so both are removed — otherwise `remove`
    // would report success while leaving the rule on disk.
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.rules) continue;
      // Not ours to write to, so not ours to delete from. Same gate as the
      // tombstone pass in pull.
      if (isAgentExcluded(localConfig, tool)) continue;
      const baseDir = resolveToolBaseDir(tool, localConfig);
      const extensions = new Set<string>([ruleFileExtensionForTool(tool), '.md']);
      for (const localName of localNames) {
        for (const extension of extensions) {
          const filePath = path.join(baseDir, toolPath.rules, `${localName}${extension}`);
          if (await pathExists(filePath)) {
            await remove(filePath);
            removed.push(filePath);
            log.debug(`Removed rule ${localName} from ${tool}`);
          }
        }
      }
    }

    // Refresh CLAUDE.md references
    await this.pullAllRules(teamConfig, localConfig);

    return removed;
  }

  /**
   * Distribute rule files to each tool's rules/ directory, then update
   * CLAUDE.md with a lightweight reference list instead of inlining content.
   */
  async pullAllRules(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    filteredRules?: ResourceItem[],
  ): Promise<void> {
    const rules = filteredRules ?? await this.scanTeamForPull(teamConfig, localConfig);

    // Hermes: inline all team rules into a teamai-managed block in SOUL.md
    // (user-level standing instructions). Only when Hermes is actually
    // installed — never create ~/.hermes for users who don't use it.
    if (!isAgentExcluded(localConfig, 'hermes')) {
      const { getHermesHome } = await import('../hermes-home.js');
      if (await pathExists(getHermesHome())) {
        const { upsertSoulRules } = await import('../hermes-config.js');
        await upsertSoulRules(await hermesRulesText(rules));
      }
    }

    // OpenCode does not auto-scan a rules directory: the .md files are inert
    // until referenced from `instructions` in opencode.json. Activate (or, when
    // there are no team rules, deactivate) that glob. Runs before the empty-set
    // early return so removing the last rule also removes the glob.
    await this.activateOpencodeInstructions(teamConfig, localConfig, rules.length > 0);

    // Empty set = the team has no rules right now. We deliberately do NOT run the
    // aggressive stale-file cleanup below in that case, because it would treat a
    // user's own personal rule files as stale and delete them. Explicit team
    // removals are handled by the tombstone cleanup in pull.ts instead. The
    // OpenCode glob deactivation above still runs, so the (now unmanaged) rules
    // stop being auto-loaded.
    if (rules.length === 0) return;

    // 1. Distribute rule files to each tool's rules/ directory
    for (const rule of rules) {
      await this.pullItem(rule, teamConfig, localConfig);
    }

    // 1.5. Clean up stale local rule files not present in team repo
    const teamRuleNames = new Set(rules.map((r) => r.name));
    // A rule this machine published into a namespace keeps the author's copy at
    // the rules ROOT under its bare name. The desired set never contains that
    // name — it is `<ns>/<name>` there, or absent when the namespace is not
    // active here — so the sweep below would delete the author's own file,
    // local edits and all (#649 review). The record is what marks it as ours,
    // and only while the team file it points at still exists. Before the PR
    // merges there is no record yet — the placement is on the pending entry —
    // and the copy is just as much ours then.
    const { placedRules, pendingPushes } = await loadStateForScope(localConfig);
    for (const name of Object.keys(placedRules ?? {})) {
      const placed = placedResourcePath(placedRules, 'rules', name);
      if (placed && await pathExists(path.join(localConfig.repo.localPath, placed))) {
        teamRuleNames.add(name);
      }
    }
    // Any pending entry that carries a root-authored rule at a namespaced path,
    // not only one still marked `placed`: reconcile spends the mark on a
    // placement it cannot prove, while the PR may still be open and the copy
    // is still the author's work (#649 review).
    for (const entry of pendingPushes ?? []) {
      for (const item of entry.items) {
        if (item.type === 'rules' && !item.name.includes('/') && item.relativePath.split('/').length === 3) {
          teamRuleNames.add(item.name);
        }
      }
    }
    const tombstones = await this.readTombstones(localConfig);
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.rules) continue;
      // `pullItem` above skips excluded tools, so this pass must skip them too.
      // Without it the stale sweep deletes from a directory teamai never wrote.
      if (isAgentExcluded(localConfig, tool)) continue;
      if (!await isToolInstalledForConfig(tool, toolPath.rules, localConfig)) continue;

      const baseDir = resolveToolBaseDir(tool, localConfig);
      const destDir = path.join(baseDir, toolPath.rules);
      if (!await pathExists(destDir)) continue;

      const ext = ruleFileExtensionForTool(tool);
      const localFiles = await listFilesRecursive(destDir);
      for (const localFile of localFiles) {
        const ruleName = ruleStemFromFilename(localFile);
        if (ruleName === null) continue;

        // JoyCode, OMP, Pi, and Copilot rule directories are shared with
        // user-authored rules. Absence from the current team set is not proof
        // of TeamAI ownership (including legacy .md files); only explicit team
        // removals authorize cleanup. Cursor is deliberately absent — teamai
        // owns .cursor/rules and sweeps it.
        if ((tool === 'joycode' || tool === 'omp' || tool === 'pi' || usesCopilotInstructions(tool)) && !tombstones.has(ruleName)) continue;

        // `.mdc` tools only read `.mdc`, so any `.md` here is inert leftover from the
        // layout that predates it — removed whether or not the rule is still
        // active, and ahead of the built-in check, since built-ins now deploy to
        // target tool as `.mdc` too.
        if (isLegacyCursorRuleFile(tool, localFile)) {
          await remove(path.join(destDir, localFile));
          log.debug(`Removed legacy .md rule ${localFile} from ${tool}`);
          continue;
        }

        if (!localFile.endsWith(ext)) continue;
        // Skip built-in and legacy rules (managed by CLI, not team repo)
        if (EXCLUDED_RULE_NAMES.has(ruleName)) continue;
        if (!teamRuleNames.has(ruleName)) {
          const fullPath = path.join(destDir, localFile);
          await remove(fullPath);
          log.debug(`Removed stale rule ${localFile} from ${tool}`);
        }
      }

      // Clean up empty subdirectories
      await this.removeEmptyDirs(destDir);
    }

    // 2. Remove legacy rules section from CLAUDE.md (no longer injected)
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.claudemd) continue;
      const baseDir = resolveToolBaseDir(tool, localConfig);
      const claudeMdPath = path.join(baseDir, toolPath.claudemd);
      try {
        const content = await readFileSafe(claudeMdPath);
        if (!content || !content.includes(TEAMAI_RULES_START)) continue;
        const startIdx = content.indexOf(TEAMAI_RULES_START);
        const endIdx = content.indexOf(TEAMAI_RULES_END);
        if (startIdx === -1 || endIdx === -1) continue;
        const before = content.substring(0, startIdx).replace(/\n+$/, '\n');
        const after = content.substring(endIdx + TEAMAI_RULES_END.length).replace(/^\n+/, '\n');
        const newContent = (before + after).trim();
        if (newContent.length === 0) {
          await remove(claudeMdPath);
        } else {
          await writeFile(claudeMdPath, newContent + '\n');
        }
        log.debug(`Removed legacy rules section from ${claudeMdPath}`);
      } catch {
        // Best-effort cleanup
      }
    }
  }

  /**
   * Add or remove the teamai rules glob in OpenCode's opencode.json `instructions`
   * array, so copied rule files are actually loaded. No-op for any tool other than
   * opencode, when opencode is disabled, or when opencode is not installed (we
   * never create an opencode.json for a user who doesn't use OpenCode).
   */
  private async activateOpencodeInstructions(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    present: boolean,
  ): Promise<void> {
    const target = await this.opencodeInstructionsTarget(teamConfig, localConfig);
    if (target === null) return;

    const { reconcileOpencodeInstructions } = await import('./opencode-config.js');
    try {
      await reconcileOpencodeInstructions(target.configFile, target.glob, present);
    } catch (e) {
      log.warn(`Failed to update OpenCode instructions in ${target.configFile}: ${(e as Error).message}`);
    }
  }

  /**
   * The opencode.json this scope activates rules through, and the one glob
   * teamai owns inside it. Null when OpenCode receives no rules here:
   * excluded, not installed, or configured without a rules or config path.
   *
   * Read-only, and public for the same reason `deliveryTargets` is: OpenCode
   * does not auto-scan its rules directory, so a `.md` sitting there is inert
   * until this glob references it. A check that derived the path a second time
   * could look at a different file than the pull writes (#624).
   */
  async opencodeInstructionsTarget(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<{ configFile: string; glob: string } | null> {
    if (isAgentExcluded(localConfig, 'opencode')) return null;
    const paths = scopedToolPaths(teamConfig, localConfig)['opencode'];
    if (!paths?.rules) return null;

    const baseDir = resolveBaseDir(localConfig);
    // Only touch opencode.json when OpenCode is actually installed for this scope.
    if (!await ResourceHandler.isToolInstalled(paths.rules, baseDir)) return null;

    // The config file mirrors the MCP scope fields: <root>/opencode.json in
    // project scope, ~/.config/opencode/opencode.json in user scope.
    const configRel = localConfig.scope === 'project' ? paths.mcpProject : paths.mcp;
    if (!configRel) return null;

    const configFile = path.join(baseDir, configRel);
    const { opencodeRulesGlob } = await import('./opencode-config.js');
    return { configFile, glob: opencodeRulesGlob(configFile, path.join(baseDir, paths.rules)) };
  }

  /**
   * Recursively remove empty subdirectories under a given directory.
   */
  private async removeEmptyDirs(dir: string): Promise<void> {
    if (!await pathExists(dir)) return;
    const subdirs = await listDirs(dir);
    for (const sub of subdirs) {
      const subPath = path.join(dir, sub);
      await this.removeEmptyDirs(subPath);
      // After cleaning children, check if this dir is now empty
      const remaining = await listFilesRecursive(subPath);
      const remainingDirs = await listDirs(subPath);
      if (remaining.length === 0 && remainingDirs.length === 0) {
        await remove(subPath);
      }
    }
  }
}

/**
 * The bytes a team rule becomes for one tool. `.md` is copied verbatim;
 * Cursor-compatible tools and Copilot read frontmatter derived from the same
 * source, so their file is a render rather than a copy.
 *
 * This is the single spelling of that mapping: `pullItem` writes it and
 * `doctor` compares the delivered file against it, so a stale render is a
 * reported failure rather than a file that merely exists.
 */
function renderRuleForTool(tool: string, source: string): string {
  if (usesCursorMdcRules(tool)) return teamRuleToCursorMdc(source);
  if (usesCopilotInstructions(tool)) return teamRuleToCopilotInstructions(source);
  return source;
}

/**
 * The text `upsertSoulRules` inlines into the teamai block of Hermes SOUL.md.
 *
 * Hermes reads standing instructions from one file rather than a rules
 * directory, so its rules are delivered as this block's contents. `doctor`
 * compares what is in the block with this, the same way it compares a rule
 * file with its render.
 */
export async function hermesRulesText(rules: ResourceItem[]): Promise<string> {
  const bodies: string[] = [];
  for (const rule of rules) {
    const body = await readFileSafe(rule.sourcePath);
    if (body && body.trim() !== '') bodies.push(body.trim());
  }
  return bodies.join('\n\n');
}
