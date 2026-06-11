import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../clone.js', () => ({
    shallowClone: vi.fn().mockResolvedValue({
        sha: 'deadbeef1234567890abcdef1234567890abcdef',
        branch: 'main',
        cloneMethod: 'https-token',
    }),
}));

vi.mock('../codebase.js', () => ({
    generateCodebaseMd: vi.fn().mockResolvedValue('# Codebase\n\n生成的 codebase 文档内容\n'),
}));

vi.mock('../domains/recommend.js', () => ({
    recommendDomain: vi.fn().mockResolvedValue({
        domain: '推理',
        confidence: 0.84,
        signal: 'README 含 "推理服务"',
        alternatives: [{ domain: '平台', confidence: 0.42 }],
    }),
}));

vi.mock('../utils/prompt.js', () => ({
    askQuestion: vi.fn().mockResolvedValue('y'),
    askConfirmation: vi.fn().mockResolvedValue(true),
}));

// ─── Imports（after mocks）──────────────────────────────

import { importFromRepo, buildRepoMetaFromPath } from '../import-repo.js';
import { loadDomains } from '../domains/store.js';
import { shallowClone } from '../clone.js';
import { generateCodebaseMd } from '../codebase.js';
import { recommendDomain } from '../domains/recommend.js';
import { askQuestion } from '../utils/prompt.js';

// ─── Helpers ────────────────────────────────────────────

async function makeWorkdir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-import-repo-test-'));
    // 初始化 .teamai 目录（saveDomains 需要）
    await fs.ensureDir(path.join(tmpDir, '.teamai'));
    return tmpDir;
}

async function makeCacheDir(tmpDir: string, provider: string, owner: string, repo: string): Promise<string> {
    const cacheDir = path.join(tmpDir, 'cache', provider, owner, repo);
    await fs.ensureDir(cacheDir);
    return cacheDir;
}

// ─── Tests ──────────────────────────────────────────────

describe('importFromRepo', () => {
    let workdir: string;
    let originalCwd: string;
    let originalCacheDir: string | undefined;

    beforeEach(async () => {
        workdir = await makeWorkdir();
        originalCwd = process.cwd();
        process.chdir(workdir);

        // 把缓存目录也放在 tmpDir 下，避免污染真实 ~/.teamai
        originalCacheDir = process.env.TEAMAI_CACHE_DIR;
        process.env.TEAMAI_CACHE_DIR = path.join(workdir, 'cache');

        vi.clearAllMocks();

        // 默认：shallowClone 成功后缓存目录会存在（importFromRepo 需要读取其中文件）
        vi.mocked(shallowClone).mockImplementation(async (_url, localPath) => {
            await fs.ensureDir(localPath);
            return { sha: 'deadbeef1234567890abcdef', branch: 'main', cloneMethod: 'https-token' };
        });

        vi.mocked(generateCodebaseMd).mockResolvedValue('# Codebase\n内容\n');

        vi.mocked(recommendDomain).mockResolvedValue({
            domain: '推理',
            confidence: 0.84,
            signal: 'README 含推理服务',
            alternatives: [],
        });

        // 默认用户回答 Y
        vi.mocked(askQuestion).mockResolvedValue('y');

        // 模拟 TTY
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        if (originalCacheDir === undefined) {
            delete process.env.TEAMAI_CACHE_DIR;
        } else {
            process.env.TEAMAI_CACHE_DIR = originalCacheDir;
        }
        await fs.remove(workdir);
        vi.restoreAllMocks();
    });

    it('显式 --domain 模式：跳过推荐，直接写入对应域', async () => {
        await importFromRepo({
            url: 'https://github.com/org/inference-core',
            explicitDomain: '推理',
        });

        expect(recommendDomain).not.toHaveBeenCalled();

        const domains = await loadDomains(workdir);
        const inferDomain = domains.domains.find((d) => d.name === '推理');
        expect(inferDomain).toBeDefined();
        expect(inferDomain!.repos).toHaveLength(1);
        expect(inferDomain!.repos[0].url).toBe('https://github.com/org/inference-core');
    });

    it('显式 --domain 指向不存在的域 → 自动新建该域', async () => {
        await importFromRepo({
            url: 'https://github.com/org/new-service',
            explicitDomain: '全新业务域',
        });

        const domains = await loadDomains(workdir);
        const newDomain = domains.domains.find((d) => d.name === '全新业务域');
        expect(newDomain).toBeDefined();
        expect(newDomain!.repos[0].url).toBe('https://github.com/org/new-service');
    });

    it('AI 推荐 + 用户接受 → 写入 RepoEntry', async () => {
        vi.mocked(askQuestion).mockResolvedValue('y');

        await importFromRepo({ url: 'https://github.com/org/ai-engine' });

        expect(recommendDomain).toHaveBeenCalled();

        const domains = await loadDomains(workdir);
        const inferDomain = domains.domains.find((d) => d.name === '推理');
        expect(inferDomain).toBeDefined();
        expect(inferDomain!.repos[0].url).toBe('https://github.com/org/ai-engine');
        expect(inferDomain!.repos[0].confidence).toBeCloseTo(0.84);
    });

    it('AI 推荐 + 用户拒绝 (n) → 归入未分类并记录 reject_reason 到 history', async () => {
        // 第一次调用 askQuestion 是确认框，第二次是 reject reason
        vi.mocked(askQuestion)
            .mockResolvedValueOnce('n')          // 拒绝推荐
            .mockResolvedValueOnce('不符合该域');  // reject reason

        await importFromRepo({ url: 'https://github.com/org/rejected-repo' });

        const domains = await loadDomains(workdir);
        const unclassified = domains.domains.find((d) => d.name === '未分类');
        expect(unclassified).toBeDefined();
        expect(unclassified!.repos[0].url).toBe('https://github.com/org/rejected-repo');

        // 验证 history 中有 reject 记录
        const historyPath = path.join(workdir, '.teamai', 'domains.history.jsonl');
        const historyContent = await fs.readFile(historyPath, 'utf8');
        const lines = historyContent.trim().split('\n').filter(Boolean);
        const lastEvent = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
        expect(lastEvent.action).toBe('reject');
        expect((lastEvent.details as Record<string, unknown>).reject_reason).toBe('不符合该域');
    });

    it('url 重复（已在其他域）→ warn + 跳过，不重复添加', async () => {
        const existingUrl = 'https://github.com/org/existing-repo';

        // 先正常导入一次
        vi.mocked(askQuestion).mockResolvedValue('y');
        await importFromRepo({ url: existingUrl, explicitDomain: '平台' });

        const domainsAfterFirst = await loadDomains(workdir);
        const repoCountAfterFirst = domainsAfterFirst.domains
            .flatMap((d) => d.repos)
            .filter((r) => r.url === existingUrl).length;
        expect(repoCountAfterFirst).toBe(1);

        // 再次导入同一 url，应该跳过
        vi.clearAllMocks();
        vi.mocked(shallowClone).mockImplementation(async (_url, localPath) => {
            await fs.ensureDir(localPath);
            return { sha: 'deadbeef', branch: 'main', cloneMethod: 'https-anonymous' };
        });
        vi.mocked(generateCodebaseMd).mockResolvedValue('# Codebase\n');

        await importFromRepo({ url: existingUrl, explicitDomain: '推理' });

        const domainsAfterSecond = await loadDomains(workdir);
        const repoCountAfterSecond = domainsAfterSecond.domains
            .flatMap((d) => d.repos)
            .filter((r) => r.url === existingUrl).length;
        // 不应增加
        expect(repoCountAfterSecond).toBe(1);
    });

    it('dry-run 不写盘（domains.yaml 不变，产物文件不生成）', async () => {
        await importFromRepo({
            url: 'https://github.com/org/dry-run-repo',
            dryRun: true,
            explicitDomain: '推理',
        });

        // domains.yaml 应不存在或为空（未写入）
        const domainsPath = path.join(workdir, '.teamai', 'domains.yaml');
        const exists = await fs.pathExists(domainsPath);
        expect(exists).toBe(false);

        // 产物文件不应生成
        const repoMdPath = path.join(workdir, 'docs', 'team-codebase', 'repos');
        const repoMdExists = await fs.pathExists(repoMdPath);
        expect(repoMdExists).toBe(false);
    });

    it('非 TTY 直接归未分类（不调用 askQuestion）', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

        await importFromRepo({ url: 'https://github.com/org/non-tty-repo' });

        // 非 TTY 下不应调用 prompt
        expect(askQuestion).not.toHaveBeenCalled();

        const domains = await loadDomains(workdir);
        const unclassified = domains.domains.find((d) => d.name === '未分类');
        expect(unclassified).toBeDefined();
        expect(unclassified!.repos[0].url).toBe('https://github.com/org/non-tty-repo');
    });
});

