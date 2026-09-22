import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../clone.js', () => ({
    shallowClone: vi.fn(),
    shallowFetch: vi.fn(),
}));

vi.mock('../utils/prompt.js', () => ({
    askQuestion: vi.fn().mockResolvedValue('y'),
    askConfirmation: vi.fn().mockResolvedValue(true),
}));

vi.mock('../codebase.js', () => ({
    generateCodebaseMd: vi.fn().mockResolvedValue(
        '---\ntitle: Test Repo\nlastUpdated: 2024-01-01T00:00:00.000Z\n---\n\n## 项目概述\n固定的项目概述内容，不会改变。\n\n## 技术栈\nTypeScript + vitest',
    ),
}));

vi.mock('../codebase-extract.js', () => ({
    extractCodebase: vi.fn(),
}));

vi.mock('../config.js', () => ({
    autoDetectInit: vi.fn().mockRejectedValue(new Error('no config in test')),
}));

// ─── Imports (after mocks) ──────────────────────────────

import { importFromRepo } from '../import-repo.js';
import { shallowClone, shallowFetch } from '../clone.js';
import { generateCodebaseMd } from '../codebase.js';
import { extractCodebase } from '../codebase-extract.js';

// ─── Constants ──────────────────────────────────────────

const CLONE_SHA = 'deadbeef1234567890abcdef1234567890abcdef';
const SLUG = 'github__owner__mergetest';

const DETERMINISTIC_OVERVIEW = [
    '---',
    'title: github__owner__mergetest overview',
    'domain: code-knowledge',
    '---',
    '',
    '# github__owner__mergetest',
    '',
    '**5 facts** extracted from 3 files.',
    'Graph: 4 nodes, 2 edges.',
    '',
    '## Module Structure',
    '',
    '| Module | Facts | Components | Interfaces |',
    '|--------|-------|------------|------------|',
    '| src | 3 | 2 | 1 |',
    '',
].join('\n');

// ─── Helpers ────────────────────────────────────────────

async function makeWorkdir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-import-merge-test-'));
    await fs.ensureDir(path.join(tmpDir, '.teamai'));
    return tmpDir;
}

// ─── Tests ──────────────────────────────────────────────

