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
import { resumeCommand } from './adapters/platform-facts.js';
import {
  AgentSession,
  noAdapter,
  recordedToolRoots,
  toolRootsLookup,
  writeCopyOnce,
} from './agent-session.js';
import { SyncManager, getGitAuthor, defaultSyncMeta, withSessionPublicationLock, type IndexEntry } from './sync.js';
import { SessionSearchEngine, type LoadedSession } from './search.js';
import { isSafeSessionFileId } from './ids.js';
import { isInteractive } from '../utils/prompt.js';
import { updateReports } from '../utils/reports-branch.js';
import { knownSecrets } from '../env-resolution.js';
import { pushSession } from './archive.js';
import { registerMigrationCommand } from './session-migrate-cmd.js';
import {
  REPORTS_ARCHIVE_BUSY,
  archiveToReports,
  ask,
  authorForCwd,
  closeStdin,
  confirmUnredactedArchive,
  deriveArchiveIdentity,
  listedCounts,
  listSource,
  pullArchive,
  pushToRemote,
  reportArchiveBusy,
  resolveRepoIdentity,
  resolveRepoRoot,
  runGitStep,
  safeGetAdapter,
  safeText,
} from './session-cmd-shared.js';

/**
 * The sessions of `identities` that the archive at `root` holds, then those the archive kept on the default branch
 * before, at `legacy`, holds: a session both hold, under the same repository, name and author, is kept from `root`.
 */
