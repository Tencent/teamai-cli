import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { gfListOrgRepos } from '../providers/tgit/gf-org.js';
import { gfGetOAuthToken } from '../providers/tgit/gf-cli.js';

function makeProject(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        name: 'repo-one',
        path_with_namespace: 'my-group/repo-one',
        description: 'A test repo',
        http_url_to_repo: 'https://git.woa.com/my-group/repo-one.git',
        archived: false,
        last_activity_at: '2024-01-01T00:00:00Z',
        star_count: 5,
        ...overrides,
    };
}

function makeResponse(body: unknown, status = 200): Response {
    const bodyText = JSON.stringify(body);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(bodyText);
    let readerDone = false;
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(bodyText),
        body: {
            getReader: () => ({
                read: async () => {
                    if (!readerDone) {
                        readerDone = true;
                        return { done: false, value: bytes };
                    }
                    return { done: true, value: undefined };
                },
                cancel: async () => {},
            }),
        },
    } as unknown as Response;
}

describe('gfListOrgRepos', () => {
    let mockFetch: Mock;

    beforeEach(() => {
        vi.resetAllMocks();
        mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);
        (gfGetOAuthToken as Mock).mockReturnValue('test-token-abc');
    });

    it('单页（< 100 条）— 一次调用拿全', async () => {
        const projects = [
            makeProject(),
            makeProject({ id: 2, name: 'repo-two', path_with_namespace: 'my-group/repo-two' }),
        ];
        mockFetch.mockResolvedValueOnce(makeResponse(projects));

        const result = await gfListOrgRepos('my-group');

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(2);
        expect(result[0].fullName).toBe('my-group/repo-one');
        expect(result[1].name).toBe('repo-two');
    });

    it('多页（页1返回100条 → 页2返回23条）— 两次调用，正确合并', async () => {
        const page1 = Array.from({ length: 100 }, (_, i) =>
            makeProject({ id: i + 1, name: `repo-${i}`, path_with_namespace: `grp/repo-${i}` }),
        );
        const page2 = Array.from({ length: 23 }, (_, i) =>
            makeProject({ id: 200 + i, name: `repo-b-${i}`, path_with_namespace: `grp/repo-b-${i}` }),
        );

        mockFetch
            .mockResolvedValueOnce(makeResponse(page1))
            .mockResolvedValueOnce(makeResponse(page2));

        const result = await gfListOrgRepos('grp');

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(123);
    });

    it('maxRepos=50 限制 — 只返回 50 条', async () => {
        const page1 = Array.from({ length: 100 }, (_, i) =>
            makeProject({ id: i + 1, name: `repo-${i}`, path_with_namespace: `grp/repo-${i}` }),
        );
        mockFetch.mockResolvedValueOnce(makeResponse(page1));

        const result = await gfListOrgRepos('grp', { maxRepos: 50 });

        expect(result).toHaveLength(50);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('404 — 抛 TGit group not found or no access', async () => {
        // 策略 1（/groups/<id>/projects）和策略 2（/groups/<id>）均返回 404
        mockFetch.mockResolvedValueOnce(makeResponse('Not Found', 404));
        mockFetch.mockResolvedValueOnce(makeResponse('Not Found', 404));

        await expect(gfListOrgRepos('nonexistent-group')).rejects.toThrow(
            'TGit group nonexistent-group not found or no access',
        );
    });

    it('401 HTTP 错误 — 抛 TGit API HTTP 401', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: () => Promise.resolve('Unauthorized'),
        } as unknown as Response);

        await expect(gfListOrgRepos('my-group')).rejects.toThrow('TGit API HTTP 401');
    });

    it('403 HTTP 错误 — 抛 TGit API HTTP 403', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 403,
            text: () => Promise.resolve('Forbidden'),
        } as unknown as Response);

        await expect(gfListOrgRepos('my-group')).rejects.toThrow('TGit API HTTP 403');
    });

    it('token 缺失 — 抛 TGit token unavailable', async () => {
        (gfGetOAuthToken as Mock).mockReturnValue(null);

        await expect(gfListOrgRepos('my-group')).rejects.toThrow('TGit token unavailable');
    });

    it('archived 字段缺失时默认 false', async () => {
        const project = makeProject();
        delete (project as Record<string, unknown>).archived;
        mockFetch.mockResolvedValueOnce(makeResponse([project]));

        const result = await gfListOrgRepos('my-group');

        expect(result[0].archived).toBe(false);
    });

    it('多级 group 路径 team/sub — URL 中 team%2Fsub', async () => {
        mockFetch.mockResolvedValueOnce(makeResponse([]));

        await gfListOrgRepos('team/sub');

        const calledUrl = mockFetch.mock.calls[0][0] as string;
        expect(calledUrl).toContain('team%2Fsub');
    });

    it('字段映射准确 — path_with_namespace → fullName，http_url_to_repo → url', async () => {
        const project = makeProject({
            path_with_namespace: 'org/sub/my-repo',
            http_url_to_repo: 'https://git.woa.com/org/sub/my-repo.git',
            description: 'Test description',
            star_count: 42,
            last_activity_at: '2025-01-15T10:00:00Z',
        });
        mockFetch.mockResolvedValueOnce(makeResponse([project]));

        const result = await gfListOrgRepos('org/sub');

        expect(result[0].fullName).toBe('org/sub/my-repo');
        expect(result[0].url).toBe('https://git.woa.com/org/sub/my-repo.git');
        expect(result[0].description).toBe('Test description');
        expect(result[0].stars).toBe(42);
        expect(result[0].pushedAt).toBe('2025-01-15T10:00:00Z');
        expect(result[0].primaryLanguage).toBeUndefined();
    });
});
