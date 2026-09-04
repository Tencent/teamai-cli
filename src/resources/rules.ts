import path from 'node:path';
import { ResourceHandler } from './base.js';
import type { ResourceItem, ResourceItemStatus, TeamaiConfig, LocalConfig } from '../types.js';
import { listFilesRecursive, pathExists, copyFile, ensureDir, remove, fileContentEqual, getFileMtime, listDirs, readFileSafe, writeFile } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { TEAMAI_RULES_START, TEAMAI_RULES_END, resolveBaseDir, isAgentDisabled, scopedToolPaths, effectiveToolPaths } from '../types.js';
import { EXCLUDED_RULE_NAMES } from '../builtin-rules.js';
import { teamRuleToCursorMdc, mergeCursorBodyIntoTeamMd, cursorMdcBodyEqualsTeamMd } from './cursor-mdc.js';
import {
  ruleFileExtensionForTool,
  ruleStemFromFilename,
  usesCursorMdcRules,
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

    // Collect the best candidate for each rule name across all tool directories
    const candidates = new Map<string, { sourcePath: string; mtime: number; status: ResourceItemStatus }>();
    // One read per team rule, shared across every tool dir that compares against it.
    const teamContentCache = new Map<string, string>();
    const readTeamRule = async (filePath: string): Promise<string> => {
      const cached = teamContentCache.get(filePath);
      if (cached !== undefined) return cached;
      const content = (await readFileSafe(filePath)) ?? '';
      teamContentCache.set(filePath, content);
      return content;
    };

    // Scan each tool's rules/ directory (push stays within team-managed tools)
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      const rulesPath = toolPath.rules;
      if (!rulesPath) continue;
      const rulesDir = path.join(resolveBaseDir(localConfig), rulesPath);
      if (!await pathExists(rulesDir)) continue;

      // Cursor stores rules as `.mdc`; every other tool as `.md`.
      const ext = ruleFileExtensionForTool(tool);
      const isCursor = usesCursorMdcRules(tool);

      const files = await listFilesRecursive(rulesDir);
      for (const file of files) {
        if (!file.endsWith(ext)) continue;
        // name includes subdirectory path, e.g. "common/coding-standards"
        const name = file.slice(0, -ext.length);
        if (tombstones.has(name)) continue;
        if (EXCLUDED_RULE_NAMES.has(name)) continue; // Skip CLI built-in and legacy rules

        const localFilePath = path.join(rulesDir, file);
        // Team repo always stores `.md`, keyed by rule name.
        const teamFileName = `${name}.md`;

        if (teamRules.has(teamFileName)) {
          // File exists in team repo — check if content differs
          const teamFilePath = path.join(teamRulesDir, teamFileName);
          // For Cursor, compare markdown bodies only: the `.mdc` frontmatter is
          // machine-derived on pull, so a clean pull-then-push must not look
          // modified. For other tools the files are byte-identical copies.
          const equal = isCursor
            ? cursorMdcBodyEqualsTeamMd(
                (await readFileSafe(localFilePath)) ?? '',
                await readTeamRule(teamFilePath),
              )
            : await fileContentEqual(localFilePath, teamFilePath);
          if (equal) continue; // This tool dir's copy is identical, skip

          // Content differs — candidate for "modified"
          const mtime = await getFileMtime(localFilePath);
          const existing = candidates.get(name);
          if (!existing || mtime > existing.mtime) {
            candidates.set(name, { sourcePath: localFilePath, mtime, status: 'modified' });
          }
        } else {
          // File does not exist in team repo — candidate for "new".
          // Except in Cursor's dir: `.cursor/rules/*.mdc` is exactly where
          // Cursor's own "New Cursor Rule" command writes a developer's personal
          // rules, so treating them as new team resources would offer to publish
          // private files (with their frontmatter stripped) to the whole team.
          // teamai only ever authors `.mdc` there by pulling, so a Cursor-only
          // file is by definition not ours to push.
          if (isCursor) continue;
          const existing = candidates.get(name);
          if (!existing) {
            const mtime = await getFileMtime(localFilePath);
            candidates.set(name, { sourcePath: localFilePath, mtime, status: 'new' });
          } else if (existing.status === 'new') {
            // Multiple tool dirs have the same new file — pick latest mtime
            const mtime = await getFileMtime(localFilePath);
            if (mtime > existing.mtime) {
              candidates.set(name, { sourcePath: localFilePath, mtime, status: 'new' });
            }
          }
        }
      }
    }

    // Convert candidates map to items array
    const items: ResourceItem[] = [];
    for (const [name, candidate] of candidates) {
      items.push({
        name,
        type: 'rules',
        sourcePath: candidate.sourcePath,
        relativePath: `rules/${name}.md`,
        status: candidate.status,
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
    const dest = path.join(localConfig.repo.localPath, 'rules', `${item.name}.md`);
    if (item.sourcePath !== dest) {
      if (item.sourcePath.endsWith('.mdc')) {
        // Source is a Cursor `.mdc`. Only its markdown body is pushed: the
        // Cursor frontmatter is machine-derived, and the team file keeps its own
        // tool-neutral frontmatter (`paths:`, …) — dropping that would silently
        // un-scope the rule for the whole team on the next pull.
        const raw = await readFileSafe(item.sourcePath);
        if (raw === null) {
          // Never turn an unreadable source into an empty team rule.
          throw new Error(`Cannot read rule source ${item.sourcePath}`);
        }
        await writeFile(dest, mergeCursorBodyIntoTeamMd(raw, await readFileSafe(dest)));
      } else {
        await copyFile(item.sourcePath, dest);
      }
    }
    log.debug(`Copied rule ${item.name} → team repo`);
  }

  /**
   * Pull a single rule file to all configured AI tool rules/ directories.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const baseDir = resolveBaseDir(localConfig);
    for (const [tool, toolPath] of Object.entries(await effectiveToolPaths(teamConfig, localConfig))) {
      if (isAgentDisabled(localConfig, tool)) continue;
      if (!toolPath.rules) continue;

      // Skip tools that are not installed
      if (!await ResourceHandler.isToolInstalled(toolPath.rules, baseDir)) {
        log.debug(`Skipping rule sync for ${tool}: tool not installed`);
        continue;
      }

      const destDir = path.join(baseDir, toolPath.rules);
      await ensureDir(destDir);
      const dest = path.join(destDir, `${item.name}${ruleFileExtensionForTool(tool)}`);
      try {
        if (usesCursorMdcRules(tool)) {
          // Cursor needs `.mdc` with derived frontmatter, not a raw `.md` copy.
          const raw = await readFileSafe(item.sourcePath);
          if (raw === null) {
            // Never write a stub always-on rule in place of an unreadable source.
            throw new Error(`Cannot read rule source ${item.sourcePath}`);
          }
          await writeFile(dest, teamRuleToCursorMdc(raw));
          // Drop the copy an older teamai layout left as `.md` here: Cursor
          // never reads it, and it would otherwise linger forever.
          await remove(path.join(destDir, `${item.name}.md`));
        } else {
          await copyFile(item.sourcePath, dest);
        }
        log.debug(`Synced rule ${item.name} → ${tool}`);
      } catch (e) {
        log.warn(`Failed to sync rule ${item.name} to ${tool}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Remove a rule from the team repo and all local AI tool rules/ directories.
   */
  async removeItem(name: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const removed: string[] = [];
    const baseDir = resolveBaseDir(localConfig);

    // Remove from team repo (always `.md`)
    const teamFile = path.join(localConfig.repo.localPath, 'rules', `${name}.md`);
    if (await pathExists(teamFile)) {
      await remove(teamFile);
      removed.push(teamFile);
    }

    // Record tombstone so the resource won't be re-pushed
    await this.addTombstone(name, localConfig);

    // Remove from each tool's rules directory. Cursor uses `.mdc`, but an older
    // teamai layout wrote `.md` there, so both are removed — otherwise `remove`
    // would report success while leaving the rule on disk.
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.rules) continue;
      const extensions = new Set<string>([ruleFileExtensionForTool(tool), '.md']);
      for (const extension of extensions) {
        const filePath = path.join(baseDir, toolPath.rules, `${name}${extension}`);
        if (await pathExists(filePath)) {
          await remove(filePath);
          removed.push(filePath);
          log.debug(`Removed rule ${name} from ${tool}`);
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
    if (!isAgentDisabled(localConfig, 'hermes')) {
      const { getHermesHome } = await import('../hermes-home.js');
      if (await pathExists(getHermesHome())) {
        const bodies: string[] = [];
        for (const rule of rules) {
          const body = await readFileSafe(rule.sourcePath);
          if (body && body.trim() !== '') bodies.push(body.trim());
        }
        const { upsertSoulRules } = await import('../hermes-config.js');
        await upsertSoulRules(bodies.join('\n\n'));
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
    // Only in team-managed tools — auto-discovered tools may have personal rules.
    const teamRuleNames = new Set(rules.map((r) => r.name));
    const baseDir = resolveBaseDir(localConfig);
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.rules) continue;
      if (!await ResourceHandler.isToolInstalled(toolPath.rules, baseDir)) continue;

      const destDir = path.join(baseDir, toolPath.rules);
      if (!await pathExists(destDir)) continue;

      const ext = ruleFileExtensionForTool(tool);
      const localFiles = await listFilesRecursive(destDir);
      for (const localFile of localFiles) {
        const ruleName = ruleStemFromFilename(localFile);
        if (ruleName === null) continue;

        // Cursor only reads `.mdc`, so any `.md` here is inert leftover from the
        // layout that predates it — removed whether or not the rule is still
        // active, and ahead of the built-in check, since built-ins now deploy to
        // Cursor as `.mdc` too.
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
    for (const [, toolPath] of Object.entries(await effectiveToolPaths(teamConfig, localConfig))) {
      if (!toolPath.claudemd) continue;
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
    if (isAgentDisabled(localConfig, 'opencode')) return;
    const scoped = await effectiveToolPaths(teamConfig, localConfig);
    const paths = scoped['opencode'];
    if (!paths?.rules) return;

    const baseDir = resolveBaseDir(localConfig);
    // Only touch opencode.json when OpenCode is actually installed for this scope.
    if (!await ResourceHandler.isToolInstalled(paths.rules, baseDir)) return;

    // The config file mirrors the MCP scope fields: <root>/opencode.json in
    // project scope, ~/.config/opencode/opencode.json in user scope.
    const configRel = localConfig.scope === 'project' ? paths.mcpProject : paths.mcp;
    if (!configRel) return;
    const configFileAbs = path.join(baseDir, configRel);
    const rulesDirAbs = path.join(baseDir, paths.rules);

    const { reconcileOpencodeInstructions, opencodeRulesGlob } = await import('./opencode-config.js');
    const glob = opencodeRulesGlob(configFileAbs, rulesDirAbs);
    try {
      await reconcileOpencodeInstructions(configFileAbs, glob, present);
    } catch (e) {
      log.warn(`Failed to update OpenCode instructions in ${configFileAbs}: ${(e as Error).message}`);
    }
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
