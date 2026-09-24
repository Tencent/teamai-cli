/**
 * Hook Handler Registry — maps event+matcher to concrete handler implementations.
 *
 * Each handler wraps an existing teamai subcommand function but accepts pre-parsed
 * STDIN data instead of reading from process.stdin directly. This enables the
 * dispatcher to read STDIN once and fan out to all handlers.
 *
 * Existing standalone subcommands (`teamai pull`, `teamai track --stdin`, etc.)
 * remain unchanged for backward compatibility during migration.
 */

import path from 'node:path';

import type { HookHandler } from './hook-dispatch.js';
import type { LocalConfig } from './types.js';
import { deriveSessionId } from './utils/session-id.js';
import { log } from './utils/logger.js';
import { normalizeToolName } from './utils/tool-names.js';
import { resolveHookCwd } from './utils/hook-cwd.js';

// ─── Public types ───────────────────────────────────────

export interface HandlerRegistration {
  event: string;
  matcher: string;
  handler: HookHandler;
  timeoutMs: number;
  /** Fire-and-forget: run detached so it can't delay host hook completion. */
  background?: boolean;
  /**
   * Git-provider-only handler. When teamai is configured with an HTTP source
   * (localConfig.repo.kind === 'http'), these are filtered out at the dispatch
   * boundary so HTTP consumers never see prompts for git-only workflows
   * (contribute / import-from-mr / votes push). See filterHandlersForConfig.
   */
  gitOnly?: boolean;
  /**
   * Team handler: it only makes sense where teamai is set up. Hooks live in HOME
   * even for a project-scope install, so they fire in every project on the
   * machine; with no config for the hook's cwd these are filtered out at the
   * dispatch boundary (#748). See filterHandlersForConfig.
   */
  requiresConfig?: boolean;
}

// ─── Timeout constants ──────────────────────────────────

/**
 * Unified budget for every *foreground* (inline) handler, kept strictly under 5s.
 *
 * Foreground handlers block the host IDE's hook. Empirically CodeBuddy aborts a
 * hook at ~10s REGARDLESS of the larger `timeout` we declare (see
 * builtin-hooks.ts: even Stop/SessionStart, declared 15s, are killed at 10000ms),
 * reporting "Hook timed out after 10000ms" (error 3003) and breaking the IDE.
 *
 * So no single foreground handler may approach that ceiling. Since foreground
 * handlers on an event run concurrently, the whole foreground pass finishes at
 * ~max(handler timeouts) + node startup/exit, which must stay well under 10s. A
 * unified <5s cap guarantees that with margin. Healthy endpoints answer in well
 * under a second, so this is invisible in normal use; it only bounds the worst
 * case (slow/unreachable endpoint). Any network side-effect truncated here (e.g.
 * a large first-time resource sync, vote-delta push) is completed later by the
 * background (detached) pass, which is not awaited by the host.
 */
const FOREGROUND_HOOK_TIMEOUT_MS = 4_500;
/**
 * TodoWrite runs on a PostToolUse matcher whose host cap is only 3s
 * (builtin-hooks.ts), so it needs a tighter budget than the shared foreground
 * cap. It is a local dedup-cache check that completes in microseconds anyway.
 */
const TODOWRITE_HINT_TIMEOUT_MS = 2_500;
/** Background (detached) npm-registry update check — not awaited by the host. */
const UPDATE_TIMEOUT_MS = 10_000;
/**
 * Background (detached) local-agent HTTP report/sync. Detached runs are not
 * awaited by the host, so they keep a full budget to complete real work such as
 * resource downloads. Foreground local-agent runs use FOREGROUND_HOOK_TIMEOUT_MS.
 */
const LOCAL_AGENT_TIMEOUT_MS = 15_000;
/**
 * Background (detached) upvote LLM-judge (issue #723, opt-in). It shells out to
 * the local signed-in CLI (judgeAdoption caps that call at 30s), so it needs a
 * budget slightly above that to also parse + write + sync votes. Detached, so it
 * never delays the host Stop.
 */
const VOTES_JUDGE_TIMEOUT_MS = 45_000;
/**
 * Budget for the detached session-start pull.
 *
 * A background handler's timeout is not advisory: the dispatch pass settles on
 * it and index.ts then `process.exit(0)`s, truncating whatever is still running
 * (git children orphaned, later sync stages never run). Cold pulls — fetch,
 * submodule update, resource reconcile — measured 10-25s, so the shared 15s
 * budget silently cut the pull short. Since the postPull script runs inside
 * the pull, this budget also covers the deploy wait (sizing lives with the
 * constants in post-pull.ts, pinned by its guard test).
 */
export const PULL_TIMEOUT_MS = 120_000;

// ─── Handler implementations ────────────────────────────
//
// Each handler is a thin adapter that:
//   1. Receives pre-parsed STDIN (Record<string, unknown>)
//   2. Delegates to the actual subcommand logic
//   3. Returns output string or null
//
// IMPORTANT: These use dynamic imports to keep module loading lazy.
// The dispatcher only loads the modules that actually need to run.

