// -*- coding: utf-8 -*-
/**
 * 共用 tokenizer — 确保 search-index 和 code-knowledge-recall 使用相同的分词逻辑。
 *
 * 特性：
 * - Intl.Segmenter word-boundary 分词（支持中英混合）
 * - camelCase/PascalCase 额外拆分（getUserById 额外产生 get, user, by, id）
 * - CJK bigram 分词，仅拼接相邻单字段（"排"+"查" → "排查"）；
 *   不跨多字词边界，避免 "推理"+"服务" 产生无意义的 "理服"
 * - 全小写
 * - 去重
 *
 * ## 修改分词逻辑时：只减 token 安全，增 token 需要 bump 索引版本
 *
 * 索引存的是 tokenize 的产物，query 侧用的是当前的 tokenize。若新逻辑只是
 * **不再产生**某些 token（如移除跨词边界的 "理服"），旧索引里的多余成员是惰性
 * 死重：匹配方向是 `entryTokens.has(queryToken)`，query 侧不再产生它就永不命中；
 * df 按 token 独立计数，多余 token 自成 key，不影响真实 token 的 IDF。因此无需
 * 强制 rebuild。
 *
 * 反之，若新逻辑**开始产生**新 token，旧索引里没有它，召回会静默失效 —— 这时
 * 必须 bump `SEARCH_INDEX_VERSION`，让 `isLegacyIndex` 触发全量重建。
 */
export const MAX_TOKENIZE_CHARS = 50_000;

const sharedSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

export function tokenize(text: string): string[] {
  if (!text) return [];

  const input = text.length > MAX_TOKENIZE_CHARS ? text.slice(0, MAX_TOKENIZE_CHARS) : text;
  const segmenter = sharedSegmenter;
  const tokens: string[] = [];

  // Accumulate runs of single-CJK-character segments. Segmenter sometimes fails
  // to join a real word ("排查" → "排"|"查"); bigrams recover it. Runs are broken
  // by any multi-char word, so "推理"+"服务" never mints a phantom "理服".
  let cjkRun: string[] = [];

  const flushCjkRun = (): void => {
    if (cjkRun.length >= 2) {
      for (let i = 0; i < cjkRun.length - 1; i++) {
        tokens.push(cjkRun[i] + cjkRun[i + 1]);
      }
    }
    cjkRun = [];
  };

  for (const seg of segmenter.segment(input)) {
    if (!seg.isWordLike) {
      flushCjkRun();
      continue;
    }

    const word = seg.segment.toLowerCase();
    tokens.push(word);

    // camelCase/PascalCase split: add sub-tokens for compound identifiers.
    // e.g. "ModuleNotFoundError" → also add "module", "not", "found", "error".
    // Original lowercased word is kept above to preserve whole-word matching.
    if (/[A-Z]/.test(seg.segment)) {
      const split = seg.segment
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2);
      for (const t of split) {
        if (t !== word) tokens.push(t);
      }
    }

    // Only single-char CJK segments feed the bigram run; anything else ends it.
    if (word.length === 1 && /[一-鿿]/.test(word)) {
      cjkRun.push(word);
    } else {
      flushCjkRun();
    }
  }
  flushCjkRun();

  return [...new Set(tokens)];
}

/** Non-deduplicated word-like token count (for BM25 document length). */
export function tokenCount(text: string): number {
  if (!text) return 0;
  const input = text.length > MAX_TOKENIZE_CHARS
    ? text.slice(0, MAX_TOKENIZE_CHARS) : text;
  let count = 0;
  for (const seg of sharedSegmenter.segment(input)) {
    if (seg.isWordLike) count++;
  }
  return count;
}

/**
 * Word-like segments in their original casing, for reporting terms back to the
 * caller.
 *
 * Unlike `tokenize`, this neither lowercases, splits camelCase, nor emits CJK
 * bigrams — "AppID" stays one segment instead of becoming app/id, while
 * space-free CJK such as "推理服务崩溃" splits into the words a reader would
 * name (推理 / 服务 / 崩溃). Splitting on whitespace alone cannot do the
 * latter, which matters for languages that do not delimit words with spaces.
 *
 * Adjacent single-CJK-char segments are rejoined, mirroring the bigram recovery
 * in `tokenize`: the segmenter splits "排查" into 排|查, and reporting those as
 * two separate terms would be noise rather than the word the caller typed.
 */
export function wordSegments(text: string): string[] {
  if (!text) return [];
  const input = text.length > MAX_TOKENIZE_CHARS
    ? text.slice(0, MAX_TOKENIZE_CHARS) : text;
  const words: string[] = [];
  let run: string[] = [];

  const flushRun = (): void => {
    if (run.length > 0) words.push(run.join(''));
    run = [];
  };

  for (const seg of sharedSegmenter.segment(input)) {
    if (!seg.isWordLike) {
      flushRun();
      continue;
    }
    if (seg.segment.length === 1 && /[一-鿿]/.test(seg.segment)) {
      run.push(seg.segment);
      continue;
    }
    flushRun();
    words.push(seg.segment);
  }
  flushRun();

  return words;
}
