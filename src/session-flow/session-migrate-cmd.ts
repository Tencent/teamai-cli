import type { Command } from 'commander';
import { listAvailablePlatforms } from './adapters/index.js';
import { previewMigration, resolveTargetCwd } from './migrate.js';
import {
  AgentSession,
  noAdapter,
  toolRootsLookup,
  type AgentSessionCopy,
} from './agent-session.js';
import {
  SyncManager,
  getGitAuthor,
  defaultSyncMeta,
  withSessionPublicationLock,
} from './sync.js';
import { isInteractive } from '../utils/prompt.js';
import { setStderrOnly } from '../utils/logger.js';
import { knownSecrets } from '../env-resolution.js';
import {
  REPORTS_ARCHIVE_BUSY,
  archiveBusyMessage,
  archiveToReports,
  ask,
  authorForCwd,
  closeStdin,
  confirmUnredactedArchive,
  deriveArchiveIdentity,
  listedCounts,
  printEnvelope,
  pushToRemote,
  resolveRepoRoot,
  runGitStep,
  safeText,
} from './session-cmd-shared.js';

const BATCH_CONFIRM_THRESHOLD = 10;
const SESSION_PICKER_PAGE_SIZE = 10;

/** What `session migrate --json` reports for one copy: the copy result without its status. */
type MigrateJsonData = Omit<Extract<AgentSessionCopy, { status: 'done' }>, 'status'>;

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

interface MigrationOptions {
  json?: boolean; all?: boolean; source?: string; target?: string; cwd?: string; targetCwd?: string;
  push?: boolean; scrub?: boolean; yes?: boolean; repoRoot?: string; limit?: string;
}

type MigrationResult =
  | { error: { code: string; message: string } }
  | { data: { dryRun: true; fidelity: ReturnType<typeof previewMigration>['fidelity'] } }
  | { cancelled: true }
  | { empty: { source: string; sessionId?: string; cwd: string } }
  | { summary: { copied?: MigrateJsonData; dryRun: boolean; total: number; migrated: number; reused: number; failed: number } };

function renderMigrationResult(result: MigrationResult | undefined, json: boolean): void {
  if (!result) return;
  if ('error' in result) {
    if (json) printEnvelope(result);
    else { console.error(`Error: ${result.error.message}`); process.exitCode = 1; }
  } else if ('data' in result) {
    if (json) printEnvelope(result);
  } else if ('cancelled' in result) {
    console.log('Cancelled.');
  } else if ('empty' in result) {
    if (json) printEnvelope({ error: { code: 'not_found', message: `No ${result.empty.source} session ${result.empty.sessionId} in ${result.empty.cwd}.` } });
    else console.log('No sessions found on source platform.');
  } else {
    const { copied, dryRun, total, migrated, reused, failed } = result.summary;
    if (json && copied) { printEnvelope({ data: copied }); return; }
    const failedNote = failed > 0 ? `, ${failed} failed` : '';
    console.log(dryRun
      ? `\n  ${total - failed} session(s) would be migrated${failedNote} (--dry-run, no changes made).\n`
      : `\n  ${migrated} session(s) migrated${reused > 0 ? `, ${reused} already migrated` : ''}${failedNote}.\n`);
  }
}

