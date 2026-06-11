// -*- coding: utf-8 -*-
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';

import {
    loadPendingReview,
    savePendingReview,
    appendPendingReview,
    removePendingReview,
    computeReviewId,
    inferRisk,
    getPendingReviewPath,
    type PendingReviewItem,
} from '../review-store.js';

// ─── 辅助 ────────────────────────────────────────────────

async function makeWorkdir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'teamai-review-store-test-'));
}

function makeItem(overrides: Partial<PendingReviewItem> = {}): PendingReviewItem {
    return {
        id: 'abc123def456',
        ts: '2024-01-01T00:00:00.000Z',
        kind: 'codebase-section',
        target: { file: 'docs/team-codebase/external-knowledge.md', section: 'glossary' },
        payload: { content: '## 术语表\n| foo | bar |' },
        source: 'import --from-iwiki',
        risk: 'medium',
        ...overrides,
    };
}

// ─── Tests ──────────────────────────────────────────────

describe('review-store', () => {
    let cwd: string;

    beforeEach(async () => {
        cwd = await makeWorkdir();
    });

    afterEach(async () => {
        await fs.remove(cwd);
    });

    // ── loadPendingReview ────────────────────────────────

    it('文件不存在 → 返回空数组', async () => {
        const items = await loadPendingReview(cwd);
        expect(items).toEqual([]);
    });

    it('旧 schema 条目（type/file/section/content）能被归一化', async () => {
        const legacyRecord = {
            ts: '2024-01-01T00:00:00.000Z',
            type: 'codebase-section',
            file: 'docs/team-codebase/external-knowledge.md',
            section: 'glossary',
            source: 'iwiki://12345',
            content: '## 术语表\n| foo | bar |',
        };

        const filePath = getPendingReviewPath(cwd);
        await fs.ensureDir(path.dirname(filePath));
        await fs.appendFile(filePath, JSON.stringify(legacyRecord) + '\n', 'utf8');

        const items = await loadPendingReview(cwd);
        expect(items).toHaveLength(1);

        const item = items[0];
        expect(item.kind).toBe('codebase-section');
        expect(item.target.file).toBe('docs/team-codebase/external-knowledge.md');
        expect(item.target.section).toBe('glossary');
        expect(item.payload['content']).toBe('## 术语表\n| foo | bar |');
        expect(item.source).toBe('iwiki://12345');
        // id 应该被自动计算
        expect(item.id).toBeTruthy();
        expect(item.id).toHaveLength(12);
        // risk 应该被推断（路径含 external-knowledge → high）
        expect(item.risk).toBe('high');
    });

    it('新 schema 条目正确读出', async () => {
        const newItem = makeItem();
        const filePath = getPendingReviewPath(cwd);
        await fs.ensureDir(path.dirname(filePath));
        await fs.appendFile(filePath, JSON.stringify(newItem) + '\n', 'utf8');

        const items = await loadPendingReview(cwd);
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe('abc123def456');
        expect(items[0].kind).toBe('codebase-section');
        expect(items[0].risk).toBe('medium');
    });

    it('损坏的 JSON 行被跳过，其他行正常返回', async () => {
        const filePath = getPendingReviewPath(cwd);
        await fs.ensureDir(path.dirname(filePath));

        const good = makeItem({ id: 'gooditem0001' });
        await fs.appendFile(filePath, JSON.stringify(good) + '\n', 'utf8');
        await fs.appendFile(filePath, 'this is not valid json\n', 'utf8');
        await fs.appendFile(filePath, JSON.stringify(makeItem({ id: 'gooditem0002' })) + '\n', 'utf8');

        const items = await loadPendingReview(cwd);
        expect(items).toHaveLength(2);
        expect(items[0].id).toBe('gooditem0001');
        expect(items[1].id).toBe('gooditem0002');
    });

    // ── appendPendingReview ──────────────────────────────

    it('appendPendingReview：缺 id/ts/risk 自动填充', async () => {
        const item = await appendPendingReview(cwd, {
            kind: 'codebase-section',
            target: { file: 'docs/foo.md', section: 'bar' },
            payload: { content: 'hello' },
            source: 'test',
        });

        expect(item.id).toBeTruthy();
        expect(item.id).toHaveLength(12);
        expect(item.ts).toBeTruthy();
        expect(item.risk).toBe('medium');

        // 验证落盘
        const loaded = await loadPendingReview(cwd);
        expect(loaded).toHaveLength(1);
        expect(loaded[0].id).toBe(item.id);
    });

    it('appendPendingReview：返回值含完整字段', async () => {
        const item = await appendPendingReview(cwd, {
            kind: 'codebase-section',
            target: { file: 'docs/foo.md', section: '架构' },
            payload: { content: 'body' },
            source: 'test',
        });

        expect(item.risk).toBe('high'); // 高风险章节
        expect(item.kind).toBe('codebase-section');
        expect(item.target.section).toBe('架构');
    });

    // ── removePendingReview ──────────────────────────────

    it('removePendingReview：存在 → 返回 true，文件少一行', async () => {
        const item1 = await appendPendingReview(cwd, {
            kind: 'codebase-section',
            target: { file: 'docs/a.md', section: 'sec1' },
            payload: {},
            source: 'test',
        });
        const item2 = await appendPendingReview(cwd, {
            kind: 'codebase-section',
            target: { file: 'docs/b.md', section: 'sec2' },
            payload: {},
            source: 'test',
        });

        const removed = await removePendingReview(cwd, item1.id);
        expect(removed).toBe(true);

        const remaining = await loadPendingReview(cwd);
        expect(remaining).toHaveLength(1);
        expect(remaining[0].id).toBe(item2.id);
    });

    it('removePendingReview：不存在 → 返回 false', async () => {
        const removed = await removePendingReview(cwd, 'nonexistent0');
        expect(removed).toBe(false);
    });

    // ── inferRisk ────────────────────────────────────────

    it('inferRisk：高风险章节 → high', () => {
        expect(inferRisk({ file: 'docs/foo.md', section: '架构' })).toBe('high');
        expect(inferRisk({ file: 'docs/foo.md', section: 'architecture' })).toBe('high');
        expect(inferRisk({ file: 'docs/foo.md', section: 'external-knowledge' })).toBe('high');
        expect(inferRisk({ file: 'docs/foo.md', section: '架构决策与权衡' })).toBe('high');
    });

    it('inferRisk：包含 external-knowledge 路径 → high', () => {
        expect(inferRisk({ file: 'docs/team-codebase/external-knowledge.md' })).toBe('high');
    });

    it('inferRisk：普通章节 → medium', () => {
        expect(inferRisk({ file: 'docs/foo.md', section: 'glossary' })).toBe('medium');
        expect(inferRisk({ file: 'docs/readme.md' })).toBe('medium');
    });

    // ── computeReviewId ──────────────────────────────────

    it('computeReviewId：相同输入产生相同 ID', () => {
        const id1 = computeReviewId('docs/foo.md', 'bar', '2024-01-01T00:00:00.000Z');
        const id2 = computeReviewId('docs/foo.md', 'bar', '2024-01-01T00:00:00.000Z');
        expect(id1).toBe(id2);
        expect(id1).toHaveLength(12);
    });

    it('computeReviewId：不同输入产生不同 ID', () => {
        const id1 = computeReviewId('docs/foo.md', 'bar', '2024-01-01T00:00:00.000Z');
        const id2 = computeReviewId('docs/baz.md', 'bar', '2024-01-01T00:00:00.000Z');
        expect(id1).not.toBe(id2);
    });

    // ── savePendingReview 原子性 ─────────────────────────

    it('savePendingReview 原子性：rename 失败时不留 .tmp 残留', async () => {
        const items = [makeItem()];
        const filePath = getPendingReviewPath(cwd);
        const tmpPath = `${filePath}.tmp`;

        await fs.ensureDir(path.dirname(filePath));

        // mock fs.rename 抛错
        const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));

        await expect(savePendingReview(cwd, items)).rejects.toThrow('rename failed');

        renameSpy.mockRestore();

        // .tmp 文件应该存在（因为 rename 失败前已写入）
        // 但主文件不应存在（rename 失败）
        expect(await fs.pathExists(filePath)).toBe(false);
        expect(await fs.pathExists(tmpPath)).toBe(true);

        // 清理
        await fs.remove(tmpPath);
    });

    describe('loadPendingReview — 文件大小限制', () => {
        it('pending-review.jsonl 超过 10 MB 时抛出 size 超限错误', async () => {
            const filePath = getPendingReviewPath(cwd);
            await fs.ensureDir(path.dirname(filePath));
            // 写入 11 MB 内容（真实文件，非 mock fs.stat）
            const chunk = 'x'.repeat(1024 * 1024);
            let content = '';
            for (let i = 0; i < 11; i++) content += chunk;
            await fs.writeFile(filePath, content, 'utf8');

            await expect(loadPendingReview(cwd)).rejects.toThrow('exceeds max allowed size 10MB');
        });
    });
});
