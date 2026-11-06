import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../clone.js', () => ({
    shallowClone: vi.fn(),
    shallowFetch: vi.fn(),
}));

vi.mock('../codebase-extract.js', () => ({
    extractCodebase: vi.fn(),
}));

vi.mock('../utils/prompt.js', () => ({
    askQuestion: vi.fn().mockResolvedValue('y'),
    askConfirmation: vi.fn().mockResolvedValue(true),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
    autoDetectInit: vi.fn().mockRejectedValue(new Error('no config in test')),
}));

// ─── Imports (after mocks) ───────────────────────────────

import { shallowClone, shallowFetch } from '../clone.js';
import { extractCodebase } from '../codebase-extract.js';
import { runImportSteps } from './helpers/import-steps.js';

// ─── Constants ──────────────────────────────────────────

const CLONE_SHA = 'deadbeef1234567890abcdef1234567890abcdef';
const FETCH_SHA = 'cafebabe1234567890abcdef1234567890abcdef';

// ─── Helpers ────────────────────────────────────────────

async function makeWorkdir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-incremental-test-'));
    await fs.ensureDir(path.join(tmpDir, '.teamai'));
    return tmpDir;
}

async function makeFakeCache(
    baseDir: string,
    provider: string,
    owner: string,
    repo: string,
    sha: string,
): Promise<string> {
    const cacheDir = path.join(baseDir, 'cache', provider, owner, repo);
    await fs.ensureDir(path.join(cacheDir, '.git'));
    const isoTs = new Date().toISOString();
    await fs.writeFile(path.join(cacheDir, 'LAST_SYNC'), `${sha}\n${isoTs}\n`, 'utf8');
    return cacheDir;
}

// ─── Tests ──────────────────────────────────────────────

describe('import --from-repo — incremental mode', () => {
    let workdir: string;
    const FAKE_OLD_SHA = 'oldsha0001234567890abcdef1234567890abcdef';
    const TEST_URL = 'https://github.com/owner/testrepo';

    beforeEach(async () => {
        workdir = await makeWorkdir();
        vi.spyOn(process, 'cwd').mockReturnValue(workdir);
        process.env.TEAMAI_CACHE_DIR = path.join(workdir, 'cache');

        vi.mocked(shallowClone).mockImplementation(async (_url: string, localPath: string) => {
            await fs.ensureDir(localPath);
            return { sha: CLONE_SHA, branch: 'main', cloneMethod: 'https-token' as const };
        });

        vi.mocked(shallowFetch).mockImplementation(async (localPath: string) => {
            await fs.ensureDir(localPath);
            return { sha: FETCH_SHA };
        });

        vi.mocked(extractCodebase).mockImplementation(async (opts) => {
            const evidenceDir = path.join(opts.outputRoot!, 'teamwiki', 'evidence', 'code', opts.project!);
            await fs.ensureDir(evidenceDir);
            await fs.writeFile(path.join(evidenceDir, 'overview.md'), '---\ntitle: test\n---\n\n# Overview\n');
            return true;
        });
    });

    /** The steps of an `import --from-repo` run into `<workdir>/.teamai/team-repo/teamwiki`. */
    const importFromRepo = async ({ incremental }: { incremental: boolean }): Promise<void> => {
        const ended = await runImportSteps({
        workflow: 'teamai-import-from-repo',
        command: 'teamai import --from-repo',
        json: false,
        inputs: {
            wiki_root: path.join(workdir, '.teamai', 'team-repo', 'teamwiki'),
            mode: 'repo',
            items: [{ kind: 'repo', source: TEST_URL, domain: '', auth: '', slug: '', repo_url: '', mr_urls: [] }],
            settings: { depth: 1, ssh: false, incremental, skip_enrich: true, max_files: 0, team_repo: '' },
            skipped: 0,
            concurrency: 1,
        },
        });
        expect(ended.outputs?.exit_code).toBe(0);
    };

    afterEach(async () => {
        process.exitCode = undefined;
        vi.restoreAllMocks();
        vi.clearAllMocks();
        delete process.env.TEAMAI_CACHE_DIR;
        await fs.remove(workdir);
    });

    it('缓存不存在时走全量 clone，不调 shallowFetch', async () => {
        await importFromRepo({ incremental: true });

        expect(shallowClone).toHaveBeenCalledTimes(1);
        expect(shallowFetch).not.toHaveBeenCalled();
    });

    it('缓存存在 + LAST_SYNC + incremental=true → 走 fetch，不调 shallowClone', async () => {
        await makeFakeCache(workdir, 'github', 'owner', 'testrepo', FAKE_OLD_SHA);

        await importFromRepo({ incremental: true });

        expect(shallowFetch).toHaveBeenCalledTimes(1);
        expect(shallowClone).not.toHaveBeenCalled();
    });

    it('增量 fetch 失败时 fallback 到 shallowClone', async () => {
        await makeFakeCache(workdir, 'github', 'owner', 'testrepo', FAKE_OLD_SHA);
        vi.mocked(shallowFetch).mockRejectedValueOnce(new Error('network error'));

        await importFromRepo({ incremental: true });

        expect(shallowFetch).toHaveBeenCalledTimes(1);
        expect(shallowClone).toHaveBeenCalledTimes(1);
    });

    it('incremental=false 时即使有缓存也走全量 clone', async () => {
        await makeFakeCache(workdir, 'github', 'owner', 'testrepo', FAKE_OLD_SHA);

        await importFromRepo({ incremental: false });

        expect(shallowClone).toHaveBeenCalledTimes(1);
        expect(shallowFetch).not.toHaveBeenCalled();
    });

    it('全量 clone 后写入 LAST_SYNC', async () => {
        await importFromRepo({ incremental: false });

        const lastSyncPath = path.join(workdir, 'cache', 'github', 'owner', 'testrepo', 'LAST_SYNC');
        const exists = await fs.pathExists(lastSyncPath);
        expect(exists).toBe(true);
        const content = await fs.readFile(lastSyncPath, 'utf8');
        expect(content).toContain('deadbeef');
    });

});