function archivedSessions(
  { root, legacy }: { root: string; legacy?: string },
  identities: (archive: SyncManager) => Array<string | null>,
  author?: string,
): Array<{ archive: SyncManager; identity: string | null; entry: IndexEntry }> {
  const seen = new Set<string>();
  const found: Array<{ archive: SyncManager; identity: string | null; entry: IndexEntry }> = [];
  for (const archiveRoot of [root, ...(legacy ? [legacy] : [])]) {
    const archive = new SyncManager(archiveRoot);
    for (const identity of identities(archive)) {
      for (const entry of archive.listSessions(identity, author)) {
        const key = JSON.stringify([identity, entry.sessionName, entry.author]);
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ archive, identity, entry });
      }
    }
  }
  return found;
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

  registerMigrationCommand(sessionCmd, isDryRun);

  // ── session push ───────────────────────────────────────────
  sessionCmd
    .command('push')
    .description('Push local sessions to the team repo')
    .option('--source <platform>', 'Source platform to read sessions from')
    .option('--session <id>', 'Push only this session of --source, from any workspace, redacted, without prompting, to teamai-reports of the teamai install for this directory (not with --all or --repo-root)')
    .option('--repo-root <path>', 'Team repo clone that holds the session archive (default: the teamai install for this directory, else your user install)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--limit <n>', 'Max sessions to push (default: 5; ignored with --all or --session)', '5')
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
      if (opts.session) {
        const { reports: config } = await resolveRepoRoot(opts.repoRoot, { dryRun: isDryRun() });
        if (opts.all || !config) {
          console.error('Error: --session pushes one session to teamai-reports of the teamai install for this directory, so it takes neither --all nor --repo-root.');
          process.exitCode = 1;
          return;
        }
        if (isDryRun()) {
          console.log(`Dry-run: would archive ${source} session ${safeText(opts.session)}, redacted, on teamai-reports.`);
          return;
        }
        const pushed = await pushSession(config, { platform: source, sessionId: opts.session });
        switch (pushed.status) {
          case 'archived':
            console.log(`\n  ✓ Pushed ${source} session ${safeText(opts.session)} to teamai-reports (redacted)\n`);
            return;
          case 'busy':
            console.error(`Error: ${REPORTS_ARCHIVE_BUSY}`);
            process.exitCode = 1;
            return;
          case 'failed':
            console.error(`Error: ${safeText(pushed.message)}`);
            process.exitCode = 1;
            return;
          default: {
            const unhandled: never = pushed;
            return unhandled;
          }
        }
      }
      const workCwd = opts.cwd ?? process.cwd();
      const archive = await resolveRepoRoot(opts.repoRoot, { dryRun: isDryRun() });
      const { root: repoRoot, reports, legacy } = archive;
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

      const toolRootsFor = toolRootsLookup();
      // The team's declared secrets are known only for the teamai install's own archive, not for a --repo-root clone.
      const scrub = opts.scrub ? { secrets: reports ? await knownSecrets(reports) : {} } : false;
      const commitMessage = (saved: number) => `sync: push ${saved} session(s) from ${source}${opts.all ? ' (all workspaces)' : ''}`;
      /** Saves the selected sessions into the archive at `root`: how many, or undefined once a failure that stops the push was reported. */
      const archiveInto = async (syncMgr: SyncManager, root: string): Promise<number | undefined> => {
        let saved = 0;
        let unreadable = 0;
        let redactedTotal = 0;
        let onDefaultBranch = 0;
        const defaultBranch = legacy ? new SyncManager(legacy) : undefined;
        for (const m of selected) {
          // Read the file that was listed: with --all, one id can live in several workspaces.
          // What gets archived is the full original text, and the team can read it: redact first when --scrub is set; when not redacted, say so once explicitly.
          const found = await AgentSession.find(
            { platform: source, sessionId: m.sessionId, cwd: opts.all ? undefined : workCwd, filePath: m.filePath },
            { scrub, toolRootsFor },
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
            const write = await syncMgr.saveSession(session, meta);
            if (write.status === 'busy') {
              reportArchiveBusy(root, write.lockPath);
              return undefined;
            }
          } catch (err) {
            console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = 1;
            return undefined;
          }
          saved++;
          if (defaultBranch?.findArchived(meta.origin.repoIdentity, { platform: source, sessionId: m.sessionId })) onDefaultBranch++;
        }
        if (onDefaultBranch > 0) {
          console.log(`  · ${onDefaultBranch} session(s) also archived on the default branch: session list and resume read the copy pushed to teamai-reports first.`);
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
        return saved;
      };
      // Archive changes and their Git publication are serialized per team repo, the teamai-reports archive included.
      const publication = await withSessionPublicationLock(repoRoot, async () => {
        if (reports) {
          const archived = await archiveToReports(reports, archiveInto, commitMessage);
          switch (archived.status) {
            case 'busy':
              console.error(`Error: ${REPORTS_ARCHIVE_BUSY}`);
              process.exitCode = 1;
              return;
            case 'stopped':
              return;
            case 'published':
              console.log(`\n  ✓ Pushed ${archived.saved} session(s) from ${source}\n`);
              return;
            case 'already-present':
              console.log(`\n  · No changes to push\n`);
              return;
            case 'failed':
              console.error(`\n  ✗ ${archived.saved} session(s) not pushed to teamai-reports: ${safeText(archived.reason)}`);
              process.exitCode = 1;
              return;
            default: {
              const unhandled: never = archived;
              return unhandled;
            }
          }
        }
        const syncMgr = new SyncManager(repoRoot);
        const saved = await archiveInto(syncMgr, repoRoot);
        if (saved === undefined) return;
        // [fixed] a gitCommit failure (not a git directory / index.lock race) used to crash with a raw stack trace
        const commit = runGitStep(
          () => syncMgr.gitCommit(commitMessage(saved)),
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
      });
      if (publication.status === 'busy') reportArchiveBusy(repoRoot, publication.lockPath);
      } finally {
        closeStdin();
      }
    });

  // ── session pull ───────────────────────────────────────────
  sessionCmd
    .command('pull')
    .description('Pull team sessions for the current project')
    .option('--repo-root <path>', 'Team repo clone that holds the session archive (default: the teamai install for this directory, else your user install)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--all', 'Rebuild indexes for every repo in the team repo (not just the current project)')
    .action(async (opts) => {
      const workCwd = opts.cwd ?? process.cwd();
      const { root: repoRoot, reports, legacy } = await resolveRepoRoot(opts.repoRoot, { dryRun: isDryRun() });

      if (isDryRun()) {
        console.log(`Dry-run: would pull from the team repo remote and rebuild indexes (repo root: ${repoRoot}).`);
        return;
      }
      /** Pulls the archive at `root` and rebuilds its indexes: false once the pull itself failed and said why; a busy rebuild sets the exit code instead. */
      const pullInto = async (root: string): Promise<boolean> => {
        const syncMgr = new SyncManager(root);
        const pulled = await pullArchive(syncMgr, root);
        if (pulled.status === 'failed') {
          console.error(`Error: ${pulled.reason}`);
          return false;
        }
        if (pulled.rebuilt > 0) console.log(`  ✓ Merged remote sessions and rebuilt ${pulled.rebuilt} conflicted session index(es)`);
        if (opts.all) {
          // P2: rebuild by directory (including repos whose index is missing or corrupt — those are exactly the ones that most need repair),
          // rather than only rebuilding the ones whose identity can be recovered from _index.json.
          const rebuilt = await syncMgr.rebuildAllIndexes();
          if (rebuilt.status === 'busy') {
            reportArchiveBusy(root, rebuilt.lockPath);
            return true;
          }
          const { repos, sessions } = rebuilt.value;
          console.log(`\n  ✓ Pulled and indexed ${sessions} session(s) across ${repos} repo(s)\n`);
        } else {
          const repoIdentity = resolveRepoIdentity(workCwd);
          const rebuilt = await syncMgr.rebuildIndex(repoIdentity);
          if (rebuilt.status === 'busy') {
            reportArchiveBusy(root, rebuilt.lockPath);
            return true;
          }
          console.log(`\n  ✓ Pulled and indexed ${rebuilt.value} session(s)\n`);
        }
        return true;
      };
      // Archive changes and their Git publication are serialized per team repo, the teamai-reports archive included.
      const publication = await withSessionPublicationLock(repoRoot, async (): Promise<boolean> => {
        if (!reports) return pullInto(repoRoot);
        // Pulling merges into the teamai-reports checkout, so it runs under the lock every writer there takes.
        let pulled = true;
        const result = await updateReports(reports, async (worktree) => {
          pulled = await pullInto(worktree);
          return null;
        });
        if (result.status === 'busy') {
          console.error('Error: Another teamai command is writing teamai-reports, so nothing was pulled. Run this command again once it has finished.');
          process.exitCode = 1;
          return true;
        }
        if (result.status === 'failed') {
          console.error(`Error: ${safeText(result.reason)}`);
          process.exitCode = 1;
          return true;
        }
        if (!legacy) return pulled;
        const pulledLegacy = await withSessionPublicationLock(legacy, () => pullArchive(new SyncManager(legacy), legacy));
        if (pulledLegacy.status === 'busy') reportArchiveBusy(legacy, pulledLegacy.lockPath);
        else if (pulledLegacy.value.status === 'failed') {
          console.error(`Error: Pulling the sessions archived on the default branch in ${legacy} failed: ${safeText(pulledLegacy.value.reason)}`);
          process.exitCode = 1;
        }
        return pulled;
      });
      if (publication.status === 'busy') reportArchiveBusy(repoRoot, publication.lockPath);
      else if (!publication.value) process.exit(1);
    });

  // ── session list ───────────────────────────────────────────
  sessionCmd
    .command('list')
    .description('List team sessions for the current project')
    .option('--repo-root <path>', 'Team repo clone that holds the session archive (default: the teamai install for this directory, else your user install)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--author <name>', 'Filter by author')
    .option('--all', 'List sessions across all projects in the team repo (not just the current one)')
    .action(async (opts) => {
      const workCwd = opts.cwd ?? process.cwd();
      const archives = await resolveRepoRoot(opts.repoRoot, { dryRun: isDryRun(), read: true });
      const repoIdentity = resolveRepoIdentity(workCwd);

      // P2: --all uses the cross-repo view (including _unattributed); each entry's repoIdentity marks the source
      const sessions = archivedSessions(
        archives,
        (archive) => (opts.all ? archive.listAllRepoIdentities() : [repoIdentity]),
        opts.author,
      ).map(({ identity, entry }) => ({ ...entry, repoIdentity: entry.repoIdentity ?? identity }));

      if (sessions.length === 0) {
        console.log('No team sessions found.');
        return;
      }

      // Whole names and authors: session resume and score --team-session take them as printed.
      const nameWidth = Math.max(36, ...sessions.map((s) => safeText(s.sessionName).length));
      const authorWidth = Math.max(12, ...sessions.map((s) => safeText(s.author).length + 1));
      const head = `  ${'SESSION'.padEnd(nameWidth)}  ${'AUTHOR'.padEnd(authorWidth)}PLATFORM        MSGS  UPDATED`;
      if (opts.all) {
        console.log(`\nSessions across all projects:\n`);
        console.log(`${head}    SOURCE`);
        console.log(`  ${'─'.repeat(head.length + 8)}`);
        for (const s of sessions) {
          const nameCol = safeText(s.sessionName).padEnd(nameWidth);
          const authorCol = safeText(s.author).padEnd(authorWidth);
          const platCol = safeText(s.platform).slice(0, 16).padEnd(16);
          const msgCol = String(s.messageCount).padStart(4);
          const dateCol = s.updatedAt.slice(0, 10);
          const source = safeText(s.repoIdentity ?? '_unattributed');
          console.log(`  ${nameCol}  ${authorCol}${platCol}${msgCol}  ${dateCol}  ${source}`);
        }
      } else {
        const repoLabel = repoIdentity ?? '_unattributed';
        console.log(`\nSessions for ${repoLabel}:\n`);
        console.log(head);
        console.log(`  ${'─'.repeat(head.length - 2)}`);
        for (const s of sessions) {
          const nameCol = safeText(s.sessionName).padEnd(nameWidth);
          const authorCol = safeText(s.author).padEnd(authorWidth);
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
    .option('--repo-root <path>', 'Team repo clone that holds the session archive (default: the teamai install for this directory, else your user install)')
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
      const archives = await resolveRepoRoot(opts.repoRoot, { dryRun: isDryRun(), read: true });
      const repoIdentity = resolveRepoIdentity(workCwd);

      // A session teamai-reports does not hold is read from the archive the team kept on its default branch before.
      const [held] = archivedSessions(archives, () => [repoIdentity], opts.author)
        .filter(({ entry }) => entry.sessionName === sessionName);
      const syncMgr = held?.archive ?? new SyncManager(archives.root);
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
        console.log(`\n  To continue: ${resumeCommand(opts.platform, write.sessionId)}\n`);
        return;
      }

      const newSessionId = write.sessionId;
      const registrationNotice = resumeAdapter.consumeWriteNotice?.();

      console.log(`\n  ✓ Session restored to ${opts.platform}`);
      if (registrationNotice) console.error(`  ⚠ ${registrationNotice}`);
      console.log(`  Session ID: ${newSessionId}`);
      console.log(`  Messages: ${session.messages.length}`);
      console.log(`  CWD: ${resumeCwd}`);
      console.log(`\n  To continue: ${resumeCommand(opts.platform, newSessionId)}\n`);
    });

  // ── session search ─────────────────────────────────────────
  sessionCmd
    .command('search')
    .description('Search team session content')
    .argument('<query>', 'Search query')
    .option('--repo-root <path>', 'Team repo clone that holds the session archive (default: the teamai install for this directory, else your user install)')
    .option('--cwd <path>', 'Working directory (defaults to current directory)')
    .option('--limit <n>', 'Max results (default: 10)', '10')
    .option('--all', 'Search across all projects (not just current)')
    .action(async (query, opts) => {
      const workCwd = opts.cwd ?? process.cwd();
      const archives = await resolveRepoRoot(opts.repoRoot, { dryRun: isDryRun(), read: true });
      const repoIdentity = resolveRepoIdentity(workCwd);
      const limitRaw = parseInt(opts.limit, 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10;

      const loadedSessions: LoadedSession[] = [];

      // P1: --all walks every repo (including _unattributed) and loads sessions;
      // without --all, only the current repo is loaded. The old implementation's loop body was dead code: listRepos()
      // returns encoded directory names and has no decoder, so the canonical identity can only be
      // recovered from each repo's _index.json (see SyncManager.listAllRepoIdentities).
      const found = archivedSessions(
        archives,
        (archive) => (opts.all ? archive.listAllRepoIdentities() : [repoIdentity]),
      );
      for (const { archive, identity, entry } of found) {
        try {
          const { session } = archive.loadSession(identity, entry.sessionName, entry.author);
          loadedSessions.push({ sessionName: entry.sessionName, author: entry.author, session });
        } catch {
          // skip corrupted
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
