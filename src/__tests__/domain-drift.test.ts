import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../domains/recommend.js', () => ({
    recommendDomain: vi.fn(),
}));

vi.mock('../domains/store.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../domains/store.js')>();
    return {
        ...actual,
        appendHistory: vi.fn().mockResolvedValue(undefined),
    };
});

// ─── Imports (after mocks) ───────────────────────────────

import { detectDomainDrift } from '../import-repo.js';
import { recommendDomain } from '../domains/recommend.js';
import { appendHistory } from '../domains/store.js';
import type { DomainsFile } from '../domains/index.js';

// ─── Helpers ────────────────────────────────────────────

function buildDomains(
    repoUrl: string,
    domainName: string,
    repoConfidence: number,
): DomainsFile {
    return {
        version: 1,
        confidence_threshold: 0.6,
        domains: [
            {
                name: domainName,
                description: '',
                repos: [
                    { url: repoUrl, confidence: repoConfidence, signal: 'test', locked: false },
                ],
            },
        ],
    };
}

async function makeWorkdir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-drift-test-'));
    await fs.ensureDir(path.join(tmpDir, '.teamai'));
    return tmpDir;
}

// ─── Tests ──────────────────────────────────────────────

describe('detectDomainDrift', () => {
    let workdir: string;
    const TEST_URL = 'https://github.com/owner/testrepo';
    const OLD_SHA = 'oldsha0001234567890abcdef1234567890abcdef';
    const NEW_SHA = 'newsha0001234567890abcdef1234567890abcdef';
    const newMeta = { url: TEST_URL, name: 'testrepo' };

    beforeEach(async () => {
        workdir = await makeWorkdir();
        vi.mocked(appendHistory).mockClear();
        vi.mocked(recommendDomain).mockClear();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await fs.remove(workdir);
    });

    it('oldSha 为 null 时不报告（非增量场景）', async () => {
        const domains = buildDomains(TEST_URL, '推理', 0.84);
        vi.mocked(recommendDomain).mockResolvedValue({
            domain: '平台', confidence: 0.9, signal: 'test', alternatives: [],
        });

        await detectDomainDrift({
            cwd: workdir, url: TEST_URL, newMeta, domains,
            oldSha: null, newSha: NEW_SHA,
        });

        expect(appendHistory).not.toHaveBeenCalled();
    });

    it('推荐域与当前域相同 → 不报告', async () => {
        const domains = buildDomains(TEST_URL, '推理', 0.84);
        vi.mocked(recommendDomain).mockResolvedValue({
            domain: '推理', confidence: 0.9, signal: 'test', alternatives: [],
        });

        await detectDomainDrift({
            cwd: workdir, url: TEST_URL, newMeta, domains,
            oldSha: OLD_SHA, newSha: NEW_SHA,
        });

        expect(appendHistory).not.toHaveBeenCalled();
    });

    it('推荐不同域 + confidence > 0.5 + 偏差 > 0.4 → appendHistory 被调', async () => {
        const domains = buildDomains(TEST_URL, '推理', 0.5);
        vi.mocked(recommendDomain).mockResolvedValue({
            domain: '平台', confidence: 0.95, signal: 'README changed', alternatives: [],
        });

        await detectDomainDrift({
            cwd: workdir, url: TEST_URL, newMeta, domains,
            oldSha: OLD_SHA, newSha: NEW_SHA,
        });

        expect(appendHistory).toHaveBeenCalledTimes(1);
        const callArg = vi.mocked(appendHistory).mock.calls[0]![1];
        expect(callArg.action).toBe('recommend');
        expect(callArg.details.kind).toBe('drift');
        expect(callArg.details.oldDomain).toBe('推理');
        expect(callArg.details.newRecommendedDomain).toBe('平台');
    });

    it('推荐不同域但 confidence <= 0.5 → 不报告', async () => {
        const domains = buildDomains(TEST_URL, '推理', 0.84);
        vi.mocked(recommendDomain).mockResolvedValue({
            domain: '平台', confidence: 0.45, signal: 'low confidence', alternatives: [],
        });

        await detectDomainDrift({
            cwd: workdir, url: TEST_URL, newMeta, domains,
            oldSha: OLD_SHA, newSha: NEW_SHA,
        });

        expect(appendHistory).not.toHaveBeenCalled();
    });

    it('推荐不同域但偏差 <= 0.4 → 不报告', async () => {
        const domains = buildDomains(TEST_URL, '推理', 0.75);
        // confidence 差值 = |0.9 - 0.75| = 0.15 <= 0.4
        vi.mocked(recommendDomain).mockResolvedValue({
            domain: '平台', confidence: 0.9, signal: 'small diff', alternatives: [],
        });

        await detectDomainDrift({
            cwd: workdir, url: TEST_URL, newMeta, domains,
            threshold: 0.4,
            oldSha: OLD_SHA, newSha: NEW_SHA,
        });

        expect(appendHistory).not.toHaveBeenCalled();
    });

    it('url 不在任何域中 → 跳过（不调 recommendDomain）', async () => {
        const domains: DomainsFile = {
            version: 1,
            confidence_threshold: 0.6,
            domains: [
                { name: '推理', description: '', repos: [] },
            ],
        };

        await detectDomainDrift({
            cwd: workdir, url: TEST_URL, newMeta, domains,
            oldSha: OLD_SHA, newSha: NEW_SHA,
        });

        expect(recommendDomain).not.toHaveBeenCalled();
        expect(appendHistory).not.toHaveBeenCalled();
    });

    it('recommendDomain 抛错 → 不阻塞主流程（不抛错）', async () => {
        const domains = buildDomains(TEST_URL, '推理', 0.5);
        vi.mocked(recommendDomain).mockRejectedValue(new Error('AI timeout'));

        await expect(
            detectDomainDrift({
                cwd: workdir, url: TEST_URL, newMeta, domains,
                oldSha: OLD_SHA, newSha: NEW_SHA,
            }),
        ).resolves.toBeUndefined();

        expect(appendHistory).not.toHaveBeenCalled();
    });
});
