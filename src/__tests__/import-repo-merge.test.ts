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

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
    autoDetectInit: vi.fn().mockRejectedValue(new Error('no config in test')),
}));

// ─── Imports (after mocks) ──────────────────────────────

import { importFromRepo } from '../import-repo.js';
import { shallowClone, shallowFetch } from '../clone.js';
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
    let output: string;
    let evidenceDir: string;
    const TEST_URL = 'https://github.com/owner/mergetest';

    beforeEach(async () => {
        workdir = await makeWorkdir();
        output = path.join(workdir, '.teamai', 'team-repo');
        evidenceDir = path.join(output, 'teamwiki', 'evidence', 'code', SLUG);
        vi.spyOn(process, 'cwd').mockReturnValue(workdir);
        process.env.TEAMAI_CACHE_DIR = path.join(workdir, 'cache');

        vi.mocked(shallowClone).mockImplementation(async (_url: string, localPath: string) => {
            await fs.ensureDir(path.join(localPath, '.git'));
            return { sha: CLONE_SHA, branch: 'main', cloneMethod: 'https-token' as const };
        });

        // Mock extractCodebase to simulate writing teamwiki evidence files into its staging root
        vi.mocked(extractCodebase).mockImplementation(async (opts) => {
            const wikiRoot = path.join(opts.outputRoot!, 'teamwiki');
            const stagedEvidence = path.join(wikiRoot, 'evidence', 'code', opts.project!);
            const indicesDir = path.join(wikiRoot, '.indices');

            await fs.ensureDir(stagedEvidence);
            await fs.ensureDir(indicesDir);
            await fs.writeFile(path.join(stagedEvidence, 'overview.md'), DETERMINISTIC_OVERVIEW, 'utf8');
            const manifest = JSON.stringify({ project: opts.project, headSha: CLONE_SHA, files: [] });
            await fs.writeFile(path.join(stagedEvidence, 'source-manifest.json'), manifest, 'utf8');
            await fs.writeFile(path.join(wikiRoot, 'source-manifest.json'), manifest, 'utf8');
            await fs.writeFile(path.join(indicesDir, 'graph-index.json'), JSON.stringify({ nodes: [], edges: [] }), 'utf8');
            await fs.writeFile(path.join(indicesDir, 'facts-cache.json'), '[]', 'utf8');
            return true;
        });
    });

    afterEach(async () => {
        vi.clearAllMocks();
        delete process.env.TEAMAI_CACHE_DIR;
        await fs.remove(workdir);
    });

    it('AI 叙事追加到 teamwiki evidence overview.md 末尾', async () => {
        await importFromRepo({ url: TEST_URL, output });

        const overviewPath = path.join(evidenceDir, 'overview.md');
        expect(await fs.pathExists(overviewPath)).toBe(true);

        const content = await fs.readFile(overviewPath, 'utf8');
        // 确定性内容（模块表格）在前
        expect(content).toContain('## Module Structure');
        // AI 叙事在后
        expect(content).toContain('## AI Architecture Narrative');
        expect(content).toContain('固定的项目概述内容，不会改变。');
        expect(content).toContain('技术栈');
    });

    it('docs/team-codebase/repos/ 不再被创建', async () => {
        await importFromRepo({ url: TEST_URL, output });

        const oldPath = path.join(output, 'docs', 'team-codebase', 'repos', `${SLUG}.md`);
        expect(await fs.pathExists(oldPath)).toBe(false);
    });

    it('skipEnrich 时不追加 AI 叙事', async () => {
        await importFromRepo({ url: TEST_URL, output, skipEnrich: true });

        const content = await fs.readFile(path.join(evidenceDir, 'overview.md'), 'utf8');
        expect(content).not.toContain('## AI Architecture Narrative');
    });

    it('--output <dir> writes <dir>/teamwiki, not a sibling of <dir>', async () => {
        await importFromRepo({ url: TEST_URL, output, skipEnrich: true });

        expect(await fs.pathExists(path.join(output, 'teamwiki', 'evidence', 'code', SLUG, 'overview.md'))).toBe(true);
        expect(await fs.pathExists(path.join(workdir, '.teamai', 'teamwiki'))).toBe(false);
    });

    it('extracts in a staging dir: the clone cache gets no teamwiki/, the codebase keeps its own graph and caches', async () => {
        await importFromRepo({ url: TEST_URL, output, skipEnrich: true });

        const cacheDir = path.join(workdir, 'cache', 'github', 'owner', 'mergetest');
        expect(vi.mocked(extractCodebase).mock.calls[0]?.[0]).toMatchObject({ path: cacheDir, project: SLUG });
        expect(vi.mocked(extractCodebase).mock.calls[0]?.[0]?.outputRoot).not.toContain(cacheDir);
        expect(await fs.pathExists(path.join(cacheDir, 'teamwiki'))).toBe(false);
        expect(await fs.pathExists(path.join(evidenceDir, '.indices', 'graph-index.json'))).toBe(true);
        expect(await fs.pathExists(path.join(evidenceDir, '.indices', 'facts-cache.json'))).toBe(true);
        expect(await fs.pathExists(path.join(evidenceDir, 'source-manifest.json'))).toBe(true);
    });

    it('fails before cloning when there is neither a team repo nor --output', async () => {
        await expect(importFromRepo({ url: TEST_URL })).rejects.toThrow('no config in test');
        expect(shallowClone).not.toHaveBeenCalled();
    });

    it('retries extraction after a failed import of the same commit', async () => {
        vi.mocked(extractCodebase).mockRejectedValueOnce(new Error('write failed'));
        vi.mocked(shallowFetch).mockResolvedValue({ sha: CLONE_SHA });
        const options = { url: TEST_URL, output, incremental: true, skipEnrich: true, skipAutoPush: true };
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

    it('does not skip an unchanged clone cache when the target teamwiki has not been imported at that commit', async () => {
        vi.mocked(shallowFetch).mockResolvedValue({ sha: CLONE_SHA });
        const cacheDir = path.join(workdir, 'cache', 'github', 'owner', 'mergetest');
        await fs.ensureDir(path.join(cacheDir, '.git'));
        await fs.writeFile(path.join(cacheDir, 'LAST_SYNC'), `${CLONE_SHA}\n2024-01-01T00:00:00.000Z\n`);

        // Another --output (or team repo) imported this commit; this one has nothing yet.
        await importFromRepo({ url: TEST_URL, output, incremental: true, skipEnrich: true, skipAutoPush: true });
        expect(extractCodebase).toHaveBeenCalledTimes(1);
        expect(await fs.pathExists(path.join(evidenceDir, 'overview.md'))).toBe(true);

        // Now it holds the commit, so the next run skips it.
        await importFromRepo({ url: TEST_URL, output, incremental: true, skipEnrich: true, skipAutoPush: true });
        expect(extractCodebase).toHaveBeenCalledTimes(1);
    });

    it('seeds the codebase\'s own baseline, so an incremental run extracts incrementally', async () => {
        await importFromRepo({ url: TEST_URL, output, skipEnrich: true, skipAutoPush: true });
        vi.mocked(shallowFetch).mockResolvedValue({ sha: 'cafebabe1234567890abcdef1234567890abcdef' });

        let seededManifest: unknown = null;
        vi.mocked(extractCodebase).mockImplementationOnce(async (opts) => {
            seededManifest = await fs.readJson(path.join(opts.outputRoot!, 'teamwiki', 'source-manifest.json')).catch(() => null);
            return true;
        });
        await importFromRepo({ url: TEST_URL, output, incremental: true, skipEnrich: true, skipAutoPush: true });

        expect(vi.mocked(extractCodebase).mock.calls.map(([opts]) => opts.incremental)).toEqual([false, true]);
        expect(seededManifest).toMatchObject({ project: SLUG, headSha: CLONE_SHA });
    });

    it('keeps the published evidence when an incremental run finds no source changes', async () => {
        await importFromRepo({ url: TEST_URL, output, skipEnrich: true, skipAutoPush: true });
        const before = await fs.readFile(path.join(evidenceDir, 'overview.md'), 'utf8');
        vi.mocked(shallowFetch).mockResolvedValue({ sha: 'cafebabe1234567890abcdef1234567890abcdef' });
        // A commit that touched no source file: the extractor writes nothing.
        vi.mocked(extractCodebase).mockResolvedValueOnce(false);

        await importFromRepo({ url: TEST_URL, output, incremental: true, skipEnrich: true, skipAutoPush: true });

        expect(await fs.readFile(path.join(evidenceDir, 'overview.md'), 'utf8')).toBe(before);
        expect(await fs.pathExists(path.join(evidenceDir, '.indices', 'graph-index.json'))).toBe(true);
    });
});
