import path from 'node:path';
import os from 'node:os';

import fs from 'fs-extra';
import matter from 'gray-matter';
import chalk from 'chalk';

import { getTeamCodebasePaths } from './utils/team-codebase-paths.js';
import { loadDomains } from './domains/index.js';
import { loadRepoList } from './repo-list/store.js';
import { getRepoSlug } from './utils/repo-cache.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type Severity = 'high' | 'medium' | 'low' | 'info';

export type LintCategory =
    | 'anchor-unclosed'
    | 'orphan-repo'
    | 'orphan-md'
    | 'source-invalid'
    | 'whitelist-missing'
    | 'whitelist-only'
    | 'sync-stale'
    | 'index-mismatch'
    | 'aggregate-row-mismatch'
    | 'frontmatter-missing'
    | 'pending-review-backlog'
    | 'multi-source-conflict';

export interface LintIssue {
    severity: Severity;
    category: LintCategory;
    location: string;
    description: string;
    suggestion?: string;
    fixable: boolean;
}

export interface LintReport {
    issues: LintIssue[];
    summary: {
        total: number;
        bySeverity: Record<Severity, number>;
        byCategory: Record<string, number>;
    };
    scanned: {
        domainsFile: boolean;
        repoListFile: boolean;
        indexFile: boolean;
        domainFiles: number;
        repoFiles: number;
        externalKnowledgeFile: boolean;
    };
}

export interface LintOptions {
    cwd: string;
    output?: string;
    severity?: Severity;
    staleDays?: number;
    pendingReviewThreshold?: number;
}

export interface FixOptions {
    cwd: string;
    output?: string;
    dryRun?: boolean;
}

export interface FixResult {
    applied: Array<{ category: LintCategory; location: string; description: string }>;
    skipped: Array<{ category: LintCategory; location: string; reason: string }>;
}

// ─── Severity ordering ───────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };

function severityAtLeast(issue: Severity, threshold: Severity): boolean {
    return SEVERITY_ORDER[issue] >= SEVERITY_ORDER[threshold];
}

// ─── URL → slug helper ───────────────────────────────────────────────────────

/**
 * 从仓库 URL 解析出 slug（与 import-repo 中逻辑保持一致）。
 *
 * @param url 仓库 HTTP/SSH URL
 * @returns   slug 字符串，解析失败返回 null
 */
function urlToSlug(url: string): string | null {
    let provider: string | null = null;
    if (/github\.com/i.test(url)) {
        provider = 'github';
    } else if (/git\.woa\.com/i.test(url) || /tgit/i.test(url)) {
        provider = 'tgit';
    } else if (/gitlab\./i.test(url)) {
        provider = 'gitlab';
    } else {
        // 通用 fallback：取域名去 www. 前缀
        const domainMatch = url.match(/https?:\/\/([^/]+)/);
        if (domainMatch) {
            provider = domainMatch[1].replace(/^www\./, '').replace(/\./g, '-');
        }
    }
    if (!provider) return null;

    const httpsMatch = url.match(/https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
    const sshMatch = url.match(/git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
    let owner: string;
    let repo: string;
    if (httpsMatch) {
        owner = httpsMatch[1];
        repo = httpsMatch[2];
    } else if (sshMatch) {
        owner = sshMatch[1];
        repo = sshMatch[2];
    } else {
        return null;
    }
    return getRepoSlug(provider, owner, repo);
}

// ─── Parse source-marks.jsonl ────────────────────────────────────────────────

interface SourceMark {
    file?: string;
    section?: string;
    source?: string;
    ts?: string;
    [key: string]: unknown;
}

function parseJsonlLines(content: string): SourceMark[] {
    return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
            try {
                return JSON.parse(line) as SourceMark;
            } catch {
                return null;
            }
        })
        .filter((item): item is SourceMark => item !== null);
}

// ─── Check functions ─────────────────────────────────────────────────────────

