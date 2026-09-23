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
 * Team course-correction keywords for the current project. The dispatcher has
 * already chdir'd to the hook payload's cwd (hook-dispatch-cli), so
 * autoDetectInit() resolves the right project, as it does for
 * contributeHintAllowed. Only prompt hooks pay for the config read; an
 * unreadable config means "built-in keywords only".
 */
async function teamCorrectionKeywords(stdin: Record<string, unknown>): Promise<readonly string[]> {
  if (typeof stdin.prompt !== 'string') return [];
  try {
    const { autoDetectInit } = await import('./config.js');
    const { getInterventionSharing } = await import('./types.js');
    const { teamConfig } = await autoDetectInit();
    return getInterventionSharing(teamConfig).correctionKeywords;
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
  async execute(stdin, tool) {
    const { parseHookEvent, appendEvent, compactEvents } = await import('./dashboard-collector.js');
    const raw = JSON.stringify(stdin);
    const event = await parseHookEvent(raw, tool, {
      correctionKeywords: await teamCorrectionKeywords(stdin),
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
 * Whether the share-learnings hint may be emitted at all. Resolved lazily per
 * hook run so a team can switch it off via teamai.yaml (or a member via local
 * config) without re-injecting hooks. Withheld when there is no config at all:
 * the hook fires in every project on the machine, and a directory without teamai
 * has no team to share with (#748). A config that exists but cannot be loaded
 * withholds it too: `share` refuses there, so the nudge would lead nowhere.
 *
 * Recall and a writable source gate it too: the hint routes to the `share`
 * workflow, and `teamai skill get share` refuses while recall is off or the
 * team source is read-only HTTP, so a nudge towards it would send the agent to
 * a command that says no. The dispatcher already drops this `gitOnly` handler
 * for HTTP teams; the check here keeps the gate the same wherever it is called.
 */
async function contributeHintAllowed(): Promise<boolean> {
  const { isContributeHintEnabled, isRecallEnabled } = await import('./types.js');
  const { autoDetectInit } = await import('./config.js');
  try {
    const { localConfig, teamConfig } = await autoDetectInit();
    return localConfig.repo?.kind !== 'http'
      && isContributeHintEnabled(localConfig, teamConfig)
      && isRecallEnabled(localConfig, teamConfig);
  } catch {
    return false;
  }
}

/**
 * Ask the model to declare which recalled documents it actually used.
 *
 * English, like every other user-facing string: Claude Code prints the Stop
 * payload, so this reaches the terminal of anyone whose team has recall on. It
 * restates the requirement `compileRecallRulesBlock` already ships (#719).
 */
export function buildVotesNudge(recalledDocIds: readonly string[]): string {
  return (
    `This session recalled team knowledge through teamai (candidate doc-ids: ${recalledDocIds.join(', ')}). `
    + 'Before you finish, declare the entries you actually used by appending '
    + '`<!-- teamai:referenced-doc-ids: [the-doc-ids-you-used] -->` to your final reply. '
    + 'Declare an empty list `[]` if you used none.'
  );
}

const contributeCheckHandler: HookHandler = {
  name: 'contribute-check',
  async execute(stdin, tool) {
    if (!(await contributeHintAllowed())) return null;

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
    const hint = (await contributeHintAllowed()) ? stashed : null;
    const votesHint = await pending.takePendingVotesHint(sessionId);

    // The votes nudge instructs the model; the contribute hint asks it to relay
    // a message to the user and so must run to the end of the payload. Reversing
    // the order would leave "print the following verbatim" with no clear end (#719).
    const combined = [votesHint, hint].filter(Boolean).join('\n');
    if (!combined) return null;

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: combined,
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
  async execute(stdin, tool) {
    if (process.env.TEAMAI_RECALL_DISABLED === '1') return null;

    const transcriptPath = typeof stdin.transcript_path === 'string' ? stdin.transcript_path : null;
    if (!transcriptPath) return null;

    try {
      const { parseTranscriptForVotes } = await import('./transcript-parser.js');
      const { incrementUpvoted, syncVotesToTeam } = await import('./votes.js');
      const { autoDetectInit } = await import('./config.js');

      const voteData = await parseTranscriptForVotes(transcriptPath);
      // autoDetectInit picks project scope when present (so self-mode configs are
      // honored), falling back to user scope otherwise.
      const { localConfig } = await autoDetectInit();
      const { getUserVotesDir } = await import('./types.js');
      const votesDir = getUserVotesDir();
      const votePath = path.join(votesDir, `${localConfig.username}.yaml`);

      // Only count upvotes for docs actually recalled this session, to avoid crediting hallucinated/distractor doc-ids
      const recalledSet = new Set(voteData.recalledDocIds);
      const verifiedDocIds = voteData.referencedDocIds.filter((id) => recalledSet.has(id));
      if (verifiedDocIds.length > 0) {
        await incrementUpvoted(votePath, verifiedDocIds);
      }
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

      // Enforcement: recall happened but nothing was declared → nudge the model
      // to declare which recalled docs it actually used. The nudge makes the
      // model continue; on the next Stop the declaration is recorded above.
      // An explicit empty declaration (`[]`) counts as declared, otherwise a
      // model that correctly reports "nothing used" would be nudged forever.
      // Most tools can retry until the model declares on the next turn. Cursor
      // is capped below because followup_message itself forces another turn and
      // would otherwise create an unbounded Stop loop.
      const sessionId = deriveSessionId(stdin, { includeCwd: true });
      const recalled = voteData.recalledDocIds;
      const declared = voteData.referencedDocIds;
      let nudged = false;

      if (recalled.length > 0 && !voteData.hasReferencedDocIdsDeclaration) {
        nudged = true;
        // Cursor's followup_message forces another model turn. Cap it to one
        // per session so a model that never emits the declaration cannot enter
        // an unbounded Stop → follow-up loop.
        if ((tool ?? '').toLowerCase() === 'cursor') {
          const { claimVotesNudge } = await import('./contribute-check.js');
          nudged = await claimVotesNudge(sessionId);
        }
      }

      // A/B measurement (opt-in): one line per Stop.
      if (process.env.TEAMAI_ADOPTION_EVAL_LOG) {
        try {
          const { appendFile } = await import('node:fs/promises');
          await appendFile(
            process.env.TEAMAI_ADOPTION_EVAL_LOG,
            JSON.stringify({
              ts: new Date().toISOString(),
              sessionId,
              recalled: recalled.length,
              declared: declared.length,
              nudged,
            }) + '\n',
          );
        } catch {
          // best-effort; measurement only
        }
      }

      if (nudged) {
        const { formatStopHookOutput } = await import('./utils/hook-output.js');
        const { stopStdoutUnsupported } = await import('./utils/tool-names.js');
        const msg = buildVotesNudge(recalled);
        // For tools whose Stop stdout is ignored, stash the nudge for delivery
        // on the next UserPromptSubmit (same cross-process mechanism as contribute).
        if (stopStdoutUnsupported(tool)) {
          const { stashVotesHint } = await import('./contribute-check.js');
          await stashVotesHint(sessionId, msg);
          return null;
        }
        return formatStopHookOutput(msg, tool ?? 'claude');
      }
    } catch {
      // Non-critical — votes will sync on next pull
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
  async execute(stdin, tool) {
    const { sendWebhook, loadWebhookConfig } = await import('./webhook.js');

    try {
      const config = await loadWebhookConfig();
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
