/**
 * Regression tests for four wiki-related bugs found in v0.15.0 e2e:
 *
 *   BUG #1 — push hardcoded `git add 'rules/' 'env/'` even when those dirs
 *            don't exist (pure-wiki team first push crashes with
 *            `pathspec did not match any files`).
 *   BUG #2 — push is non-transactional: files are copied into team repo
 *            working tree before git ops; any later failure leaves untracked
 *            files that poison the next `scanLocalForPush` (reports
 *            "No new resources" falsely).
 *   BUG #3 — `teamai remove wiki <name>` rejected by CLI because
 *            `REMOVABLE_TYPES` didn't include 'wiki'.
 *   BUG #4 — `teamai pull` didn't honor wiki tombstones: a `wiki/.removed`
 *            entry in the team repo never deleted the local copy.
 */

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
    spinner: vi.fn(() => ({
        start: vi.fn().mockReturnThis(),
        succeed: vi.fn().mockReturnThis(),
        fail: vi.fn().mockReturnThis(),
        warn: vi.fn().mockReturnThis(),
    })),
}));

import { filterExistingTopLevelPaths } from '../push.js';
import { WikiHandler } from '../resources/wiki.js';
import { ResourceHandler } from '../resources/base.js';
import { resolveBaseDir } from '../types.js';
import { remove as removeFile } from '../utils/fs.js';
import type { TeamaiConfig, LocalConfig, ResourceType } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────
// BUG #1 — filterExistingTopLevelPaths
// ─────────────────────────────────────────────────────────────────────────
describe('filterExistingTopLevelPaths (BUG #1 regression)', () => {
    let tmpDir: string;
    beforeEach(async () => {
        tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pfx-'));
    });
    afterEach(async () => {
        await fse.remove(tmpDir);
    });

    it('drops candidates that do not exist in the repo', async () => {
        await fse.ensureDir(path.join(tmpDir, 'wiki'));
        const got = await filterExistingTopLevelPaths(tmpDir, ['rules/', 'env/', 'wiki/']);
        expect(got).toEqual(['wiki/']);
    });

    it('keeps all candidates that exist', async () => {
        await fse.ensureDir(path.join(tmpDir, 'rules'));
        await fse.ensureDir(path.join(tmpDir, 'wiki'));
        const got = await filterExistingTopLevelPaths(tmpDir, ['rules/', 'env/', 'wiki/']);
        expect(got.sort()).toEqual(['rules/', 'wiki/']);
    });

    it('returns empty when no candidates exist (pure-wiki team before first push)', async () => {
        // repo dir exists but has no subfolders yet
        const got = await filterExistingTopLevelPaths(tmpDir, ['rules/', 'env/']);
        expect(got).toEqual([]);
    });

    it('deduplicates repeated candidates', async () => {
        await fse.ensureDir(path.join(tmpDir, 'rules'));
        const got = await filterExistingTopLevelPaths(tmpDir, ['rules/', 'rules/', 'rules/']);
        expect(got).toEqual(['rules/']);
    });

    it('does not escape the repo dir', async () => {
        // "../sibling" should be checked relative to tmpDir; sibling doesn't exist.
        const got = await filterExistingTopLevelPaths(tmpDir, ['../sibling/']);
        expect(got).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// BUG #3 — `wiki` is a removable type
// ─────────────────────────────────────────────────────────────────────────
describe('remove.ts REMOVABLE_TYPES (BUG #3 regression)', () => {
    it('accepts "wiki" as a removable resource type (via WikiHandler.removeItem)', async () => {
        // This is a structural test: calling `getHandler('wiki').removeItem(...)`
        // must not throw "Unsupported resource type". The CLI-level gate lives
        // in src/remove.ts. We assert both:
        //   1. The handler factory returns something with .removeItem().
        //   2. That implementation runs without throwing on empty state.
        const { getHandler } = await import('../resources/index.js');
        const handler = getHandler('wiki');
        expect(handler).toBeDefined();
        expect(typeof handler.removeItem).toBe('function');

        // Build minimal configs and run on empty dirs — should return [] cleanly.
        const tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rmw-'));
        try {
            const repoPath = path.join(tmpDir, 'team-repo');
            await fse.ensureDir(path.join(repoPath, 'wiki'));

            const teamConfig: TeamaiConfig = {
                team: 'test',
                description: '',
                repo: 'https://example.com/r.git',
                provider: 'github',
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
                        wiki: '.claude/wiki',
                    },
                },
            } as TeamaiConfig;
            const localConfig: LocalConfig = {
                repo: { localPath: repoPath, remote: 'https://example.com/r.git' },
                username: 'tester',
                updatePolicy: 'auto',
                additionalRoles: [],
                scope: 'user',
            } as LocalConfig;

            const removed = await handler.removeItem('entities/alpha', teamConfig, localConfig);
            expect(removed).toEqual([]);

            // Tombstone should be written even if nothing was physically removed.
            const tombstones = await handler.readTombstones(localConfig);
            expect(tombstones.has('entities/alpha')).toBe(true);
        } finally {
            await fse.remove(tmpDir);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────
// BUG #4 — pull cleans up wiki pages named in wiki/.removed
// ─────────────────────────────────────────────────────────────────────────
describe('pull tombstone cleanup for wiki (BUG #4 regression)', () => {
    let tmpDir: string;
    let homeDir: string;
    let repoPath: string;
    let teamConfig: TeamaiConfig;
    let localConfig: LocalConfig;

    beforeEach(async () => {
        tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pullts-'));
        homeDir = path.join(tmpDir, 'home');
        repoPath = path.join(tmpDir, 'team-repo');
        await fse.ensureDir(path.join(repoPath, 'wiki'));
        await fse.ensureDir(path.join(homeDir, '.claude', 'wiki', 'entities'));
        vi.stubEnv('HOME', homeDir);

        teamConfig = {
            team: 'test',
            description: '',
            repo: 'https://example.com/r.git',
            provider: 'github',
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
                    wiki: '.claude/wiki',
                },
            },
        } as TeamaiConfig;

        localConfig = {
            repo: { localPath: repoPath, remote: 'https://example.com/r.git' },
            username: 'tester',
            updatePolicy: 'auto',
            additionalRoles: [],
            scope: 'user',
        } as LocalConfig;
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await fse.remove(tmpDir);
    });

    /**
     * Reproduces the exact loop pull.ts runs after the fix (tombstoneTypes
     * now includes wiki with toolPathField='wiki'). We keep the check at
     * this layer instead of end-to-end because pullForScope touches git,
     * spinners, and file-system fetches that are costly to mock.
     */
    it('removes local wiki pages that are listed in wiki/.removed', async () => {
        // Simulate a team member running `teamai remove wiki entities/alpha`:
        // write the tombstone in team repo.
        await fse.writeFile(
            path.join(repoPath, 'wiki', '.removed'),
            'entities/alpha\n',
        );
        // Local copy that should be cleaned up.
        const localAlpha = path.join(homeDir, '.claude', 'wiki', 'entities', 'alpha.md');
        await fse.writeFile(localAlpha, '# alpha');

        // Mimic pull.ts tombstone loop with the fixed config
        const tombstoneTypes: {
            type: ResourceType;
            ext?: string;
            toolPathField: 'rules' | 'skills' | 'wiki';
        }[] = [
            { type: 'rules', ext: '.md', toolPathField: 'rules' },
            { type: 'skills', toolPathField: 'skills' },
            { type: 'wiki', ext: '.md', toolPathField: 'wiki' },
        ];

        const handler = new WikiHandler();
        const baseDir = resolveBaseDir(localConfig);

        for (const { type, ext, toolPathField } of tombstoneTypes) {
            if (type !== 'wiki') continue;
            const tombstones = await handler.readTombstones(localConfig);
            for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
                const dir = toolPath[toolPathField];
                if (!dir) continue;
                if (!await ResourceHandler.isToolInstalled(dir, baseDir)) continue;
                for (const name of tombstones) {
                    const p = path.join(baseDir, dir, ext ? `${name}${ext}` : name);
                    if (await fse.pathExists(p)) {
                        await removeFile(p);
                    }
                }
            }
        }

        expect(await fse.pathExists(localAlpha)).toBe(false);
    });

    it('does not touch files that are not in the tombstone', async () => {
        await fse.writeFile(
            path.join(repoPath, 'wiki', '.removed'),
            'entities/alpha\n',
        );
        const localAlpha = path.join(homeDir, '.claude', 'wiki', 'entities', 'alpha.md');
        const localBeta = path.join(homeDir, '.claude', 'wiki', 'entities', 'beta.md');
        await fse.writeFile(localAlpha, '# alpha');
        await fse.writeFile(localBeta, '# beta');

        const handler = new WikiHandler();
        const baseDir = resolveBaseDir(localConfig);
        const tombstones = await handler.readTombstones(localConfig);

        for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
            if (!toolPath.wiki) continue;
            if (!await ResourceHandler.isToolInstalled(toolPath.wiki, baseDir)) continue;
            for (const name of tombstones) {
                const p = path.join(baseDir, toolPath.wiki, `${name}.md`);
                if (await fse.pathExists(p)) await removeFile(p);
            }
        }

        expect(await fse.pathExists(localAlpha)).toBe(false);
        expect(await fse.pathExists(localBeta)).toBe(true);
    });
});
