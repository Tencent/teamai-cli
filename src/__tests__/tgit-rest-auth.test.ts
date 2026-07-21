import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../../src/providers/tgit/gf-cli.js', () => ({
    gfGetOAuthToken: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
    log: {
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        dim: vi.fn(),
    },
}));

import { getTGitToken, tgitAuthHeaders, tgitFetch, tgitGitUser, tryGetTGitToken } from '../providers/tgit/rest-auth.js';
import { gfGetOAuthToken } from '../providers/tgit/gf-cli.js';

function makeResponse(status: number): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
    } as unknown as Response;
}

describe('rest-auth', () => {
    let mockFetch: Mock;
    const savedToken = process.env['TGIT_TOKEN'];

    beforeEach(() => {
        vi.resetAllMocks();
        mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);
        delete process.env['TGIT_TOKEN'];
    });

    afterEach(() => {
        if (savedToken === undefined) {
            delete process.env['TGIT_TOKEN'];
        } else {
            process.env['TGIT_TOKEN'] = savedToken;
        }
    });

    describe('getTGitToken', () => {
        it('TGIT_TOKEN set → private-token scheme', () => {
            process.env['TGIT_TOKEN'] = 'pat-123';
            expect(getTGitToken()).toEqual({ token: 'pat-123', scheme: 'private-token' });
        });

        it('no TGIT_TOKEN, OAuth token → bearer scheme', () => {
            (gfGetOAuthToken as Mock).mockReturnValue('oauth-x');
            expect(getTGitToken()).toEqual({ token: 'oauth-x', scheme: 'bearer' });
        });

        it('neither credential → throws', () => {
            (gfGetOAuthToken as Mock).mockReturnValue(null);
            expect(() => getTGitToken()).toThrow(/No TGit credentials found/);
        });
    });

    describe('tgitGitUser', () => {
        it("'private-token' → 'private'", () => {
            expect(tgitGitUser('private-token')).toBe('private');
        });

        it("'bearer' → 'oauth2'", () => {
            expect(tgitGitUser('bearer')).toBe('oauth2');
        });
    });

    describe('tryGetTGitToken', () => {
        it('TGIT_TOKEN set → private-token scheme', () => {
            process.env['TGIT_TOKEN'] = 'pat-123';
            expect(tryGetTGitToken()).toEqual({ token: 'pat-123', scheme: 'private-token' });
        });

        it('no TGIT_TOKEN, OAuth token → bearer scheme', () => {
            (gfGetOAuthToken as Mock).mockReturnValue('oauth-x');
            expect(tryGetTGitToken()).toEqual({ token: 'oauth-x', scheme: 'bearer' });
        });

        it('neither credential → returns null (does not throw)', () => {
            (gfGetOAuthToken as Mock).mockReturnValue(null);
            expect(tryGetTGitToken()).toBeNull();
        });
    });

    describe('tgitAuthHeaders', () => {
        it('bearer and private-token produce correct headers', () => {
            expect(tgitAuthHeaders('tok', 'bearer')).toEqual({ Authorization: 'Bearer tok' });
            expect(tgitAuthHeaders('tok', 'private-token')).toEqual({ 'PRIVATE-TOKEN': 'tok' });
        });
    });

    describe('tgitFetch', () => {
        it('200 response → one call with PRIVATE-TOKEN header and correct base URL', async () => {
            process.env['TGIT_TOKEN'] = 'pat-123';
            mockFetch.mockResolvedValueOnce(makeResponse(200));

            const resp = await tgitFetch('/projects');

            expect(resp.status).toBe(200);
            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url, init] = mockFetch.mock.calls[0];
            expect(url).toMatch(/^https:\/\/git\.woa\.com\/api\/v3/);
            expect((init.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('pat-123');
        });

        it('401 → retries once with the opposite scheme', async () => {
            // Fresh module so the module-level scheme cache does not leak.
            vi.resetModules();
            process.env['TGIT_TOKEN'] = 'pat-123';
            const localFetch: Mock = vi.fn()
                .mockResolvedValueOnce(makeResponse(401))
                .mockResolvedValueOnce(makeResponse(200));
            vi.stubGlobal('fetch', localFetch);

            const mod = await import('../providers/tgit/rest-auth.js');
            const resp = await mod.tgitFetch('/projects');

            expect(resp.status).toBe(200);
            expect(localFetch).toHaveBeenCalledTimes(2);

            const firstHeaders = localFetch.mock.calls[0][1].headers as Record<string, string>;
            const secondHeaders = localFetch.mock.calls[1][1].headers as Record<string, string>;
            // First call uses private-token (from TGIT_TOKEN), fallback uses bearer.
            expect(firstHeaders['PRIVATE-TOKEN']).toBe('pat-123');
            expect(secondHeaders.Authorization).toBe('Bearer pat-123');
        });

        it('both schemes fail → returns the original status, not the retry status', async () => {
            // A genuine 403 (authorized-but-forbidden) must not be masked as the
            // retry's 401, which would invert the caller's 401-vs-403 remedy.
            vi.resetModules();
            process.env['TGIT_TOKEN'] = 'pat-123';
            const localFetch: Mock = vi.fn()
                .mockResolvedValueOnce(makeResponse(403))
                .mockResolvedValueOnce(makeResponse(401));
            vi.stubGlobal('fetch', localFetch);

            const mod = await import('../providers/tgit/rest-auth.js');
            const resp = await mod.tgitFetch('/projects');

            expect(localFetch).toHaveBeenCalledTimes(2);
            expect(resp.status).toBe(403);
        });
    });
});