function checkAnchorUnclosed(content: string, filePath: string): LintIssue[] {
    const issues: LintIssue[] = [];
    const openRegex = /<!--\s*managed-by:[^>]+?section:\s*([^,>\s]+)[^>]*-->/g;
    const closeRegex = /<!--\s*\/managed-by:\s*([^>\s]+)\s*-->/g;

    const openSections = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = openRegex.exec(content)) !== null) {
        openSections.add(match[1]);
    }
    const closedSections = new Set<string>();
    while ((match = closeRegex.exec(content)) !== null) {
        closedSections.add(match[1]);
    }
    for (const section of openSections) {
        if (!closedSections.has(section)) {
            issues.push({
                severity: 'high',
                category: 'anchor-unclosed',
                location: `${filePath}:${section}`,
                description: `开始锚点 section="${section}" 未找到对应闭合标签`,
                suggestion: '检查最近一次 --from-iwiki 是否中断，手动补全 <!-- /managed-by: ... -->',
                fixable: false,
            });
        }
    }
    return issues;
}

function checkSyncStaleSections(
    content: string,
    filePath: string,
    staleDays: number
): LintIssue[] {
    const issues: LintIssue[] = [];
    const syncedAtRegex =
        /<!--\s*managed-by:[^>]+?section:\s*([^,>\s]+)[^>]*?syncedAt:\s*([^,>\s]+)[^>]*-->/g;
    let match: RegExpExecArray | null;
    const now = Date.now();
    const thresholdMs = staleDays * 24 * 60 * 60 * 1000;
    while ((match = syncedAtRegex.exec(content)) !== null) {
        const section = match[1];
        const syncedAt = match[2];
        const syncedDate = new Date(syncedAt);
        if (!isNaN(syncedDate.getTime()) && now - syncedDate.getTime() > thresholdMs) {
            issues.push({
                severity: 'medium',
                category: 'sync-stale',
                location: `${filePath}:${section}`,
                description: `section="${section}" syncedAt=${syncedAt} 超过 ${staleDays} 天未同步`,
                suggestion: '重新运行 teamai import --from-iwiki 更新该 section',
                fixable: false,
            });
        }
    }
    return issues;
}

function checkRepoFrontmatterRequired(
    fm: Record<string, unknown>,
    filePath: string
): LintIssue[] {
    const issues: LintIssue[] = [];
    const required = ['title', 'generator', 'schemaVersion'] as const;
    for (const field of required) {
        if (fm[field] === undefined || fm[field] === null || fm[field] === '') {
            issues.push({
                severity: field === 'schemaVersion' ? 'medium' : 'high',
                category: 'frontmatter-missing',
                location: filePath,
                description: `repos/*.md 缺少必需 frontmatter 字段: ${field}`,
                suggestion: `在 frontmatter 中补充 ${field}`,
                fixable: field === 'schemaVersion',
            });
        }
    }
    return issues;
}

function checkDomainFrontmatterRequired(
    fm: Record<string, unknown>,
    filePath: string
): LintIssue[] {
    const issues: LintIssue[] = [];
    const required = ['domain', 'generator'] as const;
    for (const field of required) {
        if (fm[field] === undefined || fm[field] === null || fm[field] === '') {
            issues.push({
                severity: 'high',
                category: 'frontmatter-missing',
                location: filePath,
                description: `domains/*.md 缺少必需 frontmatter 字段: ${field}`,
                suggestion: `在 frontmatter 中补充 ${field}`,
                fixable: false,
            });
        }
    }
    return issues;
}

function checkIndexFrontmatterRequired(
    fm: Record<string, unknown>,
    filePath: string
): LintIssue[] {
    const issues: LintIssue[] = [];
    const required = ['generator', 'schemaVersion'] as const;
    for (const field of required) {
        if (fm[field] === undefined || fm[field] === null || fm[field] === '') {
            issues.push({
                severity: field === 'schemaVersion' ? 'medium' : 'high',
                category: 'frontmatter-missing',
                location: filePath,
                description: `index.md 缺少必需 frontmatter 字段: ${field}`,
                suggestion: `在 frontmatter 中补充 ${field}`,
                fixable: field === 'schemaVersion',
            });
        }
    }
    return issues;
}

