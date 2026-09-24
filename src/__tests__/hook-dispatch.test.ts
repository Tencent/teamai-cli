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
    it('hands every handler the scope it was created with', async () => {
      const localConfig = { repo: { localPath: '/team', remote: '' }, username: 'u', scope: 'user' as const, additionalRoles: [] };
      const a = createHandler('a');
      const b = createHandler('b');
      const dispatcher = createDispatcher({
        localConfig,
        handlers: [
          { event: 'stop', matcher: '*', handler: a },
          { event: 'stop', matcher: '*', handler: b, background: true },
        ],
      });

      await dispatcher.dispatch('stop', '*', {}, 'claude');

      expect(a.execute).toHaveBeenCalledWith({}, 'claude', localConfig);
      expect(b.execute).toHaveBeenCalledWith({}, 'claude', localConfig);
    });

    it('dispatches to all handlers registered for the given event+matcher', async () => {
      const pullHandler = createHandler('pull');
      const dashboardHandler = createHandler('dashboard-report');

      const dispatcher = createDispatcher({
        localConfig: null,
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
        localConfig: null,
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
        localConfig: null,
        handlers: [
          { event: 'post-tool-use', matcher: '*', handler: createHandler('dashboard') },
          { event: 'post-tool-use', matcher: 'Skill', handler: skillHandler },
        ],
      });

      await dispatcher.dispatch('post-tool-use', 'Bash', {}, 'claude');

      expect(skillHandler.execute).not.toHaveBeenCalled();
    });

    it('wildcard matcher handlers do not fire during a specific matcher dispatch', async () => {
      const wildcardHandler = createHandler('dashboard');
      const bashHandler = createHandler('auto-recall');

      const dispatcher = createDispatcher({
        localConfig: null,
        handlers: [
          { event: 'post-tool-use', matcher: '*', handler: wildcardHandler },
          { event: 'post-tool-use', matcher: 'Bash', handler: bashHandler },
        ],
      });

      await dispatcher.dispatch('post-tool-use', 'Bash', {}, 'claude');

      expect(wildcardHandler.execute).not.toHaveBeenCalled();
      expect(bashHandler.execute).toHaveBeenCalledOnce();
    });
  });

  describe('isolation', () => {
    it('a failing handler does not prevent other handlers from executing', async () => {
      const failingHandler = createHandler('failing');
      failingHandler.execute.mockRejectedValue(new Error('boom'));
      const successHandler = createHandler('success');

      const dispatcher = createDispatcher({
        localConfig: null,
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
        localConfig: null,
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
        localConfig: null,
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
        localConfig: null,
        handlers: [
          { event: 'session-start', matcher: '*', handler: createHandler('pull') },
          { event: 'session-start', matcher: '*', handler: createHandler('dashboard') },
        ],
      });

      const result = await dispatcher.dispatch('session-start', '*', {}, 'claude');

      expect(result.output).toBeNull();
    });

    it('merges additionalContext from concurrent handlers', async () => {
      const first = createHandler('votes', JSON.stringify({
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'VOTES' },
      }));
      const second = createHandler('contribute', JSON.stringify({
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'CONTRIBUTE' },
      }));
      const dispatcher = createDispatcher({ localConfig: null, handlers: [
        { event: 'stop', matcher: '*', handler: first },
        { event: 'stop', matcher: '*', handler: second },
      ] });

      const result = await dispatcher.dispatch('stop', '*', {}, 'claude');
      const parsed = JSON.parse(result.output!);
      expect(parsed.hookSpecificOutput.additionalContext).toBe('VOTES\nCONTRIBUTE');
    });

    it('merges Cursor followup messages from concurrent handlers', async () => {
      const first = createHandler('votes', JSON.stringify({ followup_message: 'VOTES' }));
      const second = createHandler('contribute', JSON.stringify({ followup_message: 'CONTRIBUTE' }));
      const dispatcher = createDispatcher({ localConfig: null, handlers: [
        { event: 'stop', matcher: '*', handler: first },
        { event: 'stop', matcher: '*', handler: second },
      ] });

      const result = await dispatcher.dispatch('stop', '*', {}, 'cursor');
      expect(JSON.parse(result.output!).followup_message).toBe('VOTES\nCONTRIBUTE');
    });

    it('merges additional context from independent handlers', async () => {
      const mrHint = createHandler('mr-hint', JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'MR context',
        },
      }));
      const packageHint = createHandler('package-hint', JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'Package context',
        },
      }));
      const dispatcher = createDispatcher({
        localConfig: null,
        handlers: [
          { event: 'session-start', matcher: '*', handler: mrHint },
          { event: 'session-start', matcher: '*', handler: packageHint },
        ],
      });

      const result = await dispatcher.dispatch('session-start', '*', {}, 'claude');
      const output = JSON.parse(result.output!);
      expect(output.hookSpecificOutput.additionalContext).toBe('MR context\nPackage context');
    });
  });

  describe('stdin sharing', () => {
    it('passes the same stdin object to all handlers', async () => {
      const handler1 = createHandler('h1');
      const handler2 = createHandler('h2');

      const dispatcher = createDispatcher({
        localConfig: null,
        handlers: [
          { event: 'stop', matcher: '*', handler: handler1 },
          { event: 'stop', matcher: '*', handler: handler2 },
        ],
      });

      const stdin = { session_id: 'abc', cwd: '/project' };
      await dispatcher.dispatch('stop', '*', stdin, 'claude');

      expect(handler1.execute).toHaveBeenCalledWith(stdin, 'claude', null);
      expect(handler2.execute).toHaveBeenCalledWith(stdin, 'claude', null);
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
        localConfig: null,
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

  describe('foreground / background split', () => {
    it('foreground mode runs only non-background handlers', async () => {
      const fg = createHandler('contribute-check', 'hint');
      const bg = createHandler('update');

      const dispatcher = createDispatcher({
        localConfig: null,
        handlers: [
          { event: 'stop', matcher: '*', handler: fg },
          { event: 'stop', matcher: '*', handler: bg, background: true },
        ],
      });

      const result = await dispatcher.dispatch('stop', '*', {}, 'claude', 'foreground');

      expect(fg.execute).toHaveBeenCalledOnce();
      expect(bg.execute).not.toHaveBeenCalled();
      expect(result.output).toBe('hint');
    });

    it('background mode runs only background handlers', async () => {
      const fg = createHandler('contribute-check', 'hint');
      const bg = createHandler('update');

      const dispatcher = createDispatcher({
        localConfig: null,
        handlers: [
          { event: 'stop', matcher: '*', handler: fg },
          { event: 'stop', matcher: '*', handler: bg, background: true },
        ],
      });

      const result = await dispatcher.dispatch('stop', '*', {}, 'claude', 'background');

      expect(bg.execute).toHaveBeenCalledOnce();
      expect(fg.execute).not.toHaveBeenCalled();
      // Background handlers are fire-and-forget — no output wired to the host.
      expect(result.output).toBeNull();
    });

    it('default mode ("all") runs both, preserving backward compatibility', async () => {
      const fg = createHandler('contribute-check');
      const bg = createHandler('update');

      const dispatcher = createDispatcher({
        localConfig: null,
        handlers: [
          { event: 'stop', matcher: '*', handler: fg },
          { event: 'stop', matcher: '*', handler: bg, background: true },
        ],
      });

      await dispatcher.dispatch('stop', '*', {}, 'claude');

      expect(fg.execute).toHaveBeenCalledOnce();
      expect(bg.execute).toHaveBeenCalledOnce();
    });

    it('hasBackground reflects whether the event+matcher has a background handler', () => {
      const dispatcher = createDispatcher({
        localConfig: null,
        handlers: [
          { event: 'stop', matcher: '*', handler: createHandler('contribute-check') },
          { event: 'stop', matcher: '*', handler: createHandler('update'), background: true },
          { event: 'post-tool-use', matcher: 'Skill', handler: createHandler('track') },
        ],
      });

      expect(dispatcher.hasBackground('stop', '*')).toBe(true);
      expect(dispatcher.hasBackground('post-tool-use', 'Skill')).toBe(false);
      expect(dispatcher.hasBackground('session-start', '*')).toBe(false);
    });
  });
});
