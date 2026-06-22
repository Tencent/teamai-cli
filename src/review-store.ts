// -*- coding: utf-8 -*-
/**
 * Pending-review 存储层：读写 .teamai/pending-review.jsonl。
 *
 * 负责新 schema 的增删改查，以及将旧条目（iwiki-dual.ts 写出格式）归一化为新 schema。
 */

import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { log } from './utils/logger.js';

// ─── 类型 ────────────────────────────────────────────────

export type Risk = 'high' | 'medium' | 'low';

export interface PendingReviewItem {
    id: string;
    ts: string;
    kind: 'codebase-section' | 'domain-drift' | 'multi-source-conflict';
    target: { file: string; section?: string };
    payload: Record<string, unknown>;
    source: string;
    risk: Risk;
}

// ─── 常量 ────────────────────────────────────────────────

export const PENDING_REVIEW_PATH = '.teamai/pending-review.jsonl';

/** 高风险章节名称集合。 */
const HIGH_RISK_SECTIONS = new Set([
    '架构决策与权衡', '架构', 'architecture',
    '目录结构与模块职责', '模块依赖', 'modules', 'dependencies',
    'external-knowledge', '外部知识源',
]);
/** 反序列化大小上限：10 MB，防止超大文件导致 OOM。 */
const MAX_CONFIG_FILE_BYTES = 10 * 1024 * 1024;

// ─── 工具函数 ────────────────────────────────────────────

/**
 * 获取 pending-review.jsonl 的绝对路径。
 */
export function getPendingReviewPath(cwd: string): string {
    return path.join(cwd, PENDING_REVIEW_PATH);
}

/**
 * 计算条目 ID：sha1(file|section|ts) 取前 12 位十六进制。
 */
export function computeReviewId(
    file: string,
    section: string | undefined,
    ts: string,
): string {
    return crypto
        .createHash('sha1')
        .update(`${file}|${section ?? ''}|${ts}`)
        .digest('hex')
        .slice(0, 12);
}

/**
 * 推断风险等级。
 *
 * 高风险章节或含 external-knowledge 路径 → high；其余 → medium。
 */
export function inferRisk(target: { file: string; section?: string }): Risk {
    if (target.section && HIGH_RISK_SECTIONS.has(target.section)) return 'high';
    if (target.file.includes('external-knowledge')) return 'high';
    return 'medium';
}

// ─── 旧 schema 归一化 ────────────────────────────────────

interface LegacyRecord {
    ts?: string;
    type?: string;
    file?: string;
    section?: string;
    source?: string;
    content?: string;
    [key: string]: unknown;
}

/**
 * 将旧格式条目归一化为新 schema。
 * 若条目已是新 schema（含 kind 字段），直接返回。
 */
function normalizeItem(raw: Record<string, unknown>): PendingReviewItem | null {
    const legacy = raw as LegacyRecord;

    // 新 schema 判断：含 kind 字段
    if (typeof raw['kind'] === 'string') {
        const item = raw as Partial<PendingReviewItem>;
        const file = item.target?.file ?? '';
        const section = item.target?.section;
        const ts = item.ts ?? new Date().toISOString();
        return {
            id: item.id ?? computeReviewId(file, section, ts),
            ts,
            kind: item.kind ?? 'codebase-section',
            target: { file, section },
            payload: item.payload ?? {},
            source: item.source ?? '',
            risk: item.risk ?? inferRisk({ file, section }),
        };
    }

    // 旧 schema：type / file / section / content
    if (legacy.type === 'codebase-section' || legacy.file !== undefined) {
        const file = legacy.file ?? '';
        const section = legacy.section;
        const ts = legacy.ts ?? new Date().toISOString();
        return {
            id: computeReviewId(file, section, ts),
            ts,
            kind: 'codebase-section',
            target: { file, section },
            payload: legacy.content !== undefined ? { content: legacy.content } : {},
            source: legacy.source ?? '',
            risk: inferRisk({ file, section }),
        };
    }

    return null;
}

// ─── 核心 API ────────────────────────────────────────────

/**
 * 读取 jsonl 全部条目，归一化旧 schema 到新 schema。
 *
 * 文件不存在 → 返回空数组（不抛错）。
 * 行解析失败 → 跳过该行并 log.debug。
 */
export async function loadPendingReview(cwd: string): Promise<PendingReviewItem[]> {
    const filePath = getPendingReviewPath(cwd);
    if (!await fs.pathExists(filePath)) {
        return [];
    }

    const stat = await fs.stat(filePath);
    if (stat.size > MAX_CONFIG_FILE_BYTES) {
        throw new Error(`${filePath} exceeds max allowed size 10MB`);
    }

    const text = await fs.readFile(filePath, 'utf8');
    const items: PendingReviewItem[] = [];

    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch (err) {
            log.debug(`[review-store] 跳过损坏行: ${trimmed.slice(0, 80)} — ${String(err)}`);
            continue;
        }

        const normalized = normalizeItem(parsed);
        if (normalized) {
            items.push(normalized);
        } else {
            log.debug(`[review-store] 跳过无法识别的条目: ${trimmed.slice(0, 80)}`);
        }
    }

    return items;
}

/**
 * 覆盖式写入整个 jsonl（每行一个 JSON）。原子性：先写 .tmp 再 rename。
 */
export async function savePendingReview(cwd: string, items: PendingReviewItem[]): Promise<void> {
    const filePath = getPendingReviewPath(cwd);
    const tmpPath = `${filePath}.tmp`;

    await fs.ensureDir(path.dirname(filePath));
    const content = items.map((item) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : '');
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, filePath);
}

/**
 * 追加单个条目到 jsonl 末尾（不读全量；高效）。
 *
 * 输入若缺 id 自动计算；缺 ts 自动填 now；缺 risk 自动推断。
 *
 * @returns 实际落盘的 PendingReviewItem
 */
export async function appendPendingReview(
    cwd: string,
    partial: Omit<PendingReviewItem, 'id' | 'ts' | 'risk'> & {
        id?: string;
        ts?: string;
        risk?: Risk;
    },
): Promise<PendingReviewItem> {
    const ts = partial.ts ?? new Date().toISOString();
    const { file, section } = partial.target;
    const id = partial.id ?? computeReviewId(file, section, ts);
    const risk = partial.risk ?? inferRisk(partial.target);

    const item: PendingReviewItem = {
        id,
        ts,
        kind: partial.kind,
        target: partial.target,
        payload: partial.payload,
        source: partial.source,
        risk,
    };

    const filePath = getPendingReviewPath(cwd);
    await fs.ensureDir(path.dirname(filePath));
    await fs.appendFile(filePath, JSON.stringify(item) + '\n', 'utf8');

    return item;
}

/**
 * 按 id 移除条目。返回是否真的移除。
 */
export async function removePendingReview(cwd: string, id: string): Promise<boolean> {
    const items = await loadPendingReview(cwd);
    const filtered = items.filter((item) => item.id !== id);

    if (filtered.length === items.length) {
        return false;
    }

    await savePendingReview(cwd, filtered);
    return true;
}
