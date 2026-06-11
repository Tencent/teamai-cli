import { describe, it, expect } from 'vitest';

import {
    splitToSections,
    joinSections,
    parseSections,
    patchManagedSection,
    hashBody,
    mergeWithAnchors,
} from '../section-patcher.js';

// ─── hashBody ────────────────────────────────────────────

describe('hashBody', () => {
    it('相同输入产生相同 hash', () => {
        expect(hashBody('hello world')).toBe(hashBody('hello world'));
    });

    it('trailing whitespace 不影响 hash', () => {
        expect(hashBody('line1\nline2  \nline3')).toBe(hashBody('line1\nline2\nline3'));
    });

    it('前后空行不影响 hash', () => {
        expect(hashBody('\n\nhello\n\n')).toBe(hashBody('hello'));
    });

    it('返回 16 位 hex 字符串', () => {
        const h = hashBody('test');
        expect(h).toMatch(/^[0-9a-f]{16}$/);
    });
});

// ─── splitToSections ──────────────────────────────────────

describe('splitToSections', () => {
    it('纯 frontmatter + 多个 section → 正确切分', () => {
        const md = [
            '---',
            'title: Test',
            'lastUpdated: 2024-01-01',
            '---',
            '',
            '## 项目概述',
            '这是项目概述内容。',
            '',
            '## 技术栈',
            'TypeScript + Node.js',
        ].join('\n');

        const { prelude, sections } = splitToSections(md);

        expect(prelude).toContain('title: Test');
        expect(sections).toHaveLength(2);
        expect(sections[0].title).toBe('项目概述');
        expect(sections[0].slug).toBe('项目概述');
        expect(sections[0].body).toContain('这是项目概述内容');
        expect(sections[1].title).toBe('技术栈');
        expect(sections[1].slug).toBe('技术栈');
    });

    it('无 frontmatter → prelude 为空字符串（或只含 ## 前的内容）', () => {
        const md = '## 第一章\n内容一\n\n## 第二章\n内容二\n';
        const { prelude, sections } = splitToSections(md);

        expect(prelude.trim()).toBe('');
        expect(sections).toHaveLength(2);
        expect(sections[0].title).toBe('第一章');
    });

    it('标题重复 → 第二个 slug 加 -2', () => {
        const md = '## Overview\n内容1\n\n## Overview\n内容2\n';
        const { sections } = splitToSections(md);

        expect(sections).toHaveLength(2);
        expect(sections[0].slug).toBe('Overview');
        expect(sections[1].slug).toBe('Overview-2');
    });

    it('无任何 ## 标题 → sections 为空，prelude 为全文', () => {
        const md = '# 一级标题\n\n普通段落\n';
        const { prelude, sections } = splitToSections(md);

        expect(sections).toHaveLength(0);
        expect(prelude).toBe(md);
    });

    it('标题中含空格 → slug 用 - 替换空格', () => {
        const md = '## My Section Title\n内容\n';
        const { sections } = splitToSections(md);

        expect(sections[0].slug).toBe('My-Section-Title');
    });
});

// ─── joinSections × splitToSections 往返 ──────────────────

describe('joinSections × splitToSections 往返', () => {
    it('split 后 join 再 split 保持一致', () => {
        const md = [
            '---',
            'title: Demo',
            '---',
            '',
            '## Alpha',
            'alpha content',
            '',
            '## Beta',
            'beta content',
        ].join('\n');

        const { prelude, sections } = splitToSections(md);
        const joined = joinSections(prelude, sections);
        const { sections: sections2 } = parseSections(joined);

        expect(sections2).toHaveLength(2);
        expect(sections2[0].title).toBe('Alpha');
        expect(sections2[0].body.trim()).toBe('alpha content');
        expect(sections2[1].title).toBe('Beta');
        expect(sections2[1].body.trim()).toBe('beta content');
    });
});

// ─── parseSections ────────────────────────────────────────

