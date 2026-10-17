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
  withSessionIndexLock,
} from './sync.js';
import { isInteractive } from '../utils/prompt.js';
import type { WorkflowEnvelope } from '../workflow/types.js';

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
    return getRepoIdentity(nativeCwd);
  }
  console.warn(
    `  ⚠ native cwd unknowable for ${platform} session, archived under _unattributed`,
  );
  return null;
}

/**
 * Resolve the team-repo root.
 * Prefer --repo-root; otherwise use cwd (assuming cwd is the team-repo clone).
 */
export async function resolveRepoRoot(
  repoRoot?: string,
  options?: { materialize?: boolean },
): Promise<string> {
  if (repoRoot?.trim()) return repoRoot.trim();
  const { detectProjectConfig } = await import('../config.js');
  const { getReportsDir, isSelfMode } = await import('../types.js');
  const { ensureReportsWorktree } = await import('../utils/reports-branch.js');
  const cfg = await detectProjectConfig();
  if (!cfg || cfg.repo.kind === 'http' || !cfg.repo.localPath?.trim()) {
    throw new Error(
      'No teamai project config found. Run `teamai init` or pass --repo-root. Session sync will not use the current working directory.',
    );
  }
  if (isSelfMode(cfg)) {
    // Readers and --dry-run must not publish a brand-new teamai-reports branch.
    // The default ensure() pushes the orphan branch as soon as it creates it.
    if (options?.materialize !== false) {
      await ensureReportsWorktree(cfg, { pushIfCreated: false });
    }
    return getReportsDir(cfg);
  }
  return cfg.repo.localPath;
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
  try {
    const pushed = syncMgr.gitPush();
    if (pushed.status === 'indexes-conflicted') {
      const merged = await withSessionIndexLock(repoRoot, async () => syncMgr.commitRebuiltIndexes(pushed.indexes));
      if (merged.status === 'busy') throw new Error(mergeBusyMessage(repoRoot, merged.lockPath));
      if (syncMgr.gitPush().status !== 'pushed') {
        throw new Error(`The remote moved on again and its merge stopped on the session indexes; run \`teamai session pull\` to finish it.`);
      }
    }
    return true;
  } catch (err) {
    // The local commit is kept, so nothing is lost -- but this is still a
    // failure and must not be printed as "✓ Pushed".
    console.error(`  ✗ Remote push failed (local commit kept): ${gitFailureReason(err)}`);
    return false;
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
