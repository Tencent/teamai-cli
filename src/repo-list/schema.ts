// -*- coding: utf-8 -*-
import { z } from 'zod';

/** 单仓白名单条目 schema。 */
export const RepoListEntrySchema = z.object({
    url: z.string().url(),
    domain: z.string().optional(),
    iwiki_space: z.string().optional(),
    auth: z.enum(['token', 'ssh', 'public']).optional(),
    priority: z.enum(['low', 'normal', 'high']).optional().default('normal'),
});

/** org/group 批量导入条目 schema（P5.4 实现；P5.2 遇到时 warn + 跳过）。 */
export const RepoListOrgEntrySchema = z.object({
    org: z.string().url(),
    include_pattern: z.string().optional(),
    exclude_pattern: z.string().optional(),
    default_domain: z.string().optional(),
    auth: z.enum(['token', 'ssh', 'public']).optional(),
});

/** 白名单条目：单仓或 org 批量。 */
export const RepoListItemSchema = z.union([RepoListOrgEntrySchema, RepoListEntrySchema]);

/** 白名单 yaml 顶层文件 schema。 */
export const RepoListFileSchema = z.object({
    version: z.literal(1).default(1),
    repos: z.array(RepoListItemSchema).default([]),
});

export type RepoListEntry = z.infer<typeof RepoListEntrySchema>;
export type RepoListOrgEntry = z.infer<typeof RepoListOrgEntrySchema>;
export type RepoListItem = z.infer<typeof RepoListItemSchema>;
export type RepoListFile = z.infer<typeof RepoListFileSchema>;

/**
 * 判断条目是否为 org 批量条目。
 *
 * @param item 白名单条目
 * @returns    是 org 条目时为 true
 */
export function isOrgEntry(item: RepoListItem): item is RepoListOrgEntry {
    return 'org' in item;
}