const pullHandler: HookHandler = {
  name: 'pull',
  async execute(stdin, tool) {
    const cwd = resolveHookCwd(stdin);
    const hintCwd = cwd ?? process.cwd();
    const packageHints = await import('./pkg/pkg-hint.js');
    const packageHashBeforePull = await packageHints.packageManifestHashForCwd(hintCwd);
    try {
      const { seedProjectAgentRoot } = await import('./project-agent-root.js');
      await seedProjectAgentRoot(tool, cwd);
    } catch (e) {
      log.debug(`hook-dispatch: seedProjectAgentRoot failed: ${(e as Error).message}`);
    }
    const { pull } = await import('./pull.js');
    await pull({ silent: true });
    await packageHints.stashPackageHintAfterPull(
      hintCwd,
      deriveSessionId(stdin, { includeCwd: true }),
      packageHashBeforePull,
    );
    return null;
  },
};

const updateHandler: HookHandler = {
  name: 'update',
  async execute(_stdin, _tool) {
    const { doUpdate } = await import('./update.js');
    await doUpdate();
    return null;
  },
};

/**
 * Team course-correction keywords of the hook's scope. Only prompt hooks pay for
 * the team config read; no scope or an unreadable team config means "built-in
 * keywords only".
 */
async function teamCorrectionKeywords(
  stdin: Record<string, unknown>,
  config: LocalConfig | null,
): Promise<readonly string[]> {
  if (typeof stdin.prompt !== 'string' || !config) return [];
  try {
    const { loadTeamConfig } = await import('./config.js');
    const { getInterventionSharing } = await import('./types.js');
    const teamConfig = await loadTeamConfig(config.repo.localPath);
    return teamConfig ? getInterventionSharing(teamConfig).correctionKeywords : [];
  } catch {
    return [];
  }
}

/**
 * Per-machine gateway model-alias map from the user-scope config, used to price
 * requests whose transcript records an opaque alias instead of a Claude model
 * name. Only read on stop events (where pricing happens); an unreadable config
 * means "no aliases", i.e. built-in model-name matching only.
 */
async function userModelAliases(stdin: Record<string, unknown>): Promise<Record<string, string> | undefined> {
  const eventName = typeof stdin.hook_event_name === 'string' ? stdin.hook_event_name.toLowerCase() : '';
  if (eventName !== 'stop') return undefined;
  try {
    const { loadLocalConfig } = await import('./config.js');
    return (await loadLocalConfig())?.modelAliases;
  } catch {
    return undefined;
  }
}

const dashboardReportHandler: HookHandler = {
  name: 'dashboard-report',
  async execute(stdin, tool, config) {
    const { parseHookEvent, appendEvent, compactEvents } = await import('./dashboard-collector.js');
    const raw = JSON.stringify(stdin);
    const event = await parseHookEvent(raw, tool, {
      correctionKeywords: await teamCorrectionKeywords(stdin, config),
      modelAliases: await userModelAliases(stdin),
    });
    if (event) {
      await appendEvent(event);
      // Non-blocking compaction
      compactEvents().catch(() => {});
    }
    return null;
  },
};

const trackHandler: HookHandler = {
  name: 'track',
  async execute(stdin, tool) {
    const { resolveSkillUse, appendUsageEvent, updateKnownSkills } = await import('./usage-tracker.js');
    const { resolveConfigForDir } = await import('./config.js');

    const rawToolName = stdin.tool_name;
    if (typeof rawToolName !== 'string') return null;
    const toolName = normalizeToolName(rawToolName);

    const toolInput = stdin.tool_input;
    if (!toolInput || typeof toolInput !== 'object') return null;

    // Shared resolver: Skill (Claude/CodeBuddy) or Read+SKILL.md (Cursor).
    const resolved = resolveSkillUse(toolName, toolInput as Record<string, unknown>);
    if (!resolved) return null;

    const config = await resolveConfigForDir(resolveHookCwd(stdin));
    if (!config) return null;
    await appendUsageEvent({
      skill: resolved.skillName,
      timestamp: new Date().toISOString(),
      tool: resolved.source ?? tool,
    }, config);
    await updateKnownSkills(resolved.skillName);
    return null;
  },
};

const trackSlashHandler: HookHandler = {
  name: 'track-slash',
  async execute(stdin, tool) {
    const { isValidSkillName, appendUsageEvent, updateKnownSkills } = await import('./usage-tracker.js');
    const { resolveConfigForDir } = await import('./config.js');

    const prompt = stdin.prompt;
    if (typeof prompt !== 'string' || !prompt.startsWith('/')) return null;

    // Extract skill name: first word after "/". Character class must match
    // SKILL_NAME_REGEX (types.ts) — the CLI path (trackSlashCommand) already
    // uses the full set; this handler was narrower, silently truncating names
    // that contain dots or colons (both valid per the schema).
    const match = prompt.match(/^\/([a-zA-Z0-9_\-:.]+)/);
    if (!match) return null;

    const skillName = match[1];
    if (!isValidSkillName(skillName)) return null;

    const config = await resolveConfigForDir(resolveHookCwd(stdin));
    if (!config) return null;
    await appendUsageEvent({ skill: skillName, timestamp: new Date().toISOString(), tool }, config);
    await updateKnownSkills(skillName);
    return null;
  },
};


