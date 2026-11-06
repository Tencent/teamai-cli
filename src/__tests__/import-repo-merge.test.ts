import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../clone.js', () => ({
    shallowClone: vi.fn(),
    shallowFetch: vi.fn(),
}));

vi.mock('../utils/prompt.js', () => ({
    askQuestion: vi.fn().mockResolvedValue('y'),
    askConfirmation: vi.fn().mockResolvedValue(true),
}));

vi.mock('../codebase.js', () => ({
    gatherRepoContext: vi.fn().mockResolvedValue('repository context'),
}));

vi.mock('../codebase-extract.js', () => ({
    extractCodebase: vi.fn(),
}));

vi.mock('../workflow-commands.js', () => ({ runShortcut: vi.fn() }));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
    autoDetectInit: vi.fn().mockRejectedValue(new Error('no config in test')),
}));

// ─── Imports (after mocks) ──────────────────────────────

import { shallowClone, shallowFetch } from '../clone.js';
import { extractCodebase } from '../codebase-extract.js';
import { runShortcut } from '../workflow-commands.js';
import { runImportSteps, type ImportStepAnswers } from './helpers/import-steps.js';

// ─── Constants ──────────────────────────────────────────

const CLONE_SHA = 'deadbeef1234567890abcdef1234567890abcdef';
const SLUG = 'github__owner__mergetest';

const DETERMINISTIC_OVERVIEW = [
    '---',
    'title: github__owner__mergetest overview',
    'domain: code-knowledge',
    '---',
    '',
    '# github__owner__mergetest',
    '',
    '**5 facts** extracted from 3 files.',
    'Graph: 4 nodes, 2 edges.',
    '',
    '## Module Structure',
    '',
    '| Module | Facts | Components | Interfaces |',
    '|--------|-------|------------|------------|',
    '| src | 3 | 2 | 1 |',
    '',
].join('\n');

/** What the tool answers for the repository's narrative, with a frontmatter of its own. */
const NARRATIVE = '---\ntitle: Test Repo\nlastUpdated: 2024-01-01T00:00:00.000Z\n---\n\n## 项目概述\n固定的项目概述内容，不会改变。\n\n## 技术栈\nTypeScript + vitest';

// ─── Helpers ────────────────────────────────────────────

async function makeWorkdir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-import-merge-test-'));
    await fs.ensureDir(path.join(tmpDir, '.teamai'));
    return tmpDir;
}

// ─── Tests ──────────────────────────────────────────────