function parseAggregateTableRows(content: string): number {
    // 查找 ## 仓库列表 下的 markdown 表格行数（去掉表头行和分隔行）
    const sectionMatch = content.match(/##\s+仓库列表\s*\n([\s\S]*?)(?:\n##\s|\n#\s|$)/);
    if (!sectionMatch) return 0;
    const tableText = sectionMatch[1];
    const lines = tableText.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
    // 去掉表头行（第一行）和分隔行（含 ---）
    const dataRows = lines.filter((l) => !l.includes('---') && lines.indexOf(l) > 0);
    return dataRows.length;
}

function checkMultiSourceConflict(marks: SourceMark[], now: number): LintIssue[] {
    const issues: LintIssue[] = [];
    const within24h = now - 24 * 60 * 60 * 1000;
    // group by file+section
    const groups = new Map<string, Set<string>>();
    for (const mark of marks) {
        if (!mark.file || !mark.section || !mark.source || !mark.ts) continue;
        const ts = new Date(mark.ts).getTime();
        if (isNaN(ts) || ts < within24h) continue;
        const key = `${mark.file}:${mark.section}`;
        const sources = groups.get(key) ?? new Set<string>();
        sources.add(mark.source);
        groups.set(key, sources);
    }
    for (const [key, sources] of groups) {
        if (sources.size >= 2) {
            issues.push({
                severity: 'medium',
                category: 'multi-source-conflict',
                location: key,
                description: `近 24h 内 ${key} 出现 ${sources.size} 个不同 source：${[...sources].join(', ')}`,
                suggestion: '检查是否有并发 import 任务，确认最终 source 的优先级',
                fixable: false,
            });
        }
    }
    return issues;
}

// ─── Main lint entry ─────────────────────────────────────────────────────────

/**
 * 全局 lint 主入口。
 *
 * 扫描 docs/team-codebase/ 及 .teamai/ 下各产物，返回完整报告。
 * 底层 IO/解析失败转为 lint issue，不抛错。
 *
 * @param opts lint 选项
 * @returns    完整 LintReport
 */
export async function lintTeamCodebase(opts: LintOptions): Promise<LintReport> {
    const staleDays = opts.staleDays ?? 60;
    const pendingThreshold = opts.pendingReviewThreshold ?? 10;
    const severityFilter = opts.severity ?? 'info';
    const paths = getTeamCodebasePaths(opts.cwd, opts.output);

    const issues: LintIssue[] = [];
    const scanned = {
        domainsFile: false,
        repoListFile: false,
        indexFile: false,
        domainFiles: 0,
        repoFiles: 0,
        externalKnowledgeFile: false,
    };

    // 1. Load domains.yaml
    let domainsData: Awaited<ReturnType<typeof loadDomains>> | null = null;
    try {
        domainsData = await loadDomains(opts.cwd);
        scanned.domainsFile = true;
    } catch {
        issues.push({
            severity: 'high',
            category: 'frontmatter-missing',
            location: '.teamai/domains.yaml',
            description: '无法加载 .teamai/domains.yaml（文件不存在或格式错误）',
            suggestion: '运行 teamai import 重新生成 domains.yaml',
            fixable: false,
        });
    }

    // 2. Load repo-whitelist.yaml
    const whitelistPath = path.join(opts.cwd, '.teamai', 'repo-whitelist.yaml');
    let whitelistData: Awaited<ReturnType<typeof loadRepoList>> | null = null;
    try {
        whitelistData = await loadRepoList(whitelistPath);
        scanned.repoListFile = true;
    } catch {
        // 不致命，降级为 low
        issues.push({
            severity: 'low',
            category: 'frontmatter-missing',
            location: '.teamai/repo-whitelist.yaml',
            description: '无法加载 .teamai/repo-whitelist.yaml（文件不存在或格式错误）',
            suggestion: '运行 teamai import --from-repo-list 生成白名单文件',
            fixable: false,
        });
    }

    // 3. List repo files
    let repoMdFiles: string[] = [];
    if (await fs.pathExists(paths.reposDir)) {
        const entries = await fs.readdir(paths.reposDir);
        repoMdFiles = entries.filter((f) => f.endsWith('.md'));
        scanned.repoFiles = repoMdFiles.length;
    }

    // 4. List domain files
    let domainMdFiles: string[] = [];
    if (await fs.pathExists(paths.domainsDir)) {
        const entries = await fs.readdir(paths.domainsDir);
        domainMdFiles = entries.filter((f) => f.endsWith('.md'));
        scanned.domainFiles = domainMdFiles.length;
    }

    // 5. Check orphan-repo and orphan-md
    if (domainsData) {
        const allDomainUrls = domainsData.domains.flatMap((d) => d.repos.map((r) => r.url));
        const urlToSlugMap = new Map<string, string>();
        for (const url of allDomainUrls) {
            const slug = urlToSlug(url);
            if (slug) urlToSlugMap.set(url, slug);
        }

        // orphan-repo: domains.yaml url 对应的 md 不存在
        for (const url of allDomainUrls) {
            const slug = urlToSlugMap.get(url);
            if (!slug) continue;
            const mdPath = path.join(paths.reposDir, `${slug}.md`);
            if (!(await fs.pathExists(mdPath))) {
                issues.push({
                    severity: 'high',
                    category: 'orphan-repo',
                    location: `docs/team-codebase/repos/${slug}.md`,
                    description: `domains.yaml 中 url=${url} 在 repos/ 下找不到对应 ${slug}.md`,
                    suggestion: '运行 teamai import --from-repo 重新生成该仓库的 codebase 文档',
                    fixable: false,
                });
            }
        }

        // orphan-md: md 存在但 domains.yaml 无对应
        const slugsInDomains = new Set(urlToSlugMap.values());
        for (const mdFile of repoMdFiles) {
            const slug = mdFile.replace(/\.md$/, '');
            if (!slugsInDomains.has(slug)) {
                const relPath = `docs/team-codebase/repos/${mdFile}`;
                issues.push({
                    severity: 'high',
                    category: 'orphan-md',
                    location: relPath,
                    description: `${mdFile} 存在于 repos/ 但 domains.yaml 中无对应 url 条目`,
                    suggestion: '运行 teamai codebase --fix 将孤儿文件移到 .archived/ 目录',
                    fixable: true,
                });
            }
        }
    }

    // 6. Check source-invalid (only when cache root exists)
    const cacheRoot = path.join(os.homedir(), '.teamai', 'cache', 'repos');
    const cacheExists = await fs.pathExists(cacheRoot);
    for (const mdFile of repoMdFiles) {
        const mdPath = path.join(paths.reposDir, mdFile);
        try {
            const content = await fs.readFile(mdPath, 'utf8');
            const parsed = matter(content);
            const fm = parsed.data as Record<string, unknown>;

            // frontmatter-missing checks for repo files
            issues.push(...checkRepoFrontmatterRequired(fm, `docs/team-codebase/repos/${mdFile}`));

            // source-invalid check
            const source = fm['source'] as string | undefined;
            if (source) {
                if (cacheExists) {
                    if (!(await fs.pathExists(source))) {
                        issues.push({
                            severity: 'high',
                            category: 'source-invalid',
                            location: `docs/team-codebase/repos/${mdFile}`,
                            description: `frontmatter source="${source}" 指向的缓存路径已不存在`,
                            suggestion: '重新运行 teamai import --from-repo 刷新缓存',
                            fixable: false,
                        });
                    }
                } else {
                    issues.push({
                        severity: 'info',
                        category: 'source-invalid',
                        location: `docs/team-codebase/repos/${mdFile}`,
                        description: `source-invalid 检查在本主机跳过：~/.teamai/cache 不存在（CI 环境）`,
                        fixable: false,
                    });
                }
            }

            // sync-stale check for repo files
            const lastUpdated = fm['lastUpdated'] as string | undefined;
            if (lastUpdated) {
                const d = new Date(lastUpdated);
                if (!isNaN(d.getTime())) {
                    const ageMs = Date.now() - d.getTime();
                    if (ageMs > staleDays * 24 * 60 * 60 * 1000) {
                        issues.push({
                            severity: 'medium',
                            category: 'sync-stale',
                            location: `docs/team-codebase/repos/${mdFile}`,
                            description: `lastUpdated=${lastUpdated} 超过 ${staleDays} 天未同步`,
                            suggestion: '重新运行 teamai import --from-repo 刷新此仓库文档',
                            fixable: false,
                        });
                    }
                }
            }
        } catch {
            issues.push({
                severity: 'medium',
                category: 'frontmatter-missing',
                location: `docs/team-codebase/repos/${mdFile}`,
                description: `读取或解析 ${mdFile} 失败`,
                fixable: false,
            });
        }
    }

    // 7. Check domain files
    for (const domFile of domainMdFiles) {
        const domPath = path.join(paths.domainsDir, domFile);
        try {
            const content = await fs.readFile(domPath, 'utf8');
            const parsed = matter(content);
            const fm = parsed.data as Record<string, unknown>;

            issues.push(
                ...checkDomainFrontmatterRequired(fm, `docs/team-codebase/domains/${domFile}`)
            );

            // sync-stale check for domain files
            const lastSynced = fm['last_synced'] as string | undefined;
            if (lastSynced) {
                const d = new Date(lastSynced);
                if (!isNaN(d.getTime())) {
                    const ageMs = Date.now() - d.getTime();
                    if (ageMs > staleDays * 24 * 60 * 60 * 1000) {
                        issues.push({
                            severity: 'medium',
                            category: 'sync-stale',
                            location: `docs/team-codebase/domains/${domFile}`,
                            description: `last_synced=${lastSynced} 超过 ${staleDays} 天未同步`,
                            suggestion: '重新运行 teamai import --from-repo-list 更新域聚合文档',
                            fixable: false,
                        });
                    }
                }
            }

            // aggregate-row-mismatch check
            if (domainsData && fm['domain']) {
                const domainName = fm['domain'] as string;
                const domainEntry = domainsData.domains.find((d) => d.name === domainName);
                if (domainEntry) {
                    const expectedCount = domainEntry.repos.length;
                    const actualCount = parseAggregateTableRows(parsed.content);
                    if (actualCount !== expectedCount) {
                        issues.push({
                            severity: 'low',
                            category: 'aggregate-row-mismatch',
                            location: `docs/team-codebase/domains/${domFile}`,
                            description:
                                `仓库列表表格行数 ${actualCount} 与 domains.yaml 中 ` +
                                `"${domainName}" 域的 repos 数量 ${expectedCount} 不一致`,
                            suggestion: '重新运行 teamai import --from-repo-list 重新聚合',
                            fixable: false,
                        });
                    }
                }
            }
        } catch {
            issues.push({
                severity: 'medium',
                category: 'frontmatter-missing',
                location: `docs/team-codebase/domains/${domFile}`,
                description: `读取或解析 ${domFile} 失败`,
                fixable: false,
            });
        }
    }

    // 8. Check index.md
    if (await fs.pathExists(paths.index)) {
        scanned.indexFile = true;
        try {
            const content = await fs.readFile(paths.index, 'utf8');
            const parsed = matter(content);
            const fm = parsed.data as Record<string, unknown>;

            issues.push(...checkIndexFrontmatterRequired(fm, 'docs/team-codebase/index.md'));

            // index-mismatch check
            const fmRepoCnt = Number(fm['repo_count'] ?? -1);
            const fmDomainCnt = Number(fm['domain_count'] ?? -1);
            const actualRepoCnt = repoMdFiles.length;
            const actualDomainCnt = domainMdFiles.length;

            if (!isNaN(fmRepoCnt) && fmRepoCnt >= 0 && fmRepoCnt !== actualRepoCnt) {
                issues.push({
                    severity: 'medium',
                    category: 'index-mismatch',
                    location: 'docs/team-codebase/index.md',
                    description:
                        `index.md frontmatter repo_count=${fmRepoCnt} 与实际 repos/ 文件数 ` +
                        `${actualRepoCnt} 不一致`,
                    suggestion: '运行 teamai codebase --fix 修正 index.md 中的计数',
                    fixable: true,
                });
            }
            if (!isNaN(fmDomainCnt) && fmDomainCnt >= 0 && fmDomainCnt !== actualDomainCnt) {
                issues.push({
                    severity: 'medium',
                    category: 'index-mismatch',
                    location: 'docs/team-codebase/index.md',
                    description:
                        `index.md frontmatter domain_count=${fmDomainCnt} 与实际 domains/ 文件数 ` +
                        `${actualDomainCnt} 不一致`,
                    suggestion: '运行 teamai codebase --fix 修正 index.md 中的计数',
                    fixable: true,
                });
            }
        } catch {
            issues.push({
                severity: 'medium',
                category: 'frontmatter-missing',
                location: 'docs/team-codebase/index.md',
                description: '读取或解析 index.md 失败',
                fixable: false,
            });
        }
    }

    // 9. Check external-knowledge.md
    const extKnowledgePath = path.join(paths.root, 'external-knowledge.md');
    if (await fs.pathExists(extKnowledgePath)) {
        scanned.externalKnowledgeFile = true;
        try {
            const content = await fs.readFile(extKnowledgePath, 'utf8');
            issues.push(...checkAnchorUnclosed(content, 'docs/team-codebase/external-knowledge.md'));
            issues.push(
                ...checkSyncStaleSections(
                    content,
                    'docs/team-codebase/external-knowledge.md',
                    staleDays
                )
            );
        } catch {
            issues.push({
                severity: 'medium',
                category: 'frontmatter-missing',
                location: 'docs/team-codebase/external-knowledge.md',
                description: '读取 external-knowledge.md 失败',
                fixable: false,
            });
        }
    }

    // 10. Whitelist cross-check
    if (domainsData && whitelistData) {
        const domainUrls = new Set(
            domainsData.domains.flatMap((d) => d.repos.map((r) => r.url))
        );
        const whitelistUrls = new Set(
            whitelistData.repos
                .filter((r) => 'url' in r)
                .map((r) => (r as { url: string }).url)
        );

        for (const url of domainUrls) {
            if (!whitelistUrls.has(url)) {
                issues.push({
                    severity: 'medium',
                    category: 'whitelist-missing',
                    location: '.teamai/repo-whitelist.yaml',
                    description: `domains.yaml 中 url=${url} 不在 repo-whitelist.yaml 中`,
                    suggestion: '将该 url 加入 .teamai/repo-whitelist.yaml 的 repos 列表',
                    fixable: false,
                });
            }
        }
        for (const url of whitelistUrls) {
            if (!domainUrls.has(url)) {
                issues.push({
                    severity: 'medium',
                    category: 'whitelist-only',
                    location: '.teamai/repo-whitelist.yaml',
                    description: `repo-whitelist.yaml 中 url=${url} 未出现在 domains.yaml 中`,
                    suggestion: '运行 teamai import 将该仓库归入某个业务域',
                    fixable: false,
                });
            }
        }
    }

    // 11. Check pending-review.jsonl
    const pendingPath = path.join(opts.cwd, '.teamai', 'pending-review.jsonl');
    if (await fs.pathExists(pendingPath)) {
        try {
            const content = await fs.readFile(pendingPath, 'utf8');
            const lines = content.split('\n').filter((l) => l.trim().length > 0);
            if (lines.length > pendingThreshold) {
                issues.push({
                    severity: 'info',
                    category: 'pending-review-backlog',
                    location: '.teamai/pending-review.jsonl',
                    description: `pending-review.jsonl 有 ${lines.length} 条待审记录，超过阈值 ${pendingThreshold}`,
                    suggestion: '运行 teamai import --require-review 处理积压的待审条目',
                    fixable: false,
                });
            }
        } catch {
            // 读取失败，跳过
        }
    }

    // 12. Check source-marks.jsonl for multi-source-conflict
    const sourceMarksPath = path.join(opts.cwd, '.teamai', 'source-marks.jsonl');
    if (await fs.pathExists(sourceMarksPath)) {
        try {
            const content = await fs.readFile(sourceMarksPath, 'utf8');
            const marks = parseJsonlLines(content);
            issues.push(...checkMultiSourceConflict(marks, Date.now()));
        } catch {
            // 读取失败，跳过
        }
    }

    // Filter by severity
    const filteredIssues = issues.filter((i) => severityAtLeast(i.severity, severityFilter));

    // Build summary
    const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
    const byCategory: Record<string, number> = {};
    for (const issue of filteredIssues) {
        bySeverity[issue.severity]++;
        byCategory[issue.category] = (byCategory[issue.category] ?? 0) + 1;
    }

    return {
        issues: filteredIssues,
        summary: {
            total: filteredIssues.length,
            bySeverity,
            byCategory,
        },
        scanned,
    };
}

// ─── Format report ───────────────────────────────────────────────────────────

/**
 * 把报告渲染为带 chalk 颜色的人类可读文本。
 *
 * @param report lint 报告
 * @param opts   渲染选项（color 默认为 true）
 * @returns      可打印的字符串
 */
export function formatLintReport(report: LintReport, opts?: { color?: boolean }): string {
    const useColor = opts?.color !== false;
    const { total, bySeverity } = report.summary;

    const colorize = (severity: Severity, text: string): string => {
        if (!useColor) return text;
        switch (severity) {
            case 'high':
                return chalk.red(text);
            case 'medium':
                return chalk.yellow(text);
            case 'low':
                return chalk.cyan(text);
            case 'info':
                return chalk.gray(text);
        }
    };

    const lines: string[] = [];
    const summaryParts = (['high', 'medium', 'low', 'info'] as Severity[])
        .filter((s) => bySeverity[s] > 0)
        .map((s) => colorize(s, `${s}: ${bySeverity[s]}`));
    lines.push(`[lint] 共 ${total} 个问题（${summaryParts.join(', ')}）`);

    if (total === 0) {
        lines.push(useColor ? chalk.green('  ✓ 无问题') : '  ✓ 无问题');
        return lines.join('\n');
    }

    // Sort: high first
    const sorted = [...report.issues].sort(
        (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]
    );

    for (const issue of sorted) {
        const tag = colorize(issue.severity, `[${issue.severity}]`);
        const cat = issue.category.padEnd(28);
        lines.push(`${tag}   ${cat} ${issue.location}`);
        lines.push(`        ${issue.description}`);
        if (issue.suggestion) {
            lines.push(`        ${useColor ? chalk.gray(`建议：${issue.suggestion}`) : `建议：${issue.suggestion}`}`);
        }
    }
    return lines.join('\n');
}

// ─── Fix entry ───────────────────────────────────────────────────────────────

/**
 * 自动修复仅限低风险机械动作：
 *   - orphan-md：把孤儿 repos/*.md 移动到 repos/.archived/<slug>.md（不删除）
 *   - frontmatter-missing：补齐 schemaVersion: 1 默认值
 *   - index-mismatch：重新写入正确的 repo_count/domain_count
 *
 * @param opts fix 选项
 * @returns    修复结果
 */
export async function fixTeamCodebase(opts: FixOptions): Promise<FixResult> {
    const report = await lintTeamCodebase({ cwd: opts.cwd, output: opts.output });
    const paths = getTeamCodebasePaths(opts.cwd, opts.output);

    const applied: FixResult['applied'] = [];
    const skipped: FixResult['skipped'] = [];

    for (const issue of report.issues) {
        if (!issue.fixable) {
            skipped.push({
                category: issue.category,
                location: issue.location,
                reason: '该类别不支持自动修复',
            });
            continue;
        }

        if (issue.category === 'orphan-md') {
            const mdFile = path.basename(issue.location);
            const srcPath = path.join(paths.reposDir, mdFile);
            const archivedDir = path.join(paths.reposDir, '.archived');
            const dstPath = path.join(archivedDir, mdFile);
            if (opts.dryRun) {
                applied.push({
                    category: issue.category,
                    location: issue.location,
                    description: `[dry-run] 移动 ${srcPath} → ${dstPath}`,
                });
            } else {
                try {
                    await fs.ensureDir(archivedDir);
                    await fs.move(srcPath, dstPath, { overwrite: true });
                    applied.push({
                        category: issue.category,
                        location: issue.location,
                        description: `移动 ${srcPath} → ${dstPath}`,
                    });
                } catch (err) {
                    skipped.push({
                        category: issue.category,
                        location: issue.location,
                        reason: `移动失败：${String(err)}`,
                    });
                }
            }
        } else if (issue.category === 'frontmatter-missing') {
            // 只补 schemaVersion: 1
            const relPath = issue.location;
            const absPath = path.join(opts.cwd, relPath);
            if (opts.dryRun) {
                applied.push({
                    category: issue.category,
                    location: issue.location,
                    description: '[dry-run] 补齐 schemaVersion: 1',
                });
            } else {
                try {
                    const content = await fs.readFile(absPath, 'utf8');
                    const parsed = matter(content);
                    if (!parsed.data['schemaVersion']) {
                        parsed.data['schemaVersion'] = 1;
                        const newContent = matter.stringify(parsed.content, parsed.data);
                        await fs.writeFile(absPath, newContent, 'utf8');
                        applied.push({
                            category: issue.category,
                            location: issue.location,
                            description: '已补齐 schemaVersion: 1',
                        });
                    } else {
                        skipped.push({
                            category: issue.category,
                            location: issue.location,
                            reason: 'schemaVersion 已存在，无需修复',
                        });
                    }
                } catch (err) {
                    skipped.push({
                        category: issue.category,
                        location: issue.location,
                        reason: `读写失败：${String(err)}`,
                    });
                }
            }
        } else if (issue.category === 'index-mismatch') {
            if (opts.dryRun) {
                const repoFiles = await fs.readdir(paths.reposDir).catch(() => [] as string[]);
                const domainFiles = await fs.readdir(paths.domainsDir).catch(() => [] as string[]);
                const repoCnt = repoFiles.filter((f) => f.endsWith('.md')).length;
                const domainCnt = domainFiles.filter((f) => f.endsWith('.md')).length;
                applied.push({
                    category: issue.category,
                    location: issue.location,
                    description: `[dry-run] 将 index.md repo_count 设为 ${repoCnt}，domain_count 设为 ${domainCnt}`,
                });
            } else {
                try {
                    const indexContent = await fs.readFile(paths.index, 'utf8');
                    const parsed = matter(indexContent);

                    const repoFiles = await fs.readdir(paths.reposDir).catch(() => [] as string[]);
                    const domainFiles = await fs.readdir(paths.domainsDir).catch(() => [] as string[]);
                    const repoCnt = repoFiles.filter((f) => f.endsWith('.md')).length;
                    const domainCnt = domainFiles.filter((f) => f.endsWith('.md')).length;

                    parsed.data['repo_count'] = repoCnt;
                    parsed.data['domain_count'] = domainCnt;
                    const newContent = matter.stringify(parsed.content, parsed.data);
                    await fs.writeFile(paths.index, newContent, 'utf8');
                    applied.push({
                        category: issue.category,
                        location: issue.location,
                        description: `已更新 index.md: repo_count=${repoCnt}, domain_count=${domainCnt}`,
                    });
                } catch (err) {
                    skipped.push({
                        category: issue.category,
                        location: issue.location,
                        reason: `更新 index.md 失败：${String(err)}`,
                    });
                }
            }
        } else {
            skipped.push({
                category: issue.category,
                location: issue.location,
                reason: '该类别不在自动修复范围内',
            });
        }
    }

    return { applied, skipped };
}
