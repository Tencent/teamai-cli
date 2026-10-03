/**
 * OpenClaw internal hook events, shaped the way OpenClaw's producers build them
 * (openclaw@2026.9.7 source). Every event comes from `createInternalHookEvent`
 * (src/hooks/internal-hooks.ts): `{ type, action, sessionKey, context,
 * timestamp, messages }`. A handler is called with that event as its only
 * argument; there is no `event` field.
 *
 * Producers:
 * - command:new     src/gateway/session-create-service.ts (emitCommandHooks)
 * - command:reset   src/auto-reply/reply/commands-reset-hooks.ts, src/gateway/session-reset-service.ts
 * - command:stop    src/auto-reply/reply/commands-session-abort.ts (no workspaceDir)
 * - session:auto-reset  src/hooks/session-auto-reset.ts
 * - gateway:startup src/gateway/server-startup-post-attach.ts (sessionKey "gateway:startup")
 * - message:received    src/auto-reply/reply/message-received-hooks.ts (no workspaceDir)
 * - message:sent    src/infra/outbound/message-sent-hook.ts
 *
 * The key list is pinned from docs/automation/hooks/event-types.md (Event types table).
 */

export const OPENCLAW_EVENT_KEYS = [
  'command:new',
  'command:reset',
  'command:stop',
  'session:auto-reset',
  'session:compact:before',
  'session:compact:after',
  'session:patch',
  'agent:bootstrap',
  'gateway:startup',
  'gateway:shutdown',
  'gateway:pre-restart',
  'message:received',
  'message:transcribed',
  'message:preprocessed',
  'message:sent',
] as const;

export interface OpenClawHookEvent {
  type: string;
  action: string;
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[];
}

function event(type: string, action: string, sessionKey: string, context: Record<string, unknown>): OpenClawHookEvent {
  return { type, action, sessionKey, context, timestamp: new Date(0), messages: [] };
}

/** Events for one workspace; `workspaceDir` is where the producer says the agent works. */
export function openclawEvents(workspaceDir: string): Record<string, OpenClawHookEvent> {
  return {
    'command:new': event('command', 'new', 'agent:main:main', {
      agentId: 'main', commandSource: 'webchat', cfg: {}, storePath: '/state/sessions', workspaceDir,
    }),
    'command:reset': event('command', 'reset', 'agent:main:main', {
      agentId: 'main', commandSource: 'gateway:sessions.reset', cfg: {}, storePath: '/state/sessions', workspaceDir,
    }),
    'command:stop': event('command', 'stop', 'agent:main:main', {
      sessionId: 's-1', commandSource: 'chat', senderId: 'u-1',
    }),
    'session:auto-reset': event('session', 'auto-reset', 'agent:main:main', {
      cfg: {}, agentId: 'main', workspaceDir, storePath: '/state/sessions',
      sessionEntry: { sessionId: 's-1' }, reason: 'idle',
    }),
    'gateway:startup': event('gateway', 'startup', 'gateway:startup', {
      cfg: {}, deps: {}, workspaceDir,
    }),
    'message:received': event('message', 'received', 'agent:main:main', {
      from: 'u-1', content: 'hello', channelId: 'chat',
    }),
    'message:sent': event('message', 'sent', 'agent:main:main', {
      to: 'u-1', content: 'hi', channelId: 'chat', success: true,
    }),
  };
}
