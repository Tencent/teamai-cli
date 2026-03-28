import path from 'node:path';
import { ResourceHandler } from './base.js';
import type { ResourceItem, ResourceItemStatus, TeamaiConfig, LocalConfig } from '../types.js';
import { listFilesRecursive, pathExists, readFileSafe, writeFile, copyFile, ensureDir, remove, fileContentEqual, getFileMtime, listDirs } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { TEAMAI_RULES_START, TEAMAI_RULES_END } from '../types.js';
import { BUILTIN_RULE_NAMES } from '../builtin-rules.js';

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

    // Scan each tool's rules/ directory (recursively)
    for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      const rulesPath = toolPath.rules;
      if (!rulesPath) continue;
      const rulesDir = path.join(process.env.HOME ?? '', rulesPath);
      if (!await pathExists(rulesDir)) continue;

      const files = await listFilesRecursive(rulesDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        // name includes subdirectory path, e.g. "common/coding-standards"
        const name = file.replace(/\.md$/, '');
        if (tombstones.has(name)) continue;
        if (BUILTIN_RULE_NAMES.has(name)) continue; // Skip CLI built-in rules

        const localFilePath = path.join(rulesDir, file);

        if (teamRules.has(file)) {
          // File exists in team repo — check if content differs
          const teamFilePath = path.join(teamRulesDir, file);
          const equal = await fileContentEqual(localFilePath, teamFilePath);
          if (equal) continue; // This tool dir's copy is identical, skip

          // Content differs — candidate for "modified"
          const mtime = await getFileMtime(localFilePath);
          const existing = candidates.get(name);
          if (!existing || mtime > existing.mtime) {
            candidates.set(name, { sourcePath: localFilePath, mtime, status: 'modified' });
          }
        } else {
          // File does not exist in team repo — candidate for "new"
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
      await copyFile(item.sourcePath, dest);
    }
    log.debug(`Copied rule ${item.name} → team repo`);
  }

  /**
   * Pull a single rule file to all configured AI tool rules/ directories.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    const home = process.env.HOME ?? '';
    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.rules) continue;

      // Skip tools that are not installed
      if (!await ResourceHandler.isToolInstalled(toolPath.rules)) {
        log.debug(`Skipping rule sync for ${tool}: tool not installed`);
        continue;
      }

      const destDir = path.join(home, toolPath.rules);
      await ensureDir(destDir);
      const dest = path.join(destDir, `${item.name}.md`);
      try {
        await copyFile(item.sourcePath, dest);
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
    const home = process.env.HOME ?? '';
    const fileName = `${name}.md`;

    // Remove from team repo
    const teamFile = path.join(localConfig.repo.localPath, 'rules', fileName);
    if (await pathExists(teamFile)) {
      await remove(teamFile);
      removed.push(teamFile);
    }

    // Record tombstone so the resource won't be re-pushed
    await this.addTombstone(name, localConfig);

    // Remove from each tool's rules directory
    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.rules) continue;
      const filePath = path.join(home, toolPath.rules, fileName);
      if (await pathExists(filePath)) {
        await remove(filePath);
        removed.push(filePath);
        log.debug(`Removed rule ${name} from ${tool}`);
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
  async pullAllRules(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const rules = await this.scanTeamForPull(teamConfig, localConfig);
    if (rules.length === 0) return;

    // 1. Distribute rule files to each tool's rules/ directory
    for (const rule of rules) {
      await this.pullItem(rule, teamConfig, localConfig);
    }

    // 1.5. Clean up stale local rule files not present in team repo
    const teamRuleFiles = new Set(rules.map((r) => `${r.name}.md`));
    const home = process.env.HOME ?? '';
    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.rules) continue;
      if (!await ResourceHandler.isToolInstalled(toolPath.rules)) continue;

      const destDir = path.join(home, toolPath.rules);
      if (!await pathExists(destDir)) continue;

      const localFiles = await listFilesRecursive(destDir);
      for (const localFile of localFiles) {
        if (!localFile.endsWith('.md')) continue;
        // Skip built-in rules (managed by CLI, not team repo)
        const ruleName = localFile.replace(/\.md$/, '');
        if (BUILTIN_RULE_NAMES.has(ruleName)) continue;
        if (!teamRuleFiles.has(localFile)) {
          const fullPath = path.join(destDir, localFile);
          await remove(fullPath);
          log.debug(`Removed stale rule ${localFile} from ${tool}`);
        }
      }

      // Clean up empty subdirectories
      await this.removeEmptyDirs(destDir);
    }

    // 2. Update CLAUDE.md with references only
    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.claudemd || !toolPath.rules) continue;

      // Skip tools that are not installed
      if (!await ResourceHandler.isToolInstalled(toolPath.rules)) continue;

      // Reference the rules directory and docs directory
      const refs: string[] = [
        `- ~/${toolPath.rules}/`,
      ];
      const docsDir = teamConfig.sharing.docs.localDir;
      if (docsDir) {
        refs.push(`- ${docsDir}/`);
      }

      const rulesBlock = [
        TEAMAI_RULES_START,
        '<!-- DO NOT EDIT: This section is auto-managed by teamai -->',
        '',
        '## Team Rules (teamai)',
        '',
        'The following rule files apply to this project:',
        '',
        ...refs,
        '',
        TEAMAI_RULES_END,
      ].join('\n');

      const claudeMdPath = path.join(home, toolPath.claudemd);
      let existing = await readFileSafe(claudeMdPath) ?? '';

      const startIdx = existing.indexOf(TEAMAI_RULES_START);
      const endIdx = existing.indexOf(TEAMAI_RULES_END);

      if (startIdx !== -1 && endIdx !== -1) {
        existing = existing.substring(0, startIdx) + rulesBlock + existing.substring(endIdx + TEAMAI_RULES_END.length);
      } else {
        existing = existing.trimEnd() + '\n\n' + rulesBlock + '\n';
      }

      try {
        await writeFile(claudeMdPath, existing);
        log.debug(`Updated rules references in ${tool} CLAUDE.md`);
      } catch (e) {
        log.warn(`Failed to update ${tool} CLAUDE.md: ${(e as Error).message}`);
      }
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
