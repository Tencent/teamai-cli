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

import type { ResolvedEntry } from './namespaced-entries.js';
import type { HookHandler } from './hook-dispatch.js';
import type { LocalConfig } from './types.js';
import type { GitHookEvent } from './git-hook.js';
import { deriveDispatchSessionId, deriveSessionId } from './utils/session-id.js';
import { log } from './utils/logger.js';
import { isReservedTeamEnvKey } from './env-reserved.js';
import { normalizeToolName } from './utils/tool-names.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { pathExists } from './utils/fs.js';

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
  async execute(stdin, tool, config) {
    const cwd = resolveHookCwd(stdin);
    // No config resolved: teamai is not set up here, or the project config
    // cannot be read. Only the second stops the pull, since what detection
    // loads after that file may be another team's (#784). A cwd that no longer
    // exists holds no project config, and git refuses to open it.
    if (!config && (cwd === undefined || await pathExists(cwd))) {
      const { findUnreadableProjectConfig } = await import('./config.js');
      if (await findUnreadableProjectConfig(cwd) !== null) return null;
    }
    // A tool excluded here, by `uninstall --agent` or an uninstall that could not remove its hooks,
    // syncs nothing from its hooks: a pull would restore what was removed (#993).
    if (config) {
      const { isAgentExcluded } = await import('./types.js');
      if (isAgentExcluded(config, tool)) return null;
    }
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

/**
 * `post-checkout` from the git hook: a new checkout (a linked worktree) of a
 * project-scope repository gets its tool roots and the team's resources. A
 * branch switch, user scope (whose resources live in HOME), and checkouts
 * teamai itself creates (its knowledge and reports worktrees, under the scope's
 * data home or team clone) do nothing.
 */
const newWorktreeHandler: HookHandler = {
  name: 'new-worktree',
  async execute(stdin, _tool, config) {
    const { isNewCheckout } = await import('./git-hook.js');
    const args = Array.isArray(stdin.git_args) ? stdin.git_args.map(String) : [];
    if (!config || config.scope !== 'project' || !isNewCheckout(args)) return null;
    const cwd = resolveHookCwd(stdin) ?? process.cwd();
    const { getDataHome } = await import('./types.js');
    if (await isWithin(cwd, [getDataHome(config), config.repo.localPath, ...await ownCheckoutsDir(cwd)])) return null;

    await recordingFailure(config, 'post-checkout', async () => {
      const { createProjectToolRoots } = await import('./project-agent-root.js');
      await createProjectToolRoots({ cwd });
      const { pull } = await import('./pull.js');
      await pull({ silent: true, inline: true, gitHook: 'post-checkout' });
    });
    // Learnings, reports, sources and the team repo itself refresh after
    // `git worktree add` returns; it also retries what failed above.
    await spawnDetachedPull(cwd, 'post-checkout');
    return null;
  },
};

/** How long `git pull` waits for its hook's team repo fetch. */
const GIT_PULL_FETCH_CAP_MS = 5_000;

/**
 * `post-merge`, `post-rewrite` after a rebase, or `post-checkout` from a rebase
 * that only fast-forwarded (`git pull`, see isRebaseFastForward): the next session gets what
 * changed. With a separate team repo, the team repo is fetched inline within
 * GIT_PULL_FETCH_CAP_MS and delivered when its revision moved (the rev fast
 * path skips it otherwise); past the cap, and for learnings, reports and
 * sources, a detached pull takes over. In single-repo (self) mode the team
 * repo is the working tree `git pull` just updated: delivered with no network.
 */
const gitPullHandler: HookHandler = {
  name: 'git-pull',
  async execute(stdin, _tool, config) {
    if (!config || config.scope !== 'project') return null;
    const event = stdin.hook_event_name === 'post-rewrite' || stdin.hook_event_name === 'post-checkout'
      ? stdin.hook_event_name : 'post-merge';
    const args = Array.isArray(stdin.git_args) ? stdin.git_args.map(String) : [];
    if (event === 'post-rewrite' && args[0] !== 'rebase') return null;
    const cwd = resolveHookCwd(stdin) ?? process.cwd();
    if (event === 'post-checkout') {
      const { isRebaseFastForward } = await import('./git-hook.js');
      if (!await isRebaseFastForward(args, process.env.GIT_REFLOG_ACTION, cwd)) return null;
    }
    const { getDataHome, isSelfMode } = await import('./types.js');
    const self = isSelfMode(config);
    // teamai's own checkouts; in self mode the team repo is the member's.
    const own = [getDataHome(config), ...await ownCheckoutsDir(cwd)];
    if (await isWithin(cwd, self ? own : [...own, config.repo.localPath])) return null;

    const { pull } = await import('./pull.js');
    await recordingFailure(config, event, () => pull({
      silent: true, inline: true, gitHook: event, fetchTimeoutMs: GIT_PULL_FETCH_CAP_MS,
    }));
    if (!self) await spawnDetachedPull(cwd, event);
    return null;
  },
};

/**
 * Run the inline pass of a git hook; what it throws is recorded (the hook is
 * silent), not raised.
 */
async function recordingFailure(
  config: LocalConfig,
  event: GitHookEvent,
  pass: () => Promise<unknown>,
): Promise<void> {
  try {
    await pass();
  } catch (e) {
    const { recordGitHookFailure } = await import('./git-hook.js');
    await recordGitHookFailure(config, { kind: 'hook-error', event, at: new Date().toISOString(), error: (e as Error).message });
  }
}

/**
 * Start a full `teamai pull --silent` in `cwd` that this process does not wait
 * for. TEAMAI_GIT_HOOK makes it record its failure, and clear the record when it
 * succeeds.
 */
async function spawnDetachedPull(cwd: string, event: GitHookEvent): Promise<void> {
  const { resolveCliEntry } = await import('./builtin-hooks.js');
  const { spawn } = await import('node:child_process');
  spawn(process.execPath, [resolveCliEntry() ?? '', 'pull', '--silent'], {
    cwd, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, TEAMAI_GIT_HOOK: event },
  }).on('error', (e) => log.debug(`git hook: detached pull failed to start: ${e.message}`)).unref();
}

