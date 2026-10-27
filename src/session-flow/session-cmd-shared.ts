import readline from 'node:readline';
import * as path from 'node:path';
import { getAdapter } from './adapters/index.js';
import {
  AgentSession,
  noAdapter,
  recordedToolRoots,
  type AgentSessionListed,
} from './agent-session.js';
import {
  SyncManager,
  getRepoIdentity,
  getGitAuthor,
} from './sync.js';
import { getReportsDir, isSelfMode, usesBranchWorktree, type LocalConfig } from '../types.js';
import { isInteractive } from '../utils/prompt.js';
import { readableReportsWorktree, updateReports } from '../utils/reports-branch.js';
import type { WorkflowEnvelope } from '../workflow/types.js';
import { worktreeCheckout } from '../workflow/worktree.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** `  (12 msgs)` or `  (12 msgs, 4.0KB)`; nothing when the tool's listing does not count (OpenCode). */
export function listedCounts(m: AgentSessionListed, { includeSize = false } = {}): string {
  if (m.messageCount === undefined) return '';
  if (!includeSize || m.sizeBytes === undefined) return `  (${m.messageCount} msgs)`;
  return `  (${m.messageCount} msgs, ${formatBytes(m.sizeBytes)})`;
}

/**
 * Strip terminal control sequences before printing untrusted text.
 *
 * Session titles, author names, repo identities, and search snippets all come
 * from the team repo — anything a member pushes lands in someone else's
 * terminal. ANSI/OSC sequences can move the cursor, clear the screen, change
 * the title, or even disguise the output as another command's result (the
 * same class of overwrite as `\r`). Always strip control characters before display.
 */
// oxlint-disable-next-line no-control-regex
const CONTROL_SEQ_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function safeText(value: string): string {
  return String(value ?? '').replace(CONTROL_SEQ_RE, ' ');
}

/**
 * Prefetch every stdin line into a queue; ask consumes from the queue.
 *
 * Do not wait on rl.question one call at a time: with piped batch input,
 * multiple question callbacks race (after the previous question shifts its
 * callback and before the next callback is registered, intervening input
 * lines are dropped). A queue reader is stable on both a TTY and a pipe.
 */
let lineQueue: string[] = [];
let lineResolver: ((line: string) => void) | null = null;
let lineReaderStarted = false;
let sharedRl: readline.Interface | null = null;

function startLineReader(): void {
  if (lineReaderStarted) return;
  lineReaderStarted = true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  sharedRl = rl;
  rl.on('line', (line) => {
    if (lineResolver) {
      const r = lineResolver;
      lineResolver = null;
      r(line.trim());
    } else {
      lineQueue.push(line.trim());
    }
  });
}

/**
 * Close the readline interface and release the event loop.
 * Must be called after all interactive input, or the process hangs and never
 * exits (the terminal does not return a prompt).
 */
export function closeStdin(): void {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
  }
  lineResolver = null;
}

/**
 * Read one line of user input (interactive). Prefer the prefetched queue;
 * otherwise wait for the next line.
 */
export function ask(question: string): Promise<string> {
  startLineReader();
  return new Promise((resolve) => {
    if (lineQueue.length > 0) {
      resolve(lineQueue.shift() as string);
      return;
    }
    // When stdin closes (EOF / pipe end), 'line' never fires and the promise
    // hangs until the event loop drains, then the process exits silently —
    // a scripted call gets exit 0 and no output, which looks like success.
    // Resolve an empty string explicitly so callers take their own "Cancelled." branch.
    const onEnd = () => {
      if (lineResolver) {
        const r = lineResolver;
        lineResolver = null;
        r('');
      }
    };
    sharedRl?.once?.('close', onEnd);
    lineResolver = (line) => {
      sharedRl?.off?.('close', onEnd);
      resolve(line);
    };
    process.stdout.write(question);
  });
}

type ArchiveConsent = 'ok' | 'declined' | 'refused';

/**
 * Unredacted transcripts are team-readable. Interactive runs ask first.
 * `-y` is the explicit yes for scripts (it also skips the large-batch prompt).
 * `--scrub` redacts before anything is written. A non-interactive run with
 * neither flag used to archive anyway and only warn afterwards.
 */
