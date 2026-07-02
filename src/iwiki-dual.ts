// -*- coding: utf-8 -*-
/**
 * iWiki 双路模式：在产出 learning 之外，同时产出 codebase suggestions。
 *
 * 将内容写入 docs/team-codebase/external-knowledge.md 的章节锚点。
 * 不替换既有 importFromIWiki，是独立的补充入口。
 */

import path from 'node:path';
import fs from 'fs-extra';

import { IWikiClient } from './utils/iwiki-client.js';
import type { IWikiDocument, IWikiPage } from './utils/iwiki-client.js';
import { appendPendingReview } from './review-store.js';
import { getTeamCodebasePaths } from './utils/team-codebase-paths.js';
import { callClaude } from './utils/ai-client.js';
import { log } from './utils/logger.js';

// ─── 常量 ────────────────────────────────────────────────

/** 每页截取的最大字符数。 */
const MAX_CONTENT_PER_PAGE = 5000;

/** 并发下载页面数。 */
const DOWNLOAD_BATCH_SIZE = 5;

/** 默认拉取最大页数。 */
const DEFAULT_MAX_PAGES = 200;

/** 各章节的中文标题。 */
const SECTION_TITLES: Record<string, string> = {
    'business-api': '业务接口',
    'external-knowledge': '外部知识源',
    'glossary': '术语表',
};

// ─── 类型 ────────────────────────────────────────────────

/** 支持的章节类型。 */
export type SectionKey = 'business-api' | 'external-knowledge' | 'glossary';

/** importFromIWikiDual 的选项。 */
export interface IWikiDualOptions {
    /** Space ID / 页面 URL */
    input: string;
    /** PAT；或 TAI_PAT_TOKEN */
    token?: string;
    /** 要更新的章节列表，默认全部三章节 */
    sections?: SectionKey[];
    /** 自定义产物根（同 P5.x output） */
    output?: string;
    dryRun?: boolean;
    maxPages?: number;
    /** 默认 false；true 时不直接写盘，进 .teamai/pending-review.jsonl */
    requireReview?: boolean;
}

/** AI 抽取的三章节内容。 */
interface AiSectionOutput {
    'business-api': string;
    'external-knowledge': string;
    'glossary': string;
}

// ─── 辅助函数 ────────────────────────────────────────────

/**
 * 解析用户输入，识别 Space ID 或页面 ID（与 import-iwiki 保持一致）。
 */
