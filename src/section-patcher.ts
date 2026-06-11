import crypto from 'node:crypto';

// ─── Types ──────────────────────────────────────────────

export interface ManagedSection {
    /** 切片 slug（来自标题，唯一） */
    slug: string;
    /** 章节标题（不含 ## 前缀） */
    title: string;
    /** body 内容（不含开闭锚点、不含 ## 标题行；保留前后空行） */
    body: string;
    /** body 的 sha1（hex 前 16 位） */
    bodyHash: string;
    /** 写入时的 source 字段 */
    source?: string;
    /** 写入时的 syncedAt 字段 */
    syncedAt?: string;
}

// ─── Internal helpers ───────────────────────────────────

/**
 * 从标题文本生成 slug：去空格（用 -）、替换路径分隔符，保留中文。
 * 重复 slug 在调用处处理（加 -2 / -3 后缀）。
 */
function slugify(title: string): string {
    return title.trim().replace(/\s+/g, '-').replace(/[\/\\:]/g, '_');
}

/**
 * 解析并去除 frontmatter（首部 `---...---` 块）。
 * 返回 { frontmatter: 原始 frontmatter 文本含首尾 ---，rest: 剩余内容 }。
 * 若不存在，frontmatter 为空字符串。
 */
function extractFrontmatter(md: string): { frontmatter: string; rest: string } {
    if (!md.startsWith('---')) {
        return { frontmatter: '', rest: md };
    }
    const endIdx = md.indexOf('\n---', 3);
    if (endIdx === -1) {
        return { frontmatter: '', rest: md };
    }
    const fmEnd = endIdx + 4; // past '\n---'
    // 可能后面还有 \n
    const afterFm = md[fmEnd] === '\n' ? fmEnd + 1 : fmEnd;
    return {
        frontmatter: md.slice(0, afterFm),
        rest: md.slice(afterFm),
    };
}

// ─── Public API ─────────────────────────────────────────

/**
 * body 的 sha1 hex 前 16 位。
 *
 * 归一化：去掉前后空行，行末 trailing whitespace 统一。
 */
export function hashBody(body: string): string {
    const normalized = body
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .trim();
    return crypto.createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 把整篇 markdown 按 `^## ` 二级标题切分为章节。
 *
 * 行为：
 *   - frontmatter 区段（首部 `---...---`）保留作为返回的 `prelude` 字段
 *   - 第一个 `## ` 之前但 frontmatter 之后的内容也归入 prelude
 *   - 每个 `## 标题` 至下一个 `## ` 之间为一个 section（不含开闭锚点）
 *   - 标题行被剥离，仅 title 字段保留
 *   - slug 重复时第二个加 -2 后缀，第三个 -3，依此类推
 *
 * @returns { prelude, sections } 顺序保留
 */
export function splitToSections(md: string): { prelude: string; sections: ManagedSection[] } {
    const { frontmatter, rest } = extractFrontmatter(md);

    const lines = rest.split('\n');
    const sections: ManagedSection[] = [];
    const slugCounts: Map<string, number> = new Map();

    // 找出所有 ## 标题的行号
    const headerIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (/^## /.test(lines[i])) {
            headerIndices.push(i);
        }
    }

    if (headerIndices.length === 0) {
        return { prelude: frontmatter + rest, sections: [] };
    }

    // prelude = frontmatter + 第一个 ## 前的内容
    const preludeRest = lines.slice(0, headerIndices[0]).join('\n');
    const prelude = frontmatter + preludeRest;

    for (let hi = 0; hi < headerIndices.length; hi++) {
        const headerLineIdx = headerIndices[hi];
        const title = lines[headerLineIdx].replace(/^## /, '').trim();

        const bodyStartIdx = headerLineIdx + 1;
        const bodyEndIdx = hi + 1 < headerIndices.length ? headerIndices[hi + 1] : lines.length;
        const bodyLines = lines.slice(bodyStartIdx, bodyEndIdx);
        // 去掉末尾的空行（章节间间距由 joinSections 控制）
        while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
            bodyLines.pop();
        }
        const body = bodyLines.join('\n');

        const baseSlug = slugify(title);
        const count = slugCounts.get(baseSlug) ?? 0;
        slugCounts.set(baseSlug, count + 1);
        const slug = count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;

        sections.push({
            slug,
            title,
            body,
            bodyHash: hashBody(body),
        });
    }

    return { prelude, sections };
}

