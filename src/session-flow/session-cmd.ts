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
import { listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';
import {
  AgentSession,
  noAdapter,
  recordedToolRoots,
  toolRootsLookup,
  writeCopyOnce,
} from './agent-session.js';
import { SyncManager, getGitAuthor, defaultSyncMeta, withSessionIndexLock } from './sync.js';
import { SessionSearchEngine, type LoadedSession } from './search.js';
import { isSafeSessionFileId } from './ids.js';
import { isInteractive } from '../utils/prompt.js';
import { registerMigrationCommand } from './session-migrate-cmd.js';
import {
  ask,
  authorForCwd,
  closeStdin,
  confirmUnredactedArchive,
  deriveArchiveIdentity,
  listedCounts,
  listSource,
  mergeBusyMessage,
  pushToRemote,
  reportArchiveBusy,
  resolveRepoIdentity,
  resolveRepoRoot,
  runGitStep,
  safeGetAdapter,
  safeText,
} from './session-cmd-shared.js';

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

  registerMigrationCommand(sessionCmd, isDryRun);

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
