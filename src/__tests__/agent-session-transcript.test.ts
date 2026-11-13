/**
 * agent-session-transcript.test.ts — the transcript a search or a scorer reads.
 *
 * One entry per message, in order, so a match or a judgement can cite the message it came from.
 */
import { describe, it, expect } from 'vitest';
import { AgentSession } from '../session-flow/agent-session.js';
import type { Message, Session } from '@teamai/tool-core/sessions/ir';

function sessionOf(messages: Message[]): Session {
  return {
    sessionId: 's-1',
    title: 'deploy',
    cwd: '/proj',
    platform: 'claude-code',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages,
  };
}

describe('AgentSession.transcript', () => {
  it('renders one entry per message, with tool calls as JSON and tool results as their own part', () => {
    const session = sessionOf([
      { role: 'user', content: [{ type: 'text', text: 'Run the deploy' }], timestamp: '2026-01-01T00:00:01.000Z' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running it.' },
          {
            type: 'tool_call',
            toolName: 'Bash',
            callId: 'c1',
            arguments: { command: 'npm run deploy', env: { REGION: 'eu' } },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', callId: 'c1', content: 'Error: connect ECONNRESET', isError: true }],
      },
    ]);

    const entries = AgentSession.transcript(session);

    expect(entries.map((e) => e.role)).toEqual(['user', 'assistant', 'user']);
    expect(entries[0]).toEqual({ role: 'user', timestamp: '2026-01-01T00:00:01.000Z', text: 'Run the deploy', toolOutput: '' });
    expect(entries[1].text).toContain('Running it.');
    expect(entries[1].text).toContain('[tool_call] Bash {"command":"npm run deploy","env":{"REGION":"eu"}}');
    expect(entries[1].text).not.toContain('[object Object]');
    // A tool result arrives as a user message; it stays apart from what the member typed.
    expect(entries[2]).toEqual({ role: 'user', text: '', toolOutput: '[tool_result error] Error: connect ECONNRESET' });
  });

  it('truncates a long tool result and says so', () => {
    const dump = 'line of a large file\n'.repeat(5_000);
    const [entry] = AgentSession.transcript(
      sessionOf([{ role: 'user', content: [{ type: 'tool_result', callId: 'c1', content: dump, isError: false }] }]),
    );

    expect(entry.toolOutput.startsWith('[tool_result] line of a large file')).toBe(true);
    expect(entry.toolOutput.length).toBeLessThan(5_000);
    expect(entry.toolOutput).toMatch(/\[truncated \d+ chars\]$/);
  });
});