/**
 * 把 sections 重新组装为完整 markdown，每个 section 加上开闭 HTML 锚点。
 *
 * 输出形如：
 *   <prelude>
 *   <!-- managed-by: import --from-repo, section: <slug>, source: ..., syncedAt: ... -->
 *   ## <title>
 *   <body>
 *   <!-- /managed-by: <slug> -->
 *
 *   <!-- ... 下一个 section ... -->
 */
export function joinSections(prelude: string, sections: ManagedSection[]): string {
    if (sections.length === 0) {
        return prelude;
    }

    // 规范化 prelude：去掉尾部所有换行，统一加一个 \n，再加一个 \n 作为与首章节的间隔
    const preludeNorm = prelude.replace(/\n+$/, '') + '\n';

    const sectionStrs = sections.map((section) => {
        const metaParts = ['managed-by: import --from-repo', `section: ${section.slug}`];
        if (section.source) {
            metaParts.push(`source: ${section.source}`);
        }
        if (section.syncedAt) {
            metaParts.push(`syncedAt: ${section.syncedAt}`);
        }
        const openAnchor = `<!-- ${metaParts.join(', ')} -->`;
        const closeAnchor = `<!-- /managed-by: ${section.slug} -->`;
        return `${openAnchor}\n## ${section.title}\n${section.body}\n${closeAnchor}`;
    });

    return preludeNorm + '\n' + sectionStrs.join('\n\n') + '\n';
}

/**
 * 从一份**已有锚点**的 markdown 中读取所有 ManagedSection（带 source / syncedAt）。
 *
 * 行为：
 *   - 严格匹配开锚 `<!-- managed-by:[^>]+section:\s*([^,>\s]+)[^>]*-->`
 *   - 严格匹配闭锚 `<!-- /managed-by:\s*([^>\s]+)\s*-->`
 *   - 未配对的开锚 → 整个文档抛 Error('unclosed anchor: <slug>')
 *   - 不存在任何锚点 → 返回 { prelude: 整篇, sections: [] }
 */
export function parseSections(md: string): { prelude: string; sections: ManagedSection[] } {
    // 同时接受 --from-repo 和 --from-iwiki 来源（保持写入侧锚点不变，解析侧放宽）。
    // [^>\n]{0,256}? 限制字符种类（不含换行）与长度上限（256），防止恶意输入触发 ReDoS 回溯。
    const openRe = /<!--\s*managed-by:\s*import\s+--from-(?:repo|iwiki),\s*section:\s*([^,>\s]+)([^>\n]{0,256}?)-->/g;
    const closeRe = /<!--\s*\/managed-by:\s*([^>\n\s]{0,256}?)\s*-->/g;

    // 收集所有开锚
    const opens: Array<{ slug: string; extra: string; index: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(md)) !== null) {
        opens.push({ slug: m[1], extra: m[2], index: m.index, end: m.index + m[0].length });
    }

    if (opens.length === 0) {
        return { prelude: md, sections: [] };
    }

    // 收集所有闭锚
    const closes: Array<{ slug: string; index: number; end: number }> = [];
    while ((m = closeRe.exec(md)) !== null) {
        closes.push({ slug: m[1], index: m.index, end: m.index + m[0].length });
    }

    // 按 slug 配对（顺序匹配）
    const sections: ManagedSection[] = [];
    const closeUsed = new Set<number>();

    for (const open of opens) {
        const closeIdx = closes.findIndex((c, i) => c.slug === open.slug && !closeUsed.has(i) && c.index > open.end);
        if (closeIdx === -1) {
            throw new Error(`unclosed anchor: ${open.slug}`);
        }
        closeUsed.add(closeIdx);
        const close = closes[closeIdx];

        // 提取 body（开锚 end 到闭锚 start 之间）
        let inner = md.slice(open.end, close.index);
        // 首行可能是 \n## title\n...
        const innerLines = inner.split('\n');
        // 跳过可能的空行后取标题
        let titleLine = '';
        let bodyStartLine = 0;
        for (let i = 0; i < innerLines.length; i++) {
            if (innerLines[i].trim() === '') {
                continue;
            }
            if (/^## /.test(innerLines[i])) {
                titleLine = innerLines[i].replace(/^## /, '').trim();
                bodyStartLine = i + 1;
            }
            break;
        }
        const bodyLines = innerLines.slice(bodyStartLine);
        // 去末尾空行
        while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
            bodyLines.pop();
        }
        const body = bodyLines.join('\n');

        // 解析 extra 里的 source / syncedAt
        let source: string | undefined;
        let syncedAt: string | undefined;
        const srcMatch = open.extra.match(/source:\s*([^,>]+)/);
        if (srcMatch) {
            source = srcMatch[1].trim();
        }
        const syncMatch = open.extra.match(/syncedAt:\s*([^,>]+)/);
        if (syncMatch) {
            syncedAt = syncMatch[1].trim();
        }

        sections.push({
            slug: open.slug,
            title: titleLine,
            body,
            bodyHash: hashBody(body),
            source,
            syncedAt,
        });
    }

    // prelude = 第一个开锚之前的内容
    const firstOpenIdx = opens[0].index;
    const prelude = md.slice(0, firstOpenIdx);

    return { prelude, sections };
}

