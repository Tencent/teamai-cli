import fs from 'node:fs';
import path from 'node:path';
import fse from 'fs-extra';
import { requireInit, detectProjectConfig, loadTeamConfig, loadLocalConfigForScope } from './config.js';
import { assertNotReadOnly } from './read-only.js';
import { pushRepoDirectly, pullRepo } from './utils/git.js';
import { withTimeout } from './utils/async.js';
import { ensureDir, pathExists } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { markContributed } from './contribute-check.js';
import type { GlobalOptions, LocalConfig } from './types.js';
import { LEARNINGS_LOCAL_DIR, getTeamaiHome } from './types.js';

/**
 * Rebuild this scope's local search index so the freshly-written contribution
 * (and anything pulled just before it) is immediately recallable — otherwise
 * `recall` only picks it up after the next `teamai pull` rebuilds the index (#85).
 * Mirrors the per-scope indexing pull.ts does after syncing learnings.
 */
async function rebuildIndexAfterContribute(localConfig: LocalConfig): Promise<void> {
  const repoPath = localConfig.repo.localPath;
  const learningsRepoDir = path.join(repoPath, 'learnings');
  const docsRepoDir = path.join(repoPath, 'docs');
  const rulesRepoDir = path.join(repoPath, 'rules');
  const skillsRepoDir = path.join(repoPath, 'skills');
  const votesDir = path.join(repoPath, 'votes');

  // user scope mirrors learnings/ into ~/.teamai/learnings/ (legacy behavior,
  // same as pull.ts); project scope indexes the repo's learnings/ directly.
  let effectiveLearningsDir: string | undefined;
  if (localConfig.scope === 'user') {
    if (await pathExists(learningsRepoDir)) {
      await fse.copy(learningsRepoDir, LEARNINGS_LOCAL_DIR, {
        overwrite: true,
        filter: (src: string) => !path.basename(src).startsWith('.'),
      });
    }
    effectiveLearningsDir = (await pathExists(LEARNINGS_LOCAL_DIR)) ? LEARNINGS_LOCAL_DIR : undefined;
  } else {
    effectiveLearningsDir = (await pathExists(learningsRepoDir)) ? learningsRepoDir : undefined;
  }

  const teamaiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
  const indexPath = path.join(teamaiHome, 'search-index.json');
  const { buildIndex } = await import('./utils/search-index.js');
  await buildIndex({
    learningsDir: effectiveLearningsDir,
    docsDir: (await pathExists(docsRepoDir)) ? docsRepoDir : undefined,
    rulesDir: (await pathExists(rulesRepoDir)) ? rulesRepoDir : undefined,
    skillsDir: (await pathExists(skillsRepoDir)) ? skillsRepoDir : undefined,
    votesDir: (await pathExists(votesDir)) ? votesDir : undefined,
    indexPath,
  });
}

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
  assertNotReadOnly(localConfig, 'teamai contribute');
  const repoPath = localConfig.repo.localPath;
  const username = localConfig.username;

  if (options.dryRun) {
    const filename = generateFilename(options.title);
    log.info(`[dry-run] Would push: learnings/${filename} (${content.length} bytes)`);
    return;
  }

  // Single-repo mode: learnings are knowledge on main → contribute via a PR from
  // an isolated worktree (never the active tree / direct push to main).
  if (localConfig.repo.kind === 'self') {
    await contributeSelf(localConfig, content, options);
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

    // Rebuild the index now so recall can find this contribution immediately,
    // independent of whether the push below succeeds.
    try {
      await rebuildIndexAfterContribute(localConfig);
    } catch (e) {
      log.debug(`contribute: index rebuild skipped: ${(e as Error).message}`);
    }

    // Push directly to master with timeout. withTimeout clears its timer once
    // the push settles, so a fast push does not leave a 10s timer pinning the
    // event loop (and hanging the CLI) after the work is done.
    const commitMsg = `[teamai] Contribute session knowledge from ${username}`;
    await withTimeout(
      pushRepoDirectly(repoPath, commitMsg, [`learnings/${filename}`]),
      10_000,
      'Push timeout (10s)',
    );

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

/**
 * Single-repo mode contribution: learnings are knowledge on main, so we open a
 * PR from an isolated knowledge worktree instead of pushing to main directly.
 *
 * The user's active working tree is never written to. For immediate local recall,
 * we mirror the worktree's learnings/ (committed main learnings + the new one)
 * into the machine-local LEARNINGS_LOCAL_DIR and index from there — the same
 * pattern user scope uses. The contribution lands in the active tree only when the
 * PR merges and the user pulls.
 */
async function contributeSelf(
  localConfig: LocalConfig,
  content: string,
  options: GlobalOptions & { file?: string; title?: string; sessionId?: string; scope?: string },
): Promise<void> {
  const username = localConfig.username;
  const filename = generateFilename(options.title);
  const relPath = `learnings/${filename}`;
  const commitMsg = `[teamai] Contribute session knowledge from ${username}`;
  const spin = spinner('Contributing session knowledge...').start();

  try {
    const { withKnowledgeWorktree } = await import('./utils/reports-branch.js');
    const { pushRepoBranch, checkoutMaster, generateBranchName } = await import('./utils/git.js');
    const { createPrWithFallback } = await import('./push.js');
    const teamConfig = await loadTeamConfig(localConfig.repo.localPath);

    await withKnowledgeWorktree(localConfig, async (wtConfig) => {
      const wtRepo = wtConfig.repo.localPath;
      await ensureDir(path.join(wtRepo, 'learnings'));
      await fs.promises.writeFile(path.join(wtRepo, relPath), content, 'utf-8');

      // Mirror the worktree's learnings into the machine-local dir + rebuild the
      // index so recall sees this contribution immediately — without touching the
      // user's active tree. Index ALL categories (not just learnings) — a
      // learnings-only rebuild would clobber the project index and drop
      // docs/rules/skills/votes until the next full pull.
      //
      // IMPORTANT: source docs/rules/skills from the PERSISTENT active tree
      // (localConfig.repo.localPath/.teamai), NOT the disposable knowledge
      // worktree — withKnowledgeWorktree deletes wtRepo on teardown, and buildIndex
      // bakes absolute paths into search-index.json, so worktree paths would leave
      // recall printing `File: <deleted>` pointers. learnings come from the
      // persistent LEARNINGS_LOCAL_DIR mirror; votes from the reports worktree.
      // This matches the other index-build sites (pull.ts / recall.ts).
      try {
        const { pathExists } = await import('./utils/fs.js');
        const wtLearnings = path.join(wtRepo, 'learnings');
        await fse.copy(wtLearnings, LEARNINGS_LOCAL_DIR, {
          overwrite: true,
          filter: (src: string) => !path.basename(src).startsWith('.'),
        });

        const repoPath = localConfig.repo.localPath; // persistent active-tree .teamai
        const docsDir = path.join(repoPath, 'docs');
        const rulesDir = path.join(repoPath, 'rules');
        const skillsDir = path.join(repoPath, 'skills');

        // votes are on the teamai-reports orphan branch, not in the knowledge worktree.
        let votesDir: string | undefined;
        try {
          const { ensureReportsWorktree } = await import('./utils/reports-branch.js');
          const candidate = path.join(await ensureReportsWorktree(localConfig), 'votes');
          if (await pathExists(candidate)) votesDir = candidate;
        } catch { /* reports worktree unavailable — index without votes */ }

        const teamaiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
        const { buildIndex } = await import('./utils/search-index.js');
        await buildIndex({
          learningsDir: await pathExists(LEARNINGS_LOCAL_DIR) ? LEARNINGS_LOCAL_DIR : undefined,
          docsDir: await pathExists(docsDir) ? docsDir : undefined,
          rulesDir: await pathExists(rulesDir) ? rulesDir : undefined,
          skillsDir: await pathExists(skillsDir) ? skillsDir : undefined,
          votesDir,
          indexPath: path.join(teamaiHome, 'search-index.json'),
        });
      } catch (e) {
        log.debug(`contribute(self): local index refresh skipped: ${(e as Error).message}`);
      }

      const branchName = generateBranchName(username);
      const hasChanges = await pushRepoBranch(wtRepo, commitMsg, [relPath], branchName);
      if (!hasChanges) {
        spin.info('Contribution already present — nothing to push.');
        return;
      }
      if (teamConfig) {
        await createPrWithFallback(
          teamConfig,
          wtConfig,
          branchName,
          commitMsg,
          `Contribute session knowledge: ${options.title ?? filename}`,
        );
      }
      await checkoutMaster(wtRepo);
      spin.succeed(`Contributed via PR: ${relPath}`);
    });

    const sessionId = options.sessionId || process.env.CLAUDE_SESSION_ID || '';
    if (sessionId) await markContributed(sessionId);
    log.info('Your session knowledge has been shared with the team (PR opened).');
  } catch (e) {
    spin.fail(`Contribution failed: ${(e as Error).message}`);
    log.info('You can retry with: teamai contribute --file <path>');
  }
}
