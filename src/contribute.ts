import fs from 'node:fs';
import path from 'node:path';
import { requireInit, detectProjectConfig, loadLocalConfigForScope } from './config.js';
import { assertNotReadOnly } from './read-only.js';
import { pathExists } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { markContributed } from './contribute-check.js';
import { pendingLearningsDir, queueWriteRefusal, savePendingLearning } from './utils/pending-learnings.js';
import { publishQueuedLearnings } from './utils/learnings-publish.js';
import { indexableLearningsRoots } from './utils/learnings-roots.js';
import { resolveActiveLearningsNamespaces } from './projects.js';
import { isSafeNamespaceSegment } from './manifest-schema.js';
import type { GlobalOptions, LocalConfig } from './types.js';
import { getProjectSearchIndexPath, isSelfMode } from './types.js';

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
export async function resolveLearningsSubdir(localConfig: LocalConfig): Promise<string> {
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
 *
 * The queue is indexed FIRST, ahead of the published roots: a contribution is
 * recallable the moment it is written, whether or not it has reached origin, and
 * a queued edit of a published learning is the copy recall serves.
 */
export async function rebuildIndexAfterContribute(localConfig: LocalConfig): Promise<void> {
  const repoPath = localConfig.repo.localPath;
  const docsRepoDir = path.join(repoPath, 'docs');
  const rulesRepoDir = path.join(repoPath, 'rules');
  // Not another repository's reports checkout (#808).
  const { indexableVotesDir } = await import('./utils/reports-branch.js');
  const votesDir = await indexableVotesDir(localConfig);

  const activeLearningsNamespaces = await resolveActiveLearningsNamespaces(
    repoPath,
    localConfig.projects ?? [],
  );

  const indexPath = getProjectSearchIndexPath(localConfig);
  const { buildIndex, dropOtherCheckoutIndexes } = await import('./utils/search-index.js');
  const { deliveredIndexSources } = await import('./resources/desired.js');
  await dropOtherCheckoutIndexes(localConfig);
  await buildIndex({
    // Without another repository's learnings checkout, if one sits where this
    // project's would (#808).
    learningsDirs: [
      pendingLearningsDir(localConfig),
      ...await indexableLearningsRoots(localConfig),
    ],
    // Manifest-resolved namespaces — MUST match what pull indexes by, or a
    // contribute-time rebuild drops the project's other learnings from recall.
    learningsNamespaces: activeLearningsNamespaces,
    docsDir: (await pathExists(docsRepoDir)) ? docsRepoDir : undefined,
    rulesDir: (await pathExists(rulesRepoDir)) ? rulesRepoDir : undefined,
    // The docs and skills pull delivers here, not the whole trees (#707).
    ...await deliveredIndexSources(localConfig),
    votesDir: votesDir && (await pathExists(votesDir)) ? votesDir : undefined,
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
//      ├─ savePendingLearning() → the durable queue, outside anything git rewrites
//      ├─ rebuildIndexAfterContribute() → recallable now, online or not
//      ├─ publishQueuedLearnings() → the one place that knows the destination
//      │   ├── confirmed on origin → drop the queue entry, markContributed()
//      │   └── not confirmed → keep it queued, retried by the next pull
//      └─ done
//

/**
 * Where a learning saved for an install that changed before it was published
 * is, for the member: still queued, or set aside with the previous install's
 * queue by the `init` that switched it, which names the directory.
 */
export const KEPT_FOR_ITS_INSTALL =
  'It stays on this machine: in the queue, or where `teamai init` set that install\'s queue aside.';

/** What happens to a learning a checkout refusal kept from publishing: every pull meets the refusal too. */
export const KEPT_UNTIL_CHECKOUT_SETTLED =
  'It stays queued and recallable here, but no `teamai pull` can publish it until that checkout is dealt with: ' +
  'do what the refusal says, then run `teamai pull`.';

/**
 * Generate a safe filename for a contribution document.
 *
 * Format: <title-slug>-<date>-<random>.md
 *
 * The title is slugified (lowercase, hyphens, max 50 chars).
 * A 6-char random suffix avoids collisions.
 */
export function generateFilename(title?: string): string {
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
 * The contribution is written to the durable queue first and published from
 * there. Nothing about it depends on the network, on push rights, or on a git
 * operation succeeding right now: what cannot be published stays queued and the
 * next `teamai pull` publishes it, once any checkout refusal that stopped it is
 * dealt with.
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

  try {
    const queued = await savePendingLearning(localConfig, relPath, content);
    if (queued.status !== 'saved') {
      spin.fail(queueWriteRefusal(queued));
      process.exitCode = 1;
      return;
    }
  } catch (e) {
    spin.fail(`Contribution failed: ${(e as Error).message}`);
    log.info('You can retry with: teamai contribute --file <path>');
    return;
  }

  // Index before publishing: recall finds the contribution even when the push
  // below cannot run at all.
  try {
    await rebuildIndexAfterContribute(localConfig);
  } catch (e) {
    log.debug(`contribute: index rebuild skipped: ${(e as Error).message}`);
  }

  const report = await publishQueuedLearnings(localConfig, username);

  // Publishing dropped the just-published files from the pending queue, but the
  // index built above still points recall at those now-deleted pending paths —
  // the agent is handed a File that no longer exists (#705). Rebuild once more so
  // every published entry resolves to its durable worktree copy instead. Only
  // when something actually reached origin; a still-queued contribution keeps its
  // pending path, which is exactly where it is still readable.
  if (report.published.length > 0) {
    try {
      await rebuildIndexAfterContribute(localConfig);
    } catch (e) {
      log.debug(`contribute: post-publish index rebuild skipped: ${(e as Error).message}`);
    }
  }

  // The session counts as contributed once the note is durably queued, not once
  // it reaches origin: the queue always retries, and re-contributing the same
  // session would add a second copy of the same knowledge rather than fix
  // anything. `pull` and `doctor` are what tell the user it is still queued.
  const sessionId = options.sessionId || process.env.CLAUDE_SESSION_ID || '';
  if (sessionId) {
    await markContributed(sessionId);
  }

  if (report.published.includes(relPath)) {
    spin.succeed(`Contributed: learnings/${relPath}`);
    log.info('Your session knowledge has been shared with the team.');
    return;
  }
  if (report.installChanged) {
    spin.warn(`Saved locally, not published: ${report.installChanged}. ${KEPT_FOR_ITS_INSTALL}`);
    return;
  }

  spin.warn(
    `Saved locally (${report.lastError ?? 'not published yet'}). `
    + (report.refused ? KEPT_UNTIL_CHECKOUT_SETTLED : 'It stays recallable here and the next `teamai pull` publishes it.'),
  );
}
