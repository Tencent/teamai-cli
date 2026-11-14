/**
 * session-search.test.ts — what `teamai session search` finds and how it ranks it.
 */
import { describe, it, expect } from 'vitest';
import { SessionSearchEngine, type LoadedSession } from '../session-flow/search.js';
import type { Message } from '@teamai/tool-core/sessions/ir';

function loaded(sessionName: string, title: string, messages: Message[]): LoadedSession {
  return {
    sessionName,
    author: 'alice',
    session: {
      sessionId: sessionName,
      title,
      cwd: '/proj',
      platform: 'claude-code',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      messages,
    },
  };
}

const say = (role: Message['role'], text: string): Message => ({ role, content: [{ type: 'text', text }] });

describe('session search', () => {
  it('finds text that appears only in a tool result, and cites that message', async () => {
    const sessions = [
      loaded('deploy-run', 'Deploy the service', [
        say('user', 'Deploy it'),
        {
          role: 'assistant',
          content: [{ type: 'tool_call', toolName: 'Bash', callId: 'c1', arguments: { command: 'npm run deploy' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', callId: 'c1', content: 'Error: read ECONNRESET at TCP.onStreamRead', isError: true }],
          timestamp: '2026-01-01T00:00:03.000Z',
        },
        say('assistant', 'The deploy failed; retrying.'),
      ]),
      loaded('docs-edit', 'Edit the docs', [say('user', 'Fix the typo in the README')]),
    ];

    const hits = await new SessionSearchEngine().search(sessions, 'ECONNRESET', { enableDecay: false });

    expect(hits.map((h) => h.sessionName)).toEqual(['deploy-run']);
    expect(hits[0].matchedMessages).toHaveLength(1);
    expect(hits[0].matchedMessages[0].role).toBe('user');
    expect(hits[0].matchedMessages[0].timestamp).toBe('2026-01-01T00:00:03.000Z');
    expect(hits[0].matchedMessages[0].snippet).toContain('ECONNRESET');
  });

  it('ranks a session whose title matches above one that matches only inside a long tool dump', async () => {
    const read = (callId: string, content: string): Message[] => [
      { role: 'assistant', content: [{ type: 'tool_call', toolName: 'Read', callId, arguments: { file_path: `/proj/${callId}.ts` } }] },
      { role: 'user', content: [{ type: 'tool_result', callId, content, isError: false }] },
    ];
    const source = 'export const retries = config.retries ?? 3;\n'.repeat(400);
    const testLog = Array.from({ length: 300 }, (_, i) => `retry ${i}: read ECONNRESET from mock upstream`).join('\n');

    const sessions = [
      loaded('fix-reset', 'Fix ECONNRESET on deploy', [
        say('user', 'The deploy fails with ECONNRESET, fix it'),
        ...read('client', source),
        ...read('server', source),
        ...read('pool', source),
        say('assistant', 'The pool closed sockets early; fixed.'),
      ]),
      loaded('config-refactor', 'Refactor the config loader', [
        say('user', 'Split the config loader into modules'),
        { role: 'assistant', content: [{ type: 'tool_call', toolName: 'Bash', callId: 't1', arguments: { command: 'npm test' } }] },
        { role: 'user', content: [{ type: 'tool_result', callId: 't1', content: testLog, isError: false }] },
        say('assistant', 'Tests pass; the retries are expected noise.'),
      ]),
      loaded('docs-edit', 'Edit the docs', [say('user', 'Fix the typo in the README')]),
      loaded('lint-fix', 'Fix lint warnings', [say('user', 'Clean up the lint warnings in src')]),
    ];

    const hits = await new SessionSearchEngine().search(sessions, 'ECONNRESET', { enableDecay: false });

    expect(hits.map((h) => h.sessionName)).toEqual(['fix-reset', 'config-refactor']);
  });

  it('finds an error at the end of a long build log, and cites that message', async () => {
    const log = [...Array.from({ length: 200 }, (_, i) => `compiling module ${i}`), 'error TS2304: Cannot find name ZZTOP'].join('\n');
    const sessions = [
      loaded('build-run', 'Run the build', [
        say('user', 'Build it'),
        { role: 'user', content: [{ type: 'tool_result', callId: 'b1', content: log, isError: true }] },
      ]),
      loaded('docs-edit', 'Edit the docs', [say('user', 'Fix the typo in the README')]),
    ];

    const hits = await new SessionSearchEngine().search(sessions, 'ZZTOP', { enableDecay: false });

    expect(hits.map((h) => h.sessionName)).toEqual(['build-run']);
    expect(hits[0].matchedMessages[0].snippet).toContain('Cannot find name ZZTOP');
  });

  it('shows a match inside multi-line tool output as a one-line snippet', async () => {
    const log = ['> npm test', '', 'FAIL api.test.ts', '  Error: read ECONNRESET', '    at TCP.onStreamRead'].join('\n');
    const sessions = [
      loaded('api-tests', 'Run the API tests', [
        { role: 'user', content: [{ type: 'tool_result', callId: 't1', content: log, isError: true }] },
      ]),
    ];

    const [hit] = await new SessionSearchEngine().search(sessions, 'ECONNRESET', { enableDecay: false });

    expect(hit.snippet).toContain('FAIL api.test.ts Error: read ECONNRESET at TCP.onStreamRead');
    expect(hit.matchedMessages[0].snippet).not.toMatch(/\n/);
  });

  it('ranks a session that mentions the query in conversation above one that matches only inside a long tool dump', async () => {
    const source = 'export const pool = createPool({ max: 10, idleTimeoutMillis: 30000 });\n'.repeat(200);
    const testLog = Array.from({ length: 300 }, (_, i) => `retry ${i}: read ECONNRESET from mock upstream`).join('\n');

    const sessions = [
      loaded('pool-debug', 'Debug the connection pool', [
        say('user', 'Sockets drop under load and the client logs ECONNRESET. Why?'),
        { role: 'assistant', content: [{ type: 'tool_call', toolName: 'Read', callId: 'r1', arguments: { file_path: '/proj/pool.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', callId: 'r1', content: source, isError: false }] },
        say(
          'assistant',
          'The pool closes idle sockets after thirty seconds while the upstream keeps them for sixty, so the client ' +
            'writes to a socket the pool already closed. Raising the idle timeout above the upstream keep-alive fixes it.',
        ),
      ]),
      loaded('config-refactor', 'Refactor the config loader', [
        say('user', 'Split the config loader into modules'),
        { role: 'assistant', content: [{ type: 'tool_call', toolName: 'Bash', callId: 't1', arguments: { command: 'npm test' } }] },
        { role: 'user', content: [{ type: 'tool_result', callId: 't1', content: testLog, isError: false }] },
        say('assistant', 'Tests pass; the retries are expected noise.'),
      ]),
      loaded('docs-edit', 'Edit the docs', [say('user', 'Fix the typo in the README')]),
      loaded('lint-fix', 'Fix lint warnings', [say('user', 'Clean up the lint warnings in src')]),
    ];

    const hits = await new SessionSearchEngine().search(sessions, 'ECONNRESET', { enableDecay: false });

    expect(hits.map((h) => h.sessionName)).toEqual(['pool-debug', 'config-refactor']);
  });
});