describe('importFromRepo — AI narrative appended to overview.md', () => {
    let workdir: string;
    const TEST_URL = 'https://github.com/owner/mergetest';

    beforeEach(async () => {
        workdir = await makeWorkdir();
        vi.spyOn(process, 'cwd').mockReturnValue(workdir);
        process.env.TEAMAI_CACHE_DIR = path.join(workdir, 'cache');

        vi.mocked(shallowClone).mockImplementation(async (_url: string, localPath: string) => {
            await fs.ensureDir(path.join(localPath, '.git'));
            return { sha: CLONE_SHA, branch: 'main', cloneMethod: 'https-token' as const };
        });

        // Mock extractCodebase to simulate writing teamwiki evidence files
        vi.mocked(extractCodebase).mockImplementation(async (opts) => {
            const cacheDir = opts.path ?? '.';
            const project = opts.project || 'test';
            const wikiRoot = path.join(cacheDir, 'teamwiki');
            const evidenceDir = path.join(wikiRoot, 'evidence', 'code', project);
            const indicesDir = path.join(wikiRoot, '.indices');

            await fs.ensureDir(evidenceDir);
            await fs.ensureDir(indicesDir);
            await fs.writeFile(path.join(evidenceDir, 'overview.md'), DETERMINISTIC_OVERVIEW, 'utf8');
            const emptyGraph = JSON.stringify({ nodes: [], edges: [] });
            await fs.writeFile(path.join(indicesDir, 'graph-index.json'), emptyGraph, 'utf8');
        });
    });

    afterEach(async () => {
        vi.clearAllMocks();
        delete process.env.TEAMAI_CACHE_DIR;
        await fs.remove(workdir);
    });

    it('AI 叙事追加到 teamwiki evidence overview.md 末尾', async () => {
        await importFromRepo({
            url: TEST_URL,
            interactive: false,
        });

        const overviewPath = path.join(
            workdir, '.teamai', 'team-repo', 'teamwiki', 'evidence', 'code',
            SLUG, 'overview.md',
        );
        const exists = await fs.pathExists(overviewPath);
        expect(exists).toBe(true);

        const content = await fs.readFile(overviewPath, 'utf8');
        // 确定性内容（模块表格）在前
        expect(content).toContain('## Module Structure');
        // AI 叙事在后
        expect(content).toContain('## AI Architecture Narrative');
        expect(content).toContain('固定的项目概述内容，不会改变。');
        expect(content).toContain('技术栈');
    });

    it('docs/team-codebase/repos/ 不再被创建', async () => {
        await importFromRepo({
            url: TEST_URL,
            interactive: false,
        });

        const oldPath = path.join(
            workdir, '.teamai', 'team-repo', 'docs', 'team-codebase', 'repos',
            `${SLUG}.md`,
        );
        const exists = await fs.pathExists(oldPath);
        expect(exists).toBe(false);
    });

    it('skipEnrich 时不追加 AI 叙事', async () => {
        await importFromRepo({
            url: TEST_URL,
            interactive: false,
            skipEnrich: true,
        });

        const overviewPath = path.join(
            workdir, '.teamai', 'team-repo', 'teamwiki', 'evidence', 'code',
            SLUG, 'overview.md',
        );
        if (await fs.pathExists(overviewPath)) {
            const content = await fs.readFile(overviewPath, 'utf8');
            expect(content).not.toContain('## AI Architecture Narrative');
        }
    });

    it('retries extraction after a failed import of the same commit', async () => {
        vi.mocked(extractCodebase).mockRejectedValueOnce(new Error('write failed'));
        vi.mocked(shallowFetch).mockResolvedValue({ sha: CLONE_SHA });
        const options = { url: TEST_URL, incremental: true, interactive: false, skipEnrich: true, skipAutoPush: true };
        const lastSyncPath = path.join(workdir, 'cache', 'github', 'owner', 'mergetest', 'LAST_SYNC');
        await fs.ensureDir(path.join(path.dirname(lastSyncPath), '.git'));
        await fs.writeFile(lastSyncPath, 'previous-sha\n2024-01-01T00:00:00.000Z\n');

        await expect(importFromRepo(options)).rejects.toThrow('Knowledge extraction failed: write failed');
        expect(await fs.readFile(lastSyncPath, 'utf8')).toContain('previous-sha');

        await importFromRepo(options);
        expect(extractCodebase).toHaveBeenCalledTimes(2);
        expect(shallowFetch).toHaveBeenCalledTimes(2);
        expect(await fs.readFile(lastSyncPath, 'utf8')).toContain(CLONE_SHA);
    });

    it('re-extracts when cleanup fails after publishing the new manifest', async () => {
        vi.mocked(shallowFetch).mockResolvedValue({ sha: CLONE_SHA });
        vi.mocked(extractCodebase).mockImplementation(async (opts) => {
            const wikiRoot = path.join(opts.path ?? '.', 'teamwiki');
            const manifestPath = path.join(wikiRoot, 'source-manifest.json');
            if (opts.incremental && await fs.pathExists(manifestPath)
                && (await fs.readJson(manifestPath)).headSha === CLONE_SHA) {
                return; // The real extractor skips when the copied manifest matches HEAD.
            }
            const evidenceDir = path.join(wikiRoot, 'evidence', 'code', SLUG);
            await fs.ensureDir(evidenceDir);
            await fs.writeFile(path.join(evidenceDir, 'overview.md'), DETERMINISTIC_OVERVIEW);
            await fs.writeJson(manifestPath, { headSha: CLONE_SHA, files: [] });
        });

        const options = { url: TEST_URL, incremental: true, interactive: false, skipEnrich: true, skipAutoPush: true };
        const cacheDir = path.join(workdir, 'cache', 'github', 'owner', 'mergetest');
        const lastSyncPath = path.join(cacheDir, 'LAST_SYNC');
        const publishedManifest = path.join(workdir, '.teamai', 'team-repo', 'teamwiki', 'source-manifest.json');
        await fs.ensureDir(path.join(cacheDir, '.git'));
        await fs.writeFile(lastSyncPath, 'previous-sha\n2024-01-01T00:00:00.000Z\n');
        await fs.ensureDir(path.dirname(publishedManifest));
        await fs.writeJson(publishedManifest, { headSha: 'previous-sha', files: [] });

        const remove = fs.remove;
        let failOnce = true;
        const removeSpy = vi.spyOn(fs, 'remove').mockImplementation(async (target) => {
            if (target === path.join(cacheDir, 'teamwiki') && failOnce) {
                failOnce = false;
                throw new Error('cache cleanup failed');
            }
            return remove(target);
        });
        try {
            await expect(importFromRepo(options)).rejects.toThrow('Knowledge extraction failed: cache cleanup failed');
        } finally {
            removeSpy.mockRestore();
        }

        expect((await fs.readJson(publishedManifest)).headSha).toBe(CLONE_SHA);
        expect(await fs.readFile(lastSyncPath, 'utf8')).toContain('previous-sha');

        await importFromRepo(options);
        expect(vi.mocked(extractCodebase).mock.calls.map(([opts]) => opts.incremental)).toEqual([true, false]);
        expect(await fs.readFile(lastSyncPath, 'utf8')).toContain(CLONE_SHA);
    });
});
