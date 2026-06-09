import path from 'node:path';

import { autoDetectInit } from './config.js';
import { generateCodebaseMd } from './codebase.js';
import { scanCandidates, classifyWithAI, interactiveReview, pushAccepted } from './import-local.js';
import { importFromIWiki } from './import-iwiki.js';
import { importFromMR } from './import-mr.js';
import { GlobalOptions } from './types.js';
import { log } from './utils/logger.js';

/**
 * import 命令的扩展选项，合并全局选项与子命令专属选项。
 */
interface ImportOptions extends GlobalOptions {
  /** 本地目录路径，用于扫描可导入文件 */
  dir?: string;
  /** 是否扫描 Claude/Cursor rule 目录 */
  fromClaude?: boolean;
  /** 是否从当前 git 工作区生成 codebase.md */
  workspace?: boolean;
  /** 从已合并 MR/PR URL 提取知识 */
  fromMr?: string;
  /** iWiki Space ID 或页面 URL，用于批量导入 iWiki 文档 */
  fromIwiki?: string;
  /** 批量模式下最多扫描的 MR 数量（字符串，需 parseInt） */
  limit?: string;
  /** 是否恢复中断的导入会话 */
  resume?: boolean;
  /** 是否导入全部候选（跳过交互确认） */
  all?: boolean;
  /** 将草稿写入指定目录而非推送至团队仓库 */
  output?: string;
}

/**
 * import 命令主入口，根据选项组合 local、workspace、MR 三条导入流程。
 *
 * @param opts - 合并了全局选项与子命令选项的参数对象
 */
export async function importCmd(opts: ImportOptions): Promise<void> {
  try {
    if (opts.fromIwiki) {
      // 分支 0：--from-iwiki，从 iWiki Space 或单页批量导入
      const { localConfig } = await autoDetectInit();
      await importFromIWiki({
        input: opts.fromIwiki,
        all: opts.all,
        outputDir: opts.output,
        repoPath: opts.dryRun ? undefined : localConfig.repo.localPath,
        dryRun: opts.dryRun,
      });
    } else if (opts.fromMr) {
      // 分支 1：--from-mr <url>，从已合并 MR 提取学习内容
      const { localConfig } = await autoDetectInit();
      await importFromMR({
        url: opts.fromMr,
        learningsDir: path.join(localConfig.repo.localPath, 'learnings'),
        all: opts.all,
        outputDir: opts.output,
        repoPath: opts.dryRun ? undefined : localConfig.repo.localPath,
        dryRun: opts.dryRun,
      });
    } else if (opts.workspace) {
      // 分支 2：--workspace，从当前 git 工作区生成 codebase.md
      const codebaseMd = await generateCodebaseMd({ repoPath: process.cwd() });
      if (opts.output) {
        const fs = await import('fs/promises');
        await fs.writeFile(opts.output, codebaseMd, 'utf-8');
        log.info(`已写入：${opts.output}`);
      } else {
        log.info(codebaseMd);
      }
    } else if (opts.dir || opts.fromClaude) {
      // 分支 3：--dir 或 --from-claude，扫描本地文件并交互式导入
      const candidates = await scanCandidates({ dir: opts.dir, fromClaude: opts.fromClaude });
      if (candidates.length === 0) {
        log.info('未发现可导入的文件');
        return;
      }
      const classified = await classifyWithAI(candidates);
      const session = await interactiveReview(classified, { all: opts.all, resume: opts.resume });
      const { localConfig } = await autoDetectInit();
      await pushAccepted(session, localConfig.repo.localPath, {
        dryRun: opts.dryRun,
        outputDir: opts.output,
      });
      log.success('导入完成');
    } else {
      // 默认：未指定来源，提示用户
      log.info('请指定导入来源：--dir <path>、--from-claude、--workspace、--from-mr <url> 或 --from-iwiki <space-id-or-url>');
      process.exit(0);
    }
  } catch (err: unknown) {
    log.error((err as Error).message);
    process.exit(1);
  }
}
