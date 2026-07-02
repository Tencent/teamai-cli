import { describe, it, expect } from 'vitest';
import {
    DomainsFileSchema,
    DomainEntrySchema,
    RepoEntrySchema,
    HistoryEventSchema,
} from '../domains/schema.js';

describe('RepoEntrySchema', () => {
    it('应正确解析合法仓库条目', () => {
        const result = RepoEntrySchema.parse({ url: 'https://github.com/org/repo' });
        expect(result.url).toBe('https://github.com/org/repo');
        expect(result.locked).toBe(false);
    });

    it('应拒绝非法 URL', () => {
        expect(() => RepoEntrySchema.parse({ url: 'not-a-url' })).toThrow();
    });

    it('应拒绝 confidence > 1', () => {
        expect(() =>
            RepoEntrySchema.parse({ url: 'https://github.com/org/repo', confidence: 1.5 })
        ).toThrow();
    });

    it('应拒绝 confidence < 0', () => {
        expect(() =>
            RepoEntrySchema.parse({ url: 'https://github.com/org/repo', confidence: -0.1 })
        ).toThrow();
    });

    it('signal 字段可选', () => {
        const result = RepoEntrySchema.parse({ url: 'https://github.com/org/repo' });
        expect(result.signal).toBeUndefined();
    });
});

describe('DomainEntrySchema', () => {
    it('应拒绝缺少 name 的条目', () => {
        expect(() => DomainEntrySchema.parse({ repos: [] })).toThrow();
    });

    it('应拒绝空 name', () => {
        expect(() => DomainEntrySchema.parse({ name: '' })).toThrow();
    });

    it('description 默认为空字符串', () => {
        const result = DomainEntrySchema.parse({ name: '基础设施' });
        expect(result.description).toBe('');
    });

    it('repos 默认为空数组', () => {
        const result = DomainEntrySchema.parse({ name: '基础设施' });
        expect(result.repos).toEqual([]);
    });
});

describe('DomainsFileSchema', () => {
    it('version 默认为 1', () => {
        const result = DomainsFileSchema.parse({});
        expect(result.version).toBe(1);
    });

    it('confidence_threshold 默认为 0.6', () => {
        const result = DomainsFileSchema.parse({});
        expect(result.confidence_threshold).toBe(0.6);
    });

    it('domains 默认为空数组', () => {
        const result = DomainsFileSchema.parse({});
        expect(result.domains).toEqual([]);
    });

    it('应拒绝 version 不为 1', () => {
        expect(() => DomainsFileSchema.parse({ version: 2 })).toThrow();
    });

    it('应拒绝 confidence_threshold > 1', () => {
        expect(() => DomainsFileSchema.parse({ confidence_threshold: 1.5 })).toThrow();
    });

    it('应正确解析完整的 domains 文件', () => {
        const input = {
            version: 1 as const,
            confidence_threshold: 0.7,
            domains: [
                {
                    name: '基础设施',
                    description: '底层基础设施仓库',
                    repos: [
                        {
                            url: 'https://github.com/org/infra',
                            confidence: 0.9,
                            signal: '包含 k8s 配置',
                        },
                    ],
                },
            ],
        };
        const result = DomainsFileSchema.parse(input);
        expect(result.domains[0]?.name).toBe('基础设施');
        expect(result.domains[0]?.repos[0]?.locked).toBe(false);
    });

    it('generated_at 和 generator 字段可选', () => {
        const result = DomainsFileSchema.parse({});
        expect(result.generated_at).toBeUndefined();
        expect(result.generator).toBeUndefined();
    });
});

describe('HistoryEventSchema', () => {
    it('应正确解析合法事件', () => {
        const event = {
            ts: '2024-01-01T00:00:00.000Z',
            actor: 'ai' as const,
            action: 'recommend' as const,
            details: { domain: '基础设施' },
        };
        const result = HistoryEventSchema.parse(event);
        expect(result.actor).toBe('ai');
        expect(result.action).toBe('recommend');
    });

    it('应拒绝非法 actor', () => {
        expect(() =>
            HistoryEventSchema.parse({
                ts: '2024-01-01T00:00:00.000Z',
                actor: 'system',
                action: 'accept',
                details: {},
            })
        ).toThrow();
    });

    it('应拒绝非法 action', () => {
        expect(() =>
            HistoryEventSchema.parse({
                ts: '2024-01-01T00:00:00.000Z',
                actor: 'user',
                action: 'delete',
                details: {},
            })
        ).toThrow();
    });

    it('所有合法 action 枚举应通过', () => {
        const validActions = ['recommend', 'accept', 'reject', 'merge', 'split', 'rename', 'lock', 'reassign'];
        for (const action of validActions) {
            expect(() =>
                HistoryEventSchema.parse({
                    ts: '2024-01-01T00:00:00.000Z',
                    actor: 'user',
                    action,
                    details: {},
                })
            ).not.toThrow();
        }
    });
});
