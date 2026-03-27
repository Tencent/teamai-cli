import fs from 'node:fs';
import path from 'node:path';
import { requireInit } from './config.js';
import { pushRepoDirectly, pullRepo } from './utils/git.js';
import { ensureDir } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { markContributed } from './contribute-check.js';
import type { GlobalOptions } from './types.js';

// ─── Contribute data flow ─────────────────────────────────
//
//  User/Agent runs: teamai contribute --file <path> [--title <title>]
//      │
//      ├─ requireInit() → repoPath + username
//      ├─ readFile(path) → validate non-empty
//      ├─ generateFilename(title) → ai-docs/data-<title>-<random>.md
//      ├─ ensureDir(repoPath/ai-docs/)
//      ├─ copyFile → repoPath/ai-docs/<filename>
//      ├─ pullRepo() → get latest (best effort)
//      ├─ pushRepoDirectly(repoPath, commitMsg, [ai-docs/<filename>])
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

  const random = Math.random().toString(36).slice(2, 8);
  return `data-${slug}-${random}.md`;
}

/**
 * Handle `teamai contribute --file <path> [--title <title>]`.
 *
 * Pushes a contribution document directly to master in the team repo's
 * `ai-docs/` directory. No branch/MR — contributions are lightweight
 * knowledge items, not code changes.
 */
export async function contribute(
  options: GlobalOptions & { file?: string; title?: string; sessionId?: string },
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

  // Init check
  const { localConfig } = await requireInit();
  const repoPath = localConfig.repo.localPath;
  const username = localConfig.username;

  if (options.dryRun) {
    const filename = generateFilename(options.title);
    log.info(`[dry-run] Would push: ai-docs/${filename} (${content.length} bytes)`);
    return;
  }

  const pushSpin = spinner('Contributing session knowledge...').start();

  try {
    // Prepare destination
    const aiDocsDir = path.join(repoPath, 'ai-docs');
    await ensureDir(aiDocsDir);

    const filename = generateFilename(options.title);
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
      [`ai-docs/${filename}`],
    );

    const timeoutPromise = new Promise<never>((__, reject) =>
      setTimeout(() => reject(new Error('Push timeout (10s)')), 10_000),
    );

    await Promise.race([pushPromise, timeoutPromise]);

    pushSpin.succeed(`Contributed: ai-docs/${filename}`);

    // Mark session as contributed (dedup for contribute-check)
    const sessionId = options.sessionId || process.env.CLAUDE_SESSION_ID || '';
    if (sessionId) {
      await markContributed(sessionId);
    }

    log.info(`Your session knowledge has been shared with the team.`);
  } catch (e) {
    pushSpin.fail(`Contribution failed: ${(e as Error).message}`);
    log.info('You can retry with: teamai contribute --file <path>');
  }
}
