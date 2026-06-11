import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DomainsFile, HistoryEvent } from '../domains/schema.js';

// mock prompt 工具（在 import reviewDomains 之前）
vi.mock('../utils/prompt.js', () => ({
    askQuestion: vi.fn(),
    askConfirmation: vi.fn(),
}));

import { reviewDomains } from '../domains/review.js';
import { askQuestion } from '../utils/prompt.js';

/** 构建一个简单的 DomainsFile 用于测试。 */
function makeDraft(): DomainsFile {
    return {
        version: 1,
        confidence_threshold: 0.6,
        domains: [
            {
                name: '基础设施',
                description: '底层基础设施',
                confidence: 0.9,
                repos: [
                    {
                        url: 'https://github.com/org/infra',
                        confidence: 0.9,
                        signal: '包含 k8s 配置',
                        locked: false,
                    },
                ],
            },
            {
                name: '前端应用',
                description: '前端相关仓库',
                confidence: 0.8,
                repos: [
                    {
                        url: 'https://github.com/org/webapp',
                        confidence: 0.3,  // 低置信度
                        signal: '包含 React 代码',
                        locked: false,
                    },
                ],
            },
        ],
    };
}

describe('reviewDomains — 操作事件', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('TTY 环境下输入 m 应触发 merge 事件', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });

        try {
            // m 0 1 → 合并，然后 a → 接受
            vi.mocked(askQuestion)
                .mockResolvedValueOnce('m 0 1')
                .mockResolvedValueOnce('a');

            const events: HistoryEvent[] = [];
            const result = await reviewDomains(makeDraft(), {
                onEvent: (e) => { events.push(e); },
            });

            expect(result.finalize).toBe('save');
            const mergeEvent = events.find((e) => e.action === 'merge');
            expect(mergeEvent).toBeDefined();
            expect(mergeEvent?.details).toMatchObject({ into: '基础设施', merged: '前端应用' });
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true });
        }
    });

    it('TTY 环境下输入 e 应触发 rename 事件', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });

        try {
            // e 0 → 重命名，然后 a → 接受
            vi.mocked(askQuestion)
                .mockResolvedValueOnce('e 0')
                .mockResolvedValueOnce('新域名')
                .mockResolvedValueOnce('a');

            const events: HistoryEvent[] = [];
            const result = await reviewDomains(makeDraft(), {
                onEvent: (e) => { events.push(e); },
            });

            expect(result.finalize).toBe('save');
            const renameEvent = events.find((e) => e.action === 'rename');
            expect(renameEvent).toBeDefined();
            expect(renameEvent?.details).toMatchObject({ from: '基础设施', to: '新域名' });
            // 验证结果中域名已更新
            const updatedDomain = result.result.domains.find((d) => d.name === '新域名');
            expect(updatedDomain).toBeDefined();
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true });
        }
    });

    it('TTY 环境下输入 x 应触发 reassign 事件', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });

        try {
            // x 1 0 基础设施 → 将前端应用[0]移到基础设施，然后 a
            vi.mocked(askQuestion)
                .mockResolvedValueOnce('x 1 0 基础设施')
                .mockResolvedValueOnce('a');

            const events: HistoryEvent[] = [];
            const result = await reviewDomains(makeDraft(), {
                onEvent: (e) => { events.push(e); },
            });

            expect(result.finalize).toBe('save');
            const reassignEvent = events.find((e) => e.action === 'reassign');
            expect(reassignEvent).toBeDefined();
            expect(reassignEvent?.details).toMatchObject({
                url: 'https://github.com/org/webapp',
                from: '前端应用',
                to: '基础设施',
            });
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true });
        }
    });

    it('TTY 环境下输入 l 应触发 lock 事件', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });

        try {
            vi.mocked(askQuestion)
                .mockResolvedValueOnce('l 0 0')
                .mockResolvedValueOnce('a');

            const events: HistoryEvent[] = [];
            const result = await reviewDomains(makeDraft(), {
                onEvent: (e) => { events.push(e); },
            });

            expect(result.finalize).toBe('save');
            const lockEvent = events.find((e) => e.action === 'lock');
            expect(lockEvent).toBeDefined();
            // 验证仓库已被锁定
            const lockedRepo = result.result.domains[0]?.repos[0];
            expect(lockedRepo?.locked).toBe(true);
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true });
        }
    });
});