/**
 * Tell the user which recalled team-knowledge entries this session actually
 * adopted. A deterministic, user-facing summary built from tool-use adoption
 * evidence teamai already computed (files the agent opened) — the user sees the
 * real entries with no dependency on the model self-declaring anything. Only
 * shown when there is at least one adopted entry, so a session that used no team
 * knowledge stays quiet.
 *
 * English, like every other user-facing string (Claude Code prints the Stop
 * payload to the terminal).
 */
export function buildAdoptedSummary(adoptedDocIds: readonly string[]): string {
  return `[teamai] Adopted team knowledge this session: ${adoptedDocIds.join(', ')}`;
}

/**
 * Filter adopted doc-ids to those whose upvote may be attributed to the ACTIVE
 * scope's vote file. While a project is active, a doc recalled from the inherited
 * USER scope is read-only (issue #723 review) — crediting it would push a
 * user-knowledge vote to the project team on the next report, contradicting the
 * documented "inherited user hits remain read-only while the project is active"
 * rule and matching how recall.ts already scopes recalled_count. When the active
 * scope is `user` (or unknown), every adopted doc is eligible. A doc whose scope
 * is `unknown` (legacy region with no label) is credited to the active scope, as
 * before — the guard only withholds an EXPLICIT `user` hit during a project.
 */
export function eligibleUpvotes(
  adoptedDocIds: readonly string[],
  recalledDocScopes: Record<string, 'project' | 'user' | 'unknown'>,
  activeScope: string | undefined,
): string[] {
  if (activeScope !== 'project') return [...adoptedDocIds];
  return adoptedDocIds.filter((id) => recalledDocScopes[id] !== 'user');
}

const contributeCheckHandler: HookHandler = {
  name: 'contribute-check',
  async execute(stdin, tool) {
    // The payload's cwd, not the process's: hook-dispatch changes into it, but
    // that can fail, and the gate must not then read the launcher's directory.
    const { contributeHintAllowed } = await import('./skill-content.js');
    if (!(await contributeHintAllowed(resolveHookCwd(stdin)))) return null;

    const { contributeCheckForSession } = await import('./contribute-check.js');
    const { formatStopHookOutput, relayWhenHidden } = await import('./utils/hook-output.js');
    const { stopStdoutUnsupported } = await import('./utils/tool-names.js');

    // Match dashboard-collector's derivation so events and contribute state
    // share the same session id even when stdin.session_id is absent.
    const sessionId = deriveSessionId(stdin, { includeCwd: true });
    const cwd = resolveHookCwd(stdin);
    const transcriptPath = typeof stdin.transcript_path === 'string' ? stdin.transcript_path : undefined;
    // Tools whose Stop hook cannot deliver model context: stash the hint (in the same
    // single state write inside contributeCheckForSession) for delivery on the
    // next UserPromptSubmit, so contributeCheckForSession returns null here.
    const stash = stopStdoutUnsupported(tool);
    const { hint } = await contributeCheckForSession(sessionId, cwd, transcriptPath, stash);
    if (!hint) return null;
    // The hint is addressed to the user, so a host that hides the payload needs
    // the model to pass it on. Claude Code prints it and must not be asked (#719).
    return formatStopHookOutput(relayWhenHidden(hint, tool), tool);
  },
};

/** UserPromptSubmit: deliver contribution hints stashed by stdout-less tools. */
const pendingHintHandler: HookHandler = {
  name: 'pending-hint',
  async execute(stdin, tool) {
    const { stopStdoutUnsupported } = await import('./utils/tool-names.js');
    if (!stopStdoutUnsupported(tool)) return null;

    // Must match contributeCheckHandler's derivation so Stop and UserPromptSubmit
    // resolve to the same session file. This cross-process handoff relies on
    // codebuddy/workbuddy sending a stable, consistent session_id on BOTH the
    // Stop and the next UserPromptSubmit payload — verified against real session
    // data (a session's stop and prompt_submit events share one sessionId). If a
    // tool omits session_id, deriveSessionId falls back to pid+cwd, which can
    // differ across the two hook processes and orphan the stash (best-effort).
    const sessionId = deriveSessionId(stdin, { includeCwd: true });
    const pending = await import('./contribute-check.js');
    // Always consume the stash so a hint stashed before the team turned the
    // feature off is not delivered later when it is turned back on.
    const stashed = await pending.takePendingHint(sessionId);
    // The votes-hint stash/replay path is removed with the self-declaration
    // mechanism (#723); only the contribute hint remains. Uses the upstream
    // contributeHintAllowed(cwd) signature (moved to skill-content).
    const { contributeHintAllowed } = await import('./skill-content.js');
    const hint = (await contributeHintAllowed(resolveHookCwd(stdin))) ? stashed : null;
    if (!hint) return null;

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: hint,
      },
    });
  },
};

