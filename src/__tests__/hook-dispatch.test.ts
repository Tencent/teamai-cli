import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Test doubles ────────────────────────────────────────

/** Minimal handler interface for testing. */
interface TestHandler {
  name: string;
  execute: ReturnType<typeof vi.fn>;
}

function createHandler(name: string, output?: string): TestHandler {
  return {
    name,
    execute: vi.fn().mockResolvedValue(output ?? null),
  };
}

// ── Import after understanding module shape ─────────────

import {
  createDispatcher,
  type HookHandler,
  type DispatchResult,
} from '../hook-dispatch.js';

// ── Tests ───────────────────────────────────────────────

describe('hook-dispatch', () => {
  describe('routing', () => {
    it('dispatches to all handlers registered for the given event+matcher', async () => {
      const pullHandler = createHandler('pull');
      const dashboardHandler = createHandler('dashboard-report');

      const dispatcher = createDispatcher({
        handlers: [
          { event: 'session-start', matcher: '*', handler: pullHandler },
          { event: 'session-start', matcher: '*', handler: dashboardHandler },
          { event: 'stop', matcher: '*', handler: createHandler('update') },
        ],
      });

      const stdin = { session_id: 'test-123', cwd: '/tmp' };
      await dispatcher.dispatch('session-start', '*', stdin, 'claude');

      expect(pullHandler.execute).toHaveBeenCalledOnce();
      expect(dashboardHandler.execute).toHaveBeenCalledOnce();
    });

    it('does not invoke handlers for a different event', async () => {
      const stopHandler = createHandler('update');

      const dispatcher = createDispatcher({
        handlers: [
          { event: 'session-start', matcher: '*', handler: createHandler('pull') },
          { event: 'stop', matcher: '*', handler: stopHandler },
        ],
      });

      await dispatcher.dispatch('session-start', '*', {}, 'claude');

      expect(stopHandler.execute).not.toHaveBeenCalled();
    });

    it('does not invoke handlers with a different matcher', async () => {
      const skillHandler = createHandler('track');

      const dispatcher = createDispatcher({
        handlers: [
          { event: 'post-tool-use', matcher: '*', handler: createHandler('dashboard') },
          { event: 'post-tool-use', matcher: 'Skill', handler: skillHandler },
        ],
      });

      await dispatcher.dispatch('post-tool-use', 'Bash', {}, 'claude');

      expect(skillHandler.execute).not.toHaveBeenCalled();
    });

    it('wildcard matcher handlers also fire when a specific matcher is dispatched', async () => {
      const wildcardHandler = createHandler('dashboard');
      const bashHandler = createHandler('auto-recall');

      const dispatcher = createDispatcher({
        handlers: [
          { event: 'post-tool-use', matcher: '*', handler: wildcardHandler },
          { event: 'post-tool-use', matcher: 'Bash', handler: bashHandler },
        ],
      });

      await dispatcher.dispatch('post-tool-use', 'Bash', {}, 'claude');

      expect(wildcardHandler.execute).toHaveBeenCalledOnce();
      expect(bashHandler.execute).toHaveBeenCalledOnce();
    });
  });

  describe('isolation', () => {
    it('a failing handler does not prevent other handlers from executing', async () => {
      const failingHandler = createHandler('failing');
      failingHandler.execute.mockRejectedValue(new Error('boom'));
      const successHandler = createHandler('success');

      const dispatcher = createDispatcher({
        handlers: [
          { event: 'session-start', matcher: '*', handler: failingHandler },
          { event: 'session-start', matcher: '*', handler: successHandler },
        ],
      });

      await dispatcher.dispatch('session-start', '*', {}, 'claude');

      expect(successHandler.execute).toHaveBeenCalledOnce();
    });

    it('returns errors from failed handlers in the result', async () => {
      const failingHandler = createHandler('failing');
      failingHandler.execute.mockRejectedValue(new Error('boom'));

      const dispatcher = createDispatcher({
        handlers: [
          { event: 'session-start', matcher: '*', handler: failingHandler },
          { event: 'session-start', matcher: '*', handler: createHandler('ok') },
        ],
      });

      const result = await dispatcher.dispatch('session-start', '*', {}, 'claude');

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].handlerName).toBe('failing');
      expect(result.errors[0].error.message).toBe('boom');
    });
  });

  describe('output merging', () => {
    it('returns output from the handler that produces one', async () => {
      const outputHandler = createHandler('auto-recall', '{"hookSpecificOutput":{"additionalContext":"found stuff"}}');
      const silentHandler = createHandler('dashboard');

      const dispatcher = createDispatcher({
        handlers: [
          { event: 'post-tool-use', matcher: 'Bash', handler: outputHandler },
          { event: 'post-tool-use', matcher: '*', handler: silentHandler },
        ],
      });

      const result = await dispatcher.dispatch('post-tool-use', 'Bash', {}, 'claude');

      expect(result.output).toBe('{"hookSpecificOutput":{"additionalContext":"found stuff"}}');
    });

    it('returns null output when no handler produces output', async () => {
      const dispatcher = createDispatcher({
        handlers: [
          { event: 'session-start', matcher: '*', handler: createHandler('pull') },
          { event: 'session-start', matcher: '*', handler: createHandler('dashboard') },
        ],
      });

      const result = await dispatcher.dispatch('session-start', '*', {}, 'claude');

      expect(result.output).toBeNull();
    });
  });

  describe('stdin sharing', () => {
    it('passes the same stdin object to all handlers', async () => {
      const handler1 = createHandler('h1');
      const handler2 = createHandler('h2');

      const dispatcher = createDispatcher({
        handlers: [
          { event: 'stop', matcher: '*', handler: handler1 },
          { event: 'stop', matcher: '*', handler: handler2 },
        ],
      });

      const stdin = { session_id: 'abc', cwd: '/project' };
      await dispatcher.dispatch('stop', '*', stdin, 'claude');

      expect(handler1.execute).toHaveBeenCalledWith(stdin, 'claude');
      expect(handler2.execute).toHaveBeenCalledWith(stdin, 'claude');
    });
  });

  describe('timeout', () => {
    it('aborts a handler that exceeds its timeout', async () => {
      const slowHandler: TestHandler = {
        name: 'slow',
        execute: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve('late'), 5000)),
        ),
      };
      const fastHandler = createHandler('fast', 'quick');

      const dispatcher = createDispatcher({
        handlers: [
          { event: 'session-start', matcher: '*', handler: slowHandler, timeoutMs: 50 },
          { event: 'session-start', matcher: '*', handler: fastHandler },
        ],
      });

      const result = await dispatcher.dispatch('session-start', '*', {}, 'claude');

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].handlerName).toBe('slow');
      expect(result.errors[0].error.message).toContain('timeout');
      expect(result.output).toBe('quick');
    });
  });
});
