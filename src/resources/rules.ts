import path from 'node:path';
import { ResourceHandler } from './base.js';
import type { ResourceItem, TeamaiConfig, LocalConfig } from '../types.js';
import { listFiles, pathExists, readFileSafe, writeFile, copyFile, ensureDir, remove } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { TEAMAI_RULES_START, TEAMAI_RULES_END } from '../types.js';

export class RulesHandler extends ResourceHandler {
  readonly type = 'rules' as const;

  /**
   * Scan for local rule .md files that are not yet in the team repo.
   * Looks in each tool's configured rules/ directory (e.g. ~/.claude/rules/).
   */
  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    const teamRules = new Set(
      (await pathExists(teamRulesDir))
        ? (await listFiles(teamRulesDir)).filter((f) => f.endsWith('.md'))
        : [],
    );

    // Read tombstones to skip previously deleted resources
    const tombstones = await this.readTombstones(localConfig);

    const items: ResourceItem[] = [];
    const seen = new Set<string>();

    // Scan each tool's rules/ directory
    for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      const rulesPath = toolPath.rules;
      if (!rulesPath) continue;
      const rulesDir = path.join(process.env.HOME ?? '', rulesPath);
      if (!await pathExists(rulesDir)) continue;

      const files = await listFiles(rulesDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const name = file.replace(/\.md$/, '');
        if (seen.has(file) || teamRules.has(file)) continue;
        if (tombstones.has(name)) continue;

        seen.add(file);
        items.push({
          name,
          type: 'rules',
          sourcePath: path.join(rulesDir, file),
          relativePath: `rules/${file}`,
        });
      }
    }

    return items;
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const rulesDir = path.join(localConfig.repo.localPath, 'rules');
    if (!await pathExists(rulesDir)) return [];

    const files = await listFiles(rulesDir);
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

    // 2. Update CLAUDE.md with references only
    const home = process.env.HOME ?? '';
    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.claudemd || !toolPath.rules) continue;

      const ruleRefs = rules.map((r) => `- ~/${toolPath.rules}/${r.name}.md`);
      const rulesBlock = [
        TEAMAI_RULES_START,
        '<!-- DO NOT EDIT: This section is auto-managed by teamai -->',
        '',
        '## Team Rules (teamai)',
        '',
        'The following rule files apply to this project:',
        '',
        ...ruleRefs,
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
}
