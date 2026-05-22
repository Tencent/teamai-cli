/**
 * Hook Dispatcher — unified entry point for teamai hooks.
 *
 * Instead of spawning N separate processes per event, Claude Code invokes
 * a single `teamai hook-dispatch <event> [--matcher <m>]` command.
 * The dispatcher reads STDIN once and fans out to all registered handlers.
 *
 * Design:
 *   - Handlers are pure functions: (stdin, tool) → output | null
 *   - Promise.allSettled ensures one handler crash doesn't take down others
 *   - At most one handler per event produces STDOUT output
 */

// ─── Public types ───────────────────────────────────────

export interface HookHandler {
  name: string;
  execute(stdin: Record<string, unknown>, tool: string): Promise<string | null>;
}

export interface HandlerRegistration {
  event: string;
  matcher: string;
  handler: HookHandler;
  /** Per-handler timeout in ms. If exceeded, handler is treated as failed. */
  timeoutMs?: number;
}

export interface DispatchError {
  handlerName: string;
  error: Error;
}

export interface DispatchResult {
  /** Combined STDOUT output (at most one handler produces output per event). */
  output: string | null;
  /** Errors from failed handlers (non-fatal — other handlers still ran). */
  errors: DispatchError[];
}

export interface DispatcherConfig {
  handlers: HandlerRegistration[];
}

export interface Dispatcher {
  dispatch(event: string, matcher: string, stdin: Record<string, unknown>, tool: string): Promise<DispatchResult>;
}

// ─── Implementation ─────────────────────────────────────

/** Default timeout: 60 seconds (matches Claude Code's default hook timeout). */
const DEFAULT_TIMEOUT_MS = 60_000;

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
 *   - A handler matches if its event matches AND (its matcher === dispatched matcher OR its matcher === '*')
 *   - Wildcard ('*') matchers fire for any dispatched matcher on that event
 */
export function createDispatcher(config: DispatcherConfig): Dispatcher {
  return {
    async dispatch(event, matcher, stdin, tool): Promise<DispatchResult> {
      // Find all handlers that should fire for this event+matcher
      const matched = config.handlers.filter((reg) => {
        if (reg.event !== event) return false;
        // Wildcard handlers always fire; specific matchers must match exactly
        return reg.matcher === '*' || reg.matcher === matcher;
      });

      // Execute all matched handlers concurrently with isolation + per-handler timeout
      const settled = await Promise.allSettled(
        matched.map((reg) => {
          const timeoutMs = reg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
          return withTimeout(reg.handler.execute(stdin, tool), timeoutMs, reg.handler.name);
        }),
      );

      // Collect results
      let output: string | null = null;
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
          // First non-null output wins (at most one handler should produce output per event)
          if (output === null) {
            output = result.value;
          }
        }
      }

      return { output, errors };
    },
  };
}
