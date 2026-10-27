import { describe, expect, it } from 'vitest';
import { ADAPTER_REGISTRY } from '../session-flow/adapters/index.js';
import { SESSION_PLATFORM_FACTS, resumeCommand, sessionPlatformFacts } from '../session-flow/adapters/platform-facts.js';
import { AgentSession, noAdapter } from '../session-flow/agent-session.js';
import { sessionPlatformsOf, TOOLS } from '../tools.js';
import { fidelityFromSession } from '../session-flow/migrate.js';
import type { Session } from '../session-flow/ir.js';

describe('session platform facts (#1140)', () => {
  it('every registered adapter supplies the facts used by its readers and copies', () => {
    expect(Object.keys(SESSION_PLATFORM_FACTS).sort()).toEqual(Object.keys(ADAPTER_REGISTRY).sort());
    for (const [platform, facts] of Object.entries(SESSION_PLATFORM_FACTS)) {
      expect(AgentSession.platformForTool(AgentSession.toolForPlatform(platform))).toBe(platform);
      expect(AgentSession.platformForTool(platform)).toBe(platform);
      expect(Boolean(noAdapter(platform, 'write', 'win32'))).toBe(facts.sqliteRegistrationOnWindows);
    }
    expect(AgentSession.platformForTool('unsupported')).toBeUndefined();
  });

  it('credits each platform to the one tool whose sessions list it', () => {
    const owners = new Map<string, string[]>();
    for (const tool of Object.keys(TOOLS)) {
      for (const platform of sessionPlatformsOf(tool)) owners.set(platform, [...owners.get(platform) ?? [], tool]);
    }
    expect([...owners].filter(([, tools]) => tools.length > 1)).toEqual([]);
    for (const [platform, [tool]] of owners) expect(AgentSession.toolForPlatform(platform)).toBe(tool);
    expect(AgentSession.toolForPlatform('claude-code')).toBe('claude');
    expect(AgentSession.platformForTool('claude')).toBe('claude-code');
  });

  it('keeps a tool only on the platforms no tool lists: the CodeBuddy IDE', () => {
    const listed = new Set<string>(Object.keys(TOOLS).flatMap((tool) => sessionPlatformsOf(tool)));
    const unlisted = Object.entries(SESSION_PLATFORM_FACTS).filter(([platform]) => !listed.has(platform));
    expect(unlisted.map(([platform, facts]) => [platform, 'tool' in facts ? facts.tool : undefined])).toEqual([['codebuddy-ide', 'codebuddy-ide']]);
    for (const [platform, facts] of Object.entries(SESSION_PLATFORM_FACTS)) {
      if (listed.has(platform)) expect('tool' in facts).toBe(false);
    }
    expect(AgentSession.toolForPlatform('codebuddy-ide')).toBe('codebuddy-ide');
  });

  it('keeps a store in the home of the tool that lists its platform', () => {
    for (const [platform, { store }] of Object.entries(SESSION_PLATFORM_FACTS)) {
      if (store.in === 'tool-home') expect(sessionPlatformsOf(store.home).some((listed) => listed === platform)).toBe(true);
    }
  });

  it('reads no session platform for a tool whose sessions are none or unknown', () => {
    for (const tool of ['copilot', 'muse', 'pi', 'kiro', 'qoder', 'openclaw', 'joycode']) expect(AgentSession.platformForTool(tool)).toBeUndefined();
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
