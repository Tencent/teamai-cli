import { z } from 'zod';

/** 域内单个仓库条目 schema。 */
export const RepoEntrySchema = z.object({
    url: z.string().url(),
    confidence: z.number().min(0).max(1).optional(),
    signal: z.string().optional(),      // AI 给出的归类依据，可选
    locked: z.boolean().optional().default(false),
});

/** 单个业务域条目 schema。 */
export const DomainEntrySchema = z.object({
    name: z.string().min(1),
    description: z.string().optional().default(''),
    confidence: z.number().min(0).max(1).optional(),
    repos: z.array(RepoEntrySchema).default([]),
});

/** domains.yaml 顶层文件 schema。 */
export const DomainsFileSchema = z.object({
    version: z.literal(1).default(1),
    generated_at: z.string().optional(),    // ISO timestamp，draft 才有
    generator: z.string().optional(),       // 例如 "import --bootstrap-domains"
    confidence_threshold: z.number().min(0).max(1).default(0.6),
    domains: z.array(DomainEntrySchema).default([]),
});

export type RepoEntry = z.infer<typeof RepoEntrySchema>;
export type DomainEntry = z.infer<typeof DomainEntrySchema>;
export type DomainsFile = z.infer<typeof DomainsFileSchema>;

/** 历史日志条目 schema。 */
export const HistoryEventSchema = z.object({
    ts: z.string(),                     // ISO timestamp
    actor: z.enum(['ai', 'user']),
    action: z.enum(['recommend', 'accept', 'reject', 'merge', 'split', 'rename', 'lock', 'reassign']),
    details: z.record(z.unknown()),     // 自由 payload
});
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

/**
 * 仓库元信息（聚类输入），由 P5.1 提供。
 */
export interface RepoMeta {
    url: string;
    name: string;                       // 仓库名（不含 org）
    readme_excerpt?: string;            // README 首段（最多 ~500 字）
    description?: string;               // package.json / setup.py 等
    keywords?: string[];
    primary_language?: string;
}
