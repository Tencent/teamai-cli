import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';

import { generateCodebaseMd } from './codebase.js';
import { extractCodebase } from './codebase-extract.js';
import { mergeWithAnchors } from './section-patcher.js';
import { detectProvider } from './providers/registry.js';
import { shallowClone, shallowFetch } from './clone.js';
import { appendPendingReview, loadPendingReview, removePendingReview } from './review-store.js';
import {
    getRepoCacheDir,
    getRepoSlug,
    writeLastSync,
    readLastSync,
    ensureCacheRoot,
} from './utils/repo-cache.js';
import { touchCacheEntry } from './utils/cache-index.js';
import {
    loadDomains,
    saveDomains,
    appendHistory,
    recommendDomain,
    type DomainsFile,
    type RepoEntry,
    type RepoMeta,
} from './domains/index.js';
import { askQuestion } from './utils/prompt.js';
import { log } from './utils/logger.js';
import { assertSafePath } from './utils/path-safety.js';

// ─── Types ──────────────────────────────────────────────

export interface ImportFromRepoOptions {
    /** 仓库 URL（https/ssh 任一） */
    url: string;
    /** Shallow clone 深度，默认 1 */
    depth?: number;
    /** 强制 SSH clone */
    forceSsh?: boolean;
    /** 强制匿名 HTTPS（即使 token 可用），用于白名单 auth='public' */
    forceAnonymous?: boolean;
    /** --domain 显式指定时跳过 AI 推荐 */
    explicitDomain?: string;
    /** Dry-run 模式：跳过写盘但执行 clone+扫描 */
    dryRun?: boolean;
    /** 自定义产物根目录；默认 .teamai/team-repo/docs/team-codebase */
    output?: string;
    /**
     * 是否启用交互式确认。
     * 默认 true（TTY 下展示 AI 推荐并等待用户输入）；
     * 批量导入时传 false → 无 TTY 路径（置信度不足直接归未分类）。
     */
    interactive?: boolean;
    /** 增量模式：缓存命中时仅 fetch+reset，未命中时 fallback 到全量 clone */
    incremental?: boolean;
    /** batch 模式下跳过 per-repo 的 autoPushTeamRepo（由调用方统一处理） */
    skipAutoPush?: boolean;
    /** 跳过 AI enrichment（只做 clone + extract + graph，不调用 LLM） */
    skipEnrich?: boolean;
}

// ─── Cross-Repo Edge Detection ─────────────────────────

interface SimpleGraphNode {
    id?: string; slug?: string;
    kind?: string; type?: string;
    label?: string; title?: string;
    file?: string;
}

interface SimpleGraphIndex {
    nodes: SimpleGraphNode[];
    edges: Array<{ from: string; to: string; relation: string }>;
}

/**
 * 检测跨仓库依赖关系。
 *
 * 通过比较两个图谱的节点标签（组件名/接口名），
 * 当仓库 A 有一个节点名称与仓库 B 的节点名称匹配时，
 * 说明两者可能存在依赖关系（如共享接口、同名组件引用）。
 *
 * 基于 team-wiki 的 buildCodeGraphIndex 中 exportIndex 匹配思想。
 */
