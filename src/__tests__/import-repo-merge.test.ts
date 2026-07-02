import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../clone.js', () => ({
    shallowClone: vi.fn(),
    shallowFetch: vi.fn(),
}));

vi.mock('../domains/recommend.js', () => ({
    recommendDomain: vi.fn().mockResolvedValue({
        domain: '推理',
        confidence: 0.84,
        signal: 'test signal',
        alternatives: [],
    }),
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

// ─── Imports (after mocks) ──────────────────────────────

import { importFromRepo } from '../import-repo.js';
import { shallowClone } from '../clone.js';
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
            await fs.ensureDir(localPath);
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
        expect(content).toContain('## AI 架构叙事');
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
            expect(content).not.toContain('## AI 架构叙事');
        }
    });
});
