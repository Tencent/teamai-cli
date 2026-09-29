import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AGENT_SESSION_ENV, agentSessionIdFromEnv, deriveSessionId } from '../utils/session-id.js';

describe('deriveSessionId', () => {
    const originalEnv = process.env.CLAUDE_SESSION_ID;

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.CLAUDE_SESSION_ID;
        } else {
            process.env.CLAUDE_SESSION_ID = originalEnv;
        }
        vi.unstubAllEnvs();
    });

    it('prefers explicit session_id from payload', () => {
        expect(deriveSessionId({ session_id: 'explicit-session' })).toBe('explicit-session');
    });

    it('uses Copilot camelCase sessionId when the snake_case field is absent', () => {
        expect(deriveSessionId({ sessionId: 'copilot-session' })).toBe('copilot-session');
    });

    it('prefers canonical snake_case when both session ID forms are present', () => {
        expect(deriveSessionId({
            session_id: 'canonical-session',
            sessionId: 'copilot-session',
        })).toBe('canonical-session');
    });

    it('falls back to CLAUDE_SESSION_ID env var', () => {
        delete process.env.CLAUDE_SESSION_ID;
        process.env.CLAUDE_SESSION_ID = 'env-session';
        expect(deriveSessionId({})).toBe('env-session');
    });

    it('falls back to pid when nothing else is available', () => {
        delete process.env.CLAUDE_SESSION_ID;
        expect(deriveSessionId({})).toMatch(/^pid-/);
    });

    it('keeps a hook without a session_id on its pid fallback when it inherits another agent\'s variable', () => {
        // An OpenCode, Pi or OMP bridge started from a Claude Code shell sends no
        // session_id; its events must not be filed under the outer Claude session.
        delete process.env.CLAUDE_SESSION_ID;
        vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'outer-claude-session');
        const result = deriveSessionId({ cwd: '/tmp/project' }, { includeCwd: true });
        expect(result).toMatch(/^pid-\d+-\/tmp\/project$/);
    });

    it('ignores non-string session_id values', () => {
        delete process.env.CLAUDE_SESSION_ID;
        process.env.CLAUDE_SESSION_ID = 'env-session';
        expect(deriveSessionId({ session_id: 123 })).toBe('env-session');
    });

    it('includes cwd in pid fallback when includeCwd is true', () => {
        delete process.env.CLAUDE_SESSION_ID;
        const result = deriveSessionId({ cwd: '/tmp/project' }, { includeCwd: true });
        expect(result).toMatch(/^pid-\d+-\/tmp\/project$/);
    });

    it('uses process.cwd() when cwd is missing and includeCwd is true', () => {
        delete process.env.CLAUDE_SESSION_ID;
        const result = deriveSessionId({}, { includeCwd: true });
        expect(result).toContain(process.cwd());
    });

    it('uses workspace_roots in pid fallback when cwd is absent', () => {
        delete process.env.CLAUDE_SESSION_ID;
        const result = deriveSessionId(
            { workspace_roots: ['/Users/jeffxu/Project/teamai-cli'] },
            { includeCwd: true },
        );
        expect(result).toMatch(/^pid-\d+-\/Users\/jeffxu\/Project\/teamai-cli$/);
    });
});