/**
 * The main checkout's `.teamai/`, where teamai creates its knowledge worktree.
 * Detection run from inside that worktree resolves the worktree as its own
 * project root, so the config alone cannot tell it is teamai's.
 */
async function ownCheckoutsDir(cwd: string): Promise<string[]> {
  // Git refuses to open a directory that no longer exists.
  if (!await pathExists(cwd)) return [];
  const { resolveAnchors } = await import('./utils/git.js');
  const anchors = await resolveAnchors(cwd);
  return anchors ? [path.join(anchors.projectAnchor, '.teamai')] : [];
}

/** Whether `dir` is one of `parents` or inside one (real paths). */
async function isWithin(dir: string, parents: string[]): Promise<boolean> {
  const { realpath } = await import('node:fs/promises');
  const real = (p: string) => realpath(p).catch(() => path.resolve(p));
  const target = await real(dir);
  for (const parent of parents) {
    const rel = path.relative(await real(parent), target);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

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
    // Registered with requiresConfig: a session outside any scope is not recorded.
    if (!config) return null;
    const { parseHookEvent, appendEvent, compactEvents, dataHomeKey, eventProjectAnchor } = await import('./dashboard-collector.js');
    const { getDataHome } = await import('./types.js');
    const raw = JSON.stringify(stdin);
    const event = await parseHookEvent(raw, tool, {
      correctionKeywords: await teamCorrectionKeywords(stdin, config),
      modelAliases: await userModelAliases(stdin),
    });
    if (event) {
      // The dispatcher's scope, which knows the project even when the event
      // records no cwd (Copilot) or a symlinked one (#785).
      event.dataHomeKey = await dataHomeKey(getDataHome(config));
      event.projectAnchor = await eventProjectAnchor(event.cwd, event.sessionId);
      await appendEvent(event);
      // Non-blocking compaction
      compactEvents().catch(() => {});
    }
    return null;
  },
};

