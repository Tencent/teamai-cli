import fs from 'node:fs';
import path from 'node:path';
import { requireInit, detectProjectConfig, loadTeamConfig, loadLocalConfigForScope } from './config.js';
import { pushRepoDirectly, pullRepo } from './utils/git.js';
import { ensureDir } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { markContributed } from './contribute-check.js';
import type { GlobalOptions, LocalConfig } from './types.js';

// ─── Contribute data flow ─────────────────────────────────
//
//  User/Agent runs: teamai contribute --file <path> [--title <title>]
//      │
//      ├─ requireInit() → repoPath + username
//      ├─ readFile(path) → validate non-empty
//      ├─ generateFilename(title) → learnings/<title-slug>-<date>-<random>.md
//      ├─ ensureDir(repoPath/learnings/)
//      ├─ copyFile → repoPath/learnings/<filename>
//      ├─ pullRepo() → get latest (best effort)
//      ├─ pushRepoDirectly(repoPath, commitMsg, [learnings/<filename>])
//      │   ├── success → markContributed(sessionId)
//      │   └── fail → log error
//      └─ done
//

/**
 * Generate a safe filename for a contribution document.
 *
 * Format: data-<title-slug>-<random>.md
 *
 * The title is slugified (lowercase, hyphens, max 50 chars).
 * A 6-char random suffix avoids collisions.
 */
function generateFilename(title?: string): string {
  const slug = (title ?? 'session-notes')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-') // Allow Chinese chars
    .replace(/^-+|-+$/g, '') // Trim leading/trailing hyphens
    .slice(0, 50);

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const random = Math.random().toString(36).slice(2, 8);
  return `${slug}-${date}-${random}.md`;
}

/**
 * Handle `teamai contribute --file <path> [--title <title>]`.
 *
 * Pushes a contribution document directly to master in the team repo's
 * `learnings/` directory. No branch/MR — contributions are lightweight
 * knowledge items, not code changes.
 */
export async function contribute(
  options: GlobalOptions & { file?: string; title?: string; sessionId?: string; scope?: string },
): Promise<void> {
  // Validate file
  if (!options.file) {
    log.error('Usage: teamai contribute --file <path> [--title <title>]');
    return;
  }

  let content: string;
  try {
    content = await fs.promises.readFile(options.file, 'utf-8');
  } catch (e) {
    log.error(`Cannot read file: ${options.file} — ${(e as Error).message}`);
    return;
  }

  if (!content.trim()) {
    log.error('Contribution file is empty — nothing to push.');
    return;
  }

  // Init check — select scope based on --scope flag or auto-detect
  let localConfig: LocalConfig;
  if (options.scope === 'project') {
    const cfg = await loadLocalConfigForScope('project', process.cwd());
    if (!cfg) { log.error('当前目录没有项目级 teamai 配置'); return; }
    localConfig = cfg;
  } else if (options.scope === 'user') {
    const { localConfig: userCfg } = await requireInit();
    localConfig = userCfg;
  } else {
    // 自动检测（默认行为不变）
    const projectConfig = await detectProjectConfig();
    localConfig = projectConfig ?? (await requireInit()).localConfig;
  }
  const repoPath = localConfig.repo.localPath;
  const username = localConfig.username;

  if (options.dryRun) {
    const filename = generateFilename(options.title);
    log.info(`[dry-run] Would push: learnings/${filename} (${content.length} bytes)`);
    return;
  }

  const pushSpin = spinner('Contributing session knowledge...').start();
  const filename = generateFilename(options.title);

  try {
    // Prepare destination
    const aiDocsDir = path.join(repoPath, 'learnings');
    await ensureDir(aiDocsDir);
    const destPath = path.join(aiDocsDir, filename);

    // Write file to repo
    await fs.promises.writeFile(destPath, content, 'utf-8');

    // Pull latest (best effort — don't fail if network is down)
    try {
      await pullRepo(repoPath);
    } catch {
      log.debug('contribute: pull failed, continuing with local state');
    }

    // Push directly to master with timeout
    const commitMsg = `[teamai] Contribute session knowledge from ${username}`;
    const pushPromise = pushRepoDirectly(
      repoPath,
      commitMsg,
      [`learnings/${filename}`],
    );

    const timeoutPromise = new Promise<never>((__, reject) =>
      setTimeout(() => reject(new Error('Push timeout (10s)')), 10_000),
    );

    await Promise.race([pushPromise, timeoutPromise]);

    pushSpin.succeed(`Contributed: learnings/${filename}`);

    // Mark session as contributed (dedup for contribute-check)
    const sessionId = options.sessionId || process.env.CLAUDE_SESSION_ID || '';
    if (sessionId) {
      await markContributed(sessionId);
    }

    log.info(`Your session knowledge has been shared with the team.`);
  } catch (e) {
    // 确保文件至少被本地 commit（防止 resetToCleanMaster 丢失数据）
    try {
      const { execFileSync } = await import('node:child_process');
      const commitMsg = `[teamai] Contribute: ${options.title || 'session knowledge'}`;
      execFileSync('git', ['add', `learnings/${filename}`], { cwd: repoPath, timeout: 5000 });
      execFileSync('git', ['commit', '-m', commitMsg], { cwd: repoPath, timeout: 5000 });
      pushSpin.warn(`已保存到本地（推送失败: ${(e as Error).message}）。下次 pull 时将自动重试推送。`);
    } catch {
      pushSpin.fail(`Contribution failed: ${(e as Error).message}`);
      log.info('You can retry with: teamai contribute --file <path>');
    }
  }
}
