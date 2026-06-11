// -*- coding: utf-8 -*-
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
            { docid: '123', title: 'Test Page' },
        ]),
        getDocument: vi.fn().mockResolvedValue({
            docid: '123',
            title: 'Test Page',
            content: '这是测试内容，包含一些 API 接口和术语。',
        }),
    })),
}));

// ─── Imports (after mocks) ───────────────────────────────

import { importFromIWikiDual } from '../iwiki-dual.js';
import { callClaude } from '../utils/ai-client.js';

// ─── 辅助 ────────────────────────────────────────────────

const VALID_AI_OUTPUT = JSON.stringify({
    'business-api': '## 业务接口\n接口列表...',
    'external-knowledge': '## 外部知识\n知识列表...',
    'glossary': '| 术语 | 说明 |\n|------|------|\n| foo | bar |',
});

async function makeWorkdir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-iwiki-dual-test-'));
    return tmpDir;
}

// ─── Tests ──────────────────────────────────────────────

describe('importFromIWikiDual', () => {
    let cwd: string;
    let originalCwd: string;

    beforeEach(async () => {
        cwd = await makeWorkdir();
        originalCwd = process.cwd();
        process.chdir(cwd);
        vi.clearAllMocks();
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.remove(cwd);
    });

    it('首次创建写出三章节骨架', async () => {
        (callClaude as ReturnType<typeof vi.fn>).mockResolvedValue(VALID_AI_OUTPUT);

        await importFromIWikiDual({ input: '12345', token: 'test-token' });

        const filePath = path.join(cwd, 'docs/team-codebase/external-knowledge.md');
        expect(await fs.pathExists(filePath)).toBe(true);
        const content = await fs.readFile(filePath, 'utf8');
        expect(content).toContain('## 业务接口');
        expect(content).toContain('## 外部知识源');
        expect(content).toContain('## 术语表');
    });

    it('二次调用按锚点替换，未指定的章节不动', async () => {
        // 第一次：写全部三章节
        (callClaude as ReturnType<typeof vi.fn>).mockResolvedValue(VALID_AI_OUTPUT);
        await importFromIWikiDual({ input: '12345', token: 'test-token' });

        const filePath = path.join(cwd, 'docs/team-codebase/external-knowledge.md');
        const firstContent = await fs.readFile(filePath, 'utf8');

        // 第二次：只更新 business-api
        const updatedOutput = JSON.stringify({
            'business-api': '## 更新后的接口',
            'external-knowledge': '',
            'glossary': '',
        });
        (callClaude as ReturnType<typeof vi.fn>).mockResolvedValue(updatedOutput);

        await importFromIWikiDual({
            input: '12345',
            token: 'test-token',
            sections: ['business-api'],
        });

        const secondContent = await fs.readFile(filePath, 'utf8');
        // business-api 已更新
        expect(secondContent).toContain('更新后的接口');
        // glossary 未被清空（来自第一次写入）
        expect(secondContent).toContain('| 术语 | 说明 |');
        // external-knowledge 区域存在（来自第一次写入）
        expect(secondContent).toContain('外部知识');
        // 长度与第一次相比发生了变化（business-api 被替换）
        expect(secondContent).not.toEqual(firstContent);
    });

    it('AI 输出非 JSON → warn 并不写', async () => {
        (callClaude as ReturnType<typeof vi.fn>).mockResolvedValue('这不是 JSON 内容');

        const result = await importFromIWikiDual({ input: '12345', token: 'test-token' });

        expect(result.sectionsUpdated).toHaveLength(0);
        const filePath = path.join(cwd, 'docs/team-codebase/external-knowledge.md');
        // 不写文件（因为 AI 输出无效）
        expect(await fs.pathExists(filePath)).toBe(false);
    });

    it('requireReview=true → 落到 pending-review.jsonl 且不动 external-knowledge.md', async () => {
        (callClaude as ReturnType<typeof vi.fn>).mockResolvedValue(VALID_AI_OUTPUT);

        const result = await importFromIWikiDual({
            input: '12345',
            token: 'test-token',
            requireReview: true,
        });

        expect(result.pendingReview).toBe(true);

        // external-knowledge.md 不应被创建
        const filePath = path.join(cwd, 'docs/team-codebase/external-knowledge.md');
        expect(await fs.pathExists(filePath)).toBe(false);

        // pending-review.jsonl 应存在且含记录
        const pendingPath = path.join(cwd, '.teamai/pending-review.jsonl');
        expect(await fs.pathExists(pendingPath)).toBe(true);
        const lines = (await fs.readFile(pendingPath, 'utf8'))
            .split('\n')
            .filter((l) => l.trim());
        expect(lines.length).toBeGreaterThan(0);
        const record = JSON.parse(lines[0]) as { type: string; section: string };
        expect(record.type).toBe('codebase-section');
    });
});