/** UserPromptSubmit: deliver a package notice created by the detached pull. */
const packagePendingHintHandler: HookHandler = {
  name: 'package-pending-hint',
  async execute(stdin, _tool) {
    const { takePendingPackageHint } = await import('./pkg/pkg-hint.js');
    const hint = await takePendingPackageHint(
      deriveSessionId(stdin, { includeCwd: true }),
    );
    if (!hint) return null;
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: hint,
      },
    });
  },
};

const votesSyncHandler: HookHandler = {
  name: 'votes-sync',
  async execute(stdin, tool, localConfig) {
    if (process.env.TEAMAI_RECALL_DISABLED === '1' || !localConfig) return null;

    const transcriptPath = typeof stdin.transcript_path === 'string' ? stdin.transcript_path : null;
    if (!transcriptPath) return null;

    try {
      const { parseTranscriptForVotes } = await import('./transcript-parser.js');
      const { incrementUpvoted, syncVotesToTeam, pruneUpvoteLedger } = await import('./votes.js');

      const voteData = await parseTranscriptForVotes(transcriptPath);
      const { getUserVotesDir } = await import('./types.js');
      const votesDir = getUserVotesDir();
      const votePath = path.join(votesDir, `${localConfig.username}.yaml`);

      // Count an upvote when a recalled doc was actually adopted this session.
      // Adoption is proven by tool-use evidence: the agent opened the recalled
      // doc's file via Read/Grep/Glob/Bash (collected in transcript-parser and
      // already gated to the recalled set). This needs zero cooperation from the
      // model — no self-declaration. A recalled doc the agent adopted without
      // opening its file (e.g. it used a subagent summary) is caught separately
      // by the optional background LLM-judge (TEAMAI_UPVOTE_JUDGE).
      // Stop fires after every turn, so the SAME adopted doc would be re-counted
      // on each subsequent Stop of the session. incrementUpvoted takes the
      // sessionId and does the dedup + increment atomically under the votes lock,
      // returning ONLY the docs it actually credited this call (or null if the
      // lock was busy). We surface exactly that freshly-credited subset — so a
      // failed/contended write neither claims the doc nor prints a summary, and a
      // later Stop retries cleanly.
      // Scope guard: while a PROJECT is active, a doc recalled from the inherited
      // USER scope is read-only — its upvote must NOT be attributed to the project
      // team's vote file (issue #723 review; matches recall.ts's recalled_count
      // scoping and the documented "inherited user hits remain read-only" rule).
      const eligible = eligibleUpvotes(voteData.adoptedDocIds, voteData.recalledDocScopes, localConfig.scope);
      let adoptedDocIds: string[] = [];
      if (eligible.length > 0) {
        const sessionId = deriveSessionId(stdin, { includeCwd: true });
        const credited = await incrementUpvoted(votePath, eligible, sessionId);
        adoptedDocIds = credited ?? [];
      }

      // Bound the in-file session ledger even in the default (judge-off) config,
      // where a recall-but-never-adopt session never reaches incrementUpvoted and
      // so would never prune (issue #723 review). This runs every Stop, is locked,
      // and only writes when it actually drops a stale entry.
      await pruneUpvoteLedger(votePath).catch(() => undefined);

      const { usesBranchWorktree } = await import('./types.js');
      if (usesBranchWorktree(localConfig)) {
        // Votes are report data → the teamai-reports orphan branch, written
        // through an isolated worktree (never the default branch / active tree).
        // Stop fires every turn: skip the fetch when nothing is pending.
        try {
          const { hasPendingVoteDeltas } = await import('./votes.js');
          if (await hasPendingVoteDeltas(votesDir, localConfig.username)) {
            const { updateReports } = await import('./utils/reports-branch.js');
            await updateReports(localConfig, async (wt) => (
              await syncVotesToTeam(wt, localConfig.username, votesDir)
                ? {
                  files: [`votes/${localConfig.username}.yaml`],
                  message: `[teamai] Update votes for ${localConfig.username}`,
                }
                : null
            ));
          }
        } catch {
          // Push failed — will retry next session
        }
      } else {
        await syncVotesToTeam(localConfig.repo.localPath, localConfig.username, votesDir).catch(() => {
          // Push failed — will retry next session
        });
      }

      // A/B measurement (opt-in): one line per Stop. `adopted` is the count
      // newly credited this turn (after per-session dedup), so summing the log
      // over a session yields the true number of docs upvoted for it.
      if (process.env.TEAMAI_ADOPTION_EVAL_LOG) {
        try {
          const sessionId = deriveSessionId(stdin, { includeCwd: true });
          const { appendFile } = await import('node:fs/promises');
          await appendFile(
            process.env.TEAMAI_ADOPTION_EVAL_LOG,
            JSON.stringify({
              ts: new Date().toISOString(),
              sessionId,
              recalled: voteData.recalledDocIds.length,
              adopted: adoptedDocIds.length,
            }) + '\n',
          );
        } catch {
          // best-effort; measurement only
        }
      }

      // This session adopted team knowledge → surface the real adopted entries
      // to the user, so they observe the recall database's effect. Deterministic:
      // built from tool-use evidence, not from the model self-declaring anything.
      //
      // This is a user-facing note, not a model instruction, so we only emit it
      // on tools that print the Stop payload to the terminal. Tools whose Stop
      // stdout is ignored deliver stashed content back through the model's
      // context (additionalContext); routing an FYI summary there would pollute
      // the next turn, so we simply skip it for those tools rather than misuse
      // the model channel.
      if (adoptedDocIds.length > 0) {
        const { stopStdoutUnsupported } = await import('./utils/tool-names.js');
        if (!stopStdoutUnsupported(tool)) {
          const { formatStopHookOutput } = await import('./utils/hook-output.js');
          return formatStopHookOutput(buildAdoptedSummary(adoptedDocIds), tool ?? 'claude');
        }
      }
    } catch (error) {
      // Non-critical for the session (votes retry on next pull), but the failure
      // MUST be traceable: a swallowed error here is exactly why upvote
      // collection could fail silently for an entire team (see #723). Log it.
      log.debug(`votes-sync handler failed: ${(error as Error)?.stack ?? String(error)}`);
    }
    return null;
  },
};

