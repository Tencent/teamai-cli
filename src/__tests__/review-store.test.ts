// -*- coding: utf-8 -*-
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import { acquireLock, releaseLock } from '../update.js';

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

function signal(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

// ─── Tests ──────────────────────────────────────────────

describe('review-store', () => {
    let cwd: string;

    beforeEach(async () => {
        cwd = await makeWorkdir();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
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

    it('skips a null line and loads the lines around it', async () => {
        const filePath = getPendingReviewPath(cwd);
        await fs.ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, [
            JSON.stringify(makeItem({ id: 'beforenull01' })),
            'null',
            JSON.stringify(makeItem({ id: 'afternull001' })),
        ].join('\n') + '\n', 'utf8');

        const items = await loadPendingReview(cwd);
        expect(items.map((item) => item.id)).toEqual(['beforenull01', 'afternull001']);
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

    it.each(['append', 'remove'] as const)('keeps a concurrent %s when a removal has read the queue but not replaced it', async (operation) => {
        const first = makeItem({ id: 'first' });
        const second = makeItem({ id: 'second' });
        await savePendingReview(cwd, [first, second]);
        const filePath = getPendingReviewPath(cwd);
        const paused = signal();
        const resume = signal();
        const contended = signal();
        const rename = fs.rename.bind(fs);
        const readFile = fs.readFile.bind(fs);
        let held = false;

        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (String(to) === filePath && !held) {
                held = true;
                paused.resolve();
                await resume.promise;
            }
            return rename(from, to);
        });
        vi.spyOn(fs, 'readFile').mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
            if (held && String(args[0]) === `${filePath}.lock`) contended.resolve();
            return readFile(...args);
        }) as typeof fs.readFile);

        const removing = removePendingReview(cwd, first.id);
        await paused.promise;
        const concurrent = operation === 'append'
            ? appendPendingReview(cwd, makeItem({ id: 'third' }))
            : removePendingReview(cwd, second.id);
        try {
            // On main the second write finishes while the old snapshot is paused.
            // With locking it instead reaches the held lock, without touching the queue.
            await Promise.race([concurrent, contended.promise]);
        } finally {
            resume.resolve();
        }
        await Promise.all([removing, concurrent]);

        expect((await loadPendingReview(cwd)).map((item) => item.id)).toEqual(operation === 'append' ? ['second', 'third'] : []);
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

    it('keeps the queue, removes the temp and releases the lock when replacement fails', async () => {
        const item = makeItem();
        await savePendingReview(cwd, [item]);
        const filePath = getPendingReviewPath(cwd);
        const original = await fs.readFile(filePath, 'utf8');
        const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));

        await expect(removePendingReview(cwd, item.id)).rejects.toThrow('rename failed');
        renameSpy.mockRestore();

        expect(await fs.readFile(filePath, 'utf8')).toBe(original);
        expect(await fs.readdir(path.dirname(filePath))).toEqual(['pending-review.jsonl']);
        await appendPendingReview(cwd, makeItem({ id: 'after-failure' }));
        expect(await removePendingReview(cwd, item.id)).toBe(true);
        expect((await loadPendingReview(cwd)).map((entry) => entry.id)).toEqual(['after-failure']);
    });

    it('refuses every writer without changing the queue while its lock stays held', async () => {
        const item = makeItem();
        await savePendingReview(cwd, [item]);
        const filePath = getPendingReviewPath(cwd);
        const original = await fs.readFile(filePath, 'utf8');
        expect(await acquireLock(`${filePath}.lock`)).toBe(true);
        try {
            await Promise.all([
                expect(appendPendingReview(cwd, makeItem({ id: 'blocked' }))).rejects.toThrow('Another teamai command is changing'),
                expect(removePendingReview(cwd, item.id)).rejects.toThrow('Another teamai command is changing'),
                expect(savePendingReview(cwd, [])).rejects.toThrow('Another teamai command is changing'),
            ]);
            expect(await fs.readFile(filePath, 'utf8')).toBe(original);
        } finally {
            await releaseLock(`${filePath}.lock`);
        }
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
