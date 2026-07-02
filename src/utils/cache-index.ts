import path from 'node:path';
import os from 'node:os';

import fs from 'fs-extra';

import { log } from './logger.js';

// ─── Constants ───────────────────────────────────────────

const INDEX_FILENAME = '.cache-index.json';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const DEFAULT_TARGET_RATIO = 0.8;
const DEFAULT_STALE_DAYS = 30;
/** 反序列化大小上限：10 MB，防止超大文件导致 OOM。 */
const MAX_CONFIG_FILE_BYTES = 10 * 1024 * 1024;

// ─── Types ───────────────────────────────────────────────

/**
 * 单个缓存仓条目的元信息。
 */
export interface CacheIndexEntry {
    /** 唯一键：<provider>/<owner>/<repo>，对应实际目录路径相对 cache root */
    key: string;
    /** 全量字节数（递归 stat 累加；不区分 .git 与工作区） */
    size_bytes: number;
    /** 最近一次访问（clone/fetch/scan）的 ISO 时间 */
    last_used: string;
    /** 最近一次同步时拿到的 commit SHA */
    last_synced_sha?: string;
}

/**
 * 缓存索引文件的完整结构。
 */
export interface CacheIndex {
    version: 1;
    updated_at: string;
    entries: CacheIndexEntry[];
}

export interface GcOptions {
    /** 默认 DEFAULT_MAX_BYTES（可被 TEAMAI_CACHE_MAX_BYTES 覆盖） */
    maxBytes?: number;
    /** 默认 0.8 */
    targetRatio?: number;
    /** 默认 30 */
    staleDays?: number;
    dryRun?: boolean;
}

export interface GcResult {
    before: { totalBytes: number; entryCount: number };
    after: { totalBytes: number; entryCount: number };
    removed: Array<{ key: string; size_bytes: number; reason: 'over-cap' | 'stale' }>;
    skipped: Array<{ key: string; reason: string }>;
}

// ─── Helpers ────────────────────────────────────────────

/**
 * 读取 cache root（与 repo-cache.ts 行为完全一致：env TEAMAI_CACHE_DIR 优先，否则 ~/.teamai/cache/repos）。
 */
export function getCacheRoot(): string {
    return process.env.TEAMAI_CACHE_DIR ?? path.join(os.homedir(), '.teamai', 'cache', 'repos');
}

/**
 * 构建缓存条目 key：<provider>/<owner>/<repo>
 *
 * @param provider  git provider 标识
 * @param owner     仓库属主（可含多级 group）
 * @param repo      仓库名
 */
function buildKey(provider: string, owner: string, repo: string): string {
    return `${provider}/${owner}/${repo}`;
}

/**
 * 根据 key 计算缓存目录绝对路径。
 *
 * @param key  buildKey 生成的键
 */
function keyToAbsPath(key: string): string {
    return path.join(getCacheRoot(), key);
}

// ─── Index I/O ───────────────────────────────────────────

/**
 * 读取索引文件；不存在或损坏返回空索引（不抛错）。
 */
export async function loadCacheIndex(): Promise<CacheIndex> {
    const indexPath = path.join(getCacheRoot(), INDEX_FILENAME);
    try {
        const stat = await fs.stat(indexPath);
        if (stat.size > MAX_CONFIG_FILE_BYTES) {
            throw new Error(`${indexPath} exceeds max allowed size 10MB`);
        }
        const raw = await fs.readFile(indexPath, 'utf8');
        const parsed = JSON.parse(raw) as CacheIndex;
        if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
            log.debug('[cache-index] 索引格式不符，返回空索引');
            return emptyIndex();
        }
        return parsed;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.debug(`[cache-index] 读取索引失败，返回空索引: ${String(err)}`);
        }
        return emptyIndex();
    }
}

/**
 * 写入索引文件（覆盖式；调用方负责保证不并发）。
 */
export async function saveCacheIndex(idx: CacheIndex): Promise<void> {
    const root = getCacheRoot();
    await fs.ensureDir(root);
    const indexPath = path.join(root, INDEX_FILENAME);
    const updated: CacheIndex = { ...idx, updated_at: new Date().toISOString() };
    await fs.writeFile(indexPath, JSON.stringify(updated, null, 2), 'utf8');
}

function emptyIndex(): CacheIndex {
    return { version: 1, updated_at: new Date().toISOString(), entries: [] };
}

// ─── Dir Size ────────────────────────────────────────────

/**
 * 递归累加目录字节数。
 *
 * 读取异常的子项跳过（log.debug）。软链接不跟随。
 *
 * @param absPath  目录绝对路径
 */