/**
 * Optional background LLM-judge for upvote adoption (issue #723, design option 1).
 *
 * The foreground votesSyncHandler credits adoption from tool-use evidence (the
 * agent opened a recalled doc's file). But the recommended recall path injects
 * the subagent's summary as text, so the main agent often adopts a doc WITHOUT
 * opening it — leaving no tool-use trace. This detached pass asks the local
 * signed-in CLI whether the latest reply substantively used each recalled doc,
 * then upvotes the subset the foreground pass did NOT already credit (no double
 * counting).
 *
 * Properties:
 *   - background: true → runs detached, never blocks the host Stop (UX ~0s).
 *   - Uses the user's local CLI (subscription), not a platform API key.
 *   - Opt-in via TEAMAI_UPVOTE_JUDGE=1 so default behavior is unchanged; a
 *     reviewer can decide whether to enable it by default after evaluating cost.
 *   - Judgement gated to recalled doc-ids; fails soft (no upvote on any error).
 *   - Each recalled doc is judged at most once per session (per-doc judged
 *     record, not an exclusive claim); later turns still judge NEW docs, and a
 *     killed run records nothing so the next Stop retries (crash-safe).
 */
const votesJudgeHandler: HookHandler = {
  name: 'votes-judge',
  async execute(stdin, _tool, localConfig) {
    if (process.env.TEAMAI_RECALL_DISABLED === '1' || !localConfig) return null;
    // Opt-in only. Keeps the default path identical to the tool-use-only fix.
    if (process.env.TEAMAI_UPVOTE_JUDGE !== '1') return null;

    const transcriptPath = typeof stdin.transcript_path === 'string' ? stdin.transcript_path : null;
    if (!transcriptPath) return null;

    try {
      const sessionId = deriveSessionId(stdin, { includeCwd: true });

      // Parse and filter candidates BEFORE claiming the session. Stop fires
      // every turn, including turns before any recall has happened; claiming on
      // such an early Stop would burn the once-per-session marker and prevent the
      // judge from ever running on the later turns that DO have recalls. So we
      // only spend the claim once there is real work to do.
      const { parseTranscriptForVotes } = await import('./transcript-parser.js');
      const voteData = await parseTranscriptForVotes(transcriptPath);
      if (voteData.recalledDocIds.length === 0) return null;

      // Only judge docs the foreground pass did NOT already credit — i.e. those
      // with no tool-use evidence (the agent adopted them without opening their
      // file). This avoids double counting the same adoption.
      const recalledSet = new Set(voteData.recalledDocIds);
      const alreadyCredited = new Set<string>(voteData.adoptedDocIds);

      // Resolve config + votes path up front so we can also exclude docs the
      // session already UPVOTED (via the shared in-file ledger). Without this,
      // a doc the foreground pass credited on a later turn would still enter
      // toJudge and, because the provisional claim is released whenever the
      // increment dedups to nothing, could re-trigger a local-CLI judge call on
      // every subsequent Stop (issue #723 review). Filtering here keeps the cost
      // at ~one CLI call per session in the steady state.
      const { getUserVotesDir, getUserLearningsDir, usesBranchWorktree } = await import('./types.js');
      const votesDir = getUserVotesDir();
      const votePath = path.join(votesDir, `${localConfig.username}.yaml`);
      const { creditedDocIdsForSession } = await import('./votes.js');
      const ledgerCredited = await creditedDocIdsForSession(votePath, sessionId);

      // Same scope guard as the foreground handler: while a project is active,
      // a doc recalled from the inherited USER scope is read-only, so the judge
      // must not upvote it into the project team either (issue #723 review).
      const scopeEligible = new Set(
        eligibleUpvotes(voteData.recalledDocIds, voteData.recalledDocScopes, localConfig.scope),
      );
      // Dedup is ledger-only now: a doc credited by the foreground pass, by this
      // judge's tool-use evidence, or already in the shared per-session upvote
      // ledger is never sent to the judge again. A recalled doc that was NOT
      // adopted is re-judged on a later Stop (the judge is opt-in, so this cost
      // is acceptable). There is no per-session marker to clean up, so a killed
      // detached run leaves no stuck state; later turns can still judge NEW docs,
      // and a positive verdict only lands once incrementUpvoted succeeds
      // atomically (sessionId-scoped) — preventing any double credit.
      const toJudge = voteData.recalledDocIds.filter(
        (id) => scopeEligible.has(id) && !alreadyCredited.has(id) && !ledgerCredited.has(id),
      );
      if (toJudge.length === 0) return null;

      // The judge reads recalled doc excerpts; restrict those reads to trusted
      // knowledge roots so an unauthenticated transcript cannot make it read an
      // arbitrary local file (issue #723 review). Use the SAME roots recall
      // itself reads from — the learnings write root / teamai-learnings branch
      // worktree, the user-scope mirror, this scope's partition cache, and the
      // inherited knowledge clone — PLUS the pending-contribution queue (which
      // recall indexes first and which, for git teams, lives OUTSIDE the clone,
      // beside it) and the repo clone (for docs/). Deriving the list from
      // learningsRoots keeps it correct wherever recall's roots move. Base roots
      // (always safe): the repo clone (docs/) and the user mirror. Recall-derived
      // roots are added best-effort — a resolution failure degrades to the base
      // set, not a disabled judge (the excerpt read is fail-closed either way).
      const allowedRoots = [localConfig.repo.localPath, getUserLearningsDir()];
      try {
        const { learningsRoots } = await import('./utils/learnings-roots.js');
        const { pendingLearningsDir } = await import('./utils/pending-learnings.js');
        allowedRoots.push(...learningsRoots(localConfig).read, pendingLearningsDir(localConfig));
      } catch (e) {
        log.debug(`votes-judge: could not resolve extra learnings roots: ${(e as Error).message}`);
      }
      const roots = allowedRoots.filter(Boolean);

      const { judgeAdoption } = await import('./votes-judge.js');
      const adopted = await judgeAdoption(voteData.finalAssistantText, toJudge, voteData.recalledDocPaths, roots);

      // Gate again to recalled (defensive; judgeAdoption already restricts to toJudge).
      const verified = adopted.filter((id) => recalledSet.has(id));
      if (verified.length === 0) return null;

      const { incrementUpvoted, syncVotesToTeam, hasPendingVoteDeltas } = await import('./votes.js');
      // Pass sessionId so judge credits enter the SAME per-session ledger the
      // foreground handler uses, preventing a later foreground open from
      // double-counting the same doc (issue #723 review).
      const credited = await incrementUpvoted(votePath, verified, sessionId);
      if (credited === null || credited.length === 0) return null;

      // Sync using the same path as the foreground handler.
      if (usesBranchWorktree(localConfig)) {
        if (await hasPendingVoteDeltas(votesDir, localConfig.username)) {
          const { updateReports } = await import('./utils/reports-branch.js');
          await updateReports(localConfig, async (wt) => (
            await syncVotesToTeam(wt, localConfig.username, votesDir)
              ? { files: [`votes/${localConfig.username}.yaml`], message: `[teamai] Update votes for ${localConfig.username}` }
              : null
          )).catch(() => undefined);
        }
      } else {
        await syncVotesToTeam(localConfig.repo.localPath, localConfig.username, votesDir).catch(() => undefined);
      }
    } catch (error) {
      // Best-effort supplement; never surface failures.
      log.debug(`votes-judge handler failed: ${(error as Error)?.stack ?? String(error)}`);
    }
    return null;
  },
};

