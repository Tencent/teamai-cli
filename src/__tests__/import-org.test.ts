// -*- coding: utf-8 -*-
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../domains/cluster.js', () => ({
    clusterRepos: vi.fn(),
}));

vi.mock('../domains/store.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../domains/store.js')>();
    return {
        ...actual,
        saveDomainsDraft: vi.fn().mockResolvedValue(undefined),
        saveDomains: vi.fn().mockResolvedValue(undefined),
        appendHistory: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('../domains/review.js', () => ({
    reviewDomains: vi.fn(),
}));

vi.mock('../import-repo-list.js', () => ({
    importFromRepoList: vi.fn(),
}));

vi.mock('../providers/registry.js', () => ({
    getProvider: vi.fn(),
    getProviderFromUrl: vi.fn().mockReturnValue({ name: 'github' }),
}));

// ─── Imports (after mocks) ───────────────────────────────

import { importFromOrg } from '../import-org.js';
import { clusterRepos } from '../domains/cluster.js';
import { saveDomainsDraft, saveDomains, appendHistory } from '../domains/store.js';
import { reviewDomains } from '../domains/review.js';
import { importFromRepoList } from '../import-repo-list.js';
import { getProvider } from '../providers/registry.js';
import type { DomainsFile } from '../domains/index.js';
import type { OrgRepoInfo } from '../providers/types.js';

// ─── Helpers ────────────────────────────────────────────

function makeRepo(overrides: Partial<OrgRepoInfo> = {}): OrgRepoInfo {
    return {
        url: 'https://github.com/org/repo-a',
        fullName: 'org/repo-a',
        name: 'repo-a',
        archived: false,
        ...overrides,
    };
}

function makeDomains(): DomainsFile {
    return {
        version: 1,
        confidence_threshold: 0.6,
        domains: [
            {
                name: '基础设施',
                description: '',
                repos: [{ url: 'https://github.com/org/repo-a', locked: false }],
            },
        ],
    };
}

async function makeWorkdir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-import-org-test-'));
    await fs.ensureDir(path.join(tmpDir, '.teamai'));
    return tmpDir;
}

// ─── Tests ──────────────────────────────────────────────

describe('importFromOrg', () => {
    let cwd: string;
    let originalCwd: string;

    const mockListOrgRepos = vi.fn();
    const mockProvider = {
        name: 'github',
        listOrgRepos: mockListOrgRepos,
    };

    beforeEach(async () => {
        cwd = await makeWorkdir();
        originalCwd = process.cwd();
        process.chdir(cwd);
        vi.clearAllMocks();
        (getProvider as ReturnType<typeof vi.fn>).mockReturnValue(mockProvider);
        (clusterRepos as ReturnType<typeof vi.fn>).mockResolvedValue(makeDomains());
        (reviewDomains as ReturnType<typeof vi.fn>).mockResolvedValue({
            result: makeDomains(),
            finalize: 'save',
        });
        (importFromRepoList as ReturnType<typeof vi.fn>).mockResolvedValue({
            succeeded: 1,
            failed: [],
            skipped: [],
        });
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.remove(cwd);
    });

    it.skip('过滤 archived 仓库后传给 clusterRepos', async () => {
        const repos: OrgRepoInfo[] = [
            makeRepo({ url: 'https://github.com/org/active', fullName: 'org/active', name: 'active', archived: false }),
            makeRepo({ url: 'https://github.com/org/archived', fullName: 'org/archived', name: 'archived',
                archived: true }),
        ];
        mockListOrgRepos.mockResolvedValue(repos);
        (clusterRepos as ReturnType<typeof vi.fn>).mockResolvedValue({
            ...makeDomains(),
            domains: [{
                name: '基础设施',
                description: '',
                repos: [{ url: 'https://github.com/org/active', locked: false }],
            }],
        });

        await importFromOrg({ org: 'github.com/org', skipImport: true, bootstrap: false, dryRun: true });

        expect(clusterRepos).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ name: 'active' }),
            ]),
        );
        const callArg = (clusterRepos as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<unknown>;
        expect(callArg.some((r: unknown) => (r as { name: string }).name === 'archived')).toBe(false);
    });

    it.skip('includePattern + excludePattern 共同生效', async () => {
        const repos: OrgRepoInfo[] = [
            makeRepo({ url: 'https://github.com/org/service-a', fullName: 'org/service-a', name: 'service-a' }),
            makeRepo({ url: 'https://github.com/org/service-b', fullName: 'org/service-b', name: 'service-b' }),
            makeRepo({ url: 'https://github.com/org/tool-x', fullName: 'org/tool-x', name: 'tool-x' }),
        ];
        mockListOrgRepos.mockResolvedValue(repos);

        await importFromOrg({
            org: 'github.com/org',
            includePattern: 'service-',
            excludePattern: 'service-b',
            skipImport: true,
            bootstrap: false,
            dryRun: true,
        });

        const callArg = (clusterRepos as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<unknown>;
        expect(callArg).toHaveLength(1);
        expect((callArg[0] as { name: string }).name).toBe('service-a');
    });

    it('skipImport=true 跳过 importFromRepoList', async () => {
        mockListOrgRepos.mockResolvedValue([makeRepo()]);

        await importFromOrg({ org: 'github.com/org', skipImport: true, bootstrap: false, dryRun: true });

        expect(importFromRepoList).not.toHaveBeenCalled();
    });

    it('bootstrap=false 仅写草稿不 review', async () => {
        mockListOrgRepos.mockResolvedValue([makeRepo()]);

        await importFromOrg({ org: 'github.com/org', bootstrap: false, skipImport: true, dryRun: true });

        expect(reviewDomains).not.toHaveBeenCalled();
    });

    it.skip('bootstrap=true 调用 reviewDomains 且 finalize=save 时写正式配置', async () => {
        mockListOrgRepos.mockResolvedValue([makeRepo()]);

        await importFromOrg({
            org: 'github.com/org',
            bootstrap: true,
            skipImport: true,
            dryRun: false,
        });

        expect(reviewDomains).toHaveBeenCalled();
        expect(saveDomains).toHaveBeenCalled();
    });

    it('appendHistory 被调用两次（start + complete）', async () => {
        mockListOrgRepos.mockResolvedValue([makeRepo()]);

        await importFromOrg({ org: 'github.com/org', skipImport: true, bootstrap: false, dryRun: true });

        expect(appendHistory).toHaveBeenCalledTimes(2);
    });
});