export async function statDirSize(absPath: string): Promise<number> {
    let total = 0;
    let stat: fs.Stats;
    try {
        stat = await fs.lstat(absPath);
    } catch (err) {
        log.debug(`[cache-index] statDirSize lstat 失败，跳过 ${absPath}: ${String(err)}`);
        return 0;
    }

    if (stat.isSymbolicLink()) {
        return 0;
    }

    if (stat.isFile()) {
        return stat.size;
    }

    if (!stat.isDirectory()) {
        return 0;
    }

    let entries: fs.Dirent[];
    try {
        entries = await fs.readdir(absPath, { withFileTypes: true });
    } catch (err) {
        log.debug(`[cache-index] statDirSize readdir 失败，跳过 ${absPath}: ${String(err)}`);
        return 0;
    }

    for (const entry of entries) {
        const childPath = path.join(absPath, entry.name);
        if (entry.isSymbolicLink()) {
            continue;
        }
        if (entry.isDirectory()) {
            total += await statDirSize(childPath);
        } else if (entry.isFile()) {
            try {
                const childStat = await fs.lstat(childPath);
                total += childStat.size;
            } catch (err) {
                log.debug(`[cache-index] statDirSize 子文件 stat 失败，跳过: ${String(err)}`);
            }
        }
    }

    return total;
}

// ─── Touch ───────────────────────────────────────────────

/**
 * 把单个 entry 的元信息刷新到索引：
 *   - size_bytes 用 statDirSize(absPath) 重算
 *   - last_used = now
 *   - last_synced_sha = lastSyncedSha（若提供）
 *   - 已存在则更新；不存在则新增
 *
 * 不会触发 GC；GC 由单独入口控制。
 *
 * @param args.provider       git provider 标识
 * @param args.owner          仓库属主
 * @param args.repo           仓库名
 * @param args.lastSyncedSha  本次同步的 commit SHA（可选）
 */
export async function touchCacheEntry(args: {
    provider: string;
    owner: string;
    repo: string;
    lastSyncedSha?: string;
}): Promise<void> {
    const { provider, owner, repo, lastSyncedSha } = args;
    const key = buildKey(provider, owner, repo);
    const absPath = keyToAbsPath(key);

    const sizeBytes = await statDirSize(absPath);

    const idx = await loadCacheIndex();
    const existingIdx = idx.entries.findIndex((e) => e.key === key);

    const newEntry: CacheIndexEntry = {
        key,
        size_bytes: sizeBytes,
        last_used: new Date().toISOString(),
        ...(lastSyncedSha !== undefined ? { last_synced_sha: lastSyncedSha } : {}),
    };

    // 保留已有 last_synced_sha（若本次未提供）
    if (existingIdx >= 0) {
        const existing = idx.entries[existingIdx];
        if (lastSyncedSha === undefined && existing.last_synced_sha !== undefined) {
            newEntry.last_synced_sha = existing.last_synced_sha;
        }
        idx.entries[existingIdx] = newEntry;
    } else {
        idx.entries.push(newEntry);
    }

    await saveCacheIndex(idx);
}

// ─── GC ──────────────────────────────────────────────────

/**
 * 执行 GC：
 *   1. 标记所有 last_used > staleDays 的 entry 为 'stale'，无条件淘汰
 *   2. 若剩余总量仍 > maxBytes，按 last_used 升序（最旧优先）淘汰，直到 ≤ maxBytes * targetRatio
 *   3. 删除磁盘目录 + 从索引移除 entry
 *   4. dryRun=true 仅汇报不动盘
 *
 * 淘汰物理路径用 fs.remove（不区分 .git）。
 *
 * @param opts  GC 参数
 * @returns GcResult 含前后对比 + 被删 / 被跳过列表
 */