const todowriteHintHandler: HookHandler = {
  name: 'todowrite-hint',
  async execute(stdin, _tool) {
    if (process.env.TEAMAI_RECALL_DISABLED === '1') return null;

    const toolName = normalizeToolName(typeof stdin.tool_name === 'string' ? stdin.tool_name : '');
    if (toolName !== 'TodoWrite') return null;

    const { shouldSkipTodoWriteHint, buildHintMessage } = await import('./todowrite-hint.js');

    if (shouldSkipTodoWriteHint(deriveSessionId(stdin))) return null;

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: buildHintMessage(),
      },
    });
  },
};

const mrHintHandler: HookHandler = {
  name: 'mr-hint',
  async execute(_stdin, _tool) {
    const { computeMrHintOutput } = await import('./mr-hint.js');
    return computeMrHintOutput();
  },
};

const packageHintHandler: HookHandler = {
  name: 'package-hint',
  async execute(stdin, _tool) {
    const { claimPackageHintOutput } = await import('./pkg/pkg-hint.js');
    return claimPackageHintOutput(
      resolveHookCwd(stdin) ?? process.cwd(),
      deriveSessionId(stdin, { includeCwd: true }),
    );
  },
};

/** HTTP local-agent report/sync + workspace binding prompts. */
const localAgentHandler: HookHandler = {
  name: 'local-agent-sync',
  async execute(stdin, tool) {
    const { reportAndSyncFromHook } = await import('./local-agent.js');
    return reportAndSyncFromHook(stdin, tool);
  },
};

