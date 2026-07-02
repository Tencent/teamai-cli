import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as cacheIndexModule from '../utils/cache-index.js';
import type { CacheCmdOptions } from '../cache-cmd.js';

// ─── Tests ───────────────────────────────────────────────

describe('cache-cmd', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
            throw new Error(`process.exit called with code ${code}`);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ─── --status ────────────────────────────────────────

    describe('--status', () => {
        it('默认路径调用 getCacheStatus', async () => {
            const mockStatus = {
                root: '/mock/cache',
                totalBytes: 1024,
                entryCount: 1,
                entries: [
                    {
                        key: 'github/owner/repo',
                        size_bytes: 1024,
                        last_used: '2025-01-01T00:00:00.000Z',
                        last_synced_sha: 'abcdef12',
                    },
                ],
            };
            vi.spyOn(cacheIndexModule, 'getCacheStatus').mockResolvedValue(mockStatus);

            const { cacheCmd } = await import('../cache-cmd.js');
            const opts: CacheCmdOptions = { dryRun: false, verbose: false };
            await cacheCmd(opts);

            expect(cacheIndexModule.getCacheStatus).toHaveBeenCalledOnce();
        });

        it('--json 输出合法 JSON', async () => {
            const mockStatus = {
                root: '/mock/cache',
                totalBytes: 0,
                entryCount: 0,
                entries: [],
            };
            vi.spyOn(cacheIndexModule, 'getCacheStatus').mockResolvedValue(mockStatus);

            const outputs: string[] = [];
            consoleSpy.mockImplementation((msg: unknown) => {
                if (typeof msg === 'string') outputs.push(msg);
            });

            const { cacheCmd } = await import('../cache-cmd.js');
            const opts: CacheCmdOptions = { dryRun: false, verbose: false, json: true };
            await cacheCmd(opts);

            const allOutput = outputs.join('');
            expect(() => JSON.parse(allOutput)).not.toThrow();
            const parsed = JSON.parse(allOutput) as Record<string, unknown>;
            expect(parsed).toHaveProperty('root');
            expect(parsed).toHaveProperty('entries');
        });
    });

    // ─── --gc ────────────────────────────────────────────

    describe('--gc', () => {
        it('--gc 路径调用 gcCache', async () => {
            const mockResult: cacheIndexModule.GcResult = {
                before: { totalBytes: 1000, entryCount: 2 },
                after: { totalBytes: 500, entryCount: 1 },
                removed: [{ key: 'github/owner/old', size_bytes: 500, reason: 'stale' }],
                skipped: [],
            };
            vi.spyOn(cacheIndexModule, 'gcCache').mockResolvedValue(mockResult);

            const { cacheCmd } = await import('../cache-cmd.js');
            const opts: CacheCmdOptions = { dryRun: false, verbose: false, gc: true };
            await cacheCmd(opts);

            expect(cacheIndexModule.gcCache).toHaveBeenCalledOnce();
        });

        it('--gc --json 输出合法 JSON', async () => {
            const mockResult: cacheIndexModule.GcResult = {
                before: { totalBytes: 1000, entryCount: 1 },
                after: { totalBytes: 0, entryCount: 0 },
                removed: [{ key: 'github/owner/old', size_bytes: 1000, reason: 'stale' }],
                skipped: [],
            };
            vi.spyOn(cacheIndexModule, 'gcCache').mockResolvedValue(mockResult);

            const outputs: string[] = [];
            consoleSpy.mockImplementation((msg: unknown) => {
                if (typeof msg === 'string') outputs.push(msg);
            });

            const { cacheCmd } = await import('../cache-cmd.js');
            const opts: CacheCmdOptions = { dryRun: false, verbose: false, gc: true, json: true };
            await cacheCmd(opts);

            const allOutput = outputs.join('');
            expect(() => JSON.parse(allOutput)).not.toThrow();
            const parsed = JSON.parse(allOutput) as Record<string, unknown>;
            expect(parsed).toHaveProperty('before');
            expect(parsed).toHaveProperty('removed');
        });

        it('skipped 非空时退出码为 1', async () => {
            const mockResult: cacheIndexModule.GcResult = {
                before: { totalBytes: 1000, entryCount: 1 },
                after: { totalBytes: 1000, entryCount: 1 },
                removed: [],
                skipped: [{ key: 'github/owner/broken', reason: '删除失败: EPERM' }],
            };
            vi.spyOn(cacheIndexModule, 'gcCache').mockResolvedValue(mockResult);

            const { cacheCmd } = await import('../cache-cmd.js');
            const opts: CacheCmdOptions = { dryRun: false, verbose: false, gc: true };
            await expect(cacheCmd(opts)).rejects.toThrow('process.exit called with code 1');
        });

        it('skipped 非空且 --json 时退出码为 1', async () => {
            const mockResult: cacheIndexModule.GcResult = {
                before: { totalBytes: 1000, entryCount: 1 },
                after: { totalBytes: 1000, entryCount: 1 },
                removed: [],
                skipped: [{ key: 'github/owner/broken', reason: '删除失败' }],
            };
            vi.spyOn(cacheIndexModule, 'gcCache').mockResolvedValue(mockResult);

            const { cacheCmd } = await import('../cache-cmd.js');
            const opts: CacheCmdOptions = { dryRun: false, verbose: false, gc: true, json: true };
            await expect(cacheCmd(opts)).rejects.toThrow('process.exit called with code 1');
        });
    });
});