describe('import --from-repo — AI narrative appended to overview.md', () => {
    let workdir: string;
    let output: string;
    let evidenceDir: string;
    let writesManifest: boolean;
    let deep: NonNullable<ImportStepAnswers['deep']>;
    const TEST_URL = 'https://github.com/owner/mergetest';

    /** The steps of an import of TEST_URL into `<output>/teamwiki`, as `mode` (the command that started it) runs them. */
    const importFromRepo = async ({ incremental = false, skipEnrich = false, mode = 'repo' }: { incremental?: boolean; skipEnrich?: boolean; mode?: string } = {}) => runImportSteps({
        workflow: 'teamai-import-from-repo',
        command: 'teamai import --from-repo',
        json: false,
        inputs: {
            wiki_root: path.join(output, 'teamwiki'),
            mode,
            items: [{ kind: 'repo', source: TEST_URL, domain: '', auth: '', slug: '', repo_url: '', mr_urls: [] }],
            settings: { depth: 1, ssh: false, incremental, skip_enrich: skipEnrich, max_files: 0, team_repo: '' },
            skipped: 0,
            concurrency: 1,
        },
    }, { narrative: () => ({ text: NARRATIVE, failure: '' }), deep: (slug) => deep(slug) });

    beforeEach(async () => {
        workdir = await makeWorkdir();
        output = path.join(workdir, '.teamai', 'team-repo');
        evidenceDir = path.join(output, 'teamwiki', 'evidence', 'code', SLUG);
        writesManifest = false;
        deep = () => 'complete';
        vi.mocked(runShortcut).mockImplementation(async (run) => runImportSteps(run, { narrative: () => ({ text: NARRATIVE, failure: '' }), deep: (slug) => deep(slug) }));
        vi.spyOn(process, 'cwd').mockReturnValue(workdir);
        process.env.TEAMAI_CACHE_DIR = path.join(workdir, 'cache');

        vi.mocked(shallowClone).mockImplementation(async (_url: string, localPath: string) => {
            await fs.ensureDir(path.join(localPath, '.git'));
            return { sha: CLONE_SHA, branch: 'main', cloneMethod: 'https-token' as const };
        });

        // Mock extractCodebase to simulate writing teamwiki evidence files into its staging root
        vi.mocked(extractCodebase).mockImplementation(async (opts) => {
            const wikiRoot = path.join(opts.outputRoot!, 'teamwiki');
            const stagedEvidence = path.join(wikiRoot, 'evidence', 'code', opts.project!);
            const indicesDir = path.join(wikiRoot, '.indices');

            await fs.ensureDir(stagedEvidence);
            await fs.ensureDir(indicesDir);
            await fs.writeFile(path.join(stagedEvidence, 'overview.md'), DETERMINISTIC_OVERVIEW, 'utf8');
            const manifest = JSON.stringify({ project: opts.project, headSha: CLONE_SHA, files: [] });
            await fs.writeFile(path.join(stagedEvidence, 'source-manifest.json'), manifest, 'utf8');
            await fs.writeFile(path.join(wikiRoot, 'source-manifest.json'), manifest, 'utf8');
            await fs.writeFile(path.join(indicesDir, 'graph-index.json'), JSON.stringify({ nodes: [], edges: [] }), 'utf8');
            await fs.writeFile(path.join(indicesDir, 'facts-cache.json'), '[]', 'utf8');
            // Deep enrich runs on an extraction that wrote a manifest.
            if (writesManifest) await fs.writeJson(path.join(stagedEvidence, '_manifest.json'), { components: [{ slug: 'src' }] });
            return true;
        });
    });

    afterEach(async () => {
        vi.clearAllMocks();
        process.exitCode = undefined;
        delete process.env.TEAMAI_CACHE_DIR;
        await fs.remove(workdir);
    });

    it('AI 叙事追加到 teamwiki evidence overview.md 末尾', async () => {
        await importFromRepo();

        const overviewPath = path.join(evidenceDir, 'overview.md');
        expect(await fs.pathExists(overviewPath)).toBe(true);

        const content = await fs.readFile(overviewPath, 'utf8');
        // 确定性内容（模块表格）在前
        expect(content).toContain('## Module Structure');
        // AI 叙事在后
        expect(content).toContain('## AI Architecture Narrative');
        expect(content).toContain('固定的项目概述内容，不会改变。');
        expect(content).toContain('技术栈');
    });

    it('import --from-repo exits 1 and names the retry command when deep enrich leaves AI docs missing', async () => {
        writesManifest = true;
        deep = () => 'incomplete';
        const lines: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
        try {
            const { importCmd } = await import('../import.js');
            await importCmd({ fromRepo: TEST_URL, output });
        } finally {
            spy.mockRestore();
        }

        expect(process.exitCode).toBe(1);
        expect(lines.join('\n')).toContain(
            `Deep enrich incomplete: ${SLUG}. Run \`teamai codebase --deep-enrich --project ${SLUG} --output ${output}\` to retry.`,
        );
        expect(await fs.pathExists(path.join(evidenceDir, 'overview.md'))).toBe(true);
    });

    it('says a failed deep-enrich run in the exit code, with no retry hint for a command that publishes the import itself', async () => {
        writesManifest = true;
        deep = () => ({ failure: 'teamwiki is locked' });
        const lines: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
        let ended: Awaited<ReturnType<typeof importFromRepo>>;
        try {
            ended = await importFromRepo({ mode: 'update' });
        } finally {
            spy.mockRestore();
        }

        expect(ended.outputs).toMatchObject({ exit_code: 1, imported: [{ slug: SLUG, updated: true, failed: false }] });
        expect(lines.join('\n')).toContain(`Deep enrich failed for ${SLUG}: teamwiki is locked`);
        expect(lines.join('\n')).not.toContain('Deep enrich incomplete');
    });

    it('docs/team-codebase/repos/ 不再被创建', async () => {
        await importFromRepo();

        const oldPath = path.join(output, 'docs', 'team-codebase', 'repos', `${SLUG}.md`);
        expect(await fs.pathExists(oldPath)).toBe(false);
    });

    it('skipEnrich 时不追加 AI 叙事', async () => {
        await importFromRepo({ skipEnrich: true });

        const content = await fs.readFile(path.join(evidenceDir, 'overview.md'), 'utf8');
        expect(content).not.toContain('## AI Architecture Narrative');
    });

    it('--output <dir> writes <dir>/teamwiki, not a sibling of <dir>', async () => {
        await importFromRepo({ skipEnrich: true });

        expect(await fs.pathExists(path.join(output, 'teamwiki', 'evidence', 'code', SLUG, 'overview.md'))).toBe(true);
        expect(await fs.pathExists(path.join(workdir, '.teamai', 'teamwiki'))).toBe(false);
    });

    it('extracts in a staging dir: the clone cache gets no teamwiki/, the codebase keeps its own graph and caches', async () => {
        await importFromRepo({ skipEnrich: true });

        const cacheDir = path.join(workdir, 'cache', 'github', 'owner', 'mergetest');
        expect(vi.mocked(extractCodebase).mock.calls[0]?.[0]).toMatchObject({ path: cacheDir, project: SLUG });
        expect(vi.mocked(extractCodebase).mock.calls[0]?.[0]?.outputRoot).not.toContain(cacheDir);
        expect(await fs.pathExists(path.join(cacheDir, 'teamwiki'))).toBe(false);
        expect(await fs.pathExists(path.join(evidenceDir, '.indices', 'graph-index.json'))).toBe(true);
        expect(await fs.pathExists(path.join(evidenceDir, '.indices', 'facts-cache.json'))).toBe(true);
        expect(await fs.pathExists(path.join(evidenceDir, 'source-manifest.json'))).toBe(true);
    });

    it('fails before cloning when there is neither a team repo nor --output', async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const { importCmd } = await import('../import.js');
            await importCmd({ fromRepo: TEST_URL });
            expect(exit).toHaveBeenCalledWith(1);
        } finally {
            exit.mockRestore();
            error.mockRestore();
        }

        expect(shallowClone).not.toHaveBeenCalled();
        expect(runShortcut).not.toHaveBeenCalled();
    });

    it('retries extraction after a failed import of the same commit', async () => {
        vi.mocked(extractCodebase).mockRejectedValueOnce(new Error('write failed'));
        vi.mocked(shallowFetch).mockResolvedValue({ sha: CLONE_SHA });
        const options = { incremental: true, skipEnrich: true };
        const lastSyncPath = path.join(workdir, 'cache', 'github', 'owner', 'mergetest', 'LAST_SYNC');
        await fs.ensureDir(path.join(path.dirname(lastSyncPath), '.git'));
        await fs.writeFile(lastSyncPath, 'previous-sha\n2024-01-01T00:00:00.000Z\n');

        expect((await importFromRepo(options)).outputs).toMatchObject({ exit_code: 1, imported: [{ failed: true }] });
        expect(await fs.readFile(lastSyncPath, 'utf8')).toContain('previous-sha');

        await importFromRepo(options);
        expect(extractCodebase).toHaveBeenCalledTimes(2);
        expect(shallowFetch).toHaveBeenCalledTimes(2);
        expect(await fs.readFile(lastSyncPath, 'utf8')).toContain(CLONE_SHA);
    });

    it('does not skip an unchanged clone cache when the target teamwiki has not been imported at that commit', async () => {
        vi.mocked(shallowFetch).mockResolvedValue({ sha: CLONE_SHA });
        const cacheDir = path.join(workdir, 'cache', 'github', 'owner', 'mergetest');
        await fs.ensureDir(path.join(cacheDir, '.git'));
        await fs.writeFile(path.join(cacheDir, 'LAST_SYNC'), `${CLONE_SHA}\n2024-01-01T00:00:00.000Z\n`);

        // Another --output (or team repo) imported this commit; this one has nothing yet.
        await importFromRepo({ incremental: true, skipEnrich: true });
        expect(extractCodebase).toHaveBeenCalledTimes(1);
        expect(await fs.pathExists(path.join(evidenceDir, 'overview.md'))).toBe(true);

        // Now it holds the commit, so the next run skips it.
        await importFromRepo({ incremental: true, skipEnrich: true });
        expect(extractCodebase).toHaveBeenCalledTimes(1);
    });

    it('seeds the codebase\'s own baseline, so an incremental run extracts incrementally', async () => {
        await importFromRepo({ skipEnrich: true });
        vi.mocked(shallowFetch).mockResolvedValue({ sha: 'cafebabe1234567890abcdef1234567890abcdef' });

        let seededManifest: unknown = null;
        vi.mocked(extractCodebase).mockImplementationOnce(async (opts) => {
            seededManifest = await fs.readJson(path.join(opts.outputRoot!, 'teamwiki', 'source-manifest.json')).catch(() => null);
            return true;
        });
        await importFromRepo({ incremental: true, skipEnrich: true });

        expect(vi.mocked(extractCodebase).mock.calls.map(([opts]) => opts.incremental)).toEqual([false, true]);
        expect(seededManifest).toMatchObject({ project: SLUG, headSha: CLONE_SHA });
    });

    it('keeps the published evidence when an incremental run finds no source changes', async () => {
        await importFromRepo({ skipEnrich: true });
        const before = await fs.readFile(path.join(evidenceDir, 'overview.md'), 'utf8');
        vi.mocked(shallowFetch).mockResolvedValue({ sha: 'cafebabe1234567890abcdef1234567890abcdef' });
        // A commit that touched no source file: the extractor writes nothing.
        vi.mocked(extractCodebase).mockResolvedValueOnce(false);

        await importFromRepo({ incremental: true, skipEnrich: true });

        expect(await fs.readFile(path.join(evidenceDir, 'overview.md'), 'utf8')).toBe(before);
        expect(await fs.pathExists(path.join(evidenceDir, '.indices', 'graph-index.json'))).toBe(true);
    });
});
