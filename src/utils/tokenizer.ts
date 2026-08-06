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
