import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import chalk from 'chalk';
import matter from 'gray-matter';

import { extractCodebase } from './codebase-extract.js';
import { log } from './utils/logger.js';
import { pathExists } from './utils/fs.js';

export interface UpgradeCodebaseWikiOptions {
  cwd: string;
  dryRun?: boolean;
  json?: boolean;
}

interface MigrationResult {
  migrated: string[];
  skipped: string[];
  errors: string[];
}

export async function upgradeCodebaseWiki(opts: UpgradeCodebaseWikiOptions): Promise<void> {
  const teamCodebaseDir = path.join(opts.cwd, 'docs', 'team-codebase', 'repos');

  if (!await pathExists(teamCodebaseDir)) {
    if (opts.json) {
      console.log(JSON.stringify({ status: 'nothing-to-migrate', reason: 'docs/team-codebase/repos/ not found' }));
    } else {
      log.info('未发现 docs/team-codebase/repos/ 目录，无需迁移。');
    }
    return;
  }

  const files = await readdir(teamCodebaseDir);
  const mdFiles = files.filter(f => f.endsWith('.md'));

  if (mdFiles.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ status: 'nothing-to-migrate', reason: 'no .md files in repos/' }));
    } else {
      log.info('repos/ 下无 .md 文件，无需迁移。');
    }
    return;
  }

  if (!opts.json) {
    log.info(`发现 ${mdFiles.length} 个旧格式仓库文档，开始迁移到 teamwiki/ 图谱格式...`);
  }

  const result: MigrationResult = { migrated: [], skipped: [], errors: [] };

  for (const file of mdFiles) {
    const slug = file.replace('.md', '');
    const filePath = path.join(teamCodebaseDir, file);

    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = matter(content);
      const source = parsed.data['source'] ?? parsed.data['repo_url'];

      if (!source) {
        result.skipped.push(`${slug}: 无 source/repo_url 字段`);
        continue;
      }

      if (opts.dryRun) {
        result.migrated.push(`${slug} → teamwiki/evidence/code/${slug}/`);
        continue;
      }

      // 尝试从缓存目录查找已有 clone
      const cacheBase = path.join(process.env['HOME'] ?? '', '.teamai', 'cache', 'repos');
      const urlParts = String(source).replace(/^https?:\/\//, '').replace(/@.*$/, '').split('/');
      const cachePath = path.join(cacheBase, ...urlParts.slice(0, 3));

      if (await pathExists(cachePath)) {
        await extractCodebase({ path: cachePath, project: slug });
        result.migrated.push(slug);
      } else {
        result.skipped.push(`${slug}: 缓存不存在 (${cachePath}), 请先执行 teamai import --from-repo`);
      }
    } catch (err) {
      result.errors.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ status: 'done', ...result }, null, 2));
  } else {
    if (result.migrated.length > 0) {
      log.success(`已迁移 ${result.migrated.length} 个仓库到 teamwiki/ 格式`);
      for (const m of result.migrated) {
        console.log(chalk.green(`  ✓ ${m}`));
      }
    }
    if (result.skipped.length > 0) {
      console.log(chalk.yellow(`跳过 ${result.skipped.length} 个：`));
      for (const s of result.skipped) {
        console.log(chalk.yellow(`  - ${s}`));
      }
    }
    if (result.errors.length > 0) {
      console.log(chalk.red(`失败 ${result.errors.length} 个：`));
      for (const e of result.errors) {
        console.log(chalk.red(`  ✗ ${e}`));
      }
    }

    if (!opts.dryRun && result.migrated.length > 0) {
      log.info('');
      log.info('迁移完成。旧的 docs/team-codebase/ 目录已保留（未删除）。');
      log.info('确认新图谱工作正常后，可手动删除 docs/team-codebase/ 目录。');
    }
  }
}
