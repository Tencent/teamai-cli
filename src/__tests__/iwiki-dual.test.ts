import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
    spinner: vi.fn(async () => ({ succeed: vi.fn(), fail: vi.fn() })),
}));

vi.mock('../utils/iwiki-client.js', () => ({
    IWikiClient: vi.fn().mockImplementation(function () {
        return {
            fetchAllPages: vi.fn().mockResolvedValue([{ docid: '123', title: 'Test Page' }, { docid: '124', title: 'Second' }]),
            getDocument: vi.fn().mockImplementation(async (docid: string) => ({ docid, title: `Page ${docid}`, content: `Content of ${docid}` })),
        };
    }),
}));

import { ImportFromIwiki } from '../import-iwiki.js';
import { writeSections } from '../iwiki-dual.js';
import { loadPendingReview } from '../review-store.js';
import { log } from '../utils/logger.js';

const VALID_AI_OUTPUT = JSON.stringify({
    'business-api': '## 业务接口\n接口列表...',
    'external-knowledge': '## 外部知识\n知识列表...',
    'glossary': '| 术语 | 说明 |\n|------|------|\n| foo | bar |',
});

let cwd: string;

beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-iwiki-dual-test-'));
    vi.clearAllMocks();
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.remove(cwd);
});

/** write-sections as the teamai-import-from-iwiki step runs it, after the AI tool replied `reply`. */
function sections(reply: string, extra: { failure?: string; review?: string } = {}) {
    return writeSections({
        source: 'iwiki://123',
        reply,
        failure: extra.failure ?? '',
        sectionsDir: path.join(cwd, 'docs', 'team-codebase'),
        reviewDir: cwd,
        review: extra.review ?? 'false',
    });
}

describe('teamai import fetch-iwiki', () => {
    it('refuses to run without a token, saying where to get one', async () => {
        vi.stubEnv('TAI_PAT_TOKEN', '');
        vi.stubEnv('TEAMAI_RUN_DIR', cwd);

        await expect(ImportFromIwiki.fetch({ source: '12345', dual: 'false' })).rejects.toThrow(
            'Please set TAI_PAT_TOKEN environment variable (get it at: https://tai.it.woa.com/user/pat)',
        );
    });

    it('refuses input that is neither a space id nor a page URL', async () => {
        vi.stubEnv('TAI_PAT_TOKEN', 'token');
        vi.stubEnv('TEAMAI_RUN_DIR', cwd);

        await expect(ImportFromIwiki.fetch({ source: 'not-an-id', dual: 'false' })).rejects.toThrow('Unrecognized iWiki input format: "not-an-id"');
    });

    it('stores each page of a space in the run directory as a candidate, and with dual the text the AI tool is shown', async () => {
        vi.stubEnv('TAI_PAT_TOKEN', 'token');
        vi.stubEnv('TEAMAI_RUN_DIR', cwd);

        const fetched = await ImportFromIwiki.fetch({ source: '12345', dual: 'true' });

        expect(fetched).toEqual({
            source: 'iwiki://12345',
            documents: path.join(cwd, 'iwiki', 'documents.json'),
            candidates: [
                { path: 'iwiki://p/123', file: path.join(cwd, 'iwiki', '123.md') },
                { path: 'iwiki://p/124', file: path.join(cwd, 'iwiki', '124.md') },
            ],
            dual_context: '=== 123 ===\nContent of 123\n\n=== 124 ===\nContent of 124',
        });
        expect(await fs.readFile(path.join(cwd, 'iwiki', '124.md'), 'utf8')).toBe('Content of 124');
    });
});

describe('teamai import write-sections', () => {
    it('creates external-knowledge.md with the three sections the first time', async () => {
        await sections(VALID_AI_OUTPUT);

        const content = await fs.readFile(path.join(cwd, 'docs/team-codebase/external-knowledge.md'), 'utf8');
        expect(content).toContain('## 业务接口');
        expect(content).toContain('## 外部知识源');
        expect(content).toContain('## 术语表');
        expect(content).toContain('<!-- managed-by: import --from-iwiki, section: glossary, source: iwiki://123, syncedAt: ');
        expect(log.info).toHaveBeenCalledWith('iWiki dual-path complete: sections updated [business-api, external-knowledge, glossary]');
    });

    it('replaces a section in its anchors on a later import and leaves the sections it found empty as they were', async () => {
        await sections(VALID_AI_OUTPUT);

        await sections(JSON.stringify({ 'business-api': '## 更新后的接口', 'external-knowledge': '', 'glossary': '' }));

        const content = await fs.readFile(path.join(cwd, 'docs/team-codebase/external-knowledge.md'), 'utf8');
        expect(content).toContain('更新后的接口');
        expect(content).not.toContain('接口列表...');
        expect(content).toContain('| foo | bar |');
        expect(content).toContain('知识列表...');
        expect(log.warn).toHaveBeenCalledWith('iWiki dual import: Section "glossary" is empty; skipped.');
    });

    it('writes nothing when the reply is not JSON, and says so in English', async () => {
        await sections('not JSON');

        expect(await fs.pathExists(path.join(cwd, 'docs/team-codebase/external-knowledge.md'))).toBe(false);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('AI output is not valid JSON'));
        expect(log.info).toHaveBeenCalledWith('iWiki dual-path complete: sections updated []');
    });

    it('writes nothing when the AI tool did not answer, and says why without failing the import', async () => {
        await expect(sections('', { failure: 'claude exited 2: Authentication failed' })).resolves.toEqual({});

        expect(await fs.pathExists(path.join(cwd, 'docs'))).toBe(false);
        expect(log.warn).toHaveBeenCalledWith('iWiki dual-path error (non-blocking): claude exited 2: Authentication failed');
    });

    it('queues each section for review with --require-review and leaves external-knowledge.md alone', async () => {
        await sections(VALID_AI_OUTPUT, { review: 'true' });

        expect(await fs.pathExists(path.join(cwd, 'docs/team-codebase/external-knowledge.md'))).toBe(false);
        const queued = await loadPendingReview(cwd);
        expect(queued.map((entry) => [entry.kind, entry.target.section, entry.source])).toEqual([
            ['codebase-section', 'business-api', 'iwiki://123'],
            ['codebase-section', 'external-knowledge', 'iwiki://123'],
            ['codebase-section', 'glossary', 'iwiki://123'],
        ]);
        expect(log.info).toHaveBeenCalledWith('iWiki dual-path complete: sections updated [business-api, external-knowledge, glossary] (pending review)');
    });
});
