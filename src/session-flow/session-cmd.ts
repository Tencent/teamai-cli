/**
 * session-cmd.ts — SessionFlow subcommand registration.
 *
 * Registers SessionFlow's session migrate/sync/search/resume capabilities as
 * subcommands of `teamai session`:
 *
 *   teamai session migrate   Migrate a session across platforms (or archive on the same platform)
 *   teamai session push      Push sessions to the team repo
 *   teamai session pull      Pull the current project's sessions from the team repo
 *   teamai session list      List team members' sessions for the current project
 *   teamai session resume    Restore a session onto a local platform and continue the chat
 *   teamai session search    Search historical session content
 *   teamai session rollback  Roll back one migration
 *
 * Sits alongside the existing `teamai session save` (redacted summary); the two do not interfere.
 *
 * Project isolation: current cwd's git remote origin → canonical → team-repo directory.
 * A non-git directory falls back to _unattributed/ without an error.
 */

import type { Command } from 'commander';
import readline from 'node:readline';
import * as path from 'node:path';
import { getAdapter, listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';
import { previewMigration, resolveTargetCwd } from './migrate.js';
import {
  AgentSession,
  noAdapter,
  recordedToolRoots,
  toolRootsLookup,
  writeCopyOnce,
  type AgentSessionCopy,
  type AgentSessionListed,
} from './agent-session.js';
import { SyncManager, getRepoIdentity, getGitAuthor, defaultSyncMeta, withSessionIndexLock } from './sync.js';
import { SessionSearchEngine, type LoadedSession } from './search.js';
import { isSafeSessionFileId } from './ids.js';
import { isInteractive } from '../utils/prompt.js';
import { setStderrOnly } from '../utils/logger.js';
import type { WorkflowEnvelope } from '../workflow/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** `  (12 msgs)` or `  (12 msgs, 4.0KB)`; nothing when the tool's listing does not count (OpenCode). */
function listedCounts(m: AgentSessionListed, { includeSize = false } = {}): string {
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

function safeText(value: string): string {
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
/** During --all batch migration, list the sessions and require confirmation above this count (-y skips it). */
const BATCH_CONFIRM_THRESHOLD = 10;

/** How many sessions to show per page in the interactive picker (n/p pages). */
const SESSION_PICKER_PAGE_SIZE = 10;


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
function closeStdin(): void {
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
function ask(question: string): Promise<string> {
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
async function confirmUnredactedArchive(
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
 * Show a numbered menu and let the user pick one item.
 * A number or a name is accepted; returns the selected string.
 */
async function promptSelect(question: string, options: string[]): Promise<string> {
  console.log(question);
  for (let i = 0; i < options.length; i++) {
    console.log(`  [${i + 1}] ${options[i]}`);
  }
  const ans = await ask('Select (number or name): ');
  if (!ans) throw new Error('Selection cancelled');
  const num = parseInt(ans, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= options.length) {
    return options[num - 1];
  }
  const lower = ans.toLowerCase();
  const byName = options.find((o) => o.toLowerCase() === lower);
  if (byName) return byName;
  throw new Error(`Invalid selection: ${ans}`);
}

/**
 * Look up an adapter safely; an invalid platform gets a friendly message
 * instead of a stack trace. Its store follows the tool roots recorded for `cwd`.
 */
async function safeGetAdapter(platform: string, cwd: string | undefined) {
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
function authorForCwd(cwd: string | undefined, fallback: string): string {
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
function resolveRepoIdentity(cwd?: string): string | null {
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
function deriveArchiveIdentity(session: { cwd: string }, platform: string): string | null {
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
async function resolveRepoRoot(
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
async function pushToRemote(syncMgr: SyncManager, repoRoot: string): Promise<boolean> {
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
function runGitStep<T>(step: () => T, repoRoot: string, what: string): T {
  try {
    return step();
  } catch (err) {
    console.error(`Error: ${what} failed in ${repoRoot}: ${gitFailureReason(err)}`);
    console.error(`Check that ${repoRoot} is a git repository with a configured remote, then retry.`);
    process.exit(1);
  }
}

function archiveBusyMessage(repoRoot: string, lockPath: string): string {
  return `another teamai command is writing the session archive in ${repoRoot} (lock: ${lockPath}).`;
}

/** A pull merged the remote, but the session indexes it left conflicted wait for the lock another command holds. */
function mergeBusyMessage(repoRoot: string, lockPath: string): string {
  return `${archiveBusyMessage(repoRoot, lockPath)} The pull is left mid-merge on the session indexes; run \`teamai session pull\` once it has finished.`;
}

/** Another command held the session archive lock for the whole wait: this write did not happen, so fail the run. */
function reportArchiveBusy(repoRoot: string, lockPath: string): void {
  console.error(`Error: ${archiveBusyMessage(repoRoot, lockPath)}`);
  console.error('Run this command again once it has finished.');
  process.exitCode = 1;
}

/** What `session migrate --json` reports for one copy: the copy result without its status. */
type MigrateJsonData = Omit<Extract<AgentSessionCopy, { status: 'done' }>, 'status'>;

/** `session migrate --json` prints the same `{ data } | { error }` envelope as the workflow commands. */
function printEnvelope(envelope: WorkflowEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  if ('error' in envelope) process.exitCode = 1;
}

/**
 * The sessions of `platform` in `cwd`, or in every workspace without it. When the platform could
 * not be listed, its failure is printed (as the envelope under --json), the run fails, and the
 * result is undefined.
 */
async function listSource({
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

/**
 * Under --json, stdout carries only the envelope: every progress line, from this command or a
 * logger it reaches, goes to stderr until the returned restore runs.
 */
function reserveStdoutForEnvelope(): () => void {
  const log = console.log;
  console.log = console.error;
  const wasStderrOnly = setStderrOnly(true);
  return () => {
    console.log = log;
    setStderrOnly(wasStderrOnly);
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/**
 * Register SessionFlow's 7 subcommands on the `teamai session` command object.
 */
export function registerSessionFlowCommands(sessionCmd: Command): void {
  // When the output pipe is closed by a downstream consumer (e.g. `session push --all | head`),
  // EPIPE would end the whole command in a stack-trace crash — the data was
  // already written; this is not an error, so exit quietly.
  process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });

  // --dry-run / -v are global options on the top-level program and do not
  // automatically appear in a subcommand's opts.
  // Commands in the original project uniformly take globals via `program.opts()`
  // and merge them with the command's own options (see the init/push/pull
  // actions in src/index.ts); keep the same pattern here.
  const root = sessionCmd.parent ?? sessionCmd;
  const isDryRun = (): boolean => Boolean((root.opts() as { dryRun?: boolean }).dryRun);

  // ── session platforms ──────────────────────────────────────
  sessionCmd
    .command('platforms')
    .description('List supported and installed AI agent platforms')
    .action(async () => {
      const available = listAvailablePlatforms();
      const installed = listInstalledPlatforms(await recordedToolRoots(undefined));
      console.log('Available platforms:');
      for (const p of available) {
        const status = installed.includes(p) ? '✓ installed' : '✗ not installed';
        console.log(`  ${p}: ${status}`);
      }
    });

  // ── session migrate ────────────────────────────────────────
  sessionCmd
    .command('migrate')
    .description('Migrate a session from one platform to another (or archive to same platform)')
    .argument('[sessionId]', 'Session ID to migrate')
    .option('-s, --source <platform>', 'Source platform (e.g. claude-code, codebuddy)')
    .option('-t, --target <platform>', 'Target platform')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--target-cwd <path>', 'Override cwd for the target session')
    .option('--push', 'Also push the migrated session to the team repo')
    .option('--repo-root <path>', 'Team repo root (for --push)')
    .option('--scrub', 'Redact secrets (tokens/keys/passwords) from the session before writing it')
    .option('--all', 'Migrate every session from source (not just the 5 most recent)')
    .option('--limit <n>', 'Max sessions to migrate (only caps --all; ignored otherwise)')
    .option('-y, --yes', 'Skip confirmation prompts, including archiving unredacted transcripts')
    .option('--json', 'Print one {data}|{error} JSON envelope on stdout; never prompts (needs a session id, -s and -t)')
    .action(async (sessionId, opts) => {
      const json = Boolean(opts.json);
      const restoreStdout = json ? reserveStdoutForEnvelope() : undefined;
      try {
      // A driver never answers a prompt: refuse up front, before anything is copied.
      if (json) {
        const refuse = (message: string) => printEnvelope({ error: { code: 'prompt_refused', message } });
        if (opts.all) {
          return printEnvelope({
            error: { code: 'unsupported_option', message: '--json migrates one session: pass its id instead of --all.' },
          });
        }
        if (!opts.source || !opts.target) return refuse('--json never prompts: pass -s <platform> and -t <platform>.');
        if (!sessionId) return refuse('--json never prompts: pass the session id to migrate.');
        if (opts.push && !opts.scrub && !opts.yes) {
          return refuse('--json never prompts: pass -y to archive the transcript as-is, or --scrub to redact it first.');
        }
      }
      let source = opts.source;
      let target = opts.target;

      // Interactive: when source/target is missing, guide the user to pick
      if (!source) {
        source = await promptSelect('Select source platform:', listAvailablePlatforms());
      }
      if (!target) {
        const others = listAvailablePlatforms().filter((p) => p !== source);
        target = await promptSelect('Select target platform:', others);
      }

      // A target no copy can be written to fails once here, not once per session after its preview.
      const refusedTarget = noAdapter(target, 'write');
      if (refusedTarget) {
        if (json) return printEnvelope({ error: { code: refusedTarget.code, message: refusedTarget.message } });
        console.error(`Error: ${refusedTarget.message}`);
        process.exitCode = 1;
        return;
      }

      let workCwd = opts.cwd ?? process.cwd();
      let metas = await listSource({ platform: source, cwd: workCwd, asEnvelope: json });
      if (!metas) return;
      let crossDirExpanded = false;
      // --all means "every session from this source": with no --cwd, enumerate
      // across all workspaces, rather than only the current directory (that
      // would silently turn --all into "everything in the current directory").
      if (opts.all && !opts.cwd && !sessionId) {
        const allMetas = await listSource({ platform: source });
        if (!allMetas) return;
        if (allMetas.length > 0) {
          metas = allMetas;
          crossDirExpanded = true;
        }
      }


      // When the current cwd has no sessions, interactively offer to list sessions from every directory.
      // After expansion those sessions **do not belong to workCwd**; source lookup must pass
      // undefined so the adapter searches globally by id (every adapter's findSessionFile has that fallback).
      // Previously workCwd was still passed to the source adapter, and claude-code
      // only looked in the single encodeCwdClaude(workCwd) directory, so this path failed 100% of the time.
      if (metas.length === 0 && !opts.cwd && !sessionId) {
        const allMetas = await listSource({ platform: source });
        if (!allMetas) return;
        if (allMetas.length > 0) {
          console.log(`\nNo sessions found in current directory: ${workCwd}`);
          console.log(`But ${allMetas.length} session(s) found across all directories on ${source}.`);
          console.log(`Tip: pass --cwd <project-dir> to migrate from a specific workspace (non-interactive runs need it).`);
          const ans = await ask('List all? (y/N): ');
          if (ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes') {
            metas = allMetas;
            crossDirExpanded = true;
          }
        }
      }
      /** Workspace used for source lookup: when expanded across directories, sessions do not belong to workCwd, so the adapter searches globally. */
      const sourceProjectPath = crossDirExpanded ? undefined : workCwd;
      const printNotFound = () =>
        printEnvelope({ error: { code: 'not_found', message: `No ${source} session ${sessionId} in ${workCwd}.` } });

      if (metas.length === 0) {
        if (json) return printNotFound();
        console.log('No sessions found on source platform.');
        return;
      }

      // Select sessions
      let targets: typeof metas;
      if (opts.all) {
        // --all means what it says: migrate every session, no longer silently truncated to 5.
        // Previously slice(0, 5) with no notice, so users thought everything had been migrated.
        // Use --limit when a cap is needed (same semantics as session push).
        const limitRaw = parseInt(opts.limit, 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 0;
        const sorted = metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        targets = limit > 0 ? sorted.slice(0, limit) : sorted;

        // Large-batch confirmation: --all now migrates everything (no longer truncated to 5).
        // When there are many sessions, list them and require confirmation; -y skips it.
        // Avoid accidentally migrating dozens or hundreds at once, which is expensive to roll back.
        if (targets.length > BATCH_CONFIRM_THRESHOLD && !opts.yes) {
          console.log(`\nAbout to migrate ${targets.length} session(s) from ${source}:`);
          for (const m of targets) {
            const title = safeText(m.title);
            console.log(`  ${m.sessionId.slice(0, 8)}  ${title.length > 50 ? title.slice(0, 50) + '...' : title}${listedCounts(m)}`);
          }
          // Nobody can answer in a non-interactive run. Cancelling with exit 0
          // there would tell a script that every session was migrated; refuse
          // instead and let the caller opt in explicitly.
          if (!isInteractive()) {
            console.error(`\nRefusing to migrate ${targets.length} session(s) without confirmation.`);
            console.error('Pass -y to confirm, or --limit <n> to migrate fewer.');
            process.exit(1);
          }
          const ans = await ask('\nMigrate all of the above? (y/N): ');
          if (ans.toLowerCase() !== 'y' && ans.toLowerCase() !== 'yes') {
            console.log('Cancelled.');
            return;
          }
        }
      } else if (sessionId) {
        const matches = metas.filter(
          (m) => m.sessionId === sessionId || m.sessionId.startsWith(sessionId),
        );
        if (matches.length === 0) {
          if (json) return printNotFound();
          console.error(`Session not found: ${sessionId}`);
          process.exit(1);
        }
        // Ambiguous prefix: taking every match silently migrates sessions the
        // user never named (and rollback then has to undo all of them).
        if (matches.length > 1) {
          if (json) {
            const ids = matches.slice(0, 10).map((m) => m.sessionId).join(', ');
            return printEnvelope({
              error: {
                code: 'ambiguous_id',
                message: `Session id "${sessionId}" matches ${matches.length} sessions (${ids}). Pass the full id.`,
              },
            });
          }
          console.error(`Ambiguous session id "${sessionId}": matches ${matches.length} sessions.`);
          for (const m of matches.slice(0, 10)) {
            console.error(`  ${m.sessionId}  ${safeText(m.title).slice(0, 60)}`);
          }
          console.error('Pass more characters of the id, or use --all / no argument to pick from a list.');
          process.exit(1);
        }
        targets = matches;
      } else {
        // Interactive paging: 10 per screen, n/p to change page. Numbers are global indexes (still selectable after paging).
        // Showing only the first 10 with no way to page makes users think there are only 10 sessions once the list grows.
        const sorted = metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const pageSize = SESSION_PICKER_PAGE_SIZE;
        const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
        let page = 0;

        for (;;) {
          const start = page * pageSize;
          const slice = sorted.slice(start, start + pageSize);
          console.log(
            `\nSessions on ${source} — ${pages > 1 ? `page ${page + 1}/${pages}, ` : ''}${sorted.length} total:`,
          );
          for (let i = 0; i < slice.length; i++) {
            const m = slice[i];
            const title = safeText(m.title);
            const titleShown = title.length > 50 ? title.slice(0, 50) + '...' : title;
            console.log(
              `  [${start + i + 1}] ${m.sessionId.slice(0, 8)}  ${titleShown}${listedCounts(m, { includeSize: true })}`,
            );
          }

          const ans = (
            await ask(
              pages > 1
                ? '\nSelect a number, n = next page, p = previous page, Enter = cancel: '
                : '\nSelect session (number) or Enter to cancel: ',
            )
          )
            .trim()
            .toLowerCase();
          // Enter (and EOF, which reads as an empty answer) still cancels:
          // a non-interactive run must never sit in a paging loop.
          if (!ans || ans === 'q' || ans === 'quit' || ans === 'exit') {
            console.log('Cancelled.');
            return;
          }
          if (pages > 1 && (ans === 'n' || ans === 'next' || ans === 'd')) {
            page = (page + 1) % pages;
            continue;
          }
          if (pages > 1 && (ans === 'p' || ans === 'prev' || ans === 'previous' || ans === 'u')) {
            page = (page - 1 + pages) % pages;
            continue;
          }
          const num = parseInt(ans, 10);
          if (!Number.isNaN(num) && num >= 1 && num <= sorted.length) {
            targets = [sorted[num - 1]];
            break;
          }
          console.log(
            `Enter a number between 1 and ${sorted.length}${pages > 1 ? ', or n/p to change page' : ''}.`,
          );
        }
      }

      const toolRootsFor = toolRootsLookup();
      let migrated = 0;
      let reused = 0;
      let failed = 0;
      // Record the target session ID and real fidelity of each successful migration, and of each
      // copy that already existed (a retried --push archives it).
      // --push then reads those IDs back exactly (not "the N most recent on the target platform",
      // which would push the wrong sessions; see P4/P7).
      const migratedTargets: { sessionId: string; fidelityScore: number; cwd?: string }[] = [];
      /** --json: the one copy this run made or found. */
      let copied: MigrateJsonData | undefined;

      for (const m of targets) {
        // The preview shows what is stored; a --scrub run redacts in the copy itself.
        const found = await AgentSession.find(
          { platform: source, sessionId: m.sessionId, cwd: sourceProjectPath, filePath: m.filePath },
          { scrub: false, toolRootsFor },
        );
        if (found.status === 'failed') {
          if (json) return printEnvelope({ error: { code: found.failure.code, message: found.failure.message } });
          console.error(`\n  ✗ Migration failed: ${found.failure.message}`);
          failed++;
          continue;
        }
        const preview = previewMigration(found.session, source, target);

        console.log(`\n  Migration Preview`);
        console.log(`  ─────────────────────────────────`);
        console.log(`  Source:    ${preview.sourcePlatform}`);
        console.log(`  Target:    ${preview.targetPlatform}`);
        console.log(`  Session:   ${safeText(preview.sessionTitle)} (${preview.sessionId.slice(0, 8)}...)`);
        console.log(`  CWD:       ${preview.cwd}`);
        // Target workspace defaults to the source session's workspace; only --target-cwd moves it
        console.log(`  Target CWD:${opts.targetCwd ? ' ' + opts.targetCwd : ' (same as source)'}`);
        console.log(`  Messages:  ${preview.messageCount}`);
        console.log(`  ─────────────────────────────────`);
        console.log(`  Fidelity:  ${(preview.fidelity.score * 100).toFixed(1)}% (Mode ${preview.fidelity.mode})`);
        console.log(`  Preserved: ${preview.fidelity.preservedBlocks}/${preview.fidelity.totalBlocks} blocks`);
        if (preview.fidelity.degradedBlocks > 0) {
          console.log(`  Degraded:  ${preview.fidelity.degradedBlocks} blocks`);
        }
        for (const d of preview.fidelity.degradations) {
          console.log(`    ⚠ ${d}`);
        }
        for (const w of preview.fidelity.warnings) {
          console.log(`    ⚠ ${w}`);
        }

        // --dry-run: stop once the preview is printed.
        // Migration has no confirmation step (it runs immediately after printing the preview).
        // Without honoring the global --dry-run, the only way to see fidelity and warnings
        // is to migrate for real and roll back if unhappy.
        if (isDryRun()) {
          if (json) return printEnvelope({ data: { dryRun: true, fidelity: preview.fidelity } });
          console.log(`\n  · --dry-run: preview only, not migrated: ${m.sessionId.slice(0, 8)}...\n`);
          continue;
        }

        // Target workspace default = source session workspace (keep the directory the same);
        // only an explicit --target-cwd moves the session to another workspace. An encoded or
        // placeholder source cwd (e.g. `-Users-foo-project`) falls back to --cwd, and copy
        // refuses anything that is still not an existing absolute directory.
        const targetCwd = resolveTargetCwd(opts.targetCwd, preview.cwd, sourceProjectPath) ?? preview.cwd;
        const result = await AgentSession.copy({
          from: { platform: source, sessionId: m.sessionId, cwd: sourceProjectPath, filePath: m.filePath },
          to: { platform: target, cwd: targetCwd },
          scrub: Boolean(opts.scrub),
          toolRootsFor,
        });
        if (result.status === 'failed') {
          if (json) {
            printEnvelope({ error: { code: result.failure.code, message: result.failure.message } });
            return;
          }
          console.error(`\n  ✗ Migration failed: ${result.failure.message}`);
          failed++;
          continue;
        }
        if (result.reused) {
          // Never overwritten: the member may have kept talking in the copy.
          console.log(`\n  ✓ Session already migrated as ${result.sessionId}, nothing written.`);
          console.log(`  Target CWD: ${result.cwd}`);
          console.log(
            `  To refresh it, delete that copy and migrate again: teamai session rollback ${result.sessionId} --platform ${target} --cwd "${result.cwd}"`,
          );
          reused++;
        } else {
          console.log(`\n  ✓ Migration successful`);
          console.log(`  Target session ID: ${result.sessionId}`);
          console.log(`  Target CWD: ${result.cwd}`);
          if (opts.scrub) {
            console.log(
              `  Redacted: ${result.redactedCount ?? 0} secret-looking value(s) (best-effort; review before archiving)`,
            );
          }
          if (result.filePath) {
            console.log(`  Target file: ${result.filePath}`);
          }
          if (result.notice) {
            console.error(`  ⚠ ${result.notice}`);
          }
          console.log(`  Fidelity: ${(result.fidelity.score * 100).toFixed(1)}%`);
          migrated++;
        }
        migratedTargets.push({ sessionId: result.sessionId, fidelityScore: result.fidelity.score, cwd: result.cwd });
        const { status: _status, ...copy } = result;
        copied = copy;
      }
      // Scripted semantics: any single failure exits non-zero (--all batch does not stop the remaining sessions).
      if (failed > 0) {
        process.exitCode = 1;
      }

      // --push: push to the team repo
      if (opts.push && migratedTargets.length > 0) {
        const consent = await confirmUnredactedArchive(migratedTargets.length, `${source} → ${target}`, {
          scrub: Boolean(opts.scrub),
          yes: Boolean(opts.yes),
        });
        if (consent !== 'ok') {
          console.error(`\n  ${migratedTargets.length} session(s) migrated locally, not archived.`);
          if (consent === 'refused') {
            console.error('Pass --scrub to redact the archive, or -y to archive as-is.');
            process.exitCode = 1;
          } else {
            console.log('Archive cancelled. Re-run with --scrub to archive a redacted copy.');
          }
          return;
        }
        const repoRoot = await resolveRepoRoot(opts.repoRoot, { materialize: !isDryRun() });
        // When expanded across directories, sessions do not belong to workCwd; author should come from the repo the session actually lives in
        const authorCwd = migratedTargets.find((t) => t.cwd)?.cwd ?? workCwd;
        const author = getGitAuthor(authorCwd);

        const syncMgr = new SyncManager(repoRoot);
        /** --json: the copy stays on this machine whatever happens to its archive, so say where it is. */
        const archiveFailed = (code: string, reason: string) =>
          printEnvelope({ error: { code, message: `Copied as ${copied?.sessionId} in ${copied?.cwd}, but not archived: ${reason}` } });
        let saved = 0;
        let unarchived = 0;
        for (const t of migratedTargets) {
          // Migration keeps image paths so the target can still open the file.
          // The copy that lands in the team repo must not: re-read the target
          // and scrub again with the archive default, which drops filePath.
          const readBack = await AgentSession.find(
            { platform: target, sessionId: t.sessionId, cwd: t.cwd ?? opts.targetCwd ?? workCwd },
            { scrub: Boolean(opts.scrub), toolRootsFor },
          );
          if (readBack.status === 'failed') {
            if (json) return archiveFailed(readBack.failure.code, readBack.failure.message);
            console.error(`\n  ✗ Not archived: ${readBack.failure.message}`);
            unarchived++;
            continue;
          }
          const session = readBack.session;
          // P3: the archive key is derived from the session's native cwd, not the directory migrate is running in (see deriveArchiveIdentity)
          const meta = defaultSyncMeta(
            {
              platform: target,
              author: authorForCwd(session.cwd ?? t.cwd, author),
              cwd: session.cwd || opts.targetCwd || workCwd,
              sessionId: t.sessionId,
              repoIdentity: deriveArchiveIdentity(session, target),
              title: session.title,
            },
            session.createdAt,
          );
          meta.migration.migratedAt = new Date().toISOString();
          meta.migration.sourcePlatform = source;
          meta.migration.targetPlatform = target;
          meta.migration.fidelityScore = t.fidelityScore;
          try {
            const write = await withSessionIndexLock(repoRoot, async () => syncMgr.saveSession(session, meta));
            if (write.status === 'busy') {
              if (json) return archiveFailed('busy', `${archiveBusyMessage(repoRoot, write.lockPath)} Run it again once that has finished.`);
              reportArchiveBusy(repoRoot, write.lockPath);
              return;
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (json) return archiveFailed('archive_failed', reason);
            console.error(`Error: ${reason}`);
            process.exitCode = 1;
            return;
          }
          saved++;
        }
        if (unarchived > 0) {
          console.error(`\n  ✗ ${unarchived} migrated session(s) could not be read back and were not archived.`);
          process.exitCode = 1;
        }
        // [fixed] a gitCommit failure (not a git directory / index.lock race) used to crash with a raw stack trace
        // Under --json a throw reaches the action's catch, which prints the envelope; runGitStep would exit without one.
        const commitArchive = () => syncMgr.gitCommit(`sync: migrate ${saved} session(s) ${source}→${target}`);
        const commit = json ? commitArchive() : runGitStep(commitArchive, repoRoot, 'git commit');
        if (commit.status === 'committed') {
          const pushed = await pushToRemote(syncMgr, repoRoot);
          if (pushed) {
            console.log(`\n  ✓ Pushed ${saved} session(s) to team repo`);
          } else {
            console.log(`\n  · ${saved} session(s) committed locally but not pushed`);
            process.exitCode = 1;
            if (json) {
              return archiveFailed(
                'archive_failed',
                `committed in ${repoRoot} as ${commit.commit.slice(0, 8)}, but the push to the remote failed (reason on stderr).`,
              );
            }
          }
          console.log(`  commit: ${commit.commit.slice(0, 8)}`);
        } else if (commit.status === 'failed') {
          // Hooks / gpg / missing identity: the archive files are still
          // staged. Say so, and fail -- "No changes to push" here would hide
          // a broken archive.
          console.error(`\n  ✗ Commit failed, ${saved} session(s) left staged in ${repoRoot}: ${safeText(commit.reason)}`);
          process.exitCode = 1;
          if (json) return archiveFailed('archive_failed', `the commit failed, files left staged in ${repoRoot}: ${safeText(commit.reason)}`);
        } else {
          console.log(`\n  · No changes to push\n`);
        }
      }

      if (json && copied) {
        printEnvelope({ data: copied });
        return;
      }
      const failedNote = failed > 0 ? `, ${failed} failed` : '';
      console.log(
        isDryRun()
          ? `\n  ${targets.length - failed} session(s) would be migrated${failedNote} (--dry-run, no changes made).\n`
          : `\n  ${migrated} session(s) migrated${reused > 0 ? `, ${reused} already migrated` : ''}${failedNote}.\n`,
      );
      } catch (err) {
        // Interactive cancel (promptSelect throws 'Selection cancelled'; on EOF, ask returns an empty string
        // and hits that path) is not a failure. Exit quietly, and do not turn it into an unhandled-rejection stack.
        const msg = err instanceof Error ? err.message : String(err);
        // --json never prompts, so nothing here is a cancel. Listing, reading and copying report their
        // failures as values, so a throw that reaches here has no known cause.
        if (json) return printEnvelope({ error: { code: 'unexpected_error', message: msg } });
        if (/cancel/i.test(msg)) {
          console.log('Cancelled.');
          return;
        }
        console.error(`Error: ${msg}`);
        process.exit(1);
      } finally {
        restoreStdout?.();
        closeStdin();
      }
    });

  // ── session push ───────────────────────────────────────────
  sessionCmd
    .command('push')
    .description('Push local sessions to the team repo')
    .option('--source <platform>', 'Source platform to read sessions from')
    .option('--repo-root <path>', 'Team repo root (defaults to cwd)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--limit <n>', 'Max sessions to push (default: 5; ignored with --all)', '5')
    .option('--all', 'Push every session of the platform across all workspace directories (ignores --limit)')
    .option('-y, --yes', 'Skip confirmation prompts, including archiving unredacted transcripts (--all)')
    .option('--scrub', 'Redact secrets before archiving (archived sessions are team-readable)')
    .action(async (opts) => {
      try {
      const source = opts.source;
      if (!source) {
        console.error('Error: --source <platform> required.');
        console.error('Usage: teamai session push --source <platform> [--repo-root <path>] [--all]');
        process.exit(1);
      }
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = await resolveRepoRoot(opts.repoRoot, { materialize: !isDryRun() });
      const author = getGitAuthor(workCwd);
      // --all: no workspace lists every workspace directory of that platform (P5).
      // The blast radius stays on a single platform (same as status --all); single-cwd mode keeps the old behavior.
      const metas = await listSource({ platform: source, cwd: opts.all ? undefined : workCwd });
      if (!metas) return;
      const limitRaw = parseInt(opts.limit, 10);
      // Non-numeric / 0 / negative all fall back to the default. slice(0, -1)'s negative semantics would quietly drop one result
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 5;
      const sorted = metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const selected = opts.all ? sorted : sorted.slice(0, limit);

      if (selected.length === 0) {
        console.log('No sessions found to push.');
        return;
      }

      // dry-run: list the sessions that would be archived, then stop; do not write, commit, or push
      if (isDryRun()) {
        console.log(`\nDry-run: would archive ${selected.length} session(s) from ${source}:`);
        for (const m of selected) {
          console.log(`  ${m.sessionId.slice(0, 8)}  ${safeText(m.title).slice(0, 50)}${listedCounts(m)}`);
        }
        console.log(`  Repo root: ${repoRoot}`);
        return;
      }

      // Large-batch confirmation: when --all would push more than 5, list them (id/title/count) and require confirmation; -y skips it
      if (opts.all && selected.length > 5 && !opts.yes) {
        if (!isInteractive()) {
          console.error(`\nRefusing to push ${selected.length} session(s) without confirmation.`);
          console.error('Pass -y to confirm, or omit --all to push the recent few.');
          process.exitCode = 1;
          return;
        }
        console.log(`\nAbout to push ${selected.length} session(s) from ${source}:`);
        for (const m of selected) {
          const title = safeText(m.title);
          console.log(`  ${m.sessionId.slice(0, 8)}  ${title.length > 50 ? title.slice(0, 50) + '...' : title}${listedCounts(m)}`);
        }
        const ans = await ask('\nPush all of the above? (y/N): ');
        if (ans.toLowerCase() !== 'y' && ans.toLowerCase() !== 'yes') {
          console.log('Cancelled.');
          return;
        }
      }

      const consent = await confirmUnredactedArchive(selected.length, source, {
        scrub: Boolean(opts.scrub),
        yes: Boolean(opts.yes),
      });
      if (consent === 'refused') {
        console.error(`\nRefusing to archive ${selected.length} unredacted session(s) without confirmation.`);
        console.error('Pass --scrub to redact first, or -y to archive as-is.');
        process.exitCode = 1;
        return;
      }
      if (consent === 'declined') {
        console.log('Cancelled. Re-run with --scrub to archive a redacted copy.');
        return;
      }

      const syncMgr = new SyncManager(repoRoot);
      const toolRootsFor = toolRootsLookup();
      let saved = 0;
      let unreadable = 0;
      let redactedTotal = 0;
      for (const m of selected) {
        // Read the file that was listed: with --all, one id can live in several workspaces.
        // What gets archived is the full original text, and the team can read it: redact first when --scrub is set; when not redacted, say so once explicitly.
        const found = await AgentSession.find(
          { platform: source, sessionId: m.sessionId, cwd: opts.all ? undefined : workCwd, filePath: m.filePath },
          { scrub: Boolean(opts.scrub), toolRootsFor },
        );
        if (found.status === 'failed') {
          // This session alone is skipped; the rest of the batch is still archived.
          console.error(`  ✗ Not archived: ${found.failure.message}`);
          unreadable++;
          continue;
        }
        const session = found.session;
        redactedTotal += found.redactedCount ?? 0;
        if (opts.all) {
          console.log(`  Source: ${safeText(session.cwd || 'unknown directory')}`);
        }
        // P3: the archive key is derived from the session's native cwd (see deriveArchiveIdentity), not the directory the CLI is running in
        const meta = defaultSyncMeta(
          {
            platform: source,
            // Each session is signed with the git identity of its own workspace (especially important for --all across workspaces)
            author: authorForCwd(session.cwd, author),
            cwd: session.cwd || workCwd,
            sessionId: m.sessionId,
            repoIdentity: deriveArchiveIdentity(session, source),
            title: session.title,
          },
          session.createdAt,
        );
        // A corrupted index is repaired from disk, or the save throws: failing
        // mid-batch must not fall through to a commit that publishes a
        // half-archive.
        try {
          const write = await withSessionIndexLock(repoRoot, async () => syncMgr.saveSession(session, meta));
          if (write.status === 'busy') {
            reportArchiveBusy(repoRoot, write.lockPath);
            return;
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
          return;
        }
        saved++;
      }
      if (unreadable > 0) {
        console.error(`  ✗ ${unreadable} session(s) could not be read and were not archived.`);
        process.exitCode = 1;
      }
      if (opts.scrub) {
        console.log(`  Redacted: ${redactedTotal} secret-looking value(s) (best-effort; review before sharing)`);
      } else if (saved > 0) {
        console.log(
          '  ⚠ Archived as-is: full transcripts (possibly secrets/paths) are team-readable. Use --scrub to redact.',
        );
      }
      // [fixed] a gitCommit failure (not a git directory / index.lock race) used to crash with a raw stack trace
      const commit = runGitStep(
        () => syncMgr.gitCommit(`sync: push ${saved} session(s) from ${source}${opts.all ? ' (all workspaces)' : ''}`),
        repoRoot,
        'git commit',
      );
      if (commit.status === 'committed') {
        const pushed = await pushToRemote(syncMgr, repoRoot);
        if (pushed) {
          console.log(`\n  ✓ Pushed ${saved} session(s) from ${source}`);
        } else {
          console.log(`\n  · ${saved} session(s) committed locally but not pushed`);
          process.exitCode = 1;
        }
        console.log(`  commit: ${commit.commit.slice(0, 8)}\n`);
      } else if (commit.status === 'failed') {
        console.error(
          `\n  ✗ Commit failed, ${saved} session(s) left staged in ${repoRoot}: ${safeText(commit.reason)}`,
        );
        process.exitCode = 1;
      } else {
        console.log(`\n  · No changes to push\n`);
      }
      } finally {
        closeStdin();
      }
    });

  // ── session pull ───────────────────────────────────────────
  sessionCmd
    .command('pull')
    .description('Pull team sessions for the current project')
    .option('--repo-root <path>', 'Team repo root (defaults to cwd)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--all', 'Rebuild indexes for every repo in the team repo (not just the current project)')
    .action(async (opts) => {
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = await resolveRepoRoot(opts.repoRoot, { materialize: !isDryRun() });

      const syncMgr = new SyncManager(repoRoot);
      if (isDryRun()) {
        console.log(`Dry-run: would pull from the team repo remote and rebuild indexes (repo root: ${repoRoot}).`);
        return;
      }
      // [fixed] a gitPull failure (no remote / repoRoot does not exist) used to crash with a raw stack trace
      const finishIndexMerge = async (indexes: string[]): Promise<void> => {
        // The rebuild takes the lock and the network pull does not: a lock held across it would make other saves wait and fail busy.
        const merged = await withSessionIndexLock(repoRoot, async () =>
          runGitStep(() => syncMgr.commitRebuiltIndexes(indexes), repoRoot, 'git pull'),
        );
        if (merged.status === 'busy') {
          console.error(`Error: ${mergeBusyMessage(repoRoot, merged.lockPath)}`);
          process.exit(1);
        }
        console.log(`  ✓ Merged remote sessions and rebuilt ${indexes.length} conflicted session index(es)`);
      };
      let pulled = runGitStep(() => syncMgr.gitPull(), repoRoot, 'git pull');
      // A merge an earlier pull left on the session indexes is finished first; it does not replace this pull.
      if (pulled.status === 'indexes-conflicted' && pulled.pending) {
        await finishIndexMerge(pulled.indexes);
        pulled = runGitStep(() => syncMgr.gitPull(), repoRoot, 'git pull');
      }
      if (pulled.status === 'stopped') {
        console.error(`Error: ${pulled.reason}`);
        process.exit(1);
      }
      if (pulled.status === 'indexes-conflicted') await finishIndexMerge(pulled.indexes);
      if (opts.all) {
        // P2: rebuild by directory (including repos whose index is missing or corrupt — those are exactly the ones that most need repair),
        // rather than only rebuilding the ones whose identity can be recovered from _index.json.
        const rebuilt = await withSessionIndexLock(repoRoot, async () => syncMgr.rebuildAllIndexes());
        if (rebuilt.status === 'busy') return reportArchiveBusy(repoRoot, rebuilt.lockPath);
        const { repos, sessions } = rebuilt.value;
        console.log(`\n  ✓ Pulled and indexed ${sessions} session(s) across ${repos} repo(s)\n`);
      } else {
        const repoIdentity = resolveRepoIdentity(workCwd);
        const rebuilt = await withSessionIndexLock(repoRoot, async () => syncMgr.rebuildIndex(repoIdentity));
        if (rebuilt.status === 'busy') return reportArchiveBusy(repoRoot, rebuilt.lockPath);
        console.log(`\n  ✓ Pulled and indexed ${rebuilt.value} session(s)\n`);
      }
    });

  // ── session list ───────────────────────────────────────────
  sessionCmd
    .command('list')
    .description('List team sessions for the current project')
    .option('--repo-root <path>', 'Team repo root (defaults to cwd)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--author <name>', 'Filter by author')
    .option('--all', 'List sessions across all projects in the team repo (not just the current one)')
    .action(async (opts) => {
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = await resolveRepoRoot(opts.repoRoot, { materialize: !isDryRun() });
      const repoIdentity = resolveRepoIdentity(workCwd);

      const syncMgr = new SyncManager(repoRoot);
      // P2: --all uses the cross-repo view (including _unattributed); each entry's repoIdentity marks the source
      const sessions = opts.all
        ? syncMgr.listSessionsAcrossRepos(opts.author)
        : syncMgr.listSessions(repoIdentity, opts.author);

      if (sessions.length === 0) {
        console.log('No team sessions found.');
        return;
      }

      if (opts.all) {
        console.log(`\nSessions across all projects:\n`);
        console.log(`  SESSION                              AUTHOR       PLATFORM        MSGS  UPDATED    SOURCE`);
        console.log(`  ─────────────────────────────────────────────────────────────────────────────────────`);
        for (const s of sessions) {
          const name = safeText(s.sessionName);
          const nameCol = name.length > 36 ? name.slice(0, 34) + '..' : name.padEnd(36);
          const authorCol = safeText(s.author).slice(0, 12).padEnd(12);
          const platCol = safeText(s.platform).slice(0, 16).padEnd(16);
          const msgCol = String(s.messageCount).padStart(4);
          const dateCol = s.updatedAt.slice(0, 10);
          const source = safeText(s.repoIdentity ?? '_unattributed');
          console.log(`  ${nameCol}  ${authorCol}${platCol}${msgCol}  ${dateCol}  ${source}`);
        }
      } else {
        const repoLabel = repoIdentity ?? '_unattributed';
        console.log(`\nSessions for ${repoLabel}:\n`);
        console.log(`  SESSION                              AUTHOR       PLATFORM        MSGS  UPDATED`);
        console.log(`  ──────────────────────────────────────────────────────────────────────────`);
        for (const s of sessions) {
          const name = safeText(s.sessionName);
          const nameCol = name.length > 36 ? name.slice(0, 34) + '..' : name.padEnd(36);
          const authorCol = safeText(s.author).slice(0, 12).padEnd(12);
          const platCol = safeText(s.platform).slice(0, 16).padEnd(16);
          const msgCol = String(s.messageCount).padStart(4);
          const dateCol = s.updatedAt.slice(0, 10);
          console.log(`  ${nameCol}  ${authorCol}${platCol}${msgCol}  ${dateCol}`);
        }
      }
      console.log(`\n  ${sessions.length} session(s)\n`);
    });

  // ── session resume ─────────────────────────────────────────
  sessionCmd
    .command('resume')
    .description('Restore a team session to a local platform')
    .argument('<sessionName>', 'Session name (from `teamai session list`)')
    // The option is named --platform rather than --in: aligned with rollback's --platform,
    // and with the noun-style naming of the rest of this project's commands (--source / --target / --agent / --role).
    .requiredOption('--platform <platform>', 'Target platform to restore into')
    .option('--repo-root <path>', 'Team repo root (defaults to cwd)')
    .option('--cwd <path>', 'Working directory for the restored session (defaults to current directory)')
    .option('--author <name>', 'Author of the session (if ambiguous)')
    .action(async (sessionName, opts) => {
      const refused = noAdapter(opts.platform, 'write');
      if (refused) {
        console.error(`Error: ${refused.message}`);
        process.exitCode = 1;
        return;
      }
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = await resolveRepoRoot(opts.repoRoot, { materialize: !isDryRun() });
      const repoIdentity = resolveRepoIdentity(workCwd);

      const syncMgr = new SyncManager(repoRoot);
      // Without try/catch, a loadSession error on resume hits the terminal as an uncaught exception.
      // The usual root cause is that the session was archived under another project name (repoIdentity mismatch).
      // Give an actionable hint instead of a raw stack trace (see design doc P9).
      let session;
      try {
        ({ session } = syncMgr.loadSession(repoIdentity, sessionName, opts.author));
      } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        console.error('The session may be archived under another project identity.');
        console.error('Try `teamai session search --all <keyword>` to find it,');
        console.error('or rerun with `--cwd <project path>` of the project it belongs to.');
        process.exit(1);
      }

      const resumeCwd = opts.cwd ?? process.cwd();
      const resumeAdapter = await safeGetAdapter(opts.platform, resumeCwd);
      session.cwd = resumeCwd;

      if (isDryRun()) {
        console.log(
          `Dry-run: would restore "${safeText(session.title)}" (${session.messages.length} msgs) into ${opts.platform} at ${resumeCwd}.`,
        );
        return;
      }

      // Never overwrite: a member may have kept talking in an earlier restore of this session.
      const write = await writeCopyOnce(resumeAdapter, { session, sourcePlatform: session.platform, cwd: resumeCwd });
      if (write.status === 'failed') {
        console.error(`Error: ${write.failure.message}`);
        process.exitCode = 1;
        return;
      }
      if (write.reused) {
        console.log(`\n  ✓ Session already restored as ${write.sessionId}, nothing written.`);
        console.log(`  CWD: ${resumeCwd}`);
        console.log(`\n  To continue: ${opts.platform} --resume ${write.sessionId}\n`);
        return;
      }

      const newSessionId = write.sessionId;
      const registrationNotice = resumeAdapter.consumeWriteNotice?.();

      console.log(`\n  ✓ Session restored to ${opts.platform}`);
      if (registrationNotice) console.error(`  ⚠ ${registrationNotice}`);
      console.log(`  Session ID: ${newSessionId}`);
      console.log(`  Messages: ${session.messages.length}`);
      console.log(`  CWD: ${resumeCwd}`);
      console.log(`\n  To continue: ${opts.platform} --resume ${newSessionId}\n`);
    });

  // ── session search ─────────────────────────────────────────
  sessionCmd
    .command('search')
    .description('Search team session content')
    .argument('<query>', 'Search query')
    .option('--repo-root <path>', 'Team repo root (defaults to cwd)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--limit <n>', 'Max results (default: 10)', '10')
    .option('--all', 'Search across all projects (not just current)')
    .action(async (query, opts) => {
      const workCwd = opts.cwd ?? process.cwd();
      const repoRoot = await resolveRepoRoot(opts.repoRoot, { materialize: !isDryRun() });
      const repoIdentity = resolveRepoIdentity(workCwd);
      const limitRaw = parseInt(opts.limit, 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10;

      const syncMgr = new SyncManager(repoRoot);
      const loadedSessions: LoadedSession[] = [];

      // P1: --all walks every repo (including _unattributed) and loads sessions;
      // without --all, only the current repo is loaded. The old implementation's loop body was dead code: listRepos()
      // returns encoded directory names and has no decoder, so the canonical identity can only be
      // recovered from each repo's _index.json (see SyncManager.listAllRepoIdentities).
      const identitiesToSearch: Array<string | null> = opts.all
        ? syncMgr.listAllRepoIdentities()
        : [repoIdentity];
      for (const identity of identitiesToSearch) {
        for (const entry of syncMgr.listSessions(identity)) {
          try {
            const { session } = syncMgr.loadSession(identity, entry.sessionName, entry.author);
            loadedSessions.push({ sessionName: entry.sessionName, author: entry.author, session });
          } catch {
            // skip corrupted
          }
        }
      }

      const searchEngine = new SessionSearchEngine();
      const results = await searchEngine.search(loadedSessions, query, { limit });

      if (results.length === 0) {
        console.log('No results found.');
        return;
      }

      console.log('');
      for (let i = 0; i < results.length; i++) {
        const hit = results[i];
        const date = hit.createdAt ? hit.createdAt.slice(0, 10) : 'unknown';
        const snippet = safeText(hit.snippet);
        const snippetShown = snippet.length > 150 ? snippet.slice(0, 150) + '...' : snippet;
        console.log(`  [${i + 1}] ${safeText(hit.sessionName)} (${safeText(hit.author)}, ${date})`);
        // Two significant digits: a match only in tool output scores well under 0.1, and one decimal printed 0.0.
        console.log(`      Score: ${Number(hit.score.toPrecision(2))}`);
        console.log(`      ${snippetShown}`);
        console.log('');
      }
      console.log(`  ${results.length} result(s) found`);
    });

  // ── session rollback ───────────────────────────────────────
  sessionCmd
    .command('rollback')
    .description('Rollback a migration (delete the target session)')
    .argument('<sessionId>', 'Target session ID to delete')
    .requiredOption('--platform <platform>', 'Platform where the session was written')
    .option('--cwd <cwd>', 'Only roll back the copy under this project path (default: all)')
    .action(async (sessionId, opts) => {
      if (!isSafeSessionFileId(sessionId)) {
        console.error('\n  ✗ Refusing to roll back a session id that is not a single path segment.\n');
        process.exitCode = 1;
        return;
      }
      // Rollback is destructive (deletes the CLI file and the IDE sidebar entry); look first, then delete.
      if (isDryRun()) {
        console.log(
          `\n  · --dry-run: would delete ${opts.platform}/${sessionId}` +
            `${opts.cwd ? ` (only ${opts.cwd})` : ' (all workspaces)'}\n`,
        );
        return;
      }

      const adapter = await safeGetAdapter(opts.platform, opts.cwd);
      let deleted: boolean;
      try {
        deleted = await adapter.deleteSession(sessionId, opts.cwd);
      } catch (err) {
        // Same contract as the other subcommands: one English line, no stack.
        console.error(`\n  ✗ Rollback failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
        return;
      }
      // The adapter returning false means it confirmed nothing was deleted (session does not exist).
      // Previously a checkmark was printed whether or not it existed, so a silent no-op reported success and scripts could not tell whether it took effect.
      if (deleted === false) {
        console.log(`\n  · Session not found: ${opts.platform}/${sessionId}, no changes (may have already been deleted)\n`);
        return;
      }
      console.log(`\n  ✓ Rolled back: ${opts.platform}/${sessionId}\n`);
    });
}