export async function gcCache(opts?: GcOptions): Promise<GcResult> {
    const {
        targetRatio = DEFAULT_TARGET_RATIO,
        dryRun = false,
    } = opts ?? {};

    // 解析 maxBytes：opts 优先，其次 env，最后默认
    let maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
    const envVal = process.env.TEAMAI_CACHE_MAX_BYTES;
    if (opts?.maxBytes === undefined && envVal !== undefined) {
        const parsed = parseInt(envVal, 10);
        if (!isNaN(parsed) && parsed > 0) {
            maxBytes = parsed;
        }
    }

    const staleDays = opts?.staleDays ?? DEFAULT_STALE_DAYS;

    const idx = await loadCacheIndex();

    const beforeTotal = idx.entries.reduce((s, e) => s + e.size_bytes, 0);
    const beforeCount = idx.entries.length;

    const removed: GcResult['removed'] = [];
    const skipped: GcResult['skipped'] = [];

    // 阶段 1：淘汰 stale 条目
    const staleThresholdMs = staleDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const remaining: CacheIndexEntry[] = [];

    for (const entry of idx.entries) {
        const lastUsedMs = new Date(entry.last_used).getTime();
        const isStale = now - lastUsedMs > staleThresholdMs;

        if (isStale) {
            const absPath = keyToAbsPath(entry.key);
            if (!dryRun) {
                try {
                    await fs.remove(absPath);
                    removed.push({ key: entry.key, size_bytes: entry.size_bytes, reason: 'stale' });
                } catch (err) {
                    log.debug(`[gc] 删除失败，跳过 ${entry.key}: ${String(err)}`);
                    skipped.push({ key: entry.key, reason: `删除失败: ${String(err)}` });
                    remaining.push(entry);
                }
            } else {
                removed.push({ key: entry.key, size_bytes: entry.size_bytes, reason: 'stale' });
            }
        } else {
            remaining.push(entry);
        }
    }

    // 阶段 2：容量上限淘汰（按 last_used 升序）
    const targetBytes = maxBytes * targetRatio;
    let currentTotal = remaining.reduce((s, e) => s + e.size_bytes, 0);

    if (currentTotal > maxBytes) {
        // 最旧优先
        remaining.sort((a, b) => new Date(a.last_used).getTime() - new Date(b.last_used).getTime());

        const toKeep: CacheIndexEntry[] = [];

        for (const entry of remaining) {
            if (currentTotal <= targetBytes) {
                toKeep.push(entry);
                continue;
            }
            const absPath = keyToAbsPath(entry.key);
            if (!dryRun) {
                try {
                    await fs.remove(absPath);
                    removed.push({ key: entry.key, size_bytes: entry.size_bytes, reason: 'over-cap' });
                    currentTotal -= entry.size_bytes;
                } catch (err) {
                    log.debug(`[gc] 删除失败，跳过 ${entry.key}: ${String(err)}`);
                    skipped.push({ key: entry.key, reason: `删除失败: ${String(err)}` });
                    toKeep.push(entry);
                }
            } else {
                removed.push({ key: entry.key, size_bytes: entry.size_bytes, reason: 'over-cap' });
                currentTotal -= entry.size_bytes;
            }
        }

        // 更新 remaining 为保留部分
        remaining.length = 0;
        remaining.push(...toKeep);
    }

    // 更新索引
    const removedKeys = new Set(removed.map((r) => r.key));
    const finalEntries = dryRun
        ? idx.entries.filter((e) => !removedKeys.has(e.key))
        : remaining;

    const updatedIdx: CacheIndex = {
        ...idx,
        entries: finalEntries,
        updated_at: new Date().toISOString(),
    };

    if (!dryRun) {
        await saveCacheIndex(updatedIdx);
    }

    const afterTotal = updatedIdx.entries.reduce((s, e) => s + e.size_bytes, 0);

    return {
        before: { totalBytes: beforeTotal, entryCount: beforeCount },
        after: { totalBytes: afterTotal, entryCount: updatedIdx.entries.length },
        removed,
        skipped,
    };
}

// ─── Status ──────────────────────────────────────────────

/**
 * 返回当前 cache 状态摘要（status 子命令用）。
 *
 * 注意：会同步索引中已不存在于磁盘的 entry（自动剪除）。
 *
 * @returns 根目录、总字节数、条目数、条目列表
 */
export async function getCacheStatus(): Promise<{
    root: string;
    totalBytes: number;
    entryCount: number;
    entries: CacheIndexEntry[];
}> {
    const root = getCacheRoot();
    const idx = await loadCacheIndex();

    // 自愈：移除磁盘已不存在的条目
    const validEntries: CacheIndexEntry[] = [];
    let dirty = false;

    for (const entry of idx.entries) {
        const absPath = keyToAbsPath(entry.key);
        const exists = await fs.pathExists(absPath);
        if (exists) {
            validEntries.push(entry);
        } else {
            log.debug(`[cache-status] 磁盘已不存在，自动剪除条目: ${entry.key}`);
            dirty = true;
        }
    }

    if (dirty) {
        const cleanedIdx: CacheIndex = { ...idx, entries: validEntries };
        await saveCacheIndex(cleanedIdx);
    }

    const totalBytes = validEntries.reduce((s, e) => s + e.size_bytes, 0);

    return {
        root,
        totalBytes,
        entryCount: validEntries.length,
        entries: validEntries,
    };
}