/**
 * Map a host's `hook_event_name` (as normalized by parseStdin) to the canonical
 * webhook event names teams subscribe to. The handler used to read `stdin.event`,
 * which hosts never send, so every event was forwarded as `unknown` and no
 * `skill-use` / `session-start` / `session-stop` subscription ever matched (#702).
 *
 * Keyed by the lowercased hook name for a case-insensitive lookup: Claude sends
 * PascalCase (`SessionStart`) while Cursor/CodeBuddy send camelCase
 * (`sessionStart`) — see dashboard-collector's mapEventType, which handles both.
 * A case-sensitive PascalCase-only map silently dropped the camelCase hosts.
 */
const WEBHOOK_EVENT_BY_HOOK: Record<string, string> = {
  sessionstart: 'session-start',
  stop: 'session-stop',
  sessionend: 'session-stop',
  posttooluse: 'skill-use',
};

/**
 * Build the minimal, whitelisted data payload for a webhook event.
 *
 * Only a fixed set of non-sensitive fields per event is forwarded. Raw
 * `tool_input` (which can carry API keys in tool args) and `tool_response`
 * (which can carry private tool output) are never included (#701). The result is
 * additionally deep-redacted at the send boundary (see sendWebhook).
 */
async function buildWebhookData(
  event: string,
  stdin: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (event === 'skill-use') {
    const rawToolName = stdin.tool_name;
    const toolInput = stdin.tool_input;
    if (typeof rawToolName !== 'string' || !toolInput || typeof toolInput !== 'object') return {};
    const { resolveSkillUse } = await import('./usage-tracker.js');
    // Same resolver trackHandler uses, so the webhook reaches parity: it fires
    // for Claude/CodeBuddy `Skill` AND Cursor's `Read` of a SKILL.md path, and
    // never for a normal file Read (#702 follow-up). The resolver already
    // validates the name with isValidSkillName, so a tool-arg string cannot
    // escape as skillName (#701).
    const resolved = resolveSkillUse(
      normalizeToolName(rawToolName),
      toolInput as Record<string, unknown>,
    );
    return resolved ? { skillName: resolved.skillName } : {};
  }
  if (event === 'session-start' || event === 'session-stop') {
    const sessionId = deriveSessionId(stdin);
    return sessionId ? { sessionId } : {};
  }
  return {};
}

/** Webhook notification handler — sends events to configured endpoints. */
const webhookHandler: HookHandler = {
  name: 'webhook-dispatch',
  async execute(stdin, tool, localConfig) {
    if (!localConfig) return null;
    const { sendWebhook, loadWebhookConfig } = await import('./webhook.js');

    try {
      const config = await loadWebhookConfig(localConfig);
      if (!config.enabled || config.endpoints.length === 0) return null;

      const hookEventName = typeof stdin.hook_event_name === 'string' ? stdin.hook_event_name : '';
      // Case-insensitive so both PascalCase (Claude) and camelCase (Cursor/
      // CodeBuddy) hook names resolve (#702).
      const event = WEBHOOK_EVENT_BY_HOOK[hookEventName.toLowerCase()];
      // Only forward events we can map to a canonical name — never emit `unknown` (#702).
      if (!event) return null;

      const payload = {
        tool,
        sessionId: deriveSessionId(stdin),
        cwd: resolveHookCwd(stdin),
        username: typeof stdin.username === 'string' ? stdin.username : undefined,
        data: await buildWebhookData(event, stdin),
      };

      await sendWebhook(event, payload, config);
    } catch (error) {
      log.debug(`Webhook dispatch failed: ${(error as Error).message}`);
    }

    return null;
  },
};

// ─── Registry builder ───────────────────────────────────

/**
 * Build the complete handler registry for the hook dispatcher.
 * Returns all handler registrations with their event, matcher, timeout, and implementation.
 */
