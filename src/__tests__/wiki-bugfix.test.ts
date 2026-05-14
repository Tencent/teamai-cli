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
 *
 *   NOTE (refactored for shared wiki location):
 *   With the wiki refactoring, BUG #4 no longer iterates through per-tool
 *   wiki directories. Instead, pull.ts has a dedicated wiki tombstone cleanup
 *   block that removes pages from the shared wiki location (~/.teamai/wiki/).
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
import { remove as removeFile } from '../utils/fs.js';
import { getTeamaiHome } from '../types.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

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
            const teamaiHome = path.join(tmpDir, '.teamai');
            await fse.ensureDir(path.join(teamaiHome, 'wiki'));

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
                    },
                },
            } as TeamaiConfig;
            const localConfig: LocalConfig = {
                repo: { localPath: repoPath, remote: 'https://example.com/r.git' },
                username: 'tester',
                updatePolicy: 'auto',
                additionalRoles: [],
                scope: 'project',
                projectRoot: tmpDir,
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
    let repoPath: string;
    let teamaiHome: string;
    let teamConfig: TeamaiConfig;
    let localConfig: LocalConfig;

    beforeEach(async () => {
        tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pullts-'));
        repoPath = path.join(tmpDir, 'team-repo');
        teamaiHome = path.join(tmpDir, '.teamai');

        await fse.ensureDir(path.join(repoPath, 'wiki'));
        await fse.ensureDir(path.join(teamaiHome, 'wiki', 'entities'));

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
                },
            },
        } as TeamaiConfig;

        localConfig = {
            repo: { localPath: repoPath, remote: 'https://example.com/r.git' },
            username: 'tester',
            updatePolicy: 'auto',
            additionalRoles: [],
            scope: 'project',
            projectRoot: tmpDir,
        } as LocalConfig;
    });

    afterEach(async () => {
        await fse.remove(tmpDir);
    });

    /**
     * Reproduces the new wiki tombstone cleanup logic in pull.ts.
     * With the refactoring, wiki tombstones are cleaned up from the shared
     * ~/.teamai/wiki/ location (or <projectRoot>/.teamai/wiki/ for project scope)
     * instead of iterating through per-tool directories.
     */
    it('removes local wiki pages that are listed in wiki/.removed', async () => {
        // Simulate a team member running `teamai remove wiki entities/alpha`:
        // write the tombstone in team repo.
        await fse.writeFile(
            path.join(repoPath, 'wiki', '.removed'),
            'entities/alpha\n',
        );
        // Local copy in shared wiki location that should be cleaned up.
        const localAlpha = path.join(teamaiHome, 'wiki', 'entities', 'alpha.md');
        await fse.writeFile(localAlpha, '# alpha');

        // Mimic pull.ts wiki tombstone cleanup with the new architecture
        const handler = new WikiHandler();
        const wikiTombstones = await handler.readTombstones(localConfig);

        if (wikiTombstones.size > 0) {
            const sharedWikiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
            const wikiDir = path.join(sharedWikiHome, 'wiki');
            for (const name of wikiTombstones) {
                const wikiPath = path.join(wikiDir, `${name}.md`);
                if (await fse.pathExists(wikiPath)) {
                    await removeFile(wikiPath);
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
        const localAlpha = path.join(teamaiHome, 'wiki', 'entities', 'alpha.md');
        const localBeta = path.join(teamaiHome, 'wiki', 'entities', 'beta.md');
        await fse.writeFile(localAlpha, '# alpha');
        await fse.writeFile(localBeta, '# beta');

        const handler = new WikiHandler();
        const wikiTombstones = await handler.readTombstones(localConfig);

        if (wikiTombstones.size > 0) {
            const sharedWikiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
            const wikiDir = path.join(sharedWikiHome, 'wiki');
            for (const name of wikiTombstones) {
                const wikiPath = path.join(wikiDir, `${name}.md`);
                if (await fse.pathExists(wikiPath)) {
                    await removeFile(wikiPath);
                }
            }
        }

        expect(await fse.pathExists(localAlpha)).toBe(false);
        expect(await fse.pathExists(localBeta)).toBe(true);
    });
});
