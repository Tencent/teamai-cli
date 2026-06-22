import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
    loadDomains,
    loadDomainsDraft,
    saveDomains,
    saveDomainsDraft,
    clearDomainsDraft,
    appendHistory,
} from '../domains/store.js';
import type { DomainsFile, HistoryEvent } from '../domains/schema.js';

/** 创建一个合法的 DomainsFile 用于测试。 */
function makeDomainsFile(overrides: Partial<DomainsFile> = {}): DomainsFile {
    return {
        version: 1,
        confidence_threshold: 0.6,
        domains: [
            {
                name: '基础设施',
                description: '底层基础设施',
                repos: [
                    {
                        url: 'https://github.com/org/infra',
                        confidence: 0.9,
                        signal: '包含 k8s 配置',
                        locked: false,
                    },
                ],
            },
        ],
        ...overrides,
    };
}

describe('domains store', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-domains-test-'));
    });

    afterEach(async () => {
        await fs.remove(tmpDir);
    });

    describe('loadDomains', () => {
        it('文件不存在时返回带空 domains 的默认值', async () => {
            const result = await loadDomains(tmpDir);
            expect(result.version).toBe(1);
            expect(result.domains).toEqual([]);
            expect(result.confidence_threshold).toBe(0.6);
        });

        it('加载写入的数据后应往返一致', async () => {
            const data = makeDomainsFile();
            await saveDomains(tmpDir, data);
            const loaded = await loadDomains(tmpDir);
            expect(loaded.version).toBe(1);
            expect(loaded.domains[0]?.name).toBe('基础设施');
            expect(loaded.domains[0]?.repos[0]?.url).toBe('https://github.com/org/infra');
        });

        it('加载非法 YAML 时应抛出含字段名的错误', async () => {
            const filePath = path.join(tmpDir, '.teamai', 'domains.yaml');
            await fs.ensureDir(path.dirname(filePath));
            // url 故意写成非法值
            await fs.writeFile(
                filePath,
                'version: 1\nconfidence_threshold: 0.6\n'
                    + 'domains:\n  - name: test\n    repos:\n'
                    + '      - url: not-valid-url\n',
                'utf8'
            );
            await expect(loadDomains(tmpDir)).rejects.toThrow(/Invalid domains file/);
        });
    });

    describe('loadDomainsDraft', () => {
        it('草稿不存在时返回 null', async () => {
            const result = await loadDomainsDraft(tmpDir);
            expect(result).toBeNull();
        });

        it('加载草稿后应往返一致', async () => {
            const data = makeDomainsFile({ generator: 'test-generator' });
            await saveDomainsDraft(tmpDir, data);
            const loaded = await loadDomainsDraft(tmpDir);
            expect(loaded).not.toBeNull();
            expect(loaded?.generator).toBe('test-generator');
        });
    });

    describe('saveDomains 与 saveDomainsDraft', () => {
        it('应写到不同路径', async () => {
            const data = makeDomainsFile();
            await saveDomains(tmpDir, data);
            await saveDomainsDraft(tmpDir, data);

            const domainsPath = path.join(tmpDir, '.teamai', 'domains.yaml');
            const draftPath = path.join(tmpDir, '.teamai', 'domains.draft.yaml');
            expect(await fs.pathExists(domainsPath)).toBe(true);
            expect(await fs.pathExists(draftPath)).toBe(true);
        });

        it('应自动创建父目录', async () => {
            const data = makeDomainsFile();
            await saveDomains(tmpDir, data);
            const domainsPath = path.join(tmpDir, '.teamai', 'domains.yaml');
            expect(await fs.pathExists(domainsPath)).toBe(true);
        });
    });

    describe('clearDomainsDraft', () => {
        it('草稿存在时应删除', async () => {
            const data = makeDomainsFile();
            await saveDomainsDraft(tmpDir, data);
            await clearDomainsDraft(tmpDir);
            const draftPath = path.join(tmpDir, '.teamai', 'domains.draft.yaml');
            expect(await fs.pathExists(draftPath)).toBe(false);
        });

        it('草稿不存在时不报错', async () => {
            await expect(clearDomainsDraft(tmpDir)).resolves.not.toThrow();
        });
    });

    describe('appendHistory', () => {
        it('多次调用应产生多行 jsonl', async () => {
            const event1: HistoryEvent = {
                ts: '2024-01-01T00:00:00.000Z',
                actor: 'user',
                action: 'accept',
                details: { count: 3 },
            };
            const event2: HistoryEvent = {
                ts: '2024-01-01T01:00:00.000Z',
                actor: 'ai',
                action: 'recommend',
                details: { domain: '基础设施' },
            };

            await appendHistory(tmpDir, event1);
            await appendHistory(tmpDir, event2);

            const historyPath = path.join(tmpDir, '.teamai', 'domains.history.jsonl');
            const content = await fs.readFile(historyPath, 'utf8');
            const lines = content.trim().split('\n');
            expect(lines).toHaveLength(2);

            const parsed1 = JSON.parse(lines[0]!) as HistoryEvent;
            const parsed2 = JSON.parse(lines[1]!) as HistoryEvent;
            expect(parsed1.action).toBe('accept');
            expect(parsed2.action).toBe('recommend');
        });

        it('history 文件父目录不存在时应自动创建', async () => {
            const event: HistoryEvent = {
                ts: '2024-01-01T00:00:00.000Z',
                actor: 'user',
                action: 'lock',
                details: { url: 'https://github.com/org/repo' },
            };
            await expect(appendHistory(tmpDir, event)).resolves.not.toThrow();
            const historyPath = path.join(tmpDir, '.teamai', 'domains.history.jsonl');
            expect(await fs.pathExists(historyPath)).toBe(true);
        });
    });

    describe('loadDomains — 文件大小限制', () => {
        it('文件超过 10 MB 时抛出 size 超限错误', async () => {
            const domainsPath = path.join(tmpDir, '.teamai', 'domains.yaml');
            await fs.ensureDir(path.join(tmpDir, '.teamai'));
            // 写入 11 MB 内容（真实文件，非 mock fs.stat）
            const chunk = 'a'.repeat(1024 * 1024); // 1 MB
            let content = '';
            for (let i = 0; i < 11; i++) content += chunk;
            await fs.writeFile(domainsPath, content, 'utf8');

            await expect(loadDomains(tmpDir)).rejects.toThrow('exceeds max allowed size 10MB');
        });
    });
});
