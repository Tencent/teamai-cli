// -*- coding: utf-8 -*-
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import fs from 'fs-extra';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../review-store.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../review-store.js')>();
    return {
        ...actual,
        loadPendingReview: vi.fn(),
        savePendingReview: vi.fn(),
        removePendingReview: vi.fn(),
        decidePendingReview: vi.fn(),
    };
});

vi.mock('../section-patcher.js', () => ({
    patchManagedSection: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────

import { reviewCmd } from '../review-cmd.js';
import {
    decidePendingReview,
    loadPendingReview,
    removePendingReview,
    type PendingReviewItem,
} from '../review-store.js';
import { patchManagedSection } from '../section-patcher.js';

// ─── 辅助 ────────────────────────────────────────────────

async function makeWorkdir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'teamai-review-cmd-test-'));
}

function makeItem(overrides: Partial<PendingReviewItem> = {}): PendingReviewItem {
    return {
        id: 'abc123def456',
        ts: '2024-01-01T00:00:00.000Z',
        kind: 'codebase-section',
        target: {
            file: 'docs/team-codebase/external-knowledge.md',
            section: 'glossary',
        },
        payload: { content: '## 术语表\n| foo | bar |' },
        source: 'import --from-iwiki',
        risk: 'medium',
        ...overrides,
    };
}

// ─── Tests ──────────────────────────────────────────────

describe('review-cmd', () => {
    let cwd: string;
    let originalCwd: string;
    let consoleSpy: MockInstance<typeof console.log>;

    beforeEach(async () => {
        cwd = await makeWorkdir();
        originalCwd = process.cwd();
        process.chdir(cwd);
        vi.clearAllMocks();
        vi.mocked(decidePendingReview).mockImplementation(async (dir, id, decide) => {
            const item = (await loadPendingReview(dir)).find((entry) => entry.id === id);
            return item ? decide(item) : undefined;
        });
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.remove(cwd);
        consoleSpy.mockRestore();
    });

    it('refuses an invalid risk ceiling before reading or applying the queue', async () => {
        (loadPendingReview as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        await expect(reviewCmd({ allApply: true, maxRisk: 'invalid' })).rejects.toThrow('--max-risk must be high, medium, or low');
        expect(loadPendingReview).not.toHaveBeenCalled();
        expect(removePendingReview).not.toHaveBeenCalled();
    });

    // ── list 模式 ─────────────────────────────────────────

    it('无 args → list 调用 loadPendingReview', async () => {
        (loadPendingReview as ReturnType<typeof vi.fn>).mockResolvedValue([makeItem()]);

        await reviewCmd({});

        expect(loadPendingReview).toHaveBeenCalledOnce();
        // 输出中含 ID
        const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(output).toContain('abc123def456');
    });

    it('--json → list 输出有效 JSON 数组', async () => {
        const items = [makeItem(), makeItem({ id: 'def456abc123', risk: 'high' })];
        (loadPendingReview as ReturnType<typeof vi.fn>).mockResolvedValue(items);

        await reviewCmd({ json: true });

        const output = consoleSpy.mock.calls[0][0] as string;
        const parsed = JSON.parse(output) as PendingReviewItem[];
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(2);
    });

    // ── show 模式 ─────────────────────────────────────────

    it('show 模式正确渲染单条', async () => {
        const item = makeItem();
        (loadPendingReview as ReturnType<typeof vi.fn>).mockResolvedValue([item]);

        await reviewCmd({ idArg: 'abc123def456' });

        const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(output).toContain('abc123def456');
        expect(output).toContain('codebase-section');
        expect(output).toContain('glossary');
    });

    // ── apply 模式 ────────────────────────────────────────

    it('apply 单条 codebase-section → 写入更新后的文档', async () => {
        const item = makeItem();
        const targetFile = path.join(cwd, item.target.file!);
        await fs.ensureDir(path.dirname(targetFile));
        await fs.writeFile(targetFile, '# doc\n<!-- managed-by: import --from-repo, section: glossary -->## glossary\n<!-- /managed-by: glossary -->', 'utf8');

        (loadPendingReview as ReturnType<typeof vi.fn>).mockResolvedValue([item]);
        (patchManagedSection as ReturnType<typeof vi.fn>).mockReturnValue('# doc patched');

        await reviewCmd({ idArg: 'abc123def456', apply: true });

        expect(patchManagedSection).toHaveBeenCalledOnce();
        expect(await fs.readFile(targetFile, 'utf8')).toBe('# doc patched');
    });

    it('apply kind=domain-drift → 不调 patchManagedSection，jsonl 不变', async () => {
        const item = makeItem({ kind: 'domain-drift' });
        (loadPendingReview as ReturnType<typeof vi.fn>).mockResolvedValue([item]);

        await reviewCmd({ idArg: 'abc123def456', apply: true });

        expect(patchManagedSection).not.toHaveBeenCalled();
        expect(removePendingReview).not.toHaveBeenCalled();

        const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(output).toContain('does not support auto-apply');
    });

    // ── reject 模式 ───────────────────────────────────────

    it('reject 单条 → removePendingReview', async () => {
        const item = makeItem();
        (loadPendingReview as ReturnType<typeof vi.fn>).mockResolvedValue([item]);
        (removePendingReview as ReturnType<typeof vi.fn>).mockResolvedValue(true);

        await reviewCmd({ idArg: 'abc123def456', reject: true, reason: '内容不准确' });

        expect(removePendingReview).toHaveBeenCalledWith(expect.stringContaining('teamai-review-cmd-test-'), 'abc123def456');
    });

    // ── --all-apply 模式 ──────────────────────────────────

    it('--all-apply --max-risk medium → 只应用 medium/low 的 codebase-section；high 项跳过', async () => {
        const highItem = makeItem({ id: 'highriskitem1', risk: 'high', target: { file: 'docs/a.md', section: 'sec-a' } });
        const mediumItem = makeItem({ id: 'mediumitem001', risk: 'medium', target: { file: 'docs/b.md', section: 'sec-b' } });

        const targetFile = path.join(cwd, 'docs/b.md');
        await fs.ensureDir(path.dirname(targetFile));
        await fs.writeFile(targetFile, '# doc', 'utf8');

        (loadPendingReview as ReturnType<typeof vi.fn>).mockResolvedValue([highItem, mediumItem]);
        (patchManagedSection as ReturnType<typeof vi.fn>).mockReturnValue('# doc patched');

        await reviewCmd({ allApply: true, maxRisk: 'medium' });

        // 只对 mediumItem 调用 patchManagedSection
        expect(patchManagedSection).toHaveBeenCalledOnce();
        expect(await fs.readFile(targetFile, 'utf8')).toBe('# doc patched');

        const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(output).toContain('skipped');
    });

    it('--json 输出有效 JSON（apply 模式）', async () => {
        const item = makeItem();
        const targetFile = path.join(cwd, item.target.file!);
        await fs.ensureDir(path.dirname(targetFile));
        await fs.writeFile(targetFile, '# doc', 'utf8');

        (loadPendingReview as ReturnType<typeof vi.fn>).mockResolvedValue([item]);
        (patchManagedSection as ReturnType<typeof vi.fn>).mockReturnValue('# doc patched');

        await reviewCmd({ idArg: 'abc123def456', apply: true, json: true });

        const output = consoleSpy.mock.calls[0][0] as string;
        const parsed = JSON.parse(output) as { ok: boolean; id: string };
        expect(typeof parsed.ok).toBe('boolean');
        expect(parsed.id).toBe('abc123def456');
    });
});
