import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { requireInit, detectProjectConfig, loadLocalConfigForScope } from './config.js';
import { assertNotReadOnly } from './read-only.js';
import { pathExists } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { markContributed } from './contribute-check.js';
import { agentSessionFromEnv } from './utils/session-id.js';
import { splitFrontmatter, stringifyFrontmatter } from './utils/frontmatter.js';
import { AgentSession } from './session-flow/agent-session.js';
import { SessionCaptures } from './session-flow/captures.js';
import type { SessionSubject } from './scorers/label.js';
import { appendEvent, dataHomeKey } from './dashboard-collector.js';
import { ATTEMPT_ENV, sessionRun } from './launch-context.js';
import { learningIdOf } from './outcomes.js';
import { appendAttemptOutcome } from './workflow/store.js';
import { pendingLearningsDir, queueWriteRefusal, savePendingLearning } from './utils/pending-learnings.js';
import { publishQueuedLearnings } from './utils/learnings-publish.js';
import { indexableLearningsRoots } from './utils/learnings-roots.js';
import { resolveActiveLearningsNamespaces } from './projects.js';
import { isSafeNamespaceSegment } from './manifest-schema.js';
import { deliveredLearningsNamespaces, readWorkspaceChildren } from './workspace-children.js';
import type { GlobalOptions, LocalConfig, Scope } from './types.js';
import { getDataHome, getProjectSearchIndexPath, isSelfMode, parseInstallScope } from './types.js';

/**
 * Decide which learnings subdirectory a contribution lands in — resolved from
 * the manifest's `resources.learnings`, the SAME mapping `pull` indexes by (NOT
 * the raw project id, which the schema allows to differ). Async because it reads
 * the manifest.
 *
 * - Exactly one active learnings namespace → that namespace's subdir (isolated).
 * - Zero (no role or active project declares a learnings namespace) →
 *   the shared root (empty string).
 * - Multiple active learnings namespaces → the shared root, because the
 *   contribution's ownership is ambiguous. `contribute --namespace` lets the
 *   member choose one of these namespaces without changing this default.
 */
