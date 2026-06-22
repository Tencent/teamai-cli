// -*- coding: utf-8 -*-
/**
 * 多源冲突检测工具。
 *
 * 在更新 codebase 章节前记录"本轮被哪些源更新"，
 * 同一文件 + 同一章节在同一日内被多源更新时标记 conflict。
 *
 * 状态文件：.teamai/source-marks.jsonl
 */

import path from 'node:path';
import fs from 'fs-extra';

// ─── 类型 ────────────────────────────────────────────────

/** 数据来源标记。 */
export interface SourceMark {
    source: 'iwiki' | 'mr' | 'repo' | 'manual';
    /** iwiki page id / MR url / repo url */
    sourceId: string;
    /** ISO 时间 */
    syncedAt: string;
}

/** source-marks.jsonl 中一条记录。 */
interface SourceMarkRecord {
    file: string;
    section: string;
    mark: SourceMark;
}

// ─── 常量 ────────────────────────────────────────────────

const SOURCE_MARKS_FILE = '.teamai/source-marks.jsonl';

/** 冲突检测窗口（24 小时，毫秒）。 */
const CONFLICT_WINDOW_MS = 24 * 60 * 60 * 1000;

// ─── 辅助函数 ────────────────────────────────────────────

/**
 * 读取 source-marks.jsonl，过滤损坏行。
 */
async function readMarks(cwd: string): Promise<SourceMarkRecord[]> {
    const filePath = path.join(cwd, SOURCE_MARKS_FILE);
    const exists = await fs.pathExists(filePath);
    if (!exists) {
        return [];
    }

    const content = await fs.readFile(filePath, 'utf8');
    const records: SourceMarkRecord[] = [];

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            records.push(JSON.parse(trimmed) as SourceMarkRecord);
        } catch {
            // 损坏行跳过
        }
    }

    return records;
}

// ─── 主入口 ──────────────────────────────────────────────

/**
 * 记录本轮 codebase 章节更新来源，检测是否与近 24 小时内其他来源冲突。
 *
 * @param cwd     工作目录
 * @param file    被更新的文件绝对路径
 * @param section 被更新的章节标识符
 * @param mark    本轮来源信息
 * @returns       { conflict, previousSources }
 */
export async function recordSourceUpdate(
    cwd: string,
    file: string,
    section: string,
    mark: SourceMark,
): Promise<{ conflict: boolean; previousSources: SourceMark[] }> {
    const now = new Date(mark.syncedAt).getTime();
    const windowStart = now - CONFLICT_WINDOW_MS;

    const allRecords = await readMarks(cwd);

    // 找近 24 小时内同 file + section 的记录
    const recentRecords = allRecords.filter((r) => {
        if (r.file !== file || r.section !== section) return false;
        const ts = new Date(r.mark.syncedAt).getTime();
        return ts >= windowStart && ts <= now;
    });

    // 不同 source 且不同 sourceId → 冲突
    const conflictRecords = recentRecords.filter(
        (r) => r.mark.source !== mark.source || r.mark.sourceId !== mark.sourceId,
    );

    const conflict = conflictRecords.length > 0;
    const previousSources = conflictRecords.map((r) => r.mark);

    // 追加本次记录
    const newRecord: SourceMarkRecord = { file, section, mark };
    const filePath = path.join(cwd, SOURCE_MARKS_FILE);
    await fs.ensureDir(path.dirname(filePath));
    await fs.appendFile(filePath, JSON.stringify(newRecord) + '\n', 'utf8');

    return { conflict, previousSources };
}