/**
 * 单章节原地替换：在 md 中找到 slug 对应的开闭锚点对，
 * 用 newBody / newSource / newSyncedAt 替换 body 与元数据，标题不变。
 *
 * 找不到 slug 时抛 Error('section not found: <slug>')。
 */
export function patchManagedSection(
    md: string,
    slug: string,
    newBody: string,
    meta: { source?: string; syncedAt?: string },
): string {
    // 同时接受 --from-repo 和 --from-iwiki 来源（写入侧锚点保持原样，解析侧放宽匹配）。
    // [^>\n]{0,256}? 限制字符种类与长度上限，防止 ReDoS 回溯。
    const fromVariants = '--from-(?:repo|iwiki)';
    const openRe = new RegExp(
        `<!--\\s*managed-by:\\s*import\\s+${fromVariants},\\s*section:\\s*${escapeRegex(slug)}([^>\\n]{0,256}?)-->`,
    );
    const closeRe = new RegExp(`<!--\\s*/managed-by:\\s*${escapeRegex(slug)}[^>\\n]{0,256}?\\s*-->`);

    const openMatch = openRe.exec(md);
    if (!openMatch) {
        throw new Error(`section not found: ${slug}`);
    }

    const openStart = openMatch.index;
    const openEnd = openStart + openMatch[0].length;

    const afterOpen = md.slice(openEnd);
    const closeMatch = closeRe.exec(afterOpen);
    if (!closeMatch) {
        throw new Error(`section not found: ${slug}`);
    }

    const closeStart = openEnd + closeMatch.index;
    const closeEnd = closeStart + closeMatch[0].length;

    // 从旧开锚中提取标题
    const oldInner = md.slice(openEnd, closeStart);
    let title = '';
    for (const line of oldInner.split('\n')) {
        if (/^## /.test(line)) {
            title = line.replace(/^## /, '').trim();
            break;
        }
    }

    // 构建新开锚
    const metaParts = ['managed-by: import --from-repo', `section: ${slug}`];
    if (meta.source) metaParts.push(`source: ${meta.source}`);
    if (meta.syncedAt) metaParts.push(`syncedAt: ${meta.syncedAt}`);
    const newOpen = `<!-- ${metaParts.join(', ')} -->`;
    const newClose = `<!-- /managed-by: ${slug} -->`;
    const newInner = `\n## ${title}\n${newBody}\n`;

    return md.slice(0, openStart) + newOpen + newInner + newClose + md.slice(closeEnd);
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 三路合并：
 *   - oldFile：当前盘上文件（可能含旧锚点，也可能旧版本无锚点）
 *   - freshMd：generateCodebaseMd 刚产出的整篇（无锚点）
 *   - meta：本轮的 source / syncedAt
 *
 * 返回：
 *   - mergedMd：合并后的整篇（带锚点）
 *   - changedSlugs：本轮 body hash 改变的 slug 列表
 *   - keptSlugs：body 完全相同、保留旧 syncedAt 的 slug 列表
 *   - addedSlugs：fresh 中有、old 中没有的 slug
 *   - removedSlugs：old 中有、fresh 中没有的 slug
 */
export function mergeWithAnchors(
    oldFile: string | null,
    freshMd: string,
    meta: { source: string; syncedAt: string },
): {
    mergedMd: string;
    changedSlugs: string[];
    keptSlugs: string[];
    addedSlugs: string[];
    removedSlugs: string[];
} {
    const { prelude: freshPrelude, sections: freshSections } = splitToSections(freshMd);

    // 首次写入
    if (oldFile === null) {
        const allSections = freshSections.map((s) => ({
            ...s,
            source: meta.source,
            syncedAt: meta.syncedAt,
        }));
        return {
            mergedMd: joinSections(freshPrelude, allSections),
            changedSlugs: [],
            keptSlugs: [],
            addedSlugs: allSections.map((s) => s.slug),
            removedSlugs: [],
        };
    }

    // 解析旧文件
    let oldPrelude: string;
    let oldSections: ManagedSection[];
    try {
        const parsed = parseSections(oldFile);
        oldPrelude = parsed.prelude;
        oldSections = parsed.sections;
    } catch (err) {
        // 解析失败（如未闭合锚点）：重新抛出，由调用方（import-repo）决定是否备份后 fallback
        throw err;
    }

    // 无旧锚点：视为首次写入
    if (oldSections.length === 0) {
        const allSections = freshSections.map((s) => ({
            ...s,
            source: meta.source,
            syncedAt: meta.syncedAt,
        }));
        return {
            mergedMd: joinSections(freshPrelude, allSections),
            changedSlugs: [],
            keptSlugs: [],
            addedSlugs: allSections.map((s) => s.slug),
            removedSlugs: [],
        };
    }

    const oldBySlug = new Map(oldSections.map((s) => [s.slug, s]));
    const freshBySlug = new Map(freshSections.map((s) => [s.slug, s]));

    const changedSlugs: string[] = [];
    const keptSlugs: string[] = [];
    const addedSlugs: string[] = [];
    const removedSlugs: string[] = [];

    // 按 fresh 顺序构建合并后 sections
    const mergedSections: ManagedSection[] = [];
    for (const freshSection of freshSections) {
        const old = oldBySlug.get(freshSection.slug);
        if (old) {
            if (old.bodyHash === freshSection.bodyHash) {
                // 保留旧 syncedAt + source
                keptSlugs.push(freshSection.slug);
                mergedSections.push({ ...freshSection, source: old.source, syncedAt: old.syncedAt });
            } else {
                // 内容变了
                changedSlugs.push(freshSection.slug);
                mergedSections.push({ ...freshSection, source: meta.source, syncedAt: meta.syncedAt });
            }
        } else {
            // 新章节
            addedSlugs.push(freshSection.slug);
            mergedSections.push({ ...freshSection, source: meta.source, syncedAt: meta.syncedAt });
        }
    }

    // 统计被删除的章节
    for (const oldSection of oldSections) {
        if (!freshBySlug.has(oldSection.slug)) {
            removedSlugs.push(oldSection.slug);
        }
    }

    // 若全部 kept（无 added/removed/changed），保留旧 frontmatter 避免 lastUpdated 变化
    let finalPrelude = freshPrelude;
    if (changedSlugs.length === 0 && addedSlugs.length === 0 && removedSlugs.length === 0) {
        finalPrelude = oldPrelude;
    }

    return {
        mergedMd: joinSections(finalPrelude, mergedSections),
        changedSlugs,
        keptSlugs,
        addedSlugs,
        removedSlugs,
    };
}