export function detectCrossRepoEdges(
    overlay: SimpleGraphIndex,
    existing: SimpleGraphIndex,
): Array<{ from: string; to: string; relation: 'DEPENDS_ON' }> {
    const crossEdges: Array<{ from: string; to: string; relation: 'DEPENDS_ON' }> = [];
    const edgeSet = new Set<string>();

    const nodeId = (n: SimpleGraphNode): string => n.id ?? n.slug ?? '';
    const nodeLabel = (n: SimpleGraphNode): string => n.label ?? n.title ?? '';
    const nodeKind = (n: SimpleGraphNode): string => n.kind ?? n.type ?? '';

    // 建立已有图谱的组件/接口名索引
    const existingIndex = new Map<string, string>();
    for (const node of existing.nodes) {
        const label = nodeLabel(node);
        if (label) existingIndex.set(label.toLowerCase(), nodeId(node));
    }

    // 建立新图谱的组件/接口名索引
    const overlayIndex = new Map<string, string>();
    for (const node of overlay.nodes) {
        const label = nodeLabel(node);
        if (label) overlayIndex.set(label.toLowerCase(), nodeId(node));
    }

    // 检查新仓库的 import 边目标是否有同名组件在已有仓库中
    for (const edge of overlay.edges) {
        if (edge.relation !== 'imports') continue;
        const segments = edge.to.split('/');
        const fileName = segments[segments.length - 1]?.replace(/\.(ts|tsx|js|jsx|py|go|rs|java)$/, '') ?? '';
        const pascalName = fileName.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');

        const match = existingIndex.get(pascalName.toLowerCase());
        if (match) {
            const fromNode = overlay.nodes.find(n => (n.file ?? n.id ?? n.slug ?? '') === edge.from);
            if (fromNode) {
                const fromId = nodeId(fromNode);
                const key = `${fromId}|${match}`;
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    crossEdges.push({ from: fromId, to: match, relation: 'DEPENDS_ON' });
                }
            }
        }
    }

    // 反向：已有图谱的 import 边是否指向新仓库中的同名组件
    for (const edge of existing.edges) {
        if (edge.relation !== 'imports') continue;
        const segments = edge.to.split('/');
        const fileName = segments[segments.length - 1]?.replace(/\.(ts|tsx|js|jsx|py|go|rs|java)$/, '') ?? '';
        const pascalName = fileName.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');

        const match = overlayIndex.get(pascalName.toLowerCase());
        if (match) {
            const fromNode = existing.nodes.find(n => (n.file ?? n.id ?? n.slug ?? '') === edge.from);
            if (fromNode) {
                const fromId = nodeId(fromNode);
                const key = `${fromId}|${match}`;
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    crossEdges.push({ from: fromId, to: match, relation: 'DEPENDS_ON' });
                }
            }
        }
    }

    // 配置仓库关联：config/data 节点的 label 与另一仓库的组件/接口节点 label 完全匹配
    const overlayConfigs = overlay.nodes.filter(n => nodeKind(n) === 'config' || nodeKind(n) === 'data');
    const existingConfigs = existing.nodes.filter(n => nodeKind(n) === 'config' || nodeKind(n) === 'data');

    for (const cfg of overlayConfigs) {
        const cfgName = nodeLabel(cfg).toLowerCase();
        if (cfgName.length < 5) continue;
        const cfgId = nodeId(cfg);
        const match = existingIndex.get(cfgName);
        if (match) {
            const key = `${match}|${cfgId}`;
            if (!edgeSet.has(key)) {
                edgeSet.add(key);
                crossEdges.push({ from: match, to: cfgId, relation: 'DEPENDS_ON' });
            }
        }
    }

    for (const cfg of existingConfigs) {
        const cfgName = nodeLabel(cfg).toLowerCase();
        if (cfgName.length < 5) continue;
        const cfgId = nodeId(cfg);
        const match = overlayIndex.get(cfgName);
        if (match) {
            const key = `${match}|${cfgId}`;
            if (!edgeSet.has(key)) {
                edgeSet.add(key);
                crossEdges.push({ from: match, to: cfgId, relation: 'DEPENDS_ON' });
            }
        }
    }

    return crossEdges;
}

// ─── Helpers ────────────────────────────────────────────

/**
 * 判断 url 是否已在 domains.yaml 某个域中。
 * 返回所在域名，不存在返回 null。
 */
function findExistingDomain(domains: DomainsFile, url: string): string | null {
    for (const domain of domains.domains) {
        if (domain.repos.some((r) => r.url === url)) {
            return domain.name;
        }
    }
    return null;
}

/**
 * 统计目录（深度 ≤ maxDepth）内各语言文件数量，返回占比最高的语言标识符。
 */
async function detectPrimaryLanguage(
    repoPath: string,
    maxDepth: number = 3,
): Promise<string | undefined> {
    const langExtMap: Record<string, string> = {
        '.ts': 'TypeScript',
        '.tsx': 'TypeScript',
        '.js': 'JavaScript',
        '.jsx': 'JavaScript',
        '.py': 'Python',
        '.go': 'Go',
        '.java': 'Java',
        '.rs': 'Rust',
        '.cpp': 'C++',
        '.c': 'C',
        '.rb': 'Ruby',
        '.php': 'PHP',
    };

    const counts: Map<string, number> = new Map();

    async function walk(dir: string, depth: number): Promise<void> {
        if (depth > maxDepth) return;
        let entries: fs.Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const name = entry.name;
            // 跳过常见的无关目录
            if (entry.isDirectory()) {
                if (['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv'].includes(name)) {
                    continue;
                }
                await walk(path.join(dir, name), depth + 1);
            } else if (entry.isFile()) {
                const ext = path.extname(name).toLowerCase();
                const lang = langExtMap[ext];
                if (lang) {
                    counts.set(lang, (counts.get(lang) ?? 0) + 1);
                }
            }
        }
    }

    await walk(repoPath, 1);

    if (counts.size === 0) return undefined;
    let topLang = '';
    let topCount = 0;
    for (const [lang, count] of counts) {
        if (count > topCount) {
            topCount = count;
            topLang = lang;
        }
    }
    return topLang || undefined;
}