describe('parseSections', () => {
    it('从含锚点的 md 中读出 section + 元数据', () => {
        const md = [
            '---',
            'title: Test',
            '---',
            '',
            '<!-- managed-by: import --from-repo, section: intro, source: https://github.com/a/b@deadbeef, syncedAt: 2024-01-01T00:00:00.000Z -->',
            '## Introduction',
            'Some intro text.',
            '<!-- /managed-by: intro -->',
            '',
            '<!-- managed-by: import --from-repo, section: setup, source: https://github.com/a/b@deadbeef, syncedAt: 2024-01-02T00:00:00.000Z -->',
            '## Setup',
            'Setup instructions.',
            '<!-- /managed-by: setup -->',
        ].join('\n');

        const { prelude, sections } = parseSections(md);

        expect(prelude).toContain('title: Test');
        expect(sections).toHaveLength(2);
        expect(sections[0].slug).toBe('intro');
        expect(sections[0].title).toBe('Introduction');
        expect(sections[0].body.trim()).toBe('Some intro text.');
        expect(sections[0].source).toBe('https://github.com/a/b@deadbeef');
        expect(sections[0].syncedAt).toBe('2024-01-01T00:00:00.000Z');
        expect(sections[1].slug).toBe('setup');
    });

    it('未配对的开锚抛 "unclosed anchor: <slug>"', () => {
        const md = [
            '<!-- managed-by: import --from-repo, section: orphan -->',
            '## Orphan',
            'content',
            // 没有闭锚
        ].join('\n');

        expect(() => parseSections(md)).toThrow('unclosed anchor: orphan');
    });

    it('完全无锚点 → sections=[], prelude=full md', () => {
        const md = '# Title\n\nSome content\n\n## Section\nBody text\n';
        const { prelude, sections } = parseSections(md);

        expect(sections).toHaveLength(0);
        expect(prelude).toBe(md);
    });
});

// ─── patchManagedSection ─────────────────────────────────

describe('patchManagedSection', () => {
    const md = [
        '<!-- managed-by: import --from-repo, section: alpha, source: repo@abc, syncedAt: 2024-01-01T00:00:00.000Z -->',
        '## Alpha',
        'Old alpha content.',
        '<!-- /managed-by: alpha -->',
        '',
        '<!-- managed-by: import --from-repo, section: beta, source: repo@abc, syncedAt: 2024-01-01T00:00:00.000Z -->',
        '## Beta',
        'Beta content stays.',
        '<!-- /managed-by: beta -->',
    ].join('\n');

    it('替换 body 不影响其他 section', () => {
        const result = patchManagedSection(md, 'alpha', 'New alpha content.', {
            source: 'repo@newsha',
            syncedAt: '2024-06-01T00:00:00.000Z',
        });

        expect(result).toContain('New alpha content.');
        expect(result).toContain('Beta content stays.');
        expect(result).not.toContain('Old alpha content.');
    });

    it('找不到 slug 时抛错', () => {
        expect(() => patchManagedSection(md, 'nonexistent', 'body', {})).toThrow(
            'section not found: nonexistent',
        );
    });
});

// ─── --from-iwiki 锚点兼容性（Blocker 1 修复验证）────────

describe('parseSections — 接受 --from-iwiki 锚点', () => {
    const iwikiMd = [
        '# 外部知识源',
        '',
        '<!-- managed-by: import --from-iwiki, section: external-knowledge, source: iwiki://456, syncedAt: 2024-01-01T00:00:00.000Z -->',
        '## 外部知识',
        'iwiki 章节内容',
        '<!-- /managed-by: external-knowledge -->',
        '',
        '<!-- managed-by: import --from-iwiki, section: glossary, source: iwiki://456, syncedAt: 2024-01-01T00:00:00.000Z -->',
        '## 术语表',
        '| 术语 | 说明 |',
        '<!-- /managed-by: glossary -->',
    ].join('\n');

    it('parseSections 能正确解析含 --from-iwiki 锚点的 md', () => {
        const { prelude, sections } = parseSections(iwikiMd);

        expect(prelude).toContain('外部知识源');
        expect(sections).toHaveLength(2);
        expect(sections[0].slug).toBe('external-knowledge');
        expect(sections[0].body).toContain('iwiki 章节内容');
        expect(sections[1].slug).toBe('glossary');
    });

    it('patchManagedSection 在含 --from-iwiki 锚点的 md 上 patch 成功', () => {
        const result = patchManagedSection(
            iwikiMd,
            'external-knowledge',
            '## 外部知识\n已 patch 的新内容',
            { source: 'iwiki://456', syncedAt: '2024-06-01T00:00:00.000Z' },
        );

        expect(result).toContain('已 patch 的新内容');
        expect(result).not.toContain('iwiki 章节内容');
        // 术语表章节不受影响
        expect(result).toContain('| 术语 | 说明 |');
    });
});

