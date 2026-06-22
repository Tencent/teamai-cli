import path from 'node:path';
import os from 'node:os';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';

import { lintTeamCodebase } from '../codebase-lint.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isoAgo(days: number): string {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return d.toISOString();
}

interface ScaffoldOptions {
    cwd: string;
    repoSlugs?: string[];
    domainNames?: string[];
    repoFrontmatter?: Record<string, unknown>;
    domainFrontmatter?: Record<string, unknown>;
    indexFrontmatter?: Record<string, unknown>;
    externalKnowledge?: string;
    domainsYaml?: string;
    repoWhitelist?: string;
    sourceMarks?: string;
    pendingReview?: string;
    repoCount?: number;
    domainCount?: number;
}

async function scaffold(opts: ScaffoldOptions): Promise<void> {
    const reposDir = path.join(opts.cwd, 'docs', 'team-codebase', 'repos');
    const domainsDir = path.join(opts.cwd, 'docs', 'team-codebase', 'domains');
    const teamaiDir = path.join(opts.cwd, '.teamai');

    await fs.ensureDir(reposDir);
    await fs.ensureDir(domainsDir);
    await fs.ensureDir(teamaiDir);

    // Default domains.yaml
    const defaultUrl = 'https://github.com/org/repo-a';
    const defaultSlug = 'github__org__repo-a';
    const slugs = opts.repoSlugs ?? [defaultSlug];
    const urls: string[] = [];
    for (const slug of slugs) {
        const parts = slug.split('__');
        if (parts.length === 3) {
            const [provider, owner, repo] = parts;
            if (provider === 'github') {
                urls.push(`https://github.com/${owner}/${repo}`);
            } else {
                urls.push(`https://git.woa.com/${owner}/${repo}`);
            }
        } else {
            urls.push(defaultUrl);
        }
    }

    const domainsYaml =
        opts.domainsYaml ??
        `version: 1\ndomains:\n  - name: core\n    description: core services\n    repos:\n${urls.map((u) => `      - url: "${u}"`).join('\n')}\n`;
    await fs.writeFile(path.join(teamaiDir, 'domains.yaml'), domainsYaml, 'utf8');

    // Default repo-whitelist.yaml (match the urls in domains.yaml)
    if (opts.repoWhitelist !== undefined) {
        await fs.writeFile(path.join(teamaiDir, 'repo-whitelist.yaml'), opts.repoWhitelist, 'utf8');
    } else {
        // Create a default whitelist matching the urls so whitelist cross-check passes
        const defaultWhitelist =
            `version: 1\nrepos:\n${urls.map((u) => `  - url: "${u}"`).join('\n')}\n`;
        await fs.writeFile(path.join(teamaiDir, 'repo-whitelist.yaml'), defaultWhitelist, 'utf8');
    }

    // Write repo .md files
    for (const slug of slugs) {
        const fm = {
            title: 'Codebase 概览',
            lastUpdated: isoAgo(1),
            source: opts.cwd,
            generator: 'teamai-cli',
            schemaVersion: 1,
            ...(opts.repoFrontmatter ?? {}),
        };
        const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
        const content = `---\n${fmLines.join('\n')}\n---\n\n# ${slug}\n`;
        await fs.writeFile(path.join(reposDir, `${slug}.md`), content, 'utf8');
    }

    // Write domain .md files
    const domainNames = opts.domainNames ?? ['core'];
    for (const name of domainNames) {
        const fm = {
            domain: name,
            description: `${name} domain`,
            repo_count: slugs.length,
            last_synced: isoAgo(1),
            generator: 'teamai import (P5.2 aggregate)',
            ...(opts.domainFrontmatter ?? {}),
        };
        const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
        const tableRows = slugs
            .map((s) => `| ${s} | desc | - |`)
            .join('\n');
        const content =
            `---\n${fmLines.join('\n')}\n---\n\n## 仓库列表\n\n| 仓库 | 描述 | 域 |\n|------|------|----|\n${tableRows}\n`;
        await fs.writeFile(path.join(domainsDir, `domain-${name}.md`), content, 'utf8');
    }

    // Write index.md
    const repoCnt = opts.repoCount ?? slugs.length;
    const domainCnt = opts.domainCount ?? domainNames.length;
    const indexFm = {
        generator: 'teamai import (P5.2 aggregate)',
        last_generated: isoAgo(1),
        domain_count: domainCnt,
        repo_count: repoCnt,
        schemaVersion: 1,
        ...(opts.indexFrontmatter ?? {}),
    };
    const indexFmLines = Object.entries(indexFm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    await fs.writeFile(
        path.join(opts.cwd, 'docs', 'team-codebase', 'index.md'),
        `---\n${indexFmLines.join('\n')}\n---\n\n# Team Codebase\n`,
        'utf8'
    );

    if (opts.externalKnowledge !== undefined) {
        await fs.writeFile(
            path.join(opts.cwd, 'docs', 'team-codebase', 'external-knowledge.md'),
            opts.externalKnowledge,
            'utf8'
        );
    }

    if (opts.sourceMarks !== undefined) {
        await fs.writeFile(path.join(teamaiDir, 'source-marks.jsonl'), opts.sourceMarks, 'utf8');
    }

    if (opts.pendingReview !== undefined) {
        await fs.writeFile(path.join(teamaiDir, 'pending-review.jsonl'), opts.pendingReview, 'utf8');
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('lintTeamCodebase', () => {
    let tmpdir: string;

    beforeEach(async () => {
        tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-lint-'));
    });

    afterEach(async () => {
        await fs.remove(tmpdir);
    });

    it('全部正确时返回 0 issues', async () => {
        await scaffold({ cwd: tmpdir });
        const report = await lintTeamCodebase({ cwd: tmpdir });
        // Only filter out source-invalid info (CI env has no cache)
        const nonInfoIssues = report.issues.filter((i) => i.severity !== 'info');
        expect(nonInfoIssues).toHaveLength(0);
    });

    it('anchor-unclosed 报 high', async () => {
        await scaffold({
            cwd: tmpdir,
            externalKnowledge: [
                '<!-- managed-by: import --from-iwiki, section: business-api, source: iwiki://biz, syncedAt: 2025-01-01 -->',
                '<body>no close tag here</body>',
            ].join('\n'),
        });
        const report = await lintTeamCodebase({ cwd: tmpdir });
        const anchorIssues = report.issues.filter((i) => i.category === 'anchor-unclosed');
        expect(anchorIssues.length).toBeGreaterThanOrEqual(1);
        expect(anchorIssues[0].severity).toBe('high');
        expect(anchorIssues[0].fixable).toBe(false);
    });

    it('orphan-md 报 high 且 fixable=true', async () => {
        // Create a md that has no corresponding url in domains.yaml
        await scaffold({ cwd: tmpdir, repoSlugs: ['github__org__repo-a'] });
        // Add an extra orphan md
        await fs.writeFile(
            path.join(tmpdir, 'docs', 'team-codebase', 'repos', 'github__org__orphan.md'),
            '---\ntitle: Orphan\ngenerator: teamai-cli\nschemaVersion: 1\n---\n\n# orphan\n',
            'utf8'
        );
        const report = await lintTeamCodebase({ cwd: tmpdir });
        const orphanIssues = report.issues.filter((i) => i.category === 'orphan-md');
        expect(orphanIssues.length).toBeGreaterThanOrEqual(1);
        expect(orphanIssues[0].severity).toBe('high');
        expect(orphanIssues[0].fixable).toBe(true);
    });

    it('sync-stale 90天前 报 medium', async () => {
        await scaffold({
            cwd: tmpdir,
            repoFrontmatter: { lastUpdated: isoAgo(90) },
        });
        const report = await lintTeamCodebase({ cwd: tmpdir, staleDays: 60 });
        const staleIssues = report.issues.filter((i) => i.category === 'sync-stale');
        expect(staleIssues.length).toBeGreaterThanOrEqual(1);
        expect(staleIssues[0].severity).toBe('medium');
    });

    it('index-mismatch 报 medium 且 fixable=true', async () => {
        await scaffold({
            cwd: tmpdir,
            repoCount: 99, // wrong count
        });
        const report = await lintTeamCodebase({ cwd: tmpdir });
        const mismatchIssues = report.issues.filter((i) => i.category === 'index-mismatch');
        expect(mismatchIssues.length).toBeGreaterThanOrEqual(1);
        expect(mismatchIssues[0].severity).toBe('medium');
        expect(mismatchIssues[0].fixable).toBe(true);
    });

    it('frontmatter-missing 报 high 当缺失 title', async () => {
        await scaffold({
            cwd: tmpdir,
            repoFrontmatter: { title: '' },
        });
        const report = await lintTeamCodebase({ cwd: tmpdir });
        const fmIssues = report.issues.filter(
            (i) => i.category === 'frontmatter-missing' && i.description.includes('title')
        );
        expect(fmIssues.length).toBeGreaterThanOrEqual(1);
        expect(fmIssues[0].severity).toBe('high');
    });

    it('aggregate-row-mismatch 报 low', async () => {
        // The domain md has only 1 row but domains.yaml has 2 repos
        const url1 = 'https://github.com/org/repo-a';
        const url2 = 'https://github.com/org/repo-b';
        const domainsYaml = `version: 1\ndomains:\n  - name: core\n    description: core\n    repos:\n      - url: "${url1}"\n      - url: "${url2}"\n`;
        await scaffold({
            cwd: tmpdir,
            repoSlugs: ['github__org__repo-a', 'github__org__repo-b'],
            domainsYaml,
        });
        // Rewrite domain md with only 1 row
        const domainsDir = path.join(tmpdir, 'docs', 'team-codebase', 'domains');
        await fs.writeFile(
            path.join(domainsDir, 'domain-core.md'),
            '---\ndomain: "core"\ngenerator: "teamai import (P5.2 aggregate)"\n---\n\n## 仓库列表\n\n| 仓库 | 描述 | 域 |\n|------|------|----|\n| repo-a | desc | core |\n',
            'utf8'
        );
        const report = await lintTeamCodebase({ cwd: tmpdir });
        const rowIssues = report.issues.filter((i) => i.category === 'aggregate-row-mismatch');
        expect(rowIssues.length).toBeGreaterThanOrEqual(1);
        expect(rowIssues[0].severity).toBe('low');
    });

    it('pending-review-backlog 超阈值报 info', async () => {
        const lines = Array.from({ length: 12 }, (_, i) =>
            JSON.stringify({ id: i, file: 'test.md', section: 'sec' })
        ).join('\n');
        await scaffold({
            cwd: tmpdir,
            pendingReview: lines,
        });
        const report = await lintTeamCodebase({ cwd: tmpdir, pendingReviewThreshold: 10 });
        const backlogIssues = report.issues.filter(
            (i) => i.category === 'pending-review-backlog'
        );
        expect(backlogIssues.length).toBe(1);
        expect(backlogIssues[0].severity).toBe('info');
    });

    it('multi-source-conflict 24h 内不同 source 报 medium', async () => {
        const now = new Date().toISOString();
        const lines = [
            JSON.stringify({ file: 'test.md', section: 'biz', source: 'iwiki://a', ts: now }),
            JSON.stringify({ file: 'test.md', section: 'biz', source: 'iwiki://b', ts: now }),
        ].join('\n');
        await scaffold({ cwd: tmpdir, sourceMarks: lines });
        const report = await lintTeamCodebase({ cwd: tmpdir });
        const conflictIssues = report.issues.filter(
            (i) => i.category === 'multi-source-conflict'
        );
        expect(conflictIssues.length).toBeGreaterThanOrEqual(1);
        expect(conflictIssues[0].severity).toBe('medium');
    });

    it('severity 过滤只返回 >= medium 的问题', async () => {
        const lines = Array.from({ length: 12 }, (_, i) =>
            JSON.stringify({ id: i, file: 'test.md', section: 'sec' })
        ).join('\n');
        await scaffold({
            cwd: tmpdir,
            pendingReview: lines,
        });
        const report = await lintTeamCodebase({ cwd: tmpdir, severity: 'medium' });
        const infoIssues = report.issues.filter((i) => i.severity === 'info');
        expect(infoIssues).toHaveLength(0);
    });
});