// ─── Public API ─────────────────────────────────────────

/**
 * 从 clone 出的 repoPath 抽取 RepoMeta，用于 AI 推荐输入。
 *
 * @param repoPath  本地仓库路径
 * @param url       仓库远端 URL
 * @param name      仓库名（不含 org）
 */
export async function buildRepoMetaFromPath(
    repoPath: string,
    url: string,
    name: string,
): Promise<RepoMeta> {
    const meta: RepoMeta = { url, name };

    // README 首段
    const readmeCandidates = ['README.md', 'readme.md', 'README.zh-CN.md', 'README.zh.md'];
    for (const candidate of readmeCandidates) {
        const filePath = path.join(repoPath, candidate);
        if (await fs.pathExists(filePath)) {
            try {
                const content = await fs.readFile(filePath, 'utf8');
                // 去掉 Markdown 标题前缀，取首 ~500 字
                const stripped = content.replace(/^#+\s.*\n?/gm, '').trim();
                meta.readme_excerpt = stripped.slice(0, 500);
                break;
            } catch {
                // 忽略读取错误
            }
        }
    }

    // package.json
    const pkgPath = path.join(repoPath, 'package.json');
    if (await fs.pathExists(pkgPath)) {
        try {
            const pkgRaw = await fs.readFile(pkgPath, 'utf8');
            const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
            if (typeof pkg.description === 'string' && pkg.description) {
                meta.description = pkg.description;
            }
            if (Array.isArray(pkg.keywords) && pkg.keywords.length > 0) {
                meta.keywords = pkg.keywords as string[];
            }
        } catch {
            // 忽略解析错误
        }
    }

    // setup.py description（Python 项目）
    if (!meta.description) {
        const setupPath = path.join(repoPath, 'setup.py');
        if (await fs.pathExists(setupPath)) {
            try {
                const setupContent = await fs.readFile(setupPath, 'utf8');
                const match = setupContent.match(/description\s*=\s*['"]([^'"]+)['"]/);
                if (match) {
                    meta.description = match[1];
                }
            } catch {
                // 忽略
            }
        }
    }

    // 主要语言
    meta.primary_language = await detectPrimaryLanguage(repoPath);

    return meta;
}

/**
 * 单点确认 UX：展示 AI 推荐，等待用户输入 Y/n/o/u。
 * 非 TTY 模式直接归入「未分类」。
 *
 * 返回最终确定的域名。
 */
async function interactiveConfirmDomain(
    repoName: string,
    recommend: Awaited<ReturnType<typeof recommendDomain>>,
    domains: DomainsFile,
): Promise<{ domainName: string; accepted: boolean; rejectReason?: string }> {
    if (!process.stdin.isTTY) {
        log.warn(`非 TTY 模式，仓库 ${repoName} 直接归入「未分类」`);
        return { domainName: '未分类', accepted: false };
    }

    const { domain, confidence, signal, alternatives } = recommend;

    console.log('');
    console.log(chalk.cyan(`[AI 推荐 domain: ${domain} (confidence ${confidence.toFixed(2)})]`));
    console.log(chalk.gray(`[依据: ${signal}]`));
    if (alternatives.length > 0) {
        const altStr = alternatives.map((a) => `${a.domain} (${a.confidence.toFixed(2)})`).join(', ');
        console.log(chalk.gray(`[备选: ${altStr}]`));
    }
    console.log('');

    const answer = await askQuestion(
        `确认归入「${domain}」吗？ [Y/n/o (其他域)/u (未分类)] `,
        'y',
    );

    const lower = answer.toLowerCase().trim();

    if (lower === '' || lower === 'y') {
        return { domainName: domain, accepted: true };
    }

    if (lower === 'u') {
        return { domainName: '未分类', accepted: false };
    }

    if (lower === 'n') {
        let rejectReason: string | undefined;
        try {
            rejectReason = await askQuestion('请简述拒绝原因（可留空）：', '');
        } catch {
            // 非 TTY fallback
        }
        return { domainName: '未分类', accepted: false, rejectReason: rejectReason || undefined };
    }

    if (lower === 'o') {
        const existingDomains = domains.domains.map((d, idx) => `  ${idx + 1}. ${d.name}`);
        console.log('已有域列表：');
        console.log(existingDomains.join('\n'));
        const numStr = await askQuestion('请输入编号：', '');
        const num = parseInt(numStr, 10);
        if (!isNaN(num) && num >= 1 && num <= domains.domains.length) {
            return { domainName: domains.domains[num - 1].name, accepted: true };
        }
        log.warn('无效编号，归入「未分类」');
        return { domainName: '未分类', accepted: false };
    }

    return { domainName: '未分类', accepted: false };
}

// ─── Domain Drift Detection ─────────────────────────────

/**
 * 检测仓库域归属漂移（仅在增量同步场景执行）。
 *
 * 当推荐域与当前归属不同、且 confidence 偏差 > threshold 时，写入 history 并告警。
 * 任何错误只 debug 日志，不抛出，不阻塞主流程。
 *
 * @internal
 */
export async function detectDomainDrift(args: {
    cwd: string;
    url: string;
    newMeta: RepoMeta;
    domains: DomainsFile;
    threshold?: number;
    oldSha: string | null;
    newSha: string;
}): Promise<void> {
    const { cwd, url, newMeta, domains, threshold = 0.4, oldSha, newSha } = args;

    if (oldSha === null) {
        // 非增量场景，不检测漂移
        return;
    }

    try {
        // 找到 url 当前归属域
        let currentDomain: string | null = null;
        let currentConfidence = 0;
        for (const domain of domains.domains) {
            const repoEntry = domain.repos.find((r) => r.url === url);
            if (repoEntry) {
                currentDomain = domain.name;
                currentConfidence = repoEntry.confidence ?? 0;
                break;
            }
        }

        if (currentDomain === null) {
            // 不在任何域，跳过
            return;
        }

        const recommendResult = await recommendDomain(newMeta, domains);

        // 同域无需报告
        if (recommendResult.domain === currentDomain) {
            return;
        }

        const confidenceDiff = Math.abs(recommendResult.confidence - currentConfidence);
        if (recommendResult.confidence <= 0.5 || confidenceDiff <= threshold) {
            return;
        }

        // 写 history
        await appendHistory(cwd, {
            ts: new Date().toISOString(),
            actor: 'ai',
            action: 'recommend',
            details: {
                kind: 'drift',
                url,
                oldDomain: currentDomain,
                newRecommendedDomain: recommendResult.domain,
                oldConfidence: currentConfidence,
                newConfidence: recommendResult.confidence,
                oldSha,
                newSha,
                signal: recommendResult.signal,
            },
        });

        log.warn(
            `[drift] 仓库 ${url} 可能需要重新分类` +
            `（推荐域 ${recommendResult.domain}，confidence ${recommendResult.confidence.toFixed(2)}），` +
            `已记入 history。请人工 review，自动归属未变。`,
        );

        // 写 pending-review（24h 去重：移除同 url 的旧 drift 项）
        try {
            const existing = await loadPendingReview(cwd);
            const cutoffMs = Date.now() - 24 * 3600 * 1000;
            for (const existingItem of existing) {
                if (existingItem.kind !== 'domain-drift') continue;
                const itemUrl = String(existingItem.payload['url'] ?? '');
                if (itemUrl !== url) continue;
                const itemMs = Date.parse(existingItem.ts);
                if (Number.isFinite(itemMs) && itemMs >= cutoffMs) {
                    await removePendingReview(cwd, existingItem.id);
                }
            }
            await appendPendingReview(cwd, {
                kind: 'domain-drift',
                target: { file: '.teamai/domains.yaml' },
                payload: {
                    url,
                    oldDomain: currentDomain,
                    newRecommendedDomain: recommendResult.domain,
                    oldConfidence: currentConfidence,
                    newConfidence: recommendResult.confidence,
                    signal: recommendResult.signal,
                    oldSha,
                    newSha,
                },
                source: 'drift-detector',
            });
        } catch (err) {
            log.debug(`[drift] 写入 pending-review 失败：${err instanceof Error ? err.message : String(err)}`);
        }
    } catch (err) {
        log.debug(`[drift] 域漂移检测失败（不影响主流程）：${String(err)}`);
    }
}

/**
 * teamai import --from-repo <url> 主入口。
 *
 * 流程：
 *  1. 解析 url → provider + RepoInfo（owner/repo）
 *  2. shallow clone（或增量 fetch+reset）到 ~/.teamai/cache/repos/<provider>/<owner>/<repo>
 *  3. generateCodebaseMd({ repoPath: cacheDir })
 *  4. 写出到 <outputRoot>/repos/<slug>.md（默认 outputRoot=.teamai/team-repo/docs/team-codebase）
 *  5. 推荐业务域（或使用 --domain 显式指定）
 *  6. 写入 .teamai/domains.yaml + appendHistory
 *  7. 写 LAST_SYNC
 *
 * @throws 克隆失败、扫描失败、IO 失败时抛 Error
 */
export async function importFromRepo(opts: ImportFromRepoOptions): Promise<void> {
    const {
        url, depth = 1, forceSsh = false, forceAnonymous = false,
        explicitDomain, dryRun = false, output, interactive = true,
        incremental = false, skipAutoPush = false, skipEnrich = false,
    } = opts;

    // 1. 解析 provider 和仓库信息
    const providerName = detectProvider(url);
    if (!providerName) {
        throw new Error(`Unsupported repo URL: ${url}`);
    }

    // 从 url 提取 owner 和 repo 名
    // 支持 https://github.com/owner/repo[.git] 和 git@github.com:owner/repo[.git]
    let owner: string;
    let repoName: string;
    const httpsMatch = url.match(/https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
    const sshMatch = url.match(/git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (httpsMatch) {
        owner = httpsMatch[1];
        repoName = httpsMatch[2];
    } else if (sshMatch) {
        owner = sshMatch[1];
        repoName = sshMatch[2];
    } else {
        throw new Error(`Unsupported repo URL: ${url}`);
    }

    log.info(`导入远端仓库: ${owner}/${repoName} (provider: ${providerName})`);

    // 2. shallow clone 或增量 fetch+reset
    await ensureCacheRoot();
    const cacheDir = getRepoCacheDir(providerName, owner, repoName);
    const slug = getRepoSlug(providerName, owner, repoName);

    const lastSync = await readLastSync(cacheDir);
    const cacheExists = await fs.pathExists(path.join(cacheDir, '.git'));
    const useIncremental = incremental && cacheExists && lastSync !== null;

    let cloneSha: string;
    let cloneBranch: string;
    let oldSha: string | null = null;

    if (useIncremental) {
        oldSha = lastSync.sha;
        log.info(`[incremental] 缓存命中 ${cacheDir}，从 ${oldSha.slice(0, 8)} 增量同步`);
        try {
            const fetchResult = await shallowFetch(cacheDir);
            cloneSha = fetchResult.sha;
            cloneBranch = 'HEAD';
            log.info(`[incremental] Fetch 完成: SHA=${cloneSha.slice(0, 8)}`);
        } catch (fetchErr) {
            log.warn(
                `[incremental] fetch 失败，fallback 到全量 clone：` +
                `${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
            );
            try {
                const cloneResult = await shallowClone(url, cacheDir, providerName, {
                    depth, forceSsh, forceAnonymous,
                });
                cloneSha = cloneResult.sha;
                cloneBranch = cloneResult.branch;
                oldSha = null; // fallback 时视为全量，不做漂移检测
            } catch (err) {
                throw new Error(`克隆失败 (${url}): ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    } else {
        log.info(`Shallow clone 到缓存目录: ${cacheDir}`);
        try {
            const cloneResult = await shallowClone(url, cacheDir, providerName, {
                depth, forceSsh, forceAnonymous,
            });
            cloneSha = cloneResult.sha;
            cloneBranch = cloneResult.branch;
        } catch (err) {
            // shallowClone 内部已清理目录
            throw new Error(`克隆失败 (${url}): ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    log.info(`Clone/Fetch 完成: SHA=${cloneSha.slice(0, 8)}, branch=${cloneBranch}`);

    // 2.5 SHA 未变化时跳过 AI 扫描（增量模式快速路径）
    if (useIncremental && oldSha && cloneSha === oldSha) {
        log.info(`[incremental] SHA 未变化 (${cloneSha.slice(0, 8)})，跳过 AI 扫描`);
        await writeLastSync(cacheDir, cloneSha);
        try {
            await touchCacheEntry({ provider: providerName, owner, repo: repoName, lastSyncedSha: cloneSha });
        } catch {}
        log.info(chalk.green(`✓ 仓库 ${owner}/${repoName} 无变化，跳过`));
        return;
    }

    // 3. 扫描生成 codebase.md（AI 扫描失败不阻断后续图谱提取）
    log.info(`扫描仓库内容...`);
    let codebaseMd: string | undefined;
    if (skipEnrich) {
        log.debug('AI enrichment skipped (--skip-enrich)');
    } else {
        try {
            codebaseMd = await generateCodebaseMd({ repoPath: cacheDir });
        } catch (err) {
            log.warn(`AI codebase 扫描失败（不阻断图谱提取）: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // Resolve team-repo directory (needed for both docs/team-codebase and teamwiki)
    let teamRepoDir: string;
    let teamRepoRemote = '';
    try {
        const { autoDetectInit } = await import('./config.js');
        const { localConfig: lc } = await autoDetectInit();
        teamRepoDir = lc.repo.localPath;
        teamRepoRemote = lc.repo.remote;
    } catch {
        teamRepoDir = path.join(process.cwd(), '.teamai', 'team-repo');
    }

    // 4. 写入 docs/team-codebase 叙事文档（AI 扫描成功时）
    const outputRoot = output ?? path.join(teamRepoDir, 'docs', 'team-codebase');
    let repoMdPath = path.join(outputRoot, 'repos', `${slug}.md`);

    if (codebaseMd) {
        assertSafePath(repoMdPath, [path.join(outputRoot, 'repos')]);
        const sourceTag = `${url}@${cloneSha.slice(0, 8)}`;
        const syncedAt = new Date().toISOString();

        let oldFile: string | null = null;
        if (await fs.pathExists(repoMdPath)) {
            try { oldFile = await fs.readFile(repoMdPath, 'utf8'); } catch { oldFile = null; }
        }

        let merged: ReturnType<typeof mergeWithAnchors>;
        let toWrite: string;
        try {
            merged = mergeWithAnchors(oldFile, codebaseMd, { source: sourceTag, syncedAt });
            toWrite = merged.mergedMd;
        } catch (err) {
            log.warn(`[section-merge] ${err instanceof Error ? err.message : err}；fallback 到全量重写`);
            if (oldFile !== null && !dryRun) {
                const bakPath = `${repoMdPath}.bak`;
                try { await fs.writeFile(bakPath, oldFile, 'utf8'); } catch {}
            }
            merged = mergeWithAnchors(null, codebaseMd, { source: sourceTag, syncedAt });
            toWrite = merged.mergedMd;
        }

    // 注入 repo_url 到 frontmatter，供 aggregate 映射 domain
    if (toWrite.startsWith('---\n') && !toWrite.includes('\nrepo_url:')) {
        const fmEnd = toWrite.indexOf('\n---\n', 4);
        if (fmEnd !== -1) {
            toWrite = toWrite.slice(0, fmEnd) + `\nrepo_url: ${url}` + toWrite.slice(fmEnd);
        }
    }

    if (dryRun) {
        console.log(chalk.yellow(`[dry-run] 产物路径: ${repoMdPath}`));
        console.log(chalk.yellow('[dry-run] 产物预览（前 50 行）：'));
        const preview = toWrite.split('\n').slice(0, 50).join('\n');
        console.log(preview);
        if (merged.changedSlugs.length > 0) {
            console.log(chalk.yellow(`[dry-run] 变化章节: ${merged.changedSlugs.join(', ')}`));
        }
        if (merged.addedSlugs.length > 0) {
            console.log(chalk.yellow(`[dry-run] 新增章节: ${merged.addedSlugs.join(', ')}`));
        }
        if (merged.removedSlugs.length > 0) {
            console.log(chalk.yellow(`[dry-run] 移除章节: ${merged.removedSlugs.join(', ')}`));
        }
    } else {
        await fs.ensureDir(path.dirname(repoMdPath));
        const noChange =
            merged.changedSlugs.length === 0 &&
            merged.addedSlugs.length === 0 &&
            merged.removedSlugs.length === 0 &&
            oldFile !== null &&
            oldFile === toWrite;
        if (noChange) {
            log.info(`[section-merge] 仓库 ${repoName} 无章节变化，跳过写入`);
        } else {
            await fs.writeFile(repoMdPath, toWrite, 'utf8');
            log.info(`产物已写入: ${repoMdPath}`);
            if (merged.changedSlugs.length > 0) {
                log.debug(`[section-merge] 变化章节: ${merged.changedSlugs.join(', ')}`);
            }
            if (merged.addedSlugs.length > 0) {
                log.debug(`[section-merge] 新增章节: ${merged.addedSlugs.join(', ')}`);
            }
            if (merged.removedSlugs.length > 0) {
                log.debug(`[section-merge] 移除章节: ${merged.removedSlugs.join(', ')}`);
            }
        }
    }
    } // end if (codebaseMd)

    // 4b. 生成 teamwiki/ 知识图谱产物（写入 team-repo 以便自动 push）
    const teamwikiRoot = output
        ? path.resolve(output, '..', 'teamwiki')
        : path.join(teamRepoDir, 'teamwiki');
    if (!dryRun) {
        const cacheWiki = path.join(cacheDir, 'teamwiki');
        try {
            await extractCodebase({ path: cacheDir, project: slug, json: false, skipEnrich });
            // 将产物从 cacheDir/teamwiki/ 移动到目标 teamwikiRoot
            if (await fs.pathExists(cacheWiki)) {
                const evidenceSrc = path.join(cacheWiki, 'evidence', 'code', slug);
                const evidenceDest = path.join(teamwikiRoot, 'evidence', 'code', slug);
                await fs.ensureDir(evidenceDest);
                await fs.copy(evidenceSrc, evidenceDest, { overwrite: true });
                // 如果 AI 扫描成功，将架构概述写入 overview.md
                if (codebaseMd) {
                    const overviewContent = [
                        '---',
                        `title: ${slug} overview`,
                        'domain: code-knowledge',
                        `source: [${url}]`,
                        '---',
                        '',
                        codebaseMd.replace(/^---[\s\S]*?---\n*/m, ''),
                    ].join('\n');
                    await fs.writeFile(path.join(evidenceDest, 'overview.md'), overviewContent, 'utf8');
                }
                // Per-repo graph: copy to evidence/<slug>/.indices/ (no global merge here — done in batch)
                const srcGraph = path.join(cacheWiki, '.indices', 'graph-index.json');
                const evidenceGraphDir = path.join(teamwikiRoot, 'evidence', 'code', slug, '.indices');
                await fs.ensureDir(evidenceGraphDir);
                await fs.copy(srcGraph, path.join(evidenceGraphDir, 'graph-index.json'));
                await fs.remove(cacheWiki);
            }
            // 白名单显式 domain 覆盖 AI 推断
            if (explicitDomain) {
                const domainsJsonPath = path.join(teamwikiRoot, 'evidence', 'code', slug, '_domains.json');
                if (await fs.pathExists(domainsJsonPath)) {
                    try {
                        const existing = JSON.parse(await fs.readFile(domainsJsonPath, 'utf8'));
                        existing.domain = explicitDomain;
                        await fs.writeFile(domainsJsonPath, JSON.stringify(existing, null, 2), 'utf8');
                    } catch { /* skip */ }
                } else {
                    await fs.writeFile(domainsJsonPath, JSON.stringify({ domain: explicitDomain }, null, 2), 'utf8');
                }
            }
            // 更新顶层 router.md 和 index.md（追加新项目，不覆盖）
            const { routerTemplate, indexTemplate, HOT_TEMPLATE } = await import('./wiki-engine/adapters/templates.js');
            const routerPath = path.join(teamwikiRoot, 'router.md');
            const indexPath = path.join(teamwikiRoot, 'index.md');
            const projectLink = `[[code/${slug}/index]]`;
            if (await fs.pathExists(routerPath)) {
                const router = await fs.readFile(routerPath, 'utf8');
                if (!router.includes(projectLink)) {
                    const line = `- ${projectLink} — ${slug} 代码知识\n`;
                    await fs.writeFile(routerPath, router.trimEnd() + '\n' + line, 'utf8');
                }
            } else {
                await fs.writeFile(routerPath, routerTemplate([{ slug, label: slug }]), 'utf8');
            }
            if (await fs.pathExists(indexPath)) {
                const idx = await fs.readFile(indexPath, 'utf8');
                if (!idx.includes(slug)) {
                    const insertPoint = idx.indexOf('## Navigation');
                    if (insertPoint > 0) {
                        const entry = `- [${slug}](./evidence/code/${slug}/index.md) — 代码知识图谱\n\n`;
                        await fs.writeFile(indexPath, idx.slice(0, insertPoint) + entry + idx.slice(insertPoint), 'utf8');
                    }
                }
            } else {
                await fs.writeFile(indexPath, indexTemplate([{ slug, label: slug }]), 'utf8');
            }
            if (!await fs.pathExists(path.join(teamwikiRoot, 'hot.md'))) {
                await fs.writeFile(path.join(teamwikiRoot, 'hot.md'), HOT_TEMPLATE, 'utf8');
            }

            log.info(chalk.green(`✓ teamwiki/ 知识图谱已更新: ${slug}`));
        } catch (err) {
            log.debug(`[wiki-engine] 图谱生成失败（非阻塞）: ${err instanceof Error ? err.message : err}`);
        } finally {
            await fs.remove(cacheWiki).catch(() => {});
        }
    }

    // 4c. Reconcile product docs ↔ code knowledge (if product docs exist)
    if (!dryRun && teamwikiRoot) {
        try {
            const { reconcileKnowledge } = await import('./wiki-engine/adapters/index.js');
            const result = await reconcileKnowledge({ wikiRoot: teamwikiRoot, dryRun: false });
            if (result.mappings > 0 || result.gaps.length > 0) {
                log.info(`  对账: ${result.mappings} 映射, ${result.gaps.length} 缺口, ${result.graphEdges.length} MAPS_TO 边`);
            }
        } catch (e) {
            log.debug(`reconcile skipped: ${(e as Error).message}`);
        }
    }

    // 5. 聚合全局图谱 + 自动推送（单仓模式；batch 模式由 import-repo-list 统一处理）
    if (!dryRun && !skipAutoPush) {
        if (teamwikiRoot) {
            try {
                const { aggregateGlobalGraph } = await import('./graph-aggregate.js');
                await aggregateGlobalGraph(teamwikiRoot);
            } catch (e) {
                log.debug(`[graph] 单仓聚合跳过: ${(e as Error).message}`);
            }
        }
        if (await fs.pathExists(teamRepoDir)) {
            const { autoPushTeamRepo } = await import('./utils/git.js');
            await autoPushTeamRepo(teamRepoDir, `[teamai] Import codebase knowledge from ${owner}/${repoName}`);
            log.success(`已推送到团队知识仓库${teamRepoRemote ? ` (${teamRepoRemote})` : ''}`);
        }
    }

    log.info(chalk.green(`✓ 仓库 ${owner}/${repoName} 导入完成`));

    // 5b. 后台深度生成（不阻塞；batch 模式下跳过 push 由调用方统一处理）
    if (!dryRun && teamwikiRoot) {
        const evidenceDir = path.join(teamwikiRoot, 'evidence', 'code', slug);
        if (await fs.pathExists(path.join(evidenceDir, '_manifest.json'))) {
            setImmediate(async () => {
                try {
                    const { deepEnrich } = await import('./deep-enrich.js');
                    await deepEnrich({ project: slug, evidenceDir, wikiRoot: teamwikiRoot, cacheDir });
                    if (!skipAutoPush) {
                        const { autoPushTeamRepo } = await import('./utils/git.js');
                        if (await fs.pathExists(teamRepoDir)) {
                            await autoPushTeamRepo(teamRepoDir, `[teamai] Deep enrich: ${slug}`);
                        }
                    }
                    log.info(chalk.green(`✓ 深度生成完成: ${slug}`));
                } catch (e) {
                    log.debug(`deep-enrich background failed for ${slug}: ${(e as Error).message}`);
                }
            });
        }
    }


    // 6. 写 LAST_SYNC
    if (!dryRun) {
        await writeLastSync(cacheDir, cloneSha);
        try {
            await touchCacheEntry({ provider: providerName, owner, repo: repoName, lastSyncedSha: cloneSha });
        } catch (touchErr) {
            log.debug(`[cache-index] touchCacheEntry 失败: ${String(touchErr)}`);
        }
    }
}
