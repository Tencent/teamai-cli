// -*- coding: utf-8 -*-
/**
 * The dual sections of an iWiki import (`--iwiki-dual`): the business API, external knowledge and glossary the AI tool
 * found in the pages, written into the managed anchors of docs/team-codebase/external-knowledge.md, or queued for
 * review. teamai-import-from-iwiki asks the tool; `write-sections` is the step that writes its answer.
 */

import path from 'node:path';
import fs from 'fs-extra';
import { z } from 'zod';

import type { IWikiDocument } from './utils/iwiki-client.js';
import { appendPendingReview } from './review-store.js';
import { log } from './utils/logger.js';

/** How much of each page the AI tool is shown. */
const MAX_CONTENT_PER_PAGE = 5000;

/** 各章节的中文标题。 */
const SECTION_TITLES = new Map<string, string>([
    ['business-api', '业务接口'],
    ['external-knowledge', '外部知识源'],
    ['glossary', '术语表'],
]);

const SECTIONS = ['business-api', 'external-knowledge', 'glossary'] as const;

/** The sections the AI extracted; one that is not text reads as absent, and a reply that is not an object as none. */
const AiSectionOutputSchema = z.object({
    'business-api': z.string().optional().catch(undefined),
    'external-knowledge': z.string().optional().catch(undefined),
    'glossary': z.string().optional().catch(undefined),
});

/** The pages as the AI tool is shown them to find the sections. */
export function buildDualContext(docs: IWikiDocument[]): string {
    return docs
        .map((d) => `=== ${d.docid} ===\n${d.content.slice(0, MAX_CONTENT_PER_PAGE)}`)
        .join('\n\n');
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
    const title = SECTION_TITLES.get(sectionKey) ?? sectionKey;
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

/** What `write-sections` is given: the AI tool's reply, or why it gave none, and where the sections go. */
export interface SectionsFlags {
    /** `iwiki://<id>`, recorded in each section's anchor. */
    source: string;
    reply: string;
    /** Why the AI tool did not answer, when it did not; the import is done, so this is said and nothing is written. */
    failure: string;
    /** The directory holding external-knowledge.md. */
    sectionsDir: string;
    /** The directory whose .teamai/pending-review.jsonl takes the sections with --require-review. */
    reviewDir: string;
    review: string;
}

/**
 * `teamai import write-sections`: writes each section the AI tool found into the managed anchors of
 * external-knowledge.md, creating it with every anchor, or with `review` queues them for `teamai review`. A
 * reply that is not the JSON asked for writes nothing.
 */
export async function writeSections(flags: SectionsFlags): Promise<Record<string, never>> {
    if (flags.failure !== '') {
        log.warn(`iWiki dual-path error (non-blocking): ${flags.failure}`);

        return {};
    }

    const requireReview = flags.review === 'true';
    let aiOutput: z.infer<typeof AiSectionOutputSchema> = {};

    try {
        aiOutput = AiSectionOutputSchema.safeParse(JSON.parse(extractJson(flags.reply))).data ?? {};
    } catch (err) {
        log.warn(`iWiki dual import: AI output is not valid JSON; skipped all sections. Error: ${String(err)}`);
        log.info('iWiki dual-path complete: sections updated []');

        return {};
    }

    const filePath = path.join(flags.sectionsDir, 'external-knowledge.md');

    if (requireReview) {
        const relativeFilePath = path.relative(flags.reviewDir, filePath);

        for (const sectionKey of SECTIONS) {
            const body = aiOutput[sectionKey] ?? '';

            if (!body) continue;
            await appendPendingReview(flags.reviewDir, {
                kind: 'codebase-section',
                target: { file: relativeFilePath, section: sectionKey },
                payload: { content: body },
                source: flags.source,
            });
        }

        log.info(`iWiki dual-path complete: sections updated [${SECTIONS.join(', ')}] (pending review)`);

        return {};
    }

    const updatedSections: string[] = [];
    const ts = new Date().toISOString();
    await fs.ensureDir(flags.sectionsDir);
    const exists = await fs.pathExists(filePath);
    let content = exists ? await fs.readFile(filePath, 'utf8') : buildSkeletonContent();

    for (const sectionKey of SECTIONS) {
        const body = aiOutput[sectionKey] ?? '';

        if (!body) {
            log.warn(`iWiki dual import: Section "${sectionKey}" is empty; skipped.`);
            continue;
        }

        content = replaceManagedSection(content, sectionKey, body, flags.source, ts);
        updatedSections.push(sectionKey);
    }

    if (updatedSections.length > 0) {
        await fs.writeFile(filePath, content, 'utf8');
    }

    log.info(`iWiki dual-path complete: sections updated [${updatedSections.join(', ')}]`);

    return {};
}
