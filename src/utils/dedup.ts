import fs from 'node:fs/promises';
import path from 'node:path';

import matter from 'gray-matter';

import { log } from './logger.js';

/** 英文停用词集合 */
const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'but', 'not', 'with',
  'from', 'by', 'as', 'this', 'that', 'it', 'he', 'she', 'we', 'they',
]);

/** CJK 停用词集合 */
const CJK_STOPWORDS = new Set(['的', '了', '是', '在', '有', '和', '与', '或', '不', '也', '都', '就', '被', '由', '从', '到', '对', '于']);

/**
 * 从文本中提取关键词。
 *
 * 提取英文单词（lowercase，去停用词）和 CJK 单字（去停用词），
 * 只保留长度 ≥ 2 的词。
 */
export function extractKeywords(text: string): Set<string> {
  const keywords = new Set<string>();

  // 提取英文单词
  const enWords = text.match(/[a-zA-Z]+/g) ?? [];
  for (const word of enWords) {
    const lower = word.toLowerCase();
    if (lower.length >= 2 && !EN_STOPWORDS.has(lower)) {
      keywords.add(lower);
    }
  }

  // 提取 CJK 字符
  const cjkChars = text.match(/[一-鿿]/g) ?? [];
  for (const char of cjkChars) {
    if (!CJK_STOPWORDS.has(char)) {
      keywords.add(char);
    }
  }

  return keywords;
}

/**
 * 计算两个关键词集合的 Jaccard 相似度。
 *
 * 返回值范围 [0, 1]，任一集合为空时返回 0。
 */
export function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let intersectionSize = 0;
  for (const word of a) {
    if (b.has(word)) {
      intersectionSize++;
    }
  }

  const unionSize = a.size + b.size - intersectionSize;
  return intersectionSize / unionSize;
}

/** 文件名日期前缀正则，格式 YYYY-MM-DD */
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/;

/**
 * 从文件名或 mtime 解析文档日期。
 *
 * 优先解析文件名前缀（YYYY-MM-DD），失败时回退到 mtime。
 */
async function resolveDocDate(filePath: string, filename: string): Promise<Date> {
  const match = DATE_PREFIX_RE.exec(filename);
  if (match) {
    const parsed = new Date(match[1]);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const stat = await fs.stat(filePath);
  return stat.mtime;
}

/**
 * 查找与草稿关键词高度重叠的已有 learning 文件。
 *
 * 扫描 learningsDir 下 withinDays 天内的 .md 文件，
 * 返回 Jaccard 相似度 ≥ 0.6 的条目，按 overlap 降序排列。
 */
export async function findSupersededLearnings(
  draftKeywords: Set<string>,
  learningsDir: string,
  withinDays: number = 14,
): Promise<Array<{ filename: string; overlap: number }>> {
  let entries: string[];

  try {
    entries = await fs.readdir(learningsDir);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const mdFiles = entries.filter((name) => name.endsWith('.md'));
  const cutoffDate = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000);
  const results: Array<{ filename: string; overlap: number }> = [];

  for (const filename of mdFiles) {
    const filePath = path.join(learningsDir, filename);

    try {
      const docDate = await resolveDocDate(filePath, filename);
      if (docDate < cutoffDate) {
        continue;
      }

      const raw = await fs.readFile(filePath, 'utf8');
      const { content: body } = matter(raw);
      const fileKeywords = extractKeywords(body);
      const ratio = overlapRatio(draftKeywords, fileKeywords);

      if (ratio >= 0.6) {
        results.push({ filename, overlap: ratio });
      }
    } catch (err: unknown) {
      log.debug(`dedup: skip ${filename} — ${(err as Error).message}`);
    }
  }

  return results.sort((x, y) => y.overlap - x.overlap);
}