function parseIWikiInput(input: string): { type: 'space' | 'page'; id: string } {
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) {
        return { type: 'space', id: trimmed };
    }
    const pageMatch = trimmed.match(/\/(?:p|pages)\/([^/?#]+)/);
    if (pageMatch) {
        return { type: 'page', id: pageMatch[1] };
    }
    throw new Error(
        `无法识别 iWiki 输入格式："${trimmed}"。请输入纯数字 Space ID 或含 /p/ 的页面 URL。`,
    );
}

/**
 * 批量并发下载文档内容（每批 DOWNLOAD_BATCH_SIZE 个）。
 */
async function downloadDocuments(
    client: IWikiClient,
    pages: IWikiPage[],
): Promise<IWikiDocument[]> {
    const documents: IWikiDocument[] = [];
    for (let i = 0; i < pages.length; i += DOWNLOAD_BATCH_SIZE) {
        const batch = pages.slice(i, i + DOWNLOAD_BATCH_SIZE);
        const results = await Promise.allSettled(
            batch.map((page) => client.getDocument(page.docid)),
        );
        for (const result of results) {
            if (result.status === 'fulfilled') {
                documents.push(result.value);
            } else {
                log.warn(`下载文档失败，已跳过: ${String(result.reason)}`);
            }
        }
    }
    return documents;
}

/**
 * 构建 AI 抽取 prompt。
 */
function buildExtractionPrompt(docs: IWikiDocument[]): string {
    const content = docs
        .map((d) => `=== ${d.docid} ===\n${d.content.slice(0, MAX_CONTENT_PER_PAGE)}`)
        .join('\n\n');

    return `你是团队知识整理专家，请从以下 iWiki 文档中抽取三类知识，以 JSON 格式输出。

## 文档内容

${content}

## 输出要求

请严格输出以下 JSON 格式，三个字段都是可直接嵌入 Markdown 的内容：

{
  "business-api": "<关于内部业务 API/接口规范的 Markdown 摘要，无相关内容则为空字符串>",
  "external-knowledge": "<关于外部系统/第三方知识源的 Markdown 摘要，无相关内容则为空字符串>",
  "glossary": "<项目术语表 Markdown（| 术语 | 说明 | 格式），无相关内容则为空字符串>"
}

不要输出 JSON 以外的任何内容。`;
}

/**
 * 从 AI 输出文本中提取 JSON。
 */
function extractJson(text: string): string {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        return fenceMatch[1].trim();
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        return text.slice(start, end + 1);
    }
    return text.trim();
}

/**
 * 在文件内容中替换某章节的 managed 锚点区间。
 *
 * 锚点格式：
 *   ## <章节标题>
 *   <!-- managed-by: import --from-iwiki, section: <key>, source: <source>, syncedAt: <ts> -->
 *   <body>
 *   <!-- /managed-by: <key> -->
 *
 * @param content    文件当前内容
 * @param sectionKey 章节标识符
 * @param newBody    新内容（Markdown）
 * @param source     数据来源标识（iwiki://<id>）
 * @param ts         同步时间戳（ISO）
 */
function replaceManagedSection(
    content: string,
    sectionKey: string,
    newBody: string,
    source: string,
    ts: string,
): string {
    const openTag =
        `<!-- managed-by: import --from-iwiki, section: ${sectionKey}, ` +
        `source: ${source}, syncedAt: ${ts} -->`;
    const closeTag = `<!-- /managed-by: ${sectionKey} -->`;

    const openRegex = new RegExp(
        `<!--\\s*managed-by:\\s*import\\s*--from-iwiki,[^>]*section:\\s*${sectionKey}[^>]*-->`,
        'g',
    );
    const closeRegex = new RegExp(`<!--\\s*/managed-by:\\s*${sectionKey}\\s*-->`, 'g');

    const openIdx = content.search(openRegex);
    const closeIdx = content.search(closeRegex);

    if (openIdx !== -1 && closeIdx !== -1 && closeIdx > openIdx) {
        // 替换 open tag 到 close tag 之间（含两个 tag）
        const before = content.slice(0, openIdx);
        const after = content.slice(closeIdx + `<!-- /managed-by: ${sectionKey} -->`.length);
        return `${before}${openTag}\n${newBody}\n${closeTag}${after}`;
    }

    // 找到对应章节标题并追加
    const title = SECTION_TITLES[sectionKey] ?? sectionKey;
    const headingRegex = new RegExp(`(##\\s+${title}\\s*\\n)`, 'm');
    const headingMatch = content.match(headingRegex);
    if (headingMatch?.index !== undefined) {
        const insertPos = headingMatch.index + headingMatch[0].length;
        const before = content.slice(0, insertPos);
        const after = content.slice(insertPos);
        const block = `${openTag}\n${newBody}\n${closeTag}\n`;
        return `${before}${block}${after}`;
    }

    // 找不到标题则在末尾追加整个章节
    const block =
        `\n## ${title}\n${openTag}\n${newBody}\n${closeTag}\n`;
    return content + block;
}

/**
 * 生成初始骨架文件（三个空章节）。
 */
function buildSkeletonContent(): string {
    return `# 外部知识源

本文档由 \`teamai import --from-iwiki --iwiki-dual\` 自动维护。

## 业务接口

<!-- managed-by: import --from-iwiki, section: business-api, source: (pending), syncedAt: (pending) -->

<!-- /managed-by: business-api -->

## 外部知识源

<!-- managed-by: import --from-iwiki, section: external-knowledge, source: (pending), syncedAt: (pending) -->

<!-- /managed-by: external-knowledge -->

## 术语表

<!-- managed-by: import --from-iwiki, section: glossary, source: (pending), syncedAt: (pending) -->

<!-- /managed-by: glossary -->
`;
}

// ─── 主入口 ──────────────────────────────────────────────

/**
 * 从 iWiki 拉取文档，AI 抽取业务接口/外部知识源/术语表三类内容，
 * 写入 docs/team-codebase/external-knowledge.md 的对应章节锚点。
 *
 * @param opts 双路导入选项
 * @returns    更新的章节列表 + 是否进入 pending-review
 */
export async function importFromIWikiDual(opts: IWikiDualOptions): Promise<{
    sectionsUpdated: string[];
    pendingReview: boolean;
}> {
    const cwd = process.cwd();
    const sections: SectionKey[] = opts.sections ?? ['business-api', 'external-knowledge', 'glossary'];

    // 1. 读取 token
    const token = opts.token ?? process.env['TAI_PAT_TOKEN'];
    if (!token) {
        throw new Error(
            '请设置 TAI_PAT_TOKEN 环境变量（获取地址：https://tai.it.woa.com/user/pat）',
        );
    }

    // 2. 解析输入
    const { type, id } = parseIWikiInput(opts.input);
    const source = `iwiki://${id}`;

    // 3. 创建客户端
    const client = new IWikiClient(token);

    // 4. 获取页面列表
    let pages: IWikiPage[];
    if (type === 'page') {
        pages = [{ docid: id, title: id }];
    } else {
        pages = await client.fetchAllPages(id, { maxPages: opts.maxPages ?? DEFAULT_MAX_PAGES });
    }

    if (pages.length === 0) {
        log.warn('iWiki 双路：未找到任何页面');
        return { sectionsUpdated: [], pendingReview: false };
    }

    // 5. 下载文档内容
    const documents = await downloadDocuments(client, pages);

    if (documents.length === 0) {
        log.warn('iWiki 双路：所有文档下载失败');
        return { sectionsUpdated: [], pendingReview: false };
    }

    // 6. AI 抽取
    const prompt = buildExtractionPrompt(documents);
    const rawOutput = await callClaude(prompt);
    const jsonStr = extractJson(rawOutput);

    let aiOutput: Partial<AiSectionOutput> = {};
    try {
        aiOutput = JSON.parse(jsonStr) as Partial<AiSectionOutput>;
    } catch (err) {
        log.warn(`iWiki 双路：AI 输出非 JSON，跳过全部章节。错误：${String(err)}`);
        return { sectionsUpdated: [], pendingReview: false };
    }

    // 7. 确定 external-knowledge.md 路径
    const paths = getTeamCodebasePaths(cwd, opts.output);
    const filePath = path.join(paths.root, 'external-knowledge.md');

    // 8. 若启用 requireReview，写到 pending-review.jsonl
    if (opts.requireReview) {
        if (!opts.dryRun) {
            const relativeFilePath = path.relative(cwd, filePath);
            for (const sectionKey of sections) {
                const body = aiOutput[sectionKey] ?? '';
                if (!body) continue;
                await appendPendingReview(cwd, {
                    kind: 'codebase-section',
                    target: { file: relativeFilePath, section: sectionKey },
                    payload: { content: body },
                    source,
                });
            }
        }
        return { sectionsUpdated: sections, pendingReview: true };
    }

    // 9. 写入 external-knowledge.md
    const updatedSections: string[] = [];
    const ts = new Date().toISOString();

    if (!opts.dryRun) {
        await fs.ensureDir(paths.root);

        // 首次创建时写骨架
        const exists = await fs.pathExists(filePath);
        let content = exists ? await fs.readFile(filePath, 'utf8') : buildSkeletonContent();

        for (const sectionKey of sections) {
            const body = aiOutput[sectionKey] ?? '';
            if (!body) {
                log.warn(`iWiki 双路：章节 "${sectionKey}" 内容为空，跳过`);
                continue;
            }
            content = replaceManagedSection(content, sectionKey, body, source, ts);
            updatedSections.push(sectionKey);
        }

        if (updatedSections.length > 0) {
            await fs.writeFile(filePath, content, 'utf8');
        }
    } else {
        for (const sectionKey of sections) {
            if (aiOutput[sectionKey]) {
                updatedSections.push(sectionKey);
            }
        }
        log.info(`[dry-run] 将更新章节：${updatedSections.join(', ')}`);
    }

    return { sectionsUpdated: updatedSections, pendingReview: false };
}
