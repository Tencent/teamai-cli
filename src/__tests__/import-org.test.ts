// -*- coding: utf-8 -*-
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../import-repo-list.js', () => ({
    importFromRepoList: vi.fn(),
}));

vi.mock('../providers/registry.js', () => ({
    getProvider: vi.fn(),
    getProviderFromUrl: vi.fn().mockReturnValue({ name: 'github' }),
    detectProvider: vi.fn().mockReturnValue('github'),
}));

// ─── Imports (after mocks) ───────────────────────────────

import { importFromOrg } from '../import-org.js';
import { importFromRepoList } from '../import-repo-list.js';
import { detectProvider, getProvider } from '../providers/registry.js';
import type { OrgRepoInfo } from '../providers/types.js';
import { log } from '../utils/logger.js';

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
        vi.mocked(detectProvider).mockReturnValue('github');
        (getProvider as ReturnType<typeof vi.fn>).mockReturnValue(mockProvider);
        (importFromRepoList as ReturnType<typeof vi.fn>).mockResolvedValue({
            succeeded: 1,
            failed: [],
            skipped: [],
        });
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.remove(cwd);
        vi.restoreAllMocks();
    });

    it('过滤 archived 仓库后生成白名单', async () => {
        const repos: OrgRepoInfo[] = [
            makeRepo({ url: 'https://github.com/org/active', fullName: 'org/active', name: 'active', archived: false }),
            makeRepo({ url: 'https://github.com/org/archived', fullName: 'org/archived', name: 'archived',
                archived: true }),
        ];
        mockListOrgRepos.mockResolvedValue(repos);

        await importFromOrg({ org: 'github.com/org', skipImport: true, dryRun: false });

        const whitelistPath = path.join(cwd, '.teamai', 'repo-whitelist.draft.yaml');
        const content = await fs.readFile(whitelistPath, 'utf8');
        expect(content).toContain('https://github.com/org/active');
        expect(content).not.toContain('https://github.com/org/archived');
    });

    it('includePattern + excludePattern 共同生效', async () => {
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
            dryRun: false,
        });

        const whitelistPath = path.join(cwd, '.teamai', 'repo-whitelist.draft.yaml');
        const content = await fs.readFile(whitelistPath, 'utf8');
        expect(content).toContain('https://github.com/org/service-a');
        expect(content).not.toContain('https://github.com/org/service-b');
        expect(content).not.toContain('https://github.com/org/tool-x');
    });

    it('skipImport=true 跳过 importFromRepoList', async () => {
        mockListOrgRepos.mockResolvedValue([makeRepo()]);

        await importFromOrg({ org: 'github.com/org', skipImport: true, dryRun: true });

        expect(importFromRepoList).not.toHaveBeenCalled();
    });

    it('skipImport=false 调用 importFromRepoList', async () => {
        mockListOrgRepos.mockResolvedValue([makeRepo()]);

        await importFromOrg({ org: 'github.com/org', skipImport: false, dryRun: false });

        expect(importFromRepoList).toHaveBeenCalledWith(
            expect.objectContaining({
                listPath: expect.stringContaining('repo-whitelist.draft.yaml'),
            }),
        );
    });

    it.each([false, true])('previews the current selection without importing or writing (old draft=%s)', async (hasDraft) => {
        const draft = path.join(cwd, '.teamai', 'repo-whitelist.draft.yaml');
        const oldContent = 'version: 1\nrepos:\n  - url: https://github.com/old-org/old-repo\n';
        if (hasDraft) await fs.writeFile(draft, oldContent);
        const before = await fs.readdir(path.join(cwd, '.teamai'));
        mockListOrgRepos.mockResolvedValue([
            makeRepo({ fullName: 'org/service-a', url: 'https://github.com/org/service-a' }),
            makeRepo({ fullName: 'org/service-b', url: 'https://github.com/org/service-b' }),
            makeRepo({ fullName: 'org/archived', archived: true }),
            makeRepo({ fullName: 'org/tool-x' }),
        ]);
        const info = vi.spyOn(log, 'info').mockImplementation(() => {});

        await importFromOrg({ org: 'github.com/org', dryRun: true, includePattern: 'service-', excludePattern: 'service-b' });

        expect(importFromRepoList).not.toHaveBeenCalled();
        expect(await fs.readdir(path.join(cwd, '.teamai'))).toEqual(before);
        if (hasDraft) expect(await fs.readFile(draft, 'utf8')).toBe(oldContent);
        const output = info.mock.calls.map(([message]) => message).join('\n');
        expect(output).toContain('[dry-run] Would write whitelist');
        expect(output).toContain('[dry-run] Would import https://github.com/org/service-a');
        expect(output).not.toContain('service-b');
        expect(output).not.toContain('old-org');
    });

    it('previews only the whitelist when import is explicitly skipped', async () => {
        mockListOrgRepos.mockResolvedValue([makeRepo()]);
        const info = vi.spyOn(log, 'info').mockImplementation(() => {});

        await importFromOrg({ org: 'github.com/org', dryRun: true, skipImport: true });

        const output = info.mock.calls.map(([message]) => message).join('\n');
        expect(output).toContain('[dry-run] Would write whitelist');
        expect(output).toContain('https://github.com/org/repo-a');
        expect(output).not.toContain('Would import');
        expect(importFromRepoList).not.toHaveBeenCalled();
        expect(await fs.readdir(path.join(cwd, '.teamai'))).toEqual([]);
    });

});
