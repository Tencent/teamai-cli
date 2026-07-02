import { describe, it, expect, afterEach } from 'vitest';
import { deriveSessionId } from '../utils/session-id.js';

describe('deriveSessionId', () => {
    const originalEnv = process.env.CLAUDE_SESSION_ID;

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.CLAUDE_SESSION_ID;
        } else {
            process.env.CLAUDE_SESSION_ID = originalEnv;
        }
    });

    it('prefers explicit session_id from payload', () => {
        expect(deriveSessionId({ session_id: 'explicit-session' })).toBe('explicit-session');
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
});
