// -*- coding: utf-8 -*-
/**
 * iwiki review apply 闭环 e2e 测试
 *
 * 验证从 importFromIWikiDual(requireReview:true) 写入 pending-review.jsonl，
 * 到 reviewCmd(apply:true) 将章节 patch 进 external-knowledge.md 的完整链路。
 * 关键点：patchManagedSection 必须能识别 --from-iwiki 锚点（Blocker 1 修复验证）。
 */

import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../utils/ai-client.js', () => ({
    callClaude: vi.fn(),
}));

vi.mock('../utils/iwiki-client.js', () => ({
    IWikiClient: vi.fn().mockImplementation(() => ({
        fetchAllPages: vi.fn().mockResolvedValue([
            { docid: '456', title: 'Test Wiki Page' },
        ]),
        getDocument: vi.fn().mockResolvedValue({
            docid: '456',
            title: 'Test Wiki Page',
            content: '这是测试内容，包含业务接口和外部知识',
        }),
    })),
}));

vi.mock('../utils/prompt.js', () => ({
    askQuestion: vi.fn().mockResolvedValue('y'),
    askConfirmation: vi.fn().mockResolvedValue(true),
}));

vi.mock('../domains/store.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../domains/store.js')>();
    return {
        ...actual,
        appendHistory: vi.fn().mockResolvedValue(undefined),
    };
});

// ─── Imports (after mocks) ───────────────────────────────

import { importFromIWikiDual } from '../iwiki-dual.js';
import { reviewCmd } from '../review-cmd.js';
import { loadPendingReview } from '../review-store.js';
import { callClaude } from '../utils/ai-client.js';

// ─── 常量 ────────────────────────────────────────────────

const AI_OUTPUT = JSON.stringify({
    'business-api': '## 业务接口\n已更新的业务接口内容',
    'external-knowledge': '## 外部知识\n已更新的外部知识内容，由 iwiki 导入',
    'glossary': '| 术语 | 说明 |\n|------|------|\n| alpha | 测试术语 |',
});

/** 含 --from-iwiki 锚点的 external-knowledge.md 骨架内容 */
function buildSkeletonMd(): string {
    return [
        '# 外部知识源',
        '',
        '本文档由 `teamai import --from-iwiki --iwiki-dual` 自动维护。',
        '',
        '<!-- managed-by: import --from-iwiki, section: business-api, source: (pending), syncedAt: (pending) -->',
        '',
        '<!-- /managed-by: business-api -->',
        '',
        '<!-- managed-by: import --from-iwiki, section: external-knowledge, source: (pending), syncedAt: (pending) -->',
        '',
        '<!-- /managed-by: external-knowledge -->',
        '',
        '<!-- managed-by: import --from-iwiki, section: glossary, source: (pending), syncedAt: (pending) -->',
        '',
        '<!-- /managed-by: glossary -->',
    ].join('\n');
}

// ─── 辅助 ────────────────────────────────────────────────

async function makeWorkdir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-iwiki-apply-e2e-'));
    await fs.ensureDir(path.join(tmpDir, '.teamai'));
    return tmpDir;
}

// ─── Tests ──────────────────────────────────────────────

describe('iwiki review apply 闭环 e2e', () => {
    let cwd: string;
    let originalCwd: string;

    beforeEach(async () => {
        cwd = await makeWorkdir();
        originalCwd = process.cwd();
        process.chdir(cwd);
        vi.clearAllMocks();
        (callClaude as ReturnType<typeof vi.fn>).mockResolvedValue(AI_OUTPUT);
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.remove(cwd);
    });

    it('importFromIWikiDual(requireReview:true) 写入 pending-review.jsonl', async () => {
        const result = await importFromIWikiDual({
            input: '456',
            token: 'fake-token',
            sections: ['external-knowledge'],
            requireReview: true,
        });

        expect(result.pendingReview).toBe(true);

        const items = await loadPendingReview(cwd);
        expect(items.length).toBeGreaterThan(0);

        const item = items.find((i) => i.target.section === 'external-knowledge');
        expect(item).toBeDefined();
        expect(item?.kind).toBe('codebase-section');
        expect(item?.source).toContain('iwiki://456');
        expect(item?.payload['content']).toContain('外部知识');
    });

    it('reviewCmd(apply:true) 成功 patch --from-iwiki 锚点并写入 body', async () => {
        // 1. 准备带 --from-iwiki 锚点的 external-knowledge.md
        const ekDir = path.join(cwd, 'docs', 'team-codebase');
        await fs.ensureDir(ekDir);
        const ekPath = path.join(ekDir, 'external-knowledge.md');
        await fs.writeFile(ekPath, buildSkeletonMd(), 'utf8');

        // 2. 写入 pending-review 条目（模拟 importFromIWikiDual requireReview 的产物）
        await importFromIWikiDual({
            input: '456',
            token: 'fake-token',
            sections: ['external-knowledge'],
            requireReview: true,
        });

        const items = await loadPendingReview(cwd);
        const item = items.find((i) => i.target.section === 'external-knowledge');
        expect(item).toBeDefined();
        const itemId = item!.id;

        // 3. 执行 review --apply
        await reviewCmd({ idArg: itemId, apply: true });

        // 4. 断言 external-knowledge.md 的 body 确实被 patch（内容包含新文本）
        const patched = await fs.readFile(ekPath, 'utf8');
        expect(patched).toContain('已更新的外部知识内容');
        expect(patched).toContain('由 iwiki 导入');

        // 5. 断言锚点前缀仍保留 --from-iwiki（写入侧锚点不被 patch 成 --from-repo）
        // patchManagedSection 会用 meta.source 重建开锚；此处来源是 iwiki://456
        expect(patched).toContain('--from-iwiki');

        // 6. 断言条目已从 pending-review 移除
        const remaining = await loadPendingReview(cwd);
        expect(remaining.find((i) => i.id === itemId)).toBeUndefined();
    });
});
