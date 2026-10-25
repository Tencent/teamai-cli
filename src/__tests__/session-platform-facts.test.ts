import { describe, expect, it } from 'vitest';
import { ADAPTER_REGISTRY } from '../session-flow/adapters/index.js';
import { SESSION_PLATFORM_FACTS, resumeCommand, sessionPlatformFacts } from '../session-flow/adapters/platform-facts.js';
import { AgentSession, noAdapter } from '../session-flow/agent-session.js';
import { fidelityFromSession } from '../session-flow/migrate.js';
import type { Session } from '../session-flow/ir.js';

describe('session platform facts (#1140)', () => {
  it('every registered adapter supplies the facts used by its readers and copies', () => {
    expect(Object.keys(SESSION_PLATFORM_FACTS).sort()).toEqual(Object.keys(ADAPTER_REGISTRY).sort());
    for (const [platform, facts] of Object.entries(SESSION_PLATFORM_FACTS)) {
      expect(AgentSession.platformForTool(facts.tool)).toBe(platform);
      expect(AgentSession.platformForTool(platform)).toBe(platform);
      expect(Boolean(noAdapter(platform, 'write', 'win32'))).toBe(facts.sqliteRegistrationOnWindows);
    }
    expect(AgentSession.platformForTool('unsupported')).toBeUndefined();
  });

  it('prints the resume command each CLI accepts', () => {
    expect(resumeCommand('claude-code', 'id1')).toBe('claude --resume id1');
    expect(resumeCommand('codex', 'id1')).toBe('codex resume id1');
    expect(resumeCommand('opencode', 'ses_1')).toBe('opencode --session ses_1');
    expect(resumeCommand('codebuddy', 'id1')).toBe('codebuddy --resume id1');
  });

  it('rejects inherited object keys as platform names', () => {
    expect(sessionPlatformFacts('claude-code')).toBe(SESSION_PLATFORM_FACTS['claude-code']);
    for (const platform of ['constructor', 'toString', '__proto__']) {
      expect(sessionPlatformFacts(platform)).toBeUndefined();
    }
  });

  it('Cursor still degrades thinking and images while Claude preserves them', () => {
    const session: Session = { sessionId: 'facts', title: 'Facts', platform: 'claude-code', cwd: '/test',
      createdAt: '2026-10-23', updatedAt: '2026-10-23', metadata: {}, messages: [
        { role: 'user', content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] },
        { role: 'assistant', content: [{ type: 'thinking', text: 'Reasoning' }] },
      ] };
    expect(fidelityFromSession(session, 'claude-code').degradedBlocks).toBe(0);
    expect(fidelityFromSession(session, 'cursor').degradedBlocks).toBe(2);
  });
});
