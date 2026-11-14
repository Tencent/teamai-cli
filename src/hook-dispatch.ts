/**
 * Hook Dispatcher — unified entry point for teamai hooks.
 *
 * Instead of spawning N separate processes per event, Claude Code invokes
 * a single `teamai hook-dispatch <event> [--matcher <m>]` command.
 * The dispatcher reads STDIN once and fans out to all registered handlers.
 *
 * Design:
 *   - Handlers are pure functions: (stdin, tool, config) → output | null, where
 *     config is the scope the dispatcher resolved for the hook's cwd
 *   - Promise.allSettled ensures one handler crash doesn't take down others
 *   - Compatible structured outputs are merged so concurrent hints are preserved
 */

import { z } from 'zod';
import { JsonObjectSchema } from './types.js';
import type { LocalConfig } from './types.js';
import { baseToolOf } from './tool-registry.js';
import { log } from './utils/logger.js';

// ─── Public types ───────────────────────────────────────

/**
 * A hook's STDIN payload: the JSON object the host wrote. A number too large for a double, which JSON.parse reads as
 * Infinity, reads as null, as JSON writes it, so the rest of the payload is kept.
 */
export const HookStdinSchema = z.preprocess((payload) => JSON.parse(JSON.stringify(payload) ?? 'null'), JsonObjectSchema);

export type HookStdin = z.infer<typeof HookStdinSchema>;

/** The string `stdin` carries in `field`, or undefined when that field is absent or not a string. */
export function stdinString(stdin: HookStdin, field: string): string | undefined {
  const value = z.string().safeParse(stdin[field]);

  return value.success ? value.data : undefined;
}

export interface HookHandler {
  name: string;
  /**
   * `config` is the scope the dispatcher resolved for the hook's cwd, or null
   * when none applies (teamai not set up there, or its config unreadable).
   * Handlers read their scope from it, never from the process cwd: the
   * dispatcher's chdir into the hook's cwd can fail (#752).
   * A skipped action contributes no host output and keeps its own diagnostic outcome.
   */
  execute(stdin: HookStdin, tool: string, config: LocalConfig | null): Promise<string | null | { outcome: 'skipped' }>;
}

const SkippedHookSchema = z.object({ outcome: z.literal('skipped') });

export interface HandlerRegistration {
  event: string;
  matcher: string;
  handler: HookHandler;
  /** Per-handler timeout in ms. If exceeded, handler is treated as failed. */
  timeoutMs?: number;
  /**
   * Fire-and-forget handlers that never contribute STDOUT (pure side effects
   * like version-check, votes-sync, dashboard-report). The CLI runs these in a
   * detached background process so a slow network/registry call cannot delay
   * the host's hook completion. Foreground handlers (those that may return
   * output the host injects back into the session) always run inline.
   */
  background?: boolean;
  /**
   * Its context is left out when the merged reply is over the host's limit
   * and the other handlers' replies fit without it.
   */
  yieldsToContextLimit?: true;
}

/** The most characters Cursor takes as a hook's `additional_context`; over it, Cursor drops the whole reply. */
export const CURSOR_HOOK_CONTEXT_LIMIT = 10_000;

/** Characters of context in a merged reply, as Cursor counts them (trimmed). */
function contextLength(output: string | null): number {
  if (output === null) return 0;

  try {
    const reply = HookContextReplySchema.safeParse(JSON.parse(output));

    return reply.success ? reply.data.hookSpecificOutput.additionalContext.trim().length : 0;
  } catch {
    return 0;
  }
}

/** Which subset of matched handlers to run in a single dispatch pass. */
export type DispatchMode = 'all' | 'foreground' | 'background';

export interface DispatchError {
  handlerName: string;
  error: Error;
}

export interface DispatchResult {
  /** Combined STDOUT output from all compatible output-producing handlers. */
  output: string | null;
  /** Errors from failed handlers (non-fatal — other handlers still ran). */
  errors: DispatchError[];
}

export interface DispatcherConfig {
  handlers: HandlerRegistration[];
  /** The scope every handler runs in; see HookHandler.execute. */
  localConfig: LocalConfig | null;
}

export interface Dispatcher {
  dispatch(
    event: string,
    matcher: string,
    stdin: HookStdin,
    tool: string,
    mode?: DispatchMode,
  ): Promise<DispatchResult>;
  /** True when the event+matcher has at least one background-marked handler. */
  hasBackground(event: string, matcher: string): boolean;
}

// ─── Implementation ─────────────────────────────────────

/** Default timeout: 60 seconds (matches Claude Code's default hook timeout). */
const DEFAULT_TIMEOUT_MS = 60_000;

/** A reply whose context a host injects. */
const HookContextReplySchema = z.object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) });

/** A hook reply in either structured schema: a JSON object. */
const HookReplySchema = JsonObjectSchema;

const StringsSchema = z.array(z.string());

/** Merge the two hook output schemas used by the supported hosts. */
export function mergeHookOutputs(outputs: string[]): string | null {
  if (outputs.length === 0) return null;

  if (outputs.length === 1) return outputs[0];

  let parsed: Array<z.infer<typeof HookReplySchema>>;

  try {
    parsed = outputs.map((output) => {
      const value = HookReplySchema.safeParse(JSON.parse(output));

      if (!value.success) throw new Error('Hook output is not an object');

      return value.data;
    });
  } catch {
    // Preserve the historical first-output behavior for unknown/plain schemas.
    return outputs[0];
  }

  const followups = StringsSchema.safeParse(parsed.map((value) => value.followup_message));

  if (followups.success) {
    return JSON.stringify({ ...parsed[0], followup_message: followups.data.join('\n') });
  }

  const specificOutputs = z.array(HookReplySchema).safeParse(parsed.map((value) => value.hookSpecificOutput));

  if (specificOutputs.success) {
    const contexts = StringsSchema.safeParse(specificOutputs.data.map((value) => value.additionalContext));
    const eventNames = new Set(specificOutputs.data.map((value) => value.hookEventName).filter(Boolean));

    if (contexts.success && eventNames.size <= 1) {
      return JSON.stringify({
        ...parsed[0],
        hookSpecificOutput: {
          ...specificOutputs.data[0],
          additionalContext: contexts.data.join('\n'),
        },
      });
    }
  }

  return outputs[0];
}

