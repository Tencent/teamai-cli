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
import { normalizeToolName } from './utils/tool-names.js';

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
  async execute(_stdin, _tool) {
    const { pull } = await import('./pull.js');
    await pull({ silent: true });
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

const dashboardReportHandler: HookHandler = {
  name: 'dashboard-report',
  async execute(stdin, tool) {
    const { parseHookEvent, appendEvent, compactEvents } = await import('./dashboard-collector.js');
    const raw = JSON.stringify(stdin);
    const event = await parseHookEvent(raw, tool);
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
    const { extractSkillName, isValidSkillName, appendUsageEvent, updateKnownSkills } = await import('./usage-tracker.js');

    const rawToolName = stdin.tool_name;
    if (typeof rawToolName !== 'string') return null;
    const toolName = normalizeToolName(rawToolName);

    const toolInput = stdin.tool_input;
    if (!toolInput || typeof toolInput !== 'object') return null;

    // Only track Skill (Claude/CodeBuddy) or Read+SKILL.md (Cursor)
    let skillName: string | null = null;
    let toolSource = tool;

    if (toolName === 'Skill') {
      skillName = extractSkillName(toolInput as Record<string, unknown>);
    } else if (toolName === 'Read') {
      const input = toolInput as Record<string, unknown>;
      const filePath =
        (typeof input.file_path === 'string' ? input.file_path : null) ??
        (typeof input.filePath === 'string' ? input.filePath : null) ??
        (typeof input.path === 'string' ? input.path : null);
      if (typeof filePath === 'string' && /\/SKILL\.md$/i.test(filePath)) {
        skillName = extractSkillName({ skill: filePath });
        toolSource = 'cursor';
      }
    } else {
      return null;
    }

    if (!skillName || !isValidSkillName(skillName)) return null;

    await appendUsageEvent({ skill: skillName, timestamp: new Date().toISOString(), tool: toolSource });
    await updateKnownSkills(skillName);
    return null;
  },
};

const trackSlashHandler: HookHandler = {
  name: 'track-slash',
  async execute(stdin, tool) {
    const { extractSkillName, isValidSkillName, appendUsageEvent, updateKnownSkills } = await import('./usage-tracker.js');

    const prompt = stdin.prompt;
    if (typeof prompt !== 'string' || !prompt.startsWith('/')) return null;

    // Extract skill name: first word after "/"
    const match = prompt.match(/^\/([\w-]+)/);
    if (!match) return null;

    const skillName = match[1];
    if (!isValidSkillName(skillName)) return null;

    await appendUsageEvent({ skill: skillName, timestamp: new Date().toISOString(), tool });
    await updateKnownSkills(skillName);
    return null;
  },
};

const contributeCheckHandler: HookHandler = {
  name: 'contribute-check',
  async execute(stdin, tool) {
    const { contributeCheckForSession } = await import('./contribute-check.js');
    const { formatStopHookOutput } = await import('./utils/hook-output.js');

    // Match dashboard-collector's derivation so events and contribute state
    // share the same session id even when stdin.session_id is absent.
    const sessionId = deriveSessionId(stdin, { includeCwd: true });
    const cwd = typeof stdin.cwd === 'string' ? stdin.cwd : undefined;
    const { hint } = await contributeCheckForSession(sessionId, cwd);
    if (hint) {
      return formatStopHookOutput(hint, tool);
    }
    return null;
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
      const { requireInit } = await import('./config.js');

      const voteData = await parseTranscriptForVotes(transcriptPath);
      const { localConfig } = await requireInit();
      const { VOTES_LOCAL_DIR, TEAMAI_SESSIONS_DIR } = await import('./types.js');
      const votesDir = VOTES_LOCAL_DIR;
      const votePath = path.join(votesDir, `${localConfig.username}.yaml`);

      // Record the adoptions the main conversation declared.
      if (voteData.referencedDocIds.length > 0) {
        await incrementUpvoted(votePath, voteData.referencedDocIds);
      }
      await syncVotesToTeam(localConfig.repo.localPath, localConfig.username, votesDir).catch(() => {
        // Push failed — will retry next session
      });

      // Enforcement: recall happened but nothing was declared → nudge the model
      // once to declare which recalled docs it actually used. The nudge makes the
      // model continue; on the next Stop the declaration is recorded above.
      const sessionId = deriveSessionId(stdin, { includeCwd: true });
      const recalled = voteData.recalledDocIds;
      const declared = voteData.referencedDocIds;
      let nudged = false;

      if (recalled.length > 0 && declared.length === 0) {
        const fsp = await import('node:fs/promises');
        const safeId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const marker = path.join(TEAMAI_SESSIONS_DIR, `${safeId}-adoption-nudged`);
        let already = false;
        try { await fsp.access(marker); already = true; } catch { already = false; }
        if (!already) {
          try {
            const { ensureDir } = await import('./utils/fs.js');
            await ensureDir(TEAMAI_SESSIONS_DIR);
            await fsp.writeFile(marker, '');
            // Only nudge once we've persisted the marker, so a write failure
            // degrades to "no nudge this Stop" rather than re-nudging every Stop.
            nudged = true;
          } catch {
            // Could not persist the marker — skip the nudge this Stop; retry next.
          }
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
        const msg =
          `你本次通过 teamai 召回了团队知识（候选 doc-id：${recalled.join(', ')}）。` +
          `结束前请在回复末尾声明你实际用到的条目：<!-- teamai:referenced-doc-ids: [用到的doc-id] -->；没用到就留空 []。`;
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

/** HTTP local-agent report/sync + workspace binding prompts. */
const localAgentHandler: HookHandler = {
  name: 'local-agent-sync',
  async execute(stdin, tool) {
    const { reportAndSyncFromHook } = await import('./local-agent.js');
    return reportAndSyncFromHook(stdin, tool);
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
    // on a slow network cannot delay session startup. Reuses LOCAL_AGENT_TIMEOUT_MS
    // (15s) — ample for a background git pull that is not awaited by the host.
    { event: 'session-start', matcher: '*', handler: pullHandler, timeoutMs: LOCAL_AGENT_TIMEOUT_MS, background: true },
    { event: 'session-start', matcher: '*', handler: dashboardReportHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },
    { event: 'session-start', matcher: '*', handler: mrHintHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, gitOnly: true },
    { event: 'session-start', matcher: '*', handler: localAgentHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },

    // ─── Stop ─────────────────────────────────────────
    // votes-sync and contribute-check may return a hint the host injects back
    // into the session, so they run inline (capped at FOREGROUND_HOOK_TIMEOUT_MS).
    // The rest are pure side effects — the update check in particular shells out
    // to the npm registry — so they run detached to avoid pushing the Stop hook
    // past the host's hook timeout (CodeBuddy kills hooks at ~10s regardless of
    // the declared timeout).
    { event: 'stop', matcher: '*', handler: updateHandler, timeoutMs: UPDATE_TIMEOUT_MS, background: true },
    { event: 'stop', matcher: '*', handler: votesSyncHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, gitOnly: true },
    { event: 'stop', matcher: '*', handler: contributeCheckHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, gitOnly: true },
    { event: 'stop', matcher: '*', handler: dashboardReportHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS, background: true },
    { event: 'stop', matcher: '*', handler: localAgentHandler, timeoutMs: LOCAL_AGENT_TIMEOUT_MS, background: true },

    // ─── PostToolUse ──────────────────────────────────
    { event: 'post-tool-use', matcher: '*', handler: dashboardReportHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },
    { event: 'post-tool-use', matcher: 'Skill', handler: trackHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },
    { event: 'post-tool-use', matcher: 'TodoWrite', handler: todowriteHintHandler, timeoutMs: TODOWRITE_HINT_TIMEOUT_MS },
    { event: 'post-tool-use', matcher: '*', handler: localAgentHandler, timeoutMs: LOCAL_AGENT_TIMEOUT_MS, background: true },

    // ─── UserPromptSubmit ─────────────────────────────
    { event: 'prompt-submit', matcher: '*', handler: trackSlashHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },
    { event: 'prompt-submit', matcher: '*', handler: dashboardReportHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },
    { event: 'prompt-submit', matcher: '*', handler: localAgentHandler, timeoutMs: FOREGROUND_HOOK_TIMEOUT_MS },
  ];
}

/**
 * Apply the provider-config gate to a handler registry.
 *
 * HTTP-only teams (localConfig.repo.kind === 'http') must not receive prompts
 * for git-provider-only features. This drops every `gitOnly` handler when the
 * team source is HTTP. When localConfig is null (teamai not initialized) or the
 * source is git (kind === 'git' or undefined for backward compatibility), the
 * full registry is returned unchanged.
 *
 * The gate is keyed on teamai's own configured source, NOT on the current
 * working directory's git remote — an HTTP-only user working inside a
 * github/tgit checkout must still see no git-only prompts.
 *
 * Fail-open by design: a null localConfig means either teamai is not
 * initialized or the config failed to parse (loadLocalConfig swallows parse
 * errors and returns null). In both cases the full registry is kept, so a
 * corrupted config degrades to "all hooks run" rather than silently disabling
 * them. This is intentionally NOT a hard security gate — HTTP write ops are
 * still enforced at execution time by assertNotReadOnly().
 */
export function filterHandlersForConfig(
  registry: HandlerRegistration[],
  localConfig: LocalConfig | null,
): HandlerRegistration[] {
  if (localConfig?.repo.kind === 'http') {
    return registry.filter((reg) => reg.gitOnly !== true);
  }
  return registry;
}
