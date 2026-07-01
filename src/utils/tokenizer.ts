// -*- coding: utf-8 -*-
/**
 * 共用 tokenizer — 确保 search-index 和 code-knowledge-recall 使用相同的分词逻辑。
 *
 * 特性：
 * - Intl.Segmenter word-boundary 分词（支持中英混合）
 * - camelCase/PascalCase 额外拆分（getUserById 额外产生 get, user, by, id）
 * - CJK bigram 分词（"超时" → "超"、"时"、"超时"）
 * - 全小写
 * - 去重
 */
const MAX_TOKENIZE_CHARS = 100_000;

export function tokenize(text: string): string[] {
  if (!text) return [];

  const input = text.length > MAX_TOKENIZE_CHARS ? text.slice(0, MAX_TOKENIZE_CHARS) : text;
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  const segments = [...segmenter.segment(input)];
  const tokens: string[] = [];

  // Collect CJK characters in runs for bigram generation
  let cjkRun: string[] = [];

  const flushCjkRun = (): void => {
    if (cjkRun.length >= 2) {
      for (let i = 0; i < cjkRun.length - 1; i++) {
        tokens.push(cjkRun[i] + cjkRun[i + 1]);
      }
    }
    cjkRun = [];
  };

  for (const seg of segments) {
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

    // Track CJK runs for bigram generation
    const chars = [...word];
    for (const ch of chars) {
      if (/[一-鿿]/.test(ch)) {
        cjkRun.push(ch);
      } else {
        flushCjkRun();
      }
    }
  }
  flushCjkRun();

  return [...new Set(tokens)];
}
