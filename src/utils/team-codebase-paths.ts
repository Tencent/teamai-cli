// -*- coding: utf-8 -*-
import path from 'node:path';

/** 相对于 docs/ 的团队 codebase 子目录名。 */
export const TEAM_CODEBASE_DIR = 'team-codebase';

/** 团队 codebase 各层路径集合。 */
export interface TeamCodebasePaths {
    /** .teamai/team-repo/docs/team-codebase (or custom --output path) */
    root: string;
    /** <root>/index.md */
    index: string;
    /** <root>/domains */
    domainsDir: string;
    /** <root>/repos */
    reposDir: string;
}

/**
 * 由 cwd 派生出团队 codebase 全部路径。
 *
 * @param cwd    工作目录（通常 process.cwd()）
 * @param output 自定义产物根（绝对路径）；指定时直接使用，不再向下拼 docs/
 * @returns      TeamCodebasePaths 对象
 */
export function getTeamCodebasePaths(cwd: string, output?: string): TeamCodebasePaths {
    const root = output ?? path.join(cwd, 'docs', TEAM_CODEBASE_DIR);
    return {
        root,
        index: path.join(root, 'index.md'),
        domainsDir: path.join(root, 'domains'),
        reposDir: path.join(root, 'repos'),
    };
}

/**
 * 将域名转换为文件名安全形式（safe slug）。
 *
 * 规则：把 /、\、: 替换为 _；trim 空白；空名退化为 'unnamed'。
 * 中文及其他 Unicode 字符保留（写盘时 utf-8）。
 *
 * @param name 原始域名
 * @returns    文件名安全的 slug 字符串
 */
export function safeDomainSlug(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
        return 'unnamed';
    }
    return trimmed.replace(/[/\\:]/g, '_');
}
