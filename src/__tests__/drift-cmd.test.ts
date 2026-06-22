// -*- coding: utf-8 -*-
/**
 * drift-cmd.test.ts — driftCmd 单元测试。
 */

import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../review-store.js', () => ({
    loadPendingReview: vi.fn(),
    removePendingReview: vi.fn(),
    appendPendingReview: vi.fn(),
}));

vi.mock('../domains/index.js', () => ({
    loadDomains: vi.fn(),
    saveDomains: vi.fn(),
    appendHistory: vi.fn(),
}));

vi.mock('../aggregate.js', () => ({
    regenerateAggregate: vi.fn(),
}));

vi.mock('../utils/team-codebase-paths.js', () => ({
    getTeamCodebasePaths: vi.fn().mockReturnValue({ reposDir: '/fake/repos', aggregateFile: '/fake/agg.md' }),
}));

vi.mock('../utils/prompt.js', () => ({
    askConfirmation: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
    log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

// ─── Imports (after mocks) ───────────────────────────────

import { driftCmd } from '../drift-cmd.js';
import {
    loadPendingReview,
    removePendingReview,
} from '../review-store.js';
import {
    loadDomains,
    saveDomains,
    appendHistory,
} from '../domains/index.js';
import { regenerateAggregate } from '../aggregate.js';
import { askConfirmation } from '../utils/prompt.js';
import type { PendingReviewItem } from '../review-store.js';
import type { DomainsFile } from '../domains/index.js';

// ─── Helpers ────────────────────────────────────────────

function makeDriftItem(overrides: Partial<PendingReviewItem> = {}): PendingReviewItem {
    return {
        id: 'test-id-001',
        ts: new Date().toISOString(),
        kind: 'domain-drift',
        target: { file: '.teamai/domains.yaml' },
        payload: {
            url: 'https://github.com/team/myrepo',
            oldDomain: '推理',
            newRecommendedDomain: '平台',
            oldConfidence: 0.5,
            newConfidence: 0.9,
            signal: 'README changed',
            oldSha: 'abc',
            newSha: 'def',
        },
        source: 'drift-detector',
        risk: 'medium',
        ...overrides,
    };
}

function makeDomains(domainName: string, repoUrl: string): DomainsFile {
    return {
        version: 1,
        confidence_threshold: 0.6,
        domains: [
            {
                name: domainName,
                description: '',
                confidence: 1.0,
                repos: [
                    { url: repoUrl, confidence: 0.5, signal: 'test', locked: false },
                ],
            },
            {
                name: '平台',
                description: '',
                confidence: 1.0,
                repos: [],
            },
        ],
    };
}

// ─── Tests ──────────────────────────────────────────────

describe('driftCmd', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(loadPendingReview).mockResolvedValue([]);
        vi.mocked(removePendingReview).mockResolvedValue(true);
        vi.mocked(loadDomains).mockResolvedValue(makeDomains('推理', 'https://github.com/team/myrepo'));
        vi.mocked(saveDomains).mockResolvedValue(undefined);
        vi.mocked(appendHistory).mockResolvedValue(undefined);
        vi.mocked(regenerateAggregate).mockResolvedValue({ filesWritten: [], errors: [] } as never);
        vi.mocked(askConfirmation).mockResolvedValue(true);
    });

    it('list 模式：无 repoUrlArg + 无 applyAll → 渲染漂移项（不调 applyOne）', async () => {
        const item = makeDriftItem();
        vi.mocked(loadPendingReview).mockResolvedValue([item]);

        await driftCmd({ skipAggregate: true });

        expect(loadPendingReview).toHaveBeenCalledTimes(1);
        expect(saveDomains).not.toHaveBeenCalled();
    });

    it('apply 单条 + 新域已存在 → 移动 repo / appendHistory / removePendingReview / regenerateAggregate', async () => {
        const item = makeDriftItem();
        vi.mocked(loadPendingReview).mockResolvedValue([item]);

        await driftCmd({
            repoUrlArg: 'https://github.com/team/myrepo',
            apply: true,
        });

        expect(saveDomains).toHaveBeenCalledTimes(1);
        const savedDomains = vi.mocked(saveDomains).mock.calls[0]![1] as DomainsFile;
        // 旧域 repos 应为空
        const oldEntry = savedDomains.domains.find((d) => d.name === '推理');
        expect(oldEntry?.repos).toHaveLength(0);
        // 新域应有 entry
        const newEntry = savedDomains.domains.find((d) => d.name === '平台');
        expect(newEntry?.repos).toHaveLength(1);
        expect(newEntry?.repos[0]?.url).toBe('https://github.com/team/myrepo');

        expect(appendHistory).toHaveBeenCalledTimes(1);
        expect(vi.mocked(appendHistory).mock.calls[0]![1].action).toBe('reassign');

        expect(removePendingReview).toHaveBeenCalledWith(expect.anything(), 'test-id-001');
        expect(regenerateAggregate).toHaveBeenCalledTimes(1);
    });

    it('apply 单条 + 新域不存在 + askConfirmation true → 自动新建域', async () => {
        const domains = makeDomains('推理', 'https://github.com/team/myrepo');
        // 移除平台域
        domains.domains = domains.domains.filter((d) => d.name !== '平台');
        vi.mocked(loadDomains).mockResolvedValue(domains);

        const item = makeDriftItem();
        vi.mocked(loadPendingReview).mockResolvedValue([item]);
        vi.mocked(askConfirmation).mockResolvedValue(true);

        // 模拟 TTY 环境
        const originalIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

        await driftCmd({
            repoUrlArg: 'https://github.com/team/myrepo',
            apply: true,
            skipAggregate: true,
        });

        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });

        expect(saveDomains).toHaveBeenCalledTimes(1);
        const savedDomains = vi.mocked(saveDomains).mock.calls[0]![1] as DomainsFile;
        const newEntry = savedDomains.domains.find((d) => d.name === '平台');
        expect(newEntry).toBeDefined();
        expect(newEntry?.repos).toHaveLength(1);
    });

    it('apply 单条 + 新域不存在 + 非 TTY → 报错跳过', async () => {
        const domains = makeDomains('推理', 'https://github.com/team/myrepo');
        domains.domains = domains.domains.filter((d) => d.name !== '平台');
        vi.mocked(loadDomains).mockResolvedValue(domains);

        const item = makeDriftItem();
        vi.mocked(loadPendingReview).mockResolvedValue([item]);

        const originalIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

        const originalExitCode = process.exitCode;
        await driftCmd({
            repoUrlArg: 'https://github.com/team/myrepo',
            apply: true,
            skipAggregate: true,
        });
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
        process.exitCode = originalExitCode;

        // 非 TTY 下不应写入
        expect(saveDomains).not.toHaveBeenCalled();
    });

    it('lock：repos[i].locked = true，相关 drift 被移除', async () => {
        const item = makeDriftItem();
        vi.mocked(loadPendingReview).mockResolvedValue([item]);

        await driftCmd({
            repoUrlArg: 'https://github.com/team/myrepo',
            lock: true,
            skipAggregate: true,
        });

        expect(saveDomains).toHaveBeenCalledTimes(1);
        const savedDomains = vi.mocked(saveDomains).mock.calls[0]![1] as DomainsFile;
        const domainEntry = savedDomains.domains.find((d) => d.name === '推理');
        expect(domainEntry?.repos[0]?.locked).toBe(true);

        expect(appendHistory).toHaveBeenCalledTimes(1);
        expect(vi.mocked(appendHistory).mock.calls[0]![1].action).toBe('lock');

        expect(removePendingReview).toHaveBeenCalledWith(expect.anything(), 'test-id-001');
    });

    it('apply-all + threshold=0.7 → 应用 confidence > 0.7 的项；低于阈值的跳过', async () => {
        const highConf = makeDriftItem({
            id: 'id-high',
            payload: {
                url: 'https://github.com/team/myrepo',
                oldDomain: '推理',
                newRecommendedDomain: '平台',
                oldConfidence: 0.5,
                newConfidence: 0.85,
                signal: 'high',
                oldSha: 'abc',
                newSha: 'def',
            },
        });
        const lowConf = makeDriftItem({
            id: 'id-low',
            payload: {
                url: 'https://github.com/team/other',
                oldDomain: '推理',
                newRecommendedDomain: '平台',
                oldConfidence: 0.5,
                newConfidence: 0.6,
                signal: 'low',
                oldSha: 'abc',
                newSha: 'def',
            },
        });
        vi.mocked(loadPendingReview).mockResolvedValue([highConf, lowConf]);

        await driftCmd({
            applyAll: true,
            threshold: '0.7',
            skipAggregate: true,
            json: true,
        });

        // 仅 highConf 被 apply，lowConf 被跳过
        expect(saveDomains).toHaveBeenCalledTimes(1);
        expect(removePendingReview).toHaveBeenCalledWith(expect.anything(), 'id-high');
        expect(removePendingReview).not.toHaveBeenCalledWith(expect.anything(), 'id-low');
    });

    it('apply-all：单条失败不阻塞批量', async () => {
        const item1 = makeDriftItem({
            id: 'id-1',
            payload: {
                url: 'https://github.com/team/myrepo',
                oldDomain: '不存在的域',
                newRecommendedDomain: '平台',
                oldConfidence: 0.5,
                newConfidence: 0.9,
                signal: 'test',
                oldSha: 'abc',
                newSha: 'def',
            },
        });
        const item2 = makeDriftItem({
            id: 'id-2',
            payload: {
                url: 'https://github.com/team/myrepo',
                oldDomain: '推理',
                newRecommendedDomain: '平台',
                oldConfidence: 0.5,
                newConfidence: 0.85,
                signal: 'test',
                oldSha: 'abc',
                newSha: 'def',
            },
        });
        vi.mocked(loadPendingReview).mockResolvedValue([item1, item2]);

        // 第一次 loadDomains 给失败域，第二次正常
        vi.mocked(loadDomains)
            .mockResolvedValueOnce(makeDomains('推理', 'https://github.com/team/myrepo'))
            .mockResolvedValueOnce(makeDomains('推理', 'https://github.com/team/myrepo'));

        await driftCmd({
            applyAll: true,
            threshold: '0.7',
            skipAggregate: true,
            json: true,
        });

        // item1 失败（旧域不存在），item2 成功
        expect(saveDomains).toHaveBeenCalledTimes(1);
        expect(removePendingReview).toHaveBeenCalledWith(expect.anything(), 'id-2');
        expect(removePendingReview).not.toHaveBeenCalledWith(expect.anything(), 'id-1');
    });
});
