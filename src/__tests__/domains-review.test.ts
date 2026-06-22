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

describe('reviewDomains', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('非 TTY 环境下应直接返回 draft + finalize="draft"', async () => {
        // 确保非 TTY 环境（CI 环境下 isTTY 通常为 undefined/false）
        const originalIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true });

        try {
            const draft = makeDraft();
            const result = await reviewDomains(draft);
            expect(result.finalize).toBe('draft');
            expect(result.result).toEqual(draft);
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true });
        }
    });

    it('非 TTY 下不应调用 askQuestion', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true });

        try {
            await reviewDomains(makeDraft());
            expect(askQuestion).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true });
        }
    });

    it('TTY 环境下输入 a 应返回 finalize="save"', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });

        try {
            vi.mocked(askQuestion).mockResolvedValueOnce('a');

            const events: HistoryEvent[] = [];
            const result = await reviewDomains(makeDraft(), {
                onEvent: (e) => { events.push(e); },
            });

            expect(result.finalize).toBe('save');
            expect(events).toHaveLength(1);
            expect(events[0]?.action).toBe('accept');
            expect(events[0]?.actor).toBe('user');
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true });
        }
    });

    it('TTY 环境下输入 q 选 3 应返回 finalize="abort"', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });

        try {
            vi.mocked(askQuestion)
                .mockResolvedValueOnce('q')
                .mockResolvedValueOnce('3');

            const draft = makeDraft();
            const result = await reviewDomains(draft);

            expect(result.finalize).toBe('abort');
            // abort 时返回原始 draft
            expect(result.result).toEqual(draft);
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true });
        }
    });
});
