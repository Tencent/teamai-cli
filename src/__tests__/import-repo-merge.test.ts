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

// ─── Imports (after mocks) ──────────────────────────────

import { importFromRepo } from '../import-repo.js';
import { shallowClone } from '../clone.js';
import { generateCodebaseMd } from '../codebase.js';

// ─── Constants ──────────────────────────────────────────

const CLONE_SHA = 'deadbeef1234567890abcdef1234567890abcdef';

const FIXED_CODEBASE_MD =
    '---\ntitle: Test Repo\nlastUpdated: 2024-01-01T00:00:00.000Z\n---\n\n## 项目概述\n固定的项目概述内容，不会改变。\n\n## 技术栈\nTypeScript + vitest';

// ─── Helpers ────────────────────────────────────────────

async function makeWorkdir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-import-merge-test-'));
    await fs.ensureDir(path.join(tmpDir, '.teamai'));
    return tmpDir;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tests ──────────────────────────────────────────────

describe('importFromRepo — section merge', () => {
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

        vi.mocked(generateCodebaseMd).mockResolvedValue(FIXED_CODEBASE_MD);
    });

    afterEach(async () => {
        vi.clearAllMocks();
        delete process.env.TEAMAI_CACHE_DIR;
        await fs.remove(workdir);
    });

    it('第一次跑 import → 文件被创建、含锚点', async () => {
        await importFromRepo({
            url: TEST_URL,
            interactive: false,
        });

        const repoMdPath = path.join(workdir, '.teamai', 'team-repo', 'docs', 'team-codebase', 'repos', 'github__owner__mergetest.md');
        const exists = await fs.pathExists(repoMdPath);
        expect(exists).toBe(true);

        const content = await fs.readFile(repoMdPath, 'utf8');
        expect(content).toContain('<!-- managed-by: import --from-repo');
        expect(content).toContain('<!-- /managed-by:');
        expect(content).toContain('项目概述');
        expect(content).toContain('技术栈');
    });

    it('第二次跑同样输入 → 文件 mtime 不改变（真正跳过写入）', async () => {
        // 第一次运行
        await importFromRepo({
            url: TEST_URL,
            interactive: false,
        });

        const repoMdPath = path.join(workdir, '.teamai', 'team-repo', 'docs', 'team-codebase', 'repos', 'github__owner__mergetest.md');
        const stat1 = await fs.stat(repoMdPath);
        const mtime1 = stat1.mtimeMs;

        // 等待足够时间确保 mtime 可区分
        await sleep(20);

        // 第二次运行，相同输入（仓库已在 domains 中，走增量路径返回）
        // 需要先让仓库不在 domains 中，重新走 import 流程
        // 或者直接验证文件内容未变（字节级等同）
        const content1 = await fs.readFile(repoMdPath, 'utf8');

        // 模拟：手动调用 mergeWithAnchors 验证第二次不写盘
        // 实际测试方式：删除 domains 记录，让第二次也能跑 import 全流程
        // 清空 domains 并再次导入
        await fs.remove(path.join(workdir, '.teamai', 'domains.yaml'));

        await sleep(20);
        await importFromRepo({
            url: TEST_URL,
            interactive: false,
        });

        const stat2 = await fs.stat(repoMdPath);
        const mtime2 = stat2.mtimeMs;

        // 关键断言：mtime 没有改变（跳过了写入）
        expect(mtime2).toBe(mtime1);

        // 文件内容也应字节级相同
        const content2 = await fs.readFile(repoMdPath, 'utf8');
        expect(content2).toBe(content1);
    });

    it('旧文件含未闭合锚点 → fallback 时备份旧文件、产物使用新 codebase', async () => {
        const repoMdPath = path.join(workdir, '.teamai', 'team-repo', 'docs', 'team-codebase', 'repos', 'github__owner__mergetest.md');
        await fs.ensureDir(path.dirname(repoMdPath));

        // 准备含未闭合锚点的旧文件
        const unclosedOldFile = [
            '# Old Content',
            '',
            '<!-- managed-by: import --from-repo, section: 项目概述, source: old@aabbccdd, syncedAt: 2024-01-01T00:00:00Z -->',
            '## 项目概述',
            '旧内容，这是旧内容。',
            // 故意缺少 <!-- /managed-by: 项目概述 --> 闭锚
        ].join('\n');

        await fs.writeFile(repoMdPath, unclosedOldFile, 'utf8');

        // 执行 importFromRepo，此时 parseSections 会因未闭合锚点抛错 → fallback
        await importFromRepo({
            url: TEST_URL,
            interactive: false,
        });

        // 1. 验证备份文件存在且内容等于旧文件
        const bakPath = `${repoMdPath}.bak`;
        expect(await fs.pathExists(bakPath)).toBe(true);
        const bakContent = await fs.readFile(bakPath, 'utf8');
        expect(bakContent).toBe(unclosedOldFile);

        // 2. 验证产物文件包含新 codebase 内容（fallback 全量重写）
        const newContent = await fs.readFile(repoMdPath, 'utf8');
        expect(newContent).toContain('项目概述');
        expect(newContent).toContain('固定的项目概述内容');
    });
});
