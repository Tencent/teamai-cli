/**
 * Regression tests for push path filtering (formerly part of the wiki-bugfix
 * suite; the wiki-specific cases were removed when the teamai-wiki resource
 * type was decommissioned — see issue #89).
 *
 *   BUG #1 — push hardcoded `git add 'rules/' 'env/'` even when those dirs
 *            don't exist (first push of a team without those dirs crashes
 *            with `pathspec did not match any files`).
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
        await fse.ensureDir(path.join(tmpDir, 'env'));
        const got = await filterExistingTopLevelPaths(tmpDir, ['rules/', 'env/']);
        expect(got).toEqual(['env/']);
    });

    it('keeps all candidates that exist', async () => {
        await fse.ensureDir(path.join(tmpDir, 'rules'));
        await fse.ensureDir(path.join(tmpDir, 'env'));
        const got = await filterExistingTopLevelPaths(tmpDir, ['rules/', 'env/']);
        expect(got.sort()).toEqual(['env/', 'rules/']);
    });

    it('returns empty when no candidates exist (team before first push)', async () => {
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
