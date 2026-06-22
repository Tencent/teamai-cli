import { spawn } from 'node:child_process';

import fs from 'fs-extra';

import { getGitHubToken } from './providers/github/gh-cli.js';
import { log } from './utils/logger.js';

// ─── Types ──────────────────────────────────────────────

export interface CloneOpts {
    /** Shallow clone depth，默认 1 */
    depth?: number;
    /** 强制走 SSH，即使 HTTPS token 可用 */
    forceSsh?: boolean;
    /** 强制匿名 HTTPS，即使 token 可用（per-repo auth: public） */
    forceAnonymous?: boolean;
    /** 超时毫秒数，默认 180_000 */
    timeoutMs?: number;
}

export interface CloneResult {
    /** clone 完成后的 HEAD commit SHA */
    sha: string;
    /** 默认分支名 */
    branch: string;
    /** 实际使用的认证方式 */
    cloneMethod: 'https-token' | 'https-anonymous' | 'ssh';
}

// ─── Helpers ────────────────────────────────────────────

/**
 * 判断 url 是否是 SSH 形式（git@ 开头或包含 : 且不含 ://）。
 */
function isSshUrl(url: string): boolean {
    return url.startsWith('git@') || (!url.includes('://') && url.includes(':'));
}

/**
 * 将 URL 中的认证信息脱敏，用于日志和错误消息。
 * 替换 https://[anything]@ 为 https://***@
 *
 * @param msg  可能含有 token 的字符串
 * @returns    脱敏后的字符串
 */
export function sanitizeGitUrl(msg: string): string {
    return msg.replace(/https?:\/\/[^@\s]+@/g, 'https://***@');
}

/**
 * 对日志/错误信息中的 token 进行脱敏。
 */
function redactToken(msg: string): string {
    return sanitizeGitUrl(msg);
}

/**
 * 构建携带 GitHub token 的 git -c http.extraHeader 参数值。
 * 避免将 token 嵌入 URL，防止其出现在进程列表或日志中。
 *
 * @param token  GitHub token
 * @returns      Authorization header 值，格式为 `Authorization: Basic <base64>`
 */
function buildAuthHeader(token: string): string {
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
    return `Authorization: Basic ${encoded}`;
}

/**
 * 包装 spawn 为 Promise，返回 stdout/stderr/exitCode。
 */
function runCommand(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: opts.cwd,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Command timed out after ${opts.timeoutMs}ms: ${cmd} ${args.join(' ')}`));
        }, opts.timeoutMs);

        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code: code ?? 1 });
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * 在给定目录执行 git 命令，返回 stdout（trim）。
 */
async function gitCmd(
    args: string[],
    cwd: string,
    timeoutMs: number = 30_000,
): Promise<string> {
    const { stdout, stderr, code } = await runCommand('git', args, { cwd, timeoutMs });
    if (code !== 0) {
        throw new Error(`git ${args[0]} failed (exit ${code}): ${redactToken(stderr.trim())}`);
    }
    return stdout.trim();
}

// ─── Public API ─────────────────────────────────────────

/**
 * Shallow clone 远端仓库到指定本地目录。
 *
 * 三层认证策略：
 *   1. forceSsh=true 或 url 是 SSH 形式 → 直接走 SSH
 *   2. github 且能拿到 token → HTTPS + x-access-token 注入
 *   3. tgit 走 ~/.netrc（git 自身处理）；github 无 token 则匿名 HTTPS
 *
 * @param url        仓库 URL（https/ssh 任一）
 * @param localPath  目标目录（存在则先 rm 再 clone）
 * @param provider   'github' | 'tgit'
 * @param opts       克隆选项
 */
export async function shallowClone(
    url: string,
    localPath: string,
    provider: string,
    opts?: CloneOpts,
): Promise<CloneResult> {
    const depth = opts?.depth ?? 1;
    const forceSsh = opts?.forceSsh ?? false;
    const forceAnonymous = opts?.forceAnonymous ?? false;
    const timeoutMs = opts?.timeoutMs ?? 180_000;

    // 清理已存在目录
    if (await fs.pathExists(localPath)) {
        await fs.remove(localPath);
    }
    await fs.ensureDir(localPath);

    // 确定克隆 URL 和认证方式
    let cloneUrl = url;
    let cloneMethod: CloneResult['cloneMethod'];
    let githubToken: string | undefined;

    if (forceSsh || isSshUrl(url)) {
        cloneUrl = url;
        cloneMethod = 'ssh';
        log.debug(`shallowClone: 使用 SSH 克隆 ${url}`);
    } else if (forceAnonymous) {
        cloneUrl = url;
        cloneMethod = 'https-anonymous';
        log.debug(`shallowClone: forceAnonymous=true，匿名 HTTPS 克隆 ${url}`);
    } else if (provider === 'github') {
        const token = getGitHubToken();
        if (token) {
            cloneUrl = url;
            githubToken = token;
            cloneMethod = 'https-token';
            log.debug(`shallowClone: 使用 HTTPS+token 克隆 github 仓库`);
        } else {
            cloneUrl = url;
            cloneMethod = 'https-anonymous';
            log.debug(`shallowClone: 使用匿名 HTTPS 克隆 github 仓库`);
        }
    } else {
        // tgit 或其他 provider，依赖 ~/.netrc
        cloneUrl = url;
        cloneMethod = 'https-anonymous';
        log.debug(`shallowClone: 使用 HTTPS (~/.netrc) 克隆 ${provider} 仓库`);
    }

    // 构建 clone 参数：若有 token 则通过 http.extraHeader 注入，避免 token 出现在 URL 中
    const cloneArgs: string[] = [];
    if (githubToken) {
        cloneArgs.push('-c', `http.extraHeader=${buildAuthHeader(githubToken)}`);
    }
    cloneArgs.push(
        'clone',
        `--depth=${depth}`,
        '--single-branch',
        cloneUrl,
        localPath,
    );

    try {
        const { code, stderr } = await runCommand('git', cloneArgs, { timeoutMs });
        if (code !== 0) {
            // 清理失败的目录
            await fs.remove(localPath).catch(() => undefined);
            throw new Error(`git clone failed (exit ${code}): ${redactToken(stderr.trim())}`);
        }
    } catch (err) {
        if (err instanceof Error && err.message.startsWith('git clone failed')) {
            throw err;
        }
        await fs.remove(localPath).catch(() => undefined);
        throw err;
    }

    // 获取 HEAD SHA 和分支名
    const sha = await gitCmd(['rev-parse', 'HEAD'], localPath);
    let branch: string;
    try {
        branch = await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD'], localPath);
    } catch {
        branch = 'HEAD';
    }

    log.debug(`shallowClone 完成：sha=${sha.slice(0, 8)}, branch=${branch}, method=${cloneMethod}`);
    return { sha, branch, cloneMethod };
}

/**
 * 在已有 clone 目录上执行 git fetch 并 reset 到最新 HEAD（用于 P5.3 增量；P5.1 暂不调用）。
 *
 * @param localPath  本地 clone 目录
 * @param opts       选项
 */
export async function shallowFetch(
    localPath: string,
    opts?: { timeoutMs?: number },
): Promise<{ sha: string }> {
    const timeoutMs = opts?.timeoutMs ?? 180_000;

    // 获取当前分支
    const branch = await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD'], localPath, timeoutMs);

    await gitCmd(['fetch', '--depth=50', 'origin'], localPath, timeoutMs);
    await gitCmd(['reset', '--hard', `origin/${branch}`], localPath, timeoutMs);

    const sha = await gitCmd(['rev-parse', 'HEAD'], localPath);
    return { sha };
}