const trackHandler: HookHandler = {
  name: 'track',
  async execute(stdin, tool, config) {
    // Registered with requiresConfig: the dispatcher's scope, which knows the
    // project of a removed worktree (#810).
    if (!config) return null;
    const { resolveSkillUse, appendUsageEvent, updateKnownSkills } = await import('./usage-tracker.js');

    const rawToolName = stdin.tool_name;
    if (typeof rawToolName !== 'string') return null;
    const toolName = normalizeToolName(rawToolName);

    const toolInput = stdin.tool_input;
    if (!toolInput || typeof toolInput !== 'object') return null;

    // Shared resolver: Skill (Claude/CodeBuddy) or Read+SKILL.md (Cursor).
    const resolved = resolveSkillUse(toolName, toolInput as Record<string, unknown>);
    if (!resolved) return null;

    await appendUsageEvent({
      skill: resolved.skillName,
      timestamp: new Date().toISOString(),
      tool: resolved.source ?? tool,
    }, config);
    await updateKnownSkills(resolved.skillName);
    return null;
  },
};

/**
 * PostToolUse: record a recall claim or a read of team knowledge in the recall
 * log, for the reducer votes-sync runs at Stop, SubagentStop and SessionEnd (#884). One
 * write per call, whatever number of run ids, docs read or files a search
 * showed lines of it records, and never a read of the log or of a file, so it
 * stays inside the foreground budget.
 */
const recallAttributionHandler: HookHandler = {
  name: 'recall-attribution',
  async execute(stdin, tool, config) {
    if (process.env.TEAMAI_RECALL_DISABLED === '1' || !config) return null;
    const { recordToolCall } = await import('./recall-adoption.js');
    await recordToolCall(stdin, tool, config);
    return null;
  },
};