describe('buildRepoMetaFromPath', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-repo-meta-test-'));
    });

    afterEach(async () => {
        await fs.remove(tmpDir);
    });

    it('读取 README.md 首段（不含标题前缀）', async () => {
        await fs.writeFile(
            path.join(tmpDir, 'README.md'),
            '# My Project\n\n这是项目描述。提供推理服务。\n\n## 安装\n\n略。\n',
            'utf8',
        );

        const meta = await buildRepoMetaFromPath(tmpDir, 'https://github.com/org/test', 'test');
        expect(meta.readme_excerpt).toContain('这是项目描述');
        expect(meta.readme_excerpt).not.toContain('# My Project');
    });

    it('读取 package.json description 和 keywords', async () => {
        await fs.writeJSON(path.join(tmpDir, 'package.json'), {
            name: 'test-pkg',
            description: '测试包描述',
            keywords: ['ai', 'inference'],
        });

        const meta = await buildRepoMetaFromPath(tmpDir, 'https://github.com/org/test', 'test');
        expect(meta.description).toBe('测试包描述');
        expect(meta.keywords).toEqual(['ai', 'inference']);
    });

    it('无 README 和 package.json 时元数据为空但不报错', async () => {
        const meta = await buildRepoMetaFromPath(tmpDir, 'https://github.com/org/empty', 'empty');
        expect(meta.url).toBe('https://github.com/org/empty');
        expect(meta.name).toBe('empty');
        expect(meta.readme_excerpt).toBeUndefined();
        expect(meta.description).toBeUndefined();
    });

    it('Python 项目读取 setup.py description', async () => {
        await fs.writeFile(
            path.join(tmpDir, 'setup.py'),
            'setup(name="svc", description="Python 推理服务", version="1.0")\n',
            'utf8',
        );

        const meta = await buildRepoMetaFromPath(tmpDir, 'https://github.com/org/py-svc', 'py-svc');
        expect(meta.description).toBe('Python 推理服务');
    });

    it('检测主要语言（TypeScript 文件最多）', async () => {
        await fs.writeFile(path.join(tmpDir, 'a.ts'), '');
        await fs.writeFile(path.join(tmpDir, 'b.ts'), '');
        await fs.writeFile(path.join(tmpDir, 'c.ts'), '');
        await fs.writeFile(path.join(tmpDir, 'd.py'), '');

        const meta = await buildRepoMetaFromPath(tmpDir, 'https://github.com/org/ts-proj', 'ts-proj');
        expect(meta.primary_language).toBe('TypeScript');
    });
});