export async function confirmUnredactedArchive(
  count: number,
  sourceLabel: string,
  opts: { scrub?: boolean; yes?: boolean },
): Promise<ArchiveConsent> {
  if (opts.scrub || opts.yes) return 'ok';
  if (!isInteractive()) return 'refused';
  console.log(`\n  ⚠ About to archive ${count} unredacted session(s) from ${sourceLabel}.`);
  console.log(
    '    Archived sessions are team-readable: full prompts, tool output, file paths and any secret in them.',
  );
  console.log('    Re-run with --scrub to redact secret-shaped values first, or -y to archive as-is.');
  const ans = await ask('Archive as-is? (y/N): ');
  if (!/^y(es)?$/i.test(ans.trim())) return 'declined';
  return 'ok';
}

/**
 * Look up an adapter safely; an invalid platform gets a friendly message
 * instead of a stack trace. Its store follows the tool roots recorded for `cwd`.
 */
export async function safeGetAdapter(platform: string, cwd: string | undefined) {
  const unknown = noAdapter(platform, 'read');
  if (unknown) {
    console.error(`Error: ${unknown.message}`);
    process.exit(1);
  }
  return getAdapter(platform, await recordedToolRoots(cwd));
}

/**
 * Archive author: prefer the git identity of the session's own workspace.
 *
 * `push --all` archives sessions from several workspaces (possibly different
 * repos and different local identities) together. Signing them all with the
 * identity of the directory the CLI happens to run in attributes other
 * people's sessions to the current user and makes `--author` filtering lie.
 * When that identity is unavailable, fall back to the run directory's identity.
 */
