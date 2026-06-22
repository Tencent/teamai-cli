// -*- coding: utf-8 -*-
/**
 * gh-org private repo / fallback 场景测试
 *
 * 验证：
 * 1. 私有仓不被过滤（Blocker 2 修复）
 * 2. /orgs/<x> 第一页返回 [] 时 fallback 到 /users/<x>（Major 1 修复）
 * 3. /orgs/<x> 404 时 fallback 到 /users/<x>（既有路径，防回归）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../providers/github/gh-cli.js', () => ({
    isGhInstalled: vi.fn().mockReturnValue(false),
    getGitHubToken: vi.fn().mockReturnValue('fake-token-xyz'),
}));

// ─── Imports (after mocks) ───────────────────────────────

import { ghListOrgRepos } from '../providers/github/gh-org.js';
import { isGhInstalled, getGitHubToken } from '../providers/github/gh-cli.js';

// ─── Helpers ────────────────────────────────────────────

function makeGhRepoItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        clone_url: 'https://github.com/org/repo.git',
        full_name: 'org/repo',
        name: 'repo',
        description: null,
        language: 'TypeScript',
        archived: false,
        stargazers_count: 5,
        pushed_at: '2024-01-01T00:00:00Z',
        ...overrides,
    };
}

// ─── Tests ──────────────────────────────────────────────

describe('gh-org fetch 分支（使用 GITHUB_TOKEN）', () => {
    beforeEach(() => {
        vi.mocked(isGhInstalled).mockReturnValue(false);
        vi.mocked(getGitHubToken).mockReturnValue('fake-token-xyz');
        vi.restoreAllMocks();
        // 每次重新 mock
        vi.mocked(isGhInstalled).mockReturnValue(false);
        vi.mocked(getGitHubToken).mockReturnValue('fake-token-xyz');
    });

    it('包含私有仓的响应 → 私有仓出现在结果中（不被过滤）', async () => {
        const items = [
            makeGhRepoItem({ full_name: 'org/public-repo', name: 'public-repo', clone_url: 'https://github.com/org/public-repo.git' }),
            makeGhRepoItem({ full_name: 'org/private-repo', name: 'private-repo', clone_url: 'https://github.com/org/private-repo.git' }),
        ];

        const mockFetch = vi.fn().mockResolvedValue({
            status: 200,
            ok: true,
            body: {
                getReader: () => {
                    const text = JSON.stringify(items);
                    const encoder = new TextEncoder();
                    const bytes = encoder.encode(text);
                    let done = false;
                    return {
                        read: async () => {
                            if (!done) {
                                done = true;
                                return { done: false, value: bytes };
                            }
                            return { done: true, value: undefined };
                        },
                        cancel: async () => {},
                    };
                },
            },
        });

        vi.stubGlobal('fetch', mockFetch);

        const result = await ghListOrgRepos('org');

        const names = result.map((r: { name: string }) => r.name);
        expect(names).toContain('public-repo');
        expect(names).toContain('private-repo');

        vi.unstubAllGlobals();
    });

    it('/orgs/<x> 第一页返回 [] → fallback 到 /users/<x> 并拿到非空结果', async () => {
        const userRepos = [
            makeGhRepoItem({ full_name: 'myuser/my-repo', name: 'my-repo', clone_url: 'https://github.com/myuser/my-repo.git' }),
        ];

        let callCount = 0;
        const mockFetch = vi.fn().mockImplementation(async (url: string) => {
            callCount++;
            if (url.includes('/orgs/')) {
                // /orgs/<x> 第一页返回空数组
                const emptyBytes = new TextEncoder().encode('[]');
                return {
                    status: 200,
                    ok: true,
                    body: {
                        getReader: () => {
                            let done = false;
                            return {
                                read: async () => {
                                    if (!done) { done = true; return { done: false, value: emptyBytes }; }
                                    return { done: true, value: undefined };
                                },
                                cancel: async () => {},
                            };
                        },
                    },
                };
            }
            // /users/<x> 返回非空
            const bytes = new TextEncoder().encode(JSON.stringify(userRepos));
            return {
                status: 200,
                ok: true,
                body: {
                    getReader: () => {
                        let done = false;
                        return {
                            read: async () => {
                                if (!done) { done = true; return { done: false, value: bytes }; }
                                return { done: true, value: undefined };
                            },
                            cancel: async () => {},
                        };
                    },
                },
            };
        });

        vi.stubGlobal('fetch', mockFetch);

        const result = await ghListOrgRepos('myuser');

        // 断言走了 fallback：/orgs/ 一次 + /users/ 至少一次
        expect(callCount).toBeGreaterThanOrEqual(2);
        expect(result.length).toBeGreaterThan(0);
        expect(result[0].name).toBe('my-repo');

        vi.unstubAllGlobals();
    });

    it('/orgs/<x> 404 → fallback 到 /users/<x>', async () => {
        const userRepos = [
            makeGhRepoItem({ full_name: 'fallback-user/repo1', name: 'repo1', clone_url: 'https://github.com/fallback-user/repo1.git' }),
        ];

        const mockFetch = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('/orgs/')) {
                // 模拟 404 → fetchApiPage 抛错 → tryUrl 捕获，page === 1 返回 false
                return {
                    status: 404,
                    ok: false,
                    text: async () => 'Not Found',
                    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }), cancel: async () => {} }) },
                };
            }
            const bytes = new TextEncoder().encode(JSON.stringify(userRepos));
            return {
                status: 200,
                ok: true,
                body: {
                    getReader: () => {
                        let done = false;
                        return {
                            read: async () => {
                                if (!done) { done = true; return { done: false, value: bytes }; }
                                return { done: true, value: undefined };
                            },
                            cancel: async () => {},
                        };
                    },
                },
            };
        });

        vi.stubGlobal('fetch', mockFetch);

        const result = await ghListOrgRepos('fallback-user');
        expect(result.length).toBeGreaterThan(0);
        expect(result[0].name).toBe('repo1');

        vi.unstubAllGlobals();
    });
});