async function migrateSession(sessionId: string | undefined, opts: MigrationOptions, isDryRun: () => boolean): Promise<MigrationResult | undefined> {
  const json = Boolean(opts.json);
  try {
    // A driver never answers a prompt: refuse up front, before anything is copied.
    if (json) {
      const refuse = (message: string) => ({ error: { code: 'prompt_refused', message } });
      if (opts.all) {
        return ({
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
      return { error: { code: refusedTarget.code, message: refusedTarget.message } };
    }

    let workCwd = opts.cwd ?? process.cwd();
    const listed = await AgentSession.list({ platforms: [source], cwd: workCwd });
    if (listed.failures[0]) return { error: { code: listed.failures[0].code, message: listed.failures[0].message } };
    let metas = listed.sessions;
    let crossDirExpanded = false;
    // --all means "every session from this source": with no --cwd, enumerate
    // across all workspaces, rather than only the current directory (that
    // would silently turn --all into "everything in the current directory").
    if (opts.all && !opts.cwd && !sessionId) {
      const allListed = await AgentSession.list({ platforms: [source] });
      if (allListed.failures[0]) return { error: { code: allListed.failures[0].code, message: allListed.failures[0].message } };
      const allMetas = allListed.sessions;
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
      const allListed = await AgentSession.list({ platforms: [source] });
      if (allListed.failures[0]) return { error: { code: allListed.failures[0].code, message: allListed.failures[0].message } };
      const allMetas = allListed.sessions;
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
      ({ error: { code: 'not_found', message: `No ${source} session ${sessionId} in ${workCwd}.` } });

    if (metas.length === 0) {
      return { empty: { source, sessionId, cwd: workCwd } };
    }

    // Select sessions
    let targets: typeof metas;
    if (opts.all) {
      // --all means what it says: migrate every session, no longer silently truncated to 5.
      // Previously slice(0, 5) with no notice, so users thought everything had been migrated.
      // Use --limit when a cap is needed (same semantics as session push).
      const limitRaw = parseInt(opts.limit ?? '', 10);
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
          return { cancelled: true };
        }
      }
    } else if (sessionId) {
      const matches = metas.filter(
        (m) => m.sessionId === sessionId || m.sessionId.startsWith(sessionId),
      );
      if (matches.length === 0) {
        return printNotFound();
      }
      // Ambiguous prefix: taking every match silently migrates sessions the
      // user never named (and rollback then has to undo all of them).
      if (matches.length > 1) {
        if (json) {
          const ids = matches.slice(0, 10).map((m) => m.sessionId).join(', ');
          return ({
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
          return { cancelled: true };
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
        if (json) return { error: { code: found.failure.code, message: found.failure.message } };
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
        if (json) return { data: { dryRun: true, fidelity: preview.fidelity } };
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
          return { error: { code: result.failure.code, message: result.failure.message } };
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
      /** --json: the copy stays on this machine whatever happens to its archive, so say where it is. */
      const archiveFailed = (code: string, reason: string, failedCopy: { sessionId?: string; cwd?: string } | undefined = copied) =>
        ({ error: { code, message: `Copied as ${failedCopy?.sessionId} in ${failedCopy?.cwd}, but not archived: ${reason}` } });
      let archive: Awaited<ReturnType<typeof resolveRepoRoot>>;
      try {
        archive = await resolveRepoRoot(opts.repoRoot, { dryRun: isDryRun() });
      } catch (err) {
        if (!json) throw err;
        return archiveFailed('archive_failed', err instanceof Error ? err.message : String(err));
      }
      const { root: repoRoot, reports } = archive;
      // The team's declared secrets are known only for the teamai install's own archive, not for a --repo-root clone.
      const scrub = opts.scrub ? { secrets: reports ? await knownSecrets(reports) : {} } : false;
      // When expanded across directories, sessions do not belong to workCwd; author should come from the repo the session actually lives in
      const authorCwd = migratedTargets.find((t) => t.cwd)?.cwd ?? workCwd;
      const author = getGitAuthor(authorCwd);

      let stopped: MigrationResult | undefined;
      /** Saves the migrated sessions into the archive at `root`: how many, or undefined once `stopped` holds why it stopped. */
      const archiveInto = async (syncMgr: SyncManager, root: string): Promise<number | undefined> => {
        let saved = 0;
        let unarchived = 0;
        for (const t of migratedTargets) {
          // Migration keeps image paths so the target can still open the file.
          // The copy that lands in the team repo must not: re-read the target
          // and scrub again with the archive default, which drops filePath.
          const readBack = await AgentSession.find(
            { platform: target, sessionId: t.sessionId, cwd: t.cwd ?? opts.targetCwd ?? workCwd },
            { scrub, toolRootsFor },
          );
          if (readBack.status === 'failed') {
            if (json) {
              stopped = archiveFailed(readBack.failure.code, readBack.failure.message);
              return undefined;
            }
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
            const write = await syncMgr.saveSession(session, meta);
            if (write.status === 'busy') {
              stopped = archiveFailed('busy', `${archiveBusyMessage(root, write.lockPath)} Run it again once that has finished.`, t);
              return undefined;
            }
          } catch (err) {
            stopped = archiveFailed('archive_failed', err instanceof Error ? err.message : String(err), t);
            return undefined;
          }
          saved++;
        }
        if (unarchived > 0) {
          console.error(`\n  ✗ ${unarchived} migrated session(s) could not be read back and were not archived.`);
          process.exitCode = 1;
        }
        return saved;
      };
      const commitMessage = (saved: number) => `sync: migrate ${saved} session(s) ${source}→${target}`;
      // Archive changes and their Git publication are serialized per team repo, the teamai-reports archive included.
      const publication = await withSessionPublicationLock(repoRoot, async (): Promise<MigrationResult | undefined> => {
        if (reports) {
          const archived = await archiveToReports(reports, archiveInto, commitMessage);
          switch (archived.status) {
            case 'busy':
              return archiveFailed('busy', REPORTS_ARCHIVE_BUSY);
            case 'stopped':
              return stopped;
            case 'published':
              console.log(`\n  ✓ Pushed ${archived.saved} session(s) to team repo`);
              break;
            case 'already-present':
              console.log(`\n  · No changes to push\n`);
              break;
            case 'failed':
              console.error(`\n  ✗ ${archived.saved} session(s) not pushed to teamai-reports: ${safeText(archived.reason)}`);
              process.exitCode = 1;
              if (json) return archiveFailed('archive_failed', `the push to teamai-reports failed: ${safeText(archived.reason)}`);
              break;
            default: {
              const unhandled: never = archived;
              return unhandled;
            }
          }
        } else {
          const syncMgr = new SyncManager(repoRoot);
          const saved = await archiveInto(syncMgr, repoRoot);
          if (saved === undefined) return stopped;
          // [fixed] a gitCommit failure (not a git directory / index.lock race) used to crash with a raw stack trace
          // Under --json a throw reaches the action's catch, which prints the envelope; runGitStep would exit without one.
          const commitArchive = () => syncMgr.gitCommit(commitMessage(saved));
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
      });
      if (publication.status === 'busy') return archiveFailed('busy', archiveBusyMessage(repoRoot, publication.lockPath));
      if (publication.value) return publication.value;
    }

    return { summary: { copied, dryRun: isDryRun(), total: targets.length, migrated, reused, failed } };
  } catch (err) {
    // Interactive cancel (promptSelect throws 'Selection cancelled'; on EOF, ask returns an empty string
    // and hits that path) is not a failure. Exit quietly, and do not turn it into an unhandled-rejection stack.
    const msg = err instanceof Error ? err.message : String(err);
    // --json never prompts, so nothing here is a cancel. Listing, reading and copying report their
    // failures as values, so a throw that reaches here has no known cause.
    if (json) return { error: { code: 'unexpected_error', message: msg } };
    if (/cancel/i.test(msg)) {
      return { cancelled: true };
    }
    return { error: { code: 'unexpected_error', message: msg } };
  }
}

/** Register the migration command and keep its orchestration isolated from the other session commands. */
export function registerMigrationCommand(sessionCmd: Command, isDryRun: () => boolean): void {
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
    .option('--repo-root <path>', 'Team repo clone to archive into with --push (default: the teamai install for this directory, else your user install)')
    .option('--scrub', 'Redact secrets (tokens/keys/passwords) from the session before writing it')
    .option('--all', 'Migrate every session from source (not just the 5 most recent)')
    .option('--limit <n>', 'Max sessions to migrate (only caps --all; ignored otherwise)')
    .option('-y, --yes', 'Skip confirmation prompts, including archiving unredacted transcripts')
    .option('--json', 'Print one {data}|{error} JSON envelope on stdout; never prompts (needs a session id, -s and -t)')
    .action(async (sessionId: string | undefined, opts: MigrationOptions) => {
      const restoreStdout = opts.json ? reserveStdoutForEnvelope() : undefined;
      try {
        renderMigrationResult(await migrateSession(sessionId, opts, isDryRun), Boolean(opts.json));
      } finally {
        restoreStdout?.();
        closeStdin();
      }
    });
}