export function authorForCwd(cwd: string | undefined, fallback: string): string {
  if (!cwd || !path.isAbsolute(cwd)) return fallback;
  try {
    const author = getGitAuthor(cwd);
    return author && author !== 'unknown' ? author : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Resolve the current cwd's repoIdentity (canonical git remote).
 * A non-git directory returns null (falls back to _unattributed) without an error.
 */
export function resolveRepoIdentity(cwd?: string): string | null {
  return getRepoIdentity(cwd ?? process.cwd());
}

/**
 * Derive the archive key (repoIdentity) from the session's **native cwd**.
 * Key invariant: the archive key comes from the session's own working
 * directory, never from the directory the CLI happens to be running in
 * (design doc P3).
 *
 * Each adapter's readSession already tries to recover the native cwd:
 * - codex / workbuddy: storage includes the real path
 * - claude-code / codebuddy / cursor: recovered from the cwd field recorded in JSONL
 * - codebuddy-ide: the workspace directory is an irreversible md5(cwd). When
 *   the real path cannot be recovered, session.cwd is an `md5:<hash>`
 *   placeholder, the session goes under `_unattributed`, and an English warning is printed
 */
export function deriveArchiveIdentity(session: { cwd: string }, platform: string): string | null {
  const nativeCwd = session.cwd;
  if (nativeCwd && path.isAbsolute(nativeCwd)) {
    // A workflow step's worktree is removed once the step is done; the checkout it was made from has the same remote.
    return getRepoIdentity(worktreeCheckout(nativeCwd) ?? nativeCwd);
  }
  console.warn(
    `  ⚠ native cwd unknowable for ${platform} session, archived under _unattributed`,
  );
  return null;
}

/** Where this machine has the team session archive: the teamai-reports checkout. An http team has none. */
export function sessionArchiveRoot(config: LocalConfig): string | undefined {
  return usesBranchWorktree(config) ? getReportsDir(config) : undefined;
}

/**
 * Resolve the session archive root a session command works in: --repo-root, else the archive of this workspace's
 * install, else of the user install (see sessionArchiveRoot). Without one, this throws, and the CLI entry point
 * reports the reason and fails the run.
 * `reports` is set when that archive is the teamai-reports checkout: a write there goes through `updateReports` with it.
 * A `read` gets that checkout as `readableReportsWorktree` leaves it. On a git-kind team, `legacy` is the team clone,
 * which holds the archive teamai kept on the default branch before: it is read after `root`, and never written.
 */
export async function resolveRepoRoot(
  repoRoot: string | undefined,
  options: { dryRun: boolean; read?: boolean },
): Promise<{ root: string; reports?: LocalConfig; legacy?: string }> {
  if (repoRoot?.trim()) return { root: repoRoot.trim() };
  const { detectProjectConfig, requireInit, NotInitializedError } = await import('../config.js');
  const loadOpts = { dryRun: options.dryRun };
  let cfg: LocalConfig;
  try {
    cfg = (await detectProjectConfig(undefined, undefined, loadOpts)) ?? (await requireInit(loadOpts)).localConfig;
  } catch (e) {
    if (!(e instanceof NotInitializedError)) throw e;
    throw new Error(
      'teamai is not set up for this directory. It has no workspace install, and there is no user install. Run `teamai init`, or pass --repo-root <path to the team repo clone>.',
    );
  }
  const archives = await sessionArchives(cfg, options);
  if (!archives) {
    throw new Error(
      'This teamai install keeps no team repo clone on this machine, so it has no session archive. Pass --repo-root <path to a team repo clone>.',
    );
  }
  return archives;
}

/**
 * The session archive of install `cfg`, as `resolveRepoRoot` gives it, or undefined when it keeps none: an http team,
 * or an install with no team repo clone. Throws when the teamai-reports checkout cannot be read.
 */
export async function sessionArchives(
  cfg: LocalConfig,
  options: { dryRun: boolean; read?: boolean },
): Promise<{ root: string; reports: LocalConfig; legacy?: string } | undefined> {
  const root = cfg.repo.localPath?.trim() ? sessionArchiveRoot(cfg) : undefined;
  if (!root) return undefined;
  const legacy = isSelfMode(cfg) ? {} : { legacy: cfg.repo.localPath };
  // A writer opens the checkout itself, under the lock, in updateReports.
  if (!options.read) return { root, reports: cfg, ...legacy };
  try {
    return { root: await readableReportsWorktree(cfg, { dryRun: options.dryRun }), reports: cfg, ...legacy };
  } catch (e) {
    throw new Error(safeText(e instanceof Error ? e.message : String(e)));
  }
}

export const REPORTS_ARCHIVE_BUSY =
  'Another teamai command is writing teamai-reports, so nothing was archived. Run this command again once it has finished.';

/** What became of sessions archived on teamai-reports. `stopped`: `save` hit a failure it already reported, and nothing was published. */
export type ReportsArchive =
  | { status: 'busy' }
  | { status: 'stopped' }
  | { status: 'published' | 'already-present'; saved: number }
  | { status: 'failed'; saved: number; reason: string };

/**
 * Archive sessions on teamai-reports under the lock every teamai-reports writer takes: `save` writes them into the
 * checkout and returns how many, or undefined once it reported a failure; what it wrote is committed and pushed.
 * While another write holds the lock, `save` never runs.
 */
export async function archiveToReports(
  reports: LocalConfig,
  save: (syncMgr: SyncManager, root: string) => Promise<number | undefined>,
  commitMessage: (saved: number) => string,
): Promise<ReportsArchive> {
  // Stays 0 when the write never ran, so a failure before it is still reported.
  let saved: number | undefined = 0;
  const result = await updateReports(reports, async (worktree) => {
    const syncMgr = new SyncManager(worktree);
    saved = await save(syncMgr, worktree);
    return saved ? { files: syncMgr.writtenFiles(), message: commitMessage(saved) } : null;
  });
  if (result.status === 'busy') return result;
  if (saved === undefined) return { status: 'stopped' };
  if (result.status === 'failed') return { status: 'failed', saved, reason: result.reason };
  return { status: result.status, saved };
}

/**
 * Push the team repo to the remote; on failure, degrade to a warning instead of crashing.
 *
 * By the time we get here, the local saveSession + gitCommit have already
 * succeeded — the session data is not lost. Remote failures are often
 * unrelated to the data (no upstream, read-only HTTP mode, network). Blowing
 * up with a stack trace would disguise a successful archive as a total
 * failure, and running it again would create duplicate commits.
 */
export async function pushToRemote(syncMgr: SyncManager, repoRoot: string): Promise<boolean> {
  const pushed = await pushArchive(syncMgr, repoRoot);
  if (pushed.status === 'pushed') return true;
  // The local commit is kept, so nothing is lost -- but this is still a
  // failure and must not be printed as "✓ Pushed".
  console.error(`  ✗ Remote push failed (local commit kept): ${pushed.reason}`);
  return false;
}

/** Push the team repo's archive commits; a merge the push needs that stops on the session indexes is finished by rebuilding them. */
export async function pushArchive(syncMgr: SyncManager, repoRoot: string): Promise<{ status: 'pushed' } | { status: 'failed'; reason: string }> {
  try {
    const pushed = syncMgr.gitPush();
    if (pushed.status === 'indexes-conflicted') {
      const merged = await syncMgr.commitRebuiltIndexes(pushed.indexes);
      if (merged.status === 'busy') throw new Error(mergeBusyMessage(repoRoot, merged.lockPath));
      if (syncMgr.gitPush().status !== 'pushed') {
        throw new Error(`The remote moved on again and its merge stopped on the session indexes; run \`teamai session pull\` to finish it.`);
      }
    }
    return { status: 'pushed' };
  } catch (err) {
    return { status: 'failed', reason: gitFailureReason(err) };
  }
}

/**
 * Pull the team repo's archive. A merge that stops on the session indexes, an earlier pull's included, is finished by
 * rebuilding them under the index lock; the network pull takes no lock. `rebuilt` counts the indexes rebuilt.
 */
export async function pullArchive(syncMgr: SyncManager, repoRoot: string): Promise<{ status: 'pulled'; rebuilt: number } | { status: 'failed'; reason: string }> {
  let rebuilt = 0;
  const finishMerge = async (indexes: string[]): Promise<string | undefined> => {
    const merged = await syncMgr.commitRebuiltIndexes(indexes);
    if (merged.status === 'busy') return mergeBusyMessage(repoRoot, merged.lockPath);
    rebuilt += indexes.length;
    return undefined;
  };
  try {
    let pulled = syncMgr.gitPull();
    if (pulled.status === 'indexes-conflicted' && pulled.pending) {
      const busy = await finishMerge(pulled.indexes);
      if (busy) return { status: 'failed', reason: busy };
      pulled = syncMgr.gitPull();
    }
    if (pulled.status === 'stopped') return { status: 'failed', reason: pulled.reason };
    if (pulled.status === 'indexes-conflicted') {
      const busy = await finishMerge(pulled.indexes);
      if (busy) return { status: 'failed', reason: busy };
    }
    return { status: 'pulled', rebuilt };
  } catch (err) {
    return {
      status: 'failed',
      reason: `git pull failed in ${repoRoot}: ${gitFailureReason(err)}. Check that ${repoRoot} is a git repository with a configured remote, then retry.`,
    };
  }
}

/** The first line ("Command failed: git ...") only repeats the command; git's fatal/error line is the actual reason. */
function gitFailureReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const fatal = msg.split('\n').find((l) => /^(fatal|error):/i.test(l.trim()));
  return safeText(fatal?.trim() ?? msg.split('\n')[0]);
}

/**
 * Wrap gitCommit / gitPull: a git-layer failure (not a git directory, no
 * remote, index.lock race, and so on) prints a single English error line and
 * exits 1, instead of letting execFileSync's exception hit the user as a raw
 * stack trace (leaked internal paths plus a fake sense of a crash).
 */
export function runGitStep<T>(step: () => T, repoRoot: string, what: string): T {
  try {
    return step();
  } catch (err) {
    console.error(`Error: ${what} failed in ${repoRoot}: ${gitFailureReason(err)}`);
    console.error(`Check that ${repoRoot} is a git repository with a configured remote, then retry.`);
    process.exit(1);
  }
}

export function archiveBusyMessage(repoRoot: string, lockPath: string): string {
  return `another teamai command is writing the session archive in ${repoRoot} (lock: ${lockPath}).`;
}

/** A pull merged the remote, but the session indexes it left conflicted wait for the lock another command holds. */
export function mergeBusyMessage(repoRoot: string, lockPath: string): string {
  return `${archiveBusyMessage(repoRoot, lockPath)} The pull is left mid-merge on the session indexes; run \`teamai session pull\` once it has finished.`;
}

/** Another command held the session archive lock for the whole wait: this write did not happen, so fail the run. */
export function reportArchiveBusy(repoRoot: string, lockPath: string): void {
  console.error(`Error: ${archiveBusyMessage(repoRoot, lockPath)}`);
  console.error('Run this command again once it has finished.');
  process.exitCode = 1;
}

/** `session migrate --json` prints the same `{ data } | { error }` envelope as the workflow commands. */
export function printEnvelope(envelope: WorkflowEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  if ('error' in envelope) process.exitCode = 1;
}

/**
 * The sessions of `platform` in `cwd`, or in every workspace without it. When the platform could
 * not be listed, its failure is printed (as the envelope under --json), the run fails, and the
 * result is undefined.
 */
export async function listSource({
  platform,
  cwd,
  asEnvelope = false,
}: {
  platform: string;
  cwd?: string;
  asEnvelope?: boolean;
}): Promise<AgentSessionListed[] | undefined> {
  const {
    sessions,
    failures: [failure],
  } = await AgentSession.list({ platforms: [platform], cwd });
  if (!failure) return sessions;
  if (asEnvelope) {
    printEnvelope({ error: { code: failure.code, message: failure.message } });
  } else {
    console.error(`Error: ${failure.message}`);
    process.exitCode = 1;
  }
  return undefined;
}