const trackSlashHandler: HookHandler = {
  name: 'track-slash',
  async execute(stdin, tool, config) {
    // Registered with requiresConfig: the dispatcher's scope (#810).
    if (!config) return null;
    const { isValidSkillName, appendUsageEvent, updateKnownSkills } = await import('./usage-tracker.js');

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
    // A removed worktree's session keeps its recorded scope (#810).
    const { contributeHintAllowed } = await import('./skill-content.js');
    const { hookScopeDir } = await import('./dashboard-collector.js');
    if (!(await contributeHintAllowed(await hookScopeDir(stdin, tool)))) return null;

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
    const { hookScopeDir } = await import('./dashboard-collector.js');
    const hint = (await contributeHintAllowed(await hookScopeDir(stdin, tool))) ? stashed : null;
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

    try {
      const { creditAdoptedDocs } = await import('./recall-adoption.js');
      const { syncVotesToTeam, pruneUpvoteLedger } = await import('./votes.js');
      const { getVotesDir } = await import('./types.js');
      const votesDir = getVotesDir(localConfig);
      const votePath = path.join(votesDir, `${localConfig.username}.yaml`);
      const sessionId = deriveDispatchSessionId(stdin, tool);

      // Count an upvote when this session opened a doc one of its recalls
      // returned, within 24 h after the run: the reducer joins the recall log's
      // runs, claims and evidence, which PostToolUse recorded (#884). No
      // transcript is needed, so hosts that send none vote too. A doc adopted
      // without opening its file (a subagent summary) is left to the opt-in
      // judge (TEAMAI_UPVOTE_JUDGE). Stop fires every turn: the per-session
      // ledger in incrementUpvoted credits a doc once, and only the docs this
      // call credited come back (none when the votes file was busy, and the
      // next Stop retries). Inherited user-scope docs stay read-only.
      const { credited, recalled } = await creditAdoptedDocs(localConfig, sessionId);
      const adoptedDocIds = credited ?? [];
      // A subagent's end is not the end of the turn: the main agent waits on
      // this hook, so it only credits locally. The ledger prune and the vote
      // push, a git round trip, wait for the next Stop or pull.
      const hookEvent = typeof stdin.hook_event_name === 'string' ? stdin.hook_event_name.toLowerCase() : '';
      const subagentStop = hookEvent === 'subagentstop';
      // Copilot's SessionEnd ends the session: it pushes as Stop does, but no
      // one reads its reply, so it prints no summary.
      const sessionEnd = hookEvent === 'sessionend';

      // Bound the in-file session ledger even in the default (judge-off) config,
      // where a recall-but-never-adopt session never reaches incrementUpvoted and
      // so would never prune (issue #723 review). This runs every Stop, is locked,
      // and only writes when it actually drops a stale entry.
      if (!subagentStop) await pruneUpvoteLedger(votePath).catch(() => undefined);

      const { usesBranchWorktree } = await import('./types.js');
      if (subagentStop) {
        // Nothing to push now: see above.
      } else if (usesBranchWorktree(localConfig)) {
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
          const { appendFile } = await import('node:fs/promises');
          await appendFile(
            process.env.TEAMAI_ADOPTION_EVAL_LOG,
            JSON.stringify({
              ts: new Date().toISOString(),
              sessionId,
              recalled,
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
      // The summary is for Stop alone.
      if (adoptedDocIds.length > 0 && !subagentStop && !sessionEnd) {
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
 * then upvotes the subset. Docs already in the session's upvote ledger are
 * never sent to it, so it and the foreground pass never double-count (#884).
 *
 * Properties:
 *   - background: true → runs detached, never blocks the host Stop (UX ~0s).
 *   - Uses the user's local CLI (subscription), not a platform API key.
 *   - Opt-in via TEAMAI_UPVOTE_JUDGE=1 so default behavior is unchanged; a
 *     reviewer can decide whether to enable it by default after evaluating cost.
 *   - Judgement gated to recalled doc-ids; fails soft (no upvote on any error).
 *   - Each recalled doc is upvoted at most once per session (the ledger); a
 *     doc the judge rejected is judged again on a later Stop, and a killed
 *     run records nothing so the next Stop retries (crash-safe).
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

      // The session's upvote ledger holds every doc the hook path (or an earlier
      // judge pass) upvoted for it: those are not judged again (#884).
      const recalledSet = new Set(voteData.recalledDocIds);
      const { getVotesDir, usesBranchWorktree } = await import('./types.js');
      const votesDir = getVotesDir(localConfig);
      const votePath = path.join(votesDir, `${localConfig.username}.yaml`);
      // The dispatcher starts this detached pass before the foreground
      // votes-sync credits the turn, so run the same reducer pass first: a doc
      // opened in this turn is then in the ledger and never sent to the judge.
      // Safe to run twice: the ledger and consumed marks dedupe it.
      const { creditAdoptedDocs, recalledKeyOf } = await import('./recall-adoption.js');
      const dispatchSessionId = deriveDispatchSessionId(stdin, _tool);
      await creditAdoptedDocs(localConfig, dispatchSessionId);
      const { creditedDocIdsForSession } = await import('./votes.js');
      const ledgerCredited = await creditedDocIdsForSession(votePath, sessionId);
      // The parser names a doc by its `File:` basename (`setup`, a skill's
      // `SKILL`); the ledger and the votes use the key its run recorded
      // (`learnings/setup`, `retry`). A path no run printed keeps the parser's id.
      const printedKey = await recalledKeyOf(localConfig, dispatchSessionId);
      const keyOf = (id: string): string => {
        const printed = voteData.recalledDocPaths[id];
        return (printed !== undefined ? printedKey(printed) : undefined) ?? id;
      };

      // Same scope guard as the foreground handler: while a project is active,
      // a doc recalled from the inherited USER scope is read-only, so the judge
      // must not upvote it into the project team either (issue #723 review).
      const scopeEligible = new Set(
        eligibleUpvotes(voteData.recalledDocIds, voteData.recalledDocScopes, localConfig.scope),
      );
      // Dedup is ledger-only: a doc already in the shared per-session upvote
      // ledger is never sent to the judge again. A recalled doc that was NOT
      // adopted is re-judged on a later Stop (the judge is opt-in, so this cost
      // is acceptable). There is no per-session marker to clean up, so a killed
      // detached run leaves no stuck state; later turns can still judge NEW docs,
      // and a positive verdict only lands once incrementUpvoted succeeds
      // atomically (sessionId-scoped) — preventing any double credit.
      const toJudge = voteData.recalledDocIds.filter(
        (id) => scopeEligible.has(id) && !ledgerCredited.has(keyOf(id)),
      );
      if (toJudge.length === 0) return null;

      // The judge reads recalled doc excerpts; restrict those reads to trusted
      // knowledge roots so an unauthenticated transcript cannot make it read an
      // arbitrary local file (issue #723 review): the same roots recall reads
      // from, which a resolution failure narrows to the clone and the user
      // mirror, never to a disabled judge (the excerpt read is fail-closed).
      const { knowledgeRoots } = await import('./utils/learnings-roots.js');
      const roots = await knowledgeRoots(localConfig);

      const { judgeAdoption } = await import('./votes-judge.js');
      const adopted = await judgeAdoption(voteData.finalAssistantText, toJudge, voteData.recalledDocPaths, roots);

      // Gate again to recalled (defensive; judgeAdoption already restricts to toJudge).
      const verified = adopted.filter((id) => recalledSet.has(id));
      if (verified.length === 0) return null;

      const { incrementUpvoted, syncVotesToTeam, hasPendingVoteDeltas } = await import('./votes.js');
      // Pass sessionId so judge credits enter the SAME per-session ledger the
      // foreground handler uses, preventing a later foreground open from
      // double-counting the same doc (issue #723 review).
      const credited = await incrementUpvoted(votePath, [...new Set(verified.map(keyOf))], sessionId);
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

/**
 * SessionStart: tell the agent which env variables and secrets the scope
 * delivers, and to run the commands that need them through `teamai env exec`
 * (#875). That is the one path that gives a command this directory's env in
 * every tool and shell (#1018). Nothing when the scope delivers neither, or
 * when its files don't parse (doctor and pull say so).
 */
const teamEnvHintHandler: HookHandler = {
  name: 'team-env-hint',
  async execute(_stdin, _tool, config) {
    if (!config) return null;
    const { resolveTeamEnv, effectiveTeamEnvVariables } = await import('./env-resolution.js');
    const teamEnv = await resolveTeamEnv(config);
    const { declarations } = teamEnv;
    const variables = effectiveTeamEnvVariables(teamEnv);
    const secrets = declarations.kind === 'resolved' ? declarations.entries.filter(({ name }) => !isReservedTeamEnvKey(name)) : [];
    const secretNames = new Set(secrets.map(({ name }) => name));
    const plain = variables.filter(({ name }) => !secretNames.has(name) && !isReservedTeamEnvKey(name));
    if (secrets.length === 0 && plain.length === 0) return null;
    const described = (entries: readonly Pick<ResolvedEntry<{ description?: string }>, 'name' | 'entry'>[]): string => entries.map(({ name, entry }) => {
      const description = entry.description?.replace(/\s+/g, ' ').trim();
      return description ? `${name} (${description})` : name;
    }).join(', ');
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: [
          ...plain.length > 0 ? [`Team env variables in this scope: ${described(plain)}.`] : [],
          ...secrets.length > 0 ? [`Team secrets in this scope: ${described(secrets)}.`] : [],
          'Run the commands that need them through `teamai env exec -- <command>` so they get this directory\'s team values.',
          ...secrets.length > 0
            ? ['Never ask for, read or print a secret value; if one is missing, ask the member to run `teamai env set KEY` in their own terminal.']
            : [],
        ].join(' '),
      },
    });
  },
};

/**
 * SessionStart: a project's rules for a tool with no rules format and no
 * project file of its own (the Codex family, #938; ZCode and DeepSeek
 * Harness, #946), and for the Codex family its instruction blocks (culture,
 * shared instructions, recall, #945). The project AGENTS.md is the owners'
 * file, and other tools read it too. User-scope content is in the tool's own
 * AGENTS.md, so a session outside a project gets nothing here. Codex runs
 * SessionStart again after a compaction or a clear; a resumed session already
 * holds the content in its history. A Codex subagent fires SubagentStart
 * instead, which gets the same content.
 */
const teamRulesHandler: HookHandler = {
  name: 'team-rules',
  async execute(stdin, tool, config) {
    if (!config || config.scope !== 'project' || stdin.source === 'resume') return null;
    const { getsRulesFromSessionHook } = await import('./resources/rule-format.js');
    const { isAgentExcluded } = await import('./types.js');
    if (!getsRulesFromSessionHook(tool) || isAgentExcluded(config, tool)) return null;
    const { loadTeamConfig } = await import('./config.js');
    const teamConfig = await loadTeamConfig(config.repo.localPath);
    if (!teamConfig) return null;
    const { deliversInstructionsByHook, instructionHookTextFor } = await import('./instruction-targets.js');
    const { teamRulesContext } = await import('./resources/rules.js');
    const text = deliversInstructionsByHook(tool, config.scope) ? await instructionHookTextFor(teamConfig, config, tool) : '';
    const parts = text ? [text] : [];
    const rules = await teamRulesContext(teamConfig, config);
    if (rules !== null) parts.push(rules);
    if (parts.length === 0) return null;
    // Codex rejects output whose hookEventName is not the event it ran.
    const hookEventName = stdin.hook_event_name === 'SubagentStart' ? 'SubagentStart' : 'SessionStart';
    return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: parts.join('\n\n') } });
  },
};

/**
 * `instructions`: the culture, claudemd and recall blocks for a tool whose
 * extension adds them to the prompt instead of reading a file (#945), and for
 * Pi the project's team rules after them (#946). Resolved for the member,
 * project and scope of the session's cwd, as a pull would. Nothing when the
 * tool reads a file in that scope, or is excluded.
 */
const instructionsHandler: HookHandler = {
  name: 'instructions',
  async execute(_stdin, tool, config) {
    if (!config) return null;
    const { deliversInstructionsByHook, instructionHookTextFor } = await import('./instruction-targets.js');
    const { isAgentExcluded } = await import('./types.js');
    if (!deliversInstructionsByHook(tool, config.scope) || isAgentExcluded(config, tool)) return null;
    const { loadTeamConfig } = await import('./config.js');
    const teamConfig = await loadTeamConfig(config.repo.localPath);
    if (!teamConfig) return null;
    const text = await instructionHookTextFor(teamConfig, config, tool);
    const parts = text ? [text] : [];
    const { getsRulesFromExtension } = await import('./resources/rule-format.js');
    if (config.scope === 'project' && getsRulesFromExtension(tool)) {
      const { teamRulesContext } = await import('./resources/rules.js');
      const rules = await teamRulesContext(teamConfig, config);
      if (rules !== null) parts.push(rules);
    }
    if (parts.length === 0) return null;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } });
  },
};

