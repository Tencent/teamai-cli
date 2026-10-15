import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AGENT_SESSION_ENV, agentSessionFromEnv, agentSessionIdFromEnv, deriveSessionId } from '../utils/session-id.js';

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

    it('uses Cursor\'s conversation_id after session_id and sessionId, before the environment', () => {
        vi.stubEnv('CLAUDE_SESSION_ID', 'env-session');
        expect(deriveSessionId({ conversation_id: 'cursor-conversation' })).toBe('cursor-conversation');
        expect(deriveSessionId({ sessionId: 'copilot-session', conversation_id: 'cursor-conversation' })).toBe('copilot-session');
        expect(deriveSessionId({ session_id: 'canonical-session', conversation_id: 'cursor-conversation' })).toBe('canonical-session');
        expect(deriveSessionId({ conversation_id: '' })).toBe('env-session');
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
        // A Pi or OMP bridge started from a Claude Code shell sends no
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
            'OPENCODE_SESSION_ID',
            'TEAMAI_AGENT_SESSION_ID',
            'PI_SESSION_ID',
            'MUSE_SESSION_ID',
        ]);
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

    // Pi's bash tool sets PI_SESSION_ID to the session TeamAI's Pi extension
    // sends on every event (#884).
    it('reads the Pi session from PI_SESSION_ID in a Pi shell', async () => {
        vi.stubEnv('PI_SESSION_ID', 'pi-session');
        expect(await agentSessionFromEnv()).toEqual({ id: 'pi-session', agent: 'pi', unambiguous: true });
    });

    // Muse Code sets MUSE_SESSION_ID in its shell tool's environment, the
    // session_id its hooks carry.
    it('reads the Muse Code session from MUSE_SESSION_ID in a Muse shell', async () => {
        vi.stubEnv('MUSE_SESSION_ID', '01a131d0-7b02-7e90-bd5a-74e6934af652');
        expect(await agentSessionFromEnv()).toEqual({ id: '01a131d0-7b02-7e90-bd5a-74e6934af652', agent: 'muse', unambiguous: true });
    });

    // The OpenCode plugin sets TEAMAI_AGENT_SESSION_ID in its bash tool's
    // environment, and its hooks carry that session (#884).
    it('reads the native V2 OpenCode shell session', async () => {
        vi.stubEnv('OPENCODE_SESSION_ID', 'ses_v2');
        expect(await agentSessionFromEnv()).toEqual({ id: 'ses_v2', agent: 'opencode', unambiguous: true });
    });

    it('reads the OpenCode session from TEAMAI_AGENT_SESSION_ID in an OpenCode shell', async () => {
        vi.stubEnv('OPENCODE', '1');
        vi.stubEnv('TEAMAI_AGENT_SESSION_ID', 'ses_opencode');
        expect(await agentSessionFromEnv()).toEqual({ id: 'ses_opencode', agent: 'opencode', unambiguous: true });
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

        // OPENCODE=1 is no bridge marker: an agent started from an OpenCode
        // shell inherits it with TEAMAI_AGENT_SESSION_ID, next to its own variable.
        it('picks the inner agent started from an OpenCode shell, which OPENCODE does not mask', async () => {
            home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-id-'));
            vi.stubEnv('HOME', home);
            vi.stubEnv('OPENCODE', '1');
            vi.stubEnv('TEAMAI_AGENT_SESSION_ID', 'outer-opencode');
            vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'inner-claude');
            writeEvents([
                { sessionId: 'outer-opencode', timestamp: '2026-09-28T10:00:00.000Z', type: 'session_start' },
                { sessionId: 'inner-claude', timestamp: '2026-09-28T10:05:00.000Z', type: 'session_start' },
            ]);
            expect(await agentSessionFromEnv()).toEqual({ id: 'inner-claude', agent: 'claude', unambiguous: false });
        });

        // Pi started from Claude Code's shell inherits CLAUDE_CODE_SESSION_ID
        // next to its own PI_SESSION_ID; its extension records its session start.
        it('picks Pi started from a Claude Code shell, by its later session start', async () => {
            home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-id-'));
            vi.stubEnv('HOME', home);
            vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'outer-claude');
            vi.stubEnv('PI_SESSION_ID', 'inner-pi');
            writeEvents([
                { sessionId: 'outer-claude', timestamp: '2026-09-28T10:00:00.000Z', type: 'session_start' },
                { sessionId: 'inner-pi', timestamp: '2026-09-28T10:05:00.000Z', type: 'session_start' },
            ]);
            expect(await agentSessionFromEnv()).toEqual({ id: 'inner-pi', agent: 'pi', unambiguous: false });
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

// Recall settles a run by its env session only when no pick was made (#884).
describe('agentSessionFromEnv', () => {
    let home: string | undefined;

    afterEach(() => {
        vi.unstubAllEnvs();
        if (home) fs.rmSync(home, { recursive: true, force: true });
        home = undefined;
    });

    it('names the agent family of a single session variable, unambiguous', async () => {
        vi.stubEnv('CODEX_SESSION_ID', 'codex-session');
        expect(await agentSessionFromEnv()).toEqual({ id: 'codex-session', agent: 'codex', unambiguous: true });
    });

    it('counts CodeBuddy\'s CLAUDE_SESSION_ID alias of the same id as one candidate', async () => {
        vi.stubEnv('CODEBUDDY_SESSION_ID', 'codebuddy-session');
        vi.stubEnv('CLAUDE_SESSION_ID', 'codebuddy-session');
        expect(await agentSessionFromEnv()).toEqual({ id: 'codebuddy-session', agent: 'codebuddy', unambiguous: true });
    });

    it('is ambiguous when a nested agent sees two sessions, and names the family of the one it picked', async () => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-id-'));
        vi.stubEnv('HOME', home);
        vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'outer-claude');
        vi.stubEnv('CODEX_SESSION_ID', 'inner-codex');
        expect(await agentSessionFromEnv()).toEqual({ id: 'outer-claude', agent: 'claude', unambiguous: false });
    });

    it('has no session and is not unambiguous when no variable is set', async () => {
        expect(await agentSessionFromEnv()).toEqual({ unambiguous: false });
    });
});