// The test setup clears every AGENT_SESSION_ENV variable, so each case starts
// without the agent shell's own session.
describe('agentSessionIdFromEnv', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('reads the agent variables in this order', () => {
        expect(AGENT_SESSION_ENV).toEqual([
            'CLAUDE_CODE_SESSION_ID',
            'CODEX_SESSION_ID',
            'CODEBUDDY_SESSION_ID',
            'COPILOT_AGENT_SESSION_ID',
            'CURSOR_CONVERSATION_ID',
            'CLAUDE_SESSION_ID',
        ]);
    });

    // Pi's hook bridge sends no session id, so its hooks record under the
    // pid fallback; PI_SESSION_ID would name a session with no events.
    it('ignores PI_SESSION_ID, which Pi hooks never receive', async () => {
        vi.stubEnv('PI_SESSION_ID', 'pi-session');
        expect(await agentSessionIdFromEnv()).toBeUndefined();
    });

    it.each(AGENT_SESSION_ENV)('returns %s', async (name) => {
        vi.stubEnv(name, 'env-session');
        expect(await agentSessionIdFromEnv()).toBe('env-session');
    });

    it('prefers CODEBUDDY_SESSION_ID over the CLAUDE_SESSION_ID alias CodeBuddy also sets', async () => {
        vi.stubEnv('CLAUDE_SESSION_ID', 'alias-session');
        vi.stubEnv('CODEBUDDY_SESSION_ID', 'codebuddy-session');
        expect(await agentSessionIdFromEnv()).toBe('codebuddy-session');
    });

    it('skips an empty variable', async () => {
        vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
        vi.stubEnv('CODEX_SESSION_ID', 'codex-session');
        expect(await agentSessionIdFromEnv()).toBe('codex-session');
    });

    it('returns undefined when no agent variable is set', async () => {
        expect(await agentSessionIdFromEnv()).toBeUndefined();
    });

    // Pi and OpenCode export none of AGENT_SESSION_ENV, and their hooks record
    // under the pid fallback. Started from Claude Code's shell, they inherit
    // its variable, which would file their work under the Claude session.
    it.each([
        ['PI_SESSION_ID', 'pi-session'],
        ['OPENCODE', '1'],
    ])('returns undefined under a bridge agent marker (%s), even with an inherited variable', async (marker, value) => {
        vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'outer-claude');
        vi.stubEnv(marker, value);
        expect(await agentSessionIdFromEnv()).toBeUndefined();
    });

    describe('in a nested agent session', () => {
        let home: string;

        function writeEvents(events: { sessionId: string; timestamp: string; type?: string }[]): void {
            const dir = path.join(home, '.teamai', 'dashboard');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'events.jsonl'),
                events.map((e) => JSON.stringify({ type: 'prompt_submit', tool: 'test', ...e })).join('\n') + '\n',
            );
        }

        afterEach(() => {
            if (home) fs.rmSync(home, { recursive: true, force: true });
        });

        // Codex started from Claude Code's shell inherits CLAUDE_CODE_SESSION_ID
        // and sets its own CODEX_SESSION_ID; Codex's hooks record under the latter.
        it('picks the inner agent: the session with the latest hook event', async () => {
            home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-id-'));
            vi.stubEnv('HOME', home);
            vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'outer-claude');
            vi.stubEnv('CODEX_SESSION_ID', 'inner-codex');
            writeEvents([
                { sessionId: 'outer-claude', timestamp: '2026-09-28T10:00:00.000Z' },
                { sessionId: 'inner-codex', timestamp: '2026-09-28T10:05:00.000Z' },
                { sessionId: 'unrelated', timestamp: '2026-09-28T10:09:00.000Z' },
            ]);
            expect(await agentSessionIdFromEnv()).toBe('inner-codex');
        });

        // A background `codex exec` or a parallel subagent keeps the outer
        // session firing hooks after the inner one starts.
        it('picks the inner agent even when the outer session has the latest event', async () => {
            home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-id-'));
            vi.stubEnv('HOME', home);
            vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'outer-claude');
            vi.stubEnv('CODEX_SESSION_ID', 'inner-codex');
            writeEvents([
                { sessionId: 'outer-claude', timestamp: '2026-09-28T10:00:00.000Z' },
                { sessionId: 'inner-codex', timestamp: '2026-09-28T10:05:00.000Z' },
                { sessionId: 'outer-claude', timestamp: '2026-09-28T10:07:00.000Z' },
            ]);
            expect(await agentSessionIdFromEnv()).toBe('inner-codex');
        });

        // `claude --resume` from a new Codex session: Claude's session began
        // yesterday, but its SessionStart hook fires again on resume.
        it('picks the resumed inner agent by its latest session start, not its first event', async () => {
            home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-id-'));
            vi.stubEnv('HOME', home);
            vi.stubEnv('CODEX_SESSION_ID', 'outer-codex');
            vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'inner-claude');
            writeEvents([
                { sessionId: 'inner-claude', timestamp: '2026-09-27T09:00:00.000Z', type: 'session_start' },
                { sessionId: 'inner-claude', timestamp: '2026-09-27T09:01:00.000Z' },
                { sessionId: 'outer-codex', timestamp: '2026-09-28T10:00:00.000Z', type: 'session_start' },
                { sessionId: 'outer-codex', timestamp: '2026-09-28T10:01:00.000Z' },
                { sessionId: 'inner-claude', timestamp: '2026-09-28T10:05:00.000Z', type: 'session_start' },
                { sessionId: 'outer-codex', timestamp: '2026-09-28T10:07:00.000Z' },
            ]);
            expect(await agentSessionIdFromEnv()).toBe('inner-claude');
        });

        it('falls back to the variable order when no set session has events', async () => {
            home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-id-'));
            vi.stubEnv('HOME', home);
            vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'outer-claude');
            vi.stubEnv('CODEX_SESSION_ID', 'inner-codex');
            writeEvents([{ sessionId: 'unrelated', timestamp: '2026-09-28T10:09:00.000Z' }]);
            expect(await agentSessionIdFromEnv()).toBe('outer-claude');
        });
    });
});