/**
 * The HTTP local agent's prompts from its resource cache for the session's
 * project (#945), for a tool with no project file the agent could write to.
 * Pi, OMP and Hermes ask through `instructions`; the Codex family gets them
 * at SessionStart and SubagentStart, beside the team rules. Runs without a
 * teamai config, since an HTTP-only machine has none.
 */
const localAgentInstructionsHandler: HookHandler = {
  name: 'http-prompt-instructions',
  async execute(stdin, tool, config) {
    const { isAgentExcluded } = await import('./types.js');
    if (config && isAgentExcluded(config, tool)) return null;
    const { deliversInstructionsByHook } = await import('./instruction-targets.js');
    const { getsRulesFromSessionHook } = await import('./resources/rule-format.js');
    if (!deliversInstructionsByHook(tool, 'project')) return null;
    const sessionEvent = stdin.hook_event_name === 'SessionStart' || stdin.hook_event_name === 'SubagentStart';
    // Each tool through its own channel only; a resumed Codex session holds them already.
    if (getsRulesFromSessionHook(tool) !== sessionEvent || stdin.source === 'resume') return null;
    const { localAgentInstructionText } = await import('./local-agent.js');
    const text = await localAgentInstructionText(resolveHookCwd(stdin) ?? process.cwd(), tool);
    if (!text) return null;
    const hookEventName = stdin.hook_event_name === 'SubagentStart' ? 'SubagentStart' : 'SessionStart';
    return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
  },
};

