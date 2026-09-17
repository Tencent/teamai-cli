import fs from 'node:fs';
import path from 'node:path';
import { requireInit, detectProjectConfig, loadLocalConfigForScope } from './config.js';
import { assertNotReadOnly } from './read-only.js';
import { pathExists } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { markContributed } from './contribute-check.js';
import { pendingLearningsDir, savePendingLearning } from './utils/pending-learnings.js';
import { publishLearning } from './utils/learnings-publish.js';
import { learningsRoots } from './utils/learnings-roots.js';
import { isSafeNamespaceSegment, resolveActiveLearningsNamespaces } from './projects.js';
import type { GlobalOptions, LocalConfig } from './types.js';
import { getDataHome, getReportsDir, isSelfMode } from './types.js';

/**
 * Decide which learnings subdirectory a contribution lands in — resolved from
 * the manifest's `resources.learnings`, the SAME mapping `pull` indexes by (NOT
 * the raw project id, which the schema allows to differ). Async because it reads
 * the manifest.
 *
 * - Exactly one active learnings namespace → that namespace's subdir (isolated).
 * - Zero (no project, or the active projects declare no learnings namespace) →
 *   the shared root (empty string).
 * - Multiple active learnings namespaces → the shared root, because the
 *   contribution's ownership is ambiguous; a member on several projects can still
 *   target one explicitly by contributing from that project's directory. This
 *   favors the safe default (visible to all) over silently guessing a namespace.
 */
async function resolveLearningsSubdir(localConfig: LocalConfig): Promise<string> {
  const namespaces = await resolveActiveLearningsNamespaces(
    localConfig.repo.localPath,
    localConfig.projects ?? [],
  );
  const sub = namespaces.length === 1 ? namespaces[0] : '';
  // Defense-in-depth: the namespace is a path component here. It is validated at
  // the manifest boundary, but refuse anything that isn't a safe single segment
  // rather than let it escape the learnings/ directory.
  if (sub && !isSafeNamespaceSegment(sub)) {
    throw new Error(`Invalid learnings namespace "${sub}": must not contain path separators or '..'`);
  }
  return sub;
}

/**
 * Rebuild this scope's local search index so the freshly-written contribution
 * (and anything pulled just before it) is immediately recallable — otherwise
 * `recall` only picks it up after the next `teamai pull` rebuilds the index (#85).
 */
