// -*- coding: utf-8 -*-
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import { stringify as yamlStringify } from 'yaml';

import { loadRepoList } from '../repo-list/store.js';
import { isOrgEntry, type RepoListFile } from '../repo-list/schema.js';

describe('loadRepoList', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-repo-list-test-'));
    });

    afterEach(async () => {
        await fs.remove(tmpDir);
    });

    it('加载并校验合法的单仓 yaml', async () => {
        const content: RepoListFile = {
            version: 1,
            repos: [
                { url: 'https://github.com/org/repo-a', domain: '推理', priority: 'high' },
                { url: 'https://github.com/org/repo-b', priority: 'normal' },
            ],
        };
        const filePath = path.join(tmpDir, 'repos.yaml');
        await fs.writeFile(filePath, yamlStringify(content), 'utf8');

        const loaded = await loadRepoList(filePath);
        expect(loaded.version).toBe(1);
        expect(loaded.repos).toHaveLength(2);
        expect(loaded.repos[0]).toMatchObject({ url: 'https://github.com/org/repo-a', domain: '推理' });
    });

    it('文件不存在时抛 Error 包含文件路径', async () => {
        const missingPath = path.join(tmpDir, 'nonexistent.yaml');
        await expect(loadRepoList(missingPath)).rejects.toThrow(`Repo list not found: ${missingPath}`);
    });

    it('url 不合法时 zod 校验抛错', async () => {
        const filePath = path.join(tmpDir, 'bad.yaml');
        await fs.writeFile(filePath, yamlStringify({ version: 1, repos: [{ url: 'not-a-url' }] }), 'utf8');
        await expect(loadRepoList(filePath)).rejects.toThrow();
    });

    it('org entry 与 single entry 都被正确识别', async () => {
        const filePath = path.join(tmpDir, 'mixed.yaml');
        await fs.writeFile(filePath, yamlStringify({
            version: 1,
            repos: [
                { url: 'https://github.com/org/single-repo' },
                { org: 'https://github.com/myorg', default_domain: '平台' },
            ],
        }), 'utf8');

        const loaded = await loadRepoList(filePath);
        expect(loaded.repos).toHaveLength(2);

        const orgItem = loaded.repos[1];
        expect(isOrgEntry(orgItem)).toBe(true);
        if (isOrgEntry(orgItem)) {
            expect(orgItem.org).toBe('https://github.com/myorg');
        }

        const singleItem = loaded.repos[0];
        expect(isOrgEntry(singleItem)).toBe(false);
    });

    it('version 字段缺失时默认为 1', async () => {
        const filePath = path.join(tmpDir, 'no-version.yaml');
        await fs.writeFile(filePath, yamlStringify({ repos: [{ url: 'https://github.com/a/b' }] }), 'utf8');
        const loaded = await loadRepoList(filePath);
        expect(loaded.version).toBe(1);
    });

    it('文件超过 10 MB 时抛出 size 超限错误', async () => {
        const filePath = path.join(tmpDir, 'huge.yaml');
        // 写入 11 MB 内容（真实文件，非 mock fs.stat）
        const chunk = 'a'.repeat(1024 * 1024);
        let content = '';
        for (let i = 0; i < 11; i++) content += chunk;
        await fs.writeFile(filePath, content, 'utf8');

        await expect(loadRepoList(filePath)).rejects.toThrow('exceeds max allowed size 10MB');
    });
});
