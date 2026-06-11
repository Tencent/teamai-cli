import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../clone.js', () => ({
    shallowClone: vi.fn(),
    shallowFetch: vi.fn(),
}));

vi.mock('../codebase.js', () => ({
    generateCodebaseMd: vi.fn().mockResolvedValue('# Codebase\n\n生成的 codebase 文档内容\n'),
}));

vi.mock('../domains/recommend.js', () => ({
    recommendDomain: vi.fn().mockResolvedValue({
        domain: '推理',
        confidence: 0.84,
        signal: 'README 含 "推理服务"',
        alternatives: [],
    }),
}));

vi.mock('../utils/prompt.js', () => ({
    askQuestion: vi.fn().mockResolvedValue('y'),
    askConfirmation: vi.fn().mockResolvedValue(true),
}));

// ─── Imports (after mocks) ───────────────────────────────

import { importFromRepo } from '../import-repo.js';
import { shallowClone, shallowFetch } from '../clone.js';
import { loadDomains } from '../domains/store.js';
import { generateCodebaseMd } from '../codebase.js';
import { recommendDomain } from '../domains/recommend.js';

// ─── Constants ──────────────────────────────────────────

const CLONE_SHA = 'deadbeef1234567890abcdef1234567890abcdef';
const FETCH_SHA = 'cafebabe1234567890abcdef1234567890abcdef';

// ─── Helpers ────────────────────────────────────────────

async function makeWorkdir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-incremental-test-'));
    await fs.ensureDir(path.join(tmpDir, '.teamai'));
    return tmpDir;
}

async function makeFakeCache(
    baseDir: string,
    provider: string,
    owner: string,
    repo: string,
    sha: string,
): Promise<string> {
    const cacheDir = path.join(baseDir, 'cache', provider, owner, repo);
    await fs.ensureDir(path.join(cacheDir, '.git'));
    const isoTs = new Date().toISOString();
    await fs.writeFile(path.join(cacheDir, 'LAST_SYNC'), `${sha}\n${isoTs}\n`, 'utf8');
    return cacheDir;
}

// ─── Tests ──────────────────────────────────────────────

describe('importFromRepo — incremental mode', () => {
    let workdir: string;
    const FAKE_OLD_SHA = 'oldsha0001234567890abcdef1234567890abcdef';
    const TEST_URL = 'https://github.com/owner/testrepo';

    beforeEach(async () => {
        workdir = await makeWorkdir();
        vi.spyOn(process, 'cwd').mockReturnValue(workdir);
        process.env.TEAMAI_CACHE_DIR = path.join(workdir, 'cache');

        vi.mocked(shallowClone).mockImplementation(async (_url: string, localPath: string) => {
            await fs.ensureDir(localPath);
            return { sha: CLONE_SHA, branch: 'main', cloneMethod: 'https-token' as const };
        });

        vi.mocked(shallowFetch).mockImplementation(async (localPath: string) => {
            await fs.ensureDir(localPath);
            return { sha: FETCH_SHA };
        });

        vi.mocked(generateCodebaseMd).mockResolvedValue('# Codebase\n\n生成的 codebase 文档内容\n');

        vi.mocked(recommendDomain).mockResolvedValue({
            domain: '推理',
            confidence: 0.84,
            signal: 'README 含 "推理服务"',
            alternatives: [],
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        delete process.env.TEAMAI_CACHE_DIR;
        await fs.remove(workdir);
    });

    it('缓存不存在时走全量 clone，不调 shallowFetch', async () => {
        await importFromRepo({
            url: TEST_URL,
            incremental: true,
            interactive: false,
        });

        expect(shallowClone).toHaveBeenCalledTimes(1);
        expect(shallowFetch).not.toHaveBeenCalled();
    });

    it('缓存存在 + LAST_SYNC + incremental=true → 走 fetch，不调 shallowClone', async () => {
        await makeFakeCache(workdir, 'github', 'owner', 'testrepo', FAKE_OLD_SHA);

        await importFromRepo({
            url: TEST_URL,
            incremental: true,
            interactive: false,
        });

        expect(shallowFetch).toHaveBeenCalledTimes(1);
        expect(shallowClone).not.toHaveBeenCalled();
    });

    it('增量 fetch 失败时 fallback 到 shallowClone', async () => {
        await makeFakeCache(workdir, 'github', 'owner', 'testrepo', FAKE_OLD_SHA);
        vi.mocked(shallowFetch).mockRejectedValueOnce(new Error('network error'));

        await importFromRepo({
            url: TEST_URL,
            incremental: true,
            interactive: false,
        });

        expect(shallowFetch).toHaveBeenCalledTimes(1);
        expect(shallowClone).toHaveBeenCalledTimes(1);
    });

    it('incremental=false 时即使有缓存也走全量 clone', async () => {
        await makeFakeCache(workdir, 'github', 'owner', 'testrepo', FAKE_OLD_SHA);

        await importFromRepo({
            url: TEST_URL,
            incremental: false,
            interactive: false,
        });

        expect(shallowClone).toHaveBeenCalledTimes(1);
        expect(shallowFetch).not.toHaveBeenCalled();
    });

    it('全量 clone 后写入 LAST_SYNC', async () => {
        await importFromRepo({
            url: TEST_URL,
            incremental: false,
            interactive: false,
        });

        const lastSyncPath = path.join(workdir, 'cache', 'github', 'owner', 'testrepo', 'LAST_SYNC');
        const exists = await fs.pathExists(lastSyncPath);
        expect(exists).toBe(true);
        const content = await fs.readFile(lastSyncPath, 'utf8');
        expect(content).toContain('deadbeef');
    });

    it('增量模式下仓库已在域中：更新 LAST_SYNC 并返回', async () => {
        const domainsYaml = [
            'version: 1',
            'confidence_threshold: 0.6',
            'domains:',
            '  - name: 推理',
            '    description: ""',
            '    repos:',
            `      - url: "${TEST_URL}"`,
            '        confidence: 0.84',
            '        signal: test',
            '        locked: false',
        ].join('\n');
        await fs.writeFile(path.join(workdir, '.teamai', 'domains.yaml'), domainsYaml, 'utf8');
        await makeFakeCache(workdir, 'github', 'owner', 'testrepo', FAKE_OLD_SHA);

        await importFromRepo({
            url: TEST_URL,
            incremental: true,
            interactive: false,
        });

        expect(shallowFetch).toHaveBeenCalledTimes(1);
        const lastSyncPath = path.join(workdir, 'cache', 'github', 'owner', 'testrepo', 'LAST_SYNC');
        const content = await fs.readFile(lastSyncPath, 'utf8');
        expect(content).toContain('cafebabe');

        // domains.yaml 中不应新增条目
        const domains = await loadDomains(workdir);
        const domainEntry = domains.domains.find((d) => d.name === '推理');
        expect(domainEntry?.repos).toHaveLength(1);
    });
});
