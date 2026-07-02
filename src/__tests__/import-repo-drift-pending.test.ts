// -*- coding: utf-8 -*-
/**
 * import-repo-drift-pending.test.ts — detectDomainDrift 扩展测试。
 *
 * 验证 drift 触发后同时写入 pending-review.jsonl，
 * 以及 24h 去重逻辑（仅移除 24h 内的旧项，不移除更早的）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

vi.mock('../review-store.js', () => ({
    loadPendingReview: vi.fn(),
    removePendingReview: vi.fn(),
    appendPendingReview: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────

import { detectDomainDrift } from '../import-repo.js';
import { recommendDomain } from '../domains/recommend.js';
import { appendHistory } from '../domains/store.js';
import {
    loadPendingReview,
    removePendingReview,
    appendPendingReview,
} from '../review-store.js';
import type { DomainsFile } from '../domains/index.js';
import type { PendingReviewItem } from '../review-store.js';

// ─── Helpers ────────────────────────────────────────────

function buildDomains(repoUrl: string, domainName: string, repoConfidence: number): DomainsFile {
    return {
        version: 1,
        confidence_threshold: 0.6,
        domains: [
            {
                name: domainName,
                description: '',
                confidence: 1.0,
                repos: [
                    { url: repoUrl, confidence: repoConfidence, signal: 'test', locked: false },
                ],
            },
        ],
    };
}

function makeDriftPendingItem(url: string, tsMs: number): PendingReviewItem {
    return {
        id: `drift-${tsMs}`,
        ts: new Date(tsMs).toISOString(),
        kind: 'domain-drift',
        target: { file: '.teamai/domains.yaml' },
        payload: { url, oldDomain: '推理', newRecommendedDomain: '平台' },
        source: 'drift-detector',
        risk: 'medium',
    };
}

// ─── Tests ──────────────────────────────────────────────

describe('detectDomainDrift + pending-review', () => {
    const TEST_URL = 'https://github.com/owner/testrepo';
    const OLD_SHA = 'oldsha001234567890abcdef1234567890abcdef';
    const NEW_SHA = 'newsha001234567890abcdef1234567890abcdef';
    const newMeta = { url: TEST_URL, name: 'testrepo' };
    const domains = buildDomains(TEST_URL, '推理', 0.5);

    beforeEach(() => {
        vi.mocked(appendHistory).mockClear();
        vi.mocked(recommendDomain).mockClear();
        vi.mocked(loadPendingReview).mockClear();
        vi.mocked(removePendingReview).mockClear();
        vi.mocked(appendPendingReview).mockClear();
        vi.mocked(appendPendingReview).mockResolvedValue({} as PendingReviewItem);
        vi.mocked(removePendingReview).mockResolvedValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('drift 触发后 appendPendingReview 被调用，payload 包含正确字段', async () => {
        vi.mocked(loadPendingReview).mockResolvedValue([]);
        vi.mocked(recommendDomain).mockResolvedValue({
            domain: '平台', confidence: 0.95, signal: 'README changed', alternatives: [],
        });

        await detectDomainDrift({
            cwd: '/fake/cwd', url: TEST_URL, newMeta, domains,
            oldSha: OLD_SHA, newSha: NEW_SHA,
        });

        expect(appendPendingReview).toHaveBeenCalledTimes(1);
        const call = vi.mocked(appendPendingReview).mock.calls[0]!;
        expect(call[1].kind).toBe('domain-drift');
        expect(call[1].payload['url']).toBe(TEST_URL);
        expect(call[1].payload['oldDomain']).toBe('推理');
        expect(call[1].payload['newRecommendedDomain']).toBe('平台');
        expect(call[1].payload['newConfidence']).toBe(0.95);
        expect(call[1].source).toBe('drift-detector');
    });

    it('24h 去重：仅移除 24h 内的旧项，25h 前的不移除', async () => {
        const now = Date.now();
        const item25hAgo = makeDriftPendingItem(TEST_URL, now - 25 * 3600 * 1000);
        const item1hAgo = makeDriftPendingItem(TEST_URL, now - 1 * 3600 * 1000);
        vi.mocked(loadPendingReview).mockResolvedValue([item25hAgo, item1hAgo]);

        vi.mocked(recommendDomain).mockResolvedValue({
            domain: '平台', confidence: 0.95, signal: 'test', alternatives: [],
        });

        await detectDomainDrift({
            cwd: '/fake/cwd', url: TEST_URL, newMeta, domains,
            oldSha: OLD_SHA, newSha: NEW_SHA,
        });

        // 1h 内的旧项应被移除，25h 前的不应被移除
        expect(removePendingReview).toHaveBeenCalledWith('/fake/cwd', item1hAgo.id);
        expect(removePendingReview).not.toHaveBeenCalledWith('/fake/cwd', item25hAgo.id);

        // 最终 appendPendingReview 依然被调用（新项写入）
        expect(appendPendingReview).toHaveBeenCalledTimes(1);
    });

    it('24h 去重：不同 url 的旧项不被移除', async () => {
        const now = Date.now();
        const itemOtherUrl = makeDriftPendingItem('https://github.com/other/repo', now - 1 * 3600 * 1000);
        vi.mocked(loadPendingReview).mockResolvedValue([itemOtherUrl]);

        vi.mocked(recommendDomain).mockResolvedValue({
            domain: '平台', confidence: 0.95, signal: 'test', alternatives: [],
        });

        await detectDomainDrift({
            cwd: '/fake/cwd', url: TEST_URL, newMeta, domains,
            oldSha: OLD_SHA, newSha: NEW_SHA,
        });

        // 不同 url 不应被移除
        expect(removePendingReview).not.toHaveBeenCalled();
        expect(appendPendingReview).toHaveBeenCalledTimes(1);
    });

    it('drift 未触发时 appendPendingReview 不被调用（同域）', async () => {
        vi.mocked(recommendDomain).mockResolvedValue({
            domain: '推理', confidence: 0.9, signal: 'same domain', alternatives: [],
        });

        await detectDomainDrift({
            cwd: '/fake/cwd', url: TEST_URL, newMeta, domains,
            oldSha: OLD_SHA, newSha: NEW_SHA,
        });

        expect(appendPendingReview).not.toHaveBeenCalled();
        expect(loadPendingReview).not.toHaveBeenCalled();
    });

    it('appendPendingReview 抛错 → 不阻塞主流程（不抛错）', async () => {
        vi.mocked(loadPendingReview).mockResolvedValue([]);
        vi.mocked(appendPendingReview).mockRejectedValue(new Error('disk full'));
        vi.mocked(recommendDomain).mockResolvedValue({
            domain: '平台', confidence: 0.95, signal: 'test', alternatives: [],
        });

        await expect(
            detectDomainDrift({
                cwd: '/fake/cwd', url: TEST_URL, newMeta, domains,
                oldSha: OLD_SHA, newSha: NEW_SHA,
            }),
        ).resolves.toBeUndefined();

        // appendHistory 依然被调用（不因 pending-review 失败而跳过）
        expect(appendHistory).toHaveBeenCalledTimes(1);
    });
});