/**
 * Wrap a promise with a timeout. Rejects with a timeout error if not resolved in time.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, handlerName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Handler "${handlerName}" exceeded timeout of ${ms}ms`));
    }, ms);

    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Create a dispatcher with the given handler registrations.
 *
 * Routing rules:
 *   - A handler matches if its event and matcher both match the dispatched hook.
 *   - The injected wildcard hook dispatches matcher='*' separately, so wildcard
 *     handlers must not also run during a specific matcher dispatch.
 */
export function createDispatcher(config: DispatcherConfig): Dispatcher {
  const matchedFor = (event: string, matcher: string) =>
    config.handlers.filter((reg) => reg.event === event && reg.matcher === matcher);

  return {
    hasBackground(event, matcher): boolean {
      return matchedFor(event, matcher).some((reg) => reg.background === true);
    },

    async dispatch(event, matcher, stdin, tool, mode = 'all'): Promise<DispatchResult> {
      // Find all handlers that should fire for this event+matcher, then narrow
      // to the requested mode so the inline pass and the detached background
      // pass each run their own subset.
      const matched = matchedFor(event, matcher).filter((reg) => {
        if (mode === 'foreground') return reg.background !== true;

        if (mode === 'background') return reg.background === true;

        return true;
      });

      // Execute all matched handlers concurrently with isolation + per-handler timeout
      const timings: Array<{ handler: string; ms: number; outcome: string }> = [];
      const startedAt = Date.now();

      const settled = await Promise.allSettled(
        matched.map((reg) => {
          const timeoutMs = reg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
          const handlerStartedAt = Date.now();

          const record = (outcome: string) => {
            timings.push({ handler: reg.handler.name, ms: Date.now() - handlerStartedAt, outcome });
          };

          return withTimeout(reg.handler.execute(stdin, tool, config.localConfig), timeoutMs, reg.handler.name).then(
            (value) => {
              const skipped = SkippedHookSchema.safeParse(value).success;
              record(skipped ? 'skipped' : 'ok');

              return skipped ? null : z.string().nullable().parse(value);
            },
            (cause: unknown) => {
              // The message duplicates what hook-dispatch-cli already logs for a
              // failed handler; 'timeout' names the case that log cannot explain.
              record(cause instanceof Error && /exceeded timeout/.test(cause.message) ? 'timeout' : 'failed');
              throw cause;
            },
          );
        }),
      );

      // Per-handler wall-clock, slowest first. Diagnostic only: every handler keeps
      // the caller's own timeout budget, so this reports what already happened
      // rather than changing it. Concurrent handlers make `total` the floor any
      // single handler imposes, not the sum — the gap between `total` and the
      // slowest handler is time spent in module loading before the handler ran.
      if (matched.length > 0) {
        const slowest = timings.reduce((a, b) => (b.ms > a.ms ? b : a), timings[0]);

        const detail = [...timings]
          .sort((a, b) => b.ms - a.ms)
          .map((t) => `${t.handler}=${t.ms}ms(${t.outcome})`)
          .join(' ');

        log.debug(`[hook-dispatch] ${event}/${tool} ${mode}: ${Date.now() - startedAt}ms total, ${matched.length} handlers, slowest ${slowest.handler}=${slowest.ms}ms | ${detail}`);
      }

      // Collect results
      const outputs: Array<{ reg: HandlerRegistration; value: string }> = [];
      const errors: DispatchError[] = [];

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        const handlerName = matched[i].handler.name;

        if (result.status === 'rejected') {
          errors.push({
            handlerName,
            error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
          });
        } else if (result.status === 'fulfilled' && result.value != null) {
          outputs.push({ reg: matched[i], value: result.value });
        }
      }

      let output = mergeHookOutputs(outputs.map(({ value }) => value));
      const length = contextLength(output);

      if (baseToolOf(tool) === 'cursor' && length > CURSOR_HOOK_CONTEXT_LIMIT && outputs.some(({ reg }) => reg.yieldsToContextLimit)) {
        const rest = mergeHookOutputs(outputs.flatMap(({ reg, value }) => (reg.yieldsToContextLimit ? [] : [value])));
        const yielded = outputs.flatMap(({ reg }) => (reg.yieldsToContextLimit ? [reg.handler.name] : [])).join(', ');

        if (contextLength(rest) <= CURSOR_HOOK_CONTEXT_LIMIT) {
          log.debug(`[hook-dispatch] ${event}/${tool}: reply context is ${length} characters, over the ${CURSOR_HOOK_CONTEXT_LIMIT}-character limit; left out ${yielded}`);
          output = rest;
        } else {
          log.debug(`[hook-dispatch] ${event}/${tool}: reply context is ${length} characters, over the ${CURSOR_HOOK_CONTEXT_LIMIT}-character limit even without ${yielded}; Cursor drops it`);
        }
      }

      return { output, errors };
    },
  };
}