export function buildHandlerRegistry(): HandlerRegistration[] {
  return [
    // ─── SessionStart ─────────────────────────────────
    // pull does not produce output the host needs; run detached so git fetch
    // on a slow network cannot delay session startup. Its own generous budget
    // (PULL_TIMEOUT_MS) — the shared 15s truncated the pull itself.
    { event: 'session-start', matcher: '*', handler: pullHandler, timeoutMs: PULL_TIMEOUT_MS, background: true },
    { event: 'session-start', matcher: '*', handler: dashboardReportHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'session-start', matcher: '*', handler: mrHintHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, gitOnly: true, requiresConfig: true },
    { event: 'session-start', matcher: '*', handler: packageHintHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'session-start', matcher: '*', handler: localAgentHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },
    { event: 'session-start', matcher: '*', handler: webhookHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, background: true, requiresConfig: true },

    // Copilot emits SessionEnd after its final turn (not Stop), so the webhook
    // handler must run here too or those sessions emit no session-stop
    // notification (#702). Detached, mirroring the stop registration.
    { event: 'session-end', matcher: '*', handler: dashboardReportHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, background: true, requiresConfig: true },
    { event: 'session-end', matcher: '*', handler: webhookHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, background: true, requiresConfig: true },

    // ─── Stop ─────────────────────────────────────────
    // votes-sync and contribute-check may return a hint the host injects back
    // into the session, so they run inline (capped at FOREGROUND_HOOK_TIMEOUT_MS).
    // The rest are pure side effects — the update check in particular shells out
    // to the npm registry — so they run detached to avoid pushing the Stop hook
    // past the host's hook timeout (CodeBuddy kills hooks at ~10s regardless of
    // the declared timeout).
    { event: 'stop', matcher: '*', handler: updateHandler, timeoutMs: UPDATE_TIMEOUT_MS, background: true },
    { event: 'stop', matcher: '*', handler: votesSyncHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, gitOnly: true, requiresConfig: true },
    // Optional background LLM-judge (issue #723). Opt-in via TEAMAI_UPVOTE_JUDGE=1;
    // detached so it never delays the Stop. gitOnly (HTTP teams skip upvotes).
    { event: 'stop', matcher: '*', handler: votesJudgeHandler, timeoutMs: VOTES_JUDGE_TIMEOUT_MS, background: true, gitOnly: true, requiresConfig: true },
    { event: 'stop', matcher: '*', handler: contributeCheckHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, gitOnly: true, requiresConfig: true },
    { event: 'stop', matcher: '*', handler: dashboardReportHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, background: true, requiresConfig: true },
    { event: 'stop', matcher: '*', handler: localAgentHandler, timeoutMs: LOCAL_AGENT_TIMEOUT_MS, background: true },
    { event: 'stop', matcher: '*', handler: webhookHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, background: true, requiresConfig: true },

    // ─── PostToolUse ──────────────────────────────────
    { event: 'post-tool-use', matcher: '*', handler: dashboardReportHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'post-tool-use', matcher: 'Skill', handler: trackHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'post-tool-use', matcher: 'TodoWrite', handler: todowriteHintHandler, timeoutMs: TODOWRITE_HINT_TIMEOUT_MS, requiresConfig: true },
    { event: 'post-tool-use', matcher: '*', handler: localAgentHandler, timeoutMs: LOCAL_AGENT_TIMEOUT_MS, background: true },
    { event: 'post-tool-use', matcher: 'Skill', handler: webhookHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, background: true, requiresConfig: true },

    // ─── UserPromptSubmit ─────────────────────────────
    { event: 'prompt-submit', matcher: '*', handler: pendingHintHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, gitOnly: true, requiresConfig: true },
    { event: 'prompt-submit', matcher: '*', handler: packagePendingHintHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },
    { event: 'prompt-submit', matcher: '*', handler: trackSlashHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'prompt-submit', matcher: '*', handler: dashboardReportHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'prompt-submit', matcher: '*', handler: localAgentHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },
  ];
}

/**
 * Apply the config gates to a handler registry.
 *
 * No config (localConfig === null) drops every `requiresConfig` handler. Hooks
 * live in HOME even for a project-scope install, so they fire in every project
 * on the machine; a directory without teamai must see no team prompts (#748).
 * A config that fails to parse also reads as null (loadLocalConfig swallows
 * parse errors), so a corrupted config withholds team prompts too; `teamai
 * doctor` reports it.
 *
 * HTTP-only teams (localConfig.repo.kind === 'http') must not receive prompts
 * for git-provider-only features, so every `gitOnly` handler is dropped when the
 * team source is HTTP. A git source (kind === 'git' or undefined for backward
 * compatibility) keeps the full registry.
 *
 * The gate is keyed on teamai's own configured source, NOT on the current
 * working directory's git remote — an HTTP-only user working inside a
 * github/tgit checkout must still see no git-only prompts. This is
 * intentionally NOT a hard security gate — HTTP write ops are still enforced
 * at execution time by assertNotReadOnly().
 */
export function filterHandlersForConfig(
  registry: HandlerRegistration[],
  localConfig: LocalConfig | null,
): HandlerRegistration[] {
  if (!localConfig) {
    return registry.filter((reg) => reg.requiresConfig !== true);
  }
  if (localConfig.repo.kind === 'http') {
    return registry.filter((reg) => reg.gitOnly !== true);
  }
  return registry;
}