/** HTTP local-agent report/sync + workspace binding prompts. */
const localAgentHandler: HookHandler = {
  name: 'local-agent-sync',
  async execute(stdin, tool, config) {
    const { isAgentExcluded } = await import('./types.js');
    if (config && isAgentExcluded(config, tool)) return null;
    const { reportAndSyncFromHook } = await import('./local-agent.js');
    const output = await reportAndSyncFromHook(stdin, tool);
    // Codex's first prompt must read the cache after this sync, rather than
    // racing it in another handler. SubagentStart reads the parent's cache.
    if (stdin.hook_event_name === 'SessionStart') {
      return await localAgentInstructionsHandler.execute(stdin, tool, config) ?? output;
    }
    return output;
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
    { event: 'session-start', matcher: '*', handler: teamRulesHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'session-start', matcher: '*', handler: mrHintHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, gitOnly: true, requiresConfig: true },
    { event: 'session-start', matcher: '*', handler: packageHintHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'session-start', matcher: '*', handler: teamEnvHintHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'session-start', matcher: '*', handler: localAgentHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },
    // Asked for by the Pi and OMP extensions and the Hermes plugin, which add the result to the prompt.
    { event: 'instructions', matcher: '*', handler: instructionsHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'instructions', matcher: '*', handler: localAgentInstructionsHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },
    { event: 'session-start', matcher: '*', handler: webhookHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, background: true, requiresConfig: true },

    // Copilot emits SessionEnd after its final turn (not Stop), so the webhook
    // handler must run here too or those sessions emit no session-stop
    // notification (#702). Detached, mirroring the stop registration.
    { event: 'session-end', matcher: '*', handler: dashboardReportHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, background: true, requiresConfig: true },
    { event: 'session-end', matcher: '*', handler: webhookHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, background: true, requiresConfig: true },
    // Copilot's last turn can end with SessionEnd and no Stop, so the recall
    // reducer runs here too and pushes the votes (#884). A Stop before it
    // already credited the same reads, and the ledger counts a doc once.
    { event: 'session-end', matcher: '*', handler: votesSyncHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, gitOnly: true, requiresConfig: true },

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

    // ─── SubagentStart ────────────────────────────────
    // Codex only (SUBAGENT_START_SPEC): a fresh subagent fires no SessionStart (#938).
    { event: 'subagent-start', matcher: '*', handler: teamRulesHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'subagent-start', matcher: '*', handler: localAgentInstructionsHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },

    // ─── SubagentStop ─────────────────────────────────
    // A subagent can finish after the session's last Stop (a background
    // worker): votes-sync credits what it read then, locally; the next Stop or
    // pull pushes it (#884). Only the agents in
    // SUBAGENT_STOP_TOOLS (builtin-hooks.ts) register it.
    { event: 'subagent-stop', matcher: '*', handler: votesSyncHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, gitOnly: true, requiresConfig: true },

    // ─── PostToolUse ──────────────────────────────────
    { event: 'post-tool-use', matcher: '*', handler: dashboardReportHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'post-tool-use', matcher: 'Skill', handler: trackHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'post-tool-use', matcher: '*', handler: recallAttributionHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'post-tool-use', matcher: 'TodoWrite', handler: todowriteHintHandler, timeoutMs: TODOWRITE_HINT_TIMEOUT_MS, requiresConfig: true },
    { event: 'post-tool-use', matcher: '*', handler: localAgentHandler, timeoutMs: LOCAL_AGENT_TIMEOUT_MS, background: true },
    { event: 'post-tool-use', matcher: 'Skill', handler: webhookHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, background: true, requiresConfig: true },

    // ─── UserPromptSubmit ─────────────────────────────
    { event: 'prompt-submit', matcher: '*', handler: pendingHintHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, gitOnly: true, requiresConfig: true },
    { event: 'prompt-submit', matcher: '*', handler: packagePendingHintHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },
    { event: 'prompt-submit', matcher: '*', handler: trackSlashHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'prompt-submit', matcher: '*', handler: dashboardReportHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, requiresConfig: true },
    { event: 'prompt-submit', matcher: '*', handler: localAgentHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },

    // ─── Git (`--tool git`, see git-hook.ts) ──────────
    // Inline: the delivery has to land before `git worktree add` returns. Git
    // has no hook timeout, so the budget is the detached pull's; git-pull hooks
    // cap their own fetch.
    { event: 'post-checkout', matcher: '*', handler: newWorktreeHandler, timeoutMs: PULL_TIMEOUT_MS, requiresConfig: true },
    { event: 'post-checkout', matcher: '*', handler: gitPullHandler, timeoutMs: PULL_TIMEOUT_MS, requiresConfig: true },
    { event: 'post-merge', matcher: '*', handler: gitPullHandler, timeoutMs: PULL_TIMEOUT_MS, requiresConfig: true },
    { event: 'post-rewrite', matcher: '*', handler: gitPullHandler, timeoutMs: PULL_TIMEOUT_MS, requiresConfig: true },
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