async function rebuildIndexAfterContribute(localConfig: LocalConfig): Promise<void> {
  const repoPath = localConfig.repo.localPath;
  const docsRepoDir = path.join(repoPath, 'docs');
  const rulesRepoDir = path.join(repoPath, 'rules');
  const skillsRepoDir = path.join(repoPath, 'skills');
  const votesDir = path.join(getReportsDir(localConfig), 'votes');

  const activeLearningsNamespaces = await resolveActiveLearningsNamespaces(
    repoPath,
    localConfig.projects ?? [],
  );

  const teamaiHome = getDataHome(localConfig);
  const indexPath = path.join(teamaiHome, 'search-index.json');
  const { buildIndex } = await import('./utils/search-index.js');
  await buildIndex({
    // The durable copy of a contribution that could not be published is a
    // learnings root too. Without it, a member whose worktree cannot be created
    // at all keeps the note but cannot recall it until it publishes — and
    // before learnings moved to their own branch, it was always findable.
    learningsDirs: [pendingLearningsDir(localConfig), ...learningsRoots(localConfig).read],
    // Manifest-resolved namespaces — MUST match what pull indexes by, or a
    // contribute-time rebuild drops the project's other learnings from recall.
    learningsNamespaces: activeLearningsNamespaces,
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
//      ├─ requireInit() → localConfig + username
//      ├─ readFile(path) → validate non-empty
//      ├─ generateFilename(title) → <title-slug>-<date>-<random>.md
//      ├─ publishLearning() → the one place that knows the destination
//      ├─ rebuildIndexAfterContribute() → recallable from the branch worktree
//      │   ├── confirmed on origin → markContributed()
//      │   └── not confirmed → keep a durable copy, retried by the next pull
//      └─ done
//

/**
 * Generate a safe filename for a contribution document.
 *
 * Format: <title-slug>-<date>-<random>.md
 *
 * The title is slugified (lowercase, hyphens, max 50 chars).
 * A 6-char random suffix avoids collisions.
 */
function generateFilename(title?: string): string {
  const slug = (title ?? 'session-notes')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-') // Allow CJK characters
    .replace(/^-+|-+$/g, '') // Trim leading/trailing hyphens
    .slice(0, 50);

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const random = Math.random().toString(36).slice(2, 8);
  return `${slug}-${date}-${random}.md`;
}

/**
 * Handle `teamai contribute --file <path> [--title <title>]`.
 *
 * The contribution goes to the `teamai-learnings` branch, with no pull request
 * and no commit on the default branch. What cannot be published right now is
 * kept outside the clone and retried by the next `teamai pull`.
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
    if (!cfg) { log.error('No project-level teamai config in this directory'); return; }
    localConfig = cfg;
  } else if (options.scope === 'user') {
    const { localConfig: userCfg } = await requireInit();
    localConfig = userCfg;
  } else {
    // Auto-detect (unchanged default behavior)
    const projectConfig = await detectProjectConfig();
    localConfig = projectConfig ?? (await requireInit()).localConfig;
  }
  assertNotReadOnly(localConfig, 'teamai contribute');
  const username = localConfig.username;

  const filename = generateFilename(options.title);
  // Route into an active-project subdir when there is exactly one, else the
  // shared root. `relPath` is the learnings-relative path used everywhere.
  const learningsSubdir = await resolveLearningsSubdir(localConfig);
  const relPath = learningsSubdir ? path.posix.join(learningsSubdir, filename) : filename;

  if (options.dryRun) {
    log.info(`[dry-run] Would push: learnings/${relPath} (${content.length} bytes)`);
    return;
  }

  const spin = spinner('Contributing session knowledge...').start();

  // Publishing creates a worktree under `.teamai/`. A single-repo install whose
  // `.gitignore` predates it would show that worktree in the user's own
  // `git status`, so self-heal it first — `pull` and `push` already do.
  if (isSelfMode(localConfig)) {
    const { migrateSelfModeGitignore } = await import('./init.js');
    await migrateSelfModeGitignore(localConfig);
  }

  const result = await publishLearning(localConfig, username, relPath, content);

  // Rebuild the index either way: the learning is in the branch worktree, which
  // is a read root, whether or not the push that follows it reached origin.
  const published = result.status === 'published' || result.status === 'already-present';

  // Not on origin: keep a durable copy outside anything git rewrites, so the
  // next pull can deliver it. It has to exist before the index is rebuilt, or
  // a contribution whose worktree could not be created at all would be kept
  // and still be unfindable.
  let saved = false;
  if (!published) {
    try {
      await savePendingLearning(localConfig, relPath, content);
      saved = true;
    } catch (e) {
      spin.fail(`Contribution failed: ${(e as Error).message}`);
      log.info('You can retry with: teamai contribute --file <path>');
      return;
    }
  }

  try {
    await rebuildIndexAfterContribute(localConfig);
  } catch (e) {
    log.debug(`contribute: index rebuild skipped: ${(e as Error).message}`);
  }

  const sessionId = options.sessionId || process.env.CLAUDE_SESSION_ID || '';
  if (sessionId) {
    await markContributed(sessionId);
  }

  if (published) {
    spin.succeed(`Contributed: learnings/${relPath}`);
    log.info('Your session knowledge has been shared with the team.');
    return;
  }

  if (saved) {
    const reason = result.status === 'failed' ? result.reason : 'another teamai write is in progress';
    spin.warn(`Saved locally (${reason}). Will retry on the next pull.`);
  }
}
