// -*- coding: utf-8 -*-
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import { stringify as yamlStringify } from 'yaml';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../workflow-commands.js', () => ({ runShortcut: vi.fn() }));

vi.mock('../import-codebase.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../import-codebase.js')>()),
    refreshTeamwikiIndexes: vi.fn().mockResolvedValue(undefined),
    publishTeamwikiViaMR: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
    autoDetectInit: vi.fn().mockRejectedValue(new Error('no config in test')),
}));

// ─── Imports（after mocks）──────────────────────────────

import { importFromRepoList } from '../import-repo-list.js';
import { ImportFromRepo } from '../import-from-repo.js';
import { runShortcut } from '../workflow-commands.js';
import { DetachedTeamRepoError } from '../utils/git.js';
import { autoDetectInit } from '../config.js';
import { LocalConfigSchema, TeamaiConfigSchema } from '../types.js';
import { publishTeamwikiViaMR, refreshTeamwikiIndexes } from '../import-codebase.js';

// ─── Helpers ────────────────────────────────────────────

/** The `items` input entry of a repository the list names. */
function repoItem(url: string, entry: { domain?: string; auth?: string } = {}) {
    return { kind: 'repo', source: url, domain: entry.domain ?? '', auth: entry.auth ?? '', slug: '', repo_url: '', mr_urls: [] };
}

/** The settings input of a list import, with `team_repo` the team repo that holds the teamwiki. */
function settings(teamRepo = ''): string {
    return JSON.stringify({ depth: 1, ssh: false, incremental: false, skip_enrich: false, max_files: 0, team_repo: teamRepo });
}

/** The inputs of the run `runShortcut` was asked to start. */
function startedInputs(): Record<string, unknown> {
    const [run] = vi.mocked(runShortcut).mock.calls[0] ?? [];

    if (!run) throw new Error('No run was started');

    return run.inputs;
}

/** Collects what the batch says on stdout while `body` runs. */
async function linesOf(body: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });

    try {
        await body();
    } finally {
        spy.mockRestore();
    }

    return lines.join('\n');
}

// ─── Tests ──────────────────────────────────────────────

