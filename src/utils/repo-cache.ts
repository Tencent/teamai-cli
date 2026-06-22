import path from 'node:path';
import os from 'node:os';

import fs from 'fs-extra';

// ─── Constants ──────────────────────────────────────────

const LAST_SYNC_FILE = 'LAST_SYNC';

// ─── Helpers ────────────────────────────────────────────

/**
 * 返回缓存根目录（可通过 TEAMAI_CACHE_DIR 环境变量覆盖）。
 */
function getCacheRoot(): string {
    return process.env.TEAMAI_CACHE_DIR ?? path.join(os.homedir(), '.teamai', 'cache', 'repos');
}

// ─── Public API ─────────────────────────────────────────

/**
 * 计算单仓的本地缓存目录：~/.teamai/cache/repos/<provider>/<owner>/<repo>
 *
 * @param provider  'github' | 'tgit'
 * @param owner     仓库属主（含可能的多级 group，如 'team/sub'）
 * @param repo      仓库名
 */
export function getRepoCacheDir(provider: string, owner: string, repo: string): string {
    return path.join(getCacheRoot(), provider, owner, repo);
}

/**
 * 计算单仓 slug（用于产物文件命名）：<provider>__<owner-with-slashes-replaced>__<repo>
 *
 * @param provider  'github' | 'tgit'
 * @param owner     仓库属主（含可能的多级 group）
 * @param repo      仓库名
 */
export function getRepoSlug(provider: string, owner: string, repo: string): string {
    const safeOwner = owner.replace(/\//g, '-');
    return `${provider}__${safeOwner}__${repo}`;
}

/**
 * 写入 LAST_SYNC 文件，记录 commit SHA + ISO 时间。
 *
 * @param cacheDir  本地缓存目录路径
 * @param sha       HEAD commit SHA
 */
export async function writeLastSync(cacheDir: string, sha: string): Promise<void> {
    const isoTs = new Date().toISOString();
    const content = `${sha}\n${isoTs}\n`;
    await fs.writeFile(path.join(cacheDir, LAST_SYNC_FILE), content, 'utf8');
}

/**
 * 读取 LAST_SYNC 文件；不存在时返回 null。
 *
 * @param cacheDir  本地缓存目录路径
 */
export async function readLastSync(
    cacheDir: string,
): Promise<{ sha: string; ts: string } | null> {
    const filePath = path.join(cacheDir, LAST_SYNC_FILE);
    const exists = await fs.pathExists(filePath);
    if (!exists) {
        return null;
    }
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length < 2) {
        return null;
    }
    return { sha: lines[0].trim(), ts: lines[1].trim() };
}

/**
 * 确保缓存父目录存在，返回缓存根路径。
 */
export async function ensureCacheRoot(): Promise<string> {
    const root = getCacheRoot();
    await fs.ensureDir(root);
    return root;
}
