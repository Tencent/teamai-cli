// -*- coding: utf-8 -*-
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';

import { recordSourceUpdate } from '../utils/source-conflict.js';
import type { SourceMark } from '../utils/source-conflict.js';

// ─── Helpers ────────────────────────────────────────────

async function makeWorkdir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-source-conflict-test-'));
    await fs.ensureDir(path.join(tmpDir, '.teamai'));
    return tmpDir;
}

function makeMark(
    source: SourceMark['source'],
    sourceId: string,
    syncedAt: string,
): SourceMark {
    return { source, sourceId, syncedAt };
}

// ─── Tests ──────────────────────────────────────────────

describe('recordSourceUpdate', () => {
    let cwd: string;
    let originalCwd: string;
    const TEST_FILE = '/tmp/fake/external-knowledge.md';
    const TEST_SECTION = 'business-api';

    beforeEach(async () => {
        cwd = await makeWorkdir();
        originalCwd = process.cwd();
        process.chdir(cwd);
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.remove(cwd);
    });

    it('首次记录返回 conflict=false', async () => {
        const mark = makeMark('iwiki', 'page-123', new Date().toISOString());
        const result = await recordSourceUpdate(cwd, TEST_FILE, TEST_SECTION, mark);

        expect(result.conflict).toBe(false);
        expect(result.previousSources).toHaveLength(0);

        // 验证记录已写入
        const marksPath = path.join(cwd, '.teamai/source-marks.jsonl');
        expect(await fs.pathExists(marksPath)).toBe(true);
    });

    it('24 小时内不同 source 返回 conflict=true', async () => {
        const now = Date.now();
        const mark1 = makeMark('iwiki', 'page-123', new Date(now - 3600_000).toISOString());
        const mark2 = makeMark('mr', 'https://github.com/org/repo/pull/1', new Date(now).toISOString());

        // 先写 iwiki 记录
        await recordSourceUpdate(cwd, TEST_FILE, TEST_SECTION, mark1);

        // 再写 mr 记录 → 应检测到冲突
        const result = await recordSourceUpdate(cwd, TEST_FILE, TEST_SECTION, mark2);

        expect(result.conflict).toBe(true);
        expect(result.previousSources).toHaveLength(1);
        expect(result.previousSources[0]?.source).toBe('iwiki');
    });

    it('相同 source + sourceId 不冲突', async () => {
        const now = Date.now();
        const mark1 = makeMark('iwiki', 'page-123', new Date(now - 3600_000).toISOString());
        const mark2 = makeMark('iwiki', 'page-123', new Date(now).toISOString());

        await recordSourceUpdate(cwd, TEST_FILE, TEST_SECTION, mark1);
        const result = await recordSourceUpdate(cwd, TEST_FILE, TEST_SECTION, mark2);

        expect(result.conflict).toBe(false);
    });

    it('24 小时外的旧记录被忽略', async () => {
        const now = Date.now();
        // 写一条 25 小时前的 iwiki 记录
        const oldMark = makeMark('iwiki', 'page-123', new Date(now - 25 * 3600_000).toISOString());
        await recordSourceUpdate(cwd, TEST_FILE, TEST_SECTION, oldMark);

        // 现在写 mr 记录
        const newMark = makeMark('mr', 'https://github.com/org/repo/pull/1', new Date(now).toISOString());
        const result = await recordSourceUpdate(cwd, TEST_FILE, TEST_SECTION, newMark);

        // 25 小时前的 iwiki 记录超出窗口，不触发冲突
        expect(result.conflict).toBe(false);
    });

    it('不同 file 的记录不互相影响', async () => {
        const now = Date.now();
        const mark1 = makeMark('iwiki', 'page-111', new Date(now - 3600_000).toISOString());
        const mark2 = makeMark('mr', 'https://mr/1', new Date(now).toISOString());

        await recordSourceUpdate(cwd, '/file-a.md', TEST_SECTION, mark1);
        const result = await recordSourceUpdate(cwd, '/file-b.md', TEST_SECTION, mark2);

        expect(result.conflict).toBe(false);
    });
});