describe('importFromRepoList', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-import-list-test-'));
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        await fs.ensureDir(path.join(tmpDir, '.teamai'));
        vi.clearAllMocks();
        vi.mocked(autoDetectInit).mockRejectedValue(new Error('no config in test'));
    });

    afterEach(async () => {
        process.exitCode = undefined;
        process.chdir(originalCwd);
        await fs.remove(tmpDir);
        vi.restoreAllMocks();
    });

    async function writeYaml(fileName: string, content: unknown): Promise<string> {
        const filePath = path.join(tmpDir, fileName);
        await fs.writeFile(filePath, yamlStringify(content), 'utf8');
        return filePath;
    }

    it.each([0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid concurrency %s before reading the list or preparing output', async (concurrency) => {
            const output = path.join(tmpDir, 'out');
            await expect(importFromRepoList({ listPath: path.join(tmpDir, 'missing.yaml'), concurrency, output }))
                .rejects.toThrow('--concurrency must be a positive safe integer');
            expect(runShortcut).not.toHaveBeenCalled();
            expect(await fs.pathExists(output)).toBe(false);
        },
    );

    it('rejects zero instead of leaving a nonempty batch pending', async () => {
        const listPath = await writeYaml('repos.yaml', { version: 1, repos: [{ url: 'https://github.com/org/repo' }] });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await expect(Promise.race([
                importFromRepoList({ listPath, concurrency: 0, dryRun: true }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Batch is still pending')), 250); }),
            ])).rejects.toThrow('--concurrency must be a positive safe integer');
            expect(runShortcut).not.toHaveBeenCalled();
        } finally {
            clearTimeout(timer);
        }
    });

    it.each([1, 2, 3])('starts one run over every repository of the list, %i at a time', async (concurrency) => {
        const repos = Array.from({ length: 5 }, (_, i) => ({ url: `https://github.com/org/repo-${i}` }));
        const listPath = await writeYaml('repos.yaml', { version: 1, repos });

        await importFromRepoList({ listPath, concurrency, output: tmpDir });

        expect(runShortcut).toHaveBeenCalledTimes(1);
        expect(startedInputs()).toMatchObject({ mode: 'list', concurrency, items: repos.map(({ url }) => repoItem(url)) });
    });

    it('exits 1 and names the retry command for each repo whose deep enrich did not finish', async () => {
        const wikiRoot = path.join(tmpDir, 'wiki', 'teamwiki');
        const finishItem = async (url: string, slug: string, deep: string) => ImportFromRepo.finishItem({
            item: JSON.stringify(repoItem(url)), settings: settings(), wikiRoot, mode: 'list', slug, head: '', deep, deepFailure: '',
        });

        const output = await linesOf(async () => {
            expect(await finishItem('https://github.com/org/repo-1', 'github__org__repo-1', 'true')).toEqual({ deep_complete: true });
            expect(await finishItem('https://github.com/org/repo-2', 'github__org__repo-2', 'false')).toEqual({ deep_complete: false });
        });

        expect(output).toContain(
            `Deep enrich incomplete: github__org__repo-2. Run \`teamai codebase --deep-enrich --project github__org__repo-2 --output ${path.join(tmpDir, 'wiki')}\` to retry.`,
        );
        expect(output).not.toContain('Deep enrich incomplete: github__org__repo-1');

        const results = [
            { item: repoItem('https://github.com/org/repo-1'), outcome: 'success', outputs: { slug: 'github__org__repo-1', updated: true, deep_complete: true } },
            { item: repoItem('https://github.com/org/repo-2'), outcome: 'success', outputs: { slug: 'github__org__repo-2', updated: true, deep_complete: false } },
        ];
        const end = await ImportFromRepo.finish({ mode: 'list', wikiRoot, settings: settings(), skipped: '0', results: JSON.stringify(results) });
        expect(end).toMatchObject({ text: 'Batch import complete: 2 succeeded, 0 failed, 0 skipped', exit_code: 1 });
    });

    it('names the deep-enrich retry with no --output in a team repo', async () => {
        const localPath = path.join(tmpDir, 'team-repo');
        const output = await linesOf(async () => ImportFromRepo.finishItem({
            item: JSON.stringify(repoItem('https://github.com/org/repo-2', { auth: 'ssh', domain: 'billing' })),
            settings: settings(localPath), wikiRoot: path.join(localPath, 'teamwiki'), mode: 'list', slug: 'github__org__repo-2', head: '', deep: 'false', deepFailure: '',
        }));

        expect(output).toContain('Deep enrich incomplete: github__org__repo-2. Run `teamai codebase --deep-enrich --project github__org__repo-2` to retry.');
    });

    it('gives the run each repository with its domain and auth, and the org entries it skipped', async () => {
        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [
                { org: 'https://github.com/myorg', default_domain: '平台' },
                { url: 'https://github.com/org/repo-1', domain: '推理', auth: 'ssh' },
                { url: 'https://github.com/org/repo-2', domain: '训练' },
            ],
        });

        expect(await importFromRepoList({ listPath: filePath, output: tmpDir })).toEqual({ kind: 'run', end: undefined });

        expect(startedInputs()).toMatchObject({
            wiki_root: path.join(tmpDir, 'teamwiki'),
            items: [repoItem('https://github.com/org/repo-1', { domain: '推理', auth: 'ssh' }), repoItem('https://github.com/org/repo-2', { domain: '训练' })],
            skipped: 1,
        });
    });

    it('sums up a batch where one repository failed, which does not stop the others, and exits 1', async () => {
        const wikiRoot = path.join(tmpDir, 'out', 'teamwiki');
        await fs.ensureDir(wikiRoot);
        const results = [
            { item: repoItem('https://github.com/org/fail-repo'), outcome: 'failed', outputs: null },
            { item: repoItem('https://github.com/org/success-repo'), outcome: 'success', outputs: { slug: 'github__org__success-repo', updated: true, deep_complete: true } },
        ];
        let end: Awaited<ReturnType<typeof ImportFromRepo.finish>> | undefined;

        const output = await linesOf(async () => {
            end = await ImportFromRepo.finish({ mode: 'list', wikiRoot, settings: settings(), skipped: '1', results: JSON.stringify(results) });
        });

        expect(end).toMatchObject({
            text: 'Batch import complete: 1 succeeded, 1 failed, 1 skipped',
            exit_code: 1,
            imported: [
                { source: 'https://github.com/org/fail-repo', slug: '', updated: false, failed: true },
                { source: 'https://github.com/org/success-repo', slug: 'github__org__success-repo', updated: true, failed: false },
            ],
        });
        expect(output).toContain('import failed: https://github.com/org/fail-repo');
    });

    it('priority=high 条目优先排序：先于 normal', async () => {
        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [
                { url: 'https://github.com/org/normal-repo', priority: 'normal' },
                { url: 'https://github.com/org/high-repo', priority: 'high' },
            ],
        });

        await importFromRepoList({ listPath: filePath, concurrency: 1, output: tmpDir });

        expect(startedInputs()['items']).toEqual([repoItem('https://github.com/org/high-repo'), repoItem('https://github.com/org/normal-repo')]);
    });

    it('--output: every repo and the index rebuild use <output>/teamwiki, and nothing is pushed', async () => {
        const output = path.join(tmpDir, 'out');
        await fs.ensureDir(path.join(output, 'teamwiki'));
        const filePath = await writeYaml('repos.yaml', { version: 1, repos: [{ url: 'https://github.com/org/repo-1' }] });

        await importFromRepoList({ listPath: filePath, output });

        expect(startedInputs()).toMatchObject({ wiki_root: path.join(output, 'teamwiki'), settings: { team_repo: '' } });
        const results = [{ item: repoItem('https://github.com/org/repo-1'), outcome: 'success', outputs: { slug: 'github__org__repo-1', updated: true, deep_complete: true } }];
        await linesOf(async () => ImportFromRepo.finish({ mode: 'list', wikiRoot: path.join(output, 'teamwiki'), settings: settings(), skipped: '0', results: JSON.stringify(results) }));
        expect(refreshTeamwikiIndexes).toHaveBeenCalledWith(path.join(output, 'teamwiki'));
        expect(publishTeamwikiViaMR).not.toHaveBeenCalled();
    });

    it('propagates a detached-clone refusal from batch publishing', async () => {
        const localPath = path.join(tmpDir, 'team-repo');
        await fs.ensureDir(path.join(localPath, 'teamwiki'));
        vi.mocked(autoDetectInit).mockResolvedValueOnce({
            localConfig: LocalConfigSchema.parse({ repo: { localPath, remote: 'https://example.com/team.git' }, username: 'test', scope: 'project' }),
            teamConfig: TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.com/team.git' }),
        });
        const refusal = new DetachedTeamRepoError('main');
        vi.mocked(publishTeamwikiViaMR).mockRejectedValueOnce(refusal);
        const results = [{ item: repoItem('https://github.com/org/repo'), outcome: 'success', outputs: { slug: 'github__org__repo', updated: true, deep_complete: true } }];

        await expect(linesOf(async () => ImportFromRepo.finish({
            mode: 'list', wikiRoot: path.join(localPath, 'teamwiki'), settings: settings(localPath), skipped: '0', results: JSON.stringify(results),
        }))).rejects.toBe(refusal);
    });

    it('fails before importing anything when there is neither a team repo nor --output', async () => {
        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [{ url: 'https://github.com/org/repo-1' }],
        });

        await expect(importFromRepoList({ listPath: filePath })).rejects.toThrow('no config in test');
        expect(runShortcut).not.toHaveBeenCalled();
    });
});