export async function resolveLearningsSubdir(localConfig: LocalConfig): Promise<string> {
  const namespaces = await resolveActiveLearningsNamespaces(localConfig);
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

  // A workspace's children's too (#913).
  const activeLearningsNamespaces = await deliveredLearningsNamespaces(localConfig);

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
    voteScope: localConfig,
    indexPath,
    children: localConfig.children?.fingerprint,
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
 * The session a contribution names: `--session-id`, else the tool's session variable. Its platform is resolved as
 * `teamai score --session` resolves it: the variable's tool family when the variable names that session, else the
 * one platform the session's captures name. Undefined when no session is named.
 */
async function contributedSession(localConfig: LocalConfig, named: string | undefined): Promise<ContributedSession | undefined> {
  const env = await agentSessionFromEnv();
  const sessionId = named || env.id;
  if (!sessionId) return undefined;
  const own = env.id === sessionId;
  const fromEnv = own && env.agent ? AgentSession.platformForTool(env.agent) : undefined;
  const captured = fromEnv === undefined ? await SessionCaptures.platformsOf(localConfig, sessionId) : [];
  const platform = fromEnv ?? (captured.length === 1 ? captured[0] : undefined);
  const tool = own ? env.agent : platform && AgentSession.toolForPlatform(platform);
  return { sessionId, own, ...(platform ? { platform } : {}), ...(tool ? { tool } : {}) };
}

/** The session a contribution names, and whether this process runs in it, so its run mode and launcher are that session's. */
interface ContributedSession {
  sessionId: string;
  own: boolean;
  platform?: string;
  tool?: string;
}

/** Record the learning at `relPath` as an outcome of `session`, on this machine only. */
async function recordLearningOutcome(localConfig: LocalConfig, session: ContributedSession, relPath: string): Promise<void> {
  await appendEvent({
    type: 'session_outcome',
    timestamp: new Date().toISOString(),
    sessionId: session.sessionId,
    ...(session.tool ? { tool: session.tool } : {}),
    dataHomeKey: await dataHomeKey(getDataHome(localConfig)),
    ...(session.own ? sessionRun(process.env) : {}),
    outcomes: [{ kind: 'learning', id: learningIdOf(relPath) }],
  });
}

/**
 * Record the learning at `relPath` on the workflow attempt `marker` names, for the engine to put on the step's pass when
 * the attempt settles. Not recording it never fails the contribution.
 */
async function recordStepOutcome(localConfig: LocalConfig, marker: string, relPath: string): Promise<void> {
  const id = learningIdOf(relPath);
  let recorded: Awaited<ReturnType<typeof appendAttemptOutcome>>;
  try {
    recorded = await appendAttemptOutcome(localConfig, marker, { kind: 'learning', id });
  } catch (e) {
    log.warn(`Learning ${id} is not recorded on workflow attempt ${marker}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  switch (recorded) {
    case 'appended': return;
    case 'bad_marker':
      log.warn(`Learning ${id} is not recorded on a workflow step: ${ATTEMPT_ENV} is "${marker}", not <run>/<attempt>.`);
      return;
    case 'unknown_run':
      log.warn(`Learning ${id} is not recorded on workflow attempt ${marker}: this scope holds no such run. Run teamai contribute in the step's checkout, or pass --scope with the scope the run started in.`);
      return;
    default: {
      const unhandled: never = recorded;
      return unhandled;
    }
  }
}

/**
 * `content` with `session: { platform, sessionId }` in its frontmatter. The line is added to the block as written, so
 * the author's own fields keep their spelling; a block that already has a `session` is rewritten with this one. A block
 * that does not parse is left as it is.
 */
function withSessionField(content: string, session: SessionSubject): string {
  const line = `session: ${YAML.stringify(session, { collectionStyle: 'flow' }).trimEnd()}`;
  const { raw, valid, data, body } = splitFrontmatter(content);
  if (!raw) return `---\n${line}\n---\n${body}`;
  if (!valid) return content;
  if ('session' in data) return stringifyFrontmatter({ ...data, session }, body);
  return raw.replace(/(\r?\n)(---[ \t]*(?:\r?\n)?)$/, `$1${line}$1$2`) + body;
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
  options: GlobalOptions & { file?: string; title?: string; sessionId?: string; scope?: string; namespace?: string },
): Promise<void> {
  // Validate file
  if (!options.file) {
    log.error('Usage: teamai contribute --file <path> [--title <title>] [--namespace <ns>]');
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

  // Init check — select scope based on --scope flag or auto-detect. The flag
  // reaches the loaders: a bare load migrates the legacy role config in place,
  // which would write under --dry-run (#850).
  const loadOpts = { dryRun: options.dryRun };
  let scope: Scope | undefined;
  try {
    scope = options.scope === undefined ? undefined : parseInstallScope(options.scope);
  } catch (e) {
    log.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  let localConfig: LocalConfig;
  if (scope === 'project') {
    const cfg = await loadLocalConfigForScope('project', process.cwd(), loadOpts);
    if (!cfg) { log.error('No workspace teamai config in this directory'); return; }
    localConfig = cfg;
  } else if (scope === 'user') {
    const { localConfig: userCfg } = await requireInit(loadOpts);
    localConfig = userCfg;
  } else {
    // Auto-detect (unchanged default behavior)
    const projectConfig = await detectProjectConfig(undefined, undefined, loadOpts);
    localConfig = projectConfig ?? (await requireInit(loadOpts)).localConfig;
  }
  assertNotReadOnly(localConfig, 'teamai contribute');
  const username = localConfig.username;
  localConfig = await readWorkspaceChildren(localConfig);

  const filename = generateFilename(options.title);
  // The own selection picks the default; --namespace accepts any namespace this
  // scope reads, a workspace's children's included (#913).
  const ownNamespaces = await resolveActiveLearningsNamespaces(localConfig);
  const namespaces = await deliveredLearningsNamespaces(localConfig);
  // Validate before saving the queue, creating worktrees or rebuilding indexes.
  // An empty --namespace names the shared root, which every member may write.
  if (options.namespace !== undefined && options.namespace !== '' &&
      (!isSafeNamespaceSegment(options.namespace) || !namespaces.includes(options.namespace))) {
    log.error(`Cannot contribute to namespace "${options.namespace}". Allowed learnings namespaces: ${namespaces.join(', ') || '(none)'}.`);
    process.exitCode = 1;
    return;
  }
  const learningsSubdir = options.namespace ?? (ownNamespaces.length === 1 ? ownNamespaces[0] : '');
  if (options.namespace === undefined && !learningsSubdir && namespaces.length > 0) {
    log.info(`Contributing to learnings/ (shared root). To choose a namespace, pass --namespace <ns>: ${namespaces.join(', ')}.`);
  }
  // Keep the chosen path in the queue so retries publish to the same namespace.
  const relPath = learningsSubdir ? path.posix.join(learningsSubdir, filename) : filename;

  if (options.dryRun) {
    log.info(`[dry-run] Would push: learnings/${relPath} (${content.length} bytes)`);
    return;
  }

  const spin = (await spinner('Contributing session knowledge...')).start();

  // Publishing creates a worktree under `.teamai/`. A single-repo install whose
  // `.gitignore` predates it would show that worktree in the user's own
  // `git status`, so self-heal it first — `pull` and `push` already do.
  if (isSelfMode(localConfig)) {
    const { migrateSelfModeGitignore } = await import('./init.js');
    await migrateSelfModeGitignore(localConfig);
  }

  const session = await contributedSession(localConfig, options.sessionId);
  try {
    const queued = await savePendingLearning(localConfig, relPath, session?.platform
      ? withSessionField(content, { platform: session.platform, sessionId: session.sessionId })
      : content);
    if (queued.status !== 'saved') {
      spin.fail(queueWriteRefusal(queued));
      process.exitCode = 1;
      return;
    }
    if (session) await recordLearningOutcome(localConfig, session, relPath);
    const attempt = process.env[ATTEMPT_ENV];
    if (attempt) await recordStepOutcome(localConfig, attempt, relPath);
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
  if (session) {
    await markContributed(session.sessionId);
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
