import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
    log: {
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        dim: vi.fn(),
    },
}));

import { WikiHandler } from '../resources/wiki.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('WikiHandler', () => {
    let tmpDir: string;
    let teamaiHome: string;
    let handler: WikiHandler;
    let teamConfig: TeamaiConfig;
    let localConfig: LocalConfig;

    beforeEach(async () => {
        tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-wiki-test-'));
        teamaiHome = path.join(tmpDir, '.teamai');

        const repoPath = path.join(tmpDir, 'team-repo');
        await fse.ensureDir(path.join(repoPath, 'wiki'));
        await fse.ensureDir(path.join(teamaiHome, 'wiki'));

        handler = new WikiHandler();

        teamConfig = {
            team: 'test',
            description: '',
            repo: 'https://git.woa.com/test/repo.git',
            provider: 'tgit' as const,
            reviewers: [],
            sharing: {
                skills: {},
                rules: { enforced: [] },
                docs: { localDir: '' },
                env: { injectShellProfile: true },
            },
            toolPaths: {
                claude: {
                    skills: '.claude/skills',
                    rules: '.claude/rules',
                },
            },
        };

        // Use project scope with projectRoot so getTeamaiHome returns the test tmpDir
        localConfig = {
            repo: {
                localPath: repoPath,
                remote: 'https://git.woa.com/test/repo.git',
            },
            username: 'testuser',
            updatePolicy: 'auto',
            additionalRoles: [],
            scope: 'project',
            projectRoot: tmpDir,
        };
    });

    afterEach(async () => {
        await fse.remove(tmpDir);
    });

    describe('scanLocalForPush', () => {
        it('detects new wiki page not in team repo', async () => {
            // Create local wiki page in shared location
            const localWiki = path.join(teamaiHome, 'wiki');
            await fse.ensureDir(path.join(localWiki, 'entities'));
            await fse.writeFile(
                path.join(localWiki, 'entities', 'test-module.md'),
                '---\ntitle: Test Module\ncategory: entity\n---\n\n# Test Module\n',
            );

            const items = await handler.scanLocalForPush(teamConfig, localConfig);

            expect(items).toHaveLength(1);
            expect(items[0].name).toBe('entities/test-module');
            expect(items[0].status).toBe('new');
            expect(items[0].type).toBe('wiki');
        });

        it('detects modified wiki page', async () => {
            // Create page in team repo
            const teamWiki = path.join(localConfig.repo.localPath, 'wiki');
            await fse.ensureDir(path.join(teamWiki, 'entities'));
            await fse.writeFile(
                path.join(teamWiki, 'entities', 'test-module.md'),
                '# Test Module\nOld content',
            );

            // Create same page locally with different content
            const localWiki = path.join(teamaiHome, 'wiki');
            await fse.ensureDir(path.join(localWiki, 'entities'));
            await fse.writeFile(
                path.join(localWiki, 'entities', 'test-module.md'),
                '# Test Module\nNew content',
            );

            const items = await handler.scanLocalForPush(teamConfig, localConfig);

            expect(items).toHaveLength(1);
            expect(items[0].name).toBe('entities/test-module');
            expect(items[0].status).toBe('modified');
        });

        it('skips unchanged wiki page', async () => {
            const content = '# Test Module\nSame content';

            // Create same content in both locations
            const teamWiki = path.join(localConfig.repo.localPath, 'wiki');
            await fse.ensureDir(path.join(teamWiki, 'entities'));
            await fse.writeFile(path.join(teamWiki, 'entities', 'test-module.md'), content);

            const localWiki = path.join(teamaiHome, 'wiki');
            await fse.ensureDir(path.join(localWiki, 'entities'));
            await fse.writeFile(path.join(localWiki, 'entities', 'test-module.md'), content);

            const items = await handler.scanLocalForPush(teamConfig, localConfig);

            expect(items).toHaveLength(0);
        });

        it('excludes _metadata.json from push', async () => {
            const localWiki = path.join(teamaiHome, 'wiki');
            await fse.writeFile(
                path.join(localWiki, '_metadata.json'),
                '{"version":1}',
            );

            const items = await handler.scanLocalForPush(teamConfig, localConfig);

            expect(items).toHaveLength(0);
        });
    });

    describe('scanTeamForPull', () => {
        it('lists wiki pages from team repo', async () => {
            const teamWiki = path.join(localConfig.repo.localPath, 'wiki');
            await fse.ensureDir(path.join(teamWiki, 'entities'));
            await fse.ensureDir(path.join(teamWiki, 'concepts'));
            await fse.writeFile(path.join(teamWiki, 'entities', 'foo.md'), '# Foo');
            await fse.writeFile(path.join(teamWiki, 'concepts', 'bar.md'), '# Bar');
            await fse.writeFile(path.join(teamWiki, 'index.md'), '# Index');

            const items = await handler.scanTeamForPull(teamConfig, localConfig);

            expect(items).toHaveLength(3);
            const names = items.map((i) => i.name).sort();
            expect(names).toEqual(['concepts/bar', 'entities/foo', 'index']);
        });

        it('returns empty when no wiki dir', async () => {
            // Remove wiki dir from team repo
            await fse.remove(path.join(localConfig.repo.localPath, 'wiki'));

            const items = await handler.scanTeamForPull(teamConfig, localConfig);

            expect(items).toHaveLength(0);
        });

        it('excludes _metadata.json from pull', async () => {
            const teamWiki = path.join(localConfig.repo.localPath, 'wiki');
            await fse.writeFile(path.join(teamWiki, '_metadata.json'), '{}');
            await fse.writeFile(path.join(teamWiki, 'index.md'), '# Index');

            const items = await handler.scanTeamForPull(teamConfig, localConfig);

            expect(items).toHaveLength(1);
            expect(items[0].name).toBe('index');
        });
    });

    describe('pushItem', () => {
        it('copies wiki page to team repo', async () => {
            const localWiki = path.join(teamaiHome, 'wiki');
            await fse.ensureDir(path.join(localWiki, 'entities'));
            const sourcePath = path.join(localWiki, 'entities', 'test.md');
            await fse.writeFile(sourcePath, '# Test');

            await handler.pushItem(
                {
                    name: 'entities/test',
                    type: 'wiki',
                    sourcePath,
                    relativePath: 'wiki/entities/test.md',
                    status: 'new',
                },
                teamConfig,
                localConfig,
            );

            const dest = path.join(localConfig.repo.localPath, 'wiki', 'entities', 'test.md');
            expect(await fse.pathExists(dest)).toBe(true);
            expect(await fse.readFile(dest, 'utf-8')).toBe('# Test');
        });
    });

    describe('pullItem', () => {
        it('copies wiki page to shared wiki location', async () => {
            const teamWiki = path.join(localConfig.repo.localPath, 'wiki');
            await fse.ensureDir(path.join(teamWiki, 'entities'));
            const sourcePath = path.join(teamWiki, 'entities', 'test.md');
            await fse.writeFile(sourcePath, '# Test from team');

            await handler.pullItem(
                {
                    name: 'entities/test',
                    type: 'wiki',
                    sourcePath,
                    relativePath: 'wiki/entities/test.md',
                },
                teamConfig,
                localConfig,
            );

            const dest = path.join(teamaiHome, 'wiki', 'entities', 'test.md');
            expect(await fse.pathExists(dest)).toBe(true);
            expect(await fse.readFile(dest, 'utf-8')).toBe('# Test from team');
        });
    });

    describe('rebuildMetadata', () => {
        it('rebuilds metadata from wiki pages', async () => {
            const wikiDir = path.join(teamaiHome, 'wiki');
            await fse.ensureDir(path.join(wikiDir, 'entities'));
            await fse.writeFile(
                path.join(wikiDir, 'entities', 'foo.md'),
                '---\ntitle: Foo\ncategory: entity\ntags: [core]\nupdated: 2026-04-08\n---\n\n# Foo\n\nSee [[bar]] for details.\n\n## Related\n- [[bar]]\n\n## Backlinks\n',
            );
            await fse.writeFile(
                path.join(wikiDir, 'entities', 'bar.md'),
                '---\ntitle: Bar\ncategory: entity\ntags: [util]\nupdated: 2026-04-08\n---\n\n# Bar\n\n## Related\n\n## Backlinks\n',
            );

            await WikiHandler.rebuildMetadata(localConfig);

            const metadataPath = path.join(wikiDir, '_metadata.json');
            expect(await fse.pathExists(metadataPath)).toBe(true);

            const metadata = JSON.parse(await fse.readFile(metadataPath, 'utf-8'));
            expect(metadata.stats.totalPages).toBe(2);
            expect(metadata.stats.totalLinks).toBe(1); // Only [[bar]] from foo
            expect(metadata.pages['entities/foo.md'].title).toBe('Foo');
            expect(metadata.pages['entities/foo.md'].outLinks).toContain('bar');
        });
    });
});
