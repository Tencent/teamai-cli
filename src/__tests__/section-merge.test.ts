import { describe, it, expect } from 'vitest';

import { mergeWithAnchors, splitToSections, joinSections } from '../section-patcher.js';

const META = { source: 'https://github.com/org/repo@deadbeef', syncedAt: '2024-01-01T00:00:00.000Z' };
const META2 = { source: 'https://github.com/org/repo@cafebabe', syncedAt: '2024-06-01T00:00:00.000Z' };

const FRESH_MD = [
    '---',
    'title: Test Repo',
    'lastUpdated: 2024-01-01T00:00:00.000Z',
    '---',
    '',
    '## 项目概述',
    '这是项目概述。',
    '',
    '## 技术栈',
    'TypeScript + Node.js',
].join('\n');

describe('mergeWithAnchors', () => {
    it('oldFile=null（首次）→ 全部 added，无 changed/removed', () => {
        const result = mergeWithAnchors(null, FRESH_MD, META);

        expect(result.addedSlugs).toHaveLength(2);
        expect(result.changedSlugs).toHaveLength(0);
        expect(result.removedSlugs).toHaveLength(0);
        expect(result.keptSlugs).toHaveLength(0);
        expect(result.mergedMd).toContain('<!-- managed-by:');
        expect(result.mergedMd).toContain('项目概述');
        expect(result.mergedMd).toContain('技术栈');
    });

    it('第二次相同 fresh → mergedMd 字节级等于第一次；changed/added/removed 均空', () => {
        const first = mergeWithAnchors(null, FRESH_MD, META);
        const second = mergeWithAnchors(first.mergedMd, FRESH_MD, META);

        // 核心：零 diff
        expect(second.mergedMd).toBe(first.mergedMd);
        expect(second.changedSlugs).toHaveLength(0);
        expect(second.addedSlugs).toHaveLength(0);
        expect(second.removedSlugs).toHaveLength(0);
        expect(second.keptSlugs).toHaveLength(2);
    });

    it('fresh 中某 section body 改了 → 该 slug 进 changed，syncedAt 更新；其他 section syncedAt 保留', () => {
        const first = mergeWithAnchors(null, FRESH_MD, META);

        const freshMd2 = [
            '---',
            'title: Test Repo',
            'lastUpdated: 2024-06-01T00:00:00.000Z',
            '---',
            '',
            '## 项目概述',
            '这是更新后的项目概述。',  // 内容改了
            '',
            '## 技术栈',
            'TypeScript + Node.js',   // 未改
        ].join('\n');

        const second = mergeWithAnchors(first.mergedMd, freshMd2, META2);

        expect(second.changedSlugs).toContain('项目概述');
        expect(second.keptSlugs).toContain('技术栈');
        expect(second.addedSlugs).toHaveLength(0);
        expect(second.removedSlugs).toHaveLength(0);

        // 已改的 section 用新 syncedAt
        expect(second.mergedMd).toContain('syncedAt: 2024-06-01T00:00:00.000Z');
        // 未改的 section 保留旧 syncedAt
        expect(second.mergedMd).toContain('syncedAt: 2024-01-01T00:00:00.000Z');
    });

    it('fresh 中 section 被删除 → removed 列表', () => {
        const first = mergeWithAnchors(null, FRESH_MD, META);

        const freshMd2 = [
            '---',
            'title: Test Repo',
            'lastUpdated: 2024-06-01T00:00:00.000Z',
            '---',
            '',
            '## 项目概述',
            '这是项目概述。',
            // 技术栈 被删除
        ].join('\n');

        const second = mergeWithAnchors(first.mergedMd, freshMd2, META2);

        expect(second.removedSlugs).toContain('技术栈');
        expect(second.mergedMd).not.toContain('<!-- /managed-by: 技术栈 -->');
    });

    it('fresh 中新增 section → added 列表', () => {
        const first = mergeWithAnchors(null, FRESH_MD, META);

        const freshMd2 = [
            '---',
            'title: Test Repo',
            'lastUpdated: 2024-06-01T00:00:00.000Z',
            '---',
            '',
            '## 项目概述',
            '这是项目概述。',
            '',
            '## 技术栈',
            'TypeScript + Node.js',
            '',
            '## 部署方式',   // 新增
            'Docker + K8s',
        ].join('\n');

        const second = mergeWithAnchors(first.mergedMd, freshMd2, META2);

        expect(second.addedSlugs).toContain('部署方式');
        expect(second.mergedMd).toContain('部署方式');
    });

    it('prelude 不同（frontmatter lastUpdated 变化）→ 全 kept 时保留旧 prelude', () => {
        const first = mergeWithAnchors(null, FRESH_MD, META);

        // freshMd 完全相同内容但 lastUpdated 不同
        const freshMd2 = FRESH_MD.replace('2024-01-01T00:00:00.000Z', '2099-12-31T00:00:00.000Z');
        const second = mergeWithAnchors(first.mergedMd, freshMd2, META);

        // 全部 kept，应保留旧 prelude（旧 lastUpdated）
        expect(second.mergedMd).toBe(first.mergedMd);
        expect(second.changedSlugs).toHaveLength(0);
    });

    it('有 section 改变时 prelude 用 fresh 的', () => {
        const first = mergeWithAnchors(null, FRESH_MD, META);

        const freshMd2 = [
            '---',
            'title: Test Repo',
            'lastUpdated: 2099-12-31T00:00:00.000Z',
            '---',
            '',
            '## 项目概述',
            '内容已改变！',
            '',
            '## 技术栈',
            'TypeScript + Node.js',
        ].join('\n');

        const second = mergeWithAnchors(first.mergedMd, freshMd2, META2);

        expect(second.changedSlugs).toContain('项目概述');
        // fresh prelude 被使用（含新 lastUpdated）
        expect(second.mergedMd).toContain('2099-12-31T00:00:00.000Z');
    });
});
