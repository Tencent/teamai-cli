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

import type { LocalConfig } from './types.js';

// ─── Public types ───────────────────────────────────────

export interface HookHandler {
  name: string;
  /**
   * `config` is the scope the dispatcher resolved for the hook's cwd, or null
   * when none applies (teamai not set up there, or its config unreadable).
   * Handlers read their scope from it, never from the process cwd: the
   * dispatcher's chdir into the hook's cwd can fail (#752).
   */
  execute(stdin: Record<string, unknown>, tool: string, config: LocalConfig | null): Promise<string | null>;
}

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
    stdin: Record<string, unknown>,
    tool: string,
    mode?: DispatchMode,
  ): Promise<DispatchResult>;
  /** True when the event+matcher has at least one background-marked handler. */
  hasBackground(event: string, matcher: string): boolean;
}

// ─── Implementation ─────────────────────────────────────

/** Default timeout: 60 seconds (matches Claude Code's default hook timeout). */
const DEFAULT_TIMEOUT_MS = 60_000;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

/** Merge the two hook output schemas used by the supported hosts. */
function mergeHookOutputs(outputs: string[]): string | null {
  if (outputs.length === 0) return null;
  if (outputs.length === 1) return outputs[0];

  let parsed: JsonObject[];
  try {
    parsed = outputs.map((output) => {
      const value = asObject(JSON.parse(output));
      if (!value) throw new Error('Hook output is not an object');
      return value;
    });
  } catch {
    // Preserve the historical first-output behavior for unknown/plain schemas.
    return outputs[0];
  }

  const followups = parsed.map((value) => value.followup_message);
  if (followups.every((value): value is string => typeof value === 'string')) {
    return JSON.stringify({ ...parsed[0], followup_message: followups.join('\n') });
  }

  const specificOutputs = parsed.map((value) => asObject(value.hookSpecificOutput));
  if (specificOutputs.every((value): value is JsonObject => value !== null)) {
    const contexts = specificOutputs.map((value) => value.additionalContext);
    const eventNames = new Set(specificOutputs.map((value) => value.hookEventName).filter(Boolean));
    if (
      contexts.every((value): value is string => typeof value === 'string')
      && eventNames.size <= 1
    ) {
      return JSON.stringify({
        ...parsed[0],
        hookSpecificOutput: {
          ...specificOutputs[0],
          additionalContext: contexts.join('\n'),
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
      const settled = await Promise.allSettled(
        matched.map((reg) => {
          const timeoutMs = reg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
          return withTimeout(reg.handler.execute(stdin, tool, config.localConfig), timeoutMs, reg.handler.name);
        }),
      );

      // Collect results
      const outputs: string[] = [];
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
          outputs.push(result.value);
        }
      }

      return { output: mergeHookOutputs(outputs), errors };
    },
  };
}
