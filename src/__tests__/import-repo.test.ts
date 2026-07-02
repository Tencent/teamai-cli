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

vi.mock('../config.js', () => ({
    autoDetectInit: vi.fn().mockRejectedValue(new Error('not initialized in test')),
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
